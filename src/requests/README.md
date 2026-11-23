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
- Telegram files operator entry points under the sender's user id and the scheduler's own request under the
  scheduler's marker (`utils/topicRequest.ts`), so a run never merges with a person's request (a run that rides a person's request
  opens none: § Scheduled runs).
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

## Scheduled runs (`../scheduler/scheduledRunTarget.ts`; the turn rules are § Wake-ups)

ONE model for a Telegram topic whose view has requests and a Jira issue; the two differences are the ones Jira forces (*Jira:* below).
A topic in the stream view has no requests: its fires are plain prompts.

- **A fire never replaces a request: it RIDES one.** At forward time (the post may have waited up to 10 min behind a running turn;
  a topic's forwards run one at a time per conversation, so two fires at once open one request, not two) its target is the first of:
  1. *the job's request*: the one the job was armed under (`ScheduleRecord.requestId`) or the open one that replaced it
     (`supersededRequestIds`), while it is open, whoever raised it;
  2. a topic: *the scheduler's request* (`origin.kind` `scheduledRun`, requester `scheduler`, at most one open); *Jira:* the newest open
     request;
  3. a topic: a NEW scheduler's request, opened for this fire; *Jira:* none (the header says so, no turn is watched). A request of the
     scheduler's on an issue would comment, which always notifies, and owe an answer nobody asked for.

  A scheduler's request the bot gave up on (`isWakeStopped`: the operator was told it could not finish) is ridden by nothing, not even
  by its own job's fire: the next fire opens a new one (3), the only replace a fire ever causes.
- **The turn a fire starts is a scheduled run of the request it rides** (`isScheduledRun`, set by the forward that rides it or opens
  it, never read from the request): it may end without an answer while nothing is owed (rows 11–13). The prompt starts with a header
  that names the request and asks for an answer only with a result the requester needs (`buildResultOnlyAnswerLine`), or in this turn
  when the request owes one (`build*ScheduledRunHeader`) — the scheduler's request a fire opens too (`buildRequestHeader`'s
  `isAnswerOnlyWithResult`: no «`final` at the end of your turn», no line naming the given-up request it replaced), so silence is what
  the agent is told it may do, not only what the rules accept. A fire is never a wake-up and never counts against the cap.
- **A fire of the request's own job, or of another job.** The forward says which (`RiddenRequest.isRequestJob`: the fire's job is
  armed under the request it rides, `checkIsJobArmedUnderRequest`). Only a fire of the request's OWN job handles the request's watch
  that fired (`armed` counts for its turn) and is the request's activity. A fire of ANOTHER job only rides it (Jira's newest open
  request, a topic's scheduler's request): its turn may end quietly, but its forward, a «continue» of it, its busy time and its quiet
  end write nothing on the request, so the request's follow-up and its backstop (counted from its OWN last activity) stand. Nor does
  any fire's turn — of any job, on any request — count for the OTHER requests of the conversation: the sweep records a busy session as a
  request's activity only while no turn is watched there. A check forwards only at its first failure, so every later fire on an `armed`
  request is another job's; credited, a recurring unrelated job would keep a watch nobody handled from ever being taken back. The
  opening fire of the scheduler's request is that request's own.
- **The scheduler's request** (a topic only) is no person's, so it never owes their words, and it has two states:
  - *never answered* (`progressAnswerCount` 0, `checkIsUnansweredFireRequest`): nobody was told anything, so ANY turn of it that ends
    without an answer (its fire's, a riding fire's, a reminder's after a lost turn, a «continue»'s) closes it `cancelled` silently.
  - *answered* (a `progress` delivered): the operator was told «working on it», so it is read like any answered request. A fire
    riding it may end quietly; any other silent turn (the follow-up reminder, the backstop's, a «continue» of such a turn) is a silent
    turn, and the second ends in the give-up, which tells the operator.

  It closes by the agent's `final` / `question`, a cancel of the conversation, the silent close above, or, once given up, by the
  next fire's new request. No answered state passes from one scheduler's request to the next. The jobs armed under the replaced one
  follow it, as on any supersede (`supersededRequestIds`): the new request counts them and their fires ride it. Only one is open at a
  time, and a fire that finds it open rides it.
- **Who closes what.** A request a fire rides is closed only by the agent's answer, a cancel of the conversation, or (the scheduler's,
  never answered) the silent close above. A fire itself replaces only a scheduler's request the bot gave up on, and never closes or
  replaces a person's request.
- **A job armed in a fire's turn** goes to the request that fire rides when the fire started the turn (`pickRequestToArmUnder`, the
  scheduler's request included): the watch an agent arms while handling an alarm belongs to that alarm, not to a person's unrelated
  request.
- Known limitation: a `progress` note to a scheduler's request the bot gave up on, sent after the next fire replaced it, is delivered
  and changes nothing (the operator was already told it could not finish).

## Turn starts — how the previous watch ends (`wakeUpEngine.ts` `settleEndedTurnsOf`, `trackForwardedTurn`)

