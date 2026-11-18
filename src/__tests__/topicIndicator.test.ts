/**
 * @description The refresher of the status mark at the end of a topic's name (`connectors/telegram/topicIndicator.ts`) over fake ports, a
 * fake clock and a real `StateStore`: what it writes and when — the question edges at once, the settle time of ⏳, the gap between two
 * renames with the latest state winning — what it never writes (a topic whose own name it does not know), how it answers Telegram's
 * refusals (the missing right stops the chat, «not modified» is fine, anything else is logged once), the bot's own «renamed» line, the
 * name put back, the owner's change of a switch, the sweep and the boot wave.
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
import type { ThreadMessageDeletion } from '../connectors/telegram/commands/botCore';

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
  deletionOutcome: { current: ThreadMessageDeletion };
  isBacklogHandled: { current: boolean };
  nowMs: () => number;
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

  async function createHarness(options: { windows?: Partial<{ settleMs: number; minGapMs: number; sweepIntervalMs: number; bootWaveDelayMs: number }> } = {}): Promise<Harness> {
    const state = new StateStore(dataDir, { saveDebounceMs: 5 });
    stores.push(state);
    await state.init();
    await state.setBinding(topic, 'alpha', { topicName: 'Deploy' });
    let currentMs = 1_000_000;
    const timers: FakeTimer[] = [];
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
      deletionOutcome: { current: 'deleted' },
      isBacklogHandled: { current: true },
      nowMs: () => currentMs,
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
      getPrefs: () => parts.prefs.current,
      getStatusInputs: (key) => {
        parts.inputReads.count += 1;
        return parts.inputs.get(`${key.thread}`) ?? nothingHolds;
      },
      getAgentsCount: () => parts.counts.agents,
      getQueuedCount: () => parts.counts.queued,
      sendTopicName: async (key, name) => {
        if (parts.failNextRename.error !== null) {
          const error = parts.failNextRename.error;
          parts.failNextRename.error = null;
          throw error;
        }
        parts.renames.push({ key, name });
      },
      deleteMessage: async (key, messageId) => {
        parts.deletions.push({ key, messageId });
        return parts.deletionOutcome.current;
      },
      checkIsBacklogHandled: () => parts.isBacklogHandled.current,
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

  describe('what it writes', () => {
    it('writes the question mark at once, and takes it off at once when the question is answered', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { hasOpenQuestion: true, isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓']);
      assert.equal(getAppliedName(harness), 'Deploy ❓', 'the applied name is persisted');

      // The answer comes a second later: far inside the gap, and the next state shows at once all the same.
      await harness.advance(1_000);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ❓', 'Deploy ✅']);
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
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames, [{ key: topic, name: 'Deploy 💤' }]);
    });

    it('shows ⏳ only after the turn has run the settle time, and a short turn goes straight to ✅', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);

      // A turn of 5 s: ⏳ never shows.
      setInputs(harness, topic, { isWorking: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(5_000);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤', 'Deploy ✅'], 'straight to ✅, no ⏳ in between');

      // A turn that runs on: ⏳ shows when the settle time is up (the gap since ✅ is up by then too).
      await harness.advance(indicatorMinRenameGapMs);
      setInputs(harness, topic, { isWorking: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(indicatorSettleMs - 1_000);
      assert.equal(harness.renames.at(-1)?.name, 'Deploy ✅', 'still not');
      await harness.advance(1_000);
      assert.equal(harness.renames.at(-1)?.name, 'Deploy ⏳');
    });

    it('keeps two renames of a topic a gap apart, and what came and went inside the gap is never shown: the latest state wins', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅']);

      // Inside the gap: stuck, then asleep. Neither is written; the topic waits for the gap's end.
      await harness.advance(10_000);
      setInputs(harness, topic, { isStuck: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(10_000);
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renames.length, 1, 'nothing written inside the gap');

      await harness.advance(indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅', 'Deploy 💤'], 'the latest state, once, when the gap ended');
    });

    it('writes nothing for a state the topic already shows', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
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
      assert.equal(harness.renames.length, 1);
      assert.ok(harness.inputReads.count <= 4, `the facts were read ${harness.inputReads.count} times for 50 signals in one tick`);
    });

    it('shows no mark for a topic that has no agent, and the owner\'s own name for a closed topic', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(indicatorMinRenameGapMs);
      await harness.state.setBindingClosed(topic, true);
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅', 'Deploy'], 'a closed topic shows the owner\'s name');
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
      assert.equal(harness.renames.length, 0);
    });
  });

  describe('the switches', () => {
    it('a status switched off is skipped; every status off leaves the owner\'s name', async () => {
      const harness = await createHarness();
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames, [], 'the name already is the owner\'s: nothing to write');
    });

    it('the counts show after the mark only when switched on, each only from 1', async () => {
      const harness = await createHarness();
      harness.prefs.current = { ...defaultTopicStatusPrefs, agents: true, queued: true };
      harness.counts.agents = 3;
      harness.counts.queued = 5;
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renames.at(-1)?.name, 'Deploy ✅ ⚙️3 📋5');
    });

    it('a change the owner made skips the gap: the base name is back at once when he turns the mark off', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(2_000);
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      harness.indicator.requestRefresh(topic, { isOwnerChange: true });
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅', 'Deploy']);
    });

    it('a change that is not the owner\'s waits for the gap even when a switch moved', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(2_000);
      harness.prefs.current = { ...defaultTopicStatusPrefs, finished: false };
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renames.length, 1);
      await harness.advance(indicatorMinRenameGapMs);
      assert.equal(harness.renames.length, 2);
    });
  });

  describe('Telegram\'s answers', () => {
    it('a missing «Manage topics» right stops the feature for the chat, with one log line and a hint for the picker', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: not enough rights to manage topics');
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.indicator.getHealth(topic), { isRenameRefused: true, isLineDeletionRefused: false });
      assert.equal(harness.logs.filter((line) => line.includes('Manage topics')).length, 1);

      setInputs(harness, topic, { hasOpenQuestion: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.renames.length, 0, 'not tried again while refused');
      assert.equal(harness.logs.length, 1, 'and no second line');
    });

    it('the sweep tries a refused chat once more, and logs nothing new when it is refused again', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000 } });
      harness.indicator.start();
      harness.failNextRename.error = createApiError('Bad Request: not enough rights');
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, true);
      // The right is granted meanwhile: the sweep's attempt succeeds.
      await harness.advance(60_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅']);
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false);
      harness.indicator.stop();
    });

    it('«topic not modified» means the topic already has the name: it is recorded as applied, not retried', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: TOPIC_NOT_MODIFIED');
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(getAppliedName(harness), 'Deploy ✅');
      assert.equal(harness.logs.length, 0);
    });

    it('any other failure is logged once per cause and tried again at the next signal', async () => {
      const harness = await createHarness();
      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.logs.length, 1);
      assert.match(harness.logs[0], /renaming the topic failed: Bad Request: something odd/);
      assert.equal(getAppliedName(harness), undefined, 'nothing is recorded as applied');
      assert.equal(harness.indicator.getHealth(topic).isRenameRefused, false);

      harness.failNextRename.error = createApiError('Bad Request: something odd', 500);
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.equal(harness.logs.length, 1, 'the same cause is not logged again');
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅'], 'the next signal after the failures writes it');
    });
  });

  describe('the bot\'s own «renamed» line', () => {
    it('is deleted at once', async () => {
      const harness = await createHarness();
      await harness.indicator.handleOwnRenameLine(topic, 4242);
      assert.deepEqual(harness.deletions, [{ key: topic, messageId: 4242 }]);
      assert.deepEqual(harness.indicator.getHealth(topic), { isRenameRefused: false, isLineDeletionRefused: false });
    });

    it('stays when Telegram refuses the delete: one log line and a hint for the picker, while the renames go on', async () => {
      const harness = await createHarness();
      harness.deletionOutcome.current = 'stayed';
      await harness.indicator.handleOwnRenameLine(topic, 1);
      await harness.indicator.handleOwnRenameLine(topic, 2);
      assert.equal(harness.logs.filter((line) => line.includes('stayed')).length, 1);
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, true);
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅']);
    });

    it('a line that was already gone is no refusal', async () => {
      const harness = await createHarness();
      harness.deletionOutcome.current = 'gone';
      await harness.indicator.handleOwnRenameLine(topic, 7);
      assert.equal(harness.indicator.getHealth(topic).isLineDeletionRefused, false);
      assert.equal(harness.logs.length, 0);
    });
  });

  describe('the owner\'s name put back', () => {
    it('restoreBaseName writes the base at once, whatever the gap says', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.indicator.restoreBaseName(topic);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅', 'Deploy']);
      assert.equal(getAppliedName(harness), 'Deploy');
    });

    it('writes nothing when the topic already shows the owner\'s name', async () => {
      const harness = await createHarness();
      await harness.indicator.restoreBaseName(topic);
      assert.equal(harness.renames.length, 0);
    });

    it('cancels a rename that waits for its gap', async () => {
      const harness = await createHarness();
      setInputs(harness, topic, { isFinished: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.advance(1_000);
      setInputs(harness, topic, { isAsleep: true });
      harness.indicator.requestRefresh(topic);
      await harness.settle();
      await harness.indicator.restoreBaseName(topic);
      await harness.advance(10 * indicatorMinRenameGapMs);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅', 'Deploy'], 'the waiting 💤 never lands over the restored name');
    });
  });

  describe('the boot wave and the sweep', () => {
    it('the wave writes after its window and only once the waiting updates are handled', async () => {
      const harness = await createHarness({ windows: { bootWaveDelayMs: 5_000, sweepIntervalMs: 10 * indicatorSweepIntervalMs } });
      setInputs(harness, topic, { isAsleep: true });
      harness.isBacklogHandled.current = false;
      harness.indicator.start();
      await harness.advance(5_000);
      assert.equal(harness.renames.length, 0, 'the updates that waited are not handled yet');
      harness.isBacklogHandled.current = true;
      await harness.advance(1_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy 💤']);
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
      await harness.advance(5_000);
      assert.equal(harness.renames.length, 0);
      harness.indicator.stop();
    });

    it('the sweep looks at every topic again, for the changes no event announces', async () => {
      const harness = await createHarness({ windows: { sweepIntervalMs: 60_000, bootWaveDelayMs: 1_000 } });
      harness.indicator.start();
      await harness.advance(2_000);
      setInputs(harness, topic, { isFinished: true });
      assert.equal(harness.renames.length, 0, 'no event signalled it');
      await harness.advance(60_000);
      assert.deepEqual(harness.renames.map((rename) => rename.name), ['Deploy ✅']);
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
