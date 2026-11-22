import { checkIsAnswerOwed, checkIsJobArmedUnderRequest } from '../requests/scheduleWait';
import { buildResultOnlyAnswerLine, plainTextHiddenSentence } from '../requests/requestHeader';
import type { OpenRequestState } from '../requests/types';
import type { ScheduleRecord } from './types';

/**
 * @description How a scheduler fire meets the request/answer core — ONE model for a Telegram topic whose view has requests and a
 * Jira issue (`src/requests/README.md` § Scheduled runs). A fire never replaces a request: it RIDES one, picked at forward time (the
 * post may have waited behind a running turn) — the request its job was armed under, while it is open; else, in a topic, the
 * scheduler's own request, in an issue the newest open request; else, in a topic, a NEW scheduler's request, in an issue none. The two
 * differences are the ones Jira forces: an issue's only party is the requester whose hand-over request owes the answer, and a request of
 * the scheduler's there would comment (always notifying) and owe an answer nobody asked for. Pure: the bot feeds it the open requests and
 * puts the header in front of the scheduled prompt.
 */

/**
 * @name TrackerRunTarget
 * @description The request a tracker fire rides, or none. `finishedRequestId` is the request the job was armed under when no
 * request is open any more (its id, closed): an answer to it still becomes a comment and hands nothing back.
 */
export type TrackerRunTarget =
  | { kind: 'request'; request: OpenRequestState }
  | { kind: 'none'; finishedRequestId?: string };

/**
 * @name TopicRunTarget
 * @description The request a topic fire rides, or `ownRequest`: none to ride, so the fire opens the scheduler's request.
 */
export type TopicRunTarget =
  | { kind: 'request'; request: OpenRequestState }
  | { kind: 'ownRequest' };

/**
 * @description Whether `request` is the scheduler's request (a topic's `scheduledRun`) the bot GAVE UP on (`isWakeStopped`): the
 * operator was told it could not finish, so no fire rides it — the next one opens a new request in its place.
 */
function checkIsGivenUpSchedulerRequest(request: OpenRequestState): boolean {
  return request.origin.kind === 'scheduledRun' && request.isWakeStopped;
}

/**
 * @description The job's request: the open one `job` was armed under (its id, or a request that replaced it —
 * `supersededRequestIds`), whoever raised it, unless it is a scheduler's request the bot gave up on. `openRequests` is oldest first,
 * as `RequestLedger.listOpenRequestsOf` returns it: the newest of a list is its last.
 */
function getJobRequest(job: Pick<ScheduleRecord, 'requestId'>, openRequests: readonly OpenRequestState[]): OpenRequestState | undefined {
  return openRequests.filter((request) => checkIsJobArmedUnderRequest(job, request) && !checkIsGivenUpSchedulerRequest(request)).at(-1);
}

/** @description The request a fire of `job` rides in a tracker conversation: the job's request; else the newest open one; else none. */
export function pickTrackerRunTarget(job: Pick<ScheduleRecord, 'requestId'>, openRequests: readonly OpenRequestState[]): TrackerRunTarget {
  const request = getJobRequest(job, openRequests) ?? openRequests.at(-1);
  if (request) return { kind: 'request', request };
  return job.requestId === undefined ? { kind: 'none' } : { kind: 'none', finishedRequestId: job.requestId };
}

/**
 * @description The request a fire of `job` rides in a topic whose view has requests: the job's request; else the scheduler's open
 * request (at most one: they share one requester), unless the bot gave up on it; else `ownRequest` — a person's request the job was
 * not armed under is never ridden.
 */
export function pickTopicRunTarget(job: Pick<ScheduleRecord, 'requestId'>, openRequests: readonly OpenRequestState[]): TopicRunTarget {
  const request = getJobRequest(job, openRequests)
    ?? openRequests.find((open) => open.origin.kind === 'scheduledRun' && !checkIsGivenUpSchedulerRequest(open));
  return request ? { kind: 'request', request } : { kind: 'ownRequest' };
}

/**
 * @description The line under a header that names the request a fire rides: answer it only with a result the requester needs —
 * unless the request still OWES the requester an answer (`checkIsAnswerOwed`: words whose turn a restart lost, a silent turn pending,
 * a person's request never answered): then the fire's turn is no quiet one (`decideTurnEnd`), and the agent is told to answer it in
 * this turn instead of learning it from the reminder.
 */
function buildRiddenRequestLine(request: OpenRequestState): string {
  return checkIsAnswerOwed(request)
    ? `It still owes the requester an answer: answer it through answer_request (requestId "${request.id}") in this turn, whatever this run finds.`
    : buildResultOnlyAnswerLine(request.id);
}

/**
 * @name TrackerScheduledRunHeaderInput
 * @description `conversationLabel` names where the agent is (`Jira issue PROJ-12 (<link>)`) — a fresh session, one a
 * failed resume started, learns it from here.
 */
export interface TrackerScheduledRunHeaderInput {
  jobName: string;
  conversationLabel: string;
  target: TrackerRunTarget;
}

/** Said under every tracker header: a fire writes nothing on the issue, so the agent speaks only with a result. */
const nothingShownSentence = 'Nothing of this run is shown on the issue.';

/**
 * @description The header line (and the one or two sentences under it) a scheduled prompt starts with in a tracker conversation.
 * With an open request it names that request ({@link buildRiddenRequestLine}). With none open it says so, names the finished request
 * the job was armed under, and tells the agent that an answer to it still becomes a comment but hands nothing back, and to cancel a
 * job that served only that request. Agent-facing, so English; ends with a newline.
 */
export function buildTrackerScheduledRunHeader(input: TrackerScheduledRunHeaderInput): string {
  const lead = `[Scheduled run "${input.jobName}" · ${input.conversationLabel}`;
  const { target } = input;
  if (target.kind === 'request') {
    return `${lead} · request ${target.request.id} is open]\n${buildRiddenRequestLine(target.request)} ${nothingShownSentence}\n`;
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

/**
 * @name TopicScheduledRunHeaderInput
 * @description `isPlainTextHidden` — the topic's view shows only answers, so the requester never sees the agent's plain text.
 */
export interface TopicScheduledRunHeaderInput {
  jobName: string;
  request: OpenRequestState;
  isPlainTextHidden: boolean;
}

/**
 * @description The header a scheduled prompt starts with in a topic when the fire RIDES an open request (the job's, or the
 * scheduler's): the request it rides and when to answer it ({@link buildRiddenRequestLine}), plus, in the answers-only view, that the
 * requester sees only what goes through `answer_request`. A fire that opens the scheduler's request gets that request's own header
 * instead (`buildTopicRequestHeader`). Agent-facing, so English; ends with a newline.
 */
export function buildTopicScheduledRunHeader(input: TopicScheduledRunHeaderInput): string {
  const lines = [`[Scheduled run "${input.jobName}" · request ${input.request.id} is open]`, buildRiddenRequestLine(input.request)];
  if (input.isPlainTextHidden) lines.push(plainTextHiddenSentence);
  return `${lines.join('\n')}\n`;
}
