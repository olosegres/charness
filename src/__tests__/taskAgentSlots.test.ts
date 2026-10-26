/**
 * @description The slots of the tracker task agents (`trackers/taskAgentSlots.ts`, decision D10): what holds a slot, who gets
 * the next free one, what is persisted, and who is told when one frees. Driven over a scripted ledger and an in-memory wait
 * list (`taskAgentSlotsTestKit.ts`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString } from '../sessionKey';
import type { ClosedRequestRecord, RequestCloseReason, RequestOriginKind } from '../requests/types';
import { taskAgentStartFailureLimit } from '../trackers/taskAgentSlots';
import { createJiraConversationKey, createTestSlots, createWaitEntry } from './taskAgentSlotsTestKit';

const first = createJiraConversationKey('PROJ-1');
const second = createJiraConversationKey('PROJ-2');
const third = createJiraConversationKey('PROJ-3');
const fourth = createJiraConversationKey('PROJ-4');

function createClosedRecord(kind: RequestOriginKind, closeReason: RequestCloseReason): ClosedRequestRecord {
  return {
    id: 'req_closed',
    origin: { kind, attributes: {} },
    createdAt: 1,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    conversationKey: keyToString(first),
    closedAt: 2,
    closeReason,
  };
}

describe('TaskAgentSlots', () => {
  describe('the cap', () => {
    it('no limit (0): every hand-over is granted, however many run', async () => {
      const kit = createTestSlots({ maxConcurrent: 0 });
      kit.setOpenRequests([first, second, third].map((key) => ({ key, kind: 'trackerEvent' })));
      assert.deepEqual(await kit.slots.checkIn(fourth, 'trigger'), { kind: 'granted' });
      assert.deepEqual(kit.getWaitList(), []);
    });

    it('under the cap a hand-over is granted; at the cap it waits, naming the cap and how many are ahead', async () => {
      const kit = createTestSlots({ maxConcurrent: 2 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
      kit.slots.noteStarted(second);
      kit.setOpenRequests([first, second].map((key) => ({ key, kind: 'trackerEvent' })));
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger-3'), { kind: 'queued', isNewlyQueued: true, aheadCount: 0, maxConcurrent: 2 });
      assert.deepEqual(await kit.slots.checkIn(fourth, 'trigger-4'), { kind: 'queued', isNewlyQueued: true, aheadCount: 1, maxConcurrent: 2 });
    });

    it('a conversation with several open hand-overs (two people handed one issue over) holds ONE slot', async () => {
      const kit = createTestSlots({ maxConcurrent: 2 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }, { key: first, kind: 'trackerEvent' }]);
      assert.equal(kit.slots.getStatus().runningCount, 1);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('a mention request (answer only) holds no slot', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'trackerMention' }]);
      assert.equal(kit.slots.getStatus().runningCount, 0);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('a request a message or a schedule opened in a Telegram topic holds no slot', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'message' }, { key: second, kind: 'scheduledRun' }]);
      assert.equal(kit.slots.getStatus().runningCount, 0);
    });

    it('a request the wake-up engine gave up on holds no slot: the alert is out and the issue handed back', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent', isWakeStopped: true }]);
      assert.equal(kit.slots.getStatus().runningCount, 0);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('a conversation that holds a slot needs no new one: a newer hand-over of it supersedes its request even at the cap', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      assert.deepEqual(await kit.slots.checkIn(first, 'newer-trigger'), { kind: 'granted' });
      assert.deepEqual(kit.getWaitList(), []);
    });

    it('the cap read at every question: lowered below the running count nobody new starts, and the running ones are not touched', async () => {
      const kit = createTestSlots({ maxConcurrent: 3 });
      kit.setOpenRequests([first, second, third].map((key) => ({ key, kind: 'trackerEvent' })));
      kit.setMaxConcurrent(2);
      assert.equal((await kit.slots.checkIn(fourth, 'trigger')).kind, 'queued');
      kit.setMaxConcurrent(4);
      assert.deepEqual(await kit.slots.checkIn(fourth, 'trigger'), { kind: 'granted' });
    });
  });

  describe('the wait list is FIFO and persisted', () => {
    it('the first queued answer saves and flushes the list; later check-ins of the same conversation change nothing', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, now: () => 1234 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      await kit.slots.checkIn(second, 'trigger-2');
      assert.deepEqual(kit.getWaitList(), [{ conversationKey: keyToString(second), triggerId: 'trigger-2', queuedAt: 1234 }]);
      assert.equal(kit.getFlushCount(), 1);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger-2'), { kind: 'queued', isNewlyQueued: false, aheadCount: 0, maxConcurrent: 1 });
      assert.equal(kit.getFlushCount(), 1, 'nothing changed, nothing saved');
    });

    it('a newer hand-over of a waiting issue replaces its trigger and keeps its place', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      await kit.slots.checkIn(second, 'old');
      await kit.slots.checkIn(third, 'trigger-3');
      assert.deepEqual(await kit.slots.checkIn(second, 'new'), { kind: 'queued', isNewlyQueued: false, aheadCount: 0, maxConcurrent: 1 });
      assert.deepEqual(kit.getWaitList().map((entry) => [entry.conversationKey, entry.triggerId]), [[keyToString(second), 'new'], [keyToString(third), 'trigger-3']]);
    });

    it('a freed slot goes to the head of the list, whatever order the polls ask in — the second waits although it asks first', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      await kit.slots.checkIn(second, 'trigger-2');
      await kit.slots.checkIn(third, 'trigger-3');
      kit.setOpenRequests([]);
      assert.equal((await kit.slots.checkIn(third, 'trigger-3')).kind, 'queued', 'the third is behind the second');
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger-2'), { kind: 'granted' });
    });

    it('two free slots start the first two of the list, not the second and the third', async () => {
      const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-2', 1), createWaitEntry('PROJ-3', 2), createWaitEntry('PROJ-4', 3)] });
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'granted' });
      kit.slots.noteStarted(third);
      kit.setOpenRequests([{ key: third, kind: 'trackerEvent' }]);
      assert.equal((await kit.slots.checkIn(fourth, 'trigger')).kind, 'queued', 'the second is ahead of the fourth and takes the last slot');
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('a new hand-over queues BEHIND those already waiting even while a slot is free (the waiting one has not asked again yet)', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-2', 1)] });
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'queued', isNewlyQueued: true, aheadCount: 1, maxConcurrent: 1 });
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('a restart keeps the order: a new slots object over the same persisted list decides as the old one did', async () => {
      const waitList = [createWaitEntry('PROJ-2', 1), createWaitEntry('PROJ-3', 2)];
      const kit = createTestSlots({ maxConcurrent: 1, waitList });
      kit.setOpenRequests([{ key: first, kind: 'trackerEvent' }]);
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'queued', isNewlyQueued: false, aheadCount: 1, maxConcurrent: 1 });
      assert.equal(kit.slots.getStatus().waitingCount, 2);
    });

    it('a place whose conversation holds a slot already (a start whose entry was not dropped before a crash) does not count as waiting', async () => {
      const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-2', 1)] });
      kit.setOpenRequests([{ key: second, kind: 'trackerEvent' }]);
      assert.equal(kit.slots.getStatus().waitingCount, 0);
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'granted' });
    });
  });

  describe('a grant is a reservation until the request is open', () => {
    it('two grants never share the last slot: the second asks while the first has not opened its request yet', async () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
      assert.equal((await kit.slots.checkIn(second, 'trigger')).kind, 'queued');
    });

    it('a grant that could not open its request gives the slot back and keeps its place in the list', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1)] });
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
      kit.slots.noteStartFailed(first);
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [keyToString(first)], 'its place stays');
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' }, 'and it is first in line again');
    });

    it('noteStarted drops the reservation and the place in the list', async () => {
      const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-1', 1)] });
      await kit.slots.checkIn(first, 'trigger');
      kit.slots.noteStarted(first);
      assert.deepEqual(kit.getWaitList(), []);
      assert.equal(kit.slots.getStatus().runningCount, 0, 'the ledger counts it from here, not the slots');
    });
  });

  describe('a waiting issue that fails to start does not hold up the ones behind it', () => {
    /** Everything `console.warn` is told while `run` runs. */
    async function collectWarnings(run: () => Promise<void> | void): Promise<string[]> {
      const warn = console.warn;
      const warnings: string[] = [];
      console.warn = (line: string) => {
        warnings.push(line);
      };
      try {
        await run();
      } finally {
        console.warn = warn;
      }
      return warnings;
    }

    it('B behind a failing A starts in the SAME poll when A is asked first: A\'s failure gives the slot back and A no longer stands ahead', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2)] });
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
      kit.slots.noteStartFailed(first);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
    });

    it('B asked before A in a poll waits for the next one; there A, whose last start failed, no longer holds it up', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2)] });
      assert.equal((await kit.slots.checkIn(second, 'trigger')).kind, 'queued', 'poll 1: A is ahead and has not failed yet');
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
      kit.slots.noteStartFailed(first);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' }, 'poll 2: B takes the free slot');
    });

    it('a newcomer is not held up by a place whose last start failed either', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1)] });
      await kit.slots.checkIn(first, 'trigger');
      kit.slots.noteStartFailed(first);
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'granted' });
    });

    it('A keeps its place and is retried while it is the only one waiting; a start that works clears the failures', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1)] });
      for (let attempt = 0; attempt < taskAgentStartFailureLimit - 1; attempt += 1) {
        assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' }, `attempt ${attempt + 1}`);
        kit.slots.noteStartFailed(first);
      }
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [keyToString(first)], 'two failures: still its place');
      await kit.slots.checkIn(first, 'trigger');
      kit.slots.noteStarted(first);
      assert.deepEqual(kit.getWaitList(), []);
      // Back in the list, its failures start from zero: it takes the full number of failures again to move.
      await kit.slots.checkIn(third, 'trigger');
      kit.setOpenRequests([{ key: third, kind: 'trackerEvent' }]);
      await kit.slots.checkIn(first, 'trigger-2');
      await kit.slots.checkIn(second, 'trigger-3');
      kit.setOpenRequests([]);
      for (let attempt = 0; attempt < taskAgentStartFailureLimit - 1; attempt += 1) {
        await kit.slots.checkIn(first, 'trigger-2');
        kit.slots.noteStartFailed(first);
      }
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [keyToString(first), keyToString(second)], 'the earlier failures were forgotten');
    });

    it('a start that keeps failing moves to the END of the list on its third failure in a row — logged once — and the others are ahead of it from then on', async () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2), createWaitEntry('PROJ-3', 3)] });
      const warnings = await collectWarnings(async () => {
        for (let attempt = 0; attempt < taskAgentStartFailureLimit; attempt += 1) {
          assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' }, `attempt ${attempt + 1}`);
          kit.slots.noteStartFailed(first);
          if (attempt < taskAgentStartFailureLimit - 1) {
            assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [first, second, third].map((key) => keyToString(key)), `still first after ${attempt + 1} failures`);
          }
        }
      });
      assert.equal(taskAgentStartFailureLimit, 3);
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [second, third, first].map((key) => keyToString(key)), 'moved behind the others');
      assert.deepEqual(warnings, [`[tasks] ${keyToString(first)} failed to start 3 times in a row; it moves to the end of the wait list`], 'said once');
      // The second starts now (and holds the slot); a newcomer queues behind the third AND the moved first.
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
      assert.deepEqual(await kit.slots.checkIn(fourth, 'trigger'), { kind: 'queued', isNewlyQueued: true, aheadCount: 2, maxConcurrent: 1 });
    });

    it('with several slots free, the failing A does not use one up: B and C start beside it', async () => {
      const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2), createWaitEntry('PROJ-3', 3)] });
      assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
      kit.slots.noteStartFailed(first);
      assert.deepEqual(await kit.slots.checkIn(second, 'trigger'), { kind: 'granted' });
      kit.slots.noteStarted(second);
      kit.setOpenRequests([{ key: second, kind: 'trackerEvent' }]);
      assert.deepEqual(await kit.slots.checkIn(third, 'trigger'), { kind: 'granted' });
    });

    it('a place that leaves the list forgets its failures: joining again, it takes the full number of failures to move', async () => {
      const kit = createTestSlots({ maxConcurrent: 2 });
      const occupy = (): void => kit.setOpenRequests([third, fourth].map((key) => ({ key, kind: 'trackerEvent' })));
      occupy();
      await kit.slots.checkIn(first, 'trigger');
      kit.setOpenRequests([]);
      for (let attempt = 0; attempt < taskAgentStartFailureLimit - 1; attempt += 1) {
        await kit.slots.checkIn(first, 'trigger');
        kit.slots.noteStartFailed(first);
      }
      kit.slots.dropWaiting(first);
      occupy();
      assert.equal((await kit.slots.checkIn(first, 'trigger')).kind, 'queued', 'a new place');
      kit.setOpenRequests([]);
      const warnings = await collectWarnings(async () => {
        for (let attempt = 0; attempt < taskAgentStartFailureLimit - 1; attempt += 1) {
          await kit.slots.checkIn(first, 'trigger');
          kit.slots.noteStartFailed(first);
        }
      });
      assert.deepEqual(warnings, [], 'two failures since it joined again: not moved');
    });

    it('a failed start with no place has nothing to move: nothing is logged, and nothing is kept against it', async () => {
      const kit = createTestSlots({ maxConcurrent: 2 });
      const warnings = await collectWarnings(async () => {
        for (let attempt = 0; attempt < taskAgentStartFailureLimit + 1; attempt += 1) {
          assert.deepEqual(await kit.slots.checkIn(first, 'trigger'), { kind: 'granted' });
          kit.slots.noteStartFailed(first);
        }
      });
      assert.deepEqual(warnings, []);
      assert.deepEqual(kit.getWaitList(), []);
    });
  });

  describe('places leave the list', () => {
    it('dropWaiting removes one conversation\'s place', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2)] });
      kit.slots.dropWaiting(first);
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [keyToString(second)]);
    });

    it('pruneWaiting drops the places a connector no longer vouches for, and only that connector\'s', () => {
      const foreign = { conversationKey: '-1001111111111:7', triggerId: 'x', queuedAt: 1 };
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), foreign, createWaitEntry('PROJ-2', 2)] });
      kit.slots.pruneWaiting('jira', (key) => key.thread === 'PROJ-2');
      assert.deepEqual(kit.getWaitList().map((entry) => entry.conversationKey), [foreign.conversationKey, keyToString(second)]);
    });

    it('dropUnserved drops the places of a connector this process no longer serves (they could never start)', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-1', 1), createWaitEntry('PROJ-2', 2)] });
      kit.slots.dropUnserved((key) => key.platform !== 'jira');
      assert.deepEqual(kit.getWaitList(), []);
    });
  });

  describe('a freed slot wakes the listeners', () => {
    it('a hand-over that closed (answer, question, cancel) wakes them while somebody waits', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-2', 1)] });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      for (const closeReason of ['final', 'question', 'cancelled'] as const) kit.slots.noteRequestClosed(createClosedRecord('trackerEvent', closeReason));
      assert.equal(wakes, 3);
    });

    it('nobody waits: nobody is woken', () => {
      const kit = createTestSlots({ maxConcurrent: 1 });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      kit.slots.noteRequestClosed(createClosedRecord('trackerEvent', 'final'));
      assert.equal(wakes, 0);
    });

    it('a request that was only replaced by a newer one of its conversation, a mention and a Telegram request free nothing', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-2', 1)] });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      kit.slots.noteRequestClosed(createClosedRecord('trackerEvent', 'superseded'));
      kit.slots.noteRequestClosed(createClosedRecord('trackerMention', 'final'));
      kit.slots.noteRequestClosed(createClosedRecord('message', 'final'));
      assert.equal(wakes, 0);
    });

    it('the wake-up engine giving up on a hand-over wakes them while somebody waits — a mention, a Telegram request or nobody waiting does not', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-2', 1)] });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      kit.slots.noteRequestWakeStopped(createClosedRecord('trackerEvent', 'final'));
      assert.equal(wakes, 1);
      kit.slots.noteRequestWakeStopped(createClosedRecord('trackerMention', 'final'));
      kit.slots.noteRequestWakeStopped(createClosedRecord('message', 'final'));
      assert.equal(wakes, 1);
      const idle = createTestSlots({ maxConcurrent: 1 });
      idle.slots.onSlotFreed(() => {
        wakes += 1;
      });
      idle.slots.noteRequestWakeStopped(createClosedRecord('trackerEvent', 'final'));
      assert.equal(wakes, 1);
    });

    it('a raised cap wakes them while somebody waits: found by a read outside a poll (the screen\'s status, the note after /task_agents) — not by a check-in, which is the poll itself', async () => {
      const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-2', 1)] });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      kit.slots.getStatus();
      assert.equal(wakes, 0, 'the first read only learns the cap');
      kit.setMaxConcurrent(3);
      kit.slots.getStatus();
      assert.equal(wakes, 1, 'raised, seen by the screen');
      kit.slots.getStatus();
      assert.equal(wakes, 1, 'once: the raise is known now');
      kit.setMaxConcurrent(5);
      await kit.slots.checkIn(createJiraConversationKey('PROJ-8'), 'trigger');
      assert.equal(wakes, 1, 'a poll\'s own check-in reads the new cap without waking itself');
      kit.setMaxConcurrent(6);
      kit.slots.noteLimitMayHaveChanged();
      assert.equal(wakes, 2, 'raised again, told by the note');
    });

    it('a lowered cap, an unchanged one and a raise with nobody waiting wake nobody; «no limit» after a number is a raise', () => {
      const kit = createTestSlots({ maxConcurrent: 5, waitList: [createWaitEntry('PROJ-2', 1)] });
      let wakes = 0;
      kit.slots.onSlotFreed(() => {
        wakes += 1;
      });
      kit.slots.noteLimitMayHaveChanged();
      kit.setMaxConcurrent(3);
      kit.slots.noteLimitMayHaveChanged();
      kit.slots.noteLimitMayHaveChanged();
      assert.equal(wakes, 0);
      kit.setMaxConcurrent(0);
      kit.slots.noteLimitMayHaveChanged();
      assert.equal(wakes, 1, 'no limit is room');
      kit.setMaxConcurrent(7);
      kit.slots.noteLimitMayHaveChanged();
      assert.equal(wakes, 1, 'from no limit down is not a raise');
      const idle = createTestSlots({ maxConcurrent: 1 });
      idle.slots.onSlotFreed(() => {
        wakes += 1;
      });
      idle.slots.noteLimitMayHaveChanged();
      idle.setMaxConcurrent(9);
      idle.slots.noteLimitMayHaveChanged();
      assert.equal(wakes, 1, 'nobody waits: nobody is woken');
    });

    it('the function onSlotFreed returns stops the listening; a listener that throws does not stop the others', () => {
      const kit = createTestSlots({ maxConcurrent: 1, waitList: [createWaitEntry('PROJ-2', 1)] });
      const woken: string[] = [];
      kit.slots.onSlotFreed(() => {
        throw new Error('broken listener');
      });
      const stopSecond = kit.slots.onSlotFreed(() => woken.push('second'));
      kit.slots.onSlotFreed(() => woken.push('third'));
      const warn = console.warn;
      console.warn = () => {};
      try {
        kit.slots.noteRequestClosed(createClosedRecord('trackerEvent', 'final'));
        assert.deepEqual(woken, ['second', 'third']);
        stopSecond();
        kit.slots.noteRequestClosed(createClosedRecord('trackerEvent', 'final'));
        assert.deepEqual(woken, ['second', 'third', 'third']);
      } finally {
        console.warn = warn;
      }
    });
  });

  it('getStatus: the cap, the conversations working and the conversations waiting', () => {
    const kit = createTestSlots({ maxConcurrent: 2, waitList: [createWaitEntry('PROJ-3', 1), createWaitEntry('PROJ-4', 2)] });
    kit.setOpenRequests([first, second].map((key) => ({ key, kind: 'trackerEvent' })));
    assert.deepEqual(kit.slots.getStatus(), { maxConcurrent: 2, runningCount: 2, waitingCount: 2 });
  });
});
