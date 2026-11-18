/**
 * @description `AgentAdapter.setQuestionAside` — what each backend does to the question the agent is blocked on when the
 * bot sets it aside (the wait ended): the question's tool call returns the bot's text and the agent's turn GOES ON.
 *
 *  - Claude json-stream: the `can_use_tool` request is DENIED with the text as its message — through the real path (a
 *    `control_request` line read from stdout makes the question pending, and the frame the CLI would read from stdin is
 *    captured) — and NO interrupt follows; the question's sidecar is gone, so a restart cannot resurface it.
 *  - OpenCode: the question is REPLIED to with the text as the custom answer of every question left open (answers already
 *    collected stay as they are) and is NEVER rejected: a reject ends OpenCode's agent loop.
 *
 * The bot-side wiring (the timer, the topic message) is a later scope; the flows that run a real agent process through it
 * come with it.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { AgentAdapter, OpenCodePendingQuestion } from '../types';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { buildQuestionSetAsideText } from '../utils/questionWaitPlan';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';
import { createOpenCodeSessionFixture, getOpenCodeSession } from './openCodeSessionFixture';

const key: SessionKey = makeTelegramKey(-100999778, 56);
const askedAtMs = new Date(2026, 10, 18, 14, 5).getTime();
const setAsideAtMs = new Date(2026, 10, 18, 14, 35).getTime();

const askedQuestions = [
  { question: 'Push the fix to main now, or wait for the review?', header: 'Deploy', options: [{ label: 'Push now' }, { label: 'Wait for the review' }], multiSelect: false },
  { question: 'Which docs to update first?', header: 'Docs', options: [{ label: 'README' }, { label: 'Changelog' }], multiSelect: false },
];

/** The line the CLI writes when the agent calls AskUserQuestion: it blocks on this request until the bot answers it. */
function buildAskUserQuestionLine(requestId: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: askedQuestions }, tool_use_id: toolUseId, requires_user_interaction: true },
  }) + '\n';
}

