import type { Config } from './config.js';
import { computeCoverage } from './coverage.js';
import { createCssDetector } from './detectors/css.js';
import { createStructureDetector } from './detectors/structure.js';
import { createTokenDetector } from './detectors/tokens.js';
import { collectInventory } from './inventory.js';
import { compareLocations } from './locations.js';
import { countDuplicatedLines, dropExplainedPairs } from './merge.js';
import type { AuditReport, Gate } from './report.js';
import type { CloneCluster, Detector, DetectorId } from './types.js';

export interface AuditOutcome {
  report: AuditReport;
  passed: boolean;
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

export async function runAudit(
  root: string,
  config: Config,
  detectors: readonly Detector[] = createDetectors(root, config),
): Promise<AuditOutcome> {
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

  const duplicatedLines = countDuplicatedLines(clusters);
  const duplicationPercent = coverage.coveredLines === 0 ? 0 : (duplicatedLines / coverage.coveredLines) * 100;

  const clustersByDetector: AuditReport['duplication']['clustersByDetector'] = {};
  for (const { detector } of clusters) clustersByDetector[detector] = (clustersByDetector[detector] ?? 0) + 1;

  const gates = {
    coverage: gate(config.gates.minCoveragePercent, coverage.percent, (actual, limit) => actual >= limit),
    duplication: gate(config.gates.maxDuplicationPercent, duplicationPercent, (actual, limit) => actual <= limit),
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
    },
    excluded: inventory.excluded,
    failures: results.flatMap((result) => result.failures),
    notes: results.flatMap((result) => result.notes),
    gates,
    clusters,
  };
  return { report, passed: gates.coverage.passed && gates.duplication.passed };
}

function gate(limit: number, actual: number, passes: (actual: number, limit: number) => boolean): Gate {
  return { limit, actual, passed: passes(actual, limit) };
}
