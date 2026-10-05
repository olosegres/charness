/**
 * @description What to do with a json-stream process ADOPTED at boot whose
 * bot-MCP tool list may be stale (plan 2026-10-04-claude-process-lifecycle, L4).
 * An MCP client fetches the tool list when it connects, and the bot's server is
 * stateless (one `McpServer` per request), so it has no channel to push a
 * `tools/list_changed` to a running client. A process started under an earlier
 * bot build therefore keeps that build's tools — a live test (2026-10-04) saw
 * `answer_request` missing from an adopted session, requests left open. The
 * bot persists a digest of the tool definitions a session was started with and
 * compares it at adopt: a different (or missing) digest means the process is
 * stopped at its next idle point and the next trigger resumes it with the
 * current tools (L-D2: never while it works).
 */

export type AdoptedToolListRefresh =
  /** The process got the current tools at its start — nothing to do. */
  | 'fresh'
  /** Stale and idle: stop now; the next trigger resumes it with the current tools. */
  | 'stopNow'
  /** Stale but working: keep it until it is idle, then stop it. */
  | 'stopWhenIdle';

export function decideAdoptedToolListRefresh(input: {
  /** The digest persisted when the process was started; absent for a row written before it was tracked. */
  persistedDigest: string | undefined;
  currentDigest: string;
  isWorking: boolean;
}): AdoptedToolListRefresh {
  if (input.persistedDigest === input.currentDigest) return 'fresh';
  return input.isWorking ? 'stopWhenIdle' : 'stopNow';
}
