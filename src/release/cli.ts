/**
 * Thin wrapper over `releasePlan.ts` for the release workflow and the `version` script: reads git and the
 * files of the CURRENT directory (the repository root), asks the pure planner, writes the answer to stdout,
 * `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY`. Run with `tsx src/release/cli.ts <subcommand>`.
 *
 *   plan [--bump auto|patch|minor|major] [--force true|false]   decide the run; exits 1 on a `fail`
 *   apply <version>                                             write package.json version + CHANGELOG
 *   changelog                                                   CHANGELOG only, version from package.json
 *   notes <version>                                             print the version's CHANGELOG section
 *   check-pack [--version X.Y.Z] [--skip-install]               package contents + install smoke test
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  ReleaseError,
  checkIsShippedManifestChange,
  createChangelogRelease,
  createReleasePlan,
  getChangelogFallback,
  getPackViolations,
  getReleaseDate,
  getReleaseNotes,
  releaseTagPrefix,
  type PackListing,
  type PackageManifest,
  type ReleaseBumpInput,
  type ReleaseCommit,
  type ReleasePlan,
} from './releasePlan';

const gitTimeoutMs = 60_000;
const npmPackTimeoutMs = 3 * 60_000;
const npmInstallTimeoutMs = 10 * 60_000;
const smokeTestTimeoutMs = 60_000;
const gitMaxBufferBytes = 64 * 1024 * 1024;
const recordSeparator = '\x1e';
const fieldSeparator = '\x1f';
const releaseTagGlob = `${releaseTagPrefix}[0-9]*`;
const bumpInputs: ReleaseBumpInput[] = ['auto', 'patch', 'minor', 'major'];
const manifestFileName = 'package.json';
const changelogFileName = 'CHANGELOG.md';
const releaseVersionPattern = /^\d+\.\d+\.\d+$/;
const annotationNewline = '%0A';

function runCommand(command: string, args: string[], timeoutMs: number, cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: gitMaxBufferBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(...args: string[]): string {
  return runCommand('git', args, gitTimeoutMs);
}

function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function getLastReleaseTag(): string | null {
  return tryGit('describe', '--tags', '--abbrev=0', '--match', releaseTagGlob)?.trim() ?? null;
}

function checkIsHeadTagged(): boolean {
  return git('tag', '--points-at', 'HEAD', '--list', releaseTagGlob).trim() !== '';
}

function readManifestAt(revision: string): PackageManifest | null {
  const text = tryGit('show', `${revision}:${manifestFileName}`);
  return text === null ? null : JSON.parse(text);
}

function splitPaths(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

/** Commits of `<tag>..HEAD` (merges left out — their content is in the commits they merge), oldest last. */
function getCommitsSince(tag: string): ReleaseCommit[] {
  const format = `${recordSeparator}%H${fieldSeparator}%s${fieldSeparator}%b${fieldSeparator}`;
  const log = git('log', '--no-merges', '--no-renames', '--name-only', `--format=${format}`, `${tag}..HEAD`);
  return log
    .split(recordSeparator)
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash, subject, body, pathsText] = record.split(fieldSeparator);
      const paths = splitPaths(pathsText);
      const changesShippedManifest =
        paths.includes(manifestFileName) &&
        checkIsShippedManifestChange(readManifestAt(`${hash}^`), readManifestAt(hash));
      return { hash, subject, body, paths, changesShippedManifest };
    });
}

function getNetDiff(tag: string): { paths: string[]; changesShippedManifest: boolean } {
  const paths = splitPaths(git('diff', '--name-only', '--no-renames', tag, 'HEAD'));
  const changesShippedManifest =
    paths.includes(manifestFileName) && checkIsShippedManifestChange(readManifestAt(tag), readManifestAt('HEAD'));
  return { paths, changesShippedManifest };
}

function readPackageVersion(): string {
  const manifest: { version: string } = JSON.parse(fs.readFileSync(manifestFileName, 'utf8'));
  return manifest.version;
}

function writePackageVersion(version: string): void {
  const text = fs.readFileSync(manifestFileName, 'utf8');
  const current = readPackageVersion();
  // Edit the one value in place: JSON.stringify would rewrite the file's whole formatting.
  const versionLine = new RegExp(`("version"\\s*:\\s*")${current.replaceAll('.', '\\.')}(")`);
  if (!versionLine.test(text)) throw new ReleaseError(`Cannot find "version": "${current}" in ${manifestFileName}.`);
  fs.writeFileSync(manifestFileName, text.replace(versionLine, `$1${version}$2`));
}

/** Writes the CHANGELOG release section for `version` and returns the notes (the section body). */
function writeChangelogRelease(version: string): string {
  const lastTag = getLastReleaseTag();
  const commits = lastTag === null ? [] : getCommitsSince(lastTag);
  const { changelog, notes } = createChangelogRelease(
    fs.readFileSync(changelogFileName, 'utf8'),
    version,
    getReleaseDate(new Date()),
    getChangelogFallback(commits),
  );
  fs.writeFileSync(changelogFileName, changelog);
  return notes;
}

function writeGithubOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) fs.appendFileSync(outputFile, `${name}=${value.replace(/\s*\n\s*/g, ' ')}\n`);
}

function writeStepSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, `${markdown}\n`);
}

function describePlan(plan: ReleasePlan): string {
  if (plan.kind === 'skip') return `Nothing to release: ${plan.reason}`;
  if (plan.kind === 'fail') return plan.message;
  return `Release ${plan.version} (${plan.bump}).`;
}

