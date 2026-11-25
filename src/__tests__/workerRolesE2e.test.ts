/**
 * @description `/workers` — the bot's default model and effort per worker role — at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, the fake `claude` as the
 * topic's agent, and a fake OpenCode (`openCodeE2e/fakeOpenCodeServer.ts` + the `opencode` CLI on the instance's PATH) for the catalog and
 * the variants. What an agent reads is the proof of what the screen wrote: the fake agent calls `claude_profiles` with a `role` (its
 * `claude-profiles` mode) and the answer is checked. One flow, in order:
 *
 *   boot → a topic bound, a signed-in account seeded, its agent started
 *   → `/workers` in General: the six built-in values, «your own instructions win», no «All to built-in values»; nothing written
 *   → Builder → Sonnet, then high: the ✓ moves in place, «(built-in)» goes, `settings.json` holds only the builder; back on the overview
 *     its row reads «Sonnet · high» and «All to built-in values» appears; the topic's own `/workers` shows the same bot-wide values
 *   → the agent asks `claude_profiles {role: builder}`: the launch, «the bot's default — your own instructions win», then the account
 *   → Reviewer → OpenCode → openai → gpt-6-astra → medium; the agent's answer names `opencode run … --variant medium`, no account needed
 *   → the provider disconnects (the catalog no longer lists it; a restart drops the adapter's cache): the overview warns, the role's row
 *     carries ⚠️, and the agent is told to launch it on its own model
 *   → `/bot_skills`: its «🛠 Worker models» row opens the screen as a NEW message, the picker untouched; with the skills off the screen says so
 *   → «↩ Built-in» on the reviewer and «All to built-in values» take the fields out of `settings.json`; the agent's answer is Opus again
 *   → the same screens in Russian (the chat's language)
 *
 * The words in all twelve languages, every warning case and the codec are `workerRolesScreenPlan.test.ts`'s; a stale keyboard, an
 * unwritable file and a refused tap are `workerRolesCommand.test.ts`'s; the tool's role input and its refusals `schedulerMcp.test.ts`'s.
 * Nothing leaves the machine: the Bot API and OpenCode are on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
import { fakeClaudeLogFileNames, type FakeClaudeToolCall } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const threadId = 111;
const topicKey = `${group.id}:${threadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folder = 'workers-a';
const accountName = 'work';
const fakeOpenCodeVersion = '1.17.11';
const openCodeModels = ['openai/gpt-5.6-sol', 'openai/gpt-6-astra', 'anthropic/claude-x'];
/** The catalog once the `openai` provider is disconnected. */
const openCodeModelsWithoutOpenAi = ['anthropic/claude-x'];
const replyTimeoutMs = 30 * 1000;
const builtInRows = [
  ['Builder: Opus · medium'],
  ['Builder, data storage: Opus · xhigh'],
  ['Investigator: Opus · xhigh'],
  ['Reviewer: Opus · xhigh'],
  ['Mini-review: Opus · high'],
  ['Planner: Opus · xhigh'],
];
const ownInstructionsWin = 'Your own instructions win: a model you name in the conversation, or a delegate skill of the project or your own that names a role\'s model.';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
let general: TopicDriver;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let turnCounter = 0;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

/** `settings.json` sits beside the instance's env file. */
function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(getLayout().envFile), 'settings.json'), 'utf8'));
}

/** The message `screen` with its CURRENT text and keyboard (the bot edits a screen in place). */
function getCurrent(driver: TopicDriver, screen: FakeTelegramMessage): FakeTelegramMessage {
  const current = driver.listMessages().find((message) => message.message_id === screen.message_id);
  assert.ok(current, 'the screen message is still in the topic');
  return current;
}

/**
 * Tap `data` on the screen and wait until it, as it is NOW, satisfies `check` — its text, and its keyboard's labels for a tap that
 * changes only the buttons; resolves the screen as it is now.
 */
async function tapScreen(driver: TopicDriver, screen: FakeTelegramMessage, data: string, check: (text: string, labels: string[]) => boolean): Promise<FakeTelegramMessage> {
  await driver.tapAndAwaitAnswer(screen, data);
  await getCharness().waitFor(`the screen after ${data}`, replyTimeoutMs, () => {
    const current = getCurrent(driver, screen);
    return check(current.text, driver.getKeyboardLabels(current).flat());
  });
  return getCurrent(driver, screen);
}

