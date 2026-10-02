/**
 * @description The foreign-key gates of Jira connector plan J2b: the routing of
 * every adapter event for a conversation of another platform (R2), the send
 * queue's refusal of such a key without ever raising an unhandled rejection
 * (R2), and the native question turned off outside Telegram (R1).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import {
  adapterEventNames,
  dispatchAdapterEvent,
  type AdapterEventName,
} from '../adapters/adapterEventRouting';
import { enqueueSend, ForeignKeySendRefusedError, sendUnpaced } from '../rateLimiter';
import { getClaudePlatformToolFlags } from '../adapters/claudePlatformFlags';

const topicKey = makeTelegramKey(-1001234567890, 42);
const issueKey = makeJiraKey('PROJ-12');

/** What a Jira conversation's event must run — written out here, not read from the module's table. */
const expectedJiraRoutes: Record<AdapterEventName, 'telegramHandler' | 'requestSideHandler' | 'nothing'> = {
  output: 'requestSideHandler',
  status: 'nothing',
  question: 'nothing',
  thinking: 'nothing',
  toolResult: 'nothing',
  subagentStatus: 'nothing',
  apiError: 'telegramHandler',
  noResponse: 'telegramHandler',
  questionGone: 'nothing',
  closed: 'requestSideHandler',
  started: 'nothing',
  stopped: 'requestSideHandler',
  error: 'requestSideHandler',
};

function getRanHandler(key: typeof topicKey, eventName: AdapterEventName): string {
  const ran: string[] = [];
  dispatchAdapterEvent(key, eventName, () => ran.push('telegramHandler'), () => ran.push('requestSideHandler'));
  assert.ok(ran.length <= 1, `${eventName}: at most one handler runs`);
  return ran[0] ?? 'nothing';
}

describe('dispatchAdapterEvent (R2)', () => {
  it('a Telegram conversation runs the Telegram handler of every event', () => {
    for (const eventName of adapterEventNames) assert.equal(getRanHandler(topicKey, eventName), 'telegramHandler', eventName);
  });

  it('a Jira conversation runs only what its request needs, event by event', () => {
    for (const eventName of adapterEventNames) {
      assert.equal(getRanHandler(issueKey, eventName), expectedJiraRoutes[eventName], eventName);
    }
  });

  it('every event the adapters are wired for has a route', () => {
    const wiring = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'createAdapter.ts'), 'utf8');
    const wiredEvents = [...wiring.matchAll(/adapter\.on\('([A-Za-z]+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(wiredEvents, [...adapterEventNames].sort());
  });
});

describe('the send queue refuses a Jira conversation (R2)', () => {
  it('never runs the operation, and rejects like a failed Telegram call', async () => {
    let calls = 0;
    const operation = async (): Promise<string> => { calls += 1; return 'sent'; };

    await assert.rejects(enqueueSend(issueKey, operation), ForeignKeySendRefusedError);
    await assert.rejects(sendUnpaced(issueKey, operation), ForeignKeySendRefusedError);
    assert.equal(calls, 0);
  });

  it('a fire-and-forget refusal raises no unhandled rejection (that would end the process)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      void enqueueSend(issueKey, async () => 'sent');
      void sendUnpaced(issueKey, async () => 'sent');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe('getClaudePlatformToolFlags (R1)', () => {
  it('turns the native question off outside Telegram, and only there', () => {
    assert.deepEqual(getClaudePlatformToolFlags(issueKey), ['--disallowedTools', 'AskUserQuestion']);
    assert.deepEqual(getClaudePlatformToolFlags(topicKey), []);
  });
});
