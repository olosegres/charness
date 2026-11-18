/**
 * @description The pure plan of the status mark at the END of a topic's name (`connectors/telegram/topicIndicator.ts` applies it, `/topic_status`
 * switches it): which status a topic shows, the name that carries it, the owner's own name back out of a name that already carries a mark,
 * and WHEN a rename is allowed — so the topic list never flickers. No Telegram, no clock of its own: every instant comes in.
 *
 * The name is `<base> <status> <counts>`: the base is the owner's own words, the status is ONE mark, the counts are off by default.
 * The topic's ICON is never part of it.
 */

import { cutTextSurrogateSafe } from './surrogateSafeCut';

/** Telegram accepts a topic name of 0–128 characters (`createForumTopic`, `editForumTopic`), counted the way `String.length` does. */
export const topicNameMaxLength = 128;

/** The statuses a name can show, highest priority first: the name shows the first one that holds. */
export const topicStatuses = ['question', 'stuck', 'working', 'finished', 'asleep'] as const;

/** @name TopicStatus @description One status mark: a question waits, the agent is stuck, it works, it finished, it sleeps. */
export type TopicStatus = (typeof topicStatuses)[number];

/** The mark each status writes; `stuck` and `agents` carry the emoji variation selector the way the owner types them. */
export const topicStatusMarks: Record<TopicStatus, string> = {
  question: '❓',
  stuck: '❗️',
  working: '⏳',
  finished: '✅',
  asleep: '💤',
};

/** The two counts after the status: agents at work and tasks queued. */
export const topicIndicatorCountKinds = ['agents', 'queued'] as const;

/** @name TopicIndicatorCountKind @description One of the counts a name can carry after its status. */
export type TopicIndicatorCountKind = (typeof topicIndicatorCountKinds)[number];

/** The mark in front of each count's number. */
export const topicIndicatorCountMarks: Record<TopicIndicatorCountKind, string> = {
  agents: '⚙️',
  queued: '📋',
};

/** Every switch `/topic_status` has: one per status and one per count, in the order the picker lists them. */
export const topicIndicatorSwitches = [...topicStatuses, ...topicIndicatorCountKinds] as const;

/** @name TopicIndicatorSwitch @description One indicator the owner can turn on or off. */
export type TopicIndicatorSwitch = (typeof topicIndicatorSwitches)[number];

/** @description Whether `value` names a switch (the data of a tap, a hand-edited file). */
export function checkIsTopicIndicatorSwitch(value: string | undefined): value is TopicIndicatorSwitch {
  return topicIndicatorSwitches.some((candidate) => candidate === value);
}

/** @name TopicStatusPrefs @description Which indicators a topic shows: on or off, one per switch. */
export type TopicStatusPrefs = Record<TopicIndicatorSwitch, boolean>;

/** What an instance does until the owner chooses: the five status marks on, both counts off (the owner: «a masquerade» otherwise). */
export const defaultTopicStatusPrefs: TopicStatusPrefs = {
  question: true,
  stuck: true,
  working: true,
  finished: true,
  asleep: true,
  agents: false,
  queued: false,
};

/**
 * @description The switches in force for a topic: its own set when it has one (a tap copies General's set into the topic first, so it
 * is whole), else the instance's (`settings.json`, which may name only the switches the owner changed) over the defaults.
 */
export function resolveTopicStatusPrefs(instancePrefs: Partial<TopicStatusPrefs> | null, topicPrefs: TopicStatusPrefs | undefined): TopicStatusPrefs {
  return topicPrefs ?? { ...defaultTopicStatusPrefs, ...instancePrefs };
}

/** @description Every switch turned to `isOn` — the «All off» button, and a whole set made of a partial one. */
export function createTopicStatusPrefsWith(isOn: boolean): TopicStatusPrefs {
  return { question: isOn, stuck: isOn, working: isOn, finished: isOn, asleep: isOn, agents: isOn, queued: isOn };
}

// ── which status holds ──

/** What the bot knows of a topic's agent, reduced to facts: the status is the first of the list that holds. */
export interface TopicStatusInputs {
  /** A question of the agent is open: waiting for the owner, or set aside (any number). */
  hasOpenQuestion: boolean;
  /** The agent cannot go on by itself: logged out, a usage-limit wait with no account to switch to, a crash or a lost conversation until the next turn. */
  isStuck: boolean;
  /** Its turn runs (background tasks and a compaction included), or a watched worker of this topic runs. */
  isWorking: boolean;
  /** The turn ended and the process is still up: the answer is there to read. */
  isFinished: boolean;
  /** The bot stopped the idle process; the conversation is kept and resumes on the next message. */
  isAsleep: boolean;
}

