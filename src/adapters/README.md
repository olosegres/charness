# `src/adapters/` — agent backends

Every backend implements the `AgentAdapter` seam (`../types.ts`); the bot never
talks to an agent directly. Each file's header says what it is; `createAdapter.ts`
is the factory and the late-wiring (DI) hub, `adapterEventRouting.ts` the one gate
where adapter events meet a conversation of another platform. This README documents
what is NOT discoverable from the code or public docs: the reverse-engineered stdio
control protocol behind `claudeJsonStreamAdapter`, then the traps of the other
backends.

## `claude-json-stream` — driving the CLI over stream-json

An experimental alternative to the tmux `claude` backend: instead of
screen-scraping a TUI, it spawns the `claude` binary in headless streaming mode
and exchanges structured JSON over the child's stdio. Min version: `claude`
2.1.201.

### Invocation — the load-bearing flags

```
claude -p --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose --replay-user-messages \
  --dangerously-skip-permissions --permission-mode bypassPermissions \
  --permission-prompt-tool stdio \
  --session-id <uuid> [--resume <id>] --model … --effort … --mcp-config <file> -C <workDir>
```

- `--include-partial-messages --verbose` — WITHOUT BOTH, stream-json emits no
  token deltas (only settled `assistant` messages).
- `--permission-prompt-tool stdio` — **the lynchpin for interactive questions**:
  without it `AskUserQuestion` is not even in the tool list, and there is no
  channel to answer a permission over. Easy to miss; nothing else surfaces the
  need for it. It STAYS even under `bypassPermissions` — verified live on
  v2.1.201 that bypass does NOT drop `AskUserQuestion` from the tool list and
  still routes it through the control channel (and `apiKeySource` stays `none`).
- `--dangerously-skip-permissions --permission-mode bypassPermissions` — bypass
  ALL permission checks (tmux-backend parity: the operator trusts their own
  agent). Regular tool use (Bash/Read/…) never routes through the stdio prompt
  tool at all, so the agent never stalls waiting for an allow. WITHOUT these
  (the old `acceptEdits`) every non-edit tool DID route through the prompt tool
  — and any hiccup in the auto-allow reply silently blocked it. The residual
  circuit-breakers claude never bypasses (`rm -rf /`, `rm -rf ~`) still arrive
  as a `can_use_tool` and get a generic auto-allow.
