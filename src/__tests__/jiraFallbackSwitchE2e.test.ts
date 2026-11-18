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
 *   → with auto switch OFF (as an operator left it) the next issue's agent hits the same limit and WAITS: the requester is told in a
 *     comment, nothing moves, nobody switches
 *   → the launches carried the Jira flags and the allowlist (a launch under an account's directory adds `CLAUDE_CONFIG_DIR` — a path,
 *     the one variable an account adds — and only there), and no Telegram path was reached
 *
 * What the unit tests cover instead: the scan (`claudeProfileSync.test.ts`) and the decision per kind of conversation, with an account
 * free, none free, auto switch OFF, a chain with OpenCode rungs (`limitSwitchPlan.test.ts`).
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
import {
  checkHasFlag,
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
const takeoverDaysAhead = 2;

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
    const persisted = readPersistedState(getLayout());
    assert.equal(persisted.claudeProfileOverrides?.[keyToString(makeJiraKey(limitIssueKey))], handSignedAccount, 'the issue now follows the adopted account');
    assert.equal(persisted.claudeProfiles?.[exhaustedAccount]?.limitedUntil, resetsAtIso, 'the exhausted account is marked limited until the reset the error named');
    const output = getCharness().output;
    assert.match(output, new RegExp(`\\[fallback\\] ${keyToString(makeJiraKey(limitIssueKey))}: usage limit on .*; switch plan: auto → .*${handSignedAccount}`));
    assert.match(output, new RegExp(`\\[fallback\\] ${keyToString(makeJiraKey(limitIssueKey))}: switched from .* after a usage limit; resuming`));
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

/** What the instance logged about limits, switches and the issues of the flow — the evidence a failed step needs. */
function listLimitLogLines(): string[] {
  return getCharness().output.split('\n').filter((line) => /\[fallback\]|\[apiRetry\]|\[limit|usage limit|PROJ-5\d|\[accounts\]|\[usage\]/.test(line)).slice(-60);
}
