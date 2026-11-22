import { EventEmitter } from 'events';
import type { Locale } from './i18n';
import type { OpenCodeAuthMethod } from './utils/openCodeAuthLogin';
import type { McpHealOutcome } from './utils/claudeMcpHeal';
import type { SessionKey } from './sessionKey';
import type { OutboundHints } from './platform/outbound';
import type { FallbackChainEntry } from './utils/fallbackChain';
import type { ClaudeBackgroundTask } from './utils/claudeStreamJson';
import type { ScheduledJob } from './utils/claudeScheduledJobs';
import type { LostWork } from './utils/lostWork';
import type { BackgroundWorkSignal } from './utils/workingSignals';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @description One conversational turn (a single user OR assistant message that
 * carries renderable text) of a resumable session, used to build the short
 * "↩️ Resumed — last N messages" context block shown on resume instead of
 * flooding the topic with the whole restored transcript. Tool-call / step /
 * meta records are NOT turns. See `src/resumeContext.ts`.
 */
export interface RecentTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * @description Per-thread "seen" watermark — how far the LIVE relay had shown
 * the agent's persistent record at the last turn end. Persisted in `state.json`
 * on the agent row (next to the session ids) so a bot restart can tell how much
 * output the agent produced WHILE the bot was down (and recover it via the
 * reattach recap) instead of silently losing it.
 *
 * Backend representations live side by side (only one is set per row, mirroring
 * `claudeSessionId` / `opencodeSessionId`):
 * - OpenCode → the last completed assistant message `id` of the turn.
 * - Claude   → the transcript `.jsonl` byte offset (file size) at turn end.
 *
 * `sessionId` scopes the watermark to the session it was taken against: it
 * survives `/new` (which keeps the agent row) and `/sessions` resume (which
 * merges onto it), so on a later read the recap MUST verify the stored id still
 * matches the session being recapped — otherwise an old session's offset/id
 * cross-applies to a different transcript and yields a garbage count. A
 * mismatch is treated as "watermark unknown" (the no-count fallback).
 */
export interface SeenWatermark {
  sessionId: string;
  opencodeMessageId?: string;
  claudeTranscriptOffset?: number;
}

/**
 * @description Adapter-side callback that advances the per-thread
 * {@link SeenWatermark} at turn end. Injected at boot via the same DI seam as
 * {@link DisplayPrefsReader} (`createAdapter.registerSeenWatermarkWriter`),
 * wired in `bot.ts` to `state.setSeenWatermark`. Inert (no-op) until registered,
 * so an embedded / test caller that never wires it simply skips watermarking.
 */
export type SeenWatermarkWriter = (key: SessionKey, watermark: SeenWatermark) => void;

/**
 * @description Per-thread json-stream stdout tail position — how far the bot
 * has consumed the EXTERNAL claude process's `stdout.jsonl` (plan
 * 2026-07-05-jsonstream-restart-isolation). Persisted in `state.json` on the
 * agent row so a restarted bot resumes tailing exactly where it left off and
 * replays only what was produced during the downtime. `offsetBytes` always
 * lands on a LINE BOUNDARY (see `getStdoutLineBoundaryOffset`), so the resumed
 * tail never starts on a torn JSON line. `sessionId` scopes the offset to the
 * session's own stdout file — a mismatch on adopt means the file belongs to a
 * different run and the tail seeds to the current EOF instead.
 */
export interface JsonStreamTailOffset {
  sessionId: string;
  offsetBytes: number;
  /**
   * The CLI's background-task list as of `offsetBytes` (`task_id`s of the last
   * `background_tasks_changed` frame before it). Frames before the offset are
   * not replayed on adopt, so the list rides along with the offset; a row
   * written before the list was tracked has none, which reads as "no tasks".
   */
  backgroundTaskIds?: string[];
  /** The CLI version the process reported on its `init` (`claude_code_version`), restored on adopt for the auto-stop gate (L-D10). */
  claudeCodeVersion?: string;
  /**
   * Whether a turn was in flight as of `offsetBytes` — set when a user turn is
   * written, cleared by its `result`. Restored on adopt so a process in a long,
   * silent tool call across a restart (no frame after the offset to rebuild it
   * from) still reads as working (L-D2) and is never stopped mid-turn.
   */
  isTurnInFlight?: boolean;
  /**
   * The tool calls in flight as of `offsetBytes` (`tool_use` ids whose
   * `tool_result` had not returned). Restored on adopt with the flag above:
   * an outstanding tool is what vetoes the busy-idle watchdog, so without it a
   * restored turn in a long, silent tool call would be declared idle after the
   * watchdog's silence window and stopped mid-call after all.
   */
  outstandingToolUseIds?: string[];
  /**
   * The background tasks as of `offsetBytes` with the descriptions the agent gave them — written beside
   * `backgroundTaskIds` (which an older reader still reads) while any runs; the lost-work note names them.
   */
  backgroundTasks?: ClaudeBackgroundTask[];
  /**
   * When a background task's notification announced the turn it starts, while that turn has not shown yet
   * (`utils/jsonStreamPendingWork.ts`): a reload inside that sub-second gap must not read the process as idle.
   */
  notificationTurnPendingSinceMs?: number;
  /** When the conversation's last turn ended, while background tasks or scheduled jobs are pending: the hold counts from it. */
  lastTurnEndedAtMs?: number;
  /** The session-only `CronCreate` jobs the process holds (`utils/claudeScheduledJobs.ts`); absent when none. */
  scheduledJobs?: ScheduledJob[];
  /** An account switch the user picked while the process worked, still waiting for its turn to end: a reload keeps it. */
  isConfigDirSwitchPending?: boolean;
}

/**
 * @description Adapter-side callback that persists the {@link JsonStreamTailOffset}
 * as the json-stream tail consumes stdout lines. Same DI seam and inert-until-
 * registered semantics as {@link SeenWatermarkWriter}; wired in `bot.ts` to
 * `state.setJsonStreamTail`.
 */
export type JsonStreamTailWriter = (key: SessionKey, tail: JsonStreamTailOffset) => void;

/**
 * @description Result of {@link AgentAdapter.getReattachRecap} — the data the
 * bot needs to assemble the post-restart recap for one thread.
 *
 * - `missedCount` — number of AGENT (assistant) messages produced during the
 *   downtime, computed from the persisted {@link SeenWatermark}. `0` when none
 *   were missed (a clean hot reload) → the bot posts nothing.
 * - `turns` — the last few conversational turns (already capped), rendered as
 *   the recap body regardless of `missedCount` (the count line conveys scale).
 * - `isWatermarkKnown` — whether the watermark was trusted and located in the
 *   record. `false` (first run after ship, pruned transcript, crash before any
 *   watermark) → the bot uses the no-number fallback header.
 * - `isActive` — best-effort "the agent is still working right now" signal,
 *   read cheaply from in-memory state; drives the trailing status line.
 * - `headWatermark` — the watermark value meaning "everything currently in the
 *   session's record is accounted for" (the session's CURRENT tail: Claude →
 *   transcript byte size, OpenCode → latest assistant message id). The bot
 *   persists this AFTER computing the recap — whether or not a recap posted —
 *   so the same gap can never re-report on the next reattach (idempotency).
 *   Absent when the record was unreadable (head unknown → the bot skips the
 *   advance and retries on the next reattach).
 */
export interface ReattachRecap {
  missedCount: number;
  turns: RecentTurn[];
  isWatermarkKnown: boolean;
  isActive: boolean;
  headWatermark?: SeenWatermark;
}

/**
 * @description Options for {@link AgentAdapter.resumeSession}.
 */
export interface ResumeSessionOptions {
  /**
   * Post the "↩️ Resumed — last N messages" context block to the topic.
   * Set ONLY on the explicit user resume (`/sessions` pick) — silent
   * re-attach after a bot restart and crash-recovery resumes must stay
   * quiet, otherwise every hot rebuild spams every active topic.
   */
  isWithRecentContext?: boolean;
  /**
   * The bot saw this session take a turn (its seen watermark names it). Set by the wake of a sleeping conversation:
   * a Claude transcript that is then missing was removed (Claude Code's cleanup of old conversations), so the resume
   * fails like a refused one and the caller's recovery tells the topic; without it a missing transcript is a session
   * that never took a turn and its id is started silently.
   */
  isConversationRecorded?: boolean;
}

/**
 * @description One tappable option of an interactive agent question
 * (OpenCode's `ask`/question tool). `description` is shown beneath the label
 * when present.
 */
export interface OpenCodeQuestionOption {
  label: string;
  description?: string;
}

/**
 * @description One question of an interactive agent prompt. `multiple` means
 * several options may be selected. The bot renders one Telegram message per
 * question with an inline button per option.
 */
export interface OpenCodeQuestion {
  question: string;
  header?: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
}

/**
 * @description A pending interactive question the agent is blocked on, awaiting
 * the user's answer. Plain serialisable data (no functions / class instances)
 * so it can be persisted in `state.json` and restored after a bot restart —
 * which is the whole point: without persistence the in-memory pending-question
 * map is lost on restart, the agent's question tool hangs forever, and the
 * existing Telegram option buttons go dead. Lives here (a leaf module both
 * `bot.ts` and `state.ts` already import) rather than in `openCodeAdapter.ts`
 * so persisting it does not create a `state.ts → adapter → types` import cycle.
 */
