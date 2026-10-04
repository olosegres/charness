# `src/requests/` — request / answer core

A *request* is one unit of work handed to a conversation's agent: a user message, a scheduled run, a tracker
event. The agent answers through the `answer_request` MCP tool and the platform's `AnswerSink`
(`../platform/answerSink.ts`) delivers it. Nothing here knows Telegram — every platform goes through the same code.
Numeric bounds are named constants in the files below; this README says only what the code cannot.

## Ledger (`requestLedger.ts`)

- **At most ONE open request per conversation** (`state.json` `openRequests`, keyed by the `SessionKey`
  string, changed under the state's per-key lock). `createRequest` supersedes the previous one in the same
  atomic step and resolves only once the new request is flushed to disk — an id an agent was told about is
  never lost to a crash.
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
  read. It is never written to the closed history.
- Closed ids stay known only up to `closedRequestIndexMaxSize`; an older one reads as unknown.

## `answer_request` (`answerRequest.ts`)

- An unknown id and an id outside the caller's scope are refused ALIKE — a session cannot probe other
  conversations' ids.
- A failed delivery leaves the request unchanged, so the agent can retry. After a delivery `progress` keeps
  the request open (counted, and it marks a kept prompt as taken in); `question` and `final` close it. An
  answer to an already closed request is still delivered and changes nothing.

## Wake-ups (`wakeUpRules.ts` = pure decisions, `wakeUpEngine.ts` = timers)

- A turn has ENDED only when the session is idle, nothing blocks it (pending question, compaction, armed
  retry or limit wait, session start, wedge recovery) and the backend has TAKEN IN the request's message
  (`checkHasUnconsumedInput`) — otherwise an earlier turn's idle reads as the end of this request's turn.
- A silent turn wakes the agent at once; the second silent turn in a row alerts and stops; a `progress` note
  resets the counter and schedules a follow-up; every wake passes `maxWakeUpsPerRequest`. Requests nobody
  watches get a backstop wake (`getRequestBackstopMs`).
- A request whose prompt could not be posted is retried on `postRetryDelaysMs`, OUTSIDE the wake-up cap
  (`notePostFailed`); a message forwarded any other way drops a pending retry.
- A failure in one conversation is logged and never stops the others or rejects a timer tick — an unhandled
  rejection ends the process.
- Cancelling the conversation (`/esc`, `/c`, `/quit`, `/quit-all`, `/new`, a `/resume` pick, leaving the
  folder, switching to another agent or a shell) closes the open request `cancelled` (`cancelConversation`).

## Usage limits (`limitWaitAnswer.ts`)

- During an ARMED wait the probe holds the turn: nothing wakes the request and no attempt is spent. The bot
  answers the request itself with a `progress` answer ("the answer will come after HH:MM") — not through
  `answer_request`, so it is not the agent's note and starts no follow-up. It replaces the plain notice, is
  deduplicated per request and per wait, and a request opened mid-wait is told by the ledger's
  `onRequestCreated` hook.
- When the retry's "continue" nudge is forwarded, `trackContinuationTurn` watches its turn afresh and, after a
  LIMIT wait, restarts the counters. A wait that will not end by itself (auto-resume off, «Skip once»,
  the retry giving up) calls `stopWakingForLimitWait` — no alert; a later limit resume lifts it, otherwise the
  operator's next message supersedes the request. A stop that lands while a decision is under way wins
  (`applyDecision` re-checks under the ledger lock).
