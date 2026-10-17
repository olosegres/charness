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
import { signOutDefaultClaudeLogin, type ClaudeAuthStatus } from '../utils/claudeProfiles';
import type { FallbackChainEntry } from '../utils/fallbackChain';
import type { BackendFamily } from '../utils/backendSwitchPlan';
import type { OperatorSwitchOutcome } from '../utils/operatorSwitchPlan';
import { t } from '../i18n';
import { buildClaudeProfileUsageViews } from '../utils/claudeUsage';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

/** A test sets it to make the stand-in `applyAutoSwitch` word its answer differently (a long one). */
let autoSwitchWordingOverride: string | null = null;
let harness: CommandHarness;
let accounts: ReturnType<typeof createClaudeAccounts>;
let dataDir: string;
let homeClaudeDir: string;
let isGeneralTopic = false;
let applyOutcome: ClaudeProfileApplyOutcome = 'inactive';
const appliedKeys: SessionKey[] = [];
let applyEverywhereCalls = 0;
/**
 * What the stand-in bot answers when a rung is picked on a topic: `null` = the topic runs Claude (the pick is recorded and
 * applied, `applyOutcome` says how), else the outcome of a pick that crosses to Claude from OpenCode (`asked` / `switched`).
 */
let operatorSwitchOutcome: OperatorSwitchOutcome | null = null;
const operatorSwitches: Array<{ key: SessionKey; to: FallbackChainEntry }> = [];
let openCodeProviders: string[] = [];
/** The catalog behind a provider's model page (`provider/model` labels). */
let openCodeModels: string[] = [];
/** Where the stand-in bot says the topic runs: `family` null = no agent. */
let topicRun: { family: BackendFamily | null; rung: FallbackChainEntry | null } = { family: null, rung: null };
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
      switchTopicByOperator: async (key, to) => {
        operatorSwitches.push({ key, to });
        if (operatorSwitchOutcome) return operatorSwitchOutcome;
        if (to.backend !== 'claude') return { kind: 'switched', text: `Model: ${to.providerId}/${to.modelId}` };
        await harness.state.setClaudeProfileOverride(key, to.profile);
        appliedKeys.push(key);
        return { kind: 'switched', text: t('account.setThisTopic', { name: to.profile, apply: t(`account.applied.${applyOutcome}`) }) };
      },
      detectOpenCodeProviders: async () => openCodeProviders,
      listOpenCodeModels: async () => openCodeModels,
      getTopicRun: () => topicRun,
      disconnectOpenCodeProvider: async (key, providerId) => {
        disconnected.push({ key, providerId });
      },
      startOpenCodeConnect: async (key, providerId) => {
        startedConnects.push({ key, providerId });
      },
      // The setting is `/limits`'s (`fallbackChain.ts`); here a stand-in writes the same state and words it tersely.
      applyAutoSwitch: async (key, isGeneral, enabled) => {
        if (isGeneral) await harness.state.setClaudeAutoSwitchOnLimitGlobalDefault(enabled);
        else await harness.state.setClaudeAutoSwitchOnLimitOverride(key, enabled);
        return autoSwitchWordingOverride ?? `auto switch ${enabled ? 'ON' : 'OFF'} for ${isGeneral ? 'ALL topics' : 'this topic'}`;
      },
      // The default login lives in the fixture's `.claude`, never in the real one.
      getHomeClaudeDir: () => homeClaudeDir,
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
      String(/^acct_dcre_(\d{1,2})$/),
      String(/^acct_ocuse_(\d{1,2})$/),
      String(/^acct_ocpg_(\d{1,3})$/),
      String(/^acct_ocm_(\d{1,3})$/),
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
      ['acct_use_default', 'acct_login_default', 'acct_rm_default'],
      ['acct_add', 'acct_ocadd'],
    ], 'one row per account (pick + re-login + remove, `default` included), then the two adders');
    assert.match(picker?.text ?? '', /OpenCode providers: none connected yet/);
    // The default's probe lands on its hidden record (the usage ranking and the CLI twin read it there), never on the registry.
    assert.equal(harness.state.getClaudeProfileInfo('default')?.email, 'me@example.com');
    assert.equal(harness.state.getClaudeProfileRecord('default'), undefined);
    assert.deepEqual(Object.keys(harness.state.getClaudeProfileRecords()), []);
    assert.match(picker?.text ?? '', /Usage: % of each window used/);
    assert.match(picker?.text ?? '', /Tap an account or a provider to switch this topic to it .*🔑 .*🗑 .*🔌 disconnects a provider/);
  });

  it('a polled profile\'s windows hang under its row (the renderer `/limits` shares): 5h / week with relative resets and no arrow, Fable left out when the account has no such window, the stale mark and the limit mark', async () => {
    const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000 + 30_000).toISOString();
    harness.state.setClaudeProfileUsage('default', {
      fetchedAt: new Date().toISOString(),
      source: 'api',
      isStale: true,
      buckets: [
        { kind: 'session', percent: 5, resetsAt: inHours(4), scopeModel: null },
        { kind: 'weekly_all', percent: 20, resetsAt: inHours(5 * 24 + 8), scopeModel: null },
      ],
    });
    harness.state.setClaudeProfileLimitedUntil('default', inHours(2));
    await harness.runCommand('account');
    const text = harness.replies.at(-1)?.text ?? '';
    assert.match(text, /✓ default — me@example\.com, personal max\n {4}⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h \(stale\)\n {4}⛔ at its limit until /);
    assert.doesNotMatch(text, /Fable \d|Fable —/, 'no Fable window → nothing about Fable on the line');
    assert.ok(text.indexOf('Usage: % of each window used') < text.indexOf('OpenCode providers'), 'the usage hint (the percentages are USED) sits right after the account list');
    harness.state.setClaudeProfileLimitedUntil('default', null);
    await harness.state.upsertClaudeProfileRecord('default', { usage: undefined });
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
    assert.deepEqual(harness.getKeyboardData(picker)[0], ['acct_use_default', 'acct_login_default', 'acct_rm_default']);
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

  it('on a topic that runs OpenCode a pick is a switch to Claude: the bot decides (`switchTopicByOperator`), an «asked» pick records nothing and posts no confirmation line', async () => {
    await harness.state.setClaudeProfileOverride(harness.key, null);
    operatorSwitches.length = 0;
    operatorSwitchOutcome = { kind: 'asked' };
    try {
      const repliesBefore = harness.replies.length;
      await harness.runCommand('account', 'use work');
      assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'claude', profile: 'work', model: null } }]);
      assert.equal(harness.state.getClaudeProfileOverride(harness.key), undefined, 'the pick waits for the operator\'s answer');
      assert.equal(harness.replies.length, repliesBefore, 'the question is the port\'s own message — nothing else is posted');

      await harness.runCommand('account');
      const picker = harness.replies.at(-1);
      await harness.tapButton(picker!.messageId!, 'acct_use_work');
      assert.deepEqual(operatorSwitches.at(-1), { key: harness.key, to: { backend: 'claude', profile: 'work', model: null } });
      assert.equal(harness.state.getClaudeProfileOverride(harness.key), undefined, 'a tap is the same switch');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '', 'the tap is answered with no toast');
    } finally {
      operatorSwitchOutcome = null;
    }
  });

  it('a topic on OpenCode with nothing to hand over switches at once: the port\'s line is the confirmation, typed and tapped', async () => {
    operatorSwitches.length = 0;
    operatorSwitchOutcome = { kind: 'switched', text: '🔁 Switched this topic to Claude «work».' };
    try {
      await harness.runCommand('account', 'use work');
      assert.equal(harness.replies.at(-1)?.text, '🔁 Switched this topic to Claude «work».');

      await harness.runCommand('account');
      const picker = harness.replies.at(-1);
      await harness.tapButton(picker!.messageId!, 'acct_use_work');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '🔁 Switched this topic to Claude «work».');
      assert.equal(operatorSwitches.length, 2);
    } finally {
      operatorSwitchOutcome = null;
    }
  });

  it('a profile that is not signed in is refused before the OpenCode port is asked, and General never asks it', async () => {
    operatorSwitches.length = 0;
    operatorSwitchOutcome = { kind: 'asked' };
    try {
      await harness.runCommand('account', 'use team');
      assert.match(harness.replies.at(-1)?.text ?? '', /not signed in/);
      isGeneralTopic = true;
      await harness.runCommand('account', 'use work');
      isGeneralTopic = false;
      assert.deepEqual(operatorSwitches, []);
    } finally {
      isGeneralTopic = false;
      operatorSwitchOutcome = null;
    }
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

  it('`remove`: the instance default is refused', async () => {
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
    assert.match(harness.replies.at(-1)?.text ?? '', /auto switch OFF for this topic/, 'the verb goes through the /limits port');
    await harness.runCommand('account', 'autoswitch maybe');
    assert.match(harness.replies.at(-1)?.text ?? '', /^Usage: /);
  });

  it('a tap\'s confirmation reaches the user whole: as the toast when it fits, else cut for the toast and posted in full as a message', async () => {
    await harness.runCommand('account');
    const picker = harness.replies.at(-1)?.messageId;
    assert.ok(picker);
    try {
      autoSwitchWordingOverride = 'The short confirmation.';
      let repliesBefore = harness.replies.length;
      await harness.tapButton(picker, 'acct_autosw_on');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The short confirmation.');
      assert.equal(harness.replies.length, repliesBefore, 'a toast that fits needs no message');

      autoSwitchWordingOverride = `Switching on limit is on. ${'Every account that has room is tried before the wait. '.repeat(8)}`.trimEnd();
      assert.ok(autoSwitchWordingOverride.length > 200, 'precondition: longer than a toast holds');
      repliesBefore = harness.replies.length;
      await harness.tapButton(picker, 'acct_autosw_on');
      const toast = harness.fakeTelegram.callbackAnswers.at(-1) ?? '';
      assert.ok(toast.length <= 200 && toast.endsWith('…') && autoSwitchWordingOverride.startsWith(toast.slice(0, -1)), 'the toast is the start of the text, cut to fit');
      assert.equal(harness.replies[repliesBefore]?.text, autoSwitchWordingOverride, 'the whole text, as a message');
    } finally {
      autoSwitchWordingOverride = null;
    }
  });

  it('the OpenCode part: a topic\'s provider row is [pick] [🔑] [🔌]; the 🔌 asks first and only the confirmation disconnects', async () => {
    openCodeProviders = ['openai', 'openrouter'];
    await harness.runCommand('accounts');
    const screen = harness.replies.at(-1)!;
    assert.match(screen.text ?? '', /OpenCode providers \(connected\):\n• openai\n• openrouter/);
    const rows = harness.getKeyboardData(screen);
    assert.deepEqual(rows.filter((row) => row[0].startsWith('acct_ocuse_')), [['acct_ocuse_0', 'acct_dcre_0', 'acct_dc_0'], ['acct_ocuse_1', 'acct_dcre_1', 'acct_dc_1']], 'a provider row mirrors an account row: pick, 🔑 connect again, 🔌 disconnect');
    assert.deepEqual(harness.getKeyboardLabels(screen).find((row) => row.some((label) => label.includes('openrouter'))), ['openrouter', '🔑', '🔌'], 'the pick names the provider; the two icons are the same as an account row\'s');
    assert.deepEqual(rows.at(-1)?.slice(-2), ['acct_add', 'acct_ocadd']);
    await harness.tapButton(screen.messageId!, 'acct_dc_1');
    assert.match(harness.edits.at(-1)?.text ?? '', /Disconnect openrouter\?/);
    assert.deepEqual(disconnected, [], 'asking disconnects nothing');
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['acct_dcok_1'], ['acct_back']]);
    await harness.tapButton(screen.messageId!, 'acct_dcok_1');
    assert.deepEqual(disconnected, [{ key: harness.key, providerId: 'openrouter' }]);
    assert.equal(harness.getKeyboardData(harness.edits.at(-1)).some((row) => row[0] === 'acct_ocuse_0'), true, 'the screen is re-rendered in place');
  });

  it('in General a provider row stays connect / disconnect only: [🔌 Disconnect X] [🔑], no pick', async () => {
    openCodeProviders = ['openai', 'openrouter'];
    isGeneralTopic = true;
    try {
      await harness.runCommand('accounts');
      const screen = harness.replies.at(-1)!;
      const rows = harness.getKeyboardData(screen);
      assert.deepEqual(rows.filter((row) => row[0].startsWith('acct_dc_')), [['acct_dc_0', 'acct_dcre_0'], ['acct_dc_1', 'acct_dcre_1']]);
      assert.equal(rows.flat().some((data) => data.startsWith('acct_ocuse_')), false);
      assert.deepEqual(harness.getKeyboardLabels(screen).find((row) => row.some((label) => label.includes('openrouter'))), ['🔌 Disconnect openrouter', '🔑']);
      assert.match(screen.text ?? '', /Tap an account to make it the default for all topics\. 🔑 signs an account or provider in again, 🗑 removes an account, 🔌 disconnects a provider\./);
      await harness.tapButton(screen.messageId!, 'acct_ocuse_0'); // an old keyboard from a topic
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'An OpenCode model is picked inside a topic.');
    } finally {
      isGeneralTopic = false;
    }
  });

  it('the title and the ✓ say where the topic REALLY runs: the account its session runs on (not the pick), OpenCode with its model, none while OpenCode\'s model is unknown', async () => {
    openCodeProviders = [];
    const savedOverride = harness.state.getClaudeProfileOverride(harness.key);
    await harness.state.setClaudeProfileOverride(harness.key, 'default');
    try {
      topicRun = { family: 'claude', rung: { backend: 'claude', profile: 'work', model: null } };
      await harness.runCommand('accounts');
      let screen = harness.replies.at(-1)!;
      assert.match(screen.text ?? '', /^👤 This topic runs on: Claude «work»\n\n• default — .*\n✓ work — /, 'the session runs on «work» although the pick is «default» (a switch is deferred)');
      assert.deepEqual(harness.getKeyboardLabels(screen).slice(0, 2).map((row) => row[0].startsWith('✓')), [false, true]);

      topicRun = { family: 'opencode', rung: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' } };
      await harness.runCommand('accounts');
      screen = harness.replies.at(-1)!;
      assert.match(screen.text ?? '', /^👤 This topic runs on: OpenCode openai\/gpt-5\n\n• default — /);
      assert.equal(harness.getKeyboardLabels(screen).flat().some((label) => label.startsWith('✓')), false, 'no Claude account carries the ✓ while OpenCode runs');

      topicRun = { family: 'opencode', rung: null };
      await harness.runCommand('accounts');
      assert.match(harness.replies.at(-1)?.text ?? '', /^👤 This topic runs on: OpenCode\n\n/, 'an unknown OpenCode model is just OpenCode');

      topicRun = { family: null, rung: null };
      await harness.runCommand('accounts');
      assert.match(harness.replies.at(-1)?.text ?? '', /^👤 This topic runs on: Claude «default»\n\n✓ default — /, 'with no agent the next start\'s account (the pick) is where it will run');
    } finally {
      await harness.state.setClaudeProfileOverride(harness.key, savedOverride ?? null);
      topicRun = { family: null, rung: null };
    }
  });

  it('a provider signed in through a ChatGPT subscription shows its usage like an account; an API-key provider says so; the provider the topic runs on carries the ✓ and its model', async () => {
    openCodeProviders = ['openai', 'openrouter', 'google'];
    const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000 + 30_000).toISOString();
    harness.state.setOpenCodeProviderUsage('openai', {
      authKind: 'subscription',
      usage: { fetchedAt: new Date().toISOString(), source: 'api', buckets: [{ kind: 'session', percent: 12, resetsAt: inHours(3), scopeModel: null }, { kind: 'weekly_all', percent: 40, resetsAt: inHours(100), scopeModel: null }] },
    });
    harness.state.setOpenCodeProviderUsage('openrouter', { authKind: 'apiKey' });
    harness.state.setOpenCodeProviderUsage('google', { authKind: 'subscription' });
    topicRun = { family: 'opencode', rung: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' } };
    try {
      await harness.runCommand('accounts');
      const screen = harness.replies.at(-1)!;
      assert.match(screen.text ?? '', /🔌 OpenCode providers \(connected\):\n✓ openai — ChatGPT subscription\n {4}⏱ 5h 12% 🔄 in 3h · week 40% 🔄 in 4d \d+h\n• openrouter — API key\n• google\n/);
      assert.deepEqual(harness.getKeyboardLabels(screen).filter((row) => row.length === 3 && row[1] === '🔑' && row[2] === '🔌').map((row) => row[0]), ['✓ openai · gpt-5', 'openrouter', 'google']);
      isGeneralTopic = true;
      await harness.runCommand('accounts');
      assert.match(harness.replies.at(-1)?.text ?? '', /\n• openai — ChatGPT subscription\n {4}⏱ 5h 12%/, 'General shows the usage too, with no ✓ on a provider');
    } finally {
      isGeneralTopic = false;
      topicRun = { family: null, rung: null };
      harness.state.setOpenCodeProviderUsage('openai', { authKind: 'unknown' });
      harness.state.setOpenCodeProviderUsage('openrouter', { authKind: 'unknown' });
      harness.state.setOpenCodeProviderUsage('google', { authKind: 'unknown' });
    }
  });

  it('a provider row opens its model page (the shared one: ✓ on the running model, ⛔ on a limited one, Back to /accounts); a pick goes through the switch path and the screen returns', async () => {
    openCodeProviders = ['openai', 'openrouter'];
    openCodeModels = ['openai/gpt-5', 'openai/gpt-5-mini', 'openrouter/deepseek-chat'];
    topicRun = { family: 'opencode', rung: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' } };
    await harness.state.setOpenCodeModelLimitedUntil('openai/gpt-5-mini', new Date(Date.now() + 3_600_000 * 2).toISOString());
    await harness.state.setBinding(harness.key, 'folder');
    operatorSwitches.length = 0;
    try {
      await harness.runCommand('accounts');
      const screen = harness.replies.at(-1)!;
      await harness.tapButton(screen.messageId!, 'acct_ocuse_0');
      const page = harness.edits.at(-1)!;
      assert.equal(page.text, 'OpenCode · openai — pick the model for this topic:');
      const labels = harness.getKeyboardLabels(page);
      assert.equal(labels[0][0], 'gpt-5 ✓');
      assert.match(labels[1][0], /^gpt-5-mini ⛔ /);
      assert.deepEqual(harness.getKeyboardData(page), [['acct_ocm_0'], ['acct_ocm_1'], ['acct_back']]);
      assert.equal(labels.at(-1)?.[0], '⬅️ Back');

      await harness.tapButton(screen.messageId!, 'acct_ocm_1');
      assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5-mini' } }]);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'Model: openai/gpt-5-mini');
      assert.match(harness.edits.at(-1)?.text ?? '', /^👤 This topic runs on:/, 'back on the screen');

      // «Back» returns to the screen too; a model button of a screen that shows no page is out of date.
      await harness.tapButton(screen.messageId!, 'acct_ocuse_0');
      await harness.tapButton(screen.messageId!, 'acct_back');
      assert.match(harness.edits.at(-1)?.text ?? '', /^👤 This topic runs on:/);
      const editsBefore = harness.edits.length;
      await harness.tapButton(screen.messageId!, 'acct_ocm_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
      assert.equal(operatorSwitches.length, 1, 'the stale model button switched nothing');
      assert.equal(harness.edits.length, editsBefore + 1);
    } finally {
      await harness.state.setOpenCodeModelLimitedUntil('openai/gpt-5-mini', null);
      await harness.state.removeBinding(harness.key);
      topicRun = { family: null, rung: null };
    }
  });

  it('a provider with ONE model is picked at once (unless the topic runs on it); a refusal keeps the page, an asked question has no toast', async () => {
    openCodeProviders = ['solo', 'openrouter'];
    openCodeModels = ['solo/only', 'openrouter/a', 'openrouter/b'];
    topicRun = { family: 'claude', rung: { backend: 'claude', profile: 'default', model: null } };
    await harness.state.setBinding(harness.key, 'folder');
    operatorSwitches.length = 0;
    try {
      await harness.runCommand('accounts');
      const screen = harness.replies.at(-1)!;
      await harness.tapButton(screen.messageId!, 'acct_ocuse_0');
      assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'solo', modelId: 'only' } }]);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'Model: solo/only');

      operatorSwitchOutcome = { kind: 'asked' };
      await harness.tapButton(screen.messageId!, 'acct_ocuse_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '', 'the hand-over question is the answer');

      operatorSwitchOutcome = { kind: 'refused', text: '⚠️ no luck' };
      await harness.tapButton(screen.messageId!, 'acct_ocuse_1');
      await harness.tapButton(screen.messageId!, 'acct_ocm_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '⚠️ no luck');
      assert.match(harness.edits.at(-1)?.text ?? '', /pick the model for this topic/, 'a refusal leaves the page');

      topicRun = { family: 'opencode', rung: { backend: 'opencode', providerId: 'solo', modelId: 'only' } };
      operatorSwitchOutcome = null;
      operatorSwitches.length = 0;
      await harness.runCommand('accounts');
      await harness.tapButton(harness.replies.at(-1)!.messageId!, 'acct_ocuse_0');
      assert.deepEqual(operatorSwitches, [], 'the topic runs on the provider already: its page opens instead');
      assert.equal(harness.getKeyboardLabels(harness.edits.at(-1))[0][0], 'only ✓');
    } finally {
      operatorSwitchOutcome = null;
      await harness.state.removeBinding(harness.key);
      topicRun = { family: null, rung: null };
    }
  });

  it('an unbound topic is told to bind a folder before it picks a provider', async () => {
    openCodeProviders = ['openai'];
    openCodeModels = ['openai/gpt-5', 'openai/gpt-5-mini'];
    operatorSwitches.length = 0;
    await harness.runCommand('accounts');
    await harness.tapButton(harness.replies.at(-1)!.messageId!, 'acct_ocuse_0');
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.');
    await harness.runCommand('accounts', 'use openai/gpt-5');
    assert.equal(harness.replies.at(-1)?.text, '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.');
    assert.deepEqual(operatorSwitches, []);
  });

  it('`/accounts use <provider>/<model>` is the typed form of a provider pick: the same switch path; never in General; a value that is no provider/model gets the usage', async () => {
    await harness.state.setBinding(harness.key, 'folder');
    operatorSwitches.length = 0;
    try {
      await harness.runCommand('accounts', 'use openrouter/anthropic/claude-sonnet-4.5');
      assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' } }]);
      assert.equal(harness.replies.at(-1)?.text, 'Model: openrouter/anthropic/claude-sonnet-4.5');

      const repliesBefore = harness.replies.length;
      operatorSwitchOutcome = { kind: 'asked' };
      await harness.runCommand('accounts', 'use openai/gpt-5');
      assert.equal(harness.replies.length, repliesBefore, 'the question is the answer: nothing more is posted');
      operatorSwitchOutcome = null;

      await harness.runCommand('accounts', 'use /gpt-5');
      assert.match(harness.replies.at(-1)?.text ?? '', /^Usage: \/accounts/);

      isGeneralTopic = true;
      operatorSwitches.length = 0;
      await harness.runCommand('accounts', 'use openai/gpt-5');
      assert.equal(harness.replies.at(-1)?.text, 'An OpenCode model is picked inside a topic.');
      assert.deepEqual(operatorSwitches, []);
    } finally {
      isGeneralTopic = false;
      operatorSwitchOutcome = null;
      await harness.state.removeBinding(harness.key);
    }
  });

  it('the provider snapshot belongs to its CHAT: a disconnect tap from another chat on the same message id resolves no provider', async () => {
    openCodeProviders = ['openai', 'openrouter'];
    await harness.runCommand('accounts');
    const screen = harness.replies.at(-1)!;
    const editsBefore = harness.edits.length;
    await harness.asForeignChat(() => harness.tapButton(screen.messageId!, 'acct_dc_1'));
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
    assert.ok(!harness.edits.slice(editsBefore).some((edit) => /Disconnect openrouter\?/.test(edit.text)), 'no confirmation for a provider of another chat\'s screen');
    await harness.tapButton(screen.messageId!, 'acct_dc_1');
    assert.match(harness.edits.at(-1)?.text ?? '', /Disconnect openrouter\?/, 'this chat\'s own tap still resolves against its snapshot');
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

  it('a «connect again» tap on a provider row starts that provider\'s /connect flow', async () => {
    openCodeProviders = ['openai'];
    await harness.runCommand('accounts');
    const screen = harness.replies.at(-1)!;
    const before = startedConnects.length;
    await harness.tapButton(screen.messageId!, 'acct_dcre_0');
    assert.deepEqual(startedConnects.at(-1), { key: harness.key, providerId: 'openai' });
    assert.equal(startedConnects.length, before + 1);
    openCodeProviders = [];
  });

  it('removing `default` signs ~/.claude out (only the stored login), asks first, hides the account until it is signed in again', async () => {
    // A decoy home: the login, an MCP token beside it, and the shared entries that must survive.
    fs.mkdirSync(path.join(homeClaudeDir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(homeClaudeDir, 'projects', 'p', 'chat.jsonl'), 'transcript');
    fs.writeFileSync(path.join(homeClaudeDir, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(homeClaudeDir, 'CLAUDE.md'), 'memory');
    const credentials = path.join(homeClaudeDir, '.credentials.json');
    fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'decoy-token' }, mcpOAuth: { server: { token: 'keep' } } }), { mode: 0o600 });

    await harness.runCommand('account');
    const picker = harness.replies.at(-1)!;
    await harness.tapButton(picker.messageId!, 'acct_rm_default');
    const ask = harness.edits.at(-1);
    assert.match(ask?.text ?? '', /Remove the default account \(me@example\.com\)\?.*sessions running on it stop working/);
    assert.deepEqual(harness.getKeyboardData(ask), [['acct_rmok_default'], ['acct_back']]);
    assert.equal(fs.existsSync(credentials), true, 'asking removes nothing');

    setStatus(null, { loggedIn: false, email: null, subscriptionType: null, orgName: null }); // what the CLI reports afterwards
    await harness.tapButton(picker.messageId!, 'acct_rmok_default');
    const left = JSON.parse(fs.readFileSync(credentials, 'utf8'));
    assert.deepEqual(left, { mcpOAuth: { server: { token: 'keep' } } }, 'only the subscription login is gone');
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(homeClaudeDir, 'projects', 'p', 'chat.jsonl'), 'utf8'), 'transcript');
    assert.equal(fs.readFileSync(path.join(homeClaudeDir, 'settings.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(homeClaudeDir, 'CLAUDE.md'), 'utf8'), 'memory');
    assert.equal(harness.state.getClaudeProfileInfo('default')?.isRemoved, true);

    const rerendered = harness.edits.at(-1);
    assert.doesNotMatch(rerendered?.text ?? '', /default — /, 'hidden from the list');
    assert.match(rerendered?.text ?? '', /\/accounts login default/);
    assert.equal(harness.getKeyboardData(rerendered).flat().some((data) => data.endsWith('_default')), false);
    const views = buildClaudeProfileUsageViews({ dataDir, records: harness.state.getAllClaudeProfileInfos() });
    assert.equal(views.some((view) => view.name === 'default'), false, 'and from the fallback ranking');

    // Signed in again (here: the status probe says so) — the account is back.
    setStatus(null, { loggedIn: true, email: 'me@example.com', subscriptionType: 'max', orgName: null });
    await harness.runCommand('account');
    assert.match(harness.replies.at(-1)?.text ?? '', /default — me@example\.com/);
    assert.equal(harness.state.getClaudeProfileInfo('default')?.isRemoved, undefined);
  });

  it('a credentials file that holds only the login is deleted with it; a missing one is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-signout-'));
    try {
      assert.equal(signOutDefaultClaudeLogin(dir), false);
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
      assert.equal(signOutDefaultClaudeLogin(dir), true);
      assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
