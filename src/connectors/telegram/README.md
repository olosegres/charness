# `src/connectors/telegram/` — the Telegram connector

The only place that imports the Telegram library (`platformBoundary.test.ts` enforces it; `bot.ts` is the one
documented exemption). It translates telegraf updates into the core's `InboundEvent`s and the core's semantic
`OutboundContent` into messages, edits, pins, keyboards and typing actions. It owns the frozen
`"<chatId>:<threadId>"` key spelling (`sessionKeyCodec.ts`) and the HTML dialect.

- **Membership lookup must REJECT when it cannot answer**, never resolve `[]`: `AdminCache` stores an empty
  answer as fresh and would lock everyone out for the whole TTL. An admin-status change in the served space
  invalidates the cache at once (`checkShouldInvalidateAdminCache`).
- **`bindPicker.ts`:** the `/bind` folder keyboard (create row, folder grid, paging), a leaf module `/topic` reuses with its
  callbacks re-targeted (`BindPickerCallbacks`).
- **`outbound.ts`:** ordinary turn content streams through the chat-mode transport below; content carrying
  `keepVisible` or tappable `options` finalizes in-flight output FIRST, then posts as its own message, then pins.
  `setActivity` `working` drives the typing loader, `starting` is ONE typing ping.

## Output transport (`output/`)

Chosen once at boot by `CHAT_MODE` — an internal detail of this connector, not the platform seam.

- **group** — the `queueOutput` edit-in-place path. A continuation appends to the message being rendered: the
  FULL accumulated text is re-rendered (so `**` / `` ` `` pairs split across flushes re-pair) and edited in
  place, spilling into a new message past the cap (`outputFlushPlan.ts`). A topic's unsent text is ONE ordered,
  numbered backlog sent by ONE loop from its head (`utils/groupOutputBacklog.ts`, whose header lists what it
  keeps): a leftover that failed for now (a 429, the network) goes back to the head, one Telegram refused for good
  (a closed topic, another 4xx) is dropped with a log line, a send whose outcome is unknown is never sent again, and
  nothing captures a slice of it. `finalizeInFlight` is a landing: it seals the newest segment and waits until every
  segment up to it has settled, so a question, a tool call's status frame, an `answer_request` answer and the
  messages of `send_messages_to_user` — posted straight to the topic — land BELOW the text the agent streamed
  before them. Each of them waits for at most `streamedOutputLandingLimitMs` (60 s,
  `utils/streamedOutputLanding.ts`), then posts anyway. A stop gives the backlog ONE final attempt (a 429 then
  drops what it keeps, logged) and drops only the pending status frame (`utils/clearStatusCoalescer.ts`).
- **dm** — a live "cursor": ONE accumulating native `sendMessageDraft` holds the whole current reply and is
  FINALIZED to a permanent `sendMessage` on boundaries (idle, 4096 overflow, `isFinal`, a new response, status,
  teardown). Claude's scrape adapter emits deltas with no continuation meta, so the transport synthesises it
  (`getDmDraftContinuation`, gated on `outputsDeltas`). The Claude liveness heartbeat stays a no-op while a
  draft is active, or its status frame would chop the draft mid-answer.
- **both** — a dispatcher routing each per-thread call by `checkIsDmKey(key)` to a once-built DM or group
  implementation.

## Send pacing (`../../rateLimiter.ts`)

ONE process-wide `GlobalSendPacer` releases at most one send per `globalSendIntervalMs` across ALL chats,
first-come-first-served, CLOCK-based and non-blocking (a slow send never head-of-line-blocks the others). Each
topic coalesces its own stream with a 3 s output debounce; when a topic backs up
(`backlogGlueThreshold`) the flush glues the backlog into the fewest messages (`outputBacklogGlue.ts`).
Cancelling rejects a send still parked in the queues; once a send has started, the caller awaits it and its
cleanup. Each Bot API call of a topic's queue is bounded by `telegramSendOperationDeadlineMs` (30 s; the pacer's
and a 429's waits do not count): at the deadline the request is aborted — the client passes the queue's abort signal
to it (`botApiConnection.ts`) — and settles as `SendOutcomeUnknownError`, so one hung call never holds the topic's
later sends. Its outcome is unknown, so no caller sends it again (`sendOutcome.ts`): an output chunk counts as sent
(the next text opens a new message); an edit counts as made for every caller, so none posts the content anew (a
status or thinking frame keeps its message, a screen is not posted again); a question is not posted again as plain
text, and a pinned notice (logged out, limit reset, a runner's link — `pinnedNoticeSlot.ts`) not at all; an
`answer_request` answer is reported delivered with a plain warning that it may not have reached the user, the part
known to have landed pinned; a `send_messages_to_user` batch ends as `deliveryUnknown` with the ids that did land.
A file upload opts out (it bounds its own wait).

- **Unpaced on purpose** (`sendUnpaced`: 429 retry kept, no pacer permit, no per-thread FIFO): the typing
  indicator (not a message, yet it ate ~60% of the budget) and the voice acks (the transcript echo and the
  retry notice — the user's own input must not queue behind agent output). Agent output NEVER goes unpaced.
- The old post-cooldown redelivery was retired: at one send per 2 s a 429 is nearly impossible and the late
  re-send was the OUT-OF-ORDER cause. `withRateLimitRetry`'s single retry-after wait is the floor.

## Bot API connections (`botApiConnection.ts`)

The bot pools keep-alive connections to the Bot API and a server closes an idle one after a while. A client that has not yet
read that close (a process starved of CPU) writes its next request onto it: «socket hang up» / `ECONNRESET` / `EPIPE` for a
request the closed connection never delivered.

- **The agent** (`createBotApiHttpsAgent`; `createBotApiHttpAgent` for the `http://` root of the process-level tests, where
  Telegraf drops its own agent) closes a pooled connection that idled `botApiFreeSocketTimeoutMs`, far below the server's
  limit. Node applies that socket timeout to FREE sockets only, so a 50 s long poll is not cut. A client stalled past the
  server's limit is not helped by it: its timers do not run either. What it meets then depends on the Node: since 22.23.4 the
  http agent itself looks for what the server already sent on an idle socket before it reuses it («http: ensure agent data guard
  works without I/O», CVE-2026-105481), finds the close and opens a fresh connection; an older one (`engines` allows 22.12) writes
  onto the closed connection. On every Node a server can still close a pooled connection as the request is on its way, which no
  client sees coming — the retry below covers that, and the older agents' case.
