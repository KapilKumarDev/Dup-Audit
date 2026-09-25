import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCandidatePairs } from '../src/candidates.js';
import { clusterUnits } from '../src/clustering.js';

describe('findCandidatePairs', () => {
  it('reports pairs above the Jaccard threshold with their exact overlap ratio', () => {
    const pairs = findCandidatePairs(
      [
        [1, 2, 3, 4],
        [1, 2, 3, 5],
        [9, 10, 11, 12],
      ],
      { minJaccard: 0.5, maxPosting: 10 },
    );
    assert.equal(pairs.length, 1);
    assert.deepEqual({ a: pairs[0].a, b: pairs[0].b }, { a: 0, b: 1 });
    assert.equal(pairs[0].jaccard, 3 / 5);
  });

  it('ignores features shared by more items than maxPosting', () => {
    const sets = [[1, 100], [2, 100], [3, 100]];
    assert.equal(findCandidatePairs(sets, { minJaccard: 0.1, maxPosting: 2 }).length, 0);
    assert.equal(findCandidatePairs(sets, { minJaccard: 0.1, maxPosting: 3 }).length, 3);
  });
});

interface Unit {
  name: string;
  normalized: string;
  raw: string;
  features: number[];
}

const unit = (name: string, normalized: string, raw: string, features: number[] = []): Unit => ({
  name,
  normalized,
  raw,
  features,
});

const cluster = (units: Unit[], similarity: (a: Unit, b: Unit) => number = () => 0, threshold = 0.8) =>
  clusterUnits({
    units,
    normalizedKey: (u) => u.normalized,
    rawKey: (u) => u.raw,
    features: (u) => u.features,
    candidates: { minJaccard: 0.1, maxPosting: 100 },
    similarity,
    threshold,
  });

describe('clusterUnits', () => {
  it('groups equal normalized keys and labels raw-equal groups identical', () => {
    const [result] = cluster([unit('a', 'k', 'r'), unit('b', 'k', 'r'), unit('c', 'k', 'r')]);
    assert.equal(result.kind, 'identical');
    assert.equal(result.similarity, 1);
    assert.equal(result.members.length, 3);
  });

  it('labels groups whose raw keys differ as normalized', () => {
    const [result] = cluster([unit('a', 'k', 'r1'), unit('b', 'k', 'r2')]);
    assert.equal(result.kind, 'normalized');
  });

  it('never reports a unit that matches nothing', () => {
    assert.deepEqual(cluster([unit('a', 'k1', 'r1'), unit('b', 'k2', 'r2')]), []);
  });

  it('merges groups whose representatives are confirmed similar and reports the weakest link', () => {
    const units = [
      unit('a1', 'A', 'a1', [1, 2, 3]),
      unit('a2', 'A', 'a2', [1, 2, 3]),
      unit('b', 'B', 'b', [1, 2, 4]),
      unit('c', 'C', 'c', [1, 2, 5]),
    ];
    const similarity = (x: Unit, y: Unit): number => (x.name === 'a1' && y.name === 'b' ? 0.95 : 0.9);
    const [result] = cluster(units, similarity);
    assert.equal(result.kind, 'near-miss');
    assert.equal(result.members.length, 4);
    assert.equal(result.similarity, 0.9);
  });

  it('rejects candidate pairs below the confirmation threshold', () => {
    const units = [unit('a', 'A', 'a', [1, 2, 3]), unit('b', 'B', 'b', [1, 2, 3])];
    assert.deepEqual(cluster(units, () => 0.79), []);
  });

  it('skips the precise check when the cheap upper bound is already below the threshold', () => {
    let calls = 0;
    const units = [unit('a', 'A', 'a', [1, 2, 3]), unit('b', 'B', 'b', [1, 2, 3])];
    const result = clusterUnits({
      units,
      normalizedKey: (u) => u.normalized,
      rawKey: (u) => u.raw,
      features: (u) => u.features,
      candidates: { minJaccard: 0.1, maxPosting: 100 },
      upperBound: () => 0.5,
      similarity: () => {
        calls++;
        return 1;
      },
      threshold: 0.8,
    });
    assert.deepEqual(result, []);
    assert.equal(calls, 0);
  });
});
