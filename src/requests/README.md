# `src/requests/` — request / answer core

A *request* is one unit of work handed to a conversation's agent: a user message, a scheduled run, a tracker
event. The agent answers through the `answer_request` MCP tool and the platform's `AnswerSink`
(`../platform/answerSink.ts`) delivers it. Nothing here knows Telegram or Jira — both go through the same code.
Numeric bounds are named constants in the files below; this README says only what the code cannot.

## Merge rule (`requestGroup.ts`)

- A request supersedes an earlier open one ONLY within the same **request group**: the conversation (the
  surface and the topic / thread / issue — the `SessionKey`) plus the **requester**, read from the origin's
  `requester` attribute (`requestRequesterAttribute`). `getRequestGroupKey` is the one place the key is
  derived. Two people writing in a row in one topic keep two open requests, each owed its own answer; two
  messages in a row from one person merge into the newer request. An origin without a requester is the
  empty requester (all such requests of a conversation share one group).
- Telegram files operator entry points under the sender's user id and a scheduled run under the
  scheduler's marker (`utils/topicRequest.ts`), so a run never merges with a person's request.
- The persisted field name is `<conversation key>` + unit separator + URI-encoded requester; a bare
  conversation key (written before requesters existed) reads as the empty requester (`emptyRequester`).
- **A request with the empty requester keeps the old rule**: the conversation's next request supersedes it
  whoever raised that one (a restart onto this code must not leave such a request lingering with
  wake-ups). It is closed in a separate step right after the new request is saved — a crash between the
  two leaves it open for the next request, never a lost new one.

## Ledger (`requestLedger.ts`)

