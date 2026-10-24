/**
 * @description A Claude Code usage WARNING on the tmux backend, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), with the
 * fake interactive TUI (`tmuxE2e/fakeClaudeTui.ts`) in a private tmux server. One flow, in order:
 *
 *   boot → a topic is bound and switched to the tmux backend (`/claude_mode tmux`), `/claude` starts the TUI in a pane
 *   → a turn on which Claude Code shows its non-blocking warning (`Approaching session limit · resets 11:29pm`): the
 *     agent's answer reaches the topic and NO usage-limit notice is posted — the bot used to read the warning row as
 *     the limit itself and stop the topic until the reset
 *   → a turn that hits the real block (`You've hit your session limit · resets 11:29pm`): the limit notice is posted.
 *
 * What the unit tests cover instead (`claudeAgentErrorLine.test.ts`): every warning and extra-usage wording, the
 * classifier, a warning and a block in the same pane delta.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeTuiLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { fakeClaudeTuiBanner, fakeUsageLimitRow, fakeUsageWarningRow } from './tmuxE2e/fakeClaudeTui';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 141;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'tmux-warning';
const warningTurnLabel = 'WARN-1';
const limitTurnLabel = 'LIMIT-1';

const replyTimeoutMs = 20 * 1000;
const agentTimeoutMs = 60 * 1000;
/** The bot's usage-limit wait notice («🚧 Usage limit reached — …»). */
const limitNoticeMark = '🚧';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];

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

/** What the bot SENT to the topic (the Bot API call log), oldest first. */
function listSentTexts(): string[] {
  return fakeTelegram
    .listCalls('sendMessage')
    .filter((call) => call.payload.message_thread_id === topicThreadId)
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

/** Whether the bot relayed `text` to the topic — sent or edited into a message. */
function checkIsRelayed(text: string): boolean {
  return topic.listMessages().some((message) => message.text.includes(text));
}

describe('A usage warning on the tmux backend end to end: built charness, fake Bot API, fake Claude TUI', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-tmuxwarn-', [topicFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeTuiLauncher(layout),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic, switches it to the tmux backend and starts the TUI', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply('/claude_mode tmux', 'applies on next start');
    // The tmux backend greets with the TUI itself (no «ready» line): its banner is relayed into the topic. The bot
    // then types the stored effort into the fresh TUI; the flow's prompts come after it.
    fakeTelegram.pushOperatorMessage(topicThreadId, '/claude');
    await getCharness().waitFor('the TUI banner relayed', agentTimeoutMs, () => checkIsRelayed(fakeClaudeTuiBanner));
    await getCharness().waitFor('the stored effort typed into the fresh TUI', agentTimeoutMs, () => getCharness().output.includes('[Claude] sendInput: "/effort'));
  });

  it('a turn with the usage WARNING: the answer reaches the topic and no limit notice is posted', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${warningTurnLabel} [fake:usage-warning] refactor the parser`);
    await getCharness().waitFor('the answer after the warning to be relayed', agentTimeoutMs, () => checkIsRelayed(`Done with ${warningTurnLabel}`));
    assert.equal(getCharness().output.includes(`API error detected (usageLimit): ${fakeUsageWarningRow}`), false, 'the warning row is not taken for an API error');
    assert.deepEqual(listSentTexts().filter((text) => text.startsWith(limitNoticeMark)), [], 'a warning is not a usage limit');
  });

  it('a turn that hits the real block: the limit notice is posted', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${limitTurnLabel} [fake:usage-limit] carry on`);
    await getCharness().waitFor('the usage-limit notice', agentTimeoutMs, () => listSentTexts().some((text) => text.startsWith(limitNoticeMark)));
    assert.ok(getCharness().output.includes(`API error detected (usageLimit): ${fakeUsageLimitRow}`), 'the block row is the detected error');
  });
});
