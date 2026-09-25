export type DetectorId = 'tokens' | 'structure' | 'css';

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
  /** Paths of the files this detector actually examined. */
  analyzed: string[];
  failures: Failure[];
  notes: string[];
}

export interface Detector {
  id: DetectorId;
  run(files: readonly SourceFile[]): Promise<DetectorResult>;
}