describe('json-stream: setQuestionAside denies the question with the text and lets the turn go on', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  /** An adapter whose session holds a question the agent really asked, and the frames the CLI would read from stdin. */
  function createAdapterBlockedOnQuestion(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; frames: Array<Record<string, unknown>> } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-set-aside-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-set-aside-work', sessionId: 'sess-set-aside', paths: getJsonStreamSessionPaths(dir) });
    adapter['sessions'].set(keyToString(key), session);
    const frames: Array<Record<string, unknown>> = [];
    adapter['writeStdin'] = async (_session: StreamSession, frame: Record<string, unknown>) => { frames.push(frame); };
    adapter['onStdout'](session, buildAskUserQuestionLine('req_ask', 'toolu_ask'));
    return { adapter, session, frames };
  }

  it('answers the tool call with a DENY whose message is the text — and sends no interrupt', () => {
    const { adapter, session, frames } = createAdapterBlockedOnQuestion();
    assert.equal(session.pendingQuestion?.requestId, 'req_ask', 'precondition: the agent is blocked on the question');
    assert.equal(fs.existsSync(session.paths.questionFile), true, 'precondition: the question is kept for a restart');
    const text = buildQuestionSetAsideText({ questions: session.pendingQuestion?.questions ?? [], answers: [null, null], askedAtMs, nowMs: setAsideAtMs });

    // Called the way the bot calls it, through the backend-neutral contract (which also carries the answers given so far).
    const backendNeutralAdapter: AgentAdapter = adapter;
    const wasSetAside = backendNeutralAdapter.setQuestionAside?.(key, 'req_ask', text, [null, null]);
    assert.equal(wasSetAside, true, 'the bot is told the question was set aside');

    // Load-bearing: the frame is a deny carrying the bot's text — the model reads it as the tool's result — and nothing
    // else is written: an interrupt (`control_request`) would abort the very turn this is meant to let go on.
    assert.deepEqual(frames, [{
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_ask', response: { behavior: 'deny', message: text, toolUseID: 'toolu_ask' } },
    }]);
    assert.match(text, /^\[Charness\] The user has not answered yet/, 'the text the agent reads is the plan\'s');
  });

  it('closes the question on the bot\'s side: no pending question, its sidecar removed, the turn still busy', () => {
    const { adapter, session } = createAdapterBlockedOnQuestion();
    assert.equal(session.isBusy, true, 'precondition: asking marked the turn busy');

    adapter.setQuestionAside(key, 'req_ask', 'set aside');

    assert.equal(session.pendingQuestion, null);
    assert.equal(fs.existsSync(session.paths.questionFile), false, 'a restart finds no question to resurface');
    assert.equal(session.isBusy, true, 'the agent\'s turn goes on, it is not ended');
    assert.equal(session.isActive, true);
    assert.equal(adapter['sessions'].has(keyToString(key)), true, 'the session is not torn down');
  });

  it('restarts the idle-watchdog clock the long wait had run down, as an answer does', () => {
    const { adapter, session } = createAdapterBlockedOnQuestion();
    session.lastStdoutActivityAt = Date.now() - 3_600_000;

    const before = Date.now();
    adapter.setQuestionAside(key, 'req_ask', 'set aside');

    assert.ok(session.lastStdoutActivityAt >= before, 'the clock restarts at the set-aside');
  });

  it('the question stays suppressed in the topic: the denied call\'s own result is not echoed', () => {
    const { adapter, session } = createAdapterBlockedOnQuestion();
    const toolResults: string[] = [];
    adapter.on('toolResult', (_key: SessionKey, result: { output: string }) => toolResults.push(result.output));
    const buildToolResultLine = (toolUseId: string, output: string): string => JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: true }] },
    }) + '\n';

    adapter.setQuestionAside(key, 'req_ask', 'set aside');
    // The CLI answers the denied call with its tool_result; it must stay out of the topic like an answered question's.
    adapter['onStdout'](session, buildToolResultLine('toolu_ask', 'set aside'));
    assert.deepEqual(toolResults, []);

    // Negative control: the same line for an ordinary tool IS relayed — so the silence above is the question's, not the line's shape.
    adapter['onStdout'](session, buildToolResultLine('toolu_other', 'ordinary output'));
    assert.deepEqual(toolResults, ['ordinary output']);
  });

  it('is a no-op when no question is pending', () => {
    const { adapter, session, frames } = createAdapterBlockedOnQuestion();
    adapter.rejectQuestion(key);
    frames.length = 0;

    const wasSetAside = adapter.setQuestionAside(key, 'req_ask', 'set aside');

    assert.equal(wasSetAside, false, 'the bot is told nothing was set aside');
    assert.deepEqual(frames, [], 'nothing is written for a question that is not pending');
    assert.equal(session.pendingQuestion, null);
  });

  it('is a no-op for a question that is not the one pending now: a late timer cannot set the agent\'s NEXT question aside', () => {
    const { adapter, session, frames } = createAdapterBlockedOnQuestion();
    // Question A was answered, the agent went on and asked B in the same turn; A's timer (armed for A's request id) fires late.
    adapter.answerQuestion(key, [['Push now'], ['README']]);
    adapter['onStdout'](session, buildAskUserQuestionLine('req_ask_b', 'toolu_ask_b'));
    assert.equal(session.pendingQuestion?.requestId, 'req_ask_b', 'precondition: B is pending');
    frames.length = 0;

    const wasSetAside = adapter.setQuestionAside(key, 'req_ask', 'asked 14:05, waited 30 min — A\'s text');

    // Load-bearing: B is still pending and untouched — its tool call is still waiting for an answer, nothing was written.
    assert.equal(wasSetAside, false);
    assert.deepEqual(frames, []);
    assert.equal(session.pendingQuestion?.requestId, 'req_ask_b');
    assert.equal(fs.existsSync(session.paths.questionFile), true, 'B\'s saved copy is kept');
    // B's own timer sets it aside: the id is what matches.
    assert.equal(adapter.setQuestionAside(key, 'req_ask_b', 'B\'s text'), true);
    assert.equal(frames.length, 1);
  });

  it('settles a question once: a set-aside after the answer (or before it) writes no second response', () => {
    const answeredFirst = createAdapterBlockedOnQuestion();
    answeredFirst.adapter.answerQuestion(key, [['Push now'], ['README']]);
    assert.equal(answeredFirst.adapter.setQuestionAside(key, 'req_ask', 'set aside'), false, 'a question answered already is not set aside');
    assert.deepEqual(answeredFirst.frames.map((frame) => (frame.response as Record<string, unknown>).request_id), ['req_ask'], 'only the answer is written');
    assert.equal(((answeredFirst.frames[0].response as Record<string, unknown>).response as Record<string, unknown>).behavior, 'allow');
    fs.rmSync(dir, { recursive: true, force: true });

    const setAsideFirst = createAdapterBlockedOnQuestion();
    assert.equal(setAsideFirst.adapter.setQuestionAside(key, 'req_ask', 'set aside'), true);
    setAsideFirst.adapter.answerQuestion(key, [['Push now'], ['README']]);
    setAsideFirst.adapter.rejectQuestion(key);
    assert.equal(setAsideFirst.frames.length, 1, 'only the set-aside is written');
    assert.equal(((setAsideFirst.frames[0].response as Record<string, unknown>).response as Record<string, unknown>).behavior, 'deny');
  });

  it('writes nothing to a session that is no longer active', () => {
    const { adapter, session, frames } = createAdapterBlockedOnQuestion();
    session.isActive = false;

    assert.equal(adapter.setQuestionAside(key, 'req_ask', 'set aside'), false);

    assert.deepEqual(frames, []);
    assert.notEqual(session.pendingQuestion, null, 'the question is left as it was');
  });

  it('is a no-op for a conversation with no session at all', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    assert.equal(adapter.setQuestionAside(key, 'req_ask', 'set aside'), false);
  });
});

