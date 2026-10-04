# TelegramCode — agent guide

> **Keep this file a short map. Module behaviour goes to the module's `README.md`; do not add per-change notes here.**

> Shared rules live in the `.claude` rules directory (loaded automatically). User-facing behaviour (commands,
> env vars, features) is in the public `README.md`, the architecture diagram in `DEVELOPMENT.md`,
> per-function detail in the code's own comments and tests.

> **Terminology:** when the user says "чат"/"chat" they mean a **topic** (forum thread), NOT the whole
> supergroup. Read every such request as per-topic.

> **Naming:** the product in prose is **TelegramCode**; the npm package and the CLI command are lowercase
> **`telegramcode`** (legacy `telegramCode` bin alias kept; `DATA_DIR` default `~/.telegramCode` deliberately
> unrenamed).

## What this project is

A Telegram **forum-supergroup bot that proxies user commands and messages to agentic CLIs** — **Claude Code**
and **OpenCode** (plus a raw `$SHELL`). The bot has almost no "AI" logic: routing, session lifecycle,
translating chat input into the right call to the agent, and streaming the output back into the topic.

**Core mental model — the bot is a proxy/relay.** Most commands are *forwarded* to the agent:

- **Claude Code, two backends** (they share the on-disk transcript; `/claude_mode` switches a topic between
  them). `claude-json-stream` (DEFAULT) drives `claude -p` over stream-json as an EXTERNAL tmux-hosted process
  (FIFO stdin, tailed `stdout.jsonl`). `claude` (tmux-scrape) drives the interactive TUI with
  `tmux send-keys` and scrapes it with adaptive `capture-pane` polling (300 ms while the pane changes, backing
  off to 1.5 s). `CLAUDE_SCRAPE_DEBUG=1` logs raw/filtered scrape chunks.
- **OpenCode** — a local HTTP server: prompts POST to `/session/:id/prompt_async` (with a
  `model: {providerID, modelID}` override) and ONE multiplexed `/global/event` SSE stream serves the whole
  server; each event is routed by its envelope `directory` + `sessionID` (child→parent lineage for
  sub-agents). A genuinely unroutable `question.asked` / `permission.asked` is logged loudly, never silently
  dropped.
- **Terminal** (`/terminal`) — a raw `$SHELL` in tmux, no AI.

