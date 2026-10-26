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
      kit.slots.releaseReservation(first);
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
