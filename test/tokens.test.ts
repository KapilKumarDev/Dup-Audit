import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createTokenDetector, type DetectClones, type JscpdClone } from '../src/detectors/tokens.js';
import { sourceFile } from './helpers.js';

const ROOT = path.resolve('/repo');
const clone = (a: string, b: string): JscpdClone => ({
  duplicationA: { sourceId: path.join(ROOT, a), start: { line: 3 }, end: { line: 20 } },
  duplicationB: { sourceId: path.join(ROOT, b), start: { line: 7 }, end: { line: 24 } },
});

const files = [
  sourceFile('src/a.ts', 'a\n'),
  sourceFile('src/b.ts', 'b\n'),
  sourceFile('db/schema.sql', 'select 1;\n'),
  sourceFile('docs/readme.md', '# x\n'),
  sourceFile('app/[id]/page.tsx', 'c\n'),
];

describe('token detector', () => {
  it('passes only eligible, glob-safe files to jscpd and maps its clones to locations', async () => {
    let received: Record<string, unknown> = {};
    const detect: DetectClones = async (options) => {
      received = options;
      return [clone('src/a.ts', 'src/b.ts')];
    };
    const result = await createTokenDetector(ROOT, DEFAULT_CONFIG.tokens, detect).run(files);

    assert.deepEqual(received.path, [path.join(ROOT, 'src/a.ts'), path.join(ROOT, 'src/b.ts'), path.join(ROOT, 'db/schema.sql')]);
    assert.equal(received.minTokens, DEFAULT_CONFIG.tokens.minTokens);
    assert.equal(received.gitignore, false);
    assert.deepEqual(result.analyzed, ['src/a.ts', 'src/b.ts', 'db/schema.sql']);
    assert.deepEqual(result.clusters[0].locations, [
      { path: 'src/a.ts', startLine: 3, endLine: 20 },
      { path: 'src/b.ts', startLine: 7, endLine: 24 },
    ]);
    assert.equal(result.clusters[0].kind, 'identical');
    assert.match(result.notes[0], /1 file\(s\) with glob characters/);
  });

  it('does not call jscpd when nothing is eligible', async () => {
    const detect: DetectClones = async () => {
      throw new Error('should not run');
    };
    const result = await createTokenDetector(ROOT, DEFAULT_CONFIG.tokens, detect).run([sourceFile('a.md', 'x')]);
    assert.deepEqual(result.clusters, []);
    assert.deepEqual(result.analyzed, []);
  });

  it('refuses results that name a file it never requested', async () => {
    const detect: DetectClones = async () => [clone('src/a.ts', 'src/unknown.ts')];
    await assert.rejects(createTokenDetector(ROOT, DEFAULT_CONFIG.tokens, detect).run(files), /not requested/);
  });

  it('refuses results in an unexpected shape', async () => {
    const detect: DetectClones = async () => [{ duplicationA: {}, duplicationB: {} } as unknown as JscpdClone];
    await assert.rejects(createTokenDetector(ROOT, DEFAULT_CONFIG.tokens, detect).run(files), /unexpected shape/);
  });
});
