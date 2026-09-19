# Development

Architecture and local-development notes for TelegramCode. User-facing setup
lives in the [README](README.md); for a deep dive into every module and
behavior, see [`CLAUDE.md`](CLAUDE.md).

## Architecture

The per-topic folder layout is in the README under
[Required files structure](README.md#required-files-structure).

Routing key is `(chatId, threadId)` everywhere. Per-thread state lives in
`${DATA_DIR}/state.json` (atomic writes with `fsync`, archived on
corruption). Bot-owned tmux sessions are named per backend —
`claude-<chatId>-<threadId>` (Claude tmux-scrape), `cjson-…` (the Claude
json-stream host process), `term-…` (terminal) — see
`src/utils/tmuxSessionName.ts`; opencode sessions are keyed by the same
`<chatId>:<threadId>` string. Two topics on the same folder stay independent.

### Connector pattern (the platform seam)

The core never speaks to a chat platform directly. It consumes normalized
`InboundEvent`s and emits semantic `OutboundContent`, both addressed by a
platform-agnostic `SessionKey`. Telegram is the first connector; adding a
tracker or Teams surface means adding a directory under `src/connectors/`, not
editing the core.

```
Telegram  <->  connectors/telegram/  <->  bot.ts  <->  AgentAdapter <-> { Claude CLI (tmux scrape) |
                 inbound.ts               (core)          │              Claude CLI (stream-json) |
                 outbound.ts + output/      │             │              OpenCode (HTTP+SSE)      |
                 sessionKeyCodec.ts         │             │              Terminal ($SHELL in tmux) }
                 renderAgentHtml.ts         │             │
                 messageSplit.ts            │             └── state.ts  (bindings, claudeSessionId,
                 fileIntake.ts              │                            opencodeSessionId, messages,
                 fileSendGateway.ts         │                            MCP per-thread overrides)
                 updateDispatcher.ts        │
                 language/timezonePicker.ts │
                                            │
      platform/inbound.ts  ─────────────────┤
      platform/outbound.ts ─────────────────┤
      platform/commandRouter.ts ────────────┘
      (the contracts — no platform library may be imported here)
```

A test (`src/__tests__/platformBoundary.test.ts`) fails if any module outside
`src/connectors/telegram/` imports the Telegram library; `src/bot.ts` is the one
explicit, documented exemption still awaiting decomposition.

- `platform/` holds the CONTRACTS: `InboundEvent`, `ConnectorInbound`,
  `OutboundContent`, `OutboundHints`, `ConnectorCapabilities`,
  `ConnectorOutbound`, and the neutral command router.
- `connectors/telegram/` holds the IMPLEMENTATION: telegraf types, the HTML
  dialect, message limits, inline keyboards, pins, the typing action, and the
  frozen `"<chatId>:<threadId>"` key spelling.
- A connector DECLARES its capabilities (`ConnectorCapabilities`); the core
  degrades where a surface lacks one — a tracker has no pinning and no tappable
  buttons.
- `OutputTransport` (`src/connectors/telegram/output/`) is a Telegram CHAT-MODE seam, one level
  below: picked once at boot by `CHAT_MODE`, group edit-in-place stream vs the
  owner-DM native draft "cursor". It is composed by the Telegram connector, not
  by the core.

### Adapter pattern

Each adapter implements `AgentAdapter` from `src/types.ts`:
- `startSession(key, workDir, args?, sessionId?)` / `stopSession(key)` / `resumeSession(key, workDir, sessionId, options?)`
- `sendInput(key, text)` / `sendSignal(key, signal)`
- events: `output`, `status`, `question`, `questionGone`, `thinking`,
  `toolResult`, `subagentStatus`, `apiError`, `started`, `stopped`, `closed`,
  `error` (all emit `SessionKey` first)

## Local development

```bash
yarn install
yarn dev          # tsx watch (fast dev — TS errors crash the process)
yarn typecheck    # strict tsc --noEmit
yarn build        # tsc → dist/
yarn test         # unit/integration (node test runner + tsx); build first —
                  # some tests exercise the built dist/cli.js
yarn hot          # hot-reload mode: tsc -w + nodemon on dist/ (also
                   # `telegramcode hot` from anywhere) — a broken edit can't
                   # take the bot down; OpenCode generations stay outside the
                   # worker tree, so agent turns survive worker reloads
                   # (Linux/macOS; Windows hot mode is intentionally refused)
```

The Docker dev loop (never `docker compose restart` — it ignores
`depends_on`):

```bash
docker compose down telegramcode-pet && docker compose up -d telegramcode-pet
docker compose logs -f telegramcode-pet     # tail logs
```