- **Billing**: NEVER `--bare`, NEVER set `ANTHROPIC_API_KEY` — either one forces
  metered pay-per-token API billing. Non-`--bare` + the existing OAuth login runs
  on the **subscription**. Proof in the stream: `system/init` carries
  `apiKeySource:"none"` and a `rate_limit_event` with `rateLimitType:"seven_day"`
  (a subscription concept — the metered API has no such event). `total_cost_usd`
  in `result` is a NOTIONAL figure, not a charge. The one deliberate exception is
  an account billed to API credits (`utils/claudeProfiles.ts`, `billing: 'api'`):
  its key is a console login's in its own `CLAUDE_CONFIG_DIR`, or a pasted key its
  launch settings' `apiKeyHelper` reads (`prepareClaudeCompactHookFlags(dataDir,
  configDir)` — only the LAST `--settings` counts, so hook and helper share one
  file) — still never `ANTHROPIC_API_KEY` (`apiKeySource` then reads
  `/login managed key` or `apiKeyHelper`), and only there `total_cost_usd` is money.

### Output events (documented, stable)

Newline-delimited JSON, one object per line, parsed in
`../utils/claudeStreamJson.ts`:

- `system` — `subtype:"init"` carries `session_id`; `subtype:"api_retry"` for
  retryable provider errors (has an `error` category enum).
- `stream_event` — `event.type:"content_block_delta"` with
  `event.delta.type:"text_delta"` = live token deltas.
- `assistant` — the settled text of the turn.
- `result` — turn end (usage, cost, `session_id`). The adapter logs every
  turn's `usage` as `[ClaudeJson] usage <key>: input=… cacheRead=… cacheWrite=…
  output=…` — the cross-process prompt-cache proof. A `/compact` turn's result
  carries an all-zero `usage` and reports its summary call only under the
  per-model `modelUsage`; the line then logs the `modelUsage` total.
- `system` `subtype:"background_tasks_changed"` — the CLI's CURRENT list of
  background tasks (`tasks[].task_id`; a background Bash / Monitor is
  `local_bash`, a background sub-agent `local_agent`), re-sent whole on every
  change, empty when nothing runs. The adapter keeps it per session (persisted
  with the tail offset, restored on adopt) and `checkIsWorking` reports a
  non-empty list as working: a stop would kill those tasks. Reported from
  Claude Code 2.1.287 on (`init.claude_code_version`;
  `utils/claudeCodeVersion.ts` is the gate).

### Multi-turn — one process per conversation, two lifecycles

ONE process per conversation at a time. Feed each user turn as a line on stdin:

```
{"type":"user","message":{"role":"user","content":"…"}}
```

The process stays alive between turns and exits ONLY when stdin closes (a single
message + EOF makes it answer once and exit — that is not multi-turn).
`--replay-user-messages` echoes each input back as an ack.

The SAME adapter class runs under two lifecycles (plan
2026-10-04-claude-process-lifecycle), one adapter instance each, both using the
same tmux name and host dir per conversation:

- `claude-json-stream` (`lifecycle: 'idle'`, the default) — the process stays
  between turns and is STOPPED at the idle mark (55 min, `AGENT_IDLE_MINUTES`),
  right after the idle compaction when it applies (L-D1: whether or not it ran).
- `claude-per-turn` (`lifecycle: 'perTurn'`) — the process is stopped right
  after EVERY turn, by the bot on the adapter's `turnEnded` event (emitted after
  each terminal `result`), unless a deferred compaction is armed or the process
  still works. stdin is never closed while a task runs: EOF kills background
  tasks ~5 s later (probe 2026-10-04).

Every COMPLETED compaction is told as `contextCompacted` (key, trigger): a bot-issued one on its one success
path (`resolveCompaction`), and the CLI's own overflow compaction — a `compact_boundary` nobody waited for, live
or met while replaying the downtime tail. A connector that tracks what a conversation was already told (Jira)
starts over from it; a failed compaction tells nothing.

A stopped conversation SLEEPS: its session id stays persisted and the next
trigger (a message, a Jira request, a limit resume, a wake-up, a schedule, a
command that needs a live agent) resumes it through the bot's one choke point,
`ensureAgentSession` — `--resume <id>`, silently, with the startup window open
so a prompt typed meanwhile is buffered and replayed. A resume minutes later
still reads the prompt cache (measured: a new process resuming after 50 min idle
read 24 k cached tokens; after 70 min the session's own cache was gone — hence
the 55-minute mark). A resume that fails starts a fresh session and the topic
gets one line. `/quit`, `/new` and leaving the folder release the id.

**A resume is decided by what the transcript HOLDS, not by its existence** (`utils/claudeTranscriptContent.ts`,
`prepareClaudeSessionLaunch`, called by `spawnSession` for every start, resume and re-spawn): only a transcript with a
`user` / `assistant` / `attachment` entry is `--resume`d. Two things are not one, and the difference matters:
- **No file** (a session that never took a turn — `/new`, then an idle stop before the first prompt — or a transcript Claude
  Code's cleanup of old conversations removed while the conversation slept): the bot's seen watermark tells them apart.
  When it names the session (`checkIsConversationRecorded`, passed as `ResumeSessionOptions.isConversationRecorded` by the
  wake of a sleeping conversation; `switchThreadAdapter` keeps the watermark while its session is kept), the conversation
  had turns and is gone: the resume fails like on a stub, below. Otherwise nothing is known to be lost, and the id is simply
  STARTED under the same id, silently, by a resume and a re-spawn alike.
- **The metadata-only stub** a stopped process writes back into a removed transcript (`last-prompt`, `cost-state`, …) — proof
  that the conversation HAD turns and is gone: `resumeSession` fails like any resume the CLI would refuse, and the bot's own
  recovery follows (`ensureAgentSession`: a fresh session, one line to the topic, a whole prompt for a tracker). A live
  re-spawn (`respawnWithChange`: model, effort, account) has no caller to recover it: it starts the conversation again under the
  same id and emits `conversationLost` — the bot posts the same one line, forgets that the thread-context preamble was
  injected and drops the seen watermark (it measured the lost conversation: kept, a sleep before the new one's first turn
  would wake as lost a second time); a tracker's connector sends the whole issue next.

Measured on CLI 2.1.302, a stub is refused by `--resume` («No conversation found with session ID») and by `--session-id`
(«already in use») alike, so it is removed before any launch. The teardown of a process (`terminateSessionProcess`: a stop, a
re-spawn) waits for it to be gone, because that exit is what writes the stub: up to `pidExitWaitTimeoutMs` (5 s), then the
process is SIGKILLed (`waitForPidExitOrKill`) — a launch finds what the exit leaves and never runs beside the process it replaces.

**Working (L-D2).** A process is never stopped while it works: a running turn
(`checkIsBusy`), or `checkHasBackgroundWork` — the CLI's live background-task
list (`system/background_tasks_changed`, `tasks[].task_id`; a background Bash
or Monitor is `local_bash`, a background sub-agent `local_agent`; re-sent whole
on every change, empty when nothing runs), input written but not yet echoed, a
bot-issued compaction in flight. The two halves are read apart by the idle fire:
a pending interactive question excuses the turn (D1: reject, compact, re-ask)
but never a background task. A finished background task starts a turn of its
own (`task_notification`), which re-arms the idle timer. The list rides the tail
record (below) so an adopt restores it.

**Version gate (L-D10).** The task list is reported from Claude Code 2.1.287 on
(`system/init` `claude_code_version`, persisted with the tail record), so a
process whose version is unknown or older is never auto-stopped (one log line),
and a switch to `claude-per-turn` is refused for a conversation whose last known
version — the live process's, else the persisted one — is below the gate; an
unknown version allows the switch. `utils/claudeCodeVersion.ts` holds the gate.

Every `result` logs `[ClaudeJson] usage <key>: input=… cacheRead=… cacheWrite=…
output=…` (L-D11) — the cross-process cache check reads these lines (the
`modelUsage` total when `usage` is all zero, as on a `/compact` turn).

### Process hosting — external tmux + FIFO + file tail (restart isolation)

The process is NOT a bot child (plan 2026-07-05-jsonstream-restart-isolation):
a generated `#!/bin/sh` wrapper (`utils/jsonStreamHost.buildWrapperScript`)
hosts it in a detached tmux session `cjson-<chatId>-<threadId>`, so bot
restarts — every hot reload — never touch it. Per-thread host dir
`DATA_DIR/jsonstream/<chatId>_<threadId>/`:

- `stdin.fifo` — the bot writes turns/control frames here. Claude holds the
  fifo **`0<>` (read-write on fd 0)**, so a writer (bot) dying never EOFs its
  stdin. The bot's write-open is `O_WRONLY|O_NONBLOCK` with an `ENXIO` retry
  loop — a plain blocking open on a reader-less fifo hangs forever (probe-
  proven); persistent `ENXIO` = the process is dead.
- `stdout.jsonl` — append-only event log replacing the stdout pipe. The
  adapter TAILS it (adaptive 300ms→1.5s cadence) and feeds the same line
  reader/classifier; deltas keep landing while the bot is down. The consumed
  line-boundary byte offset persists in `state.json` (`agents[key].jsonStreamTail`)
  but only once batched answer text has actually been EMITTED — an offset past
  un-emitted text would skip it on replay (live seam-loss 2026-07-05).
  The record also carries the background-task list, a turn-in-flight flag and
  the outstanding tool calls as of that offset (written on every advance and on
  each user turn), so an adopt restores a working state the frames before the
  offset built — a long, silent tool call leaves nothing after it to rebuild
  from (L-D2), and the restored outstanding tool keeps the busy-idle watchdog
  from declaring that turn over.
- `stderr.log` — passive; read only for spawn-fail / unexpected-exit
  diagnostics. `pid` / `exitcode` — written by the wrapper; the poll tick's
  exit detection (pid-alive + exitcode file) routes into the normal
  stopped/closed handling with the real code.
