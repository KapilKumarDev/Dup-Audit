export interface TedNode {
  label: string;
  children: readonly TedNode[];
}

/**
 * Post-order arrays (1-based) of a tree read in one child order. `cost` is the number of table cells one
 * tree contributes to a Zhang-Shasha run, which depends on the order: trees nesting to the right are
 * cheap to read right-to-left.
 */
interface Orientation {
  labels: Int32Array;
  leftmost: Int32Array;
  keyroots: number[];
  cost: number;
}

/** Both reading orders of a tree, computed once per tree. Reversing the children of both trees keeps the distance. */
export interface PreparedTree {
  size: number;
  forward: Orientation;
  mirrored: Orientation;
}

export function prepareTree(root: TedNode, intern: (label: string) => number): PreparedTree {
  const forward = orient(root, intern, false);
  return { size: forward.labels.length - 1, forward, mirrored: orient(root, intern, true) };
}

function orient(root: TedNode, intern: (label: string) => number, mirrored: boolean): Orientation {
  const labels: number[] = [0];
  const leftmost: number[] = [0];

  const visit = (node: TedNode): number => {
    let first = 0;
    const count = node.children.length;
    for (let position = 0; position < count; position++) {
      const childLeftmost = visit(node.children[mirrored ? count - 1 - position : position]);
      if (first === 0) first = childLeftmost;
    }
    labels.push(intern(node.label));
    const index = labels.length - 1;
    leftmost[index] = first === 0 ? index : first;
    return leftmost[index];
  };
  visit(root);

  // A keyroot is the highest node among all nodes sharing the same leftmost leaf.
  const highestByLeftmost = new Map<number, number>();
  for (let index = 1; index < labels.length; index++) highestByLeftmost.set(leftmost[index], index);
  const keyroots = [...highestByLeftmost.values()].sort((x, y) => x - y);

  return {
    labels: Int32Array.from(labels),
    leftmost: Int32Array.from(leftmost),
    keyroots,
    cost: keyroots.reduce((sum, keyroot) => sum + keyroot - leftmost[keyroot] + 1, 0),
  };
}

let treeScratch = new Int32Array(0);
let forestScratch = new Int32Array(0);

/**
 * Tables for one distance call. Large trees need tens of megabytes each, so the buffers are kept and grown
 * rather than reallocated per call; every cell read is written first within the same pass.
 */
function scratchTables(treeCells: number, forestCells: number): { treeDist: Int32Array; forestDist: Int32Array } {
  if (treeScratch.length < treeCells) treeScratch = new Int32Array(treeCells);
  if (forestScratch.length < forestCells) forestScratch = new Int32Array(forestCells);
  return { treeDist: treeScratch, forestDist: forestScratch };
}

/** Edits allowed above the lower bound in the first pass of `editDistance`; each failed pass doubles the bound. */
const FIRST_SLACK = 8;

/**
 * Minimum number of node insertions, deletions and relabels turning tree `a` into tree `b`.
 *
 * With `maxDistance` the result is exact when it is at most `maxDistance` and `maxDistance + 1` otherwise.
 * Two forests whose sizes differ by more than the bound cannot be within it, so the Zhang-Shasha table is
 * only filled inside a diagonal band (the strip of Ukkonen's bounded string edit distance) and the bound is
 * doubled until the distance fits. Similar trees therefore cost O(n * distance) cells per keyroot pair
 * instead of O(n^2). Each pair is read in whichever child order has the smaller table. The first bound is the
 * string edit distance of the pre-order and post-order label sequences, a known lower bound that is within a
 * few edits of the distance for edited copies, and that rejects clearly different pairs without any table.
 */
export function editDistance(a: PreparedTree, b: PreparedTree, maxDistance = a.size + b.size): number {
  const limit = Math.min(maxDistance, a.size + b.size);
  const gap = Math.abs(a.size - b.size);
  if (gap > limit) return limit + 1;

  const mirrored = a.mirrored.cost * b.mirrored.cost < a.forward.cost * b.forward.cost;
  const first = mirrored ? a.mirrored : a.forward;
  const second = mirrored ? b.mirrored : b.forward;
  // Post-order of the mirrored tree is the reversed pre-order, and reversing both sequences keeps their distance.
  const lowerBound = Math.max(
    sequenceDistance(a.forward.labels.subarray(1), b.forward.labels.subarray(1), limit),
    sequenceDistance(a.mirrored.labels.subarray(1), b.mirrored.labels.subarray(1), limit),
  );
  if (lowerBound > limit) return limit + 1;

  const { treeDist, forestDist } = scratchTables((a.size + 1) * (b.size + 1), (a.size + 2) * (b.size + 2));
  let bound = Math.min(lowerBound + FIRST_SLACK, limit);
  for (;;) {
    const distance = bandedDistance(first, second, bound, treeDist, forestDist);
    if (distance <= bound) return distance;
    if (bound === limit) return limit + 1;
    bound = Math.min(bound * 2, limit);
  }
}

