/**
 * Thin wrapper over `releasePlan.ts` for the release workflow and the `version` script: reads git and the
 * files of the CURRENT directory (the repository root), asks the pure planner, writes the answer to stdout,
 * `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY`. Run with `tsx src/release/cli.ts <subcommand>`.
 *
 *   plan [--bump auto|patch|minor|major] [--force true|false]   decide the run; exits 1 on a `fail`
 *   apply <version>                                             write package.json version + CHANGELOG
 *   changelog                                                   CHANGELOG only, version from package.json
 *   notes <version>                                             print the version's CHANGELOG section
 *   check-pack [--version X.Y.Z] [--skip-install]               package contents + bin paths + install smoke test
 *   check-install --tarball <file> [--version X.Y.Z]            the install smoke test of a packed tarball (the release's own job)
 *   check-publish                                               `npm publish --dry-run`: refuses what npm would drop from package.json
 *   test-gate [--sha <commit>] [--event <name>] [--through-parent]
 *                                                               the Tests workflow's result for the exact commit (a hand-pushed tag
 *                                                               also tries its parent); exits 1 on a refusal
 *   verify-delta --base <commit> [--head <rev>]                 the release commit is the tested one plus its version bump, or exit 1
 *   check-registry --version X.Y.Z [--registry <url>]          refuses while npm holds a version newer than every release tag but this
 *                                                               run's own (a release that published and did not finish)
 *   commit-release <version> [--tarball <file>] [--base <commit>] [--check | --prepare] [--remote origin] [--branch main]
 *                                                               commit, tag and push the applied release (`--tarball`: its files out of
 *                                                               the packed package; `--base`: refuse unless it is that commit plus its
 *                                                               version bump; `--check` / `--prepare`: commit and merge main locally,
 *                                                               push nothing — before / after the publish)
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  ReleaseError,
  checkIsShippedManifestChange,
  createChangelogRelease,
  createReleasePlan,
  getChangelogFallback,
  getInvalidBinPaths,
  getPackViolations,
  getPublishDryRunProblems,
  getReleaseDate,
  getReleaseNotes,
  getUnfinishedReleaseVersions,
  mergeReleaseChangelog,
  releaseTagPrefix,
  type PackListing,
  type PackageManifest,
  type ReleaseBumpInput,
  type ReleaseCommit,
  type ReleasePlan,
} from './releasePlan';
import {
  decideTestGate,
  decideTestGateThroughParent,
  getReleaseDeltaProblems,
  getTestGateVerdict,
  testWorkflowFile,
  type TestGateDecision,
  type TestGateState,
  type WorkflowRun,
} from './testGate';
import { getShrinkwrapDeviations, setShrinkwrapVersion, shrinkwrapFileName } from './hubShrinkwrap';
import { startLocalRegistry, type LocalRegistryManifest } from './localRegistry';
import { parseRunnerLock, registryUrl } from '../runners/runnerLock';

const shortShaLength = 7;
const gitTimeoutMs = 60_000;
const gitPushTimeoutMs = 5 * 60_000;
const npmPackTimeoutMs = 3 * 60_000;
const npmPublishDryRunTimeoutMs = 5 * 60_000;
const outputTailChars = 4000;
const npmInstallTimeoutMs = 10 * 60_000;
const smokeTestTimeoutMs = 60_000;
const gitMaxBufferBytes = 64 * 1024 * 1024;
const recordSeparator = '\x1e';
const fieldSeparator = '\x1f';
const releaseTagGlob = `${releaseTagPrefix}[0-9]*`;
const bumpInputs: ReleaseBumpInput[] = ['auto', 'patch', 'minor', 'major'];
const defaultRemote = 'origin';
const defaultBranch = 'main';
const pushAttemptLimit = 3;
const releaseBotIdentity = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];
const manifestFileName = 'package.json';
const changelogFileName = 'CHANGELOG.md';
const releaseVersionPattern = /^\d+\.\d+\.\d+$/;
const fullShaPattern = /^[0-9a-f]{40}$/;
const annotationNewline = '%0A';
const defaultGithubApiUrl = 'https://api.github.com';
const githubApiVersion = '2022-11-28';
const githubApiTimeoutMs = 60_000;
const registryReadTimeoutMs = 60_000;
/** The abbreviated packument: the versions without their whole manifests. */
const registryPackumentAccept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8';
const notFoundStatus = 404;
const registryPackumentSchema = z.object({ versions: z.record(z.string(), z.object({})) });
/** A commit has a handful of runs; one page is all of them. */
const workflowRunsPageSize = 100;

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

