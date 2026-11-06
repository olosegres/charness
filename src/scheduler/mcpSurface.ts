import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  JSONRPCRequestSchema,
  type CallToolResult,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { StateStore } from '../state';
import { openCodeAdapterName } from '../adapters/adapterNames';
import { keyFromString, tryKeyFromString, type PlatformId, type SessionKey } from '../sessionKey';
import { checkIsBotSkillsEnabled } from '../utils/botSkills';
import { claudeProfileNameMaxLength } from '../utils/claudeProfiles';
import { describeClaudeLaunchOutcome, type ClaudeProfilesReport } from '../utils/claudeUsage';
import type { SendFilesToThread } from '../utils/fileSendService';
import { formatIsoLocalOffset } from '../utils/isoTimestamp';
import { formatLocalDateAndClock } from '../utils/localClock';
import {
  maxDiscreteMessages,
  type DiscreteMessageItem,
  type SendMessagesToThread,
} from '../utils/messageSendService';
import { getAbortError } from '../utils';
import { defaultCheckTimeoutSec, maxCheckCommandLength, maxCheckTimeoutSec } from './checkRun';
import {
  checkStatusCommandTimeoutSec,
  defaultCheckStatusEveryMinutes,
  maxCheckStatusCommandLength,
  maxCheckStatusEveryMinutes,
  maxCheckStatusRunDirLength,
  minCheckStatusEveryMinutes,
} from './checkStatus';
import { checkIsCheckSchedule, checkIsReminderSchedule } from './deliveryKind';
import {
  workerWatchCheckCommand,
  workerWatchCheckCron,
  workerWatchSilenceMinutes,
  workerWatchStatusArguments,
  workerWatchStatusEveryMinutes,
} from './workerWatch';
import { describePhrasedSchedule, describeSchedule, validateScheduleSpec } from './recurrence';
import { createStrictToolInput, getUnknownKeysMessageOfUnion, runWithRefusalLogging, type StrictToolInput } from './strictToolInput';
import { createScheduleForThread } from './store';
import type { ScheduleRecord, ScheduleSpec } from './types';
import { formatDeprecation, warnLegacyNameOnce } from '../legacyNames';
import {
  answerBodyMaxLength,
  type AnswerRequestArgs,
  type AnswerRequestOutcome,
} from '../requests/answerRequest';
import { answerStyleInstruction } from '../requests/answerStyle';
import type { RequestAnswerKind } from '../requests/types';
import type { TodoUpdateArgs } from '../todos/merge';
import { todoHistoryMaxItems, todoReadScopes, type TodoReadArgs, type TodoToolOutcome } from '../todos/registry';
import { todoNoteMaxLength, todoPositions, todoRefMaxLength, todoStatuses, todoTitleMaxLength } from '../todos/types';

/**
 * @description The bot-owned MCP server exposes the agent-facing tools —
 * `schedule_create`, `schedule_list`, `schedule_cancel`, `send_file_to_user`,
 * `send_messages_to_user`, `compact_conversation` and `answer_request` — over
 * streamable HTTP on a loopback port. The server is
 * INERT until `bot.ts` wires {@link createSchedulerMcpServer}; this module
 * imports nothing from `bot.ts` (every side effect is injected via
 * {@link SchedulerMcpDeps}).
 *
 * Transport: STATELESS streamable HTTP (`sessionIdGenerator: undefined`) — a
 * research-locked choice (plan S5) that dodges the SDK's session-loss bugs and
 * suits a single local host. The SDK binds one `McpServer` to one transport per
 * connection, so every request builds a FRESH `McpServer` + transport (see
 * {@link buildRequestServer}) that registers the same handlers, and they
 * are closed when the response finishes. MCP cancellation arrives as a separate
 * HTTP notification, so {@link createSchedulerMcpServer} keeps only the active
 * request abort controllers plus one bounded, expiring lifecycle-tombstone cache
 * across those otherwise-stateless transports. A pending-cancellation tombstone
 * handles a cancellation that genuinely leads first registration; a
 * recently-completed tombstone suppresses an unmatched late cancellation only
 * while that key is inactive. An active request always takes precedence so its
 * own legitimate cancellation can abort it even after typed JSON-RPC id reuse.
 *
 * Auth/scoping: a request carries `Authorization: Bearer <token>`. The token is
 * self-describing — `<scopeB64url>.<hmacHex>` — so the bot need not know every
 * valid scope up front (an OpenCode directory scope is any bound folder). The
 * scope rides in cleartext (base64url) next to an HMAC-SHA256 signature over the
 * decoded scope string; {@link verifySchedulerMcpToken} recomputes the HMAC and
 * compares it timing-safely. A scope is one of:
 *   - `thread:<threadKey>` — a Claude session, pinned to its exact thread.
 *   - `dir:<directory>`    — an OpenCode instance, granular to a bound folder.
 * Every tool call resolves a single target thread from the scope (see
 * {@link resolveTargetThreadKey}) and can only touch that thread's jobs —
 * except `answer_request`, whose request id already names the conversation: it
 * only checks that conversation is inside the scope
 * ({@link checkIsConversationInScope}).
 */

/**
 * Default loopback port for the scheduler MCP server. Zero asks the OS for a
 * free ephemeral port, so independent bot instances never compete for 4097.
 */
export const defaultSchedulerMcpPort = 0;

/** HTTP path the streamable transport is served on (matches the injected `--mcp-config` url, S6). */
export const schedulerMcpPath = '/mcp';

/** Per-registration identity used to isolate equal JSON-RPC request IDs. */
export const schedulerMcpClientIdHeader = 'x-charness-mcp-client-id';

/**
 * The header a pre-rename release put into the MCP config it injected. A running
 * agent keeps the config of its launch, so the server still accepts it; new
 * configs carry {@link schedulerMcpClientIdHeader}.
 */
export const legacySchedulerMcpClientIdHeader = 'x-telegramcode-mcp-client-id';

/**
 * A port that is in use at the start is retried this many times, this far apart,
 * before the bot binds another one. Another port orphans every Claude session
 * launched before (it keeps the MCP address of its launch), and the holder may
 * let go soon: the previous process still exiting, or a short connection of
 * another process that was handed the port as its local one while the bot was
 * down. Together they span the shutdown watchdog's bound (`DEFAULT_WATCHDOG_MS`),
 * the longest the previous generation can take to exit.
 */
export const schedulerMcpBindRetryCount = 20;
export const schedulerMcpBindRetryDelayMs = 500;

/** Pending cancellations and recent completions remain correlatable for this window. */
export const schedulerMcpPendingCancellationTtlMs = 30_000;

/** Global memory bound shared by pending-cancellation and recent-completion tombstones. */
export const schedulerMcpPendingCancellationMax = 1_000;

const schedulerMcpClientIdMaxLength = 128;
const schedulerMcpClientIdPattern = /^[A-Za-z0-9._:-]+$/;

/** Server identity reported in the MCP `initialize` handshake. */
const mcpServerName = 'telegram-bot-scheduler';
const mcpServerVersion = '1.0.0';

/** The skill an orchestrating agent loads in a bot session, as each CLI names it. */
const managerSkillInstruction =
  'load the `charness-manager` skill (Claude Code lists it as `charness:charness-manager`) and follow it instead of any other manager skill';

/** The instruction bullets that hold on every platform (the two platform-neutral tools). */
const compactConversationInstruction =
  '• The user EXPLICITLY asks to compact/shrink/summarize this conversation\'s context → compact_conversation. Never on your own judgement.';
const answerRequestInstruction =
  '• A message carries a "[Request <id> · from: …]" header → answer it through answer_request with that id: kind "final" with the full result at the end of your turn, "question" when you need the requester before you can go on (their reply arrives as a new request), "progress" for an interim note. Only question/final close the request. ' +
  answerStyleInstruction;
/** The shared todo registry's bullet (D7) — Telegram topics and Jira issues publish alike. */
const todoInstruction =
  '• BEFORE you start any task (fixes you found yourself included: a failing test, a leak) → todo_update adds it as inWork, naming the area (files, tests). Check the returned board for overlap with other agents. Take the queue top-down; mark items done / dropped at once. A ticket you create in a tracker gets an item with its key in `ref`.';
/** The `charness remote-run` bullet — present only while a runner is paired or listed in `runners.json`, for Telegram topics and tracker issues alike. The CLI's own `--help` has the job commands. */
const remoteRunInstruction =
  '• Heavy work (test suite, build, e2e run) → send it to a runner, not this machine: `charness remote-run runners` lists them and what each can do; `charness remote-run [--needs android|ios|docker|playwright] <command>` (iOS: `--needs ios`) runs it in a copy of this project, returns output and exit code (edit files only here). Longer than your tool timeout: `charness remote-run --bg <command>`, then `charness remote-run wait <id>` in the background; `charness remote-run --help` lists the rest.';

/**
 * Claude Code cuts a server's connect-time `instructions` that are longer than this: whatever comes last is lost, silently. The Telegram
 * text is within a few hundred characters of it before the remote-run bullet, so the runner lines are fitted to the room that is left.
 */
export const claudeCodeInstructionsMaxLength = 4096;

/**
 * The remote-run bullet with one line per runner under it (`mac — macOS 15.1, android, playwright`: the name, the OS, what it could do when
 * last probed): the first `shownCount` runners, and «… and N more» for the rest. The lines are a snapshot taken at connect; `charness
 * remote-run runners` has the live state. `shownCount` 0 gives the bullet alone.
 */
function buildRemoteRunInstruction(runnerLines: readonly string[], shownCount: number): string {
  if (shownCount === 0) return remoteRunInstruction;
  const hiddenCount = runnerLines.length - shownCount;
  return [
    remoteRunInstruction,
    '  Runners, as last seen:',
    ...runnerLines.slice(0, shownCount).map((line) => `  – ${line}`),
    ...(hiddenCount > 0 ? [`  – … and ${hiddenCount} more`] : []),
  ].join('\n');
}
const orchestrationInstructionHead = '• You orchestrate detached workers (a `claude -p` / `opencode run` builder, reviewer, researcher) →';
/** What the worker-watch recipe says once a tool is named: shared by both wordings of the Telegram bullet. */
const workerWatchRecipeText =
  'its description has the recipe (checkCommand, cron, status arguments); never `kill -0` alone: it never fires on a hung worker.';

/**
 * The orchestration bullet of a conversation on a tracker, which has no scheduling tools: only the manager-skill hint, so
 * with the bot's skills off (`/bot_skills`) there is nothing left of it and `null` drops it.
 */
function buildTrackerOrchestrationInstruction(isBotSkillsEnabled: boolean): string | null {
  return isBotSkillsEnabled ? `${orchestrationInstructionHead} ${managerSkillInstruction}.` : null;
}

/** The orchestration bullet of a Telegram topic: the manager-skill hint (dropped with the skills off) and the worker-watch recipe, which is a tool fact and stays. */
function buildTelegramOrchestrationInstruction(isBotSkillsEnabled: boolean): string {
  return isBotSkillsEnabled
    ? `${orchestrationInstructionHead} ${managerSkillInstruction}. Watch EACH worker with schedule_create — ${workerWatchRecipeText}`
    : `${orchestrationInstructionHead} schedule_create to watch EACH worker — ${workerWatchRecipeText}`;
}
const claudeProfilesInstruction =
  '• Before you start or resume a child `claude` process (worker, reviewer, planner) → claude_profiles with the model you will launch, and start the child under the account it names (`CLAUDE_CONFIG_DIR=<configDir>`): without it the child inherits YOUR account and drains the same limits. The tool description has the rest (resuming, `recommended: null`).';

/** What the `claude_profiles` tool asks the bot: the model, and for a resumed session the account it last ran on. */
export interface ClaudeProfilesQuery {
  model: string | null;
  /** The profile the resumed session last ran on; `null` for a new agent. */
  currentProfile: string | null;
  /** The resumed session broke off on a usage limit of `currentProfile`. */
  isStoppedByLimit: boolean;
}