Adding a feature: first decide *bot-local or proxied?* A feature that changes agent behaviour (model, effort,
prompt, interrupt) usually has one implementation per backend — keystrokes or control frames for Claude, HTTP
for OpenCode — and the backends expose it very differently (Claude has a real `/effort` slash command;
OpenCode encodes effort as the model's variant). **`/model` (`handleClaudeModel` / `setOpenCodeModel`) is the
reference** for a per-thread, per-backend, persisted setting. `AgentAdapter` (`types.ts`) is the seam;
per-backend controls are optional methods the bot checks before calling.

## Key concepts (project-wide invariants)

- **The operator runs ALL topics muted.** A plain bot message is silent; **pinning** pierces a muted topic
  (a notification, no sound). So a pending interactive question is PINNED (`pinThreadQuestion` /
  `unpinThreadQuestion`, unpinned on resolve) — exactly one notification per question, re-pins are silent.
  Design any "the user must notice this" signal the same way.
- **One topic ↔ one project folder ↔ one agent session; the bind is mandatory.** The folder is a subfolder
  of `WORK_ROOT` (unset → the launch `$PWD`); an unbound topic refuses every agent-facing action. Two topics
  may share a folder. For OpenCode the bind selects the server instance (`?directory=<workDir>`).
- **Per-thread isolation.** Routing, sessions, prefs and history key on `SessionKey` `{platform, space,
  thread}`; each connector owns its serialisation (Telegram: the frozen `"<chatId>:<threadId>"`, which also
  names state fields, tmux sessions, `DATA_DIR` dirs). The core never parses a key.
- **Restart-safe.** State lives in `state.json` (+ per-thread JSON in `DATA_DIR`). A bot restart — hot mode
  restarts on every code change — must not kill agents: tmux sessions and the json-stream process are
  EXTERNAL and re-adopted at boot (json-stream replays the downtime tail from a persisted offset); OpenCode
  reconnects SSE and restores sessions by persisted id; a stale-version OpenCode server is replaced. Explicit
  `/quit`, `/quit-all`, `/new` and leaving a folder RELEASE the persisted ids: no auto-reattach, still
  resumable via `/sessions`. tmux is REQUIRED for both Claude backends.
- **Startup-safe input.** Prompts typed while a session boots are buffered in memory and replayed in order
  (`startupPromptBuffer.ts`; `deliverPromptOrBuffer` is the one buffer-or-forward unit).
- **Output.** OpenCode streams continuations that APPEND to the message being rendered; a non-continuation
  always posts a new message (an in-place edit would replace interim texts). Sends are paced by ONE
  process-wide FCFS gate (1 send / 2 s across all chats) with a 3 s per-topic debounce; only typing and a few
  voice acks are unpaced — agent output never is. HOW output reaches a topic is chosen
  once at boot by `CHAT_MODE`: `group` (edit-in-place), `dm` (native draft cursor), `both` (DEFAULT, decided
  per chat off the `SessionKey`; `OWNER_USER_ID` required for `dm`, optional for `both`).
- **Bot-injected MCP server `telegramBot`** (HTTP, loopback, per-session HMAC tokens scoped `thread:` /
  `dir:`) goes into EVERY bot-started session: `schedule_*`, `compact_conversation`, `answer_request`,
  `send_file_to_user`, `send_messages_to_user`. It is bot plumbing, separate from the user-editable MCP hierarchy (mostly dormant,
  undocumented). Clients cache `instructions` and tool descriptions at connect: a running agent sees an edit
  only after reconnecting; tool RESULTS reflect live code.
- **Scheduler** (`src/scheduler/`). `/schedule` hands free text to the agent, which calls `schedule_*`;
  `/reminders` is the bot-local twin (buttons only, the bot posts and pins itself, no agent, works in ANY
  topic, unbound/General included). One `schedules` store, split by `deliveryKind`. A `checkCommand` job is
  a WATCHDOG (`deliveryKind: 'check'`, `scheduler/checkRun.ts`): the bot runs the command in the bound
  folder, stays silent while it exits 0, and only the FIRST failure after a pass pins an alert and wakes the
  agent (`isCheckFailing` is stored before the wake, so a restart never repeats it); recovery posts one line.
- **One instance-wide timezone** (`/timezone`) applied through `process.env.TZ`. After a zone change never
  re-arm schedules with the engine's `rearmAll()` (the boot replay would fire bogus catch-ups).
- **Prompt decoration** happens at ONE choke point, `forwardPromptToAgent`: the `[Telegram thread context]`
  preamble (only when it changed), the reply-quote block, the optional `/timestamps` line. Files sent to a
  topic land in `DATA_DIR/files/…` (never inside the project folder); albums are batched into one prompt.
- **Auto-retry on provider errors** (`apiErrorRetry.ts`, `apiRetryKick.ts`): transient → backoff retry;
  usage limit → wait for the reset and resume by itself (`/auto_continue_limits`); auth → never retried,
  surfaced as a pinned logged-out notice. A saved retry record means ARMED; the "continue" nudge goes through
  `deliverPromptOrBuffer`, never a wait-for-idle path; nothing is posted INTO an armed limit wait (scheduled
  runs are held and ride the resume). Detector guards: see `getClaudeAgentErrorLine` /
  `handleAutoLifecycle` (`claudeCliAdapter.ts`); a missed API error leaves no `[Claude] API error detected`
  line in the bot log.
- **Request/answer core** (`src/requests/`). A conversation has at most ONE open request; the agent answers
  through `answer_request` (`progress` / `question` / `final`) and the platform's `AnswerSink` delivers it; a
  wake-up engine re-prods silent turns and alerts when it gives up.
- **Compaction.** `/compact` is bot-owned and per backend (OpenCode: server summarize; json-stream: confirmed
  `/compact` turn; tmux Claude: the literal `/compact`; terminal: unsupported). Compact-on-idle fires after
  ~55 min idle (inside the prompt-cache window); `compact_conversation` arms a compaction that runs when the
  turn ends, never mid-turn. A bot-issued compaction is NARRATED (start notice → completion report → the full
  summary via `postCompactionSummary`, plain text, never through the agent-output path); `/compact_summary`
  toggles the summary post per topic (General → instance default). A backend whose own compaction already
  reaches the topic sets `AgentAdapter.streamsCompactionSummary` (OpenCode) and the bot posts no copy. The
  backends' OWN overflow compaction gets the same summary guidance (name the loaded skills, reload them):
  Claude through a `PreCompact` hook (`utils/claudeCompactHook.ts`, `--settings` file in `DATA_DIR`),
  OpenCode through a bot-installed global plugin (`utils/openCodeCompactPlugin.ts`); at boot
  `activateCompactionPluginForActiveSessions` recreates idle directory instances that lack it BEFORE the
  scheduler-MCP reconcile (recreating drops the runtime MCP registration). A `telegramBot` registration or
  reconcile that fails on OpenCode is retried (`schedulerMcpRetryDelaysMs`), reading `GET /mcp` first.
- **Display prefs.** `/thinking`, `/tool_results`, `/subagent` (+ `/verbosity`) are per-topic rendering prefs
  (`minimal|short|full`), never sent to the agent; only the sub-agent mode is read BY the adapters.

## Module map (`src/`)

| Path | What it is |
|------|------------|
| `cli.ts`, `cli/` | CLI dispatch: `envLoader.ts` (`.env` / `ENV_FILE`), `hot.ts` + `botEntry.ts` (hot supervisor / worker), `bot.ts` (shared startup) |
| `bot.ts` | **The bot**: Telegram handlers, every slash command (on the neutral `commandRouter`), output streaming, composition root; ~14k lines. A test cannot import it (module-scope `parseEnv()` exits the process), so logic goes into pure helpers that `bot.ts` wires |
| `agentLogin/` | `createAgentLogin(ports)`: the out-of-band sign-in drivers — json-stream `/login` and OpenCode `/connect` OAuth, each a pty relayed through the topic. README: contracts |
| `connectors/telegram/commands/` | Slash commands + buttons decomposed out of `bot.ts`, one `create<Feature>(ports)` per file over the shared `BotCore` ports bag (`displayModes.ts`, `reminders.ts`, `modelProviders.ts`, …). README: registration-order and ports contract |
| `state.ts` | `state.json` persistence (bindings, sessions, prefs, schedules, open requests); `resolveDataDir()` |
| `sessionKey.ts`, `types.ts` | `SessionKey` + codec registry; shared types incl. the `AgentAdapter` contract |
| `threadRouting.ts`, `accessControl.ts`, `validation.ts`, `folderName.ts` | Topic → folder binding; who may use the bot (`AdminCache` is the single authority); `/bind` validation (path-traversal/symlink safe, canonical `resolveBoundWorkDir`); new-folder-name gate |
| `mcpConfig.ts`, `i18n.ts`, `i18n/` | MCP hierarchy merge; `t(key, vars)` over 12 locales, `en` canonical |
| `rateLimiter.ts` | Per-user limits, the global send pacer, `enqueueSend` / `sendUnpaced` |
| `apiErrorRetry.ts`, `apiRetryKick.ts` | API-error classification + retry plan; the retry timer, its kick and boot restore |
| `postToSession.ts`, `startupPromptBuffer.ts` | Post a prompt into a conversation's session (ensure/resume, wait for idle, forward); the startup buffer |
| `threadContextPreamble.ts`, `resumeContext.ts`, `pinnedStatus.ts`, `pendingQuestionRepost.ts`, `progressLine.ts` | Thread-context preamble; recent-turns block on resume; pinned status banner; keep a pending question last in its topic; collapse Claude's transient progress shapes into one edited message |
| `openCode*.ts`, `sessionPick.ts`, `effortLevels.ts` | Pure OpenCode helpers (event→session routing, question flow/recovery, titles); the `/sessions` pick; effort catalogs |
| `installManager.ts` | Locate/install agent binaries; OpenCode server generations (launched outside nodemon's tree) |
| `outputTrace.ts`, `diagLog.ts`, `cli/lock.ts`, `shutdown.ts`, `bootClassifier.ts` | Always-on trace (`/trace`) + diagnostic log; single-instance lock; ordered graceful shutdown; hot-reload vs cold-start decision |
| `botFileStorage.ts`, `voiceQueue.ts`, `agentTrigger.ts`, `sendErrorClassifier.ts` | File-intake dirs + janitor; per-thread voice queue; natural-language agent trigger; send-failure classes |
| `adapters/` | Backends behind `AgentAdapter`: `claudeJsonStreamAdapter`, `claudeCliAdapter` (tmux scrape), `openCodeAdapter`, `terminalAdapter`; `createAdapter.ts` (factory + DI hub). README: protocol + traps |
| `connectors/telegram/` | All code that touches the Telegram library: inbound/outbound translation, HTML, splitting, file intake + send gateway, answer sink, pickers, `output/` (`CHAT_MODE` transports) |
| `connectors/test/` | Capability-configurable test double; TESTS ONLY, no production import |
| `platform/` | Core-side seam contracts: inbound/outbound/answer sink, command router, capability fallback |
| `requests/` | Request ledger, `answer_request`, wake-up engine + rules, session turn probe, limit-wait answers |
| `scheduler/` | Schedule store/engine/recurrence/delivery/run ledger; the bot-owned MCP server (`mcpSurface.ts`), its injection and boot order |
| `utils/` | ~85 mostly pure helpers behind `bot.ts` and the adapters: Claude scrape pipeline, tmux primitives, json-stream host, picker/render plans, reminders, timezone, limit/compaction rules, file send |

**Platform boundary.** `platformBoundary.test.ts` fails if a module outside `connectors/telegram/` imports the
Telegram library (its exemption ledger, just `bot.ts`, may only shrink). The core reaches a connector's
answer sink only through `getAnswerSink` by `key.platform`. Details: `src/platform/README.md`.

## Conventions and pitfalls

- **Add a command:** register via the group-gated `command()` wrapper in `bot.ts`; user text in `i18n.ts` —
  add the key to `en.ts` first, then mirror it in EVERY locale; add the name (and aliases) to the
  `botCommands` set, or the `message('text')` handler re-forwards the slash to the agent; branch on the
  thread's adapter if it controls the agent. Agent-facing templates stay English with a baked "IN <language>"
  reply directive.
- **Inline keyboards:** `callback_data` is capped at 64 BYTES, so pickers carry INDEXES (`mdlp_<i>_<page>`,
  `resume_<i>`, …). When an index points into a mutable list, snapshot that list per MESSAGE or bake the
  identity into the data (`acl_skip_<fireAt>`, a wizard id) so an old keyboard can never act on newer
  state. A one-shot setting picker CONSUMES its keyboard (edit into a confirmation, drop the markup); a
  picker meant for repeated use re-renders in place.
- Telegram auto-links a bare `/command` in message text — to point at a setting, name it in prose, don't
  attach a button.
- **tmux:** every call goes through `utils/tmuxExec.ts` (it adds `-L <TMUX_SOCKET_NAME>`), always with an
  EXACT target — `getTmuxSessionTarget` (`=name`) / `getTmuxPaneTarget` (`=name:`). A bare `-t name` falls
  back to a PREFIX match and once killed another topic's session.
- **Claude scrape:** the output bullet is `●` OR `⏺` (newer Claude Code) — match both in any regex that
  anchors on it; shapes live once in `utils/claudeScrapeShapes.ts`. Inspect a live pane with `capture-pane`,
  never `attach` (it resizes the window and tmux re-wraps the scrollback). The end-of-turn feedback survey is
  dismissed by a CLOSED list of known header wordings; an unrecognised one strands the next prompt in the
  input box and the topic looks hung — add the wording.
- **Secrets:** never log or echo a token/key; a pasted secret (`/login` code, `/connect` key) is deleted from
  the topic and redacted from the trace preview.

## Privacy gate — the repo is public

History was scrubbed of real operator identifiers — keep it that way:

- Never commit real instance identifiers (chat/topic/user ids, group names, `t.me/c/…` links, home paths
  with a real username, private project names/remotes, tokens) — in code, tests, docs, plans, or commit
  messages. Quoting live-debug output is the usual leak path: replace ids first.
- Examples use the repo's placeholders (`-1001111111111`, `ExampleGroup`, `/home/user/…`); real values live
  only in untracked `CLAUDE.local.md` / `agent/tmp/`.
- Pre-commit review sweeps the diff for real-looking identifiers — any hit is a FAIL.

## Deployment — only committed `main` ships

After resuming an interrupted session, inspect recent commits and the worktree first; another agent may have
advanced the task. This checkout is the SOURCE other agent accounts on this host mirror: each has its `origin`
pointing here and pulls on a timer via `scripts/self-update.sh`.

- **Only committed `main` propagates.** Anything uncommitted never reaches the mirrors — landing it on `main`
  IS the deploy step.
- The pull is **fast-forward only** and skips a dirty or diverged tree, so a rewritten or force-moved `main`
  silently stalls every mirror until each one is re-pointed by hand.
- Touching a hot-supervisor file (`src/cli.ts`, `src/cli/hot.ts`, `nodemon.json`) makes the mirrors restart
  the whole service (nodemon never reloads the process that spawned it); any other change rides the hot reload.

## Tests & build

- **Run:** `yarn start` (`node dist/cli.js`), or installed: `cd <projects-parent> && telegramcode` (the launch
  directory becomes the work root).
- `yarn typecheck` · `yarn build` (`tsc` → `dist/`) · `yarn test` (node test runner + tsx; needs `dist/` —
  process-level tests spawn the built CLI) · `yarn dev` (`tsx watch`; a TS error crashes it) · `yarn hot` /
  `telegramcode hot` (`tsc -w` + nodemon on `dist/`: a broken edit cannot take the bot down, agents survive
  reloads; Linux/macOS only).
- **tmux safety in tests and by hand.** Run anything that touches tmux as `env -u TMUX -u TMUX_PANE …`. Never
  touch the DEFAULT tmux server: a bare `kill-server` run from inside tmux goes to the server `$TMUX` names,
  whatever `TMUX_TMPDIR` says. A test's own servers are private (`TMUX_SOCKET_NAME` + a `TMUX_TMPDIR` inside
  a temp dir) and are ended only by the FULL socket path (`tmux -S <path> kill-server`). Compare a read-only
  `tmux ls` before and after a suite — a session that disappears is a suite bug.
- **Verifying code you wrote is YOUR job** — run it, drive the real surface; never hand the check to the user.
  If the usual tool is missing, find another path (live OpenCode over HTTP, a real tmux pane, the code path).
- **Output / rendering / relay changes must be verified LIVE** on the dedicated test topic ("Telegram code
  testing", root `111` in group `-1001111111111` — placeholders; real values in untracked `CLAUDE.local.md`)
  through `telegram-mcp` `get_history`, BEFORE the commit — unit tests and review are not enough (these bugs
  show only under real scrape/diff timing). `telegram-mcp` not connected = BLOCKER: say so, don't commit as
  "verified". Touch ONLY that topic. A Bash result still showing `⎿` in the raw text was NOT fenced.
  A pasted `t.me/c/<id>/…` link decodes directly: `chat_id` = `-100<id>`; the last segment is the
  `message_id`, a middle one (three segments) the topic root id.
- **"A message never reached the user":** the hourly `DATA_DIR/output-trace-*.jsonl` buckets (ON by default;
  stdout is also tee'd to `bot-console-*.log`) are the source of truth. Follow `recv` → `emit` → `sendTry` →
  `sendOk` / `sendErr`: no `emit` = lost in the adapter; `emit` without `sendTry` = lost in the send path;
  `sendErr` 429 = rate-limited; `sendOk` but absent in `get_history` = spilled onto another message.
  `editMessageText` records carry NO thread id — never filter the trace by thread key alone.
- **OpenCode:** `Invalid authentication credentials` → restart the `opencode serve` process (stale provider
  credentials). Prove a per-prompt override (model or `/effort` variant) applied with
  `GET /session/<id>/message` — the stored turns echo `model.variant`.
