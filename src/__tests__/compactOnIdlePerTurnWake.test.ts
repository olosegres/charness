/**
 * @description A SLEEPING per-turn session whose topic only the bot woke (a check, a worker watch) is resumed for its idle compaction
 * and put back to sleep, through the REAL compaction module (`connectors/telegram/commands/compaction.ts`) wired to the command
 * harness (`commandModuleHarness.ts`) and a stub adapter that sleeps between turns the way `claude-per-turn` does (L5, L-D7).
 * The owner's rule (2026-11-22): the compaction comes first, then the sleep — the user-latch (D2) that an earlier idle compaction
 * set, and that only a PERSON's message clears, must not keep the sleeping session from its compaction:
 *
 *   • latched, asleep, a turn since the last compaction ⇒ the countdown is armed, the fire resumes the session, compacts it and
 *     stops it again — the log never says «latched»;
 *   • with nothing new since that compaction no countdown is armed any more: a sleeping per-turn session is never woken for nothing,
 *     so the compactions cannot loop.
 *
 * The decision's own branches (the latch still blocks a backend that is not stopped) are `compactOnIdle.test.ts`'s; the whole thing
 * at process level — the json-stream backend, a scheduler job as the wake — is `compactBeforeSleepE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { claudePerTurnAdapterName } from '../adapters/adapterNames';
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

/** A per-turn conversation: asleep between turns, resumed for a compaction, able to compact and to be stopped. */
class PerTurnStubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = claudePerTurnAdapterName;
  readonly label = 'Stub per-turn';
  isActive = false;
  compactions = 0;

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return this.isActive; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

describe('a sleeping per-turn session woken only by the bot is resumed for its idle compaction, latch or not', () => {
  let harness: CommandHarness;
  const adapter = new PerTurnStubAdapter();
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
      // The per-turn stop after the compaction's own turn: the session sleeps again.
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

  before(async () => {
    harness = await createCommandHarness();
    await harness.state.setAgent(key, { name: adapter.name, claudeSessionId: 'session-per-turn' });
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
    adapter.isActive = false;
    adapter.compactions = 0;
  });

  it('latched by an earlier idle compaction, asleep, a turn since: the fire resumes it, compacts it and stops it again; nothing new afterwards, nothing armed', async () => {
    const module = createModule();
    steps = [];
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    // The earlier idle compaction latched the topic; a bot wake (no person) gave the agent one more turn since.
    await harness.state.setCompactIdleLatched(key, true);
    module.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftMs);
    module.rearmThreadIdleTimer(key);

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
});