export interface OpenCodePendingQuestion {
  requestId: string;
  questions: OpenCodeQuestion[];
  /**
   * Project-instance directory that owns the question request (from the
   * `/global/event` envelope). The reply must select the same instance via
   * `?directory=` — see `buildDirectoryScopedPath` in `openCodeAdapter.ts`.
   */
  directory?: string;
}

/**
 * @description The bot's per-thread record of an interactive question on screen:
 * the question {@link OpenCodePendingQuestion} plus the Telegram `messageId`
 * of the posted option-button message (`null` until `replyToThread` resolves).
 * All fields are serialisable, so the whole record is persisted to `state.json`
 * and restored at boot for threads whose session reattached — re-arming the
 * existing buttons so a restart no longer hangs the agent.
 *
 * Sequential multi-question: when the agent asks more than one question in a
 * turn, the bot shows them ONE AT A TIME and collects the answers locally,
 * replying to the agent only once EVERY question is answered (OpenCode's reply
 * API takes the whole answer matrix at once). The progress lives here so it
 * survives a restart:
 *  - `answers` — one slot per question (same order as `data.questions`), `null`
 *    until that question is answered, then the chosen labels/text;
 *  - `currentIndex` — which question is currently on screen;
 *  - `messageId` — the Telegram message id of the CURRENTLY shown question.
 */
export interface PendingQuestionState {
  data: OpenCodePendingQuestion;
  messageId: number | null;
  /** One slot per question (null = unanswered). Length === questions.length. */
  answers: (string[] | null)[];
  /** Index into `data.questions` of the question currently on screen. */
  currentIndex: number;
  /**
   * The message the question on screen (`currentIndex`) was FIRST asked in: the record that stays in the topic, with its text
   * and «asked again below», however often the question is put at the bottom again — a copy an earlier re-post made is deleted
   * when the next one lands, so a waiting question leaves the original and the live copy. Kept here, in the saved state, so a
   * restart does not lose which message is the original. Empty until the question is posted, cleared when the question
   * advances to the next one, and absent in a state that predates it (the message found then is taken for the original,
   * which is never deleted).
   */
  originalMessageId?: number | null;
  /**
   * When the agent asked the question, epoch ms: the moment its wait counts from (`utils/questionWaitPlan.ts`), kept here so a
   * restart re-arms the set-aside timer for the original point and not a fresh wait. Absent in a state that predates it (the
   * restore then counts from the boot).
   */
  askedAt?: number;
}

/**
 * @description A question the idle compaction re-asked (D1), as it is kept across a bot restart: the id of the message
 * that carries its `reask_<i>` buttons and the question they answer. Kept so those buttons still work after a restart
 * while the conversation sleeps, and so a restart that finds the conversation released can close the message.
 *
 * It is saved from the moment the idle compaction starts, when the re-ask is not posted yet: `isPosted: false`, and
 * `messageId` is then the message the question waited in (its buttons are off, and it has no result yet). A restart that
 * finds such a record asks the question again when the conversation can still be resumed (the old message then says «asked
 * again below»), and closes that message as unanswered when it is gone.
 */
export interface ReAskedQuestionRecord {
  messageId: number;
  question: OpenCodeQuestion;
  /** `false` while the re-ask is not posted yet; absent once it is. */
  isPosted?: boolean;
  /**
   * Of a posted re-ask: the message the question waited in, which the copy replaces, and whether its result («asked again
   * below») has LANDED. The post is saved before that edit is made, so a restart between the two finds the old message
   * without a note and finishes it.
   */
  predecessorMessageId?: number | null;
  isPredecessorClosed?: boolean;
}

/**
 * @description A question the agent asked that nobody answered within the question wait: the bot told the agent to go on
 * without it (`utils/questionWaitPlan.ts`) and keeps the question open in the topic — its message, buttons and pin — so an
 * answer given later still reaches the agent, as a new message. Plain serialisable data, kept in `state.json`.
 */
export interface SetAsideQuestionRecord {
  /**
   * Short id baked into the record's button data (`qs_<id>_<option>`), unique for the topic's whole LIFETIME and never reused:
   * a keyboard whose removal failed (the message is too old, a 429) stays live, and a later question that took its id would be
   * answered by a tap on it. Made from a per-topic counter that only goes up and that closing a record, an eviction or the end
   * of a conversation never reset (`createSetAsideQuestionId`); a tap is also honoured only on a message of the record
   * (`checkIsSetAsideRecordMessage`).
   */
  id: string;
  /** The Telegram message that shows the question (its buttons, its pin); `null` when its post never landed. */
  messageId: number | null;
  /**
   * The message the question was FIRST asked in, when a re-post put a copy at the bottom (`PendingQuestionState.originalMessageId`):
   * the copy is `messageId`, the original stays up with «asked again below». A reply to either answers the record. Absent when the
   * question was never re-posted.
   */
  originalMessageId?: number | null;
  questions: OpenCodeQuestion[];
  /** One slot per question (same order as `questions`): the answer given before the wait ended, `null` while it is still open. */
  answers: (string[] | null)[];
  /**
   * The index of the first question that was still open when the agent was told to go on: the questions from it on are answered
   * LATE (the ones before it went to the agent with the set-aside text). Their answers are collected here, one at a time, and the
   * agent gets them in one late-answer message once the last is in.
   */
  lateFromIndex: number;
  /** When the question was first asked, epoch ms. */
  askedAt: number;
  /** When the agent was told to go on without it, epoch ms. */
  setAsideAt: number;
}

/**
 * Why an agent's account was refused (an `auth` error): `signedOut` — no login, or one that expired or was revoked (the Claude
 * CLI's `authentication_failed`); `orgDisabled` — the account's organization turned its use off (`oauth_org_not_allowed`:
 * «Your organization has disabled Claude subscription access for Claude Code»); `rejected` — a bare 401 / 403 that names
 * neither.
 */
export type AgentAuthErrorReason = 'signedOut' | 'orgDisabled' | 'rejected';

/**
 * @description Classification of a provider-side API error surfaced by either
 * agent backend (Claude terminal "API Error" line or OpenCode `session.error`).
 * Drives the retry/surface decision: `transient` (rate-limit / overloaded —
 * short backoff) vs `usageLimit` (subscription / quota exhausted — long wait)
 * vs `auth` (logged out / bad credentials). `auth` is never retried — a wait
 * never fixes it: a json-stream Claude conversation moves to another account
 * that can work (`bot.ts` `handleClaudeAuthRefusal`); anything else, or nowhere
 * to go, is SURFACED as a pinned notice (the user must re-`/login`, or the
 * OpenCode server needs a restart) instead of arming a timer.
 */
export interface AgentApiErrorClass {
  /**
   * `conversationTail` — the provider refused a request whose history ended on the MODEL's turn (Gemini through
   * OpenCode v1's agent loop): a user turn fixes it, so it gets one immediate "continue".
   */
  kind: 'transient' | 'usageLimit' | 'auth' | 'conversationTail';
  /** Epoch ms when a usage window resets, if the error text exposed one. */
  resetAt?: number;
  /**
   * A usage-limit wording that does not by itself prove the window is used up — Anthropic's "This request would
   * exceed your account's rate limit" comes at 0–84 % shown usage too. The bot probes once with a short retry and
   * waits for the reset only when it repeats right after the probe or the account's usage reading is at 100 %.
   */
  isUnconfirmed?: boolean;
  /**
   * The account's prepaid API credit balance is used up («Credit balance is too low» — an account billed to a Claude
   * Console organization's API credits, or an API-key provider). No window resets it, so it never arms a
   * wait-for-reset: the bot marks the account exhausted until the operator acts and moves along the fallback chain.
   */
  isBalanceExhausted?: boolean;
  /** An `auth` error only: what the CLI refused the account for ({@link AgentAuthErrorReason}); absent = not told. */
  authReason?: AgentAuthErrorReason;
  /** An `auth` error only: the CLI's own words of it (the turn's error text), for the operator's alert; absent = none read. */
  authDetail?: string;
  /**
   * The error was read while an adopted session replayed the tail its process wrote while the bot was down: it ended a
   * turn BEFORE this bot started, not just now. The boot recovery owns such an episode (it reads the error's own time off
   * the transcript, where the replay can only read the clock); the bot must not handle its replayed copy again.
   */
  isReplayed?: boolean;
}

/**
 * @description The bot's per-thread record of an armed auto-retry after a
 * provider-side API error: the error {@link AgentApiErrorClass.kind} that armed
 * it, the 1-based attempt already scheduled, and the epoch-ms `fireAt` when the
 * retry timer should fire. No prompt is stored — the kick is a neutral "continue"
 * nudge that resumes the agent's intact session, not a re-send of the original
 * prompt. No adapter name either — the kick reuses the thread's existing
 * last-used adapter via `ensureAgentSession`. All fields are serialisable, so the
 * whole record is persisted to `state.json` and re-armed at boot — a multi-hour
 * usage-limit wait survives a restart. The record means ARMED: it is removed when
 * the retry stops being armed (cancelled, given up, or its kick ran its course — the
 * nudge forwarded, or dropped for good), so a restart never restores a retry that is
 * already spent. A nudge still waiting in the startup buffer behind a session start
 * has not run its course: the buffer is in memory, so the record stays until the
 * buffer replays or drops it.
 */
