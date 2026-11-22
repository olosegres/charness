/**
 * @description The user-latch (D2) of the idle compaction, through the REAL compaction module
 * (`connectors/telegram/commands/compaction.ts`) wired to the command harness (`commandModuleHarness.ts`) and stub adapters whose
 * lifecycle the test sets. The owner's rule (2026-11-22): the compaction comes first, then the sleep — the latch that an earlier idle
 * compaction set, and that only a PERSON's message clears, must not keep a topic from its compaction where the bot then stops the
 * process. Proven here:
 *
 *   • a SLEEPING per-turn session (`claude-per-turn`: asleep between turns, L5, L-D7) that only the bot woke, latched, with a turn
 *     since the last compaction ⇒ the fire resumes it, compacts it and stops it again — the log never says «latched», and with
 *     nothing new since that compaction no countdown is armed any more, so the compactions cannot loop; the resumed process has not
 *     reported its CLI version yet, and that does not matter: it is asleep only because it was stopped automatically;
 *   • a LIVE suspendable process whose CLI may be stopped automatically (L-D10) ⇒ the latched fire compacts it, then stops it;
 *   • the same process on a CLI too old, or not yet known, to be stopped automatically ⇒ it stays alive, so the latch holds: the fire
 *     compacts nothing and says «latched (D2)».
 *
 * The decision's own branches are `compactOnIdle.test.ts`'s; the whole thing at process level — the json-stream backend, a scheduler
 * job as the wake — is `compactBeforeSleepE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName } from '../adapters/adapterNames';
import type { AgentAdapter, AgentSession, CompactionResult, PendingQuestionState } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test. */
const idleWindowMs = 300;
/** What is left of the window when the timer is armed: the fire comes right away. */
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

/** A suspendable conversation the test puts to sleep or keeps live, able to compact and to be stopped, and saying whether its CLI may be stopped. */
class LifecycleStubAdapter extends EventEmitter implements AgentAdapter {
  readonly label = 'Stub';
  isActive = false;
  /** What the CLI's version says (L-D10): `false` for a version too old or not yet known. */
  isAutoStopSupported = true;
  compactions = 0;

  constructor(readonly name: string) {
    super();
  }

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return this.isActive; }
  checkIsAutoStopSupported(): boolean { return this.isAutoStopSupported; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

describe('the idle compaction and the user-latch, through the compaction module', () => {
  let harness: CommandHarness;
  let adapter = new LifecycleStubAdapter(claudePerTurnAdapterName);
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
      // The stop after the compaction (a per-turn session's own `turnEnded`, the idle fire's stop): the session sleeps again.
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

  /** The topic as a bot-only wake leaves it: latched by an earlier idle compaction, a turn since, the countdown armed as a re-adopt arms it. */
  async function armLatchedTopic(module: ReturnType<typeof createModule>): Promise<void> {
    steps = [];
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    await harness.state.setCompactIdleLatched(key, true);
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);
  }

  before(async () => {
    harness = await createCommandHarness();
    await harness.state.setAgent(key, { name: claudePerTurnAdapterName, claudeSessionId: 'session-lifecycle' });
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
  });

  it('a latched, sleeping per-turn session woken only by the bot: the fire resumes it, compacts it and stops it again; nothing new afterwards, nothing armed', async () => {
    adapter = new LifecycleStubAdapter(claudePerTurnAdapterName);
    // The resumed process has not told its CLI version yet: the exemption does not ask it.
    adapter.isAutoStopSupported = false;
    const module = createModule();
    await armLatchedTopic(module);

    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.deepEqual(steps, ['resume', 'stop'], 'resumed for the compaction, then put back to sleep');
    assert.equal(adapter.compactions, 1, 'the conversation was compacted before the sleep');
    assert.ok(!logs.some((line) => line.includes('latched')), `the fire never took the latch for a reason to skip:\n${logs.join('\n')}`);

    // The compaction closed the guard (`lastCompactionAt` is the newest instant): a sleeping session with nothing new is not woken again.
    module.rearmThreadIdleTimer(key);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    assert.deepEqual(steps, ['resume', 'stop'], 'no second wake-up for nothing: the compactions cannot loop');
    assert.equal(adapter.compactions, 1);
  });

  it('a latched, live process whose CLI may be stopped automatically: the fire compacts it, then stops it', async () => {
    adapter = new LifecycleStubAdapter(claudeJsonStreamAdapterName);
    adapter.isActive = true;
    const module = createModule();
    await armLatchedTopic(module);

    await waitUntil('the compaction and the stop', () => steps.includes('stop'));
    assert.deepEqual(steps, ['stop'], 'the live process is not resumed, only stopped');
    assert.equal(adapter.compactions, 1, 'the conversation was compacted before the sleep');
    assert.ok(!logs.some((line) => line.includes('latched')), `the latch held nothing back:\n${logs.join('\n')}`);
  });

  it('a latched, live process whose CLI is too old (or not yet known) to be stopped automatically stays alive, so the latch holds: nothing is compacted', async () => {
    adapter = new LifecycleStubAdapter(claudeJsonStreamAdapterName);
    adapter.isActive = true;
    adapter.isAutoStopSupported = false;
    const module = createModule();
    await armLatchedTopic(module);

    await waitUntil('the skipped fire', () => logs.some((line) => line.includes('timer fired but the compaction is skipped: latched (D2)')));
    assert.equal(adapter.compactions, 0, 'no second idle compaction for a process that is not stopped: one per active period');
  });
});
