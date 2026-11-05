/**
 * @description Coverage for `utils/transientFrames` — the pure collector behind
 * the graceful-shutdown sweep and the boot reconciliation that delete orphaned
 * status frames and «transcribing…» voice notes. Load-bearing facts: only the ids
 * on screen are returned, in the fixed status → thinking → sub-agent → voice notes
 * order, and an empty state yields an empty list (so the sweep / boot loop does
 * nothing).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getTransientFrameIds,
  clearTransientFramesForShutdown,
  deleteTransientMessages,
  sweepTransientMessages,
  type ShutdownFrameState,
  type TransientSweepPorts,
} from '../utils/transientFrames';
import { checkIsRetryableTelegramError } from '../utils/telegramError';
import { getStatusFrameStoreDecision } from '../utils/claudeLivenessAction';

function makeShutdownState(overrides: Partial<ShutdownFrameState> = {}): ShutdownFrameState {
  return {
    statusMessageId: null,
    thinkingMessageId: null,
    subagentStatusMessageId: null,
    voiceProgressNoteIds: [],
    undeletedMessageIds: [],
    statusFrameGeneration: 0,
    thinkingFrameGeneration: 0,
    ...overrides,
  };
}

test('collects all three non-null frame ids in status → thinking → sub-agent order', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 10,
      thinkingMessageId: 20,
      subagentStatusMessageId: 30,
      voiceProgressNoteIds: [],
      undeletedMessageIds: [],
    }),
    [10, 20, 30],
  );
});

test('skips null frame ids, keeping the rest in order', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: null,
      thinkingMessageId: 20,
      subagentStatusMessageId: null,
      voiceProgressNoteIds: [],
      undeletedMessageIds: [],
    }),
    [20],
  );
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 5,
      thinkingMessageId: null,
      subagentStatusMessageId: 7,
      voiceProgressNoteIds: [],
      undeletedMessageIds: [],
    }),
    [5, 7],
  );
});

test('returns an empty list when every frame id is null', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: null,
      thinkingMessageId: null,
      subagentStatusMessageId: null,
      voiceProgressNoteIds: [],
      undeletedMessageIds: [],
    }),
    [],
  );
});

test('the «transcribing…» voice notes are collected after the frames — one id per voice message still waiting', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 10,
      thinkingMessageId: null,
      subagentStatusMessageId: null,
      voiceProgressNoteIds: [41, 42],
      undeletedMessageIds: [],
    }),
    [10, 41, 42],
  );
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: null,
      thinkingMessageId: null,
      subagentStatusMessageId: null,
      voiceProgressNoteIds: [41],
      undeletedMessageIds: [],
    }),
    [41],
    'a voice note alone is a transient message: the sweep and the boot reconciliation must delete it',
  );
});

test('clearTransientFramesForShutdown returns the voice notes too, then empties the list', () => {
  const state = makeShutdownState({ voiceProgressNoteIds: [41, 42] });
  assert.deepEqual(clearTransientFramesForShutdown(state), [41, 42]);
  assert.deepEqual(state.voiceProgressNoteIds, []);
});

test('clearTransientFramesForShutdown returns on-screen ids, then nulls them and bumps both generations', () => {
  const state = makeShutdownState({
    statusMessageId: 10,
    thinkingMessageId: 20,
    subagentStatusMessageId: 30,
    statusFrameGeneration: 4,
    thinkingFrameGeneration: 7,
  });
  const ids = clearTransientFramesForShutdown(state);
  assert.deepEqual(ids, [10, 20, 30]);
  assert.equal(state.statusMessageId, null);
  assert.equal(state.thinkingMessageId, null);
  assert.equal(state.subagentStatusMessageId, null);
  assert.equal(state.statusFrameGeneration, 5);
  assert.equal(state.thinkingFrameGeneration, 8);
});

test('bumps generations EVEN when every id is null (the racing-create case)', () => {
  // The bug: a `sendStatusFrame` create mid-`await` at sweep time has stored no
  // id yet, so the old sweep (gated on `ids.length === 0`) skipped the thread and
  // never bumped — the create then stored an orphan that survived the restart.
  const state = makeShutdownState({ statusFrameGeneration: 2, thinkingFrameGeneration: 2 });
  const ids = clearTransientFramesForShutdown(state);
  assert.deepEqual(ids, [], 'nothing on screen to delete');
  assert.equal(state.statusFrameGeneration, 3, 'status generation still bumped');
  assert.equal(state.thinkingFrameGeneration, 3, 'thinking generation still bumped');
});

test('a status create that captured the pre-sweep generation now DISCARDS (no orphan)', () => {
  // End-to-end of the fix: the in-flight create snapshots the generation before
  // its await; the sweep bumps it; `getStatusFrameStoreDecision` then says discard.
  const state = makeShutdownState({ statusFrameGeneration: 9 });
  const generationAtCreateStart = state.statusFrameGeneration; // create begins pre-sweep
  clearTransientFramesForShutdown(state); // sweep runs during the create's await
  assert.equal(
    getStatusFrameStoreDecision(generationAtCreateStart, state.statusFrameGeneration),
    'discard',
  );
});

test('leftovers whose delete failed earlier are collected last, so the next sweep and boot try them again', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 10,
      thinkingMessageId: null,
      subagentStatusMessageId: null,
      voiceProgressNoteIds: [41],
      undeletedMessageIds: [7, 8],
    }),
    [10, 41, 7, 8],
  );
  const state = makeShutdownState({ undeletedMessageIds: [7, 8] });
  assert.deepEqual(clearTransientFramesForShutdown(state), [7, 8]);
  assert.deepEqual(state.undeletedMessageIds, []);
});

const networkError = new Error('socket hang up');
const tooManyRequests = { response: { error_code: 429, description: 'Too Many Requests: retry after 3' } };
const serverError = { response: { error_code: 500, description: 'Internal Server Error' } };
const alreadyGone = { response: { error_code: 400, description: 'Bad Request: message to delete not found' } };
const refusedForGood = { response: { error_code: 400, description: 'Bad Request: message can\'t be deleted' } };

test('deleteTransientMessages keeps the ids whose delete a retry can fix and settles the rest', async () => {
  const failures = new Map<number, unknown>([[2, networkError], [3, tooManyRequests], [4, serverError], [5, alreadyGone], [6, refusedForGood]]);
  const attempted: number[] = [];

  const keptIds = await deleteTransientMessages(
    [1, 2, 3, 4, 5, 6],
    async (messageId) => {
      attempted.push(messageId);
      if (failures.has(messageId)) throw failures.get(messageId);
    },
    checkIsRetryableTelegramError,
  );

  assert.deepEqual(attempted, [1, 2, 3, 4, 5, 6], 'every message gets its attempt, one failure does not stop the others');
  assert.deepEqual(keptIds, [2, 3, 4], 'deleted (1), already gone (5) and refused for good (6) are settled; a bad moment is kept');
});

test('deleteTransientMessages with nothing to delete, or with every delete done, keeps nothing', async () => {
  assert.deepEqual(await deleteTransientMessages([], async () => { throw networkError; }, checkIsRetryableTelegramError), []);
  assert.deepEqual(await deleteTransientMessages([1, 2], async () => {}, checkIsRetryableTelegramError), []);
});

interface SweepWorld {
  /** Which ids Telegram still holds, by thread. */
  onScreen: Map<string, Set<number>>;
  /** What `state.json` holds per thread. */
  saved: Map<string, number[]>;
  /** Failures to hand out, in order, to the next delete attempts of an id. */
  failuresByMessageId: Map<number, unknown[]>;
  problems: string[];
  ports: TransientSweepPorts<string>;
}

