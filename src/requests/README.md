# `src/requests/` — request / answer core

A *request* is one unit of work handed to a conversation's agent: a user message, a scheduled run, a tracker
event. The agent answers through the `answer_request` MCP tool and the platform's `AnswerSink`
(`../platform/answerSink.ts`) delivers it. Nothing here knows Telegram — every platform goes through the same code.
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
  read. It is never written to the closed history.
- Closed ids stay known only up to `closedRequestIndexMaxSize`; an older one reads as unknown.

## Header (`requestHeader.ts`)

- Agent-facing, English on every surface (not localized). A request that superseded others gets a line
  naming them and saying ONE answer to this request covers them all, so the agent never answers each
  separately. `joinPromptsNotTakenIn` is the re-post text of a conversation's untaken prompts (one per
  requester at most).

## `answer_request` (`answerRequest.ts`)

- An unknown id and an id outside the caller's scope are refused ALIKE — a session cannot probe other
  conversations' ids.
- A failed delivery leaves the request unchanged, so the agent can retry. After a delivery `progress` keeps
  the request open (counted, and it marks a kept prompt as taken in); `question` and `final` close it. An
  answer to an already closed request is still delivered and changes nothing — deliberately, never blocked;
  for a superseded request the tool result names the request that replaced it, so the agent knows which
  one its answer belonged to.

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
- A request whose prompt could not be posted is retried on `postRetryDelaysMs`, OUTSIDE the wake-up cap
  (`notePostFailed`); a message forwarded any other way drops a pending retry.
- A failure in one conversation is logged and never stops the others or rejects a timer tick — an unhandled
  rejection ends the process.
- Cancelling the conversation (`/esc`, `/c`, `/quit`, `/quit-all`, `/new`, a `/resume` pick, leaving the
  folder, switching to another agent or a shell) closes EVERY open request of the conversation `cancelled`
  (`cancelConversation`); a limit-wait stop and the counters reset of a "continue" nudge apply to every one too.

## Usage limits (`limitWaitAnswer.ts`)

- During an ARMED wait the probe holds the turn: nothing wakes the request and no attempt is spent. The bot
  answers every open request of the conversation itself with a `progress` answer ("the answer will come after HH:MM") — not through
  `answer_request`, so it is not the agent's note and starts no follow-up. It replaces the plain notice, is
  deduplicated per request and per wait, and a request opened mid-wait is told by the ledger's
  `onRequestCreated` hook.
- When the retry's "continue" nudge is forwarded, `trackContinuationTurn` watches its turn afresh and, after a
  LIMIT wait, restarts the counters. A wait that will not end by itself (auto-resume off, «Skip once»,
  the retry giving up) calls `stopWakingForLimitWait` — no alert; a later limit resume lifts it, otherwise the
  operator's next message supersedes the request. A stop that lands while a decision is under way wins
  (`applyDecision` re-checks under the ledger lock).