function gitPush(...args: string[]): string {
  return runCommand('git', ['push', ...args], gitPushTimeoutMs);
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

function readFileAt(revision: string, filePath: string): string | null {
  return tryGit('show', `${revision}:${filePath}`);
}

function readManifestAt(revision: string): PackageManifest | null {
  const text = readFileAt(revision, manifestFileName);
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

function readPackageManifest(): PackageManifest & { name: string; version: string } {
  return JSON.parse(fs.readFileSync(manifestFileName, 'utf8'));
}

function readPackageVersion(): string {
  return readPackageManifest().version;
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

/** The shrinkwrap carries the package's version too (as `npm version` writes it); a repository without one has nothing to write. */
function writeShrinkwrapVersion(version: string): boolean {
  if (!fs.existsSync(shrinkwrapFileName)) return false;
  fs.writeFileSync(shrinkwrapFileName, setShrinkwrapVersion(fs.readFileSync(shrinkwrapFileName, 'utf8'), version));
  return true;
}

function runApply(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const version = requireVersionArgument(positionals);
  writePackageVersion(version);
  const hasShrinkwrap = writeShrinkwrapVersion(version);
  writeChangelogRelease(version);
  process.stdout.write(`Applied ${version}: ${[manifestFileName, ...(hasShrinkwrap ? [shrinkwrapFileName] : []), changelogFileName].join(', ')} updated.\n`);
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

/** The path inside a packed tarball under which npm puts every file. */
const tarballRootFolder = 'package';

/** `npm install` as an async child: the local registry serving it runs in this process, so a blocking call would starve it. */
function runCommandAsync(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: gitMaxBufferBytes }, (error, stdout, stderr) => {
      if (error) reject(new ReleaseError(`${command} ${args.join(' ')} failed: ${error.message}\n${`${stdout}${stderr}`.slice(-outputTailChars)}`));
      else resolve(stdout);
    });
  });
}

/**
 * Installs a packed tarball the way a user installs the release — `npm install -g <name>@<version>` from a registry, through a
 * loopback one that serves the tarball and marks its shrinkwrap as the npm registry does (npm reads a package's shrinkwrap only then:
 * an install of the tarball FILE resolves the open ranges) — into a throwaway prefix with a cache of its own, runs its
 * `charness --version`, and checks that npm installed exactly the tree the shrinkwrap pins.
 */