export interface ApiRetryState {
  kind: AgentApiErrorClass['kind'];
  /** 1-based attempt already scheduled. */
  attempt: number;
  /** Epoch ms when the retry timer should fire. */
  fireAt: number;
  /**
   * A usage-limit wait that ends on ANOTHER rung of the fallback chain (the one whose limit resets earliest,
   * `utils/fallbackChain.ts`): the resume moves the topic there before the continue nudge. Absent = the topic
   * continues where it is. Persisted, so a restart keeps the target.
   */
  resumeOn?: FallbackChainEntry;
  /**
   * The short probe retry of an UNCONFIRMED usage limit ({@link AgentApiErrorClass.isUnconfirmed}). Persisted, so the
   * same error right after a probe that a restart re-armed still confirms the limit instead of being probed again.
   */
  isLimitProbe?: boolean;
}

/**
 * @description A limit EPISODE already handled in a json-stream session's `stdout.jsonl` (`state.json`
 * `limitEpisodesRecovered`): recorded when the boot recovery arms a limit wait from the log's trailing error, and when a
 * live wait settles without its resume («⏭ Skip once», a give-up, a used-up balance). A later boot whose log is parked on
 * the SAME `result` line (`errorEndOffset` + `errorStamp`, `utils/limitEpisodeRecovery.ts`) does not arm it again — whatever ambient
 * frames (the boot's own `mcp_status` reply) were appended after it; a genuinely NEW trailing error is handled again. A marker
 * without `errorEndOffset` (written before it was kept, or of a log not parked on an error) is compared on the log's byte size
 * plus mtime, as it always was.
 */
export interface LimitEpisodeMarker {
  sizeBytes: number;
  mtimeMs: number;
  /** The byte offset right after the parked error's `result` line: where the episode is in the log. */
  errorEndOffset?: number;
  /** A hash of the parked error's whole `result` line (`getLimitEpisodeLineStamp`: its turn's `uuid`, `duration_ms`, `session_id`), beside its offset. */
  errorStamp?: string;
}

/**
 * @description THE unified verbosity vocabulary for every per-thread display
 * preference (`/thinking`, `/tool_results`, `/subagent`). Per-thread, persisted
 * (see `state.ts` `displayPrefs`). A bot-RENDERING concern only — it never
 * changes what is sent to the agent. Default for every pref is `minimal`.
 *
 * Per-command semantics (the live "working" indicators show in ALL modes;
 * the mode only controls what REMAINS in the topic):
 *
 * - thinking:
 *   - `full`    → the full reasoning text streams in and STAYS after the answer.
 *   - `short`   → live "thinking …" while reasoning, then collapses to a single
 *                 "thought for {N}s" line that STAYS.
 *   - `minimal` → live "thinking …" shown, but REMOVED once the answer starts.
 * - toolResults:
 *   - `full`    → the tool result is rendered in full, fenced.
 *   - `short`   → the result is truncated to a cap (lines + chars) with a footer.
 *   - `minimal` → only the transient "🔧 …" status, no result body.
 * - subagent (OpenCode: child session; Claude: Task-tool child, tailed from its
 *   on-disk transcript) — the "working" indicator is NEVER hidden (locked):
 *   - `full`    → child TEXT is additionally streamed, each chunk marked as
 *                 sub-agent.
 *   - `short`   → child transcript is NOT streamed (OpenCode shows a single live
 *                 "🤖 sub-agent: <title> …" status; Claude's own ◯ task-panel
 *                 line rolls inside the coalesced status frame).
 *   - `minimal` → v1: EXACTLY the same as `short` (status-only) — accepted so
 *                 the vocabulary stays uniform across the three commands.
 *
 * Old persisted/typed names (`detailed`/`brief`/`hide`/`compact`) are mapped
 * to this vocabulary at read/parse time — see
 * `utils/displayVerbosity.normalizeDisplayVerbosityMode`.
 */
export type DisplayVerbosityMode = 'minimal' | 'short' | 'full';

/**
 * @description What a Telegram topic SHOWS of the agent's work (request/answer
 * plan S6), set per topic through `/verbosity` and persisted with the display
 * prefs. `stream` is today's behaviour (the default); `streamAnswers` adds the
 * agent's `answer_request` answers, pinned, and turns requests on; `answers`
 * hides the agent's stream and shows only the pinned answers, the typing
 * indicator, native questions, files and the bot's own notices. Rules live in
 * `utils/topicView.ts`.
 */
export type TopicView = 'stream' | 'streamAnswers' | 'answers';

/**
 * @description Reader for a thread's FULL resolved display preferences, injected
 * into BOTH adapters at boot (`createAdapter.registerDisplayPrefsReader`, S4).
 * Generalises the former single-pref `SubagentModeReader`: the adapters now need
 * more than the sub-agent mode at PRODUCE time — Claude's relay classifies each
 * scraped chunk and routes tool / panel segments per the `toolResults` pref too
 * (S4), so one reader returning every pref is wired instead of N parallel
 * injections. The sub-agent branch still derives `.subagent` from it.
 *
 * Why a live read (not the bot's render-time resolution used for thinking /
 * tool-result OpenCode events): OpenCode branches a child part on its SSE hot
 * path (compact refreshes a status, full streams into a separate child
 * accumulator) and Claude's poll loop decides whether to read + relay tool
 * bodies — both are adapter-side decisions that cannot be deferred. Until
 * registered, both adapters fall back to all-fields-`minimal`.
 */
export type DisplayPrefsReader = (key: SessionKey) => ResolvedThreadDisplayPrefs;

/**
 * @description Reader for a thread's resolved UI locale, injected into BOTH
 * adapters at boot (`createAdapter.registerThreadLocaleReader`). The adapters
 * call `t(...)` on their own hot paths (Claude's poll loop formats question
 * hints / tool-result status; OpenCode's SSE handler builds delegation status)
 * OUTSIDE the bot's `withThreadLocale` wrapper — those `t(...)` calls would
 * otherwise fall back to `en` regardless of the chat's locale. With this
 * reader the adapter wraps the `t(...)` call in `runWithLocale(reader(key))`.
 * Until registered, the adapters fall back to {@link defaultLocale} (`en`).
 */
export type ThreadLocaleReader = (key: SessionKey) => Locale;

/**
 * @description Per-thread bot-rendering preferences for agent output
 * verbosity. Each field is optional: an absent field means "use the locked
 * default" (`minimal` for all three), so the persisted record only stores
 * non-default overrides — keeping `state.json` clean (same
 * delete-when-default idiom as the `/trace` toggle).
 *
 * On disk a field may still hold a LEGACY mode name
 * (`detailed`/`brief`/`hide`/`compact`) written before the vocabulary was
 * unified; `state.ts`'s `getDisplayPrefs` normalizes those at read time, so
 * the declared {@link DisplayVerbosityMode} type holds for every consumer.
 *
 * These are bot-side rendering concerns, NOT agent behavior: they live in
 * `state.json` per-thread (NOT the adapter pref files) and do not change what
 * is sent to the agent.
 */
export interface ThreadDisplayPrefs {
  thinking?: DisplayVerbosityMode;
  toolResults?: DisplayVerbosityMode;
  subagent?: DisplayVerbosityMode;
  view?: TopicView;
}

/**
 * @description Fully-resolved per-thread display preferences — every field is
 * present because the locked default is applied when the persisted record omits
 * it. Returned by the state store's getter so callers on the hot path never have
 * to re-apply defaults themselves.
 */
export interface ResolvedThreadDisplayPrefs {
  thinking: DisplayVerbosityMode;
  toolResults: DisplayVerbosityMode;
  subagent: DisplayVerbosityMode;
  view: TopicView;
}

/**
 * @description The per-surface output path, selected ONCE at boot from
 * `CHAT_MODE` (mirroring the {@link AgentAdapter} pattern) instead of a per-call
 * surface branch at every output site. The group impl is thin (`queueOutput`
 * edit-in-place + a noop finalize); the DM impl owns the draft-cursor manager;
 * `both` dispatches per key. Built by `createOutputTransport`.
 */
export interface OutputTransport {
  /** Route one `output` event to its message path (the mode's own logic). */
  deliverOutput(key: SessionKey, output: string, meta?: OutboundHints): void;
  /**
   * Finalize any in-flight content for the thread (DM: the live draft → a
   * permanent message; group: noop). The STATUS site awaits this so the status
   * frame lands below content; the two TEARDOWN sites fire-and-forget.
   */
  finalizeInFlight(key: SessionKey): Promise<void>;
  /**
   * Drop the thread's per-transport state on a full teardown (`/unbind`, topic
   * deleted) so it doesn't leak across a rebind. DM drops the reset draft entry;
   * group has nothing to drop (noop). Called AFTER `finalizeInFlight`.
   */
  disposeThread(key: SessionKey): void;
  /**
   * True while in-flight content "owns" the live message (DM: a draft turn is
   * active). The Claude liveness loop ORs this into `checkIsOutputStreaming` so a
   * heartbeat status frame can't be created between prose deltas — which would
   * trip a mid-answer `needsNewMessage` and chop the draft. Group: always false
   * (its streaming is already tracked via the output queue).
   */
  checkIsStreaming(key: SessionKey): boolean;
  /**
   * Thread keys whose TRANSPORT-OWNED in-flight state holds content to finalize
   * (DM: threads with an active draft turn). The graceful-shutdown flush
   * enumerates these so every live draft lands as a permanent message before the
   * process exits. Group: always empty — its coalesced-but-unsent state lives in
   * the bot's output queues, which the shutdown flush enumerates directly.
   */
  getInFlightThreadKeys(): SessionKey[];
}