/**
 * @name OptionalBotTools
 * @description The tools a session gets only when their port is wired — the instructions name a tool only when it
 * is offered.
 */
export interface OptionalBotTools {
  isJiraAttachmentToolOffered: boolean;
  isTodoToolOffered: boolean;
  /** One line per runner that is paired or listed in `runners.json` (`remoteRun/runnerSummary.ts`); none = the instructions do not mention `charness remote-run`. */
  remoteRunRunnerLines: readonly string[];
}

/** @description Which optional tools `deps` offers. */
function getOptionalBotTools(deps: SchedulerMcpDeps): OptionalBotTools {
  return {
    isJiraAttachmentToolOffered: deps.fetchJiraAttachment !== undefined,
    isTodoToolOffered: deps.todos !== undefined,
    remoteRunRunnerLines: deps.getRemoteRunRunnerLines?.() ?? [],
  };
}

function buildTelegramInstructions(isTodoToolOffered: boolean, remoteRunInstructionText: string | null, isBotSkillsEnabled: boolean): string {
  return `This MCP lets the agent act on its own Telegram topic.

When to use it:
• The user asks to run/finish a plan or task LATER ("in 2h", "tomorrow 9am", "every weekday") → schedule_create. Put the work in \`prompt\`; the future run is a fresh session with no memory of this chat. Not CronCreate / ScheduleWakeup for anything that must happen: they die with your process, which the bot stops after a long idle stretch.
• You produced a file/chart/screenshot/video to deliver → send_file_to_user. Videos MUST be H.264 .mp4 sent as video (never as_file/document or .webm/.mov — those render as GIFs or don't play); transcode first if needed (recipe in the tool description).
• You want to deliver SEVERAL discrete messages (each its own message, e.g. a per-item news digest) → send_messages_to_user; an item may attach ONE file (the text becomes its caption).
${compactConversationInstruction}
${isTodoToolOffered ? `${todoInstruction}\n` : ''}• You need to review or remove scheduled jobs → schedule_list / schedule_cancel.
• You need a watchdog — keep an eye on a service, build, deploy, disk, URL… → schedule_create with \`checkCommand\` (cron): the bot runs it in this folder, stays silent while it exits 0, and on the first failure posts a notice and wakes you with \`prompt\` + the exit code and output tail. Checks survive restarts and crashes. NEVER build your own watcher (background loop, nohup, sleep loop, tmux pane, shell crontab): it dies with your session or a restart, silently.
${buildTelegramOrchestrationInstruction(isBotSkillsEnabled)}
${answerRequestInstruction} The requester may not see your plain text: anything they must read goes through answer_request — yet your plain text is relayed into the topic too, so end the turn WITHOUT a recap of what you answered (it would show twice).
${claudeProfilesInstruction}${remoteRunInstructionText === null ? '' : `\n${remoteRunInstructionText}`}

Tool descriptions hold the argument recipes.`;
}

/** What a Jira session's instructions add: the tool that reaches the issue's original files (C10). */
const jiraAttachmentInstruction =
  '• The issue lists a file (an attachment id in the attachments list, or in a placeholder such as "[image: shot.png — attachment 10234]") you need to look at → jira_get_attachment with that id; it saves the original file and returns its path.';

/** For a conversation on a tracker: the requester sees nothing but the answers; `extraInstructions` name the platform's own tools. */
function buildTrackerInstructions(extraInstructions: readonly string[], isBotSkillsEnabled: boolean): string {
  return `This MCP connects the agent to the conversation that asked for its work.

When to use it:
${[
  `${answerRequestInstruction} The requester never sees your plain text or tool output: anything they must read goes through answer_request.`,
  ...extraInstructions,
  compactConversationInstruction,
  claudeProfilesInstruction,
  buildTrackerOrchestrationInstruction(isBotSkillsEnabled),
].filter((instruction) => instruction !== null).join('\n')}

Each tool's own description has the exact argument recipe.`;
}

/**
 * Connect-time `instructions` returned in the MCP `initialize` handshake — a
 * short, high-level pointer the client surfaces to the agent BEFORE any call.
 * Deliberately use-case oriented (when to reach for this server, what it can do)
 * and does NOT repeat the per-tool argument recipes: each tool's own description
 * already carries those in full. Kept terse on purpose.
 *
 * @description The connect-time instructions for a session of `platform`: only
 * a Telegram session has the scheduling and send-to-topic tools, so only its
 * instructions name them (Jira connector plan J2, D18); an optional tool is named
 * only where it is offered. With the bot's skills off for the session
 * (`isBotSkillsEnabled`, `/bot_skills`) the orchestration bullet no longer tells it to load `charness-manager`.
 */
export function buildMcpServerInstructions(platform: PlatformId | null, offered: OptionalBotTools, isBotSkillsEnabled: boolean): string {
  const render = (remoteRunInstructionText: string | null): string => {
    if (platform === 'telegram') return buildTelegramInstructions(offered.isTodoToolOffered, remoteRunInstructionText, isBotSkillsEnabled);
    const remoteRunInstructions = remoteRunInstructionText === null ? [] : [remoteRunInstructionText];
    if (platform !== 'jira') return buildTrackerInstructions(remoteRunInstructions, isBotSkillsEnabled);
    return buildTrackerInstructions([
      ...(offered.isJiraAttachmentToolOffered ? [jiraAttachmentInstruction] : []),
      ...(offered.isTodoToolOffered ? [todoInstruction] : []),
      ...remoteRunInstructions,
    ], isBotSkillsEnabled);
  };
  const runnerCount = offered.remoteRunRunnerLines.length;
  if (runnerCount === 0) return render(null);
  // As many runners as the room under Claude Code's cap leaves; the bullet itself always stays (its `runners` command is the full list).
  for (let shownCount = runnerCount; shownCount > 0; shownCount -= 1) {
    const text = render(buildRemoteRunInstruction(offered.remoteRunRunnerLines, shownCount));
    if (text.length <= claudeCodeInstructionsMaxLength) return text;
  }
  return render(buildRemoteRunInstruction(offered.remoteRunRunnerLines, 0));
}

/** Max characters of a free-text job name / prompt accepted by a tool (defensive bound). */
const maxNameLength = 200;
const maxPromptLength = 8000;

// ─── scope + token ───────────────────────────────────────────────────

/**
 * @name SchedulerScope
 * @description The authorisation scope a token grants. `thread` pins to one exact
 * thread (Claude); `dir` grants the whole bound directory (OpenCode), where a
 * single bound thread is implicit and >1 forces an explicit `threadKey` arg.
 */
export type SchedulerScope =
  | { kind: 'thread'; threadKey: string }
  | { kind: 'dir'; directory: string };

/** Read the configured scheduler MCP port once, mirroring the OPENCODE_URL env read. */
export function getSchedulerMcpPort(): number {
  const raw = process.env.SCHEDULER_MCP_PORT;
  if (!raw) return defaultSchedulerMcpPort;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : defaultSchedulerMcpPort;
}

/**
 * @description Resolve the scheduler MCP listen port with a fixed precedence:
 * an explicit env port (`SCHEDULER_MCP_PORT`, a non-zero {@link getSchedulerMcpPort})
 * WINS; else the port persisted from a prior boot (so an ephemeral port, once
 * chosen, is reused — the registrations injected into agent sessions point at
 * it, and an ephemeral port changing every restart would orphan them); else `0`
 * (ask the OS for a fresh ephemeral port). A persisted `0` / non-positive value
 * is ignored (nothing worth reusing).
 */
export function resolveSchedulerMcpPort(
  envPort: number,
  persistedPort: number | undefined,
): number {
  if (envPort !== defaultSchedulerMcpPort) return envPort;
  if (persistedPort !== undefined && persistedPort > 0) return persistedPort;
  return defaultSchedulerMcpPort;
}

/**
 * @description The platform of the conversations a scope reaches. A `dir:`
 * scope is an OpenCode registration, which only Telegram topics use today. A
 * thread key no codec reads gets the narrower, platform-neutral tool set.
 */
export function getSchedulerScopePlatform(scope: SchedulerScope): PlatformId | null {
  if (scope.kind === 'dir') return 'telegram';
  return tryKeyFromString(scope.threadKey)?.platform ?? null;
}

/** Serialise a scope to its canonical cleartext form (the string the HMAC signs). */
export function serializeSchedulerScope(scope: SchedulerScope): string {
  return scope.kind === 'thread' ? `thread:${scope.threadKey}` : `dir:${scope.directory}`;
}

/** Parse the canonical cleartext scope string back into a {@link SchedulerScope}, or `null`. */
export function parseSchedulerScope(serialized: string): SchedulerScope | null {
  const sep = serialized.indexOf(':');
  if (sep <= 0) return null;
  const kind = serialized.slice(0, sep);
  const rest = serialized.slice(sep + 1);
  if (rest.length === 0) return null;
  if (kind === 'thread') return { kind: 'thread', threadKey: rest };
  if (kind === 'dir') return { kind: 'dir', directory: rest };
  return null;
}

/** HMAC-SHA256(secret, message) as lowercase hex. */
function computeHmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * @description Mint a bearer token for a scope: `<scopeB64url>.<hmacHex>`. The
 * scope rides in cleartext (base64url of the canonical scope string) so the
 * verifier can recover it without a lookup table; the HMAC over the DECODED
 * scope string is the unforgeable part. Document/keep in sync with
 * {@link verifySchedulerMcpToken}.
 */
export function buildSchedulerMcpToken(secret: string, scope: SchedulerScope): string {
  const serialized = serializeSchedulerScope(scope);
  const scopeB64 = Buffer.from(serialized, 'utf8').toString('base64url');
  const signature = computeHmacHex(secret, serialized);
  return `${scopeB64}.${signature}`;
}

/**
 * @description Verify a bearer token and recover its scope. Splits on the single
 * `.`, base64url-decodes the scope half, recomputes the HMAC over the decoded
 * scope string, and compares it to the token's signature with a constant-time
 * {@link timingSafeEqual} (equal-length hex buffers). Returns the parsed scope on
 * success, or `null` for any malformed / tampered token. A tampered scope half
 * changes the HMAC input so the recomputed signature won't match; a tampered
 * signature half fails the compare directly.
 */
