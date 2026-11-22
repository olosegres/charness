import { checkIsJobArmedUnderRequest } from '../requests/scheduleWait';
import type { OpenRequestState } from '../requests/types';
import type { ScheduleRecord } from './types';

/**
 * @description How a scheduler fire meets the request/answer core in a TRACKER conversation (a Jira issue). A fire opens NO
 * request of its own: the only party on an issue is the requester whose hand-over request owes the answer and the
 * hand-back, so the fire rides the request that is open — the way an issue update already does. Pure: the bot feeds it the
 * open requests at forward time (the post may have waited behind a running turn) and puts the header in front of the
 * scheduled prompt.
 */

/**
 * @name ScheduledRunTarget
 * @description The request a fire rides, or none. `finishedRequestId` is the request the job was armed under when no
 * request is open any more (its id, closed): an answer to it still becomes a comment and hands nothing back.
 */
export type ScheduledRunTarget =
  | { kind: 'request'; request: OpenRequestState }
  | { kind: 'none'; finishedRequestId?: string };

/** @description The newest request of `requests` by creation time (the later one of equal times). */
function getNewestRequest(requests: readonly OpenRequestState[]): OpenRequestState | undefined {
  return requests.reduce<OpenRequestState | undefined>((newest, request) => (newest === undefined || request.createdAt >= newest.createdAt ? request : newest), undefined);
}

/**
 * @description The request a fire of `job` rides: the one it was armed under (still open, or the open one that replaced
 * it — `supersededRequestIds`); else the newest open request of the conversation; else none.
 */
export function pickScheduledRunTarget(job: Pick<ScheduleRecord, 'requestId'>, openRequests: readonly OpenRequestState[]): ScheduledRunTarget {
  const armedUnder = getNewestRequest(openRequests.filter((request) => checkIsJobArmedUnderRequest(job, request)));
  if (armedUnder) return { kind: 'request', request: armedUnder };
  const newest = getNewestRequest(openRequests);
  if (newest) return { kind: 'request', request: newest };
  return job.requestId === undefined ? { kind: 'none' } : { kind: 'none', finishedRequestId: job.requestId };
}

/**
 * @name TrackerScheduledRunHeaderInput
 * @description `conversationLabel` names where the agent is (`Jira issue PROJ-12 (<link>)`) — a fresh session, one a
 * failed resume started, learns it from here.
 */
export interface TrackerScheduledRunHeaderInput {
  jobName: string;
  conversationLabel: string;
  target: ScheduledRunTarget;
}

/** Said under every header: a fire writes nothing on the issue, so the agent speaks only with a result. */
const nothingShownSentence = 'Nothing of this run is shown on the issue.';

/**
 * @description The header line (and the one or two sentences under it) a scheduled prompt starts with in a tracker
 * conversation. With an open request it names that request and says to answer it only when there is a result the requester
 * needs; with none open it says so, names the finished request the job was armed under, and tells the agent that an answer
 * to it still becomes a comment but hands nothing back, and to cancel a job that served only that request. Agent-facing,
 * so English; ends with a newline.
 */
export function buildTrackerScheduledRunHeader(input: TrackerScheduledRunHeaderInput): string {
  const lead = `[Scheduled run "${input.jobName}" · ${input.conversationLabel}`;
  const { target } = input;
  if (target.kind === 'request') {
    return `${lead} · request ${target.request.id} is open]\n` +
      `Answer it through answer_request (requestId "${target.request.id}") only when you have a result the requester needs. ${nothingShownSentence}\n`;
  }
  if (target.finishedRequestId === undefined) {
    return `${lead} · no request is open]\n` +
      `This job was armed under no request, so there is nothing to answer through. ${nothingShownSentence}\n`;
  }
  return `${lead} · no request is open]\n` +
    `The request this job was armed under (${target.finishedRequestId}) is finished: an answer_request to it still becomes a comment and hands nothing back. ` +
    'Answer only if the requester must know; cancel this job (schedule_cancel) if it served only that request. ' +
    `${nothingShownSentence}\n`;
}
