import * as path from 'path';
import { z } from 'zod';

/**
 * @description The lockfile that the hub's package carries for the runner: made from `yarn.lock` for EXACTLY the packages the runner program needs at
 * run time, so that `npm ci` on a runner installs what the hub has run and nothing newer. Without it the runner ran `npm install` against the open
 * ranges of `package.json` (`"ssh2": "^1.17.0"`): at the next auto-update the machine could pull a version that was published since — hijacked,
 * say — and that nobody on the hub had ever run, into an always-on process.
 *
 * Pure, and free of `node_modules` of its own, so a test can run it on the repo's real `yarn.lock`:
 *
 *   - {@link parseYarnLock} reads the entries of a Yarn Berry lockfile (`__metadata: version: 8`);
 *   - {@link buildRunnerLock} walks the dependency tree from the runner's own dependencies ({@link runnerRuntimePackages}) and writes an npm
 *     lockfile (`lockfileVersion: 3`) with each package at the version `yarn.lock` resolved, from the registry URL npm would use. OPTIONAL dependencies
 *     are left out (`ssh2` has two native add-ons, `cpu-features` and `nan`: it falls back to JavaScript without them, and `--ignore-scripts` would not
 *     build them anyway), and so is the `node-gyp` that Yarn adds by itself to packages with a `binding.gyp`. A package that would need two versions
 *     (a nested `node_modules`) is refused — the runner's tree has none, and a flat lock stays easy to read;
 *   - the integrity hash of each package is NOT in `yarn.lock` (its checksums cover Yarn's own archives): `yarn runner-lock` fetches them once from
 *     the registry and keeps them, so the committed file pins the tarballs and not only the versions;
 *   - {@link renderRunnerPackageJson} is the `package.json` the runner gets: the hub's own, cut down to the runner's dependencies.
 *
 * The committed file is `remoteRun/runner-package-lock.json`; a unit test fails when it no longer matches `yarn.lock` and `package.json`.
 */

/** The runner program's runtime dependencies, as the hub's `package.json` names them (a unit test checks them against what the runner's code imports). */
export const runnerRuntimePackages: readonly string[] = ['ssh2', 'zod'];
/** Where the hub's package keeps the lock, next to `runner.sh`; the package ships it as `package-lock.json`. */
export const runnerLockRelativePath = 'remoteRun/runner-package-lock.json';
export const registryUrl = 'https://registry.npmjs.org';
const lockfileVersion = 3;
const npmRangePrefix = 'npm:';
/** The dependency Yarn adds to every package that has a native build, which npm's own metadata does not list. */
const yarnImplicitDependencyName = 'node-gyp';
const yarnImplicitDependencyRange = 'npm:latest';
const rootEntryKey = '';
/** The version the committed lock carries for the package itself: the hub's real one changes with every release, and the packer writes it in ({@link renderRunnerLockForPackage}). */
export const committedLockVersion = '0.0.0';

/** One entry of `yarn.lock`: what the runner's lock (and the hub's shrinkwrap) needs of it. */
export interface YarnLockEntry {
  version: string;
  /** `name@npm:version` for a package of the registry; anything else (a workspace, a patch, a git repository) is not one. */
  resolution: string;
  /** The dependencies as written (`name` → `npm:^1.0.0`). */
  dependencies: Record<string, string>;
  /** The names of dependencies that are optional. */
  optionalDependencyNames: string[];
  hasPeerDependencies: boolean;
  /** The names of its peer dependencies; those `peerDependenciesMeta` marks optional are in {@link optionalPeerDependencyNames} too. */
  peerDependencyNames: string[];
  optionalPeerDependencyNames: string[];
}

const stringRecordSchema = z.record(z.string(), z.string());

const npmLockPackageSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  dependencies: stringRecordSchema.optional(),
  engines: stringRecordSchema.optional(),
  /** npm runs a package's install scripts from a lock only when its entry says it has some (the hub's shrinkwrap; the runner builds nothing). */
  hasInstallScript: z.boolean().optional(),
});

/** @name NpmLockPackage @description One `packages` entry of an npm lockfile as the runner's lock writes it. */
export type NpmLockPackage = z.infer<typeof npmLockPackageSchema>;

