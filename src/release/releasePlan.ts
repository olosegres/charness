/**
 * Pure decisions of the daily npm release (`.github/workflows/publish.yml`): whether to release, which
 * version, what the CHANGELOG becomes, whether the packed tarball is sound. No git, no filesystem — the thin
 * wrapper `cli.ts` feeds it and acts on the answer. This directory is never built into `dist/` and never
 * shipped: the runtime must not import from it.
 */
import { isDeepStrictEqual } from 'node:util';
import { checkHasBoldLead, getChangelogEntries } from '../changelogEntries';

export const releaseTimeZone = 'Asia/Tbilisi';
export const unreleasedHeading = '## Unreleased';
export const releaseTagPrefix = 'v';

/** Files a packed tarball must hold, whatever the version. */
export const requiredPackFiles = [
  'package.json',
  'dist/cli.js',
  'stt/gigaam_sidecar.py',
  'remoteRun/runner-package-lock.json',
  // The lock an `npm install -g` installs the package's tree by (`hubShrinkwrap.ts`); npm 12 would pack none — the release refuses that.
  'npm-shrinkwrap.json',
  'remoteRun/ensureNode.sh',
  'agent-plugin/.claude-plugin/plugin.json',
  'agent-plugin/skills/charness-orchestration/SKILL.md',
  'CHANGELOG.md',
  'README.md',
  'LICENSE',
];
const forbiddenPackPathPrefixes = ['src/', 'dist/release/'];
const forbiddenPackPathFragment = '__tests__';
const relativePathPrefix = './';
/** What `npm publish` prints (only as a warning, exit 0) when it drops or rewrites a `package.json` field of the manifest it sends to the registry. */
const droppedManifestMarkers = ['was invalid and removed', 'auto-corrected some errors'];

const shippedSourceRoot = 'src/';
const shippedSourceExtension = '.ts';
const unshippedSourcePrefixes = ['src/__tests__/', 'src/release/'];
/** Files that ship besides the compiled source: the speech sidecar, and the shrinkwrap — a change to it changes what an install gets. */
const shippedExtraPaths = ['stt/gigaam_sidecar.py', 'npm-shrinkwrap.json'];
/** Folders shipped as they are: the skills the bot gives its agents. */
const shippedExtraPrefixes = ['agent-plugin/'];
const shippedManifestFields = ['dependencies', 'bin', 'engines', 'files', 'main'] as const;

const featCommitType = 'feat';
const fixCommitType = 'fix';
const breakingMarker = '!';
const releaseCommitPattern = /^chore\(release\)/;
const conventionalSubjectPattern = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<bang>!)?:\s*(?<description>.+)$/i;
const breakingFooterPattern = /^BREAKING[ -]CHANGE:/m;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const shortHashLength = 7;
const noChangesEntry = '**No user-visible changes in this release.**';

export type ReleaseBumpLevel = 'patch' | 'minor' | 'major';
export type ReleaseBumpInput = 'auto' | ReleaseBumpLevel;

/** The subset of `package.json` that decides what npm users receive. */
export type PackageManifest = {
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  main?: string;
};

/** What a diff touched: the changed paths, and whether `package.json` changed in a field that ships. */
export type ReleaseChangeSet = {
  paths: string[];
  changesShippedManifest: boolean;
};

export type ReleaseCommit = ReleaseChangeSet & {
  hash: string;
  subject: string;
  body: string;
};

export type ReleaseRequest = {
  bump: ReleaseBumpInput;
  force: boolean;
};

export type ReleasePlanInput = {
  lastTag: string | null;
  commitsSinceTag: ReleaseCommit[];
  /** The net diff from the last tag to HEAD — a change and its revert cancel out here. */
  netDiff: ReleaseChangeSet;
  isHeadTagged: boolean;
  input: ReleaseRequest;
};

export type ReleasePlan =
  | { kind: 'skip'; reason: string }
  | { kind: 'release'; version: string; bump: ReleaseBumpLevel }
  | { kind: 'fail'; message: string };

export type ReleaseBumpDecision =
  | { kind: 'bump'; level: 'patch' | 'minor' }
  | { kind: 'breaking'; commits: ReleaseCommit[] };

