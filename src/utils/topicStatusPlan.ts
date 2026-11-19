/**
 * @description The pure half of `/topic_status` — the switches of the status mark at the end of topic names (`topicIndicatorPlan.ts`): the
 * `tst_*` / `tsn_*` button codec, the result of a tap on a set of switches, and the two screens (text + button plan) — a topic's own and
 * General's, which sets the default of every topic and lists the topics whose own name the bot does not know yet. The command module
 * (`connectors/telegram/commands/topicStatus.ts`) draws them and applies what a tap decides.
 *
 * A button carries what it does, not a position: a switch's data names the switch and its NEW value, a name confirmation the topic's
 * thread id — so a keyboard left in the history applies exactly what its button says, or is told it is out of date, never something else.
 * All data is far under Telegram's 64 bytes.
 */

import { t } from '../i18n';
import { cutButtonLabel } from './cutButtonLabel';
import {
  checkIsBaseTooLongForMark,
  checkIsTopicIndicatorSwitch,
  createTopicStatusPrefsWith,
  topicIndicatorCountKinds,
  topicStatuses,
  visibleBaseChars,
  type TopicIndicatorSwitch,
  type TopicStatusPrefs,
} from './topicIndicatorPlan';

/** Every `/topic_status` button's callback data starts with this; the name confirmation has its own prefix. */
export const topicStatusCallbackPrefix = 'tst_';
export const topicStatusNameCallbackPrefix = 'tsn_';

/** The data of the «All off» and «As General» buttons. */
export const topicStatusAllOffCallback = `${topicStatusCallbackPrefix}off`;
export const topicStatusSameAsGeneralCallback = `${topicStatusCallbackPrefix}same`;

/** Longest button caption of a topic's name, in characters: a phone's button holds about this much. */
const nameButtonMaxChars = 24;

/** How many topics whose name the bot does not know General lists as buttons; the rest are counted. */
export const topicStatusUnknownNameButtonLimit = 8;

/** How many name buttons, and how many status switches, share a row. */
const nameButtonsPerRow = 2;
const statusButtonsPerRow = 2;

/** One button of a screen: its caption and the data a tap carries. */
export interface TopicStatusButton {
  label: string;
  callbackData: string;
}

/** A screen: the message text and its rows of buttons. */
export interface TopicStatusScreen {
  text: string;
  keyboard: TopicStatusButton[][];
}

/** A decoded tap. */
export type TopicStatusCallback =
  | { kind: 'switch'; name: TopicIndicatorSwitch; isOn: boolean }
  | { kind: 'allOff' }
  | { kind: 'sameAsGeneral' }
  | { kind: 'confirmName'; threadId: number };

/** Every data the module registers. */
export const topicStatusCallbackRe = /^(?:tst_(?:[a-z]+_[01]|off|same)|tsn_\d+)$/;

/** @description The data of a tap that turns `name` to `isOn`. */
export function buildTopicStatusSwitchCallback(name: TopicIndicatorSwitch, isOn: boolean): string {
  return `${topicStatusCallbackPrefix}${name}_${isOn ? 1 : 0}`;
}

/** @description The data of the button that confirms the name of topic `threadId`. */
export function buildTopicStatusNameCallback(threadId: number): string {
  return `${topicStatusNameCallbackPrefix}${threadId}`;
}

/** @description Read a tap's data; `null` for data that is none of ours (a stale or foreign keyboard). */
export function parseTopicStatusCallback(data: string): TopicStatusCallback | null {
  if (data === topicStatusAllOffCallback) return { kind: 'allOff' };
  if (data === topicStatusSameAsGeneralCallback) return { kind: 'sameAsGeneral' };
  const nameMatch = /^tsn_(\d+)$/.exec(data);
  if (nameMatch) return { kind: 'confirmName', threadId: Number(nameMatch[1]) };
  const switchMatch = /^tst_([a-z]+)_([01])$/.exec(data);
  if (switchMatch && checkIsTopicIndicatorSwitch(switchMatch[1])) return { kind: 'switch', name: switchMatch[1], isOn: switchMatch[2] === '1' };
  return null;
}

/** @description The set of switches after a tap that is a switch or «All off»; `current` itself for any other tap. */
export function applyTopicStatusTap(current: TopicStatusPrefs, tap: TopicStatusCallback): TopicStatusPrefs {
  if (tap.kind === 'switch') return { ...current, [tap.name]: tap.isOn };
  if (tap.kind === 'allOff') return createTopicStatusPrefsWith(false);
  return current;
}

// ─── the screens ────────────────────────────────────────────────────────

const switchLabelKeys: Record<TopicIndicatorSwitch, string> = {
  question: 'topicStatus.questionButtonLabel',
  stuck: 'topicStatus.stuckButtonLabel',
  working: 'topicStatus.workingButtonLabel',
  finished: 'topicStatus.finishedButtonLabel',
  asleep: 'topicStatus.asleepButtonLabel',
  agents: 'topicStatus.agentsButtonLabel',
  queued: 'topicStatus.queuedButtonLabel',
};

/** The check mark in front of what is on or chosen. */
const selectedMark = '✓';

/** A switch's button: its caption (a ✓ in front while it is on) and the tap that flips it. */
function buildSwitchButton(name: TopicIndicatorSwitch, prefs: TopicStatusPrefs): TopicStatusButton {
  return {
    label: `${prefs[name] ? `${selectedMark} ` : ''}${t(switchLabelKeys[name])}`,
    callbackData: buildTopicStatusSwitchCallback(name, !prefs[name]),
  };
}

