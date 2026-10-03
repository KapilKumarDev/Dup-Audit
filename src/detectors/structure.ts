import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Interner } from '../candidates.js';
import { clusterUnits } from '../clustering.js';
import type { Config } from '../config.js';
import { compareLocations } from '../locations.js';
import { editDistance, prepareTree, type PreparedTree, type TedNode } from '../ted.js';
import type { CloneCluster, Detector, DetectorResult, Location, SourceFile } from '../types.js';

const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

/** Number of consecutive pre-order labels per shingle used for candidate search. */
const SHINGLE_SIZE = 5;

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

/** A syntax node whose label is normalized (for matching) and raw (for telling identical from renamed). */
interface AstNode extends TedNode {
  raw: string;
  children: AstNode[];
}

/** A function-like declaration compared as one unit of duplication. */
export interface UnitSite {
  node: ts.Node;
  label: string;
  /** Own name that recursive calls refer to; treated as a local so renamed copies still match. */
  selfName?: string;
  /** Own name node, excluded from the tree because a clone is expected to be named differently. */
  skip?: ts.Node;
}

interface Unit {
  location: Location;
  tree: AstNode;
  size: number;
  normalizedKey: string;
  rawKey: string;
  features: number[];
  prepared?: PreparedTree;
}

const isJsDoc = (node: ts.Node): boolean =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

function enclosingClassName(node: ts.Node): string | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name !== undefined) {
      return current.name.text;
    }
  }
  return undefined;
}

/**
 * Units are the outermost function-like declarations: functions, methods, constructors, accessors
 * and arrow or function expressions bound to a name. Callbacks passed inline stay inside their parent.
 */
function findUnitSite(node: ts.Node): UnitSite | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body !== undefined
  ) {
    const own = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText();
    const owner = enclosingClassName(node);
    return {
      node,
      label: owner !== undefined && own !== undefined ? `${owner}.${own}` : (own ?? '<anonymous>'),
      selfName: ts.isFunctionDeclaration(node) ? node.name?.text : undefined,
      skip: ts.isConstructorDeclaration(node) ? undefined : node.name,
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (
      (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.initializer === node
    ) {
      return {
        node,
        label: parent.name.getText(),
        selfName: ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined,
        skip: ts.isFunctionExpression(node) ? node.name : undefined,
      };
    }
  }
  return undefined;
}

export function collectUnitSites(sourceFile: ts.SourceFile): UnitSite[] {
  const sites: UnitSite[] = [];
  const visit = (node: ts.Node): void => {
    const site = findUnitSite(node);
    if (site !== undefined) sites.push(site);
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Label index of a unit's own name; fixed so it never shifts the numbering of the other locals. */
const SELF_INDEX = -1;

/**
 * Names declared inside the unit, numbered in order of declaration, so renamed locals normalize alike.
 * Numbering must not depend on how the unit is declared (function, method, const arrow, property arrow).
 */
export function collectLocals(site: UnitSite): Map<string, number> {
  const locals = new Map<string, number>();
  let next = 0;
  const declare = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (!locals.has(name.text)) locals.set(name.text, next++);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) declare(element.name);
    }
  };

  if (site.selfName !== undefined) locals.set(site.selfName, SELF_INDEX);
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isTypeParameterDeclaration(node)) {
      declare(node.name);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node !== site.node && node.name) {
      declare(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(site.node);
  return locals;
}

/** True for identifiers that name a member or attribute rather than refer to a variable. */
export function isNonReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isQualifiedName(parent) && parent.right === id) ||
    (ts.isBindingElement(parent) && parent.propertyName === id) ||
    (ts.isJsxAttribute(parent) && parent.name === id) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === id)
  );
}

/** Extra syntax facts that live in node properties rather than child nodes. */
function detailOf(node: ts.Node): string | number | undefined {
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isTypeOperatorNode(node)) {
    return node.operator;
  }
  if (ts.isVariableDeclarationList(node)) return node.flags & ts.NodeFlags.BlockScoped;
  if (ts.isHeritageClause(node)) return node.token;
  if (ts.isMetaProperty(node)) return node.keywordToken;
  if (ts.isPrivateIdentifier(node)) return node.text;
  return undefined;
}

function labelsOf(node: ts.Node, locals: ReadonlyMap<string, number>): { label: string; raw: string } {
  if (ts.isIdentifier(node)) {
    const index = isNonReference(node) ? undefined : locals.get(node.text);
    const raw = `${node.kind}:${node.text}`;
    return { label: index === undefined ? raw : `${node.kind}#${index}`, raw };
  }
  if (LITERAL_KINDS.has(node.kind)) {
    return { label: `${node.kind}`, raw: `${node.kind}:${(node as ts.LiteralLikeNode).text}` };
  }
  const detail = detailOf(node);
  const label = detail === undefined ? `${node.kind}` : `${node.kind}:${detail}`;
  return { label, raw: label };
}

