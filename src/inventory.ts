import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import type { SourceFile } from './types.js';

const execFileAsync = promisify(execFile);
const LIST_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
const MAX_LIST_BYTES = 512 * 1024 * 1024;
const SKIPPABLE_READ_ERRORS = new Set(['ENOENT', 'EISDIR']);

export interface Inventory {
  /** Code files that take part in the audit. */
  files: SourceFile[];
  /** Code files removed by the `ignore` globs, reported so exclusions stay visible. */
  excluded: { files: number; lines: number };
  /** The excluded files themselves (e.g. test files) - already read in full to produce the count above, so exposing them here is free. Detectors that need something the shared `ignore` list otherwise hides (deadcode's entry points) can use this instead of re-scanning. */
  excludedFiles: SourceFile[];
}

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Lists tracked and untracked-but-not-ignored paths, honouring .gitignore natively. */
async function listPaths(root: string, ignore: readonly string[]): Promise<string[]> {
  const pathspec = ['--', '.', ...ignore.map((glob) => `:(exclude,glob)${glob}`)];
  try {
    const { stdout } = await execFileAsync('git', [...LIST_ARGS, ...pathspec], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: MAX_LIST_BYTES,
    });
    return stdout.split('\0').filter((entry) => entry !== '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot list files in ${root}; it must be inside a git repository (${reason})`);
  }
}

async function readSource(root: string, relativePath: string): Promise<SourceFile | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, relativePath), 'utf8');
  } catch (error) {
    // A file that is still in the git index but gone (or replaced by a directory) on disk is not part of the tree.
    if (error instanceof Error && 'code' in error && SKIPPABLE_READ_ERRORS.has(String(error.code))) return null;
    throw error;
  }
  return { path: relativePath, ext: path.extname(relativePath).toLowerCase(), text, lines: countLines(text) };
}

// Sequential on purpose: thousands of concurrent reads would exhaust file descriptors.
async function readAll(root: string, relativePaths: readonly string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const relativePath of relativePaths) {
    const file = await readSource(root, relativePath);
    if (file !== null) files.push(file);
  }
  return files;
}

export async function collectInventory(root: string, config: Config): Promise<Inventory> {
  const codeExtensions = new Set(config.codeExtensions);
  const isCode = (relativePath: string): boolean => codeExtensions.has(path.extname(relativePath).toLowerCase());

  const [everything, included] = await Promise.all([listPaths(root, []), listPaths(root, config.ignore)]);
  const includedSet = new Set(included);

  const files = await readAll(root, included.filter(isCode));
  const excludedFiles = await readAll(root, everything.filter((entry) => isCode(entry) && !includedSet.has(entry)));

  return {
    files,
    excluded: { files: excludedFiles.length, lines: excludedFiles.reduce((sum, file) => sum + file.lines, 0) },
    excludedFiles,
  };
}