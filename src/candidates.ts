/** Maps strings to small stable integers so features and labels compare cheaply. */
export class Interner {
  private readonly ids = new Map<string, number>();

  id(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(value, id);
    }
    return id;
  }
}

export interface CandidateOptions {
  minJaccard: number;
  /** Features shared by more items than this are ignored as boilerplate. */
  maxPosting: number;
}

export interface CandidatePair {
  a: number;
  b: number;
  jaccard: number;
}

/**
 * Finds item pairs whose feature sets overlap enough to be worth a precise comparison.
 * Uses an inverted index, so cost follows the amount of real overlap, not items squared.
 */
export function findCandidatePairs(
  featureSets: readonly (readonly number[])[],
  { minJaccard, maxPosting }: CandidateOptions,
): CandidatePair[] {
  const postings = new Map<number, number[]>();
  featureSets.forEach((features, index) => {
    for (const feature of new Set(features)) {
      const list = postings.get(feature);
      if (list === undefined) postings.set(feature, [index]);
      else list.push(index);
    }
  });

  const count = featureSets.length;
  const sizes = new Array<number>(count).fill(0);
  const overlaps = new Map<number, number>();
  for (const list of postings.values()) {
    if (list.length > maxPosting) continue;
    for (const index of list) sizes[index]++;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const key = list[x] * count + list[y];
        overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: CandidatePair[] = [];
  for (const [key, overlap] of overlaps) {
    const a = Math.floor(key / count);
    const b = key % count;
    const jaccard = overlap / (sizes[a] + sizes[b] - overlap);
    if (jaccard >= minJaccard) pairs.push({ a, b, jaccard });
  }
  return pairs;
}
