/**
 * @description `/runners` (`connectors/telegram/commands/runners.ts`) wired to ports (`commandModuleHarness.ts`: a real telegraf instance
 * against the fake Bot API, recording topic sends) over a REAL throwaway hub registry (`runnersTestKit.ts`), with a canned address
 * scanner, a controllable clock and a canned live probe. Pinned:
 *
 *   • WIRING — the command, its buttons and their order; General only (a topic is sent to General, a tap from a topic is refused);
 *   • the list: empty, with machines, the live check that redraws the list when the machines answer — and does not redraw a message
 *     that has become a question (even while the question's own edit is still queued) or was drawn again since; a long list is split over
 *     pages that each fit a Telegram message (checked against the fake Bot API's own limit), runner buttons keeping their place;
 *   • the first pairing: the address step (a proposal, none found), the typed address (refused with the reason and asked again, taken
 *     and saved), a slash command ends the wait; the pairing is ONE message (the line under its explanation), HTML with the line in a `<pre>`, SECRET for the trace, and
 *     registered in this instance's own record;
 *   • the pairing message turns into «paired» when its code is used and into «expired» when it runs out — also after a restart and for a
 *     code used while the bot was down (the instance's own record of its messages), a failed edit is tried again, and another instance
 *     sharing the registry neither edits nor takes away the way back to a message;
 *   • Pause / Resume / Remove: revisioned buttons, a stale keyboard only redraws, Remove asks first and Cancel puts the list back;
 *   • a runner's link that changes address, or links that fight, are said ONCE in General and pinned — not again at the next look, after a restart or
 *     for the rest of a fight — and told again when there is something newer; no General, or a failed send, is tried again.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createRunners, runnersWatchIntervalMs } from '../connectors/telegram/commands/runners';
import { readPairingMessages, writePairingMessages } from '../connectors/telegram/runnerPairingMessages';
import { readLastProbe } from '../remoteRun/runners';
import { keyToString, type SessionKey } from '../sessionKey';
import { parseProbeOutput } from '../remoteRun/probe';
import { ensureGateWrapper } from '../runners/gateWrapper';
import type { HostKeyScanner, HubAddress } from '../runners/hubAddress';
import { cancelPairing, createPairing, redeemPairing, sweepExpiredPairings } from '../runners/hubPairing';
import { readClosedCodes, readPairedFile, readPendingFile, recordClosedCode } from '../runners/hubRegistry';
import { pairingLifetimeMs } from '../runners/pairingTiming';
import { removeRunnerAndEndItsWork } from '../runners/runnerRemoval';
import { writeLinkState } from '../runners/linkControl';
import type { LinkSourceChange } from '../runners/linkConcern';
import { unconfirmedRemovalStopAfterHours } from '../runners/removalTiming';
import type { RunnerGroupsOutcome } from '../runners/runnerGroups';
import { readRunnersOverview, type RunnersOverview } from '../runners/runnersOverview';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { TELEGRAM_HARD_LIMIT } from '../connectors/telegram/messageSplit';
import { maxScreenTextChars } from '../utils/runnersScreenPlan';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness, type RecordedSend } from './commandModuleHarness';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const ownKey = generateEd25519KeyPair('own').publicKey;
const strangerKey = generateEd25519KeyPair('stranger').publicKey;
/** The host key of a hub whose sshd offers an 8192-bit RSA key only: its line cannot fit one Telegram message, whatever the address. */
const hugeRsaHostKey = `ssh-rsa ${Buffer.alloc(1047, 7).toString('base64')}`;
const minute = 60 * 1000;
const defaultProbeText = [
  'os=Linux', 'os_name=Ubuntu', 'os_version=24.04', 'arch=x86_64', 'cpu_model=AMD Ryzen 7 9700X', 'cpu_cores=8', 'cpu_threads=16', 'load=0.4',
  'ram_total_mb=65536', 'ram_free_mb=40960', 'disk_free_mb=512000', 'pueue=4.0.4', 'jobs_running=2', 'jobs_queued=1', 'jobs_projects=2',
  'cap_android=yes', 'cap_android_detail=KVM, emulator', 'cap_ios=no', 'cap_ios_detail=Linux', 'cap_docker=yes', 'cap_docker_detail=', 'cap_playwright=no', 'cap_playwright_detail=',
].join('\n');

let harness: CommandHarness;
let hubFixture: HubFixture;
let cacheDir: string;
let pairingMessagesPath: string;
let linkNoticesPath: string;
/** The General the module posts link notices in (`null` = none yet) and the messages it pinned there. */
let generalKey: SessionKey | null = null;
let pinnedMessageIds: number[] = [];
/** What the canned live probe says every online machine is like. */
let liveProbeText = defaultProbeText;
/** When set, every send and edit of the module also goes through the fake Bot API, which refuses a text over Telegram's limit. */
let isLengthChecked = false;
/** When set, the sweep of expired codes waits for it before it touches the registry (a sweep queued behind the hub lock). */
let sweepGate: Promise<void> | null = null;
/** Decides an edit before it reaches the harness: a promise of "go ahead" (true) or "this edit fails" (false); null leaves it alone. */
let editHook: ((messageId: number, text: string) => Promise<boolean> | null) | null = null;
/** Makes a send of the texts it returns true for fail (Telegram refused it): the bot gets no message id back. */
let sendFailsFor: ((text: string) => boolean) | null = null;
/** What the module told the runners to apply (the entry as the registry held it), and how the runner answers. */
let appliedGroups: Array<{ name: string; jobsAtOnce: number | undefined }> = [];
let applyOutcome: RunnerGroupsOutcome = 'applied';
/** The keyboard edits the module made (the harness ids are no messages of the fake Bot API, so they are recorded rather than sent). */
let keyboardEdits: Array<{ messageId: number; keyboard: object | null }> = [];
let clockMs = Date.now();
let savedAddress: HubAddress | null = null;
let candidates: string[] = [];
/** What the canned scanner answers per `host:port`. */
let scanAnswers: Record<string, string | null> = {};
let onlineRunnerNames = new Set<string>();
const probeCalls: RunnersOverview[] = [];
/** The gates the next live probes wait for, one per probe, in the order they start (none left: a probe answers at once). */
const probeGates: Array<Promise<void>> = [];
let feature: ReturnType<typeof createRunners>;

const scanHostKey: HostKeyScanner = async (host, port) => scanAnswers[`${host}:${port}`] ?? null;

const editWithHooks: Parameters<typeof createRunners>[0]['editThreadMessageDetailed'] = async (key, messageId, text, extra) => {
  const decision = editHook?.(messageId, text) ?? null;
  if (decision !== null && !(await decision)) return 'failed';
  if (isLengthChecked) await harness.core.bot.telegram.sendMessage(harnessGroup.id, text, { message_thread_id: harnessThreadId });
  return harness.core.editThreadMessageDetailed(key, messageId, text, extra);
};

function buildPorts(): Parameters<typeof createRunners>[0] {
  return {
    ...harness.core,
    replyToThread: async (key, text, extra, options) => {
      if (sendFailsFor?.(text) === true) return null;
      if (isLengthChecked) await harness.core.bot.telegram.sendMessage(harnessGroup.id, text, { message_thread_id: harnessThreadId });
      return harness.core.replyToThread(key, text, extra, options);
    },
    editThreadMessage: async (key, messageId, text, extra) => (await editWithHooks(key, messageId, text, extra)) === 'edited',
    editThreadMessageDetailed: editWithHooks,
    editThreadKeyboard: async (_key, messageId, keyboard) => {
      keyboardEdits.push({ messageId, keyboard });
      return true;
    },
    applyGroups: async (runner) => {
      appliedGroups.push({ name: runner.name, jobsAtOnce: runner.jobsAtOnce });
      return applyOutcome;
    },
    hub: hubFixture.ctx,
    pairingMessagesPath,
    linkNoticesPath,
    cacheDir,
    getGeneralKey: () => generalKey,
    pinMessage: async (_key, messageId) => {
      pinnedMessageIds.push(messageId);
      return true;
    },
    sweepExpiredCodes: async (nowMs) => {
      if (sweepGate !== null) await sweepGate;
      await sweepExpiredPairings(hubFixture.ctx, nowMs);
    },
    readRunnerHost: () => savedAddress,
    saveRunnerHost: (address) => {
      savedAddress = address;
      return null;
    },
    getBotLabel: () => '@ExampleBot',
    // The registry and the snapshots are real; which machines are "online" is the test's to say (no gate is running).
    readOverview: async (nowMs) => {
      const overview = await readRunnersOverview(hubFixture.ctx, cacheDir, nowMs);
      return { ...overview, entries: overview.entries.map((entry) => ({ ...entry, isOnline: onlineRunnerNames.has(entry.runner.name) })) };
    },
    probeOverview: async (overview, nowMs) => {
      probeCalls.push(overview);
      const gate = probeGates.shift();
      if (gate !== undefined) await gate;
      // Like the real probe, leave each answering machine's snapshot behind: the next `readOverview` reads it.
      for (const entry of overview.entries) if (entry.isOnline) writeProbeSnapshot(entry.runner.name, liveProbeText, nowMs);
      return { ...overview, entries: overview.entries.map((entry) => (entry.isOnline ? { ...entry, probe: parseProbeOutput(liveProbeText) } : entry)) };
    },
    listAddressCandidates: () => candidates,
    scanHostKey,
    ensureGateWrapper: () => { ensureGateWrapper(hubFixture.ctx); },
    now: () => clockMs,
    watchIntervalMs: 60 * minute,
  };
}

/**
 * What the real probe leaves behind (`remoteRun/runners.ts` writes `<cache>/<name>.probe.json` as `{ seenAtMs, text }`): every later
 * `readOverview` reads the machine's last snapshot from it. The read-back keeps this copy of the format honest.
 */
