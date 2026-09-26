import type { Coverage } from './coverage.js';
import type { CloneCluster, DeadCodeFinding, DetectorId, Failure, Location } from './types.js';

export interface Gate {
  limit: number;
  actual: number;
  passed: boolean;
}

export interface AuditReport {
  generatedAt: string;
  root: string;
  coverage: Coverage;
  duplication: {
    percent: number;
    duplicatedLines: number;
    clusterCount: number;
    clustersByDetector: Partial<Record<DetectorId, number>>;
    /** Present when config.baseline.enabled: the gate is evaluated against newPercent, not percent. */
    baseline?: { baselinedClusterCount: number; newClusterCount: number; newPercent: number };
  };
  /** High-confidence counts gate the build (when enabled); 'uncertain*' findings never do - see detectors/deadcode.ts. */
  deadCode: {
    findings: DeadCodeFinding[];
    deadFileCount: number;
    deadExportCount: number;
    uncertainFileCount: number;
    uncertainExportCount: number;
  };
  excluded: { files: number; lines: number };
  failures: Failure[];
  notes: string[];
  gates: { coverage: Gate; duplication: Gate; deadCode: Gate };
  clusters: CloneCluster[];
}

const SUMMARY_CLUSTER_LIMIT = 10;

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;
const formatLocation = ({ path, startLine, endLine }: Location): string => `${path}:${startLine}-${endLine}`;
const gateLabel = (gate: Gate): string => (gate.passed ? 'PASS' : 'FAIL');

export function formatSummary(report: AuditReport, outputDir: string): string {
  const { coverage, duplication, deadCode, gates, excluded } = report;
  const uncertain = deadCode.uncertainFileCount + deadCode.uncertainExportCount;
  const lines = [
    `dup-audit: ${report.root}`,
    `Coverage:    ${formatPercent(coverage.percent)} (${coverage.coveredLines}/${coverage.totalLines} lines), needs >= ${gates.coverage.limit}%: ${gateLabel(gates.coverage)}`,
    `Duplication: ${formatPercent(duplication.percent)} (${duplication.duplicatedLines} lines in ${duplication.clusterCount} clusters), allows <= ${gates.duplication.limit}%: ${gateLabel(gates.duplication)}`,
    `Dead code:   ${deadCode.deadFileCount} file(s), ${deadCode.deadExportCount} export(s), allows <= ${gates.deadCode.limit} file(s): ${gateLabel(gates.deadCode)}` +
      (uncertain > 0 ? ` (+${uncertain} uncertain, never gated)` : ''),
  ];

  const detectors = Object.entries(duplication.clustersByDetector).map(([id, count]) => `${id}: ${count}`);
  if (detectors.length > 0) lines.push(`  by detector  ${detectors.join(', ')}`);
  if (duplication.baseline !== undefined) {
    const { baselinedClusterCount, newClusterCount, newPercent } = duplication.baseline;
    lines.push(
      `  baseline  ${baselinedClusterCount} pre-existing cluster(s) excluded, ${newClusterCount} new (${formatPercent(newPercent)} of code), gate applies to new only`,
    );
  }

  const uncovered = Object.entries(coverage.uncoveredLinesByExtension).map(([ext, count]) => `${ext}: ${count}`);
  if (uncovered.length > 0) lines.push(`  uncovered lines  ${uncovered.join(', ')}`);
  if (excluded.files > 0) lines.push(`  excluded by config  ${excluded.files} files (${excluded.lines} lines)`);
  for (const failure of report.failures) lines.push(`  could not analyze ${failure.path}: ${failure.message}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);

  if (report.clusters.length > 0) {
    lines.push('', `Largest clusters (${Math.min(SUMMARY_CLUSTER_LIMIT, report.clusters.length)} of ${report.clusters.length}):`);
    for (const cluster of report.clusters.slice(0, SUMMARY_CLUSTER_LIMIT)) {
      lines.push(
        `  [${cluster.detector}/${cluster.kind} ${formatPercent(cluster.similarity * 100)}] ${cluster.locations.map(formatLocation).join('  <->  ')}`,
      );
    }
  }
  if (deadCode.findings.length > 0) {
    lines.push('', `Dead code (${Math.min(SUMMARY_CLUSTER_LIMIT, deadCode.findings.length)} of ${deadCode.findings.length}):`);
    for (const finding of deadCode.findings.slice(0, SUMMARY_CLUSTER_LIMIT)) {
      lines.push(`  [${finding.kind}] ${formatLocation(finding.location)} - ${finding.reason}`);
    }
  }

  lines.push('', `Reports: ${outputDir}`);
  return lines.join('\n');
}

const RULE_DESCRIPTIONS: Record<DetectorId, string> = {
  tokens: 'Identical token sequence found in more than one place',
  structure: 'Function-level structural clone (identical, renamed, or near-miss)',
  css: 'CSS rule with identical or near-identical declarations',
  deadcode: 'File or export unreachable from any configured entry point',
};

const physicalLocation = ({ path, startLine, endLine }: Location) => ({
  physicalLocation: { artifactLocation: { uri: path }, region: { startLine, endLine } },
});

export function toSarif(report: AuditReport): unknown {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'dup-audit',
            rules: Object.entries(RULE_DESCRIPTIONS).map(([id, text]) => ({
              id: `dup-audit/${id}`,
              shortDescription: { text },
            })),
          },
        },
        results: [
          ...report.clusters.map((cluster) => ({
            ruleId: `dup-audit/${cluster.detector}`,
            level: 'warning',
            message: {
              text: `${cluster.kind} clone across ${cluster.locations.length} locations (similarity ${formatPercent(cluster.similarity * 100)})`,
            },
            locations: [physicalLocation(cluster.locations[0])],
            relatedLocations: cluster.locations.slice(1).map((location, index) => ({ id: index + 1, ...physicalLocation(location) })),
          })),
          ...report.deadCode.findings.map((finding) => ({
            ruleId: 'dup-audit/deadcode',
            level: finding.kind.startsWith('uncertain') ? 'note' : 'warning',
            message: { text: `${finding.kind}: ${finding.reason}` },
            locations: [physicalLocation(finding.location)],
          })),
        ],
      },
    ],
  };
}