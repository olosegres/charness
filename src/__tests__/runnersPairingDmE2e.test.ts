/**
 * @description WHERE the pairing line of `/runners` goes, at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`, `CHAT_MODE=both` with an owner) against the fake Bot API of `telegramE2e/fakeTelegram.ts` — which models private
 * chats: a person who never opened one is refused with Telegram's 403 «bot can't initiate conversation with a user» — a loopback `sshd` as "the
 * host" and a temp HOME as "the runner machine" (`runnerLinkE2e/runnerLinkFlowKit.ts`). The line is a SECRET — whoever holds it within its ten
 * minutes can pair a machine to the hub — and General is read by every member of the group, so the bot sends it to the admin who asked, in a
 * private message. Three admins play the three ways it can go: the OWNER (whose private chat is a served surface), a second ADMIN who opened a
 * private chat with the bot but is not the owner (the surface does not serve their chat — their taps on the line's row are accepted because
 * the chat is theirs), and a third who NEVER opened one. One flow, in order:
 *
 *   → the owner pairs from General (an address first: the one asked for is kept): General gets one plain note — «The pairing line was sent to
 *     Operator in a private message.», naming whose chat it is — and never the line; the line is in the owner's private chat as ONE message, HTML, the line in a <pre>, no
 *     topic named in the send, under it the row that picks how many jobs the new machine runs at once; the instance's record names that chat
 *   → the owner picks 2 on the row IN the private chat: answered, the tick moves
 *   → the line run on the runner machine pairs it: the PRIVATE message turns into «Runner “…” paired …» naming the 2 jobs, its line and row gone
 *   → the second admin pairs from General: their line is in THEIR private chat (the send names no topic: Telegram refuses one in a private
 *     chat), General gets a second note — naming THEM — and still no line; their tap on the row there is accepted — it sets 3 — while a tap on it from the
 *     OWNER (a message of a chat that is not the tapper's) is refused and changes nothing
 *   → the third admin pairs from General: the bot tried their private chat first and Telegram refused; General gets a line naming the bot as
 *     the chat to open, then the line itself with its row, as before; no note, nothing in their private chat; the record names General's message
 *   → the codes run out: the second admin's PRIVATE message and the third's message in General turn into «Pairing code expired.» and the
 *     instance's record is empty; the owner's «paired» message stays as it was
 *   → the owner writes `/runners` in their OWN private chat (a served surface): the list is there, Pair posts the line right there, with no note
 *   → the codes of the lines sent privately are in no message of the group
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI fails
 * without. Nothing leaves the machine: the Bot API and the sshd are on loopback. Everything the test starts is stopped in `after`.
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { testNodeModulesEnvName } from '../runnerUtility/appInstall';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage, type TelegramUser } from './telegramE2e/fakeTelegram';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { PrivateChatDriver, TopicDriver } from './telegramE2e/topicDriver';
import {
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  readJson,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';
import { readCodeOfLine, readPayloadOfLine } from './runnersTestKit';

const missingTools = getMissingTools();
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;

const group = { id: -1001111111111, title: 'ExampleGroup' };
/** The owner: the group's creator, and the one whose private chat the bot serves (`OWNER_USER_ID`). */
const operator: TelegramUser = { id: 424242, is_bot: false, first_name: 'Operator' };
/** An admin of the group who is not the owner; they opened a private chat with the bot. */
const helper: TelegramUser = { id: 434343, is_bot: false, first_name: 'Helper' };
/** An admin of the group who never opened a private chat with the bot. */
const newcomer: TelegramUser = { id: 444444, is_bot: false, first_name: 'Newcomer' };
const botUser: TelegramUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'first';
const launchLine = 'Launching Telegraf bot (long polling';
const repoRoot = path.resolve(__dirname, '..', '..');

const bootTimeoutMs = 60 * 1000;
/** A reply that may wait for the 5 s look of the pairing watcher. */
const replyTimeoutMs = 90 * 1000;
const pairingLineTimeoutMs = 180 * 1000;
/** What General says about a line that went to a private chat: it names whose, because General is read by every member and the admin who asked is not always the one who got it. */
function getSentPrivatelyNote(name: string): string {
  return `The pairing line was sent to ${name} in a private message.`;
}
const sentPrivatelyNotePrefix = 'The pairing line was sent to ';
const openPrivateChatHint = 'To get the pairing line in a private message next time, open a private chat with @fake_charness_bot and press Start. This time the line follows here:';
const pairingLineStart = 'Pair a runner';
const accessDeniedToast = 'Access denied';