/**
 * @description Lifecycle phase of a {@link ThinkingEvent}.
 *
 * - `live` → the agent is actively reasoning; the bot shows the live
 *   "thinking …" indicator (and, in `full` mode, the accumulated text).
 * - `done` → reasoning ended for this response; `durationMs` is how long it
 *   took, used to render the collapsed "thought for {N}s" line in `short` mode.
 */
export type ThinkingPhase = 'live' | 'done';

/**
 * @description Payload of the adapter `thinking` event — a chain-of-thought
 * lifecycle signal for ONE response. Emitted on a DEDICATED channel (not the
 * generic `status` coalescer) so the thinking indicator can persist
 * independently of transient tool status.
 *
 * The adapter stays MODE-AGNOSTIC: it emits the raw accumulated reasoning text
 * and the phase, and the BOT applies the per-thread thinking
 * {@link DisplayVerbosityMode} (which controls only what remains AFTER
 * reasoning ends). Reasoning text is kept SEPARATE from the answer accumulator
 * and never leaks into `output`.
 */
export interface ThinkingEvent {
  /** Lifecycle phase of this emit. */
  phase: ThinkingPhase;
  /**
   * Reasoning text accumulated so far for this response. Grows across `live`
   * emits; carried on `done` too so a late-arriving `full`-mode render has
   * the full text. Empty until the first reasoning delta produces content.
   */
  text: string;
  /**
   * How long reasoning took, in ms. Present only on the `done` phase — the bot
   * formats it into the collapsed "thought for {N}s" line for `short` mode.
   */
  durationMs?: number;
}

/**
 * @description Payload of the adapter `toolResult` event — a completed tool
 * call's OUTPUT for one response (S3). Emitted on a DEDICATED channel so the
 * result is rendered as its own message and never pollutes the answer
 * accumulator (`currentResponseText`) or its continuation accounting.
 *
 * The adapter stays MODE-AGNOSTIC: it emits every completed tool output once,
 * and the BOT applies the per-thread tool-results {@link DisplayVerbosityMode}
 * (`minimal` drops it, `short` truncates, `full` renders the whole body).
 */
export interface ToolResultEvent {
  /** Tool name as reported by the tool part (e.g. `bash`, `read`). */
  tool: string;
  /** Human-readable title from the tool state (e.g. the command description),
   * when the backend provided one. */
  title?: string;
  /** The tool's output body, untruncated. Non-empty by adapter contract. */
  output: string;
}

/**
 * @description Payload of the adapter `subagentStatus` event — the lifecycle of
 * a single OpenCode delegation (sub-agent) for the `minimal`/`short`
 * `/subagent` modes. Emitted on a DEDICATED channel (not the generic `status`
 * coalescer) so the "working" indicator gets its OWN message + ticking elapsed
 * timer in the bot, edited in place, instead of riding the shared transient
 * status (which re-`sendMessage`d a new message on every child-text burst — the
 * flood bug). `/subagent full` does NOT use this event (the streamed child
 * transcript IS the indicator there).
 *
 * The adapter stays MODE-AGNOSTIC about presentation: it only signals whether a
 * delegation is in flight (`active`) and the current sticky title; the BOT owns
 * the message lifecycle and the elapsed counter.
 */
export interface SubagentStatusEvent {
  /**
   * `true` = a delegation is in flight (start / keep-alive / title refresh) →
   * the bot opens or refreshes the dedicated status message.
   * `false` = the delegation ended → the bot removes the message.
   */
  active: boolean;
  /**
   * The delegation's sticky title (last non-null one seen for this run), or
   * `null` when the `task` part never carried a title/description — the bot
   * falls back to the localized generic label.
   */
  title: string | null;
}

/**
 * @description One option of a Claude CLI bare-digit survey (e.g. the periodic
 * session-feedback prompt: `1: Bad  2: Fine  3: Good  0: Dismiss`). The TUI
 * submits on the bare digit alone — no Enter — so `digit` is exactly the
 * keystroke to send.
 */
export interface ClaudeSurveyOption {
  /** The bare digit keystroke that selects this option (e.g. `'1'`, `'0'`). */
  digit: string;
  /** Human-readable label shown on the button (e.g. `'Bad'`, `'Dismiss'`). */
  label: string;
}

/**
 * @description Per-call options for {@link AgentAdapter.sendInput}.
 */
export interface SendInputOptions {
  /**
   * Whether the adapter appends an Enter after the literal keystrokes. Defaults
   * to `true` so every existing caller is byte-for-byte unchanged. Pass `false`
   * for a keystroke that auto-submits on its own (no Enter needed) — appending
   * one would otherwise submit a spurious empty prompt line afterwards.
   */
  appendEnter?: boolean;
}

/**
 * @description Read-only metadata from a live agent runtime. Null means the
 * backend could not determine that value and callers must render it as unknown.
 */
export interface AgentRuntimeInfo {
  version: string | null;
  /**
   * The model the runtime ACTUALLY ran last, as the backend itself reports it
   * (Claude: the newest main-session assistant record; OpenCode: the live
   * `provider/model` of the last parent turn). This is the fallback `/status`
   * needs for a backend whose sync {@link AgentAdapter.getCurrentModel} cannot
   * know the answer — the Claude tmux backend never can (its model lives inside
   * the TUI), so before this field `/status` named no model at all there.
   */
  model: string | null;
  contextWindowTokens: number | null;
  contextUsedTokens: number | null;
}

/**
 * @name CompactionResult
 * @description Outcome of ONE {@link AgentAdapter.compactContext} call.
 *
 * A discriminated result rather than the old `string | null` (an error message,
 * or `null` for success), because a success has data worth reporting: the Claude
 * backend's confirmation frame carries the pre/post context token counts, which
 * the bot posts in its completion message. With the old shape those counts had
 * nowhere to go — the adapter logged and dropped them — and a side-channel getter
 * would be a second source of truth for one call's outcome.
 *
 * `preTokens`/`postTokens` are `null` when the backend reports no counts:
 * OpenCode's `/summarize` returns none at all, and the Claude wait can confirm a
 * compaction (`compact_status success`) without ever seeing the boundary frame
 * that carries them. `null` therefore means "compacted, counts unknown", never
 * "zero" — the completion message drops the numbers instead of printing zeros.
 *
 * `error` is the user-facing text the bot posts verbatim (already localised by
 * the adapter), same convention as {@link AgentAdapter.renameSession}'s string.
 */
export type CompactionResult =
  | { ok: true; preTokens: number | null; postTokens: number | null }
  | { ok: false; error: string };

/**
 * @name EffortSetOutcome
 * @description What {@link AgentAdapter.setEffort} did with a pick, so a caller never guesses it from state:
 * - `applied` — the thread has the pick and nothing is left to do (a live session runs it; OpenCode applies it per
 *   prompt and a session started later seeds it);
 * - `stored` — the pick is saved but cannot apply yet (no agent is running); `notice` says when it will;
 * - `refused` — nothing was changed; `reason` says why (an unknown level, a model without levels).
 */
export type EffortSetOutcome =
  | { status: 'applied' }
  | { status: 'stored'; notice: string }
  | { status: 'refused'; reason: string };

/** @name EffortState @description See {@link AgentAdapter.getEffortState}. */
export interface EffortState {
  running: string | null;
  nextStart: string;
}


/**
 * @name SurfaceOpenQuestionOutcome
 * @description What {@link AgentAdapter.surfaceOpenQuestion} did: `emitted` — the registry held a question and the bot got it as a
 * `question` event; `none` — nothing to show (an empty registry, only the question left out, or no live session); `readFailed` — the
 * registry could not be read, so whether a question waits there is not known.
 */
export type SurfaceOpenQuestionOutcome = 'emitted' | 'none' | 'readFailed';

