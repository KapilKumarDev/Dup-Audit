import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectorId } from './types.js';

export const CONFIG_FILE = 'dup-audit.config.json';

const DETECTOR_IDS: readonly DetectorId[] = ['tokens', 'structure', 'css', 'deadcode'];

export interface Config {
  detectors: DetectorId[];
  /** Git pathspec globs (relative to the root) excluded from the audit and reported as excluded. */
  ignore: string[];
  /** Extensions that count as code; the coverage gate is measured against these files. */
  codeExtensions: string[];
  gates: {
    minCoveragePercent: number;
    maxDuplicationPercent: number;
    /** Off by default (same adoption problem as `baseline`): a wrong entry point can flag live code as dead. */
    deadCode: { enabled: boolean; maxFiles: number };
  };
  tokens: {
    /** Extensions handed to the token-level detector (jscpd). */
    extensions: string[];
    minTokens: number;
    minLines: number;
  };
  structure: {
    minNodes: number;
    minLines: number;
    /** 1 - treeEditDistance / max(nodes); confirms near-miss pairs. */
    similarity: number;
    /** Larger units are matched exactly only, keeping tree edit distance affordable. */
    maxTedNodes: number;
    /** Cheap pre-filter on shared subtree shingles before the tree edit distance runs. */
    candidateJaccard: number;
    /** Shingles present in more units than this are treated as boilerplate. */
    maxPosting: number;
  };
  css: {
    minDeclarations: number;
    similarity: number;
  };
  deadcode: {
    /**
     * Glob patterns (relative to root, POSIX-style) for the program's real entry points - the files that
     * are run directly rather than only imported. Empty means "auto-detect": package.json entry fields and
     * scripts, a conventional index/main/cli file in the root or src, and the conventions of frameworks
     * listed in package.json, all combined. Setting it replaces that auto-detection; files a tool loads by
     * name (`*.config.*`, `.*rc.*`, dot-directories) stay live either way. The resolved list is always
     * reported, since a missing entry point is how this detector flags live code as dead.
     */
    entry: string[];
    /** Extra glob patterns for files this detector should never flag, e.g. framework files loaded by filename convention rather than by import. */
    ignore: string[];
    /**
     * Treat every test file (`.test.`, `.spec.`, or under `__tests__/`) as an entry point in its own
     * right, the way a test runner invokes it directly - on by default, matching `knip`'s own default.
     * This detector gathers test files itself, independently of the shared `ignore` list that (correctly)
     * removes them for every other detector, specifically so a function exported only to be unit-tested
     * directly isn't flagged as a dead export just because nothing in the shipped code calls it.
     */
    treatTestsAsEntry: boolean;
  };
  baseline: {
    /**
     * When true, `<out>/baseline.json` (written by `dup-audit baseline`) is loaded and the
     * duplication gate is evaluated against clusters not already in it, so existing debt on a
     * large codebase doesn't block adopting the gate — only newly introduced duplication does.
     * Coverage is still measured against everything; a baseline never hides missing coverage.
     */
    enabled: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  detectors: ['tokens', 'structure', 'css', 'deadcode'],
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/*.min.*',
    '**/*.d.ts',
    '**/*.generated.*',
    '**/*.test.*',
    '**/*.spec.*',
    '**/__tests__/**',
    '**/__mocks__/**',
  ],
  codeExtensions: [
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.css', '.scss', '.less',
    '.sql', '.html', '.htm',
    '.vue', '.svelte',
  ],
  gates: { minCoveragePercent: 90, maxDuplicationPercent: 5, deadCode: { enabled: false, maxFiles: 0 } },
  tokens: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.less', '.sql', '.html', '.htm'],
    minTokens: 60,
    minLines: 5,
  },
  structure: {
    minNodes: 40,
    minLines: 5,
    similarity: 0.85,
    maxTedNodes: 5000,
    candidateJaccard: 0.4,
    maxPosting: 64,
  },
  css: { minDeclarations: 3, similarity: 0.85 },
  deadcode: { entry: [], ignore: [], treatTestsAsEntry: true },
  baseline: { enabled: false },
};