export function verifySchedulerMcpToken(secret: string, token: string): SchedulerScope | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const scopeB64 = token.slice(0, dot);
  const providedSignature = token.slice(dot + 1);

  let serialized: string;
  try {
    serialized = Buffer.from(scopeB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const scope = parseSchedulerScope(serialized);
  if (!scope) return null;

  const expectedSignature = computeHmacHex(secret, serialized);
  // timingSafeEqual throws on length mismatch, so length-gate first (hex of a
  // SHA-256 is always 64 chars, but a tampered token could be any length).
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  return scope;
}

/** Pull the bearer token out of an `Authorization` header value, or `null`. */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// ─── deps + thread resolution ────────────────────────────────────────

/**
 * @name SchedulerMcpDeps
 * @description Everything the MCP server needs from the outside, injected so the
 * module stays free of `bot.ts` imports. `store` is the real {@link StateStore}
 * (schedule getters + the create path live on it / its store helper); `armJob`
 * and `disarmJob` are the engine's timer controls; `getThreadsForDirectory`
 * resolves a `dir` scope to the threads bound to that folder; `getThreadAdapterName`
 * snapshots the adapter to start after a rebind; `getSecret` returns the persisted
 * HMAC secret; `port` overrides the env-derived listen port (tests pass `0`).
 */
export interface SchedulerMcpDeps {
  store: StateStore;
  armJob: (record: ScheduleRecord) => void;
  disarmJob: (jobId: string) => void;
  /** Thread keys bound to a directory (OpenCode instance), serialised strings. */
  getThreadsForDirectory: (directory: string) => string[];
  /** Last-used adapter name for a thread, for the `lastAdapterName` snapshot. */
  getThreadAdapterName: (threadKey: string) => string | undefined;
  /**
   * Unpin these messages of the thread — the old alert pins of a cancelled check — and resolve with the ids that are STILL
   * pinned and worth another try (Telegram did not answer, asked to slow down, failed). A message that is gone, was never
   * pinned or cannot be unpinned any more is final: it is not in the list. Never rejects.
   */
  unpinMessages: (threadKey: string, messageIds: readonly number[]) => Promise<number[]>;
  /** Delete a message of the thread (best-effort: one that is gone or too old to delete is skipped) — a cancelled check's status line. */
  deleteMessage: (threadKey: string, messageId: number) => Promise<void>;
  /**
   * Send 1..10 files/images from the thread's bound folder back into the topic.
   * Path-safety, type classification, and the album/size decision live in the
   * reusable `fileSendService`; this surface only routes the resolved thread +
   * args and relays the `{ ok }` summary/error to the agent.
   */
  sendFilesToThread: SendFilesToThread;
  /**
   * Deliver a batch of DISCRETE messages into the thread's topic — each string
   * becomes its OWN Telegram message (never merged), for cases where the agent
   * wants several separate messages (e.g. a per-item news digest). The paced
   * send + `/clear` tracking live in the injected `bot.ts` closure; this surface
   * only routes the resolved thread + messages and relays the `{ ok }` summary.
   */
  sendMessagesToThread: SendMessagesToThread;
  /**
   * Arm an agent-triggered compaction for the resolved thread (F1). The bot
   * compacts the session's context once the CURRENT turn finishes (it never
   * compacts mid-turn). Returns a short status the tool relays to the agent —
   * `ok:false` when there is no active agent session to compact.
   */
  compactConversation: (threadKey: string) => { ok: boolean; message: string };
  /**
   * `jira_get_attachment`: download one attachment of the Jira issue the conversation `threadKey` names (Jira
   * prompt context C10). Supplied by the Jira connector, which stays lazily loaded; absent on an instance
   * without it, and then the tool is not offered.
   */
  fetchJiraAttachment?: (threadKey: string, attachmentId: string) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  /**
   * `claude_profiles`: the signed-in Claude account profiles with their usage windows and the one a process of
   * `query.model` should run on (`getClaudeLaunchPick`, `utils/claudeUsage.ts`); the bot refreshes the snapshots on
   * demand before answering. Offered on every platform (a child process is launched the same way everywhere); the
   * tool is absent when the port is.
   */
  listClaudeProfiles?: (query: ClaudeProfilesQuery) => Promise<ClaudeProfilesReport>;
  /**
   * One line per runner `charness remote-run` can use — paired or in `runners.json` (`remoteRun/runnerSummary.ts`): name, OS, what it could do
   * when last probed. Asked at every connect, so a runner added, removed or paused shows in the next session's instructions; absent or empty =
   * the instructions do not mention remote-run.
   */
  getRemoteRunRunnerLines?: () => readonly string[];
  /**
   * Where the surface leaves one diagnostic line when it REFUSES a tool call for an unknown input key. The SDK checks
   * the input before any of the bot's code runs, so without this a client that adds a key of its own to every call
   * would fail every call with no trace on the operator's side. Must not throw; absent = nothing is logged.
   */
  logDiagnostic?: (line: string) => void;
  /**
   * `todo_update` / `todo_read`: the conversation's published todo list (`todos/registry.ts`). Offered to Telegram
   * and Jira sessions; absent = the tools are not offered.
   */
  todos?: {
    update: (threadKey: string, args: TodoUpdateArgs) => Promise<TodoToolOutcome>;
    read: (threadKey: string, args: TodoReadArgs) => Promise<TodoToolOutcome>;
  };
  /**
   * Deliver an agent's answer to a request and apply the close rules
   * (`answer_request`). The surface passes the scope check in; the rules live in
   * `requests/answerRequest.ts`.
   */
  answerRequest: (args: AnswerRequestArgs) => Promise<AnswerRequestOutcome>;
  /**
   * Resolves once the boot has re-attached the surviving sessions and rebuilt
   * their per-thread state. The server serves BEFORE that (so a session spawned
   * at boot is born with it), and a tool that reads session state awaits this
   * first — otherwise a surviving session calling it in that window would be
   * told it has no active session.
   */
  whenSessionsRestored: () => Promise<void>;
  getSecret: () => Promise<string>;
  /** Listen port; defaults to {@link getSchedulerMcpPort}. Tests pass `0` for ephemeral. */
  port?: number;
  /** How a `port` in use is waited out before falling back; defaults to {@link schedulerMcpBindRetryCount} × {@link schedulerMcpBindRetryDelayMs}. */
  portBindRetry?: { count: number; delayMs: number };
}

/**
 * @name SchedulerMcpHandle
 * @description The running server's control surface. `port` is the actually-bound
 * port (resolved after `start`, important when the caller passed `0`).
 */
export interface SchedulerMcpHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bound port, available after `start` resolves. */
  readonly port: number;
  /** The digest of the tool definitions and instructions a session of `platform` connects to (see {@link getBotMcpToolDigest}). */
  getToolDigest(platform: PlatformId | null, isBotSkillsEnabled: boolean): string;
}

/**
 * The parts of a tool definition an MCP client sees at connect, as {@link McpServer.registerTool} takes them. The input
 * is a {@link StrictToolInput}: a tool registered with a plain raw shape would have an unknown key stripped unseen.
 */
interface ToolRegistration<InputArgs extends StrictToolInput> {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
}

/**
 * What the tool registrars need of an {@link McpServer}: the registration call
 * alone, its result unused — so a recorder that only notes the definition (the
 * digest) satisfies it next to the real server.
 */
interface ToolRegistrar {
  registerTool<InputArgs extends StrictToolInput>(
    name: string,
    config: ToolRegistration<InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): void;
}

/** The parts of a tool definition an MCP client sees — what {@link getBotMcpToolDigest} hashes. */
export interface BotMcpToolDefinition {
  name: string;
  title: string | undefined;
  description: string | undefined;
  /** The input schema's top-level parameter names, sorted. */
  inputKeys: string[];
}

/**
 * @description Hash what a client caches when it connects — the server
 * instructions and the tool definitions it would list — into a stable id of
 * "what this bot build offers a session of one platform". Lifecycle plan L4:
 * persisted when a json-stream process starts and compared when the process is
 * adopted after a bot restart, since the stateless server cannot tell a running
 * client that any of it changed.
 */
export function buildBotMcpToolDigest(instructions: string, definitions: readonly BotMcpToolDefinition[]): string {
  const canonical = [...definitions]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, title, description, inputKeys }) => ({ name, title: title ?? '', description: description ?? '', inputKeys }));
  return createHash('sha256').update(JSON.stringify({ instructions, tools: canonical })).digest('hex');
}

/** A scope of no conversation: only the digest registers against it, and the digest never runs a handler. */
const digestScope: SchedulerScope = { kind: 'dir', directory: '' };

/**
 * @description The digest of the tools a session of `platform` gets — built by
 * the SAME registration the request path runs, recorded instead of served, so
 * a tool added, renamed, re-described or re-shaped changes it and nothing else
 * has to be kept in step by hand.
 */
export function getBotMcpToolDigest(deps: SchedulerMcpDeps, platform: PlatformId | null, isBotSkillsEnabled: boolean): string {
  return buildBotMcpToolDigest(buildMcpServerInstructions(platform, getOptionalBotTools(deps), isBotSkillsEnabled), getBotMcpToolDefinitions(deps, platform));
}

/**
 * @description The tool definitions a session of `platform` gets, recorded from the SAME registration the request
 * path runs (never a handler): what the digest hashes, and what a test reads the tools' names and descriptions from.
 */
export function getBotMcpToolDefinitions(deps: SchedulerMcpDeps, platform: PlatformId | null): BotMcpToolDefinition[] {
  const definitions: BotMcpToolDefinition[] = [];
  const recorder: ToolRegistrar = {
    registerTool: (name, config) => {
      definitions.push({ name, title: config.title, description: config.description, inputKeys: Object.keys(config.inputSchema.shape).sort() });
    },
  };
  registerBotTools(recorder, deps, digestScope, platform, undefined);
  return definitions;
}

/**
 * @name ResolveThreadResult
 * @description Outcome of mapping a scope (+ optional `threadKey` arg) to a single
 * target thread. `error` carries a readable message surfaced as an MCP tool error.
 */
type ResolveThreadResult = { ok: true; threadKey: string } | { ok: false; error: string };

/**
 * @description Resolve the single thread a tool call targets, from its scope and
 * an optional caller-supplied `threadKey`:
 *  - `thread` scope → that exact thread; a supplied `threadKey` must match it.
 *  - `dir` scope → the threads bound to the directory: exactly 1 → implicit;
 *    >1 → `threadKey` REQUIRED and must be one of them; 0 → error.
 * Pure given the injected `getThreadsForDirectory`.
 */
export function resolveTargetThreadKey(
  scope: SchedulerScope,
  suppliedThreadKey: string | undefined,
  getThreadsForDirectory: (directory: string) => string[],
): ResolveThreadResult {
  if (scope.kind === 'thread') {
    if (suppliedThreadKey && suppliedThreadKey !== scope.threadKey) {
      return {
        ok: false,
        error: `threadKey "${suppliedThreadKey}" does not match this session's thread (${scope.threadKey})`,
      };
    }
    return { ok: true, threadKey: scope.threadKey };
  }

  const bound = getThreadsForDirectory(scope.directory);
  if (bound.length === 0) {
    return { ok: false, error: `no thread is bound to directory "${scope.directory}"` };
  }
  if (bound.length === 1) {
    if (suppliedThreadKey && suppliedThreadKey !== bound[0]) {
      return {
        ok: false,
        error: `threadKey "${suppliedThreadKey}" is not bound to directory "${scope.directory}"`,
      };
    }
    return { ok: true, threadKey: bound[0] };
  }
  // >1 bound thread → an explicit, valid threadKey is mandatory.
  if (!suppliedThreadKey) {
    return {
      ok: false,
      error:
        `directory "${scope.directory}" has ${bound.length} bound threads; ` +
        `pass threadKey (one of: ${bound.join(', ')})`,
    };
  }
  if (!bound.includes(suppliedThreadKey)) {
    return {
      ok: false,
      error: `threadKey "${suppliedThreadKey}" is not bound to directory "${scope.directory}"`,
    };
  }
  return { ok: true, threadKey: suppliedThreadKey };
}

// ─── tool input schemas + spec building ──────────────────────────────

/** The optional target thread every topic-scoped tool takes (a `dir:` scope with several bound threads needs it). */
const threadKeyArgSchema = z
  .string()
  .optional()
  .describe('Target thread "<chatId>:<threadId>". Required when a directory scope has more than one bound thread.');