const npmLockfileSchema = z.object({
  name: z.string(),
  version: z.string(),
  lockfileVersion: z.number(),
  requires: z.boolean(),
  packages: z.record(z.string(), npmLockPackageSchema),
});

/** @name NpmLockfile @description The npm lockfile (`lockfileVersion` 3) as the runner's lock writes it. */
export type NpmLockfile = z.infer<typeof npmLockfileSchema>;

const rootPackageJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string().optional(),
  dependencies: stringRecordSchema,
  engines: stringRecordSchema.optional(),
});

/** @name RootPackageJson @description What the runner's `package.json` is cut from: the hub's own. */
export type RootPackageJson = z.infer<typeof rootPackageJsonSchema>;

/** @description The hub's `package.json` text as the parts the runner's package needs of it; throws when it is not what the packer expects. */
export function parseRootPackageJson(text: string): RootPackageJson {
  return rootPackageJsonSchema.parse(JSON.parse(text));
}

/** @description The text of a runner lock file; throws when it is not an npm lockfile. */
export function parseRunnerLock(text: string): NpmLockfile {
  return npmLockfileSchema.parse(JSON.parse(text));
}

const entryIndent = 2;
const nestedIndent = 4;
const deepIndent = 6;

function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function countIndent(line: string): number {
  return line.length - line.trimStart().length;
}

/** The `key: value` of a line; the value is unquoted and `''` for a line that opens a block. */
function splitKeyValue(line: string): { key: string; value: string } {
  const body = line.trim();
  const quotedKey = body.startsWith('"') ? body.indexOf('":') + 1 : -1;
  const separator = quotedKey > 0 ? quotedKey : body.indexOf(':');
  return { key: unquote(body.slice(0, separator)), value: unquote(body.slice(separator + 1)) };
}

/** The descriptors of an entry's header (`ssh2@npm:^1.17.0, ssh2@npm:^1.2.0`): the whole list is quoted once, and a range may hold a comma of its own, so a part without a name in front is the rest of the one before. */
function splitDescriptors(headerText: string): string[] {
  const descriptors: string[] = [];
  for (const part of headerText.split(', ')) {
    if (descriptors.length > 0 && !part.slice(1).includes('@')) descriptors[descriptors.length - 1] += `, ${part}`;
    else descriptors.push(part);
  }
  return descriptors;
}

/**
 * @description The entries of a Yarn Berry `yarn.lock`, by descriptor (`ssh2@npm:^1.17.0`): an entry that serves several descriptors is found under each.
 * Only what the runner's lock needs is kept. Throws when the text is not that format.
 */
export function parseYarnLock(text: string): Map<string, YarnLockEntry> {
  const entries = new Map<string, YarnLockEntry>();
  const lines = text.split('\n');
  if (!lines.some((line) => line.trim() === 'version: 8') || !lines.includes('__metadata:')) throw new Error('yarn.lock is not a Yarn Berry lockfile (`__metadata: version: 8`)');
  let index = 0;
  while (index < lines.length) {
    const header = lines[index];
    if (header.startsWith('#') || header.trim() === '' || header.startsWith(' ') || !header.endsWith(':') || header === '__metadata:') {
      index += 1;
      continue;
    }
    const descriptors = splitDescriptors(unquote(header.slice(0, -1)));
    const entry: YarnLockEntry = { version: '', resolution: '', dependencies: {}, optionalDependencyNames: [], hasPeerDependencies: false, peerDependencyNames: [], optionalPeerDependencyNames: [] };
    index += 1;
    let block: string | null = null;
    let metaName: string | null = null;
    for (; index < lines.length && (lines[index].trim() === '' ? false : countIndent(lines[index]) >= entryIndent); index += 1) {
      const line = lines[index];
      const indent = countIndent(line);
      const { key, value } = splitKeyValue(line);
      if (indent === entryIndent) {
        block = value === '' ? key : null;
        metaName = null;
        if (key === 'version') entry.version = value;
        if (key === 'resolution') entry.resolution = value;
        if (key === 'peerDependencies') entry.hasPeerDependencies = true;
      } else if (indent === nestedIndent && block === 'dependencies') {
        entry.dependencies[key] = value;
      } else if (indent === nestedIndent && block === 'peerDependencies') {
        entry.peerDependencyNames.push(key);
      } else if (indent === nestedIndent && (block === 'dependenciesMeta' || block === 'peerDependenciesMeta')) {
        metaName = key;
      } else if (indent === deepIndent && block === 'dependenciesMeta' && metaName !== null && key === 'optional' && value === 'true') {
        entry.optionalDependencyNames.push(metaName);
      } else if (indent === deepIndent && block === 'peerDependenciesMeta' && metaName !== null && key === 'optional' && value === 'true') {
        entry.optionalPeerDependencyNames.push(metaName);
      }
    }
    for (const descriptor of descriptors) entries.set(descriptor, entry);
  }
  return entries;
}

