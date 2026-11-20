/**
 * @description The idle mark of a process that is HELD, through the REAL compaction module
 * (`connectors/telegram/commands/compaction.ts`) wired to the command harness (`commandModuleHarness.ts`) and a stub adapter
 * whose working signals the test sets. Live incident: a topic's idle compaction never ran because its process was held for hours
 * on a stale "message not taken in" signal; every re-check found it held again, the bot said nothing, and the compaction ran
 * only when the operator typed `/compact`. The owner's rule: a compaction later than the idle window reads a cold prompt cache
 * and is useless, so the idle compaction runs only AT the idle mark. Proven here:
 *
 *   • a fire that finds the process held neither compacts nor stops, logs WHICH signal holds it, and posts ONE line in the
 *     topic saying the compaction was skipped and why — and remembers the mark as held;
 *   • the re-check of that held mark never compacts, however idle the process is by then: it decides only the stop, and says
 *     nothing again;
 *   • a re-adopt after a restart in between (the countdown re-armed from the saved instants, the held stamp among them) finds the
 *     mark spent: no second line, no late compaction — the stamp's own survival of a reload is `state.test.ts`'s;
 *   • activity after the held mark opens a new idle period: its mark compacts again;
 *   • a real turn still running at the mark holds it too, but says nothing: its end opens a new idle period anyway;
 *   • the overdue boot fire — the bot was down past the idle window — never compacts either, and only stops the idle process
 *     (the owner's rule again: after the window the cache is cold).
 *
 * What the line says for each kind of signal is `getIdleHeldNoticeReason`'s (`workingSignals.test.ts`); the decision's own
 * branches are `compactOnIdle.test.ts`'s. The whole thing at process level — the real bot, a fake agent holding a background
 * task, a bot restarted after the window — is `backgroundTaskStopE2e.test.ts` and `compactOnIdleMergedInputE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import type { AgentAdapter, AgentSession, CompactionResult, PendingQuestionState } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { enDict } from '../i18n/en';
import type { BackgroundWorkSignal } from '../utils/workingSignals';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test: the re-check of a held mark comes this long after the first fire. */
const idleWindowMs = 400;
/** What is left of the window when the timer is armed: the first fire comes right away. */
const windowLeftMs = 20;
/** How long the test lets the module sit after a fire it expects to do nothing more, several windows' worth. */
const quietMs = 3 * idleWindowMs;

