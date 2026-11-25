/**
 * @description The usage-limit switch for a JIRA conversation, at PROCESS level: the BUILT charness serving Jira only
 * (`CONNECTORS=jira`, no Telegram, no `/accounts`) against the fake Jira and the fake `claude` (`jiraE2e/jiraFlowKit.ts`), the Jira
 * twin of `fallbackSwitchE2e.test.ts`. One flow, in order:
 *
 *   isolation checked before the boot; a profile folder an operator made the way the bot does (`createClaudeProfileLayout`) and signed
 *   in by hand (`CLAUDE_CONFIG_DIR=<it> claude auth login`, here the fake's login file), a bare folder made by hand that is not signed in
 *   and one whose name the profile gate refuses are on disk before the boot
 *   → the boot's first usage poll adopts the folders: the signed-in one is recorded as such (e-mail, plan), the blank one as not signed
 *     in and given the links a profile needs, the badly named one not at all; a restart probes only what is due, not the signed-in
 *     account again
 *   → the bot is stopped, a one-rung fallback list naming the adopted account is seeded (the usage figures of a real sign-in cannot be
 *     read here), the bot starts again
 *   → an issue's agent hits its usage limit: the conversation moves to the adopted account by itself, the SAME conversation resumed
 *     under that account's directory, answered and handed back; no wait is announced to the requester, the exhausted account is
 *     marked limited until the reset the error named, and no Telegram primitive is touched
 *   → the timeline seen live: the next issue's account hits its limit (back in 2 h) while the adopted one is itself limited, but back
 *     within a minute: the requester is told the answer comes when the ADOPTED account is back, and at that time the conversation
 *     resumes there by itself (`--resume` under its directory); that account's reset turns out wrong — it refuses once more with a
 *     later reset — so the wait is planned again, for that new reset (no retry before it, the requester told the new time), and the
 *     issue is answered on that account after it and handed back
 *   → with auto switch OFF (as an operator left it) the next issue's agent hits the same limit and WAITS: the requester is told in a
 *     comment, nothing moves, nobody switches
 *   → a wait aimed at the adopted account while the switch was ON ends after the switch was turned OFF: the issue stays, nothing is
 *     started, and the wait is armed again for its own account's reset
 *   → the launches carried the Jira flags and the allowlist (a launch under an account's directory adds `CLAUDE_CONFIG_DIR` — a path,
 *     the one variable an account adds — and only there), and no Telegram path was reached
 *
 * What the unit tests cover instead: the scan (`claudeProfileSync.test.ts`) and the decision per kind of conversation, with an account
 * free, none free (the account the wait ends on), auto switch OFF, a chain with OpenCode rungs (`limitSwitchPlan.test.ts`); the retry
 * kick's move of an issue, never onto OpenCode (`apiRetryKick.test.ts`).
 *
 * Nothing leaves the machine: Jira and the bot MCP are on loopback, the agent is the fake. Everything the test starts is stopped in
 * `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { resetBufferMs } from '../apiErrorRetry';
import type { FakeJiraIssue } from './jiraE2e/fakeJira';
import {
  checkHasFlag,
  fakeClaudeAlwaysUsageLimitFileName,
  fakeClaudeLoginFileName,
  fakeClaudeLogFileNames,
  fakeConsoleLogin,
  getForeignAgentEnvNames,
  getLaunchSessionId,
  requiredJiraSessionFlags,
} from './jiraE2e/fakeClaudeContract';
import {
  checkHasTurnOnLaunch,
  computeResetsAtIso,
  getAllAgentTurns,
  getAccountConfigDir,
  getLaunchOfTurn,
  getSessionLaunches,
  getStatePath,
  readPersistedState,
  type PersistedState,
} from './e2e/fallbackFlowKit';
import {
  answerTimeoutMs,
  bootJiraOnly,
  createIssue,
  fakeJira,
  getCharness,
  getCommentTexts,
  getLayout,
  getTurns,
  handIssueToAi,
  itHoldsIsolationBeforeBoot,
  itReachedNoTelegramPath,
  readFakeLog,
  registerJiraFlowHooks,
  requester,
  resumeTimeoutMs,
  startCharness,
  waitFor,
} from './jiraE2e/jiraFlowKit';

/** The account the first issue's conversation hits its limit on (`~/.claude`, no directory of its own). */
const exhaustedAccount = 'default';
/** The account an operator signed in by hand: nothing but a folder and a login on disk. */
const handSignedAccount = 'second';
const blankAccount = 'blank';
/** A name the profile gate refuses (upper case): never an account. */
const refusedFolderName = 'Not_A_Profile';
const limitIssueKey = 'PROJ-50';
const waitingIssueKey = 'PROJ-51';
/** The issue of the timeline seen live: its account hits the limit while the other one is limited too, but back sooner. */
const earliestIssueKey = 'PROJ-52';
const takeoverDaysAhead = 2;
/** How far ahead of the restart the adopted account's limit ends: past the boot, the poll and the first turn, which must find it limited. */
const adoptedBackLeadMs = 60_000;
/** When the issue's own account comes back: long after the adopted one. */
const ownResetLeadMs = 2 * 60 * 60 * 1000;
/** The adopted account's reset turned out wrong: at the resume it refuses again, with a reset this long after the first one. */
const refusedResetAfterBackMs = 100_000;
/** How long nothing may run after that refusal: an instant retry would land well inside it. */
const noRetryQuietMs = 5_000;