async function runInstallSmokeTest(tarballPath: string, expectedVersion: string): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-install-'));
  try {
    const unpackedDir = path.join(workDir, 'unpacked');
    fs.mkdirSync(unpackedDir);
    runCommand('tar', ['-xzf', tarballPath, '-C', unpackedDir], npmPackTimeoutMs);
    const unpackedRoot = path.join(unpackedDir, tarballRootFolder);
    const manifest: LocalRegistryManifest = JSON.parse(fs.readFileSync(path.join(unpackedRoot, manifestFileName), 'utf8'));
    const shrinkwrapPath = path.join(unpackedRoot, shrinkwrapFileName);
    const hasShrinkwrap = fs.existsSync(shrinkwrapPath);
    const registry = await startLocalRegistry({ manifest, tarballPath, hasShrinkwrap });
    const prefix = path.join(workDir, 'prefix');
    try {
      await runCommandAsync(
        'npm',
        ['install', '--global', '--prefix', prefix, '--registry', registry.url, '--cache', path.join(workDir, 'npm-cache'), '--no-audit', '--no-fund', `${manifest.name}@${manifest.version}`],
        npmInstallTimeoutMs,
      );
    } finally {
      await registry.stop();
    }
    const installedVersion = runCommand(path.join(prefix, 'bin', 'charness'), ['--version'], smokeTestTimeoutMs).trim();
    if (installedVersion !== expectedVersion) {
      throw new ReleaseError(`The installed tarball prints version ${installedVersion}, expected ${expectedVersion}.`);
    }
    if (!hasShrinkwrap) return;
    const deviations = getShrinkwrapDeviations(parseRunnerLock(fs.readFileSync(shrinkwrapPath, 'utf8')), path.join(prefix, 'lib', 'node_modules', manifest.name));
    if (deviations.length > 0) {
      throw new ReleaseError(`npm did not install the tree ${shrinkwrapFileName} pins:\n${deviations.map((line) => `  ${line}`).join('\n')}`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Packs the working tree into a throwaway folder and runs {@link runInstallSmokeTest} on the tarball. */
async function runPackedInstallSmokeTest(expectedVersion: string): Promise<void> {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-pack-'));
  try {
    const [packed]: { filename: string }[] = JSON.parse(
      runCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], npmPackTimeoutMs),
    );
    await runInstallSmokeTest(path.join(packDir, packed.filename), expectedVersion);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

/** The install smoke test of a tarball packed by an earlier job (`--tarball`), for the version it must print (`--version`, default package.json's). */
async function runCheckInstall(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { tarball: { type: 'string' }, version: { type: 'string' } } });
  if (!values.tarball) throw new ReleaseError('check-install needs --tarball <the packed package>.');
  const version = values.version ?? readPackageVersion();
  await runInstallSmokeTest(path.resolve(values.tarball), version);
  process.stdout.write(`Installed ${path.basename(values.tarball)} from a registry: charness --version prints ${version}, and npm installed the tree ${shrinkwrapFileName} pins.\n`);
  return 0;
}

async function runCheckPack(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, 'skip-install': { type: 'boolean' } } });
  const version = values.version ?? readPackageVersion();
  const invalidBinPaths = getInvalidBinPaths(readPackageManifest().bin);
  if (invalidBinPaths.length > 0) {
    throw new ReleaseError(
      `${manifestFileName} has bin paths npm >= 11.10 drops at publish (write them without "./"):\n${invalidBinPaths.map((line) => `  ${line}`).join('\n')}`,
    );
  }
  const [listing]: PackListing[] = JSON.parse(runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], npmPackTimeoutMs));
  const violations = getPackViolations(listing, version);
  if (violations.length > 0) {
    throw new ReleaseError(`The package is not fit to publish:\n${violations.map((line) => `  ${line}`).join('\n')}`);
  }
  process.stdout.write(`Package contents ok (${listing.files.length} files, version ${version}).\n`);
  if (!values['skip-install']) {
    await runPackedInstallSmokeTest(version);
    process.stdout.write(`Installed from the tarball: charness --version prints ${version}, and npm installed the tree ${shrinkwrapFileName} pins.\n`);
  }
  return 0;
}

function readEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new ReleaseError(`${name} is not set; the test gate runs inside GitHub Actions.`);
  return value;
}

/** The `Tests` workflow's runs of one exact commit (GitHub API: workflow runs filtered by `head_sha`). */
async function fetchTestWorkflowRuns(sha: string, workflowFile: string): Promise<WorkflowRun[]> {
  const apiUrl = process.env.GITHUB_API_URL || defaultGithubApiUrl;
  const url = `${apiUrl}/repos/${readEnvironment('GITHUB_REPOSITORY')}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&per_page=${workflowRunsPageSize}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${readEnvironment('GITHUB_TOKEN')}`,
        'X-GitHub-Api-Version': githubApiVersion,
      },
      signal: AbortSignal.timeout(githubApiTimeoutMs),
    });
  } catch (error) {
    throw new ReleaseError(`Cannot look up the Tests runs of ${sha.slice(0, shortShaLength)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new ReleaseError(`Cannot look up the Tests runs of ${sha.slice(0, shortShaLength)}: GitHub answered ${response.status} for ${workflowFile} (the job needs \`actions: read\`).`);
  }
  const body: { workflow_runs?: WorkflowRun[] } = JSON.parse(await response.text());
  return body.workflow_runs ?? [];
}

/**
 * What the Tests workflow says about the exact commit this release is cut from (`--sha`, default HEAD). Passed → the release does not
 * run the suite; no run → it runs it; red or still running → the daily run ends green with the reason, any other entry fails.
 */
