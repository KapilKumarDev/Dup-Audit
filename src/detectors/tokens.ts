import path from 'node:path';
import { createRequire } from 'node:module';
import type { Config } from '../config.js';
import type { CloneCluster, Detector, DetectorResult, Location, SourceFile } from '../types.js';

/** The parts of a jscpd clone this adapter reads; jscpd's own `IClone` satisfies it structurally. */
export interface JscpdFragment {
  sourceId: string;
  start: { line: number };
  end: { line: number };
}

export interface JscpdClone {
  duplicationA: JscpdFragment;
  duplicationB: JscpdFragment;
}

export type DetectClones = (options: Record<string, unknown>) => Promise<readonly JscpdClone[]>;

// jscpd applies its own size and length limits; these keep it from silently skipping large files.
const NO_LINE_LIMIT = 10_000_000;
const NO_SIZE_LIMIT = '100mb';

// jscpd hands explicit file paths to a glob engine, so names containing these characters
// (for example Next.js "[id].tsx" or "(group)/page.tsx") would match the wrong files.
const GLOB_CHARACTERS = /[*?[\]{}()!]/;

const require = createRequire(import.meta.url);

async function detectWithJscpd(options: Record<string, unknown>): Promise<readonly JscpdClone[]> {
  const { detectClones } = require('jscpd') as { detectClones: DetectClones };
  return detectClones(options as Parameters<typeof detectClones>[0]);
}

function toLocation(root: string, known: ReadonlySet<string>, fragment: JscpdFragment): Location {
  const { sourceId, start, end } = fragment;
  if (typeof sourceId !== 'string' || !Number.isInteger(start?.line) || !Number.isInteger(end?.line)) {
    throw new Error('jscpd returned a clone in an unexpected shape; the installed jscpd version is not supported');
  }
  const relative = path.relative(root, path.resolve(root, sourceId)).split(path.sep).join('/');
  if (!known.has(relative)) {
    throw new Error(`jscpd reported a file that was not requested (${sourceId}); refusing to merge unverifiable results`);
  }
  return { path: relative, startLine: start.line, endLine: end.line };
}

export function createTokenDetector(
  root: string,
  settings: Config['tokens'],
  detect: DetectClones = detectWithJscpd,
): Detector {
  const extensions = new Set(settings.extensions);
  return {
    id: 'tokens',
    async run(files: readonly SourceFile[]): Promise<DetectorResult> {
      const eligible = files.filter((file) => extensions.has(file.ext));
      const selected = eligible.filter((file) => !GLOB_CHARACTERS.test(file.path));
      const skipped = eligible.length - selected.length;
      const known = new Set(selected.map((file) => file.path));

      const clones =
        selected.length === 0
          ? []
          : await detect({
              path: selected.map((file) => path.join(root, file.path)),
              minTokens: settings.minTokens,
              minLines: settings.minLines,
              maxLines: NO_LINE_LIMIT,
              maxSize: NO_SIZE_LIMIT,
              gitignore: false,
              silent: true,
              absolute: true,
            });

      return {
        clusters: clones.map(
          (clone): CloneCluster => ({
            detector: 'tokens',
            kind: 'identical',
            similarity: 1,
            locations: [toLocation(root, known, clone.duplicationA), toLocation(root, known, clone.duplicationB)],
          }),
        ),
        deadCode: [],
        analyzed: selected.map((file) => file.path),
        failures: [],
        notes:
          skipped === 0
            ? []
            : [`${skipped} file(s) with glob characters in their names were not passed to jscpd and count as uncovered by it.`],
      };
    },
  };
}