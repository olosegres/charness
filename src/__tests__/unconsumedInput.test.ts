/**
 * @description `checkHasUnconsumedInput` — whether the backend has TAKEN IN the
 * input the bot wrote — on the two backends that can tell, driven through the
 * real adapters' input and event paths. The wake-up engine counts a turn end
 * only once this is false (request/answer core S4: a message written mid-turn
 * is read only when the running turn takes it in, measured on Claude Code
 * 2.1.287: echoed ~5 s after it was written, then merged into that turn).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';
import { useStubbedOpenCodeServer } from './openCodeServerStub';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const openCodeServer = useStubbedOpenCodeServer();

const key: SessionKey = makeTelegramKey(-100999444, 7);
const userEchoLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'the request' } })}\n`;
const skillLoadLine = `${JSON.stringify({
  type: 'user',
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/user/skills/review' }] },
})}\n`;
const subagentPromptLine = `${JSON.stringify({
  type: 'user',
  parent_tool_use_id: 'toolu_task1',
  message: { role: 'user', content: [{ type: 'text', text: 'You are the reviewer of this diff.' }] },
})}\n`;
const toolResultLine = `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
})}\n`;

describe('Claude json-stream: unconsumed input', () => {
  function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession } {
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createStreamSessionFixture({ key, workDir: '/tmp/json-unconsumed', sessionId: 'sess-unconsumed' });
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

  it('a user line the CLI produced itself (skill load, sub-agent prompt) does not take our message in', () => {
    const { adapter, session } = createAdapter();
    adapter.sendInput(key, 'the request');
    session.isBusy = false;

    adapter['onStdout'](session, skillLoadLine);
    adapter['onStdout'](session, subagentPromptLine);

    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'still waiting for the echo of our own message');
    assert.equal(adapter.checkIsBusy(key), false);
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
    adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({
      key,
      sessionId: ownSessionId,
      workDir,
      isModelInfoShown: true,
      currentModelLabel: 'anthropic/claude',
    }));
    // Neither the HTTP call nor the fallback rename is under test.
    openCodeServer.answerApiWith(() => undefined);
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

  it('a prompt whose POST failed stops counting as unconsumed', async () => {
    const adapter = createAdapter();
    openCodeServer.answerApiWith(() => { throw new Error('connection refused'); });
    // The adapter reports the failed send as an `error` event; unheard, emit would throw.
    adapter.on('error', () => {});

    adapter.sendInput(key, 'first');
    assert.equal(adapter.checkHasUnconsumedInput(key), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(adapter.checkHasUnconsumedInput(key), false, 'a prompt OpenCode never accepted is not waiting');
  });

  it('a user message of a sub-agent child session does not count', () => {
    const adapter = createAdapter();
    adapter.sendInput(key, 'first');

    feedUserMessage(adapter, 'msg_child_user', 'ses_child');

    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });
});