/** `feat` / `fix` subjects, prefix stripped, for a section whose hand-written `## Unreleased` is empty. */
export type ChangelogFallback = {
  added: string[];
  fixed: string[];
};

/** A violation of a release rule the owner fixes by editing something (the CHANGELOG, a commit message). */
export class ReleaseError extends Error {}

/** @description Whether a path is source that ships in the package; `package.json` is decided by its content. */
export function checkIsShippedPath(filePath: string): boolean {
  if (shippedExtraPaths.includes(filePath)) return true;
  if (shippedExtraPrefixes.some((prefix) => filePath.startsWith(prefix))) return true;
  if (!filePath.startsWith(shippedSourceRoot) || !filePath.endsWith(shippedSourceExtension)) return false;
  return !unshippedSourcePrefixes.some((prefix) => filePath.startsWith(prefix));
}

/** @description Whether `package.json` differs in a field that changes what an installer gets. */
export function checkIsShippedManifestChange(oldManifest: PackageManifest | null, newManifest: PackageManifest | null): boolean {
  return shippedManifestFields.some((field) => !isDeepStrictEqual(oldManifest?.[field], newManifest?.[field]));
}

/** @description Whether the change touches anything that ships. */
export function checkHasShippedChange(change: ReleaseChangeSet): boolean {
  return change.changesShippedManifest || change.paths.some(checkIsShippedPath);
}

function checkIsReleaseCommit(commit: ReleaseCommit): boolean {
  return releaseCommitPattern.test(commit.subject);
}

function checkIsBreakingCommit(commit: ReleaseCommit): boolean {
  return conventionalSubjectPattern.exec(commit.subject)?.groups?.bang === breakingMarker || breakingFooterPattern.test(commit.body);
}

function getConventionalType(commit: ReleaseCommit): string | null {
  return conventionalSubjectPattern.exec(commit.subject)?.groups?.type.toLowerCase() ?? null;
}

function formatCommitLine(commit: ReleaseCommit): string {
  return `${commit.hash.slice(0, shortHashLength)} ${commit.subject}`;
}

/**
 * @description The level the commits since the last release call for: a breaking commit (any commit, any
 * type) blocks the automatic bump, a `feat` that changes shipped code is a minor, anything else a patch.
 * `chore(release)` commits never count.
 */
export function getReleaseBump(commits: ReleaseCommit[]): ReleaseBumpDecision {
  const counted = commits.filter((commit) => !checkIsReleaseCommit(commit));
  const breaking = counted.filter(checkIsBreakingCommit);
  if (breaking.length > 0) return { kind: 'breaking', commits: breaking };
  const hasShippedFeature = counted.some((commit) => getConventionalType(commit) === featCommitType && checkHasShippedChange(commit));
  return { kind: 'bump', level: hasShippedFeature ? 'minor' : 'patch' };
}

