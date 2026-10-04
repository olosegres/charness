/**
 * @description Pure decisions for Telegram request intake (request/answer plan
 * S7): WHEN an operator message or a scheduled run in a topic opens a request,
 * and WHAT the request's origin and prompt header say. `bot.ts` applies them at
 * the user entry points (text, voice, file, album, `/schedule`, the scheduler's
 * forward) — never inside the shared prompt choke point, which also carries
 * non-requests (the API-retry "continue" nudge, wake-up reminders, replays).
 */
import type { RequestOrigin } from '../requests/types';
import { buildRequestHeader } from '../requests/requestHeader';
import type { TopicView } from '../types';
import { checkAreRequestsEnabled, checkIsStreamShown } from './topicView';

/**
 * @name TopicRequestSource
 * @description The entry point a topic request came through. It is recorded in
 * the origin's attributes and names the request to the agent.
 */
export type TopicRequestSource = 'text' | 'voice' | 'file' | 'album' | 'schedule' | 'scheduledRun';

/** The attribute name the source is stored under in a topic request's origin. */
export const topicRequestSourceAttribute = 'source';

/** What the agent is told the request came from, per entry point. */
const topicRequestOriginDescriptions: Readonly<Record<TopicRequestSource, string>> = {
  text: 'a message in this topic',
  voice: 'a voice message in this topic',
  file: 'a file sent to this topic',
  album: 'an album sent to this topic',
  schedule: 'a /schedule request in this topic',
  scheduledRun: 'a scheduled run in this topic',
};

/**
 * @description Whether a prompt in a topic opens a request: its view has
 * requests on, and the text is not a slash command forwarded to the agent
 * (`/clear`, `/compact`, … are control tokens, not work the agent owes an answer
 * to). Answers to the agent's own native questions never reach this decision —
 * their routes return before the prompt path.
 */
export function checkShouldOpenTopicRequest(view: TopicView, isSlashCommand: boolean): boolean {
  return checkAreRequestsEnabled(view) && !isSlashCommand;
}

/** @description The origin a topic request is opened with. */
export function getTopicRequestOrigin(source: TopicRequestSource): RequestOrigin {
  return { kind: source === 'scheduledRun' ? 'scheduledRun' : 'message', attributes: { [topicRequestSourceAttribute]: source } };
}

/**
 * @description The header that rides the request's prompt. In the answers-only
 * view the agent is told its plain text is not shown; in the stream views it is.
 */
export function buildTopicRequestHeader(requestId: string, source: TopicRequestSource, view: TopicView): string {
  return buildRequestHeader({
    requestId,
    originDescription: topicRequestOriginDescriptions[source],
    isPlainTextHidden: !checkIsStreamShown(view),
  });
}