const statusInputField: Record<TopicStatus, keyof TopicStatusInputs> = {
  question: 'hasOpenQuestion',
  stuck: 'isStuck',
  working: 'isWorking',
  finished: 'isFinished',
  asleep: 'isAsleep',
};

/**
 * @description The status a topic shows: the first of {@link topicStatuses} that holds AND is switched on, `null` when none does (no mark).
 * A status the owner turned off is skipped, as if it did not hold.
 */
export function resolveTopicStatus(inputs: TopicStatusInputs, prefs: TopicStatusPrefs): TopicStatus | null {
  return topicStatuses.find((status) => prefs[status] && inputs[statusInputField[status]]) ?? null;
}

// ── the name ──

/** How many of each count the topic has: the agents at work and the queued tasks. */
export type TopicIndicatorCounts = Record<TopicIndicatorCountKind, number>;

/** The ellipsis a cut base ends in. */
const baseCutEllipsis = '…';

/** The separator between the base and each part after it. */
const partSeparator = ' ';

/** @description The base cut to at most `maxLength` UTF-16 units, ending in «…», never inside a surrogate pair. */
function cutBase(base: string, maxLength: number): string {
  if (base.length <= maxLength) return base;
  return `${cutTextSurrogateSafe(base, Math.max(0, maxLength - baseCutEllipsis.length))}${baseCutEllipsis}`;
}

/**
 * @description The name a topic shows: `<base> <status> <counts>` — one space between the parts, each part only when it holds (a count
 * only when switched on and at least 1), the base alone when none does. At most {@link topicNameMaxLength} units: the SUFFIX is never
 * cut — the BASE is, ending in «…» — so the mark stays; the stored base stays whole, the cut exists only in the name that is applied.
 */
export function composeIndicatorName(base: string, status: TopicStatus | null, counts: TopicIndicatorCounts, prefs: TopicStatusPrefs): string {
  const parts: string[] = [];
  if (status !== null) parts.push(topicStatusMarks[status]);
  for (const kind of topicIndicatorCountKinds) {
    if (prefs[kind] && counts[kind] >= 1) parts.push(`${topicIndicatorCountMarks[kind]}${counts[kind]}`);
  }
  if (parts.length === 0) return base;
  const suffix = parts.join(partSeparator);
  return `${cutBase(base, topicNameMaxLength - suffix.length - partSeparator.length)}${partSeparator}${suffix}`;
}

/** The emoji variation selector a client may or may not keep on a mark. */
const variationSelector = '\uFE0F';

function stripVariationSelector(text: string): string {
  return text.replaceAll(variationSelector, '');
}

/**
 * A TRAILING run of the bot's own parts, each with its leading space: a status mark, `⚙️<n>`, `📋<n>` — with or without the variation
 * selector. Built from the same mark tables the name is, so the two cannot drift.
 */
const indicatorSuffixPattern = (() => {
  const statusMarks = topicStatuses.map((status) => stripVariationSelector(topicStatusMarks[status])).join('|');
  const countMarks = topicIndicatorCountKinds.map((kind) => stripVariationSelector(topicIndicatorCountMarks[kind])).join('|');
  const part = `(?:${statusMarks})${variationSelector}?|(?:${countMarks})${variationSelector}?\\d+`;
  return new RegExp(`(?:\\s+(?:${part}))+\\s*$`, 'u');
})();

/** @description The trailing marks of `name` (the bot's own or typed alike) as written, `''` when it ends in none. */
export function getIndicatorSuffix(name: string): string {
  return indicatorSuffixPattern.exec(name)?.[0].trim() ?? '';
}

/** @description The status mark a name ends in, `null` when it ends in none (the count marks are no status). */
export function getIndicatorStatusOfName(name: string): TopicStatus | null {
  const parts = stripVariationSelector(getIndicatorSuffix(name)).split(/\s+/u);
  return topicStatuses.find((status) => parts.includes(stripVariationSelector(topicStatusMarks[status]))) ?? null;
}

/**
 * @description The owner's own name out of a name he just saved: `name` without its trailing run of the bot's marks. A name saved equal to
 * the one the bot applied is the stored whole `base` (the applied one may be a cut of it). Cost, by design: an owner's name that itself ends
 * in a mark loses that ending.
 */
