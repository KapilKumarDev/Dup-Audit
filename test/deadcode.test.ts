import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createDeadCodeDetector } from '../src/detectors/deadcode.js';
import { collectInventory } from '../src/inventory.js';
import { detectDeadCode, makeRepo, sourceFile } from './helpers.js';

// package.json lookups against this root fail (ENOENT) and are tolerated; every test sets `entry`
// explicitly instead, so resolution never depends on auto-detection or a real filesystem.
const ROOT = '/no-such-project';

const run = (files: Record<string, string>, overrides: Partial<typeof DEFAULT_CONFIG.deadcode> = {}) =>
  createDeadCodeDetector(ROOT, { ...DEFAULT_CONFIG.deadcode, entry: ['entry.ts'], treatTestsAsEntry: false, ...overrides }).run(
    Object.entries(files).map(([name, text]) => sourceFile(name, text)),
  );

describe('deadcode detector', () => {
  it('flags a file only reachable through another file that is itself dead', async () => {
    // helper.ts IS imported by dead.ts - a shallow "is anyone importing this" check would call it live.
    // dead.ts itself is never reached from the entry point, so neither is genuinely live.
    const { deadCode } = await run({
      'entry.ts': `import { start } from './live.js';\nstart();\n`,
      'live.ts': `export function start(): void {}\n`,
      'dead.ts': `import { helperFn } from './helper.js';\nexport function unused(): void { helperFn(); }\n`,
      'helper.ts': `export function helperFn(): void {}\n`,
    });
    const flagged = deadCode.filter((f) => f.kind === 'dead-file').map((f) => f.location.path).sort();
    assert.deepEqual(flagged, ['dead.ts', 'helper.ts']);
  });

  it('flags both sides of a mutually-recursive pair when neither is reachable from an entry point', async () => {
    // a.ts and b.ts import each other, so a naive "does something import this file" check marks both
    // live. Neither has a path back to the entry point, so both are dead - the exact gap ts-prune's own
    // maintainer documents ("couldn't detect mutually recursive dead code") and knip's whole-graph
    // reachability fixes.
    const { deadCode } = await run({
      'entry.ts': `import './live.js';\n`,
      'live.ts': `export const ok = 1;\n`,
      'a.ts': `import { b } from './b.js';\nexport function a(): number { return b(); }\n`,
      'b.ts': `import { a } from './a.js';\nexport function b(): number { return 1; }\n`,
    });
    const flagged = deadCode.filter((f) => f.kind === 'dead-file').map((f) => f.location.path).sort();
    assert.deepEqual(flagged, ['a.ts', 'b.ts']);
  });

  it('flags an unused named export in a file that is otherwise reachable', async () => {
    const { deadCode } = await run({
      'entry.ts': `import { used } from './lib.js';\nused();\n`,
      'lib.ts': `export function used(): void {}\nexport function unused(): void {}\n`,
    });
    assert.equal(deadCode.some((f) => f.location.path === 'lib.ts' && f.kind === 'dead-file'), false);
    const exported = deadCode.filter((f) => f.kind === 'dead-export');
    assert.equal(exported.length, 1);
    assert.equal(exported[0].location.name, 'unused');
  });

  it('does not flag an export only reached through a barrel `export * from` re-export', async () => {
    const { deadCode } = await run({
      'entry.ts': `import { thing } from './barrel.js';\nthing();\n`,
      'barrel.ts': `export * from './impl.js';\n`,
      'impl.ts': `export function thing(): void {}\n`,
    });
    assert.equal(deadCode.filter((f) => f.location.path === 'impl.ts').length, 0);
    assert.equal(deadCode.filter((f) => f.location.path === 'barrel.ts').length, 0);
  });

  it('downgrades a file to uncertain, not dead, when a computed require elsewhere might target it', async () => {
    const { deadCode } = await run({
      'entry.ts': `const name = 'plugin-foo';\nrequire('./' + name);\n`,
      'plugin-foo.ts': `export const noop = 1;\n`,
    });
    const finding = deadCode.find((f) => f.location.path === 'plugin-foo.ts');
    assert.equal(finding?.kind, 'uncertain-file');
    assert.match(finding?.reason ?? '', /entry\.ts contains a string/);
  });

  it('skips the run and notes why when no entry point can be resolved', async () => {
    const { deadCode, notes, analyzed } = await run({ 'a.ts': 'export const x = 1;\n' }, { entry: [] });
    assert.equal(deadCode.length, 0);
    assert.deepEqual(analyzed, [], 'a skipped analysis examined nothing, so it must not count as coverage');
    assert.match(notes[0], /no entry points could be resolved/);
  });

  it('does not flag a function exported only for direct unit testing, when treatTestsAsEntry is on', async () => {
    // The dominant false-positive pattern in real use: `helper` is exported purely so a test file can
    // import and exercise it directly, not because any shipped code calls it. Nothing in `files` other
    // than the test itself ever references it, so this only passes once test files count as entries.
    const root = makeRepo({
      'src/entry.ts': `import './lib.js';\n`,
      'src/lib.ts': `export function helper(): number { return 1; }\n`,
      'src/lib.test.ts': `import { helper } from './lib.js';\nhelper();\n`,
    });
    const config = { ...structuredClone(DEFAULT_CONFIG), deadcode: { ...DEFAULT_CONFIG.deadcode, entry: ['src/entry.ts'] } };
    const inventory = await collectInventory(root, config);
    const { deadCode, notes } = await createDeadCodeDetector(root, config.deadcode).run(inventory.files, inventory.excludedFiles);
    assert.equal(deadCode.some((f) => f.location.path === 'src/lib.ts'), false);
    assert.match(notes[0], /\+ test files/);
  });

  it('does not flag an exported function that is also called elsewhere in its own file', async () => {
    // `helper` is exported (so it COULD be imported elsewhere) but is really used internally by `entry`
    // logic in the same module - never imported anywhere, but plainly not dead.
    const { deadCode } = await run({
      'entry.ts': `import './lib.js';\n`,
      'lib.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper() + helper(); }\n`,
    });
    assert.equal(deadCode.some((f) => f.location.name === 'helper'), false);
  });

  it('does not report the local name of a named default export as a separate dead export', async () => {
    // `export default function foo` exports only 'default'; `foo` is a local binding, not an export.
    const { deadCode } = await run({
      'entry.ts': `import foo from './lib.js';\nfoo();\n`,
      'lib.ts': `export default function foo(): number { return 1; }\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('treats a test file as an entry point even when it is among the audited files', async () => {
    // A custom shared `ignore` list that no longer excludes tests leaves them in `files`; they must not
    // be reported as dead, and what they import must stay live.
    const { deadCode, notes } = await run(
      {
        'entry.ts': `import './lib.js';\n`,
        'lib.ts': `export function helper(): number { return 1; }\n`,
        'lib.test.ts': `import { helper } from './lib.js';\nhelper();\n`,
      },
      { treatTestsAsEntry: true },
    );
    assert.deepEqual(deadCode, []);
    assert.match(notes[0], /\+ test files/);
  });

  it('reports the resolved entry points and basis on a normal run', async () => {
    const { notes } = await run({
      'entry.ts': `export const x = 1;\n`,
    });
    assert.match(notes[0], /entry\.ts/);
  });

  it('resolves tsconfig `paths` aliases, so a file imported only through an alias is live', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': JSON.stringify({ main: 'src/index.js' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/index.ts': `import { format } from '@/lib/format';\nformat();\n`,
      'src/lib/format.ts': `export function format(): void {}\n`,
      'src/lib/orphan.ts': `export const orphan = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['src/lib/orphan.ts']);
  });

  it('counts `export * as ns from` as a reference to the target file', async () => {
    const { deadCode } = await run({
      'entry.ts': `import { ns } from './barrel.js';\nns;\n`,
      'barrel.ts': `export * as ns from './impl.js';\n`,
      'impl.ts': `export function thing(): void {}\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('counts `import x = require()` as a reference to the target file', async () => {
    const { deadCode } = await run({
      'entry.ts': `import legacy = require('./legacy.js');\nlegacy;\n`,
      'legacy.ts': `export const value = 1;\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('counts an `import()` type reference as a reference to the target file', async () => {
    const { deadCode } = await run({
      'entry.ts': `export type Shape = import('./shape.js').Shape;\n`,
      'shape.ts': `export interface Shape { size: number }\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('reports a file only a .vue template mentions as uncertain, not dead', async () => {
    // The graph cannot read into a .vue file, so an import written there is invisible to it.
    const { deadCode } = await run({
      'entry.ts': `export const start = 1;\n`,
      'composable.ts': `export const useThing = 1;\n`,
      'Thing.vue': `<script setup>import { useThing } from './composable'</script>\n`,
    });
    const finding = deadCode.find((f) => f.location.path === 'composable.ts');
    assert.equal(finding?.kind, 'uncertain-file');
  });
});