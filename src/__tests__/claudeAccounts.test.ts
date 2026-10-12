/**
 * @description `/account` (`connectors/telegram/commands/claudeAccounts.ts`) wired to ports (`commandModuleHarness.ts`:
 * a real telegraf instance against the fake Bot API, the real state store, recording topic sends) with a
 * stand-in status probe, sign-in driver and session mover. Pinned:
 *
 *   • WIRING — the command (and its alias) and the buttons it registers, in order;
 *   • the picker: default first, ✓ on the active profile, one button per profile, the action row;
 *   • `add <name>`: the directory and its links, the registry record, the sign-in started under that directory;
 *   • «Add» without a name arms the name capture; the next message is the name, `/esc`-style cancel disarms it;
 *   • `use <name>` in a topic sets the pick and moves the live session (the apply port's outcome is reported);
 *     in General it sets the instance default and moves every session; a logged-out profile is refused;
 *   • `remove`: default refused, the instance default refused, otherwise the picks that named it are dropped.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createClaudeAccounts, type ClaudeProfileApplyOutcome } from '../connectors/telegram/commands/claudeAccounts';
import type { ClaudeLoginProfile } from '../agentLogin/agentLogin';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import type { ClaudeAuthStatus } from '../utils/claudeProfiles';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
let accounts: ReturnType<typeof createClaudeAccounts>;
let dataDir: string;
let homeClaudeDir: string;
let isGeneralTopic = false;
let applyOutcome: ClaudeProfileApplyOutcome = 'inactive';
const appliedKeys: SessionKey[] = [];
let applyEverywhereCalls = 0;
const startedLogins: Array<{ key: SessionKey; profile: ClaudeLoginProfile }> = [];
/** What the stand-in `claude auth status` answers per config dir (`null` key = the default profile). */
const statusByDir = new Map<string | null, ClaudeAuthStatus | null>();

function setStatus(configDir: string | null, status: ClaudeAuthStatus | null): void {
  statusByDir.set(configDir, status);
}