- `question.json` — the pending `AskUserQuestion` control_request, persisted
  when surfaced and removed when resolved: the blocked question's
  control_request line lies BEFORE the persisted tail offset, so an adopting
  bot restores it from this sidecar and can still answer over the fifo.

On boot, reattach ADOPTS a live `cjson-*` session (reopen fifo + resume the
tail from the persisted offset → the downtime gap replays through the normal
pipeline, in-flight turn delivered end-to-end, no recap posted); a released
session (`/quit`/`/new` cleared the persisted id) is killed as an orphan, and
a thread whose process is gone SLEEPS (lifecycle plan L4): nothing is re-spawned
at boot — its next trigger resumes the conversation — and the downtime recap is
read from the transcript alone. An adopted process keeps the bot-MCP tool list
it got at its own start (the bot's MCP server is stateless and cannot push a
`tools/list_changed`), so one started under an earlier bot build — the
persisted `mcpToolDigest` differs from the current one — is stopped at its next
idle point and resumed with the current tools. Explicit stop = SIGTERM + tmux
kill + host-dir removal. The IDLE stop (`suspendSession`, lifecycle plan L3) is
the same teardown converging on `suspended` instead of `stopped`: the session
id stays persisted and the next trigger resumes the conversation; the bot never
suspends a process that `checkIsWorking` reports as working. The wrapper runs `env -u ANTHROPIC_API_KEY`, keeping
subscription billing under tmux. tmux is therefore REQUIRED for BOTH Claude
backends.

## The control protocol (reverse-engineered — not public)

`canUseTool` / `AskUserQuestion` are documented only as an SDK-library concept;
the raw stdio wire format is not published. It was captured empirically and
cross-read against `anthropics/claude-agent-sdk-typescript`. The authoritative,
verified implementation is `claudeJsonStreamAdapter.ts` — this is the map, the
code is the exact bytes.

1. **Handshake first.** Before any turn, write a `control_request` with
   `request.subtype:"initialize"` (carrying `supportedDialogKinds`) to stdin; the
   CLI replies with a `control_response`. `AskUserQuestion` appears in the tool
   set ONLY after this ack — skip it and questions silently never fire.
2. **Request.** A question or a tool-approval arrives on stdout as a
   `control_request` with `request.subtype:"can_use_tool"`, a `tool_name`
   (`"AskUserQuestion"` or a real tool), the tool `input`, a `tool_use_id`, and
   `requires_user_interaction:true`. For `AskUserQuestion` the input is
   `{questions:[{question, header, options:[{label, description}], multiSelect}]}`.
3. **Response.** Write a `control_response` back to stdin, matched by
   `request_id`:
   - allow → `response.behavior:"allow"` with `updatedInput`. For
     `AskUserQuestion` the answer rides in `updatedInput.answers`, an object keyed
     by the question TEXT whose value is the chosen option `label` (or
     `"label1, label2"` for multi-select); for a plain tool, `updatedInput` is the
     (optionally modified) tool input.
   - deny/reject → `response.behavior:"deny"` with a `message`.

The same channel carries the bot's OWN requests, answered by a `control_response`
matched on `request_id`: the `initialize` handshake above, and the MCP heal's
`{subtype:"mcp_status"}` (returns `response.mcpServers[]` with a `status` per
server) / `{subtype:"mcp_reconnect", serverName}` (a bare success ack) — shapes in
`../utils/claudeMcpHeal.ts`, used to un-latch a `failed` `telegramBot` in a
session that outlived a bot restart.

