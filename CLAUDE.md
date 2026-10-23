# Charness — agent guide

> **Keep this file a short map. Module behaviour goes to the module's `README.md`; do not add per-change notes here.**

> User-facing behaviour (commands, env vars, features) is in the public `README.md`, the architecture diagram in
> `DEVELOPMENT.md`, per-function detail in the code's own comments and tests.

> **Naming:** the product in prose is **Charness** (formerly TelegramCode; the repository is
> `olosegres/charness`; the npm package is **`charness`** since 3.0.0, up to 2.0.3 it was `telegramcode`). The CLI
> command is **`charness`** (`telegramcode` and the legacy `telegramCode` stay as bin aliases), the config
> `~/.config/charness/.env`, the default `DATA_DIR` `~/.charness`, the env vars `CHARNESS_*`, the Docker names
> `charness` / `/opt/charness` / `charness-restart-bot`. Use the new names in code, docs and messages. The old names
> (`~/.config/telegramcode`, `~/.telegramCode`, `TELEGRAMCODE_*`, `x-telegramcode-mcp-client-id`, the
> `telegramcode-compaction` plugin, the `telegramcode` image) survive ONLY as read-fallbacks in
> `src/legacyNames.ts` (+ the plugin / MCP header code and `docker/entrypoint.sh`) because instances hot-reload
> `main`: new wins, old is the fallback, set BOTH where a child may run old code, announce a fallback once with
> `[deprecated] <old> is deprecated, rename it to <new> (see MIGRATION_RENAME_TO_CHARNESS.md)`. The config and
> default data dirs are moved at a COLD start by `src/legacyMigration.ts` (symlink left behind, under the lock,
> never on a hot worker reload). A further rename follows the same pattern and ships its own migration guide.

## What this project is

A Telegram **forum-supergroup bot that proxies user commands and messages to agentic CLIs** — **Claude Code**
and **OpenCode** (plus a raw `$SHELL`). The bot has almost no "AI" logic: routing, session lifecycle,
translating chat input into the right call to the agent, and streaming the output back into the topic. The
same core serves a second surface — Jira issues (`CONNECTORS=jira`) — through the connector seam.

**Core mental model — the bot is a proxy/relay.** Most commands are *forwarded* to the agent:

