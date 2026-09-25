import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createCssDetector } from '../src/detectors/css.js';
import { sourceFile } from './helpers.js';

const run = (files: Record<string, string>, overrides: Partial<typeof DEFAULT_CONFIG.css> = {}) =>
  createCssDetector({ ...DEFAULT_CONFIG.css, ...overrides }).run(
    Object.entries(files).map(([name, text]) => sourceFile(name, text)),
  );

const CARD = `.card {
  display: flex;
  padding: 8px 16px;
  border: 1px solid #ccc;
  border-radius: 4px;
}
`;

describe('css detector', () => {
  it('reports identical rule bodies under different selectors', async () => {
    const { clusters } = await run({
      'a.css': CARD,
      'b.css': CARD.replace('.card', '.panel'),
    });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'identical');
    assert.deepEqual(clusters[0].locations.map((l) => l.name), ['.card', '.panel']);
  });

  it('treats reordered declarations, different casing and spacing as normalized', async () => {
    const reordered = `.panel {
  border-radius: 4px;
  BORDER: 1px   solid #CCC;
  padding: 8px 16px;
  display: FLEX;
}
`;
    const { clusters } = await run({ 'a.css': CARD, 'b.css': reordered });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'normalized');
  });

  it('keeps quoted strings and urls case-sensitive', async () => {
    const rule = (name: string) => `.${name} {\n  display: block;\n  color: red;\n  background: url(${name}.png);\n}\n`;
    const { clusters } = await run({ 'a.css': rule('a'), 'b.css': rule('B') });
    assert.deepEqual(clusters, []);
  });

  it('does not pair identical bodies that live in different media contexts', async () => {
    const wrapped = `@media (min-width: 600px) {\n${CARD}}\n`;
    const { clusters } = await run({ 'a.css': CARD, 'b.css': wrapped });
    assert.deepEqual(clusters, []);
  });

  it('pairs identical bodies inside the same media context', async () => {
    const wrapped = (selector: string) => `@media (min-width: 600px) {\n${CARD.replace('.card', selector)}}\n`;
    const { clusters } = await run({ 'a.css': wrapped('.one'), 'b.css': wrapped('.two') });
    assert.equal(clusters.length, 1);
  });

  it('confirms near-miss rules above the similarity threshold', async () => {
    const big = (extra: string) => `.box {
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  color: black;
  background: white;
  border: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
${extra}}
`;
    const { clusters } = await run({ 'a.css': big(''), 'b.css': big('  position: relative;\n').replace('.box', '.other') });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'near-miss');
    assert.ok(clusters[0].similarity >= DEFAULT_CONFIG.css.similarity && clusters[0].similarity < 1);
  });

  it('rejects rules that only share a few declarations', async () => {
    const other = `.z {\n  display: flex;\n  margin: 0;\n  color: blue;\n  cursor: pointer;\n  opacity: 0.5;\n}\n`;
    const { clusters } = await run({ 'a.css': CARD, 'b.css': other });
    assert.deepEqual(clusters, []);
  });

  it('ignores rules with fewer declarations than the minimum', async () => {
    const small = '.a { color: red; }\n.b { color: red; }\n';
    const { clusters } = await run({ 'a.css': small });
    assert.deepEqual(clusters, []);
  });

  it('flags duplicate rules inside one file', async () => {
    const { clusters } = await run({ 'a.css': `${CARD}\n${CARD.replace('.card', '.tile')}` });
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].locations.map((l) => l.startLine), [1, 8]);
  });

  it('reports files that fail to parse instead of silently counting them as analyzed', async () => {
    const result = await run({ 'good.css': CARD, 'bad.css': '.broken { color: red; ' });
    assert.deepEqual(result.analyzed, ['good.css']);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, 'bad.css');
  });
});
