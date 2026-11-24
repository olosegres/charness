/**
 * @description The model's narration to the user arrives in THINKING blocks under the `updates` thinking display (Claude Code
 * 2.1.304, Opus 5.5): the reasoning block streams no text, the narration block streams the sentences the user must read — e.g.
 * the explanation written right before an `AskUserQuestion`. The json-stream adapter must emit them as answer `output`, never
 * as `thinking` (the topic's thinking display hides that behind a placeholder and deletes it). The frames below are the recorded
 * shape of such a turn, read through the real `stdout.jsonl` tail; a thinking block without that display stays thinking.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999555, 7);
const messageId = 'msg_narration';
const narration = ['The issue has no assignee and the comment ', 'mentions nobody, so the agent never saw it.', '\n\n'];

function buildLine(frame: Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}

function buildBlockStart(index: number, block: Record<string, unknown>, thinkingDisplay: string | null): string {
  return buildLine({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: block },
    parent_tool_use_id: null,
    ...(thinkingDisplay === null ? {} : { thinking_display: thinkingDisplay }),
    api_message_id: messageId,
  });
}

function buildThinkingDelta(index: number, thinking: string, thinkingDisplay: string | null): string {
  return buildLine({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking, estimated_tokens: null } },
    parent_tool_use_id: null,
    ...(thinkingDisplay === null ? {} : { thinking_display: thinkingDisplay }),
    api_message_id: messageId,
  });
}

/** One turn: an empty reasoning block, the narration block, then the question — as the CLI writes it. */
function buildNarratedQuestionTurn(thinkingDisplay: string | null): string {
  return [
    buildBlockStart(0, { type: 'thinking', thinking: '', signature: '' }, thinkingDisplay),
    buildLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null, api_message_id: messageId }),
    buildBlockStart(1, { type: 'thinking', thinking: '', signature: '' }, thinkingDisplay),
    ...narration.map((part) => buildThinkingDelta(1, part, thinkingDisplay)),
    buildLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, parent_tool_use_id: null, api_message_id: messageId }),
    buildLine({
      type: 'assistant',
      message: {
        id: messageId,
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'thinking', thinking: narration.join(''), signature: 'sig' },
          { type: 'tool_use', id: 'toolu_question', name: 'AskUserQuestion', input: { questions: [] } },
        ],
      },
      parent_tool_use_id: null,
    }),
  ].join('');
}

function createAdapterWithSession(dir: string): { adapter: ClaudeJsonStreamAdapter; outputs: string[]; thinking: string[]; stdoutFile: string } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({ key, sessionId: 'sess-narration', paths: getJsonStreamSessionPaths(dir) });
  adapter['sessions'].set(keyToString(key), session);
  const outputs: string[] = [];
  const thinking: string[] = [];
  adapter.on('output', (_key: SessionKey, text: string) => outputs.push(text));
  adapter.on('thinking', (_key: SessionKey, payload: { text: string }) => thinking.push(payload.text));
  return { adapter, outputs, thinking, stdoutFile: session.paths.stdoutFile };
}

describe('claude-json-stream narration in thinking blocks', () => {
  let dir: string;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-narration-'));
  });
  afterEach(() => {
    mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the narration written before a question reaches the user as output, whole, and nothing of it is thinking', () => {
    const { adapter, outputs, thinking, stdoutFile } = createAdapterWithSession(dir);
    fs.writeFileSync(stdoutFile, buildNarratedQuestionTurn('updates'));

    // The bot lands the pending output before it posts the question (`flushPendingOutput`): the tail is read and emitted.
    adapter.flushPendingOutput(key);

    assert.equal(outputs.join(''), narration.join(''));
    assert.deepEqual(thinking.filter((text) => text.length > 0), [], 'no narration went out as thinking');
  });

  it('thinking text without the `updates` display stays thinking', () => {
    const { adapter, outputs, thinking, stdoutFile } = createAdapterWithSession(dir);
    fs.writeFileSync(stdoutFile, buildNarratedQuestionTurn(null));

    adapter.flushPendingOutput(key);
    mock.timers.tick(400);

    assert.deepEqual(outputs, []);
    assert.equal(thinking.at(-1), narration.join(''));
  });
});
