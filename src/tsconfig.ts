import path from 'node:path';
import ts from 'typescript';

const TSCONFIG_FILE = 'tsconfig.json';

/** Directory names a build conventionally writes to, used when no tsconfig says where compiled output goes. */
export const CONVENTIONAL_OUTPUT_DIRS: readonly string[] = ['dist', 'build', 'lib', 'out'];

export const toPosix = (value: string): string => value.split(path.sep).join('/');

/**
 * Compiler options used to resolve imports the way the project's own build does: `paths`, `baseUrl`,
 * and everything inherited through `extends`. Resolution itself is forced to `Bundler`, the most
 * permissive mode (extensionless specifiers, `.js` written for a `.ts` file, directory `index` files,
 * package `exports`), so a project that declares `NodeNext` isn't penalised for an import its bundler
 * accepts. Without a readable `<root>/tsconfig.json`, only that default resolution applies.
 */
export function loadCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = path.join(root, TSCONFIG_FILE);
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  // readDirectory is stubbed out: only the options are wanted, not the list of files the config includes.
  const parsed = ts.parseJsonConfigFileContent(config ?? {}, { ...ts.sys, readDirectory: () => [] }, root, undefined, configPath);
  return {
    ...parsed.options,
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}