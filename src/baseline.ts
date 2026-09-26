import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CloneCluster, Location, SourceFile } from './types.js';

export const BASELINE_FILE = 'baseline.json';

export interface Baseline {
  generatedAt: string;
  /** One fingerprint per accepted cluster, order not significant. */
  fingerprints: string[];
}

export interface BaselineSplit {
  /** Clusters not present in the baseline: what the duplication gate is evaluated against. */
  newClusters: CloneCluster[];
  /** Clusters that matched a fingerprint in the baseline: reported, but not gated on. */
  baselinedClusters: CloneCluster[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function filesByPath(files: readonly SourceFile[]): Map<string, SourceFile> {
  return new Map(files.map((file) => [file.path, file]));
}

/**
 * Content, not position: an unrelated edit that shifts a duplicate's line numbers does not change
 * its fingerprint, but fixing one copy, or the duplicated text itself changing, does. When the file
 * is gone, a position-based fallback is used, which by construction never matches again — a moved
 * or deleted file makes that particular baseline entry inert rather than silently permanent.
 */
function memberFingerprint(location: Location, files: ReadonlyMap<string, SourceFile>): string {
  const file = files.get(location.path);
  if (file === undefined) return `missing:${location.path}:${location.startLine}-${location.endLine}`;
  const lines = file.text.split('\n').slice(location.startLine - 1, location.endLine);
  return sha256(`${location.path}\n${lines.join('\n')}`);
}

export function fingerprintCluster(cluster: CloneCluster, files: ReadonlyMap<string, SourceFile>): string {
  const members = cluster.locations.map((location) => memberFingerprint(location, files)).sort();
  return sha256(`${cluster.detector}|${cluster.kind}|${members.join('|')}`);
}

export function buildBaseline(clusters: readonly CloneCluster[], files: readonly SourceFile[]): Baseline {
  const index = filesByPath(files);
  return {
    generatedAt: new Date().toISOString(),
    fingerprints: clusters.map((cluster) => fingerprintCluster(cluster, index)),
  };
}

export function splitAgainstBaseline(
  clusters: readonly CloneCluster[],
  baseline: Baseline,
  files: readonly SourceFile[],
): BaselineSplit {
  const index = filesByPath(files);
  const accepted = new Set(baseline.fingerprints);
  const newClusters: CloneCluster[] = [];
  const baselinedClusters: CloneCluster[] = [];
  for (const cluster of clusters) {
    const bucket = accepted.has(fingerprintCluster(cluster, index)) ? baselinedClusters : newClusters;
    bucket.push(cluster);
  }
  return { newClusters, baselinedClusters };
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function loadBaseline(file: string): Promise<Baseline | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Baseline ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const fingerprints = (parsed as Partial<Baseline> | null)?.fingerprints;
  if (!Array.isArray(fingerprints) || !fingerprints.every((entry) => typeof entry === 'string')) {
    throw new Error(`Baseline ${file} is malformed: expected a "fingerprints" array of strings`);
  }
  const generatedAt = (parsed as Partial<Baseline>).generatedAt;
  return { generatedAt: typeof generatedAt === 'string' ? generatedAt : '', fingerprints };
}