function stripNpmPrefix(range: string): string {
  return range.startsWith(npmRangePrefix) ? range.slice(npmRangePrefix.length) : range;
}

/** The tarball of a registry package, where npm looks for it: `<registry>/<name>/-/<last part of name>-<version>.tgz`. */
export function getRegistryTarballUrl(name: string, version: string): string {
  return `${registryUrl}/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}

/** The key of a package's integrity in the map `buildRunnerLock` takes. */
export function getIntegrityKey(name: string, version: string): string {
  return `${name}@${version}`;
}

export interface BuildRunnerLockInputs {
  yarnLockText: string;
  rootPackageJson: RootPackageJson;
  /** The runner's direct dependencies; default {@link runnerRuntimePackages}. */
  packageNames?: readonly string[];
  /** Integrity hashes already known, by {@link getIntegrityKey}; a package without one is written without. */
  integrities?: Readonly<Record<string, string>>;
}

/** @description One package the walk of {@link walkYarnTree} placed: its name, the version `yarn.lock` resolved, the dependencies it needs (as ranges). */
export interface PlacedPackage {
  name: string;
  version: string;
  dependencies: Record<string, string>;
}

/** @description How {@link walkYarnTree} may lay the tree out. */
export interface WalkYarnTreeOptions {
  /** A package needed in a second version goes under the package that needs it (npm's nesting); refused when false — the runner's flat lock. */
  isNestingAllowed: boolean;
  /** A package with peer dependencies is accepted — an optional peer is left out, a required one must be in the tree by the end; refused when false. */
  isPeerAllowed: boolean;
}

const nodeModulesSegment = 'node_modules';
const nestedNodeModulesSeparator = `/${nodeModulesSegment}/`;

/** The `node_modules` path a package at `location` finds `name` at, nearest first, the way Node resolves it (`''` is the root). */
function getLookupLocations(location: string, name: string): string[] {
  const locations: string[] = [];
  for (let current = location; ; ) {
    locations.push(current === '' ? path.posix.join(nodeModulesSegment, name) : `${current}${nestedNodeModulesSeparator}${name}`);
    if (current === '') return locations;
    const separatorIndex = current.lastIndexOf(nestedNodeModulesSeparator);
    current = separatorIndex < 0 ? '' : current.slice(0, separatorIndex);
  }
}

/**
 * @description Lay out the tree `yarn.lock` resolved for `rootDependencies` the way npm would install it, by location
 * (`node_modules/a`, `node_modules/a/node_modules/b`): each package at the version `yarn.lock` resolved, from the registry; first
 * come, highest place (the root deps first, then theirs, each in name order — the same tree for the same input). OPTIONAL
 * dependencies are left out, and so is the `node-gyp` Yarn adds by itself to packages with a `binding.gyp`. Throws, saying what is
 * wrong, for a package that is not on the registry, a missing entry, and what `options` refuse.
 */
export function walkYarnTree(entries: Map<string, YarnLockEntry>, rootDependencies: Record<string, string>, options: WalkYarnTreeOptions): Map<string, PlacedPackage> {
  const placed = new Map<string, PlacedPackage>();
  const queue: Array<{ location: string; name: string; range: string; requiredBy: string }> = Object.entries(sortRecord(rootDependencies)).map(([name, range]) => ({ location: rootEntryKey, name, range, requiredBy: 'package.json' }));
  const requiredPeers: Array<{ location: string; owner: string; peerName: string }> = [];
  for (let position = 0; position < queue.length; position += 1) {
    const { location, name, range, requiredBy } = queue[position];
    const descriptor = `${name}@${npmRangePrefix}${stripNpmPrefix(range)}`;
    const entry = entries.get(descriptor);
    if (entry === undefined) throw new Error(`yarn.lock has no entry for ${descriptor} (needed by ${requiredBy}): run \`yarn install\``);
    if (entry.resolution !== `${name}@${npmRangePrefix}${entry.version}`) throw new Error(`${descriptor} is not a package of the npm registry (${entry.resolution}): the runner's lock cannot hold it`);
    if (entry.hasPeerDependencies && !options.isPeerAllowed) throw new Error(`${descriptor} has peer dependencies, which the runner's lock does not resolve`);
    const found = getLookupLocations(location, name).map((candidate) => ({ candidate, existing: placed.get(candidate) })).find(({ existing }) => existing !== undefined);
    if (found?.existing?.version === entry.version) continue;
    if (found?.existing !== undefined && !options.isNestingAllowed) {
      throw new Error(`the runner needs ${name} in two versions (${found.existing.version} and ${entry.version}): its lock is flat and cannot nest`);
    }
    // Not found anywhere: the root's node_modules. Found in another version: under the package that needs this one.
    const placeAt = found === undefined ? path.posix.join(nodeModulesSegment, name) : `${location}${nestedNodeModulesSeparator}${name}`;
    const required = Object.entries(sortRecord(entry.dependencies)).filter(([dependencyName, dependencyRange]) => !entry.optionalDependencyNames.includes(dependencyName) && !(dependencyName === yarnImplicitDependencyName && dependencyRange === yarnImplicitDependencyRange));
    placed.set(placeAt, { name, version: entry.version, dependencies: Object.fromEntries(required.map(([dependencyName, dependencyRange]) => [dependencyName, stripNpmPrefix(dependencyRange)])) });
    for (const [dependencyName, dependencyRange] of required) queue.push({ location: placeAt, name: dependencyName, range: dependencyRange, requiredBy: `${name}@${entry.version}` });
    for (const peerName of entry.peerDependencyNames) {
      if (!entry.optionalPeerDependencyNames.includes(peerName)) requiredPeers.push({ location: placeAt, owner: `${name}@${entry.version}`, peerName });
    }
  }
  // A required peer is not installed for the package that names it: something else must bring it, where the package finds it.
  for (const { location, owner, peerName } of requiredPeers) {
    if (!getLookupLocations(location, peerName).some((candidate) => placed.has(candidate))) throw new Error(`${owner} needs its peer ${peerName}, which no package of the tree brings where it can find it`);
  }
  return placed;
}

