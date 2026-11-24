/**
 * @description The scheduler's delivery in a TELEGRAM topic whose view has requests (`scheduler/delivery.ts`, `topicRun`): one model
 * with a Jira issue (`src/requests/README.md` § Scheduled runs) — a fire never replaces a live request, it RIDES one, picked at forward
 * time: the request its job was armed under, else the scheduler's own open request, behind a header naming it, and it opens the
 * scheduler's request only when there is none to ride (a given-up one is ridden by nothing). A topic still announces its fires; a view
 * without requests forwards the plain prompt. These are the cases of review reports 9–11 at the level where the fire's request was chosen.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleDelivery, type ScheduleDeliveryDeps, type TopicRunPorts } from '../scheduler/delivery';
import type { CheckRunResult } from '../scheduler/checkRun';
import type { FireContext, ScheduleRecord } from '../scheduler/types';
import type { OpenRequestState, RequestOrigin } from '../requests/types';
import { plainTextHiddenSentence } from '../requests/requestHeader';

const topicThreadKey = '-1001234567890:11';
const onTime: FireContext = { kind: 'on-time' };
const firedAtMs = Date.parse('2026-06-07T09:30:00.000Z');
const failingRun: CheckRunResult = { exitCode: 1, signal: null, isTimedOut: false, output: 'worker 4242 exited' };
const operatorOrigin: RequestOrigin = { kind: 'message', attributes: { requester: '424242', source: 'text' } };
const schedulerOrigin: RequestOrigin = { kind: 'scheduledRun', attributes: { requester: 'scheduler', source: 'scheduledRun' } };
const markedPrompt = '[Scheduled run "watch worker"]\nThe worker is done: read its result.';

function makeJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'watch-worker-abc123',
    threadKey: topicThreadKey,
    name: 'watch worker',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'The worker is done: read its result.',
    createdBy: 'agent',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    nextRunAt: Date.parse('2026-06-07T09:00:00.000Z'),
    lastAdapterName: 'claude-json-stream',
    ...overrides,
  };
}

function makeRequest(id: string, origin: RequestOrigin, overrides: Partial<OpenRequestState> = {}): OpenRequestState {
  return { id, origin, createdAt: 1000, progressAnswerCount: 0, silentTurnCount: 0, wakeCount: 0, isWakeStopped: false, ...overrides };
}

type CallStep = 'announce' | 'ensureSession' | 'forward' | 'forwardRun' | 'forwardOwnRequestRun' | 'setCheckFailing' | 'hold';

interface HarnessOptions {
  /** The open requests at each read, one list per read (the last sticks): the post may wait behind a running turn. */
  openRequestReads?: OpenRequestState[][];
  /** `null`: the view has no requests (the stream view). */
  requestView?: { isPlainTextHidden: boolean } | null;
  busyValues?: boolean[];
  checkResult?: CheckRunResult;
  isHeld?: boolean;
  /** A LIVE list of open requests in place of the reads: `forwardOwnRequestRun` adds the request it opens, as the ledger does. */
  liveOpenRequests?: OpenRequestState[];
  /** What the engine's settle of the ended watches does before the pick (`settleEndedTurns`). */
  onSettle?: () => void;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<{ step: CallStep; detail?: unknown }> = [];
  const reads = options.openRequestReads ?? [[]];
  let readIndex = 0;
  let busyIndex = 0;
  const busyValues = options.busyValues ?? [false];
  const topicRun: TopicRunPorts = {
    getRequestView: () => (options.requestView === undefined ? { isPlainTextHidden: false } : options.requestView),
    listOpenRequests: () => {
      if (options.liveOpenRequests) return [...options.liveOpenRequests];
      const read = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      return read;
    },
    forwardRun: async (threadKey, text, ridden) => { calls.push({ step: 'forwardRun', detail: { threadKey, text, requestId: ridden.requestId, isRequestJob: ridden.isRequestJob } }); },
    forwardOwnRequestRun: async (threadKey, text) => {
      calls.push({ step: 'forwardOwnRequestRun', detail: { threadKey, text } });
      // The ledger's create is flushed to disk before the forward goes on: the request is open a moment later.
      await new Promise((resolve) => setImmediate(resolve));
      options.liveOpenRequests?.push(makeRequest(`req_Opened${options.liveOpenRequests.length + 1}`, schedulerOrigin));
    },
  };
  const deps: ScheduleDeliveryDeps = {
    announce: async (key, text) => { calls.push({ step: 'announce', detail: { key, text } }); return 42; },
    pin: async () => {},
    unpinMessages: async () => [],
    holdForLimitResume: (key, text, heldText) => {
      if (options.isHeld) calls.push({ step: 'hold', detail: { key, text, heldText } });
      return options.isHeld === true;
    },
    checkBusy: () => {
      const value = busyValues[Math.min(busyIndex, busyValues.length - 1)];
      busyIndex += 1;
      return value;
    },
    ensureSession: async (key, fallbackAdapterName) => {
      calls.push({ step: 'ensureSession', detail: { key, fallbackAdapterName } });
      return { ok: true, isFresh: false };
    },
    forwardPrompt: async (key, text) => { calls.push({ step: 'forward', detail: { key, text } }); },
    runCheck: async () => options.checkResult ?? failingRun,
    setCheckFailing: async (jobId, isFailing) => { calls.push({ step: 'setCheckFailing', detail: { jobId, isFailing } }); },
    clearAlertPins: async () => {},
    checkIsStatusShown: () => false,
    postStatus: async () => 501,
    deleteMessage: async () => {},
    readWorkerActivity: async () => null,
    recordStatusLine: async () => true,
    topicRun,
    ...(options.onSettle ? { settleEndedTurns: async () => { options.onSettle?.(); return async () => {}; } } : {}),
    now: () => firedAtMs,
    sleep: async () => {},
  };
  const getSteps = (): CallStep[] => calls.map((call) => call.step);
  const getCall = <TDetail>(step: CallStep): TDetail => {
    const call = calls.find((candidate) => candidate.step === step);
    assert.ok(call, `${step} was called`);
    return call.detail as TDetail;
  };
  return { deps, getSteps, getCall };
}

