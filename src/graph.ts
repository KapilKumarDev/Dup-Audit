import path from 'node:path';
import ts from 'typescript';
import { parse } from './detectors/structure.js';
import type { SourceFile } from './types.js';

/** How one file causes another to load. `re-export` covers both `export * from` and `export { x } from`. */
export type EdgeKind = 'import' | 'require' | 'dynamic-import' | 're-export';

export interface ImportEdge {
  to: string;
  kind: EdgeKind;
  /** Bindings pulled from `to`: an export name, `'default'`, or `'*'` meaning "treat every export of `to` as used". */
  names: readonly string[];
}

export interface FileGraphNode {
  edges: ImportEdge[];
  /** Every exported name declared in this file (`'default'` included), mapped to its declaration line. */
  exports: ReadonlyMap<string, number>;
  /**
   * Argument text of every `require(...)` / `import(...)` call whose argument was not a literal string,
   * so the target could not be resolved statically (e.g. `require(pluginPath)`, `import(`./${name}`)`).
   */
  dynamicSpecifiers: readonly string[];
  /** String literals in the file, capped in length, used only to flag "might be referenced dynamically". */
  stringLiterals: readonly string[];
}

export interface ModuleGraph {
  nodes: ReadonlyMap<string, FileGraphNode>;
}

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
/** NodeNext/ESM convention: source keeps `.ts` but imports spell the compiled `.js` extension. */
const COMPILED_TO_SOURCE: Readonly<Record<string, string>> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };
const MAX_LITERAL_LENGTH = 200;

function normalizeRelative(from: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
}

/**
 * Resolves a relative module specifier to one of the known inventory paths, using the same suffix
 * rules Node's ESM loader and the TypeScript compiler apply: as written, with a resolvable extension
 * appended, with a compiled `.js`-style extension swapped for its `.ts`-style source, or as a directory
 * `index` file. Returns undefined for a bare/package specifier (out of scope: external, not audited) or
 * for anything that doesn't match a known file - most commonly a non-code asset (`.json`, `.svg`, css
 * treated as an asset), which is not an error and is not treated as ambiguous.
 */
export function resolveSpecifier(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalizeRelative(from, specifier);
  const ext = path.posix.extname(base);
  const swapped = ext in COMPILED_TO_SOURCE ? `${base.slice(0, -ext.length)}${COMPILED_TO_SOURCE[ext]}` : undefined;
  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...(swapped !== undefined ? [swapped] : []),
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

interface RawEdge {
  specifier: string;
  kind: EdgeKind;
  names: readonly string[];
}

interface FileExtraction {
  rawEdges: RawEdge[];
  dynamicSpecifiers: string[];
  exports: Map<string, number>;
  stringLiterals: string[];
}

function declaredNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) names.push(...declaredNames(element.name));
  }
  return names;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

function importNames(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return [];
  const names: string[] = [];
  if (clause.name !== undefined) names.push('default');
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) names.push('*');
    else for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

function extractFile(sourceFile: ts.SourceFile): FileExtraction {
  const rawEdges: RawEdge[] = [];
  const dynamicSpecifiers: string[] = [];
  const exports = new Map<string, number>();
  const stringLiterals: string[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const addExport = (name: string, node: ts.Node): void => {
    if (!exports.has(name)) exports.set(name, lineOf(node));
  };
  // A specifier that already resolves to a real edge (e.g. an import's own './helper.js') is a known,
  // statically-confirmed reference - it must not also count as a "might dynamically reference this file"
  // hit against its own target, or every ordinary import would make its target look ambiguous.
  const edgeLiterals = new Set<ts.Node>();

  const visitDeclaration = (node: ts.Node): void => {
    if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) addExport('default', node);
        if (node.name !== undefined) addExport(node.name.text, node);
      } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
        addExport(node.name.text, node);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          for (const name of declaredNames(declaration.name)) addExport(name, node);
        }
      }
    } else if (ts.isExportAssignment(node)) {
      addExport('default', node);
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      const fromModule = specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined;
      if (node.exportClause === undefined) {
        // `export * from './x'`: forwards every export of './x'; only meaningful if this file is itself reachable.
        // Not a named export of this file, so it isn't added to `exports` - only the forwarding edge matters.
        if (fromModule !== undefined) rawEdges.push({ specifier: fromModule, kind: 're-export', names: ['*'] });
      } else if (ts.isNamedExports(node.exportClause)) {
        const publicNames = node.exportClause.elements.map((element) => element.name.text);
        if (fromModule !== undefined) {
          const sourceNames = node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text);
          rawEdges.push({ specifier: fromModule, kind: 're-export', names: sourceNames });
        }
        for (const name of publicNames) addExport(name, node);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    visitDeclaration(node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      rawEdges.push({ specifier: node.moduleSpecifier.text, kind: 'import', names: importNames(node.importClause) });
      edgeLiterals.add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      edgeLiterals.add(node.moduleSpecifier); // the edge itself is recorded by visitDeclaration's export handling
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const [argument] = node.arguments;
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          rawEdges.push({ specifier: argument.text, kind: isRequire ? 'require' : 'dynamic-import', names: ['*'] });
          edgeLiterals.add(argument);
        } else if (argument !== undefined) {
          dynamicSpecifiers.push(argument.getText(sourceFile).slice(0, MAX_LITERAL_LENGTH));
        }
      }
    } else if (
      ts.isStringLiteralLike(node) &&
      !edgeLiterals.has(node) &&
      node.text.length > 0 &&
      node.text.length <= MAX_LITERAL_LENGTH
    ) {
      stringLiterals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { rawEdges, dynamicSpecifiers, exports, stringLiterals };
}

/** Builds the whole-program import graph for every TS/JS file among `files`; other extensions are ignored. */
export function buildModuleGraph(files: readonly SourceFile[]): ModuleGraph {
  const known = new Set(files.map((file) => file.path));
  const extractions = new Map<string, FileExtraction>();
  for (const file of files) {
    const sourceFile = parse(file);
    if (sourceFile !== undefined) extractions.set(file.path, extractFile(sourceFile));
  }

  const nodes = new Map<string, FileGraphNode>();
  for (const [filePath, extraction] of extractions) {
    const edges: ImportEdge[] = [];
    for (const raw of extraction.rawEdges) {
      const to = resolveSpecifier(filePath, raw.specifier, known);
      if (to !== undefined && to !== filePath) edges.push({ to, kind: raw.kind, names: raw.names });
    }
    nodes.set(filePath, {
      edges,
      exports: extraction.exports,
      dynamicSpecifiers: extraction.dynamicSpecifiers,
      stringLiterals: extraction.stringLiterals,
    });
  }
  return { nodes };
}