function writeProbeSnapshot(name: string, text: string, seenAtMs: number): void {
  fs.writeFileSync(path.join(cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs, text }), { mode: 0o600 });
  assert.equal(readLastProbe(cacheDir, name)?.seenAtMs, seenAtMs, 'the snapshot is in the format the real probe writes');
}

/** Pair a machine through the real registry: a code, then its use. Returns the code's id. */
async function pairMachine(suggestedName: string, reported: Parameters<typeof createRedeemFixture>[0] = {}): Promise<string> {
  const pairing = await createPairing(hubFixture.ctx, { host: 'host.example', port: 22, hostKey: ownKey, label: '@ExampleBot', nowMs: clockMs });
  const reply = await redeemPairing(hubFixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName, ...reported }).request, clockMs);
  assert.equal(reply.ok, true);
  return pairing.pairId;
}

function findReply(predicate: (reply: RecordedSend) => boolean): RecordedSend {
  const found = [...harness.replies].reverse().find(predicate);
  if (found === undefined) throw new Error(`no reply matched; replies: ${harness.replies.map((reply) => reply.text.slice(0, 60)).join(' | ')}`);
  return found;
}

/** The latest text of a message: its last edit, else what it was sent as. */
function readMessageText(messageId: number | null): string {
  const lastEdit = [...harness.edits].reverse().find((edit) => edit.messageId === messageId);
  return lastEdit?.text ?? harness.replies.find((reply) => reply.messageId === messageId)?.text ?? '';
}

