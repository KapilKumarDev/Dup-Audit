import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { buildModuleGraph, type ModuleGraph } from '../graph.js';
import type { DeadCodeFinding, Detector, DetectorResult, SourceFile } from '../types.js';

const PACKAGE_FILE = 'package.json';
const CONVENTIONAL_ENTRY_NAMES = new Set(['index', 'main', 'cli']);
/** Basenames too generic to trust as an "is this referenced elsewhere" hit on their own. */
const GENERIC_BASENAMES = new Set(['index', 'main', 'config', 'types', 'utils', 'helpers', 'constants']);
const MIN_HEURISTIC_MATCH_LENGTH = 4;
const TEST_PATH = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.[^/]+)$/;

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function globToRegExp(glob: string): RegExp {
  const placeholder = '\u0000';
  const body = glob
    .split('**')
    .join(placeholder)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split('*')
    .join('[^/]*')
    .split(placeholder)
    .join('.*');
  return new RegExp(`^${body}$`);
}

function matchesAny(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

/** Strings found anywhere in package.json's `main`/`bin`/`exports` fields, whatever shape they take. */
function collectPathStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectPathStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectPathStrings(item, out);
}

/** Maps a compiled/declared path (e.g. `dist/src/cli.js`) back to the source file it most likely came from. */
function toSourceCandidates(declared: string): string[] {
  const normalized = declared.replace(/^\.\//, '');
  const withoutDist = normalized.replace(/^dist\//, '');
  const ext = path.posix.extname(withoutDist);
  const swapped: Record<string, string> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };
  const sourceExt = swapped[ext];
  return [normalized, withoutDist, ...(sourceExt !== undefined ? [`${withoutDist.slice(0, -ext.length)}${sourceExt}`] : [])];
}

async function packageJsonEntries(root: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, PACKAGE_FILE), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const declared: string[] = [];
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    collectPathStrings(record.main, declared);
    collectPathStrings(record.bin, declared);
    collectPathStrings(record.exports, declared);
  }
  return declared.flatMap(toSourceCandidates);
}

/**
 * Resolves the real entry points of the program: files that run directly, not only ones that get
 * imported. Getting this wrong is the one way this detector can flag live code as dead, so every
 * source it tried is folded into the result for transparency, and it is reported every run.
 */
export async function resolveEntryPoints(
  root: string,
  files: readonly SourceFile[],
  settings: Config['deadcode'],
): Promise<{ entries: string[]; basis: string }> {
  const known = new Set(files.map((file) => file.path));
  const entries = new Set<string>();
  let basis: string;

  if (settings.entry.length > 0) {
    for (const file of files) if (matchesAny(file.path, settings.entry)) entries.add(file.path);
    basis = `deadcode.entry (${settings.entry.join(', ')})`;
  } else {
    const declared = await packageJsonEntries(root);
    for (const candidate of declared) if (known.has(candidate)) entries.add(candidate);
    if (entries.size > 0) {
      basis = 'package.json main/bin/exports';
    } else {
      for (const file of files) {
        const parts = file.path.split('/');
        const base = path.posix.basename(file.path, path.posix.extname(file.path));
        if (parts.length <= 2 && CONVENTIONAL_ENTRY_NAMES.has(base)) entries.add(file.path);
      }
      basis = 'conventional index/main/cli file at the project root';
    }
  }

  return { entries: [...entries].sort(), basis };
}

/** Files, other than the candidate itself, that mention `needle` in a dynamic specifier or string literal. */
function mentionedElsewhere(needle: string, graph: ModuleGraph, exclude: string): string | undefined {
  if (needle.length < MIN_HEURISTIC_MATCH_LENGTH) return undefined;
  for (const [filePath, node] of graph.nodes) {
    if (filePath === exclude) continue;
    const hit = [...node.dynamicSpecifiers, ...node.stringLiterals].find((text) => text.includes(needle));
    if (hit !== undefined) return filePath;
  }
  return undefined;
}

function dynamicRiskReason(candidatePath: string, graph: ModuleGraph): string | undefined {
  const withoutExt = candidatePath.replace(/\.[^./]+$/, '');
  const basename = withoutExt.split('/').pop() ?? withoutExt;
  const needles = GENERIC_BASENAMES.has(basename) ? [withoutExt] : [withoutExt, basename];
  for (const needle of needles) {
    const hitPath = mentionedElsewhere(needle, graph, candidatePath);
    if (hitPath !== undefined) return `${hitPath} contains a string that may reference this file dynamically ("${needle}")`;
  }
  return undefined;
}

/** Breadth-first reachability over the whole-file import/require/dynamic-import/re-export graph. */
function reachableFiles(graph: ModuleGraph, entries: readonly string[]): Set<string> {
  const visited = new Set<string>(entries.filter((entry) => graph.nodes.has(entry)));
  const queue = [...visited];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const edge of graph.nodes.get(current)?.edges ?? []) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return visited;
}