The adapter maps a `can_use_tool` request onto the bot's existing `question`
event (identical shape to OpenCode's), so the pin + one-at-a-time + inline-button
flow is reused verbatim; `answerQuestion` / `rejectQuestion` emit the matching
`control_response`.

## Selecting it (default + `/claude_mode`)

This is the **DEFAULT** Claude backend (`getDefaultClaudeBackendName` /
`resolveClaudeBackendName`): ▶️ Claude / `/claude` open it unless the thread
explicitly picked another. `/claude_mode` switches a topic between the three
Claude backends on the fly — json-stream (`json`, `jsonstream`, `json-stream`,
`stream`), per-turn (`perturn`, `per-turn`, `oneshot`), tmux-scrape (`tmux`,
`scrape`, `terminal`, `classic`; `parseClaudeBackendArg`) — the pick
persists as the thread's adapter name and the switch RESUMES the same
conversation (see "Shared session store"; `switchThreadAdapter` keeps
`claudeSessionId` for all three; `checkIsSameConversationSwitch`). The two
json-stream lifecycles share one stop-in-flight map, so a switch between them
never races its own `tmux kill-session` under the shared name. A reattach
guard stops a json-stream thread from re-adopting a stale tmux-`claude` session
at boot. `hiddenAdapterNames` (in `createAdapter.ts`) keeps both json-stream
names out of the generic `/start` agent list — they are reached via the
default + `/claude_mode`, not a start entry. (The old `CLAUDE_JSON_STREAM_THREADS`
env gate is RETIRED.)

## `/login` — out-of-band (no TUI)

This backend has no TUI to host Claude's interactive `/login`, so the bot runs it
out-of-band: `getLoginCommandRoute` (in `utils/claudeAuthLogin.ts`) intercepts
`/login` on a json-stream thread and `startClaudeAuthLogin` (in `agentLogin/agentLogin.ts`) spawns
`claude auth login --claudeai` in a bot-owned pty (`node-pty`; `ANTHROPIC_API_KEY`
stripped → subscription login). It relays the sign-in URL to the topic, takes the
user's pasted code into the pty (message deleted, 🔐 ack — same secret handling as
the tmux login-paste flow), and confirms via `claude auth status --json` (exit
code as the fallback), clearing the pinned logged-out notice on success. The pty
is a bot child (NOT restart-safe). The tmux backend's `/login` is unchanged (its
TUI hosts the paste flow itself).

## Account profiles — `CLAUDE_CONFIG_DIR` per process

A topic's Claude session runs on the account profile the topic resolves to (`/accounts`,
`utils/claudeProfiles.ts`). Both Claude adapters read the directory through the
`ClaudeConfigDirReader` registered at boot (`registerClaudeConfigDirReader`, the same
late-wiring idiom as the launch defaults) at EVERY spawn: json-stream puts
`CLAUDE_CONFIG_DIR=<dir>` into the wrapper's `env` call (`buildWrapperScript`, default
profile → the golden shape unchanged), tmux-scrape prefixes the pane command with
`env CLAUDE_CONFIG_DIR=<dir>`. The variable is in the process environment, so a child
`claude` the agent starts inherits the account. A running process keeps the account it
was spawned with — the CLI would re-read swapped credential files live, so the bot
never swaps files under `~/.claude`. A live change goes through the `/model` re-spawn
(`applyClaudeConfigDir`: `--resume` of the same id when idle, deferred to the end of
the turn when the process works, nothing for a sleeping session — its resume reads the
reader); after a bot restart an adopted process reports the directory recovered from
its own wrapper script / `pane_start_command` (`getSessionClaudeConfigDir`), and a
mismatch with the topic's current pick is corrected at the next idle point.