function buildTree(node: ts.Node, locals: ReadonlyMap<string, number>, skip: ts.Node | undefined): AstNode {
  const children: AstNode[] = [];
  ts.forEachChild(node, (child) => {
    if (child !== skip && !isJsDoc(child)) children.push(buildTree(child, locals, skip));
  });
  return { ...labelsOf(node, locals), children };
}

function flatten(tree: AstNode): AstNode[] {
  const nodes: AstNode[] = [];
  const visit = (node: AstNode): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(tree);
  return nodes;
}

function digest(tree: AstNode, pick: (node: AstNode) => string): string {
  const parts: string[] = [];
  const visit = (node: AstNode): void => {
    parts.push(pick(node), '(');
    node.children.forEach(visit);
    parts.push(')');
  };
  visit(tree);
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

function shingles(labelIds: readonly number[]): number[] {
  const result: number[] = [];
  for (let start = 0; start + SHINGLE_SIZE <= labelIds.length; start++) {
    let hash = 0;
    for (let offset = 0; offset < SHINGLE_SIZE; offset++) hash = (Math.imul(hash, 31) + labelIds[start + offset]) | 0;
    result.push(hash);
  }
  return result;
}

/** Parses a script file, or returns undefined when the file is not TypeScript or JavaScript. */
export function parse(file: SourceFile): ts.SourceFile | undefined {
  const scriptKind = SCRIPT_KINDS.get(file.ext);
  if (scriptKind === undefined) return undefined;
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind);
}

/** Line range of a unit, 1-based and inclusive. */
export function locate(site: UnitSite, sourceFile: ts.SourceFile): { startLine: number; endLine: number } {
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(site.node.getEnd()).line + 1,
  };
}

/** Number of syntax nodes the detector compares for `node`; pass the site's `skip` to match a unit's size exactly. */
export function nodeCount(node: ts.Node, skip?: ts.Node): number {
  return flatten(buildTree(node, new Map(), skip)).length;
}

function extractUnits(sourceFile: ts.SourceFile, settings: Config['structure'], interner: Interner): Unit[] {
  const units: Unit[] = [];

  for (const site of collectUnitSites(sourceFile)) {
    const { startLine, endLine } = locate(site, sourceFile);
    if (endLine - startLine + 1 < settings.minLines) continue;

    const tree = buildTree(site.node, collectLocals(site), site.skip);
    const nodes = flatten(tree);
    if (nodes.length < settings.minNodes) continue;

    units.push({
      location: { path: sourceFile.fileName, startLine, endLine, name: site.label },
      tree,
      size: nodes.length,
      normalizedKey: digest(tree, (node) => node.label),
      rawKey: digest(tree, (node) => node.raw),
      features: shingles(nodes.map((node) => interner.id(node.label))),
    });
  }
  return units;
}

export function createStructureDetector(settings: Config['structure']): Detector {
  return {
    id: 'structure',
    async run(files: readonly SourceFile[]): Promise<DetectorResult> {
      const interner = new Interner();
      const analyzed: string[] = [];
      const units: Unit[] = [];
      for (const file of files) {
        const sourceFile = parse(file);
        if (sourceFile === undefined) continue;
        analyzed.push(file.path);
        units.push(...extractUnits(sourceFile, settings, interner));
      }

      const prepare = (unit: Unit): PreparedTree =>
        (unit.prepared ??= prepareTree(unit.tree, (label) => interner.id(label)));

      const clusters = clusterUnits({
        units,
        normalizedKey: (unit) => unit.normalizedKey,
        rawKey: (unit) => unit.rawKey,
        features: (unit) => (unit.size <= settings.maxTedNodes ? unit.features : []),
        candidates: { minJaccard: settings.candidateJaccard, maxPosting: settings.maxPosting },
        upperBound: (a, b) => Math.min(a.size, b.size) / Math.max(a.size, b.size),
        similarity: (a, b) => {
          const larger = Math.max(a.size, b.size);
          // Beyond this many edits the pair is under the threshold, so the exact distance is not needed.
          const withinThreshold = Math.ceil((1 - settings.similarity) * larger);
          return 1 - editDistance(prepare(a), prepare(b), withinThreshold) / larger;
        },
        threshold: settings.similarity,
      });

      const oversized = units.filter((unit) => unit.size > settings.maxTedNodes).length;
      const notes =
        oversized === 0
          ? []
          : [`${oversized} function(s) above ${settings.maxTedNodes} nodes were matched exactly only; near-miss comparison skipped.`];

      return {
        clusters: clusters.map(
          (cluster): CloneCluster => ({
            detector: 'structure',
            kind: cluster.kind,
            similarity: cluster.similarity,
            locations: cluster.members.map((unit) => unit.location).sort(compareLocations),
          }),
        ),
        deadCode: [],
        analyzed,
        failures: [],
        notes,
      };
    },
  };
}