/** A turn in which the topic's agent asks `claude_profiles` with `args`; resolves the answer the bot gave it (verdict line + report). */
async function askProfilesAsAgent(args: Record<string, string>): Promise<{ verdict: string; report: { worker?: Record<string, unknown> } }> {
  turnCounter += 1;
  const label = `WR-${turnCounter}`;
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:claude-profiles] [profiles-args:${JSON.stringify(args)}] launch a worker`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  const call = readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls))
    .find((candidate) => candidate.tool === 'claude_profiles' && candidate.issueKey === label);
  assert.ok(call, `the agent called claude_profiles in ${label}`);
  const [verdict, ...rest] = call.outcome.split('\n');
  return { verdict, report: JSON.parse(rest.join('\n')) };
}

describe('/workers end to end: built charness, fake Bot API, fake agent, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-workers-', [folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    // The OpenCode server the bot adopts (the variants), and the `opencode` CLI it lists the catalog with, on the instance's PATH.
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: openCodeModels[0] });
    const openCodeUrl = await fakeOpenCode.start(await getFreePort());
    writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: openCodeModels });
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      OPENCODE_URL: openCodeUrl,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv({}),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots, binds a topic, seeds a signed-in account and starts the topic\'s agent', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    // Requests on: the agent's turn is a request it answers through `answer_request` (its `claude-profiles` mode runs there).
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: accountName, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [accountName]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' } };
      persisted.claudeProfileOverrides = { ...persisted.claudeProfileOverrides, [topicKey]: accountName };
    });
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('/workers in General: the six built-in values, «your own instructions win», no «All to built-in values»; a look writes nothing', async () => {
    const screen = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    assert.equal(screen.text, `🛠 Worker models — for the whole bot\n\nThe bot's default model and effort for each worker an agent launches. ${ownInstructionsWin}\n\nA new worker takes the value in force; a running one keeps its own.`);
    assert.deepEqual(general.getKeyboardLabels(screen), builtInRows);
    assert.deepEqual(general.getKeyboardData(screen), [['wkr_r0'], ['wkr_r1'], ['wkr_r2'], ['wkr_r3'], ['wkr_r4'], ['wkr_r5']]);
    assert.equal('workerRoles' in readSettingsFile(), false);
  });

  it('Builder → Sonnet, then high: the ✓ moves in place, «(built-in)» goes, settings.json holds only the builder; the overview shows it and offers «All to built-in values»; a topic sees the same', async () => {
    const opened = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    let screen = await tapScreen(general, opened, 'wkr_r0', (text) => text.startsWith('🛠 Builder\n'));
    assert.equal(screen.text, '🛠 Builder\n\nCode, tests, debugging, e2e and live runs, rework.\n\nNow: Opus · medium (built-in)\nYour own instructions may name another — then they win.');
    assert.deepEqual(general.getKeyboardLabels(screen), [['Fable', 'Opus ✓', 'Sonnet', 'Haiku'], ['🔌 OpenCode model…'], ['low', 'medium ✓', 'high'], ['xhigh', 'max'], ['← Back']]);

    screen = await tapScreen(general, opened, 'wkr_m0_sonnet', (text) => text.includes('Now: Sonnet · medium\n'));
    assert.deepEqual(general.getKeyboardLabels(screen)[0], ['Fable', 'Opus', 'Sonnet ✓', 'Haiku']);
    screen = await tapScreen(general, opened, 'wkr_e0_high', (text) => text.includes('Now: Sonnet · high\n'));
    assert.deepEqual(general.getKeyboardLabels(screen).slice(2), [['low', 'medium', 'high ✓'], ['xhigh', 'max'], ['↩ Built-in', '← Back']]);
    assert.equal(screen.message_id, opened.message_id, 'edited in place');
    assert.deepEqual(readSettingsFile().workerRoles, { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } });

    screen = await tapScreen(general, opened, 'wkr_o', (text) => text.startsWith('🛠 Worker models'));
    assert.deepEqual(general.getKeyboardLabels(screen), [['Builder: Sonnet · high'], ...builtInRows.slice(1), ['↩ All to built-in values']]);
    const inTopic = await topic.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    assert.deepEqual(topic.getKeyboardLabels(inTopic)[0], ['Builder: Sonnet · high'], 'one value for the whole bot');
  });

  it('the agent asks claude_profiles with the builder role: the launch, «the bot\'s default — your own instructions win», then the account', async () => {
    const { verdict, report } = await askProfilesAsAgent({ role: 'builder' });
    assert.ok(verdict.startsWith('builder: claude -p --model sonnet --effort high — the bot\'s default for this role; a model the user or your general delegate skill names wins | account: recommended: '), verdict);
    assert.deepEqual(report.worker, { role: 'builder', cli: 'claude', model: 'sonnet', effort: 'high', isBuiltIn: false, unavailable: null });
  });

  it('Reviewer → OpenCode → openai → gpt-6-astra → medium: settings.json holds it and the agent is told to run `opencode run … --variant medium`, no account needed', async () => {
    const opened = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    await tapScreen(general, opened, 'wkr_r3', (text) => text.startsWith('🛠 Reviewer\n'));
    let screen = await tapScreen(general, opened, 'wkr_oc3', (text) => text.startsWith('🛠 Reviewer · OpenCode'));
    assert.deepEqual(general.getKeyboardLabels(screen), [['openai'], ['anthropic'], ['← Back']]);
    screen = await tapScreen(general, opened, 'wkr_p3_0', (text) => text === '🛠 Reviewer · openai');
    assert.deepEqual(general.getKeyboardLabels(screen), [['gpt-5.6-sol'], ['gpt-6-astra'], ['← Back']]);
    screen = await tapScreen(general, opened, general.getButtonData(screen, 'gpt-6-astra'), (text) => text.includes('Now: OpenCode · gpt-6-astra'));
    assert.deepEqual(
      general.getKeyboardLabels(screen).slice(1, 4),
      [['🔌 OpenCode · gpt-6-astra ✓'], ['model\'s default ✓'], ['low', 'medium', 'high']],
      'the model\'s variants are the effort rows; xhigh is none of them, so the role runs on the model\'s own default',
    );
    screen = await tapScreen(general, opened, general.getButtonData(screen, 'medium'), (text) => text.includes('Now: OpenCode · gpt-6-astra · medium\n'));
    assert.deepEqual(readSettingsFile().workerRoles, { builder: { cli: 'claude', model: 'sonnet', effort: 'high' }, reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' } });

    const { verdict, report } = await askProfilesAsAgent({ role: 'reviewer' });
    assert.equal(verdict, 'reviewer: opencode run --model openai/gpt-6-astra --variant medium — the bot\'s default for this role; a model the user or your general delegate skill names wins; no Claude account needed');
    assert.deepEqual(report.worker, { role: 'reviewer', cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium', isBuiltIn: false, unavailable: null });
  });

  it('the provider disconnects: the overview warns and marks the row, and the agent is told to launch the reviewer on its own model', async () => {
    writeFakeOpenCodeBinary(getLayout().binDir, { version: fakeOpenCodeVersion, models: openCodeModelsWithoutOpenAi });
    // The adapter keeps the catalog it read for a few minutes: a restart reads the new one. The agent then starts afresh — the first request
    // of a conversation adopted across a restart is posted again only after the retry delay, which this flow has no reason to wait out.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await topic.sendAndAwaitReply('/claude', 'ready in');
    const screen = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    assert.ok(screen.text.endsWith('\n\n⚠️ Reviewer: OpenCode «openai» is not connected — agents launch it on their own model until it is.'), screen.text);
    assert.equal(general.getKeyboardLabels(screen)[3][0], '⚠️ Reviewer: OpenCode · gpt-6-astra · medium');

    const { verdict, report } = await askProfilesAsAgent({ role: 'reviewer' });
    assert.match(verdict, /^reviewer: the bot's default is opencode run --model openai\/gpt-6-astra --variant medium, but its OpenCode model is not in the catalog \(provider disconnected or model gone\) → launch it on the CLI, model and effort this conversation runs on — on Claude, call claude_profiles again with that model and take the account of that answer, not this one's$/);
    assert.equal(report.worker?.unavailable, 'openCodeModelMissing');
  });

  it('/bot_skills: «🛠 Worker models» opens the screen as a NEW message and leaves the picker; with the skills off the screen says so', async () => {
    const picker = await general.sendAndAwaitReply('/bot_skills', 'Bot skills for ALL topics');
    assert.deepEqual(general.getKeyboardLabels(picker).at(-1), ['🛠 Worker models']);
    const pickerText = picker.text;
    fakeTelegram.pushCallback(picker.message_id, 'bsk_wkr');
    const screen = await general.waitForMessage('the screen opened from /bot_skills', (message) => message.message_id > picker.message_id && message.text.startsWith('🛠 Worker models'));
    assert.doesNotMatch(screen.text, /skills are off/);
    assert.equal(getCurrent(general, picker).text, pickerText, 'the /bot_skills picker is untouched');

    await general.tapAndAwaitAnswer(picker, 'bsk_off');
    const offScreen = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    assert.ok(offScreen.text.endsWith('\n\n⚠️ The bot\'s skills are off: agents follow their own skills, which may not ask the bot for these values.'), offScreen.text);
    const onPicker = await general.sendAndAwaitReply('/bot_skills', 'Bot skills for ALL topics');
    await general.tapAndAwaitAnswer(onPicker, 'bsk_on');
  });

  it('«↩ Built-in» on the reviewer and «All to built-in values» take the fields out of settings.json; the agent\'s answer is the built-in Opus again', async () => {
    const opened = await general.sendAndAwaitReply('/workers', 'Worker models — for the whole bot');
    await tapScreen(general, opened, 'wkr_r3', (text) => text.startsWith('🛠 Reviewer\n'));
    let screen = await tapScreen(general, opened, 'wkr_x3', (text) => text.includes('Now: Opus · xhigh (built-in)'));
    assert.deepEqual(general.getKeyboardLabels(screen).at(-1), ['← Back'], '«Built-in» goes once the role holds its built-in value');
    assert.deepEqual(readSettingsFile().workerRoles, { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } });
    await tapScreen(general, opened, 'wkr_o', (text) => text.startsWith('🛠 Worker models'));
    screen = await tapScreen(general, opened, 'wkr_all', (text, labels) => text.startsWith('🛠 Worker models') && !labels.includes('↩ All to built-in values'));
    assert.deepEqual(general.getKeyboardLabels(screen), builtInRows);
    assert.equal('workerRoles' in readSettingsFile(), false);

    const { verdict, report } = await askProfilesAsAgent({ role: 'builder' });
    assert.ok(verdict.startsWith('builder: claude -p --model opus --effort medium — the bot\'s default for this role'), verdict);
    assert.equal(report.worker?.isBuiltIn, true);
  });

  it('in Russian — the chat\'s language — the overview and a role\'s screen are worded in it; model ids and efforts are not translated', async () => {
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.chatLocaleOverrides = { [group.id.toString()]: 'ru' };
    });
    const opened = await general.sendAndAwaitReply('/workers', 'Модели воркеров — для всего бота');
    assert.ok(opened.text.includes('Твои собственные инструкции важнее'), opened.text);
    assert.deepEqual(general.getKeyboardLabels(opened)[0], ['Разработчик: Opus · medium']);
    assert.deepEqual(general.getKeyboardData(opened)[0], ['wkr_r0'], 'the data does not depend on the language');
    const screen = await tapScreen(general, opened, 'wkr_r1', (text) => text.startsWith('🛠 Разработчик, хранение данных\n'));
    assert.ok(screen.text.includes('Сейчас: Opus · xhigh (встроенное)'), screen.text);
    assert.ok(screen.text.includes('Твои инструкции могут назвать другую — тогда важнее они.'), 'the role screen says the user\'s own instructions win');
    assert.deepEqual(general.getKeyboardLabels(screen).at(-1), ['← Назад']);
    // The OpenCode path in the same language (only the anthropic provider is connected by now) and /bot_skills's row.
    await tapScreen(general, opened, 'wkr_oc1', (text) => text.includes('Выбери провайдера:'));
    const page = await tapScreen(general, opened, 'wkr_p1_0', (text) => text === '🛠 Разработчик, хранение данных · anthropic');
    assert.deepEqual(general.getKeyboardLabels(page), [['claude-x'], ['← Назад']]);
    // xhigh is not one of claude-x's variants: the role takes the model's own default, and no variant carries the ✓.
    const role = await tapScreen(general, opened, 'wkr_k1_0', (text) => text.includes('Сейчас: OpenCode · claude-x · по умолчанию\n'));
    assert.deepEqual(general.getKeyboardLabels(role).slice(1, 4), [['🔌 OpenCode · claude-x ✓'], ['по умолчанию ✓'], ['low', 'medium', 'high']]);
    const picker = await general.sendAndAwaitReply('/bot_skills', 'Скиллы бота');
    assert.deepEqual(general.getKeyboardLabels(picker).at(-1), ['🛠 Модели воркеров']);
  });
});