/** @description `3.2.0` + minor → `3.3.0`; null when the version is not plain `X.Y.Z`. */
export function getNextVersion(version: string, level: ReleaseBumpLevel): string | null {
  const match = versionPattern.exec(version);
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * @description Decides one run: skip (green, nothing published), release (version + level) or fail (red,
 * the message names what to fix). `force` overrides the skip rules, never the breaking-change guard of an
 * automatic bump; an explicit `patch` / `minor` / `major` is the owner's own choice and releases as asked.
 */
export function createReleasePlan({ lastTag, commitsSinceTag, netDiff, isHeadTagged, input }: ReleasePlanInput): ReleasePlan {
  if (lastTag === null) {
    return { kind: 'fail', message: `No release tag (${releaseTagPrefix}X.Y.Z) in the history — fetch the tags, or tag the first release by hand.` };
  }
  const releasableCommits = commitsSinceTag.filter((commit) => !checkIsReleaseCommit(commit));

  if (!input.force) {
    if (isHeadTagged) return { kind: 'skip', reason: `HEAD already carries a release tag (${lastTag}).` };
    if (releasableCommits.length === 0) return { kind: 'skip', reason: `No commits since ${lastTag}.` };
    if (!checkHasShippedChange(netDiff)) {
      return { kind: 'skip', reason: `Nothing shipped changed since ${lastTag} (the net diff touches no shipped path).` };
    }
  }

  let level: ReleaseBumpLevel;
  if (input.bump === 'auto') {
    const decision = getReleaseBump(commitsSinceTag);
    if (decision.kind === 'breaking') {
      const lines = decision.commits.map((commit) => `  ${formatCommitLine(commit)}`).join('\n');
      return {
        kind: 'fail',
        message:
          `Breaking changes since ${lastTag} — an automatic release never bumps the major:\n${lines}\n` +
          'Release them by hand: dispatch the workflow with bump=major (or bump=minor / patch if the marker is a mistake).',
      };
    }
    level = decision.level;
  } else {
    level = input.bump;
  }

  const version = getNextVersion(lastTag.slice(releaseTagPrefix.length), level);
  if (version === null) return { kind: 'fail', message: `The last release tag ${lastTag} is not ${releaseTagPrefix}X.Y.Z — cannot compute the next version.` };
  return { kind: 'release', version, bump: level };
}

/** @description The release date as `YYYY-MM-DD` on the Tbilisi calendar — never the runner's UTC date. */
export function getReleaseDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: releaseTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** @description `feat` / `fix` subjects of the commits, without their `type(scope):` prefix, as sentences. */
export function getChangelogFallback(commits: ReleaseCommit[]): ChangelogFallback {
  const fallback: ChangelogFallback = { added: [], fixed: [] };
  for (const commit of commits) {
    if (checkIsReleaseCommit(commit)) continue;
    const match = conventionalSubjectPattern.exec(commit.subject);
    const type = match?.groups?.type.toLowerCase();
    const description = match?.groups?.description;
    if (!description || (type !== featCommitType && type !== fixCommitType)) continue;
    const sentence = description.replaceAll('**', '').trim();
    const entry = `**${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${/[.!?]$/.test(sentence) ? '' : '.'}**`;
    (type === featCommitType ? fallback.added : fallback.fixed).push(entry);
  }
  return fallback;
}

function createFallbackSection(fallback: ChangelogFallback): string[] {
  const groups: [string, string[]][] = [
    ['### Added', fallback.added],
    ['### Fixed', fallback.fixed],
  ];
  const lines: string[] = [];
  for (const [heading, entries] of groups) {
    if (entries.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(heading, ...entries.map((entry) => `- ${entry}`));
  }
  return lines.length > 0 ? lines : [noChangesEntry];
}

/**
 * @description Entries of a section body that do not start with a bold first sentence — each as the line
 * it begins on, for the failure message.
 */
export function getChangelogFormatViolations(sectionText: string): string[] {
  return getChangelogEntries(sectionText)
    .filter((entry) => !checkHasBoldLead(entry.text))
    .map((entry) => entry.leadLine.trim());
}

type SectionRange = { start: number; end: number };

/** The lines of `## <heading>` up to (excluding) the next `## ` heading; `start` is the heading line. */
function findSectionRange(lines: string[], checkIsHeading: (line: string) => boolean): SectionRange | null {
  const start = lines.findIndex(checkIsHeading);
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return { start, end: next === -1 ? lines.length : next };
}

function trimBlankLines(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first].trim() === '') first += 1;
  while (last > first && lines[last - 1].trim() === '') last -= 1;
  return lines.slice(first, last);
}

function checkIsUnreleasedHeading(line: string): boolean {
  return line.trimEnd() === unreleasedHeading;
}

/** @description The body of `## Unreleased`, blank edges trimmed; null when the heading is missing. */
export function getUnreleasedSection(changelogText: string): string | null {
  const lines = changelogText.split('\n');
  const range = findSectionRange(lines, checkIsUnreleasedHeading);
  return range ? trimBlankLines(lines.slice(range.start + 1, range.end)).join('\n') : null;
}

function checkIsVersionHeading(line: string, version: string): boolean {
  return line === `## ${version}` || line.startsWith(`## ${version} `);
}

