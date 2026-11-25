import { answerStyleInstruction } from './answerStyle';
import { refreshStoredPrompt } from './storedPromptRefresh';
import type { OpenRequestState, RequestWakeUpReason } from './types';

/**
 * @description The per-request header that rides inside the prompt text of every
 * request (request/answer core S3). The standing rule lives in the bot MCP's
 * connect-time instructions; the header is still needed per request because it
 * names THIS request's id, and because whether the requester sees the agent's
 * plain text can change mid-session (a Telegram view switch) or never holds
 * (a tracker). Agent-facing, so English on every surface.
 */

/**
 * @name RequestHeaderOptions
 * @description `originDescription` says where the request came from in a few
 * words ("a message in this topic", "PROJ-123 assigned to you by …").
 * `isPlainTextHidden` adds the line that the requester never sees the agent's
 * ordinary output or its thinking. `supersededRequestIds` are the same requester's earlier
 * requests this one replaced while they were still open (`requestGroup.ts`);
 * when given, the header names them and asks for only what THIS request adds.
 * The line holds in both timings (owner decision 2026-10-05): the agent reads it
 * mid-turn and gives one answer, or — Claude Code delivers a message written
 * mid-turn only after that turn ends — it has already answered the replaced
 * request and must not do the work twice.
 * `isAnswerOnlyWithResult` — a scheduled run's request (the scheduler's own, `src/requests/README.md` § Scheduled runs): a woken agent
 * with nothing to report stays silent, so the answer line asks for an answer only with a result ({@link buildResultOnlyAnswerLine}),
 * not a `final` at the end of every turn, and no superseded line is added (the only request it replaces is one the bot gave up on, and
 * nothing of that one is to be repeated).
 */
export interface RequestHeaderOptions {
  requestId: string;
  originDescription: string;
  isPlainTextHidden: boolean;
  supersededRequestIds?: readonly string[];
  isAnswerOnlyWithResult?: boolean;
}

/**
 * @description The answer line of every scheduled run's header — the scheduler's own request's and the one of a request a fire rides —
 * so the two cannot drift: answer only with a result the requester needs, else stay silent (a woken agent with nothing to report).
 */
export function buildResultOnlyAnswerLine(requestId: string): string {
  return `Answer it through answer_request (requestId "${requestId}") only when you have a result the requester needs.`;
}

/** The line that tells the agent its requester sees only its answers (a Telegram topic's answers-only view). */
export const plainTextHiddenSentence = 'The requester does not see your plain text output or your thinking — only what you send through answer_request reaches them.';

/** @description The header's line naming the requests this one replaced; empty when it replaced none. */
export function buildSupersededRequestsLine(supersededRequestIds: readonly string[]): string {
  if (supersededRequestIds.length === 0) return '';
  const isOne = supersededRequestIds.length === 1;
  return `It replaces the same requester's earlier ${isOne ? 'request' : 'requests'} ${supersededRequestIds.join(', ')}. ` +
    `If you already answered ${isOne ? 'it' : 'them'}, do not repeat that answer: reply only to what this message adds. ` +
    'If it adds nothing new, say briefly that the answer is above.';
}

/** @description The header block, ending with a blank line before the request's own text. */
export function buildRequestHeader(options: RequestHeaderOptions): string {
  const isAnswerOnlyWithResult = options.isAnswerOnlyWithResult === true;
  const lines = [
    `[Request ${options.requestId} · from: ${options.originDescription}]`,
    isAnswerOnlyWithResult
      ? buildResultOnlyAnswerLine(options.requestId)
      : `Answer it with the answer_request tool (requestId "${options.requestId}"): kind "final" with the full result at the end of your turn, ` +
        '"question" if you need the requester before you can go on, "progress" for an interim note.',
    answerStyleInstruction,
  ];
  const supersededLine = isAnswerOnlyWithResult ? '' : buildSupersededRequestsLine(options.supersededRequestIds ?? []);
  if (supersededLine !== '') lines.push(supersededLine);
  if (options.isPlainTextHidden) lines.push(plainTextHiddenSentence);
  return `${lines.join('\n')}\n\n`;
}

/** What the reminder tells the agent, per wake-up reason. */
const wakeUpReasonLines: Readonly<Record<RequestWakeUpReason, string>> = {
  silentTurn: 'Your last turn ended without answering it.',
  progressFollowUp: 'Some time has passed since your last progress note on it.',
  nothingArmed: 'Your last turn ended with it still open and nothing armed to wake you again: no job or watch of yours is armed under it. ' +
    'Nothing reminds you on a clock.',
  backstop: 'Nothing has been seen working on it for a long time (the session may have restarted).',
  postRetry: 'It could not be delivered to you earlier.',
  restarted: 'Your session ended and was resumed while you were working on it (the bot or your process restarted); carry on.',
};

/**
 * @name WakeUpMessage
 * @description What a wake-up forwards: the request's own prompt when it never
 * reached the agent (R21), else the reminder for `reason`.
 */