const scheduleCreateShape = {
  name: z.string().min(1).max(maxNameLength).describe('Short human name for the job (shown in announcements/lists).'),
  cron: z
    .string()
    .optional()
    .describe(
      '5-field host-local cron expression for a RECURRING job (e.g. "0 9 * * 1-5"). ' +
        'For a single future run use onceAt instead, NOT a cron (a cron has no year and would ' +
        'fire on the same date every year). Omit onceAt when you pass cron.',
    ),
  onceAt: z
    .string()
    .optional()
    .describe(
      'ISO 8601 instant for a ONE-SHOT run (e.g. "2026-06-07T09:00:00"). This is the right field for ' +
        '"run it once at <time>". Omit cron AND repeatCount when you pass onceAt — a one-shot always runs ' +
        'exactly once.',
    ),
  repeatCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of CRON fires before the job auto-deletes (N-times recurring). ONLY for cron jobs. ' +
        'Do NOT set it for a one-shot (onceAt) — a one-shot already runs exactly once, so repeatCount ' +
        'is ignored there.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(maxPromptLength)
    .describe(
      'The prompt forwarded to the agent at fire time (for a check: only when the check fails, after ' +
        'the failure details). Make it SELF-CONTAINED — the future run starts ' +
        'with no memory of this conversation. Bake in everything it needs: the plan file path + scope, ' +
        'whether to delegate to a sub-agent, and any constraints. Put the WORK in the prompt; do the ' +
        'investigation later, when it fires.',
    ),
  checkCommand: z
    .string()
    .max(maxCheckCommandLength)
    .optional()
    .describe(
      'Makes the job a WATCHDOG CHECK: a shell command (run with /bin/sh -c in the bound folder) the bot ' +
        'executes at every fire instead of waking you. Exit 0 = healthy, nothing is posted. The first ' +
        'non-zero exit or timeout tells the topic in one line (never the command) and wakes you with `prompt` plus the exit ' +
        'code and output tail; later failures stay silent until a run passes again (the topic is told). ' +
        'Keep it a quick probe, e.g. `systemctl --user is-active myapp`, `curl -fsS -m 10 http://127.0.0.1:8080/health`, ' +
        '`test $(df --output=pcent / | tail -1 | tr -dc 0-9) -lt 90`; a detached worker: the recipe in the tool description.',
    ),
  checkTimeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(maxCheckTimeoutSec)
    .optional()
    .describe(
      `Seconds a check run may take before it is stopped and counted as a failure (default ${defaultCheckTimeoutSec}). ` +
        'Only with checkCommand.',
    ),
  statusWorkerRunDir: z
    .string()
    .max(maxCheckStatusRunDirLength)
    .optional()
    .describe(
      'A check\'s STATUS SOURCE for a detached worker: its run directory (absolute, or relative to the bound folder). While the ' +
        'check passes, the BOT itself posts a short silent status line into the topic every statusEveryMinutes — how long the ' +
        'worker has run and what it did last (its last text or tool call, read from the newest events*.jsonl there) — and ' +
        'deletes the previous one. No agent wake, no tokens. Only with checkCommand; not together with statusCommand. ' +
        'A topic on the answers-only view, and a tracker issue, get no line.',
    ),
  statusCommand: z
    .string()
    .max(maxCheckStatusCommandLength)
    .optional()
    .describe(
      'A check\'s STATUS SOURCE for anything else: a shell command (run in the bound folder, at most ' +
        `${checkStatusCommandTimeoutSec} s) whose first output line is the «now» of the same bot-posted status line ` +
        '(e.g. `tail -n 1 build.log`). Only with checkCommand; not together with statusWorkerRunDir.',
    ),
  statusEveryMinutes: z
    .number()
    .int()
    .min(minCheckStatusEveryMinutes)
    .max(maxCheckStatusEveryMinutes)
    .optional()
    .describe(
      `Minutes between two status lines (${minCheckStatusEveryMinutes}-${maxCheckStatusEveryMinutes}, default ${defaultCheckStatusEveryMinutes}). ` +
        'Only with a status source.',
    ),
  isPinSilent: z
    .boolean()
    .optional()
    .describe('DEPRECATED, has no effect: scheduled messages and check alerts are never pinned. Do not pass it.'),
  threadKey: threadKeyArgSchema,
};
const scheduleCreateInput = createStrictToolInput(scheduleCreateShape);

const scheduleListShape = {
  threadKey: threadKeyArgSchema,
};
const scheduleListInput = createStrictToolInput(scheduleListShape);

const scheduleCancelShape = {
  id: z.string().min(1).describe('The schedule id to cancel (from schedule_list).'),
  threadKey: threadKeyArgSchema,
};
const scheduleCancelInput = createStrictToolInput(scheduleCancelShape);

/**
 * Coerces an ARRAY tool argument into an actual array before validation. Some
 * MCP bridges (observed: Claude-agent harnesses AND OpenCode) serialize an array
 * argument as a raw JSON STRING (`'["a","b"]'`, or a mixed
 * `'[{"path":"p"},"txt"]'`) instead of a JSON array, which a plain `z.array()`
 * rejects. Accept: a real array (pass-through), a JSON-array string (parsed —
 * per-element validation still runs on the union afterward), or a single plain
 * string (wrapped into a one-element array). Shared by `paths` and `messages`.
 */
const coerceJsonArrayArg = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return [value];
};

const sendFileShape = {
  paths: z.preprocess(
    coerceJsonArrayArg,
    z
      .array(z.string().min(1))
      .min(1)
      .max(10),
  )
    .describe(
      'Files to send, as 1..10 paths RELATIVE to this topic\'s bound folder (absolute paths are accepted ' +
        'only if they resolve inside it). A path outside the folder is rejected and nothing is sent. ' +
        '2..10 paths are delivered as ONE album.',
    ),
  caption: z
    .string()
    .optional()
    .describe('Optional caption (Telegram caps it at 1024 chars; longer is trimmed). For an album it rides the first file.'),
  as_file: z
    .boolean()
    .optional()
    .describe(
      'Explicitly force sendDocument (original quality, no inline preview), including for MP4s that use sendVideo by default.',
    ),
  threadKey: threadKeyArgSchema,
};
const sendFileInput = createStrictToolInput(sendFileShape);

/**
 * One batch item: EITHER a plain non-empty string (text-only message,
 * backward-compatible with the original string-array tool) OR an object that may
 * carry a text body, an attachment `path`, or both. The object is CLOSED: an
 * agent that writes `filePath` for `path` must be told, not silently sent as a
 * text-only message. The `.refine` rejects an all-empty object so a stray `{}`
 * never posts nothing.
 */
const sendMessageItemObjectSchema = createStrictToolInput({
  text: z
    .string()
    .optional()
    .describe(
      'Message body. On an ATTACHMENT item (path set) it is the media caption, trimmed to 1024 chars — put long ' +
        'prose in its OWN text-only item instead of an attachment caption.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Optional attachment, RELATIVE to this topic's bound folder (an absolute path is accepted only if it " +
        'resolves inside it; a path outside is rejected). Supported photos and MP4 videos are sent as native ' +
        'media, GIFs as animations, and everything else as a document.',
    ),
  as_file: z
    .boolean()
    .optional()
    .describe('Force sendDocument for THIS attachment (original quality, no inline preview), including for MP4s.'),
}).refine(
  (item) => (item.text?.trim().length ?? 0) > 0 || (item.path?.trim().length ?? 0) > 0,
  { message: 'each message object must set a non-empty text or path' },
);

const sendMessageShape = {
  messages: z
    .preprocess(
      coerceJsonArrayArg,
      z
        .array(z.union([z.string().min(1), sendMessageItemObjectSchema], { error: getUnknownKeysMessageOfUnion }))
        .min(1)
        .max(maxDiscreteMessages),
    )
    .describe(
      `1..${maxDiscreteMessages} items; EACH item is posted as its OWN separate Telegram message, in order (never ` +
        'merged). An item is EITHER a plain string (a text message) OR an object {text?, path?, as_file?}. When ' +
        'path is set the item is delivered as an ATTACHMENT: supported photos render inline, .gif uses ' +
        'sendAnimation, and .mp4 uses sendVideo (other video containers like .mov/.webm render as a GIF, so remux ' +
        'to .mp4 first); everything else is a document, and text becomes the media caption (trimmed to 1024 chars ' +
        '— send long prose as its OWN ' +
        "text-only item). path is RELATIVE to this topic's bound folder; as_file forces the document override. " +
        'Use this when you deliberately want several distinct messages (e.g. a per-item news digest: one message ' +
        'per headline). Do NOT also print the same content as your normal reply, or it posts twice. Text supports ' +
        'the usual markdown (links, bold); an over-long text item is split automatically.',
    ),
  threadKey: threadKeyArgSchema,
};
const sendMessageInput = createStrictToolInput(sendMessageShape);

/**
 * The three valid call shapes, appended to structural errors so a bad first call
 * teaches the corrected next call (the model spirals when an error says only what
 * is wrong, not what shape to use instead — observed in the live transcript).
 */
const scheduleRecipes =
  'Recipes — one-shot: pass onceAt (ISO), omit cron and repeatCount. ' +
  'Recurring: pass cron, omit onceAt. ' +
  'Recurring N times: pass cron and repeatCount, omit onceAt.';

/**
 * @description Collapse an optional free-text field to `undefined` when it is
 * absent OR blank (empty / whitespace-only). MCP bridges can render an omitted
 * optional as an empty string (`cron=""` on a one-shot, `onceAt=""` on a cron),
 * and an empty string must NOT count as a supplied value for the exactly-one-of
 * check. Trimming also tolerates accidental surrounding whitespace.
 */
function normalizeOptionalArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @name BuildSpecResult
 * @description Outcome of turning the create-tool args into a {@link ScheduleSpec}.
 * `note` carries a non-fatal advisory surfaced alongside a successful create
 * (e.g. a `repeatCount` ignored on a one-shot). `error` is a readable validation
 * message (exactly-one-of, bad cron / past one-shot) surfaced as an MCP tool error.
 */
type BuildSpecResult = { ok: true; spec: ScheduleSpec; note?: string } | { ok: false; error: string };

/**
 * @description Validate the create args and build a {@link ScheduleSpec}: exactly
 * one of `cron`/`onceAt` (empty/whitespace fields normalised away first); then run
 * the shared {@link validateScheduleSpec} (cron parse + min-interval + past-one-shot).
 * `nowMs` is injected so the past-one-shot check is deterministic.
 *
 * A `repeatCount` supplied alongside `onceAt` is IGNORED (not rejected): a one-shot
 * is by definition a single run, so the count is meaningless there. The model
 * naturally reaches for `repeatCount: 1` to express "run once" and, when that was
 * a hard error, spiralled into absurd counts / a wrong-year cron workaround
 * (live transcript). Accepting the natural call removes that failure mode; the
 * returned `note` teaches the agent the field was redundant.
 */
export function buildSpecFromCreateArgs(
  args: { cron?: string; onceAt?: string; repeatCount?: number },
  nowMs: number,
): BuildSpecResult {
  const cron = normalizeOptionalArg(args.cron);
  const onceAt = normalizeOptionalArg(args.onceAt);
  const { repeatCount } = args;

  if (cron && onceAt) {
    return { ok: false, error: `Pass either cron OR onceAt, not both. ${scheduleRecipes}` };
  }
  if (!cron && !onceAt) {
    return { ok: false, error: `Pass exactly one of cron or onceAt. ${scheduleRecipes}` };
  }

  let note: string | undefined;
  if (onceAt && repeatCount !== undefined) {
    note = 'repeatCount was ignored — a one-shot (onceAt) always runs exactly once.';
  }

  const spec: ScheduleSpec = cron
    ? { kind: 'cron', cronExpr: cron, ...(repeatCount !== undefined ? { remainingRuns: repeatCount } : {}) }
    : { kind: 'once', onceAtIso: onceAt as string };

  const validationError = validateScheduleSpec(spec, nowMs);
  if (validationError) return { ok: false, error: validationError };
  return { ok: true, spec, note };
}

// ─── tool result helpers ─────────────────────────────────────────────

/** Wrap text as a successful MCP tool result (plain text content block). */
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap a readable message as an MCP tool ERROR result the agent relays to the user. */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Report an ambiguous delivery without inviting MCP clients to retry it. */
function deliveryUnknownResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { kind: 'deliveryUnknown', retryable: false },
  };
}

/** One-line human summary of a record for `schedule_list` / create confirmations. */
function summarizeRecord(record: ScheduleRecord): string {
  // Local-offset ISO, never `toISOString()`'s UTC `Z`: the operator declared a
  // timezone and the agent reads this back to them, so a next-run stamp in some
  // other zone than the one the job actually fires in is actively misleading.
  const next = record.nextRunAt !== null ? formatIsoLocalOffset(record.nextRunAt) : 'none';
  const pausedNote = record.isPaused ? ' [paused]' : '';
  const checkNote = checkIsCheckSchedule(record)
    ? `; check: \`${record.checkCommand ?? ''}\` (${record.isCheckFailing ? 'FAILING' : 'passing'})`
    : '';
  const hasStatusSource = record.statusWorkerRunDir !== undefined || record.statusCommand !== undefined;
  const statusNote = hasStatusSource ? `; status every ${record.statusEveryMinutes ?? defaultCheckStatusEveryMinutes} min` : '';
  return `${record.name} (id: ${record.id}) — ${describeSchedule(record.spec)}${checkNote}${statusNote}; next run: ${next}${pausedNote}`;
}

