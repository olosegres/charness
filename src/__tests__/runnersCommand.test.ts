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
 *     and saved), a slash command ends the wait; the pairing message is HTML in a `<pre>`, SECRET for the trace, and registered with its
 *     message note in the registry;
 *   • the pairing message turns into «paired» when its code is used and into «expired» when it runs out — also after a restart and for a
 *     code used while the bot was down (the instance's own record of its messages), a failed edit is tried again, and another instance
 *     sharing the registry neither edits nor takes away the way back to a message;
 *   • Pause / Resume / Remove: revisioned buttons, a stale keyboard only redraws, Remove asks first and Cancel puts the list back.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createRunners, runnersWatchIntervalMs } from '../connectors/telegram/commands/runners';
import { readPairingMessages } from '../connectors/telegram/runnerPairingMessages';
import { readLastProbe } from '../remoteRun/runners';
import { keyToString } from '../sessionKey';
import { parseProbeOutput } from '../remoteRun/probe';
import { ensureGateWrapper } from '../runners/gateWrapper';
import type { HostKeyScanner, HubAddress } from '../runners/hubAddress';
import { createPairing, redeemPairing, sweepExpiredPairings } from '../runners/hubPairing';
import { readPairedFile, readPendingFile } from '../runners/hubRegistry';
import { readRunnersOverview, type RunnersOverview } from '../runners/runnersOverview';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { maxScreenTextChars } from '../utils/runnersScreenPlan';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness, type RecordedSend } from './commandModuleHarness';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const ownKey = generateEd25519KeyPair('own').publicKey;
const strangerKey = generateEd25519KeyPair('stranger').publicKey;
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
/** What the canned live probe says every online machine is like. */
let liveProbeText = defaultProbeText;
/** When set, every send and edit of the module also goes through the fake Bot API, which refuses a text over Telegram's limit. */
let isLengthChecked = false;
/** When set, the sweep of expired codes waits for it before it touches the registry (a sweep queued behind the hub lock). */
let sweepGate: Promise<void> | null = null;
/** Decides an edit before it reaches the harness: a promise of "go ahead" (true) or "this edit fails" (false); null leaves it alone. */
let editHook: ((messageId: number, text: string) => Promise<boolean> | null) | null = null;
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

