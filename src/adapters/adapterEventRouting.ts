import type { SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';

/**
 * @description The ONE gate where adapter events meet a conversation of another
 * platform (Jira connector plan J2b, R2). Every handler the bot wires is a
 * Telegram one — it renders, pins, edits and reads the chat's rate limit, all of
 * which throw for a foreign key, often inside a promise nobody awaits (that
 * crash ends the process). A Telegram key gets every handler; a foreign key gets
 * only what its REQUEST needs: the turn tracking the wake-ups read, the
 * usage-limit handling, and the teardown of request-side state.
 */

/** Every event an agent adapter emits (`createAdapter.ts` wires each). */
export const adapterEventNames = [
  'output',
  'status',
  'question',
  'thinking',
  'toolResult',
  'subagentStatus',
  'apiError',
  'noResponse',
  'questionGone',
  'closed',
  'started',
  'stopped',
  'error',
] as const;

export type AdapterEventName = (typeof adapterEventNames)[number];

/**
 * @name ForeignKeyEventRoute
 * @description What a foreign key's event runs:
 *  - `none` — Telegram display only (status frames, thinking, tool results,
 *    sub-agent status, native questions);
 *  - `requestSide` — a dedicated request-side handler instead of the Telegram one;
 *  - `all` — the shared handler, whose Telegram parts the primitives refuse.
 */
export type ForeignKeyEventRoute = 'none' | 'requestSide' | 'all';

export const foreignKeyEventRoutes = {
  // Output marks a turn under way (the wake-ups' busy-onset); the stream itself is display.
  output: 'requestSide',
  status: 'none',
  question: 'none',
  thinking: 'none',
  toolResult: 'none',
  subagentStatus: 'none',
  // A usage limit answers the request and its retry resumes the work.
  apiError: 'all',
  // A wedged turn's recovery replays the request's prompt.
  noResponse: 'all',
  questionGone: 'none',
  // Drop the retry, compaction and preamble state a gone session leaves behind.
  closed: 'requestSide',
  stopped: 'requestSide',
  started: 'none',
  // Logged; there is no topic to post it to.
  error: 'requestSide',
} as const satisfies Readonly<Record<AdapterEventName, ForeignKeyEventRoute>>;

/** The events whose foreign-key route is a dedicated request-side handler. */
type RequestSideEventName = {
  [E in AdapterEventName]: (typeof foreignKeyEventRoutes)[E] extends 'requestSide' ? E : never;
}[AdapterEventName];

/**
 * @description Run an adapter event's handler for its conversation's platform:
 * `onAll` for a Telegram key, else what {@link foreignKeyEventRoutes} says.
 */
export function dispatchAdapterEvent<E extends AdapterEventName>(
  key: SessionKey,
  eventName: E,
  onAll: () => void,
  // Required for exactly the `requestSide` events: a route without its handler,
  // or a handler its route never runs, is a compile error, not a silent drop.
  ...onRequestSide: E extends RequestSideEventName ? [onRequestSide: () => void] : []
): void {
  const route: ForeignKeyEventRoute = checkIsTelegramKey(key) ? 'all' : foreignKeyEventRoutes[eventName];
  if (route === 'all') onAll();
  else if (route === 'requestSide') onRequestSide[0]?.();
}