describe('claudeAccounts: /account over its ports', () => {
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
    homeClaudeDir = path.join(dataDir, 'fake-home', '.claude');
    fs.mkdirSync(homeClaudeDir, { recursive: true });
    harness = await createCommandHarness();
    setStatus(null, { loggedIn: true, email: 'me@example.com', subscriptionType: 'max', orgName: null });
    accounts = createClaudeAccounts({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      getDataDir: () => dataDir,
      getInstanceTimezone: () => 'UTC',
      refreshClaudeUsage: async () => {},
      readClaudeAuthStatus: async (configDir) => statusByDir.get(configDir) ?? null,
      startClaudeProfileLogin: async (key, profile) => {
        startedLogins.push({ key, profile });
      },
      applyClaudeProfile: async (key) => {
        appliedKeys.push(key);
        return applyOutcome;
      },
      applyClaudeProfileEverywhere: async () => {
        applyEverywhereCalls += 1;
      },
    });
    accounts.registerClaudeAccountCommands();
    accounts.registerClaudeAccountCallbacks();
    // The layout helper links into the real `~/.claude` unless told otherwise; point HOME at the fixture.
    process.env.HOME = path.dirname(homeClaudeDir);
  });

  after(async () => {
    await harness.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers /account (+ /accounts) and its buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['account', 'accounts']);
    assert.deepEqual(harness.registeredActionPatterns, [
      String(/^acct_use_([a-z0-9][a-z0-9_-]{0,31})$/),
      'acct_follow',
      'acct_add',
      'acct_login_menu',
      'acct_rm_menu',
      'acct_back',
      String(/^acct_login_([a-z0-9][a-z0-9_-]{0,31})$/),
      String(/^acct_rm_([a-z0-9][a-z0-9_-]{0,31})$/),
      String(/^acct_rmok_([a-z0-9][a-z0-9_-]{0,31})$/),
    ]);
  });

  it('the bare command renders the picker: default alone, active, with the action row', async () => {
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /✓ default — me@example\.com, personal max/);
    assert.deepEqual(harness.getKeyboardData(picker), [
      ['acct_use_default'],
      ['acct_add', 'acct_login_menu', 'acct_rm_menu'],
    ]);
  });

  it('`add <name>` lays the directory out, records the profile and starts its sign-in under that directory', async () => {
    await harness.runCommand('account', 'add Work');
    const dir = path.join(dataDir, 'claude-profiles', 'work');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(homeClaudeDir, 'projects'));
    assert.equal(harness.state.getClaudeProfileRecord('work')?.loggedIn, false);
    assert.deepEqual(startedLogins.at(-1), { key: harness.key, profile: { name: 'work', configDir: dir } });
    assert.match(harness.replies.at(-1)?.text ?? '', /Profile work created/);
  });

  it('a second `add` of the same name is refused; an invalid name is refused', async () => {
    const before = startedLogins.length;
    await harness.runCommand('account', 'add work');
    assert.match(harness.replies.at(-1)?.text ?? '', /already exists/);
    await harness.runCommand('account', 'add Bad Name');
    assert.match(harness.replies.at(-1)?.text ?? '', /lowercase letters/);
    assert.equal(startedLogins.length, before);
  });

  it('the sign-in driver\'s status report lands on the record and moves the sessions that already picked it', async () => {
    const dir = path.join(dataDir, 'claude-profiles', 'work');
    const status: ClaudeAuthStatus = { loggedIn: true, email: 'work@example.com', subscriptionType: 'team', orgName: 'Example Org' };
    setStatus(dir, status);
    const callsBefore = applyEverywhereCalls;
    await accounts.onClaudeProfileAuthStatus(harness.key, { name: 'work', configDir: dir }, status);
    assert.equal(harness.state.getClaudeProfileRecord('work')?.email, 'work@example.com');
    assert.equal(applyEverywhereCalls, callsBefore + 1);
  });

  it('«Add» without a name arms the name capture; the next plain message is the name; a slash cancels it', async () => {
    await harness.runCommand('account', 'add');
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), true);
    assert.equal(accounts.cancelProfileNameCapture(harness.key), true);
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), false);
    await harness.runCommand('account', 'add');
    await accounts.submitProfileName(harness.key, 'Nope Name');
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), true, 'a bad name keeps the prompt armed');
    await accounts.submitProfileName(harness.key, 'team');
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), false);
    assert.equal(harness.state.getClaudeProfileRecord('team') !== undefined, true);
    assert.equal(startedLogins.at(-1)?.profile.name, 'team');
  });

  it('the picker now lists both, buttons bake the names, and a logged-out profile says so', async () => {
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /• work — work@example\.com, corporate team/);
    assert.match(picker?.text ?? '', /• team — not signed in/);
    assert.deepEqual(harness.getKeyboardData(picker)[0], ['acct_use_default']);
    assert.deepEqual(harness.getKeyboardData(picker)[1], ['acct_use_work']);
    assert.deepEqual(harness.getKeyboardData(picker)[2], ['acct_use_team']);
  });

  it('`use` of a logged-out profile is refused; `use work` in a topic sets the pick and reports the apply outcome', async () => {
    const teamDir = path.join(dataDir, 'claude-profiles', 'team');
    setStatus(teamDir, { loggedIn: false, email: null, subscriptionType: null, orgName: null });
    await harness.runCommand('account', 'use team');
    assert.match(harness.replies.at(-1)?.text ?? '', /not signed in/);
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), undefined);

    applyOutcome = 'respawned';
    await harness.runCommand('account', 'use work');
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), 'work');
    assert.deepEqual(appliedKeys.at(-1), harness.key);
    assert.match(harness.replies.at(-1)?.text ?? '', /account for this topic: work\. The running session was restarted/);
  });

  it('a tap on a profile button is the same switch, and the picker re-renders in place with ✓ moved', async () => {
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardData(picker).at(-1), ['acct_follow'], 'a topic with its own pick offers «follow the default»');
    applyOutcome = 'deferred';
    await harness.tapButton(picker!.messageId!, 'acct_use_default');
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), 'default');
    const rerender = harness.edits.at(-1);
    assert.equal(rerender?.messageId, picker!.messageId);
    assert.match(rerender?.text ?? '', /✓ default/);
    await harness.tapButton(picker!.messageId!, 'acct_follow');
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), undefined);
  });

  it('in General, `use` sets the instance default and moves every session', async () => {
    isGeneralTopic = true;
    const callsBefore = applyEverywhereCalls;
    await harness.runCommand('account', 'use work');
    assert.equal(harness.state.getClaudeProfileGlobalDefault(), 'work');
    assert.equal(applyEverywhereCalls, callsBefore + 1);
    assert.match(harness.replies.at(-1)?.text ?? '', /Default Claude account for ALL topics: work/);
    isGeneralTopic = false;
  });

  it('`remove`: the default profile and the instance default are refused', async () => {
    await harness.runCommand('account', 'remove default');
    assert.match(harness.replies.at(-1)?.text ?? '', /cannot be removed/);
    await harness.runCommand('account', 'remove work');
    assert.match(harness.replies.at(-1)?.text ?? '', /default for all topics/);
    assert.ok(fs.existsSync(path.join(dataDir, 'claude-profiles', 'work')));
  });

  it('`remove` of a picked profile drops the picks (counted) and the directory, through the confirm button too', async () => {
    const teamDir = path.join(dataDir, 'claude-profiles', 'team');
    setStatus(teamDir, { loggedIn: true, email: 'team@example.com', subscriptionType: 'pro', orgName: null });
    await harness.runCommand('account', 'use team');
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), 'team');
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    await harness.tapButton(picker!.messageId!, 'acct_rm_menu');
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['acct_rm_work'], ['acct_rm_team'], ['acct_back']]);
    await harness.tapButton(picker!.messageId!, 'acct_rm_team');
    assert.match(harness.edits.at(-1)?.text ?? '', /Remove profile team \(team@example\.com\)\? .* 1 topic/);
    const callsBefore = applyEverywhereCalls;
    await harness.tapButton(picker!.messageId!, 'acct_rmok_team');
    assert.equal(harness.state.getClaudeProfileRecord('team'), undefined);
    assert.equal(harness.state.getClaudeProfileOverride(harness.key), undefined, 'the pick that named it is dropped');
    assert.equal(fs.existsSync(teamDir), false);
    assert.equal(applyEverywhereCalls, callsBefore + 1);
    assert.doesNotMatch(harness.edits.at(-1)?.text ?? '', /team —/, 'the picker re-rendered without it');
    assert.equal(keyToString(appliedKeys[0]), keyToString(harness.key));
  });
});
