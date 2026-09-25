export interface TedNode {
  label: string;
  children: readonly TedNode[];
}

/** Post-order arrays (1-based) that the distance algorithm needs, computed once per tree. */
export interface PreparedTree {
  size: number;
  labels: Int32Array;
  leftmost: Int32Array;
  keyroots: number[];
}

export function prepareTree(root: TedNode, intern: (label: string) => number): PreparedTree {
  const labels: number[] = [0];
  const leftmost: number[] = [0];

  const visit = (node: TedNode): number => {
    let first = 0;
    for (const child of node.children) {
      const childLeftmost = visit(child);
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

  return {
    size: labels.length - 1,
    labels: Int32Array.from(labels),
    leftmost: Int32Array.from(leftmost),
    keyroots: [...highestByLeftmost.values()].sort((x, y) => x - y),
  };
}

/** Minimum number of node insertions, deletions and relabels turning tree `a` into tree `b`. */
export function editDistance(a: PreparedTree, b: PreparedTree): number {
  const treeStride = b.size + 1;
  const treeDist = new Int32Array((a.size + 1) * treeStride);
  const forestStride = b.size + 2;
  const forestDist = new Int32Array((a.size + 2) * forestStride);

  for (const i of a.keyroots) {
    for (const j of b.keyroots) {
      const leftI = a.leftmost[i];
      const leftJ = b.leftmost[j];

      forestDist[0] = 0;
      for (let x = 1; x <= i - leftI + 1; x++) forestDist[x * forestStride] = forestDist[(x - 1) * forestStride] + 1;
      for (let y = 1; y <= j - leftJ + 1; y++) forestDist[y] = forestDist[y - 1] + 1;

      for (let x = leftI; x <= i; x++) {
        const dx = x - leftI + 1;
        for (let y = leftJ; y <= j; y++) {
          const dy = y - leftJ + 1;
          const remove = forestDist[(dx - 1) * forestStride + dy] + 1;
          const insert = forestDist[dx * forestStride + dy - 1] + 1;

          if (a.leftmost[x] === leftI && b.leftmost[y] === leftJ) {
            const relabel = forestDist[(dx - 1) * forestStride + dy - 1] + (a.labels[x] === b.labels[y] ? 0 : 1);
            const distance = Math.min(remove, insert, relabel);
            forestDist[dx * forestStride + dy] = distance;
            treeDist[x * treeStride + y] = distance;
          } else {
            const p = a.leftmost[x] - leftI;
            const q = b.leftmost[y] - leftJ;
            const viaSubtrees = forestDist[p * forestStride + q] + treeDist[x * treeStride + y];
            forestDist[dx * forestStride + dy] = Math.min(remove, insert, viaSubtrees);
          }
        }
      }
    }
  }
  return treeDist[a.size * treeStride + b.size];
}
