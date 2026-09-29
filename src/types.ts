export type DetectorId = 'tokens' | 'structure' | 'css' | 'deadcode';

/**
 * identical  - same content apart from whitespace and comments
 * normalized - same after normalization (renamed locals and changed literals in
 *              scripts; declaration order and casing in CSS)
 * near-miss  - copied then modified, confirmed above the configured similarity
 */
export type CloneKind = 'identical' | 'normalized' | 'near-miss';

export interface Location {
  path: string;
  startLine: number;
  endLine: number;
  name?: string;
}

export interface CloneCluster {
  detector: DetectorId;
  kind: CloneKind;
  /** Lowest similarity of any confirmed pair inside the cluster, 0..1. */
  similarity: number;
  locations: Location[];
}

/**
 * dead-file       - unreachable from every configured entry point, by static import/require/dynamic-import
 *                    analysis of the whole graph (not just "does some other file mention it" - a file only
 *                    reached through another dead file is still dead; see detectors/deadcode.ts)
 * dead-export     - the file itself is reachable, but this particular exported name is never imported by
 *                    anything that is itself reachable
 * uncertain-file  / uncertain-export - same as above, but a computed (non-literal) `require`/`import()`
 *                    somewhere in the codebase, or a string literal resembling this file's path, means the
 *                    real reference graph is not fully statically known; reported, but never gates the build
 */
export type DeadCodeKind = 'dead-file' | 'dead-export' | 'uncertain-file' | 'uncertain-export';

export interface DeadCodeFinding {
  kind: DeadCodeKind;
  location: Location;
  /** Human-readable basis for the flag, e.g. which entry points were checked or which literal triggered "uncertain". */
  reason: string;
}

export interface SourceFile {
  /** Path relative to the audited root, always with forward slashes. */
  path: string;
  /** Lower-case extension including the dot. */
  ext: string;
  text: string;
  lines: number;
}

export interface Failure {
  path: string;
  message: string;
}

export interface DetectorResult {
  clusters: CloneCluster[];
  /** Findings from the deadcode detector; always empty for the clone detectors. */
  deadCode: DeadCodeFinding[];
  /** Paths of the files this detector actually examined. */
  analyzed: string[];
  failures: Failure[];
  notes: string[];
}

export interface Detector {
  id: DetectorId;
  /** excludedFiles: files the shared `ignore` list removed before `files` was built (e.g. test files) - already read once by collectInventory, so a detector that needs them (deadcode's entry points) doesn't have to re-scan. */
  run(files: readonly SourceFile[], excludedFiles?: readonly SourceFile[]): Promise<DetectorResult>;
}