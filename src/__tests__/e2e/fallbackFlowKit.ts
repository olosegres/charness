/**
 * @description What the process-level flows of the usage-limit fallback (`fallbackSwitchE2e.test.ts` — Claude ↔
 * Claude, `fallbackSwitchOpenCodeE2e.test.ts` — to and from OpenCode) share: the slice of `state.json` they read and
 * edit, the fake `claude`'s launch and turn logs, the reset instant the fakes name and how the bot words it, the
 * `/accounts` «back» buttons, and starting / restarting the instance. Matches neither runner glob.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fakeClaudeLogFileNames, getLaunchSessionId, type FakeClaudeTurn } from '../jiraE2e/fakeClaudeContract';
import { IsolatedCharness, readJsonLines, type IsolatedInstanceLayout } from './isolatedCharness';
import type { FakeTelegram, FakeTelegramMessage } from '../telegramE2e/fakeTelegram';
import type { TopicDriver } from '../telegramE2e/topicDriver';
import type { AgentData, ClaudeProfileRecord, ParkedSession } from '../../state';
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
  fallbackChain?: FallbackChainEntry[];
  fallbackReturns?: Record<string, FallbackChainEntry>;
  agents?: Record<string, AgentData>;
  parkedSessions?: Record<string, ParkedSession>;
  /** The armed API-error retries (a usage-limit wait among them), keyed by the topic. */
  apiRetries?: Record<string, { kind: string; attempt: number; fireAt: number }>;
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
  /** The `CLAUDE_CONFIG_DIR` the process was started with: a second account's directory; `null` for the first. */
  claudeConfigDir: string | null;
}

export function getSessionLaunches(layout: IsolatedInstanceLayout): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

export function getAgentTurns(layout: IsolatedInstanceLayout, label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
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

/** The callback data of a screen's «back» buttons (`acct_ret_<revision>`), in keyboard order. */
export function listReturnButtonData(driver: TopicDriver, screen: FakeTelegramMessage): string[] {
  return driver.getKeyboardData(screen).flat().filter((data) => data.startsWith('acct_ret_'));
}

/** The bot's «switched» notices in a topic (the only messages that start with the switch mark). */
export function listSwitchNotices(driver: TopicDriver): FakeTelegramMessage[] {
  return driver.listMessages().filter((message) => message.text.startsWith('🔁'));
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