test('the fire of a watch armed under the OPERATOR\'s request rides it: no request of its own, the header names the operator\'s request; the topic still sees the announcement', async () => {
  const operatorRequest = makeRequest('req_Operator1', operatorOrigin, { progressAnswerCount: 1 });
  const { deps, getSteps, getCall } = createHarness({ openRequestReads: [[operatorRequest]] });
  assert.deepEqual(await createScheduleDelivery(deps)(makeJob({ requestId: operatorRequest.id }), onTime), { status: 'delivered' });
  assert.deepEqual(getSteps(), ['announce', 'ensureSession', 'forwardRun']);
  const { text, requestId } = getCall<{ text: string; requestId: string }>('forwardRun');
  assert.equal(requestId, operatorRequest.id);
  assert.equal(
    text,
    '[Scheduled run "watch worker" · request req_Operator1 is open]\n' +
      'Answer it through answer_request (requestId "req_Operator1") only when you have a result the requester needs.\n' +
      markedPrompt,
  );
  assert.deepEqual(getCall<{ fallbackAdapterName: string }>('ensureSession').fallbackAdapterName, 'claude-json-stream', 'a topic starts on the job\'s snapshot');
});

test('an unrelated job\'s fire RIDES the scheduler\'s request the agent answered instead of replacing it — the operator\'s «working on it» stands (report 10)', async () => {
  const answered = makeRequest('req_Sched0001', schedulerOrigin, { progressAnswerCount: 1 });
  const { deps, getCall, getSteps } = createHarness({ openRequestReads: [[answered]] });
  await createScheduleDelivery(deps)(makeJob({ requestId: undefined }), onTime);
  assert.ok(!getSteps().includes('forwardOwnRequestRun'), 'no new request is opened');
  assert.equal(getCall<{ requestId: string }>('forwardRun').requestId, answered.id);
  assert.equal(getCall<{ isRequestJob: boolean }>('forwardRun').isRequestJob, false, 'another job\'s fire: it does not handle the request\'s fired watch, nor count as its activity (review 12 #2)');
});