/** @description The runner's npm lockfile for `inputs`: see the head of the file. Throws, saying what is wrong, when the tree cannot be written flat. */
export function buildRunnerLock(inputs: BuildRunnerLockInputs): NpmLockfile {
  const { rootPackageJson } = inputs;
  const entries = parseYarnLock(inputs.yarnLockText);
  const packageNames = inputs.packageNames ?? runnerRuntimePackages;
  const rootDependencies: Record<string, string> = {};
  for (const name of packageNames) {
    const range = rootPackageJson.dependencies[name];
    if (range === undefined) throw new Error(`package.json has no dependency «${name}»: the runner needs it`);
    rootDependencies[name] = range;
  }
  const placed = walkYarnTree(entries, rootDependencies, { isNestingAllowed: false, isPeerAllowed: false });
  const packages: Record<string, NpmLockPackage> = {
    [rootEntryKey]: { name: rootPackageJson.name, version: committedLockVersion, dependencies: sortRecord(rootDependencies), ...(rootPackageJson.engines === undefined ? {} : { engines: rootPackageJson.engines }) },
    ...createLockPackageEntries(placed, inputs.integrities ?? {}, {}),
  };
  return { name: rootPackageJson.name, version: committedLockVersion, lockfileVersion, requires: true, packages };
}

