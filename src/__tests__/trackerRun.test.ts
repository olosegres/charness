/**
 * @description How a scheduler fire meets the request core in a tracker conversation (`scheduler/trackerRun.ts`): which
 * open request it rides (the one the job was armed under, the one that replaced it, the newest, none) and the header the
 * prompt starts with.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenRequestState } from '../requests/types';
import { buildTrackerScheduledRunHeader, pickScheduledRunTarget } from '../scheduler/trackerRun';

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

describe('pickScheduledRunTarget', () => {
  it('rides the request the job was armed under, while it is open', () => {
    const armedUnder = createRequest('req_Armed001', { createdAt: 1000 });
    const newer = createRequest('req_Newer001', { createdAt: 2000 });
    assert.deepEqual(pickScheduledRunTarget({ requestId: 'req_Armed001' }, [armedUnder, newer]), { kind: 'request', request: armedUnder });
  });

  it('rides the open request that replaced the one the job was armed under', () => {
    const replacement = createRequest('req_Replace01', { createdAt: 3000, supersededRequestIds: ['req_Gone0001', 'req_Armed001'] });
    const other = createRequest('req_Other0001', { createdAt: 4000 });
    assert.deepEqual(pickScheduledRunTarget({ requestId: 'req_Armed001' }, [replacement, other]), { kind: 'request', request: replacement });
  });

  it('with no request of its own open, rides the newest open one — the last of the oldest-first list the ledger returns', () => {
    const older = createRequest('req_Older001', { createdAt: 1000 });
    const middle = createRequest('req_Middle01', { createdAt: 3000 });
    const newest = createRequest('req_Newest01', { createdAt: 5000 });
    assert.deepEqual(pickScheduledRunTarget({ requestId: 'req_Closed001' }, [older, middle, newest]), { kind: 'request', request: newest });
    assert.deepEqual(pickScheduledRunTarget({ requestId: undefined }, [older, newest]), { kind: 'request', request: newest });
  });

  it('with no request open: none, naming the finished request the job was armed under', () => {
    assert.deepEqual(pickScheduledRunTarget({ requestId: 'req_Closed001' }, []), { kind: 'none', finishedRequestId: 'req_Closed001' });
    assert.deepEqual(pickScheduledRunTarget({ requestId: undefined }, []), { kind: 'none' });
  });
});

describe('buildTrackerScheduledRunHeader', () => {
  const conversationLabel = 'Jira issue PROJ-12 (https://example.atlassian.net/browse/PROJ-12)';

  it('an open request: its id, answer only with a result, nothing shown on the issue', () => {
    const header = buildTrackerScheduledRunHeader({
      jobName: 'watch worker',
      conversationLabel,
      target: { kind: 'request', request: createRequest('req_Armed001') },
    });
    assert.equal(
      header,
      `[Scheduled run "watch worker" · ${conversationLabel} · request req_Armed001 is open]\n` +
        'Answer it through answer_request (requestId "req_Armed001") only when you have a result the requester needs. Nothing of this run is shown on the issue.\n',
    );
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
