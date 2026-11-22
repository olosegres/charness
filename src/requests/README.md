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
  progress follow-up, no armed usage-limit wait, not given up, not held by a passing watch that owes nobody an answer), and when
  its process ended with its own work pending (`utils/lostWork.ts`; the lost-work note rides the wake — and no watch holds THAT
  wake, table row 19: a topic resumes on such a loss whatever is armed). One wake per conversation covers all its open
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
  just fired). `armed` counts only at the END of a turn a FIRE started, a «continue» of it included (the agent that handled the wake is not
  silent); any other turn — a reminder's, a person's — reads it as `none`, since nothing else will wake an agent whose watch is gone;
  between turns a failing check nobody handled (the agent died in the wake) does not hold the request, so the backstop takes it. A reading never decides alone:
  what a watch may keep quiet is the rule table below, which is the whole rule — change it and its test together.
- **When a waiting request may stay quiet — the complete rule.** ONE reading decides it, from the PERSISTED request plus the schedule
  wait: *owed* (`checkIsAnswerOwed`) and the reading above. The kind of a turn is NOT an input — a person's turn, a reminder's, a
  continuation's and the one a lost watch left behind all end alike — with one exception: a scheduled fire's turn (`isScheduledRun`) may
  end quietly without any schedule too (a one-shot job is gone once it fires), and even it only while nothing is owed.
  - *Owed*: a silent turn is pending (`silentTurnCount` > 0), or a person's words reached the agent after its last answer
    (`isPersonInputUnanswered`: set when a forward carries a request prompt or an issue update, and when a comment is HELD over a
    usage-limit wait — `notePersonInputHeld`, since no turn starts for it), or a person's
    request (`origin.kind` is not `scheduledRun`) was never answered (`progressAnswerCount` 0). A delivered `progress` answer clears the
    count AND the flag together (`answerRequest`: a turn that sent a note is never a silent turn), so an answer whose turn a restart then
    lost leaves nothing owed. A scheduler fire's own request (`scheduledRun`) is the alarm's and owes nobody anything. Everything here is
    persisted, so a restart changes nothing. Each write of these fields belongs to ONE request — the one whose words, answer or turn
    caused it — with deliberate exceptions, all listed in the self-check below: `isCountersReset` resets the counters of every open
    request, and the one session turn a «continue» or a restart wake starts is tracked for every open request (row 17: whose words rode
    it is decided per request; the arming pick tells which of them the agent works on).
  - *Tracked* — the engine holds the request's turn (`watched`, memory only) — or *lost*: a restart, a process that died
    (`sessionGone`) or a stale drop took it, and only the persisted request is left. That is the one thing a restart changes, and why
    *owed* is persisted.

  What the rules do (`decideTurnEnd` at a tracked turn's end, `decideUnwatchedRequest` / `decideRestartWake` between turns). «Silent» =
  `silentTurnCount` +1 and the wake `silentTurn`; at the second silent turn in a row the alert `silentTurns` and the wake stop; a wake
  past the cap of 10 per request alerts `wakeCap` instead (`getWakeOrCapDecision`), so the silent turns of a recurring fire (row 13)
  spend wakes too. «Quiet» =
  the activity is recorded, nothing else happens. «Held» = `watching` and nothing owed: no follow-up, no backstop, no restart wake. «Taken
  back» = the request is not held, so a due follow-up, else the backstop (90 min after the last activity OF THIS REQUEST — the busy
  time of another request's watched turn is not its activity: the sweep records a busy session only for a request that owes nothing, or
  when no other turn is watched in the conversation), else the restart wake applies, exactly as without a schedule. A request the rules gave up on or a limit wait stopped (`checkIsWakingStopped`) is left alone in EVERY row.

  | # | Turn | State | Turn end (tracked) | Between turns |
  |---|------|-------|--------------------|---------------|
  | 1 | person prompt (the request's own prompt, an R21 re-delivery, a post retry) | tracked, nothing pending | no answer: **silent**, whatever the reading (its words are owed). A `progress` note answers them: reading `none` (`armed` too: a watch that fired is the alarm's, not this turn's) → follow-up in 15 min; `watching` → quiet, the follow-up cleared | after the note nothing is owed: `watching` holds; `none` / `armed` at the turn's end → follow-up, then backstop; `watching` at the turn's end → backstop only |
  | 2 | person prompt | tracking lost | no turn end is decided | owed (persisted when the prompt was forwarded) → **taken back** even under `watching`: backstop 90 min after the last activity of THIS request (another request's watched turn — a recurring job's fire — does not count), a restart wake at once for a tracker conversation whose process is gone; the reminder's turn is row 9 |
  | 3 | person prompt | silent count pending | no answer: count +1 → the alert `silentTurns` (give-up), whatever the reading. A `progress` note resets the count | owed → taken back |
  | 4 | issue update (a requester's comment) | tracked, nothing pending | as row 1. Words that JOIN a turn already running (the update waits up to 10 min for idle, then is forwarded into it) start its progress count afresh: a note sent BEFORE them is not their answer — the turn ends silent, not as a «progress» one; only a note after them answers | as row 1 |
  | 5 | issue update | tracking lost | no turn end is decided | as row 2 |
  | 6 | issue update | silent count pending | as row 3 | as row 3 |
  | 7 | issue update HELD over a usage-limit wait | no turn started for it | owed from the moment it is held (`notePersonInputHeld`, persisted — a restart during the wait changes nothing); the turn that finally carries it (the wait's «continue», a fire, or the next request prompt of the issue) is read against that: no answer → **silent**, under any watch | during the wait nothing wakes it (the session is blocked by the wait); afterwards owed → taken back |
  | 8 | engine reminder (follow-up, backstop, restart) | tracked, nothing owed (the request was answered) | reading `none` or `armed` → no answer is **silent** (a reminder under a watch nobody re-armed is a silent turn: the give-up comes after two, not after ten backstop wakes); `watching` → quiet, so the agent may say nothing. A `progress` note as in row 1 | as row 1 |
  | 9 | engine reminder | tracking lost | no turn end is decided | owed → taken back; not owed → `watching` holds |
  | 10 | engine reminder | silent count pending (the silent-turn reminder) | no answer: count +1 → the alert `silentTurns`, whatever the reading (an answer is owed) | owed → taken back |
  | 11 | scheduled fire (`isScheduledRun`; the alarm's turn) | tracked, nothing owed | no answer: **quiet**, whatever the reading (a woken agent with nothing to report is no silent turn); the request's due follow-up is left alone unless a schedule holds it. A fire's own request (`scheduledRun`) that got no answer closes `cancelled` silently. A `progress` note: quiet, the follow-up cleared, under `armed` (the watch that just fired) as under `watching`; a fire's turn with nothing armed is followed up as in row 1 | `watching` holds |
  | 12 | scheduled fire | tracking lost | no turn end is decided | as row 9 |
  | 13 | scheduled fire | the request owes an answer (a silent count pending, a person's words unanswered, a person's request never answered) | **silent** as in rows 3 and 10, whatever the reading: the reminder names the request, the next silence gives up. Never quiet, or each fire would move the backstop ahead and a recurring job would leave the requester unanswered for as long as it lives. A fire that JOINED the person's turn is merged into it (below) and is not the alarm's | owed → taken back |
  | 14 | bot «continue» (after an API error or a limit wait; a fire held over the wait rides it too) | tracked, nothing pending | merges into the turn it continues and KEEPS the alarm's kind; the progress count restarts, so a note sent before the error is not this turn's. The end is that turn's row read against what is owed: words answered before the error are owed no more (quiet under a watch), words still unanswered stay owed (silent). A watch the agent arms in this turn is recorded under the request whose OWN forward started its watch, not under another one the nudge only carried along (the arming pick, below) | as that row |
  | 15 | bot «continue» | tracking lost | the nudge starts a plain turn (the alarm's only for a `scheduledRun` request). Its end reads the persisted request: owed → silent as in row 10; not owed → row 8 | as row 9 |
  | 16 | bot «continue» | silent count pending | an API-error retry keeps the count (row 10 applies at the end); `isCountersReset` — the end of a limit or account wait, a limit fallback switch AND the operator's manual backend switch WHEN IT BRIDGES (a new agent on the other backend starts the request's bookkeeping afresh; `cancelApiRetry` ends a wait armed for the backend left; an unbridged switch has no first prompt and tracks no continuation, so it resets nothing — row 18) — zeroes the count, the wake count and the follow-up and lifts the limit stop, but never the person's flag: what is owed stays owed | owed → taken back |
  | 17 | limit / account resume (or a limit fallback switch) that re-posts the prompts the session never took in — a mention that arrived during the wait | tracked, decided PER REQUEST (`trackContinuationTurn`) | a request whose own prompt rode the message (`getPromptNotTakenIn`) is row 1: its words are owed, marked at once. Every other open request gets the plain «continue» of row 14 — an answered hand-over waiting on its watch stays quiet, it is never marked owed because another request's prompt was re-posted | as the row each request falls into |
  | 18 | turns the engine does not track: a topic's lost-work auto-resume, compaction, a slash command forwarded to the agent in a view with requests (it opens no request), the held prompts replayed after a session start, a tracker fire that rides no request (`requestId` null), the first turn of an UNBRIDGED manual backend switch (the operator's text goes in as the session start's `args`, no continuation is tracked), the answer-tail reminder (only with no open request) | no turn watched | no turn end is decided | their busy time counts as the activity of a request under the sweep's rule (row 2) — bounded by one such turn; nothing here makes a request owed or answered |
  | 19 | the process ended with the agent's OWN work pending (a background build, a scheduled job it ran: lost work), between turns | tracking lost | no turn end is decided | a BOOT wakes nobody under a passing watch, but this loss is a different event: the request is woken ONCE with the lost-work note whatever is armed (`scheduleRestartWake(key, { isLostWork: true })`, a boot wake already waiting is turned into one; a topic resumes on it the same way). The wake's turn under `watching` with nothing owed is row 8 → quiet, so the agent reads the note and may stay silent. The lost-work cooldown (10 min) and the wake cap stay |

  Known limitation. A `progress` call already in flight when a person's words join the running turn lands AFTER the count restarted (row 4)
  and counts as the answer to them: it clears the flag, the turn ends as a «progress» one, and under a watch the words wait for the
  backstop although the agent never answered them. The window is one model step, and the agent sees the words later in the same turn and
  often answers anyway. Not guarded on purpose: telling an in-flight note from a real answer needs a time threshold, and a threshold that
  reads a quick genuine answer as «in flight» keeps a request owed after it was answered — a false «could not finish» and hand-back, a
  worse failure than a comment held for ninety minutes.

  Notes on the table. A woken agent in a tracker conversation may, and preferably should, stay silent about an alarm (rows 11, 12, and 8
  where nothing is owed): that is the only thing a watch buys, and it never reaches a person's words. A post retry still runs while a watch
  holds the request (the agent never saw the request). Nothing here posts on a Jira issue: a quiet end is silent by definition. In a
  Telegram topic with requests a fire opens a request of its own (`origin.kind` `scheduledRun`): the engine reads the origin, so its turn
  is the alarm's whoever tracks it, and nothing is posted, owed or backstopped when the agent leaves it unanswered. A scheduler fire
  itself is not a wake-up and never counts against the cap (the reminder after its silent turn, row 13, is one). The header of a fire
  that rides a request owing the requester an answer says so (`trackerRun.ts`) — «answer it in this turn» instead of «only when you have
  a result» — so the agent is not left to learn it from the reminder. This is why an agent in a Jira issue can launch a worker, arm its watch, answer
  `progress` and end its turn, and why a Telegram topic in a view with requests is no longer reminded every 15 minutes while its own
  watch passes.
- **A forward into a turn already watched for the same request MERGES with it** (`trackForwardedTurn`): a fire that waited behind a
  person's turn (`postToSession` waits up to 10 min, then forwards into the running turn), a reminder behind a silent one, an issue
  update during a fire, the bot's own «continue». The merged watch keeps the earlier start of the progress count (a «continue» starts it
  afresh, and so do a person's words that join the turn: a note sent before them is not their answer), is a request prompt's if either was (R21: the prompt is still marked taken in) and is the alarm's only if BOTH were (a
  «continue» keeps the alarm's kind). A person's words are not a property of the watch: they are owed on the persisted request from the
  moment they are forwarded, so an alarm that joined a requester's turn can never turn that turn's silent end into a quiet one. A fire
  riding a request also leaves its pending post retry alone: it carries none of the request's message.
- **The request a job is armed under** (`pickRequestToArmUnder`, asked through the engine's `getArmingRequestIdOf`): the one the agent is
  working on. Tiers, the first that has a request wins: a request whose watch a forward of its OWN started (its prompt, an issue update,
  a fire riding it, a reminder for it — `isOwnForward`, kept by a merge if either side had it) — the OLDEST of them, the request whose
  forward STARTED the running turn (the watches present all belong to the session's current busy period; `ownForwardStartedAt`, a merge
  keeps the earlier), so a hand-over's comment or fire that joins a mention's turn does not take the mention's job and the reverse holds
  too; a request watched only because a
  CONVERSATION-WIDE forward carried it along (a «continue» nudge and a restart wake that carried several requests watch EVERY open request,
  which says nothing about the one the agent works on); the open requests. Inside those last two tiers the newest wins, a tracker hand-over
  (`trackerEvent`) before a mention (`trackerMention`): a mention hands nothing over and long work belongs to the hand-over. A request a
  fire opened (`scheduledRun`) is passed over for any other. Without this the watch armed after an API error would go to another
  person's mention and the hand-over would wait for nothing.
- **Self-check — every write of the owed fields** (`progressAnswerCount`, `isPersonInputUnanswered`, `silentTurnCount`,
  `lastTurnActivityAt`), which request it writes and whether it can write a request other than the one whose words, answer or turn
  caused it. Keep it next to the table: a new writer is a new row here and, when it can reach another request, a decision.

  | Field | Writer | Request written | Another request? |
  |-------|--------|-----------------|------------------|
  | `progressAnswerCount` | `answerRequest` (progress +1) | the answered request (`args.requestId`, conversation-scoped) | No |
  | | `createRequest` (initial 0) | the new request | No |
  | `isPersonInputUnanswered` set | `trackForwardedTurn` | the request the forward is tracked for: the posted prompt, the update's target, a topic prompt, the woken request. A conversation-wide forward (`trackContinuationTurn`, `wakeAfterRestart`) tracks every open request, but sets the flag only for the requests whose OWN prompt rode the message (`getPromptNotTakenIn`) | No, since decision 26 |
  | | `notePersonInputHeld` | the held comment's target request | No |
  | `isPersonInputUnanswered` cleared | `answerRequest` (progress) | the answered request | No |
  | `silentTurnCount` | `decideTurnEnd` / `getWakeOrCapDecision`, applied by `applyDecision` | the request whose watched turn ended | No: a session turn watched for several requests is decided for each against its own answer |
  | | `answerRequest` (progress) | the answered request | No |
  | | `trackContinuationTurn` with `isCountersReset` (also zeroes `wakeCount`, the follow-up and `isLimitStopped`) | EVERY open request | **Yes, by design**, for four callers: the end of a limit wait, the account-wait resume, the limit fallback switch AND the operator's manual backend switch, but only when it BRIDGES (`executeBackendSwitch` → `resumeTopicOnNewSession`: no wait ended, but a new agent starts the bookkeeping afresh and `cancelApiRetry` ends a wait armed for the backend left; an unbridged switch has no first prompt, returns before `trackContinuationTurn` and resets nothing). The flag is never touched: what is owed stays owed |
  | | `createRequest` (initial 0) | the new request | No |
  | `lastTurnActivityAt` | `recordTurnActivity` from `trackForwardedTurn` (forced) | the tracked request; a «continue» and a restart wake that carried several requests track each of them | **Yes, by design**: one session turn, every request in it is watched |
  | | `recordTurnActivity` from a busy poll of a watched turn | the watched request itself | No |
  | | `recordTurnActivity` from the sweep's busy branch | the unwatched request | Narrowed (row 2): recorded only when no other turn is watched in the conversation, or when the request owes nothing — harmless then, an answered request has its follow-up pending or is held |
  | | `decideTurnEnd` / `decideUnwatchedRequest` / `decideRestartWake` updates, applied by `applyDecision` | the decided request | No |
  | | `wakeAfterRestart` (writes `decision.update` itself; only its alert goes through `applyDecision`) | each request it wakes, for itself — with `isLostWork` (row 19) also a request a passing watch holds, still only for itself | No |
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
- **A tracker request prompt and an issue update are posted through `trackerTurnPoster.ts`** (over ports: the shared session post, the
  person-activity note, the engine; `bot.ts` wires them for the Jira connector): a posted request prompt, and a forwarded update, have
  their turn watched; a failed post goes to the engine's retries (R28) before it is thrown back; an update HELD over a usage-limit wait
  starts no turn and is recorded as owed at once (`notePersonInputHeld`, table row 7).

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