describe('the pairing line of /runners goes to the admin in a private message: built charness, fake Bot API with private chats, loopback sshd, a runner machine', { skip: skipReason }, () => {
  let layout: IsolatedInstanceLayout | null = null;
  let charness: IsolatedCharness | null = null;
  let link: RunnerLinkLayout;
  let fakeTelegram: FakeTelegram;
  let general: TopicDriver;
  let operatorChat: PrivateChatDriver;
  let helperChat: PrivateChatDriver;
  let newcomerChat: PrivateChatDriver;
  let defaultTmuxSessionsBefore: string[] = [];
  let earlierOutput = '';

  let ownerLine = '';
  let helperLine = '';
  let ownerPairId = '';
  let helperPairId = '';
  let newcomerPairId = '';
  /** The owner's «paired» message and the two that wait to expire. */
  let ownerMessage: FakeTelegramMessage;
  let helperMessage: FakeTelegramMessage;
  let newcomerMessage: FakeTelegramMessage;

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

  /** The hub's registry of the instance's own HOME (`~/.config/charness/runners`). */
  function getRegistryDir(): string {
    return path.join(getLayout().instanceHome, '.config', 'charness', 'runners');
  }

  function readPending(): Array<{ pairId: string; jobsAtOnce?: number }> {
    return readJson<{ pending: Array<{ pairId: string; jobsAtOnce?: number }> }>(path.join(getRegistryDir(), 'pending.json')).pending;
  }

  function readPaired(): Array<{ id: string; name: string; jobsAtOnce?: number }> {
    return readJson<{ runners: Array<{ id: string; name: string; jobsAtOnce?: number }> }>(path.join(getRegistryDir(), 'paired.json')).runners;
  }

  /** A hand edit of `pending.json` the way an editor saves it: a new file renamed over the old. */
  function expireOpenPairings(): void {
    const pendingPath = path.join(getRegistryDir(), 'pending.json');
    const expired = { pending: readPending().map((pairing) => ({ ...pairing, expiresAtMs: Date.now() - 1000 })) };
    fs.writeFileSync(`${pendingPath}.by-hand`, `${JSON.stringify(expired)}\n`);
    fs.renameSync(`${pendingPath}.by-hand`, pendingPath);
  }

  /** The pairing messages this instance has sent and not yet settled (`DATA_DIR/runner-pairing-messages.json`). */
  function readPairingStore(): Array<{ pairId: string; key: string; messageId: number }> {
    const filePath = path.join(getLayout().dataDir, 'runner-pairing-messages.json');
    return fs.existsSync(filePath) ? readJson<{ messages: Array<{ pairId: string; key: string; messageId: number }> }>(filePath).messages : [];
  }

  /** The line in a pairing message's `<pre>`, as the operator would copy it (the HTML entities undone). */
  function readPairingLine(message: FakeTelegramMessage): string {
    const match = /<pre>([\s\S]*?)<\/pre>/.exec(message.text);
    if (match === null) throw new Error(`no <pre> in the pairing message: ${message.text.slice(0, 200)}`);
    return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /** The line as the runner account pastes it in its own terminal: without its `sudo`, and with the account that runs this flow as the last word. */
  function toOwnAccountLine(line: string): string {
    const withoutSudo = line.replace(/^sudo /, '');
    return `${withoutSudo.slice(0, withoutSudo.lastIndexOf(' ') + 1)}${os.userInfo().username}`;
  }

  /** The pasted line run on the runner machine, WITHOUT blocking this process (the fake Bot API lives in it). */
  function runPairingLineAsync(line: string): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', line], {
        env: {
          HOME: link.runnerHome,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          TMPDIR: path.join(link.root, 'tmp'),
          LANG: 'C.UTF-8',
          [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      const timer = setTimeout(() => child.kill('SIGKILL'), pairingLineTimeoutMs);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, output });
      });
    });
  }

  /** The messages of the pairing line in a chat: its explanation opens them. */
  function listPairingLines(chat: TopicDriver): FakeTelegramMessage[] {
    return chat.listMessages().filter((message) => message.text.startsWith(pairingLineStart));
  }

  function listPairingNotes(): FakeTelegramMessage[] {
    return general.listMessages().filter((message) => message.text.startsWith(sentPrivatelyNotePrefix));
  }

  /** `from` writes `/runners` in General and the list arrives; `from` taps Pair on it. */
  async function tapPairInGeneralAs(from: TelegramUser): Promise<FakeTelegramMessage> {
    const sentMessageId = fakeTelegram.pushUserMessage(generalTopicThreadId, '/runners', from);
    const list = await general.waitForMessage(`the list for ${from.first_name}`, (message) => message.message_id > sentMessageId && general.getKeyboardData(message).flat().includes('rnr_pair'));
    await general.tapAndAwaitAnswer(list, 'rnr_pair', from);
    return list;
  }

  async function startCharness(): Promise<void> {
    earlierOutput += charness?.output ?? '';
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  }

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-rpd-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    // The kit's sshd reads `<its hub HOME>/.ssh/authorized_keys`; the bot writes `~/.ssh/authorized_keys` of ITS HOME: one folder.
    link = await createRunnerLinkLayout();
    const instanceSshDir = path.join(layout.instanceHome, '.ssh');
    fs.mkdirSync(instanceSshDir, { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(link.hubHome, '.ssh'), { recursive: true, force: true });
    fs.symlinkSync(instanceSshDir, path.join(link.hubHome, '.ssh'));

    fakeTelegram = new FakeTelegram({ botUser, operator, admins: [helper, newcomer], group });
    // The bot may write to a person only once they opened a private chat with it: the owner and the second admin did, the third never.
    fakeTelegram.isPrivateChatStartRequired = true;
    fakeTelegram.openPrivateChat(operator);
    fakeTelegram.openPrivateChat(helper);
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    operatorChat = new PrivateChatDriver(fakeTelegram, getCharness, operator, replyTimeoutMs);
    helperChat = new PrivateChatDriver(fakeTelegram, getCharness, helper, replyTimeoutMs);
    newcomerChat = new PrivateChatDriver(fakeTelegram, getCharness, newcomer, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'both',
      OWNER_USER_ID: operator.id.toString(),
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      XDG_CACHE_HOME: path.join(link.root, 'xdg'),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    if (link) await destroyRunnerLinkLayout(link);
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots with the owner\'s private chat served and the group', async () => {
    await startCharness();
  });

  it('the owner pairs from General: General gets only the note, the line — one HTML message with its «jobs at once» row, no topic named — is in the owner\'s private chat, and the instance records THAT message', async () => {
    const list = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    await general.tapAndAwaitAnswer(list, 'rnr_pair');
    const step = await general.waitForMessage('the address step', (message) => message.text.startsWith('Runners connect to this machine over ssh'));
    await general.tapAndAwaitAnswer(step, 'rnr_adother');
    await general.waitForMessage('the question for the address', (message) => message.text === 'Send the address runners will dial, as host or host:port.');
    await general.sendAndAwaitReply(`127.0.0.1:${link.sshPort}`, getSentPrivatelyNote(operator.first_name));

    ownerMessage = await operatorChat.waitForMessage('the pairing line in the owner\'s private chat', (message) => message.text.startsWith(pairingLineStart));
    assert.ok(ownerMessage.text.includes('keep the line private'), ownerMessage.text);
    assert.deepEqual(operatorChat.getKeyboardLabels(ownerMessage), [['Jobs at once:'], ['1 ✓', '2', '3', '4']]);
    ownerLine = toOwnAccountLine(readPairingLine(ownerMessage));
    ownerPairId = readPayloadOfLine(ownerLine).pairId;
    const sendCall = fakeTelegram.listCalls('sendMessage').find((call) => call.payload.text === ownerMessage.text);
    assert.equal(sendCall?.payload.chat_id, operator.id, 'sent to the owner\'s private chat');
    assert.equal(sendCall?.payload.parse_mode, 'HTML');
    assert.equal(sendCall?.payload.message_thread_id, undefined, 'a private chat has no topic to name');

    assert.equal(listPairingLines(general).length, 0, 'the line is not in General');
    assert.ok(general.listMessages().every((message) => !message.text.includes('cr2.')), 'nor any part of it');
    assert.deepEqual(listPairingNotes().map((message) => message.text), [getSentPrivatelyNote(operator.first_name)], 'General says where it went — once, naming whose chat it is');
    await waitUntil(() => readPairingStore().length === 1, 'the instance to record the message it sent', 10_000);
    assert.deepEqual(readPairingStore().map((message) => [message.pairId, message.key, message.messageId]), [[ownerPairId, `${operator.id}:0`, ownerMessage.message_id]], 'the record names the private chat');
  });

  it('the owner picks 2 on the row in the private chat: answered there, the tick moves, the choice is kept on the open code', async () => {
    assert.equal(await operatorChat.tapAndAwaitAnswer(ownerMessage, `rnr_pj_${ownerPairId}_2`), 'The new machine will run 2 at once.');
    await waitUntil(() => readPending().find((pairing) => pairing.pairId === ownerPairId)?.jobsAtOnce === 2, 'the choice to be kept on the open code', 10_000);
    await waitUntil(() => operatorChat.getKeyboardLabels(ownerMessage)[1]?.join(' ') === '1 2 ✓ 3 4', 'the tick to move to 2', 10_000);
  });

  it('the line run on the runner machine pairs it: the PRIVATE message turns into «paired», naming the 2 jobs, its line and row gone', async () => {
    const result = await runPairingLineAsync(ownerLine);
    assert.equal(result.status, 0, result.output);
    await operatorChat.waitForMessageText('the private message to read paired', ownerMessage, (text) => /^Runner “[a-z0-9-]+” paired \d{1,2} \S+ \d{2}:\d{2}\.\nJobs at once: 2 — change it in \/runners\.$/u.test(text));
    assert.ok(!ownerMessage.text.includes('cr2.') && !ownerMessage.text.includes('sh -c'), 'the line is gone from the message');
    assert.equal(ownerMessage.reply_markup, undefined, 'the keyboard goes with the line');
    assert.notEqual(ownerMessage.isDeleted, true, 'the message stays and says what became of the code');
    await waitUntil(() => readPairingStore().length === 0, 'the settled message to leave the instance\'s record', 10_000);
    assert.equal(readPaired().length, 1);
    assert.equal(readPaired()[0].jobsAtOnce, 2, 'the choice made in the private chat is the runner\'s');
  });

  it('a second admin (who is not the owner, and opened a private chat with the bot) pairs from General: the line is in THEIR chat, General gets a second note and still no line; their tap on the row there is accepted, the owner\'s tap on their message is refused', async () => {
    await tapPairInGeneralAs(helper);
    helperMessage = await helperChat.waitForMessage('the pairing line in the second admin\'s private chat', (message) => message.text.startsWith(pairingLineStart));
    helperLine = toOwnAccountLine(readPairingLine(helperMessage));
    helperPairId = readPayloadOfLine(helperLine).pairId;
    assert.notEqual(helperPairId, ownerPairId);
    const sendCall = fakeTelegram.listCalls('sendMessage').find((call) => call.payload.text === helperMessage.text);
    assert.equal(sendCall?.payload.chat_id, helper.id);
    assert.equal(sendCall?.payload.message_thread_id, undefined, 'no topic named: Telegram refuses one in a private chat, whoever the person is');
    assert.deepEqual(operatorChat.listMessages().filter((message) => message.message_id > ownerMessage.message_id && message.text.startsWith(pairingLineStart)), [], 'the owner\'s chat holds no second line');
    assert.equal(listPairingLines(general).length, 0, 'General has no line');
    await waitUntil(() => listPairingNotes().length === 2, 'General\'s second note', replyTimeoutMs);
    assert.deepEqual(listPairingNotes().map((message) => message.text), [getSentPrivatelyNote(operator.first_name), getSentPrivatelyNote(helper.first_name)], 'the second note names the second admin: the one who got the line');
    await waitUntil(() => readPairingStore().length === 1, 'the instance to record the message it sent', 10_000);
    assert.deepEqual(readPairingStore().map((message) => [message.pairId, message.key]), [[helperPairId, `${helper.id}:0`]]);

    assert.equal(await helperChat.tapAndAwaitAnswer(helperMessage, `rnr_pj_${helperPairId}_3`), 'The new machine will run 3 at once.', 'a tap in the admin\'s own chat is accepted');
    await waitUntil(() => readPending().find((pairing) => pairing.pairId === helperPairId)?.jobsAtOnce === 3, 'the choice to be kept on the open code', 10_000);
    await waitUntil(() => helperChat.getKeyboardLabels(helperMessage)[1]?.join(' ') === '1 2 3 ✓ 4', 'the tick to move to 3', 10_000);

    // The owner taps a message of the OTHER admin's chat: not their chat, so no gate opens and nothing changes.
    assert.equal(await helperChat.tapAndAwaitAnswer(helperMessage, `rnr_pj_${helperPairId}_4`, operator), accessDeniedToast);
    assert.equal(readPending().find((pairing) => pairing.pairId === helperPairId)?.jobsAtOnce, 3, 'nothing was chosen');
  });

  it('a third admin who never opened a private chat: the bot tried it, Telegram said 403, General gets the line naming the bot to open — then the line itself with its row, as before — and no note', async () => {
    const callsBefore = fakeTelegram.listCalls('sendMessage').length;
    const list = await tapPairInGeneralAs(newcomer);
    newcomerMessage = await general.waitForMessage('the line in General', (message) => message.text.startsWith(pairingLineStart) && message.message_id > list.message_id);
    const hint = await general.waitForMessage('the hint', (message) => message.text === openPrivateChatHint);
    assert.ok(hint.message_id < newcomerMessage.message_id, 'the hint comes first');
    assert.ok(fakeTelegram.listCalls('sendMessage').slice(callsBefore).some((call) => call.payload.chat_id === newcomer.id), 'the bot tried their private chat first');
    assert.equal(newcomerChat.listMessages().length, 0, 'nothing reached their private chat');
    assert.equal(listPairingNotes().length, 2, 'no «sent privately» note for a line that was not');
    const newcomerLine = toOwnAccountLine(readPairingLine(newcomerMessage));
    newcomerPairId = readPayloadOfLine(newcomerLine).pairId;
    assert.deepEqual(general.getKeyboardData(newcomerMessage), [['rnr_pjinfo'], [1, 2, 3, 4].map((count) => `rnr_pj_${newcomerPairId}_${count}`)], 'the row goes with the line');
    await waitUntil(() => readPairingStore().length === 2, 'the instance to record the message it sent', 10_000);
    assert.deepEqual(readPairingStore().map((message) => [message.pairId, message.key, message.messageId]), [
      [helperPairId, `${helper.id}:0`, helperMessage.message_id],
      [newcomerPairId, `${group.id}:${generalTopicThreadId}`, newcomerMessage.message_id],
    ]);
    assert.equal(await general.tapAndAwaitAnswer(newcomerMessage, `rnr_pj_${newcomerPairId}_2`, newcomer), 'The new machine will run 2 at once.', 'the row under a line in the topic still works');
  });

  it('the codes run out: the second admin\'s PRIVATE message and the third\'s message in General turn into «Pairing code expired.», the record empties, the owner\'s «paired» message is not touched', async () => {
    const ownerTextBefore = ownerMessage.text;
    expireOpenPairings();
    await helperChat.waitForMessageText('the private message to read expired', helperMessage, (text) => text === 'Pairing code expired.');
    await general.waitForMessageText('the message in General to read expired', newcomerMessage, (text) => text === 'Pairing code expired.');
    assert.equal(helperMessage.reply_markup, undefined, 'its row goes');
    assert.equal(newcomerMessage.reply_markup, undefined);
    await waitUntil(() => readPairingStore().length === 0, 'the settled messages to leave the instance\'s record', 10_000);
    assert.equal(ownerMessage.text, ownerTextBefore, 'the owner\'s message stays as it was');
    assert.equal(readPending().length, 0, 'the expired codes are swept');
  });

  it('the owner writes /runners in their OWN private chat — a served surface: the list is there, Pair posts the line right there, with no note to point elsewhere', async () => {
    const sentMessageId = fakeTelegram.pushPrivateMessage(operator, '/runners');
    const list = await operatorChat.waitForMessage('the list in the private chat', (message) => message.message_id > sentMessageId && operatorChat.getKeyboardData(message).flat().includes('rnr_pair'));
    const notesBefore = listPairingNotes().length;
    await operatorChat.tapAndAwaitAnswer(list, 'rnr_pair');
    const line = await operatorChat.waitForMessage('the line in the private chat', (message) => message.text.startsWith(pairingLineStart) && message.message_id > list.message_id);
    assert.deepEqual(operatorChat.getKeyboardLabels(line), [['Jobs at once:'], ['1 ✓', '2', '3', '4']]);
    assert.ok(operatorChat.listMessages().every((message) => !message.text.startsWith(sentPrivatelyNotePrefix)), 'no note in the private chat');
    assert.equal(listPairingNotes().length, notesBefore, 'and none in General');
    await waitUntil(() => readPairingStore().length === 1, 'the instance to record the message it sent', 10_000);
    assert.deepEqual(readPairingStore().map((message) => [message.key, message.messageId]), [[`${operator.id}:0`, line.message_id]]);
  });

  it('the codes of the lines sent privately are in no message the bot sent to the group', async () => {
    const groupTexts = fakeTelegram.listCalls('sendMessage').filter((call) => call.payload.chat_id === group.id).map((call) => String(call.payload.text));
    const privateCodes = [readCodeOfLine(ownerLine), readCodeOfLine(helperLine)];
    assert.ok(privateCodes.every((code) => code.length > 100), 'the codes were read from the lines');
    for (const code of privateCodes) assert.ok(groupTexts.every((text) => !text.includes(code)), 'not in any message of the group');
    assert.equal(`${earlierOutput}${getCharness().output}`.includes(privateCodes[0]), false, 'not in the bot\'s output either');
  });
});
