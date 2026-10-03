import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Interner } from '../src/candidates.js';
import { seededRandom } from '../src/random.js';
import { editDistance, prepareTree, type TedNode } from '../src/ted.js';

const node = (label: string, ...children: TedNode[]): TedNode => ({ label, children });

function distance(a: TedNode, b: TedNode, maxDistance?: number): number {
  const interner = new Interner();
  const intern = (label: string): number => interner.id(label);
  return editDistance(prepareTree(a, intern), prepareTree(b, intern), maxDistance);
}

/** Copy of `tree` with the label of about `count` nodes replaced by a label no other node uses. */
function relabelSome(tree: TedNode, random: () => number, count: number): TedNode {
  const total = countNodes([tree]);
  const chosen = new Set<number>();
  while (chosen.size < Math.min(count, total)) chosen.add(Math.floor(random() * total));
  let position = 0;
  const copy = (current: TedNode): TedNode => {
    const label = chosen.has(position++) ? `${current.label}!` : current.label;
    return node(label, ...current.children.map(copy));
  };
  return copy(tree);
}

function mirror(tree: TedNode): TedNode {
  return node(tree.label, ...[...tree.children].reverse().map(mirror));
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

  it('returns the exact distance within the bound and bound + 1 beyond it', () => {
    const random = seededRandom(7);
    for (let round = 0; round < 150; round++) {
      const a = randomTree(random, { left: 7 });
      const b = randomTree(random, { left: 7 });
      const expected = bruteForce([a], [b]);
      for (let bound = 0; bound <= 14; bound++) {
        const message = `round ${round}, bound ${bound}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
        assert.equal(distance(a, b, bound), expected <= bound ? expected : bound + 1, message);
      }
    }
  });

  it('is unchanged when both trees are mirrored', () => {
    const random = seededRandom(11);
    for (let round = 0; round < 100; round++) {
      const a = randomTree(random, { left: 30 });
      const b = randomTree(random, { left: 30 });
      assert.equal(distance(mirror(a), mirror(b)), distance(a, b), `round ${round}`);
    }
  });

  it('stays consistent on larger near-clones, where distant subtrees are skipped', () => {
    const random = seededRandom(23);
    for (let round = 0; round < 20; round++) {
      const original = randomTree(random, { left: 400 });
      const relabeled = relabelSome(original, random, 6);
      const exact = distance(original, relabeled);
      assert.ok(exact <= 6, `round ${round}: ${exact} edits for 6 relabels`);
      for (const bound of [exact - 1, exact, exact + 1, 40]) {
        if (bound < 0) continue;
        assert.equal(distance(original, relabeled, bound), exact <= bound ? exact : bound + 1, `round ${round}, bound ${bound}`);
      }
    }
  });
});