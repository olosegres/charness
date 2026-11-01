/**
 * @description `/runners` at PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`)
 * against the fake Bot API of `telegramE2e/fakeTelegram.ts`, a loopback `sshd` as "the host" (no root: its own host key, key login only,
 * its `authorized_keys` the instance's own `~/.ssh/authorized_keys`) and a temp HOME as "the runner machine" where the REAL pasted line
 * runs and the REAL `charness-runner run` holds the link (`runnerLinkE2e/runnerLinkFlowKit.ts`). The test plays the operator in
 * General. One flow, in order:
 *
 *   boot → the command is in the menu and General's /help names it → a topic is sent to General and a tap from there is refused,
 *   nothing is created on disk for an instance that has no runner
 *   → General's empty list (Pair / Refresh) → Pair asks for an address (an address that answers nothing is refused with the reason and
 *     asked again) → the right one is kept in settings.json and the pairing message follows: HTML, the line in a <pre>, no keyboard
 *   → the line run on the runner machine pairs it: the message turns into «Runner “…” paired …» and its line is gone, the key line of
 *     the machine is in authorized_keys and the temporary one is not
 *   → the utility holds the link: /runners lists the machine online, and the live probe adds its hardware, jobs and capabilities
 *   → Pause marks it (a toast, the list says paused, Resume instead of Pause), Resume undoes it; a keyboard of an older revision only
 *     says the list changed and removes nothing
 *   → Remove asks first; Cancel keeps it; Remove for sure takes it out of the registry and of authorized_keys, empties the list, the
 *     machine's key is refused by sshd and the utility reports it was removed
 *   → a second pairing needs no address (it was kept); across a restart of the bot the message is found again from the registry's note
 *     and turns into «Pairing code expired.» when its code runs out, and the expired code is gone from authorized_keys; the first line,
 *     already used, and the expired one are refused on the runner machine
 *   → the pairing code is nowhere in the output trace, the console log or the bot's output: the trace keeps the message's length only
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason,
 * CI fails without. Nothing leaves the machine: the Bot API and the sshd are on loopback. Everything the test starts is stopped in
 * `after`. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { testNodeModulesEnvName } from '../runnerUtility/appInstall';
import type { RunnerStatus } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
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
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  readJson,
  sshToHubWithRunnerKey,
  startRunner,
  stopRunner,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';

const missingTools = getMissingTools();
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'first';
const launchLine = 'Launching Telegraf bot (long polling';
const repoRoot = path.resolve(__dirname, '..', '..');

const bootTimeoutMs = 60 * 1000;
/** A reply that may wait for the live probe (an ssh call through the link, a script upload) or for the 5 s look of the pairing watcher. */
const replyTimeoutMs = 90 * 1000;
const linkTimeoutMs = 90 * 1000;
const pairingLineTimeoutMs = 180 * 1000;
const generalOnlyText = '⚠️ Runners are managed in General — open /runners there.';
const staleListToast = 'The list changed — here it is again.';
const secretTracePreview = '[secret — text not recorded]';

