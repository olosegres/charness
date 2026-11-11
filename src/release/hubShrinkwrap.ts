import * as fs from 'node:fs';
import { z } from 'zod';
import {
  createLockPackageEntries,
  getIntegrityKey,
  getLockEntryPackageName,
  parseRunnerLock,
  parseYarnLock,
  renderRunnerLock,
  sortRecord,
  walkYarnTree,
  type NpmLockfile,
  type RootPackageJson,
} from '../runners/runnerLock';

/**
 * @description The `npm-shrinkwrap.json` the hub's npm package ships, made from `yarn.lock` for the package's whole run-time tree, so that
 * `npm install -g charness` and the npm self-update install what the repository has tested — not whatever the open ranges of
 * `package.json` resolve to on the day (a version published since, hijacked say, with an install script). npm reads a package's
 * shrinkwrap when it installs the package from a registry (the registry marks it, `_hasShrinkwrap`); npm 12 and later no longer read
 * it at all and install from the ranges again.
 *
 * Built by the same walk as the runner's lock (`runners/runnerLock.ts`), with what the hub's tree needs on top: a package needed in a
 * second version is nested under the one that needs it, as npm lays a tree out, and peer dependencies are accepted (an optional peer
 * is left out, a required one must be in the tree). OPTIONAL dependencies are left out, as for the runner (`ssh2`'s native
 * `cpu-features` — `ssh2` runs without it). From the registry each package's integrity and whether it has install scripts:
 * `hasInstallScript` is what makes npm run them from a lock — without it `node-pty` would be built from source instead of taking its
 * prebuilt binary. `yarn shrinkwrap` writes the file and keeps what it already knows; a unit test fails when the committed file no
 * longer matches `yarn.lock` and `package.json`. Its version is the package's: a release writes it (`cli.ts apply`), as `npm version`
 * does by itself.
 */

/** The file at the repository root; `package.json` lists it in `files` — npm packs it only then. */
export const shrinkwrapFileName = 'npm-shrinkwrap.json';
const lockfileVersion = 3;
const rootEntryKey = '';

/** What the registry tells about one version, as the shrinkwrap keeps it. */
export interface PackageVersionFacts {
  integrity: string;
  hasInstallScript: boolean;
}

export interface BuildHubShrinkwrapInputs {
  yarnLockText: string;
  rootPackageJson: RootPackageJson;
  /** What is known of each package version, by `getIntegrityKey`; a package without facts is written without integrity. */
  facts?: Readonly<Record<string, PackageVersionFacts>>;
}

/** @description The hub's shrinkwrap for `inputs` (see the head of the file); throws, saying what is wrong, when the tree cannot be written. */
export function buildHubShrinkwrap(inputs: BuildHubShrinkwrapInputs): NpmLockfile {
  const { rootPackageJson } = inputs;
  const placed = walkYarnTree(parseYarnLock(inputs.yarnLockText), rootPackageJson.dependencies, { isNestingAllowed: true, isPeerAllowed: true });
  const facts = Object.entries(inputs.facts ?? {});
  const packages = {
    [rootEntryKey]: {
      name: rootPackageJson.name,
      version: rootPackageJson.version,
      dependencies: sortRecord(rootPackageJson.dependencies),
      ...(rootPackageJson.engines === undefined ? {} : { engines: rootPackageJson.engines }),
    },
    ...createLockPackageEntries(
      placed,
      Object.fromEntries(facts.map(([key, fact]) => [key, fact.integrity])),
      Object.fromEntries(facts.map(([key, fact]) => [key, fact.hasInstallScript])),
    ),
  };
  return { name: rootPackageJson.name, version: rootPackageJson.version, lockfileVersion, requires: true, packages };
}

/** @description What a shrinkwrap already holds of each package version (its integrity, whether it has install scripts): what a regeneration keeps. */
export function readShrinkwrapFacts(lock: NpmLockfile): Record<string, PackageVersionFacts> {
  const facts: Record<string, PackageVersionFacts> = {};
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === rootEntryKey || entry.version === undefined || entry.integrity === undefined) continue;
    facts[getIntegrityKey(getLockEntryPackageName(location), entry.version)] = { integrity: entry.integrity, hasInstallScript: entry.hasInstallScript === true };
  }
  return facts;
}

/** @description The package versions of a shrinkwrap that the facts do not cover yet: what the registry must be asked about. */
export function listUnknownPackageVersions(lock: NpmLockfile): Array<{ name: string; version: string }> {
  return Object.entries(lock.packages)
    .filter(([location, entry]) => location !== rootEntryKey && entry.version !== undefined && entry.integrity === undefined)
    .map(([location, entry]) => ({ name: getLockEntryPackageName(location), version: entry.version ?? '' }));
}

/** @description The shrinkwrap as it is written to disk: two-space JSON and a final newline, deterministic (the runner's lock's format). */
export function renderHubShrinkwrap(lock: NpmLockfile): string {
  return renderRunnerLock(lock);
}

/** @description The shrinkwrap's text with `version` as the package's version (the file's and its root entry's), the rest unchanged — what `npm version` writes. */
export function setShrinkwrapVersion(text: string, version: string): string {
  const lock = parseRunnerLock(text);
  const rootEntry = lock.packages[rootEntryKey] ?? {};
  return renderHubShrinkwrap({ ...lock, version, packages: { ...lock.packages, [rootEntryKey]: { ...rootEntry, version } } });
}

/** @description Every package location and version a shrinkwrap pins — what an install of the package must have put in its `node_modules`. */
export function listPinnedPackages(lock: NpmLockfile): Array<{ location: string; version: string }> {
  return Object.entries(lock.packages)
    .filter(([location, entry]) => location !== rootEntryKey && entry.version !== undefined)
    .map(([location, entry]) => ({ location, version: entry.version ?? '' }));
}

const installedManifestSchema = z.object({ version: z.string() });

/**
 * @description What an installed copy of the package (`packageRoot`, the folder holding its `package.json`) has that its shrinkwrap does
 * not pin: a pinned package missing, or at another version. Empty: npm installed exactly the locked tree.
 */
export function getShrinkwrapDeviations(lock: NpmLockfile, packageRoot: string): string[] {
  const deviations: string[] = [];
  for (const { location, version } of listPinnedPackages(lock)) {
    const manifestPath = `${packageRoot}/${location}/package.json`;
    if (!fs.existsSync(manifestPath)) {
      deviations.push(`${location} is not installed (the shrinkwrap pins ${version})`);
      continue;
    }
    const installed = installedManifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const installedVersion = installed.success ? installed.data.version : 'unreadable';
    if (installedVersion !== version) deviations.push(`${location} is ${installedVersion}, the shrinkwrap pins ${version}`);
  }
  return deviations;
}