function createSweepWorld(): SweepWorld {
  const world: SweepWorld = {
    onScreen: new Map(),
    saved: new Map(),
    failuresByMessageId: new Map(),
    problems: [],
    ports: {
      deleteMessage: async (threadKey, messageId) => {
        const failure = world.failuresByMessageId.get(messageId)?.shift();
        if (failure !== undefined) throw failure;
        world.onScreen.get(threadKey)?.delete(messageId);
      },
      checkIsRetryable: checkIsRetryableTelegramError,
      saveKeptIds: async (threadKey, keptIds) => {
        if (keptIds.length === 0) world.saved.delete(threadKey);
        else world.saved.set(threadKey, keptIds);
      },
      logProblem: (line) => { world.problems.push(line); },
    },
  };
  return world;
}

test('the shutdown sweep deletes what is on screen and empties the saved set', async () => {
  const world = createSweepWorld();
  world.onScreen.set('topic-a', new Set([10, 41]));
  world.saved.set('topic-a', [10, 41]);
  const state = makeShutdownState({ statusMessageId: 10, voiceProgressNoteIds: [41] });

  await sweepTransientMessages([{ key: 'topic-a', state }], world.ports);

  assert.deepEqual([...world.onScreen.get('topic-a') ?? []], []);
  assert.equal(world.saved.has('topic-a'), false, 'nothing left to retry: the thread leaves state.json');
  assert.deepEqual(world.problems, []);
});

