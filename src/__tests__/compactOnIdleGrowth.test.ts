/**
 * @description The idle compaction's GROWTH gate, through the REAL compaction module (`connectors/telegram/commands/compaction.ts`)
 * wired to the command harness (`commandModuleHarness.ts`) and stub adapters whose context sizes and lifecycle the test sets. The
 * owner's rule (2026-11-22): an idle compaction runs only when the conversation's context grew by a threshold (30 000 tokens by
 * default) over what it weighed with everything loaded — the context of the FIRST model call after the last compaction (the summary,
 * the instructions, the skills, the prompt) — otherwise the topic just sleeps. Proven here:
 *
 *   • when a json-stream turn ends, the context after it is recorded (the figure growth is measured up to) and, while there is no
 *     baseline, the first call of the epoch is read from the conversation's history: a first turn that read half a repository does
 *     not hide its own growth in the baseline; a history that cannot be read leaves NO baseline, never the turn's end in its place;
 *   • a baseline that is there is not read again; a smaller context drops it (the CLI compacted by itself) to be read from the new
 *     epoch; the compaction's own turn is never read, and a reading a compaction overtook while the backend answered is dropped;
 *   • a backend that signals no turn end (OpenCode, the tmux Claude) is read once its output has settled;
 *   • the fire compacts a conversation that grew enough and only sleeps one that did not (the stop follows either way, nothing is
 *     posted); a conversation never compacted with no reading is not held back, one that WAS compacted is — a tmux-style topic whose
 *     compaction raises no signal and whose own output re-arms the countdown is compacted once, not at every idle mark;
 *   • a SLEEPING per-turn session woken only by the bot is resumed for its compaction only when the growth is there, and no
 *     countdown is armed once that compaction closed the guard.
 *
 * The decision's own branches are `compactOnIdle.test.ts`'s; the whole thing at process level — the json-stream backend, a scheduler
 * job as the wake, three idle periods, a first turn whose first and last calls differ — is `compactBeforeSleepE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName, openCodeAdapterName } from '../adapters/adapterNames';
import type { AgentAdapter, AgentSession, CompactionResult, PendingQuestionState } from '../types';
import type { ThreadContextReading } from '../connectors/telegram/commands/compaction';
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

/** How long ago the earlier compaction of a test's topic was: the turn after it, stamped now, is a turn since. */
const compactedAgoMs = 5_000;

/** What the first call of an epoch saw, what the conversation weighs once it grew by the threshold, and a first turn's big task. */
const baselineTokens = 41_000;
const grownTokens = baselineTokens + defaultCompactGrowthTokens;
const bigFirstTurnEndTokens = 120_000;

const key: SessionKey = { platform: 'telegram', space: harnessGroup.id.toString(), thread: harnessThreadId.toString() };

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** A conversation the test puts to sleep or keeps live; what it holds in its context, and in the history of its epoch, is what the test set. */
class GrowthStubAdapter extends EventEmitter implements AgentAdapter {
  readonly label = 'Stub';
  isActive = true;
  compactions = 0;
  /** The context after the newest model call; `null`: the backend cannot say. */
  contextTokens: number | null = null;
  /** What the epoch's first call saw, as the conversation's history tells; `null`: the history cannot be read. */
  firstCallTokens: number | null = null;
  firstCallReads = 0;
  /** `getOwnCompactionCount`: the compactions the CLI or the server started that completed in this session. */
  ownCompactions = 0;
  /** How long the reads take to answer. */
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
  getOwnCompactionCount(): number { return this.ownCompactions; }
  async getContextUsedTokens(): Promise<number | null> {
    const contextTokens = this.contextTokens;
    if (this.readingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readingDelayMs));
    return contextTokens;
  }
  async getFirstCallContextTokens(): Promise<number | null> {
    this.firstCallReads += 1;
    const firstCallTokens = this.firstCallTokens;
    if (this.readingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readingDelayMs));
    return firstCallTokens;
  }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

/** A tmux-style conversation: it never stops, has no compaction of its own to call — `/compact` is typed into its TUI — and can tell no context size. */
class TmuxStyleStubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude';
  readonly label = 'Stub tmux';

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  checkIsActive(): boolean { return true; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
}