function parseBumpInput(text: string | undefined): ReleaseBumpInput {
  const bump = bumpInputs.find((candidate) => candidate === (text || 'auto'));
  if (!bump) throw new ReleaseError(`--bump must be one of ${bumpInputs.join(', ')}, got "${text}".`);
  return bump;
}

function formatErrorAnnotation(title: string, message: string): string {
  return `::error title=${title}::${message.replace(/\n/g, annotationNewline)}\n`;
}

/** The plan, with the CHANGELOG rules checked up front: a violating entry fails before the 30–60 min gate. */
function runPlan(args: string[]): number {
  const { values } = parseArgs({ args, options: { bump: { type: 'string' }, force: { type: 'string' } } });
  const lastTag = getLastReleaseTag();
  const commits = lastTag === null ? [] : getCommitsSince(lastTag);
  let plan = createReleasePlan({
    lastTag,
    commitsSinceTag: commits,
    netDiff: lastTag === null ? { paths: [], changesShippedManifest: false } : getNetDiff(lastTag),
    isHeadTagged: lastTag !== null && checkIsHeadTagged(),
    input: { bump: parseBumpInput(values.bump), force: values.force === 'true' },
  });
  if (plan.kind === 'release') {
    try {
      createChangelogRelease(fs.readFileSync(changelogFileName, 'utf8'), plan.version, getReleaseDate(new Date()), getChangelogFallback(commits));
    } catch (error) {
      if (!(error instanceof ReleaseError)) throw error;
      plan = { kind: 'fail', message: error.message };
    }
  }

  const message = describePlan(plan);
  writeGithubOutput('kind', plan.kind);
  writeGithubOutput('message', message);
  if (plan.kind === 'release') {
    writeGithubOutput('version', plan.version);
    writeGithubOutput('bump', plan.bump);
  }
  writeStepSummary(`### Release plan\n\n${message}`);
  if (plan.kind === 'fail') {
    process.stderr.write(`${message}\n`);
    process.stdout.write(formatErrorAnnotation('Release plan failed', message));
    return 1;
  }
  process.stdout.write(`${message}\n`);
  return 0;
}

function requireVersionArgument(positionals: string[]): string {
  const version = positionals[0];
  if (!version || !releaseVersionPattern.test(version)) throw new ReleaseError(`Expected a version X.Y.Z, got "${version}".`);
  return version;
}

function runApply(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const version = requireVersionArgument(positionals);
  writePackageVersion(version);
  writeChangelogRelease(version);
  process.stdout.write(`Applied ${version}: ${manifestFileName} and ${changelogFileName} updated.\n`);
  return 0;
}

/** The `npm version` path: package.json already carries the new version, only the CHANGELOG heading moves. */
function runChangelog(): number {
  const version = readPackageVersion();
  writeChangelogRelease(version);
  process.stdout.write(`${changelogFileName}: ## Unreleased is now ## ${version}.\n`);
  return 0;
}

function runNotes(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const version = requireVersionArgument(positionals);
  const notes = getReleaseNotes(fs.readFileSync(changelogFileName, 'utf8'), version);
  if (notes === null) throw new ReleaseError(`${changelogFileName} has no non-empty section for ${version}.`);
  process.stdout.write(`${notes}\n`);
  return 0;
}

/** Packs the tarball, installs it into a throwaway prefix and runs its `charness --version`. */
function runInstallSmokeTest(expectedVersion: string): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-pack-'));
  try {
    const [packed]: { filename: string }[] = JSON.parse(
      runCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workDir], npmPackTimeoutMs),
    );
    const prefix = path.join(workDir, 'prefix');
    runCommand(
      'npm',
      ['install', '--prefix', prefix, '--no-audit', '--no-fund', path.join(workDir, packed.filename)],
      npmInstallTimeoutMs,
    );
    const installedVersion = runCommand(path.join(prefix, 'node_modules', '.bin', 'charness'), ['--version'], smokeTestTimeoutMs).trim();
    if (installedVersion !== expectedVersion) {
      throw new ReleaseError(`The installed tarball prints version ${installedVersion}, expected ${expectedVersion}.`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function runCheckPack(args: string[]): number {
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, 'skip-install': { type: 'boolean' } } });
  const version = values.version ?? readPackageVersion();
  const [listing]: PackListing[] = JSON.parse(runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], npmPackTimeoutMs));
  const violations = getPackViolations(listing, version);
  if (violations.length > 0) {
    throw new ReleaseError(`The package is not fit to publish:\n${violations.map((line) => `  ${line}`).join('\n')}`);
  }
  process.stdout.write(`Package contents ok (${listing.files.length} files, version ${version}).\n`);
  if (!values['skip-install']) {
    runInstallSmokeTest(version);
    process.stdout.write(`Installed from the tarball: charness --version prints ${version}.\n`);
  }
  return 0;
}

function main(argv: string[]): number {
  const [subcommand, ...args] = argv;
  switch (subcommand) {
    case 'plan':
      return runPlan(args);
    case 'apply':
      return runApply(args);
    case 'changelog':
      return runChangelog();
    case 'notes':
      return runNotes(args);
    case 'check-pack':
      return runCheckPack(args);
    default:
      throw new ReleaseError(`Unknown subcommand "${subcommand}". Use plan | apply | changelog | notes | check-pack.`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.stdout.write(formatErrorAnnotation('Release failed', error.message));
  process.exitCode = 1;
}
