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
- Bearer tokens are HMAC-signed and scoped `thread:` (Claude, one conversation) or `dir:` (OpenCode, every
  thread bound to the folder). `getSchedulerScopePlatform` reads the scope's platform: only a Telegram session
  gets `schedule_*`, `send_file_to_user` and `send_messages_to_user`; any other platform sees just
  `answer_request` + `compact_conversation`, and `buildMcpServerInstructions` names no Telegram tool. A Jira
  session also gets `jira_get_attachment` — only when the Jira connector is loaded, through the
  `fetchJiraAttachment` port it supplies (the connector stays lazily loaded); the issue is the session's own
  conversation, taken from its token, never from an argument. The tool changes the Jira digest, so an adopted
  process reconnects at idle (L4).
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
