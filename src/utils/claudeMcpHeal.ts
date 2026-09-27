/**
 * @description The wire shapes + the decision behind healing a `claude` session
 * whose bot-injected MCP server (`telegramBot`) has latched `failed`.
 *
 * WHY this exists: a json-stream session is an EXTERNAL process, so it survives
 * every bot restart — but the MCP client inside it does not retry a server it
 * once failed to reach. A session that was alive across a restart therefore kept
 * reporting `{name:'telegramBot', status:'failed'}` for the rest of its life and
 * lost `schedule_*` / `compact_conversation` / `send_file_to_user` /
 * `send_messages_to_user` with nothing short of replacing the session to bring
 * them back. The CLI answers `mcp_status` / `mcp_reconnect` on the SAME stdio
 * control channel the adapter already uses for permissions, and a reconnect
 * measurably moves the server `failed` → `connected`.
 *
 * The request/response format is reverse-engineered (measured against a live
 * `claude` process, not documented anywhere), so it lives in exactly ONE tested
 * place — the adapter only mints ids, writes the frames, and reads the verdict.
 * Pure: no IO, no timers, no adapter imports.
 */

import { checkIsStreamRecord } from './claudeStreamJson';

/**
 * @description How long to wait for ONE control round-trip before treating the
 * server status as unknown. The channel is loopback stdio answered by a process
 * that is already running, so a healthy reply lands in milliseconds — this is a
 * generous upper bound that keeps a silent CLI from hanging the caller, not a
 * tuning knob.
 */
export const mcpControlRequestTimeoutMs = 15000;

/** `mcp_status` — ask the CLI for every MCP server it holds and its state. */
export interface McpStatusControlRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: 'mcp_status' };
}

/** `mcp_reconnect` — make the CLI re-handshake ONE server by name. */
export interface McpReconnectControlRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: 'mcp_reconnect'; serverName: string };
}

/**
 * @name McpHealDecision
 * @description What to do about one server's reported status.
 */
export type McpHealDecision = 'reconnect' | 'healthy' | 'skip';

/**
 * @name McpHealOutcome
 * @description What a heal attempt actually achieved — the adapter method's
 * result, so a caller can log only the sessions it really repaired.
 *  - `healed` — the server was `failed` and the reconnect answered success.
 *  - `healthy` — nothing was wrong, no frame written beyond the status ask.
 *  - `skipped` — the status says a reconnect is not the right move
 *    ({@link decideMcpHeal}).
 *  - `unavailable` — the heal could not be completed: no live session, the CLI
 *    never answered (or refused) the status ask, or the reconnect itself was
 *    refused. In every case the server is still whatever it was.
 */
export type McpHealOutcome = 'healed' | 'healthy' | 'skipped' | 'unavailable';

/** The status of a server that completed its handshake — nothing to do. */
const mcpStatusConnected = 'connected';
/** The status of a server whose connection attempt failed and is never retried. */
const mcpStatusFailed = 'failed';

/** Build the `mcp_status` control request (`requestId` is echoed back in the
 *  response's `request_id`, which is how the reply is matched). */
export function buildMcpStatusControlRequest(requestId: string): McpStatusControlRequest {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'mcp_status' } };
}

/** Build the `mcp_reconnect` control request for ONE server. `serverName` is
 *  camelCase on the wire (unlike the snake_case envelope fields). */
export function buildMcpReconnectControlRequest(requestId: string, serverName: string): McpReconnectControlRequest {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'mcp_reconnect', serverName } };
}

/**
 * @description Read one server's `status` out of an `mcp_status` response
 * payload (`{mcpServers:[{name, status, …}]}`). Returns `null` when the payload
 * is absent / not the expected shape, when no entry carries that name, or when
 * the entry has no string status — every one of which means "unknown", which
 * {@link decideMcpHeal} deliberately refuses to act on.
 */
export function getMcpServerStatus(payload: Record<string, unknown> | null, serverName: string): string | null {
  if (!payload) return null;
  const servers = payload.mcpServers;
  if (!Array.isArray(servers)) return null;
  for (const entry of servers) {
    if (!checkIsStreamRecord(entry) || entry.name !== serverName) continue;
    return typeof entry.status === 'string' ? entry.status : null;
  }
  return null;
}

/**
 * @description Decide what a reported MCP server status calls for.
 *
 *  - `connected` → `healthy`: the server completed its handshake, so touching it
 *    would only risk interrupting live tools.
 *  - `failed` → `reconnect`: the exact latched state this whole path exists for —
 *    the CLI never retries it on its own, and a reconnect is measurably what
 *    brings the tools back.
 *  - `needs-auth` → `skip`: a human must authorise that server; reconnecting
 *    would fail again immediately and loop.
 *  - anything else, INCLUDING `null` → `skip`: an unknown or unreadable status
 *    must never be guessed into a live session. A future status name is then
 *    inert rather than wrongly acted on.
 */
export function decideMcpHeal(status: string | null): McpHealDecision {
  if (status === mcpStatusConnected) return 'healthy';
  if (status === mcpStatusFailed) return 'reconnect';
  return 'skip';
}