/**
 * The `schedule_create` confirmation, which also lands in the topic as a tool result: one line a person reads, with WHAT and
 * WHEN («Scheduled "Nightly build": daily at 02:00; next: 2026-06-07 02:00» / «Scheduled "API health": checks every 5m; next:
 * …») and, on the next, the id the agent needs to cancel it. The «next» stamp is the instance-local time, so a schedule that
 * was read in the wrong timezone shows at once; a cron nothing phrases shows only that (never the raw expression), and a
 * one-shot's phrase already is its time. The command and the status rhythm are in `schedule_list`.
 */
function summarizeCreated(record: ScheduleRecord): string {
  const isCheck = checkIsCheckSchedule(record);
  const phrase = describePhrasedSchedule(record.spec);
  const parts: string[] = [];
  if (phrase !== null) parts.push(isCheck ? `checks ${phrase}` : phrase);
  else if (isCheck) parts.push('checks');
  if (record.spec.kind === 'cron' && record.nextRunAt !== null) parts.push(`next: ${formatLocalDateAndClock(record.nextRunAt)}`);
  return `Scheduled "${record.name}": ${parts.join('; ')}\nid: ${record.id}`;
}

// ─── tool handlers (scope-bound) ─────────────────────────────────────

/**
 * @description Register the three scoped tools onto a fresh {@link McpServer}.
 * Every handler resolves the target thread from `scope` first (scope isolation),
 * then operates only on that thread's jobs. Bound to `deps` + the request's
 * verified `scope`.
 */
