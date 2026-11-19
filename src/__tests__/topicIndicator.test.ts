/**
 * @description The refresher of the status mark at the end of a topic's name (`connectors/telegram/topicIndicator.ts`) over fake ports, a
 * fake clock and a real `StateStore`: what it writes and when — the question edges at once, the settle time of ⏳, the gap between two
 * renames with the latest state winning — what it never writes (a topic whose own name it does not know), how it answers Telegram's
 * refusals (the missing right is remembered per topic and probed with one topic per sweep, «not modified» is fine, anything else is
 * logged once and tried again after a backoff), the bot's own «renamed» line, the name put back, a topic that is being unbound, the
 * owner's change of a switch, the sweep and the boot wave.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createTopicIndicator, type TopicIndicator } from '../connectors/telegram/topicIndicator';
import {
  defaultTopicStatusPrefs,
  indicatorBootWaveDelayMs,
  indicatorMinRenameGapMs,
  indicatorSettleMs,
  indicatorSweepIntervalMs,
  type TopicStatusInputs,
  type TopicStatusPrefs,
} from '../utils/topicIndicatorPlan';
import { RateLimitedError } from '../rateLimiter';
import type { CallApiHost } from '../outputTrace';
import { firstPollHoldMs, installFirstUpdateBatchNote } from '../connectors/telegram/firstUpdateBatchNote';

const chatId = -1001234567890;
const topic: SessionKey = makeTelegramKey(chatId, 11);
const otherTopic: SessionKey = makeTelegramKey(chatId, 22);
const generalTopic: SessionKey = makeTelegramKey(chatId, 1);
const nothingHolds: TopicStatusInputs = { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false };

interface FakeTimer {
  at: number;
  callback: () => void;
  isCancelled: boolean;
}

/** What a test drives: the clock, the timers it makes due, the facts the topic shows, and every call the refresher made. */
interface Harness {
  state: StateStore;
  indicator: TopicIndicator;
  /** The topic's facts, by key string: a test changes them, then signals a refresh. */
  inputs: Map<string, TopicStatusInputs>;
  prefs: { current: TopicStatusPrefs };
  counts: { agents: number; queued: number };
  renames: Array<{ key: SessionKey; name: string }>;
  deletions: Array<{ key: SessionKey; messageId: number }>;
  logs: string[];
  /** How many times the facts of a topic were read: a burst of signals must not read them once each. */
  inputReads: { count: number };
  /** The next `sendTopicName` rejects with this, once. */
  failNextRename: { error: unknown | null };
  /** Every `sendTopicName` call, the refused and failed ones too, by thread id. */
  renameAttempts: string[];
  /** The topics (thread ids) Telegram refuses to rename for want of the right. */
  refusedThreads: Set<string>;
  /** The topics (thread ids) whose every rename fails with this error — a deleted topic, a lasting failure that is no missing right. */
  brokenThreads: Map<string, object>;
  /** The topics (thread ids) being unbound right now. */
  unbindingThreads: Set<string>;
  /** While set, every `sendTopicName` waits (a slow send gate); `releaseHeldRenames` lets the held calls go on, each judged as it is by then. */
  isSendHeld: { current: boolean };
  releaseHeldRenames: () => void;
  /** Every `deleteMessage` rejects with this while it is set. */
  deletionError: { current: unknown | null };
  isBacklogHandled: { current: boolean };
  /** When set, the boot gate asks it instead of `isBacklogHandled` (a test that wires the real note of the first poll). */
  backlogProbe: { current: (() => boolean) | null };
  nowMs: () => number;
  /** The name the topic has in Telegram now: the last one written. */
  fakeNameOf: (key: SessionKey) => string | undefined;
  /** Move the clock forward, running the timers that come due on the way, each at its own instant. */
  advance: (ms: number) => Promise<void>;
  /** Let every look the refresher queued and every write it started finish. */
  settle: () => Promise<void>;
  getTimerCount: () => number;
}

function createApiError(description: string, code = 400): object {
  return { response: { error_code: code, description }, description };
}

const flushMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function flushWork(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await flushMacrotask();
}

