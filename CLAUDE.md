# TelegramCode — project guide

> Shared rules live in `~/src/.claude/rules/` (loaded automatically). This file is
> the **project map**: read it first to understand what the code does before
> changing it.

> **Terminology:** when the user says "чат"/"chat" they mean a **topic** (forum
> thread), NOT the whole supergroup. Read every such request as per-topic.

> **Naming:** the product in prose is **TelegramCode**; the npm package and the
> CLI command are lowercase **`telegramcode`** (legacy `telegramCode` bin alias
> kept; `DATA_DIR` default `~/.telegramCode` deliberately unrenamed).

## What this project is

A Telegram **forum-supergroup bot that proxies user commands and messages to
agentic CLIs** — **Claude Code** and **OpenCode**. The bot itself contains
almost no "AI" logic: its job is routing, session lifecycle, and translating
Telegram input into the right call to the underlying agent, then streaming the
agent's output back into the topic.

**Core mental model — the bot is a proxy/relay.** Most commands are *forwarded*
to the agent rather than handled locally:

- **Claude Code** runs as an interactive TUI inside `tmux`. The bot drives it
  by **writing keystrokes / slash commands** into the pane via `tmux send-keys`
  (e.g. `/model …`, `/clear`, arrow keys, Enter) and scrapes the rendered
  terminal output with adaptive `capture-pane` polling (300ms while the pane
  changes, backing off to 1.5s when it doesn't; an unchanged frame is skipped
  without any parsing). There is no API — it is screen-driving.
  `CLAUDE_SCRAPE_DEBUG=1` logs full RAW/FILTERED scrape chunks (default:
  one-line size summaries).
