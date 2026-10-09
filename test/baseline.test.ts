import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildBaseline, fingerprintCluster, loadBaseline, splitAgainstBaseline } from '../src/baseline.js';
import type { CloneCluster, Location } from '../src/types.js';
import { makeRepo, sourceFile } from './helpers.js';

const at = (path: string, startLine: number, endLine: number): Location => ({ path, startLine, endLine });
const cluster = (...locations: Location[]): CloneCluster => ({
  detector: 'structure',
  kind: 'identical',
  similarity: 1,
  locations,
});

const DUP_A = 'function a() {\n  return 1;\n}\n';
const DUP_B = 'function b() {\n  return 1;\n}\n';

describe('fingerprintCluster', () => {
  it('is unaffected by an unrelated edit that only shifts line numbers', () => {
    const before = [sourceFile('a.ts', `${DUP_A}${DUP_B}`), sourceFile('b.ts', DUP_A)];
    const after = [sourceFile('a.ts', `// new leading comment\n${DUP_A}${DUP_B}`), sourceFile('b.ts', DUP_A)];
    const beforeIndex = new Map(before.map((f) => [f.path, f]));
    const afterIndex = new Map(after.map((f) => [f.path, f]));

    const c = cluster(at('a.ts', 1, 3), at('b.ts', 1, 3));
    const shifted = cluster(at('a.ts', 2, 4), at('b.ts', 1, 3));
    assert.equal(fingerprintCluster(c, beforeIndex), fingerprintCluster(shifted, afterIndex));
  });

  it('is unaffected by the line-ending style of the checkout', () => {
    const lf = [sourceFile('a.ts', DUP_A), sourceFile('b.ts', DUP_A)];
    const crlf = lf.map((file) => sourceFile(file.path, file.text.replaceAll('\n', '\r\n')));
    const c = cluster(at('a.ts', 1, 3), at('b.ts', 1, 3));
    assert.equal(
      fingerprintCluster(c, new Map(lf.map((f) => [f.path, f]))),
      fingerprintCluster(c, new Map(crlf.map((f) => [f.path, f]))),
    );
  });

  it('changes when the duplicated content itself changes', () => {
    const files = new Map([sourceFile('a.ts', DUP_A), sourceFile('b.ts', DUP_A)].map((f) => [f.path, f]));
    const filesChanged = new Map(
      [sourceFile('a.ts', DUP_A), sourceFile('b.ts', 'function b() {\n  return 2;\n}\n')].map((f) => [f.path, f]),
    );
    const c = cluster(at('a.ts', 1, 3), at('b.ts', 1, 3));
    assert.notEqual(fingerprintCluster(c, files), fingerprintCluster(c, filesChanged));
  });

  it('does not depend on the order locations are listed in', () => {
    const files = new Map([sourceFile('a.ts', DUP_A), sourceFile('b.ts', DUP_A)].map((f) => [f.path, f]));
    const forward = cluster(at('a.ts', 1, 3), at('b.ts', 1, 3));
    const reversed = cluster(at('b.ts', 1, 3), at('a.ts', 1, 3));
    assert.equal(fingerprintCluster(forward, files), fingerprintCluster(reversed, files));
  });

  it('falls back to a position-based signature for a file that no longer exists', () => {
    const files = new Map([sourceFile('a.ts', DUP_A)].map((f) => [f.path, f]));
    const c = cluster(at('a.ts', 1, 3), at('gone.ts', 1, 3));
    assert.doesNotThrow(() => fingerprintCluster(c, files));
  });
});

describe('splitAgainstBaseline', () => {
  const files = [sourceFile('a.ts', DUP_A), sourceFile('b.ts', DUP_A), sourceFile('c.ts', DUP_A)];
  const known = cluster(at('a.ts', 1, 3), at('b.ts', 1, 3));
  const fresh = cluster(at('a.ts', 1, 3), at('c.ts', 1, 3));

  it('separates clusters already in the baseline from newly found ones', () => {
    const baseline = buildBaseline([known], files);
    const { newClusters, baselinedClusters } = splitAgainstBaseline([known, fresh], baseline, files);
    assert.deepEqual(baselinedClusters, [known]);
    assert.deepEqual(newClusters, [fresh]);
  });

  it('treats every cluster as new against an empty baseline', () => {
    const { newClusters, baselinedClusters } = splitAgainstBaseline([known, fresh], { generatedAt: '', fingerprints: [] }, files);
    assert.equal(baselinedClusters.length, 0);
    assert.equal(newClusters.length, 2);
  });
});

describe('loadBaseline', () => {
  it('returns undefined when the file does not exist', async () => {
    assert.equal(await loadBaseline(path.join(makeRepo({}), 'baseline.json')), undefined);
  });

  it('round-trips what buildBaseline writes', async () => {
    const files = [sourceFile('a.ts', DUP_A), sourceFile('b.ts', DUP_A)];
    const baseline = buildBaseline([cluster(at('a.ts', 1, 3), at('b.ts', 1, 3))], files);
    const root = makeRepo({});
    const file = path.join(root, 'baseline.json');
    writeFileSync(file, JSON.stringify(baseline));
    assert.deepEqual(await loadBaseline(file), baseline);
  });

  it('rejects a file missing the fingerprints array', async () => {
    const root = makeRepo({});
    const file = path.join(root, 'baseline.json');
    writeFileSync(file, JSON.stringify({ generatedAt: 'x' }));
    await assert.rejects(loadBaseline(file), /malformed/);
  });
});