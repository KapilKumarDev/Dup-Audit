import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Interner } from '../src/candidates.js';
import { seededRandom } from '../src/random.js';
import { editDistance, prepareTree, type TedNode } from '../src/ted.js';

const node = (label: string, ...children: TedNode[]): TedNode => ({ label, children });

function distance(a: TedNode, b: TedNode): number {
  const interner = new Interner();
  const intern = (label: string): number => interner.id(label);
  return editDistance(prepareTree(a, intern), prepareTree(b, intern));
}

/** Exponential reference implementation over forests, only usable on tiny trees. */
function bruteForce(a: TedNode[], b: TedNode[], memo = new Map<string, number>()): number {
  if (a.length === 0) return countNodes(b);
  if (b.length === 0) return countNodes(a);
  const key = `${JSON.stringify(a)}|${JSON.stringify(b)}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const v = a[a.length - 1];
  const w = b[b.length - 1];
  const result = Math.min(
    bruteForce([...a.slice(0, -1), ...v.children], b, memo) + 1,
    bruteForce(a, [...b.slice(0, -1), ...w.children], memo) + 1,
    bruteForce([...v.children], [...w.children], memo) +
      bruteForce(a.slice(0, -1), b.slice(0, -1), memo) +
      (v.label === w.label ? 0 : 1),
  );
  memo.set(key, result);
  return result;
}

function countNodes(forest: readonly TedNode[]): number {
  return forest.reduce((sum, tree) => sum + 1 + countNodes(tree.children), 0);
}

function randomTree(random: () => number, budget: { left: number }): TedNode {
  budget.left--;
  const children: TedNode[] = [];
  while (budget.left > 0 && random() < 0.55) children.push(randomTree(random, budget));
  return node(String.fromCharCode(97 + Math.floor(random() * 3)), ...children);
}

describe('editDistance', () => {
  it('is zero for identical trees', () => {
    const tree = node('f', node('a'), node('b', node('c')));
    assert.equal(distance(tree, tree), 0);
  });

  it('counts a relabel as one edit', () => {
    assert.equal(distance(node('f', node('a')), node('f', node('b'))), 1);
  });

  it('counts an inserted node as one edit', () => {
    assert.equal(distance(node('f', node('a'), node('c')), node('f', node('a'), node('b'), node('c'))), 1);
  });

  it('matches the classic Zhang-Shasha example (distance 2)', () => {
    const first = node('f', node('d', node('a'), node('c', node('b'))), node('e'));
    const second = node('f', node('c', node('d', node('a'), node('b'))), node('e'));
    assert.equal(distance(first, second), 2);
  });

  it('equals the brute-force distance on random small trees, in both directions', () => {
    const random = seededRandom(42);
    for (let round = 0; round < 150; round++) {
      const a = randomTree(random, { left: 7 });
      const b = randomTree(random, { left: 7 });
      const expected = bruteForce([a], [b]);
      assert.equal(distance(a, b), expected, `round ${round}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      assert.equal(distance(b, a), expected, `round ${round} reversed`);
    }
  });
});