describe('OpenCode: setQuestionAside replies with the text as the custom answer and never rejects', () => {
  const requestId = 'que_set_aside';
  const owningDirectory = '/home/user/src/someProject';

  const twoQuestions: OpenCodePendingQuestion['questions'] = [
    { question: 'Push the fix to main now, or wait for the review?', header: 'Deploy', options: [{ label: 'Push now' }, { label: 'Wait for the review' }] },
    { question: 'Which docs to update first?', header: 'Docs', options: [{ label: 'README' }, { label: 'Changelog' }] },
  ];

  function createAdapterBlockedOnQuestion(): {
    adapter: OpenCodeAdapter;
    apiCalls: Array<{ method: string; urlPath: string; body: unknown }>;
    errors: Error[];
  } {
    const adapter = new OpenCodeAdapter();
    adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: 'ses_set_aside', workDir: '/tmp/work-set-aside', isModelInfoShown: true }));
    const apiCalls: Array<{ method: string; urlPath: string; body: unknown }> = [];
    adapter['apiRequest'] = (async (method: string, urlPath: string, body?: unknown) => {
      apiCalls.push({ method, urlPath, body });
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];
    const errors: Error[] = [];
    adapter.on('error', (_key: SessionKey, error: Error) => errors.push(error));
    adapter['handleQuestionAsked'](key, { id: requestId, sessionID: 'ses_set_aside', questions: twoQuestions }, owningDirectory);
    return { adapter, apiCalls, errors };
  }

  it('replies to the question\'s own instance with the text as the answer of every question left open', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();
    const text = buildQuestionSetAsideText({ questions: twoQuestions, answers: [null, null], askedAtMs, nowMs: setAsideAtMs });

    assert.equal(adapter.setQuestionAside(key, requestId, text, [null, null]), true, 'the bot is told the question was set aside');

    // Load-bearing: one reply, no reject — a reject would end the agent's loop.
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].method, 'POST');
    assert.equal(apiCalls[0].urlPath, `/question/${requestId}/reply?directory=${encodeURIComponent(owningDirectory)}`);
    assert.deepEqual(apiCalls[0].body, { answers: [[text], [text]] });
    assert.ok(apiCalls.every((call) => !call.urlPath.includes('/reject')), 'a set-aside is never a reject');
  });

  it('keeps an answer already collected as the label it is, and the text only where nothing was answered', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();

    adapter.setQuestionAside(key, requestId, 'set aside', [['Push now'], null]);
    assert.deepEqual(apiCalls[0].body, { answers: [['Push now'], ['set aside']] });
  });

  it('keeps a multi-select answer\'s labels together', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();

    adapter.setQuestionAside(key, requestId, 'set aside', [null, ['README', 'Changelog']]);
    assert.deepEqual(apiCalls[0].body, { answers: [['set aside'], ['README', 'Changelog']] });
  });

  it('clears the pending question, so it is not answered, replied or rejected a second time', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();

    assert.equal(adapter.setQuestionAside(key, requestId, 'set aside', [null, null]), true);
    assert.equal(getOpenCodeSession(adapter, keyToString(key)).pendingQuestion, null);

    assert.equal(adapter.setQuestionAside(key, requestId, 'again', [null, null]), false);
    adapter.answerQuestion(key, [['Push now'], ['README']]);
    adapter.rejectQuestion(key);
    assert.equal(apiCalls.length, 1, 'only the first resolution reaches the server');
  });

  it('is a no-op when no question is pending, or the session is not active', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();
    getOpenCodeSession(adapter, keyToString(key)).isActive = false;
    assert.equal(adapter.setQuestionAside(key, requestId, 'set aside', [null, null]), false);
    assert.deepEqual(apiCalls, []);

    const idle = new OpenCodeAdapter();
    assert.equal(idle.setQuestionAside(key, requestId, 'set aside', [null]), false);
  });

  it('is a no-op for a question that is not the one pending now: a late timer cannot set the NEXT question aside', () => {
    const { adapter, apiCalls } = createAdapterBlockedOnQuestion();
    // Question A was answered, the agent asked B; A's timer (armed for A's request id) fires late with A's answers and text.
    adapter.answerQuestion(key, [['Push now'], ['README']]);
    adapter['handleQuestionAsked'](key, { id: 'que_next', sessionID: 'ses_set_aside', questions: [twoQuestions[1]] }, owningDirectory);
    apiCalls.length = 0;

    const wasSetAside = adapter.setQuestionAside(key, requestId, 'A\'s text', [['Push now'], null]);

    // Load-bearing: B is untouched — no reply reached the server, B is still pending.
    assert.equal(wasSetAside, false);
    assert.equal(apiCalls.length, 0);
    assert.equal(getOpenCodeSession(adapter, keyToString(key)).pendingQuestion?.requestId, 'que_next');
    assert.equal(adapter.setQuestionAside(key, 'que_next', 'B\'s text', [null]), true);
    assert.deepEqual(apiCalls.map((call) => call.urlPath), [`/question/que_next/reply?directory=${encodeURIComponent(owningDirectory)}`]);
    assert.deepEqual(apiCalls[0].body, { answers: [['B\'s text']] });
  });

  it('surfaces a failed reply through the adapter\'s error event, like an answer does', async () => {
    const { adapter, errors } = createAdapterBlockedOnQuestion();
    adapter['apiRequest'] = (async () => { throw new Error('server gone'); }) as OpenCodeAdapter['apiRequest'];
    const originalError = console.error;
    console.error = () => {};
    try {
      adapter.setQuestionAside(key, requestId, 'set aside', [null, null]);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors.map((error) => error.message), ['server gone']);
  });

  describe('resyncOpenQuestion — what the server holds, when the adapter\'s own copy is only a cache', () => {
    function createAdapterThatLostTheQuestion(response: unknown): { adapter: OpenCodeAdapter; apiCalls: Array<{ method: string; urlPath: string }> } {
      const adapter = new OpenCodeAdapter();
      adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: 'ses_set_aside', workDir: '/tmp/work-set-aside', isModelInfoShown: true }));
      const apiCalls: Array<{ method: string; urlPath: string }> = [];
      adapter['apiRequest'] = (async (method: string, urlPath: string) => {
        apiCalls.push({ method, urlPath });
        if (response instanceof Error) throw response;
        return response;
      }) as OpenCodeAdapter['apiRequest'];
      return { adapter, apiCalls };
    }

    const serverEntry = [{ id: requestId, sessionID: 'ses_set_aside', questions: twoQuestions }];

    it('held: the question the server has open is read into the adapter — and then it CAN be set aside', async () => {
      const { adapter, apiCalls } = createAdapterThatLostTheQuestion(serverEntry);
      assert.equal(adapter.setQuestionAside(key, requestId, 'set aside', [null, null]), false, 'precondition: the adapter does not know the question');

      assert.equal(await adapter.resyncOpenQuestion(key, requestId), 'held');

      assert.deepEqual(apiCalls, [{ method: 'GET', urlPath: `/question?directory=${encodeURIComponent('/tmp/work-set-aside')}` }], 'the server is asked for this session\'s instance');
      assert.equal(getOpenCodeSession(adapter, keyToString(key)).pendingQuestion?.requestId, requestId);
      assert.equal(adapter.setQuestionAside(key, requestId, 'set aside', [null, null]), true);
      assert.equal(apiCalls.at(-1)?.urlPath, `/question/${requestId}/reply?directory=${encodeURIComponent('/tmp/work-set-aside')}`);
    });

    it('held emits nothing: the bot that asks already holds the question', async () => {
      const { adapter } = createAdapterThatLostTheQuestion(serverEntry);
      const emitted: string[] = [];
      adapter.on('question', () => emitted.push('question'));

      await adapter.resyncOpenQuestion(key, requestId);

      assert.deepEqual(emitted, []);
    });

    it('none: the server has no question of this session (another session\'s question is not this one\'s)', async () => {
      assert.equal(await createAdapterThatLostTheQuestion([]).adapter.resyncOpenQuestion(key, requestId), 'none');
      assert.equal(await createAdapterThatLostTheQuestion([{ id: 'que_other', sessionID: 'ses_other', questions: twoQuestions }]).adapter.resyncOpenQuestion(key, requestId), 'none');
    });

    it('none for ANOTHER question: the server holds a different one than the bot asked about — the bot\'s copy is stale, and the adapter\'s cache is not filled with the other one', async () => {
      const { adapter } = createAdapterThatLostTheQuestion([{ id: 'que_changed', sessionID: 'ses_set_aside', questions: twoQuestions }]);

      assert.equal(await adapter.resyncOpenQuestion(key, requestId), 'none');

      assert.equal(getOpenCodeSession(adapter, keyToString(key)).pendingQuestion, null, 'a tap on the stale buttons can not answer a question the owner never saw');
      assert.equal(adapter.setQuestionAside(key, requestId, 'set aside', [null, null]), false);
    });

    it('surfaceOpenQuestion hands the question the server holds to the bot as a `question` event — and reads it into the cache the way a reattach does', async () => {
      const { adapter } = createAdapterThatLostTheQuestion([{ id: 'que_changed', sessionID: 'ses_set_aside', questions: twoQuestions }]);
      const emitted: string[] = [];
      adapter.on('question', (_key: SessionKey, question: { requestId: string }) => emitted.push(question.requestId));

      await adapter.surfaceOpenQuestion(key);

      assert.deepEqual(emitted, ['que_changed']);
      assert.equal(getOpenCodeSession(adapter, keyToString(key)).pendingQuestion?.requestId, 'que_changed');
    });

    it('surfaceOpenQuestion emits nothing when the server holds none of this session\'s, or the session is not active', async () => {
      const none = createAdapterThatLostTheQuestion([{ id: 'que_other', sessionID: 'ses_other', questions: twoQuestions }]);
      const emitted: string[] = [];
      none.adapter.on('question', () => emitted.push('question'));
      await none.adapter.surfaceOpenQuestion(key);

      const inactive = createAdapterThatLostTheQuestion(serverEntry);
      inactive.adapter.on('question', () => emitted.push('question'));
      getOpenCodeSession(inactive.adapter, keyToString(key)).isActive = false;
      await inactive.adapter.surfaceOpenQuestion(key);

      assert.deepEqual(emitted, []);
      assert.deepEqual(inactive.apiCalls, [], 'an inactive session is not even asked about');
    });

    it('unknown: the read failed, the answer is not a list, or the session is not active (a replacement may be under way) — never «none»', async () => {
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(await createAdapterThatLostTheQuestion(new Error('server busy')).adapter.resyncOpenQuestion(key, requestId), 'unknown');
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(await createAdapterThatLostTheQuestion({ not: 'a list' }).adapter.resyncOpenQuestion(key, requestId), 'unknown');

      const inactive = createAdapterThatLostTheQuestion(serverEntry);
      getOpenCodeSession(inactive.adapter, keyToString(key)).isActive = false;
      assert.equal(await inactive.adapter.resyncOpenQuestion(key, requestId), 'unknown');
      assert.deepEqual(inactive.apiCalls, [], 'and the server was not even asked');
      assert.equal(await new OpenCodeAdapter().resyncOpenQuestion(key, requestId), 'unknown', 'no session at all');
    });
  });
});
