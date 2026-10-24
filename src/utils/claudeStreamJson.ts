/**
 * @description Pure parser for the `claude` CLI's
 * `--output-format stream-json` protocol (the `claude-json-stream` adapter's
 * event core). Kept dependency-free and side-effect-free so it is unit-testable
 * against REAL captured stream-json samples (see `claudeStreamJson.test.ts`):
 * the adapter feeds every stdout chunk through {@link ClaudeStreamLineReader}
 * (partial-line buffering across chunks) and each complete line through
 * {@link classifyClaudeStreamMessage}, which maps ONE stream-json message to a
 * list of backend-neutral {@link ClaudeStreamAction}s the adapter then turns
 * into `AgentAdapter` events.
 *
 * The wire format was reverse-engineered from a live `claude -p
 * --input-format stream-json --output-format stream-json` run (v2.1.201) and
 * cross-read against `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` /`sdk.mjs`.
 * Every event type below is backed by a captured sample.
 */

/** Narrow an untyped `JSON.parse` result to a plain object (parse-boundary
 *  pattern for untrusted process output; mirrors `checkIsRecord` elsewhere). */
export function checkIsStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @description Newline-delimited-JSON reader with partial-line buffering. The
 * CLI writes one JSON object per line, but a stdout chunk can split a line at
 * any byte (a mid-line truncation), so a naive `chunk.split('\n')` would try to
 * `JSON.parse` half a line. {@link push} returns only the COMPLETE lines seen so
 * far and retains the trailing partial in {@link buffer} until its newline
 * arrives in a later chunk.
 */
export class ClaudeStreamLineReader {
  private buffer = '';

  /** Feed a stdout chunk; return every complete (newline-terminated) line it
   *  completed, retaining any trailing partial for the next call. Blank lines
   *  are dropped. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }

  /** Any buffered, not-yet-terminated content (diagnostic only). */
  get pending(): string {
    return this.buffer;
  }
}

/** Parse one NDJSON line to a record, or `null` for blank / malformed
 *  (a torn line that slipped past the reader) — never throws. */
export function parseStreamJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return checkIsStreamRecord(parsed) ? parsed : null;
}

/**
 * @description Backend-neutral action produced from ONE stream-json message.
 * The adapter turns these into `AgentAdapter` events (accumulation / debounce /
 * control-channel handling stay in the adapter; classification stays pure here).
 */
