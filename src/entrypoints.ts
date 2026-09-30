import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type ts from 'typescript';
import type { Config } from './config.js';
import { createMatcher } from './glob.js';
import { CONVENTIONAL_OUTPUT_DIRS, toPosix } from './tsconfig.js';
import type { SourceFile } from './types.js';

const PACKAGE_FILE = 'package.json';
const CONVENTIONAL_ENTRY_NAMES = new Set(['index', 'main', 'cli']);
/** Directories (relative to the root) where an `index`/`main`/`cli` file is taken to be an entry point. */
const CONVENTIONAL_ENTRY_DIRS = new Set(['.', 'src']);
/** package.json fields that name the files a package is run or imported through. */
const PACKAGE_ENTRY_FIELDS = ['main', 'module', 'browser', 'bin', 'exports'] as const;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
/** Characters that separate one word of a shell command from the next, including `--flag=value`. */
const SCRIPT_WORD_SEPARATORS = /[\s&|;<>()"'`=]+/;
/** Source extensions a compiled extension may have come from. */
const SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.jsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Files a tool loads itself, by name, so nothing ever imports them: `vite.config.ts`, `.eslintrc.js`,
 * and anything under a dot-directory (`.storybook/`, `.husky/`). Always live, and never a program entry
 * point in their own right.
 */
const TOOL_OWNED_GLOBS = [
  '**/*.config.{js,cjs,mjs,jsx,ts,cts,mts,tsx}',
  '**/.*rc.{js,cjs,mjs,ts,cts,mts}',
  '**/.*/**',
];

/** Files a framework runs by directory or file-name convention, enabled by a matching dependency in package.json. */
const FRAMEWORK_ENTRIES: ReadonlyArray<{ name: string; dependency: RegExp; globs: readonly string[] }> = [
  {
    name: 'next',
    dependency: /^next$/,
    globs: [
      '{src/,}pages/**',
      '{src/,}app/**/{page,layout,route,loading,error,global-error,not-found,template,default}.*',
      '{src/,}{middleware,proxy,instrumentation,instrumentation-client}.*',
    ],
  },
  { name: 'astro', dependency: /^astro$/, globs: ['src/pages/**', 'src/middleware.*', 'src/actions/index.*'] },
  { name: 'sveltekit', dependency: /^@sveltejs\/kit$/, globs: ['src/routes/**', 'src/hooks.*', 'src/params/**'] },
  {
    name: 'remix/react-router',
    dependency: /^(@remix-run\/|react-router)/,
    globs: ['app/routes/**', 'app/routes.*', 'app/root.*', 'app/entry.*'],
  },
  { name: 'gatsby', dependency: /^gatsby$/, globs: ['src/pages/**', 'gatsby-{node,browser,ssr}.*'] },
  { name: 'storybook', dependency: /^(storybook$|@storybook\/)/, globs: ['**/*.stories.*'] },
  { name: 'cypress', dependency: /^cypress$/, globs: ['cypress/**'] },
  { name: 'knex', dependency: /^knex$/, globs: ['**/migrations/**', '**/seeds/**'] },
];

export interface EntryResolution {
  /**
   * Files that run: explicit `deadcode.entry`, or else package.json fields and scripts, conventional
   * root files, and framework conventions. Empty means there is nothing to search from.
   */
  program: string[];
  /** Files a tool loads by naming convention. Live, but never reason enough to run the analysis on their own. */
  toolOwned: string[];
  /** Which sources produced `program`, for the run's notes. */
  basis: string;
}

interface Manifest {
  /** Every path-like string in main/module/browser/bin/exports, whatever shape those fields take. */
  entryPaths: string[];
  /** Full text of each script, e.g. `node scripts/seed.js`. */
  scripts: string[];
  dependencies: string[];
}

const EMPTY_MANIFEST: Manifest = { entryPaths: [], scripts: [], dependencies: [] };

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
}

async function readManifest(root: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, PACKAGE_FILE), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return EMPTY_MANIFEST;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_MANIFEST;
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY_MANIFEST;
  const record = parsed as Record<string, unknown>;
  const manifest: Manifest = { entryPaths: [], scripts: [], dependencies: [] };
  for (const field of PACKAGE_ENTRY_FIELDS) collectStrings(record[field], manifest.entryPaths);
  collectStrings(record.scripts, manifest.scripts);
  for (const field of DEPENDENCY_FIELDS) {
    const group = record[field];
    if (group !== null && typeof group === 'object') manifest.dependencies.push(...Object.keys(group));
  }
  return manifest;
}

