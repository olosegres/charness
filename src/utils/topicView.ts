/**
 * @description THE single source of truth for the per-topic VIEW vocabulary
 * (request/answer plan S6): what a Telegram topic SHOWS of the agent's work.
 * The view never changes how the agent works — only what reaches the topic
 * and whether the operator's messages open requests the agent answers through
 * `answer_request`:
 *
 *   view             agent's stream   MCP answers        requests + wake-ups
 *   stream           shown            —                  off   (DEFAULT, today)
 *   streamAnswers    shown            shown, pinned      on
 *   answers          hidden           shown, pinned      on
 *
 * Mirrors `displayVerbosity.ts`: the option order, the locked default, the type
 * guard and the typed-argument parser live here; the rendering decisions that
 * READ a view (`checkIsStreamShown`, `checkAreRequestsEnabled`) live here too so
 * the stream gates and the request intake can never disagree on a view.
 */
import type { TopicView } from '../types';

/** Every selectable view, in picker-button order (loudest → quietest). */
export const topicViewOptions: readonly TopicView[] = ['stream', 'streamAnswers', 'answers'];

/** Locked default: nothing changes for a topic until it is switched. */
export const defaultTopicView: TopicView = 'stream';

/**
 * @description The typed `/verbosity` spelling of each view — the words the
 * public README documents (`/verbosity stream|stream_answers|answers`).
 */
export const topicViewArguments: Readonly<Record<TopicView, string>> = {
  stream: 'stream',
  streamAnswers: 'stream_answers',
  answers: 'answers',
};

/** @description Type guard over the persisted spelling (a `state.json` value or a callback payload). */
export function checkIsTopicView(value: string): value is TopicView {
  return (topicViewOptions as readonly string[]).includes(value);
}

/**
 * @description Parse a typed `/verbosity` argument or a picker payload into a
 * view: the documented typed spellings and the persisted spelling are both
 * accepted (a picker button carries the persisted one); anything else, including
 * `undefined`, is `null` so the caller can tell "use the default" from "reject".
 */
export function parseTopicView(value: string | undefined): TopicView | null {
  if (value === undefined) return null;
  if (checkIsTopicView(value)) return value;
  return topicViewOptions.find((view) => topicViewArguments[view] === value) ?? null;
}

/** @description Whether the agent's own stream (text, status, thinking, tool results, sub-agents) reaches the topic. */
export function checkIsStreamShown(view: TopicView): boolean {
  return view !== 'answers';
}

/**
 * @name AgentStreamEvent
 * @description The kinds of agent event the bot renders into a topic. All but
 * `question` are the agent's STREAM; a native question is kept in every view —
 * hidden, the agent would hang on it.
 */
export type AgentStreamEvent = 'output' | 'question' | 'status' | 'thinking' | 'toolResult' | 'subagentStatus';

/**
 * @description Whether an agent event is rendered in a topic with `view` (plan
 * S9): the stream is dropped in the answers-only view, a native question never
 * is. What is NOT an agent event — the typing indicator, files the agent sends
 * through the bot MCP, the bot's own notices, the pinned answers — is not gated.
 */
export function checkIsAgentEventShown(view: TopicView, event: AgentStreamEvent): boolean {
  return event === 'question' || checkIsStreamShown(view);
}

/** @description Whether operator messages and scheduled runs in the topic open requests (and so get wake-ups and pinned answers). */
export function checkAreRequestsEnabled(view: TopicView): boolean {
  return view !== 'stream';
}
