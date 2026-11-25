/**
 * @description The `turnEnded` event carries what the adapter knows at that moment and the bot cannot read afterwards: whether input
 * written by the bot is still on its way, i.e. the next turn's. The bot marks the boundary of that turn from it
 * (`handleAgentTurnEnded`, `checkShouldMarkNewMessageAfterTurnEnd`): without it the next turn's first text is appended to the ending
 * turn's last text.
 *
 * A turn that ended in an error keeps its queue (the CLI runs a message queued behind a failed turn as its next turn), so the reading
 * says input is on its way after it too — or the next turn's first text would be glued to the error line. A turn's end leaves marked
 * entries (taken in by that turn, in a shape nothing matches) out of the reading, as it drops them.
 *
 * Frames are the shapes of the CLI's stream-json; the FIFO write is the adapter's test seam, no `claude` process is involved.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { TurnEndedEvent } from '../types';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999666, 82);

const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-turn-ended', model: 'fake-model' }) + '\n';
const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true }) + '\n';
const resultFrame = (isError: boolean): string => JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: isError ? '' : 'done' }) + '\n';

const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
});

function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; turnEnds: Array<TurnEndedEvent | undefined> } {
  const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
  const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'sess-turn-ended' });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  const turnEnds: Array<TurnEndedEvent | undefined> = [];
  adapter.on('turnEnded', (_key: SessionKey, event?: TurnEndedEvent) => turnEnds.push(event));
  return { adapter, session, turnEnds };
}

describe('json-stream adapter — the turnEnded event says whether input is on its way', () => {
  it('a message written while the turn ran and not echoed yet is on its way at the turn\'s end', async () => {
    const { adapter, session, turnEnds } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first'));
    await adapter.sendInputAndWait(key, 'second');
    adapter['onStdout'](session, resultFrame(false));
    assert.deepEqual(turnEnds, [{ hasInputOnItsWay: true }]);
  });

  it('after a turn that ended in an ERROR the message queued behind it is still on its way (the error keeps the queue for the next turn)', async () => {
    const { adapter, session, turnEnds } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first'));
    await adapter.sendInputAndWait(key, 'second');
    adapter['onStdout'](session, resultFrame(true));
    assert.deepEqual(turnEnds, [{ hasInputOnItsWay: true }]);
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'the error kept the queue: the CLI runs that message as its next turn');
  });

  it('nothing is on its way when the turn took in every message it was written, or none was queued', async () => {
    const { adapter, session, turnEnds } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first') + resultFrame(false));
    await adapter.sendInputAndWait(key, 'second');
    adapter['onStdout'](session, initFrame + echoFrame('second') + resultFrame(true));
    assert.deepEqual(turnEnds, [{ hasInputOnItsWay: false }, { hasInputOnItsWay: false }]);
  });
});