describe('/runners end to end: built charness, fake Bot API, loopback sshd, a runner machine', { skip: skipReason }, () => {
  let layout: IsolatedInstanceLayout | null = null;
  let charness: IsolatedCharness | null = null;
  let link: RunnerLinkLayout;
  let fakeTelegram: FakeTelegram;
  let general: TopicDriver;
  let topic: TopicDriver;
  let defaultTmuxSessionsBefore: string[] = [];
  let runner: ChildProcess | null = null;
  /** What the runs before the current one printed (a restart starts a new process with a new output). */
  let earlierOutput = '';

  let firstPairingLine = '';
  let secondPairingLine = '';
  let runnerId = '';
  let runnerName = '';

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

  function getAuthorizedKeysPath(): string {
    return path.join(getLayout().instanceHome, '.ssh', 'authorized_keys');
  }

  function readAuthorizedKeys(): string {
    return fs.existsSync(getAuthorizedKeysPath()) ? fs.readFileSync(getAuthorizedKeysPath(), 'utf8') : '';
  }

  interface PairedFileView {
    rev: number;
    runners: Array<{ id: string; name: string; isPaused: boolean }>;
  }

  function readPaired(): PairedFileView {
    return readJson<PairedFileView>(path.join(getRegistryDir(), 'paired.json'));
  }

  /** `settings.json` sits beside the instance's env file. */
  function readSettings(): { runnerHost?: { host: string; port: number } } {
    return readJson(path.join(path.dirname(getLayout().envFile), 'settings.json'));
  }

  /** A hand edit of `pending.json` the way an editor saves it: a new file renamed over the old. */
  function expireOpenPairings(): void {
    const pendingPath = path.join(getRegistryDir(), 'pending.json');
    const pending = readJson<{ pending: Array<{ expiresAtMs: number }> }>(pendingPath);
    const expired = { pending: pending.pending.map((pairing) => ({ ...pairing, expiresAtMs: Date.now() - 1000 })) };
    fs.writeFileSync(`${pendingPath}.by-hand`, `${JSON.stringify(expired)}\n`);
    fs.renameSync(`${pendingPath}.by-hand`, pendingPath);
  }

  function readRunnerStatus(): RunnerStatus | null {
    try {
      return readJson<RunnerStatus>(getRunnerHomePaths(link.runnerHome).status);
    } catch {
      return null;
    }
  }

  /** The line in a pairing message's `<pre>`, as the operator would copy it (the HTML entities undone). */
  function readPairingLine(message: FakeTelegramMessage): string {
    const match = /<pre>([\s\S]*?)<\/pre>/.exec(message.text);
    if (match === null) throw new Error(`no <pre> in the pairing message: ${message.text.slice(0, 200)}`);
    return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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

  /** The bot's output-trace records (every hourly bucket and its rollover), as text. */
  function readOutputTrace(): string {
    return fs.readdirSync(getLayout().dataDir)
      .filter((name) => /^output-trace-\d+\.jsonl(\.1)?$/.test(name))
      .map((name) => fs.readFileSync(path.join(getLayout().dataDir, name), 'utf8'))
      .join('');
  }

  function readConsoleLogs(): string {
    return fs.readdirSync(getLayout().dataDir)
      .filter((name) => name.startsWith('bot-console-'))
      .map((name) => fs.readFileSync(path.join(getLayout().dataDir, name), 'utf8'))
      .join('');
  }

  function listMenuCommandNames(): string[] {
    return fakeTelegram.listCalls('setMyCommands').flatMap((call) => {
      const { commands } = call.payload;
      return Array.isArray(commands) ? commands.flatMap((entry) => (typeof entry?.command === 'string' ? [entry.command] : [])) : [];
    });
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
    layout = createIsolatedInstanceLayout('charness-rns-', [projectFolder], getFlowDeadlineMs());
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
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    if (runner !== null) await stopRunner(link, runner);
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    if (link) await destroyRunnerLinkLayout(link);
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots Telegram-only against the fake Bot API and binds a topic to a folder', async () => {
    await startCharness();
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
  });

  it('the command is in the bot\'s menu, and General\'s /help names it', async () => {
    assert.ok(listMenuCommandNames().includes('runners'), 'the menu lists /runners');
    const helpMessage = await general.sendAndAwaitReply('/help', 'Commands in General');
    assert.ok(helpMessage.text.includes("/runners — machines for the agents' tests and builds"), helpMessage.text);
  });

  it('a topic is sent to General and a tap from a topic is refused; an instance with no runner creates nothing on disk', async () => {
    const refusal = await topic.sendAndAwaitReply('/runners', generalOnlyText);
    assert.equal(await topic.tapAndAwaitAnswer(refusal, 'rnr_pair'), generalOnlyText);
    assert.equal(fs.existsSync(getRegistryDir()), false, 'no registry folder yet');
    assert.equal(fs.existsSync(getAuthorizedKeysPath()), false, 'authorized_keys untouched');
  });

  it('General\'s empty list offers Pair and Refresh; Pair asks for an address — one that answers nothing is refused with the reason and asked again', async () => {
    const screen = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    assert.deepEqual(general.getKeyboardData(screen), [['rnr_pair'], ['rnr_refresh']]);
    assert.deepEqual(general.getKeyboardLabels(screen), [['＋ Pair a new runner'], ['↻ Refresh']]);

    await general.tapAndAwaitAnswer(screen, 'rnr_pair');
    // This box may or may not have a public address of its own to propose; either way the operator can enter another.
    const step = await general.waitForMessage('the address step', (message) => message.text.startsWith('Runners connect to this machine over ssh'));
    assert.ok(general.getKeyboardData(step).flat().includes('rnr_adother'), JSON.stringify(general.getKeyboardData(step)));
    assert.equal(fs.existsSync(path.join(getRegistryDir(), 'pending.json')), false, 'no code before an address is chosen');
    await general.tapAndAwaitAnswer(step, 'rnr_adother');
    await general.waitForMessage('the question for the address', (message) => message.text === 'Send the address runners will dial, as host or host:port.');

    const deadPort = await getFreePort();
    await general.sendAndAwaitReply(`127.0.0.1:${deadPort}`, `⚠️ nothing answers with an ssh host key at 127.0.0.1:${deadPort}`);
    assert.equal(readSettingsRunnerHost(), undefined, 'a refused address is not kept');
  });

  function readSettingsRunnerHost(): { host: string; port: number } | undefined {
    return readSettings().runnerHost;
  }

  it('the right address is kept in settings.json and the pairing message follows: HTML, the line in a <pre>, one message, no keyboard', async () => {
    await general.sendAndAwaitReply(`127.0.0.1:${link.sshPort}`, 'Pair a runner — valid 10 minutes, single use.');
    assert.deepEqual(readSettingsRunnerHost(), { host: '127.0.0.1', port: link.sshPort });
    const pairingMessage = await general.waitForMessage('the pairing message', (message) => message.text.startsWith('Pair a runner'));
    assert.ok(pairingMessage.text.includes('Run this on the runner machine, as the account that will run jobs'), pairingMessage.text);
    assert.ok(pairingMessage.text.endsWith('Anyone with this line can attach a machine to this charness until it is used or expires.'));
    assert.equal(pairingMessage.reply_markup, undefined);
    firstPairingLine = readPairingLine(pairingMessage);
    assert.match(firstPairingLine, /^sh -c '.*cr1\.[A-Za-z0-9_-]+.*'$/s);
    const sendCall = fakeTelegram.listCalls('sendMessage').find((call) => typeof call.payload.text === 'string' && call.payload.text.startsWith('Pair a runner'));
    assert.equal(sendCall?.payload.parse_mode, 'HTML');
    const [pending] = readJson<{ pending: Array<{ messageRef: string | null; label: string; host: string; port: number }> }>(path.join(getRegistryDir(), 'pending.json')).pending;
    assert.equal(pending.messageRef, `tg:${group.id}:${generalTopicThreadId}#${pairingMessage.message_id}`);
    assert.deepEqual([pending.label, pending.host, pending.port], ['@fake_charness_bot', '127.0.0.1', link.sshPort]);
    assert.match(readAuthorizedKeys(), /charness-pairing:/);
  });

  it('the line run on the runner machine pairs it: the message turns into «paired» and loses the line; authorized_keys holds the machine\'s key, not the temporary one', async () => {
    const pairingMessage = general.listMessages().find((message) => message.text.startsWith('Pair a runner'));
    assert.ok(pairingMessage, 'the pairing message is still there');
    const result = await runPairingLineAsync(firstPairingLine);
    assert.equal(result.status, 0, result.output);
    await general.waitForMessageText('the pairing message to read paired', pairingMessage, (text) => /^Runner “[a-z0-9-]+” paired \d{1,2} \S+ \d{2}:\d{2}\.$/u.test(text));
    assert.ok(!pairingMessage.text.includes('cr1.') && !pairingMessage.text.includes('sh -c'), 'the line is gone from the message');
    const { runners } = readPaired();
    assert.equal(runners.length, 1);
    [{ id: runnerId, name: runnerName }] = runners;
    assert.ok(pairingMessage.text.includes(`“${runnerName}”`), pairingMessage.text);
    assert.match(readAuthorizedKeys(), new RegExp(`charness-runner:${runnerId}`));
    assert.doesNotMatch(readAuthorizedKeys(), /charness-pairing:/);
  });

  it('the utility holds the link: /runners lists the machine online, and the live probe adds its hardware, jobs and capabilities', async () => {
    runner = startRunner(link);
    await waitUntil(() => readRunnerStatus()?.state === 'linked', 'the runner utility to report a linked state', linkTimeoutMs);
    const list = await general.sendAndAwaitReply('/runners', `${runnerName} — online`);
    assert.deepEqual(general.getKeyboardData(list), [['rnr_pair'], [`rnr_${readPaired().rev}_0_p`, `rnr_${readPaired().rev}_0_x`], ['rnr_refresh']]);
    await general.waitForMessageText('the live data on the list', list, (text) => text.includes('jobs: 0 running, 0 queued') && text.includes('can: ') && !text.includes('Checking the machines'));
    assert.match(list.text, /RAM \d/);
  });

  it('Pause marks the machine and the list says so; a keyboard of an older revision only says the list changed; Resume undoes it', async () => {
    const list = general.listMessages().find((message) => message.text.includes(`${runnerName} — online`));
    assert.ok(list);
    const revision = readPaired().rev;
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_p`), `⏸ ${runnerName} paused`);
    await general.waitForMessageText('the list to read paused', list, (text) => text.includes(`${runnerName} — online · paused`));
    assert.equal(readPaired().runners[0].isPaused, true);
    assert.deepEqual(general.getKeyboardLabels(list)[1], [`${runnerName}: Resume`, `${runnerName}: Remove`]);

    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_x`), staleListToast, 'the keyboard of the revision before the pause');
    assert.equal(readPaired().runners.length, 1, 'nothing was removed');

    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${readPaired().rev}_0_r`), `▶️ ${runnerName} resumed`);
    await general.waitForMessageText('the list to read resumed', list, (text) => !text.includes(' · paused'));
    assert.equal(readPaired().runners[0].isPaused, false);
  });

  it('Remove asks first and Cancel keeps the machine; Remove for sure takes its key out, empties the list, and the machine is refused and says it was removed', async () => {
    const list = general.listMessages().find((message) => message.text.includes(`${runnerName} — online`));
    assert.ok(list);
    const revision = readPaired().rev;
    await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_x`);
    await general.waitForMessageText('the question', list, (text) => text === `Remove ${runnerName}? Its key is deleted and it stops connecting. Jobs running there are killed.`);
    assert.deepEqual(general.getKeyboardData(list), [[`rnr_${revision}_0_xy`, `rnr_${revision}_0_xn`]]);
    await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_xn`);
    await general.waitForMessageText('the list back', list, (text) => text.startsWith('Runners — machines'));
    assert.equal(readPaired().runners.length, 1, 'Cancel removed nothing');

    await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_x`);
    await general.waitForMessageText('the question again', list, (text) => text.startsWith(`Remove ${runnerName}?`));
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_xy`), `✅ ${runnerName} removed`);
    await general.waitForMessageText('the empty list', list, (text) => text.includes('No runners yet.'));
    assert.equal(readPaired().runners.length, 0);
    assert.doesNotMatch(readAuthorizedKeys(), /charness-runner:/);
    assert.equal(fs.existsSync(path.join(getRegistryDir(), 'link', `${runnerId}.sock`)), false, 'its link is cut');

    const refused = sshToHubWithRunnerKey(link, [], 'link');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Permission denied/, 'sshd no longer knows its key');
    await waitUntil(() => readRunnerStatus()?.state === 'removed', 'the runner to learn it was removed', linkTimeoutMs);
  });

  it('a second pairing needs no address; after a restart of the bot the message is found again from the registry and turns to «expired»; the expired code and the used one are refused', async () => {
    const list = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    await general.tapAndAwaitAnswer(list, 'rnr_pair');
    const second = await general.waitForMessage('the second pairing message', (message) => message.text.startsWith('Pair a runner') && message.message_id > list.message_id);
    secondPairingLine = readPairingLine(second);
    assert.notEqual(secondPairingLine, firstPairingLine);
    assert.deepEqual(readSettingsRunnerHost(), { host: '127.0.0.1', port: link.sshPort }, 'the address was kept');

    await getCharness().stop();
    await startCharness();
    expireOpenPairings();
    await general.waitForMessageText('the pairing message to read expired', second, (text) => text === 'Pairing code expired.');
    assert.equal(readJson<{ pending: unknown[] }>(path.join(getRegistryDir(), 'pending.json')).pending.length, 0, 'the expired code is swept');
    assert.doesNotMatch(readAuthorizedKeys(), /charness-pairing:/);

    const usedAgain = await runPairingLineAsync(firstPairingLine);
    assert.notEqual(usedAgain.status, 0, 'a used line is refused');
    const expiredLine = await runPairingLineAsync(secondPairingLine);
    assert.notEqual(expiredLine.status, 0, 'an expired line is refused');
    assert.equal(readPaired().runners.length, 0, 'neither paired a machine');
  });

  it('the pairing code is nowhere in the output trace, the console log or the bot\'s own output — the trace keeps only the length of the message', async () => {
    await getCharness().stop();
    const codes = [firstPairingLine, secondPairingLine].map((line) => /cr1\.[A-Za-z0-9_-]+/.exec(line)?.[0] ?? '');
    assert.ok(codes.every((code) => code.length > 100), 'the codes were read from the lines');
    const trace = readOutputTrace();
    assert.ok(trace.length > 0, 'the trace is on and has recorded the run');
    assert.ok(trace.includes(secretTracePreview), 'the secret sends are in the trace, withheld');
    const consoleLog = readConsoleLogs();
    for (const code of codes) {
      assert.ok(!trace.includes(code), 'not in the trace');
      assert.ok(!consoleLog.includes(code), 'not in the console log');
      assert.ok(!`${earlierOutput}${getCharness().output}`.includes(code), 'not in the bot\'s output');
    }
    assert.ok(!trace.includes('Anyone with this line'), 'not even the text around it');
  });
});