test('a sweep whose delete hits a bad moment keeps that id in the saved set; the next sweep deletes it (failure, then retry)', async () => {
  const world = createSweepWorld();
  world.onScreen.set('topic-a', new Set([10, 11, 41]));
  world.failuresByMessageId.set(11, [serverError]);
  world.failuresByMessageId.set(41, [tooManyRequests]);

  // 1. the shutdown sweep: the «working…» frame goes, the thinking frame and the voice note hit a 5xx and a 429
  const firstState = makeShutdownState({ statusMessageId: 10, thinkingMessageId: 11, voiceProgressNoteIds: [41] });
  await sweepTransientMessages([{ key: 'topic-a', state: firstState }], world.ports);
  assert.deepEqual([...world.onScreen.get('topic-a') ?? []].sort(), [11, 41], 'precondition: the two failed deletes are still on screen');
  assert.deepEqual(world.saved.get('topic-a'), [11, 41], 'and they stay recorded — the status frame\'s record is gone, its message is');
  assert.equal(world.problems.length, 1, 'the sweep says that something stays recorded');

  // 2. the next process holds them as leftovers; its own shutdown sweep tries again, and this time Telegram answers
  const secondState = makeShutdownState({ undeletedMessageIds: world.saved.get('topic-a') });
  await sweepTransientMessages([{ key: 'topic-a', state: secondState }], world.ports);
  assert.deepEqual([...world.onScreen.get('topic-a') ?? []], [], 'the retry deleted both');
  assert.equal(world.saved.has('topic-a'), false, 'and the record is gone with them');
});

test('a sweep keeps a retryable failure but drops a final one, so a message that can never be deleted is not retried for ever', async () => {
  const world = createSweepWorld();
  world.onScreen.set('topic-a', new Set([20, 21, 22]));
  world.failuresByMessageId.set(20, [networkError]);
  world.failuresByMessageId.set(21, [refusedForGood]);
  world.failuresByMessageId.set(22, [alreadyGone]);

  await sweepTransientMessages([{ key: 'topic-a', state: makeShutdownState({ undeletedMessageIds: [20, 21, 22] }) }], world.ports);

  assert.deepEqual(world.saved.get('topic-a'), [20]);
});

test('the sweep bumps the generations of every thread, also one with nothing on screen, and leaves its saved set alone', async () => {
  const world = createSweepWorld();
  world.saved.set('topic-idle', [999]);
  const idleState = makeShutdownState({ statusFrameGeneration: 4, thinkingFrameGeneration: 6 });

  await sweepTransientMessages([{ key: 'topic-idle', state: idleState }], world.ports);

  assert.equal(idleState.statusFrameGeneration, 5);
  assert.equal(idleState.thinkingFrameGeneration, 7);
  assert.deepEqual(world.saved.get('topic-idle'), [999], 'nothing was swept, so the record is not rewritten');
});

test('a thread that cannot be saved is reported and does not stop the sweep of the others', async () => {
  const world = createSweepWorld();
  world.onScreen.set('topic-a', new Set([1]));
  world.onScreen.set('topic-b', new Set([2]));
  world.ports.saveKeptIds = async (threadKey) => {
    if (threadKey === 'topic-a') throw new Error('disk full');
  };

  await sweepTransientMessages([
    { key: 'topic-a', state: makeShutdownState({ statusMessageId: 1 }) },
    { key: 'topic-b', state: makeShutdownState({ statusMessageId: 2 }) },
  ], world.ports);

  assert.deepEqual([...world.onScreen.get('topic-b') ?? []], [], 'the other thread was swept');
  assert.equal(world.problems.length, 1);
  assert.match(world.problems[0], /could not be saved: disk full/);
});
