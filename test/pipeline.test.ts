import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../src/config.js';
import { createDetectors, runAudit } from '../src/pipeline.js';
import { toSarif } from '../src/report.js';
import { FORMAT_LABEL, makeRepo, ORDER_TOTAL, ORDER_TOTAL_RENAMED } from './helpers.js';

const CARD = `.card {\n  display: flex;\n  padding: 8px 16px;\n  border: 1px solid #ccc;\n}\n`;
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const config = (overrides: Partial<typeof DEFAULT_CONFIG> = {}) => ({
  ...structuredClone(DEFAULT_CONFIG),
  detectors: ['structure', 'css'] as typeof DEFAULT_CONFIG.detectors,
  ...overrides,
});

const repoFiles = {
  'src/cart.ts': ORDER_TOTAL,
  'src/invoice.ts': ORDER_TOTAL_RENAMED,
  'src/label.ts': FORMAT_LABEL,
  'src/a.css': CARD,
  'src/b.css': CARD.replace('.card', '.tile'),
};

describe('runAudit', () => {
  it('combines detectors, measures coverage and duplication, and evaluates the gates', async () => {
    const root = makeRepo(repoFiles);
    const settings = config({ gates: { minCoveragePercent: 90, maxDuplicationPercent: 100 } });
    const { report, passed } = await runAudit(root, settings);

    assert.equal(report.coverage.percent, 100);
    assert.equal(report.duplication.clusterCount, 2);
    assert.deepEqual(report.duplication.clustersByDetector, { structure: 1, css: 1 });
    assert.equal(report.duplication.duplicatedLines, 12 + 5);
    assert.ok(report.duplication.percent > 0 && report.duplication.percent < 100);
    assert.equal(passed, true);
    assert.equal(report.clusters[0].detector, 'structure', 'largest saving first');
  });

  it('fails the coverage gate when code is left unexamined, and names the gap', async () => {
    const root = makeRepo({ ...repoFiles, 'src/widget.vue': '<template>\n<div/>\n</template>\n'.repeat(20) });
    const { report, passed } = await runAudit(root, config({ gates: { minCoveragePercent: 90, maxDuplicationPercent: 100 } }));
    assert.ok(report.coverage.percent < 90);
    assert.ok(report.coverage.uncoveredLinesByExtension['.vue'] > 0);
    assert.equal(report.gates.coverage.passed, false);
    assert.equal(passed, false);
  });

  it('fails the duplication gate when duplication exceeds the limit', async () => {
    const root = makeRepo(repoFiles);
    const { report, passed } = await runAudit(root, config({ gates: { minCoveragePercent: 90, maxDuplicationPercent: 1 } }));
    assert.equal(report.gates.duplication.passed, false);
    assert.equal(passed, false);
  });

  it('counts files that fail to parse as uncovered and lists them', async () => {
    const root = makeRepo({ ...repoFiles, 'src/broken.css': '.x { color: red; ' });
    const { report } = await runAudit(root, config());
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].path, 'src/broken.css');
    assert.ok(report.coverage.uncoveredLinesByExtension['.css'] > 0);
  });

  it('builds detectors from the configured ids only', () => {
    assert.deepEqual(createDetectors('/x', config()).map((detector) => detector.id), ['structure', 'css']);
  });

  it('produces SARIF with related locations for every cluster', async () => {
    const { report } = await runAudit(makeRepo(repoFiles), config());
    const sarif = toSarif(report) as { runs: { results: { relatedLocations: unknown[] }[] }[] };
    assert.equal(sarif.runs[0].results.length, report.clusters.length);
    assert.equal(sarif.runs[0].results[0].relatedLocations.length, report.clusters[0].locations.length - 1);
  });
});

describe('cli', () => {
  const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [CLI, root, ...args], { encoding: 'utf8' });

  it('writes both reports and exits 1 when a gate fails', () => {
    const root = makeRepo({
      ...repoFiles,
      [CONFIG_FILE]: JSON.stringify({ detectors: ['structure', 'css'], gates: { maxDuplicationPercent: 1 } }),
    });
    const outDir = path.join(root, 'out');
    const result = run(root, '--out', outDir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Duplication:.*FAIL/);
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.gates.duplication.passed, false);
    assert.equal(JSON.parse(readFileSync(path.join(outDir, 'report.sarif'), 'utf8')).version, '2.1.0');
  });

  it('exits 0 when every gate passes', () => {
    const root = makeRepo({
      ...repoFiles,
      [CONFIG_FILE]: JSON.stringify({ detectors: ['structure', 'css'], gates: { maxDuplicationPercent: 100 } }),
    });
    assert.equal(run(root, '--out', path.join(root, 'out')).status, 0);
  });

  it('exits 2 with a clear message on a config error', () => {
    const root = makeRepo({ ...repoFiles, [CONFIG_FILE]: JSON.stringify({ nope: 1 }) });
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown config key "nope"/);
  });
});
