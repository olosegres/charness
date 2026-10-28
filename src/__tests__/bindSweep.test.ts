import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardStripsPerSweepLimit, telegramDeleteWindowMs, type OpenBindMessage } from '../connectors/telegram/openBindMessages';
import { stripStaleKeyboards, sweepOpenBindMessages, type BindSweepPorts } from '../connectors/telegram/bindSweep';

const nowMs = 1_000_000_000_000;
const recentMs = nowMs - 60_000;
const tooOldMs = nowMs - telegramDeleteWindowMs - 1;

/** `count` messages with ids first, first + 1, … (oldest first), all sent at `sentAtMs`. */
function createEntries(first: number, count: number, sentAtMs: number): OpenBindMessage[] {
  return Array.from({ length: count }, (_, index) => ({ messageId: first + index, sentAtMs }));
}

const idsOf = (entries: readonly OpenBindMessage[]): number[] => entries.map((entry) => entry.messageId);

interface Harness {
  ports: BindSweepPorts;
  /** The ids held right now. */
  held: Set<number>;
  /** What was held at the moment each bulk delete was called. */
  heldAtDelete: number[][];
  deleteCalls: number[][];
  strippedCalls: number[];
}

function createHarness(options: { isBulkDeleteAccepted?: boolean; failingKeyboardIds?: number[] } = {}): Harness {
  const held = new Set<number>();
  const heldAtDelete: number[][] = [];
  const deleteCalls: number[][] = [];
  const strippedCalls: number[] = [];
  return {
    held,
    heldAtDelete,
    deleteCalls,
    strippedCalls,
    ports: {
      retire: (messageId) => { held.add(messageId); },
      unretire: (messageId) => { held.delete(messageId); },
      deleteMessages: async (messageIds) => {
        heldAtDelete.push([...held]);
        deleteCalls.push([...messageIds]);
        return options.isBulkDeleteAccepted ?? true;
      },
      removeKeyboard: async (messageId) => {
        strippedCalls.push(messageId);
        return !(options.failingKeyboardIds ?? []).includes(messageId);
      },
    },
  };
}

test('every message is held before anything is awaited, and still held when the bulk delete is called', async () => {
  const harness = createHarness();
  const entries = createEntries(100, 4, recentMs);
  const sweeping = sweepOpenBindMessages(entries, nowMs, harness.ports);
  assert.deepEqual([...harness.held].sort(), idsOf(entries), 'held in the same synchronous step that took them');
  await sweeping;
  assert.deepEqual(harness.heldAtDelete, [idsOf(entries)]);
});

test('a bulk delete that goes through is ONE call, strips nothing, and lets go of everything it deleted', async () => {
  const harness = createHarness();
  const entries = createEntries(100, 30, recentMs);
  await sweepOpenBindMessages(entries, nowMs, harness.ports);
  assert.deepEqual(harness.deleteCalls, [idsOf(entries)]);
  assert.deepEqual(harness.strippedCalls, []);
  assert.equal(harness.held.size, 0, 'nothing left to tap, nothing held');
});

test('a refused bulk delete is not retried per picker: the newest ten lose their buttons and are let go of, the older rest stays held', async () => {
  const harness = createHarness({ isBulkDeleteAccepted: false });
  const entries = createEntries(100, keyboardStripsPerSweepLimit + 3, recentMs);
  await sweepOpenBindMessages(entries, nowMs, harness.ports);
  assert.equal(harness.deleteCalls.length, 1, 'one bulk call, no delete per picker');
  assert.deepEqual(harness.strippedCalls, idsOf(entries).slice(-keyboardStripsPerSweepLimit), 'the newest ten, oldest first');
  assert.deepEqual([...harness.held].sort(), idsOf(entries).slice(0, 3), 'the three older pickers keep their buttons and their hold');
});

test('an edit that fails leaves its message held: it still has its buttons', async () => {
  const entries = createEntries(100, 3, recentMs);
  const harness = createHarness({ isBulkDeleteAccepted: false, failingKeyboardIds: [101] });
  await sweepOpenBindMessages(entries, nowMs, harness.ports);
  assert.deepEqual([...harness.held], [101]);
});

test('messages too old to delete are never in a delete call: the newest ten lose their buttons, the older rest stays held', async () => {
  const harness = createHarness();
  const entries = createEntries(100, keyboardStripsPerSweepLimit + 2, tooOldMs);
  await sweepOpenBindMessages(entries, nowMs, harness.ports);
  assert.deepEqual(harness.deleteCalls, [], 'Telegram would refuse them');
  assert.deepEqual(harness.strippedCalls, idsOf(entries).slice(-keyboardStripsPerSweepLimit));
  assert.deepEqual([...harness.held].sort(), idsOf(entries).slice(0, 2));
});

test('recent and old messages together: the recent are deleted and let go of, the old are stripped and let go of', async () => {
  const old = createEntries(100, 2, tooOldMs);
  const recent = createEntries(200, 2, recentMs);
  const harness = createHarness();
  await sweepOpenBindMessages([...old, ...recent], nowMs, harness.ports);
  assert.deepEqual(harness.deleteCalls, [idsOf(recent)]);
  assert.deepEqual(harness.strippedCalls, idsOf(old));
  assert.equal(harness.held.size, 0);
});

test('nothing open: nothing is called', async () => {
  const harness = createHarness();
  await sweepOpenBindMessages([], nowMs, harness.ports);
  assert.deepEqual([harness.deleteCalls, harness.strippedCalls], [[], []]);
});

test('stripStaleKeyboards resolves the ids whose keyboard is gone: the newest ten that were edited successfully', async () => {
  const stripped: number[] = [];
  const messageIds = Array.from({ length: keyboardStripsPerSweepLimit + 2 }, (_, index) => 500 + index);
  const failing = messageIds.at(-1);
  const result = await stripStaleKeyboards(messageIds, async (messageId) => {
    stripped.push(messageId);
    return messageId !== failing;
  });
  assert.deepEqual(stripped, messageIds.slice(-keyboardStripsPerSweepLimit));
  assert.deepEqual(result, messageIds.slice(-keyboardStripsPerSweepLimit, -1), 'the failed edit is not reported as stripped');
});
