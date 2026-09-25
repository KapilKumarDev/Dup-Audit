import type { Location } from './types.js';

export function compareLocations(a: Location, b: Location): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.startLine - b.startLine;
}

export function contains(outer: Location, inner: Location): boolean {
  return outer.path === inner.path && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}