interface SourceLayout {
  /** Directories compiled output is written to, e.g. `dist`. */
  outDirs: readonly string[];
  /** Directories the matching source may live in; `''` is the project root. */
  sourceRoots: readonly string[];
}

/** Where compiled output goes and where its source lives: tsconfig's `outDir`/`rootDir` when set, else convention. */
function sourceLayout(root: string, options: ts.CompilerOptions): SourceLayout {
  const relativeToRoot = (dir: string | undefined): string | undefined =>
    dir === undefined ? undefined : toPosix(path.relative(root, dir));
  const defined = (values: ReadonlyArray<string | undefined>): string[] => [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ];
  return {
    outDirs: defined([relativeToRoot(options.outDir), ...CONVENTIONAL_OUTPUT_DIRS]).filter((dir) => dir !== ''),
    sourceRoots: defined([relativeToRoot(options.rootDir), '', 'src']),
  };
}

/** A declared path as written, plus every source file it plausibly came from (`dist/src/cli.js` -> `src/cli.ts`). */
function toSourceCandidates(declared: string, layout: SourceLayout): string[] {
  const normalized = path.posix.normalize(declared);
  const outDir = layout.outDirs.find((dir) => normalized.startsWith(`${dir}/`));
  const uncompiled = outDir === undefined ? [] : layout.sourceRoots.map((sourceRoot) => path.posix.join(sourceRoot, normalized.slice(outDir.length + 1)));
  return [normalized, ...uncompiled].flatMap((candidate) => {
    const ext = path.posix.extname(candidate);
    const stem = candidate.slice(0, candidate.length - ext.length);
    return [candidate, ...(SOURCE_EXTENSIONS[ext] ?? []).map((sourceExt) => `${stem}${sourceExt}`)];
  });
}

/**
 * Resolves the real entry points of the program: files that run directly, not only ones that get
 * imported. An entry point missing from this list is how live code ends up flagged as dead, so every
 * source is additive (a wrong guess only hides findings) and the result is reported on every run.
 * An explicit `deadcode.entry` replaces the automatic sources, since it says exactly what runs; files
 * that tools load by name stay live either way.
 */
export async function resolveEntryPoints(
  root: string,
  files: readonly SourceFile[],
  settings: Config['deadcode'],
  options: ts.CompilerOptions,
): Promise<EntryResolution> {
  const paths = files.map((file) => file.path);
  const known = new Set(paths);
  const matching = (globs: readonly string[]): string[] => paths.filter(createMatcher(globs));
  const existing = (candidates: readonly string[]): string[] => candidates.filter((candidate) => known.has(candidate));

  const sources: Array<{ label: string; entries: string[] }> = [];
  if (settings.entry.length > 0) {
    sources.push({ label: `deadcode.entry (${settings.entry.join(', ')})`, entries: matching(settings.entry) });
  } else {
    const manifest = await readManifest(root);
    const layout = sourceLayout(root, options);
    const declared = (words: readonly string[]): string[] => existing(words.flatMap((word) => toSourceCandidates(word, layout)));
    const scriptWords = manifest.scripts.flatMap((script) => script.split(SCRIPT_WORD_SEPARATORS));
    sources.push(
      { label: 'package.json main/bin/exports', entries: declared(manifest.entryPaths) },
      { label: 'package.json scripts', entries: declared(scriptWords) },
      {
        label: 'conventional index/main/cli in the root or src',
        entries: paths.filter((filePath) => {
          const base = path.posix.basename(filePath, path.posix.extname(filePath));
          return CONVENTIONAL_ENTRY_NAMES.has(base) && CONVENTIONAL_ENTRY_DIRS.has(path.posix.dirname(filePath));
        }),
      },
    );
    for (const framework of FRAMEWORK_ENTRIES) {
      if (manifest.dependencies.some((name) => framework.dependency.test(name))) {
        sources.push({ label: `${framework.name} conventions`, entries: matching(framework.globs) });
      }
    }
  }

  const contributing = sources.filter((source) => source.entries.length > 0);
  return {
    program: [...new Set(contributing.flatMap((source) => source.entries))].sort(),
    toolOwned: matching(TOOL_OWNED_GLOBS),
    basis: contributing.map((source) => source.label).join(' + '),
  };
}