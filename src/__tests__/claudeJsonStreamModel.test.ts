/**
 * @description The json-stream backend must be able to NAME the model it runs.
 * `/status` and the pinned banner read `getCurrentModel`, which used to return
 * only the explicit `--model` spawn pick — and that pick is `null` on every
 * default start, every resume, and every boot-time adopt, so a topic on the
 * default backend showed no model at all (user report 2026-08-23).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - claude's own `system/init` carries the RESOLVED model id and is the only
 *   report of the live model; driving a real init line through the adapter's
 *   stdout path must make `getCurrentModel` name it;
 * - the reported id must NOT leak into the re-spawn pick (`session.model`),
 *   which is replayed verbatim as `--model` on an effort/model re-spawn —
 *   overwriting it would silently pin a session that asked for no model to one
 *   frozen snapshot;
 * - the pick still answers during the window between a `/model` re-spawn and
 *   its first `init`, so the label never blanks out mid-switch.
 *
 * Private members are reached via bracket access, same pattern as
 * claudeJsonStreamWatermarkAdvance.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999222, 77);
const resolvedModel = 'claude-opus-4-5-20251101';

/** A real `system/init` line as claude emits it at session start (and on resume). */
const initLine =
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: '6761fcd2-bb5d-4dae-a1a0-deeba28a6bc6',
    model: resolvedModel,
    apiKeySource: 'none',
    tools: ['Task', 'AskUserQuestion', 'Bash'],
  }) + '\n';

function createAdapterWithSession(pickedModel: string | null): { adapter: ClaudeJsonStreamAdapter; session: StreamSession } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({
    key,
    workDir: '/tmp/jsonstream-model-work',
    sessionId: 'sess-json-model',
    model: pickedModel,
  });
  adapter['sessions'].set(keyToString(key), session);
  return { adapter, session };
}

describe('claude-json-stream current model', () => {
  it('names the model claude reports when no explicit pick was made', () => {
    const { adapter, session } = createAdapterWithSession(null);
    // Pre-fix this stayed null for the whole session — the reported bug.
    assert.equal(adapter.getCurrentModel(key), null, 'nothing is known before init arrives');

    adapter['onStdout'](session, initLine);

    assert.equal(adapter.getCurrentModel(key), resolvedModel);
  });

  it('keeps the re-spawn pick empty so a default session is never pinned to a snapshot', () => {
    const { adapter, session } = createAdapterWithSession(null);

    adapter['onStdout'](session, initLine);

    assert.equal(
      session.model,
      null,
      'the reported id must not become the --model flag of the next effort re-spawn',
    );
  });

  it('answers with the pick until init lands, then with the resolved id', () => {
    const { adapter, session } = createAdapterWithSession('opus');
    assert.equal(adapter.getCurrentModel(key), 'opus', 'the label holds through a /model re-spawn');

    adapter['onStdout'](session, initLine);

    assert.equal(adapter.getCurrentModel(key), resolvedModel, 'the live report wins once known');
  });

  it('reports nothing for a thread with no session', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    assert.equal(adapter.getCurrentModel(key), null);
  });
});
