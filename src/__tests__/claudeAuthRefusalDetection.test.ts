/**
 * @description How a Claude account the CLI refuses is told apart from any other failed turn: the error class (`auth`) and its
 * reason (`signedOut` / `orgDisabled` / `rejected`), off the result's text (`classifyAgentApiError`, `getAuthErrorReason`) and off
 * the CLI's own code on the main thread's `assistant` frame (`authentication_failed`, `oauth_org_not_allowed`), which the
 * json-stream adapter keeps for the turn's end. The frames are the ones Claude Code 2.1.304 wrote for a profile folder with no
 * login: an `assistant` message of model `<synthetic>` with `"error":"authentication_failed"`, then a `result` with
 * `is_error: true`, `api_error_status: null` and the message text, all usage zero.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAgentApiError, getAuthErrorReason } from '../apiErrorRetry';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { classifyClaudeStreamMessage, getClaudeAuthErrorCodeReason } from '../utils/claudeStreamJson';
import type { AgentApiErrorClass } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const fixedNow = Date.parse('2026-11-20T09:00:00.000Z');
const key: SessionKey = makeTelegramKey(-1001111111111, 7);

const notLoggedInText = 'Not logged in · Please run /login';
const orgDisabledText = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

function toLine(frame: object): string {
  return JSON.stringify(frame) + '\n';
}

/** The synthetic assistant message the CLI writes for an API error, carrying its code. */
function errorAssistantLine(code: string, text: string, parentToolUseId: string | null = null): string {
  return toLine({
    type: 'assistant',
    message: { model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }] },
    parent_tool_use_id: parentToolUseId,
    error: code,
    is_api_error_message: true,
  });
}

function errorResultLine(text: string): string {
  return toLine({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: text, terminal_reason: 'api_error' });
}

function createAdapterWithSession(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; errors: AgentApiErrorClass[]; outputs: string[] } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-auth-refusal', sessionId: 'sess-json-auth-refusal' });
  adapter['sessions'].set(keyToString(key), session);
  const errors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_key: SessionKey, error: AgentApiErrorClass) => errors.push(error));
  const outputs: string[] = [];
  adapter.on('output', (_key: SessionKey, text: string) => outputs.push(text));
  return { adapter, session, errors, outputs };
}

describe('classifyAgentApiError: the Claude CLI\'s refusals of an account are `auth`', () => {
  it('every wording the CLI writes for a missing, expired or revoked login, an organization\'s switch, a bare 401 / 403', () => {
    for (const text of [
      notLoggedInText,
      'OAuth token revoked · Please run /login',
      'Login expired · Please run /login',
      'Authentication required · Sign in again to continue',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      orgDisabledText,
      'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}',
      'Your organization has disabled API key authentication · Sign in again with your claude.ai account',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'API Error: 403 Forbidden',
    ]) {
      assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'auth' }, text);
    }
  });

  it('the reason: the organization first, then a login the CLI asks to redo, else a bare refusal', () => {
    assert.equal(getAuthErrorReason(notLoggedInText), 'signedOut');
    assert.equal(getAuthErrorReason('Login expired · Please run /login'), 'signedOut');
    assert.equal(getAuthErrorReason('OAuth token revoked · Please run /login'), 'signedOut');
    assert.equal(getAuthErrorReason('Authentication required · Sign in again to continue'), 'signedOut');
    assert.equal(getAuthErrorReason(orgDisabledText), 'orgDisabled');
    assert.equal(getAuthErrorReason('API Error: 403 OAuth authentication is currently not allowed for this organization.'), 'orgDisabled');
    assert.equal(getAuthErrorReason('API Error: 403 Forbidden'), 'rejected');
  });

  it('a usage limit, an overload and plain prose stay what they were', () => {
    assert.equal(classifyAgentApiError("You've hit your session limit · resets 10:50pm (UTC)", fixedNow)?.kind, 'usageLimit');
    assert.equal(classifyAgentApiError('API Error: 529 Overloaded', fixedNow)?.kind, 'transient');
    assert.equal(classifyAgentApiError('The tests failed with 403 forbidden responses from the mock server', fixedNow), null);
  });
});