describe('the status mark of topic names', () => {
  let dataDir: string;
  let fakeHome: string;
  let stores: StateStore[] = [];

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-indicator-'));
    dataDir = path.join(fakeHome, '.charness');
    stores = [];
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function createHarness(
    options: { windows?: Partial<{ settleMs: number; minGapMs: number; sweepIntervalMs: number; bootWaveDelayMs: number }>; state?: StateStore; startMs?: number } = {},
  ): Promise<Harness> {
    // `state`: a second boot over the first one's bindings — what they remember is what the new refresher starts from.
    const state = options.state ?? new StateStore(dataDir, { saveDebounceMs: 5 });
    if (!options.state) {
      stores.push(state);
      await state.init();
      await state.setBinding(topic, 'alpha', { topicName: 'Deploy' });
    }
    let currentMs = options.startMs ?? 1_000_000;
    const timers: FakeTimer[] = [];
    const heldSends: Array<() => void> = [];
    const parts: Omit<Harness, 'indicator'> = {
      state,
      inputs: new Map(),
      prefs: { current: { ...defaultTopicStatusPrefs } },
      counts: { agents: 0, queued: 0 },
      renames: [],
      deletions: [],
      logs: [],
      inputReads: { count: 0 },
      failNextRename: { error: null },
      renameAttempts: [],
      refusedThreads: new Set(),
      brokenThreads: new Map(),
      unbindingThreads: new Set(),
      isSendHeld: { current: false },
      releaseHeldRenames: () => { for (const release of heldSends.splice(0)) release(); },
      deletionError: { current: null },
      isBacklogHandled: { current: true },
      backlogProbe: { current: null },
      nowMs: () => currentMs,
      fakeNameOf: (key) => parts.renames.filter((rename) => rename.key.thread === key.thread).at(-1)?.name,
      advance: async (ms) => {
        const target = currentMs + ms;
        for (;;) {
          const due = timers.filter((timer) => !timer.isCancelled && timer.at <= target).sort((left, right) => left.at - right.at)[0];
          if (!due) break;
          currentMs = Math.max(currentMs, due.at);
          due.isCancelled = true;
          due.callback();
          await flushWork();
        }
        currentMs = target;
        await flushWork();
      },
      settle: flushWork,
      getTimerCount: () => timers.filter((timer) => !timer.isCancelled).length,
    };
    const indicator = createTopicIndicator({
      getState: () => state,
      checkIsMarkableTopic: (key) => key.thread !== generalTopic.thread,
      checkIsUnbinding: (key) => parts.unbindingThreads.has(key.thread),
      getPrefs: () => parts.prefs.current,
      getStatusInputs: (key) => {
        parts.inputReads.count += 1;
        return parts.inputs.get(`${key.thread}`) ?? nothingHolds;
      },
      getAgentsCount: () => parts.counts.agents,
      getQueuedCount: () => parts.counts.queued,
      sendTopicName: async (key, name) => {
        parts.renameAttempts.push(key.thread);
        if (parts.isSendHeld.current) await new Promise<void>((resolve) => heldSends.push(resolve));
        if (parts.refusedThreads.has(key.thread)) throw createApiError('Bad Request: not enough rights to manage topics');
        const brokenError = parts.brokenThreads.get(key.thread);
        if (brokenError !== undefined) throw brokenError;
        if (parts.failNextRename.error !== null) {
          const error = parts.failNextRename.error;
          parts.failNextRename.error = null;
          throw error;
        }
        parts.renames.push({ key, name });
      },
      deleteMessage: async (key, messageId) => {
        parts.deletions.push({ key, messageId });
        if (parts.deletionError.current !== null) throw parts.deletionError.current;
      },
      checkIsBacklogHandled: () => parts.backlogProbe.current?.() ?? parts.isBacklogHandled.current,
      windows: {
        settleMs: options.windows?.settleMs ?? indicatorSettleMs,
        minGapMs: options.windows?.minGapMs ?? indicatorMinRenameGapMs,
        sweepIntervalMs: options.windows?.sweepIntervalMs ?? indicatorSweepIntervalMs,
        bootWaveDelayMs: options.windows?.bootWaveDelayMs ?? indicatorBootWaveDelayMs,
      },
      getNowMs: () => currentMs,
      setTimer: (callback, delayMs) => {
        const timer: FakeTimer = { at: currentMs + delayMs, callback, isCancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.isCancelled = true; } };
      },
      log: (line) => parts.logs.push(line),
    });
    return { ...parts, indicator };
  }

  function setInputs(harness: Harness, key: SessionKey, inputs: Partial<TopicStatusInputs>): void {
    harness.inputs.set(`${key.thread}`, { ...nothingHolds, ...inputs });
  }

  function getAppliedName(harness: Harness): string | undefined {
    return harness.state.getBinding(topic)?.indicatorAppliedName;
  }

  /** The topic wants `inputs` from now on: ask for a look, and let the settle time pass (the gap too, when a name was written before). */
  async function wantAndWait(harness: Harness, key: SessionKey, inputs: Partial<TopicStatusInputs>, waitMs = indicatorSettleMs): Promise<void> {
    setInputs(harness, key, inputs);
    harness.indicator.requestRefresh(key);
    await harness.settle();
    await harness.advance(waitMs);
  }

  const settleAndGapMs = indicatorSettleMs + indicatorMinRenameGapMs;

  describe('what it writes', () => {
    it('writes the question mark at once, and takes it off at once when the question is answered', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { hasOpenQuestion: true, isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓'], 'no settle time, no gap');
      assert.equal(getAppliedName(harness), 'Deploy ❓', 'the applied name is persisted');

      // The answer comes a second later: far inside the gap and the settle time, and the next state shows at once all the same.
      await harness.advance(1_000);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓', 'Deploy 🟢']);
    });

    it('two questions keep the mark until both are closed (the input says so, the mark follows)', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓'], 'nothing more is written while the question is open');
    });

    it('writes the name only: a plain rename call, never an icon', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isAsleep: true });
      assert.deepEqual(harness.renames, [{ key: topic, name: 'Deploy 💤' }]);
    });

    it('shows ⏳ only after the turn has run the settle time, and a short turn goes straight to 🟢', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isAsleep: true });
      await harness.advance(indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);

      // A turn of 5 s: ⏳ never shows.
      await wantAndWait(harness, topic, { isWorking: true }, 5_000);
      await wantAndWait(harness, topic, { isFinished: true }, settleAndGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤', 'Deploy 🟢'], 'straight to 🟢, no ⏳ in between');

      // A turn that runs on: ⏳ shows when it has run the settle time (the gap since 🟢 is up by then too).
      await harness.advance(indicatorMinRenameGapMs);
      await wantAndWait(harness, topic, { isWorking: true }, indicatorSettleMs - 1_000);
      assert.equal(harness.renames.at(-1)?.name, 'Deploy 🟢', 'still not');
      await harness.advance(1_000);
      assert.equal(harness.renames.at(-1)?.name, 'Deploy ⏳');
    });

    it('a session that wakes for a prompt never shows a 🟢 on the way to its ⏳', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isAsleep: true });
      await harness.advance(indicatorMinRenameGapMs);
      // The resume makes the process active an instant before the turn runs: 🟢 is wanted for 200 ms, then ⏳ for good.
      await wantAndWait(harness, topic, { isFinished: true }, 200);
      await wantAndWait(harness, topic, { isWorking: true }, settleAndGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤', 'Deploy ⏳']);
    });

    it('keeps two renames of a topic a gap apart, and what came and went inside the gap is never shown: the latest state wins', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);

      // Inside the gap: stuck, then asleep. Neither is written; the topic waits for the gap's end.
      await wantAndWait(harness, topic, { isStuck: true }, 25_000);
      await wantAndWait(harness, topic, { isAsleep: true }, 5_000);
      assert.equal(harness.renames.length, 1, 'nothing written inside the gap');

      await harness.advance(indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy 💤'], 'the latest state, once, when the gap ended');
    });

    it('writes nothing for a state the topic already shows', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(10 * indicatorMinRenameGapMs);
      assert.equal(harness.renames.length, 1);
    });

    it('answers a burst of signals with one look and one write', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      for (let index = 0; index < 50; index += 1) harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.equal(harness.renames.length, 1);
      assert.ok(harness.inputReads.count <= 8, `the facts were read ${harness.inputReads.count} times for 50 signals in one tick`);
    });

    it('shows no mark for a topic that has no agent, and the owner\'s own name for a closed topic', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.advance(indicatorMinRenameGapMs);
      await harness.state.setBindingClosed(topic, true);
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy'], 'a closed topic shows the owner\'s name');
    });
  });

  describe('what it never writes', () => {
    it('a topic whose own name it does not know', async () => {
      const harness = await createHarness();
      await harness.state.setBinding(otherTopic, 'beta');
      setInputs(harness, otherTopic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(otherTopic);
      await harness.settle();
      assert.equal(harness.renames.length, 0);
    });

    it('General, an unbound topic', async () => {
      const harness = await createHarness();
      setInputs(harness, generalTopic, { isFinished: true });
      harness.indicator.requestRefresh(generalTopic);
      setInputs(harness, otherTopic, { isFinished: true });
      harness.indicator.requestRefresh(otherTopic);
      await harness.settle();
      await harness.advance(settleAndGapMs);
      assert.equal(harness.renames.length, 0);
    });
  });

  describe('the switches', () => {
    it('a status switched off is skipped: nothing to write when the owner\'s name is what is left', async () => {
      const harness = await createHarness();
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renames.length, 0, 'the name already is the owner\'s');
    });

    it('the counts show after the mark only when switched on, each only from 1', async () => {
      const harness = await createHarness();
      harness.prefs.current = { ...defaultTopicStatusPrefs, agents: true, queued: true };
      harness.counts.agents = 3;
      harness.counts.queued = 5;
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renames.at(-1)?.name, 'Deploy 🟢 ⚙️3 📋5');
    });

    it('a change the owner made skips the wait and the gap: the base name is back at once when he turns the mark off', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.advance(2_000);
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      harness.indicator.requestRefresh(topic, { isOwnerChange: true });
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy']);
    });

    it('a change that is not the owner\'s waits even when a switch moved', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.advance(2_000);
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renames.length, 1);
      await harness.advance(settleAndGapMs);
      assert.equal(harness.renames.length, 2);
    });
  });

  /** A second and a third topic of the chat, each with its own name known, wanting a mark. */
  async function bindMoreTopics(harness: Harness): Promise<SessionKey[]> {
    const keys = [otherTopic, makeTelegramKey(chatId, 33)];
    for (const [index, key] of keys.entries()) {
      await harness.state.setBinding(key, 'beta', { topicName: ['Research', 'Billing'][index] });
      setInputs(harness, key, { isFinished: true });
    }
    return keys;
  }

  describe('Telegram\'s answers', () => {
    it('a missing «Manage topics» right is remembered for the topic: one log line, a hint for the picker, no second try', async () => {
      const harness = await createHarness();
      harness.refusedThreads.add(topic.thread);
      await wantAndWait(harness, topic, { isFinished: true });
      assert.deepEqual(harness.indicator.getHealth(topic), { isRenameRefused: true, isLineDeletionRefused: false });
      assert.equal(harness.logs.filter((line) => line.includes('Manage topics')).length, 1);
      assert.deepEqual(harness.renameAttempts, [topic.thread]);

      await wantAndWait(harness, topic, { hasOpenQuestion: true });
      assert.deepEqual(harness.renameAttempts, [topic.thread], 'not tried again while refused');
      assert.equal(harness.logs.length, 1, 'and no second line');
    });

    it('a topic the bot made itself — no right needed — keeps its marks while an owner-made topic of the same chat is refused', async () => {
      const harness = await createHarness();
      harness.refusedThreads.add(topic.thread);
      const [botMadeTopic] = await bindMoreTopics(harness);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      harness.indicator.requestRefresh(botMadeTopic);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => `${rename.key.thread}:${rename.name}`), [`${botMadeTopic.thread}:Research 🟢`], 'the refused topic got nothing, the other its mark');
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the picker still says why the owner-made topic has no mark');
      assert.equal(harness.logs.filter((line) => line.includes('Manage topics')).length, 1, 'one line for the chat');
    });

    it('a chat without the right costs ONE failing call per sweep — the probe, the oldest refused topic — not one per topic', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      const moreTopics = await bindMoreTopics(harness);
      for (const key of [topic, ...moreTopics]) harness.refusedThreads.add(key.thread);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.start();
      for (const key of [topic, ...moreTopics]) harness.indicator.requestRefresh(key);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.equal(harness.renameAttempts.length, 3, 'each topic is refused once, as it is first looked at');

      await harness.advance(60_000);
      assert.equal(harness.renameAttempts.length, 4, 'a sweep probes one topic');
      await harness.advance(60_000);
      assert.equal(harness.renameAttempts.length, 5, 'and the next one');
      assert.equal(new Set(harness.renameAttempts.slice(3)).size, 2, 'a probe that is refused again goes to the end: the next sweep probes another topic');

      // The right is granted: the next probe succeeds, and only then do the other topics try again.
      harness.refusedThreads.clear();
      await harness.advance(60_000);
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name).sort(), ['Billing 🟢', 'Deploy 🟢', 'Research 🟢']);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false);
      harness.indicator.stop();
    });

    it('a probe that came to no write — nothing wanted a mark — says nothing about the right: it is dropped, and with no other refused topic the chat is released', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      harness.refusedThreads.add(topic.thread);
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true);
      assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true, 'the refusal is kept with the binding');
      setInputs(harness, topic, {});
      harness.indicator.start();
      await harness.advance(60_000);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the first sweep chose the probe, which had nothing to write');
      await harness.advance(60_000);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false, 'the second dropped it: the hint would be stale');
      assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, undefined, 'and the binding forgot it too');
      harness.indicator.stop();
    });

    for (const [cause, brokenError] of [
      ['its topic was deleted in Telegram while still bound (\u00abmessage thread not found\u00bb)', createApiError('Bad Request: message thread not found')],
      ['its rename keeps failing for a cause that is no missing right (a 400 of another kind)', createApiError('Bad Request: something odd', 400)],
      ['its rename keeps throwing an error that is neither an answer nor the network\'s — a bug of ours (a TypeError)', new TypeError('x is not a function')],
    ] as const) {
      it(`a probe that ends without a verdict on the right — ${cause} — is dropped like a silent one: the next refused topic is probed and written, the chat released`, async () => {
        const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
        const [research, billing] = await bindMoreTopics(harness);
        setInputs(harness, billing, {});
        for (const key of [topic, research]) harness.refusedThreads.add(key.thread);
        setInputs(harness, topic, { isFinished: true });
        harness.indicator.start();
        for (const key of [topic, research]) harness.indicator.requestRefresh(key);
        await harness.settle();
        await harness.advance(indicatorSettleMs);
        assert.deepEqual(harness.renameAttempts, [topic.thread, research.thread], 'each topic is refused once');
        assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true);

        // The right is back, but the oldest refused topic — the probe — cannot be renamed for another reason: its answer says nothing about the right.
        harness.refusedThreads.clear();
        harness.brokenThreads.set(topic.thread, brokenError);
        await harness.advance(60_000);
        assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the first sweep probed the topic that cannot be renamed: the chat is still refused');
        assert.equal(harness.renames.length, 0);

        await harness.advance(60_000);
        await harness.advance(indicatorSettleMs);
        assert.deepEqual(harness.renames.map((rename) => `${rename.key.thread}:${rename.name}`), [`${research.thread}:Research 🟢`], 'the second sweep dropped that probe and probed — and wrote — the next refused topic');
        assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false, 'the probe that went through released the chat');
        assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, undefined, 'the dropped probe\'s flag is cleared in its binding');
        assert.equal(harness.state.getBinding(research)?.indicatorRenameRefused, undefined, 'and so is the written one\'s');
        harness.indicator.stop();
      });
    }

    for (const [cause, transientError] of [
      ['a 502 from Telegram', createApiError('Bad Gateway', 502)],
      ['a 429 that outlived the send gate\'s own retry', createApiError('Too Many Requests: retry after 5', 429)],
      ['a connection reset before any answer', new Error('socket hang up')],
    ] as const) {
      it(`a probe whose rename fails with ${cause} is KEPT across the sweeps — the hint stays, no other topic is tried — and when its retry is refused it is recorded again and the next sweep probes another topic`, async () => {
        const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
        const [research, billing] = await bindMoreTopics(harness);
        setInputs(harness, billing, {});
        for (const key of [topic, research]) harness.refusedThreads.add(key.thread);
        setInputs(harness, topic, { isFinished: true });
        harness.indicator.start();
        for (const key of [topic, research]) harness.indicator.requestRefresh(key);
        await harness.settle();
        await harness.advance(indicatorSettleMs);
        assert.deepEqual(harness.renameAttempts, [topic.thread, research.thread], 'each topic is refused once');
        const attemptsOf = (key: SessionKey): number => harness.renameAttempts.filter((thread) => thread === key.thread).length;

        // The outage: the right is back, but the probe's call gets no verdict. Several sweeps pass, and its retries fail the same way.
        harness.refusedThreads.clear();
        harness.brokenThreads.set(topic.thread, transientError);
        await harness.advance(3 * 60_000);
        assert.ok(attemptsOf(topic) > 1, 'the probe was tried, and its retries went on');
        assert.equal(attemptsOf(research), 1, 'the other refused topic was never tried: the probe is no verdict on the right');
        assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the hint stays through the outage');
        assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true, 'and so does the flag of the probe\'s topic in its binding');
        assert.equal(harness.state.getBinding(research)?.indicatorRenameRefused, true, 'and the other\'s');
        assert.equal(harness.renames.length, 0);

        // The outage ends, the right is still missing: the retry is refused and the topic is recorded as refused again.
        harness.brokenThreads.delete(topic.thread);
        harness.refusedThreads.add(topic.thread);
        await harness.advance(60_000);
        assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true);
        assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true, 'its flag is saved again');

        // The next sweep probes ANOTHER topic (the right is back for it): the re-refused one was put back among the refused, not kept as the probe.
        // Its write releases the chat, and the re-refused topic is refused again.
        await harness.advance(2 * 60_000);
        await harness.advance(indicatorSettleMs);
        assert.deepEqual(harness.renames.map((rename) => `${rename.key.thread}:${rename.name}`), [`${research.thread}:Research 🟢`], 'the other topic was probed and written');
        assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the re-refused topic stays refused');
        assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true, 'with its flag');
        assert.equal(harness.state.getBinding(research)?.indicatorRenameRefused, undefined, 'the written topic\'s flag is cleared');
        harness.indicator.stop();
      });
    }

    it('a probe that came to no write does NOT release the whole chat: the next refused topic is probed, one failing call per sweep', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      const [research, billing] = await bindMoreTopics(harness);
      for (const key of [topic, research, billing]) harness.refusedThreads.add(key.thread);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.start();
      for (const key of [topic, research, billing]) harness.indicator.requestRefresh(key);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renameAttempts, [topic.thread, research.thread, billing.thread], 'each topic is refused once, in the order it was first looked at');

      // The oldest refused topic, the first probe, no longer wants a mark: its probe comes to no write.
      setInputs(harness, topic, {});
      await harness.advance(60_000);
      assert.equal(harness.renameAttempts.length, 3, 'the first sweep probed the topic that had nothing to write');
      await harness.advance(60_000);
      assert.deepEqual(harness.renameAttempts.slice(3), [research.thread], 'the second sweep dropped that probe and tried ONE other topic — not the whole chat');
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true);
      harness.indicator.stop();
    });

    it('a sweep that comes while the probe is still on its way (a slow send gate) loses nothing: the right comes back, and the answered question\'s 🟢 is written at once', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 3_000, bootWaveDelayMs: 1_000 } });
      harness.refusedThreads.add(topic.thread);
      harness.indicator.start();
      await wantAndWait(harness, topic, { isFinished: true });
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the ❓ was refused');

      // The right is back, but the sends are slow: several sweeps pass while the probe's call is still waiting for the gate.
      harness.refusedThreads.clear();
      harness.isSendHeld.current = true;
      await harness.advance(10_000);
      // A probe whose call is still queued has no result: the sweeps that came meanwhile did not take it for a silent one — the chat is
      // still refused (the picker's hint stays) and its binding still says so.
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the hint stays while the probe is on its way');
      assert.equal(harness.state.getBinding(topic)?.indicatorRenameRefused, true, 'and so does the flag in the binding');
      assert.equal(harness.renameAttempts.length, 2, 'one call from the first refusal, ONE probe on its way — the sweeps sent no second');
      harness.isSendHeld.current = false;
      harness.releaseHeldRenames();
      await harness.settle();
      assert.equal(harness.fakeNameOf(topic), 'Deploy ❓', 'the held calls went through: the mark shows');

      // The question is answered: the mark leaves at once, however the probes before it ended.
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.fakeNameOf(topic), 'Deploy 🟢');
      harness.indicator.stop();
    });

    it('a probe whose name still waits for the settle time has no result yet: the sweeps in between do not drop it, and its write releases the chat', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 3_000, bootWaveDelayMs: 1_000 } });
      harness.refusedThreads.add(topic.thread);
      harness.indicator.start();
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the ❓ was refused');

      // The question is gone and the agent works: ⏳ waits for the settle time (20 s), longer than several sweeps. The right is back.
      harness.refusedThreads.clear();
      setInputs(harness, topic, { isWorking: true });
      await harness.advance(9_000);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true, 'the probe waits for its settle time: it said nothing about the right, the hint stays');
      assert.equal(harness.renames.length, 0);
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ⏳']);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false, 'the write was the probe: the right is back');
      harness.indicator.stop();
    });

    it('a topic that was unbound is forgotten: it is never probed, and a chat with no refused topic left is released', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      const [research, billing] = await bindMoreTopics(harness);
      setInputs(harness, billing, {});
      for (const key of [topic, research]) harness.refusedThreads.add(key.thread);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.start();
      for (const key of [topic, research]) harness.indicator.requestRefresh(key);
      await harness.settle();
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renameAttempts, [topic.thread, research.thread]);

      await harness.state.removeBinding(topic);
      harness.indicator.forgetTopic(topic);
      await harness.advance(60_000);
      assert.deepEqual(harness.renameAttempts.slice(2), [research.thread], 'the sweep probed the topic that is still there, not the unbound one');

      await harness.state.removeBinding(research);
      harness.indicator.forgetTopic(research);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false, 'no refused topic is left in the chat');
      harness.indicator.stop();
    });

    it('a restart does not try the refused topics again: the binding remembers them, only the sweep\'s probe tries — and its success releases the rest', async () => {
      const first = await createHarness();
      const [research] = await bindMoreTopics(first);
      for (const key of [topic, research]) first.refusedThreads.add(key.thread);
      setInputs(first, topic, { isFinished: true });
      for (const key of [topic, research]) first.indicator.requestRefresh(key);
      await first.settle();
      await first.advance(indicatorSettleMs);
      assert.equal(first.renameAttempts.length, 2);
      assert.equal(first.state.getBinding(research)?.indicatorRenameRefused, true);

      // The boot after it: the same bindings, a new refresher. The wave and every signal find the topics refused: no call at all.
      const second = await createHarness({ state: first.state, windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      for (const key of [topic, research]) {
        second.refusedThreads.add(key.thread);
        setInputs(second, key, { isFinished: true });
      }
      second.indicator.start();
      for (const key of [topic, research]) second.indicator.requestRefresh(key);
      await second.settle();
      await second.advance(2_000 + indicatorSettleMs);
      assert.equal(second.renameAttempts.length, 0, 'not one failing call after the restart');
      assert.deepEqual(second.indicator.getHealth(topic), { isRenameRefused: true, isLineDeletionRefused: false }, 'the picker says why from the first moment');
      assert.equal(second.logs.filter((line) => line.includes('Manage topics')).length, 1, 'the boot says it once for the chat');

      await second.advance(60_000);
      assert.deepEqual(second.renameAttempts, [topic.thread], 'the first sweep probes one topic');
      second.refusedThreads.clear();
      await second.advance(60_000);
      await second.advance(indicatorSettleMs);
      assert.deepEqual(second.renames.map((rename) => rename.name).sort(), ['Deploy 🟢', 'Research 🟢'], 'the probe went through and released the other topic');
      assert.equal(second.state.getBinding(topic)?.indicatorRenameRefused, undefined, 'a written rename clears the flag in its own write');
      assert.equal(second.state.getBinding(research)?.indicatorRenameRefused, undefined);
      second.indicator.stop();
    });

    it('«topic not modified» for the owner\'s plain base proves the title IS the base: it is recorded as applied, not retried, and nothing is logged', async () => {
      const harness = await createHarness();
      await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy 💤' });
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      await wantAndWait(harness, topic, {});
      assert.equal(getAppliedName(harness), 'Deploy');
      assert.equal(harness.renameAttempts.length, 1);
      assert.equal(harness.logs.length, 0);
    });

    it('«topic not modified» for a name that is not what the bot believed shows — Telegram did not keep it (it drops a trailing ✅) — is NOT taken for applied: logged once per topic, not asked again until the name or the status changes', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      harness.indicator.start();
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renameAttempts.length, 1);
      assert.equal(getAppliedName(harness), undefined, 'the topic is still known to show the owner\'s own name: «Deploy 🟢» is not what it shows');
      assert.equal(harness.logs.filter((line) => line.includes('did not keep «Deploy 🟢»')).length, 1, 'one line, naming the name');

      // Signals, sweeps and the boot wave come and go: the same call would be answered the same, so it is never sent again.
      for (const round of [1, 2, 3, 4, 5]) {
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        await harness.advance(60_000 + round);
      }
      assert.equal(harness.renameAttempts.length, 1, 'no retry loop');
      assert.equal(harness.logs.length, 1, 'and no second line');

      // The status changes: a name that IS kept is written, and the belief follows it.
      await wantAndWait(harness, topic, { isWorking: true }, indicatorSettleMs + indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ⏳']);
      assert.equal(getAppliedName(harness), 'Deploy ⏳');

      // Back to the name that was not kept: asked once more (the pair is a new one), answered the same, and the line is not repeated.
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      await wantAndWait(harness, topic, { isFinished: true }, indicatorSettleMs + indicatorMinRenameGapMs);
      assert.equal(harness.renameAttempts.length, 3);
      assert.equal(getAppliedName(harness), 'Deploy ⏳', 'still what was last kept');
      assert.equal(harness.logs.length, 1, 'once per topic');
      harness.indicator.stop();
    });

    it('a change the owner makes with a switch asks for the name again although nothing else changed: he asked, and Telegram may have changed meanwhile', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renameAttempts.length, 1);
      assert.equal(getAppliedName(harness), undefined);
      // The same pair, a sign of life from nobody: not asked again. The owner touches a switch: asked, and — Telegram keeps it now — believed.
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renameAttempts.length, 1);
      harness.indicator.requestRefresh(topic, { isOwnerChange: true });
      await harness.settle();
      assert.equal(harness.renameAttempts.length, 2);
      assert.equal(getAppliedName(harness), 'Deploy 🟢');
    });

    it('«not modified» may mean the BELIEF was stale: a later wish equal to that stale belief is still written, never taken for «already shown»', async () => {
      const harness = await createHarness();
      // The bot believes ⏳, the topic shows 🟢 already (a hot worker killed between the rename and the save): the 🟢 ask is «not modified».
      await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy ⏳' });
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renameAttempts.length, 1);
      assert.equal(getAppliedName(harness), 'Deploy ⏳', 'not taken for applied');
      assert.equal(harness.logs.length, 1);
      assert.match(harness.logs[0], /dropped part of the name, or the bot's belief was stale/, 'the line does not claim more than is known');

      // The next turn wants ⏳ — the name the stale belief holds. The topic shows 🟢, so it must be asked.
      await wantAndWait(harness, topic, { isWorking: true }, indicatorSettleMs + indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ⏳']);
      assert.equal(getAppliedName(harness), 'Deploy ⏳');
    });

    it('«not kept» answers the owner\'s ask: the next wish that is none of his waits for the settle time instead of flashing its mark for a minute', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic, { isOwnerChange: true });
      await harness.settle();
      assert.equal(harness.renameAttempts.length, 1, 'the owner\'s switch was asked at once');

      // A short turn starts: ⏳ is no wish of the owner, so it waits out the settle time like any other.
      setInputs(harness, topic, { isWorking: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renameAttempts.length, 1, 'not at once');
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ⏳']);
    });

    describe('the name on the bot\'s own «renamed» line is what Telegram STORED', () => {
      /** The topic wants 🟢 and the ask goes through (answer ok): the line that follows says what the title reads now. */
      async function askFinished(harness: Harness): Promise<void> {
        await wantAndWait(harness, topic, { isFinished: true });
        assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
        assert.equal(getAppliedName(harness), 'Deploy 🟢');
      }

      it('a line with another name than the one asked — an answer ok that Telegram kept altered — is NOT kept: the stored name is the belief, one line is logged, and the same ask is not repeated', async () => {
        const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
        harness.indicator.start();
        await askFinished(harness);
        await harness.indicator.handleOwnRenameLine(topic, 11, 'Deploy');
        await harness.settle();
        assert.equal(getAppliedName(harness), 'Deploy', 'the belief is what the topic shows');
        assert.equal(harness.logs.filter((line) => line.includes('did not keep «Deploy 🟢»') && line.includes('stored «Deploy»')).length, 1);
        assert.deepEqual(harness.deletions.map((deletion) => deletion.messageId), [11], 'the line is deleted all the same');

        for (const round of [1, 2, 3, 4]) {
          harness.indicator.requestRefresh(topic);
          await harness.settle();
          await harness.advance(60_000 + round);
        }
        assert.equal(harness.renameAttempts.length, 1, 'the belief and the wish are the pair that was not kept: nothing is asked again');

        // Another status is written as usual, and the belief follows it.
        await wantAndWait(harness, topic, { isWorking: true }, indicatorSettleMs + indicatorMinRenameGapMs);
        assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy ⏳']);
        harness.indicator.stop();
      });

      it('a line with the name that was asked changes nothing', async () => {
        const harness = await createHarness();
        await askFinished(harness);
        await harness.indicator.handleOwnRenameLine(topic, 11, 'Deploy 🟢');
        await harness.settle();
        assert.equal(getAppliedName(harness), 'Deploy 🟢');
        assert.equal(harness.logs.length, 0);
      });

      it('a line that is nobody\'s to judge changes nothing: a name that is no reduction of the ask, a line with no ask behind it (an earlier life), a line that came after the window', async () => {
        const harness = await createHarness();
        await askFinished(harness);
        await harness.indicator.handleOwnRenameLine(topic, 11, 'Something else entirely');
        assert.equal(getAppliedName(harness), 'Deploy 🟢', 'no reduction of the ask');

        await harness.indicator.handleOwnRenameLine(topic, 12, 'Deploy 🟢');
        await harness.indicator.handleOwnRenameLine(topic, 13, 'Deploy');
        assert.equal(getAppliedName(harness), 'Deploy 🟢', 'the ask was matched with its line already: this one has none');

        await harness.advance(60_000);
        await wantAndWait(harness, topic, { isAsleep: true }, indicatorSettleMs);
        await harness.advance(31_000);
        await harness.indicator.handleOwnRenameLine(topic, 14, 'Deploy');
        assert.equal(getAppliedName(harness), 'Deploy 💤', 'the ask is overdue: its line is forgotten with it');
        assert.equal(harness.logs.length, 0);
      });

      it('an altered ask whose belief a NEWER ask has taken over is history: the belief stays the newer ask\'s', async () => {
        const harness = await createHarness();
        await askFinished(harness);
        // A question comes at once (an edge skips the gap): the ❓ ask is on its way when the 🟢 ask\'s altered line arrives.
        setInputs(harness, topic, { hasOpenQuestion: true });
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy ❓']);

        await harness.indicator.handleOwnRenameLine(topic, 31, 'Deploy');
        await harness.settle();
        assert.equal(getAppliedName(harness), 'Deploy ❓', 'the belief stays the newest ask: a title that is «Deploy» for a moment is not what the topic will read');
        await harness.indicator.handleOwnRenameLine(topic, 32, 'Deploy ❓');
        assert.equal(getAppliedName(harness), 'Deploy ❓');
        assert.equal(harness.renameAttempts.length, 2, 'and no call is spent on correcting a belief that was never wrong');
      });

      it('lines come in the order of the asks: the first is kept, the second altered — and it is the latest ask, so its stored name is the belief', async () => {
        const harness = await createHarness();
        // ❓ at once, then its answer at once: two asks inside the gap (the edges skip it).
        await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy ⏳' });
        setInputs(harness, topic, { hasOpenQuestion: true });
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        setInputs(harness, topic, { isFinished: true });
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓', 'Deploy 🟢']);

        await harness.indicator.handleOwnRenameLine(topic, 21, 'Deploy ❓');
        assert.equal(getAppliedName(harness), 'Deploy 🟢', 'the ❓ was kept as asked: the 🟢 ask is still to be judged');
        await harness.indicator.handleOwnRenameLine(topic, 22, 'Deploy');
        await harness.settle();
        assert.equal(getAppliedName(harness), 'Deploy', 'the 🟢 ask was the latest: its stored name is the belief');
      });
    });

    it('a failure a later try may fix is logged once per cause and tried again after a backoff that grows, up to a sweep — with no new signal', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 100_000 } });
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.logs.length, 1);
      assert.match(harness.logs[0], /renaming the topic failed: Bad Request: something odd/);
      assert.equal(getAppliedName(harness), undefined, 'nothing is recorded as applied');
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false);
      assert.equal(harness.renameAttempts.length, 1);

      // The retry comes after the minimum gap (60 s); it fails too, and the next waits twice as long, capped at the sweep.
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      await harness.advance(indicatorMinRenameGapMs - 1);
      assert.equal(harness.renameAttempts.length, 1, 'not before the backoff is over');
      await harness.advance(1);
      assert.equal(harness.renameAttempts.length, 2, 'the first retry');
      assert.equal(harness.logs.length, 1, 'the same cause is not logged again');
      await harness.advance(99_999);
      assert.equal(harness.renameAttempts.length, 2, 'the second backoff is longer than the first, capped at the sweep');
      await harness.advance(1);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢'], 'the second retry wrote the latest name');
      assert.equal(harness.renameAttempts.length, 3);
    });

    it('a retry writes the LATEST wanted name, not the one that failed', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      await wantAndWait(harness, topic, { isFinished: true });
      setInputs(harness, topic, { isAsleep: true });
      await harness.advance(indicatorMinRenameGapMs);
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);
    });

    it('a topic that keeps signalling while Telegram fails sends one try per backoff, not one per signal — only a ❓ edge goes at once', async () => {
      // A backoff (the gap) longer than the four signals below: the gap and the settle time are long over when they come.
      const harness = await createHarness({ windows: { minGapMs: 300_000, sweepIntervalMs: 1_000_000 } });
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      await wantAndWait(harness, topic, { isFinished: true });
      assert.equal(harness.renameAttempts.length, 1);

      // Signals come while the backoff runs (the settle time and the gap are long over): none sends a call.
      for (const inputs of [{ isAsleep: true }, { isWorking: true }, { isFinished: true }, { isAsleep: true }]) {
        setInputs(harness, topic, inputs);
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        await harness.advance(indicatorSettleMs);
      }
      assert.equal(harness.renameAttempts.length, 1, 'four signals inside the backoff, no call');

      // A question must be seen at once, backoff or not.
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓']);
      assert.equal(harness.renameAttempts.length, 2);
    });

    it('the backoff ends with ONE write of the latest wanted name, whatever the signals asked meanwhile', async () => {
      const harness = await createHarness({ windows: { minGapMs: 300_000, sweepIntervalMs: 1_000_000 } });
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      await wantAndWait(harness, topic, { isFinished: true });
      for (const inputs of [{ isWorking: true }, { isFinished: true }, { isAsleep: true }]) {
        setInputs(harness, topic, inputs);
        harness.indicator.requestRefresh(topic);
        await harness.settle();
        await harness.advance(indicatorSettleMs);
      }
      assert.equal(harness.renameAttempts.length, 1);
      await harness.advance(300_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤'], 'one try, with the name the topic wants by then');
      assert.equal(harness.renameAttempts.length, 2);
    });

    it('a 429\'s own cooldown is the floor of the backoff', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 10 * indicatorMinRenameGapMs } });
      harness.failNextRename.error = new RateLimitedError(chatId, 5 * indicatorMinRenameGapMs);
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.advance(4 * indicatorMinRenameGapMs);
      assert.equal(harness.renameAttempts.length, 1, 'the cooldown is not over');
      await harness.advance(indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
    });

    it('a topic that is gone or closed is not retried by a timer', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: message thread not found');
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.advance(10 * indicatorMinRenameGapMs);
      assert.equal(harness.renameAttempts.length, 1);
      assert.equal(harness.getTimerCount(), 0);
    });
  });

  describe('the bot\'s own «renamed» line', () => {
    it('is deleted at once', async () => {
      const harness = await createHarness();
      await harness.indicator.handleOwnRenameLine(topic, 4242, 'Deploy');
      assert.deepEqual(harness.deletions, [{ key: topic, messageId: 4242 }]);
      assert.deepEqual(harness.indicator.getHealth(topic), { isRenameRefused: false, isLineDeletionRefused: false });
    });

    it('stays when Telegram REFUSES the delete: one log line and a hint for the picker, while the renames go on', async () => {
      const harness = await createHarness();
      harness.deletionError.current = createApiError('Bad Request: message can\'t be deleted');
      await harness.indicator.handleOwnRenameLine(topic, 1, 'Deploy');
      await harness.indicator.handleOwnRenameLine(topic, 2, 'Deploy');
      assert.equal(harness.logs.filter((line) => line.includes('stayed')).length, 1);
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, true);
      await wantAndWait(harness, topic, { isFinished: true });
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
    });

    it('a failure that says nothing about the right — a reset, a 429 after its retry — is logged once and is NOT taken for a missing right', async () => {
      const harness = await createHarness();
      harness.deletionError.current = new Error('socket hang up');
      await harness.indicator.handleOwnRenameLine(topic, 1, 'Deploy');
      await harness.indicator.handleOwnRenameLine(topic, 2, 'Deploy');
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, false);
      assert.equal(harness.logs.length, 1, 'one line for the same cause');
      assert.match(harness.logs[0], /deleting the «renamed the topic» line failed: socket hang up/);
      harness.deletionError.current = createApiError('Too Many Requests: retry after 3', 429);
      await harness.indicator.handleOwnRenameLine(topic, 3, 'Deploy');
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, false);
    });

    it('the sweep forgets a refusal to delete: the hint must not outlive the missing right', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      harness.deletionError.current = createApiError('Bad Request: not enough rights to delete a message');
      await harness.indicator.handleOwnRenameLine(topic, 1, 'Deploy');
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, true);
      harness.indicator.start();
      await harness.advance(60_000);
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, false);
      harness.indicator.stop();
    });

    it('a line that was already gone is no refusal', async () => {
      const harness = await createHarness();
      harness.deletionError.current = createApiError('Bad Request: message to delete not found');
      await harness.indicator.handleOwnRenameLine(topic, 7, 'Deploy');
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, false);
      assert.equal(harness.logs.length, 0);
    });
  });

  describe('a topic that is being unbound', () => {
    it('a look queued before the unbind began writes nothing — not even a ❓ edge — and the name put back stays the last write', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      harness.unbindingThreads.add(topic.thread);
      await harness.settle();
      assert.equal(harness.renames.length, 1, 'the queued look found the topic unbinding');

      await harness.indicator.restoreBaseName(topic);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy'], 'the unbind\'s own restore still writes');
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(settleAndGapMs);
      assert.equal(harness.renames.length, 2, 'and nothing after it');
    });

    it('a refresh asked for while the restore runs writes nothing either', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.unbindingThreads.add(topic.thread);
      const restore = harness.indicator.restoreBaseName(topic);
      harness.indicator.requestRefresh(topic);
      await restore;
      await harness.settle();
      await harness.advance(settleAndGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy']);
    });
  });

  describe('the names the bot wrote', () => {
    it('the last three are remembered, newest first, for the owner\'s rename to be read against', async () => {
      const harness = await createHarness();
      assert.deepEqual(harness.indicator.getRecentAppliedNames(topic), []);
      for (const inputs of [{ isFinished: true }, { isAsleep: true }, { isStuck: true }, { hasOpenQuestion: true }]) {
        await wantAndWait(harness, topic, inputs, settleAndGapMs);
      }
      assert.deepEqual(harness.indicator.getRecentAppliedNames(topic), ['Deploy ❓', 'Deploy ❗️', 'Deploy 💤']);
    });
  });

  describe('the owner\'s name put back', () => {
    it('restoreBaseName writes the base at once, whatever the gap says', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      await harness.indicator.restoreBaseName(topic);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy']);
      assert.equal(getAppliedName(harness), 'Deploy');
    });

    it('writes nothing when the topic already shows the owner\'s name', async () => {
      const harness = await createHarness();
      await harness.indicator.restoreBaseName(topic);
      assert.equal(harness.renames.length, 0);
    });

    it('cancels a rename that waits for its gap', async () => {
      const harness = await createHarness();
      await wantAndWait(harness, topic, { isFinished: true });
      await wantAndWait(harness, topic, { isAsleep: true }, 1_000);
      await harness.indicator.restoreBaseName(topic);
      await harness.advance(10 * indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢', 'Deploy'], 'the waiting 💤 never lands over the restored name');
    });
  });

  describe('the boot wave and the sweep', () => {
    it('the wave looks after its window and only once the waiting updates are handled', async () => {
      const harness = await createHarness({ windows: { bootWaveDelayMs: 5_000, sweepIntervalMs: 10 * indicatorSweepIntervalMs } });
      setInputs(harness, topic, { isAsleep: true });
      harness.isBacklogHandled.current = false;
      harness.indicator.start();
      await harness.advance(5_000 + indicatorSettleMs);
      assert.equal(harness.renames.length, 0, 'the updates that waited are not handled yet');
      harness.isBacklogHandled.current = true;
      await harness.advance(1_000 + indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);
      harness.indicator.stop();
    });

    it('a signal of the boot itself — a mark leaving ❓ asks for a write at once — waits for the updates that waited: the owner\'s rename made during the downtime is learned first', async () => {
      const harness = await createHarness();
      await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy ❓' });
      harness.isBacklogHandled.current = false;
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(10_000);
      assert.equal(harness.renames.length, 0, 'nothing is written with a name the owner may have changed meanwhile');

      // The update is handled: the owner had renamed the topic around the mark. Now the write goes out, with his NEW name.
      await harness.state.setBindingTopicNaming(topic, { topicName: 'Deploy 2', indicatorAppliedName: 'Deploy 2 ❓' });
      harness.isBacklogHandled.current = true;
      await harness.advance(1_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 2 🟢'], 'once, with the new name — never the old one');
    });

    it('a boot with NOTHING waiting: a mark leaving ❓ is written once the first poll has stayed open for the hold — seconds after the start, not at the cap', async () => {
      const harness = await createHarness();
      await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy ❓' });
      // The real note over a host whose first long poll Telegram holds open (nothing waits for the bot), on the test's clock.
      const host: CallApiHost = { callApi: () => new Promise(() => undefined) };
      const note = installFirstUpdateBatchNote(host, { getNowMs: harness.nowMs });
      harness.backlogProbe.current = () => note.checkIsBacklogHandled(0);
      harness.indicator.start();
      void host.callApi('getUpdates', { timeout: 50 });
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(firstPollHoldMs - 1);
      assert.equal(harness.renames.length, 0, 'the poll could still be about to bring the owner\'s rename');
      await harness.advance(1_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
      assert.ok(harness.nowMs() - 1_000_000 < 10_000, 'well before the 30 s cap');
      harness.indicator.stop();
    });

    it('the wave does not wait for ever for a backlog that never settles', async () => {
      const harness = await createHarness({ windows: { bootWaveDelayMs: 1_000, sweepIntervalMs: 10 * indicatorSweepIntervalMs } });
      setInputs(harness, topic, { isAsleep: true });
      harness.isBacklogHandled.current = false;
      harness.indicator.start();
      await harness.advance(60_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);
      harness.indicator.stop();
    });

    it('the wave writes only the topics whose name changes: a restart renames nothing that is already right', async () => {
      const harness = await createHarness({ windows: { bootWaveDelayMs: 1_000, sweepIntervalMs: 10 * indicatorSweepIntervalMs } });
      await harness.state.setBindingTopicNaming(topic, { indicatorAppliedName: 'Deploy 💤' });
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.start();
      await harness.advance(5_000 + indicatorSettleMs);
      assert.equal(harness.renames.length, 0);
      harness.indicator.stop();
    });

    it('the sweep looks at every topic again, for the changes no event announces', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      harness.indicator.start();
      await harness.advance(2_000);
      setInputs(harness, topic, { isFinished: true });
      await harness.advance(indicatorSettleMs);
      assert.equal(harness.renames.length, 0, 'no event signalled it, and the sweep has not come yet');
      await harness.advance(60_000);
      await harness.advance(indicatorSettleMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 🟢']);
      harness.indicator.stop();
    });

    it('stop cancels every timer', async () => {
      const harness = await createHarness();
      harness.indicator.start();
      assert.ok(harness.getTimerCount() > 0);
      harness.indicator.stop();
      assert.equal(harness.getTimerCount(), 0);
    });
  });
});
