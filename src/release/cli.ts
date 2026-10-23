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
 *   check-publish                                               `npm publish --dry-run`: refuses what npm would drop from package.json
 *   commit-release <version> [--remote origin] [--branch main]  commit, tag and push the applied release
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
  getInvalidBinPaths,
  getPackViolations,
  getPublishDryRunProblems,
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

function readPackageManifest(): PackageManifest & { version: string } {
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
    runInstallSmokeTest(version);
    process.stdout.write(`Installed from the tarball: charness --version prints ${version}.\n`);
  }
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
 * Pushes the release commit (or, after a merge, the merge) to the branch and the tag in ONE atomic push. A
 * refused push means the branch moved during the run: `<remote>/<branch>` is merged into the release commit —
 * the tag stays on the tested release commit, reachable from the branch through the merge — and the push is
 * retried, up to {@link pushAttemptLimit} times. A merge conflict, or a refusal with nothing to merge (not a
 * race: permissions, protection), fails the run; nothing is published then.
 */
function pushReleaseWithMergeRetry(remote: string, branch: string, tag: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      gitPush('--atomic', remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt >= pushAttemptLimit) {
        throw new ReleaseError(`Pushing ${tag} failed ${attempt} times because ${branch} kept moving; nothing was published.\n${reason}`);
      }
      git('fetch', '--quiet', remote, branch);
      if (git('rev-list', '--count', `HEAD..${remote}/${branch}`).trim() === '0') {
        throw new ReleaseError(`The push of ${tag} was refused and ${remote}/${branch} has nothing new to merge; nothing was published.\n${reason}`);
      }
      try {
        git(...releaseBotIdentity, 'merge', '--no-edit', `${remote}/${branch}`);
      } catch {
        git('merge', '--abort');
        throw new ReleaseError(
          `${branch} moved during the run and merging it into the release ${tag} conflicts; nothing was published.\n` +
            'Resolve it by hand (the next daily run releases the new commits), or re-run the workflow.',
        );
      }
    }
  }
}

function runCommitRelease(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { remote: { type: 'string' }, branch: { type: 'string' } },
  });
  const version = requireVersionArgument(positionals);
  const tag = `${releaseTagPrefix}${version}`;
  git('add', manifestFileName, changelogFileName);
  git(...releaseBotIdentity, 'commit', '--quiet', '-m', `chore(release): ${version}`);
  git(...releaseBotIdentity, 'tag', '-a', tag, '-m', tag);
  pushReleaseWithMergeRetry(values.remote ?? defaultRemote, values.branch ?? defaultBranch, tag);
  writeGithubOutput('tag', tag);
  process.stdout.write(`Pushed ${tag}.\n`);
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
    case 'check-publish':
      return runCheckPublish();
    case 'commit-release':
      return runCommitRelease(args);
    default:
      throw new ReleaseError(`Unknown subcommand "${subcommand}". Use plan | apply | changelog | notes | check-pack | check-publish | commit-release.`);
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
