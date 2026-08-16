/**
 * Extensionless TypeScript resolution for `node --test`.
 *
 * Vite resolves `./wbpr-deck` to `wbpr-deck.ts` and Node does not, which is the
 * only thing standing between this codebase and the built-in test runner. Node
 * 22 can strip types by itself, so this is the whole gap.
 *
 * A loader hook rather than a dependency, on the same rule the rest of the repo
 * follows: tsx or vitest would each pull in a tree to solve fifteen lines of
 * path resolution. If the test suite ever needs mocking, coverage or a browser,
 * that calculation changes and this file is the thing to delete.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/i;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !HAS_EXTENSION.test(specifier) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      const full = resolvePath(base, candidate);
      if (existsSync(full)) return next(pathToFileURL(full).href, context);
    }
  }
  return next(specifier, context);
}
