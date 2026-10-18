/**
 * The `/limits` switch board (`connectors/telegram/commands/limitsBoard.ts`) over its ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store, recording topic
 * sends). Pinned:
 *
 *   • WIRING — the command and the five buttons;
 *   • the screen: the message carries the usage block (the `/accounts` wording; the ChatGPT subscription beside the
 *     accounts), the two settings' state with the link to their screen and the caption «Choose the active model:»; the
 *     buttons are one full-width `[✓ ]<program> · <name>` per account / provider with no figure on them, «skip once» while a
 *     limit wait is armed; General's own caption;
 *   • a tap in a topic: a Claude account goes through the `/accounts` pick (the outcome is the toast, `asked` has none),
 *     the ✓ row and an OpenCode provider open the shared model page (a provider with one model switches at once), a
 *     page pick goes through the switch path, a refusal stays on the page, anything else returns to the board;
 *   • a tap in General: a Claude row sets the default, an OpenCode row only says a model is picked inside a topic;
 *   • an unbound topic is refused; a tap on a message the board knows nothing about (or another chat's) never acts;
 *   • the old text verbs go to the `/limits_autoswitch` runner.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLimitsBoard } from '../connectors/telegram/commands/limitsBoard';
import type { SessionKey } from '../sessionKey';
import { buildSkipArmedRetryCallbackData } from '../utils/autoContinueOnLimit';
import type { FallbackChainEntry, FallbackDetection } from '../utils/fallbackChain';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import type { OperatorSwitchOutcome } from '../utils/operatorSwitchPlan';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
let isGeneralTopic = false;
let position: FallbackChainEntry | null = null;
let armedFireAt: number | null = null;
const usageRefreshes: Array<{ maxAgeMs?: number }> = [];
const claudePicks: Array<{ key: SessionKey; isGeneral: boolean; name: string }> = [];
let claudePickLine: string | null = '✅ Claude account for this topic: work.';
const operatorSwitches: Array<{ key: SessionKey; to: FallbackChainEntry }> = [];
/** The stand-in bot's confirmation line of a switch is long on purpose: the board must answer with its OWN short toast, not with this. */
const longSwitchLine = `Model: stub ${'(the /model reply with the effort note) '.repeat(4)}`;
let operatorOutcome: OperatorSwitchOutcome = { kind: 'switched', text: longSwitchLine, label: 'stub label' };
const autoSwitchRuns: Array<{ verb: string; value: string; usageKey: string }> = [];
/** What the stand-in bot does after a successful pick: the topic is now where it was sent. */
let followPicks = true;
/** What the stand-in bot does with a pick in General: the instance default becomes that account (as the real one does, after re-spawning every session). */
let generalPickSetsDefault = false;

const nowMs = Date.now();
const inHours = (hours: number): string => new Date(nowMs + hours * 3_600_000).toISOString();
const snapshot = (session: number, weekly: number, isStale = false): ClaudeUsageSnapshot => ({
  fetchedAt: new Date(nowMs).toISOString(),
  source: 'api',
  buckets: [
    { kind: 'session', percent: session, resetsAt: inHours(3), scopeModel: null },
    { kind: 'weekly_all', percent: weekly, resetsAt: inHours(96), scopeModel: null },
  ],
  ...(isStale ? { isStale: true } : {}),
});

function buildProfile(name: string, overrides: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage: undefined, limitedUntil: null, ...overrides };
}

const manyModels = Array.from({ length: 12 }, (_, index) => `openrouter/model-${index + 1}`);

let detection: FallbackDetection;
function resetDetection(): void {
  detection = {
    claudeProfiles: [buildProfile('perf', { usage: snapshot(5, 78) }), buildProfile('default', { limitedUntil: inHours(2) }), buildProfile('out', { loggedIn: false })],
    openCodeModels: ['openai/gpt-5', 'openai/gpt-5-mini', ...manyModels, 'solo/only-model'],
    recentOpenCodeModels: [],
    openCodeLimits: { 'openai/gpt-5-mini': inHours(3) },
  };
}

const claudePerf = (model: string | null = 'opus'): FallbackChainEntry => ({ backend: 'claude', profile: 'perf', model });