The json-stream adapter also reports every `rate_limit_event` frame to the
`ClaudeRateLimitSink` registered at boot (`registerClaudeRateLimitSink`), attributed to
the `configDir` the session runs under: the bot folds the frame's `unifiedWindows` into
that profile's usage snapshot and marks the profile limited on a `rejected` status
(`utils/claudeUsageRefresher.ts`). Nothing is rendered into the topic (parity).
Every `result` frame's `total_cost_usd` goes the same way to the `ClaudeTurnCostSink`
(`registerClaudeTurnCostSink`), with the conversation id and whether this process
STARTED the conversation (`--session-id`; an adopted or resumed one did not): the figure
is the conversation's running cost — the CLI restores it on `--resume` — so the bot
counts a turn's spend as the delta against the last total it saw for that topic
(`utils/claudeApiSpend.ts`), for an account billed to API credits only.

## Shared session store

Both Claude backends drive the same `claude` binary against
`~/.claude/projects/<slug>/…`, so `/sessions` reads the same transcripts (the
tmux adapter's readers are reused) and a session started in one backend is
resumable in the other.

## OpenCode (`openCodeAdapter.ts`)

- **One `/global/event` stream for the whole server**, opened with the first active session anywhere and closed
  with the last. The per-folder `/event?directory=` it replaced goes silent for an aged sole subscriber (only
  `server.heartbeat` keeps flowing), so the stall watchdog never trips and the topic hangs.
- **Owner resolution.** An event routes by `sessionID` (direct, else child→parent lineage — sub-agents run in
  CHILD sessions); when both miss it falls back to the envelope's directory (the sole active session there, or,
  when two topics share a folder, only a genuine lineage ancestor, else a LOUD drop — never a guess). Events
  for directories the bot does not own drop cheaply. Lineage is recorded from ANY event exposing `parentID`
  and refreshed on use. `question.asked` / `permission.asked` are CRITICAL: an unroutable one is logged, never
  swallowed (the old silent drop looked like a hung topic).