test('the watch armed under the answered scheduler\'s request fires and rides it: its check block behind that request\'s header (report 11 #2)', async () => {
  const answered = makeRequest('req_Sched0001', schedulerOrigin, { progressAnswerCount: 1 });
  const { deps, getSteps, getCall } = createHarness({ openRequestReads: [[answered]] });
  await createScheduleDelivery(deps)(makeJob({ requestId: answered.id, deliveryKind: 'check', checkCommand: 'kill -0 4242' }), onTime);
  assert.deepEqual(getSteps(), ['setCheckFailing', 'announce', 'ensureSession', 'forwardRun'], 'a topic announces its check alert');
  const { text, requestId, isRequestJob } = getCall<{ text: string; requestId: string; isRequestJob: boolean }>('forwardRun');
  assert.equal(requestId, answered.id);
  assert.equal(isRequestJob, true, 'the request\'s own watch');
  assert.ok(text.startsWith('[Scheduled run "watch worker" · request req_Sched0001 is open]\n'), text);
  assert.ok(text.includes('[Scheduled check "watch worker" failed]'), text);
  assert.ok(text.includes('tells the topic when it passes again'), 'a topic keeps its own wording');
});

test('a fire that waited behind the scheduler\'s request\'s RUNNING turn rides it, picked at forward time — a request opened meanwhile is ridden, not replaced (report 11 #3)', async () => {
  const running = makeRequest('req_Sched0001', schedulerOrigin);
  const { deps, getCall, getSteps } = createHarness({ openRequestReads: [[], [running]], busyValues: [true, false] });
  await createScheduleDelivery(deps)(makeJob(), onTime);
  assert.ok(!getSteps().includes('forwardOwnRequestRun'));
  const { text, requestId } = getCall<{ text: string; requestId: string }>('forwardRun');
  assert.equal(requestId, running.id);
  assert.ok(text.startsWith('[Scheduled run "watch worker" · request req_Sched0001 is open]'), text);
});

test('a scheduler\'s request the bot gave up on is ridden by nothing: the fire opens a new one, its text the bare prompt — the forward adds that request\'s own header (report 11 #1)', async () => {
  const givenUp = makeRequest('req_Sched0001', schedulerOrigin, { progressAnswerCount: 1, isWakeStopped: true });
  const { deps, getSteps, getCall } = createHarness({ openRequestReads: [[givenUp]] });
  await createScheduleDelivery(deps)(makeJob({ requestId: givenUp.id }), onTime);
  assert.deepEqual(getSteps(), ['announce', 'ensureSession', 'forwardOwnRequestRun']);
  assert.equal(getCall<{ text: string }>('forwardOwnRequestRun').text, markedPrompt);
});

test('with none to ride — nothing open, or only a person\'s request the job was not armed under — the fire opens the scheduler\'s request', async () => {
  const nothing = createHarness({ openRequestReads: [[]] });
  await createScheduleDelivery(nothing.deps)(makeJob(), onTime);
  assert.deepEqual(nothing.getSteps(), ['announce', 'ensureSession', 'forwardOwnRequestRun']);
  const unrelated = createHarness({ openRequestReads: [[makeRequest('req_Operator1', operatorOrigin)]] });
  await createScheduleDelivery(unrelated.deps)(makeJob({ requestId: undefined }), onTime);
  assert.deepEqual(unrelated.getSteps(), ['announce', 'ensureSession', 'forwardOwnRequestRun'], 'a person\'s request is ridden only by its own job');
});

test('two fires at the same moment with nothing to ride open ONE scheduler\'s request: the second rides it instead of replacing it (an answer to the first is never lost)', async () => {
  const liveOpenRequests: OpenRequestState[] = [];
  const { deps, getSteps, getCall } = createHarness({ liveOpenRequests });
  const deliver = createScheduleDelivery(deps);
  await Promise.all([deliver(makeJob({ id: 'hourly-a', name: 'hourly a' }), onTime), deliver(makeJob({ id: 'hourly-b', name: 'hourly b' }), onTime)]);
  assert.deepEqual(getSteps().filter((step) => step === 'forwardOwnRequestRun' || step === 'forwardRun'), ['forwardOwnRequestRun', 'forwardRun']);
  assert.equal(getCall<{ requestId: string }>('forwardRun').requestId, 'req_Opened1');
  assert.equal(liveOpenRequests.length, 1);
});