async function runTestGate(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { sha: { type: 'string' }, event: { type: 'string' }, 'through-parent': { type: 'boolean' } } });
  const sha = values.sha ?? git('rev-parse', 'HEAD').trim();
  if (!fullShaPattern.test(sha)) throw new ReleaseError(`--sha must be a full 40-character commit SHA, got "${sha}".`);
  const event = values.event ?? process.env.GITHUB_EVENT_NAME ?? '';

  // A hand-pushed tag: its commit was pushed this very moment, its parent usually was tested long ago.
  const parentSha = values['through-parent'] ? tryGit('rev-parse', `${sha}^`)?.trim() : undefined;
  if (parentSha && fullShaPattern.test(parentSha)) {
    const parentVerdict = getTestGateVerdict(await fetchTestWorkflowRuns(parentSha, testWorkflowFile), parentSha);
    const throughParent = decideTestGateThroughParent(parentVerdict, getParentDeltaProblems(parentSha, sha));
    if (throughParent) return reportTestGate({ sha: parentSha, state: 'passed', decision: throughParent });
  }

  const verdict = getTestGateVerdict(await fetchTestWorkflowRuns(sha, testWorkflowFile), sha);
  return reportTestGate({ sha, state: verdict.state, decision: decideTestGate(verdict, event) });
}

/** Writes what the gate decided — to the step's outputs and summary, and to the log — and fails the step on a refusal. */
function reportTestGate({ sha, state, decision }: { sha: string; state: TestGateState; decision: TestGateDecision }): number {
  writeGithubOutput('sha', sha);
  writeGithubOutput('state', state);
  writeGithubOutput('proceed', String(decision.proceed));
  writeGithubOutput('runSuite', String(decision.runSuite));
  writeGithubOutput('message', decision.message);
  writeStepSummary(`### Tests of ${sha.slice(0, shortShaLength)}\n\n${decision.message}`);
  if (decision.isRefusal) throw new ReleaseError(decision.message);
  process.stdout.write(`${decision.message}\n`);
  if (!decision.proceed) process.stdout.write(`::warning title=No release today::${decision.message}\n`);
  return 0;
}

/** What differs between `base` and `head` (the working tree when omitted) beyond package.json's version line and CHANGELOG.md. */
function getDeltaProblems(base: string, head?: string): string[] {
  const revisions = head ? [base, head] : [base];
  return getReleaseDeltaProblems({
    changedPaths: splitPaths(git('diff', '--name-only', '--no-renames', ...revisions)),
    manifestDiff: git('diff', '-U0', '--no-color', '--no-renames', ...revisions, '--', manifestFileName),
    shrinkwrapDiff: git('diff', '-U0', '--no-color', '--no-renames', ...revisions, '--', shrinkwrapFileName),
  });
}

/** {@link getDeltaProblems} for the gate's parent shortcut: a parent that cannot be compared (a shallow checkout) is a problem, not a crash. */
function getParentDeltaProblems(parentSha: string, sha: string): string[] {
  try {
    return getDeltaProblems(parentSha, sha);
  } catch (error) {
    return [`the tagged commit cannot be compared with its parent (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`];
  }
}

/**
 * Refuses (throws, `consequence` saying what is not done) unless `head` — the working tree when omitted — is `base` plus its version bump:
 * package.json's version line, the shrinkwrap's two, CHANGELOG.md.
 */
