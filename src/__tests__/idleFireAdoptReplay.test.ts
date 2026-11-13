/**
 * @description The idle fire of a topic whose session was ADOPTED at this boot, through the REAL compaction module
 * (`connectors/telegram/commands/compaction.ts`) wired to the command harness (`commandModuleHarness.ts`) and a stub
 * adapter whose replay the test holds and lets go. An adopted session is read only once the boot has restored its state,
 * and only the replay of what it wrote while the bot was down rebuilds its live state. Its idle timer is armed at the adopt
 * from the persisted activity, so it can fire before that: the fire then judged the process on the state the restart left,
 * wrote a compaction to it, and its stop read the downtime replay ahead of the boot's restore step (a replayed usage-limit
 * error handled as a live one). Proven here:
 *
 *   • a fire that comes while the replay is pending neither compacts nor stops until the replay is done — then it does both;
 *   • a fire whose wait ends with the countdown armed again (the replay brought output) gives way: no compaction, no stop.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import type { AgentAdapter, AgentSession, CompactionResult, PendingQuestionState } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { createCommandHarness, harnessGroup, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test: long, so a countdown armed again does not fire within a test. */
const idleWindowMs = 10_000;
/** What is left of the window when the timer is armed at the adopt: the fire comes while the replay is held. */
const windowLeftAtAdoptMs = 20;
/** How long the test lets a fire that waits stay waiting before it looks: several windows' worth of the short remainder. */
const heldWaitMs = 200;

const key: SessionKey = { platform: 'telegram', space: harnessGroup.id.toString(), thread: harnessThreadId.toString() };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** The adopted conversation as the idle fire sees it: live, not working, able to compact and to be stopped — and its replay held. */
class AdoptedStubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'stub-adopted-adapter';
  readonly label = 'Stub';
  /** While set, the session is adopted and not replayed yet; {@link finishReplay} lets it go. */
  replay: Deferred | null = null;
  /** How often something asked whether the replay is pending — the fire's look. */
  replayLooks = 0;
  compactions = 0;

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return true; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  rejectQuestion(): void {}
  checkIsAdoptReplayPending(): boolean {
    this.replayLooks += 1;
    return this.replay !== null;
  }
  whenAdoptReplayed(): Promise<void> {
    return this.replay?.promise ?? Promise.resolve();
  }
  async compactContext(): Promise<CompactionResult> {
    this.compactions += 1;
    return { ok: true, preTokens: null, postTokens: null };
  }

  holdReplay(): void {
    this.replay = createDeferred();
  }

  finishReplay(): void {
    const replay = this.replay;
    this.replay = null;
    replay?.resolve();
  }
}

describe('the idle fire of an adopted session waits for its replay', () => {
  let harness: CommandHarness;
  let compaction: ReturnType<typeof createCompaction>;
  const adapter = new AdoptedStubAdapter();
  /** The order of what the fire did: `compact` (the adapter's compaction) and `stop` (the suspend port). */
  let steps: string[] = [];

  before(async () => {
    harness = await createCommandHarness();
    const pendingQuestions = new Map<string, PendingQuestionState>();
    compaction = createCompaction({
      ...harness.core,
      compactSelfReviewFlagDirs: harness.compactSelfReviewFlagDirs,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions,
      clearPendingQuestion: (clearedKey) => { pendingQuestions.delete(keyToString(clearedKey)); },
      closeQuestionMessage: async () => true,
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
    await harness.state.setAgent(key, { name: adapter.name, claudeSessionId: 'session-adopted' });
  });

  after(async () => {
    await harness.stop();
  });

  afterEach(async () => {
    adapter.finishReplay();
    compaction.clearThreadCompaction(key);
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleLatched(key, false);
  });

  /**
   * The state the adopt leaves: a turn since the last compaction (a compaction is due), the persisted activity so old that
   * {@link windowLeftAtAdoptMs} of the window is left, the replay held — then the timer armed the way the adopt arms it.
   */
  async function adoptWithReplayHeld(): Promise<void> {
    steps = [];
    adapter.replayLooks = 0;
    adapter.compactions = 0;
    compaction.markThreadTurnProducedOutput(key);
    harness.state.noteCompactIdleActivity(key, Date.now() - idleWindowMs + windowLeftAtAdoptMs);
    adapter.holdReplay();
    compaction.rearmThreadIdleTimer(key);
    // Either the fire looks at the replay, or (without the wait) it already compacted or stopped.
    await waitUntil('the idle fire', () => adapter.replayLooks > 0 || adapter.compactions > 0 || steps.length > 0);
    await new Promise((resolve) => setTimeout(resolve, heldWaitMs));
  }

  it('a fire that comes while the replay is pending neither compacts nor stops until the replay is done, then does both', async () => {
    await adoptWithReplayHeld();
    assert.equal(adapter.compactions, 0, 'no compaction is written to a process whose replay is pending');
    assert.deepEqual(steps, [], 'no stop is decided on the state the restart left');

    adapter.finishReplay();
    await waitUntil('the stop after the replay', () => steps.includes('stop'));
    assert.equal(adapter.compactions, 1, 'the compaction that was due runs once the state is rebuilt');
  });

  it('a fire whose wait ends with the countdown armed again — the replay brought output — gives way: no compaction, no stop', async () => {
    await adoptWithReplayHeld();
    // What the replayed output does: real activity re-arms the countdown from now.
    compaction.noteThreadActivity(key);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      adapter.finishReplay();
      await waitUntil('the fire to give way', () => logs.some((line) => line.includes('the fire gave way')));
    } finally {
      console.log = originalLog;
    }
    await new Promise((resolve) => setTimeout(resolve, heldWaitMs));
    assert.equal(adapter.compactions, 0);
    assert.deepEqual(steps, [], 'the topic was active again: its process is kept');
  });
});
