/**
 * @description A Claude usage limit on the json-stream backend waits for the reset its `rate_limit_event` names (an
 * exact epoch), not for the one parsed out of the error text: that text changes between Claude releases and only some
 * of its wordings parse ("would exceed your account's rate limit" names none). Drives the adapter's private `onStdout`
 * with real stream-json lines; private members are reached via bracket access, as in claudeJsonStreamModel.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import type { AgentApiErrorClass } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-1001111111111, 7);
const msPerSecond = 1000;
const msPerHour = 3600 * msPerSecond;

function toLine(frame: object): string {
  return JSON.stringify(frame) + '\n';
}

/** A `rate_limit_event` as the CLI writes it: `resetsAt` in epoch SECONDS. */
function rateLimitLine(status: string, resetsAtMs: number): string {
  return toLine({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: Math.floor(resetsAtMs / msPerSecond), rateLimitType: 'seven_day' } });
}

function errorResultLine(text: string): string {
  return toLine({ type: 'result', subtype: 'success', is_error: true, result: text });
}

/** A weekly-limit wording the text parser cannot date. */
const undatedLimitText = "You've hit your weekly limit · back on the weekend";

function createAdapterWithSession(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; errors: AgentApiErrorClass[]; sinkStatuses: Array<string | null> } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-limit-reset', sessionId: 'sess-json-limit-reset' });
  adapter['sessions'].set(keyToString(key), session);
  const errors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_key: SessionKey, error: AgentApiErrorClass) => errors.push(error));
  const sinkStatuses: Array<string | null> = [];
  adapter.setClaudeRateLimitSink((_configDir, event) => sinkStatuses.push(event.status));
  return { adapter, session, errors, sinkStatuses };
}

/** The rejected window's reset, whole seconds (what the frame can carry) three days ahead. */
function getRejectedResetAtMs(): number {
  return Math.floor((Date.now() + 72 * msPerHour) / msPerSecond) * msPerSecond;
}

describe('claude-json-stream usage limit: the rejected window\'s reset', () => {
  it('a rejected rate_limit_event is the limit error\'s resetAt, whatever the text says — and still reaches the usage sink', () => {
    const { adapter, session, errors, sinkStatuses } = createAdapterWithSession();
    const resetAtMs = getRejectedResetAtMs();
    adapter['onStdout'](session, rateLimitLine('rejected', resetAtMs));
    adapter['onStdout'](session, errorResultLine(undatedLimitText));
    assert.deepEqual(errors, [{ kind: 'usageLimit', resetAt: resetAtMs }]);
    assert.deepEqual(sinkStatuses, ['rejected']);
  });

  it('the exact reset wins over one the text names, and keeps an unconfirmed wording unconfirmed (the bot confirms it by the profile mark)', () => {
    const textDated = createAdapterWithSession();
    const resetAtMs = getRejectedResetAtMs();
    textDated.adapter['onStdout'](textDated.session, rateLimitLine('rejected', resetAtMs));
    textDated.adapter['onStdout'](textDated.session, errorResultLine("You've hit your session limit · resets in 2h"));
    assert.deepEqual(textDated.errors, [{ kind: 'usageLimit', resetAt: resetAtMs }]);

    const unconfirmed = createAdapterWithSession();
    unconfirmed.adapter['onStdout'](unconfirmed.session, rateLimitLine('rejected', resetAtMs));
    unconfirmed.adapter['onStdout'](unconfirmed.session, errorResultLine("API Error: This request would exceed your account's rate limit. Please try again later."));
    assert.deepEqual(unconfirmed.errors, [{ kind: 'usageLimit', resetAt: resetAtMs, isUnconfirmed: true }]);
  });

  it('an allowed (or warning) frame after the rejection clears it; without one the text alone decides', () => {
    for (const status of ['allowed', 'allowed_warning']) {
      const { adapter, session, errors } = createAdapterWithSession();
      const resetAtMs = getRejectedResetAtMs();
      adapter['onStdout'](session, rateLimitLine('rejected', resetAtMs));
      adapter['onStdout'](session, rateLimitLine(status, resetAtMs + 2 * msPerHour));
      adapter['onStdout'](session, errorResultLine(undatedLimitText));
      assert.deepEqual(errors, [{ kind: 'usageLimit', resetAt: undefined }], status);
    }
  });

  it('a rejected reset already behind now is not used, and an error that is not a usage limit never takes it', () => {
    const stale = createAdapterWithSession();
    stale.adapter['onStdout'](stale.session, rateLimitLine('rejected', Date.now() - msPerHour));
    stale.adapter['onStdout'](stale.session, errorResultLine(undatedLimitText));
    assert.deepEqual(stale.errors, [{ kind: 'usageLimit', resetAt: undefined }]);

    const transient = createAdapterWithSession();
    transient.adapter['onStdout'](transient.session, rateLimitLine('rejected', getRejectedResetAtMs()));
    transient.adapter['onStdout'](transient.session, errorResultLine('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'));
    assert.deepEqual(transient.errors, [{ kind: 'transient' }]);
  });
});
