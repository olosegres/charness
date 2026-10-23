/**
 * @description What the process-level flows of the usage-limit fallback (`fallbackSwitchE2e.test.ts` — Claude ↔
 * Claude, `fallbackSwitchOpenCodeE2e.test.ts` — to and from OpenCode) share: the slice of `state.json` they read and
 * edit, the fake `claude`'s launch and turn logs, the reset instant the fakes name and how the bot words it, and
 * starting / restarting the instance. Matches neither runner glob.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, type FakeClaudePrompt, type FakeClaudeTurn } from '../jiraE2e/fakeClaudeContract';
import { IsolatedCharness, readJsonLines, type IsolatedInstanceLayout } from './isolatedCharness';
import type { FakeTelegram, FakeTelegramMessage } from '../telegramE2e/fakeTelegram';
import type { TopicDriver } from '../telegramE2e/topicDriver';
import type { AgentData, BindingData, ClaudeProfileRecord, ParkedSession } from '../../state';
import type { FallbackChainEntry } from '../../utils/fallbackChain';

/** The line the bot prints once its long polling is up. */
const launchLine = 'Launching Telegraf bot (long polling';
const bootTimeoutMs = 60 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const msPerDay = 24 * 60 * 60 * 1000;
/** The hour (UTC) the fake limit resets at. */
const resetHourUtc = 1;

/** The slice of `state.json` the flows read and edit. */
export interface PersistedState {
  claudeProfiles?: Record<string, ClaudeProfileRecord>;
  /** The per-topic account picks, keyed by the topic. */
  claudeProfileOverrides?: Record<string, string>;
  fallbackChain?: FallbackChainEntry[];
  agents?: Record<string, AgentData>;
  /** The folder each topic is bound to, keyed by the topic. */
  bindings?: Record<string, BindingData>;
  parkedSessions?: Record<string, ParkedSession>;
  /** The armed API-error retries (a usage-limit wait among them), keyed by the topic. */
  apiRetries?: Record<string, { kind: string; attempt: number; fireAt: number; isLimitProbe?: boolean }>;
  [field: string]: unknown;
}

export function getStatePath(layout: IsolatedInstanceLayout): string {
  return path.join(layout.dataDir, 'state.json');
}

export function readPersistedState(layout: IsolatedInstanceLayout): PersistedState {
  return JSON.parse(fs.readFileSync(getStatePath(layout), 'utf8'));
}

/** One launch the fake `claude` logged. */
export interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
  /** The pid of an earlier process of the same conversation that was STILL running when this one started, else `null`. */
  overlapsPid?: number | null;
  /** The `CLAUDE_CONFIG_DIR` the process was started with: a second account's directory; `null` for the first. */
  claudeConfigDir: string | null;
}

export function getSessionLaunches(layout: IsolatedInstanceLayout): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

/** Every turn the fake agents ran, whatever it was labelled (a «continue» nudge carries no request, so no label). */
export function getAllAgentTurns(layout: IsolatedInstanceLayout): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.turns));
}

export function getAgentTurns(layout: IsolatedInstanceLayout, label: string): FakeClaudeTurn[] {
  return getAllAgentTurns(layout).filter((turn) => turn.issueKey === label);
}

export interface TurnLaunchMatch {
  sessionId: string;
  /** The account's config directory the process runs under; `null` for the default account. */
  configDir: string | null;
  /** A `--model` the process was launched with. */
  model: string;
}

/** @description Whether some turn — labelled or not — ran in a process launched for `match.sessionId` under `match.configDir` with `--model <match.model>`. */
export function checkHasTurnOnLaunch(layout: IsolatedInstanceLayout, match: TurnLaunchMatch): boolean {
  const launches = getSessionLaunches(layout);
  return getAllAgentTurns(layout).some((turn) => {
    const launch = launches.find((candidate) => candidate.pid === turn.pid);
    return launch !== undefined
      && getLaunchSessionId(launch.argv) === match.sessionId
      && launch.claudeConfigDir === match.configDir
      && getFlagValues(launch.argv, '--model').includes(match.model);
  });
}

/** The launch of the process that ran turn `turnIndex` of `label` (the fake records launches by pid). */
export function getLaunchOfTurn(layout: IsolatedInstanceLayout, label: string, turnIndex: number): FakeLaunch {
  const turn = getAgentTurns(layout, label)[turnIndex];
  if (!turn) throw new Error(`turn ${turnIndex + 1} of ${label} is not recorded`);
  const launch = getSessionLaunches(layout).filter((candidate) => candidate.pid === turn.pid).at(-1);
  if (!launch) throw new Error(`no launch recorded for the process ${turn.pid} that ran ${label}`);
  return launch;
}

