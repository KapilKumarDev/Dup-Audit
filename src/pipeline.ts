import path from 'node:path';
import { BASELINE_FILE, loadBaseline, splitAgainstBaseline } from './baseline.js';
import type { Config } from './config.js';
import { computeCoverage } from './coverage.js';
import { createCssDetector } from './detectors/css.js';
import { createStructureDetector } from './detectors/structure.js';
import { createTokenDetector } from './detectors/tokens.js';
import { collectInventory } from './inventory.js';
import { compareLocations } from './locations.js';
import { countDuplicatedLines, dropExplainedPairs } from './merge.js';
import type { AuditReport, Gate } from './report.js';
import type { CloneCluster, Detector, DetectorId, SourceFile } from './types.js';

export interface AuditOutcome {
  report: AuditReport;
  passed: boolean;
  /** Files the audit read, exposed so `dup-audit baseline` can fingerprint report.clusters without re-scanning the tree. */
  files: readonly SourceFile[];
}

export interface RunAuditOptions {
  detectors?: readonly Detector[];
  /** Report directory, used to find baseline.json when config.baseline.enabled is set. Defaults to <root>/.dup-audit. */
  outputDir?: string;
}

export function createDetectors(root: string, config: Config): Detector[] {
  const factories: Record<DetectorId, () => Detector> = {
    tokens: () => createTokenDetector(root, config.tokens),
    structure: () => createStructureDetector(config.structure),
    css: () => createCssDetector(config.css),
  };
  return config.detectors.map((id) => factories[id]());
}

/** Lines a cluster would save if reduced to one copy; used to list the biggest problems first. */
function savableLines(cluster: CloneCluster): number {
  return [...cluster.locations]
    .sort(compareLocations)
    .slice(1)
    .reduce((sum, { startLine, endLine }) => sum + endLine - startLine + 1, 0);
}

export async function runAudit(root: string, config: Config, options: RunAuditOptions = {}): Promise<AuditOutcome> {
  const detectors = options.detectors ?? createDetectors(root, config);
  const inventory = await collectInventory(root, config);

  const results = [];
  for (const detector of detectors) results.push(await detector.run(inventory.files));

  const analyzed = new Set(results.flatMap((result) => result.analyzed));
  const coverage = computeCoverage(inventory.files, analyzed);

  const found = results.flatMap((result) => result.clusters);
  const structural = found.filter((cluster) => cluster.detector !== 'tokens');
  const tokenPairs = found.filter((cluster) => cluster.detector === 'tokens');
  const clusters = [...structural, ...dropExplainedPairs(tokenPairs, structural)].sort(
    (a, b) => savableLines(b) - savableLines(a),
  );

  let gatedClusters = clusters;
  let baselinedClusterCount = 0;
  if (config.baseline.enabled) {
    const outputDir = options.outputDir ?? path.join(root, '.dup-audit');
    const baseline = await loadBaseline(path.join(outputDir, BASELINE_FILE));
    if (baseline !== undefined) {
      const split = splitAgainstBaseline(clusters, baseline, inventory.files);
      gatedClusters = split.newClusters;
      baselinedClusterCount = split.baselinedClusters.length;
    }
  }

  const duplicatedLines = countDuplicatedLines(clusters);
  const duplicationPercent = coverage.coveredLines === 0 ? 0 : (duplicatedLines / coverage.coveredLines) * 100;
  const gatedDuplicatedLines = countDuplicatedLines(gatedClusters);
  const gatedDuplicationPercent =
    coverage.coveredLines === 0 ? 0 : (gatedDuplicatedLines / coverage.coveredLines) * 100;

  const clustersByDetector: AuditReport['duplication']['clustersByDetector'] = {};
  for (const { detector } of clusters) clustersByDetector[detector] = (clustersByDetector[detector] ?? 0) + 1;

  const gates = {
    coverage: gate(config.gates.minCoveragePercent, coverage.percent, (actual, limit) => actual >= limit),
    duplication: gate(config.gates.maxDuplicationPercent, gatedDuplicationPercent, (actual, limit) => actual <= limit),
  };

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    root,
    coverage,
    duplication: {
      percent: duplicationPercent,
      duplicatedLines,
      clusterCount: clusters.length,
      clustersByDetector,
      baseline: config.baseline.enabled
        ? { baselinedClusterCount, newClusterCount: gatedClusters.length, newPercent: gatedDuplicationPercent }
        : undefined,
    },
    excluded: inventory.excluded,
    failures: results.flatMap((result) => result.failures),
    notes: results.flatMap((result) => result.notes),
    gates,
    clusters,
  };
  return { report, passed: gates.coverage.passed && gates.duplication.passed, files: inventory.files };
}

function gate(limit: number, actual: number, passes: (actual: number, limit: number) => boolean): Gate {
  return { limit, actual, passed: passes(actual, limit) };
}