/**
 * @description Turns `## Unreleased` into `## <version> — <date>` with a fresh empty `## Unreleased` above
 * it; `notes` is that section's body (the GitHub Release text). An empty `## Unreleased` is filled from
 * the `feat` / `fix` subjects. Throws {@link ReleaseError} on a missing heading, a version that already has
 * a section, or an entry without a bold first sentence (the message quotes each such line).
 */
export function createChangelogRelease(
  changelogText: string,
  version: string,
  date: string,
  fallback: ChangelogFallback,
): { changelog: string; notes: string } {
  const lines = changelogText.split('\n');
  const range = findSectionRange(lines, checkIsUnreleasedHeading);
  if (!range) throw new ReleaseError(`CHANGELOG.md has no "${unreleasedHeading}" heading to release.`);
  if (lines.some((line) => checkIsVersionHeading(line, version))) {
    throw new ReleaseError(`CHANGELOG.md already has a section for ${version}.`);
  }

  const handWritten = trimBlankLines(lines.slice(range.start + 1, range.end));
  const section = handWritten.length > 0 ? handWritten : createFallbackSection(fallback);
  const violations = getChangelogFormatViolations(section.join('\n'));
  if (violations.length > 0) {
    const quoted = violations.map((line) => `  ${line}`).join('\n');
    throw new ReleaseError(
      `Every CHANGELOG entry of the release must start with a bold first sentence (**…**); these do not:\n${quoted}`,
    );
  }

  const rebuilt = [
    ...lines.slice(0, range.start),
    unreleasedHeading,
    '',
    `## ${version} — ${date}`,
    '',
    ...section,
    '',
    ...lines.slice(range.end),
  ];
  return { changelog: `${rebuilt.join('\n').replace(/\n+$/, '')}\n`, notes: section.join('\n') };
}

/** CHANGELOG.md on the three sides of a merge of the branch into the release commit, as `git merge` sees them. */
export interface ReleaseChangelogMerge {
  /** At the merge base: the tested commit, or the branch as an earlier merge of the same release took it in. */
  base: string;
  /** The release side: the base with the end of `## Unreleased` (the released entries) moved into `## <version>`. */
  release: string;
  /** The branch that moved during the run. */
  branch: string;
  version: string;
}

interface ChangelogParts {
  before: string[];
  unreleased: string[];
  after: string[];
}

function splitChangelog(text: string): ChangelogParts | null {
  const lines = text.split('\n');
  const range = findSectionRange(lines, checkIsUnreleasedHeading);
  if (!range) return null;
  return { before: lines.slice(0, range.start), unreleased: trimBlankLines(lines.slice(range.start + 1, range.end)), after: lines.slice(range.end) };
}

function checkAreLinesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/** Where `block` (non-empty) occurs in `lines` as a contiguous run, when it occurs exactly once; null otherwise. */
function findOnlyBlock(lines: string[], block: string[]): number | null {
  const starts = lines
    .map((_, index) => index)
    .filter((index) => index + block.length <= lines.length && checkAreLinesEqual(lines.slice(index, index + block.length), block));
  return starts.length === 1 ? starts[0] : null;
}

function joinEntryBlocks(above: string[], below: string[]): string[] {
  const upper = trimBlankLines(above);
  const lower = trimBlankLines(below);
  return upper.length > 0 && lower.length > 0 ? [...upper, '', ...lower] : [...upper, ...lower];
}

/**
 * @description The CHANGELOG of a merge of the branch into the release commit, where the branch changed the file during the run. The
 * release took the released entries from the END of `## Unreleased` into `## <version>` and changed nothing else; when the branch kept
 * those entries word for word (it added entries above or below them, and may have changed older sections), the result is the branch's
 * file with the release's section where the release put it — what was added during the run stays under `## Unreleased`, for the next
 * release. `git merge` alone conflicts on an entry added at the top (the spot the release rewrites) and files one added at the end under
 * the version that did not ship it. Null when the change is anything else — the branch edited or removed a released entry, or the
 * release side changed more —: git's own merge decides then.
 */