export interface WakeUpMessage {
  reason: RequestWakeUpReason;
  text: string;
  isRequestPrompt: boolean;
  /**
   * The reminder asks for an answer only with what the requester must know — the request waits for a passing watch and owes nobody an
   * answer, and the wake is a lost-work one (the agent's own work died with its process): the fire header's wording, so the agent
   * writes only when it did something. Never for a request's own prompt (R21: the agent never read it). The lost-work note the wake
   * carries follows it (`buildLostWorkNote`).
   */
  isAnswerOptional?: boolean;
}

/**
 * @description The request's own prompt while the session never took it in — its
 * post failed, a restart came first, a usage-limit wait held it (R21); `undefined`
 * once it was taken in, or when the request keeps no prompt. Brought up to date as it is read
 * (`refreshStoredPrompt`): it may have waited hours.
 */
export function getPromptNotTakenIn(request: OpenRequestState | null | undefined): string | undefined {
  if (request?.isPromptTakenIn === true || request?.prompt === undefined) return undefined;
  return refreshStoredPrompt(request.prompt);
}

/** Between two requests' prompts re-posted in one message (each prompt ends with its own text, not a blank line). */
const joinedPromptsSeparator = '\n\n';

/**
 * @name PromptsNotTakenIn
 * @description The prompts a resume re-posts in ONE text, and the requests they are: what the message carries is named when it is
 * built, and the turn it starts is tracked with those ids — never read again when it is tracked, which for a buffered message is its
 * replay, after other requests may have opened (review 21 nit 3).
 */
export interface PromptsNotTakenIn {
  text: string;
  requestIds: string[];
}

/**
 * @description The prompts of every request in `requests` the session never took
 * in, in the given order, as ONE text to post — a conversation may hold one open
 * request per requester, and a resume must re-post each of them — with the ids of
 * those requests. `undefined` when none is left to post.
 */
export function getPromptsNotTakenIn(requests: readonly OpenRequestState[]): PromptsNotTakenIn | undefined {
  const untaken = requests.flatMap((request) => {
    const prompt = getPromptNotTakenIn(request);
    return prompt === undefined ? [] : [{ requestId: request.id, prompt }];
  });
  if (untaken.length === 0) return undefined;
  return { text: untaken.map((entry) => entry.prompt).join(joinedPromptsSeparator), requestIds: untaken.map((entry) => entry.requestId) };
}

/**
 * @description R21: a request whose prompt was never taken in by the session gets
 * the prompt itself; a bare reminder would name a request the agent never read.
 */
export function getWakeUpMessage(request: OpenRequestState, reason: RequestWakeUpReason, options: { isAnswerOptional?: boolean } = {}): WakeUpMessage {
  const prompt = getPromptNotTakenIn(request);
  if (prompt !== undefined) return { reason, text: prompt, isRequestPrompt: true };
  const isAnswerOptional = options.isAnswerOptional === true;
  return {
    reason,
    text: buildWakeUpReminder({ requestId: request.id, reason, isAnswerOptional }),
    isRequestPrompt: false,
    ...(isAnswerOptional ? { isAnswerOptional } : {}),
  };
}

/** What the reminder asks for: the nudge of a tracker request nothing is armed to wake says how to wait; a watch still armed asks only for what matters. */
function getWakeUpAnswerLine(options: { requestId: string; reason: RequestWakeUpReason; isAnswerOptional?: boolean }): string {
  if (options.reason === 'nothingArmed') {
    return `Finish it with answer_request (requestId "${options.requestId}"): kind "final" if the work is done, "question" if you need the requester. ` +
      'If you wait on a worker or a run, arm a watch for it (schedule_create with a checkCommand), say in a "progress" note what you wait for ' +
      'and when it should end, and end your turn: the watch wakes you. If your next turn also ends with it open and nothing armed, you are ' +
      'taken to have stopped: the requester is told and it is given up.';
  }
  if (options.isAnswerOptional === true) {
    return `Your watch for it is still armed and nothing the requester wrote is waiting for your answer, so answer it with answer_request (requestId "${options.requestId}") ` +
      'only with what the requester must know — a short "progress" note if what was lost changes what they wait for, "final" if the work is ' +
      'done — otherwise continue without a comment.';
  }
  return `Answer it with answer_request (requestId "${options.requestId}"): kind "final" if the work is done, ` +
    '"question" if you need the requester, or a short "progress" note if you are still working — then continue.';
}

/**
 * @description The reminder the wake-up engine forwards into the SAME session for
 * an open request. It is not a request itself: it names the open one and asks
 * for the answer through `answer_request` — or, with `isAnswerOptional`, only for what the requester must know.
 */
export function buildWakeUpReminder(options: { requestId: string; reason: RequestWakeUpReason; isAnswerOptional?: boolean }): string {
  const answerLine = getWakeUpAnswerLine(options);
  return [
    `[Reminder · request ${options.requestId} is still open]`,
    wakeUpReasonLines[options.reason],
    answerLine,
    answerStyleInstruction,
  ].join('\n');
}
