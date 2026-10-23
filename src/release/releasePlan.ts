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
  'CHANGELOG.md',
  'README.md',
  'LICENSE',
];
const forbiddenPackPathPrefixes = ['src/', 'dist/release/'];
const forbiddenPackPathFragment = '__tests__';

const shippedSourceRoot = 'src/';
const shippedSourceExtension = '.ts';
const unshippedSourcePrefixes = ['src/__tests__/', 'src/release/'];
const shippedExtraPaths = ['stt/gigaam_sidecar.py'];
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
  const range = findSectionRange(lines, (line) => line.trimEnd() === unreleasedHeading);
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