/**
 * @description The `packages` entries of a lockfile for the packages {@link walkYarnTree} placed, by location in sorted order: the
 * registry tarball, the integrity where `integrities` knows it, the dependencies, and `hasInstallScript` for those `installScriptKeys`
 * names (by {@link getIntegrityKey}) — npm runs a package's install scripts from a lock only when its entry says so.
 */
export function createLockPackageEntries(placed: Map<string, PlacedPackage>, integrities: Readonly<Record<string, string>>, installScriptKeys: Readonly<Record<string, boolean>>): Record<string, NpmLockPackage> {
  const packages: Record<string, NpmLockPackage> = {};
  for (const location of [...placed.keys()].sort()) {
    const { name, version, dependencies } = placed.get(location) ?? { name: '', version: '', dependencies: {} };
    const key = getIntegrityKey(name, version);
    const integrity = integrities[key];
    packages[location] = {
      version,
      resolved: getRegistryTarballUrl(name, version),
      ...(integrity === undefined ? {} : { integrity }),
      ...(Object.keys(dependencies).length === 0 ? {} : { dependencies: sortRecord(dependencies) }),
      ...(installScriptKeys[key] === true ? { hasInstallScript: true } : {}),
    };
  }
  return packages;
}

export function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1)));
}

/** @description The lockfile as it is written to disk: two-space JSON and a final newline, deterministic. */
export function renderRunnerLock(lock: NpmLockfile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** @description The runner's direct dependencies as the lock records them (`packages[""].dependencies`). */
export function readRunnerLockRootDependencies(lock: NpmLockfile): Record<string, string> {
  return lock.packages[rootEntryKey]?.dependencies ?? {};
}

/** @description The integrity hashes a lock already holds, by {@link getIntegrityKey}: what a regeneration keeps for a package whose version has not moved. */
export function readLockIntegrities(lock: NpmLockfile): Record<string, string> {
  const integrities: Record<string, string> = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === rootEntryKey || entry.version === undefined || entry.integrity === undefined) continue;
    integrities[getIntegrityKey(getLockEntryPackageName(key), entry.version)] = entry.integrity;
  }
  return integrities;
}

/** @description The package name of a lock entry's location (`node_modules/a/node_modules/@s/b` → `@s/b`). */
export function getLockEntryPackageName(location: string): string {
  return location.slice(location.lastIndexOf(`${nodeModulesSegment}/`) + `${nodeModulesSegment}/`.length);
}

/**
 * @description The `package.json` the runner gets: the hub's own name, version and engines, and ONLY the dependencies the lock records — each at
 * the range the lock records, which must be the hub's own. Throws when the lock no longer matches the hub's `package.json`.
 */
export function renderRunnerPackageJson(rootPackageJson: RootPackageJson, lock: NpmLockfile): string {
  const dependencies = readRunnerLockRootDependencies(lock);
  for (const [name, range] of Object.entries(dependencies)) {
    if (rootPackageJson.dependencies[name] !== range) throw new Error(`the runner's lock expects ${name}@${range}, but package.json says ${rootPackageJson.dependencies[name] ?? 'nothing'}: run \`yarn runner-lock\``);
  }
  const trimmed = { name: rootPackageJson.name, version: rootPackageJson.version, license: rootPackageJson.license, ...(rootPackageJson.engines === undefined ? {} : { engines: rootPackageJson.engines }), dependencies: sortRecord(dependencies) };
  return `${JSON.stringify(trimmed, null, 2)}\n`;
}

/** @description The lock with the hub's own name and version on it — they change with every release, and the committed file must not. */
export function renderRunnerLockForPackage(lock: NpmLockfile, rootPackageJson: RootPackageJson): string {
  const rootEntry = lock.packages[rootEntryKey] ?? {};
  return renderRunnerLock({ ...lock, name: rootPackageJson.name, version: rootPackageJson.version, packages: { ...lock.packages, [rootEntryKey]: { ...rootEntry, name: rootPackageJson.name, version: rootPackageJson.version } } });
}