/**
 * @description Unified interface for AI agent backends (Claude CLI, OpenCode, etc.).
 * Each adapter manages sessions keyed by `SessionKey` and communicates via EventEmitter.
 *
 * Events emitted (all carry the `SessionKey` as the first argument):
 * - 'output'   (key: SessionKey, text: string, meta?: OutboundHints) — permanent text response
 * - 'status'   (key: SessionKey, text: string)   — transient status (tool calls, thinking); shown as editable message
 * - 'question' (key: SessionKey, question: { requestId: string, questions: QuestionInfo[] }) — interactive question for user
 * - 'questionGone' (key: SessionKey) — Claude-only; the scraped TUI selector left the screen (answered / dismissed), so the bot removes its pin. Claude has no `pendingQuestions` entry, so it can't lean on the OpenCode `clearPendingQuestion` unpin path; this event is the normal-answer unpin trigger. Hard-teardown paths (stop / quit / unbind / closed / error) still route through `clearPendingQuestion` for BOTH backends.
 * - 'thinking' (key: SessionKey, payload: ThinkingEvent) — chain-of-thought lifecycle (OpenCode); the bot applies the per-thread thinking {@link DisplayVerbosityMode}
 * - 'toolResult' (key: SessionKey, payload: ToolResultEvent) — a completed tool call's output (OpenCode); the bot applies the per-thread tool-results {@link DisplayVerbosityMode}
 * - 'subagentStatus' (key: SessionKey, payload: SubagentStatusEvent) — OpenCode delegation lifecycle for `minimal`/`short` `/subagent` modes; the bot owns a dedicated self-updating status message with a ticking elapsed timer
 * - 'apiError' (key: SessionKey, error: AgentApiErrorClass) — provider-side API error at the proxy boundary (auto-retry trigger; only when {@link AgentApiErrorClass} classification matched)
 * - 'started'  (key: SessionKey)                  — session is up and ready
 * - 'stopped'  (key: SessionKey)                  — `stopSession` completed (explicit teardown)
 * - 'suspended' (key: SessionKey)                 — `suspendSession` completed: the process is gone, the session stays resumable (the idle stop; lifecycle plan L3)
 * - 'turnEnded' (key: SessionKey)                 — a turn's terminal `result` was processed (json-stream); the per-turn lifecycle stops the process on it (L5)
 * - 'contextCompacted' (key: SessionKey, trigger: string | null) — a compaction COMPLETED (json-stream): one the bot issued, or the CLI's own overflow compaction; the conversation's context was replaced by a summary (Jira prompt context C6)
 * - 'conversationLost' (key: SessionKey)          — a live re-spawn (an account, model or effort change; json-stream) found the conversation's transcript gone and began a NEW conversation under the same id; the bot tells the topic and resets what the conversation was told
 * - 'closed'   (key: SessionKey)                  — session died on its own (process exit, SSE giveup, server crash)
 * - 'error'    (key: SessionKey, error: Error)    — asynchronous failure AFTER successful startSession resolution
 *
 * Audit S10 / #16 contract clarifications (enforced by every adapter):
 *
 * - `startSession` / `resumeSession` rejects (throws) if the session
 *   could not be started or recovered. Successful resolution implies
 *   `checkIsActive(key) === true` and that subsequent events will fire.
 *
 * - `emit('error', …)` is for failures that happen AFTER a successful
 *   start (network blip, SSE drop with no recovery). Synchronous start
 *   failures must throw, never emit error+return.
 *
 * - `emit('closed', …)` is for unsolicited deaths only. If the user
 *   called `stopSession`, the adapter emits `stopped` instead. Both
 *   events MUST come with the same teardown (in-memory state freed).
 */
export interface AgentAdapter extends EventEmitter {
  /** Unique adapter identifier, e.g. 'claude', 'opencode' */
  readonly name: string;
  /** Human-readable label for Telegram UI */
  readonly label: string;

  // — Lifecycle —

  /**
   * Start a new session bound to `key` in `workDir`.
   *
   * `sessionId` is the externally-assigned id for backends that support it
   * (Claude CLI's `--session-id <uuid>`). The bot owns sessionId generation
   * and persists it in state.json so resumes survive bot restarts (see plan §13.1, D14).
   * If omitted, the adapter falls back to backend defaults — for Claude this means
   * a CLI-generated UUID that the adapter still exposes via `getClaudeSessionId(key)`.
   *
   * **Throws** if the session could not be started (audit S10 / #16). The
   * returned promise rejecting means no `started` event will fire and no
   * in-memory state was retained.
   */
  startSession(key: SessionKey, workDir: string, args?: string, sessionId?: string): Promise<void>;
  stopSession(key: SessionKey): void;

  /**
   * @description Stop the process but keep the session RESUMABLE (lifecycle plan
   * L3): the next trigger resumes the conversation by its persisted id. Converges
   * on `suspended`, never `stopped`. Optional: only a backend whose process can be
   * stopped without losing the conversation (json-stream Claude) offers it; the
   * tmux TUI and OpenCode are never auto-stopped (L-D8).
   */
  suspendSession?(key: SessionKey): Promise<void>;
  /**
   * @description {@link stopSession}, resolving once the stop is DONE: the process gone and the session dropped, so
   * `checkIsActive` is false and a start under the same key finds nothing running. Optional: a backend whose `stopSession`
   * already finishes at once (or only queues its teardown) omits it. `/quit` waits on it before it says «stopped».
   */
  stopSessionAndWait?(key: SessionKey): Promise<void>;
  /**
   * @description Resolves once an ADOPTED session (one that outlived a bot restart) has replayed what its process wrote
   * while the bot was down — it is read only once the boot has restored its state — and at once for any other session. A
   * prompt forwarded before that would reset the answer and error state the replayed frames still use; an idle fire would
   * judge the process on the state the restart left. Optional: only the json-stream Claude backend adopts and replays.
   */
  whenAdoptReplayed?(key: SessionKey): Promise<void>;
  /** Whether an adopted session is not read yet or still replaying the downtime tail — {@link whenAdoptReplayed} would wait. */
  checkIsAdoptReplayPending?(key: SessionKey): boolean;
  checkIsActive(key: SessionKey): boolean;

  /**
   * @description Read runtime metadata for the live session without sending the
   * agent a prompt or command. Backends that cannot expose trustworthy model or
   * context data (such as Terminal) omit this method.
   */
  getRuntimeInfo?(key: SessionKey): Promise<AgentRuntimeInfo>;

  /**
   * @description The context size, in tokens, the live conversation holds after its newest completed model call (input + cache +
   * output): what the idle compaction measures its growth up to. Read from what the adapter already holds or from the on-disk
   * transcript — never a server round trip. `null` when it cannot be told. The read starts at once, in the call's own tick: a
   * per-turn process is stopped within moments of its turn's end. Optional: a backend with no such figure omits it.
   */
  getContextUsedTokens?(key: SessionKey): Promise<number | null>;

  /**
   * @description The context size, in tokens, the FIRST model call after the conversation's last compaction saw — the compacted
   * summary, the system prompt and instructions, the skills restored and the prompt: input + cache read + cache write (the output
   * is not what a call saw) — or of the conversation's first call when it was never compacted. The idle compaction measures its
   * growth from it, so it is read from the conversation's history, not from the end of a turn that may have read half a repository
   * (and, for a conversation that already has turns when the bot learns of the figure, not from whenever the bot first looked).
   * `null` when it cannot be told. Same «starts at once» rule as {@link getContextUsedTokens}. Optional.
   */
  getFirstCallContextTokens?(key: SessionKey): Promise<number | null>;

  /**
   * @description How many compactions the bot did NOT issue have completed in the live session — the CLI's own overflow compaction,
   * the server's own — a count the bot compares between two readings of the context: a change means the epoch was replaced, so the
   * baseline it measures growth from is the older one's. Per live session (a new process counts from 0: any difference between two
   * readings is a change, and a needless one only costs a re-read). Optional: a backend that cannot tell omits it.
   */
  getOwnCompactionCount?(key: SessionKey): number;

  /**
   * @description Whether the session bound to `key` is mid-turn (an in-progress
   * reply). `false` when there is no session or it is idle. Sync and read from
   * in-memory state only (no tmux/HTTP call) so a caller can poll it cheaply —
   * the scheduler's wait-for-idle loop polls this before forwarding a scheduled
   * prompt, so a fire never interrupts live work.
   *
   * Per-backend signal:
   *  - **Claude** — the same pane busy marker `interruptAndWaitIdle` polls
   *    (`esc to interrupt` footer), evaluated against the session's last cached
   *    capture.
   *  - **OpenCode** — the in-flight response state tracked from SSE (own
   *    generation running, a sub-agent running, or context compacting).
   *
   * Optional (optional-method pattern, like {@link setModel}): adapters that
   * can't report busy-ness omit it and a caller treats the session as never
   * busy.
   */
  checkIsBusy?(key: SessionKey): boolean;

  /**
   * Whether input the bot wrote has not yet been TAKEN IN by the backend. A
   * message written while a turn runs waits until the backend reads it (Claude
   * json-stream and OpenCode accept it mid-turn and merge it into the running
   * turn), so for that window the backend can report the END of the earlier
   * turn. The request wake-up engine counts a turn end only once this is false.
   *  - **Claude json-stream** — user messages written that no `--replay-user-messages`
   *    echo has carried yet (the echo arrives when Claude reads them; messages it takes in
   *    together are ONE echo), for as long as they can still be on their way: while a turn
   *    runs, and for a short grace after its end or their write.
   *  - **OpenCode** — prompts sent minus the new user messages seen on the event
   *    stream.
   * Optional: a backend without such a signal omits it, and the engine falls
   * back to busy or output seen since the forward. That fallback is exact for
   * the tmux Claude backend only because it interrupts the running turn before
   * typing — except while a sub-agent or compaction runs, when it queues the
   * prompt behind that turn and the earlier turn's busy already satisfies it.
   */
  checkHasUnconsumedInput?(key: SessionKey): boolean;

  /**
   * Whether the process is WORKING and must not be stopped (lifecycle plan L-D2):
   * a running turn, a background task it still runs (a background Bash / Monitor /
   * sub-agent — a stop would kill them), input written but not yet taken in, or a
   * compaction in flight. Optional: a backend without the signal omits it and the
   * idle stop falls back to `checkIsBusy`.
   *  - **Claude json-stream** — busy, or the CLI's `background_tasks_changed` list
   *    is non-empty, or an input echo is outstanding, or a bot-issued `/compact` runs.
   */
  checkIsWorking?(key: SessionKey): boolean;