async function waitUntilAsync(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

describe('/runners over its ports', () => {
  // A fresh harness (telegraf instance, fake Bot API) and module per test: a telegraf instance runs the FIRST action that matches, so
  // registering the buttons again on one instance would leave every tap to the first test's module.
  beforeEach(async () => {
    harness = await createCommandHarness();
    hubFixture = createHubFixture();
    cacheDir = path.join(hubFixture.root, 'cache');
    pairingMessagesPath = path.join(hubFixture.root, 'pairing-messages.json');
    linkNoticesPath = path.join(hubFixture.root, 'link-notices.json');
    generalKey = harness.key;
    pinnedMessageIds = [];
    fs.mkdirSync(cacheDir, { recursive: true });
    harness.isGeneral = true;
    liveProbeText = defaultProbeText;
    isLengthChecked = false;
    editHook = null;
    sendFailsFor = null;
    sweepGate = null;
    clockMs = Date.now();
    savedAddress = null;
    candidates = [];
    scanAnswers = {};
    onlineRunnerNames = new Set();
    probeCalls.length = 0;
    probeGates.length = 0;
    appliedGroups = [];
    applyOutcome = 'applied';
    keyboardEdits = [];
    feature = createRunners(buildPorts());
    feature.registerRunnersCommands();
    feature.registerRunnersCallbacks();
  });

  afterEach(async () => {
    await harness.stop();
    hubFixture.cleanup();
  });

  it('registers /runners and its buttons: the plain ones, then the page, the per-runner and the pairing-message patterns', () => {
    assert.deepEqual(harness.registeredCommandNames, ['runners']);
    assert.deepEqual(harness.registeredActionPatterns, ['rnr_pair', 'rnr_refresh', 'rnr_aduse', 'rnr_adother', 'rnr_pjinfo', String(/^rnr_pg_(\d+)$/), String(/^rnr_(\d+)_(\d+)_(p|r|x|xy|xn|j[1-8]?)$/), String(/^rnr_pj_([0-9a-f]{12})_([1-8])$/)]);
  });

  describe('the list', () => {
    it('a topic is sent to General and gets no list', async () => {
      harness.isGeneral = false;
      await harness.runCommand('runners');
      assert.deepEqual(harness.replies.map((reply) => reply.text), ['⚠️ Runners are managed in General — open /runners there.']);
    });

    it('with no machines: the empty text with Pair and Refresh, and no live check', async () => {
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      assert.ok(screen?.text.includes('No runners yet.'), screen?.text);
      assert.deepEqual(harness.getKeyboardData(screen), [['rnr_pair'], ['rnr_refresh']]);
      assert.equal(probeCalls.length, 0);
    });

    it('with machines: the list from the registry at once, then — when some are online — the live data on the same message', async () => {
      await pairMachine('mac');
      await pairMachine('box1');
      onlineRunnerNames = new Set(['mac']);
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      assert.ok(screen?.text.includes('mac — online'), screen?.text);
      assert.ok(screen?.text.includes('box1 — offline, never connected'), screen?.text);
      assert.ok(screen?.text.endsWith('⏳ Checking the machines…'), 'the first draw says it is checking');
      assert.deepEqual(harness.getKeyboardLabels(screen), [['＋ Pair a new runner'], ['mac: Pause', 'mac: Remove'], ['mac: Jobs at once — 1'], ['box1: Pause', 'box1: Remove'], ['box1: Jobs at once — 1'], ['↻ Refresh']]);

      await waitUntilAsync('the live redraw', () => harness.edits.length > 0);
      const redrawn = harness.edits.at(-1);
      assert.equal(redrawn?.messageId, screen?.messageId);
      assert.ok(redrawn?.text.includes('  AMD Ryzen 7 9700X, 8 cores, load 0.4 · RAM 64 GB, 40 GB free · disk 500 GB free'), redrawn?.text);
      assert.ok(redrawn?.text.includes('jobs: 2 running, 1 queued · projects: 2 · 1 at once'), redrawn?.text);
      assert.ok(redrawn?.text.includes('can: android (KVM, emulator) · docker · ios: no — Linux · playwright: no'), redrawn?.text);
      assert.ok(!redrawn?.text.includes('Checking the machines'), 'the note is gone');
      assert.equal(probeCalls.length, 1);
      assert.equal(probeCalls[0].entries.filter((entry) => entry.isOnline).length, 1, 'only the online machine is asked');
    });

    it('the live data never overwrites a message that became a question in the meantime', async () => {
      await pairMachine('mac');
      onlineRunnerNames = new Set(['mac']);
      let openProbe: () => void = () => {};
      probeGates.push(new Promise<void>((resolve) => { openProbe = resolve; }));
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      assert.ok(screen?.messageId !== null && screen?.messageId !== undefined);
      await harness.tapButton(screen.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_x`);
      const editsBeforeAnswer = harness.edits.length;
      assert.ok(harness.edits.at(-1)?.text.startsWith('Remove mac?'));
      openProbe();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert.equal(harness.edits.length, editsBeforeAnswer, 'the question stands');
    });

    it('the live data cannot draw the list over the Remove question while the question\'s own edit is still queued', async () => {
      await pairMachine('mac');
      onlineRunnerNames = new Set(['mac']);
      let openProbe: () => void = () => {};
      probeGates.push(new Promise<void>((resolve) => { openProbe = resolve; }));
      let openQuestionEdit: () => void = () => {};
      const questionEditGate = new Promise<void>((resolve) => { openQuestionEdit = resolve; });
      let markQuestionEditQueued: () => void = () => {};
      const questionEditQueued = new Promise<void>((resolve) => { markQuestionEditQueued = resolve; });
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      // The paced send queue holds the question's edit; meanwhile the probe — started from the list — finishes.
      editHook = (_messageId, text) => {
        if (!text.startsWith('Remove ')) return null;
        markQuestionEditQueued();
        return questionEditGate.then(() => true);
      };
      const tap = harness.tapButton(screen?.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_x`);
      // The probe is let go only once the question's edit IS queued — not «after 50 ms»: on a starved machine the tap had not been handled by then, the question was not
      // there yet, and a probe that finished first rightly drew the list (this test then failed 7 times in 7 on a core shared with eight busy loops).
      await questionEditQueued;
      openProbe();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert.equal(harness.edits.length, 0, `the probe drew nothing while the question's edit was pending; edits so far: ${JSON.stringify(harness.edits.map((edit) => edit.text.slice(0, 70)))}`);
      openQuestionEdit();
      await tap;
      assert.deepEqual(harness.edits.map((edit) => edit.text.slice(0, 12)), ['Remove mac? ']);
    });

    it('a live check that started before the list was drawn again does not draw its older data over the newer list', async () => {
      await pairMachine('mac');
      onlineRunnerNames = new Set(['mac']);
      let openOldProbe: () => void = () => {};
      probeGates.push(new Promise<void>((resolve) => { openOldProbe = resolve; }));
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      // Pause redraws the same message (a second probe, which answers at once) while the first probe is still out.
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_p`);
      await waitUntilAsync('the second probe to draw', () => harness.edits.some((edit) => edit.text.includes('mac — online · paused') && !edit.text.includes('Checking')));
      const editsBeforeOldProbe = harness.edits.length;
      openOldProbe();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert.equal(harness.edits.length, editsBeforeOldProbe, 'the older check drew nothing');
      assert.ok(harness.edits.at(-1)?.text.includes('mac — online · paused'), harness.edits.at(-1)?.text);
    });

    it('Refresh draws the list again on the same message', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      await pairMachine('box1');
      await harness.tapButton(screen?.messageId ?? 0, 'rnr_refresh');
      assert.ok(harness.edits.at(-1)?.text.includes('box1 — offline, never connected'), harness.edits.at(-1)?.text);
      assert.equal(harness.edits.at(-1)?.messageId, screen?.messageId);
    });

    it('a tap from a topic is refused and changes nothing', async () => {
      await pairMachine('mac');
      harness.isGeneral = false;
      await harness.tapButton(900, 'rnr_1_0_x');
      assert.deepEqual(harness.fakeTelegram.callbackAnswers, ['⚠️ Runners are managed in General — open /runners there.']);
      assert.equal(harness.edits.length, 0);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 1);
    });
  });

  describe('pairing a runner', () => {
    it('with no address saved and none found: only "Enter another address"; the next General message is the address', async () => {
      await harness.runCommand('runners');
      await harness.tapButton(findReply(() => true).messageId ?? 0, 'rnr_pair');
      const step = harness.replies.at(-1);
      assert.ok(step?.text.includes('No public address of this machine was found.'), step?.text);
      assert.deepEqual(harness.getKeyboardData(step), [['rnr_adother']]);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'no code before an address is chosen');

      // A wrong address says why and keeps asking.
      scanAnswers = { 'wrong.example:22': strangerKey, '127.0.0.1:22': ownKey };
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'wrong.example'), true);
      assert.ok(harness.replies.at(-1)?.text.startsWith('⚠️ wrong.example:22 answers with the ssh key SHA256:'), harness.replies.at(-1)?.text);
      assert.ok(harness.replies.at(-1)?.text.endsWith('Send another address, or open /runners again.'));
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'two words'), true);
      assert.ok(harness.replies.at(-1)?.text.startsWith('⚠️ the address must be a host name or an IP address'), harness.replies.at(-1)?.text);
      assert.equal(savedAddress, null);

      // The right one is saved and the pairing message follows.
      scanAnswers = { 'host.example:2222': ownKey, '127.0.0.1:2222': ownKey };
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example:2222'), true);
      assert.deepEqual(savedAddress, { host: 'host.example', port: 2222 });
      const pairing = harness.replies.at(-1);
      assert.ok(pairing?.text.startsWith('Pair a runner — valid 10 minutes, single use;'), pairing?.text);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 1);
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'hello'), false, 'the wait ended with the address');
    });

    it('"Enter another address" arms the wait and asks for the address', async () => {
      candidates = ['203.0.113.5'];
      scanAnswers = { '203.0.113.5:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.runCommand('runners');
      await harness.tapButton(findReply(() => true).messageId ?? 0, 'rnr_pair');
      const step = harness.replies.at(-1);
      assert.deepEqual(harness.getKeyboardLabels(step), [['Use 203.0.113.5:22', 'Enter another address']]);
      await harness.tapButton(step?.messageId ?? 0, 'rnr_adother');
      assert.equal(harness.replies.at(-1)?.text, 'Send the address runners will dial, as host or host:port.');
      scanAnswers = { ...scanAnswers, 'other.example:22': ownKey };
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'other.example'), true);
      assert.deepEqual(savedAddress, { host: 'other.example', port: 22 });
    });

    it('a proposal that answers with this machine\'s own key is offered, and "Use" saves it and makes the pairing message', async () => {
      candidates = ['203.0.113.5'];
      scanAnswers = { '203.0.113.5:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.runCommand('runners');
      await harness.tapButton(findReply(() => true).messageId ?? 0, 'rnr_pair');
      const step = harness.replies.at(-1);
      assert.ok(step?.text.includes("Address runners will dial: 203.0.113.5:22 — found on this machine, answers with this machine's ssh key ✓"), step?.text);
      await harness.tapButton(step?.messageId ?? 0, 'rnr_aduse');
      assert.deepEqual(savedAddress, { host: '203.0.113.5', port: 22 });
      assert.ok(harness.replies.at(-1)?.text.startsWith('Pair a runner'), harness.replies.at(-1)?.text);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending[0].host, '203.0.113.5');
    });

    it('an old address step (not remembered any more) answers "out of date" and makes no code', async () => {
      await harness.tapButton(777, 'rnr_aduse');
      assert.equal(harness.replies.at(-1)?.text, 'This question is out of date — open /runners and start again.');
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
    });

    it('with an address saved there is no step: the pairing at once, as ONE message — the explanation, then the line — HTML in a <pre>, a SECRET for the trace, within Telegram\'s limit, recorded as this instance\'s own', async () => {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
      isLengthChecked = true;
      await harness.runCommand('runners');
      const repliesBefore = harness.replies.length;
      await harness.tapButton(findReply(() => true).messageId ?? 0, 'rnr_pair');
      const sent = harness.replies.slice(repliesBefore);
      assert.equal(sent.length, 1, 'one message for the code');
      const [message] = sent;
      /** The words of an HTML pairing message with the markup taken off: what must go out if Telegram refuses the markup. */
      const decodeHtml = (html: string): string => html.replace(/<\/?pre>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      assert.deepEqual(Object.keys(message.extra ?? {}).sort(), ['parse_mode', 'reply_markup']);
      assert.equal((message.extra as { parse_mode?: string }).parse_mode, 'HTML');
      assert.deepEqual(harness.getKeyboardLabels(message), [['Jobs at once:'], ['1 ✓', '2', '3', '4']], 'the row that picks how many jobs the new machine runs at once, 1 chosen');
      assert.deepEqual(harness.getKeyboardData(message), [['rnr_pjinfo'], [1, 2, 3, 4].map((count) => `rnr_pj_${readPendingFile(hubFixture.ctx.dir).pending[0].pairId}_${count}`)]);
      assert.deepEqual(message.options, { isSecret: true, plainFallbackText: decodeHtml(message.text) }, 'a secret, with its plain twin for a refusal of the markup');
      assert.doesNotMatch(String(message.options?.plainFallbackText), /<\/?pre>|&(lt|gt|amp);/, 'the twin shows no tag and no entity');
      assert.ok(message.text.length <= 4096, `a pairing message must fit one Telegram message, is ${message.text.length}`);
      assert.ok(message.text.includes('"cr2.$u,$h,$p,'), 'the line puts the code together');
      assert.ok(!message.text.slice(message.text.indexOf('<pre>') + 5, message.text.indexOf('</pre>')).match(/[<>]/), 'the line is HTML-escaped inside the <pre>');
      assert.match(message.text, /^Pair a runner — valid 10 minutes, single use; keep the line private\.\n\nPaste it in an admin account's terminal on the runner machine: it runs code from this charness host there as root\. The last word, «runner», is the account that runs the agents' code: make it an existing standard \(non-admin\) account, not your main one\. No admin rights\? Run the line in that account's own terminal without «sudo»:\n\n<pre>sudo sh -c '/);
      assert.ok(message.text.endsWith(' runner</pre>'), 'the account is the last word of the line, and nothing follows the line');
      const [pending] = readPendingFile(hubFixture.ctx.dir).pending;
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 1, 'one code');
      assert.equal(pending.messageRef, null, 'the shared registry carries credentials only: no note of this instance\'s message');
      assert.deepEqual(readPairingMessages(pairingMessagesPath).messages, [{ pairId: pending.pairId, key: keyToString(harness.key), messageId: message.messageId, offeredAtMs: clockMs }]);
      assert.equal(pending.label, '@ExampleBot');
      assert.ok(fs.existsSync(path.join(hubFixture.ctx.dir, 'gate')), 'the gate wrapper the key line runs is in place');
    });

    it('when the message cannot be sent nothing is offered, nothing is recorded, the failure is told — and the code is CLOSED, so no credential stays open with nobody holding its line', async () => {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.runCommand('runners');
      const listMessageId = findReply(() => true).messageId ?? 0;
      sendFailsFor = (text) => text.startsWith('Pair a runner');
      await harness.tapButton(listMessageId, 'rnr_pair');
      assert.equal(readPairingMessages(pairingMessagesPath).messages.length, 0, 'nothing was recorded');
      assert.equal(harness.replies.at(-1)?.text, '⚠️ Could not make a pairing line: the message could not be sent');
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'the code is not left open');
      assert.equal(readClosedCodes(hubFixture.ctx.dir).codes.length, 1, 'it is closed, with a trace');
    });

    it('a line that cannot fit one Telegram message is not offered: the code is closed at once, nothing is sent or recorded, and the failure says how long it is and where to make the line instead', async () => {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': hugeRsaHostKey, '127.0.0.1:22': hugeRsaHostKey };
      isLengthChecked = true;
      await harness.runCommand('runners');
      const listMessageId = findReply(() => true).messageId ?? 0;
      const repliesBefore = harness.replies.length;
      await harness.tapButton(listMessageId, 'rnr_pair');
      const sent = harness.replies.slice(repliesBefore);
      assert.equal(sent.length, 1, 'one message: the failure, not the line');
      const [failure] = sent;
      assert.match(failure.text, /^⚠️ Could not make a pairing line: the line and its explanation take \d{4,} characters and a Telegram message holds 4096 \(/);
      assert.ok(failure.text.endsWith('charness runners pair --host host.example:22'), failure.text);
      assert.ok(!failure.text.includes('cr2.') && !failure.text.includes('sudo sh -c'), 'and shows no line');
      assert.ok(Number(/take (\d+) characters/.exec(failure.text)?.[1]) > TELEGRAM_HARD_LIMIT, 'the length it names is over the limit');
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'the code is closed, not left open for ten minutes');
      assert.equal(readClosedCodes(hubFixture.ctx.dir).codes.length, 1, 'with a trace that it was closed');
      assert.equal(readPairingMessages(pairingMessagesPath).messages.length, 0, 'no message is followed');
    });

    it('a saved address that stopped answering with this machine\'s key is refused with the reason, no code is made, and the next message may name another', async () => {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': strangerKey, '127.0.0.1:22': ownKey };
      await harness.tapButton(900, 'rnr_pair');
      assert.ok(harness.replies.at(-1)?.text.startsWith('⚠️ host.example:22 answers with the ssh key'), harness.replies.at(-1)?.text);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
      scanAnswers = { 'new.example:22': ownKey, '127.0.0.1:22': ownKey };
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'new.example'), true);
      assert.deepEqual(savedAddress, { host: 'new.example', port: 22 });
    });

    it('the typed address is read only in General, only while awaited, and a slash command ends the wait', async () => {
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), false, 'nothing asked yet');
      await harness.tapButton(900, 'rnr_adother');
      harness.isGeneral = false;
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), false, 'not General: left alone');
      harness.isGeneral = true;
      assert.equal(await feature.handleRunnersAddressText(harness.key, '/status'), false, 'a command goes on to run');
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), false, 'and it ended the wait');
    });

    it('cancelRunnersAddressWait ends the wait — what the text handler does for any slash command, a bot command included', async () => {
      await harness.tapButton(900, 'rnr_adother');
      feature.cancelRunnersAddressWait(harness.key);
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), false);
      assert.equal(savedAddress, null);
    });

    it('an address typed after the wait ran out is not taken', async () => {
      await harness.tapButton(900, 'rnr_adother');
      clockMs += 11 * minute;
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), false);
    });

    it('a typed address that is only unverified (this machine\'s own sshd could not be read) is accepted with the note, before the pairing message', async () => {
      await harness.tapButton(900, 'rnr_adother');
      scanAnswers = { 'host.example:22': ownKey };
      assert.equal(await feature.handleRunnersAddressText(harness.key, 'host.example'), true);
      const texts = harness.replies.map((reply) => reply.text);
      assert.ok(texts.some((text) => text.startsWith("ℹ️ this machine's own sshd could not be read on 127.0.0.1:22")), texts.join(' | '));
      assert.ok(texts.at(-1)?.startsWith('Pair a runner'));
    });
  });

  describe('the pairing messages follow their code', () => {
    /** A pairing is offered in one message. */
    interface Offer {
      messageId: number;
      pairId: string;
    }

    async function offerPairing(): Promise<Offer> {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.tapButton(900, 'rnr_pair');
      const message = harness.replies.at(-1);
      const [pending] = readPendingFile(hubFixture.ctx.dir).pending.slice(-1);
      assert.ok(message?.messageId !== null && message?.messageId !== undefined);
      return { messageId: message.messageId, pairId: pending.pairId };
    }

    /** The code ids of the record, one per recorded MESSAGE. */
    function readRecordedPairIds(): string[] {
      return readPairingMessages(pairingMessagesPath).messages.map((message) => message.pairId);
    }

    /** The code is settled: its message shows the `check`-ed text. */
    function expectSettled(offer: Pick<Offer, 'messageId'>, check: (text: string) => void): void {
      check(readMessageText(offer.messageId));
    }

    it('used: the message becomes «Runner “<name>” paired <time>.» — a plain edit, no keyboard, the line gone — and leaves the record, once', async () => {
      const offer = await offerPairing();
      assert.deepEqual(readRecordedPairIds(), [offer.pairId], 'the message is followed');
      await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
      await feature.watchPairingsOnce();
      assert.deepEqual(harness.edits.map((edit) => edit.messageId), [offer.messageId], 'one edit, of the message');
      assert.match(harness.edits[0].text, /^Runner “mac-mini” paired \d{1,2} \S+ \d{2}:\d{2}\.\nJobs at once: 1 — change it in \/runners\.$/u);
      assert.equal(harness.edits[0].extra, undefined, 'plain text: no parse mode, no keyboard');
      assert.ok(!harness.edits[0].text.includes('cr2.'), 'the line is gone');
      assert.deepEqual(harness.deletedMessageIds, [], 'nothing is deleted: the message stays and says what became of the code');
      assert.deepEqual(readRecordedPairIds(), []);
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, 1, 'edited once');
    });

    it('the message was deleted by hand: the code still settles — nothing to edit, nothing retried', async () => {
      const offer = await offerPairing();
      harness.goneMessageIds.add(offer.messageId);
      await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
      await feature.watchPairingsOnce();
      assert.deepEqual(readRecordedPairIds(), [], 'it leaves the record at once: a message nobody can edit is not retried for a day');
      assert.deepEqual(harness.edits, [], 'nothing was edited');
      clockMs += 6 * 1000;
      await feature.watchPairingsOnce();
      assert.deepEqual(harness.edits, [], 'and nothing is tried again');
    });

    it('a record written by the version that offered a code in two messages (a `role` on each) still validates, and both messages are edited to the result like any other', async () => {
      const offer = await offerPairing();
      // The second message of the older version: its id is all the record needs.
      const secondMessageId = offer.messageId + 1000;
      writePairingMessages(pairingMessagesPath, [
        { pairId: offer.pairId, key: keyToString(harness.key), messageId: offer.messageId, offeredAtMs: clockMs, role: 'first' },
        { pairId: offer.pairId, key: keyToString(harness.key), messageId: secondMessageId, offeredAtMs: clockMs, role: 'second' },
      ]);
      assert.equal(readPairingMessages(pairingMessagesPath).problem, null, 'the retired field does not make the file invalid');
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
      assert.equal(readMessageText(secondMessageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('expired: the message becomes «Pairing code expired.», the expired code is swept from the registry, the record is cleared', async () => {
      const offer = await offerPairing();
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'still open: nothing to say');
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('closed: a code closed unused (its line was pasted for a machine that was already paired) turns the message into «This line was used on a machine that was already paired» — not «expired» — and a code that merely ran out still reads «expired»', async () => {
      const offer = await offerPairing();
      assert.equal(await cancelPairing(hubFixture.ctx, offer.pairId, clockMs + 1000), true);
      await feature.watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'This line was used on a machine that was already paired — nothing new was paired.'));
      assert.deepEqual(readRecordedPairIds(), []);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 0, 'nothing was paired');

      const ranOut = await offerPairing();
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      expectSettled(ranOut, (text) => assert.equal(text, 'Pairing code expired.'));
    });

    it('a trace for a code that is still LISTED is no closing: it ran out (the closing\'s later writes failed), so the messages read «expired» — the rule `--wait` uses too', async () => {
      const offer = await offerPairing();
      recordClosedCode(hubFixture.ctx, offer.pairId, clockMs + 1000);
      assert.deepEqual(readPendingFile(hubFixture.ctx.dir).pending.map((pairing) => pairing.pairId), [offer.pairId], 'the code is still in the pending list');
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
    });

    describe('a closed.json that cannot be used', () => {
      let warnings: string[] = [];
      let warnMock: ReturnType<typeof mock.method>;
      beforeEach(() => {
        warnings = [];
        warnMock = mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
      });
      afterEach(() => {
        warnMock.mock.restore();
      });

      it('is read only when a message settles without a runner — a look with nothing to settle never touches it — and the problem is said ONCE across looks, not at every one', async () => {
        const open = await offerPairing();
        fs.writeFileSync(path.join(hubFixture.ctx.dir, 'closed.json'), '{ not json');
        for (let look = 0; look < 3; look += 1) await feature.watchPairingsOnce();
        assert.deepEqual(warnings.filter((line) => line.includes('closed.json')), [], 'the code is still open: no message settles, the file is not read');

        // The code runs out, but Telegram refuses the edits for a while: every try settles without a runner and reads the trace.
        clockMs += 11 * minute;
        editHook = () => Promise.resolve(false);
        await feature.watchPairingsOnce();
        clockMs += 6 * 1000;
        await feature.watchPairingsOnce();
        clockMs += 11 * 1000;
        await feature.watchPairingsOnce();
        clockMs += 21 * 1000;
        await feature.watchPairingsOnce();
        const closedWarnings = warnings.filter((line) => line.includes('closed.json'));
        assert.equal(closedWarnings.length, 1, closedWarnings.join(' | '));
        assert.match(closedWarnings[0], /^\[runners\] closed\.json is not valid JSON; .*the codes in it read as expired$/);

        // Edits are accepted again: the messages read «expired» (the trace cannot be used), and the record is cleared.
        editHook = null;
        clockMs += 6 * 60 * 1000;
        await feature.watchPairingsOnce();
        expectSettled(open, (text) => assert.equal(text, 'Pairing code expired.'));
        assert.deepEqual(readRecordedPairIds(), []);
      });
    });

    it('closed, and the bot was down: the restarted bot still settles the messages as closed — the trace lives in the registry, not in memory', async () => {
      const offer = await offerPairing();
      await cancelPairing(hubFixture.ctx, offer.pairId, clockMs + 1000);
      clockMs += 25 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(offer, (text) => assert.ok(text.startsWith('This line was used on a machine that was already paired'), text));
    });

    it('after a restart (a new module over the same record) the messages still turn to «expired» / «paired»', async () => {
      const first = await offerPairing();
      clockMs += 11 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(first, (text) => assert.equal(text, 'Pairing code expired.'));

      harness.edits.length = 0;
      const second = await offerPairing();
      const restarted = createRunners(buildPorts());
      await restarted.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'still open: nothing to say');
      await redeemPairing(hubFixture.ctx, second.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      await restarted.watchPairingsOnce();
      expectSettled(second, (text) => assert.ok(text.startsWith('Runner “box1” paired'), text));
    });

    it('a code used while the bot was down: the restarted bot turns the message into «paired» — the credential\'s entry is gone from the registry, the instance\'s own record is not', async () => {
      const offer = await offerPairing();
      await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'the registry no longer holds the code');
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(offer, (text) => assert.ok(text.startsWith('Runner “box1” paired'), text));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a code that expired and was swept while the bot was down still gets its «expired» edits', async () => {
      const offer = await offerPairing();
      clockMs += 11 * minute;
      await sweepExpiredPairings(hubFixture.ctx, clockMs);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
    });

    it('a failed edit is kept and tried again later (5 s, then 10 s…), not given up on — and it does not hold back a restart, which tries at once', async () => {
      const offer = await offerPairing();
      clockMs += 11 * minute;
      let attempts = 0;
      let failuresLeft = 2;
      editHook = (editedId) => {
        if (editedId !== offer.messageId) return null;
        attempts += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.resolve(false);
        }
        return null;
      };
      await feature.watchPairingsOnce();
      assert.equal(attempts, 1);
      assert.equal(harness.edits.length, 0);
      assert.deepEqual(readPairingMessages(pairingMessagesPath).messages.map((message) => message.messageId), [offer.messageId], 'the failed one is kept');
      await feature.watchPairingsOnce();
      assert.equal(attempts, 1, 'not again before the delay');
      clockMs += 5 * 1000;
      await feature.watchPairingsOnce();
      assert.equal(attempts, 2, 'the second failure');
      clockMs += 5 * 1000;
      await feature.watchPairingsOnce();
      assert.equal(attempts, 2, 'the delay doubled to 10 s');
      clockMs += 5 * 1000;
      await feature.watchPairingsOnce();
      assert.equal(attempts, 3);
      assert.equal(readMessageText(offer.messageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);

      // A restart forgets the delay: it tries at once.
      const second = await offerPairing();
      clockMs += 11 * minute;
      failuresLeft = 1;
      editHook = (editedId) => (editedId === second.messageId && failuresLeft-- > 0 ? Promise.resolve(false) : null);
      await feature.watchPairingsOnce();
      assert.deepEqual(readPairingMessages(pairingMessagesPath).messages.map((message) => message.messageId), [second.messageId]);
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(second, (text) => assert.equal(text, 'Pairing code expired.'));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a bot restarted more than a day after the code was issued still tries the edits — and when Telegram accepts them, the old messages are settled', async () => {
      const offer = await offerPairing();
      clockMs += 25 * 60 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
      assert.deepEqual(readRecordedPairIds(), []);

      // Also a machine that paired during the long stop.
      const second = await offerPairing();
      await redeemPairing(hubFixture.ctx, second.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      clockMs += 25 * 60 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(second, (text) => assert.ok(text.startsWith('Runner “box1” paired'), text));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a message is given up on only after its edits have been FAILING for a day — counted from the first failed attempt, not from the message\'s age', async () => {
      await offerPairing();
      clockMs += 11 * minute;
      editHook = () => Promise.resolve(false);
      await feature.watchPairingsOnce();
      const recorded = readPairingMessages(pairingMessagesPath).messages;
      assert.equal(recorded.length, 1);
      assert.deepEqual(recorded.map((message) => message.firstFailedAtMs), [clockMs], 'the first failure is written down');
      clockMs += 12 * 60 * minute;
      await feature.watchPairingsOnce();
      assert.equal(readRecordedPairIds().length, 1, 'half a day of failing: still kept');
      assert.deepEqual(readPairingMessages(pairingMessagesPath).messages.map((message) => message.firstFailedAtMs), recorded.map((message) => message.firstFailedAtMs), 'the first failure stays the first');
      clockMs += 13 * 60 * minute;
      await feature.watchPairingsOnce();
      assert.deepEqual(readRecordedPairIds(), [], 'a day of failing: given up on, not retried for ever');
      assert.equal(harness.edits.length, 0);
    });

    it('messages whose edits failed for a day and then are accepted are settled, not dropped', async () => {
      const offer = await offerPairing();
      clockMs += 11 * minute;
      editHook = () => Promise.resolve(false);
      await feature.watchPairingsOnce();
      clockMs += 30 * 60 * minute;
      editHook = null;
      await createRunners(buildPorts()).watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('an offer that finishes while the expiry sweep waits for the hub lock is judged against a registry that already holds its code — its live lines stay', async () => {
      const first = await offerPairing();
      clockMs += 11 * minute;
      // The sweep is queued (behind the hub lock); the watcher has already looked.
      let releaseSweep: () => void = () => {};
      sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
      const look = feature.watchPairingsOnce();
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      // An offer finishes meanwhile: its code is created, its messages sent and recorded.
      sweepGate = null;
      const second = await offerPairing();
      assert.deepEqual(readRecordedPairIds().sort(), [first.pairId, second.pairId].sort());
      releaseSweep();
      await look;
      expectSettled(first, (text) => assert.equal(text, 'Pairing code expired.', 'the expired code\'s message is settled'));
      assert.ok(readMessageText(second.messageId).startsWith('Pair a runner'), 'the new, live message is untouched');
      assert.deepEqual(readRecordedPairIds(), [second.pairId], 'and it is still followed');
      assert.ok(readPendingFile(hubFixture.ctx.dir).pending.some((pairing) => pairing.pairId === second.pairId), 'its code is still open');
    });

    it('another instance sharing the registry neither edits this one\'s messages nor takes the way back to them by sweeping the credential', async () => {
      const offer = await offerPairing();
      const otherEdits: Array<{ messageId: number; text: string }> = [];
      const otherPairingMessagesPath = path.join(hubFixture.root, 'other-instance-pairing-messages.json');
      const otherInstance = createRunners({
        ...buildPorts(),
        pairingMessagesPath: otherPairingMessagesPath,
        editThreadMessageDetailed: async (_key, otherMessageId, text) => {
          otherEdits.push({ messageId: otherMessageId, text });
          return 'edited';
        },
      });
      // While the code is open, and after it is used: nothing for the other instance to do.
      await otherInstance.watchPairingsOnce();
      assert.deepEqual(otherEdits, []);
      // It sweeps the expired credential (shared hygiene) before the owner looks…
      clockMs += 11 * minute;
      await otherInstance.watchPairingsOnce();
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'the credential was swept by the other instance');
      assert.deepEqual(otherEdits, [], 'but it edits no message of ours');
      assert.deepEqual(readPairingMessages(otherPairingMessagesPath).messages, []);
      // …and the owner still reaches its messages.
      assert.deepEqual(readRecordedPairIds(), [offer.pairId]);
      await feature.watchPairingsOnce();
      expectSettled(offer, (text) => assert.equal(text, 'Pairing code expired.'));
    });

    it('a record that is not valid reads as empty (said once per look), and the next pairing replaces it', async () => {
      fs.writeFileSync(pairingMessagesPath, '{ not json');
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, 0);
      const { pairId } = await offerPairing();
      assert.deepEqual(readRecordedPairIds(), [pairId]);
    });

    it('the watcher starts with a look at once, refreshes the gate wrapper only when something is registered, and stops', async () => {
      const gatePath = path.join(hubFixture.ctx.dir, 'gate');
      const stopIdle = feature.startRunnersWatcher();
      stopIdle();
      assert.equal(fs.existsSync(gatePath), false, 'an instance with no runner and no code touches nothing');

      const { messageId } = await offerPairing();
      fs.rmSync(gatePath, { force: true });
      clockMs += 11 * minute;
      const stop = createRunners({ ...buildPorts(), watchIntervalMs: runnersWatchIntervalMs }).startRunnersWatcher();
      await waitUntilAsync('the first look to settle the message', () => readMessageText(messageId) === 'Pairing code expired.');
      stop();
      assert.equal(fs.existsSync(gatePath), true, 'an instance with a code out keeps its gate wrapper in place');
    });
  });

  describe('Pause, Resume and Remove', () => {
    it('Pause marks the machine in the registry and redraws the list with Resume; Resume undoes it', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_p`);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].isPaused, true);
      assert.deepEqual(harness.fakeTelegram.callbackAnswers.at(-1), '⏸ mac paused');
      assert.ok(harness.edits.at(-1)?.text.includes('mac — offline, never connected · paused'), harness.edits.at(-1)?.text);
      assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)).at(1), ['mac: Resume', 'mac: Remove']);

      const newRevision = readPairedFile(hubFixture.ctx.dir).rev;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${newRevision}_0_r`);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].isPaused, false);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '▶️ mac resumed');
    });

    it('a keyboard from an older revision does nothing but say the list changed and draw it again', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const staleRevision = readPairedFile(hubFixture.ctx.dir).rev;
      await pairMachine('box1');
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${staleRevision}_0_x`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 2, 'nothing was removed');
      assert.ok(harness.edits.at(-1)?.text.includes('box1'), 'the new list is drawn');
    });

    it('a position past the end of the list is stale too', async () => {
      await pairMachine('mac');
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      await harness.tapButton(900, `rnr_${revision}_5_x`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
    });

    it('Remove asks first (the message becomes the question); Cancel puts the list back with nothing removed', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_x`);
      const question = harness.edits.at(-1);
      assert.equal(question?.text, 'Remove mac? Its key is deleted and it stops connecting. Jobs running there are killed.');
      assert.deepEqual(harness.getKeyboardData(question), [[`rnr_${revision}_0_xy`, `rnr_${revision}_0_xn`]]);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 1);

      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_xn`);
      assert.ok(harness.edits.at(-1)?.text.startsWith('Runners — machines'), harness.edits.at(-1)?.text);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 1);
    });

    it('Remove confirmed takes the machine out of the registry and its key line out of authorized_keys, and redraws the list', async () => {
      await pairMachine('mac');
      await pairMachine('box1');
      const authorizedKeys = hubFixture.ctx.authorizedKeysPath;
      assert.equal(fs.readFileSync(authorizedKeys, 'utf8').match(/charness-runner:/g)?.length, 2);
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_xy`);
      assert.deepEqual(readPairedFile(hubFixture.ctx.dir).runners.map((runner) => runner.name), ['box1']);
      assert.equal(fs.readFileSync(authorizedKeys, 'utf8').match(/charness-runner:/g)?.length, 1);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '', 'the tap is answered at once with no toast: what happened is told in a message once it is known');
      // The machine is offline here (no link), so its jobs could not be stopped from the hub: the message says so instead of promising it.
      assert.equal(harness.replies.at(-1)?.text, `✅ mac removed. Its key is deleted. The machine is offline, so its jobs were not stopped from here: it stops them itself once its key has been refused for ${unconfirmedRemovalStopAfterHours} h.`);
      assert.ok(!harness.edits.at(-1)?.text.includes('mac —') && harness.edits.at(-1)?.text.includes('box1 —'), harness.edits.at(-1)?.text);
    });

    it('removing a machine that runs as an always-on service tells, in a message of its own, that it keeps running there until an admin removes it — with the commands the HUB made; any other machine gets no such message', async () => {
      await pairMachine('mac', { serviceKind: 'system-service', workDir: '/Users/runner/.charness-runner/work' });
      await pairMachine('box1');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      const repliesBefore = harness.replies.length;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_xy`);
      const texts = harness.replies.slice(repliesBefore).map((reply) => reply.text);
      assert.equal(texts.length, 2, texts.join('\n---\n'));
      assert.match(texts[0], /^✅ mac removed\./);
      assert.match(texts[1], /^⚠️ mac runs as an always-on service on that machine, and only an admin there can stop it \(nothing of charness runs as root\)\. It keeps running until then\. As an admin on that machine, run:\nsudo launchctl bootout system\/com\.charness\.runner\.[0-9a-f]{8}\nsudo launchctl bootout system\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\nsudo rm \/Library\/LaunchDaemons\/com\.charness\.runner\.[0-9a-f]{8}\.plist \/Library\/LaunchDaemons\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\.plist\nThese commands come from this charness host, not from the machine itself\.$/);

      const secondRevision = readPairedFile(hubFixture.ctx.dir).rev;
      const secondBefore = harness.replies.length;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${secondRevision}_0_xy`);
      const second = harness.replies.slice(secondBefore).map((reply) => reply.text);
      assert.equal(second.length, 1, 'box1 runs by hand: only the outcome');
      assert.match(second[0], /^✅ box1 removed\./);
    });

    it('a removal that fails (a damaged authorized_keys block) is reported in General after the empty answer — never «removed» — and the machine stays listed', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      const revision = readPairedFile(hubFixture.ctx.dir).rev;
      fs.writeFileSync(hubFixture.ctx.authorizedKeysPath, '# charness runners: managed block, do not edit between the markers\n');
      const repliesBefore = harness.replies.length;
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${revision}_0_xy`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '');
      const newReplies = harness.replies.slice(repliesBefore).map((reply) => reply.text);
      assert.equal(newReplies.length, 1, newReplies.join('\n'));
      assert.match(newReplies[0], /damaged/);
      assert.ok(!newReplies[0].includes('removed'));
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, 1, 'nothing was removed');
    });

    it('a registry file that does not validate is said, not shown as an empty list', async () => {
      await pairMachine('mac');
      fs.writeFileSync(path.join(hubFixture.ctx.dir, 'paired.json'), '{ not json');
      await harness.runCommand('runners');
      assert.equal(harness.replies.at(-1)?.text, '⚠️ The runners registry cannot be read: paired.json is not valid JSON; fix or remove it by hand (nothing was changed)');
    });
  });

  describe('jobs at once', () => {
    const pickerTextStart = 'How many jobs may mac run at once? Now ';
    /** What a tap on a pairing row answers when its code is not open any more — expired, closed, or the runner it made removed. */
    const closedLineToast = 'This pairing line is no longer open — if the machine paired, set its number in /runners.';

    /** The list is drawn and the machine has a snapshot (so the picker can suggest a number for its size); returns the list message and the revision its buttons carry. */
    async function openList(): Promise<{ messageId: number; revision: number }> {
      await pairMachine('mac');
      writeProbeSnapshot('mac', defaultProbeText, clockMs);
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      return { messageId: screen?.messageId ?? 0, revision: readPairedFile(hubFixture.ctx.dir).rev };
    }

    it('the list has the button of each runner and, for a machine online, how many it runs at once', async () => {
      const { messageId } = await openList();
      const screen = harness.replies.find((reply) => reply.messageId === messageId);
      assert.deepEqual(harness.getKeyboardLabels(screen).at(2), ['mac: Jobs at once — 1']);
      onlineRunnerNames = new Set(['mac']);
      await harness.tapButton(messageId, 'rnr_refresh');
      assert.ok(harness.edits.at(-1)?.text.includes('· 1 at once'), harness.edits.at(-1)?.text);
    });

    it('the button turns the list into the picker (answered at once): the number now, what the machine\'s size suggests, 1 2 3 4 6 8 with the current marked, and Back', async () => {
      const { messageId, revision } = await openList();
      await harness.tapButton(messageId, `rnr_${revision}_0_j`);
      const picker = harness.edits.at(-1);
      assert.equal(picker?.messageId, messageId, 'the same message');
      assert.ok(picker?.text.startsWith(`${pickerTextStart}1.`), picker?.text);
      assert.ok(picker?.text.endsWith('Suggested for 8 cores and 64 GB: 2.'), picker?.text);
      assert.deepEqual(harness.getKeyboardLabels(picker), [['1 ✓', '2', '3', '4', '6', '8'], ['‹ Back']]);
      assert.deepEqual(harness.getKeyboardData(picker), [[1, 2, 3, 4, 6, 8].map((count) => `rnr_${revision}_0_j${count}`), ['rnr_refresh']]);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '', 'the tap is answered at once, with no text');
      assert.deepEqual(appliedGroups, [], 'opening the picker changes nothing and tells the runner nothing');
    });

    it('a machine that was never probed gets the picker without a suggestion', async () => {
      await pairMachine('mac');
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_j`);
      assert.ok(harness.edits.at(-1)?.text.startsWith(pickerTextStart));
      assert.ok(!harness.edits.at(-1)?.text.includes('Suggested'), harness.edits.at(-1)?.text);
    });

    it('Back draws the list again, nothing changed', async () => {
      const { messageId, revision } = await openList();
      await harness.tapButton(messageId, `rnr_${revision}_0_j`);
      await harness.tapButton(messageId, 'rnr_refresh');
      assert.ok(harness.edits.at(-1)?.text.startsWith('Runners — machines'), harness.edits.at(-1)?.text);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, undefined);
    });

    it('a live check that finishes while the picker stands does not draw the list over it', async () => {
      await pairMachine('mac');
      onlineRunnerNames = new Set(['mac']);
      let openProbe: () => void = () => {};
      probeGates.push(new Promise<void>((resolve) => { openProbe = resolve; }));
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      await harness.tapButton(screen?.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_j`);
      const editsWithPicker = harness.edits.length;
      assert.ok(harness.edits.at(-1)?.text.startsWith(pickerTextStart));
      openProbe();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert.equal(harness.edits.length, editsWithPicker, 'the picker stands');
    });

    it('a number sets the runner\'s entry, tells the machine now, says so on the tap, and draws the list with the new number', async () => {
      const { messageId, revision } = await openList();
      await harness.tapButton(messageId, `rnr_${revision}_0_j2`);
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, 2);
      assert.deepEqual(appliedGroups, [{ name: 'mac', jobsAtOnce: 2 }], 'the machine is told what the registry now holds');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'mac: 2 at once');
      const list = harness.edits.at(-1);
      assert.ok(list?.text.startsWith('Runners — machines'), 'the list again, not the picker');
      assert.deepEqual(harness.getKeyboardLabels(list).at(2), ['mac: Jobs at once — 2']);
      assert.equal(readPairedFile(hubFixture.ctx.dir).rev, revision + 1);
    });

    it('a machine that is offline keeps the number for its next job and the tap says so; one that did not take it says that — the number is saved either way', async () => {
      const { messageId, revision } = await openList();
      applyOutcome = 'offline';
      await harness.tapButton(messageId, `rnr_${revision}_0_j3`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'mac: 3 at once — it is offline and takes this at its next job');
      applyOutcome = 'failed';
      await harness.tapButton(messageId, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_j4`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'mac: 4 at once is saved, but the machine did not take it now — it does at its next job');
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, 4);
    });

    it('the same number again changes nothing in the registry (the revision stays) but is told to the machine again — a way to put right a machine that missed it', async () => {
      const { messageId, revision } = await openList();
      await harness.tapButton(messageId, `rnr_${revision}_0_j1`);
      assert.equal(readPairedFile(hubFixture.ctx.dir).rev, revision);
      assert.deepEqual(appliedGroups, [{ name: 'mac', jobsAtOnce: undefined }]);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'mac: 1 at once');
    });

    it('a picker of an older revision, or of a position that is gone, only says the list changed: nothing is set, nothing is told to a machine', async () => {
      const { messageId, revision } = await openList();
      await pairMachine('box1');
      await harness.tapButton(messageId, `rnr_${revision}_0_j2`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
      await harness.tapButton(messageId, `rnr_${revision}_0_j`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
      await harness.tapButton(messageId, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_7_j2`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
      assert.deepEqual(readPairedFile(hubFixture.ctx.dir).runners.map((runner) => runner.jobsAtOnce), [undefined, undefined]);
      assert.deepEqual(appliedGroups, []);
    });

    it('a runner removed between the list and the tap is not set: the tap says the list changed', async () => {
      const { messageId, revision } = await openList();
      await removeRunnerAndEndItsWork(hubFixture.ctx, 'mac', clockMs);
      await harness.tapButton(messageId, `rnr_${revision}_0_j2`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
      assert.deepEqual(appliedGroups, []);
    });

    it('a tap from a topic other than General is refused and sets nothing', async () => {
      const { messageId, revision } = await openList();
      harness.isGeneral = false;
      await harness.tapButton(messageId, `rnr_${revision}_0_j3`);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '⚠️ Runners are managed in General — open /runners there.');
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, undefined);
      assert.deepEqual(appliedGroups, []);
    });

    describe('on the pairing message', () => {
      async function offerPairing(): Promise<{ messageId: number; pairId: string }> {
        savedAddress = { host: 'host.example', port: 22 };
        scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
        await harness.tapButton(900, 'rnr_pair');
        const message = harness.replies.at(-1);
        const [pending] = readPendingFile(hubFixture.ctx.dir).pending.slice(-1);
        assert.ok(message?.messageId !== null && message?.messageId !== undefined);
        return { messageId: message.messageId, pairId: pending.pairId };
      }

      it('a number chosen while the code is open is kept for the machine to come: the tick moves, the machine pairs with it, and the settled message names it', async () => {
        const offer = await offerPairing();
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_3`);
        assert.equal(readPendingFile(hubFixture.ctx.dir).pending[0].jobsAtOnce, 3);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The new machine will run 3 at once.');
        assert.equal(keyboardEdits.at(-1)?.messageId, offer.messageId);
        const markup = keyboardEdits.at(-1)?.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
        assert.deepEqual(markup.inline_keyboard.map((row) => row.map((button) => button.text)), [['Jobs at once:'], ['1', '2', '3 ✓', '4']]);
        assert.equal(harness.edits.length, 0, 'the message text is not edited: the line stays');
        assert.deepEqual(appliedGroups, [], 'no machine yet: nothing to tell');

        await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
        assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, 3);
        await feature.watchPairingsOnce();
        assert.match(harness.edits.at(-1)?.text ?? '', /\nJobs at once: 3 — change it in \/runners\.$/);
      });

      it('a number chosen after the code was used (before the message turned into «paired») changes the runner it made, tells it, says so, and the message names the new number at once — without its keyboard', async () => {
        const offer = await offerPairing();
        await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_4`);
        assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, 4);
        assert.deepEqual(appliedGroups, [{ name: 'mac-mini', jobsAtOnce: 4 }]);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'mac-mini: 4 at once');
        assert.equal(keyboardEdits.length, 0, 'the keyboard goes with the text edit, not with an edit of its own');
        assert.deepEqual(harness.edits.map((edit) => edit.messageId), [offer.messageId]);
        assert.match(harness.edits[0].text, /^Runner “mac-mini” paired .*\nJobs at once: 4 — change it in \/runners\.$/su);
        assert.equal(harness.edits[0].extra, undefined, 'plain text: no keyboard');
        await feature.watchPairingsOnce();
        assert.match(harness.edits.at(-1)?.text ?? '', /\nJobs at once: 4 — change it in \/runners\.$/);
      });

      it('a tap that lands while the watcher\'s «paired» edit is already queued (built from the registry before the tap) has the LAST word: the message ends naming the new number, never the old one', async () => {
        const offer = await offerPairing();
        await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
        let isWatcherEditQueued = false;
        let isTapEditQueued = false;
        let releaseWatcherEdit: () => void = () => {};
        let releaseTapEdit: () => void = () => {};
        const watcherGate = new Promise<void>((resolve) => { releaseWatcherEdit = resolve; });
        const tapGate = new Promise<void>((resolve) => { releaseTapEdit = resolve; });
        // The paced send queue is first come, first served: the edit queued first goes out first. The test holds each one and lets them go in that order.
        editHook = (_messageId, text) => {
          if (text.includes('Jobs at once: 1')) {
            isWatcherEditQueued = true;
            return watcherGate.then(() => true);
          }
          isTapEditQueued = true;
          return tapGate.then(() => true);
        };
        const watcherTick = feature.watchPairingsOnce();
        await waitUntilAsync('the watcher\'s edit to be queued', () => isWatcherEditQueued);
        const tap = harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_4`);
        await waitUntilAsync('the tap\'s edit to be queued behind the watcher\'s', () => isTapEditQueued);
        releaseWatcherEdit();
        await watcherTick;
        assert.match(harness.edits.at(-1)?.text ?? '', /Jobs at once: 1 /, 'the watcher\'s edit went out first, built before the tap');
        releaseTapEdit();
        await tap;
        assert.equal(readPairedFile(hubFixture.ctx.dir).runners[0].jobsAtOnce, 4);
        assert.deepEqual(harness.edits.map((edit) => edit.messageId), [offer.messageId, offer.messageId]);
        assert.match(readMessageText(offer.messageId), /\nJobs at once: 4 — change it in \/runners\.$/, 'the settled message says what the registry holds');
      });

      it('a code that ran out takes no choice: the tap says the line is no longer open, nothing is written', async () => {
        const offer = await offerPairing();
        clockMs += pairingLifetimeMs + 1;
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_2`);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), closedLineToast);
        assert.equal(readPendingFile(hubFixture.ctx.dir).pending[0].jobsAtOnce, undefined);
        assert.equal(keyboardEdits.length, 0);
      });

      it('a code that was CLOSED (its line was pasted for a machine that was already paired) is not called «expired» by a tap on the keyboard that is still there: the answer is true for it too', async () => {
        const offer = await offerPairing();
        assert.equal(await cancelPairing(hubFixture.ctx, offer.pairId, clockMs), true);
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_3`);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), closedLineToast);
        assert.doesNotMatch(harness.fakeTelegram.callbackAnswers.at(-1) ?? '', /expired/i);
        assert.deepEqual(readPendingFile(hubFixture.ctx.dir).pending, []);
        assert.equal(keyboardEdits.length, 0);
        assert.deepEqual(appliedGroups, []);
      });

      it('a runner removed after it paired takes no choice from its old pairing message either: the same true answer, nothing is set or told', async () => {
        const offer = await offerPairing();
        await redeemPairing(hubFixture.ctx, offer.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
        await removeRunnerAndEndItsWork(hubFixture.ctx, 'mac-mini', clockMs);
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_3`);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), closedLineToast);
        assert.deepEqual(readPairedFile(hubFixture.ctx.dir).runners, []);
        assert.deepEqual(appliedGroups, []);
        assert.equal(harness.edits.length, 0);
      });

      it('a code nobody made takes no choice either (a keyboard of another hub)', async () => {
        await harness.tapButton(900, 'rnr_pj_0123456789ab_2');
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), closedLineToast);
      });

      it('the label button explains the row', async () => {
        await harness.tapButton(900, 'rnr_pjinfo');
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'How many jobs the new machine runs side by side. It can be changed later in /runners.');
      });

      it('a tap from a topic other than General is refused and chooses nothing', async () => {
        const offer = await offerPairing();
        harness.isGeneral = false;
        await harness.tapButton(offer.messageId, `rnr_pj_${offer.pairId}_2`);
        assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '⚠️ Runners are managed in General — open /runners there.');
        assert.equal(readPendingFile(hubFixture.ctx.dir).pending[0].jobsAtOnce, undefined);
      });
    });
  });

  describe('where a runner\'s link comes from', () => {
    const homeAddress = '198.51.100.7';
    const otherAddress = '203.0.113.9';

    /** The runner's link status as its gate leaves it: the address it comes from now and the changes it recorded. */
    function putLinkChanges(runnerId: string, changes: LinkSourceChange[]): void {
      writeLinkState(hubFixture.ctx.dir, runnerId, { pid: process.pid, sinceMs: clockMs, lastBeatMs: clockMs, endedAtMs: null, source: changes.at(-1)?.toSource ?? homeAddress, sourceChanges: changes });
    }

    async function pairAndGetId(name: string): Promise<string> {
      await pairMachine(name);
      const runner = readPairedFile(hubFixture.ctx.dir).runners.find((candidate) => candidate.name === name);
      assert.ok(runner !== undefined);
      return runner.id;
    }

    const changeAt = (atMs: number, from: string, to: string, isLiveReplacement = false): LinkSourceChange => ({ fromSource: from, toSource: to, atMs, isLiveReplacement });

    it('says it ONCE in General — the machine\'s name and what changed — and pins the message; the next look tells nothing, and nothing is told for a link that never changed', async () => {
      const runnerId = await pairAndGetId('mac');
      await pairMachine('box1');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress, true)]);
      const repliesBefore = harness.replies.length;
      await feature.watchLinkConcernsOnce();
      const told = harness.replies.slice(repliesBefore);
      assert.equal(told.length, 1, told.map((reply) => reply.text).join('\n'));
      assert.match(told[0].text, /^mac: ⚠️ A link from 203\.0\.113\.9 took over while the one from 198\.51\.100\.7 was still up \(.+\)\. If that is not you changing networks, remove this runner and pair it again: its key may be in use elsewhere\.$/);
      assert.deepEqual(pinnedMessageIds, [told[0].messageId], 'pinned — the pin is what pierces a muted topic');
      await feature.watchLinkConcernsOnce();
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore + 1, 'not again');
      assert.equal(pinnedMessageIds.length, 1);
    });

    it('is not told again after a restart: what was told is the instance\'s own record — and a NEWER change is told, as a message of its own', async () => {
      const runnerId = await pairAndGetId('mac');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress)]);
      await feature.watchLinkConcernsOnce();
      const afterFirst = harness.replies.length;
      const restarted = createRunners(buildPorts());
      await restarted.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, afterFirst, 'a restarted bot reads its record');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress), changeAt(clockMs + 3 * 60 * 60 * 1000, otherAddress, homeAddress)]);
      await restarted.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, afterFirst + 1);
      assert.match(harness.replies.at(-1)?.text ?? '', /^mac: ⚠️ Its link now comes from 198\.51\.100\.7 \(it came from 203\.0\.113\.9 before, /);
      assert.equal(pinnedMessageIds.length, 2);
    });

    it('says a fight once — «links keep replacing each other» — and not again for the changes that go on within its window', async () => {
      const runnerId = await pairAndGetId('mac');
      const first = [changeAt(clockMs, homeAddress, otherAddress), changeAt(clockMs + minute, otherAddress, homeAddress), changeAt(clockMs + 2 * minute, homeAddress, otherAddress)];
      putLinkChanges(runnerId, first);
      const repliesBefore = harness.replies.length;
      await feature.watchLinkConcernsOnce();
      const texts = harness.replies.slice(repliesBefore).map((reply) => reply.text);
      assert.equal(texts.length, 1, texts.join('\n'));
      assert.match(texts[0], /^mac: ⚠️ Links from 198\.51\.100\.7, 203\.0\.113\.9 keep replacing each other \(3 switches in 10 minutes\)\./);
      putLinkChanges(runnerId, [...first, changeAt(clockMs + 3 * minute, otherAddress, homeAddress), changeAt(clockMs + 4 * minute, homeAddress, otherAddress)]);
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore + 1, 'the same fight goes on: nothing new to say');
      // (a status file keeps the last five changes)
      putLinkChanges(runnerId, [...first.slice(1), changeAt(clockMs + 3 * minute, otherAddress, homeAddress), changeAt(clockMs + 4 * minute, homeAddress, otherAddress), changeAt(clockMs + 3 * 60 * minute, otherAddress, homeAddress)]);
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore + 2, 'a change long after it is news again');
    });

    it('waits for a General to post in, and tries again when the send fails — it is only recorded as told once it was', async () => {
      const runnerId = await pairAndGetId('mac');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress)]);
      generalKey = null;
      const repliesBefore = harness.replies.length;
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore, 'no General');
      assert.equal(fs.existsSync(linkNoticesPath), false, 'and nothing recorded as told');
      generalKey = harness.key;
      sendFailsFor = (text) => text.startsWith('mac: ⚠️');
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore, 'the send failed');
      assert.deepEqual(pinnedMessageIds, [], 'nothing to pin');
      sendFailsFor = null;
      await feature.watchLinkConcernsOnce();
      assert.equal(harness.replies.length, repliesBefore + 1, 'told at the next look');
      assert.equal(pinnedMessageIds.length, 1);
    });

    it('keeps the record to the runners that are still paired: a removed one leaves it', async () => {
      const runnerId = await pairAndGetId('mac');
      await pairMachine('box1');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress)]);
      await feature.watchLinkConcernsOnce();
      assert.equal(JSON.parse(fs.readFileSync(linkNoticesPath, 'utf8')).notices.length, 1);
      const { removePairedRunner } = await import('../runners/hubPairing');
      await removePairedRunner(hubFixture.ctx, runnerId, clockMs);
      putLinkChanges(readPairedFile(hubFixture.ctx.dir).runners[0].id, [changeAt(clockMs, homeAddress, otherAddress)]);
      await feature.watchLinkConcernsOnce();
      const record = JSON.parse(fs.readFileSync(linkNoticesPath, 'utf8')).notices as Array<{ runnerId: string }>;
      assert.deepEqual(record.map((notice) => notice.runnerId), [readPairedFile(hubFixture.ctx.dir).runners[0].id], 'only the machine still paired');
    });

    it('the watcher runs it with the pairing look — one interval, one tick', async () => {
      const runnerId = await pairAndGetId('mac');
      putLinkChanges(runnerId, [changeAt(clockMs, homeAddress, otherAddress)]);
      const repliesBefore = harness.replies.length;
      const stop = feature.startRunnersWatcher();
      try {
        await waitUntilAsync('the watcher\'s first look to tell it', () => harness.replies.length > repliesBefore);
        assert.equal(harness.replies.length, repliesBefore + 1);
      } finally {
        stop();
      }
    });
  });

  describe('a long list', () => {
    const machineCount = 12;
    const machineNames = Array.from({ length: machineCount }, (_value, index) => `box-${index}`);

    /**
     * Twelve online machines whose reports are bulky (a CPU model and a capability detail of 300 characters each): the list is a single
     * short page until the live data arrives, then several. Every send and edit also goes through the fake Bot API's length limit.
     * Resolves the list's message id once page 1 is drawn with the live data.
     */
    async function openLongList(): Promise<number> {
      isLengthChecked = true;
      liveProbeText = `${defaultProbeText}\ncap_android_detail=${'a'.repeat(300)}\ncpu_model=${'M'.repeat(300)}`;
      for (const name of machineNames) await pairMachine(name);
      onlineRunnerNames = new Set(machineNames);
      await harness.runCommand('runners');
      const messageId = harness.replies.at(-1)?.messageId ?? 0;
      await waitUntilAsync('page 1 to be drawn with the live data', () => readMessageText(messageId).includes('Page 1 of ') && !readMessageText(messageId).includes('Checking the machines'));
      return messageId;
    }

    function readLastEditOf(messageId: number): RecordedSend | undefined {
      return harness.edits.filter((edit) => edit.messageId === messageId).at(-1);
    }

    /** The first runner row of a render: its Pause/Resume button's data and the machine it names. */
    function readFirstRunnerRow(sent: RecordedSend | undefined): { data: string; removeData: string; name: string } {
      const labels = harness.getKeyboardLabels(sent)[1];
      const data = harness.getKeyboardData(sent)[1];
      return { data: data[0], removeData: data[1], name: labels[0].replace(/: (Pause|Resume)$/, '') };
    }

    it('is split over pages that each fit a Telegram message — the fake Bot API refuses a longer one — and what a machine reported about itself is clipped', async () => {
      const messageId = await openLongList();
      const text = readMessageText(messageId);
      assert.ok(text.length <= maxScreenTextChars, `${text.length} characters`);
      assert.ok(text.includes('box-0 —') && !text.includes('box-11 —'), 'the first page holds the first machines only');
      assert.ok(text.includes(`${'a'.repeat(79)}…`) && !text.includes('a'.repeat(81)), 'a reported detail is clipped');
      assert.ok(text.includes(`${'M'.repeat(79)}…`) && !text.includes('M'.repeat(81)), 'so is the CPU model');
      const labels = harness.getKeyboardLabels(readLastEditOf(messageId)).flat();
      assert.ok(labels.includes('Next ›') && !labels.includes('‹ Previous'), labels.join(' | '));
    });

    it('Next moves through the pages on the same message, every machine is on exactly one page in order, Previous goes back, and a page past the end is the last', async () => {
      const messageId = await openLongList();
      const seen: string[] = [];
      let pageNumber = 1;
      for (;;) {
        await waitUntilAsync(`page ${pageNumber} to be drawn with the live data`, () => readMessageText(messageId).includes(`Page ${pageNumber} of `) && !readMessageText(messageId).includes('Checking the machines'));
        const text = readMessageText(messageId);
        assert.ok(text.length <= maxScreenTextChars, `page ${pageNumber}: ${text.length} characters`);
        seen.push(...[...text.matchAll(/^(box-\d+) — /gm)].map((match) => match[1]));
        const lastEdit = readLastEditOf(messageId);
        const nextIndex = harness.getKeyboardLabels(lastEdit).flat().indexOf('Next ›');
        if (nextIndex < 0) break;
        await harness.tapButton(messageId, harness.getKeyboardData(lastEdit).flat()[nextIndex]);
        pageNumber += 1;
      }
      assert.deepEqual(seen, machineNames, 'every machine once, in order');
      assert.ok(pageNumber >= 2);
      assert.ok(harness.getKeyboardLabels(readLastEditOf(messageId)).flat().includes('‹ Previous'), 'the last page can go back');

      await harness.tapButton(messageId, 'rnr_pg_99');
      assert.ok(readMessageText(messageId).includes(`Page ${pageNumber} of ${pageNumber}`), 'past the end is the last page');
      await harness.tapButton(messageId, 'rnr_pg_0');
      assert.ok(readMessageText(messageId).includes(`Page 1 of ${pageNumber}`));
    });

    it('a machine on a later page is acted on by its place in the WHOLE list and the revision, and the list stays on its page', async () => {
      const messageId = await openLongList();
      await harness.tapButton(messageId, 'rnr_pg_1');
      const secondPage = readLastEditOf(messageId);
      assert.ok(secondPage?.text.includes('Page 2 of '), secondPage?.text.slice(0, 120));
      const { data, name } = readFirstRunnerRow(secondPage);
      const [, revision, index, action] = /^rnr_(\d+)_(\d+)_(\w+)$/.exec(data) ?? [];
      assert.equal(action, 'p');
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners[Number(index)].name, name, 'the button names the machine at that place in the whole list');
      assert.ok(Number(index) > 0, 'not the first machine of the list');
      assert.equal(Number(revision), readPairedFile(hubFixture.ctx.dir).rev);

      await harness.tapButton(messageId, data);
      assert.deepEqual(readPairedFile(hubFixture.ctx.dir).runners.filter((runner) => runner.isPaused).map((runner) => runner.name), [name], 'only that machine');
      assert.ok(readLastEditOf(messageId)?.text.includes('Page 2 of '), 'the list stays on its page');

      // The keyboard of the revision before the pause is stale for a machine on any page.
      await harness.tapButton(messageId, data);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'The list changed — here it is again.');
    });

    it('Remove asks about the right machine on a later page, and Cancel brings back the page it was on', async () => {
      const messageId = await openLongList();
      await harness.tapButton(messageId, 'rnr_pg_1');
      const { removeData, name } = readFirstRunnerRow(readLastEditOf(messageId));
      await harness.tapButton(messageId, removeData);
      assert.ok(readLastEditOf(messageId)?.text.startsWith(`Remove ${name}?`), readLastEditOf(messageId)?.text);
      const cancelData = harness.getKeyboardData(readLastEditOf(messageId))[0][1];
      await harness.tapButton(messageId, cancelData);
      assert.ok(readLastEditOf(messageId)?.text.includes('Page 2 of '), 'back on the page it was on');
      assert.equal(readPairedFile(hubFixture.ctx.dir).runners.length, machineCount, 'nothing was removed');
    });

    it('many open pairing codes are one line, not one line each', async () => {
      for (let count = 0; count < 8; count += 1) await createPairing(hubFixture.ctx, { host: 'host.example', port: 22, hostKey: ownKey, label: '@ExampleBot', nowMs: clockMs });
      await harness.runCommand('runners');
      const text = harness.replies.at(-1)?.text ?? '';
      assert.ok(text.includes('8 pairing codes are open, the last until '), text);
      assert.equal(text.split('\n').filter((line) => line.includes('pairing code')).length, 1);
    });
  });
});