- **The retry** (`wireBotApiClient`) sends a `callApi` again ONCE on a fresh connection, only when its request rode a REUSED
  connection (`ClientRequest.reusedSocket`, read through an `AsyncLocalStorage` probe because node-fetch drops the request
  from its error), the error came within `staleConnectionFailureWindowMs` of the reuse (a closed connection fails within a turn of the event loop;
  a server that held the request for long and then reset it is not retried), the socket read NOT A SINGLE BYTE since the reuse
  (`socket.bytesRead` — also true of a TLS socket's application stream; the `response` event would miss half a head), and the
  error is a `checkIsConnectionResetError` one.
  Never after a timeout, an abort, an answer that began, or on a fresh connection; never for a payload with a stream (the file
  send path keeps its own `deliveryUnknown` rules). It is a heuristic: a server that took the request and dropped the
  connection at once, before any byte of its answer, looks the same, and there the retry posts twice. It runs below the FIFO, the pacer
  and the 429 retry — no extra permit, the thread's order is kept — and above the trace, which shows both attempts.
- **Wire EVERY client.** Telegraf builds a NEW `Telegram` for every update (`ctx.telegram`, behind `ctx.reply`,
  `ctx.answerCbQuery`, `ctx.editMessageText`) from `bot.telegram.options`, which already lack the agent of an `http://` root.
  `bot.ts` wires `bot.telegram` once (after the trace wrap) and the FIRST `bot.use` wires `ctx.telegram` per update.
- Proof: `botApiConnection.test.ts` (real sockets, every rule), `botApiConnectionStall.test.ts` (the fake hanging up on a
  pooled connection under the client — every Node —, and a stalled client against the fake closing idle connections, held to
  what this Node's agent does with it), `staleConnectionRetryE2e.test.ts` (the whole bot, a `bot.telegram` send and a `ctx.*` picker edit).

## Agent → user file sending

User-visible behaviour (limits, albums, cancellation, `deliveryUnknown`) is in the public `docs/backends.md` (Bot-injected agent tools). What a
maintainer must not break (`fileSendGateway.ts` with `../../utils/fileSendService.ts`, `fileSendPlan.ts`):

- The service pins ONE canonical root for the whole operation and, on Linux, traverses from a root descriptor
  with per-component `O_NOFOLLOW`; it checks the opened file's device/inode identity and size and keeps every
  descriptor open until the gateway returns. Windows and macOS have no descriptor-relative lookup: there the
  `verifiedPath` strategy opens the canonical path, holds the opened file to the validated identity and resolves
  the path again (still inside the root, still that file) before it is used. `fileSendService.test.ts` runs the
  shared contract under both strategies on Linux — keep a new file-send test in `sharedTest` unless it watches
  the root descriptor itself.
- Each gateway attempt builds a FRESH bounded stream. Telegram API errors are retried; any other failure after
  the upload began is `deliveryUnknown` and is NEVER retried automatically (Telegram may already have
  accepted it).
- Once the gateway returns, delivery is final: a later recording or cleanup failure is a warning on an
  `ok:true` result, never a reason to retry.
- After every upload stream has ended, caller cancellation is deliberately NOT forwarded (Telegram may hold the
  upload); a response deadline applies instead.
- A directory-scoped call re-resolves the topic binding before opening files and again inside the delivery
  queue, refusing a binding that changed meanwhile.

## Requests in a topic (`../../requests/`)

- A topic opens requests only in the views with requests on (`/verbosity stream_answers|answers`,
  `utils/topicView.ts`). They are opened at the USER entry points — text, voice, file, album, `/schedule`, the
  scheduler's forward — never inside the prompt choke point, which also carries non-requests (the API-retry
  nudge, wake-up reminders, replays). A slash command forwarded to the agent, and an answer to the agent's own
  native question, never open one.
- The request header leads the per-message body (ahead of the reply quote, never in the once-per-change thread
  preamble) and says the plain text and the thinking are hidden only in the answers-only view (the line is
  per prompt, so it stays true when the view is switched mid-conversation). A prompt buffered behind a session
  start carries its header and its reply quote from capture time (a typed text and a voice transcript alike).
  A file or an album sent as a reply carries the quote too (an album takes the first member's).
  The ledger keeps that prompt with its message context (the quote, the forwarded mark) folded in
  (`openTopicRequest` → `buildTopicRequestPrompt`): the stored prompt is what is posted again after a failed post, a restart or a
  usage-limit wait, and a bare text would come back without them.
  A reply TO a file names it (`[photo, saved to: …]`): the path is the thread's saved copy
  (`findSavedFileName`, matched exactly by the intake's file name), absent once purged or never taken in.
- **Message context** (`inbound.ts` `getTelegramMessageContext`, folded by `utils/messageContext.ts`): ONE reader
  turns how a message arrived into the block that leads its prompt — the reply quote (`[Replying to an earlier
  message · from: …]`, `utils/replyQuote.ts`), then, for a FORWARDED message (`forward_origin`: user, hidden user, chat or
  channel), the mark `[Forwarded message · from: <kind> "<name>" · originally sent: <local ISO>]`
  (`utils/forwardedMark.ts`; the names, titles and signatures are a stranger's, so they are quoted and stripped of brackets and
  control characters by the shared `utils/stripControlCharacters.ts`) next to the words it describes. The reader works off the message, so a text, a caption, a
  voice transcript and a file announcement are marked alike, and every route (live forward, startup buffer, file, album)
  folds it with the same rule. There is NO coalescing of text or voice: each message is its own prompt with its own
  block, so a burst of forwards plus the operator's own words stays distinguishable; the two coalescing sites are an
  album (one block, the first member's) and the prompts held over a usage-limit wait, which follow the folded text of the
  prompt that releases them under a header line of their own (`heldPromptsHeader`) and so never read as part of a forward. A slash command the operator TYPED or a terminal topic's
  shell line never carries the block. A FORWARDED message is content, never control input (`MessageContext.isForwarded`,
  `checkIsTelegramForward`): `getTelegramCommand` returns `null` for it (Telegram keeps the original's `bot_command` entity), its
  text starting with `/` is folded under the mark and decorated like any prompt (`checkIsSlashCommandPrompt`), and it answers no
  pending question, option pick or selector, starts no agent and wipes no context; the routes that take text as an ANSWER the bot
  asked for (a pasted code, a name, a key, a reminder's text) still take it. A terminal topic types it like any text. A reply TO a forwarded message names who first wrote it in the quote's header
  (`from: user, forwarded from channel "Ops Alerts"`), read off the replied-to message's own `forward_origin`.
- A scheduled run held over a usage-limit wait rides the resume as plain text, without a request.
- **Answers only** (`utils/topicView.ts` `checkIsAgentEventShown`, applied per event in `bot.ts`): the agent's
  text, status/progress frames, thinking, tool results and sub-agent frames are dropped; a native question with
  its buttons, the typing indicator, files and messages the agent sends through the bot MCP, the pinned
  answers and the bot's own notices stay. A real answer still retires a pinned logged-out notice. The gate is
  read per event, so a view switch applies to the next one; a frame on screen at the switch is not removed.
- **Answers are pinned** (`answerSink.ts`): every delivered `answer_request` answer is pinned WITH a
  notification; only the latest answer of a topic stays pinned — the previous one is unpinned silently (its
  message stays), and the record of the pinned answer is persisted (`state.json` `answerPins`) so a restart
  does not leave two pinned. A failed pin changes nothing. Native question pins and scheduled-run pins are
  separate records. An answer is the LAST message of its turn: the shared message sender
  (`utils/messageSendService.ts`, also behind `send_messages_to_user`) lands the text the agent streamed ahead of
  it — still unread in the CLI's output, in the adapter's batch window (`flushPendingOutput`), in the 3 s output
  debounce or already going out — before it posts (`landStreamedOutput`); a landing that fails, or that has not
  ended after `streamedOutputLandingLimitMs`, never holds the messages back.

## Topic status marks (`topicIndicator.ts`)

The mark at the END of a bound topic's name (`❓ ❗️ ⏳ ✅ 💤`, optionally `⚙️N 📋N`; switched by `/topic_status`, see `commands/README.md`). `utils/topicIndicatorPlan.ts`
is the pure plan (which status holds, `composeIndicatorName` — `<base> <status> <counts>`, the BASE cut to Telegram's 128, never the mark —, `stripIndicatorSuffix`, and
`planIndicatorRename`: a name must have been the wanted one for the settle time and two renames keep a gap, except the edges of ❓ and the owner's own change);
`utils/topicIndicatorSources.ts` turns what `bot.ts` reads (adapter, question maps, schedules, retry timers, todos) into the facts; this module keeps, per topic, the name it last
wrote (`binding.indicatorAppliedName`, persisted) and since when the wanted name has been wanted, and writes it with `editForumTopic` — **the name only, the icon is the owner's**,
through the one send gate (`enqueueSend`). `bot.ts` asks `requestRefresh(key)` at every change signal (`updatePinnedStatus` at the agent's start / stop / suspend / close, a turn's first output
and end, a question asked / answered / set aside, a retry armed or cancelled, the logged-out notice, a watched worker created / paused / failing — `StateStore.setStatusSourceChangeListener` —,
a todo list change), a 5-minute sweep covers what no event announces, and the boot's wave looks at every topic once the updates that waited while the bot was down are handled (an
owner's rename made meanwhile is learned first). That wait is the **boot gate** — EVERY look (not only the wave) waits until the waiting updates are handled, capped at 30 s from `start()`: a boot signal such as a dropped question or the
pinned-status refresh wave would otherwise write the old base before the owner's offline rename was learned. `firstUpdateBatchNote.ts` decides «handled»: the first `getUpdates` was answered and the dispatcher is
empty — OR that first poll is still open after `firstPollHoldMs` (3 s), because Telegram answers at once when updates wait and holds the long poll (50 s) when none does: without that rule the marks, ❓ included,
would wait the whole cap after almost every restart. A COLD start (downtime over a minute) drops the waiting updates (`dropPendingUpdates`), so `waitingTopicRenames.ts` reads them first (`getUpdates`, `timeout: 0`,
`allowed_updates` = the bot's whole list `botAllowedUpdates` — Telegram REMEMBERS the list a call names, so a partial one would unsubscribe the rest until the launch's first poll resets it —, pages of 100, at most 50 pages; the renames are
picked out in code) and `bot.ts` applies only the `forum_topic_edited` messages of BOUND topics by an authorised sender through `applyOwnerTopicRename` — the path of a live rename — and deletes
the bot's own «renamed» lines; everything else is dropped as before and a read that fails is the old behaviour. It runs before `start()`, so the gate is no issue there.

- **The base is the owner's own name** (`binding.topicName`); a topic whose base the bot does not know is never written. It is learned from `forum_topic_created` / `forum_topic_edited`
  (`getOwnerRenameOutcome` cuts the bot's own trailing marks), from `/topic`, or by the owner's confirmation of `binding.topicNameCandidate` — the name on the root message a client
  attaches to the owner's plain posts (`getTopicCreationName`); the preamble and the topic rows read the base.
- **The bot's own rename comes back as a `forum_topic_edited` service message** (measured on the live bot, 2026-11-18): the handler checks «sent by the bot» FIRST, never stores it as a name
  or logs it as a stranger's, and deletes the line at once (`handleOwnRenameLine`; deleting it also reverts the unread badge and the topic's preview). A refused delete (no «Delete messages»)
  leaves the lines and shows a hint in the picker.
- **Failures are never error reports.** A refused right (`not enough rights`) stops the marks of THAT topic (`renameRefusals`, per topic — a topic the bot made itself needs no right, so one refusal must
  not cost it its marks) — one log line per chat per boot, the picker says why. The refusal is kept with the binding (`indicatorRenameRefused`, cleared by the next rename that is written, loaded on first use), so
  a restart does not send one failing call per refused topic; a refused chat is re-probed with ONE topic per sweep (`chooseRefusalProbes`, the oldest refused), the others only after it succeeds — a probe that ended
  WITHOUT a verdict on the right (`isProbeSilent`: its look found nothing to write because the topic wants no mark, the topic is gone, or Telegram ANSWERED its rename with a lasting rejection that is no missing right — a 4xx other than 429, `checkIsLastingRejection` next to `classifySendError`) is dropped from
  the refusal and the next refused topic is probed, never the whole chat released and never kept for ever on a topic that cannot answer; a probe that has no result yet — its call still queued on
  the send gate, its name still waiting for the settle time, its call failed with no answer / a 429 / a 5xx and its retry is armed — stays the probe for another round (an outage hits every topic alike: dropping one probe per sweep would only spend a failing call on each), so the picker's hint does not flicker — so a rights-less chat costs one failing call per round on the shared send gate, never one per topic. «TOPIC_NOT_MODIFIED» means the topic already has the name; any other failure is logged once per cause and
  retried by a backoff timer (`scheduleRetry`: the gap, doubling to a sweep, or the 429's `retry_after` as the floor) that looks again, so the LATEST name is written; `retryNotBeforeMs` keeps the backoff
  against every change signal — the plan holds all names back until it ends, a ❓ edge and the owner's own change excepted. A 429 is also `enqueueSend`'s own retry.
- **A topic that is being unbound is never written** (`checkIsUnbinding`, the guard `updatePinnedStatus` uses): `restoreBaseName` waits on the send gate and a late ❓ edge must not land after it.
- **The own rename's delete** marks the chat «no Delete messages right» only for a rights error (`checkIsMessageDeletionRefusedError`); a network blip leaves the picker alone.
- **The owner's rename** is cut of the bot's own trailing marks (`getOwnerRenameOutcome`); the «your ending was dropped» hint is told only when the saved ending is not one of the names the bot applied
  last (`getRecentAppliedNames`) — a mark the bot changed while the owner was typing is not his.
- Out of scope: General, Jira conversations, terminal topics (no agent states); the tmux-scrape backend shows only the states its adapter already reports (no question mark — its questions have no
  `pendingQuestions` entry).

## Testing against a fake Bot API

`TELEGRAM_API_ROOT` points the telegraf client at another Bot API host. The process-level Telegram test
(`src/__tests__/telegramViewsE2e.test.ts`; `telegramCommandsE2e.test.ts` for the slash commands, their
buttons and the voice path through a fake OpenAI-compatible engine `telegramE2e/fakeSpeechEngine.ts`, driven through
`telegramE2e/topicDriver.ts`; `sttBootE2e.test.ts` for the voice settings at boot and the end of an interrupted install; `fallbackSwitchE2e.test.ts` and `fallbackSwitchOpenCodeE2e.test.ts` for the usage-limit switch and its notice — the latter against a fake OpenCode server and CLI, `openCodeE2e/fakeOpenCodeServer.ts`, that serves only what the bot calls and lists the rest as `unhandled`) runs the built bot against
`telegramE2e/fakeTelegram.ts` on loopback with a placeholder token (it also answers `editForumTopic`, echoes the bot's own «renamed» line and refuses a rename that carries an icon — `topicStatusE2e.test.ts`); unset, the client talks to `api.telegram.org`. Telegraf drops its https
agent by itself for an `http://` root; the bot then wires its own http agent onto every client (`wireBotApiClient`, see «Bot API connections»).

## Guards

- `telegramCallGuard.ts`: an instance without the telegram connector still builds the client but wraps
  `callApi` OUTERMOST so every Bot API call rejects with `TelegramDisabledError`, logged once per method.
- `foreignKeyFallbacks.ts`: what the Telegram side of `bot.ts` does with another platform's conversation —
  locale default, no group title, and `createTelegramPrimitiveGuard`, which every Telegram I/O primitive calls
  first and returns early on.
- `../../utils/linkPreviewSuppression.ts` defaults every outgoing text to NO link preview at the shared
  `callApi` choke point; a caller that sets its own preview option wins.
