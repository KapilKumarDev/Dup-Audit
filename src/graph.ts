import path from 'node:path';
import ts from 'typescript';
import { parse } from './detectors/structure.js';
import { toPosix } from './tsconfig.js';
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
  /**
   * How many times each identifier text appears anywhere in the file. A named export's own declaration
   * contributes exactly one occurrence of its name, so a count greater than one means it's referenced
   * again somewhere else in the same file - called internally, not merely declared and exported.
   */
  identifierCounts: ReadonlyMap<string, number>;
}

export interface ModuleGraph {
  nodes: ReadonlyMap<string, FileGraphNode>;
}

const MAX_LITERAL_LENGTH = 200;

/** Where the audited tree lives and how the project resolves imports; see `loadCompilerOptions`. */
export interface ResolutionContext {
  root: string;
  options: ts.CompilerOptions;
}

/**
 * Resolves a module specifier written in `from` to one of the known inventory paths using TypeScript's
 * own resolver, so `paths` aliases, `baseUrl`, extensionless and `.js`-for-`.ts` specifiers, directory
 * `index` files, and package self-references behave as they do for the compiler. The file system is the
 * inventory itself, so nothing outside the audited set can resolve: a bare package specifier, a
 * non-code asset (`.json`, `.svg`), or a file the `ignore` list removed all come back `undefined`, which
 * is expected and not an error.
 */
function createResolver(known: ReadonlySet<string>, { root, options }: ResolutionContext): (from: string, specifier: string) => string | undefined {
  const rootDir = toPosix(root);
  const toRelative = (absolute: string): string => path.posix.relative(rootDir, absolute);
  const host: ts.ModuleResolutionHost = {
    fileExists: (absolute) => known.has(toRelative(absolute)),
    readFile: () => undefined,
    getCurrentDirectory: () => rootDir,
  };
  const cache = ts.createModuleResolutionCache(rootDir, (fileName) => fileName, options);
  return (from, specifier) => {
    const { resolvedModule } = ts.resolveModuleName(specifier, path.posix.join(rootDir, from), options, host, cache);
    if (resolvedModule === undefined || resolvedModule.isExternalLibraryImport === true) return undefined;
    const resolved = toRelative(resolvedModule.resolvedFileName);
    return known.has(resolved) ? resolved : undefined;
  };
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
  identifierCounts: Map<string, number>;
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
  const identifierCounts = new Map<string, number>();

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
        else if (node.name !== undefined) addExport(node.name.text, node);
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
      } else if (ts.isNamespaceExport(node.exportClause)) {
        // `export * as ns from './x'`: exposes all of './x' under one name of this file.
        if (fromModule !== undefined) rawEdges.push({ specifier: fromModule, kind: 're-export', names: ['*'] });
        addExport(node.exportClause.name.text, node);
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
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      // `import x = require('./x')`
      const { expression } = node.moduleReference;
      if (ts.isStringLiteral(expression)) {
        rawEdges.push({ specifier: expression.text, kind: 'require', names: ['*'] });
        edgeLiterals.add(expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import('./x').Thing` used as a type: no runtime edge, but the file is plainly referenced.
      const { argument } = node;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        rawEdges.push({ specifier: argument.literal.text, kind: 'import', names: ['*'] });
        edgeLiterals.add(argument.literal);
      }
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
    if (ts.isIdentifier(node)) identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { rawEdges, dynamicSpecifiers, exports, stringLiterals, identifierCounts };
}

/** Builds the whole-program import graph for every TS/JS file among `files`; other extensions are ignored. */
export function buildModuleGraph(files: readonly SourceFile[], resolution: ResolutionContext): ModuleGraph {
  const known = new Set(files.map((file) => file.path));
  const resolve = createResolver(known, resolution);
  const extractions = new Map<string, FileExtraction>();
  for (const file of files) {
    const sourceFile = parse(file);
    if (sourceFile !== undefined) extractions.set(file.path, extractFile(sourceFile));
  }

  const nodes = new Map<string, FileGraphNode>();
  for (const [filePath, extraction] of extractions) {
    const edges: ImportEdge[] = [];
    for (const raw of extraction.rawEdges) {
      const to = resolve(filePath, raw.specifier);
      if (to !== undefined && to !== filePath) edges.push({ to, kind: raw.kind, names: raw.names });
    }
    nodes.set(filePath, {
      edges,
      exports: extraction.exports,
      dynamicSpecifiers: extraction.dynamicSpecifiers,
      stringLiterals: extraction.stringLiterals,
      identifierCounts: extraction.identifierCounts,
    });
  }
  return { nodes };
}