function registerSchedulerTools(server: ToolRegistrar, deps: SchedulerMcpDeps, scope: SchedulerScope): void {
  server.registerTool(
    'schedule_create',
    {
      title: 'Create a scheduled prompt',
      description:
        'Schedule a prompt to be delivered to this topic later. At fire time the bot posts a short silent line ' +
        '(name and schedule, the prompt folded under it) and forwards the prompt to the agent. The line is never pinned.\n\n' +
        'Pick exactly ONE mode:\n' +
        '• one-shot (run once at a time): pass onceAt (ISO 8601); omit cron and repeatCount.\n' +
        '• recurring: pass cron (5-field); omit onceAt.\n' +
        '• recurring N times: pass cron AND repeatCount; omit onceAt.\n' +
        'For a single future run ALWAYS use onceAt — never a cron with repeatCount:1 ' +
        '(a cron has no year, so it would fire on that date every year). repeatCount counts CRON ' +
        'fires only and is ignored for a one-shot.\n\n' +
        'USE THIS whenever the user asks to schedule execution of a plan or task for later ' +
        "(e.g. \"schedule finishing plan X in 2h\", \"run this plan tomorrow morning\"). " +
        'Schedule IMMEDIATELY: write the request straight into `prompt` and create the job FIRST — ' +
        'do NOT read code, explore the repo, or deliberate before scheduling. Plan now, figure out the ' +
        'details at fire time. The future run does the investigation, not this call.\n\n' +
        'WATCHDOG: to monitor something (a service, process, build, deploy, disk, URL), pass checkCommand ' +
        'with a cron — the bot runs it in this folder and wakes you only when it starts failing. This is ' +
        'the ONLY reliable watcher: it survives bot restarts and crashes. Never build your own (a ' +
        'background loop, nohup, a sleep loop, a tmux pane, a shell crontab) — it dies with your session ' +
        'or a restart and then fails silently.\n\n' +
        `A DETACHED WORKER you launched (a \`claude -p\` / \`opencode run\` process): cron \`${workerWatchCheckCron}\`, ` +
        `\`${workerWatchStatusArguments}\`, checkCommand \`${workerWatchCheckCommand}\` with its PID and run dir — it fails when ` +
        `the worker exits OR nothing in its run dir changed for ${workerWatchSilenceMinutes} min, so the first failure is also the "worker finished" ` +
        'signal (the topic then reads «worker finished» or «worker silent», never the command). Never `kill -0` alone: it stays green ' +
        'while a worker hangs. The status arguments make the BOT post a silent status line into the topic every ' +
        `${workerWatchStatusEveryMinutes} min while the worker lives (works N min, its last action), so the topic never looks frozen — ` +
        'without waking you or spending tokens: never arm a schedule of your own for status lines. One check per worker run; ' +
        'schedule_cancel it once its wake is handled (that also deletes its status line).',
      inputSchema: scheduleCreateInput,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      const nowMs = Date.now();
      const built = buildSpecFromCreateArgs(args, nowMs);
      if (!built.ok) return errorResult(built.error);

      let threadKey: SessionKey;
      try {
        threadKey = keyFromString(resolved.threadKey);
      } catch {
        return errorResult(`invalid threadKey "${resolved.threadKey}"`);
      }

      const checkCommand = normalizeOptionalArg(args.checkCommand);
      const statusWorkerRunDir = normalizeOptionalArg(args.statusWorkerRunDir);
      const statusCommand = normalizeOptionalArg(args.statusCommand);
      if (statusWorkerRunDir !== undefined && statusCommand !== undefined) {
        return errorResult('statusWorkerRunDir and statusCommand are alternatives — pass ONE status source.');
      }
      const notes = built.note ? [built.note] : [];
      if (!checkCommand && args.checkTimeoutSeconds !== undefined) {
        notes.push('checkTimeoutSeconds was ignored — it only applies with checkCommand.');
      }
      const hasStatusSource = statusWorkerRunDir !== undefined || statusCommand !== undefined;
      if (!checkCommand && hasStatusSource) {
        notes.push('statusWorkerRunDir / statusCommand was ignored — a status line only comes with checkCommand.');
      }
      const isStatusKept = checkCommand !== undefined && hasStatusSource;
      if (args.statusEveryMinutes !== undefined && !isStatusKept) {
        notes.push('statusEveryMinutes was ignored — it only applies with checkCommand and a status source (statusWorkerRunDir or statusCommand).');
      }

      const created = await createScheduleForThread(deps.store, {
        threadKey,
        name: args.name,
        spec: built.spec,
        prompt: args.prompt,
        createdBy: 'agent',
        nowMs,
        lastAdapterName: deps.getThreadAdapterName(resolved.threadKey),
        ...(checkCommand
          ? { deliveryKind: 'check' as const, checkCommand, checkTimeoutSec: args.checkTimeoutSeconds }
          : {}),
        ...(isStatusKept ? { statusWorkerRunDir, statusCommand, statusEveryMinutes: args.statusEveryMinutes } : {}),
      });
      if (!created.ok) {
        // The cap counts only the agent-prompt jobs `schedule_list` shows, so the
        // plain sentence is the whole truth: every slot it names is one this agent
        // can see and cancel itself.
        return errorResult(
          `cannot create: thread already has the maximum of ${created.limit} schedules`,
        );
      }

      const record = created.record;
      deps.armJob(record);
      const noteSuffix = notes.map((note) => `\n\nℹ️ ${note}`).join('');
      return textResult(`${summarizeCreated(record)}${noteSuffix}`);
    },
  );

  server.registerTool(
    'schedule_list',
    {
      title: 'List scheduled prompts',
      description: 'List the scheduled prompts for this topic (id, name, schedule, next run, paused flag).',
      inputSchema: scheduleListInput,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      let threadKey: SessionKey;
      try {
        threadKey = keyFromString(resolved.threadKey);
      } catch {
        return errorResult(`invalid threadKey "${resolved.threadKey}"`);
      }

      // Reminders are invisible to the agent BY DESIGN: a `/reminders` job is
      // bot-local (posted + pinned, no session touched), so listing one here
      // would describe it to the agent as a "scheduled prompt" it could act on —
      // and `schedule_cancel` below would let it delete something the operator
      // created with buttons and never handed to any agent.
      const records = deps.store
        .getThreadSchedules(threadKey)
        .filter((record) => !checkIsReminderSchedule(record));
      if (records.length === 0) {
        return textResult('No schedules for this topic.');
      }
      const lines = records.map((record, index) => `${index + 1}. ${summarizeRecord(record)}`);
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'schedule_cancel',
    {
      title: 'Cancel a scheduled prompt',
      description:
        'Cancel (delete) a scheduled prompt by its id. Only schedules owned by this topic can be cancelled. Cancelling a ' +
        'watchdog check also deletes its status line — cancel a worker watch once its wake is handled, so a finished worker ' +
        'leaves no status line behind.',
      inputSchema: scheduleCancelInput,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      const record = deps.store.getSchedules()[args.id];
      // Scope isolation: the record must exist AND belong to the resolved thread.
      // A reminder answers the SAME "not found" as a missing id rather than a new
      // error kind: `schedule_list` never showed it, so from the agent's side it
      // genuinely does not exist, and a distinct refusal would only tell it there
      // is an id here worth retrying.
      if (!record || record.threadKey !== resolved.threadKey || checkIsReminderSchedule(record)) {
        return errorResult(`no schedule with id "${args.id}" in this topic`);
      }

      await deps.store.removeSchedule(args.id);
      deps.disarmJob(args.id);
      const cleanedUp: string[] = [];
      // Nothing pins a check alert any more, but a job made by an earlier version may still carry the ids of the ones it pinned.
      const alertPins = record.alertPinMessageIds ?? [];
      if (alertPins.length > 0) {
        const stillPinned = await deps.unpinMessages(record.threadKey, alertPins);
        const unpinnedCount = alertPins.length - stillPinned.length;
        if (unpinnedCount > 0) cleanedUp.push(`its ${unpinnedCount} pinned alert(s) unpinned`);
        if (stillPinned.length > 0) cleanedUp.push(`${stillPinned.length} pinned alert(s) could not be unpinned (Telegram did not answer — unpin by hand)`);
      }
      // A "⏳ works …" line left under a cancelled watch would be wrong: the watch no longer says anything.
      if (record.statusMessageId !== undefined) {
        await deps.deleteMessage(record.threadKey, record.statusMessageId);
        cleanedUp.push('its status line deleted');
      }
      const cleanupNote = cleanedUp.length > 0 ? `; ${cleanedUp.join('; ')}` : '';
      return textResult(`Cancelled "${record.name}" (id: ${record.id})${cleanupNote}.`);
    },
  );
}

/**
 * @description Register the agent→Telegram `send_file_to_user` tool onto a fresh
 * {@link McpServer}. Kept separate from {@link registerSchedulerTools} so the
 * scheduler tools stay cohesive. Like every tool here it resolves the target
 * thread from `scope` first (scope isolation — the agent can never name another
 * topic); the actual path-safety + Telegraf send live in `deps.sendFilesToThread`.
 */
function registerFileSendTool(
  server: ToolRegistrar,
  deps: SchedulerMcpDeps,
  scope: SchedulerScope,
  requestSignal: AbortSignal | undefined,
): void {
  server.registerTool(
    'send_file_to_user',
    {
      title: 'Send a file or image to this topic',
      description:
        'Send one or more files/images from THIS topic\'s bound folder back to the user in the topic. ' +
        'Use it to deliver a generated chart, screenshot, report, etc. Paths are relative to the bound ' +
        'folder; a path outside it is rejected and nothing is sent. Images (.png/.jpg/.jpeg/.webp) preview ' +
        'inline, .gif autoplays, and a single .mp4 uses sendVideo by default. as_file:true is the explicit sendDocument ' +
        'override for previewable media; no fake audio track is needed for a silent MP4. Everything else arrives ' +
        'as a document. VIDEO RULE: to deliver a playable video, pass a .mp4 path and do NOT set as_file — any other ' +
        'container (.mov/.webm/.mkv) or a document fallback makes Telegram render it as a GIF instead; remux to .mp4 first ' +
        '(e.g. `ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4`; if no full ffmpeg is ' +
        'installed, `npm i ffmpeg-static` provides one — Playwright\'s bundled ffmpeg has no H.264 encoder). ' +
        '2..10 paths use sendMediaGroup: eligible photos and MP4 videos stay native in ' +
        'all-video and mixed photo/video groups; as_file:true, any animation/document, or an over-cap photo makes ' +
        'the whole album documents — which turns its MP4s into GIFs, so send videos in their own call. ' +
        'If a send fails, say so and give the file\'s path in your reply, then go on with the work — never stop over it. ' +
        'Caption is optional (trimmed to 1024 chars; on the first album item).',
      inputSchema: sendFileInput,
    },
    async (args, extra) => {
      const signal = requestSignal
        ? AbortSignal.any([extra.signal, requestSignal])
        : extra.signal;
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      if (signal.aborted) throw getAbortError(signal);

      const result = await deps.sendFilesToThread(resolved.threadKey, {
        paths: args.paths,
        caption: args.caption,
        asFile: args.as_file,
        ...(scope.kind === 'dir' ? { authorizedWorkDir: scope.directory } : {}),
        signal,
      });
      if (result.ok) return textResult(result.summary);
      return 'kind' in result && result.kind === 'deliveryUnknown'
        ? deliveryUnknownResult(result.error)
        : errorResult(result.error);
    },
  );
}

/**
 * @description Register the agent→Telegram `send_messages_to_user` tool onto a
 * fresh {@link McpServer}. The discrete-message sibling of `send_file_to_user`:
 * each array element is delivered as its OWN Telegram message (never merged),
 * for a per-item digest and similar. Like every tool here it resolves the target
 * thread from `scope` first (scope isolation); the paced send lives in
 * `deps.sendMessagesToThread`.
 */
function registerMessageSendTool(
  server: ToolRegistrar,
  deps: SchedulerMcpDeps,
  scope: SchedulerScope,
  requestSignal: AbortSignal | undefined,
): void {
  server.registerTool(
    'send_messages_to_user',
    {
      title: 'Send several separate messages to this topic',
      description:
        'Deliver a batch of DISCRETE messages into THIS topic — each item of `messages` is posted as its own ' +
        'separate Telegram message, in order (never merged). Use it when you deliberately want several messages ' +
        'instead of one, e.g. a per-item news digest (header, a date separator, then one message per headline). ' +
        'An item is EITHER a plain string (text message) OR an object {text?, path?, as_file?} — set `path` to ' +
        "attach ONE file (RELATIVE to this topic's bound folder): supported photos render inline, .gif uses " +
        'sendAnimation, and .mp4 uses sendVideo (.mov/.webm render as a GIF, so remux to .mp4 first); everything ' +
        'else is a document, and `text` ' +
        'becomes the media caption (trimmed to 1024 chars — send long prose as its OWN text-only item). ' +
        '`as_file:true` forces the document override for that attachment. Markdown (links, bold) works on text ' +
        'items; an over-long text item is split automatically. Note: this does NOT replace your normal single ' +
        'reply — only reach for it when multiple discrete messages are wanted, and do not also print the same ' +
        'content as your reply text (that would post it twice).',
      inputSchema: sendMessageInput,
    },
    async (args, extra) => {
      const signal = requestSignal
        ? AbortSignal.any([extra.signal, requestSignal])
        : extra.signal;
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      if (signal.aborted) throw getAbortError(signal);

      // Map the wire shape (snake-case `as_file`) to the service's item type.
      const items: DiscreteMessageItem[] = args.messages.map((item) =>
        typeof item === 'string'
          ? item
          : {
              ...(item.text !== undefined ? { text: item.text } : {}),
              ...(item.path !== undefined ? { path: item.path } : {}),
              ...(item.as_file !== undefined ? { asFile: item.as_file } : {}),
            },
      );

      const result = await deps.sendMessagesToThread(resolved.threadKey, {
        messages: items,
        ...(scope.kind === 'dir' ? { authorizedWorkDir: scope.directory } : {}),
        signal,
      });
      if (result.ok) return textResult(result.summary);
      return 'kind' in result && result.kind === 'deliveryUnknown'
        ? deliveryUnknownResult(result.error)
        : errorResult(result.error);
    },
  );
}

/**
 * @description Register the agent→bot `compact_conversation` tool (F1). Like
 * every tool here it resolves the target thread from `scope` first (scope
 * isolation — the agent can only compact ITS OWN topic's session). The actual
 * arm + deferred compaction lives in `deps.compactConversation`; this surface
 * only routes the resolved thread and relays the status text.
 */
function registerCompactConversationTool(server: ToolRegistrar, deps: SchedulerMcpDeps, scope: SchedulerScope): void {
  server.registerTool(
    'compact_conversation',
    {
      title: 'Compact this conversation',
      description:
        'Compact (summarize) THIS topic\'s own session context so the conversation can continue in a ' +
        'smaller window. Call this ONLY when the user EXPLICITLY asks to compact / shrink / summarize the ' +
        'context (e.g. "compact our conversation", "сожми контекст") — never on your own judgement, and ' +
        'never to "clean up". It does NOT compact mid-turn: it arms compaction and returns immediately; the ' +
        'bot runs the real compaction the moment this turn finishes. There is nothing for you to do ' +
        'afterwards — do not call it again for the same request.',
      inputSchema: createStrictToolInput({
        reason: z
          .string()
          .optional()
          .describe('Optional short note on why the user asked to compact (for the bot log only).'),
      }),
    },
    async (args) => {
      // A surviving session may call this before boot re-attached it.
      await deps.whenSessionsRestored();
      const resolved = resolveTargetThreadKey(scope, undefined, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      if (args.reason) console.log(`[compact_conversation] ${resolved.threadKey}: ${args.reason}`);
      const outcome = deps.compactConversation(resolved.threadKey);
      return outcome.ok ? textResult(outcome.message) : errorResult(outcome.message);
    },
  );
}

/** The most items one `todo_update` call may name, and the longest `order` — a stand-up list is a few items (D1). */
const todoUpdateMaxItems = 30;
const todoOrderMaxIds = 100;

const todoItemPatchSchema = createStrictToolInput({
  id: z
    .string()
    .trim()
    .regex(/^t\d+$/)
    .optional()
    .describe('The item to change ("t3", from your list). Leave it out to ADD a new item.'),
  title: z
    .string()
    .max(todoTitleMaxLength)
    .optional()
    .describe('Task-sized and concrete: name the area (files, tests). Required for a new item.'),
  status: z
    .enum(todoStatuses)
    .optional()
    .describe('queued (default for a new item) · inWork (you are on it) · done · dropped (will not be done — the way to remove an item).'),
  note: z.string().max(todoNoteMaxLength).optional().describe('A short note other agents should know (what is left, a blocker). An empty note removes it.'),
  ref: z
    .string()
    .max(todoRefMaxLength)
    .optional()
    .describe('A tracker key / id / link the item stands for, e.g. the bug ticket you just created. An empty ref removes it.'),
  position: z.enum(todoPositions).optional().describe('Put the item first or last among the open ones (a new item goes last by default).'),
});

const todoUpdateShape = {
  items: z
    .preprocess(coerceJsonArrayArg, z.array(todoItemPatchSchema).max(todoUpdateMaxItems))
    .optional()
    .describe('Items to add (no id) or change (id + only the fields that change). Nothing disappears by omission: set status dropped to remove one.'),
  order: z
    .preprocess(coerceJsonArrayArg, z.array(z.string().trim().min(1)).max(todoOrderMaxIds))
    .optional()
    .describe('Open item ids in the wanted queue order; the ones left out keep their relative order after them.'),
  threadKey: threadKeyArgSchema,
};
const todoUpdateInput = createStrictToolInput(todoUpdateShape);

const todoReadShape = {
  scope: z
    .enum(todoReadScopes)
    .optional()
    .describe('own (default): your list · project: the whole board of the project\'s other topics (what they work on now).'),
  includeHistory: z.boolean().optional().describe(`With scope own: also list older closed items (done / dropped), up to ${todoHistoryMaxItems}.`),
  threadKey: threadKeyArgSchema,
};
const todoReadInput = createStrictToolInput(todoReadShape);

/**
 * @description Register `todo_update` / `todo_read` (shared todo registry D3–D5): the published list of the
 * conversation the token names — never another one; the rules live in `todos/registry.ts`.
 */
function registerTodoTools(
  server: ToolRegistrar,
  deps: SchedulerMcpDeps,
  todos: NonNullable<SchedulerMcpDeps['todos']>,
  scope: SchedulerScope,
): void {
  server.registerTool(
    'todo_update',
    {
      title: 'Update your published todo list',
      description:
        'Publish what you are doing so the agents in the project\'s other topics see it and never fix the same thing ' +
        'unknowingly (and you see theirs). Stand-up level: a few task-sized items, never micro-steps (those stay in ' +
        'your own todo tool). Add an item as inWork BEFORE you start any task, self-found fixes included (a failing ' +
        'test, a leak), naming the area concretely; mark it done / dropped as soon as it is. An UPSERT: an item ' +
        'without id is new; with an id only the fields given change. A call with no items and no order confirms the ' +
        'list is still accurate. The result is your list and what changed in the project\'s other topics since you last saw them.',
      inputSchema: todoUpdateInput,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      const outcome = await todos.update(resolved.threadKey, {
        ...(args.items === undefined ? {} : { items: args.items }),
        ...(args.order === undefined ? {} : { order: args.order }),
      });
      return outcome.ok ? textResult(outcome.message) : errorResult(outcome.error);
    },
  );

  server.registerTool(
    'todo_read',
    {
      title: 'Read your published todo list',
      description:
        'Your published todo list (in work, the queue in order, recently done) and what changed in the project\'s other ' +
        'topics since you last saw them; with includeHistory also your older closed items; with scope project the whole board ' +
        'of the other topics.',
      inputSchema: todoReadInput,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      const outcome = await todos.read(resolved.threadKey, {
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.includeHistory === undefined ? {} : { includeHistory: args.includeHistory }),
      });
      return outcome.ok ? textResult(outcome.message) : errorResult(outcome.error);
    },
  );
}

/**
 * `jira_get_attachment`: the issue is the conversation this session's token names — never an argument —
 * so a file of any other issue cannot be asked for, however the id got into the agent's head.
 */
function registerJiraAttachmentTool(
  server: ToolRegistrar,
  deps: SchedulerMcpDeps,
  fetchJiraAttachment: NonNullable<SchedulerMcpDeps['fetchJiraAttachment']>,
  scope: SchedulerScope,
): void {
  server.registerTool(
    'jira_get_attachment',
    {
      title: 'Get a Jira attachment',
      description:
        'Download the ORIGINAL of one attachment of THIS issue and get the local path it was saved at. The ' +
        'attachment ids are in the issue\'s attachments list and in placeholders like ' +
        '"[image: shot.png — attachment 10234]". There is no size limit. What you do with the file is up to ' +
        'you: view an image with your file-reading tool, take frames or the audio of a video with ffmpeg ' +
        '(when it is on your PATH). Only this issue\'s own attachments can be fetched.',
      inputSchema: createStrictToolInput({
        attachmentId: z.string().min(1).describe('The attachment id, e.g. "10234" from "[image: shot.png — attachment 10234]".'),
      }),
    },
    async (args) => {
      await deps.whenSessionsRestored();
      const resolved = resolveTargetThreadKey(scope, undefined, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);
      const outcome = await fetchJiraAttachment(resolved.threadKey, args.attachmentId);
      return outcome.ok ? textResult(outcome.message) : errorResult(outcome.error);
    },
  );
}

/**
 * @description Whether a token's scope covers a conversation (serialized key): a
 * `thread:` token covers exactly its thread, a `dir:` token every thread bound to
 * its directory. Unlike {@link resolveTargetThreadKey} it never picks a target —
 * the request id already names the conversation, this only checks the caller may
 * act on it.
 */
export function checkIsConversationInScope(
  scope: SchedulerScope,
  conversationKey: string,
  getThreadsForDirectory: (directory: string) => string[],
): boolean {
  if (scope.kind === 'thread') return scope.threadKey === conversationKey;
  return getThreadsForDirectory(scope.directory).includes(conversationKey);
}

/** The most comment ids one answer may name in `replyToCommentIds`. */
export const answerReplyToCommentIdsMaxCount = 10;

const answerRequestShape = {
  requestId: z
    .string()
    .trim()
    .min(1)
    .describe('The id from the "[Request <id> · from: …]" header of the message you are answering.'),
  kind: z
    .enum(['progress', 'question', 'final'])
    .describe(
      '"final" — the full result, at the end of your turn (closes the request); "question" — you need the ' +
        'requester before you can go on (closes the request; their reply is a new request); "progress" — an ' +
        'interim note (the request stays open).',
    ),
  body: z
    .string()
    .trim()
    .min(1)
    .max(answerBodyMaxLength)
    .describe(`The answer itself, in Markdown. The requester does not see your other output. ${answerStyleInstruction}`),
};
const answerRequestInput = createStrictToolInput(answerRequestShape);

/** `answer_request` in a Jira session: the same, and the comments the answer replies to. */
const jiraAnswerRequestShape = {
  ...answerRequestShape,
  replyToCommentIds: z
    .array(z.string().regex(/^\d+$/))
    .max(answerReplyToCommentIdsMaxCount)
    .optional()
    .describe(
      'Ids of the issue\'s comments this answer replies to, e.g. ["10240"]. The bot mentions each comment\'s ' +
        'author at the top of your answer so they are notified. Only comments you were shown in this conversation count.',
    ),
};
const jiraAnswerRequestInput = createStrictToolInput(jiraAnswerRequestShape);

/**
 * @description Register `answer_request` (request/answer core S3): the agent's
 * answer to a request, delivered to the surface the request came from. The
 * scope check is passed in so a session can only answer requests of the
 * conversations its token covers; an id outside it reads as unknown.
 */
function registerAnswerRequestTool(server: ToolRegistrar, deps: SchedulerMcpDeps, scope: SchedulerScope, platform: PlatformId | null): void {
  const definition = {
    title: 'Answer a request',
    description:
      'Send your answer to a request — a message that carries a "[Request <id> · from: …]" header — to ' +
      'the person who made it, on the surface it came from. The requester may not see your plain text, so ' +
      'anything they must read goes through this tool. Call it with kind "final" and the full result at the ' +
      'end of your turn; "question" when you need them before you can continue; "progress" for an interim ' +
      'note. You may call it several times for one request; only "question" and "final" close it. Do not ' +
      'restate the answer in plain text afterwards: where your plain text is relayed as well, a recap shows twice. ' +
      answerStyleInstruction,
  };
  const handle = async (args: { requestId: string; kind: RequestAnswerKind; body: string; replyToCommentIds?: string[] }) => {
    const outcome = await deps.answerRequest({
      requestId: args.requestId,
      kind: args.kind,
      body: args.body,
      ...(args.replyToCommentIds === undefined ? {} : { replyToCommentIds: args.replyToCommentIds }),
      checkIsConversationInScope: (conversationKey) =>
        checkIsConversationInScope(scope, conversationKey, deps.getThreadsForDirectory),
    });
    return outcome.ok ? textResult(outcome.message) : errorResult(outcome.error);
  };
  // The reply field names a tracker's comments: only a Jira session is offered it.
  if (platform === 'jira') server.registerTool('answer_request', { ...definition, inputSchema: jiraAnswerRequestInput }, handle);
  else server.registerTool('answer_request', { ...definition, inputSchema: answerRequestInput }, handle);
}

// ─── server factory ──────────────────────────────────────────────────

type SchedulerMcpCancellationTombstone =
  | { kind: 'pendingCancellation'; expiresAt: number; reason?: string }
  | { kind: 'recentlyCompleted'; expiresAt: number };

interface SchedulerMcpRegisteredRequest {
  controller: AbortController;
  markTerminal: () => void;
  unregister: () => void;
}

interface SchedulerMcpCancellationLifecycle {
  registerRequest: (clientIdentity: string, requestId: RequestId) => SchedulerMcpRegisteredRequest;
  cancelRequest: (clientIdentity: string, requestId: RequestId, reason: string | undefined) => void;
}

/** Deterministic seams for lifecycle-cache expiry and bound verification. */
export interface SchedulerMcpCancellationLifecycleOptions {
  getNowMs?: () => number;
  maxTombstones?: number;
}

/**
 * @description Correlate stateless MCP requests with cancellation notifications.
 * Active controllers are isolated by verified token + validated client identity
 * + typed JSON-RPC id. One bounded TTL cache stores mutually-exclusive terminal
 * states for inactive keys:
 *
 * - `pendingCancellation` aborts the first matching registration, then is consumed.
 * - `recentlyCompleted` ignores only an unmatched late cancellation while no
 *   matching request is active, preventing it from becoming pending poison.
 *
 * Active controllers always take precedence over tombstones because generations
 * that reuse one client identity and request id are otherwise indistinguishable.
 *
 * The clock and cache limit are injectable only at construction so expiry and
 * oldest-entry eviction stay deterministic in tests; production uses the fixed
 * exported defaults.
 */
export function createSchedulerMcpCancellationLifecycle(
  options: SchedulerMcpCancellationLifecycleOptions = {},
): SchedulerMcpCancellationLifecycle {
  const getNowMs = options.getNowMs ?? Date.now;
  const maxTombstones = options.maxTombstones ?? schedulerMcpPendingCancellationMax;
  if (!Number.isSafeInteger(maxTombstones) || maxTombstones <= 0) {
    throw new RangeError('maxTombstones must be a positive safe integer');
  }
  const requestAbortControllers = new Map<string, Set<AbortController>>();
  const tombstones = new Map<string, SchedulerMcpCancellationTombstone>();

  function getRequestCorrelationKey(clientIdentity: string, requestId: RequestId): string {
    return JSON.stringify([clientIdentity, typeof requestId, requestId]);
  }

  function pruneTombstones(now: number): void {
    for (const [correlationKey, tombstone] of tombstones) {
      if (tombstone.expiresAt <= now) tombstones.delete(correlationKey);
    }
  }

  function setTombstone(
    correlationKey: string,
    tombstone: SchedulerMcpCancellationTombstone,
    now: number,
  ): void {
    pruneTombstones(now);
    tombstones.delete(correlationKey);
    while (tombstones.size >= maxTombstones) {
      const oldestKey = tombstones.keys().next().value;
      if (oldestKey === undefined) break;
      tombstones.delete(oldestKey);
    }
    tombstones.set(correlationKey, tombstone);
  }

  function registerRequest(clientIdentity: string, requestId: RequestId): SchedulerMcpRegisteredRequest {
    const correlationKey = getRequestCorrelationKey(clientIdentity, requestId);
    const controller = new AbortController();
    const controllers = requestAbortControllers.get(correlationKey) ?? new Set();
    controllers.add(controller);
    requestAbortControllers.set(correlationKey, controllers);

    const now = getNowMs();
    pruneTombstones(now);
    const tombstone = tombstones.get(correlationKey);
    if (tombstone?.kind === 'pendingCancellation') {
      tombstones.delete(correlationKey);
      controller.abort(tombstone.reason);
    }

    let isTerminal = false;

    return {
      controller,
      markTerminal: () => {
        if (isTerminal) return;
        isTerminal = true;
        const completedAt = getNowMs();
        setTombstone(
          correlationKey,
          {
            kind: 'recentlyCompleted',
            expiresAt: completedAt + schedulerMcpPendingCancellationTtlMs,
          },
          completedAt,
        );
      },
      unregister: () => {
        controllers.delete(controller);
        if (controllers.size === 0) requestAbortControllers.delete(correlationKey);
      },
    };
  }

  function cancelRequest(
    clientIdentity: string,
    requestId: RequestId,
    reason: string | undefined,
  ): void {
    const correlationKey = getRequestCorrelationKey(clientIdentity, requestId);
    const now = getNowMs();
    pruneTombstones(now);

    const controllers = requestAbortControllers.get(correlationKey);
    if (controllers && controllers.size > 0) {
      for (const controller of controllers) controller.abort(reason);
      return;
    }

    if (tombstones.get(correlationKey)?.kind === 'recentlyCompleted') return;

    setTombstone(
      correlationKey,
      {
        kind: 'pendingCancellation',
        expiresAt: now + schedulerMcpPendingCancellationTtlMs,
        ...(reason !== undefined ? { reason } : {}),
      },
      now,
    );
  }

  return { registerRequest, cancelRequest };
}

/**
 * @description Whether the bot's skills are on for the conversations a scope reaches (`utils/botSkills.ts`). A `thread:`
 * scope is one conversation. A `dir:` scope is the OpenCode registration of a folder — ONE per folder and server run, read
 * at connect — so it serves the folder's OpenCode topics alone (a Claude topic bound to the same folder has its own
 * `thread:` scope) and keeps the manager hint while any of them has the skills on; a folder with no OpenCode topic gets the
 * instance value.
 */
function checkIsBotSkillsEnabledForScope(deps: SchedulerMcpDeps, scope: SchedulerScope): boolean {
  const threadKeys = scope.kind === 'thread'
    ? [scope.threadKey]
    : deps.getThreadsForDirectory(scope.directory).filter((threadKey) => deps.getThreadAdapterName(threadKey) === openCodeAdapterName);
  const keys = threadKeys.map(tryKeyFromString).filter((key) => key !== null);
  return keys.length === 0 ? checkIsBotSkillsEnabled(null) : keys.some((key) => checkIsBotSkillsEnabled(key));
}

/**
 * @description Build a fresh {@link McpServer} for one request, registering the
 * scope-bound scheduler tools plus the `send_file_to_user` tool. The SDK binds one server
 * per transport per connection, so a new instance is built (and closed) per
 * request in the stateless flow.
 */
function buildRequestServer(
  deps: SchedulerMcpDeps,
  scope: SchedulerScope,
  requestSignal: AbortSignal | undefined,
): McpServer {
  const platform = getSchedulerScopePlatform(scope);
  const server = new McpServer(
    { name: mcpServerName, version: mcpServerVersion },
    { instructions: buildMcpServerInstructions(platform, getOptionalBotTools(deps), checkIsBotSkillsEnabledForScope(deps, scope)) },
  );
  registerBotTools(server, deps, scope, platform, requestSignal);
  return server;
}

/** The tools a session of `platform` gets — the one list the request path serves and the digest records. */
function registerBotTools(
  server: ToolRegistrar,
  deps: SchedulerMcpDeps,
  scope: SchedulerScope,
  platform: PlatformId | null,
  requestSignal: AbortSignal | undefined,
): void {
  // These deliver into a Telegram topic; for another platform's key they would throw (D18).
  if (platform === 'telegram') {
    registerSchedulerTools(server, deps, scope);
    registerFileSendTool(server, deps, scope, requestSignal);
    registerMessageSendTool(server, deps, scope, requestSignal);
  }
  // The original files of the conversation's own issue: only a Jira session, and only with the connector loaded.
  if (platform === 'jira' && deps.fetchJiraAttachment) registerJiraAttachmentTool(server, deps, deps.fetchJiraAttachment, scope);
  registerCompactConversationTool(server, deps, scope);
  // A published list belongs to a conversation of a platform that has one (D54): a topic or a Jira issue.
  if (deps.todos && (platform === 'telegram' || platform === 'jira')) registerTodoTools(server, deps, deps.todos, scope);
  registerAnswerRequestTool(server, deps, scope, platform);
  if (deps.listClaudeProfiles) registerClaudeProfilesTool(server, deps.listClaudeProfiles);
}

/** The first line of the `claude_profiles` answer: the pick with how to launch it and why, or that nothing is usable and when something is. */
function buildClaudeProfilesVerdict(report: ClaudeProfilesReport, currentProfile: string | null): string {
  const outcome = describeClaudeLaunchOutcome(report, currentProfile);
  if (report.recommended === null) return outcome;
  const dir = report.profiles.find((profile) => profile.name === report.recommended)?.configDir ?? null;
  const launch = dir === null ? 'default profile, set no CLAUDE_CONFIG_DIR' : `CLAUDE_CONFIG_DIR=${dir}`;
  return `recommended: ${report.recommended} → ${launch} (${outcome})`;
}

/**
 * `claude_profiles`: which Claude account a child process should run on. Reads the bot's per-profile usage
 * cache (refreshed on demand by the port); touches no conversation, so it needs no scope resolution. The
 * answer is the report as JSON with a one-line verdict first, so an agent can act on it without parsing.
 */
function registerClaudeProfilesTool(server: ToolRegistrar, listClaudeProfiles: NonNullable<SchedulerMcpDeps['listClaudeProfiles']>): void {
  server.registerTool(
    'claude_profiles',
    {
      title: 'Claude accounts and their usage',
      description:
        'The Claude account profiles signed in on this host, each with its usage windows — session (5 h), weekly ' +
        '(all models) and weekly Fable — as percent used + reset instant, and `recommended`: the account a process of ' +
        'the model you pass should run on. A NEW agent (omit `currentProfile`) goes to the usable account whose weekly ' +
        'limit resets SOONEST — what burns soonest is spent first; an account whose five-hour window is at 90 % or more ' +
        'is skipped until it resets. A session you RESUME (pass `currentProfile`, the profile it last ran on) stays on ' +
        'it unless that account is signed out, limited or at 100 % on a window the model drains; when it broke off on a ' +
        'usage limit pass `isStoppedByLimit: true` and resume the SAME session at once on the answer. The session ' +
        'window and the shared weekly window bound every model, Fable included; Fable also drains its own weekly ' +
        'window; signed-out, limited and operator-switched-off accounts are skipped. An account with `billing: "api"` ' +
        'pays per request from a Claude Console balance: it has no windows and is NEVER picked for a new agent — do ' +
        'not launch a child on it unless the operator asked you to. `recommended: null` means nothing is usable now: ' +
        '`nextAvailable` names the account and instant that frees up first — schedule ONE resume at that time instead ' +
        'of retrying; when `nextAvailable` is null too, tell the user and retry once in about 30 minutes. Call it BEFORE launching or resuming a child `claude` and start the child with ' +
        'CLAUDE_CONFIG_DIR=<configDir> in its environment — configDir null means the default profile: set nothing. ' +
        'Without the variable the child inherits the account of this very session.',
      inputSchema: createStrictToolInput({
        model: z
          .string()
          .max(64)
          .optional()
          .describe('The model the child will run (e.g. "fable", "opus", "sonnet"); decides whether the Fable weekly window counts besides the shared ones. Omit for the shared windows.'),
        currentProfile: z
          .string()
          .max(claudeProfileNameMaxLength)
          .optional()
          .describe('The profile the session you RESUME last ran on (the `name` you recorded at its launch); omit for a new agent.'),
        isStoppedByLimit: z
          .boolean()
          .optional()
          .describe('The resumed session broke off on a usage limit of `currentProfile`: that account is left out of this answer. Needs `currentProfile`.'),
      }),
    },
    async (args) => {
      const currentProfile = args.currentProfile?.trim() || null;
      if (args.isStoppedByLimit === true && currentProfile === null) {
        return errorResult('isStoppedByLimit needs currentProfile — the profile the session that hit the limit last ran on.');
      }
      const report = await listClaudeProfiles({ model: args.model?.trim() || null, currentProfile, isStoppedByLimit: args.isStoppedByLimit === true });
      return textResult(`${buildClaudeProfilesVerdict(report, currentProfile)}\n${JSON.stringify(report, null, 1)}`);
    },
  );
}

/** Read the whole request body into a string (the SDK wants the parsed JSON body). */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON-RPC error response (used for the 401 / not-found paths the SDK doesn't reach). */
function writeJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * @description Create the bot-owned scheduler MCP server. Returns a handle with
 * `start`/`stop` and the bound `port`. The HTTP listener is plain `node:http`
 * (no web framework) on `127.0.0.1`; each request verifies the bearer token,
 * builds a fresh stateless transport + `McpServer`, and tears them down when the
 * response finishes. Invalid/missing tokens get a JSON-RPC 401 without touching
 * any tool.
 */
export function createSchedulerMcpServer(deps: SchedulerMcpDeps): SchedulerMcpHandle {
  const requestedPort = deps.port ?? getSchedulerMcpPort();
  let boundPort = requestedPort;
  let httpServer: Server | null = null;
  const sockets = new Set<Socket>();
  const cancellationLifecycle = createSchedulerMcpCancellationLifecycle();

  function getClientIdentity(req: IncomingMessage, verifiedToken: string): string {
    let clientId = req.headers[schedulerMcpClientIdHeader];
    if (clientId === undefined && req.headers[legacySchedulerMcpClientIdHeader] !== undefined) {
      clientId = req.headers[legacySchedulerMcpClientIdHeader];
      warnLegacyNameOnce(
        'mcp-client-id-header',
        `${formatDeprecation(legacySchedulerMcpClientIdHeader, schedulerMcpClientIdHeader)} — ` +
          `an agent session launched before the rename still sends it; a restarted session sends the new one`,
      );
    }
    if (
      typeof clientId === 'string' &&
      clientId.length > 0 &&
      clientId.length <= schedulerMcpClientIdMaxLength &&
      schedulerMcpClientIdPattern.test(clientId)
    ) {
      return `token:${verifiedToken}:client:${clientId}`;
    }
    return `token:${verifiedToken}`;
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = await deps.getSecret();
    const token = extractBearerToken(req.headers.authorization);
    const scope = token ? verifySchedulerMcpToken(secret, token) : null;
    if (!scope || token === null) {
      // -32001 (SDK's "unauthorized" convention) + HTTP 401, no tool touched.
      writeJsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid scheduler token');
      return;
    }
    if (req.method === 'GET') {
      // This server NEVER initiates a message: it is stateless, has no event
      // store, and every transport is built and closed around ONE request. The
      // spec's answer for exactly that case is 405, and the SDK client treats it
      // as expected and simply does not open a stream.
      //
      // Answering the SDK's way instead (200 + `text/event-stream`) hands the
      // client a standalone SSE stream that carries nothing and only ever ends
      // one way: the bot restarts, the socket dies, and the client burns its
      // reconnect budget against a port that is not listening yet. Hot mode
      // rebuilds on every code change, so that is a frequent event — and a
      // client that gives up latches the whole server `failed`, stranding the
      // bot's own tools in a session that was deliberately built to survive the
      // restart. Refusing the GET removes the thing that breaks.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method Not Allowed: this endpoint does not offer an SSE stream' },
          id: null,
        }),
      );
      return;
    }

    const clientIdentity = getClientIdentity(req, token);

    const bodyText = await readRequestBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      writeJsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
      return;
    }

    const cancellation = CancelledNotificationSchema.safeParse(parsedBody);
    if (cancellation.success && cancellation.data.params.requestId !== undefined) {
      cancellationLifecycle.cancelRequest(
        clientIdentity,
        cancellation.data.params.requestId,
        cancellation.data.params.reason,
      );
    }

    const request = JSONRPCRequestSchema.safeParse(parsedBody);
    const registeredRequest = request.success
      ? cancellationLifecycle.registerRequest(clientIdentity, request.data.id)
      : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildRequestServer(deps, scope, registeredRequest?.controller.signal);
    // Stateless: the transport + server live only for this request; close both
    // when the response finishes so no connection state lingers.
    const markRequestTerminal = (): void => registeredRequest?.markTerminal();
    res.once('finish', markRequestTerminal);
    res.once('close', () => {
      res.off('finish', markRequestTerminal);
      registeredRequest?.markTerminal();
      registeredRequest?.controller.abort();
      registeredRequest?.unregister();
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // The SDK refuses a call's input before any tool code runs, so the refusal is reported from inside the handling.
    const toolCall = CallToolRequestSchema.safeParse(parsedBody);
    const handleRequest = (): Promise<void> => transport.handleRequest(req, res, parsedBody);
    await (toolCall.success && deps.logDiagnostic
      ? runWithRefusalLogging({ toolName: toolCall.data.params.name, log: deps.logDiagnostic }, handleRequest)
      : handleRequest());
  }

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.url && req.url.split('?')[0] === schedulerMcpPath) {
          handleMcpRequest(req, res).catch((error) => {
            console.error('[scheduler-mcp] request handling failed:', error);
            if (!res.headersSent) {
              writeJsonRpcError(res, 500, -32603, 'Internal error');
            } else {
              res.end();
            }
          });
          return;
        }
        writeJsonRpcError(res, 404, -32601, 'Not found');
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });

      const portBindRetry = deps.portBindRetry ?? { count: schedulerMcpBindRetryCount, delayMs: schedulerMcpBindRetryDelayMs };
      let retryCount = 0;
      let isFallenBack = false;

      const handleListening = (): void => {
        const address = server.address();
        if (address && typeof address === 'object') boundPort = address.port;
        httpServer = server;
        server.off('error', handleError);
        resolve();
      };

      const handleError = (error: NodeJS.ErrnoException): void => {
        // A non-zero requested port already in use (a persisted port a prior
        // generation still holds, or a sibling instance) must not wedge boot: it
        // is retried (`portBindRetry`), then bound on an ephemeral port ONCE.
        // Port 0 can never hit EADDRINUSE.
        if (error.code === 'EADDRINUSE' && requestedPort !== 0 && !isFallenBack) {
          // Track the server before the retry so a stop() in the retry window
          // still closes the eventually-bound listener (no orphan).
          httpServer = server;
          if (retryCount < portBindRetry.count) {
            if (retryCount === 0) {
              console.warn(
                `[scheduler-mcp] requested port ${requestedPort} is in use; retrying for up to ${portBindRetry.count * portBindRetry.delayMs} ms`,
              );
            }
            retryCount += 1;
            setTimeout(() => {
              // A stop() during the wait already settled this server: binding now
              // would leave a listener nobody closes.
              if (httpServer !== server) {
                server.off('listening', handleListening);
                reject(new Error(`stopped while waiting for port ${requestedPort}`));
                return;
              }
              server.listen(requestedPort, '127.0.0.1');
            }, portBindRetry.delayMs);
            return;
          }
          isFallenBack = true;
          console.error(
            `[scheduler-mcp] requested port ${requestedPort} is still in use after ${portBindRetry.count * portBindRetry.delayMs} ms; ` +
            `falling back to an ephemeral port. A Claude session that was already running keeps the MCP address of its launch ` +
            `(127.0.0.1:${requestedPort}) and loses the bot's tools until it is restarted.`,
          );
          server.listen(0, '127.0.0.1');
          return;
        }
        server.off('listening', handleListening);
        reject(error);
      };

      server.on('listening', handleListening);
      server.on('error', handleError);
      server.listen(requestedPort, '127.0.0.1');
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
      // Streamable HTTP clients may retain an idle keep-alive connection after
      // their request completes; server.close() otherwise waits for it forever.
      for (const socket of sockets) socket.destroy();
    });
  }

  return {
    start,
    stop,
    getToolDigest: (platform, isBotSkillsEnabled) => getBotMcpToolDigest(deps, platform, isBotSkillsEnabled),
    get port() {
      return boundPort;
    },
  };
}