describe('the idle compaction waits for the context to grow, through the compaction module', () => {
  let harness: CommandHarness;
  let adapter: AgentAdapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
  let steps: string[] = [];
  let logs: string[] = [];
  let forwardedPrompts: string[] = [];
  /** What the bot reads of a STOPPED session's transcript by its persisted session (`readSleepingContext`); `null`: nothing readable. */
  let sleepingReading: ThreadContextReading | null = null;
  let sleepingReads = 0;
  const readSleepingContext = (isBaselineNeeded: boolean): ThreadContextReading | null => {
    sleepingReads += 1;
    return sleepingReading === null ? null : { lastContextTokens: sleepingReading.lastContextTokens, firstCallContextTokens: isBaselineNeeded ? sleepingReading.firstCallContextTokens : null };
  };
  const modules: Array<ReturnType<typeof createCompaction>> = [];
  const pendingQuestions = new Map<string, PendingQuestionState>();
  const originalLog = console.log;

  function createModule(): ReturnType<typeof createCompaction> {
    const module = createCompaction({
      ...harness.core,
      compactSelfReviewFlagDirs: harness.compactSelfReviewFlagDirs,
      startTypingLoader: () => {},
      forwardPromptToAgent: async (_key, _adapter, text) => { forwardedPrompts.push(text); },
      pendingQuestions,
      clearPendingQuestion: (clearedKey) => { pendingQuestions.delete(keyToString(clearedKey)); },
      closeQuestionMessage: async () => true,
      setQuestionAsideAtIdle: async () => false,
      idleWindowMs,
      checkIsLimitWaitArmed: () => false,
      // The stop after the fire (and a per-turn session's own `turnEnded` stop): the session sleeps.
      suspendThreadSession: async () => {
        steps.push('stop');
        if (adapter instanceof GrowthStubAdapter) adapter.isActive = false;
      },
      readSleepingContext: async (_key, isBaselineNeeded) => readSleepingContext(isBaselineNeeded),
      resumeSleepingSessionForCompaction: async () => {
        steps.push('resume');
        if (adapter instanceof GrowthStubAdapter) adapter.isActive = true;
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
  const growthAdapter = (): GrowthStubAdapter => {
    if (!(adapter instanceof GrowthStubAdapter)) throw new Error('the adapter under test is not the growth stub');
    return adapter;
  };

  /** The saved figures of a conversation whose baseline is `baseline` and whose context is `last` now. */
  function noteFigures(baseline: number, last: number): void {
    harness.state.noteCompactIdleContext(key, { lastContextTokens: baseline, firstCallContextTokens: baseline });
    harness.state.noteCompactIdleContext(key, { lastContextTokens: last, firstCallContextTokens: null });
  }

  /** The topic after a turn that ended: a turn since the last compaction, the countdown armed as a re-adopt arms it. */
  function armTopicAfterTurn(module: ReturnType<typeof createModule>, figures: { baseline: number; last: number } | null): void {
    steps = [];
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    module.markThreadTurnProducedOutput(key);
    if (figures) noteFigures(figures.baseline, figures.last);
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
    forwardedPrompts = [];
    sleepingReading = null;
    sleepingReads = 0;
  });

  it('a turn that ends is read: the baseline is the epoch\'s FIRST call though the turn ended far above it; a baseline that is there is not read again', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const stub = growthAdapter();
    const module = createModule();

    // The first turn after a compaction read half a repository: it ended at 120 000, its first call saw 41 000.
    stub.contextTokens = bigFirstTurnEndTokens;
    stub.firstCallTokens = baselineTokens;
    module.noteThreadTurnContext(key);
    await waitUntil('the first reading', () => getTracking().lastContextTokens === bigFirstTurnEndTokens);
    assert.deepEqual(getFigures(), [baselineTokens, bigFirstTurnEndTokens], 'the baseline is what the first call saw, not where the turn ended');
    assert.equal(stub.firstCallReads, 1);

    stub.contextTokens = bigFirstTurnEndTokens + 5_000;
    stub.firstCallTokens = 99_999;
    module.noteThreadTurnContext(key);
    await waitUntil('the second reading', () => getTracking().lastContextTokens === bigFirstTurnEndTokens + 5_000);
    assert.deepEqual(getFigures(), [baselineTokens, bigFirstTurnEndTokens + 5_000], 'growth moves the newest figure only');
    assert.equal(stub.firstCallReads, 1, 'the history is read only while there is no baseline');
  });

  it('a history that cannot be read leaves NO baseline — never the turn\'s end in its place — until a later turn\'s end reads it; a smaller context drops the baseline to be read from the new epoch', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const stub = growthAdapter();
    const module = createModule();

    stub.contextTokens = bigFirstTurnEndTokens;
    stub.firstCallTokens = null;
    module.noteThreadTurnContext(key);
    await waitUntil('the reading', () => getTracking().lastContextTokens === bigFirstTurnEndTokens);
    assert.deepEqual(getFigures(), [null, bigFirstTurnEndTokens]);

    stub.contextTokens = bigFirstTurnEndTokens + 1_000;
    stub.firstCallTokens = baselineTokens;
    module.noteThreadTurnContext(key);
    await waitUntil('the later reading', () => getTracking().baselineContextTokens === baselineTokens);
    assert.deepEqual(getFigures(), [baselineTokens, bigFirstTurnEndTokens + 1_000]);

    // The CLI compacted by itself: the context is far below the baseline, which belonged to the older epoch.
    stub.contextTokens = 20_000;
    stub.firstCallTokens = null;
    module.noteThreadTurnContext(key);
    await waitUntil('the shrunk reading', () => getTracking().lastContextTokens === 20_000);
    assert.deepEqual(getFigures(), [null, 20_000]);
    stub.contextTokens = 61_000;
    stub.firstCallTokens = 18_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the new epoch\'s baseline', () => getTracking().baselineContextTokens === 18_000);
    assert.deepEqual(getFigures(), [18_000, 61_000]);
  });

  it('a backend that cannot say (no figure of the context, or no such method at all) leaves the figures absent', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null]);
    adapter = new TmuxStyleStubAdapter();
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null]);
  });

  it('the compaction\'s own turn is never read, and a reading a compaction overtook while the backend answered is dropped', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const stub = growthAdapter();
    const module = createModule();
    stub.contextTokens = bigFirstTurnEndTokens;
    stub.firstCallTokens = baselineTokens;

    module.threadsCompacting.add(keyToString(key));
    module.noteThreadTurnContext(key);
    await new Promise((resolve) => setTimeout(resolve, 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'a compaction in flight: its turn is no turn of the conversation');
    module.threadsCompacting.delete(keyToString(key));

    // The backend is slow to answer; a compaction stamps itself meanwhile: what it brings is the context of BEFORE it.
    stub.readingDelayMs = slowReadingMs;
    module.noteThreadTurnContext(key);
    await harness.state.setCompactIdleCompactedAt(key);
    await new Promise((resolve) => setTimeout(resolve, slowReadingMs + 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'the overtaken reading did not become the new baseline');

    stub.readingDelayMs = 0;
    stub.contextTokens = 52_000;
    stub.firstCallTokens = 24_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the first reading after the compaction', () => getTracking().lastContextTokens === 52_000);
    assert.equal(getTracking().baselineContextTokens, 24_000, 'the first call after the compaction, instructions and skills reloaded');
  });

  it('a backend that signals no turn end is read once its output has settled — not for every chunk', async () => {
    adapter = new GrowthStubAdapter(openCodeAdapterName);
    const stub = growthAdapter();
    stub.contextTokens = baselineTokens + 9_000;
    stub.firstCallTokens = baselineTokens;
    const module = createModule();
    module.markThreadTurnProducedOutput(key);
    await new Promise((resolve) => setTimeout(resolve, contextSampleDebounceMs / 2));
    module.markThreadTurnProducedOutput(key);
    await new Promise((resolve) => setTimeout(resolve, contextSampleDebounceMs / 2 + 3 * waitStepMs));
    assert.deepEqual(getFigures(), [null, null], 'the second chunk moved the read back: nothing yet');
    await waitUntil('the settled read', () => getTracking().lastContextTokens === baselineTokens + 9_000);
    assert.deepEqual(getFigures(), [baselineTokens, baselineTokens + 9_000]);
  });

  it('the fire compacts a conversation that grew by the threshold since its baseline — also when its FIRST turn did all the growing — then stops it', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    // The owner leaves after one big task: the baseline is its first call (41 000), the turn ended at 120 000.
    armTopicAfterTurn(module, { baseline: baselineTokens, last: bigFirstTurnEndTokens });

    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 1, 'compacted before the sleep');
    assert.equal(getTracking().baselineContextTokens, null, 'the compaction dropped the baseline: the next turn that ends reads it again');
    assert.equal(getTracking().lastContextTokens, null);
  });

  it('the fire only stops a conversation that grew less than the threshold — nothing compacted, one line in the log saying why, nothing posted, the figures kept for the next idle mark', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    harness.replies.length = 0;
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens - 1 });

    await waitUntil('the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 0, 'a context that did not grow enough is not compacted');
    assert.ok(logs.some((line) => line.includes('timer fired but the compaction is skipped: the context grew by')), `the log says why:\n${logs.join('\n')}`);
    assert.ok(harness.replies.every((reply) => !reply.text.startsWith('🧹')), 'nothing is posted to the topic');
    assert.deepEqual(getFigures(), [baselineTokens, grownTokens - 1], 'the figures are kept for the next idle mark');
  });

  it('a conversation never compacted with no reading is not held back; one that WAS compacted and has no reading yet is — nothing is known to have grown', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    armTopicAfterTurn(module, null);
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 1, 'never compacted: nothing to measure from yet');

    // Compacted just now (the figures were dropped), a turn since — but its history is not readable yet.
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    armTopicAfterTurn(module, null);
    await waitUntil('the second stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 0, 'compacted before and unknown: only the stop');
    assert.ok(logs.some((line) => line.includes('the context size since the last compaction is not known yet')), `the log says why:\n${logs.join('\n')}`);
  });

  it('a tmux-style topic — its compaction typed into the TUI, its own output re-arming the countdown, no context figure to tell — is compacted ONCE, not at every idle mark with nobody writing', async () => {
    adapter = new TmuxStyleStubAdapter();
    const module = createModule();
    armTopicAfterTurn(module, null);
    await waitUntil('the first compaction', () => forwardedPrompts.some((text) => text.startsWith('/compact')));
    assert.equal(forwardedPrompts.length, 1, 'never compacted: the first idle mark compacts');

    // The TUI's compaction output reaches the bot after the forward returned: it counts as a turn and re-arms the countdown.
    steps = [];
    logs = [];
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.noteThreadActivity(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the second fire', () => logs.some((line) => line.includes('timer fired but the compaction is skipped')));
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.equal(forwardedPrompts.length, 1, 'no second compaction: it was compacted before and nothing is known to have grown');
  });

  it('a topic woken only by the bot (no person) is compacted again before it sleeps once it grew by the threshold since its first call after the last compaction — not for a smaller wake', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    // First period: it grew, it is compacted and sleeps.
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens });
    await waitUntil('the first compaction', () => growthAdapter().compactions === 1);
    await waitUntil('the stop', () => steps.includes('stop'));

    // A bot wake (no person): the first turn after the compaction reads its first call (52 000) and ends a little higher.
    growthAdapter().isActive = true;
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleContext(key, { lastContextTokens: 52_000 + defaultCompactGrowthTokens / 2, firstCallContextTokens: 52_000 });
    steps = [];
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the second stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 1, 'half the threshold: no second compaction, the topic just sleeps');

    // Another wake grows it past the threshold: compacted before the sleep.
    growthAdapter().isActive = true;
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleContext(key, { lastContextTokens: 52_000 + defaultCompactGrowthTokens, firstCallContextTokens: null });
    steps = [];
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the third stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 2, 'grown by the threshold since the first call after the last compaction: compacted again');
  });

  it('the deploy: a topic compacted before and idle with NO figures yet (a state kept before they existed) is measured at its mark — compacted when its context grew, only stopped when it did not', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    // Compacted once, a turn since, and the bot has never read the context of this conversation: the tracking holds no figures.
    await harness.state.setCompactIdleCompactedAt(key, Date.now() - compactedAgoMs);
    assert.deepEqual(getFigures(), [null, null], 'precondition: no figures');
    growthAdapter().contextTokens = grownTokens + 20_000;
    growthAdapter().firstCallTokens = baselineTokens;
    armTopicAfterTurn(module, null);
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 1, 'the context grew by far more than the threshold since its first call: compacted before the sleep');
    assert.equal(growthAdapter().firstCallReads, 1, 'the baseline was read from the history at the mark');

    // The same topic, the same state, but its transcript says it did not grow: nothing is compacted, the process is only stopped.
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleCompactedAt(key, Date.now() - compactedAgoMs);
    growthAdapter().contextTokens = baselineTokens + 5_000;
    growthAdapter().firstCallTokens = baselineTokens;
    armTopicAfterTurn(module, null);
    await waitUntil('the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 0, 'it did not grow: only the stop');
    assert.ok(logs.some((line) => line.includes('the context grew by')), `the log says by how much:\n${logs.join('\n')}`);
  });

  it('a turn\'s reading that was lost (a restart between its end and its read) leaves a STALE figure: the mark measures again — a context that grew since is compacted', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const module = createModule();
    // The figures the bot has are the last read turn's; the turn after it ended unread, and the context is far above them.
    harness.replies.length = 0;
    growthAdapter().contextTokens = grownTokens + 10_000;
    growthAdapter().firstCallTokens = baselineTokens;
    armTopicAfterTurn(module, { baseline: baselineTokens, last: baselineTokens + 1_000 });
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.equal(growthAdapter().compactions, 1);
    assert.equal(growthAdapter().firstCallReads, 0, 'the baseline was there: only the context now was read');
  });

  it('the deploy for a SLEEPING per-turn session: measured from its transcript by the persisted session — resumed for its compaction only when it grew, and never woken when it did not or cannot be read', async () => {
    adapter = new GrowthStubAdapter(claudePerTurnAdapterName);
    growthAdapter().isActive = false;
    const module = createModule();
    await harness.state.setCompactIdleCompactedAt(key, Date.now() - compactedAgoMs);

    // It did not grow: no wake-up for nothing.
    sleepingReading = { lastContextTokens: baselineTokens + 5_000, firstCallContextTokens: baselineTokens };
    armTopicAfterTurn(module, null);
    await waitUntil('the measure at the mark', () => sleepingReads === 1);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, [], 'not woken');
    assert.equal(growthAdapter().compactions, 0);
    assert.deepEqual(getFigures(), [baselineTokens, baselineTokens + 5_000], 'the figures are saved for the next mark');

    // Nothing readable: not woken either (it would be for nothing).
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleCompactedAt(key, Date.now() - compactedAgoMs);
    sleepingReading = null;
    sleepingReads = 0;
    armTopicAfterTurn(module, null);
    await waitUntil('the second measure', () => sleepingReads === 1);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, [], 'unreadable: not woken');

    // It grew: the fire resumes it, compacts it and stops it again.
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleCompactedAt(key, Date.now() - compactedAgoMs);
    sleepingReading = { lastContextTokens: grownTokens + 20_000, firstCallContextTokens: baselineTokens };
    armTopicAfterTurn(module, null);
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.deepEqual(steps, ['resume', 'stop'], 'resumed for the compaction, then put back to sleep');
    assert.equal(growthAdapter().compactions, 1);
  });

  it('a compaction the CLI or the server started replaces the epoch: the baseline becomes the NEW epoch\'s first call even though the context is not smaller than the old baseline', async () => {
    adapter = new GrowthStubAdapter(claudeJsonStreamAdapterName);
    const stub = growthAdapter();
    const module = createModule();

    // The conversation's first call saw 20 000; the first turn ended at 24 000.
    stub.contextTokens = 24_000;
    stub.firstCallTokens = 20_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the first reading', () => getTracking().lastContextTokens === 24_000);
    assert.deepEqual(getFigures(), [20_000, 24_000]);

    // The CLI's own overflow compaction: the new epoch's first call saw 45 000 — NOT below the old baseline, so no shrink shows it.
    stub.ownCompactions = 1;
    stub.contextTokens = 52_000;
    stub.firstCallTokens = 45_000;
    module.noteThreadTurnContext(key);
    await waitUntil('the reading after the CLI\'s compaction', () => getTracking().lastContextTokens === 52_000);
    assert.deepEqual(getFigures(), [45_000, 52_000], 'measured from the new epoch: growth is 7 000, not 32 000');

    // A later turn, no compaction since: the baseline stays and is not read again.
    stub.contextTokens = 60_000;
    stub.firstCallTokens = 99_999;
    const readsBefore = stub.firstCallReads;
    module.noteThreadTurnContext(key);
    await waitUntil('the later reading', () => getTracking().lastContextTokens === 60_000);
    assert.deepEqual(getFigures(), [45_000, 60_000]);
    assert.equal(stub.firstCallReads, readsBefore, 'the history is not read again');
  });

  it('a sleeping per-turn session woken only by the bot, once measured, is compacted again only when the context grew enough — and nothing is left to wake it after the compaction', async () => {
    adapter = new GrowthStubAdapter(claudePerTurnAdapterName);
    growthAdapter().isActive = false;
    const module = createModule();

    // Not grown enough: the mark measures, nobody is woken for nothing.
    armTopicAfterTurn(module, { baseline: baselineTokens, last: grownTokens - 1 });
    sleepingReading = { lastContextTokens: grownTokens - 1, firstCallContextTokens: null };
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, [], 'not woken');
    assert.equal(growthAdapter().compactions, 0);

    // Grown enough: the fire resumes it, compacts it and stops it again.
    sleepingReading = { lastContextTokens: grownTokens, firstCallContextTokens: null };
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.deepEqual(steps, ['resume', 'stop'], 'resumed for the compaction, then put back to sleep');
    assert.equal(growthAdapter().compactions, 1);

    // The compaction closed the guard (a turn since it is needed): a sleeping session with nothing new is not woken again.
    module.rearmThreadIdleTimer(key);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, ['resume', 'stop'], 'no second wake-up for nothing: the compactions cannot loop');
    assert.equal(growthAdapter().compactions, 1);
  });
});