/** For every file reachable from a live source, which of its exported names are actually asked for. */
function usedExportsByFile(graph: ModuleGraph, reachable: ReadonlySet<string>): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const markUsed = (filePath: string, name: string): void => {
    const set = used.get(filePath);
    if (set === undefined) used.set(filePath, new Set([name]));
    else set.add(name);
  };
  for (const filePath of reachable) {
    for (const edge of graph.nodes.get(filePath)?.edges ?? []) {
      if (edge.names.includes('*')) {
        for (const name of graph.nodes.get(edge.to)?.exports.keys() ?? []) markUsed(edge.to, name);
      } else {
        for (const name of edge.names) markUsed(edge.to, name);
      }
    }
  }
  return used;
}

export function createDeadCodeDetector(root: string, settings: Config['deadcode']): Detector {
  return {
    id: 'deadcode',
    async run(files: readonly SourceFile[], excludedFiles: readonly SourceFile[] = []): Promise<DetectorResult> {
      const originalPaths = new Set(files.map((file) => file.path));
      const testFiles = settings.treatTestsAsEntry
        ? excludedFiles.filter((file) => TEST_PATH.test(file.path) && !originalPaths.has(file.path))
        : [];
      const lines = new Map(files.map((file) => [file.path, file.lines]));
      const graph = buildModuleGraph(testFiles.length > 0 ? [...files, ...testFiles] : files);
      const { entries: resolvedEntries, basis } = await resolveEntryPoints(root, files, settings);
      const entries = testFiles.length > 0 ? [...new Set([...resolvedEntries, ...testFiles.map((file) => file.path)])].sort() : resolvedEntries;

      if (entries.length === 0) {
        return {
          clusters: [],
          deadCode: [],
          analyzed: [...files.map((file) => file.path)],
          failures: [],
          notes: [
            'dead-code analysis skipped: no entry points could be resolved (checked package.json and conventional ' +
              'index/main/cli files). Set "deadcode.entry" in dup-audit.config.json to enable it.',
          ],
        };
      }

      const reachable = reachableFiles(graph, entries);
      const used = usedExportsByFile(graph, reachable);
      // Test files are only in the graph to serve as extra entry points/edges; they were never part of
      // the audited set and are never themselves candidates for a dead-file or dead-export finding.
      const analyzed = files.map((file) => file.path).filter((filePath) => graph.nodes.has(filePath));
      const findings: DeadCodeFinding[] = [];

      for (const filePath of analyzed) {
        if (matchesAny(filePath, settings.ignore)) continue;
        if (reachable.has(filePath)) continue;
        const risk = dynamicRiskReason(filePath, graph);
        findings.push({
          kind: risk === undefined ? 'dead-file' : 'uncertain-file',
          location: { path: filePath, startLine: 1, endLine: lines.get(filePath) ?? 1 },
          reason:
            risk === undefined
              ? `Not reachable from any configured entry point (${entries.join(', ')}, via ${basis}); no ` +
                'resolved import, require, dynamic import, or re-export leads to it, directly or through any other file.'
              : `Not reachable from any configured entry point, but ${risk} - reported as uncertain rather than dead.`,
        });
      }

      for (const filePath of reachable) {
        if (!originalPaths.has(filePath)) continue;
        if (matchesAny(filePath, settings.ignore)) continue;
        const node = graph.nodes.get(filePath);
        if (node === undefined) continue;
        const usedNames = used.get(filePath) ?? new Set<string>();
        for (const [name, line] of node.exports) {
          if (usedNames.has(name)) continue;
          // 'default' isn't a real identifier text to search for; every other export is skipped here if
          // it's referenced anywhere else in its own file (called by another function in the same module,
          // for example) - its declaration contributes exactly one occurrence of its own name.
          if (name !== 'default' && (node.identifierCounts.get(name) ?? 0) > 1) continue;
          const risk = mentionedElsewhereForName(name, graph, filePath);
          findings.push({
            kind: risk === undefined ? 'dead-export' : 'uncertain-export',
            location: { path: filePath, startLine: line, endLine: line, name },
            reason:
              risk === undefined
                ? `Exported as '${name}' but not imported (by name, by namespace, or by re-export) from any file ` +
                  'reachable from a configured entry point.'
                : `Exported as '${name}' with no resolved importer, but ${risk} - reported as uncertain rather than dead.`,
          });
        }
      }

      return {
        clusters: [],
        deadCode: findings,
        analyzed,
        failures: [],
        notes: [
          `dead-code entry points (${basis}${testFiles.length > 0 ? ' + test files' : ''}): ${entries.join(', ')}`,
        ],
      };
    },
  };
}

function mentionedElsewhereForName(name: string, graph: ModuleGraph, exclude: string): string | undefined {
  if (GENERIC_BASENAMES.has(name)) return undefined;
  const hitPath = mentionedElsewhere(name, graph, exclude);
  return hitPath === undefined ? undefined : `${hitPath} contains the string "${name}" (possible reflection-style access)`;
}