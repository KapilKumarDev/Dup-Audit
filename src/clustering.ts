import { findCandidatePairs, type CandidateOptions } from './candidates.js';
import type { CloneKind } from './types.js';

export interface ClusterInput<T> {
  units: readonly T[];
  /** Equal keys mean the units match after normalization. */
  normalizedKey: (unit: T) => string;
  /** Equal keys mean the units match before normalization (identical apart from whitespace and comments). */
  rawKey: (unit: T) => string;
  /** Feature ids used to find near-miss candidates cheaply; an empty list opts a unit out. */
  features: (unit: T) => readonly number[];
  candidates: CandidateOptions;
  /** Optional cheap ceiling on the similarity of a pair; pairs below the threshold skip the precise check. */
  upperBound?: (a: T, b: T) => number;
  /** Precise similarity in 0..1, given the candidate's feature overlap. */
  similarity: (a: T, b: T, jaccard: number) => number;
  threshold: number;
}

export interface UnitCluster<T> {
  members: T[];
  kind: CloneKind;
  similarity: number;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let current = index;
    while (this.parent[current] !== root) {
      const next = this.parent[current];
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

interface Edge {
  a: number;
  b: number;
  similarity: number;
}

/**
 * Units with equal normalized keys form exact groups; one representative per group is compared
 * against the others, and every confirmed pair merges its groups into a single cluster.
 */
export function clusterUnits<T>(input: ClusterInput<T>): UnitCluster<T>[] {
  const groupsByKey = new Map<string, T[]>();
  for (const unit of input.units) {
    const key = input.normalizedKey(unit);
    const group = groupsByKey.get(key);
    if (group === undefined) groupsByKey.set(key, [unit]);
    else group.push(unit);
  }
  const groups = [...groupsByKey.values()];
  const representatives = groups.map((group) => group[0]);

  const sets = new DisjointSet(groups.length);
  const edges: Edge[] = [];
  const pairs = findCandidatePairs(representatives.map(input.features), input.candidates);
  for (const { a, b, jaccard } of pairs) {
    const left = representatives[a];
    const right = representatives[b];
    if (input.upperBound !== undefined && input.upperBound(left, right) < input.threshold) continue;
    const similarity = input.similarity(left, right, jaccard);
    if (similarity < input.threshold) continue;
    edges.push({ a, b, similarity });
    sets.union(a, b);
  }

  const componentGroups = new Map<number, number[]>();
  groups.forEach((_, index) => {
    const root = sets.find(index);
    const list = componentGroups.get(root);
    if (list === undefined) componentGroups.set(root, [index]);
    else list.push(index);
  });
  const componentSimilarity = new Map<number, number>();
  for (const { a, similarity } of edges) {
    const root = sets.find(a);
    componentSimilarity.set(root, Math.min(componentSimilarity.get(root) ?? 1, similarity));
  }

  const clusters: UnitCluster<T>[] = [];
  for (const [root, groupIndexes] of componentGroups) {
    const members = groupIndexes.flatMap((index) => groups[index]);
    if (members.length < 2) continue;
    const singleGroup = groupIndexes.length === 1;
    const kind: CloneKind = !singleGroup
      ? 'near-miss'
      : new Set(members.map(input.rawKey)).size === 1
        ? 'identical'
        : 'normalized';
    clusters.push({ members, kind, similarity: singleGroup ? 1 : (componentSimilarity.get(root) ?? 1) });
  }
  return clusters;
}
