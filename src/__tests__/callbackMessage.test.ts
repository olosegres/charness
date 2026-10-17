/**
 * @description The key of a per-MESSAGE snapshot (`connectors/telegram/commands/callbackMessage.ts`): a Telegram message
 * id is unique only within one chat, so two chats' messages with the same id must never share a snapshot.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageSnapshotKey } from '../connectors/telegram/commands/callbackMessage';
import type { SessionKey } from '../sessionKey';

const firstChat: SessionKey = { platform: 'telegram', space: '-1001111111111', thread: '111' };
const secondChat: SessionKey = { platform: 'telegram', space: '-1002222222222', thread: '111' };

describe('buildMessageSnapshotKey', () => {
  it('is the same for the same chat and message, whichever topic of the chat asks', () => {
    assert.equal(buildMessageSnapshotKey(firstChat, 7), buildMessageSnapshotKey({ ...firstChat, thread: '112' }, 7));
  });

  it('differs between chats that reuse a message id, and between messages of one chat', () => {
    assert.notEqual(buildMessageSnapshotKey(firstChat, 7), buildMessageSnapshotKey(secondChat, 7));
    assert.notEqual(buildMessageSnapshotKey(firstChat, 7), buildMessageSnapshotKey(firstChat, 8));
  });

  it('keeps a chat id and a message id apart (no "1:23" against "12:3")', () => {
    assert.notEqual(buildMessageSnapshotKey({ ...firstChat, space: '1' }, 23), buildMessageSnapshotKey({ ...firstChat, space: '12' }, 3));
  });
});
