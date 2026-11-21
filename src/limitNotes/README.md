# `src/limitNotes/` — the accounts note

An agent that launches workers picks an account once and never looks again, so it keeps spending accounts whose limits reset
late. The bot hands such a conversation a short **accounts note**: which account the next new Claude worker goes to and why,
when each limit resets — so what resets first is spent first. Agent-facing English, never posted to the topic.

## The planner (`plan.ts`) — pure

No clock, no state, no I/O: the caller hands in the report, the record, the setting and `nowMs`.

- **Who gets notes.** A conversation whose agent called `claude_profiles` or armed a worker watch in the last 7 days
  (`LimitNoteRecord.lastOrchestratedAt`). Plain chat and builder topics never see one.
- **Two shapes.** `reminder` (the pick with its reason and its week and five-hour figures, the next one or two accounts in launch order, the
  ChatGPT window, «call `claude_profiles` right before your next launch or resume»; scheduled) and `summary` (one line of the
  same figures, no instruction; only when the picture changed).
- **`decideLimitNote`** answers the shape or `null` with every reason (`limitNoteSkipReasons`, named so a log line says why
  nothing came):
  - gates for both shapes: orchestrating, not Off, a fresh figure in the usage cache (`checkHasFreshLimitUsage`);
  - reminder — turn start or mid-turn, once the interval has passed since the last note OR the agent's last `claude_profiles`
    call (calling it IS looking; never either → due); a send result carries none;
  - summary — a send result, or a turn start after 30 min of quiet (a woken session); never mid-turn; only when the
    fingerprint differs from the last note's (none stored = differs) and 30 min after it;
  - both due → the reminder alone.
- **`buildLimitNoteFingerprint`**: the recommended account; per account the `/limits` list offers its weekly use in 10-point
  steps, usable now, five-hour window past the 90 % launch ceiling; the ChatGPT weekly use in 10-point steps. A stale figure is
  its own state (`?`).
- **`buildLimitNoteText`**: from the report `claude_profiles` answers with (`buildClaudeProfilesCreditReport`) — the same pick,
  and the accounts after it are the report's `launchOrder` — the one list `getClaudeLaunchOrder` builds and the pick is the head
  of; never a second ranking. The pick's reason is `describeClaudeLaunchOutcome`'s wording. A stale figure reads
  «usage unknown», a window whose reset has passed 0 % with no countdown, an API account its credit estimate.
- The three windows (quiet, summary floor, orchestration) travel as `LimitNoteWindows`, so a flow can shorten them.

## The setting and what is kept

`/limits_reminders` (`connectors/telegram/commands/limitReminders.ts` over `utils/limitRemindersScreenPlan.ts`) is the picker; the `/limits` board's
`🔔 Reminders` row opens it.

- **Setting (`reminderChoices.ts`, imports nothing — the instance settings and the state store load before any env file).**
  `/limits_reminders`: every 1 h (default) / 2 h / 4 h / Off, stored as minutes (`0` = Off). `resolveLimitRemindersMinutes(general,
  topic)`: a topic's own choice, else General's, else the default; a stored number no choice names counts as no choice.
  General's value is `settings.json` `limitReminders.everyMinutes` (`createLimitRemindersSettingsReader`; strict — any other
  number is an error naming the field; a Jira conversation follows it), a topic's own is `state.json` `limitRemindersOverrides`
  (`getLimitRemindersOverride` / `setLimitRemindersOverride`). No env var: a window a test shortens goes into
  `CHARNESS_TEST_TIMINGS`, with the code that reads it.
- **Record (`state.json` `limitNotes[<conversation key>]`, `LimitNoteRecord`).** Epoch ms: the last note of either shape, its
  fingerprint, the last `claude_profiles` call / worker watch, the last `claude_profiles` call. Read and written in one tick
  (`getLimitNoteRecord` / `setLimitNoteRecord`), kept on disk so a restart never bursts reminders; a field of the wrong type in a
  hand-edited file counts as absent.
