/**
 * @description The OpenCode adapter's reading of what the conversation weighs now (`getContextUsedTokens`) around a compaction. The
 * summary message the server writes carries the input of the WHOLE pre-compaction context; it is the compaction's own call, never a
 * figure of the conversation afterwards. So between the summary and the next model call there is no figure — `null` — and the idle
 * compaction, which measures growth from the epoch's first call, is not shown the old, full context as «what the conversation weighs
 * now» (it would compact a conversation the server had just compacted by itself).
 *
 * Harness mirrors openCodeOwnCompactionCount.test.ts: a session is injected, real `/global/event` envelopes go through `routeSseData`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const ownSessionId = 'ses_context_used';
const key = makeTelegramKey(-100999222, 557);
const workDir = '/tmp/work';

function createAdapter(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: ownSessionId, workDir, isModelInfoShown: true, currentModelLabel: 'anthropic/claude' }));
  return adapter;
}

/** A finished parent assistant message: `input` is what the call saw, `output` what it wrote. */
function feedAssistantMessage(adapter: OpenCodeAdapter, message: { id: string; input: number; output: number; isSummary?: boolean }): void {
  const info = {
    id: message.id,
    role: 'assistant',
    sessionID: ownSessionId,
    finish: 'stop',
    providerID: 'anthropic',
    modelID: 'claude',
    tokens: { input: message.input, output: message.output, cache: { read: 0, write: 0 } },
    ...(message.isSummary ? { summary: true } : {}),
  };
  adapter['routeSseData'](JSON.stringify({ directory: workDir, project: 'proj', payload: { type: 'message.updated', properties: { info } } }));
}

describe('OpenCode context in use around a compaction', () => {
  it('the summary message of a compaction is no reading of the conversation: there is none until the next model call', async () => {
    const adapter = createAdapter();
    assert.equal(await adapter.getContextUsedTokens(key), null, 'no call yet');

    feedAssistantMessage(adapter, { id: 'msg_before', input: 120_000, output: 500 });
    assert.equal(await adapter.getContextUsedTokens(key), 120_500, 'an ordinary call: its input and output');

    // The server compacts by itself: the summary message saw the whole old context (~150 000) and wrote the summary.
    feedAssistantMessage(adapter, { id: 'msg_summary', input: 150_000, output: 4_000, isSummary: true });
    assert.equal(await adapter.getContextUsedTokens(key), null, 'the compaction\'s own call is not what the conversation weighs afterwards');

    feedAssistantMessage(adapter, { id: 'msg_after', input: 21_000, output: 300 });
    assert.equal(await adapter.getContextUsedTokens(key), 21_300, 'the next model call is the first figure of the new epoch');
  });
});