export type ClaudeStreamAction =
  /** `system/init` — the session is up (first one carries the authoritative id).
   *  `claudeCodeVersion` is the CLI's own version (`claude_code_version`) — the
   *  auto-stop gate reads it (`utils/claudeCodeVersion.ts`). */
  | { kind: 'init'; sessionId: string | null; model: string | null; apiKeySource: string | null; claudeCodeVersion: string | null }
  /** A streamed answer-text delta (`content_block_delta` `text_delta`). */
  | { kind: 'textDelta'; text: string; isSubagent: boolean }
  /** A streamed reasoning delta (`content_block_delta` `thinking_delta`). */
  | { kind: 'thinkingDelta'; text: string; isSubagent: boolean }
  /** A settled assistant `tool_use` block → drives the transient tool status. */
  | { kind: 'toolUse'; tool: string; toolUseId: string; isSubagent: boolean }
  /** A `tool_result` fed back in a `user` message → the `toolResult` event. */
  | { kind: 'toolResult'; toolUseId: string; output: string; isSubagent: boolean }
  /** The turn ended (`result`); `resultText` is the final answer text; `usage`
   *  is the turn's token accounting (`null` when the frame carries none);
   *  `totalCostUsd` is the CLI's `total_cost_usd` — the CONVERSATION's running
   *  cost (restored from the transcript on `--resume`), `null` when absent. */
  | { kind: 'turnEnd'; isError: boolean; errorText: string | null; resultText: string | null; usage: ClaudeTurnUsage | null; totalCostUsd: number | null }
  /**
   * `system/background_tasks_changed` — the CLI's CURRENT list of background
   * tasks (a background Bash / Monitor = `local_bash`, a background sub-agent =
   * `local_agent`), re-sent whole on every change; an empty list means nothing
   * runs in the background. A finished task starts its own turn
   * (`task_notification`). Probed on Claude Code 2.1.287 — older CLIs never emit
   * it, which is why auto-stop is gated on the version.
   */
  | { kind: 'backgroundTasks'; tasks: ClaudeBackgroundTask[] }
  /**
   * `system/task_notification` — a task reached its end. For a task in the
   * background list the CLI empties the list right AFTER this frame and then
   * starts the task's own turn (the agent reads the result), the turn's first
   * output only after the API round-trip — measured live on 2.1.310. A
   * foreground task's notification (mid-turn, never in the list) starts nothing.
   */
  | { kind: 'taskNotification'; taskId: string }
  /**
   * A turn STARTS before its first output: `system/session_state_changed`
   * `running` / `requires_action` (emitted only under
   * `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), or a `command_lifecycle` frame
   * `started` by a session-only `CronCreate` job firing
   * (`wakeup_source: "schedule_wakeup"`). The CLI's `idle` state is NOT mapped:
   * it fires after every `result` while a background task still runs.
   */
  | { kind: 'turnStarted'; isScheduledWakeup: boolean }
  /** A control_request off stdout (permission / AskUserQuestion / dialog). */
  | {
      kind: 'controlRequest';
      requestId: string;
      subtype: string;
      toolName?: string;
      input?: Record<string, unknown>;
      toolUseId?: string;
      dialogKind?: string;
    }
  /**
   * A control_response off stdout — the CLI's reply to a control_request the BOT
   * wrote (the `initialize` handshake, the MCP `mcp_status` / `mcp_reconnect`
   * round-trips). `payload` is the INNER `response` record, present only for a
   * data-returning subtype. (The adapter also WRITES frames of this type to
   * stdin when answering a `can_use_tool`; that is an unrelated write path.)
   */
  | { kind: 'controlResponse'; requestId: string; isSuccess: boolean; payload: Record<string, unknown> | null }
  /** `system/status` carrying a `/compact` outcome (`compact_result` /
   *  `compact_error`) — how the json-stream backend confirms a compaction ran. */
  | { kind: 'compactStatus'; result: string | null; error: string | null }
  /** `system/compact_boundary` — a completed compaction; `compact_metadata`
   *  carries `trigger` (manual/auto) and pre/post token counts. */
  | { kind: 'compactBoundary'; trigger: string | null; preTokens: number | null; postTokens: number | null }
  /** `system/api_retry` — a provider retry the CLI is performing. */
  | { kind: 'apiRetry'; text: string }
  /**
   * `rate_limit_event` — subscription usage window signal, one per API request. `status` is `allowed` /
   * `allowed_warning` / `rejected`, `rateLimitType` + `resetsAtMs` name the window the status is about, and
   * `windows` lifts `rate_limit_info.unifiedWindows` (`five_hour`, `seven_day`, `seven_day_overage_included`
   * with `utilization` 0..1 and a reset instant) — the per-profile usage cache feeds on them (`utils/claudeUsage.ts`).
   */
  | {
      kind: 'rateLimit';
      rateLimitType: string | null;
      utilization: number | null;
      status: string | null;
      resetsAtMs: number | null;
      windows: Array<{ name: string; utilization: number; resetsAtMs: number | null }>;
    }
  /** `--replay-user-messages` echo of a message the BOT wrote — the input-ack
   *  signal (see {@link checkIsOwnInputEcho} for the user lines that are not). */
  | { kind: 'userEcho' };

/**
 * @description Whether a non-tool-result `user` line is the
 * `--replay-user-messages` echo of a message the bot wrote. The stream also
 * carries `user` lines the CLI produced on its own, and counting one of those as
 * our echo marks a message still waiting mid-turn as taken in (live
 * `stdout.jsonl` logs): `isSynthetic` lines (a skill being loaded, the summary
 * that opens a compacted session, `isReplay:false`), a sub-agent's own prompt
 * and markers (`parent_tool_use_id` set), and a replayed background-task
 * notification (`origin` set). Only POSITIVE evidence excludes a line, so a CLI
 * that stamps none of these fields keeps counting every echo rather than none.
 */
function checkIsOwnInputEcho(msg: Record<string, unknown>): boolean {
  return msg.parent_tool_use_id == null
    && msg.isSynthetic !== true
    && msg.isReplay !== false
    && msg.origin === undefined;
}

