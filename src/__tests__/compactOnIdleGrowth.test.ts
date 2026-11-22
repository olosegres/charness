/**
 * @description The idle compaction's GROWTH gate, through the REAL compaction module (`connectors/telegram/commands/compaction.ts`)
 * wired to the command harness (`commandModuleHarness.ts`) and stub adapters whose context size and lifecycle the test sets. The
 * owner's rule (2026-11-22): an idle compaction runs only when the conversation's context grew by a threshold (30 000 tokens by
 * default) over its size at the FIRST turn after the last compaction; otherwise the topic just sleeps. Proven here:
 *
 *   • the context size is read when a json-stream turn ends and recorded as the baseline on the first reading — and as the figure
 *     the growth is measured up to on every later one; a smaller reading moves the baseline down; the compaction's own turn is
 *     never read, and a reading that a compaction overtook while the backend answered is dropped (it describes the context of before);
 *   • a backend that signals no turn end (OpenCode, the tmux Claude) is read once its output has settled;
 *   • a compaction drops both figures, so the next turn starts the baseline over — the compaction's own `post=` figure is never it;
 *   • the fire compacts a conversation that grew enough and only sleeps one that did not (the stop follows either way, nothing is
 *     posted); a conversation with no reading is not held back (the baseline's survival of a restart is `state.test.ts`'s);
 *   • a SLEEPING per-turn session woken only by the bot is resumed for its compaction only when the growth is there, and no
 *     countdown is armed once that compaction closed the guard.
 *
 * The decision's own branches are `compactOnIdle.test.ts`'s; the whole thing at process level — the json-stream backend, a scheduler
 * job as the wake, three idle periods — is `compactBeforeSleepE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName, openCodeAdapterName } from '../adapters/adapterNames';
import type { AgentAdapter, AgentRuntimeInfo, AgentSession, CompactionResult, PendingQuestionState } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { contextSampleDebounceMs, defaultCompactGrowthTokens } from '../utils/compactOnIdle';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test. */
const idleWindowMs = 300;
/** What is left of the window when the timer is armed: the fire comes right away. */
const windowLeftMs = 20;
/** How long the test lets the module sit after a fire it expects to do nothing more, several windows' worth. */
const quietMs = 3 * idleWindowMs;
/** The slow backend's answer in the overtaken-reading test: longer than the compaction stamp takes. */
const slowReadingMs = 150;

const baselineTokens = 41_000;
const grownTokens = baselineTokens + defaultCompactGrowthTokens;

const key: SessionKey = { platform: 'telegram', space: harnessGroup.id.toString(), thread: harnessThreadId.toString() };

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** A suspendable conversation the test puts to sleep or keeps live, whose runtime info says what the test set. */
class GrowthStubAdapter extends EventEmitter implements AgentAdapter {
  readonly label = 'Stub';
  isActive = true;
  compactions = 0;
  /** What `getRuntimeInfo` reports as the context size; `null`: the backend cannot say. */
  contextTokens: number | null = null;
  /** How long `getRuntimeInfo` takes to answer. */
  readingDelayMs = 0;

  constructor(readonly name: string) {
    super();
  }

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return this.isActive; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const contextUsedTokens = this.contextTokens;
    if (this.readingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readingDelayMs));
    return { version: null, model: null, contextWindowTokens: null, contextUsedTokens };
  }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

