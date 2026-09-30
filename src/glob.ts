import picomatch from 'picomatch';

// Compiles POSIX-style globs once into a predicate over relative paths. Dotfiles match, and a leading
// `**/` may match zero directories (so `**/*.config.ts` matches a root-level `vite.config.ts`), the way
// a git pathspec does.
export function createMatcher(globs: readonly string[]): (relativePath: string) => boolean {
  return picomatch([...globs], { dot: true });
}