- **Claude Code, three backends** (they share the on-disk transcript; `/claude_mode` switches a topic between
  them). `claude-json-stream` (DEFAULT) drives `claude -p` over stream-json as an EXTERNAL tmux-hosted process
  (FIFO stdin, tailed `stdout.jsonl`), stopped at the idle mark (`AGENT_IDLE_MINUTES`, 55 min); `claude-per-turn`
  is the same host stopped after every turn. A stopped conversation SLEEPS (id kept) and the next trigger resumes
  it through `ensureAgentSession`; a process is never stopped while it works (`checkIsWorking`), and only a CLI
  ≥ 2.1.287 is auto-stopped (`claudeCodeVersion.ts`). `claude` (tmux-scrape) drives the interactive TUI with
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
  EXTERNAL and re-adopted at boot (json-stream replays the downtime tail from a persisted offset; a json-stream
  process that is gone is NOT re-spawned — the conversation sleeps and its next trigger resumes it; an adopted
  process with a stale bot-MCP tool list is stopped at its next idle point); OpenCode
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
  `send_file_to_user`, `send_messages_to_user` (a non-Telegram session sees only `answer_request` +
  `compact_conversation`, plus `jira_get_attachment` for a Jira one). It is bot plumbing, separate from the user-editable MCP hierarchy (mostly dormant,
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
  usage limit → wait for the reset and resume by itself (`/limits_autoswitch`, the wait setting); auth → never retried,
  surfaced as a pinned logged-out notice. A saved retry record means ARMED; the "continue" nudge goes through
  `deliverPromptOrBuffer`, never a wait-for-idle path; nothing is posted INTO an armed limit wait (scheduled
  runs are held and ride the resume). Detector guards: see `getClaudeAgentErrorLine` /
  `handleAutoLifecycle` (`claudeCliAdapter.ts`); a missed API error leaves no `[Claude] API error detected`
  line in the bot log.
- **Request/answer core** (`src/requests/`). A conversation has at most ONE open request PER REQUESTER (a
  newer message supersedes only the same person's open request — `requestGroup.ts`); the agent answers
  through `answer_request` (`progress` / `question` / `final`) and the platform's `AnswerSink` delivers it; a
  wake-up engine re-prods silent turns and alerts when it gives up.
- **Compaction.** `/compact` is bot-owned and per backend (OpenCode: server summarize; json-stream: confirmed
  `/compact` turn; tmux Claude: the literal `/compact`; terminal: unsupported). Compact-on-idle fires after
  ~55 min idle (inside the prompt-cache window); `compact_conversation` arms a compaction that runs when the
  turn ends, never mid-turn. A bot-issued compaction is NARRATED (start notice → completion report → the full
  summary via `postCompactionSummary`, plain text, never through the agent-output path); `/compact_summary`
  toggles the summary post per topic (General → instance default; OFF by default, also on the `/compact_on_idle`
  picker), so by default a compaction ends in one short line. A backend whose own compaction already
  reaches the topic sets `AgentAdapter.streamsCompactionSummary` (OpenCode) and the bot posts no copy;
  that streamed summary is tagged `OutboundHints.isCompactionSummary` and obeys the same switch. The
  backends' OWN overflow compaction gets the same summary guidance (name the loaded skills, reload them):
  Claude through a `PreCompact` hook (`utils/claudeCompactHook.ts`, `--settings` file in `DATA_DIR`),
  OpenCode through a bot-installed global plugin (`utils/openCodeCompactPlugin.ts`); at boot
  `activateCompactionPluginForActiveSessions` recreates idle directory instances that lack it BEFORE the
  scheduler-MCP reconcile (recreating drops the runtime MCP registration). A `telegramBot` registration or
  reconcile that fails on OpenCode is retried (`schedulerMcpRetryDelaysMs`), reading `GET /mcp` first.
- **Claude account profiles** (`/accounts` — also the OpenCode providers' switch / connect / disconnect entry; hidden aliases `/account`, `/connect`, `/disconnect`; `utils/claudeProfiles.ts`, `commands/claudeAccounts.ts`). Several
  subscription logins kept side by side: a profile is a config directory under `DATA_DIR/claude-profiles/<name>/`
  handed to the CLI through `CLAUDE_CONFIG_DIR` at EVERY spawn (the `ClaudeConfigDirReader` seam in
  `createAdapter.ts`), with `projects/`, settings, skills, plugins and the user memory symlinked back into
  `~/.claude`; `default` IS `~/.claude`. Instance default from General + per-topic override (state.json, resolver
  in the utils module). Never switch an account by swapping files under `~/.claude` — the CLI re-reads them live
  and every running session would change at once; a live switch is the `/model` re-spawn, deferred while the
  process works. Per-profile USAGE (`utils/claudeUsage.ts`, `claudeUsageRefresher.ts`): the OAuth usage
  endpoint with each profile's own token (expired token ⇒ stale mark, never refreshed by the bot) plus the
  json-stream `rate_limit_event` frames, cached on the record (`default` has a hidden one); shown under each
  `/accounts` row and on the `/limits` board, served to agents by the `claude_profiles` MCP tool and `charness claude-profiles`. A usage
  LIMIT on a Claude topic (`utils/claudeLimitSwitch.ts`, wired in `handleApiError` →
  `announceUsageLimitOrSwitch`): the limited profile gets `limitedUntil`, the ranking names the other
  signed-in profiles with fresh usage and room — the implicit chain when the `/limits_autoswitch` chain is empty.
- **Usage limits / fallback chain** (`/limits_autoswitch`, hidden aliases `/fallback` and `/auto_continue_limits`, `utils/fallbackChain.ts`, `commands/fallbackChain.ts`): ONE instance-wide
  priority list of `{claude, profile, model|null}` / `{opencode, providerId, modelId}` rungs in `state.json`
  (`fallbackChain`), drafted from what is detected (`detectFallbackOptions`: profile views + the OpenCode catalog
  + the recent `/model` picks) and edited from any topic with revision-baked buttons (`fbk_*`). `planFallbackSwitch`
  (from `handleApiError` → `announceUsageLimitOrSwitch`) marks the limited rung (`limitedUntil` /
  `openCodeModelLimits`) and takes the first AVAILABLE rung in chain order; a rung with `disabled: true` is never a candidate (a rebuild keeps it so); auto-switch ON (a `/limits_autoswitch`
  setting, OFF by default; the wait setting beside it is the old `/auto_continue_limits` pair, a topic's three states are on / off / as General) switches by itself, OFF puts
  `fbsw_<episode>_<index>` buttons on the notice (indexes into that episode's remembered candidates); no
  candidate ⇒ the wait — aimed, when every enabled rung incl. the current one is limited, at the rung whose limit resets
  EARLIEST (`pickEarliestResetRung`, `retargetLimitWait`): the persisted retry record carries `resumeOn`, and the kick
  runs `switchTopicToFallbackEntry` onto it before the continue nudge. The list is edited from every topic. `switchTopicToFallbackEntry`: within a backend the conversation is kept
  (profile apply re-spawn / OpenCode `setModel`), across backends it is the `switchThreadAdapter` path — the
  leaving family's session id is PARKED (`parkedSessions`, restored on the way back, released with the ids) and
  the first prompt is the context bridge (`utils/fallbackBridge.ts`: the old adapter's `getRecentTurns`) instead
  of the continue nudge; both end in `cancelApiRetry` → `deliverPromptOrBuffer`. Never switched back by itself.
  OpenCode quota codes (`insufficient_quota`, a `RESOURCE_EXHAUSTED` that names a day/week/month quota, …) classify as
  `usageLimit` ahead of the 429 transient branch; a short-window throttle (per minute, concurrency, a stated reset within
  ~5 min, a bare `RESOURCE_EXHAUSTED`) is `transient`, and the wording alone of Anthropic's "would exceed your account's
  rate limit" is probed first (`apiErrorRetry.ts`).
- **`/limits` is the switch board** (`commands/limitsBoard.ts`, rows and labels in `utils/limitsBoardPlan.ts`): one name-only button
  (`[✓ ]Claude · work`) per signed-in Claude account and connected OpenCode provider, the usage in the MESSAGE (`formatLimitsUsageBlock`: the `/accounts`
  wording via the one `formatClaudeProfileUsageLines`, plus the ChatGPT subscription) — no figure fits a phone's button; the limit notice ends `Switch: /limits`. EVERY operator pick —
  a board or `/accounts` row, a model page, `/accounts use` — takes ONE path, `switchTopicByOperator` (`bot.ts`, the move decided by
  `utils/operatorSwitchPlan.ts`): a wait armed ⇒ the limit move (`switchTopicToFallbackEntry`; also a model of the SAME Claude account that the limit's exhausted
  window does not cover — `checkIsClaudeModelClearOfLimit`; a pick inside the limit only changes the model); the backend the topic runs ⇒ an account change
  or the `/model` apply (a model named for the account it already runs does NOT pin an account pick); the other backend ⇒ the hand-over question
  (`backendSwitch.ts`, naming the model, which `executeBackendSwitch` pins) or the switch at once. The model list is the shared
  `commands/modelPage.ts` (`/model`, the add step, the board and `/accounts` provider pages feed it their own callbacks). OpenCode usage:
  `utils/openCodeUsage.ts` reads the ChatGPT subscription's windows (an `oauth` record for `openai` in OpenCode's `auth.json`; the token is
  never refreshed or logged) into `state.openCodeProviderUsage`, polled with the Claude profiles; a failed read is a row without figures,
  never an error report.
- **Display prefs.** `/thinking`, `/tool_results`, `/subagent` (+ `/verbosity`) are per-topic rendering prefs
  (`minimal|short|full`), never sent to the agent; only the sub-agent mode is read BY the adapters.
- **Jira connector** (`src/connectors/jira/`). One issue = one conversation (`jira:<PROJECT>:<ISSUE-KEY>`);
  the agent talks back only through `answer_request`, which becomes comments. Isolation is FAIL-CLOSED and
  checked at boot (`cli/connectorGuards.ts`); an instance never boots on another platform's state; errors name
  variables and fields, never secret values; Jira code loads lazily — nothing `bot.ts` imports statically may
  reach its packages (`jiraLazyLoad.test.ts`).

## Module map (`src/`)

| Path | What it is |
|------|------------|
| `cli.ts`, `cli/` | CLI dispatch: `envLoader.ts` (`.env` / `ENV_FILE`), `connectorGuards.ts` (fail-closed isolation preflight), `hot.ts` + `botEntry.ts` (hot supervisor / worker), `bot.ts` (shared startup) |
| `bot.ts` | **The bot**: Telegram handlers, every slash command (on the neutral `commandRouter`), output streaming, composition root; ~11k lines (feature slices are moving out into the modules below). A test cannot import it (module-scope `parseEnv()` exits the process), so logic goes into pure helpers that `bot.ts` wires |
| `agentLogin/` | `createAgentLogin(ports)`: the out-of-band sign-in drivers — json-stream `/login` and OpenCode `/connect` OAuth, each a pty relayed through the topic. README: contracts |
| `connectors/telegram/commands/` | Slash commands + buttons decomposed out of `bot.ts`, one `create<Feature>(ports)` per file over the shared `BotCore` ports bag (`displayModes.ts`, `reminders.ts`, `modelProviders.ts`, `compaction.ts`, `autoContinueLimits.ts`, `stt.ts`, …). README: registration-order and ports contract |
| `state.ts` | `state.json` persistence (bindings, sessions, prefs, schedules, open requests); `resolveDataDir()` |
| `sessionKey.ts`, `types.ts` | `SessionKey` + codec registry; shared types incl. the `AgentAdapter` contract |
| `threadRouting.ts`, `accessControl.ts`, `validation.ts`, `folderName.ts` | Topic → folder binding; who may use the bot (`AdminCache` is the single authority); `/bind` validation (path-traversal/symlink safe, canonical `resolveBoundWorkDir`); new-folder-name gate |
| `mcpConfig.ts`, `i18n.ts`, `i18n/` | MCP hierarchy merge (non-Telegram sessions get `--strict-mcp-config`); `t(key, vars)` over 12 locales, `en` canonical |
| `rateLimiter.ts` | Per-user limits, the global send pacer, `enqueueSend` / `sendUnpaced` (both refuse a foreign-platform key) |
| `apiErrorRetry.ts`, `apiRetryKick.ts` | API-error classification + retry plan; the retry timer, its kick and boot restore |
| `postToSession.ts`, `startupPromptBuffer.ts` | Post a prompt into a conversation's session (ensure/resume, wait for idle, forward); the startup buffer |
| `threadContextPreamble.ts`, `resumeContext.ts`, `pinnedStatus.ts`, `pendingQuestionRepost.ts`, `progressLine.ts` | Thread-context preamble; recent-turns block on resume; pinned status banner; keep a pending question last in its topic; collapse Claude's transient progress shapes into one edited message |
| `openCode*.ts`, `sessionPick.ts`, `effortLevels.ts` | Pure OpenCode helpers (event→session routing, question flow/recovery, titles); the `/sessions` pick; effort catalogs |
| `installManager.ts` | Locate/install agent binaries; OpenCode server generations (launched outside nodemon's tree) |
| `instanceSettings.ts` | `settings.json` (instance-wide settings, first field `defaultEffort`, set by `/effort` in General) on `configDirFile.ts`; `effortLevels.ts` holds the resolver (`getInstanceDefaultEffort`: file → code fallback `medium`) the adapters call |
| `configDirFile.ts` | The shared mechanics of the JSON files in the config dir (`stt.json`, `settings.json`): location beside the REAL `.env`, stamp-cached load, atomic save, the unwritable / container-disk checks |
| `outputTrace.ts`, `diagLog.ts`, `instanceLock.ts`, `shutdown.ts`, `bootClassifier.ts` | Always-on trace (`/trace`) + diagnostic log; single-instance lock; ordered graceful shutdown; hot-reload vs cold-start decision |
| `stt/` | Voice recognition: `stt.json` settings (UI-first, one source of truth), the engine chain with fallback and a timeout proportional to the voice, the local GigaAM engine's installer; its Python sidecar is `stt/gigaam_sidecar.py` at the package root (shipped in `files`). README: contracts and the sidecar protocol |
| `botFileStorage.ts`, `voiceQueue.ts`, `agentTrigger.ts`, `sendErrorClassifier.ts` | File-intake dirs + janitor; per-thread voice queue; natural-language agent trigger; send-failure classes |
| `adapters/` | Backends behind `AgentAdapter`: `claudeJsonStreamAdapter`, `claudeCliAdapter` (tmux scrape), `openCodeAdapter`, `terminalAdapter`; `createAdapter.ts` (factory + DI hub), `adapterEventRouting.ts` (foreign-platform event gate), `claudePlatformFlags.ts`, `sessionLaunchDefaults.ts`. README: protocol + traps |
| `connectors/telegram/` | All code that touches the Telegram library: inbound/outbound translation, HTML, splitting, file intake + send gateway, answer sink, pickers, call guard, `output/` (`CHAT_MODE` transports) |
| `connectors/jira/` | Jira Cloud connector: config, REST client, poller, trigger rules, prompt, answer sink, ADF |
| `connectors/test/` | Capability-configurable test double; TESTS ONLY, no production import |
| `platform/` | Core-side seam contracts: inbound/outbound/answer sink, command router, capability fallback, `CONNECTORS` filter, unserved-state guard |
| `requests/` | Request ledger, `answer_request`, wake-up engine + rules, session turn probe, limit-wait answers |
| `scheduler/` | Schedule store/engine/recurrence/delivery/run ledger; the bot-owned MCP server (`mcpSurface.ts`), its injection and boot order |
| `utils/` | ~85 mostly pure helpers behind `bot.ts` and the adapters: Claude scrape pipeline, tmux primitives, json-stream host, picker/render plans, reminders, timezone, limit/compaction rules, file send |

**Platform boundary.** `platformBoundary.test.ts` fails if a module outside `connectors/telegram/` imports the
Telegram library (its exemption ledger, just `bot.ts`, may only shrink). The core reaches a connector only
through `getConnectorOutbound` / `getAnswerSink` by `key.platform`, and a Telegram I/O primitive in `bot.ts`
must guard against a foreign (Jira) key. Details: `src/platform/README.md`.

## Conventions and pitfalls

- **Add a command:** register via the group-gated `command()` wrapper in `bot.ts`; user text in `i18n.ts` —
  add the key to `en.ts` first, then mirror it in EVERY locale; add the name (and aliases) to the
  `botCommands` set, or the `message('text')` handler re-forwards the slash to the agent; branch on the
  thread's adapter if it controls the agent. Agent-facing templates stay English with a baked "IN <language>"
  reply directive.
- **Settings live in the JSON config, not in env:** a setting the bot does not need before it can start goes
  into `settings.json` (`instanceSettings.ts`) and is changed from Telegram — never a new `CHARNESS_*` env var,
  not even as an override. `.env` holds only what startup itself needs (bot token, paths, `DATA_DIR`).
- **CHANGELOG:** every commit with a user-visible change adds an entry under `## Unreleased` in
  `CHANGELOG.md`, starting with a **bold first sentence** that reads on its own — it becomes the item in the
  release notes and in the "what's new" message users get after an update. Pre-commit review FAILS a
  user-visible change without its entry.
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
- Examples use the repo's placeholders (`-1001111111111`, `ExampleGroup`, `/home/user/…`); real values never
  enter the repo.
- A real-looking identifier anywhere in a diff is a defect.

## Tests & build

- **Run:** `yarn start` (`node dist/cli.js`), or installed: `cd <projects-parent> && charness` (the launch
  directory becomes the work root).
- **The whole bot in Docker:** `docker/` (image, entrypoint with the hot-mode restart loop, `charness-restart-bot`,
  test image); the container runs as root, which is why the agent allowlist carries `IS_SANDBOX`. SETUP.md § Run with Docker.
- `yarn typecheck` (strict `tsc` over ALL of `src/`, test code included, via `tsconfig.typecheck.json` — tests run
  through `tsx`, which checks no types) · `yarn build` (`tsc` → `dist/` from `tsconfig.json`, which leaves
  `src/__tests__` out) · `yarn test` (= `test:unit` then `test:flows`, node test runner + tsx; needs `dist/` — process-level tests spawn the built CLI; Node applies `--test-timeout` to a
  whole FILE — 2 min for a unit file, 20 min for a `*E2e.test.ts` flow, whose own budget is that limit less its
  teardown (`getFlowDeadlineMs`) — so a hung or process-leaking file fails by name instead of hanging the run) ·
  `yarn dev` (`tsx watch`; a TS error crashes it) · `yarn hot` / `charness hot` (`tsc -w` + nodemon on
  `dist/`: a broken edit cannot take the bot down, agents survive reloads; Linux/macOS only). Hot mode reloads
  only the worker: a change to a supervisor file (`src/cli.ts`, `src/cli/hot.ts`, `nodemon.json`) needs a full
  service restart, because nodemon never reloads the process that spawned it.
- **Releases:** `.github/workflows/publish.yml` publishes to npm daily (09:17 Asia/Tbilisi), after the FULL `yarn test`;
  a change users see needs its CHANGELOG entry under `## Unreleased` opening with a bold first sentence, or the run
  fails. Rules, manual dispatch and the `npm version` path: DEVELOPMENT.md § Releases; the planner is `src/release/`.
- **tmux safety in tests and by hand.** Run anything that touches tmux as `env -u TMUX -u TMUX_PANE …`. Never
  touch the DEFAULT tmux server: a bare `kill-server` run from inside tmux goes to the server `$TMUX` names,
  whatever `TMUX_TMPDIR` says. A test's own servers are private (`TMUX_SOCKET_NAME` + a `TMUX_TMPDIR` inside
  a temp dir) and are ended only by the FULL socket path (`tmux -S <path> kill-server`). Compare a read-only
  `tmux ls` before and after a suite — a session that disappears is a suite bug.
- **Tests and agents run with a private `TMUX_TMPDIR`** — the default tmux server may host a live bot's sessions.
- **A guard that protects real state** (processes, tmux servers, files, accounts) is proven load-bearing only against
  a decoy the test itself creates — never by disabling it while the guarded action can reach the real thing.
- `jiraConnectorE2e.test.ts` (~7 min, part of `yarn test`) boots a real Jira-only instance through
  `scripts/run-isolated.sh` (`env -i`, temp HOME/`DATA_DIR`/`WORK_ROOT`, private tmux socket, own OpenCode
  and MCP ports) against `jiraE2e/fakeJira.ts` and `fakeClaude.ts`; cleanup runs from `after` and on
  exit/signal. `live/jiraLive.test.ts` (~14 min, not part of `yarn test`) runs the same loop against a REAL Jira
  Cloud site and a real Claude agent and is SKIPPED unless `JIRA_LIVE_ENV_FILE`, `JIRA_LIVE_SITE` and
  `JIRA_LIVE_REQUESTER_STORAGE_STATE` are set — don't set them unless asked; run it directly
  (`node --import tsx --test src/__tests__/live/jiraLive.test.ts`) with `TMUX` / `TMUX_PANE` unset.
- **"A message never reached the user":** the hourly `DATA_DIR/output-trace-*.jsonl` buckets (ON by default;
  stdout is also tee'd to `bot-console-*.log`) are the source of truth. Follow `recv` → `emit` → `sendTry` →
  `sendOk` / `sendErr`: no `emit` = lost in the adapter; `emit` without `sendTry` = lost in the send path;
  `sendErr` 429 = rate-limited; `sendOk` but absent in `get_history` = spilled onto another message.
  `editMessageText` records carry NO thread id — never filter the trace by thread key alone.
- **OpenCode:** `Invalid authentication credentials` → restart the `opencode serve` process (stale provider
  credentials). Prove a per-prompt override (model or `/effort` variant) applied with
  `GET /session/<id>/message` — the stored turns echo `model.variant`.