const key: SessionKey = { platform: 'telegram', space: harnessGroup.id.toString(), thread: harnessThreadId.toString() };

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** A live conversation whose working signals the test sets: able to compact and to be stopped. */
class HeldStubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'stub-held-adapter';
  readonly label = 'Stub';
  signals: BackgroundWorkSignal[] = [];
  isBusy = false;
  compactions = 0;

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return true; }
  checkIsBusy(): boolean { return this.isBusy; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  rejectQuestion(): void {}
  getBackgroundWorkSignals(): BackgroundWorkSignal[] { return this.signals; }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

describe('the idle mark of a held process: told once, compacted never later', () => {
  let harness: CommandHarness;
  const adapter = new HeldStubAdapter();
  let steps: string[] = [];
  let logs: string[] = [];
  const modules: Array<ReturnType<typeof createCompaction>> = [];
  const originalLog = console.log;

  /** A module over the harness' saved state — a second one stands for the bot after a restart. */
  function createModule(): ReturnType<typeof createCompaction> {
    const pendingQuestions = new Map<string, PendingQuestionState>();
    const module = createCompaction({
      ...harness.core,
      compactSelfReviewFlagDirs: harness.compactSelfReviewFlagDirs,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions,
      clearPendingQuestion: (clearedKey) => { pendingQuestions.delete(keyToString(clearedKey)); },
      closeQuestionMessage: async () => true,
      setQuestionAsideAtIdle: async () => false,
      idleWindowMs,
      checkIsLimitWaitArmed: () => false,
      suspendThreadSession: async () => { steps.push('stop'); },
      resumeSleepingSessionForCompaction: async () => false,
      getThreadAdapter: () => adapter,
      deliverLabel: async () => null,
      resumeSleepingSessionForPrompt: async () => false,
      checkIsStarting: () => false,
      closeOrphanQuestionMessage: async () => true,
      notePersonActivity: () => {},
    });
    modules.push(module);
    return module;
  }

  before(async () => {
    harness = await createCommandHarness();
    await harness.state.setAgent(key, { name: adapter.name, claudeSessionId: 'session-held' });
  });

  after(async () => {
    console.log = originalLog;
    await harness.stop();
  });

  afterEach(async () => {
    console.log = originalLog;
    for (const module of modules.splice(0)) module.clearThreadCompaction(key);
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleLatched(key, false);
    adapter.signals = [];
    adapter.isBusy = false;
  });

  /** The state of a topic whose agent finished a turn `idleWindowMs - windowLeftMs` ago, held by `signals`; the timer armed as a re-adopt arms it. */
  async function armHeldTopic(module: ReturnType<typeof createModule>, signals: BackgroundWorkSignal[]): Promise<void> {
    steps = [];
    logs = [];
    adapter.compactions = 0;
    adapter.signals = signals;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
  }

  const heldNotices = (): string[] => harness.replies.map((reply) => reply.text).filter((text) => text === enDict['compactOnIdle.skipped.unconsumedInputNotice']);

  it('a held fire compacts nothing, stops nothing, names the signal in the log and tells the topic once; the re-check never compacts, only stops', async () => {
    const module = createModule();
    harness.replies.length = 0;
    await armHeldTopic(module, [{ kind: 'unconsumedInput', count: 2 }]);

    await waitUntil('the held fire', () => logs.some((line) => line.includes('process kept: working (unconsumed input 2)')));
    assert.ok(logs.some((line) => line.includes('timer fired but the compaction is skipped: working (unconsumed input 2)')), `the log names the signal:\n${logs.join('\n')}`);
    assert.equal(adapter.compactions, 0, 'no compaction: the process is held');
    assert.deepEqual(steps, [], 'no stop: the process is held');
    await waitUntil('the line in the topic', () => heldNotices().length > 0);
    const tracking = harness.state.getCompactIdleTracking(key);
    assert.ok(tracking.lastHeldMarkAt > tracking.lastActivityAt, 'the mark is remembered as held');

    // The re-check, one window later: still held ⇒ looks again, says nothing; released ⇒ the stop, and no late compaction.
    await waitUntil('the re-check', () => logs.filter((line) => line.includes('process kept: working (unconsumed input 2)')).length > 1);
    adapter.signals = [];
    await waitUntil('the stop of the re-check', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 0, 'the re-check never compacts: the cache is cold by then');
    assert.equal(heldNotices().length, 1, 'told once, never on a re-check');
    assert.ok(logs.some((line) => line.includes('the idle mark passed while the process was held')), `the log says why no compaction:\n${logs.join('\n')}`);
  });

  it('a restart between the held fire and its re-check keeps the mark spent: the re-adopt re-arms from the saved instants — no second line, no late compaction, the stop', async () => {
    const module = createModule();
    harness.replies.length = 0;
    await armHeldTopic(module, [{ kind: 'unconsumedInput', count: 1 }]);
    await waitUntil('the held fire', () => heldNotices().length > 0);

    // What a restart leaves: the saved instants (the held mark among them), a process that is free now, and a countdown the
    // re-adopt arms from the saved activity — here with a short remainder, so the fire comes at once (a real one is overdue).
    const { lastHeldMarkAt, lastActivityAt } = harness.state.getCompactIdleTracking(key);
    assert.ok(lastHeldMarkAt > lastActivityAt, 'precondition: the mark was held');
    adapter.signals = [];
    harness.state.noteCompactIdleActivity(key, lastHeldMarkAt - 1);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the stop after the re-adopt', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 0, 'no compaction long after the mark');
    assert.equal(heldNotices().length, 1, 'the line is not posted again');
  });

  it('activity after a held mark opens a new idle period: its mark compacts again', async () => {
    const module = createModule();
    harness.replies.length = 0;
    await armHeldTopic(module, [{ kind: 'unconsumedInput', count: 1 }]);
    await waitUntil('the held fire', () => heldNotices().length > 0);

    adapter.signals = [];
    module.markThreadTurnProducedOutput(key);
    module.noteThreadActivity(key);
    await waitUntil('the compaction of the new idle period', () => adapter.compactions > 0);
    await waitUntil('its stop', () => steps.includes('stop'));
    assert.equal(heldNotices().length, 1, 'nothing more to tell');
    await new Promise((resolve) => setTimeout(resolve, quietMs / 4));
  });

  it('a real turn still running at the mark holds it silently: no line (its end opens a new idle period), but no late compaction either', async () => {
    const module = createModule();
    harness.replies.length = 0;
    adapter.isBusy = true;
    await armHeldTopic(module, []);
    await waitUntil('the held fire', () => logs.some((line) => line.includes('process kept: working (busy turn)')));
    await waitUntil('the mark remembered', () => {
      const tracking = harness.state.getCompactIdleTracking(key);
      return tracking.lastHeldMarkAt > tracking.lastActivityAt;
    });
    await new Promise((resolve) => setTimeout(resolve, quietMs / 4));
    assert.deepEqual(harness.replies.map((reply) => reply.text), [], 'nothing posted for a turn that is merely still running');
    assert.equal(adapter.compactions, 0);
  });

  it('the overdue boot fire (the bot was down past the idle window) never compacts: the idle process is only stopped, and nothing is posted', async () => {
    const module = createModule();
    harness.replies.length = 0;
    steps = [];
    logs = [];
    adapter.compactions = 0;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    module.markThreadTurnProducedOutput(key);
    // The last activity is far past the window: the re-adopt arms an OVERDUE fire (staggered; proportionally short at this window).
    harness.state.noteCompactIdleActivity(key, Date.now() - 10 * idleWindowMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the stop of the overdue fire', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 0, 'no compaction: the cache has been cold since the window ended');
    assert.ok(logs.some((line) => line.includes('the idle mark passed while the bot was down')), `the log says why:\n${logs.join('\n')}`);
    assert.deepEqual(harness.replies.map((reply) => reply.text), [], 'nothing posted: no skip the person would care about');
  });

  it('a held overdue fire is not announced either: the compaction would not have run anyway', async () => {
    const module = createModule();
    harness.replies.length = 0;
    steps = [];
    logs = [];
    adapter.compactions = 0;
    adapter.signals = [{ kind: 'backgroundTasks', count: 1 }];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - 10 * idleWindowMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the held fire', () => logs.some((line) => line.includes('process kept: working (background tasks 1)')));
    const tracking = harness.state.getCompactIdleTracking(key);
    assert.ok(tracking.lastHeldMarkAt <= tracking.lastActivityAt, 'no mark was held: there was no compaction to forgo');
    assert.deepEqual(harness.replies.map((reply) => reply.text), []);
    adapter.signals = [];
    await waitUntil('the stop of the re-check', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 0);
  });

  it('a tracker conversation (no topic to narrate into) is held all the same, silently: the mark is remembered, nothing is posted', async () => {
    const trackerKey: SessionKey = { platform: 'jira', space: 'PROJ', thread: 'PROJ-1' };
    const module = createModule();
    harness.replies.length = 0;
    await harness.state.setAgent(trackerKey, { name: adapter.name, claudeSessionId: 'session-tracker' });
    try {
      steps = [];
      logs = [];
      adapter.signals = [{ kind: 'backgroundTasks', count: 1 }];
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      module.markThreadTurnProducedOutput(trackerKey);
      harness.state.noteCompactIdleActivity(trackerKey, Date.now() - idleWindowMs + windowLeftMs);
      module.rearmThreadIdleTimer(trackerKey);
      await waitUntil('the held fire', () => logs.some((line) => line.includes('nothing to tell the topic')));
      const tracking = harness.state.getCompactIdleTracking(trackerKey);
      assert.ok(tracking.lastHeldMarkAt > tracking.lastActivityAt, 'held');
      assert.deepEqual(harness.replies.map((reply) => reply.text), [], 'nothing posted for a tracker issue');
    } finally {
      module.clearThreadCompaction(trackerKey);
      await harness.state.clearCompactIdleTracking(trackerKey);
    }
  });

  it('a compaction that was not due anyway (the topic turned it off) is not announced as skipped because of the hold', async () => {
    const module = createModule();
    harness.replies.length = 0;
    await harness.state.setCompactOnIdleOverride(key, false);
    try {
      await armHeldTopic(module, [{ kind: 'unconsumedInput', count: 1 }]);
      await waitUntil('the held fire', () => logs.some((line) => line.includes('process kept: working (unconsumed input 1)')));
      await new Promise((resolve) => setTimeout(resolve, quietMs / 4));
      assert.equal(heldNotices().length, 0, 'the hold did not cost the compaction anything');
    } finally {
      await harness.state.setCompactOnIdleOverride(key, true);
    }
  });
});