test('the engine settles the ended watches BEFORE the pick: the scheduler\'s request its silent end closed is not ridden — the fire opens a new one (review 14 #1)', async () => {
  const liveOpenRequests: OpenRequestState[] = [makeRequest('req_Sched0001', schedulerOrigin)];
  const { deps, getSteps } = createHarness({ liveOpenRequests, onSettle: () => { liveOpenRequests.splice(0); } });
  await createScheduleDelivery(deps)(makeJob(), onTime);
  assert.ok(!getSteps().includes('forwardRun'), 'the closed request is not ridden');
  assert.ok(getSteps().includes('forwardOwnRequestRun'));
});

test('the answers-only view says in the header that the requester sees only the answers', async () => {
  const operatorRequest = makeRequest('req_Operator1', operatorOrigin, { progressAnswerCount: 1 });
  const { deps, getCall } = createHarness({ openRequestReads: [[operatorRequest]], requestView: { isPlainTextHidden: true } });
  await createScheduleDelivery(deps)(makeJob({ requestId: operatorRequest.id }), onTime);
  assert.ok(getCall<{ text: string }>('forwardRun').text.includes(`\n${plainTextHiddenSentence}\n${markedPrompt}`));
});

test('a view without requests forwards the plain prompt through the shared forward: no request is ridden or opened', async () => {
  const { deps, getSteps, getCall } = createHarness({ requestView: null, openRequestReads: [[makeRequest('req_Operator1', operatorOrigin)]] });
  await createScheduleDelivery(deps)(makeJob({ requestId: 'req_Operator1' }), onTime);
  assert.deepEqual(getSteps(), ['announce', 'ensureSession', 'forward']);
  assert.equal(getCall<{ text: string }>('forward').text, markedPrompt);
});

test('a run held over a usage-limit wait keeps the header of the request it rides, as a tracker\'s', async () => {
  const operatorRequest = makeRequest('req_Operator1', operatorOrigin, { progressAnswerCount: 1 });
  const { deps, getSteps, getCall } = createHarness({ openRequestReads: [[operatorRequest]], isHeld: true });
  await createScheduleDelivery(deps)(makeJob({ requestId: operatorRequest.id }), onTime);
  assert.ok(!getSteps().includes('forwardRun'));
  const held = getCall<{ text: string; heldText: string }>('hold');
  assert.ok(held.heldText.startsWith('[Scheduled run "watch worker" · request req_Operator1 is open]'), held.heldText);
});

test('a fire picks the request it rides only once no command ends or replaces the conversation: a move that closed the request while the fire waited in its forward queue is not ridden — the fire opens the scheduler\'s request in the conversation that follows (review 28 nit 3)', async () => {
  const operatorRequest = makeRequest('req_Operator1', operatorOrigin, { progressAnswerCount: 1 });
  const liveOpenRequests: OpenRequestState[] = [operatorRequest];
  const { deps, getSteps, getCall } = createHarness({ liveOpenRequests });
  let waitCount = 0;
  // `postToSession` waits twice, ahead of its ensures; the third wait is the queued forward's own. A move ran in that last one: it closed
  // the requests of the conversation it left.
  const postDeps: ScheduleDeliveryDeps = {
    ...deps,
    waitForConversationChange: async () => {
      waitCount += 1;
      if (waitCount === 3) liveOpenRequests.length = 0;
    },
  };
  assert.deepEqual(await createScheduleDelivery(postDeps)(makeJob({ requestId: operatorRequest.id }), onTime), { status: 'delivered' });
  assert.equal(waitCount, 3, 'the forward waits in its queue, after the post\'s two waits');
  assert.ok(!getSteps().includes('forwardRun'), 'the closed request is not ridden');
  const { text } = getCall<{ text: string }>('forwardOwnRequestRun');
  assert.ok(!text.includes('req_Operator1'), 'and no header names it');
});