export function stripIndicatorSuffix(name: string, appliedName: string | undefined, base: string | undefined): string {
  if (base !== undefined && name === appliedName) return base;
  return name.replace(indicatorSuffixPattern, '').trimEnd();
}

/** @name OwnerRenameOutcome @description What an owner's rename means for the bot: the owner's own name, and the mark of his that was taken for the bot's (`null` when none was). */
export interface OwnerRenameOutcome {
  base: string;
  droppedMark: string | null;
}

/**
 * @description The owner saved `savedName` as the topic's name. The base is that name without a trailing mark of ours. A mark that is NOT
 * the one the bot itself had applied (`Release ✅` typed while ⏳ showed) was the owner's own and is reported as dropped, so the picker can
 * say so once; the bot's own mark left in place by an edit around it (`Deploy v2 ⏳` over `Deploy ⏳`) is no news.
 */
export function getOwnerRenameOutcome(savedName: string, appliedName: string | undefined, storedBase: string | undefined): OwnerRenameOutcome {
  const base = stripIndicatorSuffix(savedName, appliedName, storedBase);
  const savedSuffix = getIndicatorSuffix(savedName);
  const isOwnMarkDropped = savedSuffix !== '' && savedName !== appliedName && savedSuffix !== getIndicatorSuffix(appliedName ?? '');
  return { base, droppedMark: isOwnMarkDropped ? savedSuffix : null };
}

// ── when a rename may happen ──

/** A turn must have run this long before its ⏳ shows: a short reply goes straight to its final mark (the owner: no flashing). */
export const indicatorSettleMs = 20_000;

/** Two renames of one topic are at least this far apart; the latest state wins, a state that came and went inside the gap is never shown. */
export const indicatorMinRenameGapMs = 60_000;

/** What {@link planIndicatorRename} decides on. */
export interface IndicatorRenameInputs {
  /** The name the topic should show now. */
  desiredName: string;
  /** The status in `desiredName`. */
  desiredStatus: TopicStatus | null;
  /** The name the topic shows now, as the bot last applied it. */
  appliedName: string;
  /** When the topic's turn began running, as the bot saw it; `null` while it does not run. */
  workingSinceMs: number | null;
  /** When the bot last renamed this topic; `null` before the first. */
  lastRenameAtMs: number | null;
  nowMs: number;
  settleMs: number;
  minGapMs: number;
}

/** @name IndicatorRenamePlan @description Rename now, rename at `atMs` (and decide again then), or nothing to do. */
export type IndicatorRenamePlan = { kind: 'now' } | { kind: 'at'; atMs: number } | { kind: 'none' };

/**
 * @description When the topic is renamed to its desired name. Nothing when it already shows it. The ⏳ waits until the turn has run
 * `settleMs`. Two renames keep `minGapMs` apart — except the edges of ❓ (a question appearing or being answered is the one thing the owner
 * must see at once), which still go through the shared send gate. The instant a wait ends is when the caller asks again, so the LATEST
 * desired name wins and states that came and went meanwhile are never shown.
 */
export function planIndicatorRename(inputs: IndicatorRenameInputs): IndicatorRenamePlan {
  const { desiredName, desiredStatus, appliedName, workingSinceMs, lastRenameAtMs, nowMs, settleMs, minGapMs } = inputs;
  if (desiredName === appliedName) return { kind: 'none' };
  const isQuestionEdge = desiredStatus === 'question' || getIndicatorStatusOfName(appliedName) === 'question';
  const settleAtMs = desiredStatus === 'working' && workingSinceMs !== null ? workingSinceMs + settleMs : nowMs;
  const gapEndsAtMs = !isQuestionEdge && lastRenameAtMs !== null ? lastRenameAtMs + minGapMs : nowMs;
  const atMs = Math.max(settleAtMs, gapEndsAtMs);
  return atMs > nowMs ? { kind: 'at', atMs } : { kind: 'now' };
}

// ── names too long for the mark ──

/** How many characters of a name the owner's phone shows in the topic list before its «…»: 28 until a screenshot of the phone's list is measured (the live probe's ruler). */
export const visibleNameChars = 28;

/** What the mark takes in the list: the space and the mark itself. */
const markReserveChars = 2;

/** @description How long a base may be for its mark to stay visible on a phone: the visible characters less the space and the mark. */
export const visibleBaseChars = visibleNameChars - markReserveChars;

/** @description Whether `base` is longer than the list shows with a mark after it — the picker then says the mark may be cut off. */
export function checkIsBaseTooLongForMark(base: string): boolean {
  return Array.from(base).length > visibleBaseChars;
}