/** When the fake says the limit resets: a few days ahead. */
const resetsAtIso = computeResetsAtIso(takeoverDaysAhead);

/** The instance's `~/.claude`, where an account's shared entries link to. */
function getHomeClaudeDir(): string {
  return path.join(getLayout().instanceHome, '.claude');
}

/** Stop the instance, edit its `state.json` the way a persisted one would hold it, start it again. */
async function restartWithState(edit: (state: PersistedState) => void): Promise<void> {
  await getCharness().stop();
  const persisted = readPersistedState(getLayout());
  edit(persisted);
  fs.writeFileSync(getStatePath(getLayout()), JSON.stringify(persisted));
  await startCharness();
}

/** An issue whose agent ends its first turn on a usage limit that resets at {@link resetsAtIso}. */
function createLimitIssue(issueKey: string): void {
  createIssue(issueKey, 'usage-limit-once', ` [limit-resets:${resetsAtIso}]`);
}

describe('The usage-limit switch of a Jira conversation end to end: built charness serving Jira only, fake Jira, fake claude', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-j-fbswitch-',
    config: { adapter: 'claude-json-stream' },
  });

  itHoldsIsolationBeforeBoot();

  it('adopts the profile folders an operator signed in by hand at the first usage poll: no Telegram, no /accounts', async () => {
    const dataDir = getLayout().dataDir;
    const signedInDir = createClaudeProfileLayout({ dataDir, name: handSignedAccount, homeClaudeDir: getHomeClaudeDir() });
    fs.writeFileSync(path.join(signedInDir, fakeClaudeLoginFileName), JSON.stringify({ method: 'claudeai' }));
    // Made by hand, with no links at all: the bot gives it the ones a profile needs when it adopts it.
    fs.mkdirSync(path.join(dataDir, 'claude-profiles', blankAccount), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'claude-profiles', refusedFolderName), { recursive: true });
    assert.equal(fs.existsSync(getStatePath(getLayout())), false, 'no state, so nothing recorded, before the boot');

    await bootJiraOnly();

    await waitFor('the signed-in folder adopted and probed', answerTimeoutMs, () => {
      const profiles = fs.existsSync(getStatePath(getLayout())) ? readPersistedState(getLayout()).claudeProfiles : undefined;
      return profiles?.[handSignedAccount]?.loggedIn === true && profiles[blankAccount]?.loggedIn === false;
    });
    const { claudeProfiles = {} } = readPersistedState(getLayout());
    assert.equal(claudeProfiles[handSignedAccount].email, fakeConsoleLogin.email);
    assert.equal(claudeProfiles[handSignedAccount].subscriptionType, 'max');
    assert.equal(claudeProfiles[handSignedAccount].billing, 'subscription');
    assert.ok(claudeProfiles[handSignedAccount].statusCheckedAt, 'probed');
    assert.equal(claudeProfiles[blankAccount].email, undefined, 'a folder with no login: not signed in, never offered');
    assert.ok(fs.lstatSync(path.join(getAccountConfigDir(getLayout(), blankAccount), 'projects')).isSymbolicLink(), 'the folder made by hand got the link to the shared transcripts');
    assert.equal(Object.keys(claudeProfiles).includes(refusedFolderName), false, 'a name the gate refuses is no account');
    const output = getCharness().output;
    assert.match(output, new RegExp(`\\[accounts\\] profile ${handSignedAccount}: its folder had no record — adopted`));
    assert.match(output, new RegExp(`\\[accounts\\] profile ${blankAccount}: its folder had no record — adopted`));
    assert.ok(!output.includes(refusedFolderName), 'the refused name is not even logged');
    assert.ok(!output.includes(fakeConsoleLogin.email), 'no e-mail in the log');
  });

  it('a restart does not probe the signed-in account again while its status is fresh', async () => {
    const probesOf = (): number => listAuthStatusProbes().filter((launch) => launch.claudeConfigDir === getAccountConfigDir(getLayout(), handSignedAccount)).length;
    const before = probesOf();
    assert.ok(before >= 1, 'probed at the first poll');
    // Seed the fallback list while the bot is down: the usage figures of a real sign-in cannot be read here.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: handSignedAccount, model: null }];
    });
    // The boot's first usage poll (the scan with it) runs beside the first Jira poll and logs nothing when it finds nothing to do: give it its time.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(probesOf(), before, 'the status was fresh: no `claude auth status` under the account\'s directory at the second boot');
  });

  it('an issue\'s agent hits its limit: the conversation moves to the adopted account by itself and is answered — no wait announced, no Telegram', async () => {
    createLimitIssue(limitIssueKey);
    handIssueToAi(limitIssueKey, requester);
    const issue = fakeJira.getIssue(limitIssueKey);
    await waitFor(`${limitIssueKey}: the first turn under way`, answerTimeoutMs, () => getTurns(limitIssueKey).length >= 1);

    try {
      await waitFor(`${limitIssueKey}: the conversation continued under ${handSignedAccount}, answered and handed back`, resumeTimeoutMs, () =>
        issue.assignee?.accountId === requester.accountId && getCommentTexts(issue).length >= 1);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message.split('; charness output tail')[0] : String(e)}\n${listLimitLogLines().join('\n')}`);
    }

    const firstLaunch = getLaunchOfTurn(getLayout(), limitIssueKey, 0);
    assert.equal(firstLaunch.claudeConfigDir, null, 'the limit was hit on the account with no directory of its own');
    const sessionId = getLaunchSessionId(firstLaunch.argv) ?? '';
    assert.ok(sessionId, 'the first launch carries a conversation id');
    assert.ok(
      checkHasTurnOnLaunch(getLayout(), { sessionId, configDir: getAccountConfigDir(getLayout(), handSignedAccount), model: 'opus' }),
      'the SAME conversation (resumed) ran a turn under the adopted account\'s directory',
    );
    const resumed = getSessionLaunches(getLayout()).find((launch) => launch.claudeConfigDir === getAccountConfigDir(getLayout(), handSignedAccount) && getLaunchSessionId(launch.argv) === sessionId);
    assert.ok(resumed?.argv.includes('--resume'), 'resumed, not started over');

    const comments = getCommentTexts(issue);
    assert.ok(comments.every((text) => !/Usage limit reached/.test(text)), `the requester was told of no wait: ${comments.join(' | ')}`);
    // `state.json` is saved by a trailing debounce, so what the switch recorded reaches the file a moment after the answer: wait for
    // it instead of reading the file once (a loaded box — a test run at the lowest priority — read it before the save).
    const limitIssueStateKey = keyToString(makeJiraKey(limitIssueKey));
    await waitFor('the switch and the limit persisted to state.json', answerTimeoutMs, () => {
      const saved = readPersistedState(getLayout());
      return saved.claudeProfileOverrides?.[limitIssueStateKey] === handSignedAccount && saved.claudeProfiles?.[exhaustedAccount]?.limitedUntil === resetsAtIso;
    });
    const persisted = readPersistedState(getLayout());
    assert.equal(persisted.claudeProfileOverrides?.[limitIssueStateKey], handSignedAccount, 'the issue now follows the adopted account');
    assert.equal(persisted.claudeProfiles?.[exhaustedAccount]?.limitedUntil, resetsAtIso, 'the exhausted account is marked limited until the reset the error named');
    const output = getCharness().output;
    assert.match(output, new RegExp(`\\[fallback\\] ${keyToString(makeJiraKey(limitIssueKey))}: usage limit on .*; switch plan: auto → .*${handSignedAccount}`));
    assert.match(output, new RegExp(`\\[fallback\\] ${keyToString(makeJiraKey(limitIssueKey))}: switched from .* after a usage limit; resuming`));
  });

  it('with no account free the wait ends when the account back FIRST is back, and the conversation resumes there by itself', async () => {
    const k = keyToString(makeJiraKey(earliestIssueKey));
    const adoptedBackMs = Date.now() + adoptedBackLeadMs;
    const adoptedBackIso = new Date(adoptedBackMs).toISOString();
    const ownResetIso = new Date(Date.now() + ownResetLeadMs).toISOString();
    await restartWithState((persisted) => {
      const adopted = persisted.claudeProfiles?.[handSignedAccount];
      assert.ok(persisted.claudeProfiles && adopted, 'the adopted account is recorded');
      // The first issue left the account marked for days: this issue's own limit sets its mark.
      delete persisted.claudeProfiles[exhaustedAccount]?.limitedUntil;
      persisted.claudeProfiles[handSignedAccount] = { ...adopted, limitedUntil: adoptedBackIso };
    });
    createIssue(earliestIssueKey, 'usage-limit-once', ` [limit-resets:${ownResetIso}]`);
    handIssueToAi(earliestIssueKey, requester);
    const issue = fakeJira.getIssue(earliestIssueKey);

    await waitFor(`${earliestIssueKey}: the limit planned`, answerTimeoutMs, () => listLimitPlanLines(k).length >= 1);
    const [firstPlan] = listLimitPlanLines(k);
    if (!firstPlan.includes('earliest reset') && Date.now() > adoptedBackMs) {
      throw new Error(`precondition not met: the adopted account was back (${adoptedBackIso}) before the limit was planned — a boot and first turn slower than ${adoptedBackLeadMs / 1000} s: ${firstPlan}`);
    }
    assert.ok(firstPlan.includes(`switch plan: none; earliest reset: Claude · ${handSignedAccount} · `) && firstPlan.endsWith(` at ${adoptedBackIso}`), `the wait is aimed at the adopted account: ${firstPlan}`);
    await waitFor(`${earliestIssueKey}: the wait announced to the requester`, answerTimeoutMs, () => readLimitNotices(issue).length >= 1);
    const [notice] = readLimitNotices(issue);
    assert.equal(notice.clock, formatClockIn(notice.zone, adoptedBackMs), `the answer comes when the adopted account is back: ${notice.text}`);
    assert.notEqual(notice.clock, formatClockIn(notice.zone, Date.parse(ownResetIso)), 'not when the issue\'s own account is');
    await waitFor('the aimed wait persisted to state.json', answerTimeoutMs, () => readPersistedState(getLayout()).apiRetries?.[k]?.resumeOn !== undefined);
    const aimed = readPersistedState(getLayout());
    assert.deepEqual(aimed.apiRetries?.[k]?.resumeOn, { backend: 'claude', profile: handSignedAccount, model: null }, 'the wait ends on the adopted account');
    assert.equal(aimed.apiRetries?.[k]?.fireAt, adoptedBackMs + resetBufferMs, 'it fires when that account is back, not in 2 h');
    assert.equal(aimed.claudeProfiles?.[exhaustedAccount]?.limitedUntil, ownResetIso, 'the issue\'s account is marked until the reset its error named');

    // At the resume the adopted account refuses after all, with a later reset: its own reset was wrong.
    const refusedResetMs = adoptedBackMs + refusedResetAfterBackMs;
    const refusedResetIso = new Date(refusedResetMs).toISOString();
    const alwaysLimitPath = path.join(getLayout().fakeStateDir, fakeClaudeAlwaysUsageLimitFileName);
    fs.writeFileSync(alwaysLimitPath, refusedResetIso);
    const sessionId = getLaunchSessionId(getLaunchOfTurn(getLayout(), earliestIssueKey, 0).argv) ?? '';
    assert.ok(sessionId, 'the first launch carries a conversation id');
    const adoptedDir = getAccountConfigDir(getLayout(), handSignedAccount);
    try {
      await waitFor(`${earliestIssueKey}: resumed under ${handSignedAccount} once it was back`, adoptedBackMs + resetBufferMs + answerTimeoutMs - Date.now(), () =>
        getSessionLaunches(getLayout()).some((launch) => launch.claudeConfigDir === adoptedDir && getLaunchSessionId(launch.argv) === sessionId));
      await waitFor(`${earliestIssueKey}: the refusal planned`, answerTimeoutMs, () => listLimitPlanLines(k).length >= 2);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message.split('; charness output tail')[0] : String(e)}\n${listLimitLogLines().join('\n')}`);
    } finally {
      fs.rmSync(alwaysLimitPath, { force: true });
    }
    const turnsAfterRefusal = getAllAgentTurns(getLayout()).length;
    if (Date.now() >= refusedResetMs) throw new Error(`precondition not met: the refusal was handled after its own reset (${refusedResetIso}) — a resume slower than ${(refusedResetAfterBackMs - resetBufferMs) / 1000} s`);
    const resumed = getSessionLaunches(getLayout()).find((launch) => launch.claudeConfigDir === adoptedDir && getLaunchSessionId(launch.argv) === sessionId);
    assert.ok(resumed?.argv.includes('--resume'), 'the SAME conversation resumed, not started over');
    assert.match(getCharness().output, new RegExp(`\\[fallback\\] ${k}: switched from .* to Claude · ${handSignedAccount} · .* after a usage limit; resuming`), 'the retry kick moved it');
    const secondPlan = listLimitPlanLines(k)[1];
    assert.ok(secondPlan.includes(`usage limit on Claude · ${handSignedAccount} · `) && secondPlan.endsWith('switch plan: none'), `planned again from the adopted account, which is back first again: ${secondPlan}`);
    await waitFor(`${earliestIssueKey}: the requester told the new time`, answerTimeoutMs, () => readLimitNotices(issue).some((told) => told.clock === formatClockIn(told.zone, refusedResetMs)));
    await waitFor('the new wait persisted to state.json', answerTimeoutMs, () => readPersistedState(getLayout()).apiRetries?.[k]?.fireAt === refusedResetMs + resetBufferMs);
    assert.equal(readPersistedState(getLayout()).apiRetries?.[k]?.resumeOn, undefined, 'it stays on the account it is on');
    await new Promise((resolve) => setTimeout(resolve, noRetryQuietMs));
    assert.equal(getAllAgentTurns(getLayout()).length, turnsAfterRefusal, 'no retry before the new reset');

    // The resume's «continue» names no request: the answer follows the wake-up engine's reminder, as after the first issue's move.
    await waitFor(`${earliestIssueKey}: answered on ${handSignedAccount} after the new reset and handed back`, refusedResetMs + resetBufferMs + resumeTimeoutMs - Date.now(), () =>
      issue.assignee?.accountId === requester.accountId && getCommentTexts(issue).some((text) => text.includes(`Fake final answer for ${earliestIssueKey}`)));
    const answeringTurn = getTurns(earliestIssueKey).at(-1);
    assert.equal(getSessionLaunches(getLayout()).filter((launch) => launch.pid === answeringTurn?.pid).at(-1)?.claudeConfigDir, adoptedDir, 'the answer came from the adopted account');
  });

  it('with auto switch OFF the next issue\'s agent hits the same limit and WAITS: the requester is told in a comment, nothing moves', async () => {
    await restartWithState((persisted) => {
      persisted.claudeAutoSwitchOnLimitEnabled = false;
    });
    const launchesBefore = getSessionLaunches(getLayout()).length;
    createLimitIssue(waitingIssueKey);
    handIssueToAi(waitingIssueKey, requester);
    const issue = fakeJira.getIssue(waitingIssueKey);

    await waitFor(`${waitingIssueKey}: the wait announced to the requester`, answerTimeoutMs, () => getCommentTexts(issue).some((text) => /Usage limit reached/.test(text)));
    const output = getCharness().output;
    assert.match(output, new RegExp(`\\[fallback\\] ${keyToString(makeJiraKey(waitingIssueKey))}: usage limit on .*; switch plan: none`));
    // Quiet for a while: no switch is made behind the announcement.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    assert.equal(getTurns(waitingIssueKey).length, 1, 'the turn that hit the limit is the only one');
    const newLaunches = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.ok(newLaunches.length >= 1, 'the issue\'s agent was started');
    assert.ok(newLaunches.every((launch) => launch.claudeConfigDir === null), 'nothing was started under the adopted account');
    assert.equal(issue.assignee?.accountId !== requester.accountId, true, 'the issue stays with the AI until the wait is over');
  });

  it('switched OFF while a wait is aimed at the adopted account, the issue stays when that wait ends and waits again for its own account', async () => {
    const k = keyToString(makeJiraKey(waitingIssueKey));
    const launchesBefore = getSessionLaunches(getLayout()).length;
    // Saved the way a wait aimed at the adopted account is saved while the switch is ON — and already due, so the boot fires it.
    await restartWithState((persisted) => {
      const retry = persisted.apiRetries?.[k];
      assert.ok(retry, `${waitingIssueKey} waits for its limit`);
      persisted.apiRetries = { ...persisted.apiRetries, [k]: { ...retry, fireAt: Date.now(), resumeOn: { backend: 'claude', profile: handSignedAccount, model: null } } };
    });
    const turnsBefore = getAllAgentTurns(getLayout()).length;

    await waitFor(`${waitingIssueKey}: the wait armed again for its own account`, answerTimeoutMs, () => getCharness().output.includes(`[fallback] ${k}: auto switch is off now`));
    const ownBackIso = readPersistedState(getLayout()).claudeProfiles?.[exhaustedAccount]?.limitedUntil;
    assert.ok(ownBackIso, 'the issue\'s own account is marked limited');
    await waitFor('the new wait persisted to state.json', answerTimeoutMs, () => {
      const retry = readPersistedState(getLayout()).apiRetries?.[k];
      return retry?.fireAt === Date.parse(ownBackIso) + resetBufferMs && retry.resumeOn === undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, noRetryQuietMs));
    assert.equal(getAllAgentTurns(getLayout()).length, turnsBefore, 'no resume into the limit');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'nothing started: not under the adopted account, not on its own');
  });

  it('the launches carried the Jira flags, and an account\'s directory is the only variable a launch adds to the allowlist', () => {
    const launches = readFakeLog<{ argv: string[]; isSessionLaunch: boolean; envNames: string[]; claudeConfigDir: string | null }>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(launches.some((launch) => launch.claudeConfigDir !== null), 'a launch under an account\'s directory');
    for (const launch of launches) {
      for (const flag of requiredJiraSessionFlags) assert.ok(checkHasFlag(launch.argv, flag), `${flag.join(' ')} in ${launch.argv.join(' ')}`);
      assert.deepEqual(getForeignAgentEnvNames(launch.envNames), [], 'nothing but the allowlist');
      assert.equal(launch.envNames.includes('CLAUDE_CONFIG_DIR'), launch.claudeConfigDir !== null, 'the directory only where an account has one');
    }
  });

  itReachedNoTelegramPath();
});

