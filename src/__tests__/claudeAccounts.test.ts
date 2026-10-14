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
 *   • `remove`: default refused, the instance default refused, otherwise the picks that named it are dropped;
 *   • the auto-switch-on-limit toggle (OFF by default; its screen is /limits now): `autoswitch on|off` and the old buttons still work,
 *     General sets the instance default; a «switch to …» tap on a limit notice goes to its port and consumes the
 *     notice, a stale one only answers the callback.
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
let openCodeProviders: string[] = [];
const disconnected: Array<{ key: SessionKey; providerId: string }> = [];
const startedConnects: Array<{ key: SessionKey; providerId: string }> = [];
const startedLogins: Array<{ key: SessionKey; profile: ClaudeLoginProfile }> = [];
/** What the stand-in `claude auth status` answers per config dir (`null` key = the default profile). */
const statusByDir = new Map<string | null, ClaudeAuthStatus | null>();

function setStatus(configDir: string | null, status: ClaudeAuthStatus | null): void {
  statusByDir.set(configDir, status);
}

describe('claudeAccounts: /accounts over its ports', () => {
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
      detectOpenCodeProviders: async () => openCodeProviders,
      disconnectOpenCodeProvider: async (key, providerId) => {
        disconnected.push({ key, providerId });
      },
      startOpenCodeConnect: async (key, providerId) => {
        startedConnects.push({ key, providerId });
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

  it('registers /account and /accounts (the hidden alias and the menu name) and the buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['account', 'accounts']);
    assert.deepEqual(harness.registeredActionPatterns, [
      String(/^acct_use_([a-z0-9][a-z0-9_-]{0,31})$/),
      'acct_follow',
      'acct_add',
      'acct_ocadd',
      String(/^acct_dc_(\d{1,2})$/),
      String(/^acct_dcok_(\d{1,2})$/),
      'acct_login_menu',
      'acct_rm_menu',
      'acct_back',
      String(/^acct_login_([a-z0-9][a-z0-9_-]{0,31})$/),
      String(/^acct_rm_([a-z0-9][a-z0-9_-]{0,31})$/),
      String(/^acct_rmok_([a-z0-9][a-z0-9_-]{0,31})$/),
      'acct_autosw_on',
      'acct_autosw_off',
    ]);
  });

  it('the bare command renders the picker: default alone, active, with the action row', async () => {
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /✓ default — me@example\.com, personal max/);
    assert.deepEqual(harness.getKeyboardData(picker), [
      ['acct_use_default', 'acct_login_default'],
      ['acct_add', 'acct_ocadd'],
    ], 'one row per account (pick + re-login; `default` has no remove), then the two adders');
    assert.match(picker?.text ?? '', /OpenCode providers: none connected yet/);
    // The default's probe lands on its hidden record (the usage ranking and the CLI twin read it there), never on the registry.
    assert.equal(harness.state.getClaudeProfileInfo('default')?.email, 'me@example.com');
    assert.equal(harness.state.getClaudeProfileRecord('default'), undefined);
    assert.deepEqual(Object.keys(harness.state.getClaudeProfileRecords()), []);
    assert.match(picker?.text ?? '', /Usage: % of each window used/);
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
    assert.deepEqual(harness.getKeyboardData(picker)[0], ['acct_use_default', 'acct_login_default']);
    assert.deepEqual(harness.getKeyboardData(picker)[1], ['acct_use_work', 'acct_login_work', 'acct_rm_work']);
    assert.deepEqual(harness.getKeyboardData(picker)[2], ['acct_use_team', 'acct_login_team', 'acct_rm_team']);
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
    await harness.tapButton(picker!.messageId!, 'acct_rm_menu'); // the old sub-picker still answers
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['acct_rm_work'], ['acct_rm_team'], ['acct_back']]);
    await harness.tapButton(picker!.messageId!, 'acct_rm_team'); // the same data the row's 🗑 sends
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

  it('the auto-switch setting moved to /limits: the picker has no toggle button, only a pointer; the old buttons and the text verb still work', async () => {
    assert.equal(harness.state.checkIsClaudeAutoSwitchOnLimitEnabled(harness.key), false);
    await harness.runCommand('account');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /\/limits/);
    assert.equal(harness.getKeyboardData(picker).some((row) => row[0].startsWith('acct_autosw_')), false);
    await harness.tapButton(picker!.messageId!, 'acct_autosw_on'); // an old keyboard
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), true);
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), false, 'a topic tap never touches the instance default');
    await harness.runCommand('account', 'autoswitch off');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), false);
    assert.match(harness.replies.at(-1)?.text ?? '', /Auto-switch to another account on a usage limit: OFF for this topic/);
    await harness.runCommand('account', 'autoswitch maybe');
    assert.match(harness.replies.at(-1)?.text ?? '', /^Usage: /);
  });

  it('the OpenCode part: connected providers are listed with a 🔌 row each; the tap asks first and only the confirmation disconnects', async () => {
    openCodeProviders = ['openai', 'openrouter'];
    await harness.runCommand('accounts');
    const screen = harness.replies.at(-1)!;
    assert.match(screen.text ?? '', /OpenCode providers \(connected\):\n• openai\n• openrouter/);
    const rows = harness.getKeyboardData(screen);
    assert.deepEqual(rows.filter((row) => row[0].startsWith('acct_dc_')), [['acct_dc_0'], ['acct_dc_1']]);
    assert.deepEqual(rows.at(-1)?.slice(-2), ['acct_add', 'acct_ocadd']);
    await harness.tapButton(screen.messageId!, 'acct_dc_1');
    assert.match(harness.edits.at(-1)?.text ?? '', /Disconnect openrouter\?/);
    assert.deepEqual(disconnected, [], 'asking disconnects nothing');
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['acct_dcok_1'], ['acct_back']]);
    await harness.tapButton(screen.messageId!, 'acct_dcok_1');
    assert.deepEqual(disconnected, [{ key: harness.key, providerId: 'openrouter' }]);
    assert.equal(harness.getKeyboardData(harness.edits.at(-1)).some((row) => row[0] === 'acct_dc_0'), true, 'the screen is re-rendered in place');
  });

  it('a disconnect tap on a message with no provider snapshot (or an index past it) only re-renders', async () => {
    const stray = (await harness.core.replyToThread(harness.key, 'an old screen'))!;
    const editsBefore = harness.edits.length;
    await harness.tapButton(stray, 'acct_dcok_0');
    assert.equal(disconnected.length, 1, 'nothing more was disconnected');
    assert.equal(harness.edits.length, editsBefore + 1);
  });

  it('«➕ OpenCode provider» arms a provider-id capture: the next plain message starts the /connect flow for it; a bad id keeps it armed; /esc-style cancel disarms', async () => {
    await harness.runCommand('accounts');
    const screen = harness.replies.at(-1)!;
    await harness.tapButton(screen.messageId!, 'acct_ocadd');
    assert.match(harness.replies.at(-1)?.text ?? '', /Which OpenCode provider\?/);
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), true);
    await accounts.submitProfileName(harness.key, 'bad!id');
    assert.match(harness.replies.at(-1)?.text ?? '', /Invalid provider id/);
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), true);
    await accounts.submitProfileName(harness.key, ' OpenRouter ');
    assert.deepEqual(startedConnects, [{ key: harness.key, providerId: 'openrouter' }]);
    assert.equal(accounts.checkIsAwaitingProfileName(harness.key), false);
    await harness.tapButton(screen.messageId!, 'acct_ocadd');
    assert.equal(accounts.cancelProfileNameCapture(harness.key), true);
  });

  it('«➕ Claude account» still arms the profile-name capture, not the provider one', async () => {
    await harness.runCommand('accounts');
    await harness.tapButton(harness.replies.at(-1)!.messageId!, 'acct_add');
    assert.match(harness.replies.at(-1)?.text ?? '', /Name for the new profile/);
    const before = startedConnects.length;
    await accounts.submitProfileName(harness.key, 'bad name!');
    assert.match(harness.replies.at(-1)?.text ?? '', /lowercase letters/);
    assert.equal(startedConnects.length, before);
    accounts.cancelProfileNameCapture(harness.key);
  });

  it('a provider list that cannot be read leaves the Claude half of the screen intact', async () => {
    openCodeProviders = [];
    await harness.runCommand('accounts');
    assert.match(harness.replies.at(-1)?.text ?? '', /none connected yet/);
  });

  it('in General the toggle sets the instance default', async () => {
    isGeneralTopic = true;
    await harness.runCommand('account', 'autoswitch on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), true);
    assert.match(harness.replies.at(-1)?.text ?? '', /ON for ALL topics/);
    await harness.runCommand('account', 'autoswitch off');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), false);
    isGeneralTopic = false;
  });
});
