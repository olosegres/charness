/**
 * @description Unit coverage for `reconcileTransientFrames` — the boot-time
 * cleanup that deletes transient messages (the status / thinking / sub-agent
 * frames and the «transcribing…» voice notes) left on screen by an exit that did
 * not finish its own cleanup: an UNGRACEFUL restart (crash / SIGKILL, where the
 * graceful shutdown sweep never ran, S2) or a sweep whose deletes hit a bad moment.
 *
 * Load-bearing regression guard: reconciliation consumes the `orphaned` SNAPSHOT
 * passed to it (captured in `startBot` BEFORE `reattachExistingSessions`), NOT a
 * live re-read of the store. This is the exact bug found in live testing: a
 * reattached session's first frame setter persists the fresh all-null in-memory
 * state and would clobber the live persisted set to empty before reconcile could
 * read it — so reconcile MUST act on the pre-captured argument. (The snapshot's
 * own immunity to that clobber is proven at the store layer in `state.test.ts`.)
 *
 * The second guard is retention: a delete that fails for a reason a later try can
 * fix keeps its id in the thread's pending-delete list, and the next boot's
 * reconciliation (or the next shutdown sweep) deletes it; only a success, an
 * "already gone" or another final answer settles an id.
 *
 * The side-effecting collaborators (`deleteMessage`, `setUndeletedMessageIds`) are
 * injected so the orchestration is observable without a real Telegram client /
 * StateStore. `./reattachRecapPost.testSetup` is imported FIRST as a shared,
 * side-effect-only shim that sets `bot.ts`'s boot-time env (token + WORK_ROOT)
 * before the module evaluates.
 *
 * Test case: N/A — Charness has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */
