/**
 * @description `connectors/telegram/sendOutcome.ts`: what the bot does with each way a send or an edit ends — above all the
 * UNKNOWN outcome of a call the Bot API did not answer within the send queue's deadline, which may or may not have landed and
 * so is never made twice. The output flush's chunk loop (`sendOutputChunks`) is driven with fake ports that record every call.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCallerEditResult, sendOutputChunks, type OutputMessageCursor, type ThreadEditOutcome, type ThreadSendOutcome } from '../connectors/telegram/sendOutcome';

/** Ports that answer each call with the next scripted outcome and record it, in order. */
function createPorts(edits: ThreadEditOutcome[], sends: ThreadSendOutcome[]) {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      editLastMessage: async (messageId: number, chunk: string) => {
        calls.push(`edit #${messageId}: ${chunk}`);
        return edits.shift() ?? 'edited';
      },
      sendChunk: async (chunk: string) => {
        calls.push(`send: ${chunk}`);
        return sends.shift() ?? { kind: 'sent' as const, messageId: 900 };
      },
    },
  };
}

describe('getCallerEditResult', () => {
  it('an edit of unknown outcome counts as made — a caller must not post the content anew', () => {
    assert.equal(getCallerEditResult('unknown'), 'edited');
  });

  it('every other outcome is passed on as it is', () => {
    assert.deepEqual((['edited', 'gone', 'failed'] as const).map(getCallerEditResult), ['edited', 'gone', 'failed']);
  });
});

describe('sendOutputChunks', () => {
  it('a continuation edits the last message, then sends the rest as messages of their own', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: 7, lastMessageText: 'Hello' };
    const { ports, calls } = createPorts([], [{ kind: 'sent', messageId: 8 }]);

    const result = await sendOutputChunks(['Hello world', 'next'], true, cursor, ports);

    assert.deepEqual(calls, ['edit #7: Hello world', 'send: next']);
    assert.deepEqual(result, { unsentRemainder: null });
    assert.deepEqual(cursor, { lastMessageId: 8, lastMessageText: 'next' });
  });

  it('an edit whose outcome is UNKNOWN counts as made: the text is NOT sent fresh (it could appear twice)', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: 7, lastMessageText: 'Hello' };
    const { ports, calls } = createPorts(['unknown'], []);

    const result = await sendOutputChunks(['Hello world'], true, cursor, ports);

    assert.deepEqual(calls, ['edit #7: Hello world'], 'no fresh send of the text');
    assert.deepEqual(result, { unsentRemainder: null });
    assert.deepEqual(cursor, { lastMessageId: 7, lastMessageText: 'Hello world' }, 'the next continuation edits the whole message again');
  });

  it('an edit that FAILED sends every chunk fresh: the full text still reaches the user', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: 7, lastMessageText: 'Hello' };
    const { ports, calls } = createPorts(['gone'], [{ kind: 'sent', messageId: 8 }]);

    await sendOutputChunks(['Hello world'], true, cursor, ports);

    assert.deepEqual(calls, ['edit #7: Hello world', 'send: Hello world']);
  });

  it('a chunk whose outcome is UNKNOWN counts as sent: never sent again, nothing left over, and the next text opens a new message', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: 7, lastMessageText: 'earlier' };
    const { ports, calls } = createPorts([], [{ kind: 'unknown' }, { kind: 'sent', messageId: 9 }]);

    const result = await sendOutputChunks(['first', 'second'], false, cursor, ports);

    assert.deepEqual(calls, ['send: first', 'send: second'], 'each chunk once, and the run goes on');
    assert.deepEqual(result, { unsentRemainder: null });
    assert.deepEqual(cursor, { lastMessageId: 9, lastMessageText: 'second' });
  });

  it('after an UNKNOWN last chunk there is no message to continue', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: 7, lastMessageText: 'earlier' };
    const { ports } = createPorts([], [{ kind: 'unknown' }]);

    await sendOutputChunks(['only'], false, cursor, ports);

    assert.deepEqual(cursor, { lastMessageId: null, lastMessageText: null });
  });

  it('a chunk that FAILED stops the run: it and the rest are the remainder, retryable as the failure says', async () => {
    const cursor: OutputMessageCursor = { lastMessageId: null, lastMessageText: null };
    const retryable = createPorts([], [{ kind: 'sent', messageId: 1 }, { kind: 'failed', isRetryable: true }]);

    assert.deepEqual(await sendOutputChunks(['a', 'b', 'c'], false, cursor, retryable.ports), { unsentRemainder: 'b\n\nc', isRetryable: true });
    assert.deepEqual(retryable.calls, ['send: a', 'send: b'], 'c is not tried after b failed');

    const refused = createPorts([], [{ kind: 'failed', isRetryable: false }]);
    assert.deepEqual(await sendOutputChunks(['x'], false, { lastMessageId: null, lastMessageText: null }, refused.ports), { unsentRemainder: 'x', isRetryable: false });
  });
});