A watch ends with its turn. A new prompt reaches the agent through ONE write, `bot.ts` `forwardPromptToLiveAgent`, which first settles
the conversation's watches whose turn already ENDED: on a probe taken then, they are dropped and decided against the request as it is,
before the write (synchronously: no await may come before a write, or a stop queued meanwhile would begin first). A watch whose turn
still RUNS is left, and the new prompt joins that turn (`trackForwardedTurn` merges, for the same request). A reminder the settle decides
is persisted first and written AFTER the caller's own write, so the new prompt starts the turn and the reminder joins it, as the tick
would have reminded seconds later. A post that waited behind a running turn (`postToSession`) also awaits the settle (the decisions, not
their reminders) before it picks a request and builds its text, so the pick and the header read what the ended turn decided (a
scheduler's request its silent end closed is not ridden); it delivers the settled reminders after its own forward, on every way out.
A post is IN FLIGHT from its first step to its last (`notePostInFlight`): a reminder the engine decides for the conversation meanwhile —
at the adapter's turn end, by the poll, by the sweep — is HANDED to it (`deliverOrHandOverWake`) and written after the post's prompt and
after its caller watched the turn that prompt started (`afterForward`: a tracker request prompt or issue update is tracked inside the
post). So the prompt that waited for a turn starts the next one on both json-stream lifecycles, and the reminded request joins it: a
job the agent arms there is the waited request's (the arming pick's oldest own forward). Written first, the reminder would start that
turn, and a post that waited for the idle would wait for the reminder's whole turn or, per turn, join it as the second forward.
The settle never decides a watch whose session is gone (`sessionGone`: left to the poll), but a write rarely meets one: every path brings
a dead process back before it writes (a post's ensure, an immediate forward's wake), so the dead turn's watch then reads the new idle
process as an ended turn and is decided at the settle, unless the poll dropped it first.
Without the settle a forward that waited would usually start its turn under the old watch (the post forwards within 5 s of the idle,
the poll ticks every 10 s), and the old request would get the new turn's jobs, its busy time and its end.

The settle also runs at the adapter's own turn-end event (`handleAgentTurnEnded`). Only the json-stream Claude emits one (`turnEnded`),
in both lifecycles, so there a watched turn's end is decided at once rather than at the next tick; OpenCode and the tmux Claude end at
the poll or at a write's settle. For `claude-per-turn` it is the only place the end is decided at all: the stop is queued in that same
tick and its window opens only in a later one, and once the stop is over the session is gone, which the poll reads as «tracking lost»
(`sessionGone`), never as an end. A reminder decided there goes to a post waiting for that turn, else resumes the session through the
ensure, which queues behind the stop.

A turn that ended on an API error is decided only once the bot has armed its retry, stopped the waking or moved the conversation. The
adapter reports the error (`apiError`) right before the turn's end, and `handleApiError` runs first: a branch that arms a retry holds the
turn end through its timer; one that arms nothing — «wait for reset» off, a used-up credit balance, an account refusal or a logged-out
notice — through `checkIsApiErrorInHandling` (`bot.ts` `apiErrorsInHandling`), from the error until that handling has landed. Decided at
once, the turn would be a silent one, and its reminder, written into the limited or refused session, would end on the same error: the
second silent turn, the give-up.

A session start and the replay of the prompts buffered during it are ONE start for the turn probe (`isTurnEndBlocked`:
`StartupPromptBuffer.checkIsStarting` or `checkIsReplaying`, the latter from before the buffer is taken until after the held prompts are
forwarded, also when a forward throws). A settle at a replayed write therefore reads every watch as `running`: a watch made during the
start is never decided before the agent took its prompt in, and after the last write the prompts are unconsumed until the agent reads
them. `checkIsStarting` itself ends when the buffer is taken, so a prompt that arrives during the replay is not buffered again: it is
written at once and joins the start's turn.

| Path that starts a turn | Where it is written | The previous watch |
|---|---|---|
| forward after a wait: a Jira request prompt or issue update, the lost-work resume post (`postToSession`, `waitForIdle`) | `settleEndedTurns` awaited after the wait and the ensure, then the write and the caller's `afterForward`; the settled reminders, and the ones handed to the post, after them | ended (the usual case) → settled before the text is built, its reminder written after the post's prompt; still running (the 10-minute wait ran out) → joined; a process that died → the ensure has already brought it back, so its watch reads the new idle process as an ended turn and is decided at the settle |
| immediate forward: a person's text, voice, file, album, `/schedule` in a topic — routed AT THE WRITE by the one helper (`deliverPromptByState` → `deliverPersonPromptAtWrite`, over `deliverLatePrompt`), after its request is opened and a file downloaded, never by the window it arrived in — and the bot's writes through the same path — the answer-tail reminder (`remindAnswerTail`), the todo list's standalone reminder (`postTodoReminder`), a late answer to a question the bot set aside (`deliverLateAnswerPrompt`), the bot's own `/compact` on the frozen tmux Claude only (on json-stream and OpenCode `compactContext` writes it itself, with no settle — harmless: `checkIsCompacting` holds every watch, and on json-stream the ended turn was settled at `turnEnded`), and the wedge recovery's replay of the wedged prompt (`isRecoveryReplay`: `wedgeRecoveriesInFlight` holds the turn until the replay is written, so the wedged turn's watch survives into the replayed one) | the write; a settled reminder right after it, in the same tick | ended → settled before it; running → joined: the json-stream Claude and OpenCode queue the prompt into the turn (OpenCode's `prompt_async`; only its retry wait is aborted). The frozen tmux Claude INTERRUPTS the turn (`interruptAndWaitIdle`), after the settle, so the interrupted turn's watch survives into the new turn and is decided at that turn's end. A session that is gone → woken first (`wakeSleepingSessionForPrompt`), then written: as on the post path, the dead turn's watch is decided at the settle as an ended turn. A session still starting, or being stopped (its window open at the write) → the prompt waits in that window's buffer, and the replay is its write (last rows); a window that closed during the prompt's awaits never takes it — the buffer refuses a closed window (`StartupPromptBuffer.addPrompt`), so it is forwarded to the session the start brought up, or wakes the one the stop left asleep |
| fire: a topic's and a tracker's (`createTopicPost` / `createTrackerPost` over `postToSession`) | as a forward after a wait; a topic's forwards one at a time per conversation | as a forward after a wait; the request it rides is picked after the settle |
| «continue» after an API error, a limit or account wait, a fallback switch (`apiRetryKick`, `resumeTopicOnNewSession`) | the write — routed at it (`deliverPromptOrBuffer`): buffered behind an open window, the conversation woken when it went to sleep meanwhile — then `trackContinuationTurn` | the turn it continues reads `running` (an armed retry or wait blocks its end, `isTurnEndBlocked`; a nudge buffered behind a session start is blocked by the start and its replay): never settled, the «continue» merges into it (row 14); another request's ended watch → settled |
| engine reminder: a silent turn, a follow-up, the backstop, a post retry (`applyDecision`) | `forwardRequestWakeUp` → the write | the reminded request's own watch was dropped at its turn's end; another request's ended watch → settled |
| restart wake at a boot (`wakeAfterRestart`) | `forwardRequestWakeUp` → the write | none survives a restart (watches are in memory); one tracked since → as above |
| lost-work wake (`scheduleRestartWake(key, { isLostWork: true })`) | as the restart wake | as the restart wake |
| replay of the prompts buffered during a session start, then the held prompts on their own (`replayBufferedPrompts`, `afterReplay`) | the write, prompt by prompt | still the start (`checkIsReplaying`): every watch reads `running` and none is settled; each is decided at the end of the turn the replayed prompts started |
| a session start's `args`: the first prompt of an UNBRIDGED manual backend switch, and the text typed with `/claude <text>` or `/opencode <text>` (`handleAgentStart` → `startAgentSession(key, args)`) | the start itself — no write through `forwardPromptToLiveAgent`, no settle | the switch: none — it closed every open request and dropped their watches (`switchThreadAdapter` → `cancelConversation`). `/claude <text>` and `/opencode <text>`: an untracked turn with no settle, like the switch's. Neither turn is tracked (row 18) |

Where a watch is settled or ended, and when that runs relative to the prompt write and to a buffered replay. Only the first four DECIDE
a turn's end, all on `getWatchedTurnState`, which reads `ended` only for an active, idle session that nothing blocks (a start or its
replay, a pending question, a compaction, an armed retry or limit wait, an API error still in hand, a re-spawn under way or about to
start, a wedge recovery) and that took the turn's prompt in — a message queued behind a turn that ended in an error stays unread until
its own turn (events-list item 1) — so none of them decides a turn that has not started:

1. The settle at the write (`forwardPromptToLiveAgent`): synchronously right before the adapter write (after an immediate forward's wake
   and the adopted-replay wait in `forwardPromptToAgent`), its reminders after the write. Right after it, at a REPLAYED write only
   (`checkIsReplaying`), a watch whose prompt waited in the buffer is named the process the replay writes into (`noteReplayedWrite`):
   the replay took the whole buffer for that process. No other write names anything: a watch whose buffer was dropped stays unnamed,
   its request prompt reads not taken in (`checkIsTurnInputConsumed`: unnamed while the probe names a process), so it is never decided
   or marked off a process it never reached — and the person's dropped prompt closes its request anyway (the buffer's life, below). At
   a replayed write, and at a prompt that arrives during the replay, the probe reads the start: nothing is decided.
2. The settle at a post (`postToSession`): after the busy wait and the first ensure, before the second limit check, the second ensure,
   the pick and `buildText`; the decisions are persisted before the write, the reminders — with the ones handed to the post while it was
   in flight — delivered after the post's forward and its caller's `afterForward`. The ensure returns once the session is up, and its
   replay runs on: a settle that lands while the start's buffered prompts are still being written reads the start and decides nothing.
3. The settle at a turn end (`handleAgentTurnEnded`, json-stream Claude): at the adapter's turn-end event, after the per-turn stop is
   queued and before its window opens; no write of its own, so its reminders are handed to a post in flight, else go at once (through
   the ensure, behind the stop). A turn end held by an API error the bot still handles (`checkIsApiErrorInHandling`) or by an armed
   retry, one during a replay, and one with a written prompt not yet read (`hasUnconsumedInput`) read `running`: nothing is decided.
   Every settle still marks the prompt of a watch it leaves running as taken in when the live process took it (R21), as the poll does:
   the turn's end is where that is seen before a deferred switch's re-spawn or the per-turn stop replaces the process, and a prompt is
   read as taken in only off the process it was written to (item 4).
4. The poll (`pollWatchedTurn`, every 10 s): between writes, on its own probe and the same rule; during a start or a replay every watch
   reads `running`. Its R21 write reads what the backend still lists as unread, the turn end held or not (a message queued behind a failed
   turn stays listed until its own turn echoes it: events-list item 1) — and only off the process the prompt was written to: a process
   that replaced it (a re-spawn) lists nothing unread, and that is not the prompt read. It re-checks its watch after that write, so a
   watch a settle took meanwhile is not decided twice. What it decides is handed to a post in flight, like the turn end's.
5. `sessionGone` (the poll only; every settle leaves such a watch): dropped without a decision when the session is inactive and nothing
   blocks it — never during a start or a replay, which block it.
6. The stale drop (the poll only): a `running` watch whose session is idle, unblocked and not busy for the whole backstop window is handed
   to the sweep — never during a start or a replay.
7. A request no longer open (any settle, the poll): its watch is dropped with no decision; it decides no turn.
8. `cancelConversation` and `stopWakingForLimitWait`: every watch of the conversation dropped with no decision (the person took over, a
   limit stopped the waking); they decide no turn.

A merge (`trackForwardedTurn`, `trackContinuationTurn`) replaces a watch by its union with the new forward and decides nothing.