- **At most ONE open request per request group** (`state.json` `openRequests`, keyed by the serialized
  group, changed under the state's per-conversation lock). `createRequest` supersedes the group's previous
  request in the same atomic step and resolves only once the new request is flushed to disk — an id an
  agent was told about is never lost to a crash.
- **A superseding request names what it replaced.** The new request carries `supersededRequestIds` (the
  replaced one and, through it, what that one had replaced — newest `supersededRequestIdsMaxLength` kept);
  the closed record carries `supersededBy`. `createPrompt` receives both the id and those ids, so the kept
  prompt and the forwarded one read the same header.
- **Crash ordering.** The closed-history line (`DATA_DIR/requests.jsonl`) is written BEFORE the open entry is
  dropped, and `load` drops any open entry the history already shows closed, so a crash never leaves one both
  open and closed.
- **Load gate.** `load` runs at boot before the bot MCP server serves; until it resolves every call throws
  `RequestLedgerNotLoadedError`, and tool handlers await `whenLoaded()`.
- **Alerts are durable.** A request's alert handle is stored with it. When the request closes by any path, the
  handle joins `unreleasedRequestAlerts` in the close's own save and leaves only once `releaseAlert`
  succeeded; `load` releases every leftover, so a crash never leaves an alert pinned for good.
- **The prompt is kept** (`createPrompt`) until the agent took it in (`isPromptTakenIn`), so a failed post, a
  restart or a limit wait re-delivers the real prompt — a bare reminder would name a request the agent never
  read. It is never written to the closed history. A prompt can wait for hours before it is delivered, so a
  connector whose prompt states something that changes meanwhile registers ONE refresher
  (`storedPromptRefresh.ts`); `getPromptNotTakenIn` — the one place the untaken prompt is read for delivery: the
  wake-up's resend, the resume of a limit wait, a new session's first prompt — asks it first. It is the text itself
  for anything the refresher did not build; a refresher that throws leaves the stored text. A prompt that arrived
  during a limit wait is not held apart from its request: the ledger keeps it and the resume posts it from there.
  Jira's mention note is the one user (`connectors/jira/README.md`).
- Closed ids stay known only up to `closedRequestIndexMaxSize`; an older one reads as unknown.
- **`onRequestClosed`** reports every request that leaves the open set (an answer, a cancel, a supersede), from inside the close — a
  listener only schedules. The task-agent slots (`trackers/`) read the open set for their count and use the report to wake a
  connector's poll when somebody waits for a slot. **`onRequestWakeStopped`** reports once when the wake-up rules give up on an open
  request (`isWakeStopped` turns true, whoever wrote it — every writer goes through `updateOpenRequest`): the request stays open but no
  longer holds a slot, which is the same news for the slots as a close.

## Header (`requestHeader.ts`)

- Agent-facing, English on every surface (not localized). A request that superseded others gets a line
  naming them and asking for only what this request adds — "if you already answered them, do not repeat
  that answer; if it adds nothing new, say briefly that the answer is above". The line is honest in both
  timings: an agent that reads the new prompt mid-turn gives one answer; Claude Code delivers a message
  written mid-turn only AFTER that turn ends, so the agent has by then answered the replaced request (the
  answer is delivered — content is never dropped) and must not redo the work. `joinPromptsNotTakenIn` is
  the re-post text of a conversation's untaken prompts (one per requester at most).
- **How an answer is written is ONE sentence, `answerStyle.ts`**: like for a manager or QA, brief and to
  the point. Every surface that asks for an `answer_request` answer joins that constant — the header, the
  wake-up and answer-tail reminders, the bot MCP's instructions, `answer_request`'s description, its `body` field and its
  result to a progress note, the Jira context preamble — so the guidance never drifts between them. Change
  the wording there only; each surface's test asserts it includes the constant and `answerStyle.test.ts`
  pins what it says. A re-described tool changes the MCP tool digest, so an adopted session reconnects at its
  next idle point (L4).

## `answer_request` (`answerRequest.ts`)

- An unknown id and an id outside the caller's scope are refused ALIKE — a session cannot probe other
  conversations' ids.
- A failed delivery leaves the request unchanged, so the agent can retry. After a delivery `progress` keeps
  the request open (counted, and it marks a kept prompt as taken in); `question` and `final` close it. An
  answer to an already closed request is still delivered and changes nothing — deliberately, never blocked;
  for a superseded request the tool result names the request that replaced it, so the agent knows which
  one its answer belonged to.
- A `final` to an open request may carry one more line (`getFinalAnswerNote`): the todo registry's reminder when the
  conversation's published list still shows work in progress the request never updated (`../todos/README.md`).
- An accepted answer's outcome names the request's conversation (`conversationKey`): the MCP surface hangs the accounts
  note on the result of a conversation it is due for (`../limitNotes/README.md`).

## Wake-ups (`wakeUpRules.ts` = pure decisions, `wakeUpEngine.ts` = timers)

- **One watch per REQUEST**, not per conversation: with two requesters' requests open in one topic, each is
  followed to its own turn end — the answered one closes, the silent one is woken. The sweep skips only
  requests that are watched.
- A turn has ENDED only when the session is idle, nothing blocks it (pending question, compaction, armed
  retry or limit wait, session start, wedge recovery) and the backend has TAKEN IN the request's message
  (`checkHasUnconsumedInput`) — otherwise an earlier turn's idle reads as the end of this request's turn.
- A silent turn wakes the agent at once; the second silent turn in a row alerts and stops; a `progress` note
  resets the counter and schedules a follow-up; every wake passes `maxWakeUpsPerRequest`. Requests nobody
  watches get a backstop wake (`getRequestBackstopMs`).
- **A tracker conversation whose process is gone is woken at once, not at the backstop** (`restarted`,
  `decideRestartWake`, `scheduleRestartWake`): at a boot that did not find its process (not adopted, the
  conversation sleeps) while it holds an open request that waits for nothing of its own (no post retry, no
  progress follow-up, no armed usage-limit wait, not given up), and when its process ended with its own work
  pending (`utils/lostWork.ts`; the lost-work note rides the wake). One wake per conversation covers all its open
  requests in ONE forward — each request's prompt again when the session never took it in (R21), else its
  reminder — and one watched turn; the wakes are `restartWakeStaggerMs` (30 s) apart, the first one too, so a
  connector's first poll can supersede what it re-opens before anything is woken. A wake counts against the cap;
  one that cannot reach a session is left to the backstop, no alert. The lost-work cooldown (10 min, persisted)
  guards it: a conversation woken so within it is left to the backstop, so a crash loop is no wake loop.
  A Telegram topic keeps its own lost-work resume and is never woken this way. NOT covered: a tracker process that
  crashes while the bot keeps running, with no work of its own pending (no lost-work note) — its watched turn reads
  `sessionGone` and the request still waits for the backstop.
- **A request waits for its schedule** (`scheduleWait.ts`, platform-neutral; the engine's optional `getScheduleWait` port reads the
  conversation's jobs at every decision): a job counts when it is armed under the request (`ScheduleRecord.requestId` is the request's id
  or the id of a request it replaced), is an agent job (a prompt job or a check, not a reminder) and is not paused. The reading is `none`
  (no job counts), `watching` (a job counts and is not a failing check) or `armed` (every counting job is a failing check: a watch that
  just fired). `armed` counts only at the END of a watched turn (the agent that handled the wake is not silent); between turns a failing
  check nobody handled (the agent died in the wake) does not hold the request, so the backstop takes it. A reading never decides alone:
  what a watch may keep quiet is the rule table below, which is the whole rule — change it and its test together.
- **When a waiting request may stay quiet — the complete rule.** Two things are read besides the reading:
  - *Owed* (`checkIsAnswerOwed`), read from the PERSISTED request, so a restart that loses the engine's in-memory watches changes nothing: a silent turn is pending (`silentTurnCount` > 0), or a person's words reached the agent after its last
    answer (`isPersonInputUnanswered`: set by `trackForwardedTurn` when a forward carries a request prompt or an issue update, cleared when a
    `progress` answer is delivered), or a person's request (`origin.kind` is not `scheduledRun`) was never answered (`progressAnswerCount`
    0). A scheduler fire's own request (`scheduledRun`) is the alarm's and owes nobody anything.
  - *Tracked* — the engine holds the request's turn (`watched`, memory only) — or *lost*: a restart, a process that died (`sessionGone`) or
    a stale drop took it, and only the persisted request is left. That is the one thing a restart changes, and why *owed* is persisted.

  What the rules do (`decideTurnEnd` at a tracked turn's end, `decideUnwatchedRequest` / `decideRestartWake` between turns). «Silent» =
  `silentTurnCount` +1 and the wake `silentTurn`; at the second silent turn in a row the alert `silentTurns` and the wake stop. «Quiet» =
  the activity is recorded, nothing else happens. «Held» = `watching` and nothing owed: no follow-up, no backstop, no restart wake. «Taken
  back» = the request is not held, so a due follow-up, else the backstop (90 min after the last activity), else the restart wake applies,
  exactly as without a schedule.

  | # | Turn | State | Turn end (tracked) | Between turns |
  |---|------|-------|--------------------|---------------|
  | 1 | person prompt (the request's own prompt, a R21 re-delivery) | tracked, nothing pending | no answer: **silent**, whatever the reading. A `progress` note: reading `none` → follow-up in 15 min; `armed` / `watching` → quiet, no follow-up | after the note nothing is owed: `watching` holds; `armed` / `none` → follow-up, then backstop |
  | 2 | person prompt | tracking lost | no turn end is decided | owed (the flag, persisted when the prompt was forwarded) → **taken back** even under `watching`: backstop 90 min after the last activity, a restart wake at once for a tracker conversation whose process is gone; the reminder's turn is row 8 |
  | 3 | person prompt | silent count pending | no answer: count +1 → the alert `silentTurns` (give-up), whatever the reading. A `progress` note resets the count | owed → taken back |
  | 4 | issue update (a requester's comment) | tracked, nothing pending | as row 1 | as row 1 |
  | 5 | issue update | tracking lost | no turn end is decided | as row 2 |
  | 6 | issue update | silent count pending | as row 3 | as row 3 |
  | 7 | engine reminder (follow-up, backstop, restart, silent-turn) | tracked, nothing owed (the request was answered) | reading `none` → no answer is **silent**; `armed` / `watching` → quiet, so the agent may say nothing. A `progress` note as in row 1 | as row 1 |
  | 8 | engine reminder | tracking lost | no turn end is decided | owed → taken back; not owed → `watching` holds |
  | 9 | engine reminder | silent count pending (the silent-turn reminder) | no answer: count +1 → the alert `silentTurns`, whatever the reading (a reminder carries no person's words, but an answer is owed) | owed → taken back |
  | 10 | scheduled fire (`isScheduledRun`; the alarm's turn) | tracked, nothing pending | no answer: **quiet**, whatever the reading (a woken agent with nothing to report is no silent turn); the request's due follow-up is left alone unless a schedule holds it. A fire's own request (`scheduledRun`) that got no answer closes `cancelled` silently. A `progress` note as in row 1 | nothing owed (or the alarm's own request): `watching` holds |
  | 11 | scheduled fire | tracking lost | no turn end is decided | as row 8 |
  | 12 | scheduled fire | silent count pending (the fire rode a request that owes an answer) | quiet end that leaves the count (and a person's flag) as it is: never reset, never raised. A fire that JOINED the person's turn is merged into it (below) and is not the alarm's | owed → taken back: the count still ends in the give-up |
  | 13 | bot «continue» (after an API error or a limit wait) | tracked, nothing pending | merges into the turn it continues and KEEPS its kind (a person's stays a person's, the alarm's stays the alarm's); the progress count restarts, so a note sent before the error is not this turn's. The end is then that kind's row (1, 4, 7 or 10) | as that row |
  | 14 | bot «continue» | tracking lost | the nudge starts a plain turn: not a person's, not the alarm's (a `scheduledRun` request excepted). Its end reads the persisted request: owed → silent as in row 9; not owed → row 7 | as row 8 |
  | 15 | bot «continue» | silent count pending | an API-error retry keeps the count (row 9 applies at the end); the end of a limit wait (`isCountersReset`) zeroes the count, the wake count and the follow-up and lifts the limit stop, but never the person's flag — what is owed stays owed | owed → taken back |

  Notes on the table. A woken agent in a tracker conversation may, and preferably should, stay silent about an alarm (rows 7, 10, 11):
  that is the only thing a watch buys, and it never reaches a person's words. A post retry still runs while a watch holds the request (the
  agent never saw the request). Nothing here posts on a Jira issue: a quiet end is silent by definition. In a Telegram topic with requests a
  fire opens a request of its own (`origin.kind` `scheduledRun`): the engine reads the origin, so its turn is the alarm's whoever tracks
  it, and nothing is posted, owed or backstopped when the agent leaves it unanswered. A scheduler fire is not a wake-up and never counts
  against the cap. This is why an agent in a Jira issue can launch a worker, arm its watch, answer `progress` and end its turn, and why a
  Telegram topic in a view with requests is no longer reminded every 15 minutes while its own watch passes.
- **A forward into a turn already watched for the same request MERGES with it** (`trackForwardedTurn`): a fire that waited behind a
  person's turn (`postToSession` waits up to 10 min, then forwards into the running turn), a reminder behind a silent one, an issue
  update during a fire, the bot's own «continue». The merged watch keeps the earlier start of the progress count (a «continue» starts it
  afresh), is a request prompt's if either was (R21: the prompt is still marked taken in), carries a person's words if either did, and is
  the alarm's only if BOTH were (a «continue» carries no person's words, so it keeps the kind) — an alarm that joined a requester's turn
  never turns that turn's silent end into a quiet one. A fire riding a request also leaves its pending post retry alone: it carries none
  of the request's message.
- A request whose prompt could not be posted is retried on `postRetryDelaysMs`, OUTSIDE the wake-up cap
  (`notePostFailed`); a message forwarded any other way drops a pending retry.
- A failure in one conversation is logged and never stops the others or rejects a timer tick — an unhandled
  rejection ends the process.
- Cancelling the conversation (`/esc`, `/c`, `/quit`, `/quitall`, `/new`, a `/resume` pick, leaving the
  folder, switching to another agent or a shell) closes EVERY open request of the conversation `cancelled`
  (`cancelConversation`); a limit-wait stop and the counters reset of a "continue" nudge apply to every one too.
- **A topic prompt settles its request by where it went** (`topicRequestSettle.ts`, over the engine and the ledger as ports): a prompt
  that reached a session — or waits behind its start — has its turn tracked; one that found no session (it waited for a bot restart's
  replay and the person was told) closes the request it opened `cancelled`, so no wake-up prods the agent for a turn that never started.

## The tail after a final answer (`answerTail.ts`, followed by the wake-up engine)

- Only where the view hides the stream (a Telegram topic in "Answers only"): there the requester sees just the
  answers, and work the agent goes on with after its `final` would never reach them — the request is closed, so
  no wake-up rule covers it.
- Any delivered answer ends the previous tail; a `final` starts a fresh one. The agent's own text after it is
  counted in messages (a pause of `answerTailMessageGapMs` starts a new one; sub-agent chunks, summaries,
  questions, bot-made blocks, spinner bursts and API-error lines are not its text).
- A closing line right after the answer is no tail. Text later than `answerTailGraceMs`, or
  `answerTailMessageCount` messages in all, is: the sweep reminds the agent once its turn ended, or after
  `answerTailSilenceMs` without new text if the session still reports a turn. The reminder names the answered
  request (`answer_request` still delivers to a closed one) and asks for an answer only if something matters.
- The reply to a reminder is a final answer again and starts its own tail, so a result a background job brings
  later still reaches the requester — up to `answerTailMaxReminders` reminders per answered request, never a loop.
  A new open request, a person taking over, a limit stop, a view switch or a session that stopped before the tail
  was worth anything drops it.
  Tails live in memory; a restart forgets them.

## Usage limits (`limitWaitAnswer.ts`)

- During an ARMED wait the probe holds the turn: nothing wakes the request and no attempt is spent. The bot
  answers every open request of the conversation itself with a `progress` answer ("the answer will come after HH:MM") — not through
  `answer_request`, so it is not the agent's note and starts no follow-up. Its delivery carries `isBotNotice`, so a sink
  keeps what the agent's own answer still owes (the Jira sink: the thread an issue update put the next answer in). It replaces the plain notice, is
  deduplicated per request and per wait, and a request opened mid-wait is told by the ledger's
  `onRequestCreated` hook.
- When the retry's "continue" nudge is forwarded, `trackContinuationTurn` watches its turn afresh and, after a
  LIMIT wait, restarts the counters. A wait that will not end by itself (auto-resume off, «Skip once»,
  the retry giving up) calls `stopWakingForLimitWait` — no alert; a later limit resume lifts it, otherwise the
  operator's next message supersedes the request. A stop that lands while a decision is under way wins
  (`applyDecision` re-checks under the ledger lock).
