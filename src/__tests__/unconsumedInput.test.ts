/**
 * @description `checkHasUnconsumedInput` — whether the backend has TAKEN IN the
 * input the bot wrote — on the two backends that can tell, driven through the
 * real adapters' input and event paths. The wake-up engine counts a turn end
 * only once this is false (request/answer core S4: a message written mid-turn
 * is read only when the running turn takes it in, measured on Claude Code
 * 2.1.287: echoed ~5 s after it was written, then merged into that turn).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const key: SessionKey = makeTelegramKey(-100999444, 7);
const userEchoLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'the request' } })}\n`;
const toolResultLine = `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
})}\n`;

describe('Claude json-stream: unconsumed input', () => {
  function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: Record<string, unknown> } {
    const adapter = new ClaudeJsonStreamAdapter();
    const session: Record<string, unknown> = {
      key,
      workDir: '/tmp/json-unconsumed',
      sessionId: 'sess-unconsumed',
      reader: new ClaudeStreamLineReader(),
      isActive: true,
      isBusy: false,
      unconsumedInputCount: 0,
      currentResponseText: '',
      emittedLength: 0,
      lastWatermarkOffset: -1,
      outstandingToolUseIds: new Set(),
      questionToolUseIds: new Set(),
      toolNamesById: new Map(),
    };
    adapter['sessions'].set(keyToString(key), session);
    // The FIFO write is the transport, not what is under test.
    adapter['writeStdin'] = () => {};
    return { adapter, session };
  }

  it('a written message stays unconsumed until Claude echoes it, and the echo marks the turn busy', () => {
    const { adapter, session } = createAdapter();

    adapter.sendInput(key, 'the request');
    assert.equal(adapter.checkHasUnconsumedInput(key), true);

    // An earlier turn's end clears busy while our message still waits.
    session.isBusy = false;
    adapter['onStdout'](session, userEchoLine);

    assert.equal(adapter.checkHasUnconsumedInput(key), false);
    assert.equal(adapter.checkIsBusy(key), true, 'the echo starts the turn that carries our message');
  });

  it('a tool result fed back to the model is not an echo of our input', () => {
    const { adapter, session } = createAdapter();
    adapter.sendInput(key, 'the request');

    adapter['onStdout'](session, toolResultLine);

    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });

  it('an echo with nothing outstanding (replayed after a restart) never goes negative', () => {
    const { adapter, session } = createAdapter();
    adapter['onStdout'](session, userEchoLine);
    adapter.sendInput(key, 'the next request');

    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });
});

describe('OpenCode: unconsumed input', () => {
  const ownSessionId = 'ses_own';
  const workDir = '/tmp/opencode-unconsumed';

  function createAdapter(): OpenCodeAdapter {
    const adapter = new OpenCodeAdapter();
    adapter['sessions'].set(keyToString(key), {
      key,
      sessionId: ownSessionId,
      workDir,
      isActive: true,
      currentResponseText: '',
      lastEmittedLength: 0,
      childResponseText: '',
      childLastEmittedLength: 0,
      emittedToolResultPartIds: new Set(),
      outputTimer: null,
      isModelInfoShown: true,
      modelOverride: null,
      currentModelLabel: 'anthropic/claude',
      partTypes: new Map(),
      statusDebounceTimer: null,
      pendingStatus: null,
      pendingQuestion: null,
      effortLevel: null,
      isBusy: false,
      awaitingTurnResponse: false,
      sawTurnActivity: false,
      unconsumedInputCount: 0,
      seenUserMessageIds: new Set(),
      providerRetrySignature: null,
      isAwaitingModelAfterProviderRetryAbort: false,
      providerRetryAbortPromise: null,
      isCompacting: false,
      busyChildSessionIds: new Set(),
      lastMessageId: undefined,
      sseController: null,
      reconnectTimer: null,
      sseStallTimer: null,
    });
    // Neither the HTTP call nor the fallback rename is under test.
    adapter['apiRequest'] = async () => undefined;
    adapter['maybeScheduleFallbackRename'] = () => {};
    return adapter;
  }

  function feedUserMessage(adapter: OpenCodeAdapter, messageId: string, sessionId = ownSessionId): void {
    adapter['routeSseData'](JSON.stringify({
      directory: workDir,
      project: 'proj',
      payload: { type: 'message.updated', properties: { info: { id: messageId, sessionID: sessionId, role: 'user' } } },
    }));
  }

  it('a sent prompt stays unconsumed until its user message shows up, counted once per id', () => {
    const adapter = createAdapter();
    adapter.sendInput(key, 'first');
    adapter.sendInput(key, 'second');
    assert.equal(adapter.checkHasUnconsumedInput(key), true);

    feedUserMessage(adapter, 'msg_user_1');
    feedUserMessage(adapter, 'msg_user_1'); // re-sent update of the same message
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'one of two prompts is still waiting');

    feedUserMessage(adapter, 'msg_user_2');
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
  });

  it('a user message of a sub-agent child session does not count', () => {
    const adapter = createAdapter();
    adapter.sendInput(key, 'first');

    feedUserMessage(adapter, 'msg_child_user', 'ses_child');

    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });
});
