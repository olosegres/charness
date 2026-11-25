/**
 * @description How a scheduler fire meets the request core (`scheduler/scheduledRunTarget.ts`, `src/requests/README.md` § Scheduled
 * runs): which open request it rides — in a tracker conversation the one the job was armed under, the one that replaced it, the newest,
 * none; in a topic with requests the job's request, the scheduler's own, or a new scheduler's request — and the header the prompt
 * starts with. The topic cases are the reports' cases of the fire's request lifecycle: a fire never replaces a live request.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenRequestState } from '../requests/types';
import { plainTextHiddenSentence } from '../requests/requestHeader';
import { buildTopicScheduledRunHeader, buildTrackerScheduledRunHeader, getRiddenRequest, pickTopicRunTarget, pickTrackerRunTarget } from '../scheduler/scheduledRunTarget';

function createRequest(id: string, overrides: Partial<OpenRequestState> = {}): OpenRequestState {
  return {
    id,
    origin: { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-12', requester: 'ann' } },
    createdAt: 1000,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    ...overrides,
  };
}

describe('pickTrackerRunTarget', () => {
  it('rides the request the job was armed under, while it is open', () => {
    const armedUnder = createRequest('req_Armed001', { createdAt: 1000 });
    const newer = createRequest('req_Newer001', { createdAt: 2000 });
    assert.deepEqual(pickTrackerRunTarget({ requestId: 'req_Armed001' }, [armedUnder, newer]), { kind: 'request', request: armedUnder });
  });

  it('rides the open request that replaced the one the job was armed under', () => {
    const replacement = createRequest('req_Replace01', { createdAt: 3000, supersededRequestIds: ['req_Gone0001', 'req_Armed001'] });
    const other = createRequest('req_Other0001', { createdAt: 4000 });
    assert.deepEqual(pickTrackerRunTarget({ requestId: 'req_Armed001' }, [replacement, other]), { kind: 'request', request: replacement });
  });

  it('with no request of its own open, rides the newest open one — the last of the oldest-first list the ledger returns', () => {
    const older = createRequest('req_Older001', { createdAt: 1000 });
    const middle = createRequest('req_Middle01', { createdAt: 3000 });
    const newest = createRequest('req_Newest01', { createdAt: 5000 });
    assert.deepEqual(pickTrackerRunTarget({ requestId: 'req_Closed001' }, [older, middle, newest]), { kind: 'request', request: newest });
    assert.deepEqual(pickTrackerRunTarget({ requestId: undefined }, [older, newest]), { kind: 'request', request: newest });
  });

  it('with no request open: none, naming the finished request the job was armed under', () => {
    assert.deepEqual(pickTrackerRunTarget({ requestId: 'req_Closed001' }, []), { kind: 'none', finishedRequestId: 'req_Closed001' });
    assert.deepEqual(pickTrackerRunTarget({ requestId: undefined }, []), { kind: 'none' });
  });
});

describe('pickTopicRunTarget — a topic with requests: a fire rides, and opens the scheduler\'s request only when there is none to ride', () => {
  const scheduler = { kind: 'scheduledRun' as const, attributes: { requester: 'scheduler' } };
  const operator = { kind: 'message' as const, attributes: { requester: '424242' } };

  it('rides the request its job was armed under — the operator\'s, or the one that replaced it — not a request of its own', () => {
    const operatorRequest = createRequest('req_Operator1', { origin: operator, progressAnswerCount: 1 });
    const schedulerRequest = createRequest('req_Sched0001', { origin: scheduler, createdAt: 2000 });
    assert.deepEqual(pickTopicRunTarget({ requestId: operatorRequest.id }, [operatorRequest, schedulerRequest]), { kind: 'request', request: operatorRequest });
    const replacement = createRequest('req_Operator2', { origin: operator, supersededRequestIds: [operatorRequest.id] });
    assert.deepEqual(pickTopicRunTarget({ requestId: operatorRequest.id }, [replacement]), { kind: 'request', request: replacement });
  });

  it('rides the scheduler\'s open request instead of replacing it — answered (the operator has «working on it», report 10) or not, its turn still running (report 11 #3)', () => {
    const answered = createRequest('req_Sched0001', { origin: scheduler, progressAnswerCount: 1 });
    assert.deepEqual(pickTopicRunTarget({ requestId: undefined }, [answered]), { kind: 'request', request: answered }, 'an unrelated job\'s fire');
    assert.deepEqual(pickTopicRunTarget({ requestId: answered.id }, [answered]), { kind: 'request', request: answered }, 'the watch armed under it (report 11 #2)');
    const running = createRequest('req_Sched0002', { origin: scheduler });
    assert.deepEqual(pickTopicRunTarget({ requestId: undefined }, [running]), { kind: 'request', request: running });
  });

  it('a scheduler\'s request the bot gave up on is ridden by nothing, not even by its own job\'s fire: the fire opens a new one (report 11 #1)', () => {
    const givenUp = createRequest('req_Sched0001', { origin: scheduler, progressAnswerCount: 1, isWakeStopped: true });
    assert.deepEqual(pickTopicRunTarget({ requestId: undefined }, [givenUp]), { kind: 'ownRequest' });
    assert.deepEqual(pickTopicRunTarget({ requestId: givenUp.id }, [givenUp]), { kind: 'ownRequest' });
    // A person's request the bot gave up on is still the job's: a fire rides it, as in a tracker conversation.
    const givenUpOperator = createRequest('req_Operator1', { origin: operator, isWakeStopped: true });
    assert.deepEqual(pickTopicRunTarget({ requestId: givenUpOperator.id }, [givenUpOperator]), { kind: 'request', request: givenUpOperator });
  });

  it('with none to ride — nothing open, the job\'s request finished, or only a person\'s request the job was not armed under — the fire opens the scheduler\'s request', () => {
    assert.deepEqual(pickTopicRunTarget({ requestId: undefined }, []), { kind: 'ownRequest' });
    assert.deepEqual(pickTopicRunTarget({ requestId: 'req_Closed001' }, []), { kind: 'ownRequest' });
    const unrelated = createRequest('req_Operator1', { origin: operator });
    assert.deepEqual(pickTopicRunTarget({ requestId: undefined }, [unrelated]), { kind: 'ownRequest' }, 'a person\'s request is ridden only by its own job');
  });
});

describe('getRiddenRequest', () => {
  it('says whether the fire\'s job is the request\'s own and whether the request owes its requester an answer (review 14 #3: the lost-work note\'s wording follows it)', () => {
    const answered = createRequest('req_Armed001', { progressAnswerCount: 1 });
    assert.deepEqual(getRiddenRequest({ requestId: 'req_Armed001' }, answered), { requestId: 'req_Armed001', isRequestJob: true, isAnswerOwed: false });
    assert.deepEqual(getRiddenRequest({ requestId: 'req_Other0001' }, answered), { requestId: 'req_Armed001', isRequestJob: false, isAnswerOwed: false });
    assert.deepEqual(getRiddenRequest({ requestId: 'req_Armed001' }, { ...answered, isPersonInputUnanswered: true }), { requestId: 'req_Armed001', isRequestJob: true, isAnswerOwed: true });
  });
});

describe('buildTopicScheduledRunHeader', () => {
  it('names the request the fire rides and asks for an answer only with a result — or in this turn when it owes one; the answers-only view says the plain text is hidden', () => {
    const request = createRequest('req_Operator1', { origin: { kind: 'message', attributes: {} }, progressAnswerCount: 1 });
    assert.equal(
      buildTopicScheduledRunHeader({ jobName: 'watch worker', request, isPlainTextHidden: false }),
      '[Scheduled run "watch worker" · request req_Operator1 is open]\n' +
        'Answer it through answer_request (requestId "req_Operator1") only when you have a result the requester needs.\n',
    );
    assert.equal(
      buildTopicScheduledRunHeader({ jobName: 'watch worker', request: { ...request, isPersonInputUnanswered: true }, isPlainTextHidden: true }),
      '[Scheduled run "watch worker" · request req_Operator1 is open]\n' +
        'It still owes the requester an answer: answer it through answer_request (requestId "req_Operator1") in this turn, whatever this run finds.\n' +
        `${plainTextHiddenSentence}\n`,
    );
  });
});

describe('buildTrackerScheduledRunHeader', () => {
  const conversationLabel = 'Jira issue PROJ-12 (https://example.atlassian.net/browse/PROJ-12)';

  it('an open request that owes nothing: its id, answer only with a result, nothing shown on the issue', () => {
    const header = buildTrackerScheduledRunHeader({
      jobName: 'watch worker',
      conversationLabel,
      target: { kind: 'request', request: createRequest('req_Armed001', { progressAnswerCount: 1 }) },
    });
    assert.equal(
      header,
      `[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\n` +
        'Answer it through answer_request (requestId "req_Armed001") only when you have a result the requester needs. Nothing of this run is shown on the issue.\n',
    );
  });

  it('an open request that still owes the requester an answer says so and asks for it in this turn — the fire\'s turn is no quiet one, so the agent is not left to learn it from the reminder', () => {
    const owed: Array<[string, Partial<OpenRequestState>]> = [
      ['a comment whose turn was lost', { progressAnswerCount: 1, isPersonInputUnanswered: true }],
      ['a silent turn pending', { progressAnswerCount: 1, silentTurnCount: 1 }],
      ['a request never answered', {}],
    ];
    for (const [label, overrides] of owed) {
      const header = buildTrackerScheduledRunHeader({
        jobName: 'watch worker',
        conversationLabel,
        target: { kind: 'request', request: createRequest('req_Armed001', overrides) },
      });
      assert.equal(
        header,
        `[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\n` +
          'It still owes the requester an answer: answer it through answer_request (requestId "req_Armed001") in this turn, whatever this run finds. Nothing of this run is shown on the issue.\n',
        label,
      );
      assert.ok(!header.includes('only when you have a result'), label);
    }
  });

  it('no request open: says so, names the finished one, an answer to it hands nothing back, cancel what served only it', () => {
    const header = buildTrackerScheduledRunHeader({ jobName: 'deploy check', conversationLabel, target: { kind: 'none', finishedRequestId: 'req_Closed001' } });
    assert.ok(header.startsWith(`[Scheduled run "deploy check" · ${conversationLabel} · no request is open]\n`), header);
    assert.ok(header.includes('(req_Closed001) is finished'), header);
    assert.ok(header.includes('still becomes a comment and hands nothing back'), header);
    assert.ok(header.includes('Answer only if the requester must know'), header);
    assert.ok(header.includes('cancel this job (schedule_cancel) if it served only that request'), header);
    assert.ok(header.includes('Nothing of this run is shown on the issue.'), header);
  });

  it('a job armed under no request: no request to name, nothing to answer through', () => {
    const header = buildTrackerScheduledRunHeader({ jobName: 'job', conversationLabel, target: { kind: 'none' } });
    assert.ok(header.includes('no request is open]'), header);
    assert.ok(header.includes('armed under no request'), header);
    assert.ok(!header.includes('schedule_cancel'), header);
  });
});