describe('the idle compaction waits for the context to grow, through the compaction module', () => {
  let harness: CommandHarness;
  let adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
  let steps: string[] = [];
  let logs: string[] = [];
  const modules: Array<ReturnType<typeof createCompaction>> = [];
  const pendingQuestions = new Map<string, PendingQuestionState>();
  const originalLog = console.log;

  function createModule(): ReturnType<typeof createCompaction> {
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
      // The stop after the fire (and a per-turn session's own `turnEnded` stop): the session sleeps.
      suspendThreadSession: async () => {
        steps.push('stop');
        adapter.isActive = false;
      },
      resumeSleepingSessionForCompaction: async () => {
        steps.push('resume');
        adapter.isActive = true;
        return true;
      },
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

  const getTracking = () => harness.state.getCompactIdleTracking(key);
  const getFigures = () => [getTracking().baselineContextTokens, getTracking().lastContextTokens];

  /** The topic after a turn that ended with `contextTokens` in the context: a turn since the last compaction, the countdown armed as a re-adopt arms it. */
  function armTopicAfterTurn(module: ReturnType<typeof createModule>, figures: { baseline: number; last: number } | null): void {
    steps = [];
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    module.markThreadTurnProducedOutput(key);
    if (figures) {
      harness.state.noteCompactIdleContext(key, figures.baseline);
      harness.state.noteCompactIdleContext(key, figures.last);
    }
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
  }

  before(async () => {
    harness = await createCommandHarness();
    await harness.state.setAgent(key, { name: claudeJsonStreamAdapterName, claudeSessionId: 'session-growth' });
  });

  after(async () => {
    console.log = originalLog;
    await harness.stop();
  });

  afterEach(async () => {
    console.log = originalLog;
    for (const module of modules.splice(0)) module.clearThreadCompaction(key);
    await harness.state.clearCompactIdleTracking(key);
  });

  it('a json-stream turn that ends is read: the first reading is the baseline and the newest figure, a larger one moves only the newest, a smaller one moves the baseline down', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();

    adapter.contextTokens = baselineTokens;
    module.noteThreadTurnContext(key);
    await waitUntil('the first reading', () => getTracking().lastContextTokens === baselineTokens);
    assert.deepEqual(getFigures(), [baselineTokens, baselineTokens], 'the first turn is the baseline');

    adapter.contextTokens = grownTokens;
    module.noteThreadTurnContext(key);
    await waitUntil('the second reading', () => getTracking().lastContextTokens === grownTokens);
    assert.deepEqual(getFigures(), [baselineTokens, grownTokens], 'growth moves the newest figure only');

    adapter.contextTokens = 20_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the smaller reading', () => getTracking().lastContextTokens === 20_000);
    assert.deepEqual(getFigures(), [20_000, 20_000], 'a context below the baseline: the CLI compacted by itself, growth counts from the new size');
  });

  it('a backend that cannot say (no context size, or no runtime info at all) leaves the figures absent', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null]);
    const withoutRuntimeInfo = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    Object.assign(withoutRuntimeInfo, { getRuntimeInfo: undefined });
    adapter = withoutRuntimeInfo;
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null]);
  });

  it('the compaction\'s own turn is never read, and a reading a compaction overtook while the backend answered is dropped', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    adapter.contextTokens = baselineTokens;

    module.threadsCompacting.add(keyToString(key));
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'a compaction in flight: its turn is no turn of the conversation');
    module.threadsCompacting.delete(keyToString(key));

    // The backend is slow to answer; a compaction stamps itself meanwhile: the figure it brings is the context of BEFORE it.
    adapter.readingDelayMs = slowReadingMs;
    module.noteThreadTurnContext(key);
    await harness.state.setCompactIdleCompactedAt(key);
    await new Promise((resolve) => setTimeout(resolve, slowReadingMs + 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'the overtaken reading did not become the new baseline');

    adapter.readingDelayMs = 0;
    adapter.contextTokens = 52_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the first reading after the compaction', () => getTracking().lastContextTokens === 52_000);
    assert.equal(getTracking().baselineContextTokens, 52_000, 'the first turn after the compaction is the baseline, instructions and skills reloaded');
  });

  it('a backend that signals no turn end is read once its output has settled — not for every chunk', async () => {
    adapter = new GrowthStubAdapter(openCodeAdapterName);
    adapter.contextTokens = baselineTokens;
    const module = createModule();
    module.markThreadTurnProducedOutput(key);
    await new Promise((resolve) => setTimeout(resolve, contextSampleDebounceMs / 2));
    module.markThreadTurnProducedOutput(key);
    await new Promise((resolve) => setTimeout(resolve, contextSampleDebounceMs / 2 + 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'the second chunk moved the read back: nothing yet');
    await waitUntil('the settled read', () => getTracking().lastContextTokens === baselineTokens);
    assert.deepEqual(getFigures(), [baselineTokens, baselineTokens]);
  });

  it('the fire compacts a conversation that grew by the threshold since its baseline, then stops it', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens });

    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 1, 'compacted before the sleep');
    assert.equal(getTracking().baselineContextTokens, null, 'the compaction dropped the baseline: the next turn that ends starts it over');
    assert.equal(getTracking().lastContextTokens, null);
  });

  it('the fire only stops a conversation that grew less than the threshold — nothing compacted, one line in the log saying why, nothing posted, the figures kept for the next idle mark', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    harness.replies.length = 0;
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens - 1 });

    await waitUntil('the stop', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 0, 'a context that did not grow enough is not compacted');
    assert.ok(logs.some((line) => line.includes('timer fired but the compaction is skipped: the context grew by')), `the log says why:\n${logs.join('\n')}`);
    assert.ok(harness.replies.every((reply) => !reply.text.startsWith('🧹')), 'nothing is posted to the topic');
    assert.deepEqual(getFigures(), [baselineTokens, grownTokens - 1], 'the figures are kept for the next idle mark');
  });

  it('a conversation with no reading (a backend that cannot say, a state saved before the figures were kept) is not held back', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    armTopicAfterTurn(module, null);

    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 1);
  });

  it('a topic woken only by the bot (no person) is compacted again before it sleeps once it grew by the threshold since its first turn after the last compaction — not for a smaller wake', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    // First period: it grew, it is compacted and sleeps.
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens });
    await waitUntil('the first compaction', () => adapter.compactions === 1);
    await waitUntil('the stop', () => steps.includes('stop'));

    // A bot wake (no person) gives it a turn that grows the context a little: the first turn after the compaction is the baseline.
    adapter.isActive = true;
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleContext(key, 52_000);
    harness.state.noteCompactIdleContext(key, 52_000 + defaultCompactGrowthTokens / 2);
    steps = [];
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the second stop', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 1, 'half the threshold: no second compaction, the topic just sleeps');

    // Another wake grows it past the threshold: compacted before the sleep.
    adapter.isActive = true;
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleContext(key, 52_000 + defaultCompactGrowthTokens);
    steps = [];
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the third stop', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 2, 'grown by the threshold since the first turn after the last compaction: compacted again');
  });

  it('a sleeping per-turn session woken only by the bot is resumed for its compaction only when the context grew enough — and nothing is armed after the compaction', async () => {
    adapter = new GrowthStubAdapter(claudePerTurnAdapterName);
    adapter.isActive = false;
    const module = createModule();

    // Not grown enough: no countdown for a sleeping session, nobody is woken for nothing.
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens - 1 });
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, [], 'not woken');
    assert.equal(adapter.compactions, 0);

    // Grown enough: the fire resumes it, compacts it and stops it again.
    harness.state.noteCompactIdleContext(key, grownTokens);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.deepEqual(steps, ['resume', 'stop'], 'resumed for the compaction, then put back to sleep');
    assert.equal(adapter.compactions, 1);

    // The compaction closed the guard: a sleeping session with nothing new is not woken again.
    module.rearmThreadIdleTimer(key);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, ['resume', 'stop'], 'no second wake-up for nothing: the compactions cannot loop');
    assert.equal(adapter.compactions, 1);
  });
});