/** The status switches two to a row (a phone's buttons are narrow), then the counts' row. */
function buildSwitchRows(prefs: TopicStatusPrefs): { statuses: TopicStatusButton[][]; counts: TopicStatusButton[][] } {
  const statusButtons = topicStatuses.map((name) => buildSwitchButton(name, prefs));
  const countButtons = topicIndicatorCountKinds.map((name) => buildSwitchButton(name, prefs));
  const statusRows: TopicStatusButton[][] = [];
  for (let index = 0; index < statusButtons.length; index += statusButtonsPerRow) statusRows.push(statusButtons.slice(index, index + statusButtonsPerRow));
  return { statuses: statusRows, counts: [countButtons] };
}

/** What the topic view knows of the topic and its chat. */
export interface TopicStatusTopicView {
  /** The switches the topic uses now (its own set, else the instance's). */
  prefs: TopicStatusPrefs;
  /** Whether the topic has a set of its own (else it follows General). */
  isOwnSet: boolean;
  /** Whether the topic is bound: an unbound topic is never marked, so no hint about its name applies. */
  isBound: boolean;
  /** The owner's own name of the topic, when the bot knows it. */
  base: string | undefined;
  /** The name the topic was created with, offered while the base is unknown. */
  candidate: string | undefined;
  /** The topic's thread id: the confirmation button's data. */
  threadId: number;
  isRenameRefused: boolean;
  isLineDeletionRefused: boolean;
  /** A mark of the owner's own that was taken for the bot's and dropped from the name; told once. */
  droppedMark: string | undefined;
}

/** @description A topic's own screen: the switches, the way to General's set, and the hints that apply to it. */
export function buildTopicStatusTopicScreen(view: TopicStatusTopicView): TopicStatusScreen {
  const rows = buildSwitchRows(view.prefs);
  const keyboard: TopicStatusButton[][] = [
    ...rows.statuses,
    ...rows.counts,
    [
      { label: t('topicStatus.allOffButtonLabel'), callbackData: topicStatusAllOffCallback },
      { label: `${t('topicStatus.sameAsGeneralButtonLabel')}${view.isOwnSet ? '' : ` ${selectedMark}`}`, callbackData: topicStatusSameAsGeneralCallback },
    ],
  ];
  const hints: string[] = [];
  if (view.isBound && view.base === undefined) {
    if (view.candidate !== undefined) {
      hints.push(t('topicStatus.unknownNameCandidateHintText', { name: view.candidate }));
      keyboard.push([{ label: t('topicStatus.confirmNameButtonLabel'), callbackData: buildTopicStatusNameCallback(view.threadId) }]);
    } else {
      hints.push(t('topicStatus.unknownNameHintText'));
    }
  }
  if (view.isRenameRefused) hints.push(t('topicStatus.manageTopicsRightHintText'));
  if (view.base !== undefined && checkIsBaseTooLongForMark(view.base)) hints.push(t('topicStatus.longNameHintText', { max: visibleBaseChars }));
  if (view.droppedMark !== undefined) hints.push(t('topicStatus.droppedMarkHintText', { mark: view.droppedMark }));
  if (view.isLineDeletionRefused) hints.push(t('topicStatus.lineDeletionHintText'));
  const value = t(view.isOwnSet ? 'topicStatus.valueOwnText' : 'topicStatus.valueAsGeneralText');
  const text = [
    t('topicStatus.topicTitleText', { value }),
    t('topicStatus.statusesIntroText'),
    t('topicStatus.countsIntroText'),
    ...hints,
  ].join('\n\n');
  return { text, keyboard };
}

/** A topic General lists because the bot does not know its own name yet. */
export interface TopicStatusUnknownNameTopic {
  threadId: number;
  /** The name it was created with; `undefined` when the bot has none to offer. */
  candidate: string | undefined;
}

/** What General's view knows. */
export interface TopicStatusGeneralView {
  /** The instance's switches. */
  prefs: TopicStatusPrefs;
  /** The bound topics whose own name the bot does not know. */
  unknownNameTopics: readonly TopicStatusUnknownNameTopic[];
  isRenameRefused: boolean;
}

/** @description General's screen: the default of every topic, and the topics whose name the bot does not know yet. */
export function buildTopicStatusGeneralScreen(view: TopicStatusGeneralView): TopicStatusScreen {
  const rows = buildSwitchRows(view.prefs);
  const keyboard: TopicStatusButton[][] = [
    ...rows.statuses,
    ...rows.counts,
    [{ label: t('topicStatus.allOffButtonLabel'), callbackData: topicStatusAllOffCallback }],
  ];
  const parts: string[] = [t('topicStatus.generalTitleText'), t('topicStatus.statusesIntroText'), t('topicStatus.countsIntroText')];
  if (view.isRenameRefused) parts.push(t('topicStatus.manageTopicsRightHintText'));
  if (view.unknownNameTopics.length > 0) {
    parts.push(t('topicStatus.unknownNamesHeadingText'));
    const offered = view.unknownNameTopics.filter((topic) => topic.candidate !== undefined).slice(0, topicStatusUnknownNameButtonLimit);
    const nameButtons = offered.map((topic): TopicStatusButton => ({
      label: t('topicStatus.unknownNameChoiceButtonLabel', { name: cutButtonLabel(topic.candidate ?? '', nameButtonMaxChars) }),
      callbackData: buildTopicStatusNameCallback(topic.threadId),
    }));
    for (let index = 0; index < nameButtons.length; index += nameButtonsPerRow) keyboard.push(nameButtons.slice(index, index + nameButtonsPerRow));
    const unofferedCount = view.unknownNameTopics.length - nameButtons.length;
    if (unofferedCount > 0) parts.push(t('topicStatus.moreUnknownNamesText', { count: unofferedCount }));
  }
  return { text: parts.join('\n\n'), keyboard };
}
