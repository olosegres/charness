/**
 * @description Unit coverage for OpenCode's resume context source:
 *   - `mapOpenCodeMessagesToTurns` (pure mapper of GET /session/:id/message)
 *   - `OpenCodeAdapter.getRecentTurns` (the same mapper behind a stubbed
 *     server, plus the failure → [] guard).
 *
 * A message record is `{ info:{ role }, parts:[ {type:'text',text} | tool | step ] }`,
 * the same `parts` shape the SSE `message.part.updated` path handles. The
 * mapper joins text parts, skips tool/step/empty parts and non-user/assistant
 * roles, and keeps the last `limit` turns chronologically.
 *
 * Harness mirrors openCodeModelInfo.test.ts: the server's API is answered at the
 * stubbed HTTP boundary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFirstOpenCodeParentAssistantCallTokens,
  getLatestOpenCodeParentAssistantContext,
  OpenCodeAdapter,
  mapOpenCodeMessagesToTurns,
} from '../adapters/openCodeAdapter';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { OpenCodeApiFailure, useStubbedOpenCodeServer } from './openCodeServerStub';

const openCodeServer = useStubbedOpenCodeServer();

const limit = 3;
const key: SessionKey = makeTelegramKey(-100222333, 444);
const sessionId = 'ses_recent_turns';

describe('mapOpenCodeMessagesToTurns', () => {
  it('returns [] for a non-array payload', () => {
    assert.deepEqual(mapOpenCodeMessagesToTurns(null, limit), []);
    assert.deepEqual(mapOpenCodeMessagesToTurns({}, limit), []);
  });

  it('maps text parts, skips tool/step/empty, joins multi-text, keeps last 3', () => {
    const records = [
      // Older than the window — dropped by the last-3 cap.
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'oldest user' }] },
      // tool + step parts are skipped; the two text parts are concatenated.
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'answer A' },
          { type: 'tool', tool: 'bash', state: { status: 'completed' } },
          { type: 'text', text: 'answer B' },
        ],
      },
      // An assistant record with ONLY a tool part → no text → not a turn.
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'second user' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'final answer' }] },
    ];

    const turns = mapOpenCodeMessagesToTurns(records, limit);

    // Last 3 renderable turns, chronological. The tool-only assistant and the
    // oldest user (over the cap) are excluded.
    assert.deepEqual(turns, [
      { role: 'assistant', text: 'answer A\n\nanswer B' },
      { role: 'user', text: 'second user' },
      { role: 'assistant', text: 'final answer' },
    ]);
  });

  it('skips records whose role is neither user nor assistant', () => {
    const records = [
      { info: { role: 'system' }, parts: [{ type: 'text', text: 'system note' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'real user' }] },
    ];
    assert.deepEqual(mapOpenCodeMessagesToTurns(records, limit), [{ role: 'user', text: 'real user' }]);
  });
});

describe('getLatestOpenCodeParentAssistantContext', () => {
  it('selects the newest valid parent assistant context and ignores foreign or malformed entries', () => {
    const records = [
      {
        info: {
          id: 'msg_foreign',
          sessionID: 'ses_child',
          role: 'assistant',
          tokens: { input: 900, cache: { read: 50, write: 25 } },
        },
      },
      {
        info: {
          id: 'msg_previous',
          sessionID: sessionId,
          role: 'assistant',
          tokens: { input: 120, cache: { read: 30, write: 5 } },
        },
      },
      {
        info: {
          id: 'msg_malformed',
          sessionID: sessionId,
          role: 'assistant',
          tokens: { input: 200, cache: { read: 'wrong', write: 5 } },
        },
      },
      {
        info: {
          id: 'msg_latest',
          sessionID: sessionId,
          role: 'assistant',
          tokens: { input: 400, cache: { read: 50, write: 25 } },
        },
      },
    ];

    assert.deepEqual(getLatestOpenCodeParentAssistantContext(records, sessionId), {
      messageId: 'msg_latest',
      contextUsedTokens: 475,
    });
  });

  it('returns null when no parent assistant entry has a complete valid token total', () => {
    const records = [
      { info: { id: 'msg_missing_input', sessionID: sessionId, role: 'assistant', tokens: { cache: { read: 1 } } } },
      { info: { id: 'msg_fraction', sessionID: sessionId, role: 'assistant', tokens: { input: 1.5 } } },
      { info: { id: 'msg_negative', sessionID: sessionId, role: 'assistant', tokens: { input: 3, cache: { write: -1 } } } },
    ];

    assert.equal(getLatestOpenCodeParentAssistantContext(records, sessionId), null);
  });

  it('keeps the valid parent context when a later record is an aborted turn', () => {
    const records = [
      {
        info: {
          id: 'msg_valid',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'provider',
          modelID: 'model',
          tokens: { input: 120, cache: { read: 30, write: 5 } },
        },
      },
      {
        info: {
          id: 'msg_aborted',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'stale-provider',
          modelID: 'stale-model',
          tokens: { input: 900, cache: { read: 50, write: 25 } },
          error: { data: { message: 'Aborted' } },
        },
      },
    ];

    assert.deepEqual(getLatestOpenCodeParentAssistantContext(records, sessionId), {
      messageId: 'msg_valid',
      model: { providerID: 'provider', modelID: 'model' },
      contextUsedTokens: 155,
    });
  });

  it('keeps the last measured context when a pending assistant placeholder reports zero tokens', () => {
    const records = [
      {
        info: {
          id: 'msg_measured',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-test',
          finish: 'tool-calls',
          tokens: { input: 1_087, output: 17, cache: { read: 181_760, write: 0 } },
        },
      },
      {
        info: {
          id: 'msg_pending',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-test',
          finish: null,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    ];

    assert.deepEqual(getLatestOpenCodeParentAssistantContext(records, sessionId), {
      messageId: 'msg_measured',
      model: { providerID: 'openai', modelID: 'gpt-test' },
      contextUsedTokens: 182_864,
    });
  });
});

describe('OpenCodeAdapter.getRecentTurns', () => {
  it('GET /session/:id/message → mapped turns (last 3, tool/step skipped)', async () => {
    const adapter = new OpenCodeAdapter();
    let requestedPath = '';
    openCodeServer.answerApiWith(({ urlPath }) => {
      requestedPath = urlPath;
      return [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q1' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'text', text: 'a1' }] },
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q2' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a2' }] },
      ];
    });

    const turns = await adapter.getRecentTurns(key, '/tmp/work', sessionId, limit);

    assert.equal(requestedPath, `/session/${sessionId}/message`);
    assert.deepEqual(turns, [
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ]);
  });

  it('a failing API request yields [] (no context block, never throws)', async () => {
    const adapter = new OpenCodeAdapter();
    openCodeServer.answerApiWith(() => {
      throw new OpenCodeApiFailure(503, 'server unavailable');
    });
    const turns = await adapter.getRecentTurns(key, '/tmp/work', sessionId, limit);
    assert.deepEqual(turns, []);
  });
});

describe('getFirstOpenCodeParentAssistantCallTokens', () => {
  const assistant = (id: string, tokens: object, extra: Record<string, unknown> = {}) => ({ info: { id, sessionID: sessionId, role: 'assistant', finish: 'stop', tokens, ...extra } });

  it('is the first parent call AFTER the newest summary — input + cache, not the output, not the turn\'s later calls, not the older epoch', () => {
    const records = [
      assistant('msg_old', { input: 10, cache: { read: 500_000, write: 0 } }),
      assistant('msg_summary_old', { input: 20, cache: { read: 90_000 } }, { summary: true }),
      assistant('msg_older_epoch_first', { input: 30, cache: { read: 40_000 } }),
      assistant('msg_summary', { input: 50, cache: { read: 400_000 }, output: 3_000 }, { summary: true }),
      assistant('msg_first', { input: 3, cache: { read: 21_000, write: 1_000 }, output: 400 }),
      assistant('msg_last', { input: 5, cache: { read: 90_000, write: 2_000 }, output: 1_200 }),
    ];
    assert.equal(getFirstOpenCodeParentAssistantCallTokens(records, sessionId), 22_003);
  });

  it('is the first call of the history when it was never compacted; foreign, malformed, aborted and pending records are no call of it', () => {
    const records = [
      { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant', finish: 'stop', tokens: { input: 7, cache: { read: 99_999 } } } },
      assistant('msg_malformed', { input: 8, cache: { read: 'wrong' } }),
      assistant('msg_pending', { input: 0, cache: { read: 0, write: 0 }, output: 0 }, { finish: '' }),
      assistant('msg_first', { input: 2, cache: { read: 30_000, write: 8_000 } }),
      assistant('msg_next', { input: 6, cache: { read: 60_000 } }),
    ];
    assert.equal(getFirstOpenCodeParentAssistantCallTokens(records, sessionId), 38_002);
  });

  it('is null right after a compaction (no call yet) and for a payload that is no history', () => {
    assert.equal(getFirstOpenCodeParentAssistantCallTokens([assistant('msg_a', { input: 1, cache: { read: 1_000 } }), assistant('msg_summary', { input: 5, cache: { read: 9_000 } }, { summary: true })], sessionId), null);
    assert.equal(getFirstOpenCodeParentAssistantCallTokens({ not: 'an array' }, sessionId), null);
    assert.equal(getFirstOpenCodeParentAssistantCallTokens([], sessionId), null);
  });
});
