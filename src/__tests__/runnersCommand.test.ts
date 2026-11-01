/**
 * @description `/runners` (`connectors/telegram/commands/runners.ts`) wired to ports (`commandModuleHarness.ts`: a real telegraf instance
 * against the fake Bot API, recording topic sends) over a REAL throwaway hub registry (`runnersTestKit.ts`), with a canned address
 * scanner, a controllable clock and a canned live probe. Pinned:
 *
 *   • WIRING — the command, its buttons and their order; General only (a topic is sent to General, a tap from a topic is refused);
 *   • the list: empty, with machines, the live check that redraws the list when the machines answer — and does not redraw a message
 *     that has become a question or a different revision;
 *   • the first pairing: the address step (a proposal, none found), the typed address (refused with the reason and asked again, taken
 *     and saved), a slash command ends the wait; the pairing message is HTML in a `<pre>`, SECRET for the trace, and registered with its
 *     message note in the registry;
 *   • the pairing message turns into «paired» when its code is used and into «expired» when it runs out — also after a restart, from the
 *     registry's note;
 *   • Pause / Resume / Remove: revisioned buttons, a stale keyboard only redraws, Remove asks first and Cancel puts the list back.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createRunners, buildPairingMessageRef, parsePairingMessageRef, runnersWatchIntervalMs } from '../connectors/telegram/commands/runners';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { parseProbeOutput } from '../remoteRun/probe';
import { ensureGateWrapper } from '../runners/gateWrapper';
import type { HostKeyScanner, HubAddress } from '../runners/hubAddress';
import { createPairing, redeemPairing } from '../runners/hubPairing';
import { readPairedFile, readPendingFile } from '../runners/hubRegistry';
import { readRunnersOverview, type RunnersOverview } from '../runners/runnersOverview';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { createCommandHarness, type CommandHarness, type RecordedSend } from './commandModuleHarness';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const ownKey = generateEd25519KeyPair('own').publicKey;
const strangerKey = generateEd25519KeyPair('stranger').publicKey;
const minute = 60 * 1000;
const liveProbeText = [
  'os=Linux', 'os_name=Ubuntu', 'os_version=24.04', 'arch=x86_64', 'cpu_model=AMD Ryzen 7 9700X', 'cpu_cores=8', 'cpu_threads=16', 'load=0.4',
  'ram_total_mb=65536', 'ram_free_mb=40960', 'disk_free_mb=512000', 'pueue=4.0.4', 'jobs_running=2', 'jobs_queued=1', 'jobs_projects=2',
  'cap_android=yes', 'cap_android_detail=KVM, emulator', 'cap_ios=no', 'cap_ios_detail=Linux', 'cap_docker=yes', 'cap_docker_detail=', 'cap_playwright=no', 'cap_playwright_detail=',
].join('\n');

let harness: CommandHarness;
let hubFixture: HubFixture;
let cacheDir: string;
let clockMs = Date.now();
let savedAddress: HubAddress | null = null;
let candidates: string[] = [];
/** What the canned scanner answers per `host:port`. */
let scanAnswers: Record<string, string | null> = {};
let onlineRunnerNames = new Set<string>();
const probeCalls: RunnersOverview[] = [];
/** When set, the live probe waits for it. */
let probeGate: Promise<void> | null = null;
let feature: ReturnType<typeof createRunners>;

const scanHostKey: HostKeyScanner = async (host, port) => scanAnswers[`${host}:${port}`] ?? null;

