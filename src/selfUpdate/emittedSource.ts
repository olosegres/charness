/** What `tsc -w` turns into files under `dist/` — and so into a worker reload by nodemon (which watches nothing else). */
const emittedSourceRoot = 'src/';
/** The `src/` directories `tsconfig.json` excludes (`emittedSource.test.ts` keeps this list equal to its `exclude`). */
export const unemittedSourcePrefixes = ['src/__tests__/', 'src/release/'];
const emittedSourceExtension = '.ts';
const declarationFileExtension = '.d.ts';

/**
 * @description Whether a change to `filePath` (relative to the checkout, forward slashes) makes `tsc -w` write a file under
 * `dist/` — a TypeScript source it compiles (tests, the release tooling and declaration files excluded). Everything else —
 * docs, the CHANGELOG, scripts, the manifests, a tsconfig edit that changes no output — leaves `dist/` as it is, so nothing
 * would replace a hot worker by itself. Its own module: the hot supervisor (`cli/tscWatchGuard.ts`) reads it too, and loads
 * nothing of the update machinery for it.
 */
export function checkIsEmittedSource(filePath: string): boolean {
  return (
    filePath.startsWith(emittedSourceRoot) &&
    filePath.endsWith(emittedSourceExtension) &&
    !filePath.endsWith(declarationFileExtension) &&
    !unemittedSourcePrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}
