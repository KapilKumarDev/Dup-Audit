#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatCalibration, runCalibration } from './calibrate.js';
import { loadConfig } from './config.js';
import { runAudit } from './pipeline.js';
import { formatSummary, toSarif } from './report.js';

const USAGE = `Usage:
  dup-audit [root] [--config <file>] [--out <dir>]
  dup-audit calibrate [root] [--config <file>] [--out <dir>] [--samples <n>] [--precision-samples <n>] [--seed <n>]

  root      Directory inside a git repository (default: current directory)
  --config  Config file (default: <root>/dup-audit.config.json when present)
  --out     Report directory (default: <root>/.dup-audit)

audit exit codes: 0 gates passed, 1 a gate failed, 2 the audit could not run.
calibrate measures recall by injecting known clones and writes a sample of clusters for a one-time precision review.`;

const CALIBRATE = 'calibrate';

function integerOption(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      samples: { type: 'string' },
      'precision-samples': { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const calibrating = positionals[0] === CALIBRATE;
  const rest = calibrating ? positionals.slice(1) : positionals;
  if (rest.length > 1) throw new Error(`Expected at most one root directory.\n\n${USAGE}`);

  const root = path.resolve(rest[0] ?? '.');
  const config = await loadConfig(root, values.config);
  const outputDir = path.resolve(values.out ?? path.join(root, '.dup-audit'));
  await mkdir(outputDir, { recursive: true });

  if (calibrating) {
    const result = await runCalibration(root, config, {
      samples: integerOption(values.samples, 'samples', 200),
      precisionSamples: integerOption(values['precision-samples'], 'precision-samples', 50),
      seed: integerOption(values.seed, 'seed', 1),
    });
    const { precisionSampleMarkdown, ...summary } = result;
    await writeFile(path.join(outputDir, 'calibration.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(path.join(outputDir, 'precision-sample.md'), precisionSampleMarkdown);
    console.log(formatCalibration(result, outputDir));
    return 0;
  }

  const { report, passed } = await runAudit(root, config);
  await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'report.sarif'), `${JSON.stringify(toSarif(report), null, 2)}\n`);
  console.log(formatSummary(report, outputDir));
  return passed ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`dup-audit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