- **Fresh context.** Where the agent loses its context — a session start or stop, `/clear`, a completed compaction, a lost
  transcript (`bot.ts` `clearThreadContextMarker` and `noteConversationContextReset`, beside the project board's reset) —
  `clearLimitNoteFingerprint` clears the fingerprint ONLY, so the next summary is «changed»; the reminder clock (last note, last
  call) and the orchestration mark stay, so a fresh context is never a reason for an early reminder.

## Where a note rides (`service.ts`, wired in `bot.ts`)

- **A turn start (`forwardPromptToLiveAgent`).** The note is the LAST block of the ONE prompt text the forward writes, after the todo
  lines — never a write of its own (`noteText.ts`: `appendLimitNote` / `stripLimitNote`). Only a prompt its caller marked
  `isAccountsNoteCarrier`, never a slash command, only on Claude json-stream / per-turn and OpenCode (`checkIsAccountsNoteCarried`).
  The carriers are exactly: a person's message that opened a request (text, voice, free text that cancels a question, a file, an
  album, `/schedule`, the one buffered behind a start — the answer to the agent's own question opens none, so it is no carrier) and a
  session post (a tracker's request or update, a scheduled run, a fired check's wake). Every other prompt — the retry nudge, the
  hand-over, a wedge replay, a request wake-up, the todo reminder, the lost-work note, a compaction — leaves the flag off
  (`limitNotesWiring.test.ts` pins the list). A buffered carrier is decorated at its replay, with the figures of that moment. The
  note counts as delivered only once the prompt reached a live session; until then it is IN FLIGHT: no second note is taken for the
  conversation (two carrier prompts close together — a voice and a text, a message and a scheduled run — never both carry one), a
  write that failed or a session that was gone `release`s it, and one whose prompt never reached an end (a forward that threw before
  the write) is forgotten after `limitNoteInFlightMaxMs` (5 min).
- **Quiet.** «The session woke up» is `now − lastTurnEnd` while nothing runs (`getAccountsNoteQuietMs`): the persisted turn-end
  stamp, because a person's own message stamps the activity instant the idle timer uses at its arrival, before the forward.
- **A send tool's result** (`send_messages_to_user`, `send_file_to_user` of a topic and of a Jira issue, `answer_request`): the
  MCP surface appends the note as the last block (`takeLimitNoteForSend`; the conversation is the resolved thread, for
  `answer_request` the request's). Never the reminder; recorded as delivered at once. A failed send gets none.
- **Hidden from the topic.** The renderer of a tool result cuts the note off a bot tool's output (`checkIsBotMcpToolName`) before it
  truncates or shows it, for every `/tool_results` mode. The five readers of a stored user prompt — the resume context, the fallback
  hand-over, both session-title builders and the OpenCode auto-rename — cut the glue through ONE helper, `getUserPromptWithoutGlue`
  (the preamble, then every note): stale figures must not reach a new agent. The strip follows the note's SHAPE (`noteText.ts`: a
  summary is its header line; a reminder its header, at most one `Then …` / `ChatGPT: …` line and the fixed instruction line) wherever
  it sits, because the CLI merges messages queued behind a prompt into ONE user turn and the person's next message follows the note
  there. `plan.ts` writes the notes from the same constants.
- **What makes a conversation orchestrate.** `claude_profiles` (records the call, restarts the reminder clock, stores the fingerprint
  of the NOTES' own report — never of the answer the agent got, which was built for its model and its resumed account and differs from
  the notes' whenever the call was a resume) and `schedule_create` with a worker watch (`checkCommand` + `statusWorkerRunDir`). The scope is resolved like the
  send tools; a folder token with several bound topics names none and records nothing.
- **Test windows.** `CHARNESS_TEST_TIMINGS` `limitReminderIntervalMs`, `limitNoteQuietMs`, `limitNoteSummaryFloorMs`,
  `limitNoteEnginePollMs` (each may only shorten its production window). No env var of its own.

## Mid-turn delivery (`engine.ts`) — Claude only

A running Claude turn learns where the limits stand after its NEXT TOOL CALL, not only at its next prompt.

- **The inbox.** `utils/midTurnInbox.ts` is the project board's per-session inbox (`todos/midTurn.ts`) made sectioned: one file
  `DATA_DIR/todos/inbox/<session id>.json`, the `accounts` section (this feature) joined before the `todoBoard` one. The
  launch's ONE `PostToolUse` hook (`utils/claudeCompactHook.ts`, unchanged byte for byte) prints the file after the agent's tool
  call — `additionalContext`, no stdin, so nothing the CLI's input accounting sees. The FILE is taken whole: every section it held
  counts as taken, each section's `onTaken` fires once; a section's withdrawal rewrites the file without it and never touches the
  other. A failed write throws and registers nothing.
- **The engine.** Its own poll (`limitNoteEnginePollMs`, 60 s; the todo engine stops with the lists off, this one does not) over the
  shared `createSessionTurnProbe`: a Claude json-stream / per-turn conversation (`getClaudeSessionId`, null for OpenCode and the
  terminal — they get no mid-turn path: OpenCode's only channel is a prompt queued into the running turn, which the backend counts as
  input) that is active, busy and not `isTurnEndBlocked` (a question, a compaction, an armed retry, a retry kick, a wedge recovery, a
  session start) and whose reminder is due (`LimitNotes.takeMidTurnNote`: the reminder only, never the summary) gets its `accounts`
  section written.
- **Never into a bookkeeping turn.** A turn the bot starts for its own bookkeeping — the retry's «continue» nudge, a request wake-up, the
  todo standalone reminder, the lost-work note, a question's answer, a wedge replay, the hand-over's first prompt — got no note at its
  start, and the engine gives it none at its first tool call either. The mark is per conversation, in memory (`LimitNotes.noteTurnStart` /
  `noteTurnEnd` / `checkIsBookkeepingTurn`): the forward sets it right before its write for every prompt that is no carrier and no slash
  command, and only when the session runs nothing (a prompt queued behind a running turn opens none of its own, so that turn keeps what it
  was); a person's, tracker's or scheduler's prompt on an idle session clears it; the turn end clears it (`handleAgentTurnEnded`). A
  waiting section of such a turn is withdrawn. After a restart an adopted turn is simply not marked.
- **Delivered only when taken.** The record (`lastNoteAt`, the fingerprint) moves when the hook took the file (`onTaken` →
  `markDelivered`). A section withdrawn unseen — the turn ended, was held open, the session ended or changed, a turn start the bot
  makes (its prompt may carry the note itself), a boot — gives the note back (`release`) and it stays due. While it waits, no other
  note is taken for the conversation (the in-flight note: it also closes a window in which a send tool's result could carry a
  second one); a turn start or a session boundary withdraws it first. The in-flight mark of a turn-start note is forgotten after
  `limitNoteInFlightMaxMs` (5 min) whatever its owner did, so one lost path never silences a conversation. A MID-TURN note has no
  expiry: it can wait as long as no tool call finishes (a long watch, a `sleep`), and the inbox ends it on every exit — taken,
  withdrawn, replaced, cleared at boot, a failed write (the engine gives it back) — so nothing else is carried beside it meanwhile.
- **A late delivery never rolls the record back.** The note's fingerprint is that of the moment it was TAKEN. When the hook takes the
  file after a newer look or note was recorded (`lastProfilesCallAt` or `lastNoteAt` later than the take), the record stays as it is
  (`getLimitNoteRecordAfterDeliveredNote`): the older picture would otherwise make the next summary read as a change although nothing
  moved since the agent looked. The `claude_profiles` call also withdraws a waiting reminder before its result is returned — the hook
  runs only after that result, so the agent is not told to call the tool right after it did.
- **Where it is withdrawn** (`bot.ts` `withdrawAccountsInbox`, a guard in `limitNotesWiring.test.ts` lists the callers): every forward
  (a slash command too: `/compact` opens a held turn), the adapter's turn end, a session's start / close / suspension / stop
  (`clearThreadContextMarker`), a conversation's fresh context (`noteConversationContextReset`), the agent's `claude_profiles` call,
  and the engine's own poll for a session that is no longer busy or is held open. Where the fingerprint is cleared (a fresh context)
  the withdrawal comes FIRST: a file the hook had already taken is recorded as delivered by it, and that record must not land after the
  reset. A withdrawal whose rewrite of the file fails removes the file whole and gives every section back. The boot clears every
  inbox file (`clearAll`): what one carried is still due.
- **Read-only towards every lifecycle module.** The engine imports only the session key and three types; its deps are the conversation
  list, the Claude session id, the turn probe, the notes' `takeMidTurnNote` / `checkIsBookkeepingTurn` and the inbox — a guard pins both.

## Lifecycle safety — a note is a passenger, never a cause

Every later scope of this feature keeps these seven rules; each has a test.

1. Never activity: no `lastActivityAt` stamp, no idle-timer re-arm, no held-mark logic touched.
2. Never input: no write of its own to an agent (the turn-start note is part of the ONE prompt text, the Claude mid-turn note is
   hook `additionalContext`, the send-result note is tool-result text); no unconsumed-input entry, no request, no working signal.
3. Never wakes: no path calls `ensureAgentSession` or a resume; only a session that is active AND busy gets a mid-turn note
   (`engine.ts`).
4. Never «working»: no typing, no busy flag, no indicator refresh, no stdout or tool event.
5. Never into a held turn: compaction, limit wait / retry kick, question wait, wedge recovery, session start — nor, mid-turn, into a turn
   the bot started for its own bookkeeping.
6. The deferred account switch and the self-update idle verdict read nothing a note moves.
7. Restart-safe: note state persists, a restart neither bursts reminders nor leaves an inbox file behind.
