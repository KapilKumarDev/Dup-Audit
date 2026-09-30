import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDeadCode } from './helpers.js';

const pkg = (fields: Record<string, unknown>): string => JSON.stringify({ name: 'app', ...fields });

describe('dead-code entry points', () => {
  it('treats tool config files as live, along with whatever they import', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ main: 'src/app.js' }),
      'src/app.ts': `export {};\n`,
      'vite.config.ts': `import { plugin } from './tools/plugin.js';\nexport default { plugin };\n`,
      'tools/plugin.ts': `export const plugin = 1;\n`,
      'eslint.config.js': `export default [];\n`,
      '.eslintrc.cjs': `module.exports = {};\n`,
      '.storybook/main.ts': `export const stories = [];\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('does not run the analysis when tool config files are the only entries it has', async () => {
    const { deadCode, notes } = await detectDeadCode({
      'package.json': pkg({}),
      'vite.config.ts': `export default {};\n`,
      'lib/orphan.ts': `export const orphan = 1;\n`,
    });
    assert.deepEqual(deadCode, []);
    assert.match(notes[0], /no entry points could be resolved/);
  });

  it('maps a package.json entry back to source through the tsconfig outDir and rootDir', async () => {
    // `lib/main.ts` is not a conventional entry location, so only the tsconfig mapping can find it.
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ main: 'out/main.js' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'out', rootDir: 'lib' } }),
      'lib/main.ts': `import { dep } from './dep.js';\ndep;\n`,
      'lib/dep.ts': `export const dep = 1;\n`,
      'lib/orphan.ts': `export const orphan = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['lib/orphan.ts']);
  });

  it('maps a package.json entry to src/ by convention when there is no tsconfig', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ bin: { tool: './dist/server.js' } }),
      'src/server.ts': `import { dep } from './dep.js';\ndep;\n`,
      'src/dep.ts': `export const dep = 1;\n`,
      'src/orphan.ts': `export const orphan = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['src/orphan.ts']);
  });

  it('treats files named in package.json scripts as entry points, including --flag=value forms', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ scripts: { seed: 'tsx scripts/seed.ts && echo done', check: 'tool --config=tools/check.ts' } }),
      'scripts/seed.ts': `import { connect } from '../lib/db.js';\nconnect();\n`,
      'lib/db.ts': `export function connect(): void {}\n`,
      'tools/check.ts': `export default {};\n`,
      'lib/orphan.ts': `export const orphan = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['lib/orphan.ts']);
  });

  it('adds conventional index/main/cli files in the root and src next to package.json entries, but not deeper', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ main: 'src/app.js' }),
      'src/app.ts': `export {};\n`,
      'src/cli.ts': `import { used } from './used-by-cli.js';\nused;\n`,
      'src/used-by-cli.ts': `export const used = 1;\n`,
      'nested/deep/index.ts': `export const nested = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['nested/deep/index.ts']);
  });

  it('applies framework conventions only when the framework is a dependency, and skips their exports', async () => {
    const files = {
      'src/index.ts': `export {};\n`,
      'pages/index.tsx': `export default function Page(): null { return null; }\n`,
      'app/dash/page.tsx': `export default function Dash(): null { return null; }\n`,
      'app/lib.ts': `export const notAConvention = 1;\n`,
    };
    const withNext = await detectDeadCode({ ...files, 'package.json': pkg({ dependencies: { next: '15.0.0' } }) });
    assert.deepEqual(withNext.deadCode.map((f) => f.location.path), ['app/lib.ts']);

    const withoutNext = await detectDeadCode({ ...files, 'package.json': pkg({}) });
    assert.deepEqual(
      withoutNext.deadCode.map((f) => f.location.path).sort(),
      ['app/dash/page.tsx', 'app/lib.ts', 'pages/index.tsx'],
    );
  });

  it('does not report unused exports of an entry file, which its consumer reads rather than another file', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ main: 'src/index.js' }),
      'src/index.ts': `export const api = 1;\nexport default function main(): void {}\n`,
    });
    assert.deepEqual(deadCode, []);
  });

  it('lets an explicit deadcode.entry replace the automatic sources while tool config files stay live', async () => {
    const { deadCode } = await detectDeadCode(
      {
        'package.json': pkg({ main: 'src/index.js' }),
        'src/index.ts': `export {};\n`,
        'src/other.ts': `export {};\n`,
        'vite.config.ts': `export default {};\n`,
      },
      { entry: ['src/other.ts'] },
    );
    assert.deepEqual(deadCode.map((f) => f.location.path), ['src/index.ts']);
  });

  it('lets a `**/` deadcode.ignore glob match a root-level file', async () => {
    const { deadCode } = await detectDeadCode(
      {
        'package.json': pkg({ main: 'index.js' }),
        'index.ts': `export {};\n`,
        'scratch.ts': `export const scratch = 1;\n`,
      },
      { ignore: ['**/scratch.ts'] },
    );
    assert.deepEqual(deadCode, []);
  });

  it('treats a file named outright by a tool config as live, but not one merely matched by a glob', async () => {
    const { deadCode } = await detectDeadCode({
      'package.json': pkg({ main: 'src/app.js' }),
      'src/app.ts': `export {};\n`,
      'vitest.config.ts': `export default { test: { setupFiles: ['./src/test-setup.ts'], include: ['src/globbed/**/*.ts'] } };\n`,
      'src/test-setup.ts': `export {};\n`,
      'src/globbed/x.ts': `export const x = 1;\n`,
    });
    assert.deepEqual(deadCode.map((f) => f.location.path), ['src/globbed/x.ts']);
  });
});