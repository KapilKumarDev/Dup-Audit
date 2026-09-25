import type { SourceFile } from './types.js';

export interface Coverage {
  percent: number;
  coveredLines: number;
  totalLines: number;
  /** Lines nobody examined, grouped by extension, so gaps are actionable. */
  uncoveredLinesByExtension: Record<string, number>;
}

export function computeCoverage(files: readonly SourceFile[], analyzed: ReadonlySet<string>): Coverage {
  let coveredLines = 0;
  let totalLines = 0;
  const uncoveredLinesByExtension: Record<string, number> = {};

  for (const file of files) {
    totalLines += file.lines;
    if (analyzed.has(file.path)) {
      coveredLines += file.lines;
    } else {
      uncoveredLinesByExtension[file.ext] = (uncoveredLinesByExtension[file.ext] ?? 0) + file.lines;
    }
  }

  return {
    percent: totalLines === 0 ? 100 : (coveredLines / totalLines) * 100,
    coveredLines,
    totalLines,
    uncoveredLinesByExtension,
  };
}