function buildPorts(): Parameters<typeof createRunners>[0] {
  return {
    ...harness.core,
    replyToThread: async (key, text, extra, options) => {
      if (isLengthChecked) await harness.core.bot.telegram.sendMessage(harnessGroup.id, text, { message_thread_id: harnessThreadId });
      return harness.core.replyToThread(key, text, extra, options);
    },
    editThreadMessage: async (key, messageId, text, extra) => {
      const decision = editHook?.(messageId, text) ?? null;
      if (decision !== null && !(await decision)) return false;
      if (isLengthChecked) await harness.core.bot.telegram.sendMessage(harnessGroup.id, text, { message_thread_id: harnessThreadId });
      return harness.core.editThreadMessage(key, messageId, text, extra);
    },
    hub: hubFixture.ctx,
    pairingMessagesPath,
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
async function pairMachine(suggestedName: string): Promise<string> {
  const pairing = await createPairing(hubFixture.ctx, { host: 'host.example', port: 22, hostKey: ownKey, label: '@ExampleBot', nowMs: clockMs });
  const reply = await redeemPairing(hubFixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName }).request, clockMs);
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
    fs.mkdirSync(cacheDir, { recursive: true });
    harness.isGeneral = true;
    liveProbeText = defaultProbeText;
    isLengthChecked = false;
    editHook = null;
    sweepGate = null;
    clockMs = Date.now();
    savedAddress = null;
    candidates = [];
    scanAnswers = {};
    onlineRunnerNames = new Set();
    probeCalls.length = 0;
    probeGates.length = 0;
    feature = createRunners(buildPorts());
    feature.registerRunnersCommands();
    feature.registerRunnersCallbacks();
  });

  afterEach(async () => {
    await harness.stop();
    hubFixture.cleanup();
  });

  it('registers /runners and its buttons: the four plain ones, then the page and the per-runner patterns', () => {
    assert.deepEqual(harness.registeredCommandNames, ['runners']);
    assert.deepEqual(harness.registeredActionPatterns, ['rnr_pair', 'rnr_refresh', 'rnr_aduse', 'rnr_adother', String(/^rnr_pg_(\d+)$/), String(/^rnr_(\d+)_(\d+)_(p|r|x|xy|xn)$/)]);
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
      assert.deepEqual(harness.getKeyboardLabels(screen), [['＋ Pair a new runner'], ['mac: Pause', 'mac: Remove'], ['box1: Pause', 'box1: Remove'], ['↻ Refresh']]);

      await waitUntilAsync('the live redraw', () => harness.edits.length > 0);
      const redrawn = harness.edits.at(-1);
      assert.equal(redrawn?.messageId, screen?.messageId);
      assert.ok(redrawn?.text.includes('  AMD Ryzen 7 9700X, 8 cores, load 0.4 · RAM 64 GB, 40 GB free · disk 500 GB free'), redrawn?.text);
      assert.ok(redrawn?.text.includes('jobs: 2 running, 1 queued · projects: 2'), redrawn?.text);
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
      await harness.runCommand('runners');
      const screen = harness.replies.at(-1);
      // The paced send queue holds the question's edit; meanwhile the probe — started from the list — finishes.
      editHook = (_messageId, text) => (text.startsWith('Remove ') ? questionEditGate.then(() => true) : null);
      const tap = harness.tapButton(screen?.messageId ?? 0, `rnr_${readPairedFile(hubFixture.ctx.dir).rev}_0_x`);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      openProbe();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert.equal(harness.edits.length, 0, 'the probe drew nothing while the question\'s edit was pending');
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
      assert.ok(pairing?.text.startsWith('Pair a runner — valid 10 minutes, single use.'), pairing?.text);
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

    it('with an address saved there is no step: the pairing message at once — HTML in a <pre>, a SECRET for the trace, within one message, and recorded as this instance\'s own', async () => {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.runCommand('runners');
      await harness.tapButton(findReply(() => true).messageId ?? 0, 'rnr_pair');
      const pairing = harness.replies.at(-1);
      assert.ok(pairing !== undefined);
      assert.deepEqual(pairing.extra, { parse_mode: 'HTML' });
      assert.deepEqual(pairing.options, { isSecret: true });
      assert.match(pairing.text, /^Pair a runner — valid 10 minutes, single use\.\n\nRun this on the runner machine, as the account that will run jobs\n\(not your main account — it runs the agents' code\):\n\n<pre>sh -c '/);
      assert.ok(pairing.text.endsWith('</pre>\n\nAnyone with this line can attach a machine to this charness until it is used or expires.'), pairing.text.slice(-200));
      assert.ok(pairing.text.length <= 4096, `the message must fit one Telegram message, is ${pairing.text.length}`);
      assert.ok(pairing.text.includes('cr1.'), 'the line carries the code');
      assert.ok(!pairing.text.slice(pairing.text.indexOf('<pre>') + 5, pairing.text.indexOf('</pre>')).match(/[<>]/), 'the line is HTML-escaped inside the <pre>');
      const [pending] = readPendingFile(hubFixture.ctx.dir).pending;
      assert.equal(pending.messageRef, null, 'the shared registry carries credentials only: no note of this instance\'s message');
      assert.deepEqual(readPairingMessages(pairingMessagesPath).messages, [{ pairId: pending.pairId, key: keyToString(harness.key), messageId: pairing.messageId, offeredAtMs: clockMs }]);
      assert.equal(pending.label, '@ExampleBot');
      assert.ok(fs.existsSync(path.join(hubFixture.ctx.dir, 'gate')), 'the gate wrapper the key line runs is in place');
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

  describe('the pairing message follows its code', () => {
    async function offerPairing(): Promise<{ messageId: number; pairId: string }> {
      savedAddress = { host: 'host.example', port: 22 };
      scanAnswers = { 'host.example:22': ownKey, '127.0.0.1:22': ownKey };
      await harness.tapButton(900, 'rnr_pair');
      const pairing = harness.replies.at(-1);
      const [pending] = readPendingFile(hubFixture.ctx.dir).pending.slice(-1);
      assert.ok(pairing?.messageId !== null && pairing?.messageId !== undefined);
      return { messageId: pairing.messageId, pairId: pending.pairId };
    }

    function readRecordedPairIds(): string[] {
      return readPairingMessages(pairingMessagesPath).messages.map((message) => message.pairId);
    }

    it('used: the message becomes «Runner “<name>” paired <time>.» — one plain edit, no keyboard — and leaves the record', async () => {
      const { messageId, pairId } = await offerPairing();
      assert.deepEqual(readRecordedPairIds(), [pairId]);
      await redeemPairing(hubFixture.ctx, pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
      await feature.watchPairingsOnce();
      const edit = harness.edits.at(-1);
      assert.equal(edit?.messageId, messageId);
      assert.match(edit?.text ?? '', /^Runner “mac-mini” paired \d{1,2} \S+ \d{2}:\d{2}\.$/u);
      assert.equal(edit?.extra, undefined, 'plain text: no parse mode, no keyboard');
      assert.ok(!edit?.text.includes('cr1.'), 'the line is gone');
      assert.deepEqual(readRecordedPairIds(), []);
      const editsAfterFirst = harness.edits.length;
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, editsAfterFirst, 'edited once');
    });

    it('expired: the message becomes «Pairing code expired.», the expired code is swept from the registry, the record is cleared', async () => {
      const { messageId } = await offerPairing();
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'still open: nothing to say');
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.at(-1)?.messageId, messageId);
      assert.equal(harness.edits.at(-1)?.text, 'Pairing code expired.');
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('after a restart (a new module over the same record) the message still turns to «expired» / «paired»', async () => {
      const first = await offerPairing();
      clockMs += 11 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(first.messageId), 'Pairing code expired.');

      harness.edits.length = 0;
      const second = await offerPairing();
      const restarted = createRunners(buildPorts());
      await restarted.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'still open: nothing to say');
      await redeemPairing(hubFixture.ctx, second.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      await restarted.watchPairingsOnce();
      assert.ok(readMessageText(second.messageId).startsWith('Runner “box1” paired'), readMessageText(second.messageId));
    });

    it('a code used while the bot was down: the restarted bot turns its message into «paired» — the credential\'s entry is gone from the registry, the instance\'s own record is not', async () => {
      const { messageId, pairId } = await offerPairing();
      await redeemPairing(hubFixture.ctx, pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0, 'the registry no longer holds the code');
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.ok(readMessageText(messageId).startsWith('Runner “box1” paired'), readMessageText(messageId));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a code that expired and was swept while the bot was down still gets its «expired» edit', async () => {
      const { messageId } = await offerPairing();
      clockMs += 11 * minute;
      await sweepExpiredPairings(hubFixture.ctx, clockMs);
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(messageId), 'Pairing code expired.');
    });

    it('a failed edit is kept and tried again later (5 s, then 10 s…), not given up on; a restart tries at once', async () => {
      const { messageId } = await offerPairing();
      clockMs += 11 * minute;
      let attempts = 0;
      let failuresLeft = 2;
      editHook = () => {
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
      assert.equal(readRecordedPairIds().length, 1, 'the failed edit leaves the record');
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
      assert.equal(readMessageText(messageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);

      // A restart forgets the delay: it tries at once.
      const second = await offerPairing();
      clockMs += 11 * minute;
      failuresLeft = 1;
      await feature.watchPairingsOnce();
      assert.equal(readRecordedPairIds().length, 1);
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(second.messageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a bot restarted more than a day after the code was issued still tries the edit — and when Telegram accepts it, the old message is settled', async () => {
      const { messageId } = await offerPairing();
      clockMs += 25 * 60 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(messageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);

      // Also a machine that paired during the long stop.
      const second = await offerPairing();
      await redeemPairing(hubFixture.ctx, second.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      clockMs += 25 * 60 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.ok(readMessageText(second.messageId).startsWith('Runner “box1” paired'), readMessageText(second.messageId));
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('a message is given up on only after its edits have been FAILING for a day — counted from the first failed attempt, not from the message\'s age', async () => {
      await offerPairing();
      clockMs += 11 * minute;
      editHook = () => Promise.resolve(false);
      await feature.watchPairingsOnce();
      const [recorded] = readPairingMessages(pairingMessagesPath).messages;
      assert.equal(recorded.firstFailedAtMs, clockMs, 'the first failure is written down');
      clockMs += 12 * 60 * minute;
      await feature.watchPairingsOnce();
      assert.equal(readRecordedPairIds().length, 1, 'half a day of failing: still kept');
      assert.equal(readPairingMessages(pairingMessagesPath).messages[0].firstFailedAtMs, recorded.firstFailedAtMs, 'the first failure stays the first');
      clockMs += 13 * 60 * minute;
      await feature.watchPairingsOnce();
      assert.deepEqual(readRecordedPairIds(), [], 'a day of failing: given up on, not retried for ever');
      assert.equal(harness.edits.length, 0);
    });

    it('a message whose edits failed for a day and then are accepted is settled, not dropped', async () => {
      const { messageId } = await offerPairing();
      clockMs += 11 * minute;
      editHook = () => Promise.resolve(false);
      await feature.watchPairingsOnce();
      clockMs += 30 * 60 * minute;
      editHook = null;
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(messageId), 'Pairing code expired.');
      assert.deepEqual(readRecordedPairIds(), []);
    });

    it('an offer that finishes while the expiry sweep waits for the hub lock is judged against a registry that already holds its code — its live line stays', async () => {
      const first = await offerPairing();
      clockMs += 11 * minute;
      // The sweep is queued (behind the hub lock); the watcher has already looked.
      let releaseSweep: () => void = () => {};
      sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
      const look = feature.watchPairingsOnce();
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      // An offer finishes meanwhile: its code is created, its message sent and recorded.
      sweepGate = null;
      const second = await offerPairing();
      assert.deepEqual(readRecordedPairIds().sort(), [first.pairId, second.pairId].sort());
      releaseSweep();
      await look;
      assert.equal(readMessageText(first.messageId), 'Pairing code expired.', 'the expired code\'s message is settled');
      assert.ok(readMessageText(second.messageId).startsWith('Pair a runner'), 'the new, live message is untouched');
      assert.deepEqual(readRecordedPairIds(), [second.pairId], 'and it is still followed');
      assert.ok(readPendingFile(hubFixture.ctx.dir).pending.some((pairing) => pairing.pairId === second.pairId), 'its code is still open');
    });

    it('another instance sharing the registry neither edits this one\'s message nor takes the way back to it by sweeping the credential', async () => {
      const { messageId, pairId } = await offerPairing();
      const otherEdits: Array<{ messageId: number; text: string }> = [];
      const otherPairingMessagesPath = path.join(hubFixture.root, 'other-instance-pairing-messages.json');
      const otherInstance = createRunners({
        ...buildPorts(),
        pairingMessagesPath: otherPairingMessagesPath,
        editThreadMessage: async (_key, otherMessageId, text) => {
          otherEdits.push({ messageId: otherMessageId, text });
          return true;
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
      // …and the owner still reaches its message.
      assert.deepEqual(readRecordedPairIds(), [pairId]);
      await feature.watchPairingsOnce();
      assert.equal(readMessageText(messageId), 'Pairing code expired.');
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
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), '✅ mac removed');
      assert.ok(!harness.edits.at(-1)?.text.includes('mac —') && harness.edits.at(-1)?.text.includes('box1 —'), harness.edits.at(-1)?.text);
    });

    it('a registry file that does not validate is said, not shown as an empty list', async () => {
      await pairMachine('mac');
      fs.writeFileSync(path.join(hubFixture.ctx.dir, 'paired.json'), '{ not json');
      await harness.runCommand('runners');
      assert.equal(harness.replies.at(-1)?.text, '⚠️ The runners registry cannot be read: paired.json is not valid JSON; fix or remove it by hand (nothing was changed)');
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
