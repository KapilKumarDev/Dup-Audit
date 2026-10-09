import type { Config } from '../config.js';
import { resolveEntryPoints } from '../entrypoints.js';
import { createMatcher } from '../glob.js';
import path from 'node:path';
import { buildModuleGraph, type ModuleGraph } from '../graph.js';
import { loadCompilerOptions } from '../tsconfig.js';
import type { DeadCodeFinding, Detector, DetectorResult, SourceFile } from '../types.js';

/** Basenames too generic to trust as an "is this referenced elsewhere" hit on their own. */
const GENERIC_BASENAMES = new Set(['index', 'main', 'config', 'types', 'utils', 'helpers', 'constants']);
const MIN_HEURISTIC_MATCH_LENGTH = 4;
const TEST_PATH = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.[^/]+)$/;
/** Files that import scripts but that the graph cannot read into; their raw text is searched for mentions instead. */
const TEMPLATE_EXTENSIONS = new Set(['.vue', '.svelte', '.html', '.htm']);

/** Everything one file says that might name another file or export without importing it. */
interface MentionSource {
  path: string;
  texts: readonly string[];
}

function mentionSources(graph: ModuleGraph, templates: readonly SourceFile[]): MentionSource[] {
  return [
    ...[...graph.nodes].map(([path, node]) => ({ path, texts: [...node.dynamicSpecifiers, ...node.stringLiterals] })),
    ...templates.map((file) => ({ path: file.path, texts: [file.text] })),
  ];
}

/** Files, other than the candidate itself, that mention `needle` in a dynamic specifier, string literal, or template. */
function mentionedElsewhere(needle: string, sources: readonly MentionSource[], exclude: string): string | undefined {
  if (needle.length < MIN_HEURISTIC_MATCH_LENGTH) return undefined;
  return sources.find((source) => source.path !== exclude && source.texts.some((text) => text.includes(needle)))?.path;
}

function dynamicRiskReason(candidatePath: string, sources: readonly MentionSource[]): string | undefined {
  const withoutExt = candidatePath.replace(/\.[^./]+$/, '');
  const basename = withoutExt.split('/').pop() ?? withoutExt;
  const needles = GENERIC_BASENAMES.has(basename) ? [withoutExt] : [withoutExt, basename];
  for (const needle of needles) {
    const hitPath = mentionedElsewhere(needle, sources, candidatePath);
    if (hitPath !== undefined) return `${hitPath} contains a string that may reference this file dynamically ("${needle}")`;
  }
  return undefined;
}

function mentionedElsewhereForName(name: string, sources: readonly MentionSource[], exclude: string): string | undefined {
  if (GENERIC_BASENAMES.has(name)) return undefined;
  const hitPath = mentionedElsewhere(name, sources, exclude);
  return hitPath === undefined ? undefined : `${hitPath} contains the string "${name}" (possible reflection-style access)`;
}

/**
 * Files a tool config names outright, e.g. vitest's `setupFiles: ['./src/test-setup.ts']`. The tool
 * loads them, so no import ever points at them. Only exact paths count (relative to the project root
 * or to the config itself); globs like tailwind's `content` would otherwise mark whole trees live.
 */