function assertReleaseDelta(base: string, head: string | undefined, consequence: string): void {
  const problems = getDeltaProblems(base, head);
  if (problems.length > 0) {
    throw new ReleaseError(
      `The release is not the tested commit ${base.slice(0, shortShaLength)} plus its version bump; ${consequence}:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}

/**
 * The release commit may differ from the commit the tests passed on ONLY in package.json's version line and CHANGELOG.md. `--head`
 * a revision, or none for the working tree (the applied release before it is committed).
 */
function runVerifyDelta(args: string[]): number {
  const { values } = parseArgs({ args, options: { base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base) throw new ReleaseError('verify-delta needs --base <the tested commit>.');
  assertReleaseDelta(values.base, values.head, 'nothing is published');
  process.stdout.write(`The release differs from the tested commit ${values.base.slice(0, shortShaLength)} only in the version and the CHANGELOG.\n`);
  return 0;
}

/** Every version of `name` the registry holds; none for a package it does not know (never published). Throws when it cannot tell. */
async function fetchRegistryVersions(registry: string, name: string): Promise<string[]> {
  const cannotRead = `Cannot read the versions the registry holds of ${name}`;
  let response: Response;
  try {
    response = await fetch(`${registry.replace(/\/+$/, '')}/${name.replace('/', '%2F')}`, {
      headers: { accept: registryPackumentAccept },
      signal: AbortSignal.timeout(registryReadTimeoutMs),
    });
  } catch (error) {
    throw new ReleaseError(`${cannotRead}: ${error instanceof Error ? error.message : String(error)}; nothing is published.`);
  }
  if (response.status === notFoundStatus) return [];
  if (!response.ok) throw new ReleaseError(`${cannotRead}: the registry answered ${response.status}; nothing is published.`);
  const packument = registryPackumentSchema.safeParse(await response.json());
  if (!packument.success) throw new ReleaseError(`${cannotRead}: the registry's answer has no versions; nothing is published.`);
  return Object.keys(packument.data.versions);
}

/**
 * Refuses while the registry holds a version newer than every release tag of the repository but this run's own: a release that
 * published and did not finish ({@link getUnfinishedReleaseVersions}). Releasing past it would lose it for good, so the run stops
 * before anything else happens — the version's own run (or the by-hand path) finishes it first.
 */
async function runCheckRegistry(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, registry: { type: 'string' } } });
  const version = values.version ?? '';
  if (!releaseVersionPattern.test(version)) throw new ReleaseError(`check-registry needs --version X.Y.Z, got "${version}".`);
  const { name } = readPackageManifest();
  const tagVersions = splitPaths(git('tag', '--list', releaseTagGlob)).map((tag) => tag.slice(releaseTagPrefix.length));
  const unfinished = getUnfinishedReleaseVersions({ registryVersions: await fetchRegistryVersions(values.registry ?? registryUrl, name), tagVersions, version });
  if (unfinished.length > 0) {
    const list = unfinished.join(', ');
    throw new ReleaseError(
      `npm holds ${name} ${list}, which no release tag of the repository has: a release run published it and did not finish (its tag and version commit never reached the repository). ` +
        `Releasing ${version} now would leave ${list} without a tag, a release commit and a CHANGELOG section for good. ` +
        `Finish ${list} first: "Re-run failed jobs" on the run that published it (the version's provenance on npmjs.com links the run), or by hand — DEVELOPMENT.md § Releases, "When a release fails". Nothing is published or pushed.`,
    );
  }
  process.stdout.write(`npm holds no ${name} version newer than the release tags but ${version} itself.\n`);
  return 0;
}

/**
 * `npm publish --dry-run` exits 0 while it drops a field of `package.json` from the manifest it would send to the registry
 * (a warning); the release refuses that. A dry run that fails itself (a version already on npm, the registry unreachable) fails
 * the check too — it runs only where a publish is about to happen.
 */
