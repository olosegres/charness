/**
 * @description «A request waits for its schedule» (`requests/scheduleWait.ts`): the three readings over a conversation's
 * jobs — which jobs count (armed under the request or one it replaced; agent jobs; not paused) and how a failing check
 * differs from a passing one.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsUnansweredFireRequest,
  checkIsAnswerOwed,
  checkIsHeldBetweenTurns,
  checkIsJobArmedUnderRequest,
  checkIsWaitingAtTurnEnd,
  checkIsWaitingBetweenTurns,
  getRequestScheduleWait,
  pickRequestToArmUnder,
} from '../requests/scheduleWait';
import type { OpenRequestState } from '../requests/types';
import type { ScheduleRecord } from '../scheduler/types';

const request = { id: 'req_Current1', supersededRequestIds: ['req_Older001', 'req_Older002'] };

function createJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'job-1',
    threadKey: 'jira:PROJ:PROJ-1',
    name: 'watch worker',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'check the worker',
    createdBy: 'agent',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    nextRunAt: 1,
    requestId: request.id,
    ...overrides,
  };
}

describe('checkIsJobArmedUnderRequest', () => {
  it('a job is armed under the request it names and under every request that one replaced', () => {
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Current1' }), request), true);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older001' }), request), true);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older002' }), request), true);
  });

  it('another request\'s job, or a job armed under none, is not armed under it', () => {
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Other' }), request), false);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: undefined }), request), false);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older001' }), { id: 'req_Current1' }), false);
  });
});

describe('getRequestScheduleWait', () => {
  it('no jobs, or none armed under the request: none', () => {
    assert.equal(getRequestScheduleWait([], request), 'none');
    assert.equal(getRequestScheduleWait([createJob({ requestId: 'req_Other' }), createJob({ requestId: undefined })], request), 'none');
  });

  it('a prompt job and a passing check watch the request', () => {
    assert.equal(getRequestScheduleWait([createJob({ spec: { kind: 'once', onceAtIso: '2026-11-23T10:00:00.000Z' } })], request), 'watching');
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'true' })], request), 'watching');
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'true', isCheckFailing: false })], request), 'watching');
  });

  it('a failing check alone only arms it — a watch that just fired', () => {
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true })], request), 'armed');
  });

  it('one job that is not failing is enough for `watching`, whatever order the others come in', () => {
    const failing = createJob({ id: 'a', deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true });
    const passing = createJob({ id: 'b', deliveryKind: 'check', checkCommand: 'true' });
    assert.equal(getRequestScheduleWait([failing, passing], request), 'watching');
    assert.equal(getRequestScheduleWait([passing, failing], request), 'watching');
  });

  it('a reminder wakes nobody and a paused job fires nothing: neither counts', () => {
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'reminder' })], request), 'none');
    assert.equal(getRequestScheduleWait([createJob({ isPaused: true, pauseReason: 'unbound' })], request), 'none');
    assert.equal(
      getRequestScheduleWait([createJob({ deliveryKind: 'reminder' }), createJob({ id: 'c', isPaused: true }), createJob({ id: 'd', deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true })], request),
      'armed',
    );
  });

  it('a job armed under a request this one replaced still counts', () => {
    assert.equal(getRequestScheduleWait([createJob({ requestId: 'req_Older002' })], request), 'watching');
  });
});

describe('what each reading means to the rules', () => {
  it('the end of a watched turn reads `watching` as waiting, and `armed` only for the turn a fire started; between turns only `watching` holds the request', () => {
    assert.deepEqual((['none', 'armed', 'watching'] as const).map((wait) => checkIsWaitingAtTurnEnd(wait, false)), [false, false, true], 'a person\'s or a reminder\'s turn');
    assert.deepEqual((['none', 'armed', 'watching'] as const).map((wait) => checkIsWaitingAtTurnEnd(wait, true)), [false, true, true], 'the turn a fire started');
    assert.deepEqual((['none', 'armed', 'watching'] as const).map(checkIsWaitingBetweenTurns), [false, false, true]);
  });
});

describe('checkIsUnansweredFireRequest — the alarm\'s own request the agent never answered', () => {
  type FireFields = Pick<OpenRequestState, 'origin' | 'progressAnswerCount' | 'isSupersededRequestAnswered'>;
  const fire: FireFields = { origin: { kind: 'scheduledRun', attributes: {} }, progressAnswerCount: 0 };

  it('only a scheduled run\'s request, never answered, and not one that replaced an answered request', () => {
    assert.equal(checkIsUnansweredFireRequest(fire), true);
    assert.equal(checkIsUnansweredFireRequest({ ...fire, progressAnswerCount: 1 }), false, 'answered `progress`');
    assert.equal(checkIsUnansweredFireRequest({ ...fire, isSupersededRequestAnswered: true }), false, 'it replaced a fire request the agent had answered: the operator was told «working on it»');
    assert.equal(checkIsUnansweredFireRequest({ ...fire, isSupersededRequestAnswered: false }), true);
    assert.equal(checkIsUnansweredFireRequest({ ...fire, origin: { kind: 'message', attributes: {} } }), false, 'a person\'s request is never the alarm\'s');
    assert.equal(checkIsUnansweredFireRequest({ ...fire, origin: { kind: 'trackerEvent', attributes: {} } }), false);
  });
});

describe('checkIsAnswerOwed / checkIsHeldBetweenTurns — what a watch may never hide', () => {
  type OwedFields = Pick<OpenRequestState, 'silentTurnCount' | 'isPersonInputUnanswered' | 'progressAnswerCount' | 'origin'>;
  const personRequest: OwedFields = { silentTurnCount: 0, progressAnswerCount: 1, origin: { kind: 'trackerEvent', attributes: {} } };

  it('a pending silent turn, a person\'s words after the last answer, and a person\'s request never answered are each owed; an answered one is not', () => {
    assert.equal(checkIsAnswerOwed(personRequest), false, 'answered, nothing pending: owes nothing');
    assert.equal(checkIsAnswerOwed({ ...personRequest, silentTurnCount: 1 }), true, 'a silent turn is pending');
    assert.equal(checkIsAnswerOwed({ ...personRequest, isPersonInputUnanswered: true }), true, 'a person\'s words are not answered yet');
    assert.equal(checkIsAnswerOwed({ ...personRequest, isPersonInputUnanswered: false }), false);
    assert.equal(checkIsAnswerOwed({ ...personRequest, progressAnswerCount: 0 }), true, 'never answered at all');
  });

  it('a request a scheduler fire opened (`scheduledRun`) is the alarm\'s: never answered, it owes nobody — unless a silent turn is pending', () => {
    const alarm: OwedFields = { ...personRequest, progressAnswerCount: 0, origin: { kind: 'scheduledRun', attributes: {} } };
    assert.equal(checkIsAnswerOwed(alarm), false);
    assert.equal(checkIsAnswerOwed({ ...alarm, silentTurnCount: 1 }), true);
  });

  it('only `watching` holds a request, and only while it owes nothing', () => {
    const owed: OwedFields = { ...personRequest, isPersonInputUnanswered: true };
    assert.deepEqual((['none', 'armed', 'watching'] as const).map((wait) => checkIsHeldBetweenTurns(personRequest, wait)), [false, false, true]);
    assert.deepEqual((['none', 'armed', 'watching'] as const).map((wait) => checkIsHeldBetweenTurns(owed, wait)), [false, false, false]);
  });
});

describe('pickRequestToArmUnder — the request a new job is armed under', () => {
  const makeRequest = (id: string, createdAt: number, kind: OpenRequestState['origin']['kind'] = 'trackerEvent'): OpenRequestState => ({
    id,
    origin: { kind, attributes: {} },
    createdAt,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
  });

  it('none open: no request', () => {
    assert.equal(pickRequestToArmUnder([], []), undefined);
  });

  it('the request whose turn is watched wins over a newer one — a mention of another person does not take a hand-over\'s job', () => {
    const handOver = makeRequest('req_HandOver1', 1000);
    const mention = makeRequest('req_Mention01', 2000, 'trackerMention');
    assert.equal(pickRequestToArmUnder([handOver, mention], [handOver.id]), handOver.id);
    assert.equal(pickRequestToArmUnder([handOver, mention], [mention.id]), mention.id, 'the agent works on the mention now');
  });

  it('of several watched requests the newest (the list is oldest first); without a watched one the newest open request', () => {
    const older = makeRequest('req_Older0001', 1000);
    const newer = makeRequest('req_Newer0001', 2000);
    assert.equal(pickRequestToArmUnder([older, newer], [older.id, newer.id]), newer.id);
    assert.equal(pickRequestToArmUnder([older, newer], []), newer.id);
    assert.equal(pickRequestToArmUnder([older, newer], ['req_Unknown']), newer.id, 'a watched id that is not open is ignored');
  });

  it('a watch a forward of the request\'s OWN started wins over a request a conversation-wide forward only carried along; inside a tier a hand-over comes before a newer mention', () => {
    const handOver = makeRequest('req_HandOver1', 1000);
    const mention = makeRequest('req_Mention01', 2000, 'trackerMention');
    const both = [handOver.id, mention.id];
    assert.equal(pickRequestToArmUnder([handOver, mention], both, [handOver.id]), handOver.id, 'a «continue» watched both, the hand-over\'s own forward started its watch');
    assert.equal(pickRequestToArmUnder([handOver, mention], both, [mention.id]), mention.id, 'the agent works on the mention: its own forward');
    // Both requests have a watch a forward of their own started: the OLDEST (the list is oldest first) started the running turn.
    assert.equal(pickRequestToArmUnder([handOver, mention], both, [mention.id, handOver.id]), mention.id, 'the mention started the turn, the hand-over\'s comment joined it');
    assert.equal(pickRequestToArmUnder([handOver, mention], both, [handOver.id, mention.id]), handOver.id, 'the hand-over started the turn, the mention joined it');
    assert.equal(pickRequestToArmUnder([handOver, mention], both, []), handOver.id, 'a restart wake watched both: the hand-over before the newer mention');
    assert.equal(pickRequestToArmUnder([handOver, mention], [], []), handOver.id, 'nothing watched: the hand-over before the newer mention');
    assert.equal(pickRequestToArmUnder([mention, handOver], both, []), handOver.id, 'whatever the order');
    const newerHandOver = makeRequest('req_HandOver2', 3000);
    assert.equal(pickRequestToArmUnder([handOver, mention, newerHandOver], [], []), newerHandOver.id, 'two hand-overs: the newest');
    const operator = makeRequest('req_Operator01', 1000, 'message');
    const colleague = makeRequest('req_Colleague1', 2000, 'message');
    assert.equal(pickRequestToArmUnder([operator, colleague], [operator.id, colleague.id], []), colleague.id, 'no tracker origin: the newest, as before');
  });

  it('a request a scheduler fire opened is passed over for any other — watched or newest — and is the pick only when it is all there is', () => {
    const operator = makeRequest('req_Operator01', 1000, 'message');
    const fire = makeRequest('req_Fire000001', 3000, 'scheduledRun');
    assert.equal(pickRequestToArmUnder([operator, fire], [fire.id]), operator.id, 'the fire\'s turn is the one watched, the operator\'s request is the one that waits');
    assert.equal(pickRequestToArmUnder([operator, fire], []), operator.id);
    assert.equal(pickRequestToArmUnder([fire], [fire.id]), fire.id);
  });
});