export class ConfigError extends Error {}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function merge(defaults: unknown, user: unknown, keyPath: string): unknown {
  const label = keyPath === '' ? 'the config file' : `"${keyPath}"`;
  if (Array.isArray(defaults)) {
    if (!Array.isArray(user) || !user.every((item) => typeof item === 'string')) {
      throw new ConfigError(`${label} must be an array of strings`);
    }
    return user;
  }
  if (isObject(defaults)) {
    if (!isObject(user)) throw new ConfigError(`${label} must be an object`);
    const merged: JsonObject = { ...defaults };
    for (const [key, value] of Object.entries(user)) {
      const childPath = keyPath === '' ? key : `${keyPath}.${key}`;
      if (!Object.hasOwn(defaults, key)) throw new ConfigError(`Unknown config key "${childPath}"`);
      merged[key] = merge(defaults[key], value, childPath);
    }
    return merged;
  }
  if (typeof user !== typeof defaults) throw new ConfigError(`${label} must be a ${typeof defaults}`);
  return user;
}

function validate(config: Config): void {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const positiveInt = (value: number): boolean => Number.isInteger(value) && value > 0;
  const fraction = (value: number): boolean => value > 0 && value <= 1;
  const percent = (value: number): boolean => value >= 0 && value <= 100;
  const extensions = (list: readonly string[]): boolean => list.every((ext) => /^\.[^./\\]+$/.test(ext));

  expect(config.detectors.length > 0, 'detectors must not be empty');
  expect(config.detectors.every((id) => DETECTOR_IDS.includes(id)), `detectors must be a subset of ${DETECTOR_IDS.join(', ')}`);
  expect(extensions(config.codeExtensions), 'codeExtensions entries must look like ".ts"');
  expect(extensions(config.tokens.extensions), 'tokens.extensions entries must look like ".ts"');
  expect(percent(config.gates.minCoveragePercent), 'gates.minCoveragePercent must be within 0..100');
  expect(percent(config.gates.maxDuplicationPercent), 'gates.maxDuplicationPercent must be within 0..100');
  expect(
    Number.isInteger(config.gates.deadCode.maxFiles) && config.gates.deadCode.maxFiles >= 0,
    'gates.deadCode.maxFiles must be a non-negative integer',
  );
  expect(positiveInt(config.tokens.minTokens), 'tokens.minTokens must be a positive integer');
  expect(positiveInt(config.tokens.minLines), 'tokens.minLines must be a positive integer');
  expect(positiveInt(config.structure.minNodes), 'structure.minNodes must be a positive integer');
  expect(positiveInt(config.structure.minLines), 'structure.minLines must be a positive integer');
  expect(positiveInt(config.structure.maxTedNodes), 'structure.maxTedNodes must be a positive integer');
  expect(positiveInt(config.structure.maxPosting), 'structure.maxPosting must be a positive integer');
  expect(fraction(config.structure.similarity), 'structure.similarity must be within (0, 1]');
  expect(fraction(config.structure.candidateJaccard), 'structure.candidateJaccard must be within (0, 1]');
  expect(positiveInt(config.css.minDeclarations), 'css.minDeclarations must be a positive integer');
  expect(fraction(config.css.similarity), 'css.similarity must be within (0, 1]');

  if (problems.length > 0) throw new ConfigError(problems.join('\n'));
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function loadConfig(root: string, explicitPath?: string): Promise<Config> {
  const defaults = structuredClone(DEFAULT_CONFIG);
  const file = explicitPath === undefined ? path.join(root, CONFIG_FILE) : path.resolve(explicitPath);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (explicitPath === undefined && isMissingFile(error)) return defaults;
    throw new ConfigError(`Cannot read config ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const config = merge(defaults, parsed, '') as Config;
  config.detectors = [...new Set(config.detectors)];
  validate(config);
  return config;
}