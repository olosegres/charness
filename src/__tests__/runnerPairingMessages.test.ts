/**
 * @description `connectors/telegram/runnerPairingMessages.ts`: the instance's own record of the pairing messages it has sent and not yet
 * settled — a round trip through its file, an entry per MESSAGE (a code is offered in one; a record of the older version, which offered it in two, holds two), a missing file is empty, a file that does not validate reads as empty and
 * says why (the next write replaces it), and the record is bounded.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addPairingMessage, getPairingMessageId, markPairingMessageFailed, readPairingMessages, removePairingMessages, writePairingMessages, type PairingMessage } from '../connectors/telegram/runnerPairingMessages';

let tempDir = '';
let filePath = '';

function createMessage(overrides: Partial<PairingMessage> = {}): PairingMessage {
  return { pairId: '0123456789ab', key: '-1001111111111:1', messageId: 42, offeredAtMs: 1_000, ...overrides };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnr-pm-'));
  filePath = path.join(tempDir, 'runner-pairing-messages.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runnerPairingMessages', () => {
  it('a missing file is an empty record with no problem', () => {
    assert.deepEqual(readPairingMessages(filePath), { messages: [], problem: null });
  });

  it('what is written is read back, the file is owner-only, the messages of one code (an older version made two) are all kept and the same message again replaces itself', () => {
    addPairingMessage(filePath, createMessage());
    addPairingMessage(filePath, createMessage({ messageId: 43 }));
    addPairingMessage(filePath, createMessage({ pairId: 'ba9876543210', messageId: 44 }));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => [message.pairId, message.messageId]), [['0123456789ab', 42], ['0123456789ab', 43], ['ba9876543210', 44]]);
    addPairingMessage(filePath, createMessage({ messageId: 42, offeredAtMs: 2_000 }));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => [message.pairId, message.messageId, message.offeredAtMs]), [['0123456789ab', 43, 1_000], ['ba9876543210', 44, 1_000], ['0123456789ab', 42, 2_000]]);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });

  it('a record written by the version that offered a code in two messages (a `role` on each) still validates and is read as it was written', () => {
    const olderRecord = [createMessage({ role: 'first' }), createMessage({ messageId: 43, role: 'second' })];
    fs.writeFileSync(filePath, JSON.stringify({ messages: olderRecord }));
    assert.deepEqual(readPairingMessages(filePath), { messages: olderRecord, problem: null });
    assert.equal(readPairingMessages(filePath).messages.length, 2);
    fs.writeFileSync(filePath, JSON.stringify({ messages: [{ ...createMessage(), role: 'third' }] }));
    assert.equal(readPairingMessages(filePath).problem, `${filePath} is invalid`, 'but only the two roles that existed');
  });

  it('removing takes out the named messages only — one message of a code can go while the other stays — and nothing named is no change', () => {
    addPairingMessage(filePath, createMessage());
    addPairingMessage(filePath, createMessage({ messageId: 43 }));
    addPairingMessage(filePath, createMessage({ pairId: 'ba9876543210', messageId: 44 }));
    removePairingMessages(filePath, new Set([getPairingMessageId({ pairId: '0123456789ab', messageId: 42 }), 'ffffffffffff:1']));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => [message.pairId, message.messageId]), [['0123456789ab', 43], ['ba9876543210', 44]]);
    removePairingMessages(filePath, new Set());
    assert.equal(readPairingMessages(filePath).messages.length, 2);
  });

  it('a file that is not JSON, or does not validate, reads as empty and names the problem; the next write replaces it', () => {
    fs.writeFileSync(filePath, '{ not json');
    assert.deepEqual(readPairingMessages(filePath), { messages: [], problem: `${filePath} is not valid JSON` });
    for (const body of [{ messages: [{ pairId: 'not-an-id', key: '-100:1', messageId: 1, offeredAtMs: 0 }] }, { messages: [{ ...createMessage(), key: 'jira:PROJ-1' }] }, { messages: [{ ...createMessage(), extra: 1 }] }, { other: [] }]) {
      fs.writeFileSync(filePath, JSON.stringify(body));
      assert.deepEqual(readPairingMessages(filePath), { messages: [], problem: `${filePath} is invalid` }, JSON.stringify(body));
    }
    addPairingMessage(filePath, createMessage());
    assert.deepEqual(readPairingMessages(filePath), { messages: [createMessage()], problem: null });
  });

  it('the first failed edit of a message is written down and stays the first; other messages — also the code\'s other one — are not touched; an unknown message changes nothing', () => {
    addPairingMessage(filePath, createMessage());
    addPairingMessage(filePath, createMessage({ messageId: 43 }));
    addPairingMessage(filePath, createMessage({ pairId: 'ba9876543210', messageId: 44 }));
    markPairingMessageFailed(filePath, { pairId: '0123456789ab', messageId: 42 }, 5_000);
    markPairingMessageFailed(filePath, { pairId: '0123456789ab', messageId: 42 }, 9_000);
    markPairingMessageFailed(filePath, { pairId: 'ffffffffffff', messageId: 1 }, 9_000);
    assert.equal(readPairingMessages(filePath).messages.length, 3);
    const byMessage = new Map(readPairingMessages(filePath).messages.map((message) => [getPairingMessageId(message), message.firstFailedAtMs]));
    assert.equal(byMessage.get('0123456789ab:42'), 5_000);
    assert.equal(byMessage.get('0123456789ab:43'), undefined);
    assert.equal(byMessage.get('ba9876543210:44'), undefined);
  });

  it('keeps the newest fifty entries only', () => {
    const many = Array.from({ length: 60 }, (_value, index) => createMessage({ pairId: index.toString(16).padStart(12, '0'), messageId: index + 1 }));
    writePairingMessages(filePath, many);
    const kept = readPairingMessages(filePath).messages;
    assert.equal(kept.length, 50);
    assert.equal(kept[0].messageId, 11);
    assert.equal(kept.at(-1)?.messageId, 60);
  });
});