What can run between a json-stream `turnEnded` and the next write, in the order it can happen, checked against the turn-end settle
(item 3). In the `result`'s own `applyTurnEnd`, before `turnEnded`:

1. **The unconsumed inputs are re-based:** every message written behind the turn waits for the next turn from this end, and one the turn
   took in in a shape nothing matches goes. A turn that ended in an ERROR result keeps its queue too. Measured on CLI 2.1.330 (`-p`,
   stream-json, `--replay-user-messages`; a second message written 0.3 s after the first; the first turn failing on an unknown `--model`,
   on an HTTP 400, and on an HTTP 429 after its ten retries, the last two from a loopback API through `ANTHROPIC_BASE_URL`): the CLI wrote
   a new `system/init` 0.02–0.2 s after the error `result` and ran the queued message as its own turn. So such a message's watch reads
   `running` (unconsumed) until its own turn took it in, the per-turn stop and a deferred account switch wait for that turn
   (`checkIsWorking`), and R21 marks the prompt only once it is echoed. One never echoed holds nothing past the grace (30 s).
2. **The API error the turn ended on** (`apiError`, emitted there too, so `handleApiError`'s synchronous part runs before `turnEnded`):
   - a branch that arms a retry (a transient error, a usage limit with «wait for reset» on, an unconfirmed limit's probe, a repeat while
     one is armed): its timer holds the turn end, and the «continue» merges into the turn (row 14);
   - a branch that arms nothing: held by `checkIsApiErrorInHandling` until its stop (`stopWakingForLimitWait` drops the watch), its move
     (the account move's «continue» merges into the held turn) or its wait (`waitForClaudeAccount` stops the waking) has landed. A
     handling that stops nothing (the logged-out notice of a backend without accounts, a limit answer that could not be delivered)
     leaves the watch to the poll after it;
   - the usage limit's give-up (its attempts spent): `stopWakingForLimitWait` drops the watch synchronously, before the settle;
   - a transient error's give-up, and a second `conversationTail` error's: nothing is armed or stopped, so the turn that failed is decided
     silent at once; a message queued behind it waits for its own turn (item 1);
   - an error text the bot does not classify (`classifyAgentApiError` → null: the adapter posts «Claude error: …» and emits no `apiError`):
     nothing holds the turn end; the failed turn is decided like any ended turn, a message queued behind it as in item 1;
   - our own interrupt's error result (`/esc` and its aliases): swallowed, no `apiError`; the interrupt has closed the conversation's
     requests and dropped their watches (`cancelConversation`).
3. **A deferred account switch that is due is released** (`isConfigDirSwitchReleased`), still before `turnEnded`: item 9.

In the `turnEnded` dispatch, in this order:

4. **The todo list's standalone reminder** (`noteAdapterTurnEnd`, called first): it reads the same probe, so the same holds apply. When
   due, it is written in that same synchronous call, through the write choke point. That write's settle then decides the ended watches
   (settle-list item 1) and hands their reminders to a post in flight, else writes them right after the todo prompt; the turn-end settle
   that follows finds nothing new.
5. **The per-turn stop** (`handleAgentTurnEnded`): queued before the settle unless the process still works (a background task, a task's
   turn on its way, a message queued behind the turn: item 1, a deferred compaction). Its transition starts in a later microtask, so the
   settle reads the session active and idle; a reminder no post takes resumes the session through the ensure, behind the stop, and a
   waiting post's second ensure queues behind it too.
6. **The turn-end settle** (settle-list item 3): its reminders go to a post in flight, else out at once.

After `turnEnded`:

7. **A post waiting for the turn** (`postToSession` in `waitForIdle`, in flight): the settle's reminders are handed to it; its prompt is
   written first, its caller watches that turn (`afterForward`), then the reminders follow — on both lifecycles.
8. **The poll** (10 s): the settle drops the ended watches synchronously, the poll re-checks its watch after its await, and what it
   decides later is handed to a post in flight as well.
9. **A deferred account switch** (`applyPendingConfigDirSwitch`, right after `turnEnded`; the re-spawn starts one timer tick later):
   - the adapter reads a re-spawn about to start from its release (item 3, before `turnEnded`) and one under way until the new process is
     spawned (`checkIsRespawnPending`, json-stream); the release ends with the apply: a re-spawn, a no-op, or deferred again by a write in
     `turnEnded`'s own handlers (item 4). A re-spawn that fails is over;
   - a switch merely pending on a process that stops working with no turn end (a task hold lapsing, an input past its grace) is no
     re-spawn coming and holds nothing;
   - the probe holds the turn end meanwhile, and the process down for the re-spawn reads `running`, not `sessionGone`. So the settle and
     the poll decide nothing during it, and the reminder, decided after it, goes into the new process; written during it, its ensure
     would have resumed the conversation a second time beside the re-spawn. The hold covers the engine's own wake-ups only: a person's
     message or a post that lands in that window meets the re-spawn as before;
   - messages queued behind a turn that ended in an error result defer the switch like any work: the CLI runs them as its next turn
     within 0.2 s (item 1), and the switch fires at that turn's end. Only a switch that answers a limit (`isAfterLimit`) re-spawns over
     them at once; the new process lists nothing unread, and R21 reads a prompt as taken in only off the process it was written to (the
     watch's `writtenToProcess` against the probe's `processGeneration`), so the resume's «continue» posts it again
     (`getPromptNotTakenIn`), or, when nothing carries it, the wake of its turn's end does.
10. **Turns the CLI starts by itself:**
    - a finished background task's own turn: its `task_notification` came in the turn, and the CLI starts that turn ~0.1 s after the
      `result`. The adapter reports it on its way until its `init` (`checkIsTurnOnItsWay`, bounded by `notificationTurnGraceMs`), and the
      probe reads the session busy: a watched turn runs on into it and is decided at its end, so an answer the agent sends there counts;
    - a session `CronCreate` job's firing (`command_lifecycle` `started`), whenever it comes: one at a turn's end opens after the settle
      decided the ended watches. It is no request's turn;
    - the busy time of both is no unwatched request's activity (`checkIsCliOwnTurn`, the probe's `isCliOwnTurn`; row 18). A turn the CLI
      opens with a message of ours listed is ours, and so is one that echoes our message.
11. **A buffered replay:** a message whose write found the stop's window still open is replayed after the resume, and the probe reads the
    replay as the start (`checkIsReplaying`): nothing is decided. The window a message ARRIVED in decides nothing: a person's message is
    routed when it is written, after its request is opened and a file downloaded (`deliverPromptByState`), and the buffer refuses a
    closed window. One that arrived in the window but is written after the stop ended wakes the conversation itself and gets its
    own turn — it never waits in a buffer no stop or start replays any more (lost with a restart, and holding a self-update back).
12. **A deferred compaction** (`compact_conversation` armed in the turn, polled every 3 s): the turn's end is decided at `turnEnded`, before
    the compaction starts; a reminder starts a new turn and the compaction waits for that turn's end. Nothing is lost.
13. **Any other write** (a person's message, a fire, a reminder): the write choke point's settle (settle-list item 1).

## Wake-ups (`wakeUpRules.ts` = pure decisions, `wakeUpEngine.ts` = timers)

- **One watch per REQUEST**, not per conversation: with two requesters' requests open in one topic, each is
  followed to its own turn end — the answered one closes, the silent one is woken. The sweep skips only
  requests that are watched.
- A turn has ENDED only when the session is idle, nothing blocks it (pending question, compaction, armed
  retry or limit wait, an API error still in hand, a re-spawn under way or about to start, session start or its replay, wedge recovery) and
  the backend has TAKEN IN the request's message
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
  `sessionGone` and the request still waits for the backstop, unless a prompt is written into the conversation before the poll
  drops the watch (§ Turn starts). A `claude-per-turn` process that the bot stops after every turn is not this case: the turn's end
  is decided at the adapter's turn-end event, before the stop (§ Turn starts).
- **A request waits for its schedule** (`scheduleWait.ts`, platform-neutral; the engine's optional `getScheduleWait` port reads the
  conversation's jobs at every decision): a job counts when it is armed under the request (`ScheduleRecord.requestId` is the request's id
  or the id of a request it replaced), is an agent job (a prompt job or a check, not a reminder) and is not paused. The reading is `none`
  (no job counts), `watching` (a job counts and is not a failing check) or `armed` (every counting job is a failing check: a watch that
  just fired). `armed` counts only at the END of a turn a fire of the request's OWN job started, a «continue» of it included (the agent that handled the wake is not
  silent); any other turn — a reminder's, a person's, another job's fire's — reads it as `none`, since nothing else will wake an agent whose watch is gone;
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
    lost leaves nothing owed. The scheduler's request (`scheduledRun`) owes nobody a person's words (it never carries any): never
    answered, any silent end closes it; answered, it is read like any answered request (§ Scheduled runs, rows 8 and 11). Everything here is
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
  time of another request's watched turn is never its activity, whatever it owes: the sweep records a busy session only while no turn
  is watched in the conversation), else the restart wake applies, exactly as without a schedule. A request the rules gave up on or a limit wait stopped (`checkIsWakingStopped`) is left alone in EVERY row.
  A turn that ended on an API error is decided only once the bot has armed its retry, stopped the waking or moved the conversation
  (§ Turn starts): until then it is held, in every row.

  | # | Turn | State | Turn end (tracked) | Between turns |
  |---|------|-------|--------------------|---------------|
  | 1 | person prompt (the request's own prompt, an R21 re-delivery, a post retry) | tracked, nothing pending | no answer: **silent**, whatever the reading (its words are owed). A `progress` note answers them: reading `none` (`armed` too: a watch that fired is the alarm's, not this turn's) → follow-up in 15 min; `watching` → quiet, the follow-up cleared | after the note nothing is owed: `watching` holds; `none` / `armed` at the turn's end → follow-up, then backstop; `watching` at the turn's end → backstop only. The backstop counts this request's own activity only: no other request's watched turn pushes it |
  | 2 | person prompt | tracking lost | no turn end is decided | owed (persisted when the prompt was forwarded) → **taken back** even under `watching`: backstop 90 min after the last activity of THIS request (another request's watched turn — a recurring job's fire — does not count, for any request), a restart wake at once for a tracker conversation whose process is gone; the reminder's turn is row 10 |
  | 3 | person prompt | silent count pending | no answer: count +1 → the alert `silentTurns` (give-up), whatever the reading. A `progress` note resets the count | owed → taken back |
  | 4 | issue update (a requester's comment) | tracked, nothing pending | as row 1. Words that JOIN a turn already running (the update waits up to 10 min for idle, then is forwarded into it) start its progress count afresh: a note sent BEFORE them is not their answer — the turn ends silent, not as a «progress» one; only a note after them answers | as row 1 |
  | 5 | issue update | tracking lost | no turn end is decided | as row 2 |
  | 6 | issue update | silent count pending | as row 3 | as row 3 |
  | 7 | issue update HELD over a usage-limit wait | no turn started for it | owed from the moment it is held (`notePersonInputHeld`, persisted — a restart during the wait changes nothing); the turn that finally carries it (the wait's «continue», a fire, or the next request prompt of the issue) is read against that: no answer → **silent**, under any watch | during the wait nothing wakes it (the session is blocked by the wait); afterwards owed → taken back |
  | 8 | engine reminder (follow-up, backstop, restart) | tracked, nothing owed (the request was answered) | reading `none` or `armed` → no answer is **silent** (a reminder under a watch nobody re-armed is a silent turn: the give-up comes after two, not after ten backstop wakes); `watching` → quiet, so the agent may say nothing. A `progress` note as in row 1. The scheduler's request the agent answered `progress` is read as this row (its follow-up reminder ending silent is a silent turn, then the give-up: the operator was told «working on it»); one it never answered closes silently at any silent end (§ Scheduled runs) | as row 1 |
  | 9 | engine reminder | tracking lost | no turn end is decided | owed → taken back; not owed → `watching` holds |
  | 10 | engine reminder | the request owes an answer: a silent count pending (the silent-turn reminder), the person's words unanswered, a person's request never answered (the backstop's or a restart wake's reminder of rows 2 and 5) | no answer: count +1, whatever the reading (an answer is owed) → the reminder, or the alert `silentTurns` once it is the second silent turn in a row (at once with a count pending) | owed → taken back |
  | 11 | scheduled fire (`isScheduledRun`: the forward that rides or opens the request says so) | tracked, nothing owed | no answer: **quiet**, whatever the reading (a woken agent with nothing to report is no silent turn); the request's due follow-up is left alone unless a schedule holds it. The scheduler's request the agent NEVER answered (`checkIsUnansweredFireRequest`: `progressAnswerCount` 0) closes `cancelled` silently; one it answered stays open (the fire's turn is still quiet: the agent that handled the alarm is not silent, as on a Jira hand-over). A `progress` note: under `watching` quiet, the follow-up cleared; under `none` or `armed` followed up as in row 1 — `armed` excuses only a NO-answer end, and a watch that fired and was not re-armed wakes nobody again, so without the follow-up only the backstop would be left. A fire of ANOTHER job (`isRequestJob` false: its job is not armed under the request it rides) may end quietly too, but it does not handle `armed` and is not the request's activity: its no-answer end changes nothing on the request (follow-up and backstop stand), and its `progress` note is followed up as in row 1 | `watching` holds; a fire's busy time pushes nothing on a request it does not ride, nor, for another job's fire, on the one it rides |
  | 12 | scheduled fire | tracking lost | no turn end is decided | as row 9 |
  | 13 | scheduled fire | the request owes an answer (a silent count pending, a person's words unanswered, a person's request never answered) | **silent** as in rows 3 and 10, whatever the reading: the reminder names the request, the next silence gives up. Never quiet, or each fire would move the backstop ahead and a recurring job would leave the requester unanswered for as long as it lives. A fire that JOINED the person's turn is merged into it (below) and is not the alarm's | owed → taken back |
  | 14 | bot «continue» (after an API error or a limit wait; a fire held over the wait rides it too) | tracked, nothing pending | merges into the turn it continues and KEEPS its kind (a fire's turn stays a fire's, whatever the request); the progress count restarts, so a note sent before the error is not this turn's. The end is that turn's row read against what is owed: words answered before the error are owed no more (quiet under a watch), words still unanswered stay owed (silent). A watch the agent arms in this turn is recorded under the request whose OWN forward started its watch, not under another one the nudge only carried along (the arming pick, below) | as that row |
  | 15 | bot «continue» | tracking lost | the nudge starts a plain turn. Its end reads the persisted request: owed → silent as in row 10; the scheduler's request never answered → closed silently; else row 8 | as row 9 |
  | 16 | bot «continue» | silent count pending | an API-error retry keeps the count (row 10 applies at the end); `isCountersReset` — the end of a limit wait, the account-wait resume, a limit fallback switch WITHIN its backend (another Claude account or model, another OpenCode model) — zeroes the count, the wake count and the follow-up and lifts the limit stop, but never the person's flag: what is owed stays owed. A switch ACROSS backends (the limit fallback onto the other backend, the operator's bridged manual switch) resets too, but finds no request: `switchThreadAdapter` has already closed every open one `cancelled` (`cancelConversation`), so its context bridge continues none of them; an unbridged switch has no first prompt and tracks no continuation (row 18) | owed → taken back |
  | 17 | limit / account resume (or a limit fallback switch WITHIN its backend; one across backends has closed the requests and sends the context bridge instead) that re-posts the prompts the session never took in — a mention that arrived during the wait | tracked, decided PER REQUEST (`trackContinuationTurn`) | a request whose own prompt rode the message (`getPromptNotTakenIn`) is row 1: its words are owed, marked at once. Every other open request gets the plain «continue» of row 14 — an answered hand-over waiting on its watch stays quiet, it is never marked owed because another request's prompt was re-posted | as the row each request falls into |
  | 18 | turns the engine does not track: a topic's lost-work auto-resume, compaction, a slash command forwarded to the agent in a view with requests (it opens no request), the held prompts replayed after a session start, a tracker fire that rides no request (`requestId` null), the first turn of an UNBRIDGED manual backend switch (the operator's text goes in as the session start's `args`, no continuation is tracked), the answer-tail reminder (only with no open request), a late answer to a question the bot set aside (`deliverLateAnswerPrompt`: the owner's pick, written as their message but opening no request), the todo list's standalone reminder (`postTodoReminder`: a technical prompt into a live idle session, in a topic and in an issue — a `progress` the agent sends in that turn clears the flag and the count but schedules no follow-up); and the turns the CLI starts by itself, which no write of the bot started — a finished background task's own turn, a session `CronCreate` job's firing (§ Turn starts, events-list item 10) | no turn watched | no turn end is decided | the busy time of a turn the bot wrote counts as the activity of a request under the sweep's rule (row 2), bounded by one such turn; the CLI's own turns count for no request (`isCliOwnTurn`): a job that loops would otherwise push an owed request's backstop ahead for as long as it loops. Nothing here makes a request owed or answered |
  | 19 | the process ended with the agent's OWN work pending (a background build, a scheduled job it ran: lost work), between turns | tracking lost | no turn end is decided | a BOOT wakes nobody under a passing watch, but this loss is a different event: the request is woken ONCE with the lost-work note whatever is armed (`scheduleRestartWake(key, { isLostWork: true })`, a boot wake already waiting is turned into one; a topic resumes on it the same way). The wake's turn under `watching` with nothing owed is row 8 → quiet, and the agent is ASKED for little: for a request a passing watch holds that owes nobody an answer the wake is worded like the fire header — the reminder says the watch is still armed and nothing the requester wrote is waiting for an answer, so answer only with what the requester must know and otherwise continue without a comment (`WakeUpMessage.isAnswerOptional`), and the lost-work note says the same (`buildLostWorkNote`, telling `watchHeld`); a request that owes an answer, or whose prompt the agent never read, keeps the plain «answer it», and a forward carrying several requests is optional only when every one of them is. The lost-work note riding a TRACKER FIRE, when the request it rides owes nothing or none is open, claims no watch — the fire may be a check's failure, a one-shot job's, or ride no request at all — and defers to the run's header, which already says when to answer: tell the requester about the loss only if it changes what they wait for (`PromptDeliveryOptions.lostWorkTelling` `runHeader`). Only the request's own next step keeps the wake away: a post retry, or a follow-up that can fire — not one a passing watch holds, which never fires. A lost-work wake that wakes nobody says so in the log. The lost-work cooldown (10 min) and the wake cap stay |

  A follow-up pending while a passing watch holds the request (a note under `armed`, then the check passed again; a job armed after the
  note): held, the follow-up never fires; a lost-work wake still comes (row 19); once the hold ends the past follow-up wakes at once.

  Known limitation. A `progress` call already in flight when a person's words join the running turn lands AFTER the count restarted (row 4)
  and counts as the answer to them: it clears the flag, the turn ends as a «progress» one, and under a watch the words wait for the
  backstop although the agent never answered them. The window is one model step, and the agent sees the words later in the same turn and
  often answers anyway. Not guarded on purpose: telling an in-flight note from a real answer needs a time threshold, and a threshold that
  reads a quick genuine answer as «in flight» keeps a request owed after it was answered — a false «could not finish» and hand-back, a
  worse failure than a comment held for ninety minutes.

  Notes on the table. A woken agent may, and preferably should, stay silent about an alarm (rows 11, 12, and 8 where nothing is owed):
  that is the only thing a watch buys, and it never reaches a person's words. A post retry still runs while a watch holds the request
  (the agent never saw the request). Nothing here posts on a Jira issue: a quiet end is silent by definition. A Telegram topic with
  requests follows the same rows: its fire rides the job's request or the scheduler's own (§ Scheduled runs), and the only thing the
  engine reads from the request itself is whether the scheduler's request was ever answered (the silent close). A scheduler fire
  itself is not a wake-up and never counts against the cap (the reminder after its silent turn, row 13, is one). The header of a fire
  that rides a request owing the requester an answer says so (`scheduledRunTarget.ts`) — «answer it in this turn» instead of «only when you have
  a result» — so the agent is not left to learn it from the reminder. This is why an agent in a Jira issue can launch a worker, arm its watch, answer
  `progress` and end its turn, and why a Telegram topic in a view with requests is no longer reminded every 15 minutes while its own
  watch passes.
- **A forward into a turn already watched for the same request MERGES with it** (`trackForwardedTurn`), when that turn still runs (§ Turn
  starts: a turn that ended is settled first, so a post that waited normally starts a NEW turn): a fire forwarded into a person's
  running turn (`postToSession`'s 10-minute wait ran out), an issue update during a fire, the bot's own «continue». The merged watch keeps the earlier start of the progress count (a «continue» starts it
  afresh, and so do a person's words that join the turn: a note sent before them is not their answer), is a request prompt's if either was (R21: the prompt is still marked taken in) and is the alarm's only if BOTH were (a
  «continue» keeps the alarm's kind). A person's words are not a property of the watch: they are owed on the persisted request from the
  moment they are forwarded, so an alarm that joined a requester's turn can never turn that turn's silent end into a quiet one. A fire
  riding a request also leaves its pending post retry alone: it carries none of the request's message.
- **The request a job is armed under** (`pickRequestToArmUnder`, asked through the engine's `getArmingRequestIdOf`): the one the agent is
  working on. Tiers, the first that has a request wins: a request whose watch a forward of its OWN started (its prompt, an issue update,
  a fire riding it, a reminder for it — `isOwnForward`, kept by a merge if either side had it) — the OLDEST of them, the request whose
  forward STARTED the running turn (the watches present all belong to the session's current busy period — every write first settles the
  watches whose turn ended, § Turn starts; `ownForwardStartedAt`, a merge keeps the earlier), so a hand-over's comment or fire that joins a mention's turn does not take the mention's job and the reverse holds
  too, and so does the scheduler's request whose fire started the turn (the watch an agent arms while handling that alarm is its); a request watched only because a
  CONVERSATION-WIDE forward carried it along (a «continue» nudge and a restart wake that carried several requests watch EVERY open request,
  which says nothing about the one the agent works on); the open requests. Inside those last two tiers the newest wins, a tracker hand-over
  (`trackerEvent`) before a mention (`trackerMention`): a mention hands nothing over and long work belongs to the hand-over, and the
  scheduler's request (`scheduledRun`) is passed over for any other: they do not know the turn, and a person's work outlives an alarm. Without this the watch armed after an API error would go to another
  person's mention and the hand-over would wait for nothing.
- **Self-check — every write of the owed fields** (`progressAnswerCount`, `isPersonInputUnanswered`, `silentTurnCount`,
  `lastTurnActivityAt`), which request it writes and whether it can write a request other than the one whose words, answer or turn
  caused it. Keep it next to the table: a new writer is a new row here and, when it can reach another request, a decision.
  `lastTurnActivityAt` keeps one rule: only the request's OWN turns count as its activity — a turn its own forward started (its prompt,
  an update, a reminder for it, a fire of its own job, the fire that opened it) or a conversation-wide forward that tracks it on purpose
  (a «continue», a restart wake), whose end is then decided for it. Another job's fire that rides it, a «continue» of that fire, and the
  busy time of another request's watched turn never count.

  | Field | Writer | Request written | Another request? |
  |-------|--------|-----------------|------------------|
  | `progressAnswerCount` | `answerRequest` (progress +1) | the answered request (`args.requestId`, conversation-scoped) | No |
  | | `createRequest` (initial 0) | the new request | No |
  | `isPersonInputUnanswered` set | `trackForwardedTurn` | the request the forward is tracked for: the posted prompt, the update's target, a topic prompt, the woken request. A conversation-wide forward (`trackContinuationTurn`, `wakeAfterRestart`) tracks every open request, but sets the flag only for the requests whose OWN prompt rode the message (`getPromptNotTakenIn`) | No, since decision 26 |
  | | `notePersonInputHeld` | the held comment's target request | No |
  | `isPersonInputUnanswered` cleared | `answerRequest` (progress) | the answered request | No |
  | `silentTurnCount` | `decideTurnEnd` / `getWakeOrCapDecision`, applied by `applyDecision` | the request whose watched turn ended | No: a session turn watched for several requests is decided for each against its own answer |
  | | `answerRequest` (progress) | the answered request | No |
  | | `trackContinuationTurn` with `isCountersReset` (also zeroes `wakeCount`, the follow-up and `isLimitStopped`) | EVERY open request | **Yes, by design**, for the callers that keep the conversation's requests: the end of a limit wait (`apiRetryKick`), the account-wait resume and a limit fallback switch within its backend (`resumeTopicOnNewSession`). A switch ACROSS backends calls it too — the limit fallback onto the other backend and the operator's bridged manual switch (`executeBackendSwitch`) — but resets nothing: `switchThreadAdapter` has already closed every open request `cancelled` (`cancelConversation`). An unbridged switch has no first prompt and returns before `trackContinuationTurn`. The flag is never touched: what is owed stays owed |
  | | `createRequest` (initial 0) | the new request | No |
  | `lastTurnActivityAt` | `recordTurnActivity` from `trackForwardedTurn` (forced, keyed on the watch it just stored) | the tracked request; a «continue» and a restart wake that carried several requests track each of them; NOT when the watch is another job's fire (`isRequestJob` false: its own forward or a «continue» of it) | **Yes, by design**: one session turn, every request in it is watched, and its end is decided for each. A ridden request is never written by another job's fire or its «continue» |
  | | `recordTurnActivity` from a busy poll of a watched turn | the watched request itself, unless the watch is another job's fire (`isRequestJob` false: the busy time is that job's) | No — a write first settles the watches whose turn ended (§ Turn starts), so a watch present belongs to the current busy period, a prompt joined into it included (json-stream and OpenCode queue another request's prompt into a running turn, and the earlier watch stays `running` on the unconsumed input through the next CLI turn; the tmux Claude's interrupt keeps it too): the busy time it records is that period's, and its end is decided at the same turn's end |
  | | `recordTurnActivity` from the sweep's busy branch | the unwatched request | **Narrowed** (rows 2, 11): recorded only while NO turn is watched in the conversation, whatever the request owes, AND the running turn is one the bot wrote (not `isCliOwnTurn`: a finished task's turn or a session job's, row 18) — then the busy session is the request's own lost turn (or one untracked turn of row 18). With a turn watched the busy time is that turn's: recorded, it would push the backstop of a request whose watch fired and nobody handled (`armed`, or `none` after a dropped watch: no follow-up, the backstop is its only wake). A held request ignores the backstop anyway, and a due follow-up is woken by `nextWakeAt`, which activity does not move |
  | | `decideTurnEnd` / `decideUnwatchedRequest` / `decideRestartWake` updates, applied by `applyDecision` (a settle's by `persistDecision`, its reminder written after the caller's write) | the decided request; `decideTurnEnd` only at the end of a turn that STARTED — it runs on a watch that reads `ended`, and a turn whose prompt still waits in the startup buffer or is being replayed reads `running` (`checkIsReplaying`, § Turn starts); the no-answer quiet end of another job's fire writes nothing (`nextWakeAt` stays too) | No |
  | | `wakeAfterRestart` (writes `decision.update` itself; only its alert goes through `applyDecision`) | each request it wakes, for itself — with `isLostWork` (row 19) also a request a passing watch holds, still only for itself | No |

  The one reader that decides more than the owed reading from these fields: `progressAnswerCount` 0 on the scheduler's request
  (`checkIsUnansweredFireRequest`) makes any silent end close it (`decideTurnEnd`'s `isRequestSettled`), so an `answerRequest` progress on it
  turns it into an ordinary answered request. No field decides the kind of a TURN: only the forward that started it says it was a
  fire's (`isScheduledRun`), and no fact passes from a replaced request to its replacement (a fire never replaces a live scheduler's request).
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
