import { getChangelogEntries } from '../changelogEntries';
import { whatsNewItemLimit } from './constants';
import { compareVersionTexts } from './semver';

/** One version's headlines in a what's-new summary; `version` is `null` for a checkout, which has no versions to name. */
export interface WhatsNewGroup {
  version: string | null;
  headlines: string[];
}

/**
 * What an update changed, ready to be worded: the entries an operator must act on (`### Upgrading`) first, then the
 * headline of every other entry grouped by version, capped — `moreCount` entries did not fit.
 */
export interface WhatsNewSummary {
  todo: string[];
  groups: WhatsNewGroup[];
  moreCount: number;
}

const upgradingSubsection = 'upgrading';
const versionHeadingPattern = /^## (\d+\.\d+\.\d+)(?:\s|$)/;
const boldLeadPattern = /^\*\*(?=\S)([\s\S]*?\S)\*\*/;
const linkPattern = /\[([^\]]*)\]\([^)]*\)/g;
const fallbackHeadlineMaxLength = 200;
const sentenceEndPattern = /[.!?](?:\s|$)/;
const diffAddedPrefix = '+';
const diffContextPrefix = ' ';
const diffFileHeaderPattern = /^(?:diff --git|index |--- |\+\+\+ |@@ |\\)/;

function reduceMarkdown(text: string): string {
  return text.replace(linkPattern, '$1').replaceAll('`', '').replace(/\s+/g, ' ').trim();
}

/**
 * @description The headline of a CHANGELOG entry: its bold first sentence, links reduced to their text, code marks
 * dropped. An entry without a bold lead (an old section) falls back to its first sentence, cut at a sentence end or at
 * {@link fallbackHeadlineMaxLength} characters.
 */
export function getEntryHeadline(entryText: string): string {
  const bold = boldLeadPattern.exec(entryText);
  if (bold) return reduceMarkdown(bold[1]);
  const plain = reduceMarkdown(entryText);
  const sentenceEnd = sentenceEndPattern.exec(plain);
  const sentence = sentenceEnd ? plain.slice(0, sentenceEnd.index + 1) : plain;
  return sentence.length > fallbackHeadlineMaxLength ? `${sentence.slice(0, fallbackHeadlineMaxLength - 1)}…` : sentence;
}

interface HeadlineEntry {
  version: string | null;
  headline: string;
  isUpgrading: boolean;
}

/** Caps the entries at `limit` in display order (to-do items first, then versions in the order given). */
function createSummary(entries: HeadlineEntry[], limit: number): WhatsNewSummary | null {
  if (entries.length === 0) return null;
  const todoEntries = entries.filter((entry) => entry.isUpgrading);
  const otherEntries = entries.filter((entry) => !entry.isUpgrading);
  const kept = [...todoEntries, ...otherEntries].slice(0, limit);
  const groups: WhatsNewGroup[] = [];
  for (const entry of kept.filter((candidate) => !candidate.isUpgrading)) {
    const group = groups.find((candidate) => candidate.version === entry.version);
    if (group) group.headlines.push(entry.headline);
    else groups.push({ version: entry.version, headlines: [entry.headline] });
  }
  return {
    todo: kept.filter((entry) => entry.isUpgrading).map((entry) => entry.headline),
    groups,
    moreCount: entries.length - kept.length,
  };
}

/** The `## X.Y.Z` sections of a CHANGELOG, each with its body text. */
function getVersionSections(changelogText: string): { version: string; body: string }[] {
  const sections: { version: string; lines: string[] }[] = [];
  let current: { version: string; lines: string[] } | null = null;
  for (const line of changelogText.split('\n')) {
    const heading = versionHeadingPattern.exec(line);
    if (heading) {
      current = { version: heading[1], lines: [] };
      sections.push(current);
    } else if (line.startsWith('## ')) {
      current = null;
    } else {
      current?.lines.push(line);
    }
  }
  return sections.map((section) => ({ version: section.version, body: section.lines.join('\n') }));
}

/**
 * @description The summary of the released versions after `fromVersion` up to and including `toVersion` — every version
 * the update skipped over — read from the installed `CHANGELOG.md`, oldest version first. `null` when the range holds no
 * entry (an old package without a CHANGELOG, or without sections for these versions).
 */
export function getNpmReleaseNotes(
  changelogText: string,
  fromVersion: string,
  toVersion: string,
  limit: number = whatsNewItemLimit,
): WhatsNewSummary | null {
  const inRange = getVersionSections(changelogText)
    .filter(({ version }) => (compareVersionTexts(version, fromVersion) ?? -1) > 0 && (compareVersionTexts(version, toVersion) ?? 1) <= 0)
    .sort((left, right) => compareVersionTexts(left.version, right.version) ?? 0);
  const entries: HeadlineEntry[] = inRange.flatMap(({ version, body }) =>
    getChangelogEntries(body).map((entry) => ({
      version,
      headline: getEntryHeadline(entry.text),
      isUpgrading: entry.subsection?.toLowerCase() === upgradingSubsection,
    })),
  );
  return createSummary(entries, limit);
}

/**
 * @description The summary of what a checkout's update ADDED to `CHANGELOG.md`, read from `git diff` of the file with the
 * whole file as context (so an entry added under an existing `### Upgrading` is still known as one). An entry counts when
 * its first line is an added line; a reworded entry counts as new. `null` when nothing was added.
 */
export function getCheckoutReleaseNotes(diffText: string, limit: number = whatsNewItemLimit): WhatsNewSummary | null {
  const fileLines: { text: string; isAdded: boolean }[] = [];
  for (const line of diffText.split('\n')) {
    if (diffFileHeaderPattern.test(line)) continue;
    if (line.startsWith(diffAddedPrefix)) fileLines.push({ text: line.slice(1), isAdded: true });
    else if (line.startsWith(diffContextPrefix)) fileLines.push({ text: line.slice(1), isAdded: false });
  }
  const entries: HeadlineEntry[] = getChangelogEntries(fileLines.map((line) => line.text).join('\n'))
    .filter((entry) => fileLines[entry.leadLineIndex]?.isAdded)
    .map((entry) => ({
      version: null,
      headline: getEntryHeadline(entry.text),
      isUpgrading: entry.subsection?.toLowerCase() === upgradingSubsection,
    }));
  return createSummary(entries, limit);
}
