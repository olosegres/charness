/**
 * @description The scheduler's delivery in a TRACKER conversation (`scheduler/delivery.ts`, `trackerRun`): a fire posts
 * NOTHING (no announcement, no «back to normal» line, no status line, no check alert — a Jira comment always notifies), wakes the
 * agent behind a header that names the request it rides (picked at forward time), watches the turn as that request's scheduled
 * run, and starts a fresh session on the connector's own backend. A Telegram topic beside it is delivered as before.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleDelivery, type ScheduleDeliveryDeps, type TrackerRunPorts } from '../scheduler/delivery';
import type { CheckRunResult } from '../scheduler/checkRun';
import type { FireContext, ScheduleRecord } from '../scheduler/types';
import type { OpenRequestState } from '../requests/types';
import type { EnsureSessionResult } from '../postToSession';

const issueThreadKey = 'jira:PROJ:PROJ-12';
const topicThreadKey = '-1001234567890:11';
const conversationLabel = 'Jira issue PROJ-12 (https://example.atlassian.net/browse/PROJ-12)';
const connectorAdapterName = 'claude-json-stream';
const onTime: FireContext = { kind: 'on-time' };
/** The fake clock: long after the jobs were created, so a status line (every 15 min) would be DUE if the conversation showed one. */
const firedAtMs = Date.parse('2026-06-07T09:30:00.000Z');
const failingRun: CheckRunResult = { exitCode: 1, signal: null, isTimedOut: false, output: 'worker 4242 exited' };
const passingRun: CheckRunResult = { exitCode: 0, signal: null, isTimedOut: false, output: '' };

function makeJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'watch-worker-abc123',
    threadKey: issueThreadKey,
    name: 'watch worker',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'The worker is done: read its result.',
    createdBy: 'agent',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    nextRunAt: Date.parse('2026-06-07T09:00:00.000Z'),
    lastAdapterName: 'snapshot-adapter',
    requestId: 'req_Armed001',
    ...overrides,
  };
}

function makeCheckJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return makeJob({ deliveryKind: 'check', checkCommand: 'kill -0 4242', ...overrides });
}

function makeRequest(id: string, createdAt: number, overrides: Partial<OpenRequestState> = {}): OpenRequestState {
  return {
    id,
    origin: { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-12', requester: 'ann' } },
    createdAt,
    // Answered once: the request a fire rides while its worker runs owes nobody anything (an owed one has its own header).
    progressAnswerCount: 1,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    ...overrides,
  };
}

type CallStep = 'announce' | 'pin' | 'postStatus' | 'deleteMessage' | 'recordStatusLine' | 'readWorkerActivity' | 'ensureSession' | 'forward' | 'forwardRun' | 'setCheckFailing' | 'hold';

interface HarnessOptions {
  /** The conversation of the fire is a tracker's (default) or a topic's. */
  isTracker?: boolean;
  /** The open requests at each forward, one list per read (the last sticks): the post may wait behind a running turn. */
  openRequestReads?: OpenRequestState[][];
  busyValues?: boolean[];
  ensureResult?: EnsureSessionResult;
  checkResult?: CheckRunResult;
  forwardRunThrows?: boolean;
  isHeld?: boolean;
  /** Whether the harness's `checkIsStatusShown` says yes (a misconfigured tracker must still post no line). */
  isStatusShown?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<{ step: CallStep; detail?: unknown }> = [];
  const isTracker = options.isTracker ?? true;
  const reads = options.openRequestReads ?? [[makeRequest('req_Armed001', 1000)]];
  let readIndex = 0;
  let busyIndex = 0;
  const busyValues = options.busyValues ?? [false];
  const trackerRun: TrackerRunPorts = {
    describeConversation: (threadKey) => (isTracker && threadKey === issueThreadKey ? conversationLabel : null),
    listOpenRequests: () => {
      const read = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      return read;
    },
    forwardRun: async (threadKey, text, requestId) => {
      calls.push({ step: 'forwardRun', detail: { threadKey, text, requestId } });
      if (options.forwardRunThrows) throw new Error('forward boom');
    },
    fallbackAdapterName: connectorAdapterName,
  };
  const deps: ScheduleDeliveryDeps = {
    announce: async (key, text, announceOptions) => {
      calls.push({ step: 'announce', detail: { key, text, announceOptions } });
      return 42;
    },
    pin: async () => { calls.push({ step: 'pin' }); },
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
      return options.ensureResult ?? { ok: true, isFresh: false };
    },
    forwardPrompt: async (key, text) => { calls.push({ step: 'forward', detail: { key, text } }); },
    runCheck: async () => options.checkResult ?? passingRun,
    setCheckFailing: async (jobId, isFailing) => { calls.push({ step: 'setCheckFailing', detail: { jobId, isFailing } }); },
    clearAlertPins: async () => {},
    checkIsStatusShown: () => options.isStatusShown ?? false,
    postStatus: async (key, text) => { calls.push({ step: 'postStatus', detail: { key, text } }); return 501; },
    deleteMessage: async () => { calls.push({ step: 'deleteMessage' }); },
    readWorkerActivity: async () => { calls.push({ step: 'readWorkerActivity' }); return 'did something'; },
    recordStatusLine: async () => { calls.push({ step: 'recordStatusLine' }); return true; },
    trackerRun,
    now: () => firedAtMs,
    sleep: async () => {},
  };
  const getSteps = (): CallStep[] => calls.map((call) => call.step);
  const getForwardRun = (): { threadKey: string; text: string; requestId: string | null } => {
    const call = calls.find((candidate) => candidate.step === 'forwardRun');
    assert.ok(call, 'forwardRun was called');
    return call.detail as { threadKey: string; text: string; requestId: string | null };
  };
  return { deps, calls, getSteps, getForwardRun };
}