import './reattachRecapPost.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileTransientFrames, type ReconcileTransientFramesDeps } from '../bot';
import { keyToString, type SessionKey } from '../sessionKey';
import { getTelegramChatId, makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { checkIsRetryableTelegramError } from '../utils/telegramError';

const keyA: SessionKey = makeTelegramKey(-1001111111111, 4242);
const keyB: SessionKey = makeTelegramKey(-1001111111111, 123);

const serverError = { response: { error_code: 500, description: 'Internal Server Error' } };
const refusedForGood = { response: { error_code: 400, description: 'Bad Request: message can\'t be deleted' } };

type World = {
  deps: ReconcileTransientFramesDeps;
  /** Every delete attempt, in order. */
  deletes: Array<[number, number]>;
  /** Every `setUndeletedMessageIds` call as `<thread>: <ids>`, interleaved with the deletes in `events`. */
  undeleted: string[];
  /** Deletes and undeleted-list changes in the order they happened. */
  events: string[];
  /** Message ids whose delete fails, with the error. */
  failures: Map<number, unknown>;
};

function makeWorld(): World {
  const world: World = {
    deletes: [],
    undeleted: [],
    events: [],
    failures: new Map(),
    deps: {
      // No `await` before the push → the record lands synchronously when the delete is invoked.
      deleteMessage: async (chatId, messageId) => {
        world.deletes.push([chatId, messageId]);
        world.events.push(`delete ${messageId}`);
        if (world.failures.has(messageId)) throw world.failures.get(messageId);
        return true;
      },
      setUndeletedMessageIds: (key, ids) => {
        world.undeleted.push(`${keyToString(key)}: ${ids.join(',')}`);
        world.events.push(`undeleted [${ids.join(',')}]`);
      },
      checkIsRetryable: checkIsRetryableTelegramError,
    },
  };
  return world;
}

describe('reconcileTransientFrames', () => {
  it('deletes every id in the snapshot, in order, parks them first and empties the list once they are gone', async () => {
    const world = makeWorld();
    const orphaned = { [keyToString(keyA)]: [101, 202], [keyToString(keyB)]: [303] };

    const settled = await reconcileTransientFrames(orphaned, world.deps);

    assert.equal(settled, 3, 'returns the number of stale ids settled');
    assert.deepEqual(world.deletes, [
      [getTelegramChatId(keyA), 101],
      [getTelegramChatId(keyA), 202],
      [getTelegramChatId(keyB), 303],
    ]);
    assert.deepEqual(
      world.undeleted,
      [
        `${keyToString(keyA)}: 101,202`,
        `${keyToString(keyB)}: 303`,
        `${keyToString(keyA)}: `,
        `${keyToString(keyB)}: `,
      ],
      'every stale id is recorded as pending BEFORE any delete, and each thread\'s list is emptied after its deletes',
    );
    assert.deepEqual(world.events.slice(0, 2), ['undeleted [101,202]', 'undeleted [303]'], 'recorded first: a clobber or a second restart in the middle cannot lose them');
  });

  it('acts on the PASSED snapshot — the boot-reconcile clobber guard', async () => {
    // The whole point of the pre-reattach snapshot: reconcile must delete what it
    // was GIVEN, regardless of current live state (which reattach may have already
    // cleared). It has no other data source, so passing ids deletes exactly them.
    const world = makeWorld();
    const orphaned = { [keyToString(keyA)]: [41197] };

    const settled = await reconcileTransientFrames(orphaned, world.deps);

    assert.equal(settled, 1);
    assert.deepEqual(world.deletes, [[getTelegramChatId(keyA), 41197]]);
  });

  it('skips a corrupt key but still deletes valid threads', async () => {
    const world = makeWorld();
    const orphaned = { 'not-a-key': [1, 2], [keyToString(keyA)]: [202] };

    const settled = await reconcileTransientFrames(orphaned, world.deps);

    assert.equal(settled, 1, 'corrupt key contributes nothing');
    assert.deepEqual(world.deletes, [[getTelegramChatId(keyA), 202]]);
    assert.ok(world.undeleted.every((line) => line.startsWith(keyToString(keyA))), 'no list change for the skipped key');
  });

  it('an empty snapshot deletes nothing and settles 0', async () => {
    const world = makeWorld();

    const settled = await reconcileTransientFrames({}, world.deps);

    assert.equal(settled, 0);
    assert.deepEqual(world.deletes, []);
    assert.deepEqual(world.undeleted, []);
  });

  it('a delete that hits a bad moment keeps its id in the pending list — failure, then a successful retry at the next boot', async () => {
    const world = makeWorld();
    world.failures.set(202, serverError);
    const orphaned = { [keyToString(keyA)]: [101, 202] };

    // 1. this boot: Telegram answers 500 for one of the two
    const settledAtFirstBoot = await reconcileTransientFrames(orphaned, world.deps);
    assert.equal(settledAtFirstBoot, 1, 'only the delete that went through is settled');
    assert.equal(world.undeleted.at(-1), `${keyToString(keyA)}: 202`, 'the failed id stays recorded, so the live persist keeps it and the next sweep and boot retry it');

    // 2. the next boot reads that record as its snapshot; Telegram is well again
    world.failures.clear();
    const retried = await reconcileTransientFrames({ [keyToString(keyA)]: [202] }, world.deps);
    assert.equal(retried, 1);
    assert.equal(world.undeleted.at(-1), `${keyToString(keyA)}: `, 'now the list is empty');
    assert.deepEqual(world.deletes.filter(([, messageId]) => messageId === 202).length, 2, '202 was attempted at both boots');
  });

  it('an answer that can never change drops the id instead of retrying it for ever', async () => {
    const world = makeWorld();
    world.failures.set(7, refusedForGood);

    const settled = await reconcileTransientFrames({ [keyToString(keyA)]: [7] }, world.deps);

    assert.equal(settled, 1, 'a refusal is final: settled');
    assert.equal(world.undeleted.at(-1), `${keyToString(keyA)}: `);
  });

  it('a dropped connection (no Bot API answer) is a bad moment too', async () => {
    const world = makeWorld();
    world.failures.set(9, new Error('socket hang up'));

    const settled = await reconcileTransientFrames({ [keyToString(keyB)]: [9] }, world.deps);

    assert.equal(settled, 0);
    assert.equal(world.undeleted.at(-1), `${keyToString(keyB)}: 9`);
  });
});