/** The config directory a second Claude account `name` runs under. */
export function getAccountConfigDir(layout: IsolatedInstanceLayout, name: string): string {
  return path.join(layout.dataDir, 'claude-profiles', name);
}

/** The instant the fakes say the limit resets: a few days ahead, so the notice and the button carry the date. */
export function computeResetsAtIso(daysAhead: number): string {
  const now = new Date(Date.now() + daysAhead * msPerDay);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc)).toISOString();
}

/** The reset as the bot words it in an instance whose zone is UTC. */
export function getResetClock(resetsAtIso: string): string {
  return `${resetsAtIso.slice(0, 10)} ${resetsAtIso.slice(11, 16)}`;
}

/**
 * The bot's usage-limit «switched» notices in a topic. They start with the switch mark like the question and the
 * outcome lines of a MANUAL switch between backends, so the limit wording tells them apart.
 */
export function listSwitchNotices(driver: TopicDriver): FakeTelegramMessage[] {
  return driver.listMessages().filter((message) => message.text.startsWith('🔁') && message.text.includes('usage limit'));
}

/** The context bridges (`[Backend switch] …`) the fake `claude` was sent, oldest first. */
export function listBridgePrompts(layout: IsolatedInstanceLayout): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes('[Backend switch]'));
}

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
export async function startCharnessOnInstance(layout: IsolatedInstanceLayout, fakeTelegram: FakeTelegram): Promise<IsolatedCharness> {
  const charness = new IsolatedCharness(layout);
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  return charness;
}

/** Stop the bot, edit `state.json` the way a persisted instance would hold it, start the bot again. */
export async function restartCharnessWithState(
  layout: IsolatedInstanceLayout,
  fakeTelegram: FakeTelegram,
  running: IsolatedCharness,
  edit: (state: PersistedState) => void,
): Promise<IsolatedCharness> {
  await running.stop();
  const persisted = readPersistedState(layout);
  edit(persisted);
  fs.writeFileSync(getStatePath(layout), JSON.stringify(persisted));
  return startCharnessOnInstance(layout, fakeTelegram);
}

/** Wait until the fake agent runs in a NEW process started with `configDir` (`null`: the first account) on `sessionId`. */
export async function waitForSessionRespawn(
  charness: IsolatedCharness,
  layout: IsolatedInstanceLayout,
  description: string,
  configDir: string | null,
  sessionId: string,
  launchesBefore: number,
): Promise<void> {
  await charness.waitFor(description, agentStartTimeoutMs, () => {
    const launches = getSessionLaunches(layout);
    const latest = launches.at(-1);
    return launches.length > launchesBefore && latest !== undefined && latest.claudeConfigDir === configDir && getLaunchSessionId(latest.argv) === sessionId;
  });
}

/** The `/limits` board a topic shows, found by the callback data of its rows (`lim_*`). */
export interface OpenedLimitsBoard {
  message: FakeTelegramMessage;
  /** The callback data of the row whose label (without its ✓) starts with `rowName` (`Claude · default`, `OpenCode · openai`). */
  rowData: (rowName: string) => string;
  /** The label of that row. */
  rowLabel: (rowName: string) => string;
}

/**
 * @description The operator types `/limits` in a topic (General included); resolves the board the bot answers with: the
 * newest message after the command that carries `lim_*` rows — not a wait notice that only names the command in passing.
 */
export async function openLimitsBoard(fakeTelegram: FakeTelegram, driver: TopicDriver, threadId: number): Promise<OpenedLimitsBoard> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, '/limits');
  const message = await driver.waitForMessage('the /limits board', (candidate) => candidate.message_id > sentMessageId && driver.getKeyboardData(candidate).flat().some((data) => data.startsWith('lim_')));
  const labels = driver.getKeyboardLabels(message).flat();
  const data = driver.getKeyboardData(message).flat();
  const indexOf = (rowName: string): number => {
    const index = labels.findIndex((label) => label.replace('✓ ', '').startsWith(rowName));
    if (index < 0) throw new Error(`no board row «${rowName}» in ${labels.join(' | ')}`);
    return index;
  };
  return { message, rowData: (rowName) => data[indexOf(rowName)], rowLabel: (rowName) => labels[indexOf(rowName)] };
}
