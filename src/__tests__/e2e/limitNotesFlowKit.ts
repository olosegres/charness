/**
 * @description What the flows of the accounts note (`limitNotesMidTurnE2e`, `limitNotesTurnStartE2e`, `limitRemindersE2e`) share:
 * the shapes of a note as the fake agent reads it, the usage figures a fake agent reports, and the readers of what the fake agent
 * was told. Nothing here starts a process.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fakeClaudeLogFileNames, fakeClaudeUsageWindowsFileName, type FakeClaudePrompt, type FakeClaudeUsageWindows } from '../jiraE2e/fakeClaudeContract';
import { readJsonLines, type IsolatedInstanceLayout } from './isolatedCharness';
import { readPersistedState } from './fallbackFlowKit';

/** A reminder as the agent reads it: the head line carries only the time. */
export const reminderNoteRe = /\[Accounts · \d{2}:\d{2}\]/;

/** A change summary as the agent reads it: the same head with «changed». */
export const summaryNoteRe = /\[Accounts · \d{2}:\d{2} · changed\]/;

const msPerHour = 3_600_000;

/** An ISO instant `hours` from now. */
export const hoursAhead = (hours: number): string => new Date(Date.now() + hours * msPerHour).toISOString();

/** The five-hour window every flow reports, far from the launch ceiling. */
const reportedSessionPercent = 30;
const reportedSessionResetHours = 3;
const reportedWeeklyResetHours = 72;

/** @description Make every fake agent's turn start with the `rate_limit_event` frame of `accountName` at `weeklyPercent` — how the bot learns a figure from an agent. */
export function writeFakeUsageWindows(layout: IsolatedInstanceLayout, accountName: string, weeklyPercent: number): void {
  const windows: FakeClaudeUsageWindows = {
    [accountName]: { sessionPercent: reportedSessionPercent, sessionResetsAt: hoursAhead(reportedSessionResetHours), weeklyPercent, weeklyResetsAt: hoursAhead(reportedWeeklyResetHours) },
  };
  fs.writeFileSync(path.join(layout.fakeStateDir, fakeClaudeUsageWindowsFileName), JSON.stringify(windows));
}

/** @description Whether the account's figures reached the bot from an agent's frame and are fresh (the bot's own poller finds no sign-in on a fake account). */
export function checkIsAccountUsageFresh(layout: IsolatedInstanceLayout, accountName: string): boolean {
  const usage = readPersistedState(layout).claudeProfiles?.[accountName]?.usage;
  return usage?.source === 'stream' && usage.isStale !== true;
}

/** @description Every user message the fake agents read, in order. */
export function listFakePrompts(layout: IsolatedInstanceLayout): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.prompts));
}

/** @description What the fake agent read as the user message labelled `label` (a `KEY-n` token the flow put in the message). */
export function getFakePromptText(layout: IsolatedInstanceLayout, label: string): string {
  const prompt = listFakePrompts(layout).find((candidate) => candidate.text.includes(`${label} `));
  assert.ok(prompt, `the agent read ${label}`);
  return prompt.text;
}
