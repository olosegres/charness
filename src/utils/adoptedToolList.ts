/**
 * @description Whether a json-stream process ADOPTED at boot runs a stale bot-MCP
 * tool list (plan 2026-10-04-claude-process-lifecycle, L4). An MCP client fetches
 * the tool list when it connects, and the bot's server is stateless (one
 * `McpServer` per request), so it has no channel to push a `tools/list_changed`
 * to a running client. A process started under an earlier bot build therefore
 * keeps that build's tools — a live test (2026-10-04) saw `answer_request`
 * missing from an adopted session. The bot persists a digest of the tool
 * definitions a session was started with and compares it at adopt.
 *
 * A stale process is NOT stopped early: an early stop at its next idle point
 * killed the agent's own pending work (a background task about to report, a
 * scheduled job) and was never weighed against the idle compaction. It follows
 * the normal lifecycle — compacted at the idle mark, then stopped — and the
 * next trigger resumes it with the current tools.
 */
export function checkIsAdoptedToolListStale(input: {
  /** The digest persisted when the process was started; absent for a row written before it was tracked. */
  persistedDigest: string | undefined;
  currentDigest: string;
}): boolean {
  return input.persistedDigest !== input.currentDigest;
}