test('a prompt job in a tracker conversation posts nothing: no announcement, no pin, no status — only ensure → forwardRun', async () => {
  const { deps, getSteps, getForwardRun } = createHarness();
  const outcome = await createScheduleDelivery(deps)(makeJob(), onTime);
  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getSteps(), ['ensureSession', 'forwardRun'], 'nothing is announced or posted on the issue; the Telegram forward is not used');
  assert.equal(getForwardRun().threadKey, issueThreadKey);
});

test('a fire that rides a request still owing the requester an answer says so in the header — the turn is the request\'s all the same', async () => {
  const { deps, getForwardRun } = createHarness({ openRequestReads: [[makeRequest('req_Armed001', 1000, { progressAnswerCount: 0 })]] });
  await createScheduleDelivery(deps)(makeJob(), onTime);
  const { text, requestId } = getForwardRun();
  assert.equal(requestId, 'req_Armed001');
  assert.ok(text.startsWith(`[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\nIt still owes the requester an answer: answer it through answer_request (requestId "req_Armed001") in this turn`), text);
});

test('the prompt starts with the tracker header naming the open request, then the marker and the job\'s text; the turn is the request\'s', async () => {
  const { deps, getForwardRun } = createHarness();
  await createScheduleDelivery(deps)(makeJob(), onTime);
  const { text, requestId } = getForwardRun();
  assert.equal(requestId, 'req_Armed001');
  assert.equal(
    text,
    `[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\n` +
      'Answer it through answer_request (requestId "req_Armed001") only when you have a result the requester needs. Nothing of this run is shown on the issue.\n' +
      '[Scheduled run "watch worker"]\nThe worker is done: read its result.',
  );
});

test('a fresh session starts on the connector\'s own backend, never on the job\'s snapshot of an adapter', async () => {
  const { deps, calls } = createHarness();
  await createScheduleDelivery(deps)(makeJob(), onTime);
  assert.deepEqual(calls.find((call) => call.step === 'ensureSession')?.detail, { key: issueThreadKey, fallbackAdapterName: connectorAdapterName });
});

test('the request is picked at FORWARD time: the post waited behind a running turn, the request it was armed under was answered and replaced meanwhile', async () => {
  const replacement = makeRequest('req_Replace01', 3000, { supersededRequestIds: ['req_Armed001'] });
  const { deps, getForwardRun } = createHarness({
    // Read 1 builds the text that stands on its own (the hold); read 2 is the one right before the forward.
    openRequestReads: [[makeRequest('req_Armed001', 1000)], [replacement]],
    busyValues: [true, false],
  });
  await createScheduleDelivery(deps)(makeJob(), onTime);
  const { text, requestId } = getForwardRun();
  assert.equal(requestId, 'req_Replace01', 'the open request that replaced the one the job was armed under');
  assert.ok(text.includes('request req_Replace01 is open'), text);
  assert.ok(!text.includes('req_Armed001'), 'the stale pick is gone from the text');
});

test('with no request open the header says so, names the finished request, and no turn is watched (request id null)', async () => {
  const { deps, getForwardRun } = createHarness({ openRequestReads: [[]] });
  const outcome = await createScheduleDelivery(deps)(makeJob(), onTime);
  assert.deepEqual(outcome, { status: 'delivered' });
  const { text, requestId } = getForwardRun();
  assert.equal(requestId, null);
  assert.ok(text.includes('· no request is open]'), text);
  assert.ok(text.includes('(req_Armed001) is finished'), text);
  assert.ok(text.includes('still becomes a comment and hands nothing back'), text);
  assert.ok(text.endsWith('[Scheduled run "watch worker"]\nThe worker is done: read its result.'), text);
});

test('a job armed under no request rides the newest open one', async () => {
  const { deps, getForwardRun } = createHarness({
    openRequestReads: [[makeRequest('req_Older0001', 1000), makeRequest('req_Newest001', 5000)]],
  });
  await createScheduleDelivery(deps)(makeJob({ requestId: undefined }), onTime);
  assert.equal(getForwardRun().requestId, 'req_Newest001');
});