async function openBoard(): Promise<{ messageId: number; labels: string[]; data: string[]; text: string }> {
  await harness.runCommand('limits');
  const sent = harness.replies.at(-1);
  return { messageId: sent!.messageId!, labels: harness.getKeyboardLabels(sent).flat(), data: harness.getKeyboardData(sent).flat(), text: sent?.text ?? '' };
}

function lastEdit(): { text: string; labels: string[][]; data: string[][] } {
  const edit = harness.edits.at(-1);
  return { text: edit?.text ?? '', labels: harness.getKeyboardLabels(edit), data: harness.getKeyboardData(edit) };
}

describe('limitsBoard: /limits over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    resetDetection();
    const board = createLimitsBoard({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      getInstanceTimezone: () => 'UTC',
      refreshUsage: async (options) => { usageRefreshes.push(options); },
      detectFallbackOptions: async () => detection,
      getTopicPosition: () => position,
      pickClaudeAccount: async (key, isGeneral, name) => {
        claudePicks.push({ key, isGeneral, name });
        if (followPicks && !isGeneral) position = { backend: 'claude', profile: name, model: null };
        if (generalPickSetsDefault && isGeneral) await harness.state.setClaudeProfileGlobalDefault(name);
        return claudePickLine;
      },
      switchTopicByOperator: async (key, to) => {
        operatorSwitches.push({ key, to });
        if (operatorOutcome.kind === 'switched') position = to;
        return operatorOutcome;
      },
      listClaudeModels: async () => ['fable', 'opus', 'sonnet', 'haiku'],
      runAutoSwitchCommand: async (_key, verb, value, usageKey) => { autoSwitchRuns.push({ verb, value, usageKey }); },
      getArmedLimitRetryFireAt: () => armedFireAt,
    });
    board.registerLimitsBoardCommands();
    board.registerLimitsBoardCallbacks();
    await harness.state.setBinding(harness.key, 'folder');
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /limits and its five buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['limits']);
    assert.deepEqual(harness.registeredActionPatterns, [
      String(/^lim_c_(\d{1,3})$/),
      String(/^lim_o_(\d{1,3})$/),
      String(/^lim_pg_(\d{1,3})$/),
      String(/^lim_m_(\d{1,3})$/),
      'lim_back',
    ]);
  });

  it('a topic\'s board: the usage block, the settings with the link to their screen, the caption; one full-width name-only button per account and provider (the signed-out one left out), the ✓ on the row the topic runs on', async () => {
    position = claudePerf();
    const board = await openBoard();
    const [heading, perfLine, defaultLine, , settingsLine, , caption] = board.text.split('\n');
    assert.equal(heading, 'Usage (% used)');
    assert.equal(perfLine, 'perf — ⏱ 5h 5% 🔄 in 3h · week 78% 🔄 in 4d');
    assert.match(defaultLine, /^default — ⛔ at its limit until (?:[A-Z][a-z]{2} )?\d{2}:\d{2}$/);
    assert.equal(settingsLine, '🔁 Auto switch: OFF (as in General) · ⏳ Wait for reset: ON (as in General) — /limits_autoswitch');
    assert.equal(caption, 'Choose the active model:');
    assert.equal(board.text.split('\n').length, 7, 'nothing else: no legend, no ⚠️ line');
    assert.deepEqual(harness.getKeyboardLabels(harness.replies.at(-1)).map((row) => row.length), [1, 1, 1, 1, 1], 'one button per row');
    assert.deepEqual(board.labels, ['✓ Claude · perf', 'Claude · default', 'OpenCode · openai', 'OpenCode · openrouter', 'OpenCode · solo'], 'the name only: no figure, no reset, no ⛔, no model');
    assert.deepEqual(board.data, ['lim_c_0', 'lim_c_1', 'lim_o_2', 'lim_o_3', 'lim_o_4']);
    assert.deepEqual(usageRefreshes.at(-1), { maxAgeMs: 60_000 }, 'the usage is refreshed on demand when the screen opens');
  });

  it('the ChatGPT subscription\'s usage follows the accounts\' in the message, and a provider the poller recorded no usage for has no line', async () => {
    position = claudePerf();
    harness.state.setOpenCodeProviderUsage('openai', { authKind: 'subscription', usage: snapshot(12, 40) });
    harness.state.setOpenCodeProviderUsage('openrouter', { authKind: 'apiKey' });
    try {
      const board = await openBoard();
      const lines = board.text.split('\n');
      assert.equal(lines[3], 'openai (ChatGPT) — ⏱ 5h 12% 🔄 in 3h · week 40% 🔄 in 4d');
      assert.equal(lines.some((line) => line.startsWith('openrouter')), false);
      assert.deepEqual(board.labels.slice(2), ['OpenCode · openai', 'OpenCode · openrouter', 'OpenCode · solo'], 'the buttons carry none of it');
    } finally {
      harness.state.setOpenCodeProviderUsage('openai', { authKind: 'unknown' });
      harness.state.setOpenCodeProviderUsage('openrouter', { authKind: 'unknown' });
    }
  });

  it('with no figure and no limit anywhere there is no usage block and no heading: the message is the settings and the caption', async () => {
    detection = { ...detection, claudeProfiles: [buildProfile('perf'), buildProfile('default')] };
    position = claudePerf();
    try {
      const board = await openBoard();
      assert.equal(board.text, '🔁 Auto switch: OFF (as in General) · ⏳ Wait for reset: ON (as in General) — /limits_autoswitch\n\nChoose the active model:');
    } finally {
      resetDetection();
    }
  });

  it('the settings line says where each value comes from: nothing after the topic\'s own value', async () => {
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, true);
    await harness.state.setAutoContinueOnLimitOverride(harness.key, false);
    try {
      assert.match((await openBoard()).text, /\n🔁 Auto switch: ON · ⏳ Wait for reset: OFF — \/limits_autoswitch\n/);
      await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
      assert.match((await openBoard()).text, /\n🔁 Auto switch: OFF \(as in General\) · ⏳ Wait for reset: OFF — \/limits_autoswitch\n/);
    } finally {
      await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
      await harness.state.setAutoContinueOnLimitOverride(harness.key, null);
    }
  });

  it('usage that is out of date carries the `/accounts` stale marker in the message and nothing on its button; «skip once» only while a limit wait is armed', async () => {
    detection = { ...detection, claudeProfiles: [buildProfile('perf', { usage: snapshot(5, 78, true) }), buildProfile('default')] };
    const unarmed = await openBoard();
    assert.equal(unarmed.text.split('\n')[1], 'perf — ⏱ 5h 5% 🔄 in 3h · week 78% 🔄 in 4d (stale)');
    assert.equal(unarmed.data.some((data) => data.startsWith('acl_skip_')), false, 'no skip button while no wait is armed');
    armedFireAt = nowMs + 3_600_000;
    try {
      const board = await openBoard();
      assert.equal(board.labels[0], '✓ Claude · perf', 'no ⚠️ on the button');
      assert.equal(board.data.at(-1), buildSkipArmedRetryCallbackData(armedFireAt), 'the skip button is the last row');
      assert.equal(board.labels.at(-1), '⏭ Skip once');
    } finally {
      armedFireAt = null;
      resetDetection();
    }
  });

  it('a tap on another Claude account is the `/accounts` pick: its line is the toast and the board re-renders with the ✓ moved', async () => {
    position = claudePerf();
    claudePicks.length = 0;
    const board = await openBoard();
    claudePickLine = '✅ Claude account for this topic: default. The running session was restarted under it — same conversation.';
    await harness.tapButton(board.messageId, 'lim_c_1');
    assert.deepEqual(claudePicks, [{ key: harness.key, isGeneral: false, name: 'default' }]);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), claudePickLine);
    const rerender = lastEdit();
    assert.equal(harness.edits.at(-1)?.messageId, board.messageId);
    assert.equal(rerender.labels[0][0], 'Claude · perf', 'the old row lost its ✓');
    assert.match(rerender.labels[1][0], /^✓ Claude · default/);
    claudePickLine = '✅ Claude account for this topic: work.';
  });

  it('a pick that asked the hand-over question answers with no toast', async () => {
    position = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
    const board = await openBoard();
    claudePickLine = null;
    followPicks = false;
    try {
      await harness.tapButton(board.messageId, 'lim_c_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '');
    } finally {
      claudePickLine = '✅ Claude account for this topic: work.';
      followPicks = true;
    }
  });

  it('the ✓ Claude row opens the model page of the topic\'s account: the CLI aliases on one page, ✓ on the running one, the pick goes through the switch path and returns to the board', async () => {
    position = claudePerf('claude-opus-4-1');
    operatorSwitches.length = 0;
    claudePicks.length = 0;
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_c_0');
    assert.deepEqual(claudePicks, [], 'the ✓ row is not a switch');
    const page = lastEdit();
    assert.equal(page.text, 'Claude · perf — pick the model for this topic:');
    assert.deepEqual(page.labels, [['fable'], ['opus ✓'], ['sonnet'], ['haiku'], ['⬅️ Back']]);
    assert.deepEqual(page.data, [['lim_m_0'], ['lim_m_1'], ['lim_m_2'], ['lim_m_3'], ['lim_back']]);
    await harness.tapButton(board.messageId, 'lim_m_2');
    assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'claude', profile: 'perf', model: 'sonnet' } }]);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '✅ This topic runs on stub label.', 'the short locked toast, not the route\'s long line');
    assert.match(lastEdit().text, /Choose the active model:$/, 'back on the board');
  });

  it('an OpenCode provider opens the shared model page: its models, the ⛔ mark on a limited one, ✓ on the topic\'s model; a pick switches and returns to the board', async () => {
    position = claudePerf();
    operatorSwitches.length = 0;
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_o_2'); // openai
    const page = lastEdit();
    assert.equal(page.text, 'OpenCode · openai — pick the model for this topic:');
    assert.equal(page.labels[0][0], 'gpt-5');
    assert.match(page.labels[1][0], /^gpt-5-mini ⛔ \d{2}:\d{2}$|^gpt-5-mini ⛔ [A-Z][a-z]{2} \d{2}:\d{2}$/, 'the limited model carries its reset');
    assert.deepEqual(page.data, [['lim_m_0'], ['lim_m_1'], ['lim_back']]);
    await harness.tapButton(board.messageId, 'lim_m_1');
    assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5-mini' } }]);
    assert.equal(lastEdit().labels[2][0], '✓ OpenCode · openai', 'back on the board, the ✓ moved (the model is not on the button)');
  });

  it('a long provider list pages ten to a page, and a pick on page two is the model of the WHOLE list', async () => {
    position = claudePerf();
    operatorSwitches.length = 0;
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_o_3'); // openrouter
    const first = lastEdit();
    assert.equal(first.labels.length, 10 + 2);
    assert.deepEqual(first.data[10], ['mdlnoop', 'lim_pg_1']);
    await harness.tapButton(board.messageId, 'lim_pg_1');
    const second = lastEdit();
    assert.deepEqual(second.labels, [['model-11'], ['model-12'], ['⬅️ Prev', '2/2'], ['⬅️ Back']]);
    assert.deepEqual(second.data.slice(2), [['lim_pg_0', 'mdlnoop'], ['lim_back']]);
    assert.deepEqual(second.data[0], ['lim_m_10']);
    await harness.tapButton(board.messageId, 'lim_m_11');
    assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'openrouter', modelId: 'model-12' } }]);
  });

  it('a refusal stays on the page with its error as the toast; an asked question (no toast) returns to the board', async () => {
    position = claudePerf();
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_o_2');
    operatorOutcome = { kind: 'refused', text: '⚠️ Model change failed: nope' };
    try {
      const editsBefore = harness.edits.length;
      await harness.tapButton(board.messageId, 'lim_m_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '⚠️ Model change failed: nope');
      assert.equal(harness.edits.length, editsBefore, 'the page stays');
      operatorOutcome = { kind: 'asked' };
      await harness.tapButton(board.messageId, 'lim_m_0');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '');
      assert.match(lastEdit().text, /Choose the active model:$/);
    } finally {
      operatorOutcome = { kind: 'switched', text: longSwitchLine, label: 'stub label' };
    }
  });

  it('the ✓ OpenCode row opens its provider\'s page with the topic\'s model marked; a provider with ONE model switches at once, unless the topic is on it', async () => {
    position = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
    operatorSwitches.length = 0;
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_o_2');
    assert.equal(lastEdit().labels[0][0], 'gpt-5 ✓');
    assert.deepEqual(operatorSwitches, []);

    position = claudePerf();
    const again = await openBoard();
    await harness.tapButton(again.messageId, 'lim_o_4'); // solo: one model
    assert.deepEqual(operatorSwitches, [{ key: harness.key, to: { backend: 'opencode', providerId: 'solo', modelId: 'only-model' } }]);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '✅ This topic runs on stub label.', 'the short locked toast, not the route\'s long line');

    position = { backend: 'opencode', providerId: 'solo', modelId: 'only-model' };
    operatorSwitches.length = 0;
    const here = await openBoard();
    await harness.tapButton(here.messageId, 'lim_o_4');
    assert.deepEqual(operatorSwitches, []);
    assert.equal(lastEdit().labels[0][0], 'only-model ✓');
  });

  it('General: the board says its rows are defaults, a Claude row sets the instance default, an OpenCode row only says a model is picked inside a topic', async () => {
    isGeneralTopic = true;
    claudePicks.length = 0;
    operatorSwitches.length = 0;
    try {
      const board = await openBoard();
      const [heading, , , , settingsLine, , caption] = board.text.split('\n');
      assert.equal(heading, 'Usage (% used)', 'the usage block is on the General board too');
      assert.equal(settingsLine, 'Defaults for all topics: 🔁 Auto switch: OFF · ⏳ Wait for reset: ON — /limits_autoswitch');
      assert.equal(caption, 'Choose the default Claude account:');
      assert.deepEqual(board.labels, ['Claude · perf', '✓ Claude · default', 'OpenCode · openai', 'OpenCode · openrouter', 'OpenCode · solo']);
      assert.equal(board.labels[1].startsWith('✓ Claude · default'), true, 'the default account carries the ✓');
      claudePickLine = '✅ Default Claude account for ALL topics: perf.';
      await harness.tapButton(board.messageId, 'lim_c_0');
      assert.deepEqual(claudePicks, [{ key: harness.key, isGeneral: true, name: 'perf' }]);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), claudePickLine);
      await harness.tapButton(board.messageId, 'lim_o_2');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'An OpenCode model is picked inside a topic.');
      assert.deepEqual(operatorSwitches, []);
    } finally {
      isGeneralTopic = false;
      claudePickLine = '✅ Claude account for this topic: work.';
    }
  });

  it('a toast that comes too late (a slow pick: the default change re-spawns every live topic) never skips the re-render: the ✓ moves and the confirmation is posted in the topic instead', async () => {
    harness.fakeTelegram.isCallbackAnswerExpired = true;
    await harness.state.upsertClaudeProfileRecord('perf', { loggedIn: true }); // the default can only be a profile the state knows
    try {
      // General: the board must show the NEW default, not the one it was drawn with.
      isGeneralTopic = true;
      generalPickSetsDefault = true;
      claudePickLine = '✅ Default Claude account for ALL topics: perf.';
      const general = await openBoard();
      assert.match(general.labels[1], /^✓ Claude · default/, 'precondition: the board was drawn with the old default');
      let repliesBefore = harness.replies.length;
      await harness.tapButton(general.messageId, 'lim_c_0'); // perf
      assert.equal(harness.state.getClaudeProfileGlobalDefault(), 'perf');
      assert.match(lastEdit().labels[0][0], /^✓ Claude · perf/, 'the board was re-rendered with the new default');
      assert.equal(harness.edits.at(-1)?.messageId, general.messageId);
      assert.equal(harness.replies[repliesBefore]?.text, claudePickLine, 'the toast could not be shown: the confirmation is a message');
      await harness.state.setClaudeProfileGlobalDefault('default');
      generalPickSetsDefault = false;
      isGeneralTopic = false;

      // A topic: the switch lands, the board re-renders with the ✓ moved.
      position = claudePerf();
      claudePickLine = '✅ Claude account for this topic: default.';
      const topic = await openBoard();
      repliesBefore = harness.replies.length;
      await harness.tapButton(topic.messageId, 'lim_c_1'); // default
      assert.match(lastEdit().labels[1][0], /^✓ Claude · default/);
      assert.equal(harness.replies[repliesBefore]?.text, claudePickLine);

      // A model pick on a page (the shared model page): the switch lands, the board returns.
      position = claudePerf();
      operatorSwitches.length = 0;
      const page = await openBoard();
      await harness.tapButton(page.messageId, 'lim_c_0'); // the ✓ row opens its model page
      assert.equal(lastEdit().text, 'Claude · perf — pick the model for this topic:');
      await harness.tapButton(page.messageId, 'lim_m_2'); // sonnet
      assert.equal(operatorSwitches.length, 1);
      assert.match(lastEdit().text, /Choose the active model:$/, 'back on the board');

      // The «out of date» answer, the page arrows and Back re-render although their toast is refused.
      const editsBefore = harness.edits.length;
      await harness.tapButton(page.messageId + 9_000, 'lim_c_1');
      assert.equal(harness.edits.length, editsBefore + 1, 'a tap on an unknown message re-rendered it');
      await harness.tapButton(page.messageId, 'lim_back');
      assert.equal(harness.edits.length, editsBefore + 2, 'Back re-rendered the board');
    } finally {
      harness.fakeTelegram.isCallbackAnswerExpired = false;
      generalPickSetsDefault = false;
      isGeneralTopic = false;
      claudePickLine = '✅ Claude account for this topic: work.';
      await harness.state.setClaudeProfileGlobalDefault('default');
      await harness.state.removeClaudeProfileRecord('perf');
    }
  });

  it('an unbound topic is told to bind a folder first and nothing is switched', async () => {
    position = claudePerf();
    const board = await openBoard();
    await harness.state.removeBinding(harness.key);
    claudePicks.length = 0;
    operatorSwitches.length = 0;
    try {
      for (const data of ['lim_c_1', 'lim_o_2']) {
        await harness.tapButton(board.messageId, data);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.', data);
      }
      assert.deepEqual([claudePicks, operatorSwitches], [[], []]);
    } finally {
      await harness.state.setBinding(harness.key, 'folder');
    }
  });

  it('a tap on a message the board knows nothing about (a restart, an older screen, ANOTHER chat) says it is out of date, re-renders and never acts', async () => {
    position = claudePerf();
    claudePicks.length = 0;
    operatorSwitches.length = 0;
    const board = await openBoard();
    const editsBefore = harness.edits.length;
    await harness.tapButton(board.messageId + 9_000, 'lim_c_1'); // a message id the board never posted
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
    await harness.asForeignChat(() => harness.tapButton(board.messageId, 'lim_o_2'));
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
    assert.deepEqual([claudePicks, operatorSwitches], [[], []]);
    assert.equal(harness.edits.length, editsBefore + 2, 'each stale tap re-rendered its message');
    // A model button on a message that holds the board (not a page) is stale too, and a row button on a page.
    await harness.tapButton(board.messageId, 'lim_m_0');
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
    await harness.tapButton(board.messageId, 'lim_pg_1');
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This screen is out of date — it is re-rendered.');
    assert.deepEqual(operatorSwitches, []);
  });

  it('every callback the board and its pages carry fits Telegram\'s 64 bytes', async () => {
    position = claudePerf();
    const board = await openBoard();
    await harness.tapButton(board.messageId, 'lim_o_3');
    for (const data of [...board.data, ...lastEdit().data.flat()]) assert.ok(Buffer.byteLength(data) <= 64, data);
  });

  it('the old text verbs go to the /limits_autoswitch runner with the board\'s own usage; a bare /limits opens the board', async () => {
    autoSwitchRuns.length = 0;
    await harness.runCommand('limits', 'rebuild');
    await harness.runCommand('limits', 'wait same');
    await harness.runCommand('limits', 'bogus');
    assert.deepEqual(autoSwitchRuns, [
      { verb: 'rebuild', value: '', usageKey: 'limits.usage' },
      { verb: 'wait', value: 'same', usageKey: 'limits.usage' },
      { verb: 'bogus', value: '', usageKey: 'limits.usage' },
    ]);
    const repliesBefore = harness.replies.length;
    await harness.runCommand('limits');
    assert.equal(harness.replies.length, repliesBefore + 1);
    assert.match(harness.replies.at(-1)?.text ?? '', /Choose the active model:$/);
  });
});
