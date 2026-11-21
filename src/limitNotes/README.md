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
- **Test windows.** `CHARNESS_TEST_TIMINGS` `limitReminderIntervalMs`, `limitNoteQuietMs`, `limitNoteSummaryFloorMs` (each may only
  shorten its production window). No env var of its own.

## Lifecycle safety — a note is a passenger, never a cause

Every later scope of this feature keeps these seven rules; each has a test.

1. Never activity: no `lastActivityAt` stamp, no idle-timer re-arm, no held-mark logic touched.
2. Never input: no write of its own to an agent (the turn-start note is part of the ONE prompt text, the Claude mid-turn note is
   hook `additionalContext`, the send-result note is tool-result text); no unconsumed-input entry, no request, no working signal.
3. Never wakes: no path calls `ensureAgentSession` or a resume; only a session that is active AND busy gets a mid-turn note.
4. Never «working»: no typing, no busy flag, no indicator refresh, no stdout or tool event.
5. Never into a held turn: compaction, limit wait / retry kick, question wait, wedge recovery, session start.
6. The deferred account switch and the self-update idle verdict read nothing a note moves.
7. Restart-safe: note state persists, a restart neither bursts reminders nor leaves an inbox file behind.