/** Edit distance between two label sequences when it is at most `bound`, otherwise `bound + 1`. */
function sequenceDistance(x: Int32Array, y: Int32Array, bound: number): number {
  const cap = bound + 1;
  if (Math.abs(x.length - y.length) > bound) return cap;

  let previous = new Int32Array(y.length + 1);
  let current = new Int32Array(y.length + 1);
  for (let column = 0; column <= y.length; column++) previous[column] = Math.min(column, cap);
  for (let row = 1; row <= x.length; row++) {
    const first = Math.max(1, row - bound);
    const last = Math.min(y.length, row + bound);
    current[first - 1] = first === 1 ? Math.min(row, cap) : cap;
    for (let column = first; column <= last; column++) {
      const substitute = previous[column - 1] + (x[row - 1] === y[column - 1] ? 0 : 1);
      current[column] = Math.min(substitute, previous[column] + 1, current[column - 1] + 1, cap);
    }
    if (last < y.length) current[last + 1] = cap;
    [previous, current] = [current, previous];
  }
  return previous[y.length];
}

/**
 * Zhang-Shasha restricted to what can matter within `bound` edits: forest pairs whose sizes differ by at most
 * `bound`, and keyroot pairs whose subtrees sit at comparable positions. Anything else reads as `bound + 1`.
 */
function bandedDistance(a: Orientation, b: Orientation, bound: number, treeDist: Int32Array, forestDist: Int32Array): number {
  const cap = bound + 1;
  const sizeA = a.labels.length - 1;
  const sizeB = b.labels.length - 1;
  const treeStride = sizeB + 1;
  const forestStride = sizeB + 2;
  const forestAt = (row: number, column: number): number =>
    Math.abs(row - column) > bound ? cap : forestDist[row * forestStride + column];
  treeDist.fill(cap, 0, (sizeA + 1) * treeStride);

  for (const i of a.keyroots) {
    for (const j of b.keyroots) {
      const leftI = a.leftmost[i];
      const leftJ = b.leftmost[j];
      // The nodes before a subtree in post-order are the nodes before its leftmost leaf. Subtrees matched
      // within `bound` edits cannot have counts further apart than that, so their tables are never needed.
      if (Math.abs(leftI - leftJ) > bound) continue;
      const rows = i - leftI + 1;
      const columns = j - leftJ + 1;

      forestDist[0] = 0;
      for (let dx = 1; dx <= Math.min(rows, bound); dx++) forestDist[dx * forestStride] = dx;
      for (let dy = 1; dy <= Math.min(columns, bound); dy++) forestDist[dy] = dy;

      for (let dx = 1; dx <= rows; dx++) {
        const x = leftI + dx - 1;
        const last = Math.min(columns, dx + bound);
        for (let dy = Math.max(1, dx - bound); dy <= last; dy++) {
          const y = leftJ + dy - 1;
          const remove = forestAt(dx - 1, dy) + 1;
          const insert = forestAt(dx, dy - 1) + 1;

          if (a.leftmost[x] === leftI && b.leftmost[y] === leftJ) {
            const relabel = forestAt(dx - 1, dy - 1) + (a.labels[x] === b.labels[y] ? 0 : 1);
            const distance = Math.min(remove, insert, relabel, cap);
            forestDist[dx * forestStride + dy] = distance;
            treeDist[x * treeStride + y] = distance;
          } else {
            const viaSubtrees = forestAt(a.leftmost[x] - leftI, b.leftmost[y] - leftJ) + treeDist[x * treeStride + y];
            forestDist[dx * forestStride + dy] = Math.min(remove, insert, viaSubtrees, cap);
          }
        }
      }
    }
  }
  return treeDist[sizeA * treeStride + sizeB];
}