- **Busy queue and provider retry.** A healthy busy turn keeps new `prompt_async` messages queued. A
  provider-managed `session.status=retry` is the exception: the next prompt ABORTS the old provider wait and
  posts with the current `/model` (a model switch + `continue` would otherwise sit unread behind the old
  provider's retry deadline). Since `session.status` carries no turn id, own idles are ignored until the
  replacement's own `busy` — a wait bounded by `providerRetryReplacementStartTimeoutMs`, after which the same
  `noResponse` escalation runs.
  OpenCode's own retry loop is classified (`classifyAgentApiError` on the status message): an exhausted usage
  limit (or auth failure) never retries to success, so the adapter aborts the loop and emits `apiError` ONCE per
  episode (the bot's limit wait / fallback switch takes over). If no reset is named, a retry deadline beyond
  the normal unknown-reset wait is honored as a conservative wait hint, not a confirmed quota reset;
  short server backoffs never shorten that wait. The observed account subscription wording is a narrow
  usage-limit exception; ordinary rate-limit and overload errors remain transient. A transient retry
  posts a neutral "Provider error — OpenCode retries" notice with the sanitized reason, on attempt 1 or when the
  reason changes.
- **Wedged turns.** A bloated session can accept every prompt (`prompt_async` 204) while its agent loop exits at
  step 0: `session.idle` arrives with ZERO assistant activity, and even a server-side summarize hits the dead
  loop. `sawTurnActivity` is set ONLY by an assistant `message.updated` — the USER prompt echoes back as
  `message.part` events, and counting those masked every wedge. The bot recovers in three escalating tiers, one
  attempt each per prompt episode (`utils/wedgeRecovery.ts`, `handleNoResponse` in `bot.ts`): `resend` →
  `fork` (a fresh session carrying the full conversation) → `restart` (blank session, dialog dropped) → give up.
  The replay rides `isRecoveryReplay` so the tier only advances.
- **Background sub-agents.** OpenCode's `task` tool is synchronous: the parent session is LOCKED for the whole
  sub-agent run, so a new message queues behind it and the topic looks hung (abort does not free it). The server
  is spawned with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` and `forwardPromptToAgent` calls
  `detachRunningSubagents` before `sendInput`, which detaches a blocking sub-agent (best effort, only while a
  child session is busy); OpenCode injects its result back when it finishes.
- **Naming.** Bot-created sessions get NO title, so OpenCode auto-titles them from the first prompt; a title
  passed at creation (`/opencode <args>`) counts as user-set and is never auto-renamed (`isAutoNamePending`).
- **Effort** rides the prompt as `body.variant`, clamped to the model's variants; a thread with no pick of its own
  runs the instance default (`getInstanceDefaultEffort`: `settings.json`, else medium), clamped the same way, and
  `clearEffort` («as in General») drops the pick and takes that default for the next prompt. `setEffort` answers a typed `EffortSetOutcome` — `applied` / `stored` (saved, no agent runs yet; carries the notice) / `refused` (carries the reason) — so a caller never guesses from state whether a pick was made. `ultracode` (Claude-only) resolves
  to the model's HIGHEST variant and `auto` to no variant at all (`clampEffortToAvailable`) — never to the lowest one.
  `getEffortState` is `{ running: the live session's level, nextStart }`, the next start's level rounded with the last
  providers snapshot (synchronous: the banner needs it); `null` for a model the snapshot lists with NO variants (it
  runs without a level, the screens show none), while a model the snapshot does not know yet keeps the default. Provider auth is NOT
  thread-scoped: `/connect` and `/disconnect` resolve the OpenCode adapter through `getProviderAuthAdapter`.

## Claude, every backend

- **Effort.** Claude persists `/effort` GLOBALLY in its own settings, so a fresh TUI would inherit another
  topic's level. On every fresh spawn the tmux adapter arms the thread's stored level (`pendingEffortReapply`)
  and types `/effort <level>` the FIRST time the input box is ready — not at the spawn instant, when the banner
  is still painting and the command is left unsubmitted. Never on adopt/reattach (the surviving process keeps
  its state). A thread with no pick arms the INSTANCE default (`getInstanceDefaultEffort`: `settings.json`'s
  `defaultEffort`, else `medium`) — the same level the json-stream backends launch with (`--effort`, after the
  platform default). `getOwnEffort` is the thread's own pick only (the instance default is never stored as one);
  `clearEffort` drops it and brings a live session to the default (tmux: the `/effort` keystroke; json-stream: a
  `--resume` re-spawn, only when it runs another level). `getEffortState` says what the display shows: `running` — the
  json-stream session's `--effort` or the level the bot last typed into a tmux TUI (`runningEffort`; unknown after an
  adopt) — and `nextStart`. A json-stream adopt reads the surviving process's `--model` and `--effort` back from its
  `wrapper.sh` (`readWrapperScriptLaunchFlags`): the display survives a reload, and a later re-spawn (effort, model,
  account) passes on whichever of the two it does not change instead of dropping it.
- **Survey.** The end-of-turn feedback survey is dismissed (one Escape per appearance) by `extractClaudeSurvey`,
  whose header list (`CLAUDE_SURVEY_HEADER_REGEX`) is CLOSED and anchored on purpose — an open prose pattern
  once fired on a quoted survey. A new wording left unrecognised sits on the pane and swallows the Enter of
  the next prompt, stranding it in the input box; add the wording to that alternation.
- **Sub-agent transcripts** for `/subagent full` are tailed from the on-disk `subagents/agent-*.jsonl` files; the
  first scan seeds offsets to EOF, so there is no backlog replay on resume or adopt.
- **Interrupt.** An interrupt the bot issued yields a contentless `is_error` result on json-stream; it is
  swallowed once (`swallowNextAbortError`, armed in `sendInterrupt`) instead of surfacing a bogus
  `Claude error: API error`.
