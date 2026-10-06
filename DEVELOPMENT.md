# Development

Architecture and local-development notes for Charness. User-facing setup
lives in the [README](README.md); [`CLAUDE.md`](CLAUDE.md) is the short
project map for agents, and each module's behavior is documented next to the
code (`src/<module>/README.md`).

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
- A connector DECLARES its capabilities (`ConnectorCapabilities`) and content
  degrades through one shared rule (`platform/capabilityFallback.ts`) that every
  connector applies — a tracker has no pinning and no tappable buttons, so the
  options stay as the enumerated text the body already carries and the user
  answers by index. `src/connectors/test/` is a capability-configurable test
  double that makes those degraded paths reachable; it is TESTS ONLY.
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
yarn test         # test:unit, then test:flows (node test runner + tsx); build
                  # first — some tests exercise the built dist/cli.js
yarn test:unit    # every file but the flows; each file must finish in 2 min
yarn test:flows   # the `*E2e.test.ts` flows; each file must finish in 20 min
yarn hot          # hot-reload mode: tsc -w + nodemon on dist/ (also
                   # `telegramcode hot` from anywhere) — a broken edit can't
                   # take the bot down; OpenCode generations stay outside the
                   # worker tree, so agent turns survive worker reloads
                   # (Linux/macOS; Windows hot mode is intentionally refused)
```

Node applies `--test-timeout` to a whole test FILE (a `describe`'s own `timeout` cannot extend it), so a file that
hangs or leaves a process alive fails by name when its limit passes, instead of hanging the run. A long-running
flow file must be named `*E2e.test.ts` to get the flows' limit; `live/*Live.test.ts` is run directly (CLAUDE.md).
A flow's own time budget is that same limit less a teardown reserve (`getFlowDeadlineMs`, read from the process's
`--test-timeout`), so a flow that runs long fails first, at the wait that is late and with charness's output tail,
not with the runner's bare timeout. Run one flow directly with `--test-timeout=<ms>`.

The Docker dev loop (never `docker compose restart` — it ignores
`depends_on`):

```bash
docker compose down telegramcode && docker compose up -d telegramcode   # examples/docker-compose.yml
docker compose logs -f telegramcode         # tail logs
docker exec telegramcode-main telegramcode-restart-bot   # restart only the bot; agents keep running
```
