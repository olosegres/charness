# `src/scheduler/` — schedules, reminders and the bot-owned MCP server

Two things live here: the schedule engine (store → recurrence → engine → delivery, with a run ledger) and the
MCP server the bot injects into every agent session (`mcpSurface.ts`). Caps, intervals and timeouts are named
constants in the code; this README keeps what the code cannot say.

## Two delivery kinds, one store

`ScheduleRecord.deliveryKind` is ABSENT for an agent-prompt job (`/schedule`, or the agent's own
`schedule_create`) and `'reminder'` for a bot-local `/reminders` job. Read the discriminator through
`checkIsReminderSchedule` — never re-derive it.

- **Agent-prompt job:** at fire time announce → PIN (notifies unless `isPinSilent`; pins accumulate as run
  history, the bot never unpins) → `postToSession` (reuse an active session, waiting for idle rather than
  interrupting live work, or start one) with a `[Scheduled run]` marker.
- **Reminder:** announce → pin → `delivered`, and stops. It never reaches an agent, which is exactly why it
  fires in an unbound topic and in General.
- **Caps are counted PER KIND** (`maxSchedulesPerThread`, `maxRemindersPerThread`): storage is shared, counters
  are not. One shared counter starved the operator's reminders behind 30 agent jobs, and made the agent read
  "maximum of 30" beside a list of 5 and cancel everything it could see.
- Reminders are filtered out of the agent-facing `schedule_list`, and `schedule_cancel` of a reminder id
  answers the plain "no schedule with this id" — an agent must not see or delete what the operator created
  with buttons.
- Leaving a folder pauses the thread's AGENT-PROMPT jobs only (`getUnboundPausableSchedules`; a reminder needs
  neither folder nor agent); `/bind` resumes them from now, and an expired one-shot is dropped
  (`rebindResume.ts`).
- `schedule_create` is agent-robust (`buildSpecFromCreateArgs`): a one-shot IGNORES a redundant `repeatCount`
  (the model sends `repeatCount:1` to mean "once"; rejecting it made it spiral into absurd counts), blank
  `cron` / `onceAt` count as absent, and a structural error echoes the whole 3-mode recipe. A single future run
  is ALWAYS `onceAt` — a cron has no year and would re-fire every year.

## Restart and time

- Timers re-arm from `state.json` at boot; a run missed while the bot was down fires ONE catch-up annotated
  with the missed time. During an armed usage-limit wait a due run is HELD and rides the resume
  (`holdForLimitResume` in `postToSession.ts`).
- **A timezone change must NOT go through `engine.rearmAll()`** — that is the BOOT replay: it arms from each
  job's stored `nextRunAt` and reads a now-past one as a MISSED run, so it would announce, pin and deliver a
  bogus catch-up into every topic. `timezoneRecompute.ts` recomputes `nextRunAt` from now first (reusing
  `getRebindResumeAction`), persists, and only then arms; paused jobs are recomputed too but stay disarmed.
  No `timezone` option is passed to croner on purpose: with `process.env.TZ` applied its default already is
  the operator's zone, and a per-job zone would be a second source of truth.

## The bot MCP server (`mcpSurface.ts`, `injection.ts`, `mcpBoot.ts`)

- Stateless streamable HTTP on loopback. The port is OS-ephemeral but PERSISTED in `state.json`
  (`schedulerMcpPort`) and reused so injected URLs stay valid across restarts; `SCHEDULER_MCP_PORT` pins it
  and wins. A port in use at a start is retried (`schedulerMcpBindRetryCount` × `schedulerMcpBindRetryDelayMs`,
  the shutdown watchdog's bound: the previous process may still be exiting) before the ONE fallback to an
  ephemeral port. The fallback is logged as an error because a Claude session launched earlier keeps the
  address of its launch and loses the bot's tools until it is restarted (the heal reconnects to that same
  address, it cannot move a session). If the bind fails the bot still boots with injection inert — sessions
  spawned meanwhile lack the agent-facing tools, and a Claude one keeps lacking them (the heal never adds an
  absent server).
