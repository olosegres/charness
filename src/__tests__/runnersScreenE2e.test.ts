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
 *     asked again) → the right one is kept in settings.json and the pairing follows as ONE message — the explanation, then the line — HTML
 *     with the line in a <pre>, under it the row that picks how many jobs the new machine runs at once (1 ticked; 2 is chosen before the line is used)
 *   → the line run on the runner machine WITHOUT its `sudo`, by the account itself (its last word names that account), pairs it: the message turns
 *     into «Runner “…” paired …» naming the 2 jobs at once, its line and keyboard are gone, the registry entry holds the 2 the key line of the machine is in authorized_keys and the temporary one is not
 *   → the utility holds the link: /runners lists the machine online, and the live probe adds its hardware, jobs and capabilities
 *   → «Jobs at once» (the machine's button on the list) opens the picker with the hardware the live probe reported and a suggestion; picking
 *     2 tells the runner NOW — its private Pueue's default group runs two jobs in parallel (read back from Pueue itself), the registry holds 2, the
 *     list says «2 at once» — and a picker of an older revision sets nothing
 *   → Pause marks it (a toast, the list says paused, Resume instead of Pause), Resume undoes it; a keyboard of an older revision only
 *     says the list changed and removes nothing
 *   → Remove asks first; Cancel keeps it; with a background job running on the machine, Remove for sure takes it out of the registry
 *     and of authorized_keys, empties the list, the machine's key is refused by sshd, the utility reports it was removed and the job is
 *     killed (the cleanup is the runner utility's: this step is red until it exists)
 *   → a second pairing needs no address (it was kept); across a restart of the bot the message is found again from the instance's own
 *     record and turns into «Pairing code expired.» when its code runs out, and the expired code is gone from authorized_keys; the first
 *     line, already used, and the expired one are refused on the runner machine
 *   → a pairing whose message the person deleted by hand: when its code runs out the code still settles (Telegram answers «message to
 *     edit not found», which is settled, not retried) and the instance's record is empty
 *   → a third code is used on a second machine while the bot is STOPPED: the restarted bot turns its message into «paired"
 *   → a runner's link that changes address (its status file says so) is said once in General and pinned — not at the next looks, not after a
 *     restart — and the note stays on the list
 *   → thirty seeded machines (a registry written by hand, a snapshot each) make a list of several pages: Next / Previous edit the SAME
 *     message, every page fits Telegram's limit (the fake Bot API refuses a longer text, as the real one does), and a button on a later
 *     page pauses and removes the machine it names — by its place in the whole list and the revision — and nothing else
 *   → the pairing code and the private key in the line are nowhere in the output trace, the console log or the bot's output: the trace keeps the messages' length only
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason,
 * CI fails without. Nothing leaves the machine: the Bot API and the sshd are on loopback. Everything the test starts is stopped in
 * `after`. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getRunnerLinkStatus, writeLinkState } from '../runners/linkControl';
import * as path from 'node:path';
import { testNodeModulesEnvName } from '../runnerUtility/appInstall';
import { readLastProbe } from '../remoteRun/runners';
import { getRemoteRunCacheDir } from '../remoteRun/ssh';
import type { RunnerStatus } from '../runnerUtility/runnerConfig';
import { getPairCodeFields } from '../runners/pairCode';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { maxScreenTextChars } from '../utils/runnersScreenPlan';
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
import { readCodeOfLine, readPayloadOfLine } from './runnersTestKit';

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
  let thirdPairingLine = '';
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
    runners: Array<{ id: string; name: string; isPaused: boolean; jobsAtOnce?: number }>;
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

  /** The pasted line run on a runner machine (default: the main one), WITHOUT blocking this process (the fake Bot API lives in it). */
  function runPairingLineAsync(line: string, machineHome: string = link.runnerHome): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', line], {
        env: {
          HOME: machineHome,
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

  /** The pairing messages this instance has sent and not yet settled (`DATA_DIR/runner-pairing-messages.json`). */
  function readPairingStore(): Array<{ pairId: string; key: string; messageId: number }> {
    const filePath = path.join(getLayout().dataDir, 'runner-pairing-messages.json');
    return fs.existsSync(filePath) ? readJson<{ messages: Array<{ pairId: string; key: string; messageId: number }> }>(filePath).messages : [];
  }

  /** A second runner machine: an empty HOME with Pueue where the utility looks for its own (nothing is downloaded), like the kit's first one. */
  function createSecondMachine(): string {
    const machineHome = path.join(link.root, 'machine2');
    const binDir = getRunnerHomePaths(machineHome).binDir;
    fs.mkdirSync(binDir, { recursive: true });
    for (const tool of ['pueue', 'pueued']) fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(binDir, tool));
    return machineHome;
  }

  /** `pueue <args>` against the main runner machine's private Pueue (the one `charness-runner run` keeps). */
  function runRunnerPueue(args: string[]): string {
    const paths = getRunnerHomePaths(link.runnerHome);
    const result = spawnSync(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, ...args], { encoding: 'utf8', timeout: 30_000 });
    return `${result.stdout}${result.stderr}`;
  }

  /** Does the machine's Pueue have a task in the Running state? (The group's own «running» is lower case.) */
  function checkIsRunnerJobRunning(): boolean {
    return /\bRunning\b/.test(runRunnerPueue(['status']));
  }

  /**
   * Machines that exist only as registry entries and last-probe snapshots: written by hand the way the hub and the real probe write them
   * (`paired.json` under a new revision; `<cache>/<name>.probe.json` as `{ seenAtMs, text }` — read back through the real reader), so a
   * list long enough for several pages needs no thirty machines. None is online. Returns their names.
   */
  function seedMachines(count: number): string[] {
    const cacheDir = getRemoteRunCacheDir({}, getLayout().instanceHome);
    fs.mkdirSync(cacheDir, { recursive: true });
    const snapshotText = ['os=Linux', 'os_name=Ubuntu', 'os_version=24.04', 'arch=x86_64', `cpu_model=${'M'.repeat(300)}`, 'cpu_cores=8', 'ram_total_mb=65536', 'ram_free_mb=40960', 'disk_free_mb=512000', 'pueue=4.0.4'].join('\n');
    const names = Array.from({ length: count }, (_value, index) => `seed-${index.toString().padStart(2, '0')}`);
    const current = readJson<{ rev: number; runners: object[] }>(path.join(getRegistryDir(), 'paired.json'));
    const seeded = names.map((name, index) => {
      const publicKey = generateEd25519KeyPair(name).publicKey;
      const id = (index + 1).toString(16).padStart(12, '0');
      return {
        id, name, publicKey, keyFingerprint: `SHA256:seed${index}`, hostKey: publicKey, workDir: '/home/runner/.charness-runner/work', os: 'Linux', arch: 'x86_64', version: '3.8.0',
        serviceKind: 'user-service', pairedAtMs: 1_000 + index, pairId: (index + 1000).toString(16).padStart(12, '0'), label: '@fake_charness_bot', host: '127.0.0.1', port: link.sshPort, isPaused: false,
      };
    });
    const pairedPath = path.join(getRegistryDir(), 'paired.json');
    fs.writeFileSync(`${pairedPath}.by-hand`, `${JSON.stringify({ rev: current.rev + 1, runners: [...current.runners, ...seeded] }, null, 2)}\n`);
    fs.renameSync(`${pairedPath}.by-hand`, pairedPath);
    for (const name of names) {
      fs.writeFileSync(path.join(cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs: Date.now() - 60_000, text: snapshotText }), { mode: 0o600 });
    }
    assert.ok(readLastProbe(cacheDir, names[0]) !== null, 'the snapshots are in the format the real probe writes');
    return names;
  }

  /** The names of the machines a list message shows, in order (the heading line of each block starts with the name). */
  function readListedNames(text: string): string[] {
    return [...text.matchAll(/^([a-z0-9-]+) — /gm)].map((match) => match[1]);
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

  /** The code a pairing line puts together (the line holds its values once, as shell variables). */
  function readLineCode(line: string): string {
    return readCodeOfLine(line);
  }

  /** The line as the runner account pastes it in its own terminal: without its `sudo`, and with the account that runs this flow as the last word (the line pairs the account it runs as). */
  function toOwnAccountLine(line: string): string {
    const withoutSudo = line.replace(/^sudo /, '');
    return `${withoutSudo.slice(0, withoutSudo.lastIndexOf(' ') + 1)}${os.userInfo().username}`;
  }

  it('the right address is kept in settings.json and the pairing follows as ONE message — the explanation, then the line — HTML with the line in a <pre>, under it the row that picks how many jobs the new machine runs at once', async () => {
    await general.sendAndAwaitReply(`127.0.0.1:${link.sshPort}`, 'Pair a runner — valid 10 minutes, single use;');
    assert.deepEqual(readSettingsRunnerHost(), { host: '127.0.0.1', port: link.sshPort });
    const pairingMessage = await general.waitForMessage('the pairing message', (message) => message.text.startsWith('Pair a runner'));
    assert.ok(pairingMessage.text.includes('The last word, «runner», is the account that runs the agents\' code'), pairingMessage.text);
    assert.ok(pairingMessage.text.includes('No admin rights? Run the line in that account\'s own terminal without «sudo»:'), pairingMessage.text);
    assert.ok(!general.listMessages().some((message) => message.text.startsWith('② Without admin rights')), 'there is no second message');
    assert.deepEqual(general.getKeyboardLabels(pairingMessage), [['Jobs at once:'], ['1 ✓', '2', '3', '4']]);
    const adminLine = readPairingLine(pairingMessage);
    assert.match(adminLine, /^sudo sh -c '.*"cr2\.\$u,\$h,\$p,[0-9a-f]+,\$y,\$z,\$k".*' sh runner$/s);
    firstPairingLine = toOwnAccountLine(adminLine);
    assert.match(firstPairingLine, new RegExp(`^sh -c '.*"cr2\\.\\$u,\\$h,\\$p,[0-9a-f]+,\\$y,\\$z,\\$k".*' sh ${os.userInfo().username}$`, 's'));
    assert.equal(readLineCode(adminLine), readLineCode(firstPairingLine), 'the same code, the other way of running it');
    const sendCall = fakeTelegram.listCalls('sendMessage').find((call) => call.payload.text === pairingMessage.text);
    assert.equal(sendCall?.payload.parse_mode, 'HTML');
    const [pending] = readJson<{ pending: Array<{ pairId: string; messageRef: string | null; label: string; host: string; port: number }> }>(path.join(getRegistryDir(), 'pending.json')).pending;
    assert.equal(pending.messageRef, null, 'the shared registry carries credentials only');
    // The instance writes its record after the send has been answered, so a message can be on the fake Bot API a moment before its record is.
    await waitUntil(() => readPairingStore().length === 1, 'the instance to record the message it sent', 10_000);
    assert.deepEqual(readPairingStore().map((message) => [message.pairId, message.key, message.messageId]), [
      [pending.pairId, `${group.id}:${generalTopicThreadId}`, pairingMessage.message_id],
    ], 'the instance keeps its own record of the message');
    assert.deepEqual([pending.label, pending.host, pending.port], ['@fake_charness_bot', '127.0.0.1', link.sshPort]);
    assert.match(readAuthorizedKeys(), /charness-pairing:/);
    assert.deepEqual(general.getKeyboardData(pairingMessage), [['rnr_pjinfo'], [1, 2, 3, 4].map((count) => `rnr_pj_${pending.pairId}_${count}`)]);
    // The operator wants two side by side on this machine: chosen while the code is open, kept for the machine that will use it.
    assert.equal(await general.tapAndAwaitAnswer(pairingMessage, `rnr_pj_${pending.pairId}_2`), 'The new machine will run 2 at once.');
    await waitUntil(() => readJson<{ pending: Array<{ jobsAtOnce?: number }> }>(path.join(getRegistryDir(), 'pending.json')).pending[0]?.jobsAtOnce === 2, 'the choice to be kept on the open code', 10_000);
    await waitUntil(() => general.getKeyboardLabels(pairingMessage)[1]?.join(' ') === '1 2 ✓ 3 4', 'the tick to move to 2', 10_000);
    assert.equal(pairingMessage.text.includes('cr2.') || pairingMessage.text.includes('sh -c'), true, 'the line is still in the message: only the keyboard changed');
  });

  it('the line run on the runner machine without its sudo, by the account itself, pairs it: the message turns into «paired» and loses its line; authorized_keys holds the machine\'s key, not the temporary one', async () => {
    const pairingMessage = general.listMessages().find((message) => message.text.startsWith('Pair a runner'));
    assert.ok(pairingMessage, 'the pairing message is still there');
    const result = await runPairingLineAsync(firstPairingLine);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Paired with /);
    assert.match(result.output, /Keep it running:/, 'the account\'s way installs no service: the help for keeping it running is printed');
    await general.waitForMessageText('the pairing message to read paired', pairingMessage, (text) => /^Runner “[a-z0-9-]+” paired \d{1,2} \S+ \d{2}:\d{2}\.\nJobs at once: 2 — change it in \/runners\.$/u.test(text));
    assert.ok(!pairingMessage.text.includes('cr2.') && !pairingMessage.text.includes('sh -c'), 'the line is gone from the message');
    assert.equal(pairingMessage.reply_markup, undefined, 'the keyboard goes with the line');
    assert.notEqual(pairingMessage.isDeleted, true, 'the message stays and says what became of the code');
    await waitUntil(() => readPairingStore().length === 0, 'the settled message to leave the instance\'s record', 10_000);
    const { runners } = readPaired();
    assert.equal(runners.length, 1);
    [{ id: runnerId, name: runnerName }] = runners;
    assert.equal(runners[0].jobsAtOnce, 2, 'the choice made on the message is the runner\'s');
    assert.ok(pairingMessage.text.includes(`“${runnerName}”`), pairingMessage.text);
    assert.match(readAuthorizedKeys(), new RegExp(`charness-runner:${runnerId}`));
    assert.doesNotMatch(readAuthorizedKeys(), /charness-pairing:/);
  });

  it('the utility holds the link: /runners lists the machine online, and the live probe adds its hardware, jobs and capabilities', async () => {
    runner = startRunner(link);
    await waitUntil(() => readRunnerStatus()?.state === 'linked', 'the runner utility to report a linked state', linkTimeoutMs);
    // The runner reports «linked» when the gate's marker arrives; the hub counts it online a moment later, when the gate's own ssh handshake to the
    // runner is done and its socket is published — a list asked in between says «offline» and is not refreshed for 90 seconds.
    await waitUntil(async () => (await getRunnerLinkStatus(getRegistryDir(), runnerId)).isOnline, 'the hub to see the link (its socket accepts)', linkTimeoutMs);
    const list = await general.sendAndAwaitReply('/runners', `${runnerName} — online`);
    assert.deepEqual(general.getKeyboardData(list), [['rnr_pair'], [`rnr_${readPaired().rev}_0_p`, `rnr_${readPaired().rev}_0_x`], [`rnr_${readPaired().rev}_0_j`], ['rnr_refresh']]);
    await general.waitForMessageText('the live data on the list', list, (text) => text.includes('jobs: 0 running, 0 queued') && text.includes('can: ') && !text.includes('Checking the machines'));
    assert.match(list.text, /RAM \d/);
    assert.match(list.text, /jobs: 0 running, 0 queued · projects: 0 · 2 at once/, 'the number chosen on the pairing message');
  });

  it('«Jobs at once» opens the picker with the machine\'s hardware, and picking a number tells the runner NOW — its Pueue runs that many in parallel — saves it, redraws the list; a picker of an older revision sets nothing', async () => {
    const list = general.listMessages().find((message) => message.text.includes(`${runnerName} — online`));
    assert.ok(list);
    const revision = readPaired().rev;
    const readPueueDefaultParallel = (): number => (JSON.parse(runRunnerPueue(['status', '--json'])) as { groups: Record<string, { parallel_tasks: number }> }).groups.default.parallel_tasks;
    assert.notEqual(readPueueDefaultParallel(), 3, 'before the pick Pueue does not run 3: nobody has told it yet');
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_j`), '');
    await general.waitForMessageText('the picker', list, (text) => text.startsWith(`How many jobs may ${runnerName} run at once? Now 2.`));
    assert.match(list.text, /Suggested for \d+ cores and [\d.]+ GB: [1-4]\.$/, 'the suggestion is made from what the live probe reported');
    assert.deepEqual(general.getKeyboardLabels(list), [['1', '2 ✓', '3', '4', '6', '8'], ['‹ Back']]);

    // A picker of an older revision only says the list changed, draws the list, and sets nothing.
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision - 1}_0_j3`), staleListToast);
    assert.equal(readPaired().runners[0].jobsAtOnce, 2, 'nothing was set');
    await general.waitForMessageText('the list after the stale tap', list, (text) => text.startsWith('Runners — machines'));

    await general.tapAndAwaitAnswer(list, `rnr_${readPaired().rev}_0_j`);
    await general.waitForMessageText('the picker for the real pick', list, (text) => text.startsWith(`How many jobs may ${runnerName} run at once?`));
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${readPaired().rev}_0_j3`), `${runnerName}: 3 at once`, 'the machine was told (it is online): the toast says it applied');
    assert.equal(readPaired().runners[0].jobsAtOnce, 3);
    await general.waitForMessageText('the list with the new number', list, (text) => text.startsWith('Runners — machines') && text.includes('3 at once'));
    assert.deepEqual(general.getKeyboardLabels(list)[2], [`${runnerName}: Jobs at once — 3`]);
    // The load-bearing part: Pueue itself on the runner machine holds the number (told over the link by `runner.sh apply-groups`, not left to a job's `prepare`).
    assert.equal(readPueueDefaultParallel(), 3);
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

    // A background job is running on the machine: removing it must stop the job too (Pueue itself survives a lost link).
    runRunnerPueue(['add', '--', 'sleep', '600']);
    await waitUntil(checkIsRunnerJobRunning, 'a job to run on the machine', 30_000);

    await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_x`);
    await general.waitForMessageText('the question again', list, (text) => text.startsWith(`Remove ${runnerName}?`));
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_0_xy`), '', 'the tap is answered at once, without a toast');
    // The machine is online: the hub ended its jobs over the link, and says so in a message of its own.
    await general.waitForMessage('the outcome of the removal', (message) => message.text === `✅ ${runnerName} removed. Its key is deleted and the jobs it was running are stopped.`);
    await general.waitForMessageText('the empty list', list, (text) => text.includes('No runners yet.'));
    assert.equal(readPaired().runners.length, 0);
    assert.doesNotMatch(readAuthorizedKeys(), /charness-runner:/);
    assert.equal(fs.existsSync(path.join(getRegistryDir(), 'link', `${runnerId}.sock`)), false, 'its link is cut');

    const refused = sshToHubWithRunnerKey(link, [], 'link');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Permission denied/, 'sshd no longer knows its key');
    await waitUntil(() => readRunnerStatus()?.state === 'removed', 'the runner to learn it was removed', linkTimeoutMs);
    // The promise the confirmation makes («Jobs running there are killed»). The runner kills them when it learns it was removed.
    await waitUntil(() => !checkIsRunnerJobRunning(), 'the removed machine to kill its running job', linkTimeoutMs);
  });

  it('a second pairing needs no address; after a restart of the bot the message is found again from its own record and turns to «expired»; the expired code and the used one are refused', async () => {
    const list = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    await general.tapAndAwaitAnswer(list, 'rnr_pair');
    const second = await general.waitForMessage('the second pairing message', (message) => message.text.startsWith('Pair a runner') && message.message_id > list.message_id);
    secondPairingLine = toOwnAccountLine(readPairingLine(second));
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

  it('a pairing message the person deleted by hand: the code still settles when it runs out — the instance\'s record empties, nothing is retried', async () => {
    const list = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    await general.tapAndAwaitAnswer(list, 'rnr_pair');
    const fourth = await general.waitForMessage('the fourth pairing message', (message) => message.text.startsWith('Pair a runner') && message.message_id > list.message_id);
    // The bot records a message just after Telegram has it: the record is read once it is in it.
    await waitUntil(() => readPairingStore().length === 1, 'the message to be followed', 10_000);
    // The person deletes the message by hand (the fake Bot API then answers «message to edit not found» to an edit of it, like Telegram).
    fourth.isDeleted = true;
    expireOpenPairings();
    await waitUntil(() => readPairingStore().length === 0, 'the message to leave the instance\'s record, though it could not be edited', 10_000);
    assert.equal(readJson<{ pending: unknown[] }>(path.join(getRegistryDir(), 'pending.json')).pending.length, 0, 'the expired code is swept');
    assert.equal(readPaired().runners.length, 0, 'nothing was paired');
  });

  it('a code used while the bot is stopped: the restarted bot turns its message into «paired»', async () => {
    const list = await general.sendAndAwaitReply('/runners', 'No runners yet.');
    await general.tapAndAwaitAnswer(list, 'rnr_pair');
    const third = await general.waitForMessage('the third pairing message', (message) => message.text.startsWith('Pair a runner') && message.message_id > list.message_id);
    thirdPairingLine = toOwnAccountLine(readPairingLine(third));

    await getCharness().stop();
    const result = await runPairingLineAsync(thirdPairingLine, createSecondMachine());
    assert.equal(result.status, 0, result.output);
    assert.ok(third.text.startsWith('Pair a runner'), 'nobody edited the message while the bot was down');
    assert.equal(readPaired().runners.length, 1, 'the second machine is paired');

    await startCharness();
    await general.waitForMessageText('the pairing message to read paired', third, (text) => /^Runner “[a-z0-9-]+” paired \d{1,2} \S+ \d{2}:\d{2}\.\nJobs at once: 1 — change it in \/runners\.$/u.test(text));
    assert.ok(!third.text.includes('cr2.'), 'the line is gone');
    await waitUntil(() => readPairingStore().length === 0, 'the settled message to leave the instance\'s record', 10_000);
  });

  it('a link that changes address is said ONCE in General, pinned — also across a restart of the bot — and its note stays on the list and in `ls`', async () => {
    // The second machine has no gate holding a link here, so its status file is the test's to write (a gate would rewrite it at every heartbeat).
    const [{ id: secondId, name: secondName }] = readPaired().runners;
    const changedAtMs = Date.now();
    writeLinkState(getRegistryDir(), secondId, {
      pid: process.pid,
      sinceMs: changedAtMs,
      lastBeatMs: changedAtMs,
      endedAtMs: null,
      source: '203.0.113.9',
      sourceChanges: [{ fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: changedAtMs, isLiveReplacement: true }],
    });
    const isNotice = (message: { text: string }): boolean => message.text.startsWith(`${secondName}: ⚠️ A link from 203.0.113.9 took over while the one from 198.51.100.7 was still up`);
    await waitUntil(() => general.listMessages().some(isNotice), 'the bot to say it in General', 15_000);
    const notice = general.listMessages().find(isNotice);
    assert.ok(notice !== undefined);
    await waitUntil(() => fakeTelegram.listPinnedMessageIds().includes(notice.message_id), 'the notice to be pinned — a pin pierces a muted topic', 10_000);
    // Not again at the next looks of the watcher (5 s apart), nor after the bot restarts: what it told is its own record on disk.
    await new Promise((resolve) => { setTimeout(resolve, 8_000); });
    assert.equal(general.listMessages().filter(isNotice).length, 1, 'told once');
    await getCharness().stop();
    await startCharness();
    await new Promise((resolve) => { setTimeout(resolve, 8_000); });
    assert.equal(general.listMessages().filter(isNotice).length, 1, 'and not again after a restart');
    const list = await general.sendAndAwaitReply('/runners', `${secondName} —`);
    assert.match(list.text, /⚠️ A link from 203\.0\.113\.9 took over while the one from 198\.51\.100\.7 was still up/, 'the list keeps the note');
  });

  it('a long list is split over pages through the built bot: Next / Previous edit the same message within Telegram\'s limit, and a later page\'s buttons act on the machine they name', async () => {
    seedMachines(30);
    const registryNames = readPaired().runners.map((runner) => runner.name);
    assert.equal(registryNames.length, 31, 'the second machine and the thirty seeded ones');
    const list = await general.sendAndAwaitReply('/runners', 'Page 1 of ');
    const pageCount = Number(/Page 1 of (\d+)/.exec(list.text)?.[1]);
    assert.ok(pageCount >= 2, `${pageCount} pages`);

    // Next through every page: one message, each page within the bound, every machine once, in the registry's order.
    const seen: string[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      await general.waitForMessageText(`page ${page} of the list`, list, (text) => text.includes(`Page ${page} of ${pageCount}`) && !text.includes('Checking the machines'));
      assert.ok(list.text.length <= maxScreenTextChars, `page ${page}: ${list.text.length} characters`);
      seen.push(...readListedNames(list.text));
      const labels = general.getKeyboardLabels(list).flat();
      assert.equal(labels.includes('‹ Previous'), page > 1, `Previous on page ${page}`);
      assert.equal(labels.includes('Next ›'), page < pageCount, `Next on page ${page}`);
      if (page < pageCount) assert.equal(await general.tapAndAwaitAnswer(list, general.getButtonData(list, 'Next ›')), '');
    }
    assert.deepEqual(seen, registryNames);
    assert.ok(fakeTelegram.listCalls('editMessageText').every((call) => String(call.payload.text).length <= 4096), 'no edit was refused as too long');

    // Previous goes back on the same message.
    assert.equal(await general.tapAndAwaitAnswer(list, general.getButtonData(list, '‹ Previous')), '');
    await general.waitForMessageText('the page before', list, (text) => text.includes(`Page ${pageCount - 1} of ${pageCount}`));
    assert.equal(await general.tapAndAwaitAnswer(list, 'rnr_pg_1'), '');
    await general.waitForMessageText('page 2', list, (text) => text.includes(`Page 2 of ${pageCount}`) && !text.includes('Checking the machines'));

    // A button on page 2 names a machine by its place in the WHOLE list and the revision; only that machine is acted on.
    const [pauseData, removeData] = general.getKeyboardData(list)[1];
    const target = readListedNames(list.text)[0];
    const [, , targetIndex] = /^rnr_(\d+)_(\d+)_p$/.exec(pauseData) ?? [];
    assert.equal(registryNames[Number(targetIndex)], target, 'the button\'s place is the machine\'s place in the whole list');
    assert.ok(Number(targetIndex) > 0);
    assert.equal(await general.tapAndAwaitAnswer(list, pauseData), `⏸ ${target} paused`);
    assert.deepEqual(readPaired().runners.filter((runner) => runner.isPaused).map((runner) => runner.name), [target], 'only the named machine');
    await general.waitForMessageText('page 2 after the pause', list, (text) => text.includes(`Page 2 of ${pageCount}`) && text.includes(`${target} — offline`) && text.includes(' · paused'));

    // The keyboard from before the pause is stale for every machine on the list; it only says so and draws page 2 again.
    assert.equal(await general.tapAndAwaitAnswer(list, removeData), staleListToast);
    assert.equal(readPaired().runners.length, 31, 'the stale tap removed nothing');
    await general.waitForMessageText('page 2 settled', list, (text) => text.includes(`Page 2 of ${pageCount}`) && !text.includes('Checking the machines'));

    // Remove asks about that machine; Cancel brings page 2 back; Remove for sure takes exactly it out.
    const revision = readPaired().rev;
    const freshRemoveData = general.getKeyboardData(list)[1][1];
    assert.equal(freshRemoveData, `rnr_${revision}_${targetIndex}_x`);
    await general.tapAndAwaitAnswer(list, freshRemoveData);
    await general.waitForMessageText('the question', list, (text) => text.startsWith(`Remove ${target}?`));
    await general.tapAndAwaitAnswer(list, `rnr_${revision}_${targetIndex}_xn`);
    await general.waitForMessageText('page 2 back', list, (text) => text.includes(`Page 2 of ${pageCount}`) && text.includes(`${target} — `));
    assert.equal(readPaired().runners.length, 31, 'Cancel removed nothing');
    await general.tapAndAwaitAnswer(list, freshRemoveData);
    await general.waitForMessageText('the question again', list, (text) => text.startsWith(`Remove ${target}?`));
    assert.equal(await general.tapAndAwaitAnswer(list, `rnr_${revision}_${targetIndex}_xy`), '');
    // The tap is answered at once and the removal follows (it may take long when the machine is online): the registry is read when it is done.
    await waitUntil(() => readPaired().runners.length < registryNames.length, 'the removal to reach the registry', 10_000);
    assert.deepEqual(readPaired().runners.map((runner) => runner.name), registryNames.filter((name) => name !== target), 'exactly that machine is gone');
    await general.waitForMessageText('the list on page 2 again', list, (text) => text.includes('Page 2 of ') && !text.includes(`${target} — `));
  });

  it('the pairing code is nowhere in the output trace, the console log or the bot\'s own output — the trace keeps only the length of the message', async () => {
    await getCharness().stop();
    // What is secret in a line: the code it puts together, and the private key in it (the line holds the key's body once, as a variable).
    const lines = [firstPairingLine, secondPairingLine, thirdPairingLine];
    const codes = [...lines.map(readLineCode), ...lines.map((line) => getPairCodeFields(readPayloadOfLine(line)).privateKeyBody)];
    assert.ok(codes.every((code) => code.length > 100), 'the codes and keys were read from the lines');
    const trace = readOutputTrace();
    assert.ok(trace.length > 0, 'the trace is on and has recorded the run');
    assert.ok(trace.includes(secretTracePreview), 'the secret sends are in the trace, withheld');
    const consoleLog = readConsoleLogs();
    for (const code of codes) {
      assert.ok(!trace.includes(code), 'not in the trace');
      assert.ok(!consoleLog.includes(code), 'not in the console log');
      assert.ok(!`${earlierOutput}${getCharness().output}`.includes(code), 'not in the bot\'s output');
    }
    assert.ok(!trace.includes('keep the line private') && !trace.includes('Paste it in an admin account'), 'not even the text around it');
  });
});