function filesNamedBy(graph: ModuleGraph, toolOwned: readonly string[]): string[] {
  const named = new Set<string>();
  for (const configPath of toolOwned) {
    for (const literal of graph.nodes.get(configPath)?.stringLiterals ?? []) {
      for (const candidate of [path.posix.normalize(literal).replace(/^\//, ''), path.posix.join(path.posix.dirname(configPath), literal)]) {
        if (candidate !== configPath && graph.nodes.has(candidate)) named.add(candidate);
      }
    }
  }
  return [...named].sort();
}

/** Reachability over the whole-file import/require/dynamic-import/re-export graph; visit order doesn't matter. */
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
  const isIgnored = createMatcher(settings.ignore);
  return {
    id: 'deadcode',
    async run(files: readonly SourceFile[], excludedFiles: readonly SourceFile[] = []): Promise<DetectorResult> {
      const originalPaths = new Set(files.map((file) => file.path));
      const isTest = (file: SourceFile): boolean => settings.treatTestsAsEntry && TEST_PATH.test(file.path);
      // Excluded tests are only in the graph to serve as extra entry points; tests that are among the
      // audited files are already in it. Either way every test file is an entry point.
      const extraTestFiles = excludedFiles.filter((file) => isTest(file) && !originalPaths.has(file.path));
      const testPaths = [...files.filter(isTest), ...extraTestFiles].map((file) => file.path);
      const lines = new Map(files.map((file) => [file.path, file.lines]));
      const options = loadCompilerOptions(root);
      const graph = buildModuleGraph(extraTestFiles.length > 0 ? [...files, ...extraTestFiles] : files, { root, options });
      const { program, toolOwned, basis } = await resolveEntryPoints(root, files, settings, options);

      if (program.length === 0) {
        return {
          clusters: [],
          deadCode: [],
          analyzed: [],
          failures: [],
          notes: [
            'dead-code analysis skipped: no entry points could be resolved (checked package.json fields and scripts, ' +
              'conventional index/main/cli files, and framework conventions). Set "deadcode.entry" in ' +
              'dup-audit.config.json to enable it.',
          ],
        };
      }

      const toolNamed = filesNamedBy(graph, toolOwned);
      const entries = new Set([...program, ...toolOwned, ...toolNamed, ...testPaths]);
      const reachable = reachableFiles(graph, [...entries]);
      const used = usedExportsByFile(graph, reachable);
      const sources = mentionSources(graph, files.filter((file) => TEMPLATE_EXTENSIONS.has(file.ext)));
      // Test files are only in the graph to serve as extra entry points/edges; they were never part of
      // the audited set and are never themselves candidates for a dead-file or dead-export finding.
      const analyzed = files.map((file) => file.path).filter((filePath) => graph.nodes.has(filePath));
      const findings: DeadCodeFinding[] = [];

      for (const filePath of analyzed) {
        if (isIgnored(filePath)) continue;
        if (reachable.has(filePath)) continue;
        const risk = dynamicRiskReason(filePath, sources);
        findings.push({
          kind: risk === undefined ? 'dead-file' : 'uncertain-file',
          location: { path: filePath, startLine: 1, endLine: lines.get(filePath) ?? 1 },
          reason:
            risk === undefined
              ? `Not reachable from any of the ${entries.size} entry points (${basis}; listed in the run's notes); no ` +
                'resolved import, require, dynamic import, or re-export leads to it, directly or through any other file.'
              : `Not reachable from any configured entry point, but ${risk} - reported as uncertain rather than dead.`,
        });
      }

      for (const filePath of reachable) {
        if (!originalPaths.has(filePath)) continue;
        if (isIgnored(filePath)) continue;
        // An entry file's exports are consumed by whatever runs it (a framework, a package consumer, a
        // tool), not by another file, so the graph can never show them as used.
        if (entries.has(filePath)) continue;
        const node = graph.nodes.get(filePath);
        if (node === undefined) continue;
        const usedNames = used.get(filePath) ?? new Set<string>();
        for (const [name, line] of node.exports) {
          if (usedNames.has(name)) continue;
          // 'default' isn't a real identifier text to search for; every other export is skipped here if
          // it's referenced anywhere else in its own file (called by another function in the same module,
          // for example) - its declaration contributes exactly one occurrence of its own name.
          if (name !== 'default' && (node.identifierCounts.get(name) ?? 0) > 1) continue;
          const risk = mentionedElsewhereForName(name, sources, filePath);
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
          `dead-code entry points (${basis}${testPaths.length > 0 ? ' + test files' : ''}): ${program.join(', ')}`,
          ...(toolNamed.length > 0
            ? [`dead-code treats ${toolNamed.length} file(s) named by a tool config as live: ${toolNamed.join(', ')}`]
            : []),
          ...(toolOwned.length > 0
            ? [`dead-code treats ${toolOwned.length} tool-owned file(s) as live by naming convention (*.config.*, .*rc.*, dot-directories): ${toolOwned.join(', ')}`]
            : []),
        ],
      };
    },
  };
}