- **OpenCode** runs as a local HTTP server. The bot talks to it over
  **HTTP + SSE**: it POSTs prompts to `/session/:id/prompt_async` (with a
  `model: {providerID, modelID}` override) and consumes ONE multiplexed
  `/global/event` stream for the WHOLE server. Every event is wrapped in
  `payload` and tagged with a top-level `directory` field; the bot JSON-parses
  each event exactly once and routes it by envelope `directory` + `sessionID`
  to the owning session (plan
  `agent/tasks/actual/2026-06-17-opencode-global-event-stream.md`). The single
  stream opens with the FIRST active session anywhere and closes with the LAST.
  Healthy busy turns keep new `prompt_async` messages queued. A provider-managed
  `session.status=retry` is the exception: it stays visibly busy and posts one
  retry notice; the next user prompt aborts the old provider wait before posting
  with the current `/model`, otherwise a model switch + `continue` sits unread
  behind the old provider's retry deadline.
  (Why not `/event?directory=<workDir>` — the old per-folder model: on opencode
  1.14.41 that endpoint goes silent for an aged sole subscriber, keeping only
  `server.heartbeat` flowing so the stall watchdog never trips → the topic
  hangs. `/global/event` delivers reliably regardless of connection age.)
  Scheduler-MCP is registered per directory on session start (Set-gated, cleared
  on server restart), decoupled from the stream. **Owner resolution is robust
  (plan `agent/tasks/actual/2026-06-08-fix-lost-final-message-and-silent-question-drops.md`,
  S1+S2):** an event routes by `sessionID` (direct id, else child→parent lineage
  ancestor — sub-agents run in CHILD sessions), and when both miss it falls back
  to the envelope's DIRECTORY (the sole active session there, or — when two
  topics share a folder — only the one that is a genuine lineage ancestor, else
  a LOUD drop, never a guess). Events for directories the bot does not own (the
  user's by-hand opencode in other folders, now visible on the global stream)
  drop cheaply at owner resolution — never emitted to a topic. Lineage is
  recorded from ANY event exposing `parentID` (not just `session.updated`) and
  refreshed-on-use so an actively-routing child is never evicted from the
  bounded map. `question.asked`/`permission.asked` are CRITICAL: a genuinely
  unroutable one is logged, never silently swallowed (the old silent drop = the
  user's "question vanished, looked hung" bug).

When adding a feature, first decide: *is this a bot-local concern, or something
that must be proxied to the agent?* If it changes agent behavior (model,
effort, prompt, interrupt), it almost always has **two implementations** — a
keystroke sequence for Claude (tmux/pty) and an HTTP call for OpenCode — and
the two backends often expose the capability very differently (e.g. Claude has
a real `/effort` slash command; OpenCode encodes reasoning effort in model
config/variants, not a per-message API field).

## Key concepts

- **The operator runs ALL forum topics muted.** Design any "the user must
  notice this" signal accordingly: a plain bot message is silently muted.
  Pinning a message DOES pierce a muted topic — it fires a Telegram
  notification (vibration, no sound). This is why a pending agent question is
  pinned (see the question-pin behavior below).
- **A pending interactive question is PINNED so the muted topic notifies.**
  When the agent asks an interactive question the bot pins that message →
  Telegram fires a notification even though the topic is muted; the pin is
  removed when the question resolves (answer / cancel / session teardown /
  leaving the folder). **Exactly one notification per question:** the first pin
  notifies, any re-pin from the existing repost-to-bottom or the Q1→Q2 advance
  is silent (`disable_notification: true`). Both backends, via the shared
  `pinThreadQuestion` / `unpinThreadQuestion` helpers + the in-memory
  `questionPinnedMessageId` map (`unpinChatMessage` is per-message-id, so the
  pinned STATUS banner is never disturbed). **OpenCode** pins its discrete
  question message (`postPendingQuestionAt`), unpins via the single resolve
  choke point `clearPendingQuestion`. **Claude** has no discrete message — the
  scraped selector emit is tagged `isQuestion` (`OutboundHints`) so the bot
  sends it as its OWN standalone pinnable message; a `questionGone` adapter
  event (fired when `extractClaudeQuestion` goes pending→none) drives the unpin.
- **One topic ↔ one project folder ↔ one agent session — the bind is mandatory.**
  Each forum topic binds to a subfolder under `WORK_ROOT` and runs its own
  isolated `claude` or `opencode` session **in that folder**. Two topics can
  point at the same folder for parallel work. **No bind → no agent:** an unbound
  topic refuses every agent-facing action (start, `/sessions`, resume) with a
  "bind a folder first" reply — the agent never runs against `WORK_ROOT` itself
  (the old smoke-test fallback is retired). For OpenCode the bind is the
  server-instance selector: sessions are created and listed in that folder's
  project instance via `?directory=<workDir>`.
- **Launch path defines the work root.** The normal operator workflow is
  `cd <projects-parent> && telegramcode`; when `WORK_ROOT` is unset, the
  wrapper uses `$PWD`. `telegramcode hot` propagates that launch directory to
  its compiled worker too, so `/bind` sees the same root in both modes. Treat
  `WORK_ROOT` as an advanced override for services or containers where the
  process cwd cannot be controlled.
- **Per-thread isolation.** Routing, sessions, MCP config, model/effort prefs,
  and history are keyed per topic by a platform-agnostic `SessionKey`
  (`{platform, space, thread}`); the Telegram connector serializes it to the
  historical `"<chatId>:<threadId>"` form that names state fields, tmux
  sessions and `DATA_DIR` directories.
- **Terminal sessions (`/terminal`).** A topic can bind to a raw interactive
  `$SHELL` (in tmux) instead of an AI agent — a third `AgentAdapter`
  (`terminalAdapter.ts`). The bot proxies the user's text in as keystrokes and
  streams the scraped pane back (stream-only render model: ONE rolling message
  per command). Fresh bot-owned shell per topic (NOT attach-to-existing tmux),
  restart-safe (a live `term-<chatId>-<threadId>` shell re-adopts at boot just
  like an agent — current pane seeds the baseline, no transcript flood; an
  explicitly-stopped shell stays gone). No scheduler-MCP is injected into a
  shell. v1 limitation: full-screen TUIs (vim/htop/less) render messy; normal
  commands stream cleanly. Mutually exclusive with `/claude` / `/opencode`.
- **Restart-safe.** State is persisted to `state.json`; on restart the bot
  re-attaches to the `tmux` session (Claude) or re-connects SSE (OpenCode).
  Per-thread prefs (e.g. OpenCode model) live in `DATA_DIR` JSON files.
  **json-stream Claude sessions survive restarts too** (plan
  `agent/tasks/completed/2026-07-05-jsonstream-restart-isolation.md`): the
  process is EXTERNAL (tmux `cjson-…`, stdin on a FIFO it holds `0<>`, stdout
  appended to `DATA_DIR/jsonstream/<chatId>_<threadId>/stdout.jsonl`), so a bot
  restart neither EOFs its stdin nor loses output — the restarted bot ADOPTS
  the session, resumes the stdout tail from the persisted line-boundary offset
  (`agents[key].jsonStreamTail`) and replays the downtime gap through the
  normal pipeline: **the in-flight turn is delivered end-to-end** (no recap
  posted — the replay is the delivery; a recap fires only on the dead-process
  `--resume` fallback). A pending AskUserQuestion survives via the host dir's
  `question.json` sidecar. Consequently `tmux` is a REQUIRED dependency for
  BOTH Claude backends (as it already was for scrape/terminal).
  If the `opencode serve` process crashes, the bot auto-restarts the server
  and **restores** each active session by re-resuming its persisted id
  (sessions persist on opencode disk; the in-flight reply is lost).
  `ensureOpenCodeServer` also reconciles VERSION, not just liveness: if a server
  is already up but running an OUTDATED binary (its `/global/health` version ≠
  on-disk `opencode --version` — a stale long-lived process after opencode was
  updated, whose old code dies on the migrated shared `opencode.db`, e.g. `no
  such column: …`), it is killed (own child, else by PID on the port) and
  respawned on the current binary instead of being adopted. Only a CONFIRMED
  mismatch restarts (`checkIsOpenCodeServerStale`); an unknown version adopts as
  before. Explicit
  `/quit`, `/quit-all`, and leaving a folder (the `/bind` «leave
  current dir» button) instead **release** the persisted session ids — so a
  later bot restart does NOT auto-reattach those sessions (they stay reachable
  only via the `/sessions` picker).
- **Startup-safe input.** A session has an async boot window (Claude tmux/pty,
  OpenCode server + `POST /session`). Prompts typed during it are buffered
  (`startupPromptBuffer.ts`) and replayed in order when ready — never dropped.
- **Boot readiness status.** At startup the bot tells the owner whether it can
  work, or lists the setup steps still missing (create+pair a forum group, grant
  the bot Manage Topics / Pin / Delete, bind a topic, install an agent CLI; plus
  optional groq/owner hints). **Delivery depends on readiness
  (`resolveStartupTargets`):** the "✅ Ready" status is owner-DM-ONLY
  (`OWNER_USER_ID`) — it is noise in the shared group, so it NEVER falls back to
  General (and a ready-status owner-DM 403 does NOT fall back either); no owner DM
  ⇒ nothing is sent (log only). The General fallback is reserved for the
  ACTIONABLE not-ready checklist, which tries the owner DM first then General on a
  403 / unset owner, else console-only. Cold start always sends; a hot reload
  stays silent when fully ready. Decision logic
  is pure (`utils/startupReadiness.ts`); `bot.ts` gathers live facts + sends it
  just BEFORE `bot.launch()` (Telegraf v4's long-poll `launch()` never resolves
  until the bot stops, so post-launch code would only run on shutdown).
- **Agent start UX — one-tap start + ONE typing loader.** The post-bind welcome
  buttons (▶️ Claude / ▶️ OpenCode) START the chosen agent in one tap (the
  `agent_<name>` callback funnels through `handleAgentStart`, the shared core
  also behind `/claude` `/opencode` `/terminal`), not a select-then-type step.
  The sole "agent is working" cue is the native typing indicator (`startTypingLoader`
  re-fires `sendChatAction('typing')` every `typingLoaderRefreshMs`; it REPLACED
  the old `⏳` placeholder message). It runs at every wait point — a self-greeting
  agent's boot AND every prompt forward. It is a PERSISTENT working state (S3):
  each tick keeps firing while `checkShouldKeepTyping` holds — output mid-flight
  (`checkIsOutputStreaming`), the adapter is busy (`checkIsBusy`), OR a bot-issued
  compaction is in flight (`isCompacting`, read from `threadsCompacting`) — and
  SELF-STOPS only when the topic is truly drained + idle + not compacting (pure rule
  in `utils/typingActive.ts`). The compaction input exists because the other two are
  BOTH false while summarising (OpenCode sets no busy flag for `summarize`, and
  neither backend streams output), which left a 43 s — or 3-minute — compaction
  showing nothing at all. It is NOT cleared on the first output or a status
  frame any more (that made the topic look idle mid-answer); hard teardown paths
  (session end / question UI / unbind / start-fail) still call `stopTypingLoader`.
  There is NO timeout, so a long-thinking agent keeps showing it. An adapter that prints its own greeting
  declares `selfGreetsOnStart` (Claude's TUI banner) — then `startAgentSession`
  suppresses the bot's `agent.ready` notice (returns `''` via `getStartReadyMessage`)
  and keeps the loader up until that banner lands. OpenCode/terminal don't
  self-greet, so they keep the `agent.ready` / `terminal.ready` cue (and boot uses
  a one-shot typing ping, not the sustained loader — no output is coming yet).
  **The `agent.ready` notice names what the session will run with** — a `{infoBlock}`
  (in every locale, right above the closing "Send a message:") carries `🧠 Model:`
  (`agent.ready_model`; an unresolved model degrades to the `model.current_default`
  text `/status` and `/model` already show) plus the SHARED `effort.current_hint`
  block (`⚙️ Effort: …` + the `/effort` pointer). `getStartReadyMessage` stays PURE:
  `startAgentSession` resolves both first — effort by the `/status` rule
  (`getEffort` absent ⇒ `null` ⇒ no effort line, else the pick or `defaultEffortLevel`),
  model via `getThreadStatusModel` with `runtimeModel: null` DELIBERATELY (the runtime
  self-report is an async transcript/HTTP read that must not enter the start path).
  Both `null` ⇒ the block collapses to `''` and the notice reads exactly as it did
  before it existed. `terminal.ready` has NO block — a shell has neither setting.
  **Because the notice names the model, the backend must NOT announce it again:**
  OpenCode's `startSession` resolves it SILENTLY (`fetchModelInfo(key, false)`,
  like `resumeSession`) — resolution still runs (it populates
  `modelOverride`/`currentModelLabel` for the notice, `/effort`, and the prompt
  body), only the emit is dropped. With `emitOutput` left on, every `/new` /
  `/opencode` start posted a SECOND bare `Model: <label>` message (live 2026-09-14).
  The two REMAINING `Model:` emits are deliberate: a transient `/config` failure
  leaves `isModelInfoShown` false so the first assistant message corrects the label
  out loud (B9), and `setModel` resets that flag so the next turn confirms the new
  model actually took effect server-side.
- **Streaming output appends, never overwrites.** OpenCode streams a reply as
  incremental tails; every `output` emit after the first of a response carries
  `isContinuation: true` (`OutboundHints` in `platform/outbound.ts`). The bot appends a
  continuation to the message it is already rendering — re-rendering the FULL
  accumulated text (so `**`/`` ` `` pairs split across flushes re-pair) and
  editing in place; when the combined text outgrows the Telegram cap it spills
  into a new message and keeps growing there (pure planner:
  `connectors/telegram/outputFlushPlan.ts`). Non-continuation outputs ALWAYS send a new
  message — the old edit-in-place for fresh outputs silently replaced interim
  texts (live bug 2026-06-05). Claude's adapter never marks continuations, so
  its flushes stay one-message-each.
- **Send pacing & ordering — global 1/2s FCFS gate, 3s debounce, backlog glue**
  (plan `agent/tasks/actual/2026-07-04-send-limits-ordering-global-pacer.md`).
  With two topics streaming at once the bot used to overrun Telegram's per-chat
  budget → a sustained 429 storm. Now ONE process-wide `GlobalSendPacer`
  (`rateLimiter.ts`) releases at most one send every `globalSendIntervalMs`=2s
  across ALL chats (supergroup + owner DM), FCFS — CLOCK-BASED and non-blocking,
  so a slow/stuck send never head-of-line-blocks others (it replaced the per-chat
  priority `TokenBucket`; `enqueueSend` no longer takes a priority — pure FCFS
  temporal order, no class jumps the line). An aborted final waiter cannot leave
  a stale timer that grants a later send early. Cancellation rejects while a send
  is parked in the per-thread/pacer queues; once its operation starts, the caller
  awaits the operation and cleanup instead of racing them. Each topic coalesces its own stream
  at a 3s output debounce (`OUTPUT_DEBOUNCE_MS`, up from 1s; `isFinal` still
  flushes now). When a topic BACKS UP (≥3 messages queued) the flush GLUES the
  backlog into the fewest `\n\n`-joined messages (pure `connectors/telegram/outputBacklogGlue.ts`,
  wired at `sendOutputImmediate` fresh-path + `sendAgentChunks`) so a burst drains
  in one send. The old bounded post-cooldown REDELIVERY + `send.degradedUnderLoad`
  notice are RETIRED — at 1/2s a 429 is essentially impossible, and the late
  re-send was the OUT-OF-ORDER cause the user reported; `withRateLimitRetry`'s
  single retry-after wait stays the floor, a rare double-429 just logs. The group
  transport's `finalizeInFlight` still drains the coalesced-but-unsent buffer to a
  permanent message on settle/teardown (`finalizeGroupOutput` + pure
  `utils/groupFinalizePlan.ts`, idempotent, per-key in `both`) so the final
  answer is never discarded. While in a 429 cooldown the output debounce
  (`utils/outputFlushTiming.ts`) still scales to the LIVE remaining cooldown
  (`max(normal, 5s floor, remainingCooldownMs)`) as a harmless safety net.
  **Two deliberate UNPACED exceptions** ride `sendUnpaced` (`rateLimiter.ts`:
  429-retry + rate-summary kept, but NO pacer permit and NO per-thread FIFO):
  the typing indicator (`sendChatAction` is not a message → not subject to the
  message flood limit, yet it was eating ~60% of the paced budget) and the
  voice-path acks (`replyToThread` opt-in `unpaced` flag): the transcript 🎤
  echo — the user's own input ack must not queue behind agent output; was up to
  182s late under load, now sub-second — and the `voice.retrying` notice that
  precedes it (paced, it could land AFTER the retry's echo). Agent output NEVER
  goes unpaced — this is not a priority class inside the pacer, it is a small
  closed set of rare non-output sends moved out of it (plan
  `agent/tasks/completed/2026-07-05-unpace-typing-and-priority-acks.md`).
- **Output transport seam (CHAT_MODE-selected).** HOW agent output reaches a topic
  is chosen ONCE at boot by `CHAT_MODE` via `createOutputTransport` (`src/connectors/telegram/output/`),
  mirroring the `AgentAdapter` factory — no per-call surface branch. **Group** =
  the `queueOutput` edit-in-place path above. **DM** (`src/connectors/telegram/output/dmOutputTransport.ts`)
  = the live "cursor" draft: ONE accumulating native `sendMessageDraft` holds the
  full current reply, FINALIZED to a permanent `sendMessage` on boundaries (idle
  ~4s / 4096 overflow / isFinal / new-response / status / teardown); `isComplete`
  one-shots post directly. **Both backends stream via the cursor** now: OpenCode
  marks `isContinuation` directly; the Claude scrape adapter emits each poll's
  classifier-filtered prose delta with NO meta, so the DM transport synthesises the
  continuation flag (`getDmDraftContinuation`, gated on the adapter's
  `outputsDeltas`) — its deltas accumulate into ONE full-snapshot draft instead of
  finalizing per poll. Tools/status stay separate transients. The Claude liveness
  heartbeat is kept noop while a draft is active (`OutputTransport.checkIsStreaming`
  ORed into `checkIsOutputStreaming`) so it can't insert a status frame between
  deltas and chop the draft mid-answer. `OutputTransport` interface lives in
  `types.ts`. In **`both`** the factory returns a DISPATCHER that routes each
  per-thread call by `checkIsDmKey(key)` to a once-built DM impl or group impl —
  so one instance streams the owner DM via the cursor AND the group edit-in-place
  at the same time.
- **CHAT_MODE — one surface or both (default `both`).** `CHAT_MODE` selects which
  Telegram surface(s) the instance serves: `group` (forum supergroup only), `dm`
  (the owner's private chat only), or `both` (DEFAULT) — ONE instance serves the
  owner DM AND the group at once, decided PER CHAT off the resolved `SessionKey`
  (`checkIsDmKey(key) = getTelegramChatId(key) === ownerUserId`, since a DM key
  carries the owner's chat id). `OWNER_USER_ID` is REQUIRED for `dm`; for `both` it is
  OPTIONAL — unset → the DM surface is INERT (group-only, boot logs a notice), so
  a bare `telegramcode` stays backward-compatible with a group-only deploy and
  lights up DM the moment `OWNER_USER_ID` is set. Access stays per surface: the
  owner id gates the DM chat, the served group's admin cache gates the group chat
  (`checkIsAllowedUser(ctx)` is the single per-chat authority). The bi-surface
  key resolution (`resolveThreadKeyForMode`) and discriminator
  (`checkIsDmThreadKey`) are pure in `threadRouting.ts`; `bot.ts` wraps them with
  the runtime config.
- **Two-instance ready.** A "pet" and a "work" instance can run on one host with
  isolated `DATA_DIR`, group, and OpenCode port. (Orthogonal to `CHAT_MODE=both`,
  which serves both surfaces from ONE instance — use two instances when you want
  process-level isolation/distribution instead.)
- **MCP hierarchy (opt-in, mostly dormant — NOT a documented feature).** MCP
  servers merge across user / group / project / thread scopes with `${VAR}` env
  expansion, BUT the group (`${DATA_DIR}/mcp.json`) and thread
  (`${DATA_DIR}/threads/<key>.json`) layers are opt-in: `prepareMcpFlags`
  (`mcpConfig.ts`) emits a `--mcp-config` for them ONLY when the file exists, so
  a default install passes none. In practice the always-on consumer of the
  `--mcp-config` plumbing is the bot's OWN injected `telegramBot` server (next
  bullet) — the user-editable group/thread hierarchy exists in code but is
  unused by default, so the README deliberately does NOT document it (cut
  2026-07-12). User + project layers are claude-native (auto-loaded,
  bot-independent).
- **Agent scheduling tools (injected).** Separately from that user hierarchy,
  the bot injects its OWN `telegramBot` MCP server (HTTP, loopback `127.0.0.1`,
  per-session thread/dir-scoped HMAC tokens + a fresh client UUID) into EVERY bot-started session —
  Claude via a bot-generated `--mcp-config` file (thread-scoped), OpenCode via
  runtime `POST /mcp?directory=` (dir-scoped, re-registered after a server
  restart AND self-healed on every BOT boot: `reconcileSchedulerMcpForActiveSessions`
  reads the live `GET /mcp` per active dir and force re-registers any `telegramBot`
  that is missing or not `connected` — opencode does NOT auto-reconnect a remote
  MCP dropped during the bot-restart gap, which otherwise stranded every dir's
  tools; fire-and-forget so boot never blocks on opencode). A registration or
  reconcile that FAILS is retried after 15 s, 1 min, 5 min and 15 min
  (`schedulerMcpRetryDelaysMs`) while the folder still has an active session; each
  retry reads `GET /mcp` first, because a POST that timed out may have landed.
  Live, the first POST after a server restart timed out at 30 s and the folder's
  agent had no `telegramBot` tools until the next bot boot. The json-stream
  Claude side gets the same boot self-heal (`healSchedulerMcpForActiveSessions`
  → the adapter's `healMcpServer`, fire-and-forget per thread, logged only when
  a session was really reconnected or did not answer): a session that SURVIVED
  the restart keeps a `failed` `telegramBot` entry for good — its MCP client
  never retries one — so the bot asks `mcp_status` over the stdio control
  channel and reconnects only the failed ones. The scheduler MCP
  listen port is OS-ephemeral by default but PERSISTED in `state.json`
  (`schedulerMcpPort`) and reused across restarts so injected URLs stay valid
  (env `SCHEDULER_MCP_PORT` pins it and wins). This server exposes the `schedule_*` tools plus `compact_conversation`
  (agent→bot self-compaction — F1, thread-scoped; arms a compaction that runs when
  the current turn ends, never mid-turn; call only on an explicit user request) plus
  `answer_request` (the agent's answer to a request — `requests/answerRequest.ts`) plus `send_file_to_user`
  (agent→user file/image send into the topic, dir/thread-scoped exactly like the
  `schedule_*` tools — no new server/port/token/injection) and `send_messages_to_user`
  (agent→user per-message delivery: each array item posted as its OWN Telegram
  message, never merged — the opt-in path behind a per-item news digest; same
  dir/thread scope. Each item may be a plain text string OR an object
  `{text?, path?, as_file?}` carrying ONE attachment: a `path` item REUSES the
  same secure `send_file_to_user` pipeline (single path, `text` → caption trimmed
  to 1024 chars, `as_file` document override, `.mp4`→sendVideo rule, dir-scoped
  `authorizedWorkDir` re-check), so a digest can interleave text and media in one
  call. A file `deliveryUnknown` terminates the batch non-retryably) and is bot-owned
  plumbing; it is NOT part of the user-editable `/mcp` hierarchy and never
  touches the user's group/thread config files. Builders live in
  `scheduler/injection.ts`, configured at boot BEFORE any session is
  re-attached or resumed (`runSessionBootPhase` / `startSchedulerMcpForBoot` in
  `scheduler/mcpBoot.ts`, over the server `wireScheduler` builds in `bot.ts`), so
  a session spawned in the boot window is never born without it (if the MCP
  server fails to bind its port, the bot still boots — injection stays inert and
  sessions spawned that run lack the agent-facing tools; a Claude one keeps
  lacking them after a later restart, since the heal never adds an absent
  server). A
  single MP4 uses Bot API `sendVideo`; eligible all-video and mixed photo/video
  albums use `sendMediaGroup` with `InputMediaVideo` entries for MP4s.
  `as_file:true` is the explicit document override, and a silent MP4 needs no
  fake audio track. `utils/fileSendService.ts` owns the reusable path/snapshot/
  plan/request-dispatch pipeline: it captures each canonical file's bigint
  device/inode identity, pins one canonical root across every album item, and on
  Linux traverses from a pinned root descriptor with per-component `O_NOFOLLOW`.
  macOS fails this tool closed until a native descriptor-relative bridge exists.
  The service verifies the opened identity and owns the pinned
  file descriptor through gateway completion. `bot.ts` injects the real target
  resolver, one `executeDelivery` seam backed by `enqueueSend`, and five direct
  gateway methods. The delivery callback keeps gateway dispatch AND atomic,
  durable message-id recording inside one per-thread queue transaction; the
  complete Telegram response-ID batch reaches `state.json` before success. Every retry callback
  creates a fresh `autoClose:false` positional stream bounded to the validated
  snapshot size; a zero-byte snapshot uses a fresh in-memory empty `Readable`.
  Each attempt registers stream completion before sending, destroys unread
  streams on an early rejection, and waits for every stream to become terminal
  before `withRateLimitRetry` can start the next attempt. Telegram API errors
  remain retryable; a non-API failure after invocation becomes a typed
  delivery-unknown result that says Telegram may already have accepted the send
  and MUST NOT be retried automatically; the MCP result is non-error structured
  content `{ kind: 'deliveryUnknown', retryable: false }`. Once the gateway returns, delivery is
  final: a later message-id recording or descriptor-cleanup
  failure stays `ok:true` with a warning so the agent cannot duplicate the
  already-delivered message/album by retrying. Request cancellation removes
  parked snapshot/pacer/FIFO/retry waiters. While any request-body stream remains
  unconsumed it destroys the streams and aborts the active Telegraf `callApi`,
  surfacing `AbortError` only after terminal cleanup. Once every stream has ended,
  caller cancellation is not forwarded because Telegram may already have accepted
  the upload; instead an unref'ed 30-second response deadline starts. Expiry aborts
  Telegraf, awaits sender cleanup, and returns delivery-unknown without retrying;
  returned message IDs still win at the deadline boundary and are durably recorded.
  A directory-scoped request carries its
  canonical authorised directory into the service, which re-resolves the topic
  after snapshot admission before opening files and again inside `executeDelivery`
  immediately before dispatch, refusing a binding that changed in either queue.
- **Scheduled prompts (`src/scheduler/`).** A topic can have scheduled prompts:
  at fire time the bot posts the prompt into the topic, PINS the announcement
  (pins accumulate as run history — the bot never auto-unpins; per-job
  `isPinSilent` makes the pin not notify members, default notifies), then
  delivers the prompt to the topic's agent — reusing an active session
  (waiting for idle up to 10 min rather than interrupting live work) or
  starting one with the thread's last-used adapter. Created via `/schedule`
  (prompt wrapper) or by the agent itself (`schedule_create/list/cancel` MCP
  tools; cron / one-shot / N-times, min interval 5 min, ≤30 agent-prompt jobs per
  thread — the cap exists to muzzle a looping model, and `/reminders` jobs are
  counted under their own separate, much looser cap).
  **`schedule_create` is agent-robust** (`buildSpecFromCreateArgs`): a one-shot
  (`onceAt`) IGNORES a redundant `repeatCount` instead of erroring (a one-shot
  always runs once — the agent naturally sends `repeatCount:1` to mean "run
  once"; rejecting it made the model spiral into absurd counts / a wrong-year
  cron), empty/whitespace `cron`/`onceAt` normalise to absent, and a structural
  error (both/neither field) echoes the exact 3-mode recipe so a bad call teaches
  the corrected next call. ALWAYS use `onceAt` for a single future run, never a
  cron — cron has no year and would re-fire every year.
  Restart-safe: timers re-arm from `state.json` at boot and missed runs fire
  ONE catch-up annotated with the missed time. Leaving a folder (the `/bind`
  «leave current dir» button) pauses the thread's AGENT-PROMPT jobs and checks
  (one notice; reminders are exempt — see below); `/bind` resumes them from now (an expired
  one-shot is dropped). Run history: `DATA_DIR/scheduler-runs.jsonl`.
  **Delivery kinds.** `ScheduleRecord.deliveryKind` is ABSENT for the
  agent-prompt job described above; `'reminder'` marks a bot-local `/reminders`
  job, and the fire path BRANCHES on it (`checkIsReminderSchedule`) right after
  the pin: announce → pin → `delivered`, so `ensureSession` / wait-for-idle /
  `forwardPrompt` are never reached — which is exactly what lets a reminder fire
  in an unbound topic and in General. The unbound pause reads the same
  discriminator (`getUnboundPausableSchedules`): pausing a reminder would stop
  the one kind that needs neither folder nor agent, so a thread holding only
  reminders pauses nothing and posts no notice. Reminders are also FILTERED OUT
  of the agent-facing `schedule_list`, and `schedule_cancel` answers the plain
  "no schedule with this id" for a reminder id — the agent must not be told a
  bot-local reminder is a scheduled prompt it can act on, nor be able to delete
  something the operator created with buttons and never handed to any agent. **The
  per-thread cap is counted PER KIND** (`createScheduleForThread` filters by
  `checkIsReminderSchedule` and compares against that kind's limit —
  `maxSchedulesPerThread` 30 for agent-prompt jobs, `maxRemindersPerThread` 100 for
  reminders): the storage is shared but the counters are not, so neither creator
  eats the other's slots, and the agent's cap message can stay the plain sentence
  because every slot it names is one `schedule_list` shows and `schedule_cancel`
  can free. One shared counter did both harms — a topic with 30 agent jobs offered
  the operator no reminders, and a topic with 25 reminders + 5 agent jobs told the
  agent "maximum of 30" beside a list of 5, so it cancelled everything it could see
  and looped.
  **Watchdog checks (`deliveryKind: 'check'`).** `schedule_create` with
  `checkCommand` (+ optional `checkTimeoutSeconds`, default 60, max 600) makes the
  job a watchdog: at fire time the BOT runs the command (`/bin/sh -c`, cwd = the
  bound folder, own process group so a timeout stops everything it started, bot
  token removed from its env because the output is posted) — `scheduler/checkRun.ts`.
  Exit 0 posts nothing. The FIRST failure after a pass (non-zero exit, timeout, or
  a shell that cannot start) stores `isCheckFailing`, posts + pins the alert
  (`schedule.checkFailed`: failure, command, output tail) and wakes the agent
  through the normal ensure-session / wait-for-idle / forward steps with a
  `[Scheduled check "<name>" failed]` prompt (failure, output tail, then the job's
  `prompt`). Later failures stay SILENT until a run passes again, which clears the
  flag and posts one unpinned `schedule.checkRecovered` line
  (`getCheckAlertDecision`). The flag is stored before the agent is woken, so a
  restart mid-delivery never repeats the alert. Checks count against the agent's
  30, show in `schedule_list` with their state, and pause on unbind like prompt
  jobs. Why it exists: watchers an agent builds itself (background loops, `nohup`,
  `sleep` loops, tmux panes) die with the session or a restart and then fail
  silently — the MCP `instructions` and the `schedule_create` description tell the
  agent to use a check and never build its own watcher. The command runs as the
  bot's user, the same user the agent's own shell tools run as.
- **One instance-wide timezone (`/timezone`).** The operator declares their zone
  ONCE and every clock the bot touches speaks it. The mechanism is
  `process.env.TZ` — process-global by nature, which is exactly why the setting
  is per INSTANCE, not per chat or topic (two chat-scoped zones could not both
  be true in one process). Applied at boot right after the state store loads and
  again on every `/timezone` change through the same `applyProcessTimezone`;
  because assigning `TZ` re-bases `Date`/`Intl` immediately, every existing
  host-local render (cron fire times, "missed at HH:MM", `/timestamps`, schedule
  descriptions) becomes correct with no per-call-site threading. Absent by
  default ⇒ host zone ⇒ an install that never ran `/timezone` is unchanged.
  Beyond the clocks it also feeds the AGENT: `/schedule` carries the current
  instant + zone, and the thread-context preamble carries the zone name — so
  "tomorrow at 9" resolves against the operator's clock instead of the model's
  guess. See the `/timezone` command entry below for the scheduler trap it
  avoids.
- **Thread-context preamble.** The bot prepends a `[Telegram thread context]`
  block (topic name, group title, `chatId:threadId`, bound folder, instance
  timezone) to the forwarded prompt so the agent knows WHERE — and on which
  clock — it works. The zone rides here because it is STATIC for a session; the
  current INSTANT stays on the per-prompt paths (`/timestamps`, the `/schedule`
  templates), since a value that changes every message would re-inject the
  preamble every message. Built in
  `threadContextPreamble.ts`; injected in `forwardPromptToAgent` (the single
  choke point). Rides the next prompt only when it changed since last sent —
  per-thread in-memory marker, reset on session start/stop/closed and on
  forwarding a bare `/clear`. Topic name comes from `forum_topic_created` /
  `_edited` (persisted on the binding); the group title from an
  in-memory cache fed by authorised updates. Slash commands skip the preamble.
- **Reply-quote context.** When the operator uses Telegram's REPLY feature on a
  message in a bound, agent-active topic, the bot folds the replied-to message's
  content into the forwarded prompt (agent-facing English `[Replying to an
  earlier message · from: assistant|user]` + `> `-quoted text, placed between the
  thread-context preamble and the user's prompt — part of the per-message body,
  like the `/timestamps` line, NOT the once-per-change preamble marker). Content
  selection is first-non-empty of the manual (highlighted) quote → replied text →
  caption, capped at `replyQuoteMaxChars` (4000) with a `… [truncated]` marker.
  It rides the single `forwardPromptToAgent` choke point, so Claude (all
  backends) and OpenCode get it identically. Pure helpers in
  `utils/replyQuote.ts` (`extractReplyQuote`, `buildReplyQuoteBlock`); the impure
  telegraf bridge is `getReplyQuoteBlock` in `bot.ts`. v1 excludes terminal
  topics (raw shell, bypasses the choke point), forum/service and topic-root
  messages, no-text replies, and pending-question digit answers.
- **File intake.** A file sent to a bound, agent-active topic (photo,
  document incl. PDF, video, video_note, audio, animation) is downloaded into
  `DATA_DIR/files/<chatId>_<threadId>/` (bot-owned, never inside the bound
  project folder) and announced to the agent through `forwardPromptToAgent` as
  `[Telegram file] <kind> saved to: <path> (<size>)` + caption. Idle/unbound
  thread → same friendly hint as plain text, nothing downloaded; file over the
  20 MB Bot API cap → `file.too_big` reply. A **media album** (multiple files
  sent as one visual message; arrives as N messages sharing `media_group_id`)
  is batched by `(thread, media_group_id)` with a ~2 s debounce after the last
  item into ONE combined `[Telegram album]` prompt (one bullet per saved file +
  the album's caption), so the N items no longer abort each other and gating /
  error hints fire once per album, not N times. The batcher lives in
  `utils/mediaGroupCollector.ts` (pure, debounce + per-group one-shot hint
  guard); prompt text in `buildAlbumPromptText`. **Voice is NOT intake** — it
  stays on the transcription path. Two cleanup mechanisms: a forwarded bare
  `/clear` purges the thread's files dir (agent context gone → files useless),
  and a daily + at-boot age sweep deletes files older than `fileRetentionDays`
  (30). Pure helpers in `connectors/telegram/fileIntake.ts`; storage/janitor in
  `botFileStorage.ts`.
- **Auto-retry on API errors (`src/apiErrorRetry.ts` + the `bot.ts` retry
  manager; plan `agent/tasks/completed/2026-06-09-api-error-auto-retry.md`).**
  When the agent dies on a provider API error the bot doesn't leave the topic
  looking hung — it classifies the error and auto-resumes after a backoff.
  Detection is at the **adapter boundary** via the `apiError` event: OpenCode
  classifies in `handleSessionError` (`session.error`, structural); Claude runs
  the scraped pane through `getClaudeAgentErrorLine` — a line STARTING with
  `API Error:`, OR a `⎿` result row that contains `API Error:`, OR a row whose
  content LEADS with a logged-out phrase (`not logged in` / `please run /login` /
  `invalid authentication credentials`) or with a usage/session-LIMIT phrase
  (`You've hit your session limit · resets 10:50pm (UTC)` carries no `API Error:`
  marker at all; the phrase alternation is shared with the classifier via
  `usageLimitPhraseSource`, and the row may lead with up to three
  punctuation-free words so "You've hit …" still matches while a quoted log/path
  prefix cannot; because this shape has NO glyph/`API Error:` anchor it needs a
  SECOND signal — the row must also read like an error, `reached`/`exceeded`/
  `resets`/`try again`/`·`, else the agent's own prose about limits
  ("Session limits reset weekly") fires a bogus episode) — then `classifyAgentApiError`,
  behind a one-shot guard. **Two false-positive guards (both live 2026-07-03,
  topic 201):** (1) detection scans the NEW pane delta only, never the full pane
  — a stale `⎿ … /login` row lingers in the scrollback long after re-login, and
  the guard re-arms on redraws, so a full-pane scan re-fired every poll and
  oscillated against the recovery-clear, re-pinning "logged out" AFTER a
  successful login; the line-SET diff puts the row in the delta only on its FIRST
  render → one fire per logout episode. (2) the auth phrase must LEAD the `⎿` row
  (Claude's `⎿ Not logged in · …` format), because TOOL results (Bash/Read/Grep)
  are ALSO rendered under `⎿` — a result row that merely QUOTES the phrase deeper
  in the line (the agent grepping the bot's own logs, a `gh`/`npm` "not logged
  in") would otherwise fire; a real logged-out row leads with it, a quote embeds
  it after other text. Classes (markers verified against the `claude.exe`
  string table): *transient* (rate-limit / overloaded / 429·503·529) → retry
  +5/10/20 min, 3 tries; *usageLimit* → +60 min re-armed each repeat up to 6×, or
  the parsed reset time; *auth* (login / bad credentials) → **never retried, but SURFACED**: a deduped,
  PINNED logged-out notice (Claude → send `/login`; OpenCode → restart the
  server), one notification per episode, cleared on recovery (first real output
  after re-login) and at teardown — pre-fix a logged-out Claude emitted NOTHING
  and looked hung (live 2026-07-01, topic 201; plan
  `agent/tasks/completed/2026-07-01-surface-logged-out-agent-notice.md`). On a
  retryable fire the bot posts a notice and nudges the still-live session with a
  neutral "continue" via `forwardPromptToAgent` (NEVER a wait-for-idle path —
  OpenCode's optimistic `isBusy` is not cleared on `session.error` and would
  stall the 10-min cap). Any user message / `/new` / `/quit` / leaving a folder
  cancels a pending retry; pending retries survive a bot restart (`state.json`
  `apiRetries`, re-armed after reattach).
  **Limit wordings + the reset clock (`checkIsUsageLimitText` / `parseResetAt`).**
  The *usageLimit* vocabulary is two-tier: an explicit list (qualified
  `session`/`weekly`/`daily`/`monthly`/`hourly`/`N-hour` limits, `hit your … limit`,
  a bare `limit reached`, credit/quota exhaustion) PLUS a GENERIC fallback — a
  limit mention AND a reset/retry hint (`resets` / `try again` / `resumes`). Both
  signals are required so ordinary prose ("the API limit is 5 requests per minute")
  stays unmatched, while a wording the provider invents later still arms. Ahead of
  both tiers sits one NEGATIVE guard: a context / token / prompt-length limit is a
  limit no wait can clear (the real 400 reads "input length and `max_tokens` exceed
  context limit … and try again", i.e. limit + retry hint), so it classifies as
  `null` and is relayed instead of arming a 6-hour futile wait — unless the text
  ALSO names a usage window ("hit your weekly token limit"), which is a real limit.
  `parseResetAt` also reads `resets <clock>` with no "at", and an EXPLICIT zone
  suffix (`(UTC)`, `UTC`, `GMT`, `Z`, `±HH:MM`) is load-bearing: the clock is then
  resolved IN THAT ZONE, because reading `10:50pm (UTC)` as instance-local fires the
  retry hours early, re-errors, and burns an attempt.
  **`/auto_continue_limits` gates the usageLimit class ONLY** (per-thread override,
  General sets the instance default, ON by default; `state.json`
  `autoContinueOnLimitEnabled` + `autoContinueOnLimitOverrides`). OFF ⇒ one
  "auto-resume is off for this topic" notice per episode and NO timer/record;
  *transient* and *auth* are untouched by it. When it is ON, the arming notice ends
  with the shared `autoContinueLimits.noticeHint` pointer (one key, appended at one
  choke point, so the reset-time and "in N min" variants cannot drift), and the
  resume message for a *usageLimit* fire is a PINNED, NOTIFYING message (the wait
  can last hours in a muted topic) retired by `cancelApiRetry` — i.e. on the next
  user message or any teardown — and by the arming of the NEXT limit wait, so a
  fully autonomous topic (no user message between episodes) still notifies each
  time instead of leaving one stale pin and going silent.
  **Boot recovery of a pre-restart episode (`utils/limitEpisodeRecovery.ts`).** An
  UNRECOGNISED limit left nothing persisted, so the topic stays parked after a bot
  update. At boot, after `restoreApiRetries`, each active json-stream Claude thread
  with no armed record (and with the toggle ON — an OFF topic is skipped outright,
  or every hot reload would re-post its OFF notice for the same stale error) has the
  TAIL of its `stdout.jsonl` (64 KB, never the whole
  file) re-read: a trailing terminal `result` error classifying as *usageLimit*,
  younger than 12h, is replayed through `handleApiError` so notice/timer/persistence
  behave identically to a live error — and the log's identity (size+mtime) is
  stamped into `state.json` `limitEpisodesRecovered`, so an UNCHANGED log is never
  recovered twice (a skip / takeover / give-up clears the armed record but leaves
  the same trailing error, and hot mode reloads on every code change).
  JSON-STREAM ONLY — the tmux pane and
  OpenCode's SSE leave no comparable on-disk evidence.
  **Live-verify caveat:** a Claude
  rate-limit / 401 isn't inducible on demand, so the `getClaudeAgentErrorLine`
  cases are covered by unit tests against REAL scraped samples, not a live repro.
  If a Claude API error did NOT trigger, grep the bot log for `[Claude] API
  error detected`: absent ⇒ the detector missed the line and needs another case.

## Module map (`src/`)

| File | Responsibility |
|------|----------------|
| `cli.ts`, `cli/bot.ts`, `cli/botEntry.ts`, `cli/applyDnsFix.ts` | Public CLI dispatch, shared bot startup/DNS setup, and the internal hot worker entry. The old public `bot` subcommand is retired; nodemon runs `botEntry.ts` directly |
| `cli/envLoader.ts` | Load `.env` (config dir + per-project override) |
| `cli/lock.ts` | Single-instance lockfile |
| `bot.ts` | **The bot.** Telegram handlers, all slash commands, output streaming. Commands are registered on the neutral `commandRouter` and reach it through ONE telegraf text trigger. Large — most logic lives here |
| `threadRouting.ts` | Resolve which project folder a forum topic is bound to |
| `accessControl.ts` | Who may use the bot: `getElevatedMemberIds` + `AdminCache` (the served space's ids with elevated rights, fetched through the connector's `listMembersWithElevatedRights`, cached 1h; an admin-status change in the served space invalidates the cache immediately — the connector's `checkShouldInvalidateAdminCache`, subscribed via `allowed_updates` at launch). Platform-neutral: it speaks `PlatformMember`, never telegraf's `ChatMember`. No allow-list env, no `/grant` |
| `state.ts` | Persistence (`state.json`): bindings, sessions, pairing; `resolveDataDir()`. The `/compact_summary` toggle lives here (`compactSummaryEnabled` instance default + `compactSummaryOverrides` per-thread map, same shape/discipline as the `compactOnIdle*` pair — an explicit `false` stored, never confused with "unset"). Per-thread compact-on-idle bookkeeping lives here too (`compactIdleTracking`: last activity / turn-end / compaction instants, each bound to the agent session id so a session swap reads as no history) — the high-frequency stamps assign in memory always but only schedule a save past `compactIdleTrackingPersistStepMs` |
| `mcpConfig.ts` | Merge MCP server config across the user/group/project/thread hierarchy |
| `i18n.ts` | `t(key, vars)` translations for all user-facing strings. **12 locales** (`en`, `de`, `fr`, `es`, `pt`, `ru`, `zh`, `ja`, `hi`, `uz`, `ka`, `uk`); active locale comes from async Telegram/chat context (`/language` override → Telegram `language_code` → stored chat locale → `en`); `en` is canonical (missing key falls back to `en`); per-locale modules live in `src/i18n/`. Add a new key to `en.ts` first, then mirror it in every locale. Agent-facing templates (`schedule.*`, `apiRetry.continueNudge`) keep English instructions but bake a per-locale "IN <language>" reply directive |
| `validation.ts` | Input validation for existing-folder `/bind` args (`validateSubdir`, path-traversal/symlink-safe); `resolveBoundWorkDir` turns a persisted binding into the CANONICAL (`realpathSync`) workDir every agent, `/status` row, and `dir:` scope compares against |
| `folderName.ts` | Pure validation of a typed NEW folder name for the `/bind` create-folder flow (`validateNewFolderName`) — pre-`mkdir` gate (no slashes/traversal/dots/control chars), distinct from `validateSubdir` which requires the folder to exist |
| `rateLimiter.ts` | Per-user / per-action rate limiting |
| `progressLine.ts` | Classify + collapse Claude's transient progress shapes so they roll in ONE edited status message: `PROGRESS_LINE_RE` (spinner tick — the activity title may carry parenthesised segments like `(sub-agent)`; the end-anchored `(time · tokens)` stats parenthesis is the load-bearing anchor), sub-agent `◯` panel frames, `/compact` verb+bar lines; `checkIsProgressChunk` (every line must match) + `collapseProgressChunk` (latest frame per shape) |
| `pinnedStatus.ts` | Per-thread pinned status banner (shows model, etc.) |
| `agentTrigger.ts` | Detect agent-ready / prompt triggers in output |
| `threadContextPreamble.ts` | Pure helpers: build the `[Telegram thread context]` preamble (`buildThreadContextPreamble`), decide whether to inject it (`checkShouldInjectPreamble`, `checkShouldSkipPreambleForText`), and glue it ahead of the prompt (`prependThreadContextPreamble`) |
| `utils/replyQuote.ts` | Pure helpers behind the reply-quote context (a Telegram REPLY folds the replied-to message into the forwarded prompt): `extractReplyQuote` (first-non-empty of manual-quote / reply text / caption; `null` for a service, topic-root, or no-text reply) + `buildReplyQuoteBlock` (agent-facing `[Replying to an earlier message · from: assistant\|user]` + `> `-quoted, capped at `replyQuoteMaxChars` 4000). Structural input, no telegraf imports; the impure bridge (`getReplyQuoteBlock`) + the `forwardPromptToAgent` fold live in `bot.ts` |
| `connectors/telegram/fileIntake.ts` | Pure file-intake helpers: normalise the six media kinds (`getTelegramFileMeta`, photo = largest size), read the album id (`getMediaGroupId`), build the safe saved filename (`buildSavedFileName`, sanitised), the agent-facing announcements (`buildFilePromptText` single, `buildAlbumPromptText` album), and the size cap check (`checkIsFileTooBig`) |
| `utils/mediaGroupCollector.ts` | Pure debounced batcher for media albums: `collect(groupKey, item)` re-arms a per-group timer, `onFlush` fires once with items in arrival order; also owns the per-group one-shot hint guard (`checkShouldAnnounceOnce`) so gating/error replies fire once per album |
| `utils/transcribeAudio.ts` | Voice-note transcription against a Whisper-compatible API (`getTranscriptionEndpoint`: Groq when `GROQ_API_KEY` is set, else OpenAI). `transcribeAudio` retries a transient failure (timeout / network error / 408 / 409 / 5xx / 429) after `transcribeRetryDelaysMs` = 5 s then 15 s (a 429 waits at least its `Retry-After`) and fails a permanent one (other 4xx, empty download) at once; `onRetry` fires before each pause. `bot.ts`'s `transcribeVoiceFile` wires it to the unpaced `voice.retrying` topic notice ("… retrying in N s") and the final `voice.failed`. Pre-retry, a single Groq stall (the provider normally answers in <1 s) lost the voice note |
| `botFileStorage.ts` | Per-thread intake dir layout + janitor: `resolveThreadFilesDir`, `ensureThreadFilesDir`, `purgeThreadFiles` (on `/clear`), `sweepExpiredThreadFiles` (boot + daily age sweep, `fileRetentionDays = 30`) |
| `sendErrorClassifier.ts` | Classify Telegram send failures |
| `utils/linkPreviewSuppression.ts` | Default every outgoing text `sendMessage`/`editMessageText` to NO link preview (`link_preview_options.is_disabled`), injected at the shared `callApi` choke point (installed right after `installCallApiTrace`, sits outside it so the trace records what is sent). A caller that sets its own `link_preview_options` / `disable_web_page_preview` wins; media methods are untouched. Reason: a bare URL in agent output otherwise expanded a large preview card, one per message, in the muted topic |
| `apiErrorRetry.ts` | Pure auto-retry decision layer for agent **API** errors: `classifyAgentApiError` (transient / usageLimit / null-for-auth; markers from the claude.exe strings), `parseResetAt`, `getRetryPlan` (backoff schedule), `decideRetryAction` (arm/ignore/giveUp + grace-window dedup). The `bot.ts` manager owns the timer + kick |
| `utils/claudeAuthLogin.ts` | Pure helpers behind the json-stream `/login` out-of-band flow: `parseClaudeAuthLoginUrl` (clean OAuth URL out of the ANSI/OSC-8 pty output — stops at the BEL), `checkIsClaudeAuthLoginCodePrompt` (the "paste code" gate; shares `claudeLoginPastePromptRe` with the tmux login-paste detection), `parseAuthStatusLoggedIn` + `checkIsAuthLoginSucceeded` (status-authoritative, exit-code fallback), `getLoginCommandRoute` (`outOfBand` only for a json-stream RAW pick, else `forwardToAgent`). The impure pty driver + per-thread state live in `bot.ts` (`startClaudeAuthLogin` / `submitClaudeAuthLoginCode` / `cancelClaudeAuthLogin`) |
| `utils/compactCommandRoute.ts` | Pure three-way route for the bot-owned `/compact`: `getCompactCommandRoute({hasCompactContext, adapterName, terminalAdapterName})` → `adapterCompact` (the backend has a real compaction path — OpenCode + json-stream Claude implement `compactContext`), `notSupported` (terminal: a shell has no context), else `forwardToAgent` (the tmux Claude backend parses `/compact` natively). Kept out of `bot.ts` so the decision is unit-testable, like `getLoginCommandRoute` |
| `utils/compactOnIdle.ts` | Pure helpers for compact-on-idle (F2) + the shared closing-section + the D3 summary guidance: `idleCompactMs` (55min), `resolveCompactOnIdleEnabled` (per-thread override wins, else default-on), `checkShouldFireIdleCompaction` (enabled+active+not-real-turn-busy+not-latched+has-turn fire guard), `checkIsBusyForRealTurn` (`isBusy && !hasPendingQuestion` — a pending question is NOT a blocker, D1), `compactionSummaryGuidance` (the D3 maximally-complete + session-specific text, a code constant kept consistent with the OpenCode fork's baked prompt) + `compactionSkillsGuidance` (name the loaded skills and tell the next session to load them again — baked nowhere, sent to both backends) + `buildCompactionInstruction` (compose D3 guidance — skipped for OpenCode, which bakes it — + the skills guidance + the F2 closing directive, last), the closing sentinel markers (`compactionClosingStartMarker`/`compactionClosingEndMarker`), and `extractCompactionClosingSection` (lift the "Where we stopped" prose out of a generated summary, backend-agnostic), `stripCompactionClosingMarkers` (drop the sentinel marker LINES from the summary POSTED to the topic, keeping every line of prose — whole lines, so no blank gap is left where one stood), `checkShouldPostCompactionSummary` (the whole full-summary gate as one rule: the `/compact_summary` setting, the adapter's `streamsCompactionSummary`, and an `adapterCompact`-only route), `checkShouldAnnounceCompactionStart` (the start notice's gate: an `adapterCompact` route AND a live session), `buildIdleCompactionNoticeParts` (compose the idle report as SEPARATE parts in the notice → summary → re-asked-question order, dropping the closing block whenever a summary is present), `resolveCompactSummaryEnabled` (the `/compact_summary` resolver), `formatTokenCount` (group a context-token count for the completion message with a locale-independent narrow no-break space — NOT `toLocaleString()`, whose output follows the HOST's locale rather than the topic's), plus `getIdleCompactionArmDecision` (the restart-safe arming decision — `{delayMs, kind}`: full window with no persisted history, else the REMAINDER (clamped to the window, so a backward clock step can't inflate it into a `setTimeout` overflow), else a deterministic per-thread stagger inside `compactIdleOverdueMinDelayMs` + `compactIdleOverdueSpreadMs` for an overdue thread; it returns the `IdleCompactionArmKind` so the diagnostic log prints the case it was GIVEN instead of re-deriving a boundary that could drift). `bot.ts` owns the narration (`runNarratedCompaction` — the start notice + completion report shared by the manual `/compact` and the F1 drain — and `postCompactionSummary`, the single summary poster), the per-thread timers (`runThreadCompaction` seam, the idle watchdog's two arming entry points — `noteThreadActivity` for real activity, `rearmThreadIdleTimer` for a re-adopted session, which must NOT move the activity stamp — and the F1 deferred-arm drain), the persisted user-latch (`state.compactIdleLatchedThreads`, cleared by `noteThreadUserActivity`), and the D1 re-ask (`reAskedQuestionOptions` + the `reask_<idx>` action) |
| `utils/autoContinueOnLimit.ts` | Pure layer behind `/auto_continue_limits`: `resolveAutoContinueOnLimitEnabled` (a named wrapper over the shared `resolveDefaultOnThreadToggle`: per-thread override wins, else the instance default, ON when unset — the auto-resume was unconditional before the toggle), plus the «⏭ Skip once» button's `acl_skip_<fireAt>` codec (`buildSkipArmedRetryCallbackData` / `parseSkipArmedRetryCallbackData`) and `getArmedRetrySkipDecision` — `skip` ONLY when the baked `fireAt` matches the thread's currently armed record, else `expired` with no state change, so an untouched older picker can never cancel a LATER episode |
| `utils/threadToggle.ts` | THE resolution rule shared by every DEFAULT-ON per-thread toggle: `resolveDefaultOnThreadToggle(globalDefault, threadOverride)` — a present override (true OR false) wins, else the instance default, ON when both are unset. Both inputs stay `boolean \| undefined` so "never set" is distinguishable from an explicit `false` (otherwise a General «Disable» would be re-enabled by the default on the next boot). Each setting keeps its OWN named wrapper — `resolveCompactOnIdleEnabled`, `resolveCompactSummaryEnabled` (both `compactOnIdle.ts`), `resolveAutoContinueOnLimitEnabled` (`autoContinueOnLimit.ts`) — because the name is what documents which setting is being resolved; extracted at the third copy, which is where copies start drifting apart |
| `utils/limitEpisodeRecovery.ts` | Pure layer for recovering a usage-limit episode that ENDED BEFORE the bot restarted (nothing persisted to re-arm): `getLastTerminalErrorText` (the last terminal `result` error in a json-stream `stdout.jsonl` tail, reusing `parseStreamJsonLine` + `classifyClaudeStreamMessage`; a later healthy turn clears the verdict) and `decideLimitEpisodeRecovery` (arm only for `usageLimit`, only with no armed record, only when the log is younger than `limitEpisodeMaxAgeMs` = 12h, and only when the log's `LimitEpisodeMarker` identity CHANGED since the episode a previous boot already handled — else `skip: 'alreadyHandled'`). `bot.ts` does the one `statSync` + bounded tail read (`limitEpisodeTailMaxBytes` = 64 KB), stamps `state.json` `limitEpisodesRecovered`, and replays through `handleApiError`. JSON-STREAM ONLY — the other backends leave no on-disk tail |
| `utils/openCodeAuthLogin.ts` | Pure helpers behind OpenCode `/connect`: custom OAuth/multi-step methods come from `/provider/auth`; ordinary providers (including OpenRouter) are validated against the full `/provider` catalog and receive the generic API-key method used by OpenCode's native picker. Also owns OAuth pty parsing and `auth.json` success checks |
| `openCodeSessionRouting.ts` | Pure helpers: match an SSE event to its owning session via child→parent lineage (`checkIsEventForSession`), record lineage (`updateSessionLineage`), verify strict descent (`getLineageDepthToAncestor` — busy tracking records a busy CHILD only for a verified descendant, so a dir-fallback-routed foreign sibling's busy=true never pins the thread busy) |
| `utils/sseStreamLifecycle.ts` | Pure decision logic for the OpenCode adapter's single `/global/event` stream: open/close edge detection (`getSseStreamTransition`, driven by the TOTAL active-session count — open on first session anywhere, close on last). The per-directory helpers (`countActiveSessionsForDirectory`, `getWantedStreamDirectories`) now serve scheduler-MCP per-directory tracking, not the stream |
| `utils/openCodeTurnActivity.ts` | Pure decisions for "the prompt was delivered but no turn ran". `checkIsWedgedTurn` — a delivered prompt (`awaitingResponse`) that idled with no assistant activity (`sawActivity`, set ONLY by an assistant `message.updated` — never the echoed user-prompt parts), NOT during a compaction and NOT with a pending provider retry, means OpenCode accepted the prompt but never ran a turn → the bot auto-recovers. `checkIsReplacementTurnMissing` — the same verdict for the OTHER angle, a post-provider-retry replacement prompt whose own `busy` never arrived within its bound (see the `openCodeAdapter.ts` row); both funnel through ONE `noResponse` emit point so a single prompt can never run the escalation twice |
| `utils/wedgeRecovery.ts` | Pure 3-tier escalation for recovering a wedged OpenCode session, one attempt each per prompt episode so the last dialog is preserved when possible and a persistent wedge can't loop: `decideWedgeRecovery({tier,hasReplayPrompt,canFork})` → tier 0 `resend` (same session, transient stall) → tier 1 `fork` (fork into a fresh session carrying the FULL conversation, else `restart` if the adapter can't fork) → tier 2 `restart` (blank fresh session, dialog dropped) → `giveUp`. The bot's `handleNoResponse` runs each tier (replay rides `isRecoveryReplay`, keeping the tier), surfacing `agent.no_response` at give-up; `forkSession` is the OpenCode adapter's `POST /session/:id/fork` |
| `utils/displayVerbosity.ts` | THE shared display-verbosity vocabulary for `/thinking` / `/tool_results` / `/subagent`: option order (`displayVerbosityModeOptions`: minimal, short, full), the locked default (`defaultDisplayVerbosityMode` = `minimal`), the type guard (`checkIsDisplayVerbosityMode`), and the legacy-name normalization (`normalizeDisplayVerbosityMode`: `detailed`→`full`, `brief`→`short`, `hide`→`minimal`, `compact`→`short`; unknown→null) used both for old persisted values and old command/callback aliases |
| `utils/verbosityRender.ts` | Pure decision helper for the `/verbosity` umbrella picker: `getUniformVerbosityLevel` returns the level all three display prefs share (✓ marker target) or `null` when mixed → rendered as "custom" with the three values spelled out. The macro's write path just reuses the per-command apply helpers in `bot.ts` |
| `utils/thinkingRender.ts` | Pure decision/format helpers behind `/thinking`: the OpenCode mode×phase action matrix (`getThinkingEventAction`), the answer-start removal rule, the ms→seconds formatter (`formatThinkingDurationSeconds`), and — for the Claude scrape path (no ms timestamps) — `parseThinkingDurationSeconds` (scrapes the duration out of the "Thinking for…" header / "✻ … for Ns" trailer) |
| `utils/toolResultRender.ts` | Pure helpers for tool-result rendering behind `/tool_results`: mode→render action (`getToolResultRenderAction`), and the `short`-mode dual-cap truncation (`getTruncatedToolResult`, 15 lines / 1200 chars, line-boundary-preserving) |
| `utils/subagentRender.ts` | Sub-agent rendering helpers behind `/subagent`: the mode×part-kind matrix the adapter consults for child-session parts (`getSubagentPartAction`: text→status/stream, tool→ignore/status, reasoning→always ignore; `minimal` ≡ `short` here, v1), the status-only rolling status line (`buildSubagentStatusText`), the parent-side in-flight delegation status (`buildDelegatingStatusText`) and the full-mode chunk marker (`buildSubagentOutputPrefix`) |
| `utils/subagentStatusRender.ts` | Pure helpers behind the DEDICATED OpenCode sub-agent status message (non-`full`): `getSubagentStatusAction` (open/refresh/close/noop lifecycle from "message exists?" × "event active?"), `formatElapsed` (`m:ss`), `buildSubagentElapsedText` ("🤖 sub-agent: <title> · m:ss"), and `checkShouldEnqueueSubagentStatus` (S1' COALESCING gate). The bot's `handleSubagentStatus` owns the message id + the 10 s elapsed tick timer; replaces the flood-prone shared-status line. **Coalescing (live 2026-08-07, topic 61130):** OpenCode streams frequent `message.part.updated` for a live parent `task` part → a high-frequency run of `subagentStatus{active:true}` refreshes. The bot dedups against the last text it DECIDED to enqueue (recorded synchronously) AND never enqueues while one edit is in flight (`subagentEditInFlight`); the old dedup compared against the last DELIVERED text (updated only after the pacer-delayed send resolved), so a burst stacked hundreds of identical `editMessageText` closures into the per-thread FIFO, drained one every 2 s, and head-of-line-blocked the agent's OWN answer behind them — the topic looked hung |
| `utils/claudeScrapeShapes.ts` | THE single source of truth for Claude TUI line-shape regexes (one definition per shape): tool headers (`ANY_TOOL_HEADER_RE` superset of `OUTPUT_TOOL_HEADER_RE`+`FILE_TOOL_HEADER_RE` — incl. `Update`, Claude's render of Edit), `⎿` result marker, thinking header/trailer, collapse markers (`COLLAPSE_MARKER_RE` "+N tool uses/lines"; `COLLAPSE_TOOLUSE_MARKER_RE` "+N tool uses" only, for the orphan-panel-chatter drop), spinner ticks, chrome. **Assistant-output bullet:** detection accepts BOTH `●` (U+25CF) and `⏺` (U+23FA) — Claude Code v2.1.177 renders the output bullet as `⏺`; the older `●`-only regexes silently missed it (live 2026-06-15: a wide table's `⏺ ┌…` top border was never detected → the whole table was lost). When adding a regex that anchors on the bullet, match both glyphs (NOT the spinner-tick classes — `⏺` is a static bullet, not an animation frame) |
| `utils/claudeChunkClassifier.ts` | Pure classifier for the Claude relay (S3): segments a scraped pane chunk into tagged runs (`classifyClaudeChunk` → thinking / tool-header / tool-body / sub-agent-panel-preview / prose / chrome), threading fence/block context across polls. Conservative default-to-prose so the answer is never swallowed; an orphan "+N tool uses" wall → chrome |
| `utils/claudeRelayRouting.ts` | Pure per-pref router for the classifier's segments (S4–S6): `routeClaudeChunkSegments` keeps prose always, applies `/tool_results` + `/thinking` per segment (full keep / short truncate-or-collapse / minimal fold), always folds sub-agent panel previews to status, and returns `keptText` (permanent) + the one rolling `activityLine`; `checkIsClaudeRelayFastPath` is the all-`full` byte-identical regression anchor |
| `utils/claudeSubagentTail.ts` | Pure decision logic for Claude's `/subagent full` transcript tailing: per-file tail state (byte offset + partial-line carry), the scan planner (`getSubagentTailReads`: first scan seeds offsets to EOF with no reads = no backlog replay; non-`full` modes fast-forward without reading; full returns `[offset..size)` ranges), the transcript filename filter (`checkIsSubagentTranscriptName`), and the extractor (`extractAppendedSubagentTexts`: assistant `text` blocks only — thinking/tool_use/user/attachment dropped, malformed JSONL lines skipped). The adapter's poll tick does the fs work |
| `utils/canonicalPathContainment.ts` | Shared security boundary for binding and file-send path resolution: canonicalizes a candidate beneath an already-canonical/pinned root and performs separator-safe containment, while each caller retains its own input validation, root error mapping, and file-vs-directory gate |
| `utils/timezone.ts` | The operator-timezone core: `getCanonicalTimezone` / `checkIsValidTimezone` (an `Intl.DateTimeFormat` probe IS the validation rule — `RangeError` ⇒ invalid; `resolvedOptions()` canonicalizes `europe/moscow` → `Europe/Moscow`), `checkIsFixedOffsetZone` (drives the DST warning), the picker catalog (`listTimezoneRegions` / `getTimezonesForRegion` / `getTimezoneRegion` off `Intl.supportedValuesOf('timeZone')`, no dependency), the wall-clock formatters (`formatZoneNow` `18:42 (+03:00)`, `formatZoneNowWithDate` for the picker header), `getEffectiveTimezone` (stored ?? host — the single "unset means host" rule), `getProcessTimezoneValue` / `checkIsApplicableTimezone` (a fixed offset must be rewritten to `Etc/GMT±H` before it reaches `process.env.TZ`; ICU resolves `TZ="+04:00"` to UTC, so a half-hour offset has no applicable value and is refused), and the one impure `applyProcessTimezone` shared by boot + `/timezone`. The host zone and the launch `TZ` env are snapshotted at MODULE LOAD, before any apply: once a stored zone is written, `resolvedOptions()` reports it and the original would otherwise be unrecoverable — that snapshot is what `/timezone auto` restores |
| `connectors/telegram/timezonePicker.ts` | Pure builders + INDEX-based callback codec for the two-level `/timezone` picker (regions → that region's paginated zones): `buildTimezoneRegionPicker` (2/row + a full-width `🌐 Auto (host zone)` row, `✓` on the region CONTAINING the current zone — a fixed offset belongs to no region, so nothing is marked), `buildTimezoneZonePicker` (one zone per row + `‹ Prev`/`⬅ Regions`/`Next ›`, returns the clamped page/total for the localized header, `null` for a stale region index), `getTimezoneAt`/`getTimezoneRegionAt` (stale index ⇒ `null` so the handler answers "expired" instead of applying a neighbouring zone), `tzr_`/`tz_`/`tzback`/`tzauto` builders + parsers. Pagination reuses `utils/paginateList.ts` |
| `utils/paginateList.ts` | The generic pagination core shared by every inline-keyboard picker: `paginateList(items, page, pageSize)` (slice + clamp a stale/over-range page to the last real one, ≥1 page even when empty). `validation.ts`'s `paginateBindList` is now a thin wrapper over it |
| `utils/modelPickerPlan.ts` | Pure layer behind the two-level `/model` picker: `buildModelCatalog` (group + visibility partition in one pass; the bot's `getModelCatalog` only adds the adapter fetch + the persisted hidden-provider read), `groupModelsByProvider(models, fallbackProvider)` (first-`/` segment; slash-less ids group under the adapter label so Claude's aliases aren't dropped), `getProviderVisibility` (visible/hidden split), `checkHasProviderLevel` (skip level 1 for a lone provider), `getModelShortLabel`, and the INDEX-based callback codec (`mdlp_`/`mdl_`/`mdlhide_`/`mdlshow_`/`mdlback`/`mdlnoop` builders + parsers + `checkIsCallbackDataWithinLimit` against Telegram's 64-BYTE `callback_data` cap) |
| `utils/providerDisconnectPlan.ts` | Pure decision behind `/disconnect`: `getProviderDisconnectOutcome(providerId, activeIdsAfterDelete)` → `removed` vs `stillActiveViaEnv` (a provider still listed after `DELETE /auth/:id` comes from an environment variable the bot cannot unset), the `dscp_<idx>` picker callback codec, and the per-MESSAGE picker-snapshot keying (`buildDisconnectPickerKey`, `getDisconnectPickerProviderAt`, `getDisconnectPickerKeysForThread`, `getEvictedDisconnectPickerKeys`) that stops an older keyboard from resolving its index against a newer list |
| `utils/fileSendPlan.ts` | Pure decision/request layer for the agent→Telegram `send_file_to_user`: path-safety (`resolveSendFileWithinDir` — shared canonical containment + bigint device/inode identity + regular-file gate inside the bound folder), canonical multipart-basename control/quoted-string-metacharacter sanitization (`getTelegramUploadFilename`), extension→render-kind (`classifyFileSendKind`: photo/animation/video/document), the single/album plan (`planFileSend`: `as_file` + >10MB-photo→document downgrade, eligible photos/videos→albumPhotoVideo else albumDocument, size/count → error variant), and `buildTelegramFileSendRequest` (exact `sendPhoto`/`sendAnimation`/`sendVideo`/`sendDocument` or discriminated `sendMediaGroup` request carrying project-owned descriptor snapshots, first-item-only album caption) + `trimCaption` (1024 cap) |
| `utils/abortableFifo.ts` | Shared abortable FIFO waiter queue used by both the global send pacer and file-snapshot admission: size, wait, resolve-next, and resolve-all; an aborted waiter removes only itself and never consumes the next live permit |
| `utils/fileSendService.ts` | Reusable impure orchestration for `send_file_to_user`: `createSendFilesToThread(deps)` resolves target+workdir, pins one canonical root for the whole operation, and on Linux traverses each canonical path from a root descriptor with per-component `O_NOFOLLOW`; macOS fails closed until a native descriptor-relative bridge exists. It verifies the opened regular file's bigint device/inode identity and ≤50 MB size, then retains every file descriptor while classifying/planning/building and exhaustively invoking an injected typed `sendPhoto`/`sendAnimation`/`sendVideo`/`sendDocument`/`sendMediaGroup` gateway. Snapshot admission is bounded/FIFO and abortable; a directory-scoped call requires the same canonical authorised workdir both before opening and inside `executeDelivery` immediately before dispatch. Optional `executeDelivery` wraps gateway dispatch plus durable message-id recording in one queue/retry transaction; the default invokes directly. It closes every collected descriptor in `finally` after gateway success/failure. A gateway return is the delivery boundary: later recording/cleanup failures append warnings to an `ok:true` result to prevent duplicate retries, while `FileSendDeliveryUnknownError` becomes a distinct no-auto-retry result. `SchedulerMcpDeps` imports its `SendFilesToThread` type directly; real-HTTP tests compose a recording gateway |
| `utils/messageSendService.ts` | Reusable impure sender behind `send_messages_to_user` (`createSendMessagesToThread<TTarget>`): resolves the target, then delivers each item (`DiscreteMessageItem` = a plain string OR `{text?, path?, asFile?}`) as its OWN message, preserving order. A text item splits over-cap via `splitMessage` (blank string skipped); an item with a non-blank `path` is an ATTACHMENT delivered through the injected `sendFiles: SendFilesToThread` (the SAME closure behind `send_file_to_user` — no second pipeline) with `text`→caption, `asFile`, and the dir-scoped `authorizedWorkDir` threaded from options. Items are validated up front (an all-empty object → error, nothing sent — mirrors the MCP schema's all-or-nothing reject). `bot.ts` composes it over the paced `replyChunkWithFallback` + `renderAgentHtml` (text) and the `sendFilesToThread` closure (attachments); a total send failure returns an error (not a false "delivered 0"), a partial one stays `ok` but names the landed/attempted split + any attachment errors and reports the shortfall as `undeliveredCount`, and a file `deliveryUnknown` terminates the batch as a non-retryable `deliveryUnknown` result. Cancellation is graceful from BOTH directions: the between-items `signal.aborted` check and a catch around the attachment send (`sendFiles` REJECTS on abort rather than returning — letting that escape hid how many messages had already landed, so the agent re-sent the whole batch and the user saw them twice); both return `cancelled after delivering N message(s)`, detection is the shared `checkIsAbortError` identity check in `utils.ts` (never a message-string match), and a genuine throw still propagates while `deliveryUnknown` — which `sendFiles` decides BEFORE its abort rethrow — is never downgraded. `maxDiscreteMessages` (50) is the per-call cap (enforced at the MCP schema) |
| `connectors/telegram/fileSendGateway.ts` | Telegraf adapter for project-owned file-send descriptors: each gateway invocation creates a fresh bounded input — non-empty snapshots use `fs.createReadStream('', { fd, start: 0, end: sizeBytes - 1, autoClose: false })`, while zero-byte snapshots use an in-memory empty `Readable` — converts discriminated document vs photo/video groups into correctly homogeneous Bot API media arrays, and extracts every returned message id for `/clear` tracking. It registers `finished()` before invoking each attempt; cancellation aborts Telegraf and destroys streams only while any request body remains unconsumed. After every stream ends normally, caller cancellation stays suppressed and an unref'ed 30-second response deadline starts; expiry aborts Telegraf, awaits sender cleanup, and becomes `FileSendDeliveryUnknownError`, while message IDs returned at the boundary still win. Telegram API errors propagate to the outer retry executor; other non-API post-initiation failures also become delivery-unknown. `bot.ts` passes an abort-controller shim signal to Telegraf `callApi`; descriptor closure remains the service's responsibility |
| `utils/reminderWizard.ts` | Pure core of the `/reminders` wizard (the bot-LOCAL reminder feature — buttons only, zero agent involvement): the repeat → day → time → text step machine (`getReminderStepAfterRepeat` skips step 2 for every-day/weekdays, `getReminderPreviousStep`, `getReminderStateForStep` — re-entering a step CLEARS its own pick and every later one, so stepping back never silently keeps the value the operator came to change), the `rw_<wizardId>_<token>[_<arg>]` codec with the wizard id BAKED IN (an inline keyboard stays tappable forever, so a tap on a wizard abandoned hours ago must be inert rather than feed picks into the one that is live now — same class of guard as `/disconnect`'s per-message snapshot) validating range + real-calendar-date at DECODE time so an impossible value can never reach the assembler, the per-step keyboards, `buildReminderSpec` (the four recurring kinds emit exactly the cron shapes `describeCron` renders as words — any other shape would surface to the operator as a raw cron; `once` is assembled host-local and a PAST instant is an ERROR, never rolled forward a day; `createReminderInstant` separates an impossible DATE from a wall clock a DST spring-forward SKIPS, which is a TIME error and returns to the time step), `reminderTextMaxLength` (1000 — the bound the captured text is refused past, sized to leave the card / announcement templates room under Telegram's 4096-char cap in any locale), the hub/list/card plans + their `rm*` codec (delete carries the reminder's OWN id, never an index), the localizable `ReminderScheduleDescriptor` (with a `raw` fallback for an agent-made shape the wizard cannot create, incl. an N-times budget it has no field for), and `getReminderNameFromText` (the wizard never ASKS for a name). Emits i18n KEY plans, not prose: user text lives behind the async `t()` in 12 locales, and `bot.ts` cannot be imported by a test (its module-scope `parseEnv()` exits the process) |
| `utils/reminderScheduleText.ts` | THE localized rendering of a reminder's schedule and next run — shared by the list rows, the card, the done screen AND the fire announcement `scheduler/delivery.ts` posts, so one reminder can never be described two different ways. `describeSchedule` (`scheduler/recurrence.ts`) cannot serve these screens: it is English-ONLY by design (it is interpolated INTO i18n templates as a value) and still renders the agent-prompt announcement, while the reminder UI exists in 12 locales. The `weekly` case reuses the weekday BUTTON label the operator picked, not a second set of names. `getReminderNextRunText` compares local CALENDAR DATES rather than an hours-apart delta (an instant 20h away is "tomorrow" only when it falls on the next day) and renders `null` as the explicit none-marker so a row never looks like a failed substitution |
| `utils/reminderFlow.ts` | The `/reminders` rules that depend on the bot's surroundings rather than on the wizard's step machine, kept out of `bot.ts` because each one fails SILENTLY: `getReminderHubPlan` (at/over the per-thread REMINDER cap «add» is NOT drawn and the body line says why — a button that could only be rejected is a dead end; it compares the reminder count against `maxRemindersPerThread`, the same comparison `createScheduleForThread` makes for a reminder, so a topic full of `/schedule` jobs still offers «add»), `getReminderTextCaptureRoute` + `reminderTextWaitMs` (15 min: the step-4 wait intercepts every plain message in the topic, so it must expire AND let the triggering message fall through to normal handling instead of swallowing a prompt meant for the agent; its `isClaimed` input is what makes the wait single-use — telegraf handles updates concurrently, so the loser routes `claimed` and falls through instead of creating a second reminder from the one wizard, and a claim is checked BEFORE the window so the winner is never retired mid-create), `getReminderTextAcceptance` (the shared length gate both text sources pass — over `reminderTextMaxLength` the text is refused, never truncated), `checkIsReminderTextWaitKept` (the ONE choke point that disarms that wait: only `awaitText`/`createNow` END on the text step, so «‹ Back» out of step 4 must drop it — otherwise the next ordinary message is captured and creates the reminder from the picks the operator went back to change), and `getReminderWizardTapRoute` (a tap from a DEAD screen gets that message's keyboard stripped; a stale tap on the LIVE wizard must NOT, or the operator is left staring at a keyboard-less, unfinishable wizard) |
| `scheduler/recurrence.ts` | Pure schedule math on `croner`: `ScheduleSpec` (cron / once / N-times), validation (min fire interval 5 min), next-occurrence, human description, catch-up decision |
| `scheduler/store.ts` | Schedule records: create path (slug ids, per-KIND thread cap [`maxSchedulesPerThread` 30 for agent-prompt jobs, `maxRemindersPerThread` 100 for reminders; `checkIsReminderSchedule` picks the record's own kind, counts only that kind, and the result's `limit` reports the cap that applied], `isPinSilent`, optional `deliveryKind` — written only when set, so an agent-prompt job stays byte-identical to what it always was), persisted in `state.json` `schedules` (lifecycle-independent). `CreateScheduleArgs` is declared ONCE and shared by `createScheduleRecord` + `createScheduleForThread` so a new field cannot be added to one and forgotten on the other |
| `scheduler/engine.ts` | Timer engine: one unref'd timer per job, boot replay with one-catch-up-per-missed-run, no-overlap guard, N-times/once bookkeeping, `whenIdle` drain |
| `scheduler/delivery.ts` | Fire pipeline: announce → pin (notify by default) → wait-for-idle (5s polls, 10 min cap) → forward with the `[Scheduled run]` marker; unbound topic → distinct error. A REMINDER record STOPS after the pin (`delivered`) — steps 3–4 are never reached, which is what lets it fire in an unbound topic and in General; its announcement also leads with its own text (the pin's notification previews it) and uses the LOCALIZED `getReminderScheduleText` instead of the English-only `describeSchedule`. A CHECK record runs its command first (`deps.runCheck`, `null` = unbound) and only its first failure announces, pins and forwards (`deliverCheck`) |
| `scheduler/checkRun.ts` | The watchdog check: `runCheckCommand` (`/bin/sh -c` in the bound folder, own process group, SIGTERM→SIGKILL on timeout, output tail kept, never rejects), `buildCheckEnv` (drops the bot token), `getCheckAlertDecision` (alert on passing→failing only, one line on recovery), `describeCheckFailure`, `buildCheckFailurePrompt` (agent-facing, English), and the limits (`defaultCheckTimeoutSec` 60, `maxCheckTimeoutSec` 600, `maxCheckCommandLength` 1000, output tails) |
| `scheduler/deliveryKind.ts` | Pure decisions keyed on `ScheduleRecord.deliveryKind`: `checkIsReminderSchedule` (the discriminator the fire path, the `/reminders` screens and the MCP filter all read), `checkIsCheckSchedule`, and `getUnboundPausableSchedules` — the AGENT-PROMPT jobs and checks an unbound topic must pause, reminders EXEMPT because they post + pin with no folder and no agent, so pausing them would stop the one kind that could still have fired (a thread holding only reminders yields an empty array ⇒ nothing paused, no notice posted) |
| `scheduler/mcpSurface.ts` | Bot-owned MCP server (stateless streamable HTTP on an OS-chosen loopback port unless `SCHEDULER_MCP_PORT` pins one): `schedule_create/list/cancel` (`schedule_create` + `checkCommand` = a watchdog check) + `compact_conversation` (F1 agent-triggered self-compaction, `registerCompactConversationTool` → `deps.compactConversation` → the bot's `armDeferredCompaction`; thread-scoped, drains on turn-idle) + `send_file_to_user` (agent→Telegram file/image, separate `registerFileSendTool`; an ambiguous post-invocation outcome is non-error structured content `{ kind: 'deliveryUnknown', retryable: false }`) + `send_messages_to_user` (agent→Telegram per-message delivery: each `messages[]` item its OWN message, never merged, separate `registerMessageSendTool` → `deps.sendMessagesToThread`; an item is a plain string OR `{text?, path?, as_file?}` — a `path` item routes through `deps.sendFilesToThread` as a single-file attachment with `text`→caption, `dir`-scope passes `authorizedWorkDir`, and a `deliveryUnknown` relays as the same non-error structured content; capped at `maxDiscreteMessages`, total-failure → error), + `answer_request` (the agent's answer to a request, `registerAnswerRequestTool` → `deps.answerRequest`; the scope check `checkIsConversationInScope` is passed in: a `thread:` token covers its thread, a `dir:` token every thread bound to its folder), HMAC bearer tokens scoped `thread:`/`dir:`. The server serves BEFORE the boot re-attached sessions, so a tool that reads session state (`compact_conversation`) awaits `deps.whenSessionsRestored()` first. **`GET /mcp` is refused with 405** (`Allow: POST`, behind the token check so an unauthenticated prober still only ever sees 401): this server never initiates a message, so the spec's answer for it is 405 and the SDK client treats that as expected and opens no stream. Answering the SDK's way instead parked a standalone SSE stream that carried nothing and died with the next hot reload — a client that then exhausted its ~15 s reconnect budget latched the whole server `failed` (measured live: `telegramBot: status failed` in the `system/init` of three long-running sessions, `connected` → `failed` at one restart), stranding the bot's own tools in a session deliberately built to SURVIVE the restart. Because MCP cancellation is a separate HTTP notification while each transport is fresh, the HTTP server correlates by verified token + validated bounded client id + typed request id (verified-token fallback for legacy registrations), retains a bounded 30-second cancellation-before-registration tombstone set, and combines that controller with the SDK handler signal. Reports a short connect-time `instructions` (`mcpServerInstructions`, returned in the MCP `initialize` handshake) — a use-case pointer (when to reach for the server, what it can do); per-tool argument recipes stay in each tool's own `description`. NOTE: connect-time `instructions` + tool descriptions are cached by the client at connect — an already-running agent won't see edits until it reconnects; only tool RESULTS reflect live server code |
| `scheduler/injection.ts` | Builders for injecting the bot's MCP entry into sessions: Claude `--mcp-config` object, OpenCode `POST /mcp` registration, each with a fresh UUID client header for cancellation isolation; inert until configured |
| `scheduler/mcpBoot.ts` | Boot bring-up of the bot MCP server (`startSchedulerMcpForBoot`: bind, persist the bound port best-effort, configure injection; a bind failure logs and boots on with injection inert) and the ORDER of the boot session phase (`runSessionBootPhase`): bot MCP FIRST, then reattach, then the per-thread restores, then `onSessionsRestored` (opens the gate the session-reading tools wait on), then the active-session MCP heals (only when the server is up; a throw is logged, never aborts the boot), then the schedule re-arm. A session re-attached or resumed while injection was still inert would be born without the `telegramBot` server, and `decideMcpHeal` never adds an absent one; the heals walk only active sessions, so they must follow reattach |
| `scheduler/runLedger.ts` | Append-only JSONL run history (`DATA_DIR/scheduler-runs.jsonl`, 10MB→.1 rotation, via `utils/rotatingJsonlFile.ts`) |
| `utils/rotatingJsonlFile.ts` | The shared append-only JSONL file with ONE size-bounded `.1` backup behind the durable `DATA_DIR` histories (run ledger, request history): synchronous owner-only `append` that reports `false` instead of throwing, and `readLines` (backup first, then the live file; a missing file reads empty) |
| `requests/types.ts` | Shapes of the request ledger: `RequestOrigin` (`message` / `scheduledRun` / `trackerEvent` + connector-owned string `attributes` the core never interprets), `OpenRequestState` (id, creation time, progress-answer count and the wake-up bookkeeping the wake-up engine owns), `ClosedRequestRecord` (+ conversation, close time, `RequestCloseReason`: `final` / `question` / `superseded` / `cancelled`), `RequestLookup` |
| `requests/requestLedger.ts` | The request ledger (request/answer core S2): at most ONE open request per conversation in `state.json` `openRequests` (keyed by the platform-agnostic `SessionKey` string, mutated under the state's per-key lock via `updateOpenRequest`), closed ones in `DATA_DIR/requests.jsonl`. `createRequest` supersedes the conversation's open request in the same atomic step; `getRequest` finds an id open OR recently closed (an answer to a closed request is still delivered; only the most recent `closedRequestIndexMaxSize` = 5 000 closed ids stay known, an older one reads as unknown); ids are `req_` + 48 random bits, and `createRequest` resolves only after the new request is FLUSHED to disk, so an id an agent was told about can never be lost to a crash. The history line is written BEFORE the open entry is dropped, and `load` drops any open entry the history already shows closed, so a crash never leaves a request both open and closed. `load` runs at boot right after the state store, BEFORE the bot MCP server serves; until it resolves every call throws `RequestLedgerNotLoadedError`, and tool handlers gate on `whenLoaded()`. `onRequestClosed` fires once per close by ANY path (answer, newer request, cancellation) — the boot releases the request's alert there. `updateOpenRequest` takes a patch or a function of the current request (run under the lock, for counter increments) |
| `requests/answerRequest.ts` | The `answer_request` contract, kept out of the MCP surface so it is testable without HTTP: awaits the ledger load; an unknown id and an id outside the caller's scope are refused ALIKE (a session cannot probe other topics' ids); delivery goes through the answer sink of the conversation key's platform and a failed one leaves the request unchanged for a retry; after delivery `progress` is counted (atomic increment) and keeps the request open, `question` / `final` close it; an answer to an already closed request is still delivered and changes nothing. `answerBodyMaxLength` 100 000 |
| `requests/requestHeader.ts` | `buildRequestHeader` — the agent-facing `[Request <id> · from: …]` block that rides inside every request's prompt: the id, how to answer, and (when the requester cannot see plain output) that only `answer_request` reaches them; `buildWakeUpReminder` — the `[Reminder · request <id> is still open]` text a wake-up forwards into the SAME session (not a request) |
| `requests/wakeUpRules.ts` | The wake-up rules as PURE decisions (request/answer core S4): `decideTurnEnd` (a silent turn → wake at once, the 2nd silent turn in a row → alert + stop; a turn that sent a `progress` note → counter reset, follow-up `progressFollowUpDelayMs` = 15 min later; every wake passes the `maxWakeUpsPerRequest` = 10 cap, past it → alert), `decideUnwatchedRequest` (a due follow-up, or the backstop — nothing seen working for `getRequestBackstopMs` = 90 min, overridable by env `REQUEST_BACKSTOP_MINUTES` for live tests; never while busy or blocked, never once stopped), `getWatchedTurnState` (a turn has ENDED only when idle, not blocked — pending native question / compaction / armed retry or limit wait — and the backend has TAKEN IN the request's message: `checkHasUnconsumedInput` false, or for a backend without that signal busy-or-output seen since the forward; an inactive session is `sessionGone`, left to the backstop) |
| `requests/wakeUpEngine.ts` | `RequestWakeUpEngine` — polls the turn each forwarded request / reminder started (`trackForwardedTurn`, every `watchedTurnPollMs` 3 s) and sweeps the unwatched open requests (`unwatchedSweepMs` 60 s) for follow-ups and the backstop; persists live-turn activity at most every 60 s (it pushes the backstop back); a wake goes through the injected `deliverWakeUp` (the bot resumes a dead session from its persisted id first) and a failed one alerts `wakeFailed`; an alert's handle is stored on the request (`alertRef`) and released by the ledger's close callback — or at once when the request closed while the alert was going out. `cancelConversation` closes the open request `cancelled` (the person took over). The engine is a module-level handle in `bot.ts` (like `schedulerEngine`), created after the ledger loads, started at `onSessionsRestored`, stopped at shutdown; the cancel paths are `/esc`, `/c`, `/quit`, `/quit-all`, `/new`, a `/resume` pick and leaving the folder |
| `platform/answerSink.ts` | The core-side contract for answers: `AnswerSink.deliverAnswer(key, {requestId, kind, body, origin, isRequestOpen})` → `{ok, warning?}` / `{ok:false, error}`; `deliverAlert(key, {requestId, reason, origin})` → `{ok, alertRef?}` (the wake-up rules gave up — "something went technically wrong") and `releaseAlert(key, alertRef)`; one sink per platform (`AnswerSinks` map, built ONCE in `startBot` and shared by `answer_request`, the alerts and `releaseClosedRequestAlert` — the ledger's close callback). Separate from `ConnectorOutbound` on purpose — the stream is fire-and-forget, an answer must report whether it landed |
| `connectors/telegram/answerSink.ts` | Telegram's BASIC answer sink: the answer as its own message (split over the cap) through the same paced, recorded path as `send_messages_to_user`, reporting the result (a partial delivery — some split messages failed, `undeliveredCount > 0` — is a success WITH a warning, so the agent learns part is missing). Unpinned — pinning (latest answer only) is the Telegram views' job and needs the sent message ids back. The wake-up ALERT is a localized bot message (`requests.alert.notAnswering` / `.unreachable`) PINNED with a notification (topics are muted); its message id is the `alertRef`, unpinned when the request closes |
| `scheduler/directoryThreads.ts` | Inversion: directory → thread keys bound to it (the MCP `dir:` scope resolution). Matches each binding's CANONICAL workDir via `resolveBoundWorkDir`, so it touches the filesystem (`realpathSync`) and can throw — NOT a pure helper |
| `scheduler/rebindResume.ts` | Pure rebind decision: resume a paused job from now, or drop an expired one-shot |
| `scheduler/timezoneRecompute.ts` | Re-base EVERY job after a `/timezone` change: recompute `nextRunAt` from now (reusing `getRebindResumeAction`), persist, THEN arm — never the engine's `rearmAll()`, which reads a now-past stored `nextRunAt` as a missed run and fires a bogus catch-up into the topic. Paused jobs are recomputed too (else a later resume arms a stale instant) but stay disarmed; an expired one-shot is dropped. Deps (store/engine/clock) are injected so the "no delivery fires" property is testable |
| `diagLog.ts` | Bounded rotating diagnostic log (`appendDiagLog`) under `DATA_DIR/agent-diag.log` — SSE/session lifecycle milestones only, never the per-delta firehose |
| `outputTrace.ts` | Output-trace mode, toggled at runtime via `/trace` (no env var): JSONL record of incoming updates (`recv`), adapter emits (`emit`), and every outgoing Bot API call with outcome (`sendTry`/`sendOk`/`sendErr`, incl. 429 details) under hourly bucket files `DATA_DIR/output-trace-*.jsonl` — lets live verification diff what the bot did vs what reached Telegram. The toggle (`tracedThreads` set + `traceAllThreads` flag) is persisted in `state.json` and re-seeded at boot; an async-buffered, single-flight writer flushes on a 500ms timer / 200-entry threshold (sync flush on process exit). **ON by default for ALL threads** (always-on observability — see below); `/trace off all` turns it off DURABLY (persisted `false`). Buckets pruned at 6h by the bot janitor (`pruneTraceBuckets`). Filtering: `recv`/`emit`/send-with-thread-id record iff the thread is traced (all-flag or in the set); send records with NO derivable thread id (e.g. `editMessageText`) record whenever ANY tracing is active |
| `utils/recvPreviewRedaction.ts` | Pure security decision for the recv-trace preview (`getRecvTracePreview`): while a thread is in the pending `/connect` state (same `pendingProviderConnects` state the text handler consumes), the next non-command text IS a pasted provider API key → the preview is redacted at record time; an inline `/connect <key>` records only a fixed command marker. Also owns the shared `checkIsConnectCommandText` |
| `utils/rotatingLogFile.ts` | Shared hourly time-bucket helper for the observability logs: `getHourBucketPath(dir,base,ext,nowMs)` (`<base>-YYYYMMDDHH.<ext>`, host-local hour) + `pruneExpiredBuckets(...)` (best-effort unlink of buckets + their `.1` siblings older than `retentionHours = 6`; never throws). Used by BOTH the trace writer and the console tee |
| `utils/consoleFileTap.ts` | TEE of `process.stdout`/`process.stderr` to `DATA_DIR/bot-console-*.log` (hourly bucket): `installConsoleFileTap(dir)` wraps `write` so each chunk ALSO `fs.appendFileSync`s to the bucket (best-effort, swallows IO errors, NO `console.*` inside → no recursion), original write + return value untouched (terminal preserved). Installed as early as possible at the bot entry (`cli/bot.ts`, after env load). Buckets pruned at 6h by the janitor |
| `installManager.ts` | Install / locate agent binaries and manage OpenCode server generations. In hot workers, `startExternallyParentedProcess` launches replacements through a one-shot host so crash recovery / auth reload servers leave nodemon's descendant tree before startup returns; an endpoint + PID/start-token + signal-scope file under `DATA_DIR` transfers safe ownership across worker generations |
| `utils/startupReadiness.ts` | Pure decision layer for the boot-time readiness status (plan `agent/tasks/actual/2026-07-12-startup-readiness-status.md`): `buildReadinessReport(facts)` → `{isReady, unmetKeys, missingRights}` (required items = paired group + all bot admin rights + a binding + an installed agent CLI; optional groq/owner never block ready), `checkShouldSendStartupStatus` (cold always, hot only-if-missing), `resolveStartupTargets(isReady, hasOwner, hasGeneral)` → ordered `('owner'\|'general')[]` (ready ⇒ owner-DM-only, NEVER General; not-ready ⇒ owner then General), `buildStartupStatusText` (ready line vs numbered checklist, via an injected translate). `bot.ts` gathers the live facts + sends |
| `utils/resolveBinary.ts` | Resolve `claude` / `opencode` binary paths |
| `utils/pollBackoff.ts` | Pure adaptive poll cadence: `getNextPollDelay` (300ms while the pane changes → ×2 up to 1.5s after 10 unchanged polls; any write/change snaps back) |
| `utils/tmuxExec.ts` | Generic tmux/shell primitives shared by the claude + terminal backends (relocated from `claudeCliAdapter`): `tmuxAsync`/`tmuxOrThrowAsync` (best-effort vs strict tmux calls), `checkArgsAreSafe` (reject control chars), `shellSingleQuote`, `execFilePromise` |
| `utils/ansiClean.ts` | Pane-text cleaning shared by both tmux backends (relocated from `claudeCliAdapter`): `convertAnsiToMarkdown` (ANSI→Telegram markdown, OSC-8 strip, spinner-glyph de-bold), `cleanOutput` (full clean pipeline), private `joinBrokenUrls` |
| `utils/paneDiff.ts` | Pure line-SET diff between two tmux pane captures (relocated from `claudeCliAdapter`): `getNewPaneContent` + `NewPaneContent` (only NEW lines, `startsNewParagraph` out-of-band); imports `normalizeForComparison` from `utils/recentRelayWindow` so both backends share one normalization domain |
| `utils/paneResizeGuard.ts` | Pure decision logic for the Claude scrape pane-RESIZE guard (live 2026-07-02, topic 202: an interactive `tmux attach` resized the window → tmux re-wrapped the whole scrollback → the line-SET diff relayed ragged fragments of OLD conversation; the relay window's 16-char short-line exemption let short-line clusters through on EVERY width flap). The poll loop queries `#{pane_width}x#{pane_height}` AFTER each capture (same-poll order = race-free) and on a change swallows the repaint — baseline reseeds, nothing emits — until the capture settles (`getPaneResizeGuardDecision`, capped by `resizeSettleMaxPolls` so a busy pane is never wedged silent; `parsePaneSize` validates the query). To inspect a live pane use `capture-pane`, not `attach` — capture doesn't resize |
| `utils/tmuxSessionName.ts` | Pure parameterized tmux session-name codec shared by the tmux backends: `buildTmuxSessionName(prefix, key)` / `parseTmuxSessionName(prefix, name)` — careful negative-chatId + strict per-half regex so a foreign session sharing a prefix is never mis-adopted. Claude binds the `'claude'` prefix via thin wrappers; terminal the `'term'` prefix |
| `utils/terminalEmitPlan.ts` | Pure helpers behind `terminalAdapter`: `getTerminalEmitPlan(nextOutputFresh)` (fresh→new message, else continuation — one rolling message per command), `buildTerminalNewSessionArgs` (the `tmux new-session` argv: shell-command + `-c workDir` + size flags, no `--session-id`/permission/MCP), and the named constants (`terminalPaneCols` 200, `terminalPaneRows` 50, `terminalTmuxPrefix` `term`, `defaultShell`) |
| `utils/claudeStreamJson.ts` | Pure stream-json event core for `claudeJsonStreamAdapter`: newline-delimited JSON reader (partial-line buffering across chunks) + classifier mapping `system` / `stream_event` text_delta / `assistant` / `result` / `control_request` / `control_response` (the CLI's reply to a request the BOT wrote — the outer `subtype` verdict plus the optional inner payload, matched by `request_id`) lines to adapter events |
| `utils/openCodeCompactPlugin.ts` | The OpenCode plugin that gives OpenCode's OWN (overflow-triggered) compaction the loaded-skills guidance: `getOpenCodeCompactPluginContext` (the guidance, prefixed so it stays inside the summary), `buildOpenCodeCompactPluginSource` (a v1 plugin — `default` export with `id` + `server`, no named export the legacy loader would call), `resolveOpenCodeGlobalPluginDir` (XDG config home, as OpenCode resolves it), `checkHasOpenCodeCompactPlugin` (find it in a `GET /config` plugin list, by file name), `getCompactPluginActivation` (`loaded` / `recreate` / `busy` for one directory instance — any non-idle or unreadable session status blocks a recreate), and the one impure `installOpenCodeCompactPlugin()` (idempotent atomic install into the global plugin folder; `'failed'` never throws). Called before every server spawn (`installManager.ts`) and by the OpenCode adapter's boot step `activateCompactionPluginForActiveSessions`; `checkHasCompactionSkillsHook` reads the detection |
| `utils/claudeCompactHook.ts` | The `PreCompact` hook that gives Claude's OWN (overflow-triggered) compaction the bot's summary guidance: `getHookCompactionInstruction` (D3 + `compactionSkillsGuidance`, no closing section), `buildPreCompactHookCommand` (a `sh` one-liner that prints the instruction unless the hook's stdin JSON already carries the skills guidance — the bot-issued `/compact <instruction>` case), `buildClaudeCompactHookSettings`, and the one impure `prepareClaudeCompactHookFlags(dataDir)` → `['--settings', DATA_DIR/claude-compact-hook.json]` (one shared file, atomic rewrite on every launch; a write failure returns `[]` and never blocks the start). Wired into all three Claude launch sites (tmux start/resume, json-stream spawn) |
| `utils/claudeMcpHeal.ts` | The reverse-engineered `mcp_status` / `mcp_reconnect` control-request shapes plus the heal decision, in one tested place: `getMcpServerStatus` (one named server's status out of the status payload) and `decideMcpHeal` (`connected`→`healthy`, `failed`→`reconnect`, `needs-auth`/unknown/`null`→`skip` — a status the bot cannot read is never guessed into a live session), with the round-trip timeout constant. Needed because a session that outlived a bot restart keeps its injected `telegramBot` server latched `failed` and the CLI never retries one |
| `utils/claudeRuntimeInfo.ts` | Bounded Claude transcript-tail reader for `/status`: parses the newest main-session model usage and version, derives documented context limits, and always closes its file descriptor |
| `utils/threadStatusReport.ts` | The per-topic `/status` render + model resolution, kept out of `bot.ts` so both are unit-testable (importing `bot.ts` runs its module-scope `parseEnv()`, which exits the process without a bot token): `getThreadStatusReport` (session-only rows are dropped once the session stopped; unknown runtime data degrades to the localised unknown marker) and `getThreadStatusModel` (live adapter value → the runtime's self-reported model → the persisted pick; the middle step is the Claude tmux backend's ONLY model source) |
| `utils/jsonStreamHost.ts` | Host layout + IO primitives for the json-stream EXTERNAL transport (tmux `cjson-…` prefix binding): per-thread dir under `DATA_DIR/jsonstream/`, the probe-proven `#!/bin/sh` wrapper builder (`0<>` FIFO hold, `env -u ANTHROPIC_API_KEY`, pid/exitcode capture), the `O_NONBLOCK` FIFO write-open guard (`ENXIO`→null, never a blocking open) + bounded `EAGAIN` write retry, byte-exact stdout tail state (stateful utf8 decode across split chars, line-boundary offset for restart persistence, truncation reseed), and the orphan-dir janitor sweep |
| `utils/jsonStreamBusyWatchdog.ts` | The json-stream adapter's two SILENCE-bounded decisions (elapsed time is never the bound — a working CLI always writes stdout, a dead one stops): `checkShouldClearBusyOnIdle` (+ `busyIdleWatchdogMs`) force-clears an `isBusy` stuck by a missed terminal `result`, vetoed by any in-flight signal (tool / sub-agent / question / batched answer) so a long turn is never truncated; `getCompactionWaitVerdict` (+ `compactionSilenceTimeoutMs`, `compactionWaitPollMs`, `compactionAbsoluteTimeoutMs` as the never-finishes backstop) bounds the wait for a bot-issued `/compact` confirmation, and `getCompactionTimeoutOutcome` reports a wait that timed out AFTER a `compact_status success` as SUCCESS (only the token counts are missing) |
| `types.ts` | Shared types incl. the `AgentAdapter` contract |
| `sessionKey.ts` | The core's platform-agnostic routing key `SessionKey` (`{platform, space, thread}`) plus the `SessionKeyCodec` registry: `keyToString` dispatches on `key.platform`, `keyFromString`/`tryKeyFromString` dispatch by asking each codec's `matches()`, `keysEqual` compares `platform` too, `keyToSlug` rewrites the `:` for tmux/filesystem names. Serialization itself belongs to the connector — the core never parses the format |
| `connectors/telegram/sessionKeyCodec.ts` | Telegram's `SessionKeyCodec` — owns the frozen `"<chatId>:<threadId>"` spelling (self-registers on import) — plus `makeTelegramKey` and the native accessors `getTelegramChatId` / `getTelegramThreadId` / `checkIsTelegramKey` |
| `platform/inbound.ts` | The core-side INBOUND seam: `InboundEvent` (key + author + text + normalized attachments + optional reply/command + a connector-private `raw`), `NormalizedAttachment`, `PlatformMember`, and the `ConnectorInbound` contract (`start` / `stop` / `listMembersWithElevatedRights`). Deliberately carries NO `isAdmin` on the author — `AdminCache` stays the single source of that answer. A membership lookup that cannot be answered must REJECT, never resolve `[]`: an empty resolve is a valid "no elevated members" answer that the cache stores as fresh, locking everyone out for the full TTL |
| `platform/capabilityFallback.ts` | How outbound content degrades when the surface can't express it: `getDegradedContent` (no `tappableOptions` → drop `options`, the enumerated list in `text` carries the information; no `pinMessages` → clear `keepVisible`) and `checkNeedsOwnMessage`. Applied by EVERY connector, so degradation is identical everywhere and the core never branches on a platform |
| `platform/outbound.ts` | The core-side OUTBOUND seam: `OutboundContent` (semantic text + optional tappable `options` + a `keepVisible` request — never pre-rendered markup), `OutboundHints` (the adapters' advisory `output` flags: `isContinuation` / `isFinal` / `isComplete` / `isSubagent` / `isQuestion` / `startsNewParagraph`), `ActivityState`, `ConnectorCapabilities`, and the `ConnectorOutbound` contract (`deliver` / `deliverFile` / `setActivity` / `finalize` / `dispose` / `checkIsDelivering` / `listUnfinalizedKeys` / `capabilities`) |
| `platform/commandRouter.ts` | The platform-neutral command router: `createCommandRouter` owns the name → handler table (`register` / `checkIsRegistered` / `dispatch`, matched EXACTLY including case — telegraf's own command match is case-sensitive) and `splitCommandArgs` defines what counts as an argument. The connector recognises its own trigger syntax; the core owns dispatch, so a second surface adds a recogniser, not a second command table |
| `connectors/telegram/inbound.ts` | Telegram's INBOUND translation: `getTelegramCommand` (telegraf's own `bot_command`-at-offset-0 + `/cmd@thisbot` rule), `getInboundEvent`, `getNormalizedAttachments` (six Telegram media kinds → five neutral ones), `getPlatformMembers` + `checkShouldInvalidateAdminCache` (the `creator` / `administrator` vocabulary lives HERE, not in the policy), and `createTelegramConnectorInbound` — the SINGLE membership path (`listMembersWithElevatedRights`) and the single normalization path (`deliver`) |
| `connectors/telegram/outbound.ts` | Telegram's OUTBOUND rendering: `telegramCapabilities` (every flag `true`; `maxMessageChars` is the splitter's 4000 cap), `buildOptionsKeyboard` (one button per row, labels elided at 40 chars), and `createTelegramConnectorOutbound` — ordinary turn content streams through the chat-mode `OutputTransport`, while `keepVisible` / `options` content finalizes in-flight output FIRST, then posts as its own message, then pins |

### Test-double connector (`src/connectors/test/`)

Telegram declares every capability `true`, so the degraded half of every
capability branch is unreachable from the real connector. `createTestConnector`
is an in-repo `ConnectorOutbound` + `ConnectorInbound` with configurable
capabilities (`minimalCapabilities` ≈ a tracker comment stream,
`richCapabilities` ≈ Telegram) that records what it was actually asked to
deliver. Its `sessionKeyCodec` uses a `test|<space>|<thread>` spelling — NOT
self-registering, and deliberately colon-free so it can never collide with
Telegram's frozen `"<chatId>:<threadId>"` or break `keyToSlug`'s last-separator
parsers.

TESTS ONLY — no production module may import it.

### Platform boundary — what is enforced and what is still owed

`src/__tests__/platformBoundary.test.ts` fails if any module outside
`src/connectors/telegram/` imports the Telegram library. It carries an explicit
exemption LEDGER (currently just `src/bot.ts`) that is meant to shrink to zero —
a new file may never join it. The test also proves itself non-vacuous and
rejects a stale ledger entry.

Residual, for a follow-up decomposition plan (measured after the seam landed):

- `src/bot.ts` is 12 765 lines / 248 top-level functions. It composes the
  telegraf instance AND holds platform-neutral orchestration (session lifecycle,
  scheduling, MCP wiring), so it cannot move wholesale — it has to be split.
- `threadRouting.ts`, `rateLimiter.ts` and `outputTrace.ts` still import the
  Telegram key ACCESSORS (`getTelegramChatId` / `makeTelegramKey`) from the
  connector. No telegraf dependency, but the direction is backwards.

### Adapters (`src/adapters/`) — the proxy boundary

| File | Responsibility |
|------|----------------|
| `createAdapter.ts` | Factory: pick adapter by tool kind; wire adapter events → bot. Also the DI hub: `registerDisplayPrefsReader` (display prefs at PRODUCE time), `registerSeenWatermarkWriter` / `registerJsonStreamTailWriter` (persistence), `registerThreadLocaleReader` (adapter-side `t(...)` locale context) — same late-wiring idiom for all |
| `claudeCliAdapter.ts` | Claude Code via `tmux` (keystroke driving, adaptive capture-pane polling/scraping; the poll tick also tails the on-disk sub-agent transcripts for `/subagent full`). Owns the Claude-TUI scrape logic + table stabilizer; the GENERIC tmux/ANSI/diff primitives now live in `utils/tmuxExec`, `utils/ansiClean`, `utils/paneDiff`, `utils/tmuxSessionName` (shared with the terminal backend) and are re-exported here for back-compat. **Auto-dismisses Claude's end-of-turn feedback survey** (never relayed to the topic; one Escape per appearance, signature-deduped): the detector (`extractClaudeSurvey`) is two-factor — a whole-line-anchored header + the `N: Label` option row (≥2 options) — and accepts a CLOSED alternation of the two known header wordings (`How is Claude doing this session?` and `How well is Claude following the instructions you gave earlier in this conversation?`, optional leading `●`/`⏺` bullet + trailing `(optional)`); keep it a closed list, never an open prose pattern (a quoted header once spammed bogus surveys). Wedge symptom of an UNRECOGNISED wording: the survey sits on the pane and swallows the Enter of the next forwarded prompt — the text strands unsubmitted in the TUI input box and the topic looks hung (live 2026-07-02, topic 202); the fix is adding the new wording to the alternation |
| `claudeJsonStreamAdapter.ts` | 2nd Claude backend — drives `claude -p --input-format stream-json --output-format stream-json` (structured events, NO tmux scrape) as an EXTERNAL tmux-hosted process (`cjson-…`): a wrapper reroutes stdin to a FIFO claude holds `0<>` and stdout to an append-only `stdout.jsonl` the adapter tails, so bot restarts never kill the session — boot ADOPTS it and replays the downtime tail (host layout/primitives in `utils/jsonStreamHost.ts`; transport details in `src/adapters/README.md`). The **DEFAULT** Claude backend (`getDefaultClaudeBackendName` / `resolveClaudeBackendName`): `/login` is handled OUT-OF-BAND by the bot (`claude auth login --claudeai` in a pty — `getLoginCommandRoute` + `startClaudeAuthLogin`, see the `/login` command section), so it no longer needs a TUI to sign in. Switchable per-topic on the fly via `/claude_mode` (the pick persists as the thread's adapter name; the switch is a SEAMLESS resume — both backends share the on-disk transcript). Hidden from the generic `/start` agent list (`hiddenAdapterNames`) — reached via the default + `/claude_mode`, not a start entry. (The old `CLAUDE_JSON_STREAM_THREADS` env gate is RETIRED.) Subscription-billed (non-`--bare`, no `ANTHROPIC_API_KEY`; proof: `system/init` `apiKeySource:"none"` + a `seven_day` `rate_limit_event`). Interactive questions ride a REVERSE-ENGINEERED stdio control protocol (`--permission-prompt-tool stdio` + `initialize` handshake + `can_use_tool`/`control_response`) — full wire format in `src/adapters/README.md`. `checkHasUnconsumedInput` counts user messages written but not yet echoed back by `--replay-user-messages` (a message written mid-turn is read only when the running turn takes it in, then merged into it — measured on 2.1.287; the echo also marks the session busy), so the request wake-up engine never takes the earlier turn's `result` for the end of a request's own turn; the bot-issued `/compact` is not counted. `healMcpServer` reuses that channel at boot: it asks `mcp_status` and `mcp_reconnect`s the bot's own `telegramBot` server only when it reports `failed`, since a session that outlived the restart would otherwise keep it latched failed for good. Sessions cross-resumable with the tmux backend (shared transcript readers) |
| `openCodeAdapter.ts` | OpenCode via HTTP + SSE (POST prompts; ONE multiplexed `/global/event` stream for the whole server, every event parsed once + routed by envelope `directory` + `sessionID`). **Wedged-turn detection + auto-recovery** (live-fixed 2026-08-16, the my-news digest schedule: «триггер срабатывает, а агент не запускается»): a bloated session accepted every prompt (`prompt_async` 204) but its agent loop exited at step 0 — `session.idle` arrived with ZERO assistant activity, and even a server-side `/summarize` hit the same dead loop, so the session is unrecoverable IN PLACE. A prompt arms `awaitingTurnResponse`; the first own-session idle with no `sawTurnActivity` emits a `noResponse` event → the bot **auto-recovers in 3 escalating tiers** (one attempt each per prompt episode, so the last dialog is preserved where possible): `resend` (same session, transient stall) → `fork` (fork the session into a fresh one carrying the FULL conversation via `adapter.forkSession`, so context isn't lost) → `restart` (blank `releaseThreadSession`+`startAgentSession`, dialog dropped — for a bloated session that re-wedges even forked) → `agent.no_response` give-up (`bot.ts handleNoResponse` + pure `utils/wedgeRecovery.ts decideWedgeRecovery`; replay rides `isRecoveryReplay` so the tier only advances). **`sawTurnActivity` is ASSISTANT-`message.updated`-only** — NOT parts: `prompt_async` echoes the USER prompt as `message.part` events, and counting those masked every wedge (the live miss). Guarded against a legit compaction idle and a still-pending provider retry (`Boolean(providerRetrySignature)`, so a reattached session's `undefined` field doesn't suppress it). Pure decisions in `utils/openCodeTurnActivity.ts` (`checkIsWedgedTurn`) + `utils/wedgeRecovery.ts`. **`checkHasUnconsumedInput`** counts prompts sent minus NEW parent-session user messages seen on the event stream (de-duplicated by message id, the last 100 remembered), the request wake-up engine's guard against reading an earlier turn's idle as the end of a request's own turn; proven live on OpenCode only in the Telegram views' smoke (core S10). **The idle is not the only trigger:** a prompt sent while a provider-managed retry is in flight ABORTS that retry and posts a replacement into the same session, and since `session.status` carries no turn id the adapter must ignore own idles until the replacement's own `busy` identifies it. A wedged session never sends that `busy`, so the wait is BOUNDED (`providerRetryReplacementStartTimeoutMs`, derived from the SSE stall + max reconnect delay so a stream hiccup is never mistaken for a dead turn); on expiry the boundary is released, the optimistic busy state cleared, and the SAME `noResponse` escalation runs. Pre-bound that flag latched forever: every own idle was swallowed, the topic stayed busy and wedge detection stayed disarmed with nothing able to recover it. **Background sub-agents (unblock a topic during a long delegation).** OpenCode's `task` tool is SYNCHRONOUS — the parent session is LOCKED for the whole sub-agent run, so a new message queues behind it and the topic looks hung (verified live: a 2nd prompt during a 75s sub-agent was answered only after it finished; even `abort` doesn't free the parent, though it does NOT kill the sub-agent). Fix uses OpenCode's built-in experimental feature (no fork): the server is spawned with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (`installManager.ts`), and `forwardPromptToAgent` calls `adapter.detachRunningSubagents(key)` before `sendInput` — `POST /experimental/session/:id/background` detaches any sub-agent currently blocking the session (no-op if none) so the message is answered promptly while the sub-agent keeps running in the background; OpenCode auto-injects the sub-agent's result back into the parent when it finishes. Best-effort, gated on `session.busyChildSessionIds.size > 0` |
| `terminalAdapter.ts` | A raw interactive `$SHELL` in `tmux` — a third adapter sibling to claude/opencode (NO AI logic). Types the user's text in as keystrokes (`send-keys`) and streams the scraped pane back as ONE rolling message per command (generic capture → line-set-diff → `cleanOutput` → emit; no question/survey/sub-agent/tool-result/effort/MCP/resume machinery). Restart-safe: `listExistingTmuxSessions`/`adoptExistingTmuxSession` re-adopt a live `term-…` session at boot (current pane seeds the baseline, no flood). Does NOT extend `ClaudeCliAdapter` and leaves `outputsDeltas` falsy, so the Claude liveness loop never fires for it |

The `AgentAdapter` interface (in `types.ts`) is the seam. Per-backend agent
controls (`setModel`, `getCurrentModel`, `getRuntimeInfo`, `sendInput`,
`sendSignal`, `sendEnter`/`sendArrow`/`sendTab`, lifecycle
`startSession`/`stopSession`/`resumeSession`/`checkIsActive`) are optional
methods; the bot checks for them before calling. New per-backend capabilities are added here first, then surfaced
as a command in `bot.ts`.

`compactContext` resolves a `CompactionResult` (`types.ts`) rather than the old
`string | null`: a SUCCESS carries the backend's pre/post context token counts
(`null` = "compacted, counts unknown" — OpenCode's summarize reports none, and the
Claude wait can confirm from `compact_status success` without the boundary frame
— never zero), a FAILURE carries the user-facing text the bot posts verbatim. The
bot's completion report is rendered from those counts; before this the json-stream
adapter logged them and dropped them, so a success could carry no data at all.
`readonly streamsCompactionSummary` is the companion CAPABILITY flag: set it when
the backend's own compaction already reaches the topic as agent output, and the bot
will not post a second copy (OpenCode sets it; the Claude backends do not).

### Output transport (`src/connectors/telegram/output/`) — the per-mode output boundary

| File | Responsibility |
|------|----------------|
| `createOutputTransport.ts` | Factory: pick the output transport by `CHAT_MODE` (the single mode decision); thin group impl (`queueOutput` + `finalizeInFlight` reconcile — drains the coalesced-but-unsent buffer to a permanent message on teardown so the final answer is never discarded under 429, S2), DM delegates to `createDmOutputTransport`, `both` returns a per-key dispatcher (`checkIsDmKey`) over both impls |
| `dmOutputTransport.ts` | The DM draft-cursor manager (relocated out of `bot.ts`): `deliverOutput` 3-way route (draft / `isComplete` one-shot / `queueOutput` baseline), `finalizeInFlight`, `disposeThread`, and the whole draft state + send/pace/idle machinery — built from injected `bot.ts` primitives |

`OutputTransport` is a TELEGRAM CHAT-MODE seam, not the platform seam: it splits
group edit-in-place from the DM draft cursor *within* Telegram. Since the
platform seam landed it is an INTERNAL detail of the Telegram connector —
`connectors/telegram/outbound.ts` composes it, and the core reaches it only
through `ConnectorOutbound`. The interface itself (in `types.ts`) is still
selected once at boot (`registerOutputTransport`, mirroring
`registerDisplayPrefsReader`). `queueOutput`
and `sendAgentChunks` stay shared primitives in `bot.ts` (group + the DM Claude
baseline / one-shot use them too). Thinking frames, sub-agent status, and pinned
status are NOT part of this seam — they are mode-orthogonal (`displayPrefs` /
OpenCode events / bindings).

## Commands (all registered in `bot.ts`)

- **Session lifecycle:** `/claude`, `/opencode` (`/oc`), `/terminal`, `/new`
  (`/clear_session`), `/quit` (`/q`), `/quit-all`, `/sessions`
  (`/resume`), `/rename_session`, `/clear_messages`, `/compact`
  - `/terminal` starts a raw interactive `$SHELL` in the topic's bound folder
    (a third adapter sibling to `/claude` / `/opencode`, mutually exclusive with
    them via `switchThreadAdapter`). Unbound topic / General → the same
    bind-required reply agents give. While active, EVERY plain text message is
    typed in as a command (Enter appended) and routed DIRECTLY via
    `adapter.sendInput` — skipping `forwardPromptToAgent` (no `[thread context]`
    preamble, no typing loader, no interrupt). Output streams back as ONE rolling
    message per command (continuation), like OpenCode. Raw keys reuse the
    existing TUI commands: `/c` (Ctrl-C), `/up`·`/down` (history), `/tab`
    (completion), `/enter`. `/new`·`/quit`·leaving a folder work as for
    agents; `/sessions` lists nothing (shells aren't resumable); `/model`
    `/effort` `/thinking` `/tool_results` `/subagent` `/rename_session` reply
    "not supported" (those adapter methods are simply absent). `/schedule`
    against a terminal is out of scope for v1. Terminal sessions are NOT
    auto-started by a natural-language phrase — only by the explicit command.
    Accepted v1 limitation: full-screen / cursor-addressed TUIs (vim, htop,
    less) repaint the whole pane and look messy; normal commands/builds/logs
    stream cleanly.
  - `/new` (alias `/clear_session`) stops the thread's current agent session
    and immediately starts a fresh one in the SAME topic with the SAME adapter.
    The old session is **released, not deleted** (its transcript stays on disk
    → still resumable via `/sessions`; a bot restart won't auto-reattach it).
    Reuses the release path (`releaseThreadSession`) then
    `startAgentSession` (so it carries startup buffering, the typing loader, and
    the preamble-marker reset). The `agent.ready` notice is shown only for a
    non-self-greeting backend (OpenCode/terminal) — Claude prints its own banner,
    so `startAgentSession` returns `''` and the typing loader covers the gap (see
    "agent start / typing loader" below). Unbound topic → bind-required reply;
    General → a hint that `/new` works inside a bound topic. It no longer creates
    a forum topic (that behavior was removed).
  - `/compact` is **bot-owned** with PER-BACKEND behaviour (pure three-way
    decision `getCompactCommandRoute` in `utils/compactCommandRoute.ts`, keyed on
    whether the adapter implements `compactContext`):
    **OpenCode** → the adapter's `compactContext` (`POST
    /session/:id/summarize`, directory-scoped, body carries the resolved
    `providerID`+`modelID`, no `auto` — manual compaction); **json-stream Claude**
    (the DEFAULT Claude backend) → ALSO `compactContext` now: it sends `/compact`
    as a stream-json user turn, suppresses that turn's own output, and awaits the
    CLI's `compact_boundary` / `compact_status` frame to CONFIRM the compaction,
    then the bot posts a visible confirmation (F3 — previously the literal
    `/compact` reached the model as a normal prompt and the user saw nothing
    happen). **That wait is bounded by SILENCE, not by elapsed time**
    (`getCompactionWaitVerdict` + `compactionSilenceTimeoutMs` in
    `utils/jsonStreamBusyWatchdog`, polled every `compactionWaitPollMs`, with
    `compactionAbsoluteTimeoutMs` only as a backstop against a CLI that never
    finishes): summarising scales with the context, so the old flat 3-min cap on
    total time failed exactly where compact-on-idle matters — a measured 3 min
    15.6 s compaction (`compact_metadata.duration_ms: 195649`) was declared failed
    while the CLI was succeeding, and the F2 notice was never posted, which is the
    "it compacts but never says so" the operator reported. While it works the CLI
    heartbeats `system/status status:"compacting"` every few seconds, so silence is
    the honest death signal; a wait that times out AFTER a `compact_status success`
    still reports SUCCESS (`getCompactionTimeoutOutcome`) because only the token
    counts are missing, and a session teardown settles a parked wait at once
    instead of leaving the caller on the watchdog. **tmux Claude** → the literal
    `/compact` is still forwarded verbatim
    (its TUI parses it natively — intact by design); **terminal** → "not
    supported" (a shell has no context). `compactContext(key, instruction?)` takes
    an optional instruction that APPENDS to the backend's baked compaction prompt
    (F2's closing section); the tmux backend gets it as `/compact <instruction>`.
    Automatic (overflow-triggered) compaction is server-side: the bot does not
    trigger it, but reaches its prompt through the Claude PreCompact hook and the
    OpenCode compaction plugin below.
    **D3 — summary content (EVERY bot-issued compaction, both backends):** the
    summary must be maximally complete (nothing load-bearing dropped) yet capture
    ONLY session-specific nuances (the user's in-session directives + deviations),
    never restating the standard auto-loaded rulebook (CLAUDE.md/AGENTS.md/rules),
    which reloads on the fresh session. Delivery is per-backend
    (`getCompactionInstruction` + pure `buildCompactionInstruction`): OpenCode BAKES
    it into the fork's compaction prompt (`packages/core/src/session/compaction.ts`
    `SUMMARY_TEMPLATE` — so it also reaches the auto/overflow compaction the bot
    can't touch), so the bot does NOT re-append it there; the Claude backends have
    no bot-controlled prompt, so it rides the `/compact <instruction>` every time.
    The wording is kept consistent across both (`compactionSummaryGuidance` mirrors
    the fork's baked bullets).
    **Loaded skills (EVERY bot-issued compaction, both backends):** the summary must
    name every skill loaded in the session and say in plain words that the
    continuing session has to load them again and follow them
    (`compactionSkillsGuidance`). A skill arrives as a mid-session tool result, so
    unlike CLAUDE.md/AGENTS.md nothing reloads it after a compaction. It is NOT
    baked into the fork; on OpenCode it comes from the bot's compaction PLUGIN
    (below), and rides the per-invocation instruction only on a server without it.
    The F2 closing directive always stays last in the instruction.
    **OpenCode's own overflow compaction gets the skills guidance through a
    plugin** (`utils/openCodeCompactPlugin.ts`) the bot installs into OpenCode's
    GLOBAL plugin folder (`$XDG_CONFIG_HOME/opencode/plugins/telegramcode-compaction.js`
    — one bot-owned file, rewritten only when its content changed; the user's
    `opencode.json` is never touched), so every OpenCode on the account loads it:
    bot-started, adopted, or run by hand. Its `experimental.session.compacting`
    hook pushes the guidance into `output.context`, which OpenCode appends to the
    prompt of EVERY compaction — manual and overflow — after the bot's instruction,
    which is why its text says the skills list belongs INSIDE the summary. The hook
    cannot see the bot's instruction, so the bot drops the skills guidance from its
    own instruction when the directory's instance has the plugin
    (`checkHasCompactionSkillsHook` → `GET /config` plugin list →
    `bakesSkillsGuidance`), and keeps it otherwise. OpenCode reads plugins ONCE per
    directory instance, so an instance created before the file existed never loads
    it by itself: installed before every server spawn (`installManager.ts`) and, at
    every bot boot, `activateCompactionPluginForActiveSessions` recreates each
    active directory's instance that lacks it (`POST /instance/dispose` — no server
    restart, sessions stay on disk) — only when every session there is idle
    (`getCompactPluginActivation`; a busy one waits for the next boot). Recreating
    drops the directory's runtime MCP registrations, so the boot runs it BEFORE
    `reconcileSchedulerMcpForActiveSessions`, which restores `telegramBot`.
    `opencode-pty`'s terminals survive it (its manager is module-level state).
    **Claude's own overflow compaction gets D3 + the skills guidance too**, through
    a `PreCompact` hook (`utils/claudeCompactHook.ts`). Every bot-launched Claude
    session (both backends, start AND resume) gets `--settings
    DATA_DIR/claude-compact-hook.json`, which is merged with the user's settings and
    never written into them. Claude Code appends a PreCompact hook's stdout to the
    compaction's custom instructions on every trigger, `auto` included (verified on
    v2.1.289: an overflow compaction's summary named the loaded skill and said to
    reload it). The hook prints nothing when the compaction's `custom_instructions`
    already contain `compactionSkillsGuidance` — a bot-issued `/compact
    <instruction>` — so the text never reaches the model twice. A session started
    before this existed has no hook until it is respawned.
    **A bot-issued compaction is NARRATED, never silent.** `runNarratedCompaction`
    (shared by the manual `/compact` and the `compact_conversation` drain) posts the
    `compact.started` notice BEFORE the wait — it used to go out AFTER, so the one
    line the operator got read "starting now" about something already over — then
    the completion report (`compact.done_tokens` with the pre/post counts when the
    backend reported them, else `compact.done`; OpenCode reports none) and, when
    `/compact_summary` allows, the full summary. A FAILURE is posted too, on both
    triggers: having announced a start, silence would leave the operator waiting on
    a compaction that already gave up. Narration is `adapterCompact`-ONLY — on the
    tmux route the TUI renders its own progress and the bot has no completion
    signal to await, so "compacted" there would be a claim it cannot back. The START
    notice additionally requires a LIVE session (pure
    `checkShouldAnnounceCompactionStart`): now that it precedes the wait it can also
    precede the seam's own "no active session" refusal, and `/compact` in a bound
    topic whose agent was never started would otherwise read as a promise retracted
    one message later. The completion report needs no such input — it is reached only
    after a compaction really succeeded. The
    **typing indicator covers the whole compaction** (S3): `checkShouldKeepTyping`
    and the leak backstop `checkIsTypingStuckByLeak` both take `isCompacting`, fed
    from the existing `threadsCompacting` set — a keep-alive in the first, a VETO in
    the second (during a compaction the leak pattern is legitimate, so without the
    veto the backstop would cut exactly this indicator). The seam starts the loader
    once and never stops it in its `finally`: dropping the `threadsCompacting` mark
    lets the rule self-stop on the next tick, whereas an explicit stop could kill a
    loader a concurrent prompt armed. Needed because the indicator's other two
    inputs are BOTH false while summarising (OpenCode sets no busy flag for
    `summarize`, and neither backend streams output) — measured: 43 s of complete
    silence before this.
    **The FULL summary is written into the topic** (`postCompactionSummary`, the one
    poster all three triggers call after their own notice): `compact.summaryHeader`
    + the summary, PLAIN text with no `parse_mode` (freeform model prose — one stray
    backtick in a Markdown/HTML send drops the whole message), `splitMessage`-split
    when it outgrows one message, never truncated, and with the sentinel marker
    LINES removed (`stripCompactionClosingMarkers`). It must NOT go through the
    agent-output path — that would re-arm the idle watchdog off the bot's own
    message. A backend whose own compaction already reaches the topic declares
    `AgentAdapter.streamsCompactionSummary` (OpenCode does: its `summarize` produces
    a real assistant message that rides the SSE stream) and the bot posts nothing —
    a CAPABILITY flag, not a name check. The whole gate is the pure
    `checkShouldPostCompactionSummary({isEnabled, streamsOwnSummary, route})`.
  - **`/compact_summary` — post the full summary (toggle, default ON).** Regular
    topic → per-thread override; **General** → the instance-wide default; bare → an
    Enable/Disable picker (✓ on current) that re-renders in place (repeated use).
    Persisted as `state.json` `compactSummaryEnabled` + `compactSummaryOverrides`
    (same shape/discipline as the `compactOnIdle*` pair), lifecycle-independent.
    Unlike `/compact_on_idle` it is NOT gated on a live session: the value is read
    when a compaction FINISHES rather than used to arm a timer, so setting it in a
    quiet or not-yet-started topic is meaningful. Only a `/terminal` topic is
    refused (`compactSummary.unsupported`). It gates ONLY the summary post — the
    start notice, the typing indicator and the completion report are not settings.
  - **`/compact_on_idle` — auto-compaction after ~55 min idle** (F2). A per-topic
    idle watchdog (`noteThreadActivity` reset points: user prompt / any command /
    agent output; timer `idleCompactMs = 55min`, chosen to land inside the ~1h
    Anthropic extended prompt-cache window so the compaction reads a still-warm
    cached prefix cheaply) auto-compacts once the session sits idle. Fire guard
    (pure `checkShouldFireIdleCompaction` in `utils/compactOnIdle.ts`): enabled +
    session active + not busy for a REAL running turn (`checkIsBusyForRealTurn` =
    `checkIsBusy && !hasPendingQuestion` — a pending question is NOT a blocker, see
    D1 below) + the user-latch NOT spent (D2) + ≥1 completed turn since the last
    compaction. **No reschedule** (D2): a miss just waits — a real running turn's
    output resets the timer, everything else re-arms only on the next genuine USER
    message. **The feature's own notice is sent via `replyToThread`, NOT the
    agent-output path, so it can't re-arm the watchdog into a loop.** After
    compacting, the bot posts the report as THREE SEPARATE messages in this order
    (pure `buildIdleCompactionNoticeParts`, so the order is unit-testable):
    **(1)** the non-pinned notice (`compactOnIdle.notice`), **(2)** the full summary
    when `/compact_summary` allows, **(3)** the D1 re-asked question LAST. The split
    is what keeps that question's inline option buttons reachable — joined behind a
    full summary they end up buried under a wall of text, and the summary alone can
    outgrow one Telegram message. **The notice carries the "Where we stopped" closing
    section ONLY when no full summary is posted**: the block is a SLICE of the
    summary, so printing both duplicates it. Enforced twice — `runThreadCompaction`
    returns `closingSection: null` whenever it returns a `summary` (so each caller's
    "append the block if present" stays a plain check), and the composer applies the
    same rule. The block is lifted from the freshly-generated summary via
    `adapter.getLatestCompactionSummary` + the pure
    `extractCompactionClosingSection` (sentinel markers `<<<WHERE_WE_STOPPED>>>` /
    `<<<END_WHERE_WE_STOPPED>>>`, backend-agnostic since OpenCode's markdown template
    and Claude's freeform summary differ); that summary is read ONCE per compaction
    and serves both the block and the posted summary. The closing section is baked into the
    summary itself via the per-locale `compact.closingSectionInstruction` (English +
    a baked "IN <language>" directive, like the `schedule.*` templates) passed as the
    compaction instruction. The command: regular topic → per-thread override;
    **General topic** (`checkIsGeneral`) → the instance-wide default. Bare → an
    Enable/Disable inline picker (✓ on current) with the "run in General for ALL
    topics" hint. Default ON. Persisted like `/trace` (state `compactOnIdleEnabled`
    global default-on stored explicitly incl. `false`; `compactOnIdleOverrides`
    per-thread map), lifecycle-independent. Terminal / unbound / no-session topic →
    the `compactOnIdle.unsupported` reply.
    - **D1 — pending question at idle → reject + compact + re-ask.** If a question
      is pending when the watchdog fires, the bot REJECTS it server-side to unblock
      the turn (`adapter.rejectQuestion` + `sendSignal('SIGINT')`, reusing each
      backend's abort-error swallow so no bogus "Aborted"/"API error" leaks), drops
      the stale bot-side pending state + its buttons, compacts, then RE-ASKS the saved
      question at the END of the notice with REAL inline buttons (`reask_<idx>`). A
      tap forwards that option's label as a FRESH prompt to the now-compacted session
      (`reAskedQuestionOptions` map; the original request is gone, so it is NOT
      answered). On a compaction failure the question is still re-asked (no notice).
      This SUPERSEDES the earlier "reschedule while a question is pending".
    - **D2 — idle user-latch (fire at most once per user-active period).** A
      per-thread LATCH persisted in `state.json` (`compactIdleLatchedThreads`, `/trace`
      shape): set the instant a fire is decided (BEFORE any output), cleared ONLY by a
      genuine USER message (text/voice/file via `noteThreadUserActivity`, or a fresh
      session start). Agent output resets the TIMER but never the latch. The persisted
      latch stops a restart from RE-firing — the arming path re-arms only when the
      latch is not spent.
    - **The idle COUNTDOWN survives a restart too.** The three per-thread instants the
      watchdog reasons about (last activity / last turn end / last compaction) are
      persisted in `state.json` `compactIdleTracking`, so a re-adopted session arms on
      the REMAINDER of the 55-min window (`rearmThreadIdleTimer` →
      `getIdleCompactionArmDecision`), not a fresh full one, and an already-overdue
      backlog is staggered per thread (`compactIdleOverdueMinDelayMs` + a deterministic
      offset inside `compactIdleOverdueSpreadMs`) instead of firing all at once at boot.
      Before this the two turn/compaction instants were in-memory only, so after any
      restart the fire guard read `0 > 0` = "nothing to compress" and — D2 forbidding a
      reschedule — the feature stayed dead in every quiet topic; the bot hot-reloads on
      every code change, so it almost never fired. Each entry is BOUND to the agent
      session id it describes, so a replaced session (`/new`, `/quit` + start, a
      `/sessions` resume of an older session) reads as no history even if no
      stopped/closed event fired. The activity/turn stamps are written on every output
      chunk, so they only schedule a save past a coarse
      `compactIdleTrackingPersistStepMs` (60 s) step — irrelevant against a 55-min
      threshold, and the ~10 s heartbeat save carries them anyway.
  - **`compact_conversation` MCP tool** (F1, on the bot-owned `telegramBot` server,
    thread-scoped, injected into every session): the agent calls it ONLY when the
    user explicitly asks to compact/shrink the conversation. It ARMS compaction and
    returns immediately ("will run when this turn finishes") — it never compacts
    mid-turn; a per-thread poll (`armDeferredCompaction`) waits for `!checkIsBusy`,
    then runs the same `runThreadCompaction(key, {withClosingSection:false})` seam
    the idle path uses (no closing section — the user is present). `runThreadCompaction`
    (`bot.ts`) is the single execution seam shared by F1 + F2, wrapping the
    `getCompactCommandRoute` decision. The drain is NARRATED exactly like the manual
    `/compact` (it shares `runNarratedCompaction`): start notice when the deferred
    compaction actually begins, typing indicator throughout, then the completion
    report + the summary. It used to post NOTHING — yet the agent only ever calls
    this tool because the operator asked it to, so the operator is present and
    waiting.
  - `/clear_messages` (formerly `/clear`) deletes this thread's Telegram
    messages (up to 48h, Telegram limit). The bare `/clear` is **no longer
    bot-owned** — it's forwarded verbatim to the agent (Claude
    TUI wipes its context; OpenCode treats it as plain text), and forwarding it
    resets the thread-context preamble marker so the next prompt re-informs the
    agent of its topic. It also **purges the thread's file-intake dir** (the
    agent's context is gone, so any downloaded files it referenced are useless).
  - `/sessions` and its synonym `/resume` list resumable sessions for the
    thread's bound folder as numbered text **and** tappable inline buttons,
    then arm a per-thread pick mode: reply with a bare digit to resume that
    session, `0` to exit, out-of-range stays armed, any other
    text exits and is handled normally. A picked session is **persisted** as
    the thread's session id (`state.json`), so a bot restart (hot rebuild
    included) re-attaches to the pick — previously only fresh starts
    persisted and a restart silently fell back to the pre-resume session.
    **Both backends are folder-scoped now**
    (a binding is required to even reach the list): Claude lists real
    `~/.claude/projects/<cwd-slug>/*.jsonl` transcripts filtered by
    `recordedCwd === workDir` (so sessions started by hand on the laptop in
    that folder are resumable too); OpenCode lists the bound folder's project
    instance via `GET /session?directory=<workDir>`. Sessions created in other
    instances (by-hand serve-cwd scatter) no longer appear — accepted tradeoff;
    already-attached ones keep working (by-id calls are cross-instance).
    - **OpenCode session naming:** bot-created OpenCode sessions are created
      WITHOUT a title, so opencode's own LLM auto-titles them from the first
      prompt (e.g. "Debug broken login flow") instead of the old identical
      `Telegram session <chatId>:<threadId>` wall. `/opencode <args>` keeps
      an explicit, never-auto-renamed title. If auto-title never lands the
      adapter falls back to a ~60-char snippet of the first meaningful (non
      slash, ≥10-char) raw prompt via `PATCH /session/:id`. See plan
      `agent/tasks/completed/2026-06-04-opencode-session-autonaming.md`.
  - `/rename_session <new title>` manually renames the CURRENT thread's live
    session (per-backend, adapter-owned optional method like `/model`).
    **OpenCode** renames via instance-scoped `PATCH /session/:id { title }`
    (reusing the auto-naming PATCH helper) and clears `isAutoNamePending` so a
    manual title can never be overwritten by the auto-name fallback; the title
    is trimmed and capped at `sessionTitleSnippetMaxLength` (60). **Claude**
    has no title concept and does not implement the method → the bot replies
    "not supported". No args → usage hint; no active session → "start an agent
    first".
- **Binding & navigation:** `/bind`, `/ls`, `/list`, `/pair`
  - `/bind` is the single binding hub — there is no `/unbind` or `/where`
    command. The no-arg picker prints the current-binding line (replacing
    `/where`'s per-topic output) and carries action rows ABOVE the folders:
    when the topic is BOUND, the FIRST button is «leave current dir»
    (`bindLeaveCurrent` callback → `unbindThread`: stop session, drop pin,
    release ids, pause schedules, wipe binding — the folded-in `/unbind`);
    next is «create new folder» (`bindCreateFolder` callback). An unbound topic
    omits the leave row (nothing to leave). Tapping «create new folder» arms a
    per-thread await-folder-name mode (`awaitingFolderName`): the next text
    message is validated (`validateNewFolderName` in `folderName.ts` — no
    slashes/traversal/dots/control chars), `mkdir`'d under `WORK_ROOT`
    (already-exists → just bind to it), then bound via `applyBinding` with the
    normal welcome stack. Invalid name → error, mode stays armed for retry.
    Any command exits the mode. `/bind <subdir>` direct form is unchanged.
- **Agent control (proxied):** `/model`, `/connect`, `/disconnect`, `/effort`,
  `/verbosity`, `/thinking`, `/compact_on_idle`, `/compact_summary`,
  `/auto_continue_limits`,
  `/tool_results`, `/subagent`, `/output`, `/schedule`, `/claude_mode`, and raw TUI
  keys `/c`, `/y`, `/n`, `/enter`, `/up`, `/down`, `/tab`, `/esc` (`/escape`)
  - `/auto_continue_limits [on|off]` toggles waiting out a usage/session limit and
    resuming the topic by itself (see the auto-retry entry above). Regular topic →
    per-thread override; General → the instance-wide default; ON by default, no
    session/adapter gate (a limit can hit any topic at any time). Bare → a picker:
    Enable/Disable with `✓` on the current value, plus a «⏭ Skip once» row rendered
    ONLY while a resume is actually armed. Skip drops THAT armed resume and leaves
    the setting alone; Disable flips the setting off AND drops it. The skip button
    bakes the armed record's `fireAt` into its `callback_data`
    (`acl_skip_<fireAt>`), so an untouched older picker can never cancel a LATER
    episode — a mismatch answers "expired" and changes nothing.
  - `/claude_mode [json|tmux]` switches THIS topic's Claude Code backend between
    the tmux-scrape adapter (`'claude'`) and the structured stream-json adapter
    (`claudeJsonStreamAdapterName`) — the two share the on-disk transcript, so a
    live switch STOPS the old backend and RESUMES the same conversation on the new
    one (`applyClaudeBackendSwitch` → `switchThreadAdapter` keeps `claudeSessionId`
    for both backends). Bare `/claude_mode` shows a picker (✓ on current); persists
    as the thread's adapter name, so ▶️ Claude / `/claude` reopen the picked backend
    (default **json-stream**, `resolveClaudeBackendName`; its `/login` is handled
    out-of-band, see the `/login` command section). Only
    for Claude topics (OpenCode/terminal → a hint). Replaces the retired
    `CLAUDE_JSON_STREAM_THREADS` env gate.
  - `/esc` (alias `/escape`) sends a raw Escape keystroke to the live agent
    (Claude: interrupt the current turn / dismiss a selector via
    `sendEscape` → `tmux send-keys Escape`, a fire-and-forget one-shot, NOT a
    wait-for-idle interrupt; OpenCode: "not supported").
  - `/schedule <free text>` is a **thin prompt wrapper** — the bot owns NO
    scheduling logic. It wraps the request in an agent-facing instruction
    (`schedule.forwardPromptTemplate`; bare `/schedule` →
    `schedule.interviewPromptTemplate`, agent asks what + when) and delivers it
    EXACTLY like a plain user message: `ensureAgentSession` does the
    bind-check + start (unbound → bind-required reply; a bound topic that
    never started an agent → `no-adapter`, surfaced as the schedule-specific
    `schedule.noAgent` warning «start /claude or /opencode first» instead of
    the generic `agent.no_session`, since a scheduled run needs an agent to
    launch), then `deliverPromptOrBuffer` forwards to the live agent or buffers it
    mid-startup. The agent does all the work (parse time → cron/one-shot, call
    the `schedule_create` / `schedule_list` / `schedule_cancel` MCP tools).
    Template instructions stay English in all locales (agent-facing, not
    user-read), but the TARGET reply language is baked per locale (for example,
    ru → Russian, en → English, de → German): a fresh session's only user-language signal
    is the resolved chat locale (live 2026-06-06: "in their language" made the agent
    interview in English). The agent's `schedule_*` MCP tools are injected
    into every bot-started session (see "Agent scheduling tools" above).
  - While a Claude TUI selector is on screen (`isQuestionPending`), a bare
    digit / `y` / `n` reply drives the menu in place (`sendInput`, no
    interrupt Escape); any other text breaks out as a fresh prompt. Pre-fix
    the digit was forwarded as a prompt and its Escape cancelled the menu
    ("Login interrupted").
  - While an **OpenCode** question is pending, the same rule holds via the
    shared `deliverActivePrompt` choke point (used by BOTH the text and voice
    handlers): a bare in-range digit ANSWERS that option (a button tap too), any
    other free-form text OR voice CANCELS the question (clear pending state →
    relabel the buttons message to «❌ … cancelled» — that IS the single
    cancellation notice; the standalone `agent.question_cancelled_for_prompt`
    line fires ONLY when there was no bubble to relabel, since posting both was
    the reported duplicate → **reject the question server-side**
    (`adapter.rejectQuestion` → `POST /question/:id/reject`) → `SIGINT` abort of
    the wedged turn — the abort's OWN error result is SWALLOWED, never surfaced
    as a bogus `OpenCode error: Aborted` / `Error: Aborted`
    (`checkIsOpenCodeAbortError`, both the `session.error` and message `info.error`
    channels) or json-stream `Claude error: API error` (the contentless
    `is_error` result of an interrupt we issued; `swallowNextAbortError` one-shot
    armed in `sendInterrupt`)) and is delivered as a fresh prompt. Pre-fix the voice handler had NO question
    handling, so a voice note queued behind the blocked question-turn and the
    user got no reply (live 2026-06-25, topic «ProjectB app 1»). Route decision:
    `getQuestionReplyRoute`. **Abandoning a question ALSO rejects it on the
    server** — not just on abandon-by-prompt but on session teardown while it is
    pending (`/new`, `/quit`, leaving the folder), each rejecting BEFORE the
    session is stopped. Without the reject the question stayed "open" in
    OpenCode's registry and `restoreOpenQuestion` (`GET /question` on every
    reattach) re-posted the stale question after a restart (live 2026-07-01,
    topic 203). Claude has no server-side question concept → no reject. Pure
    reject is the OpenCode adapter's `rejectQuestion` (mirrors `answerQuestion`,
    empty body).
  - **`/login` — per-backend.** The two Claude backends host the OAuth sign-in
    differently:
    - **tmux-scrape** (`'claude'`): `/login` is forwarded to the TUI. Its last
      step shows `Paste code here if prompted >` (a plain `>` box, not `❯`/a
      selector); while it is up (`isLoginPastePending`, `checkIsClaudeLoginPaste`
      off the last pane) ANY text reply is typed VERBATIM via `sendInput` — no
      Escape, no thread-context preamble — then the user's message is deleted
      from the topic (the code is a single-use secret) and a `🔐 code relayed`
      confirmation is posted. Pre-fix the long code fell to the prompt path,
      whose Escape cancelled the login and whose preamble corrupted the code.
    - **json-stream** (`claudeJsonStreamAdapterName`, the default): has no TUI to
      host `/login`, so the bot runs it OUT-OF-BAND. `getLoginCommandRoute`
      (reads the thread's RAW backend pick, so OpenCode/terminal threads are
      never wrongly intercepted) routes `/login` to `startClaudeAuthLogin`, which
      spawns `claude auth login --claudeai` in a bot-owned **pty** (via
      `node-pty`; `ANTHROPIC_API_KEY` stripped → subscription login), relays the
      sign-in URL to the topic (`agent.login_url`) once the "paste code" prompt
      renders, then arms per-thread pending state — the next plain text is the
      OAuth code: written into the pty, the message deleted, `🔐 code relayed`
      posted. On exit `claude auth status --json` is authoritative (exit code is
      the fallback): success → clear the pinned logged-out notice + confirm
      (`agent.login_success`); else a distinct `agent.login_failed`. A 120s
      URL-timeout covers a firewall-held OAuth-init call. Pending state is
      cleared on success/failure and on any teardown (`/quit`/`/new`/unbind —
      `cancelClaudeAuthLogin`); the pty is a bot child (NOT restart-safe — a
      restart drops the in-flight login, which is correct). Pure parse/decision
      helpers in `utils/claudeAuthLogin.ts`; impure pty driver + state in
      `bot.ts`.
  - `/model` is a TWO-LEVEL inline picker: providers first, then that
    provider's models paginated at `MODEL_PAGE_SIZE` (10, one per row). The
    message TEXT stays short — the list rides the buttons. This is the fix for
    the live 4096-char failure: once the operator's OpenCode gained
    `openrouter` (367 models) the old render-everything message was 12 990
    chars, `sendMessage` returned `400 … message is too long`, and the topic
    went silent. Model ids blow past Telegram's 64-BYTE `callback_data` cap, so
    every picker callback carries INDEXES (`mdlp_<providerIdx>_<page>`,
    `mdl_<providerIdx>_<modelIdx>`, `mdlhide_`/`mdlshow_`, `mdlback`,
    `mdlnoop`) — the same trick as `connm_<idx>` / `resume_<idx>`. Grouping is
    by the first `/` segment with a FALLBACK group under the adapter label for
    slash-less ids (Claude reports `sonnet`/`opus`/`haiku`; the old slash-only
    grouping printed an EMPTY list on Claude topics). A single offered provider
    skips level 1. The numbered-text affordance survives but is scoped to the
    CURRENT PAGE (`threadModelLists` holds that page). `/model
    <provider/model>` and the legacy `model_<id>` button are unchanged. Pure
    helpers: `utils/modelPickerPlan.ts` (catalog assembly, grouping, visibility
    split, callback codec) + `utils/paginateList.ts` (the pagination core
    `paginateBindList` now wraps).
    - **The numbered list and the bare-digit arming are ONE decision.** A page
      render carries `isNumberedPickArmed`, and `applyModelPagePickArming` is
      the single choke point that arms/disarms from it — so numbers can never
      be printed without a live affordance, nor the affordance left armed
      without numbers. After a BUTTON pick the page is re-rendered with
      `isWithNumberedList: false` (✓ moved to the new model) and the thread is
      DISARMED: leaving it armed made a later ordinary "3" prompt get swallowed
      as a model pick instead of reaching the agent. A NUMBERED pick consumes
      the affordance the same way, through the one resolver
      (`getNumberedModelPick`) behind BOTH numbered entry points — `/model <n>`
      and the plain "3" reply — valid number or not; the page list itself is
      kept so a follow-up `/model 4` still resolves against what is on screen.
      An EMPTY catalog on the in-place re-render path renders the
      "no models available" copy, never "everything is hidden" (there would be
      no 👁 row to tap — a dead end).
  - **Hidden providers** — each provider row in the picker carries a 🙈 that
    hides it (and a 👁 section below to bring it back). The list is GLOBAL for
    the bot instance, persisted as `state.json` `hiddenModelProviders`
    (deduped/sorted, dropped when empty, lifecycle-independent — mirrors
    `tracedThreads`). Hiding filters the PICKER only: an explicit `/model
    <provider/model>` still resolves a hidden provider, so a saved model pref
    never breaks. It is the only lever that works for a provider OpenCode
    enables from an env var, which `/disconnect` cannot remove.
  - `/disconnect [provider]` removes a provider's STORED credentials
    (OpenCode: `DELETE /auth/:id`, then `resetOpenCodeProviderCaches()`). Bare
    `/disconnect` shows an index-based picker of the active providers. After
    the delete the adapter re-reads `GET /config/providers`: a provider still
    listed is supplied by an ENVIRONMENT VARIABLE (`openrouter` ←
    `OPENROUTER_API_KEY`) and gets an honest "credentials removed but still
    active — unset the variable or hide it in `/model`" notice instead of a
    false success. Decision helper: `utils/providerDisconnectPlan.ts`.
    - **Provider auth is NOT thread-scoped.** `/disconnect` resolves its
      adapter via `getProviderAuthAdapter()` → `getAdapter('opencode')`, the
      same hardcoded resolution `/connect` uses — resolving it from the THREAD
      made a Claude topic able to `/connect` a provider but not disconnect it,
      while the bound-thread help advertises the pair side by side. The
      unsupported-build guard (`disconnect.unsupported_backend`, no `{label}`)
      sits where the adapter is resolved, mirroring `connect.unsupported_backend`.
    - **The picker snapshot is keyed per MESSAGE, not per thread**
      (`buildDisconnectPickerKey(threadKey, messageId)`). Disconnect is
      destructive and an older picker's buttons stay tappable forever: a
      thread-keyed snapshot let a second `/disconnect` overwrite the first, so
      tapping "openai" (index 1) on the OLD keyboard resolved index 1 against
      the NEW list and deleted a DIFFERENT provider's credentials. A tap whose
      own message has no snapshot answers "expired" rather than resolving
      against someone else's list (`getDisconnectPickerProviderAt`). Thread
      teardown sweeps all of a thread's compound keys (digit-suffix match — a
      bare prefix test would let topic `1` wipe topic `12`'s picker), and the
      store is capped at `disconnectPickerSnapshotLimit`.
  - `/model` picked with NO running session persists as the thread pref and
    applies on the next agent start (OpenCode; Claude refuses — its model
    switch is a TUI keystroke with nothing to persist).
  - **Both `/model`-set SUCCESS copies carry the effort block.** The single choke
    point `getModelSetReplyDecision` appends the SAME `effort.current_hint` the
    `agent.ready` notice uses, under the live `model.set_success` headline and
    under the deferred `model.saved_for_next_start` one — so the two messages can
    never drift. The headline is localised (`model.set_success`; it used to be a
    hardcoded English literal, which would have read as English above a translated
    hint). `applyModelSelection` resolves the level AFTER `setModel` returned —
    switching to a model that lacks the current level CLEARS it (see
    `effort.cleared_on_model_switch`), so a pre-switch read would name a dead
    level. `effort: null` (a backend with no effort concept) ⇒ no line; the
    `unsupported` / `error` branches never get one (nothing was switched).
  - `/effort` sets per-thread reasoning effort and offers tappable inline
    buttons (one per available level). **Works pre-session like `/model`** (no
    `checkIsActive` gate): the pick is persisted and the next session replays it
    — the picker lists the PROSPECTIVE model's levels (OpenCode resolves it from
    the live session → saved `/model` pref → server default; Claude's canonical
    set is session-independent). Picking before a session start returns a soft
    "start an agent" notice, not a refusal. **Two backends differ:** Claude has a
    native `/effort <level>` slash command (typed into the TUI; canonical set
    `low…ultracode`, claude clamps unsupported levels per model). OpenCode
    encodes effort as the model's **variant** — read live from
    `GET /config/providers` and applied per-prompt as `body.variant` on the
    prompt request (no env configuration). See plan
    `agent/tasks/completed/2026-05-31-effort-buttons-both-backends.md`.
    - **Default reasoning effort is `xhigh`** (hard-coded `defaultEffortLevel`
      in `effortLevels.ts`, no env var). It auto-applies on session start /
      resume / `/model` change whenever the thread has NO explicit `/effort`
      pick — an explicit pick always wins and is never overwritten, and the
      default is never persisted as a pref. OpenCode clamps it to the resolved
      model's variants (`clampEffortToAvailable`, since not every model ships
      `xhigh`); Claude types `/effort xhigh` and self-clamps per model. NOT
      applied on Claude adopt/reattach (the surviving TUI keeps its effort).
    - **Effort survives the session lifecycle (per-thread, permanent).** claude
      persists effort GLOBALLY in its own settings.json, so a fresh TUI (start /
      `/new` / resume) would otherwise inherit the last globally-set level
      (maybe another topic's). On every fresh spawn the Claude adapter ARMS the
      thread's stored level on the session (`pendingEffortReapply`); the poll
      loop types `/effort <level>` the FIRST time the TUI input box is actually
      ready (`checkIsClaudePromptReady`) — NOT at the spawn instant, when the
      banner is still painting (typing then leaves the command unsubmitted; live
      bug 2026-06-05). One-shot, and strictly before any buffered prompt (same
      serial tmux queue). NOT done on adopt/reattach (the surviving process
      keeps its in-TUI state). OpenCode seeds `effortLevel` from the same
      per-thread pref at session creation.
  - `/verbosity [minimal|short|full]` is the umbrella macro over the three
    display prefs below: it sets thinking + tool results + sub-agents to ONE
    level at once (same store as the individual commands, so those keep
    point-overriding afterwards — last write per pref wins). Both backends, no
    session needed. Bare `/verbosity` shows a 3-button picker (`verb_<mode>`):
    ✓ on a level IFF all three prefs equal it; mixed prefs render as "custom"
    with the three current values spelled out (decision helper
    `getUniformVerbosityLevel` in `utils/verbosityRender.ts`).
  - `/thinking [minimal|short|full]` and `/tool_results [minimal|short|full]`
    set per-topic DISPLAY modes (bot-rendering concerns, never sent to the
    agent), persisted in `state.json` `displayPrefs` and lifecycle-independent.
    They work on **BOTH backends** now (`/tool_results` un-gated in S4,
    `/thinking` in S5) — like `/subagent`. The MECHANISM differs per backend:
    OpenCode renders from its SSE events; Claude has no API, so the scraped pane
    chunk runs through the classifier (`utils/claudeChunkClassifier.ts` — tags
    each run of lines thinking / tool-header / tool-body / sub-agent-panel-
    preview / prose / chrome, threading fence context across polls) and the
    per-pref relay router (`utils/claudeRelayRouting.ts`) which keeps /
    truncates / folds each segment. PROSE is ALWAYS kept (the answer is never
    swallowed); a sub-agent panel preview (incl. orphan "… +N tool uses" walls)
    and `minimal`-mode tool/thinking always fold into the ONE rolling status
    frame — this is what keeps a `minimal` topic quiet under a long delegation.
    (`Update`, Claude's TUI render of the Edit tool, is in the recognised header
    set, so Edit headers + their `⎿ Update(…)` previews route like any other
    tool.) All three commands share ONE unified mode vocabulary
    (`minimal|short|full`, default `minimal`; old names
    `detailed`/`brief`/`hide`/`compact` persist/parse as hidden aliases via
    `utils/displayVerbosity.ts` — pickers and replies show only the new
    names). All offer inline mode buttons (✓ on current) and work with no
    session running. **`/thinking`** (default `minimal`) controls what REMAINS
    of the chain-of-thought — the live `•••` indicator (`thinking.live`, a
    STATIC three-bullet glyph in every locale — the minimal "agent is working"
    cue; the animated cue stays the native typing action) shows in ALL
    modes: `full` keeps the full reasoning, `short` collapses it to "💭 thought
    for {N}s" (OpenCode times it from ms; Claude scrapes the duration from the
    "Thinking for…" header / "✻ … for Ns" trailer via
    `parseThinkingDurationSeconds`, and the "💭" collapse line is force-kept past
    the status-frame heuristic so it isn't mistaken for a transient), `minimal`
    keeps nothing permanent (the live status stays / is deleted when the answer
    starts). **`/tool_results`** (default `minimal`) controls a completed tool
    call's OUTPUT: `full` = whole body, `short` = capped at 15 lines / 1200
    chars + a "… (truncated, /tool_results full)" footer, `minimal` = only the
    transient 🔧 status. OpenCode posts it as its own "🔧 <tool> →" fenced
    message via a dedicated `toolResult` event (never mixed into the answer's
    continuation chain); Claude routes the scraped `● Tool(…)` header + `⎿` body
    segments through the same keep/truncate/fold matrix.
    **`/subagent`** (default `minimal`) controls a sub-agent's transcript on
    BOTH backends — `minimal` ≡ `short` here (v1): both are status-only, so
    no mode ever hides the "working" indicator (locked decision). Shared
    parity rules: child reasoning is NEVER rendered and
    child tool calls/results are never streamed (the parent's task result
    carries the final outcome); in `full` mode child TEXT streams as chunks
    marked "🤖 ⤷" OUTSIDE the parent's continuation chain
    (`OutboundHints.isSubagent`). **OpenCode** (child-session SSE events):
    non-`full` = the child transcript is NOT streamed; a DEDICATED
    self-updating message "🤖 sub-agent: <title> · m:ss" (its own
    `subagentStatusMessageId`, independent of the shared transient
    `statusMessageId`) opens on delegation start, is edited in place every
    `subagentTickMs` (10 s) with a ticking elapsed counter, and is deleted when
    the delegation ends / the parent turn idles / the session stops (the
    dedicated `subagentStatus` adapter event drives open/refresh/close). This
    replaced the old shared-status line, whose lost single-message identity
    re-`sendMessage`d a NEW message per sparse child-text burst — the flood the
    user hit (one 14-min delegation → 14 identical posts). The title is sticky
    (last non-null `task`-part title/description; upgrades from the "sub-agent"
    fallback as soon as the parent's running `task` part carries it — a short
    delegation that ends first stays on the fallback, by design). The competing
    "Delegating…" shared status is suppressed in non-`full`. `full` = a separate
    adapter-side child accumulator streams the text, and the parent's
    pending/running `task` part keeps the generic "🤖 Delegating: <title> …"
    shared status (`buildDelegatingStatusText`); completed/error keep the
    generic ✅/❌. **Claude** (no child
    events — its TUI renders sub-agents itself): non-`full` = nothing extra,
    the TUI's ◯ task-panel line rolls inside the coalesced status frame;
    `full` = the poll loop ADDITIONALLY tails the on-disk sub-agent
    transcripts (`~/.claude/projects/<slug>/<sessionId>/subagents/
    agent-*.jsonl`) and streams the appended assistant `text` blocks — no
    backlog replay on resume/adopt (the first scan seeds offsets to EOF), and
    mode flips take effect from that moment (non-`full` ticks fast-forward the
    offsets without reading). Unlike thinking/tool-results (bot resolves the
    mode at render time), the sub-agent mode is read BY the adapters via an
    injected reader (`registerSubagentModeReader` in `createAdapter.ts`) —
    the branch decides what is PRODUCED. Pure decision/format helpers:
    `utils/displayVerbosity.ts`, `utils/thinkingRender.ts`,
    `utils/toolResultRender.ts`, `utils/subagentRender.ts`,
    `utils/subagentStatusRender.ts`, `utils/claudeSubagentTail.ts`.
- **Bot-local notifications (NO agent):** `/reminders`
  - `/reminders` is the whole feature — there is deliberately no second
    `/remind` command. A reminder is the mirror image of `/schedule`:
    `/schedule` hands FREE TEXT to the agent, which parses the time and calls
    the `schedule_*` MCP tools, so a fire runs a prompt in a session;
    `/reminders` is configured entirely with INLINE BUTTONS and fires with ZERO
    agent involvement — at fire time the bot posts the reminder text into the
    topic and PINS it, and the pin IS the notification (the operator runs every
    topic muted — same mechanism as the pinned pending question). Because
    nothing is proxied it is NOT gated on a binding or a session: it works in
    ANY topic, unbound ones and General included.
  - Storage is the EXISTING scheduler: same `state.json` `schedules` map, own
    per-thread cap (`maxRemindersPerThread` 100, counted apart from the agent's 30
    so the two creators never steal each other's slots — high enough that the
    four-tap button flow is effectively unlimited for a human, bounded only because
    each record sits in the whole-file-rewritten `state.json` and arms a timer at
    boot), discriminated by the optional
    `ScheduleRecord.deliveryKind: 'reminder'` (absent = the original
    agent-prompt job, so no persisted record needed migrating) and carrying its
    visible text in the existing `prompt` field. Timers, boot re-arm and the one
    annotated catch-up for a run missed while the bot was down are the engine's,
    unchanged.
  - **Hub:** «➕ Add» + «📋 List (N)» on one row, «✕ Close» below. At 0 active
    the list button is not drawn and at the cap the add button is withdrawn (a
    button whose only outcome is a rejection is worse than none) — the body line
    then says the limit is reached.
  - **Add wizard — 4 steps, ONE message.** The hub message becomes the wizard,
    every tap re-renders it, and it finally becomes the created card; the flow
    never posts a second message. (1) repeat — once / every day / weekdays /
    weekly / monthly, which are exactly the four cron shapes `describeCron`
    renders as words, so a wizard-made job can never surface as a raw cron;
    (2) the pick that repeat implies — `once` → today / tomorrow / a date grid,
    `weekly` → weekday, `monthly` → day of month (presets + a 1–31 grid); every
    day and weekdays SKIP this step; (3) time — four quick presets or «🕐 Other
    time» → an hour grid (00–23) then a 5-minute minute grid; (4) the text —
    typed OR a voice note (the existing transcription path, same single creation
    path). Custom times are picked with BUTTONS: the reminder text is the only
    thing the operator ever types. Done screen = When / Text / Next +
    «🗑 Delete» / «📋 List» / «✕ Close».
  - The `name` is never asked for — it is derived from the first words of the
    text (`getReminderNameFromText`, capped at `slugify`'s 40-char budget so the
    derived name and the id minted from it stay in step).
  - `‹ Back` steps back AND resets that step's pick (on step 1 it leaves the
    wizard and shows the hub); `✕ Cancel` relabels the message and drops its
    keyboard; ANY slash command cancels an in-flight wizard, which is also what
    makes a repeat `/reminders` retire the previous one — exactly one wizard per
    topic.
  - **Stale taps.** The wizard id is baked into every wizard `callback_data`
    (`rw_<wizardId>_<token>[_<arg>]`) because an inline keyboard stays tappable
    forever: a tap belonging to no live wizard answers "out of date" and strips
    THAT message's keyboard, while a tap on a stale VIEW of the LIVE wizard
    re-renders its current step instead — stripping there would leave the
    operator an unfinishable wizard.
  - **The step-4 text wait EXPIRES** (`reminderTextWaitMs`, 15 min) and the
    triggering message falls THROUGH to normal handling: the wait intercepts
    every plain message in the topic, so an abandoned wizard must not swallow a
    prompt meant for the agent hours later. The capture sits AFTER the
    secret-capture flows (`/login` OAuth code, `/connect` provider key) and
    BEFORE the startup buffer.
  - **The text is BOUNDED and the wait is single-use.** Over
    `reminderTextMaxLength` (1000) the text is REJECTED (`getReminderTextAcceptance`)
    and step 4 re-renders with the reason — never truncated (the words are the
    operator's) and never accepted: an unbounded voice transcript pushes the
    created-card edit, the card and the fire announcement past Telegram's
    4096-char cap, which left a reminder that looked uncreated, could not be
    opened to be deleted, and was still recorded as delivered. The wait is also
    CLAIMED synchronously by the message that consumes it
    (`getReminderTextCaptureRoute`'s `isClaimed` → route `claimed`), because
    telegraf handles updates concurrently: two messages arriving together would
    otherwise create two reminders from the one wizard. The claim is released only
    on the too-long retry — the one path that stays on step 4.
  - A `once` pick whose wall clock a DST spring-forward SKIPS (02:30 on a
    transition day) is a TIME error, never a date one: `createReminderInstant`
    probes the calendar date on its own midnight instant, so the wizard lands the
    operator on the TIME step with the skipped hour cleared (the whole transition
    hour would fail again) instead of telling them to re-pick a date that was fine.
  - The spec is rebuilt at CREATION time, not reused from the time step —
    minutes pass while the operator types, so «today» plus a time that has since
    gone by is reported back on the time screen (with the captured text kept, so
    it is never typed twice) rather than silently rolled to tomorrow, which
    would remind them 24h off what they asked for.
  - **List / card.** Rows page at `reminderListPageSize` (8), each button
    reading `🔔 <name> · <schedule>`; tapping one opens a card (When / Text /
    Next) with «🗑 Delete» / «‹ To list». There is NO extra delete
    confirmation — the card shows exactly what is about to go. Delete carries
    the reminder's OWN id (`rmdel_<id>`), never a positional index: an old card
    stays tappable and must not delete whatever now occupies that row; an id
    already gone answers "already deleted" and reopens the list.
  - Every reminder surface renders its schedule through the SHARED localized
    renderer (`utils/reminderScheduleText.ts`) — list row, card, done screen AND
    the fire announcement — so one reminder is never described two ways. The
    wizard state itself is in MEMORY only (a few taps, not data worth
    persisting, and hot mode restarts on every code change); the reminder it
    produces goes straight to disk through the normal schedule store.
- **Info / ops:** `/start`, `/status`, `/whoami`, `/version`, `/help`,
  `/doctor`, `/mcp`, `/trace`, `/timestamps`, `/timezone`, `/language` (`/lang`)
  - `/language [locale|auto]` shows or changes the bot UI language for the
    current Telegram chat (DM or whole forum group). Bare `/language` opens a
    SINGLE-PAGE inline picker (pure builder in `connectors/telegram/languagePicker.ts`): one
    ENDONYM button per locale (each language written in itself — `中文, English,
    Français, …`), sorted A→Z by the language's ENGLISH name (Chinese first …
    Uzbek last; only the DISPLAY order is sorted — `localeCodes` stays `en`-first
    canonical), two per row, `✓` on the current selection, and a
    full-width `🌐 Auto` reset row (`lang_<code>` / `lang_auto` callbacks). All 12
    locales fit in ONE message (Telegram allows ~100 inline buttons), so there is
    NO pagination / nav row. Tapping a locale sets the override, tapping `🌐 Auto`
    clears it — and either way the picker message is edited to a short
    confirmation in the resolved language and the KEYBOARD DISAPPEARS (no
    re-showable menu once a choice is made). The confirmation / status line shows
    ONLY the resolved language via `formatLanguageDisplay` (`i18n.ts`) — the
    endonym for an explicit override (`🌐 Language: Русский`), `auto (English)`
    for any auto source (`🌐 Language: auto (English)`); no Telegram-profile /
    source label is shown. Endonyms live in CODE (`localeEndonyms`), NOT the
    per-key dict, so key parity is unaffected. The `/language <locale>` /
    `/language auto` text commands keep working. Resolution order: explicit
    override → Telegram `from.language_code` → last supported Telegram locale seen
    in that chat → `en`; logs stay English.
  - `/timestamps on|off` (bare → status) toggles the per-thread prompt
    timestamp: when ON, every prompt forwarded to the agent gets its send time
    prepended as the very top line (`2026-06-27T19:42:10+04:00` — local-offset
    ISO from `formatIsoLocalOffset` in `utils/isoTimestamp.ts`, never `Z`),
    above the on-change thread-context preamble. **Agent-facing only** — never
    posted to the topic, and the Claude echo gates strip it with the rest of
    the echo. The time is the Telegram message's real `date` (plumbed from the
    text/voice handlers as `sentAtMs`); prompts with no live message (scheduled
    runs, buffered replay, api-retry nudge, file intake) fall back to now.
    Slash commands are never timestamped (same skip rule as the preamble).
    Default OFF; persisted in `state.json` (`timestampThreads`, mirrors
    `/trace`'s shape), lifecycle-independent. Use case: long multi-day sessions
    where the agent needs absolute time for "yesterday" / "2-3 days ago".
  - `/timezone [<IANA zone>|+HH:MM|auto]` sets the ONE instance-wide operator
    timezone (bare → a two-level region → zone picker, `/model`-style
    INDEX-based callbacks because zone names blow past the 64-byte
    `callback_data` cap). Instance-wide, NOT per chat/topic: the mechanism is
    `process.env.TZ`, which is process-global by nature, so two chat-scoped
    zones could not both be true in one process. Persisted as `state.json`
    `timezone` (absent by default ⇒ host zone ⇒ an install that never ran it
    behaves exactly as before), applied at boot right after the store loads and
    again on every change through the SAME `applyProcessTimezone`
    (`utils/timezone.ts`). Assigning `process.env.TZ` re-bases `Date`/`Intl`
    IMMEDIATELY (verified on Node 22, asserted by a unit test rather than
    trusted) — which is why almost nothing else needed editing:
    `formatIsoLocalOffset`, `formatLocalClock`, `delivery.ts formatLocalTime`,
    `recurrence.ts describeOnce` and croner's host-local default all already
    read host-local time and become correct for free. No `timezone` option is
    threaded into croner on purpose — with `TZ` applied its default IS the
    operator's zone, and a per-job zone would be a second source of truth.
    A `+HH:MM` offset is ACCEPTED (Intl validates it) with a DST warning rather
    than rejected; an unknown zone is rejected and nothing is written. The one
    offset that is NOT accepted is a half-hour one: `Intl` takes `+05:30`, but
    ICU parses the `TZ` env itself and silently resolves any offset spelling to
    UTC — only the `Etc/GMT±H` form takes effect, so `getProcessTimezoneValue`
    rewrites whole-hour offsets into it (POSIX sign inversion: `+04:00` →
    `Etc/GMT-4`) and `checkIsApplicableTimezone` refuses the rest, which would
    otherwise store a setting that leaves the process on UTC while the
    confirmation cheerfully printed `+05:30`.
    **The trap (S3):** a zone change must NOT go through the engine's
    `rearmAll()` — that is the BOOT replay, which arms from each job's STORED
    `nextRunAt` and treats a past one as a MISSED run, announcing + pinning +
    delivering a catch-up. After a zone change stored `nextRunAt` values are
    routinely in the past, so `rearmAll` would spam bogus "missed at HH:MM"
    runs into every topic. `scheduler/timezoneRecompute.ts` recomputes FIRST
    (reusing `getRebindResumeAction`: next occurrence from now, expired
    one-shot dropped), persists, and only then arms — paused jobs included, so
    a later resume can't arm a stale pre-change instant. Cron is wall-clock, so
    "9am" stays 9am and simply lands on a different absolute instant. Covered
    by a unit test whose first case is a deliberate CONTRAST proving `rearmAll`
    DOES fire on the same state.
  - `/trace on|off` toggles the output-trace recorder for THIS topic; `/trace
    on all` / `/trace off all` flips the every-thread flag (and `off all`
    clears the per-thread set too); bare `/trace` reports status. Persisted in
    `state.json`, lifecycle-independent (session stop/new/quit/resume/unbind
    never touch it). Replaces the retired boot-time `OUTPUT_TRACE` env var.
    **Always-on by default:** the every-thread flag defaults ON (so every
    thread's recv/emit/send is recorded with zero setup); `/trace off all`
    turns it off DURABLY (survives restart — `false` is persisted explicitly,
    not confused with "never set"). Trace lands in hourly bucket files
    `DATA_DIR/output-trace-*.jsonl`. Separately, the bot's stdout/stderr is
    TEE'd to `DATA_DIR/bot-console-*.log` (also hourly buckets). BOTH are
    pruned at 6h by the file-sweep janitor (boot + interval).

When adding a command, follow the existing pattern: register via the
group-gated `command()` wrapper in `bot.ts`, put user-facing text in `i18n.ts`,
and (if it controls the agent) branch on the thread's adapter to drive Claude
(keystrokes) vs OpenCode (HTTP) — **`/model` (`handleClaudeModel` /
`setOpenCodeModel`) is the reference implementation** for a per-thread,
per-backend, persisted agent setting. **Also add the new command's name (and
any alias) to the `botCommands` set in `bot.ts`** — it is the `message('text')`
handler's guard that stops a bot-owned slash from ALSO being re-forwarded to the
agent as a prompt; omit it and e.g. `/esc` reaches the agent verbatim. (A
retired command is kept in the set on purpose so a stray `/where` is swallowed
rather than typed into the agent.)

**A one-shot setting picker CONSUMES its keyboard** — edit the message into a short
confirmation and drop the markup (`/language`, `/auto_continue_limits`), because a
keyboard left on screen invites a stale tap against newer state. A picker meant for
repeated use instead re-renders in place (`/model`, `/effort`, `/compact_on_idle`,
`/compact_summary`);
when its `callback_data` carries an INDEX into a mutable list, snapshot that list
per MESSAGE (`/disconnect`) or bake the identity into the data
(`acl_skip_<fireAt>`).

**Telegram auto-links a bare `/command` written in message text** — to point the
user at a setting, name the command in the prose instead of attaching a button.

## Privacy gate — the repo is public

History was scrubbed of real operator identifiers (2026-07-11) — keep it that way:

- Never commit real instance identifiers (chat/topic/user ids, group names,
  `t.me/c/…` links, home paths with a real username, private project
  names/remotes, tokens) — in code, tests, docs, plans, or commit messages.
  Quoting live-debug output is the usual leak path: replace ids first.
- Examples use the repo's placeholders (`-1001111111111`, `ExampleGroup`,
  `/home/user/…`); real values live only in untracked `CLAUDE.local.md` / `agent/tmp/`.
- Pre-commit review sweeps the diff for real-looking identifiers — any hit is a FAIL.

## Deployment — only committed `main` ships

After resuming an interrupted session, inspect recent commits and the worktree before continuing; another agent may have already advanced the task.

This checkout is the SOURCE other agent accounts on this host mirror: each has
its `origin` pointing at this checkout and pulls on a timer via
`scripts/self-update.sh`. What that means while you work here:

- **Only committed `main` propagates.** Anything left uncommitted in this tree
  never reaches the mirrors, however finished it looks — landing it on `main`
  IS the deploy step.
- The pull is **fast-forward only** and skips a dirty or diverged tree, so a
  rewritten or force-moved `main` silently stalls every mirror until each one
  is re-pointed by hand.
- Touching a hot-supervisor file (`src/cli.ts`, `src/cli/hot.ts`,
  `nodemon.json`) makes the mirrors restart the whole service, because nodemon
  never reloads the process that spawned it; any other change rides the normal
  hot reload.

## Tests & build

- `yarn test` — unit/integration (`src/__tests__/**/*.test.ts`, node test runner + tsx)
- `yarn typecheck` — `tsc --noEmit`
- `yarn build` — `tsc` → `dist/`
- `yarn dev` — `tsx watch src/cli.ts` (fast dev — TS errors crash the process)
- `yarn hot` / `telegramcode hot` — hot-reload mode: `tsc -w` + `nodemon`
  on compiled `dist/`. The supervisor starts nodemon's internal
  `dist/cli/botEntry.js` worker only after the first watch compile, avoiding an
  immediate duplicate boot. A broken intermediate edit can't take the bot down
  (no emit until the build is green), and `nodemon` waits for the old PID's
  graceful shutdown before respawning so the lock changes hands cleanly.
  Agents survive the reload: tmux sessions are external, while the long-lived
  hot supervisor pre-starts the initial `opencode serve` outside nodemon's
  replaceable worker subtree (using the checkout `.env`, not the launch-directory
  config). Any later server generation started by crash recovery, credential
  reload, or a late install goes through a one-shot host and is reparented
  outside that subtree before startup returns. An endpoint-bound `DATA_DIR`
  process-identity file records bot-started generations as `starting` before host
  release and promotes them to `ready` after health succeeds, so a successor can
  stop a pre-bind startup by process-group identity. `ready`/adopted ownership is
  revalidated against the exact hostname+port before signaling, without trusting
  a reused PID or group-signaling an adopted listener. Hot
  mode supports Linux/macOS and refuses to start on Windows,
  where nodemon cannot gracefully drain its worker tree.
  `reattachExistingSessions()` on the next boot re-adopts
  them silently if the downtime gap is short (hot reload), with a
  per-topic notice if it's long (cold start). Globally-installed bin
  resolves the project root via `fs.realpathSync(__dirname)`, so
  `telegramcode hot` works from any CWD.

- **Verifying code you wrote is YOUR job — do it yourself, never hand the check
  back to the user.** Run it, exercise it, drive the real surface. If the usual
  tool is missing (e.g. `telegram-mcp` not connected), find another path to
  exercise the change — hit the live OpenCode server over HTTP, drive/capture a
  real `tmux` claude pane, run the bot code path directly — don't offload the
  check. Asking the user to test what you built is the failure mode, not the
  fallback. (User instruction, 2026-06-21.)

- **Live-verify on the test thread BEFORE you commit — this is the EXECUTING
  (sub-)agent's job, not deferred to the orchestrator or the user.** A change
  that touches relay / output / rendering must be exercised live on the
  "Telegram code testing" topic (root `111`) and confirmed via the always-on
  trace / `get_history` *before* its commit lands. If `telegram-mcp` (the client
  that drives a topic by sending prompts) is not connected, that is a BLOCKER:
  say so explicitly, do NOT commit the change as "verified", and do NOT silently
  skip or claim done. Do not brief sub-agents to "leave on-host to the
  orchestrator". (User instruction, 2026-06-23.)

- **ALWAYS verify output/rendering changes LIVE via Telegram MCP — unit tests
  and code review are NOT enough.** Anything touching how agent output reaches a
  topic (`stripTuiElements`, `cleanOutput`, `getNewPaneContent`, fencing,
  progress-collapse in `progressLine.ts`, `renderAgentHtml`, message splitting)
  must be confirmed in a real topic with `mcp__telegram-mcp__get_history` before
  it's considered done. Why: these bugs only show under the real tmux-scrape +
  per-poll-diff timing (e.g. a sub-agent `◯` line fenced → flood) that no
  unit test reproduced — they shipped green and the user caught them. This
  session is itself relayed to a topic, so your own tool calls are live test
  data; in `get_history` raw text a Bash result still showing `⎿` means it was
  NOT fenced, a clean code block (no `⎿`, no literal ```` ``` ````) means the
  HTML `<pre>` was accepted.

- **Live tests touch ONLY the "Telegram code testing" topic** (root message id
  `111` in the served group `-1001111111111` — placeholder ids; the real
  instance values live in untracked `CLAUDE.local.md`). Never send commands,
  prompts, or button presses to any other topic — those are the user's working
  threads with live agent sessions. (User instruction, 2026-06-04.)

- **Decode a `t.me/c/<internalId>/…` link the user pastes → query directly, no
  `list_topics`/guessing.** `chat_id` = `-100` + `<internalId>` (e.g.
  `1111111111` → `-1001111111111`). Two segments `t.me/c/<id>/<msgId>`: last is
  the `message_id` → `get_message_context(chat_id, message_id, context_size=N)`.
  Three segments `t.me/c/<id>/<topicId>/<msgId>`: middle is the topic (thread)
  root id, last is the `message_id` inside it. A topic's `threadId` (for
  `SessionKey`/trace lookups) IS that topic root id. (User instruction, 2026-06-30.)

- **For send-path / responsiveness / ordering verification, use the output
  trace** — it is ON for all threads BY DEFAULT now (no `/trace on` needed),
  recorded into hourly bucket files `DATA_DIR/output-trace-*.jsonl` (read the
  current hour's bucket; older ones prune at 6h). Assert against the trace, not
  just `get_history`: recv→sendOk latency per command, `sendErr` 429s with
  `retryAfterSec`, emit-vs-sendOk order per topic. `/trace off all` stops it
  durably; `/trace` reports status. The toggle is persisted in `state.json`, so
  it survives a hot rebuild mid-debug — no `.env` edit, no restart. The bot's
  stdout/stderr is also TEE'd to `DATA_DIR/bot-console-*.log` (same hourly
  buckets, 6h prune) — readable post-incident without the operator's terminal.
  - **Diagnosing "a message never reached the user"** (dropped agent output,
    missing question / option buttons) — the `output-trace-*.jsonl` buckets are
    the SOURCE OF TRUTH (not the bot's terminal stdout, though that is now also
    captured in `bot-console-*.log`). Method: reproduce in the topic → follow
    the chain per
    message and localize the loss:
    `recv` (update arrived) → `emit` (adapter produced output/question) →
    `sendTry` → `sendOk` / `sendErr`.
      - no `emit` → lost in the adapter (SSE event not routed/handled);
      - `emit` but no `sendTry`/`sendOk` → lost in the bot's send path;
      - `sendErr` (429 `retryAfterSec`) → rate-limited / dropped under load
        (the prime suspect for *intermittent* loss — event-loop saturation);
      - `sendOk` but absent in `get_history` → spilled into / edited onto
        another message.
    `editMessageText` trace records carry NO thread id — when auditing a
    thread's sends never filter the trace by thread key alone (the edits vanish
    from the filtered view; this produced a wrong "statuses were never sent"
    diagnosis on 2026-07-02).
    Then diff the trace (what the bot DID) against `get_history` (what the user
    SEES). This beats reasoning from code or a homemade SSE listener — a stale
    code comment can lie (e.g. `question.asked` was once documented as carrying
    no `sessionID`; the live event now does), the trace cannot.

- **`OpenCode error: Invalid authentication credentials` → restart the OpenCode
  server** (the `opencode serve` process on port 4096) — its provider credentials
  went stale; new sessions keep failing until the server restarts. (User
  instruction, 2026-06-04.)

- **Verify a per-prompt OpenCode override actually applied** (model or `/effort`
  variant): `GET http://127.0.0.1:4096/session/<sessionId>/message` — the stored
  user + assistant turns echo `model.variant`, proving `body.variant` rode the
  prompt (stronger proof than "no HTTP 400"). Claude side: the tmux pane +
  `[Claude] sendInput: "/effort <level>"` in the log.