function buildPorts(): Parameters<typeof createRunners>[0] {
  return {
    ...harness.core,
    hub: hubFixture.ctx,
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
    probeOverview: async (overview) => {
      probeCalls.push(overview);
      if (probeGate !== null) await probeGate;
      return { ...overview, entries: overview.entries.map((entry) => (entry.isOnline ? { ...entry, probe: parseProbeOutput(liveProbeText) } : entry)) };
    },
    listAddressCandidates: () => candidates,
    scanHostKey,
    ensureGateWrapper: () => { ensureGateWrapper(hubFixture.ctx); },
    now: () => clockMs,
    watchIntervalMs: 60 * minute,
  };
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
    fs.mkdirSync(cacheDir, { recursive: true });
    harness.isGeneral = true;
    clockMs = Date.now();
    savedAddress = null;
    candidates = [];
    scanAnswers = {};
    onlineRunnerNames = new Set();
    probeCalls.length = 0;
    probeGate = null;
    feature = createRunners(buildPorts());
    feature.registerRunnersCommands();
    feature.registerRunnersCallbacks();
  });

  afterEach(async () => {
    await harness.stop();
    hubFixture.cleanup();
  });

  it('registers /runners and its buttons: the four plain ones, then the per-runner pattern', () => {
    assert.deepEqual(harness.registeredCommandNames, ['runners']);
    assert.deepEqual(harness.registeredActionPatterns, ['rnr_pair', 'rnr_refresh', 'rnr_aduse', 'rnr_adother', String(/^rnr_(\d+)_(\d+)_(p|r|x|xy|xn)$/)]);
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
      probeGate = new Promise<void>((resolve) => { openProbe = resolve; });
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

    it('with an address saved there is no step: the pairing message at once — HTML in a <pre>, a SECRET for the trace, within one message, and its note in the registry', async () => {
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
      assert.equal(pending.messageRef, buildPairingMessageRef(harness.key, pairing.messageId ?? 0));
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
      const [pending] = readPendingFile(hubFixture.ctx.dir).pending;
      assert.ok(pairing?.messageId !== null && pairing?.messageId !== undefined);
      return { messageId: pairing.messageId, pairId: pending.pairId };
    }

    it('used: the message becomes «Runner “<name>” paired <time>.» — one plain edit, no keyboard', async () => {
      const { messageId, pairId } = await offerPairing();
      await redeemPairing(hubFixture.ctx, pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, clockMs);
      await feature.watchPairingsOnce();
      const edit = harness.edits.at(-1);
      assert.equal(edit?.messageId, messageId);
      assert.match(edit?.text ?? '', /^Runner “mac-mini” paired \d{1,2} \S+ \d{2}:\d{2}\.$/u);
      assert.equal(edit?.extra, undefined, 'plain text: no parse mode, no keyboard');
      assert.ok(!edit?.text.includes('cr1.'), 'the line is gone');
      const editsAfterFirst = harness.edits.length;
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, editsAfterFirst, 'edited once');
    });

    it('expired: the message becomes «Pairing code expired.», the expired code is swept from the registry', async () => {
      const { messageId } = await offerPairing();
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'still open: nothing to say');
      clockMs += 11 * minute;
      await feature.watchPairingsOnce();
      assert.equal(harness.edits.at(-1)?.messageId, messageId);
      assert.equal(harness.edits.at(-1)?.text, 'Pairing code expired.');
      assert.equal(readPendingFile(hubFixture.ctx.dir).pending.length, 0);
    });

    it('after a restart (a new module over the same registry) the message is found again from its note and still turns to «expired» / «paired»', async () => {
      const first = await offerPairing();
      clockMs += 11 * minute;
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(first.messageId), 'Pairing code expired.');

      harness.edits.length = 0;
      const second = await offerPairing();
      const restarted = createRunners(buildPorts());
      await restarted.watchPairingsOnce();
      assert.equal(harness.edits.length, 0, 'adopted from the note, still open: nothing to say');
      await redeemPairing(hubFixture.ctx, second.pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      await restarted.watchPairingsOnce();
      assert.ok(readMessageText(second.messageId).startsWith('Runner “box1” paired'), readMessageText(second.messageId));
    });

    it('a code used while the bot was down keeps its (spent) message: the registry no longer holds its note', async () => {
      const { messageId, pairId } = await offerPairing();
      await redeemPairing(hubFixture.ctx, pairId, createRedeemFixture({ suggestedName: 'box1' }).request, clockMs);
      await createRunners(buildPorts()).watchPairingsOnce();
      assert.equal(readMessageText(messageId).startsWith('Pair a runner'), true);
      assert.equal(harness.edits.length, 0);
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

  describe('the registry note of a pairing message', () => {
    it('builds and reads back `tg:<key>#<message id>`; a note this module did not write is not one', () => {
      const key = makeTelegramKey(-1001111111111, 1);
      const note = buildPairingMessageRef(key, 42);
      assert.equal(note, 'tg:-1001111111111:1#42');
      assert.deepEqual(parsePairingMessageRef(note), { key, messageId: 42 });
      for (const other of [null, '', 'jira:PROJ-1#3', 'tg:abc#1', 'tg:-100:1', 'tg:-100:1#x']) assert.equal(parsePairingMessageRef(other), null, String(other));
    });
  });
});