  /**
   * The part of "working" that is NOT the running turn, by name: a background task or a scheduled job the
   * process still runs, a finished task's turn on its way, input written but not yet taken in, a compaction in
   * flight — each only for a bounded time, so none holds a turn-less process for good. Empty when there is none.
   * Read apart from `checkIsBusy` by the idle fire, which excuses a busy turn that only waits on an interactive
   * question (D1) but never this — with a question pending AND a background task running, the process is working
   * (L-D2) — and which logs WHICH signal held the process. Optional, like `checkIsWorking`.
   */
  getBackgroundWorkSignals?(key: SessionKey): BackgroundWorkSignal[];

  /**
   * The hold left for the agent's own pending work between turns — background tasks, scheduled jobs — which keeps
   * the process only for a bounded time after its last turn (`utils/jsonStreamPendingWork.ts`): `null` with nothing
   * pending, `0` once spent. The idle fire that found only this work re-checks no later than when it runs out.
   * Optional, like `getBackgroundWorkSignals`.
   */
  getPendingWorkHoldRemainingMs?(key: SessionKey): number | null;

  /**
   * Bring the in-memory working state up to what the process wrote so far (the json-stream tail is polled with a
   * backoff). An automatic stop calls it right before its last look. An adopted session the boot has not released yet is
   * not read — its caller waits for {@link whenAdoptReplayed} first. Optional: a backend whose state is current omits it.
   */
  refreshWorkingState?(key: SessionKey): void;

  /**
   * The agent's own pending work the conversation's last process took with it when it ended (a crash, a re-spawn, the
   * idle stop after the pending-work hold, a process found gone at boot), handed over ONCE; `null` when nothing was
   * lost (`utils/lostWork.ts`). Optional: only a backend that tracks the agent's background work offers it.
   */
  takeLostWork?(key: SessionKey): LostWork | null;

  /**
   * What the LIVE process holds that would die with it (`utils/lostWork.ts`), read before the bot stops it itself for
   * a backend switch — an explicit stop records nothing. `null` when nothing is pending. Optional, like `takeLostWork`.
   */
  getPendingWork?(key: SessionKey): LostWork | null;

  /**
   * Whether the live process may be stopped automatically (lifecycle plan L-D10):
   * its CLI reports the background-task list (`claude_code_version` ≥ 2.1.287).
   * Unknown version → `false`. Optional: a backend that is never auto-stopped omits it.
   */
  checkIsAutoStopSupported?(key: SessionKey): boolean;

  /**
   * Re-register the bot-owned scheduler MCP for active OpenCode directories,
   * for a listener that became available after those sessions connected. Boot
   * no longer needs it: the listener is bound before sessions are re-attached,
   * and {@link reconcileSchedulerMcpForActiveSessions} heals stale entries.
   */
  registerSchedulerMcpForActiveSessions?(): void;

  /**
   * Reconcile the bot-owned scheduler MCP registration for active OpenCode
   * directories against the server's LIVE status: force a re-registration for
   * any directory whose `charness` entry is missing or not `connected`. Used
   * at boot when the bot adopts an already-running opencode that may still hold
   * a stale registration (dead port) from a previous bot generation.
   */
  reconcileSchedulerMcpForActiveSessions?(): Promise<void>;

  /**
   * Make every active OpenCode directory's instance load the bot's compaction
   * plugin (`utils/openCodeCompactPlugin.ts`): install the plugin file, then
   * recreate each IDLE directory instance that predates it or loaded an older
   * version of it. Recreating drops the
   * directory's runtime MCP registrations, so the boot caller must run
   * {@link reconcileSchedulerMcpForActiveSessions} AFTER this resolves. Best-effort,
   * never rejects; a busy directory is left for the next boot.
   */
  activateCompactionPluginForActiveSessions?(): Promise<void>;

  /**
   * Boot step (OpenCode): replace a server started the wrong way — one the bot owns against the instance's «Bot skills»
   * switch (`utils/agentPlugin.ts`), or any `opencode serve` it may stop that answers without a password — once nothing
   * works in it, before {@link activateCompactionPluginForActiveSessions}, whose reconcile then restores what a replacement
   * drops. Best-effort, never rejects; busy → it looks again later, and at the next boot.
   */
  replaceMislaunchedServer?(): Promise<void>;

  /**
   * Heal the bot-owned MCP server `serverName` INSIDE one live session: read the
   * status the backend holds for it and reconnect it when it reports `failed`.
   * The Claude-side counterpart of {@link reconcileSchedulerMcpForActiveSessions}
   * — a json-stream session outlives every bot restart, and its MCP client never
   * retries a server it once failed to reach, so without this the bot's own
   * tools stay gone for the rest of that session. The resolved
   * {@link McpHealOutcome} says what actually happened, so a caller can log only
   * the sessions it really repaired. `legacyServerName`, when given, is the name an
   * agent started before a rename still holds the server under: it is looked for
   * when `serverName` is not listed, and the repair runs under the name found.
   *
   * Optional (optional-method pattern, like {@link compactContext}): only the
   * json-stream Claude backend has a control channel to ask over.
   */
  healMcpServer?(key: SessionKey, serverName: string, legacyServerName?: string): Promise<McpHealOutcome>;

  // — Input —

  sendInput(key: SessionKey, input: string, options?: SendInputOptions): void;
  /**
   * {@link sendInput} for a prompt whose caller must know it reached the agent: resolves once the backend has the
   * input and rejects when it could not be handed over — the json-stream host's write into the CLI's stdin that failed
   * (`EAGAIN` past its stall budget, a reader that is gone), so a prompt is never believed delivered when it was not.
   * Optional (optional-method pattern): a backend without it takes its input at once through `sendInput`.
   */
  sendInputAndWait?(key: SessionKey, input: string): Promise<void>;
  sendSignal(key: SessionKey, signal: string): void;

  // — Session history —

  /**
   * List resumable sessions for this `key`. `workDir` is supplied by the
   * bot from the thread's binding because a thread may have NO live
   * adapter session when listing (e.g. right after a restart, or to pick
   * up a conversation started by hand on the laptop), so the folder can't
   * be inferred from adapter state. Claude reads real
   * `~/.claude/projects/<cwd>/*.jsonl` transcripts filtered to `workDir`;
   * OpenCode ignores `workDir` (its server API exposes no folder field).
   */
  getSessions(key: SessionKey, workDir: string): Promise<AgentSession[]>;
  /**
   * Rename the CURRENT live session bound to `key` to `title`. Same
   * convention as {@link setModel}: resolves to `null` on success, or a
   * short user-facing error string on failure.
   *
   * Optional (optional-method pattern, like {@link setModel}): only backends
   * with a real session-title concept implement it. OpenCode does
   * (`PATCH /session/:id { title }`); Claude does NOT — its transcripts have
   * no title — so the bot replies "not supported" for adapters lacking it.
   *
   * A manual rename is final: it must suppress any later automatic title
   * overwrite (OpenCode's bot-side auto-name fallback).
   */
  renameSession?(key: SessionKey, title: string): Promise<string | null>;

  /**
   * Compact (summarize) the CURRENT live session's context so the conversation
   * can keep going in a smaller window. Resolves a {@link CompactionResult}: a
   * success optionally carrying the pre/post context token counts, or a failure
   * carrying the user-facing error text. Awaits the compaction to actually
   * COMPLETE before resolving (OpenCode's summarize blocks until the summary is
   * generated; the json-stream backend waits for the CLI's `compact_boundary`),
   * so the caller can post its notice AFTER the context was really compacted.
   *
   * `instruction`, when set, is appended to the backend's baked compaction
   * prompt (NOT a replacement) so the summary can carry an extra closing
   * section (F2's "where we stopped" recap). OpenCode threads it into the
   * summarize request body; the json-stream Claude backend sends it as
   * `/compact <instruction>`.
   *
   * Optional (optional-method pattern, like {@link renameSession}): only
   * backends that can perform a REAL, confirmable compaction implement it —
   * OpenCode (`POST /session/:id/summarize`) and the json-stream Claude backend
   * (`/compact` over the stream-json control turn). The tmux Claude backend
   * deliberately does NOT: its TUI owns `/compact`, so the bot forwards the
   * literal slash command to it instead. Adapters with neither (Terminal) get
   * the "not supported" reply.
   */
  compactContext?(key: SessionKey, instruction?: string): Promise<CompactionResult>;

  /**
   * Whether this backend's own compaction prompt already receives the
   * resume guidance (the loaded skills and the next-steps checklist) for this
   * thread's session, so the bot must leave it
   * out of the `compactContext` instruction. OpenCode: true when the server
   * loaded the CURRENT bot compaction plugin (`utils/openCodeCompactPlugin.ts`), which
   * cannot see the instruction and so cannot skip a duplicate itself. Optional —
   * absent means "no", and the Claude backends leave it unset because their
   * `PreCompact` hook skips a compaction that already carries the guidance.
   */
  checkHasCompactionResumeHook?(key: SessionKey): Promise<boolean>;

  /**
   * Whether this backend's OWN compaction summary already reaches the topic as
   * ordinary agent output, so the bot must NOT post a second copy of it.
   *
   * True for OpenCode: its `POST /session/:id/summarize` produces a real assistant
   * message, which rides the SSE stream into the topic marked
   * `OutboundHints.isCompactionSummary` (the bot drops it unless `/compact_summary`
   * is on, and shows it without the marker lines the agent was asked to write; with the summary hidden the bot posts its
   * self-review section alone — read after its own compaction, taken out of the tails of the server's own). The Claude
   * backends write the summary only into their on-disk transcript (an
   * `isCompactSummary: true` record) and emit no assistant text at all, so they
   * leave this unset and the bot posts the summary itself.
   *
   * A CAPABILITY flag, not an adapter-name check, so a future backend that streams
   * its own summary is handled by declaring it here.
   */
  readonly streamsCompactionSummary?: boolean;