describe('the CLI\'s error code on the assistant frame', () => {
  it('the main thread\'s code is an action; a sub-agent\'s is its own and is not', () => {
    const main = classifyClaudeStreamMessage(JSON.parse(errorAssistantLine('authentication_failed', notLoggedInText)));
    assert.deepEqual(main.filter((action) => action.kind === 'apiErrorCode'), [{ kind: 'apiErrorCode', code: 'authentication_failed' }]);
    const child = classifyClaudeStreamMessage(JSON.parse(errorAssistantLine('authentication_failed', notLoggedInText, 'toolu_1')));
    assert.deepEqual(child.filter((action) => action.kind === 'apiErrorCode'), []);
  });

  it('only the two account refusals have a reason', () => {
    assert.equal(getClaudeAuthErrorCodeReason('authentication_failed'), 'signedOut');
    assert.equal(getClaudeAuthErrorCodeReason('oauth_org_not_allowed'), 'orgDisabled');
    for (const code of ['rate_limit', 'overloaded', 'billing_error', 'unknown', null]) assert.equal(getClaudeAuthErrorCodeReason(code), null);
  });
});

describe('claude-json-stream: a refused account ends the turn in an `auth` error with its reason', () => {
  it('signed out — the frames 2.1.304 writes for a folder with no login', () => {
    const { adapter, session, errors, outputs } = createAdapterWithSession();
    adapter['onStdout'](session, errorAssistantLine('authentication_failed', notLoggedInText));
    adapter['onStdout'](session, errorResultLine(notLoggedInText));
    assert.deepEqual(errors, [{ kind: 'auth', authReason: 'signedOut', authDetail: notLoggedInText }], 'the CLI\'s own words ride along for the operator\'s alert');
    assert.ok(!outputs.some((text) => text.startsWith('Claude error:')), 'no raw «Claude error» line on top of the move');
  });

  it('the organization disabled subscription access: the code decides, whatever the text', () => {
    const worded = createAdapterWithSession();
    worded.adapter['onStdout'](worded.session, errorAssistantLine('oauth_org_not_allowed', orgDisabledText));
    worded.adapter['onStdout'](worded.session, errorResultLine(orgDisabledText));
    assert.deepEqual(worded.errors, [{ kind: 'auth', authReason: 'orgDisabled', authDetail: orgDisabledText }]);

    const reworded = createAdapterWithSession();
    reworded.adapter['onStdout'](reworded.session, errorAssistantLine('oauth_org_not_allowed', 'A wording no release has used yet'));
    reworded.adapter['onStdout'](reworded.session, errorResultLine('A wording no release has used yet'));
    assert.deepEqual(reworded.errors, [{ kind: 'auth', authReason: 'orgDisabled', authDetail: 'A wording no release has used yet' }]);
  });

  it('a code that is no account refusal leaves the text to decide; the code never outlives its turn', () => {
    const { adapter, session, errors } = createAdapterWithSession();
    adapter['onStdout'](session, errorAssistantLine('overloaded', 'API Error: 529 Overloaded'));
    adapter['onStdout'](session, errorResultLine('API Error: 529 Overloaded'));
    assert.deepEqual(errors, [{ kind: 'transient' }]);

    session.apiErrorFired = false; // the next turn
    adapter['onStdout'](session, errorAssistantLine('authentication_failed', notLoggedInText));
    adapter['onStdout'](session, toLine({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    session.apiErrorFired = false; // and the one after it fails on its own text
    adapter['onStdout'](session, errorResultLine('API Error: 529 Overloaded'));
    assert.deepEqual(errors, [{ kind: 'transient' }, { kind: 'transient' }], 'the code of a turn that went through was dropped at its end');
  });
});