function runCheckPublish(): number {
  const result = spawnSync('npm', ['publish', '--dry-run', '--ignore-scripts'], {
    encoding: 'utf8',
    timeout: npmPublishDryRunTimeoutMs,
    maxBuffer: gitMaxBufferBytes,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.error || result.status !== 0) {
    throw new ReleaseError(`\`npm publish --dry-run\` failed (${result.error?.message ?? `exit ${result.status}`}):\n${output.slice(-outputTailChars)}`);
  }
  const problems = getPublishDryRunProblems(output);
  if (problems.length > 0) {
    throw new ReleaseError(`npm would change ${manifestFileName} when publishing; fix it (npm pkg fix) before releasing:\n${problems.map((line) => `  ${line}`).join('\n')}`);
  }
  process.stdout.write('npm publish --dry-run: nothing in package.json is dropped or rewritten.\n');
  return 0;
}

/**
 * Merges `remoteRef` (the branch that moved during the run) into the release commit: git's merge, with CHANGELOG.md taken through
 * {@link mergeReleaseChangelog} whenever the branch changed it — what was added during the run stays under `## Unreleased` (git alone
 * conflicts on an entry added at the top, and files one added at the end under the version that did not ship it). Any other conflict
 * aborts the merge and throws, naming the files; `consequence` says what that leaves behind.
 */
function mergeBranchIntoRelease(remoteRef: string, version: string, consequence: string): void {
  let mergeError: string | null = null;
  try {
    git(...releaseBotIdentity, 'merge', '--no-commit', '--no-ff', remoteRef);
  } catch (error) {
    mergeError = error instanceof Error ? error.message : String(error);
  }
  const conflicted = splitPaths(git('diff', '--name-only', '--diff-filter=U'));
  if (mergeError !== null && conflicted.length === 0) {
    tryGit('merge', '--abort');
    throw new ReleaseError(`Merging ${remoteRef} into the release failed; ${consequence}\n${mergeError}`);
  }
  const base = readFileAt(git('merge-base', 'HEAD', 'MERGE_HEAD').trim(), changelogFileName);
  const release = readFileAt('HEAD', changelogFileName);
  const branch = readFileAt('MERGE_HEAD', changelogFileName);
  const changelog = base !== null && release !== null && branch !== null && branch !== base ? mergeReleaseChangelog({ base, release, branch, version }) : null;
  if (changelog !== null) {
    fs.writeFileSync(changelogFileName, changelog);
    git('add', changelogFileName);
  }
  const unresolved = conflicted.filter((filePath) => filePath !== changelogFileName || changelog === null);
  if (unresolved.length > 0) {
    git('merge', '--abort');
    throw new ReleaseError(`${remoteRef} moved during the run and merging it into the release conflicts in ${unresolved.join(', ')}; ${consequence}`);
  }
  git(...releaseBotIdentity, 'commit', '--quiet', '--no-edit');
}

/** Fetches the branch; merges it into the release commit when it has commits the release lacks. True when it did. */
function mergeMovedBranch(remote: string, branch: string, version: string, consequence: string): boolean {
  git('fetch', '--quiet', remote, branch);
  if (git('rev-list', '--count', `HEAD..${remote}/${branch}`).trim() === '0') return false;
  mergeBranchIntoRelease(`${remote}/${branch}`, version, consequence);
  return true;
}

/**
 * Pushes the release commit (or, after a merge, the merge) to the branch and the tag in ONE atomic push. A
 * refused push means the branch moved during the run: `<remote>/<branch>` is merged into the release commit —
 * the tag stays on the release commit, reachable from the branch through the merge — and the push is
 * retried, up to {@link pushAttemptLimit} times. A real merge conflict, or a refusal with nothing to merge (not a
 * race: permissions, protection), fails the run; `consequence` says what that leaves behind.
 */
function pushReleaseWithMergeRetry(remote: string, branch: string, tag: string, version: string, consequence: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      gitPush('--atomic', remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt >= pushAttemptLimit) {
        throw new ReleaseError(`Pushing ${tag} failed ${attempt} times because ${branch} kept moving; ${consequence}\n${reason}`);
      }
      if (!mergeMovedBranch(remote, branch, version, consequence)) {
        throw new ReleaseError(`The push of ${tag} was refused and ${remote}/${branch} has nothing new to merge; ${consequence}\n${reason}`);
      }
    }
  }
}

/** The files a release commit changes; the shrinkwrap only in a repository that has one. */
function listReleaseFileNames(): string[] {
  return [manifestFileName, changelogFileName, ...(fs.existsSync(shrinkwrapFileName) ? [shrinkwrapFileName] : [])];
}

/**
 * `--tarball`: the release's files as the packed tarball holds them — the very bytes npm publishes (npm packs them unchanged) — into the
 * checkout, so the release commit is made of what npm has.
 */
function copyReleaseFilesFromTarball(tarballPath: string): void {
  const fileNames = listReleaseFileNames();
  const unpackedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-release-files-'));
  try {
    try {
      runCommand('tar', ['-xzf', tarballPath, '-C', unpackedDir, ...fileNames.map((fileName) => `${tarballRootFolder}/${fileName}`)], npmPackTimeoutMs);
    } catch (error) {
      throw new ReleaseError(`${tarballPath} does not hold the release's ${fileNames.join(', ')}; nothing is committed.\n${error instanceof Error ? error.message : String(error)}`);
    }
    for (const fileName of fileNames) fs.copyFileSync(path.join(unpackedDir, tarballRootFolder, fileName), fileName);
  } finally {
    fs.rmSync(unpackedDir, { recursive: true, force: true });
  }
}

/**
 * The tag a re-run finds on the remote already (the push went through, a later step did not): fine when it is this run's release — on a
 * child of `base` —, refused when it is not. False when the remote has no such tag.
 */
function checkIsReleaseTagPushed(remote: string, tag: string, base: string | undefined): boolean {
  if (git('ls-remote', '--tags', remote, `refs/tags/${tag}`).trim() === '') return false;
  git('fetch', '--quiet', remote, 'tag', tag);
  const parent = tryGit('rev-parse', '--verify', '--quiet', `${tag}^{commit}^`)?.trim();
  if (base !== undefined && parent !== base) {
    throw new ReleaseError(`${remote} already holds ${tag}, on a commit that is not a release of the tested ${base.slice(0, shortShaLength)}; nothing is pushed.`);
  }
  return true;
}

