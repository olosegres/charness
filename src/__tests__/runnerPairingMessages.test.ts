/**
 * @description `connectors/telegram/runnerPairingMessages.ts`: the instance's own record of the pairing messages it has sent and not yet
 * settled — a round trip through its file, an entry per code, a missing file is empty, a file that does not validate reads as empty and
 * says why (the next write replaces it), and the record is bounded.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addPairingMessage, readPairingMessages, removePairingMessages, writePairingMessages, type PairingMessage } from '../connectors/telegram/runnerPairingMessages';

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

  it('what is written is read back, the file is owner-only, and a second entry for the same code replaces the first', () => {
    addPairingMessage(filePath, createMessage());
    addPairingMessage(filePath, createMessage({ pairId: 'ba9876543210', messageId: 43 }));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => message.pairId), ['0123456789ab', 'ba9876543210']);
    addPairingMessage(filePath, createMessage({ messageId: 99 }));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => [message.pairId, message.messageId]), [['ba9876543210', 43], ['0123456789ab', 99]]);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });

  it('removing takes out the named codes only, and nothing named is no change', () => {
    addPairingMessage(filePath, createMessage());
    addPairingMessage(filePath, createMessage({ pairId: 'ba9876543210' }));
    removePairingMessages(filePath, new Set(['0123456789ab', 'ffffffffffff']));
    assert.deepEqual(readPairingMessages(filePath).messages.map((message) => message.pairId), ['ba9876543210']);
    removePairingMessages(filePath, new Set());
    assert.equal(readPairingMessages(filePath).messages.length, 1);
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

  it('keeps the newest fifty entries only', () => {
    const many = Array.from({ length: 60 }, (_value, index) => createMessage({ pairId: index.toString(16).padStart(12, '0'), messageId: index + 1 }));
    writePairingMessages(filePath, many);
    const kept = readPairingMessages(filePath).messages;
    assert.equal(kept.length, 50);
    assert.equal(kept[0].messageId, 11);
    assert.equal(kept.at(-1)?.messageId, 60);
  });
});
