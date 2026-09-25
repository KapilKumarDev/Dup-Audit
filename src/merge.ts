import { compareLocations, contains } from './locations.js';
import type { CloneCluster, Location } from './types.js';

interface Member {
  cluster: number;
  member: number;
  location: Location;
}

/**
 * A token-level pair is redundant when its two sides sit inside two different members of the same
 * structural cluster: the structural finding already reports that duplication, with more context.
 */
export function dropExplainedPairs(
  pairs: readonly CloneCluster[],
  explainers: readonly CloneCluster[],
): CloneCluster[] {
  const membersByPath = new Map<string, Member[]>();
  explainers.forEach((cluster, clusterIndex) => {
    cluster.locations.forEach((location, member) => {
      const list = membersByPath.get(location.path);
      const entry = { cluster: clusterIndex, member, location };
      if (list === undefined) membersByPath.set(location.path, [entry]);
      else list.push(entry);
    });
  });
  const enclosing = (inner: Location): Member[] =>
    (membersByPath.get(inner.path) ?? []).filter((entry) => contains(entry.location, inner));

  return pairs.filter((pair) => {
    if (pair.locations.length !== 2) return true;
    const [first, second] = pair.locations.map(enclosing);
    return !first.some((a) => second.some((b) => a.cluster === b.cluster && a.member !== b.member));
  });
}

/** Lines that would disappear if every cluster kept a single copy, without counting a line twice. */
export function countDuplicatedLines(clusters: readonly CloneCluster[]): number {
  const spansByPath = new Map<string, [start: number, end: number][]>();
  for (const cluster of clusters) {
    for (const { path, startLine, endLine } of [...cluster.locations].sort(compareLocations).slice(1)) {
      const spans = spansByPath.get(path);
      if (spans === undefined) spansByPath.set(path, [[startLine, endLine]]);
      else spans.push([startLine, endLine]);
    }
  }

  let total = 0;
  for (const spans of spansByPath.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = spans[0];
    for (const [nextStart, nextEnd] of spans.slice(1)) {
      if (nextStart <= end + 1) {
        end = Math.max(end, nextEnd);
      } else {
        total += end - start + 1;
        [start, end] = [nextStart, nextEnd];
      }
    }
    total += end - start + 1;
  }
  return total;
}