/**
 * @description The token accounting of one turn, from `result.usage` — or, when
 * that is all zero, the sum of the result's per-model `modelUsage` entries: a
 * `/compact` turn's result reports its summary call only there (probe
 * 2026-10-05). The cache fields are the cross-process prompt-cache proof: a
 * resumed process whose `cacheReadTokens` covers the context read the previous
 * process's cache.
 */
export interface ClaudeTurnUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Read a non-negative integer field, defaulting an ABSENT field to 0 and
 *  rejecting any other shape (`null`). */
function readTokenCount(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse `result.usage`; `null` when absent or when any present count is malformed
 *  (a half-read accounting would mislead the cache check — better no line). */
function readResultUsage(usage: unknown): ClaudeTurnUsage | null {
  if (!checkIsStreamRecord(usage)) return null;
  const inputTokens = readTokenCount(usage, 'input_tokens');
  const cacheReadTokens = readTokenCount(usage, 'cache_read_input_tokens');
  const cacheWriteTokens = readTokenCount(usage, 'cache_creation_input_tokens');
  const outputTokens = readTokenCount(usage, 'output_tokens');
  if (inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || outputTokens === null) return null;
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
}

/** The turn's total over `result.modelUsage` (one entry per model used); `null` when absent or any entry is malformed. */
function readModelUsageTotal(modelUsage: unknown): ClaudeTurnUsage | null {
  if (!checkIsStreamRecord(modelUsage)) return null;
  const total: ClaudeTurnUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for (const entry of Object.values(modelUsage)) {
    if (!checkIsStreamRecord(entry)) return null;
    const inputTokens = readTokenCount(entry, 'inputTokens');
    const cacheReadTokens = readTokenCount(entry, 'cacheReadInputTokens');
    const cacheWriteTokens = readTokenCount(entry, 'cacheCreationInputTokens');
    const outputTokens = readTokenCount(entry, 'outputTokens');
    if (inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || outputTokens === null) return null;
    total.inputTokens += inputTokens;
    total.cacheReadTokens += cacheReadTokens;
    total.cacheWriteTokens += cacheWriteTokens;
    total.outputTokens += outputTokens;
  }
  return total;
}

function checkIsZeroUsage(usage: ClaudeTurnUsage): boolean {
  return usage.inputTokens === 0 && usage.cacheReadTokens === 0 && usage.cacheWriteTokens === 0 && usage.outputTokens === 0;
}

/** The turn's accounting: `result.usage`, or the `modelUsage` total when `usage` is all zero (a `/compact` turn). */
function readTurnUsage(usage: unknown, modelUsage: unknown): ClaudeTurnUsage | null {
  const resultUsage = readResultUsage(usage);
  if (resultUsage === null || !checkIsZeroUsage(resultUsage)) return resultUsage;
  return readModelUsageTotal(modelUsage) ?? resultUsage;
}

/** @name ClaudeBackgroundTask @description One entry of the CLI's background-task list: its id and the description the agent gave it. */
export interface ClaudeBackgroundTask {
  taskId: string;
  description: string;
}

/** The entries of a `background_tasks_changed` frame's `tasks` list; an entry
 *  without a string id is skipped (it cannot be matched to anything). */
function readBackgroundTasks(tasks: unknown): ClaudeBackgroundTask[] {
  if (!Array.isArray(tasks)) return [];
  const backgroundTasks: ClaudeBackgroundTask[] = [];
  for (const task of tasks) {
    if (checkIsStreamRecord(task) && typeof task.task_id === 'string') {
      backgroundTasks.push({ taskId: task.task_id, description: readString(task, 'description') ?? '' });
    }
  }
  return backgroundTasks;
}

/** `system/session_state_changed` states that mean a turn runs (`requires_action`: it waits on a permission or question). */
const turnRunningSessionStates: readonly string[] = ['running', 'requires_action'];

/** The `command_lifecycle` wakeup source of a session-only `CronCreate` job firing (probed live on 2.1.310). */
const scheduledWakeupSource = 'schedule_wakeup';

/** Read a non-negative finite dollar amount, or null (absent or malformed — no figure beats a wrong one). */
function readCostUsd(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read a string field, or null. */
function readString(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === 'string' ? value : null;
}

/** Concatenate the text of a tool_result `content` (string, or array of
 *  `{type:'text',text}` / `{type:'tool_result'…}` blocks). */
function extractToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (checkIsStreamRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * @description Map ONE parsed stream-json message to zero or more
 * {@link ClaudeStreamAction}s. Pure: no accumulation, no timers, no IO. An
 * unrecognized / uninteresting message (status, thinking_tokens, message_start,
 * content_block_start/stop, …) yields `[]`.
 */
export function classifyClaudeStreamMessage(msg: Record<string, unknown>): ClaudeStreamAction[] {
  const type = msg.type;
  const isSubagent = msg.parent_tool_use_id != null;

  if (type === 'system' && msg.subtype === 'init') {
    return [{
      kind: 'init',
      sessionId: readString(msg, 'session_id'),
      model: readString(msg, 'model'),
      apiKeySource: readString(msg, 'apiKeySource'),
      claudeCodeVersion: readString(msg, 'claude_code_version'),
    }];
  }

  if (type === 'system' && msg.subtype === 'background_tasks_changed') {
    return [{ kind: 'backgroundTasks', tasks: readBackgroundTasks(msg.tasks) }];
  }

  if (type === 'system' && msg.subtype === 'task_notification') {
    const taskId = readString(msg, 'task_id');
    return taskId === null ? [] : [{ kind: 'taskNotification', taskId }];
  }

  if (type === 'system' && msg.subtype === 'session_state_changed') {
    const sessionState = readString(msg, 'state');
    return sessionState !== null && turnRunningSessionStates.includes(sessionState) ? [{ kind: 'turnStarted', isScheduledWakeup: false }] : [];
  }

  if (type === 'command_lifecycle') {
    return msg.state === 'started' && msg.wakeup_source === scheduledWakeupSource ? [{ kind: 'turnStarted', isScheduledWakeup: true }] : [];
  }

  if (type === 'system' && msg.subtype === 'status') {
    // A `/compact` turn reports its outcome on a status frame carrying
    // `compact_result` (e.g. "success") and, on failure, `compact_error`. Every
    // other status frame (a plain `status` string) is not interesting.
    if ('compact_result' in msg || 'compact_error' in msg) {
      return [{ kind: 'compactStatus', result: readString(msg, 'compact_result'), error: readString(msg, 'compact_error') }];
    }
    return [];
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    const meta = checkIsStreamRecord(msg.compact_metadata) ? msg.compact_metadata : {};
    return [{
      kind: 'compactBoundary',
      trigger: readString(meta, 'trigger'),
      preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null,
      postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
    }];
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    // The retry carries an `error` description (documented category enum + text).
    const text = readString(msg, 'error') ?? readString(msg, 'message') ?? JSON.stringify(msg);
    return [{ kind: 'apiRetry', text }];
  }

  if (type === 'rate_limit_event') {
    const info = checkIsStreamRecord(msg.rate_limit_info) ? msg.rate_limit_info : {};
    // `resetsAt` is epoch SECONDS on the frame (measured 2026-10: `1791202200`).
    const readResetMs = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null);
    const windows: Array<{ name: string; utilization: number; resetsAtMs: number | null }> = [];
    if (checkIsStreamRecord(info.unifiedWindows)) {
      for (const [name, window] of Object.entries(info.unifiedWindows)) {
        if (!checkIsStreamRecord(window) || typeof window.utilization !== 'number') continue;
        windows.push({ name, utilization: window.utilization, resetsAtMs: readResetMs(window.resetsAt) });
      }
    }
    return [{
      kind: 'rateLimit',
      rateLimitType: readString(info, 'rateLimitType'),
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
      status: readString(info, 'status'),
      resetsAtMs: readResetMs(info.resetsAt),
      windows,
    }];
  }

  if (type === 'stream_event') {
    const event = checkIsStreamRecord(msg.event) ? msg.event : null;
    if (!event || event.type !== 'content_block_delta') return [];
    const delta = checkIsStreamRecord(event.delta) ? event.delta : null;
    if (!delta) return [];
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text ? [{ kind: 'textDelta', text: delta.text, isSubagent }] : [];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return delta.thinking ? [{ kind: 'thinkingDelta', text: delta.thinking, isSubagent }] : [];
    }
    return [];
  }

  if (type === 'assistant') {
    // The settled assistant message. Text/thinking already streamed via deltas;
    // here we only surface tool_use blocks (transient tool status).
    const message = checkIsStreamRecord(msg.message) ? msg.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const actions: ClaudeStreamAction[] = [];
    for (const block of content) {
      if (!checkIsStreamRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
        actions.push({ kind: 'toolUse', tool: block.name, toolUseId: block.id, isSubagent });
      }
    }
    return actions;
  }

  if (type === 'user') {
    // Either a `--replay-user-messages` echo OR a tool_result fed back to the model.
    const message = checkIsStreamRecord(msg.message) ? msg.message : null;
    const content = message ? message.content : undefined;
    if (Array.isArray(content)) {
      const actions: ClaudeStreamAction[] = [];
      for (const block of content) {
        if (checkIsStreamRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          actions.push({ kind: 'toolResult', toolUseId: block.tool_use_id, output: extractToolResultOutput(block.content), isSubagent });
        }
      }
      if (actions.length > 0) return actions;
    }
    return checkIsOwnInputEcho(msg) ? [{ kind: 'userEcho' }] : [];
  }

  if (type === 'result') {
    return [{
      kind: 'turnEnd',
      isError: msg.is_error === true,
      errorText: readString(msg, 'api_error_status') ?? (msg.is_error === true ? (readString(msg, 'result') ?? 'API error') : null),
      resultText: readString(msg, 'result'),
      usage: readTurnUsage(msg.usage, msg.modelUsage),
      totalCostUsd: readCostUsd(msg, 'total_cost_usd'),
    }];
  }

  if (type === 'control_request') {
    const request = checkIsStreamRecord(msg.request) ? msg.request : null;
    const requestId = readString(msg, 'request_id');
    const subtype = request ? readString(request, 'subtype') : null;
    if (!request || !requestId || !subtype) return [];
    const action: Extract<ClaudeStreamAction, { kind: 'controlRequest' }> = { kind: 'controlRequest', requestId, subtype };
    const toolName = readString(request, 'tool_name');
    if (toolName) action.toolName = toolName;
    if (checkIsStreamRecord(request.input)) action.input = request.input;
    const toolUseId = readString(request, 'tool_use_id');
    if (toolUseId) action.toolUseId = toolUseId;
    const dialogKind = readString(request, 'dialog_kind');
    if (dialogKind) action.dialogKind = dialogKind;
    return [action];
  }

  if (type === 'control_response') {
    // Measured shape: `{response:{subtype:'success'|'error', request_id,
    // response?:{…}}}` — the OUTER `response` carries the verdict + the id to
    // match, the INNER one the returned record (present for `mcp_status`,
    // ABSENT for a plain `mcp_reconnect` ack). Without a `request_id` the frame
    // cannot be matched to the request it answers, so it is not actionable —
    // same defensive rule as the `control_request` branch above.
    const response = checkIsStreamRecord(msg.response) ? msg.response : null;
    const requestId = response ? readString(response, 'request_id') : null;
    if (!response || !requestId) return [];
    return [{
      kind: 'controlResponse',
      requestId,
      isSuccess: readString(response, 'subtype') === 'success',
      payload: checkIsStreamRecord(response.response) ? response.response : null,
    }];
  }

  return [];
}

/** The `response` payload of a `can_use_tool` control_response (allow / deny). */
export type CanUseToolResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string };

/**
 * @description Build the `allow` body of a `can_use_tool` control_response.
 *
 * The CLI's control-response schema REQUIRES `updatedInput` to be a record on an
 * allow — omit it and the CLI rejects the whole response ("Tool permission
 * request failed: ZodError"), which silently blocks the tool it was meant to
 * permit. This builder makes that field impossible to forget: `input` is echoed
 * unchanged (`{}` when the request carried none). Used for the generic auto-allow
 * of ordinary tools and for the empty-question fast-path.
 */
export function buildCanUseToolAllow(input: Record<string, unknown> | undefined, toolUseId: string | undefined): CanUseToolResponse {
  const response: CanUseToolResponse = { behavior: 'allow', updatedInput: input ?? {} };
  if (toolUseId) response.toolUseID = toolUseId;
  return response;
}

/** Build the `deny` body of a `can_use_tool` control_response (schema requires
 *  `message`). Used when the user declines / abandons an AskUserQuestion. */
export function buildCanUseToolDeny(message: string, toolUseId: string | undefined): CanUseToolResponse {
  const response: CanUseToolResponse = { behavior: 'deny', message };
  if (toolUseId) response.toolUseID = toolUseId;
  return response;
}