/** The one-shot calls of the fake `claude` (`auth status`, `--version`), with the directory each ran under. */
function listAuthStatusProbes(): Array<{ argv: string[]; claudeConfigDir: string | null }> {
  return readFakeLog<{ argv: string[]; isSessionLaunch: boolean; claudeConfigDir: string | null }>(fakeClaudeLogFileNames.launches)
    .filter((launch) => !launch.isSessionLaunch && launch.argv.includes('auth') && launch.argv.includes('status'));
}

/** The `[fallback]` plan lines of the conversation `conversationKey`, one per usage limit it hit, oldest first. */
function listLimitPlanLines(conversationKey: string): string[] {
  return getCharness().output.split('\n').filter((line) => line.includes(`[fallback] ${conversationKey}: usage limit on `)).map((line) => line.trimEnd());
}

/** The limit notices on the issue (an edit of one replaces its text): the clock the answer is promised for and the zone it is in. */
function readLimitNotices(issue: FakeJiraIssue): Array<{ clock: string; zone: string; text: string }> {
  return getCommentTexts(issue).flatMap((text) => {
    const match = /the answer will come after (?:\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}) ([^\s]+?)\./.exec(text);
    return match ? [{ clock: match[1], zone: match[2], text }] : [];
  });
}

/** `HH:MM` of an instant in the time zone `zone`, as the bot words a reset for a tracker (the zone named after it). */
function formatClockIn(zone: string, epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epochMs);
}

/** What the instance logged about limits, switches and the issues of the flow — the evidence a failed step needs. */
function listLimitLogLines(): string[] {
  return getCharness().output.split('\n').filter((line) => /\[fallback\]|\[apiRetry\]|\[limit|usage limit|PROJ-5\d|\[accounts\]|\[usage\]/.test(line)).slice(-60);
}