export function mergeReleaseChangelog({ base, release, branch, version }: ReleaseChangelogMerge): string | null {
  const baseParts = splitChangelog(base);
  const releaseParts = splitChangelog(release);
  const branchParts = splitChangelog(branch);
  if (!baseParts || !releaseParts || !branchParts) return null;
  const releaseSection = findSectionRange(releaseParts.after, (line) => checkIsVersionHeading(line, version));
  if (releaseSection?.start !== 0) return null;
  if ([base, branch].some((text) => text.split('\n').some((line) => checkIsVersionHeading(line, version)))) return null;
  // The release changed nothing outside `## Unreleased` and its own new section, and kept the top of `## Unreleased`.
  if (!checkAreLinesEqual(releaseParts.before, baseParts.before)) return null;
  if (!checkAreLinesEqual(releaseParts.after.slice(releaseSection.end), baseParts.after)) return null;
  if (!checkAreLinesEqual(baseParts.unreleased.slice(0, releaseParts.unreleased.length), releaseParts.unreleased)) return null;
  const released = trimBlankLines(baseParts.unreleased.slice(releaseParts.unreleased.length));
  let unreleased = branchParts.unreleased;
  if (released.length > 0) {
    const releasedStart = findOnlyBlock(branchParts.unreleased, released);
    if (releasedStart === null) return null;
    unreleased = joinEntryBlocks(branchParts.unreleased.slice(0, releasedStart), branchParts.unreleased.slice(releasedStart + released.length));
  }
  return [
    ...branchParts.before,
    unreleasedHeading,
    '',
    ...(unreleased.length > 0 ? [...unreleased, ''] : []),
    ...releaseParts.after.slice(0, releaseSection.end),
    ...branchParts.after,
  ].join('\n');
}

/** @description The body of the `## <version>` section — the GitHub Release text; null when it is missing or empty. */
export function getReleaseNotes(changelogText: string, version: string): string | null {
  const lines = changelogText.split('\n');
  const range = findSectionRange(lines, (line) => checkIsVersionHeading(line, version));
  if (!range) return null;
  const body = trimBlankLines(lines.slice(range.start + 1, range.end));
  return body.length > 0 ? body.join('\n') : null;
}

/** The part of `npm pack --dry-run --json` the check reads. */
export type PackListing = {
  version: string;
  files: { path: string }[];
};

/** @description What is wrong with a packed tarball: missing required files, files that must not ship, a wrong version. */
export function getPackViolations(listing: PackListing, expectedVersion: string): string[] {
  const paths = listing.files.map((file) => file.path);
  const violations: string[] = [];
  for (const required of requiredPackFiles) {
    if (!paths.includes(required)) violations.push(`missing from the package: ${required}`);
  }
  for (const filePath of paths) {
    const isForbidden =
      forbiddenPackPathPrefixes.some((prefix) => filePath.startsWith(prefix)) || filePath.includes(forbiddenPackPathFragment);
    if (isForbidden) violations.push(`must not ship: ${filePath}`);
  }
  if (listing.version !== expectedVersion) {
    violations.push(`the package version is ${listing.version}, expected ${expectedVersion}`);
  }
  return violations;
}

/**
 * @description The `bin` targets written with a leading "./": npm >= 11.10 drops such an entry from the manifest it publishes
 * (a warning, exit 0), so the registry's version has no command — 3.3.0 shipped that way. Named `bin.<command>: <path>`.
 */
export function getInvalidBinPaths(bin: PackageManifest['bin']): string[] {
  const targets: [string, string][] = typeof bin === 'string' ? [['bin', bin]] : Object.entries(bin ?? {}).map(([command, target]) => [`bin.${command}`, target]);
  return targets.filter(([, target]) => target.startsWith(relativePathPrefix)).map(([label, target]) => `${label}: ${target}`);
}

/**
 * @description The lines of an `npm publish --dry-run` output that say npm dropped or rewrote part of `package.json` for the
 * registry — what the checked-in `package.json` must never cause, though npm treats it as a warning only.
 */
export function getPublishDryRunProblems(npmOutput: string): string[] {
  return npmOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => droppedManifestMarkers.some((marker) => line.includes(marker)));
}