test('a run held over a usage-limit wait is held with the header and its due note, and forwards nothing now', async () => {
  const { deps, calls, getSteps } = createHarness({ isHeld: true });
  const outcome = await createScheduleDelivery(deps)(makeJob(), { kind: 'catch-up', missedAtMs: Date.parse('2026-06-07T08:55:00.000Z') });
  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(!getSteps().includes('forwardRun'));
  const held = calls.find((call) => call.step === 'hold')?.detail as { text: string; heldText: string };
  assert.ok(held.text.startsWith(`[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]`), held.text);
  assert.ok(held.heldText.startsWith(`[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]`), held.heldText);
  assert.match(held.heldText, /\[Scheduled run "watch worker" · was due at /);
});

test('an unbound conversation fails with the distinct unbound error (the bot pauses the job), and a throwing forward fails with its message', async () => {
  const unbound = createHarness({ ensureResult: { ok: false, reason: 'unbound' } });
  assert.deepEqual(await createScheduleDelivery(unbound.deps)(makeJob(), onTime), { status: 'failed', error: 'thread is unbound' });
  assert.ok(!unbound.getSteps().includes('forwardRun'));
  const throwing = createHarness({ forwardRunThrows: true });
  assert.deepEqual(await createScheduleDelivery(throwing.deps)(makeJob(), onTime), { status: 'failed', error: 'forward boom' });
});

test('a check that keeps passing posts nothing, even with a status source and a port that would show lines', async () => {
  const { deps, getSteps } = createHarness({ isStatusShown: true });
  const job = makeCheckJob({ statusWorkerRunDir: '/work/run' });
  assert.deepEqual(await createScheduleDelivery(deps)(job, onTime), { status: 'delivered' });
  assert.deepEqual(getSteps(), [], 'no status line, no read of the worker, no wake');
});

test('a check\'s first failure posts no alert: the flag is stored, then the agent is woken behind the header with the tracker wording', async () => {
  const { deps, getSteps, getForwardRun } = createHarness({ checkResult: failingRun, isStatusShown: true });
  const outcome = await createScheduleDelivery(deps)(makeCheckJob({ statusWorkerRunDir: '/work/run' }), onTime);
  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getSteps(), ['setCheckFailing', 'ensureSession', 'forwardRun'], 'no announce, no status clearing: the flag first, then the wake');
  const { text, requestId } = getForwardRun();
  assert.equal(requestId, 'req_Armed001');
  assert.ok(text.startsWith(`[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\n`), text);
  assert.ok(text.includes('[Scheduled check "watch worker" failed]'), text);
  assert.ok(text.includes('worker 4242 exited'), 'the output tail is the agent\'s');
  assert.ok(text.includes('The bot stays silent while the check keeps failing and posts nothing on the issue when it passes again.'), text);
  assert.ok(!text.includes('tells the topic'), 'no word of a topic');
  assert.ok(text.endsWith('The worker is done: read its result.'), text);
});

test('a failure while already failing stays silent; a pass after a failure clears the flag and posts no line', async () => {
  const stillFailing = createHarness({ checkResult: failingRun });
  await createScheduleDelivery(stillFailing.deps)(makeCheckJob({ isCheckFailing: true }), onTime);
  assert.deepEqual(stillFailing.getSteps(), []);

  const recovered = createHarness({ checkResult: passingRun, isStatusShown: true });
  await createScheduleDelivery(recovered.deps)(makeCheckJob({ isCheckFailing: true, statusWorkerRunDir: '/work/run' }), onTime);
  assert.deepEqual(recovered.getSteps(), ['setCheckFailing'], 'the flag only — nothing is announced, no line follows');
  assert.deepEqual(recovered.calls[0].detail, { jobId: 'watch-worker-abc123', isFailing: false });
});

test('a Telegram topic beside it is delivered exactly as before: announced, forwarded by the ordinary forward, never through forwardRun', async () => {
  const { deps, getSteps } = createHarness({ isTracker: false });
  const outcome = await createScheduleDelivery(deps)(makeJob({ threadKey: topicThreadKey }), onTime);
  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getSteps(), ['announce', 'ensureSession', 'forward']);

  const check = createHarness({ isTracker: false, checkResult: failingRun });
  await createScheduleDelivery(check.deps)(makeCheckJob({ threadKey: topicThreadKey }), onTime);
  assert.deepEqual(check.getSteps(), ['setCheckFailing', 'announce', 'ensureSession', 'forward'], 'the check alert is announced in a topic');
  const forwarded = check.calls.find((call) => call.step === 'forward')?.detail as { text: string };
  assert.ok(forwarded.text.includes('tells the topic when it passes again'), 'the topic wording');
});

test('without the tracker ports at all every conversation is a topic', async () => {
  const { deps, getSteps } = createHarness();
  const withoutPorts: ScheduleDeliveryDeps = { ...deps, trackerRun: undefined };
  await createScheduleDelivery(withoutPorts)(makeJob(), onTime);
  assert.deepEqual(getSteps(), ['announce', 'ensureSession', 'forward']);
});
