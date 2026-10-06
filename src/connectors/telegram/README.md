# `src/connectors/telegram/` — the Telegram connector

The only place that imports the Telegram library (`platformBoundary.test.ts` enforces it; `bot.ts` is the one
documented exemption). It translates telegraf updates into the core's `InboundEvent`s and the core's semantic
`OutboundContent` into messages, edits, pins, keyboards and typing actions. It owns the frozen
`"<chatId>:<threadId>"` key spelling (`sessionKeyCodec.ts`) and the HTML dialect.

- **Membership lookup must REJECT when it cannot answer**, never resolve `[]`: `AdminCache` stores an empty
  answer as fresh and would lock everyone out for the whole TTL. An admin-status change in the served space
  invalidates the cache at once (`checkShouldInvalidateAdminCache`).
- **`outbound.ts`:** ordinary turn content streams through the chat-mode transport below; content carrying
  `keepVisible` or tappable `options` finalizes in-flight output FIRST, then posts as its own message, then pins.
  `setActivity` `working` drives the typing loader, `starting` is ONE typing ping.

## Output transport (`output/`)

Chosen once at boot by `CHAT_MODE` — an internal detail of this connector, not the platform seam.

- **group** — the `queueOutput` edit-in-place path. A continuation appends to the message being rendered: the
  FULL accumulated text is re-rendered (so `**` / `` ` `` pairs split across flushes re-pair) and edited in
  place, spilling into a new message past the cap (`outputFlushPlan.ts`). `finalizeInFlight` drains the
  coalesced-but-unsent buffer to a permanent message on settle or teardown, so the final answer is never
  discarded under a 429.
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
cleanup.

- **Unpaced on purpose** (`sendUnpaced`: 429 retry kept, no pacer permit, no per-thread FIFO): the typing
  indicator (not a message, yet it ate ~60% of the budget) and the voice acks (the transcript echo and the
  retry notice — the user's own input must not queue behind agent output). Agent output NEVER goes unpaced.
- The old post-cooldown redelivery was retired: at one send per 2 s a 429 is nearly impossible and the late
  re-send was the OUT-OF-ORDER cause. `withRateLimitRetry`'s single retry-after wait is the floor.

## Agent → user file sending

User-visible behaviour (limits, albums, cancellation, `deliveryUnknown`) is in the public `README.md`. What a
maintainer must not break (`fileSendGateway.ts` with `../../utils/fileSendService.ts`, `fileSendPlan.ts`):

- The service pins ONE canonical root for the whole operation and, on Linux, traverses from a root descriptor
  with per-component `O_NOFOLLOW`; it checks the opened file's device/inode identity and size and keeps every
  descriptor open until the gateway returns. macOS fails closed — there is no descriptor-relative bridge.
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
  A reply TO a file names it (`[photo, saved to: …]`): the path is the thread's saved copy
  (`findSavedFileName`, matched exactly by the intake's file name), absent once purged or never taken in.
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
  separate records.

## Testing against a fake Bot API

`TELEGRAM_API_ROOT` points the telegraf client at another Bot API host. The process-level Telegram test
(`src/__tests__/telegramViewsE2e.test.ts`; `telegramCommandsE2e.test.ts` for the slash commands and their
buttons, driven through `telegramE2e/topicDriver.ts`) runs the built bot against `telegramE2e/fakeTelegram.ts`
on loopback with a placeholder token; unset, the client talks to `api.telegram.org`. Telegraf drops its https
agent by itself for an `http://` root.

## Guards

- `telegramCallGuard.ts`: an instance without the telegram connector still builds the client but wraps
  `callApi` OUTERMOST so every Bot API call rejects with `TelegramDisabledError`, logged once per method.
- `foreignKeyFallbacks.ts`: what the Telegram side of `bot.ts` does with another platform's conversation —
  locale default, no group title, and `createTelegramPrimitiveGuard`, which every Telegram I/O primitive calls
  first and returns early on.
- `../../utils/linkPreviewSuppression.ts` defaults every outgoing text to NO link preview at the shared
  `callApi` choke point; a caller that sets its own preview option wins.
