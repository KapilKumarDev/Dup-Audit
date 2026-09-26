import ts from 'typescript';
import type { Config } from './config.js';
import {
  collectLocals,
  collectUnitSites,
  createStructureDetector,
  isNonReference,
  locate,
  nodeCount,
  parse,
  type UnitSite,
} from './detectors/structure.js';
import { collectInventory } from './inventory.js';
import { seededRandom, shuffled } from './random.js';
import type { CloneCluster, Location, SourceFile } from './types.js';

/** `copy` is a control: an unmodified duplicate that must always be found. */
export type MutationKind = 'copy' | 'rename' | 'literals' | 'insert-statement' | 'delete-statement';

const MUTATION_KINDS: readonly MutationKind[] = ['copy', 'rename', 'literals', 'insert-statement', 'delete-statement'];
const INSERTED_STATEMENT = '\nconsole.log("calibration");';
/** A deleted statement may cover at most this share of the function, so the edit stays a small one. */
const MAX_DELETED_SHARE = 0.1;
const PRECISION_SNIPPET_LINES = 40;

export interface CalibrationOptions {
  samples: number;
  precisionSamples: number;
  seed: number;
}

export interface RecallResult {
  kind: MutationKind;
  attempted: number;
  detected: number;
  recall: number;
}

export interface CalibrationResult {
  unitsSampled: number;
  recall: RecallResult[];
  overallRecall: number;
  clustersFound: number;
  precisionSampleMarkdown: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Candidate {
  file: SourceFile;
  sourceFile: ts.SourceFile;
  site: UnitSite;
  location: Location;
}

interface Mutant {
  kind: MutationKind;
  file: SourceFile;
  origin: Location;
}

function blockBody(node: ts.Node): ts.Block | undefined {
  const body = (node as { body?: ts.Node }).body;
  return body !== undefined && ts.isBlock(body) ? body : undefined;
}

function descendants(root: ts.Node, keep: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (keep(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Edits are relative to the start of the unit text; undefined means the mutation does not apply. */
function editsFor(kind: MutationKind, candidate: Candidate, random: () => number): Edit[] | undefined {
  const { site, sourceFile } = candidate;
  const base = site.node.getStart(sourceFile);
  const span = (node: ts.Node): { start: number; end: number } => ({
    start: node.getStart(sourceFile) - base,
    end: node.getEnd() - base,
  });
  const nonEmpty = (edits: Edit[]): Edit[] | undefined => (edits.length > 0 ? edits : undefined);

  switch (kind) {
    case 'copy':
      return [];
    case 'rename': {
      const locals = collectLocals(site);
      const identifiers = descendants(
        site.node,
        (node) => ts.isIdentifier(node) && !isNonReference(node) && locals.has(node.text),
      ) as ts.Identifier[];
      return nonEmpty(identifiers.map((id) => ({ ...span(id), text: `${id.text}_renamed` })));
    }
    case 'literals': {
      const literals = descendants(site.node, (node) => ts.isStringLiteral(node) || ts.isNumericLiteral(node));
      return nonEmpty(
        literals.map((literal) => {
          const { end } = span(literal);
          // Append inside the quotes for strings, after the digits for numbers.
          const at = ts.isStringLiteral(literal) ? end - 1 : end;
          return { start: at, end: at, text: ts.isStringLiteral(literal) ? 'x' : '0' };
        }),
      );
    }
    case 'insert-statement': {
      const [first] = blockBody(site.node)?.statements ?? [];
      return first === undefined ? undefined : [{ start: span(first).end, end: span(first).end, text: INSERTED_STATEMENT }];
    }
    case 'delete-statement': {
      const statements = blockBody(site.node)?.statements;
      if (statements === undefined) return undefined;
      const total = nodeCount(site.node, site.skip);
      const removable = statements
        .slice(0, -1)
        .filter((statement) => nodeCount(statement) <= total * MAX_DELETED_SHARE);
      if (removable.length === 0) return undefined;
      const chosen = removable[Math.floor(random() * removable.length)];
      return [{ ...span(chosen), text: '' }];
    }
  }
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
}

/** Wraps a unit's text so it parses on its own, as a standalone file. */
function standalone(candidate: Candidate, unitText: string): string {
  const { node } = candidate.site;
  if (ts.isFunctionDeclaration(node)) return `${unitText}\n`;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return `export const __unit = ${unitText};\n`;
  return `class __Calibration {\n${unitText}\n}\n`;
}

function collectCandidates(files: readonly SourceFile[], settings: Config['structure']): Candidate[] {
  const candidates: Candidate[] = [];
  for (const file of files) {
    const sourceFile = parse(file);
    if (sourceFile === undefined) continue;
    for (const site of collectUnitSites(sourceFile)) {
      const { startLine, endLine } = locate(site, sourceFile);
      const size = nodeCount(site.node, site.skip);
      if (endLine - startLine + 1 < settings.minLines || size < settings.minNodes || size > settings.maxTedNodes) continue;
      candidates.push({ file, sourceFile, site, location: { path: file.path, startLine, endLine, name: site.label } });
    }
  }
  return candidates;
}

function buildMutants(candidates: readonly Candidate[], random: () => number): Mutant[] {
  const mutants: Mutant[] = [];
  candidates.forEach((candidate, index) => {
    const { site, sourceFile, file, location } = candidate;
    const unitText = sourceFile.text.slice(site.node.getStart(sourceFile), site.node.getEnd());
    for (const kind of MUTATION_KINDS) {
      const edits = editsFor(kind, candidate, random);
      if (edits === undefined) continue;
      const path = `__calibration__/${index}-${kind}${file.ext}`;
      const text = standalone(candidate, applyEdits(unitText, edits));
      mutants.push({
        kind,
        origin: location,
        file: { path, ext: file.ext, text, lines: text.split('\n').length },
      });
    }
  });
  return mutants;
}

function isDetected(mutant: Mutant, clusters: readonly CloneCluster[]): boolean {
  return clusters.some(
    ({ locations }) =>
      locations.some((l) => l.path === mutant.file.path) &&
      locations.some((l) => l.path === mutant.origin.path && l.startLine === mutant.origin.startLine),
  );
}

function renderPrecisionSample(
  clusters: readonly CloneCluster[],
  files: ReadonlyMap<string, SourceFile>,
  count: number,
  random: () => number,
): string {
  const snippet = ({ path, startLine, endLine }: Location): string => {
    const lines = (files.get(path)?.text ?? '').split('\n').slice(startLine - 1, endLine);
    const shown = lines.slice(0, PRECISION_SNIPPET_LINES).join('\n');
    return `\`${path}:${startLine}-${endLine}\`\n\n\`\`\`\n${shown}${lines.length > PRECISION_SNIPPET_LINES ? '\n...' : ''}\n\`\`\``;
  };
  const sample = shuffled(clusters, random).slice(0, count);
  const sections = sample.map(
    (cluster, index) =>
      `## ${index + 1}. ${cluster.detector} / ${cluster.kind} / ${(cluster.similarity * 100).toFixed(1)}% (${cluster.locations.length} locations)\n\n` +
      `${cluster.locations.slice(0, 2).map(snippet).join('\n\n')}\n\n` +
      '- [ ] true duplicate\n- [ ] false positive\n',
  );
  return [
    '# Precision sample',
    '',
    `${sample.length} of ${clusters.length} clusters, chosen at random. Tick one box per cluster; precision = true duplicates / reviewed.`,
    '',
    ...sections,
  ].join('\n');
}

export async function runCalibration(
  root: string,
  config: Config,
  options: CalibrationOptions,
): Promise<CalibrationResult> {
  const random = seededRandom(options.seed);
  const { files } = await collectInventory(root, config);
  const detector = createStructureDetector(config.structure);

  const sampled = shuffled(collectCandidates(files, config.structure), random).slice(0, options.samples);
  const mutants = buildMutants(sampled, random);

  const baseline = await detector.run(files);
  const withMutants = await detector.run([...files, ...mutants.map((mutant) => mutant.file)]);

  const recall = MUTATION_KINDS.map((kind): RecallResult => {
    const ofKind = mutants.filter((mutant) => mutant.kind === kind);
    const detected = ofKind.filter((mutant) => isDetected(mutant, withMutants.clusters)).length;
    return { kind, attempted: ofKind.length, detected, recall: ofKind.length === 0 ? 0 : detected / ofKind.length };
  });
  const attempted = recall.reduce((sum, result) => sum + result.attempted, 0);
  const detected = recall.reduce((sum, result) => sum + result.detected, 0);

  return {
    unitsSampled: sampled.length,
    recall,
    overallRecall: attempted === 0 ? 0 : detected / attempted,
    clustersFound: baseline.clusters.length,
    precisionSampleMarkdown: renderPrecisionSample(
      baseline.clusters,
      new Map(files.map((file) => [file.path, file])),
      options.precisionSamples,
      random,
    ),
  };
}

export function formatCalibration(result: CalibrationResult, outputDir: string): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `Calibration: ${result.unitsSampled} functions sampled, ${result.clustersFound} clusters found in the untouched code`,
    '',
    'Recall on injected clones (found / injected):',
    ...result.recall.map(
      (item) => `  ${item.kind.padEnd(17)} ${String(item.detected).padStart(4)} / ${String(item.attempted).padEnd(4)} ${percent(item.recall)}`,
    ),
    `  ${'overall'.padEnd(17)} ${percent(result.overallRecall)}`,
    '',
    `Precision needs a human once: tick the boxes in ${outputDir}/precision-sample.md`,
  ].join('\n');
}