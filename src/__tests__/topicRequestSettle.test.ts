/**
 * @description Where a topic request goes once its prompt has come back from the prompt path (`requests/topicRequestSettle.ts`,
 * request/answer core S7). Load-bearing facts proven here, over the real settler with fake ports:
 *   • a prompt that reached a session — forwarded, buffered behind a start, even dropped by the buffer — has its turn tracked and
 *     its request stays open;
 *   • a prompt that found NO session (it waited for a bot restart's replay and the person was told) closes the request it opened
 *     as cancelled and tracks nothing — or the wake-up engine would prod the agent later for a turn that never started;
 *   • a prompt that opened no request (a slash command, requests off) settles nothing either way;
 *   • a failed track or a failed close is logged, never thrown into the caller's delivery, and tracking never holds the caller.
 * The wiring in `bot.ts` (every opening site settles through it) is pinned by `promptDelivery.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createTopicRequestSettler, type TopicRequestSettlePorts } from '../requests/topicRequestSettle';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { LatePromptOutcome } from '../utils/promptDelivery';

const key = makeTelegramKey(-1001111111111, 11);
const requestId = 'req-1';

let tracked: Array<{ requestId: string }>;
let cancelled: string[];
let warnings: string[];
let trackResult: Promise<void>;
let cancelResult: Promise<void>;

function createSettler() {
  const ports: TopicRequestSettlePorts = {
    trackTurn: (_key, trackedRequestId) => {
      tracked.push({ requestId: trackedRequestId });
      return trackResult;
    },
    cancelRequest: (cancelledRequestId) => {
      cancelled.push(cancelledRequestId);
      return cancelResult;
    },
    warn: (message) => { warnings.push(message); },
  };
  return createTopicRequestSettler(ports);
}

beforeEach(() => {
  tracked = [];
  cancelled = [];
  warnings = [];
  trackResult = Promise.resolve();
  cancelResult = Promise.resolve();
});

describe('a prompt that reached a session', () => {
  for (const delivery of ['forwarded', 'buffered', 'dropped'] as const satisfies readonly LatePromptOutcome[]) {
    test(`${delivery}: the turn is tracked and the request is left open`, async () => {
      await createSettler().settleAfterDelivery(key, { requestId }, delivery);
      assert.deepEqual(tracked, [{ requestId }]);
      assert.deepEqual(cancelled, []);
    });
  }
});

describe('a prompt that found no session', () => {
  test('the request it opened is closed as cancelled and no turn is tracked', async () => {
    await createSettler().settleAfterDelivery(key, { requestId }, 'noSession');
    assert.deepEqual(cancelled, [requestId]);
    assert.deepEqual(tracked, []);
  });

  test('a failed close is logged with the request named, not thrown into the delivery', async () => {
    cancelResult = Promise.reject(new Error('ledger is not writable'));
    await createSettler().settleAfterDelivery(key, { requestId }, 'noSession');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /closing the request req-1 of a prompt that found no session failed: ledger is not writable/);
  });
});

describe('a prompt that opened no request', () => {
  test('nothing is tracked and nothing is closed, whatever the delivery was', async () => {
    const settler = createSettler();
    for (const delivery of ['forwarded', 'buffered', 'dropped', 'noSession'] as const satisfies readonly LatePromptOutcome[]) {
      await settler.settleAfterDelivery(key, { requestId: null }, delivery);
    }
    settler.trackTurn(key, { requestId: null });
    assert.deepEqual(tracked, []);
    assert.deepEqual(cancelled, []);
  });
});

describe('tracking a turn', () => {
  test('is fire and forget: the caller is not held while the engine takes the turn in', async () => {
    trackResult = new Promise<void>(() => {});
    await createSettler().settleAfterDelivery(key, { requestId }, 'forwarded');
    assert.deepEqual(tracked, [{ requestId }], 'the engine was asked, and the settle returned without waiting for it');
  });

  test('a failed track is logged with the request named, not thrown', async () => {
    trackResult = Promise.reject(new Error('engine is not up'));
    const settler = createSettler();
    await settler.settleAfterDelivery(key, { requestId }, 'forwarded');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /tracking the turn of req-1 failed: engine is not up/);

    settler.trackTurn(key, { requestId });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 2, 'the capture-time buffer\'s direct track reports the same way');
  });
});
