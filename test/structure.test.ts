import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createStructureDetector } from '../src/detectors/structure.js';
import {
  FORMAT_LABEL,
  ORDER_TOTAL,
  ORDER_TOTAL_MODIFIED,
  ORDER_TOTAL_RENAMED,
  sourceFile,
} from './helpers.js';

const run = (files: Record<string, string>, overrides: Partial<typeof DEFAULT_CONFIG.structure> = {}) =>
  createStructureDetector({ ...DEFAULT_CONFIG.structure, ...overrides }).run(
    Object.entries(files).map(([name, text]) => sourceFile(name, text)),
  );

describe('structure detector', () => {
  it('reports a file with syntax errors as a failure and leaves it uncovered', async () => {
    const { analyzed, failures } = await run({ 'good.ts': ORDER_TOTAL, 'broken.ts': 'export function (((;\n' });
    assert.deepEqual(analyzed, ['good.ts']);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, 'broken.ts');
    assert.match(failures[0].message, /line 1/);
  });

  it('reports identical copies, ignoring comments and whitespace', async () => {
    const commented = `// copied from billing\n${ORDER_TOTAL.replace('let total = 0;', 'let   total = 0; // running sum')}`;
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': commented });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'identical');
    assert.equal(clusters[0].similarity, 1);
    assert.deepEqual(clusters[0].locations.map((l) => l.path), ['a.ts', 'b.ts']);
    assert.equal(clusters[0].locations[0].name, 'computeTotal');
  });

  it('treats renamed locals and changed literals as normalized clones', async () => {
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL_RENAMED });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'normalized');
    assert.equal(clusters[0].similarity, 1);
  });

  it('confirms a copy with an added guard as a near-miss between the threshold and 1', async () => {
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL_MODIFIED });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'near-miss');
    assert.ok(clusters[0].similarity >= DEFAULT_CONFIG.structure.similarity && clusters[0].similarity < 1);
  });

  it('does not pair unrelated functions of similar size', async () => {
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': FORMAT_LABEL });
    assert.deepEqual(clusters, []);
  });

  it('respects the similarity threshold', async () => {
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL_MODIFIED }, { similarity: 0.99 });
    assert.deepEqual(clusters, []);
  });

  it('does not treat a different property name as a rename: it stays a near-miss', async () => {
    const changed = ORDER_TOTAL.replace('item.price', 'item.unitCost');
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': changed });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'near-miss');
  });

  it('keeps operators significant', async () => {
    const changed = ORDER_TOTAL.replace('total += price', 'total -= price').replace('item.price * item.quantity', 'item.price / item.quantity');
    const { clusters } = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': changed });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'near-miss');
  });

  it('ignores functions below the size thresholds', async () => {
    const tiny = 'export const add = (a: number, b: number) => a + b;\nexport const plus = (x: number, y: number) => x + y;\n';
    const { clusters } = await run({ 'a.ts': tiny });
    assert.deepEqual(clusters, []);
  });

  it('finds clones between class methods and names them with their class', async () => {
    const asMethod = (name: string, body: string) =>
      `class ${name} {\n  ${body.replace('export function computeTotal', 'total').split('\n').join('\n  ')}\n}\n`;
    const { clusters } = await run({
      'a.ts': asMethod('Cart', ORDER_TOTAL),
      'b.ts': asMethod('Invoice', ORDER_TOTAL_RENAMED.replace('export function sumUp', 'total')),
    });
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].locations.map((l) => l.name), ['Cart.total', 'Invoice.total']);
  });

  it('finds clones between named arrow functions and function expressions', async () => {
    const asArrow = (name: string) =>
      ORDER_TOTAL.replace('export function computeTotal(', `export const ${name} = (`).replace('): number {', '): number => {');
    const { clusters } = await run({ 'a.ts': asArrow('one'), 'b.ts': asArrow('two') });
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].locations.map((l) => l.name), ['one', 'two']);
  });

  it('normalizes local numbering the same way however the function is declared', async () => {
    const body = ORDER_TOTAL.slice(ORDER_TOTAL.indexOf('(items'), ORDER_TOTAL.lastIndexOf('}') + 1);
    const arrow = body.replace('): number {', '): number => {');
    const { clusters } = await run({
      'const.ts': `export const alpha = ${arrow};\n`,
      'property.ts': `export const holder = {\n  beta: ${arrow},\n};\n`,
      'field.ts': `class Box {\n  gamma = ${arrow};\n}\n`,
    });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'identical');
    assert.equal(clusters[0].locations.length, 3);
  });

  it('normalizes recursion through the function own name', async () => {
    const recursive = (name: string) => `export function ${name}(nodes: Node[], depth: number): number {
  let count = 0;
  for (const node of nodes) {
    if (node.children.length > 0) {
      count += ${name}(node.children, depth + 1);
    }
    count += depth * node.weight;
  }
  return count > 1000 ? 1000 : count;
}
`;
    const { clusters } = await run({ 'a.ts': recursive('walk'), 'b.ts': recursive('visit') });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].kind, 'normalized');
  });

  it('analyzes JSX and reports which files it examined', async () => {
    const component = (name: string) => `export const ${name} = ({ rows }: Props) => {
  const visible = rows.filter((row) => row.visible);
  return (
    <ul className="list">
      {visible.map((row) => (
        <li key={row.id} className="item">
          <span>{row.title}</span>
        </li>
      ))}
    </ul>
  );
};
`;
    const result = await run({ 'a.tsx': component('Alpha'), 'b.tsx': component('Beta'), 'notes.md': 'ignored' });
    assert.equal(result.clusters.length, 1);
    assert.deepEqual(result.analyzed, ['a.tsx', 'b.tsx']);
  });

  it('matches oversized functions exactly but skips near-miss comparison, and says so', async () => {
    const result = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL_MODIFIED }, { maxTedNodes: 20 });
    assert.deepEqual(result.clusters, []);
    assert.match(result.notes[0], /matched exactly only/);

    const exact = await run({ 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL }, { maxTedNodes: 20 });
    assert.equal(exact.clusters.length, 1);
  });

  it('is deterministic', async () => {
    const files = { 'a.ts': ORDER_TOTAL, 'b.ts': ORDER_TOTAL_MODIFIED, 'c.ts': ORDER_TOTAL_RENAMED };
    assert.deepEqual(await run(files), await run(files));
  });
});