  /**
   * Read the most recent compaction summary text for the live session, or
   * `null` when none is available / the read failed. Used by F2 to lift the
   * appended "Where we stopped" closing section out of the freshly-generated
   * summary and surface it in the idle-compaction notice. Optional — only
   * backends whose summary is retrievable implement it; a missing method just
   * means the notice omits the closing prose.
   */
  getLatestCompactionSummary?(key: SessionKey): Promise<string | null>;

  /**
   * Resume an existing backend session under this `key` and `workDir`.
   *
   * `workDir` is now a required argument: the adapter cannot infer it after
   * a bot restart, and silently falling back to `process.env.WORK_DIR` was a
   * source of mis-routing in the old single-folder architecture (plan §10.3,
   * fix to openCodeAdapter.ts:599).
   *
   * `options.isWithRecentContext` posts the short "↩️ Resumed — last N
   * messages" context block. ONLY the explicit user resume (`/sessions` pick)
   * sets it: the same method also runs on silent re-attach after every bot
   * restart (hot reload) and on opencode crash-recovery, and posting the
   * block there spammed every active topic on every rebuild.
   */
  resumeSession(key: SessionKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void>;

  /**
   * @description Fork the thread's CURRENT session into a new one that carries
   * the full conversation, and attach to it; returns the new session id (or null
   * if inactive / failed). Optional (optional-method pattern like {@link setModel}):
   * OpenCode implements it via `POST /session/:id/fork`; the bot's wedged-turn
   * recovery uses it to restore the last dialog into a fresh, unwedged session
   * before replaying. Adapters that can't fork omit it (recovery falls back to a
   * blank restart).
   */
  forkSession?(key: SessionKey): Promise<string | null>;

  /**
   * @description Detach any RUNNING sub-agent synchronously blocking the thread's
   * session, so a new prompt is answered promptly while the sub-agent keeps
   * working in the background (its result is injected back when it finishes).
   * Returns whether anything was backgrounded. Optional (optional-method pattern):
   * OpenCode implements it via `POST /experimental/session/:id/background`; other
   * adapters omit it. Best-effort — never blocks the prompt that follows.
   */
  detachRunningSubagents?(key: SessionKey): Promise<boolean>;

  /**
   * Queue `text` into the turn the session is working on RIGHT NOW, as a note the agent reads between its steps —
   * without starting a new turn: the response being streamed goes on as one message, and nothing of the turn's state
   * is reset. Resolves `false`, posting nothing, when the session is not busy, or when the turn waits out a provider
   * retry (a note must never cut that wait short). Optional: only OpenCode reads a prompt mid-turn (the shared todo
   * lists' mid-turn board, `todos/midTurn.ts`).
   */
  queueNoteIntoRunningTurn?(key: SessionKey, text: string): Promise<boolean>;

  /**
   * @description Read the last `limit` conversational turns (user/assistant
   * messages with renderable text, oldest→newest) of `sessionId` from the
   * backend's own transcript — Claude reads its `.jsonl`, OpenCode calls
   * `GET /session/:id/message`. Optional (optional-method pattern, like
   * {@link setModel}): adapters that can't cheaply read history omit it and
   * the resume context block is simply skipped. The result is already capped
   * to `limit`; an empty array means no renderable turns (brand-new / pruned
   * session). Used by `resumeSession` to post the short resume context block.
   */
  getRecentTurns?(key: SessionKey, workDir: string, sessionId: string, limit: number): Promise<RecentTurn[]>;

  /**
   * @description The summary the backend's own compaction left in the conversation `sessionId` (the newest one), read
   * from its transcript whether or not the session runs; `null` when it holds none or cannot be read. Never part of
   * {@link getRecentTurns} — it is not something the user said — so the surfaces that show turns do not show it. Used
   * by the context bridge of a cross-backend switch, which hands it to the next agent as context. Optional: only a
   * backend whose transcript carries the summary implements it.
   */
  getSessionCompactionSummary?(key: SessionKey, workDir: string, sessionId: string): Promise<string | null>;

  /**
   * @description Assemble the post-restart recap for `sessionId`: how many
   * assistant messages were produced while the bot was down (vs the persisted
   * {@link SeenWatermark}) plus the last few turns and a best-effort
   * still-working signal. Called by `reattachExistingSessions` after a SILENT
   * re-adopt (NOT the explicit `/sessions` resume, which keeps its own context
   * block). Optional (optional-method pattern, like {@link getRecentTurns}):
   * adapters that keep no structured record omit it (Terminal) and the reattach
   * recap is simply skipped. `watermark` is `null` when none was ever persisted
   * → the implementation returns `isWatermarkKnown: false` (the fallback path).
   */
  getReattachRecap?(
    key: SessionKey,
    workDir: string,
    sessionId: string,
    watermark: SeenWatermark | null,
  ): Promise<ReattachRecap>;

  // — Model selection —

  /**
   * Connect a provider account for this backend using an API key. Same return
   * convention as {@link setModel}: resolves to `null` on success, or a short
   * user-facing error string on failure.
   *
   * Optional (optional-method pattern): OpenCode implements provider auth;
   * Claude/Terminal do not.
   */
  connectProvider?(key: SessionKey, providerId: string, apiKey: string): Promise<string | null>;

  /**
   * Disconnect a provider: remove the credentials this backend stores for it.
   * Same return convention as {@link connectProvider} — `null` means a clean
   * disconnect (the caller shows its own success copy), a non-null string is a
   * user-facing notice to show verbatim. The notice covers BOTH a failure and
   * the honest-caveat case: a provider the backend enables from an environment
   * variable stays active after its stored credentials are gone.
   *
   * Optional (optional-method pattern): OpenCode implements provider auth;
   * Claude/Terminal do not.
   */
  disconnectProvider?(key: SessionKey, providerId: string): Promise<string | null>;

  /**
   * Fetch a provider's auth methods for the `/connect` method picker. OpenCode
   * returns custom OAuth methods from its auth catalog and a generic API-key
   * method for ordinary providers in its full provider catalog.
   */
  fetchProviderAuthMethods?(providerId: string): Promise<OpenCodeAuthMethod[]>;

  /**
   * Reload provider credentials after an out-of-band OAuth login. OpenCode
   * caches auth in its live server process, so its adapter performs a
   * controlled restart and restores its active sessions before resolving.
   * Optional (OpenCode only, same optional-method pattern as provider auth).
   */
  reloadProviderAuth?(): Promise<boolean>;

  /**
   * Set model override. Returns error message on failure, `null` on
   * success. Audit S10 / #39: unified to `Promise<string | null>` —
   * callers used to branch on `void` vs `Promise<string | null>`.
   */
  setModel?(key: SessionKey, modelId: string): Promise<string | null>;
  getCurrentModel?(key: SessionKey): string | null;
  /** Get available models from backend */
  getAvailableModels?(): Promise<string[]>;

  // — Reasoning-effort selection (per-thread, per-backend) —

  /**
   * Set the reasoning-effort level for this thread. Same convention as
   * {@link setModel}, but its result is typed ({@link EffortSetOutcome}): applied, stored for the next start, or
   * refused with a short user-facing reason (e.g. "level X is not valid for model Y").
   *
   * Per-backend semantics:
   *
   * - **Claude** applies immediately by writing `/effort <level>` into the
   *   running TUI; the value is also stored for menu/banner display.
   * - **OpenCode** persists the choice but does NOT mutate the live session
   *   here — the level (a model variant) is applied **per-prompt** inside the
   *   adapter's prompt-send path, sent as `body.variant` alongside the model
   *   override (no separate request, no env configuration).
   */
  setEffort?(key: SessionKey, level: string): Promise<EffortSetOutcome>;

  /**
   * Currently selected reasoning-effort level for this thread, or `null`
   * if none has been chosen (adapter default in effect). Mirrors
   * {@link getCurrentModel}'s sync read pattern.
   */
  getEffort?(key: SessionKey): string | null;

  /**
   * The thread's effort as it stands now, for display: the level the LIVE session uses (`running`: `null` with no
   * live session, or when it cannot be known — a tmux TUI adopted after a restart), and the level the thread's next
   * session start will use (`nextStart`: its own pick, else the instance default; OpenCode: rounded to the model's
   * variants when they are known). The two differ when the default changed under a running session — a change
   * applies from the next start, never to a running one. A backend without the method has no effort concept, and
   * `null` says the same of one thread: its model is KNOWN to offer no levels (OpenCode: no variants), so a start
   * sends none and there is nothing to show — a model not known yet keeps answering with the default.
   */
  getEffortState?(key: SessionKey): EffortState | null;

  /**
   * The `provider/model` the thread's NEXT session will run on this backend — its saved `/model` pick, else the
   * server's default — or `null` when neither is known (OpenCode only; the question before a switch to it names it).
   */
  getProspectiveModelLabel?(key: SessionKey): Promise<string | null>;

  /**
   * The level this thread picked itself with `/effort`, or `null` when it follows the instance default
   * (`settings.json`). Unlike {@link getEffort} it is never a derived default — OpenCode's `getEffort` answers
   * with the clamped default of a live session — so `/effort` can tell "set for this topic" from "as in General".
   */
  getOwnEffort?(key: SessionKey): string | null;

  /**
   * Drop the thread's own `/effort` pick so it follows the instance default again. A live session is brought to
   * that default the way a pick would be (Claude json-stream: a `--resume` re-spawn when the level differs;
   * tmux Claude: the `/effort` keystroke; OpenCode: the per-prompt variant); a stopped one reads it at its next
   * start. It cannot be refused: whatever the thread had, it follows the default after it.
   */
  clearEffort?(key: SessionKey): Promise<void>;

  /**
   * Levels valid for the thread's current backend + model. Returns an
   * empty array when the adapter has no opinion on effort (e.g. an OpenCode
   * model that declares no `variants`) — the caller surfaces a "not
   * supported" notice instead of an empty picker.
   *
   * Async because OpenCode needs to query `/config/providers`; Claude
   * resolves locally and just wraps the canonical list in `Promise.resolve`.
   */
  getAvailableEffortLevels?(key: SessionKey): Promise<string[]>;

  // — Interactive questions (OpenCode) —

  /** Reply to a pending question with selected answers */
  answerQuestion?(key: SessionKey, answers: string[][]): void;

  /**
   * @description Reject (close) a pending question server-side WITHOUT answering
   * it — used when the user ABANDONS the question (sends a fresh prompt instead
   * of answering, or tears the session down while it is pending). Without this
   * the question stays "open" in OpenCode's registry and a later reattach
   * re-surfaces the stale question. OpenCode-only (Claude has no server-side
   * question concept, so it does not implement it); a no-op when no question is
   * pending. Must run while the session is still active — a stopped session
   * can't accept the reject POST.
   */
  rejectQuestion?(key: SessionKey): void;

  /**
   * @description Set the pending question ASIDE without answering it and without ending the turn: the question's tool call
   * returns `text` — the bot's «nobody answered yet, go on, the answer comes later as a message»
   * (`buildQuestionSetAsideText`) — and the agent carries on with its work. Not {@link rejectQuestion}, which is the
   * abandonment path (the turn is interrupted, or on OpenCode the agent's loop ends).
   *  - Claude json-stream / per-turn: the `can_use_tool` request is DENIED with `text` as its message, which the model
   *    reads as the tool's result; no interrupt follows.
   *  - OpenCode: the question is REPLIED to with `text` as the custom answer of every question left open; never rejected,
   *    since a reject ends OpenCode's agent loop.
   * `requestId` is the question the `text` was written for: nothing happens unless it is the question pending NOW, so a timer
   * that fires late — after that question was answered and the agent asked the next one — cannot set the wrong one aside.
   * `givenAnswers` is one slot per question: the answer already collected for it (kept as it is — OpenCode's reply takes the
   * whole answer matrix at once), `null` for one left open.
   * @returns `true` only when the question's tool call was answered (the reply or the deny was sent); `false` for a no-op: no
   * question pending, another one pending, an inactive session, or a backend that implements neither question path (the
   * tmux-scrape Claude, the terminal). The bot says «the agent went on» in the topic only for `true`.
   * `onSettled` (a backend whose reply is a network call: OpenCode) is told once whether the send was taken (`true`) or failed
   * (`false`): a failed one leaves the question open on the backend's side, so «the agent went on» may be untrue and the caller
   * must see to it; such a failure does not surface through the `error` event.
   */
  setQuestionAside?(key: SessionKey, requestId: string, text: string, givenAnswers: (string[] | null)[], onSettled?: (isSent: boolean) => void): boolean;

  /**
   * @description Re-read the backend's OWN registry of open questions for this session and say whether it holds `requestId`, the
   * question the bot asks about: `held` — that very question is open there (the adapter now holds it, so {@link setQuestionAside}
   * can act); `none` — the registry holds no such question: it is empty for this session, or holds ANOTHER one (the bot's copy is
   * stale; the adapter's own is left alone, and {@link surfaceOpenQuestion} hands the other one to the bot); `unknown` — it could
   * not be read, or the adapter has no live session to ask for (a replacement may be under way).
   * Only for a backend whose adapter merely CACHES such a registry (OpenCode: the server's `GET /question`); one that is itself the
   * authority on what it waits on (Claude json-stream: the CLI's blocked `can_use_tool`, saved beside the session) has none.
   */
  resyncOpenQuestion?(key: SessionKey, requestId: string): Promise<'held' | 'none' | 'unknown'>;

  /**
   * @description Read the backend's OWN registry of open questions for this session and, when it holds one, hand it to the bot as a
   * `question` event — the way a reattach does — so it is shown in the topic. The bot calls it after it closed a copy of a question
   * the registry no longer holds: the question the registry holds NOW was never shown. Best-effort: nothing is emitted for an empty
   * registry or a failed read, and it never throws. Only for a backend that has such a registry ({@link resyncOpenQuestion}).
   * Resolves what became of it, so a caller that counts on the question being shown can tell a failed read from an empty registry.
   */
  surfaceOpenQuestion?(key: SessionKey, exceptRequestId?: string): Promise<SurfaceOpenQuestionOutcome>;

  /**
   * @description Whether this session's turn is wedged behind an open
   * interactive question (the agent's `question` tool is blocking the turn and
   * the bot has no `pendingQuestions` entry to break out with). OpenCode-only:
   * a queued `prompt_async` would sit behind the dead turn forever, so the bot
   * aborts the turn before forwarding a fresh prompt. The check is strict —
   * `true` only when the server reports an open question for THIS session, so a
   * genuinely streaming turn / live sub-agent is never reported wedged (and the
   * normal queue-and-pick-up behaviour is preserved). Async because the
   * authoritative signal is `GET /question` on the owning instance.
   */
  checkIsWedgedOnQuestion?(key: SessionKey): Promise<boolean>;

  // — Output mode —

  /**
   * @description Emit NOW the answer text the adapter has but has not yet sent on: what the backend wrote since the last
   * poll, and what waits in the adapter's own short batch window (a few hundred ms after the last delta) — as the `output`
   * event the window's end would make, without ending the turn. The bot calls it before it posts something straight to the
   * topic (an `answer_request` answer), so the text the agent streamed before that call reaches the bot's output queue — and
   * is landed — ahead of it. A no-op without text pending or a live session. Not implemented by backends that batch nothing
   * (the deprecated tmux scrape).
   */
  flushPendingOutput?(key: SessionKey): void;

  /**
   * @description When true, adapter emits incremental text deltas (not accumulated content).
   * After a status/thinking break, the bot will force a new message to avoid
   * overwriting previous substantial content with new delta text.
   */
  readonly outputsDeltas?: boolean;

  /**
   * @description When true, the backend prints its OWN visible greeting to the
   * topic shortly after the session starts (Claude's TUI banner). The bot then
   * suppresses its `agent.ready` notice (the bot's text would be a redundant lie
   * seconds before the agent's real banner) and instead keeps the typing loader
   * up from start until that first output. Backends that emit nothing on session
   * create (OpenCode = HTTP; terminal = a bare shell) leave it falsy and keep the
   * `agent.ready` / `terminal.ready` cue — without it the user would stare at a
   * loader forever, since nothing ever greets.
   */
  readonly selfGreetsOnStart?: boolean;

  // — Optional TUI controls (Claude CLI specific) —

  sendEnter?(key: SessionKey): void;
  sendArrow?(key: SessionKey, direction: 'Up' | 'Down'): void;
  sendTab?(key: SessionKey): void;
  /**
   * @description `/esc` / `/interrupt`: stop the running turn, keeping the conversation. Claude presses Escape (or sends
   * the stream-json interrupt); OpenCode aborts the generation. Terminal has none ("Not supported").
   */
  sendEscape?(key: SessionKey): void;

  /**
   * @description Interrupt the current turn and resolve only once the agent is
   * idle again, so the caller can forward a fresh prompt without it being
   * queued behind the running turn. Implement it ONLY when the backend ignores
   * queued input while busy: Claude's TUI does (Escape — which also cancels an
   * on-screen selector — then a poll until the busy state clears). OpenCode
   * deliberately does NOT implement it — `prompt_async` queues the new prompt
   * and the turn picks it up quickly, so aborting live work would only lose it
   * (user decision 2026-06-06). Adapters without the method forward directly.
   */
  interruptAndWaitIdle?(key: SessionKey): Promise<void>;

  /**
   * @description Whether an interactive selector/question is currently on the
   * TUI screen. Lets the bot decide whether a short reply (a bare option
   * number or y/n) should DRIVE the selector, versus a free-form message that
   * should break out of it (Escape + send as a fresh instruction).
   */
  isQuestionPending?(key: SessionKey): boolean;

  /**
   * @description Whether Claude's `/login` OAuth "Paste code here" box is on
   * the TUI screen. While it is, the bot routes ANY text reply verbatim into
   * the box (the pasted code is a long free-form string, not a control reply),
   * skipping the prompt path whose Escape would cancel the login and whose
   * preamble would corrupt the code. Only Claude implements it.
   */
  isLoginPastePending?(key: SessionKey): boolean;

  getFullOutput?(key: SessionKey, lines?: number): string | null;
}
