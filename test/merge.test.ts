import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countDuplicatedLines, dropExplainedPairs } from '../src/merge.js';
import type { CloneCluster, Location } from '../src/types.js';

const at = (path: string, startLine: number, endLine: number): Location => ({ path, startLine, endLine });
const cluster = (detector: CloneCluster['detector'], ...locations: Location[]): CloneCluster => ({
  detector,
  kind: 'identical',
  similarity: 1,
  locations,
});

describe('dropExplainedPairs', () => {
  const structural = [cluster('structure', at('a.ts', 1, 20), at('b.ts', 5, 24))];

  it('drops a pair whose sides sit inside two different members of one cluster', () => {
    const pair = cluster('tokens', at('a.ts', 3, 10), at('b.ts', 8, 15));
    assert.deepEqual(dropExplainedPairs([pair], structural), []);
  });

  it('keeps a pair that only overlaps one member, or lies outside the cluster', () => {
    const inside = cluster('tokens', at('a.ts', 3, 10), at('a.ts', 12, 18));
    const outside = cluster('tokens', at('a.ts', 3, 10), at('c.ts', 1, 8));
    const spilling = cluster('tokens', at('a.ts', 3, 10), at('b.ts', 20, 30));
    assert.deepEqual(dropExplainedPairs([inside, outside, spilling], structural), [inside, outside, spilling]);
  });

  it('keeps a pair whose two sides fall in the same member', () => {
    const pair = cluster('tokens', at('a.ts', 2, 5), at('a.ts', 8, 12));
    assert.equal(dropExplainedPairs([pair], structural).length, 1);
  });
});

describe('countDuplicatedLines', () => {
  it('counts every copy except the first', () => {
    assert.equal(countDuplicatedLines([cluster('structure', at('a.ts', 1, 10), at('b.ts', 1, 10), at('c.ts', 1, 10))]), 20);
  });

  it('never counts a line twice across overlapping or adjacent clusters', () => {
    const clusters = [
      cluster('structure', at('a.ts', 1, 10), at('z.ts', 1, 10)),
      cluster('tokens', at('a.ts', 1, 5), at('z.ts', 4, 12)),
    ];
    assert.equal(countDuplicatedLines(clusters), 12);
  });

  it('is zero without clusters', () => {
    assert.equal(countDuplicatedLines([]), 0);
  });
});