- **Every tool's input is a `StrictToolInput`** (`strictToolInput.ts`): `registerTool` takes only a strict zod object, so a
  tool built on a raw shape does not compile. The SDK wraps a raw shape in a STRIPPING object — a misnamed key
  (`filePath` for `path`) vanished before the handler ran and the call still answered "delivered". An unknown key is now
  a tool error naming it, hinting at the nearest allowed key and listing the allowed ones; an object nested in an array
  item is built with `createStrictToolInput` too, and a union around it takes `getUnknownKeysMessageOfUnion` as its
  `error` so zod's bare "Invalid input" carries that message. The SDK refuses a call's input before any
  code of the bot's runs, so a refusal for an unknown key is reported from inside the request: the request handler runs a
  `tools/call` under `runWithRefusalLogging` (an `AsyncLocalStorage` carrying the tool name and `deps.logDiagnostic`),
  and the strict object's error callback leaves ONE bounded line (`[scheduler-mcp] <tool> refused a call: unknown
  key(s) [...]`) in `agent-diag.log`. A client that fails every call because of a key of its own is then visible. The digest hashes only the shape's keys, so closing the
  objects did not move it. `schedulerMcpStrictInput.test.ts` walks every tool a session gets over the real server.
- Bearer tokens are HMAC-signed and scoped `thread:` (Claude, one conversation) or `dir:` (OpenCode, every
  thread bound to the folder). `getSchedulerScopePlatform` reads the scope's platform: only a Telegram session
  gets `schedule_*`, `send_file_to_user` and `send_messages_to_user`; any other platform sees just
  `answer_request` + `compact_conversation`, and `buildMcpServerInstructions` names no Telegram tool. A Jira
  session also gets `jira_get_attachment` — only when the Jira connector is loaded, through the
  `fetchJiraAttachment` port it supplies (the connector stays lazily loaded); the issue is the session's own
  conversation, taken from its token, never from an argument. The tool changes the Jira digest, so an adopted
  process reconnects at idle (L4).
- `todo_update` / `todo_read` (the shared todo registry, `../todos/`) are offered to a Telegram AND a Jira session
  when the `todos` port is wired, never to a session no codec reads; the instructions name an optional tool only
  where it is offered (`OptionalBotTools`). The conversation comes from the token (`resolveTargetThreadKey`).
- The server serves BEFORE sessions re-attach, so a tool that reads session state awaits
  `deps.whenSessionsRestored()`. Boot order is `runSessionBootPhase`: bot MCP first, then reattach and
  restores, then `onSessionsRestored`, then the active-session heals, then the schedule re-arm. A session
  re-attached while injection was still inert would be born without the server.
- **`GET /mcp` answers 405.** This server never initiates a message; answering the SDK's way parked a
  standalone SSE stream that carried nothing and died with every hot reload, and a client that then spent its
  ~15 s reconnect budget latched the whole server `failed`, stranding the bot's tools in a session built to
  survive the restart.
- **Heals** at boot: OpenCode `reconcileSchedulerMcpForActiveSessions` (re-registers a `telegramBot` that is
  missing or not `connected` — OpenCode does not reconnect a remote MCP dropped in the restart gap); json-stream
  `healSchedulerMcpForActiveSessions` → `healMcpServer` (`mcp_status` / `mcp_reconnect` over the control
  channel, only for a `failed` entry).
- MCP cancellation is a separate HTTP notification while every transport is fresh, so the server correlates by
  verified token + a bounded client id (injected per registration) + the typed request id, and keeps a
  short-lived cancellation-before-registration tombstone set.
- Connect-time `instructions` and tool descriptions are cached by the client at connect: an already running
  agent sees edits only after it reconnects.
- **Watching a detached worker.** `workerWatchCheckCommand` is the one recipe for a check on a worker an agent
  launched: it fails when the worker's PID is gone OR nothing in its run dir changed for 45 min (a `kill -0` alone
  never fires on a hung worker), armed with `isPinSilent: true` (`workerWatchPinArgument`) because a normal finish
  fires it too; the job remembers the alerts it pinned (`alertPinMessageIds`) and `schedule_cancel` unpins them, so a
  finished worker leaves no pin once its watch is cancelled. The `schedule_create` description carries the full recipe; the Telegram instructions point at the
  `charness-manager` skill (`agent-plugin/`, which carries it verbatim — `agentPluginSkills.test.ts` holds them equal)
  and at that description; the tracker instructions only at the skill. With the scope's «Bot skills» switch off
  (`utils/botSkills.ts`) the pointer at the skill is dropped — a Telegram bullet keeps the recipe, a tracker bullet goes
  with it. A `dir:` scope — the OpenCode registration of a folder, made once per folder and server run — counts the folder's
  OpenCode topics alone (a Claude topic bound to the same folder has its own `thread:` scope) and keeps the pointer while any
  of them has the skills on; a folder with no OpenCode topic follows the instance value. The tool digest takes the switch too (`getToolDigest(platform, isBotSkillsEnabled)`).
- **The status line of a passing check** (`checkStatus.ts`, `workerActivity.ts`, `updateCheckStatus` in `delivery.ts`). A
  check with a status source — `statusWorkerRunDir` (a worker's run directory) XOR `statusCommand` — makes the BOT post one
  short silent line into the topic («⏳ builder S2 · works 30 min · now: Bash: Run the unit tests») every
  `statusEveryMinutes` (5–240, default 15; the worker-watch recipe passes 15 and ticks every 5 min, so the line comes every
  third tick: a line is due an interval LESS A SLACK after the last one — `createdAt` before the first — because a tick
  lands a few seconds after the minute). It never touches `postToSession`: no agent wake, no tokens, so it keeps coming
  while the agent is idle, compacting or stopped.
  - **Source.** «now» is the worker's last text or tool call (whichever came last), read from the newest top-level
    `events*.jsonl` of the run directory (`events-2.jsonl` of a resume beats `events.jsonl`; mtime decides) — the last
    1 MiB of it, Claude `stream-json` and OpenCode `--format json` both; or the first output line of an exit-0
    `statusCommand`. Nothing readable → the line is still posted, without its «now». A relative run directory is read from
    the bound folder, like a check's cwd.
  - **One line at a time.** A new line is POSTED silently and recorded (`statusMessageId`, `lastStatusAt`, flushed), then
    the previous one is deleted (an edit in place would not bump the topic); a failed post changes nothing and the next
    run tries again; a failure of the whole status path is logged and never fails the check.
  - **Gate.** `checkIsCheckStatusShown`: a Telegram conversation whose view shows the stream (`stream`, `streamAnswers`).
    The answers-only view and a tracker conversation (Jira) get nothing — a line present when the topic turns
    answers-only is deleted at the next run, and the lines resume when it turns back.
  - **Stop.** The first failure (the worker finished or hung — the alert and the agent wake take over), the job's final run
    and `schedule_cancel` delete the last line.