/**
 * Commits the applied release (package.json, the shrinkwrap, CHANGELOG.md) as the bot and tags it, then:
 *  - by default (finishing a release by hand) pushes both, merging a branch that moved ({@link pushReleaseWithMergeRetry});
 *  - `--check` (the release workflow, BEFORE the publish): merges a moved branch locally and pushes nothing — a conflict fails the
 *    run before anything is published;
 *  - `--prepare` (the workflow, AFTER the publish): the same, and says in `$GITHUB_OUTPUT` (`isPushed`) whether the remote holds
 *    the tag already; the push itself is the next step's, plain git, the only one that gets the push token — no package's code runs
 *    while the token is in a process's environment.
 * `--tarball` takes the files out of the published tarball; `--base` refuses anything but the tested commit plus its version bump.
 */
function runCommitRelease(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      remote: { type: 'string' },
      branch: { type: 'string' },
      tarball: { type: 'string' },
      base: { type: 'string' },
      check: { type: 'boolean' },
      prepare: { type: 'boolean' },
    },
  });
  const version = requireVersionArgument(positionals);
  if (values.check && values.prepare) throw new ReleaseError('commit-release takes --check (before the publish) or --prepare (after it), not both.');
  const tag = `${releaseTagPrefix}${version}`;
  const remote = values.remote ?? defaultRemote;
  const branch = values.branch ?? defaultBranch;
  const afterPublish = `npm has ${version} already and the repository not yet (no ${tag}, ${branch} not bumped): re-run this run's failed jobs once the cause is fixed, or finish the release by hand (DEVELOPMENT.md § Releases, "npm has a version the repository does not").`;
  if (values.tarball) copyReleaseFilesFromTarball(path.resolve(values.tarball));
  const appliedVersion = readPackageVersion();
  if (appliedVersion !== version) throw new ReleaseError(`${manifestFileName} carries version ${appliedVersion}, not ${version}: nothing is committed.`);
  if (values.base) assertReleaseDelta(values.base, undefined, 'nothing is committed');
  if (checkIsReleaseTagPushed(remote, tag, values.base)) {
    if (!values.check) writeGithubOutput('tag', tag);
    if (values.prepare) writeGithubOutput('isPushed', 'true');
    process.stdout.write(`${remote} already holds ${tag} (a re-run after the push went through); nothing to push.\n`);
    return 0;
  }
  git('add', ...listReleaseFileNames());
  git(...releaseBotIdentity, 'commit', '--quiet', '-m', `chore(release): ${version}`);
  git(...releaseBotIdentity, 'tag', '-a', tag, '-m', tag);
  if (values.check || values.prepare) {
    const isMerged = mergeMovedBranch(remote, branch, version, values.check ? 'nothing is published or pushed.' : afterPublish);
    if (values.prepare) writeGithubOutput('isPushed', 'false');
    const nextStep = values.check ? 'Nothing pushed (--check).' : `Nothing pushed yet (--prepare): push HEAD to ${branch} and ${tag}.`;
    process.stdout.write(isMerged ? `${branch} moved during the run; the release merges into it. ${nextStep}\n` : `${branch} has not moved: the push will be a fast-forward. ${nextStep}\n`);
    return 0;
  }
  pushReleaseWithMergeRetry(remote, branch, tag, version, afterPublish);
  writeGithubOutput('tag', tag);
  process.stdout.write(`Pushed ${tag}.\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
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
    case 'check-install':
      return runCheckInstall(args);
    case 'check-publish':
      return runCheckPublish();
    case 'commit-release':
      return runCommitRelease(args);
    case 'test-gate':
      return runTestGate(args);
    case 'verify-delta':
      return runVerifyDelta(args);
    case 'check-registry':
      return runCheckRegistry(args);
    default:
      throw new ReleaseError(`Unknown subcommand "${subcommand}". Use plan | apply | changelog | notes | check-pack | check-install | check-publish | test-gate | verify-delta | check-registry | commit-release.`);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    if (!(error instanceof ReleaseError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(formatErrorAnnotation('Release failed', error.message));
    process.exitCode = 1;
  },
);
