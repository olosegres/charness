# Changelog

## Unreleased

**`/limits` is a switch board: every account and provider with its usage, one tap to move the topic.** It lists each
signed-in Claude account and each connected OpenCode provider as one button — `✓ Claude · work · opus — 5h 5% · week 78%`,
`Claude · default — ⛔ until Sun 01:00`, `OpenCode · openai — 5h 12% · week 40%` — and a tap switches this topic: another
account (model and conversation kept), an OpenCode provider (its model page opens; the same OpenCode session just changes the
model), the ✓ row (change the model of where the topic runs). Across backends with a conversation to hand over it asks first;
while a usage-limit wait is armed the tap is the limit move (on the limited Claude account a model the limit does not cover — `opus` under a Fable-only weekly limit — continues the work too). The usage-limit notice now ends «The limit resets <time>.
Switch: /limits». In General a Claude row sets the default account.

**The fallback setup is its own screen, `/limits_autoswitch`.** The ordered fallback list, «🔁 Auto switch» and «⏳ Wait for
reset» moved there from the old `/limits` (minus the usage block); its rows now read `✓ 1. Claude · work · opus` /
`3. OpenCode · openai · gpt-5`. `/limits rebuild|clear|switch|wait …`, `/fallback` and `/auto_continue_limits` keep working.

**`/accounts` tells the truth about OpenCode.** Its title and ✓ say where the topic really runs (`OpenCode openai/gpt-5`),
an OpenCode provider row switches the topic to that provider through the model page (`/accounts use <provider>/<model>` is
the typed form), and a provider signed in with a ChatGPT subscription shows its ~5 h / ~7 d usage windows like a Claude account.

**A default reasoning effort for the whole instance: `/effort` in General.** New sessions no longer start on `xhigh`
in every topic that never picked a level: the default is `medium`, and the General topic's `/effort` sets it for all
topics at once (saved in `settings.json`, see [SETUP.md § Instance settings](SETUP.md#instance-settings-settingsjson)).
A topic's own `/effort` pick still wins, and «As in General» in a topic gives it up again.

**Voice recognition: one settings file, `/stt`, and a recogniser that runs on your machine.** The speech engines
(Groq, OpenAI, any OpenAI-compatible server, and the local GigaAM v3) are an ordered list in `stt.json`, edited from
`/stt` or by hand. Details: [SETUP.md § Voice input](SETUP.md#voice-input).

**A shorter notice when a usage limit moves a topic to another account or model.** One line now says which account
(or OpenCode model) hit its limit, where the topic continues — its model only when the switch changes it — when the
limit resets, and `/limits` to switch, instead of repeating every label and listing four commands.

**Switching a topic between Claude and OpenCode by hand now asks first, and a Claude account tapped in `/accounts` on an
OpenCode topic really switches.** `/claude`, `/opencode` (and the agent buttons / «start …» phrases) on a topic that
runs the other backend, and a Claude account picked in `/accounts` (`/accounts use <name>`) on an OpenCode topic —
which only recorded the pick before — ask «Switch this topic from OpenCode to Claude «work»? The conversation context
will be handed over in compacted form.» with ✅ Continue / ✖️ Cancel when there is a conversation to hand over; Continue
moves the topic the way a usage limit does (the other backend's parked conversation is resumed, the context bridge is the
first prompt), Cancel changes nothing, and a topic with nothing to hand over switches at once. `/limits_autoswitch` asks
the same way before a rung of a backend the list does not use yet is added or included again.

### Upgrading
- **`/limits` is a different screen now.** The fallback list and the two settings are in `/limits_autoswitch`; `/limits`
  is the switch board. Old buttons on an old `/limits` message keep working and re-render that message as
  `/limits_autoswitch`; the text forms (`/limits rebuild`, `/limits switch on`, …) keep working too. A bot menu entry for
  `/limits_autoswitch` is added at the next start.
- **A new outgoing request.** When OpenCode holds a ChatGPT subscription login for the `openai` provider, the bot reads
  its usage windows with the stored token from `https://chatgpt.com/backend-api/wham/usage` (every 10 minutes and when
  `/limits` or `/accounts` opens). The token is never refreshed or logged; an API-key provider triggers no request.
- **The default effort is `medium` now (it was `xhigh`).** Topics with no `/effort` pick of their own start their next
  session on `medium`; running sessions keep their level. To get the old behaviour back, pick `xhigh` in General's
  `/effort` (or write `{ "defaultEffort": "xhigh" }` into `settings.json` beside your env file).
- **`GROQ_API_KEY` / `OPENAI_API_KEY` move out of the env file.** At the first start without a `stt.json` the bot
  copies them into it (Groq first) and logs a `[deprecated]` line; from then on the env keys are ignored. Use `/stt`
  or edit `stt.json`, and delete the keys from the env file when convenient.
- **`stt.json` lives beside your real env file** (a symlinked `.env` is resolved: it goes next to the target). That
  directory must be writable and survive restarts.
- **Docker: mount the config DIRECTORY, not only the env file.** `examples/docker-compose.yml` now takes
  `INSTANCE_CONFIG_DIR` (the directory that holds the env file) in place of `INSTANCE_ENV_FILE`: move the env file into
  a directory of its own, e.g. `/srv/charness/config/instance.env`, mount that directory writable and point `ENV_FILE`
  at the file inside it (`docker run` form: SETUP.md § Run with Docker). With the old single-file mount `stt.json` lands
  on the container's own disk: it is lost whenever the container is re-created, and the old keys are copied in again each
  time. The bot warns at boot when it runs in a container and `stt.json` is not on a mount (`[STT] … is on this
  container's own disk`), and when the directory cannot be written at all. The local engine itself is not available in
  the Docker image yet (no `python3-venv`).

### Added
- **`/effort` in General** sets the instance default; **`/effort` in a topic** shows where its level comes from and
  offers «As in General». `/status`, the ready notice and the pinned banner show the level a topic's session really runs —
  after a General change a running session keeps its level, shown as «xhigh (medium from the next start)». OpenCode
  rounds General's value to the model's variants (`ultracode` = its highest, `auto` = no variant).
  The default lives in `settings.json` (beside `stt.json`), hand-editable without a restart.
- **`/stt`**: the main screen is the engine list, «➕ Add engine» and the language; each engine has a card (order, use /
  don't use, timeout, and a key for the hosted ones); Groq, OpenAI and a custom server are added through «➕ Add engine».
  A pasted key or an address with a login is deleted from the topic at once and kept out of the logs and the output trace.
- **Local recognition (GigaAM v3, Russian):** a recogniser process that starts with the first voice that needs it,
  survives hot reloads, stops after idle time and with its owner, and falls back to the next engine on any failure.
  It is added through «➕ Add engine» like any other (a confirmation and a live install progress when the model is not
  installed), and everything local-specific — status, idle exit, workers, try again after failed starts, remove from list,
  remove the model files — is on its own card, not on the main screen; the cloud engines' cards show only the common
  controls and their key or address. Memory: about 0.5 GB while it runs, up to about 0.9 GB on a long voice.

### Fixed
- A voice note whose Telegram `duration` is 0 (a sender that gave no length) is treated as of unknown length, not as a
  0-second voice: it gets the same time budget as a voice without a length, so a long one no longer falls back to the
  next engine at the bare base timeout.
- Going from Claude to OpenCode and back (`/opencode` then `/claude`, a usage-limit switch to an OpenCode model and back) resumes
  the Claude conversation the topic left; it used to come back to a fresh one, because leaving OpenCode overwrote the
  parked Claude conversation id with the OpenCode session's. The same holds the other way round.
- A Claude json-stream session re-attached after a bot restart keeps its model (a `/model` pick, or Jira's configured
  one) when it is re-spawned for an effort or account change; it used to restart on Claude's default model.
- An OpenCode model that has no effort levels shows none: `/status`, the pinned banner and the ready notice no longer
  name General's default for a session that runs without any level (`/effort` already said «not available»).

## 3.2.0 — 2026-10-16

**Renamed: what was left under the TelegramCode name is now Charness.** The old names still work and each one
in use prints a `[deprecated]` line at start — rename them when you see it. Steps for an npm install, a source
checkout with self-update and Docker: [MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md).

### Breaking / renamed
- **`charness` is the command in every message, help text and document.** `telegramcode` and `telegramCode`
  stay as aliases.
- **Global config: `~/.config/charness/.env`** (was `~/.config/telegramcode/.env`; the older
  `~/.config/telegram-code` too). Moved by the automatic migration below; by hand:
  `mv ~/.config/telegramcode ~/.config/charness`.
- **Default data dir: `~/.charness`** (was `~/.telegramCode`). An existing `~/.telegramCode` is kept while
  `~/.charness` does not exist; an explicit `DATA_DIR` is untouched. Moved by the automatic migration below; by
  hand, with the bot stopped and no agent running — or set `DATA_DIR` to the old path to keep it.
- **Hot-mode variables: `CHARNESS_HOT_RELOAD`, `CHARNESS_OPENCODE_PROCESS_FILE`** (were `TELEGRAMCODE_HOT_RELOAD`,
  `TELEGRAMCODE_OPENCODE_PROCESS_FILE`). The supervisor sets both; restart `charness hot` once after the update.
- **MCP client-id header: `x-charness-mcp-client-id`** (was `x-telegramcode-mcp-client-id`); the server accepts
  both.
- **OpenCode compaction plugin: `charness-compaction.js`** (was `telegramcode-compaction.js`); the old file is
  removed when the new one is installed.
- **Docker: image, service and container `charness`, `charness-main`**; mounts `/opt/charness`,
  `/home/charness`; restart command `charness-restart-bot`; compose variables `CHARNESS_DATA_DIR`,
  `CHARNESS_WORK_ROOT`. A running container of the old image is not affected; the new entrypoint accepts the old
  mount points and `telegramcode-restart-bot` still works.

### Added
- **Automatic migration at a cold start.** The bot moves `~/.config/telegramcode` (or the older
  `~/.config/telegram-code`) to `~/.config/charness` and the default `~/.telegramCode` to `~/.charness`, leaves a
  relative symlink at each old path (running agents and scripts keep working), renames `TELEGRAMCODE_*` keys to
  `CHARNESS_*` in the config file it moved (the original kept as `.env.bak`) and logs one `[migrate]` line per
  action. It runs under the instance lock before the state is loaded, only on the plain start and the hot
  supervisor's start (never on a worker reload), never for an explicit `DATA_DIR` or an `ENV_FILE` instance,
  and is idempotent. Details: [MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md#automatic-migration).
- `scripts/self-update.sh` names a newly added `MIGRATION_*.md` in its log.
- **Jira: an @-mention of the AI account in a comment wakes it to answer**, without the issue being handed over:
  it reads and checks, changes nothing, and its answer is a comment. On with a `trustedGroup` (only a trusted
  author and last editor count); `wakeOnMention: false` turns it off. See SETUP.md § Jira.
- **Jira: an answer notifies the person it is for** — it @-mentions the requester of a mention and the authors
  of the comments it replies to.
- **Answers are written briefly, in plain words, for a manager or QA** — on Jira issues and in Telegram topics
  alike.

### Changed
- Jira: a hand-over is noticed within 30 s by default (`pollIntervalSeconds` default 30, was 90).

### Fixed
- Jira: a mention no longer displaces a hand-over without a requester, and a superseded question no longer asks
  to assign the issue back.
- A Claude session adopted under the old data-dir path is no longer re-spawned as another account.

## 3.0.0 — 2026-10-07

**Published as `charness`.** The npm package is renamed from `telegramcode` to
`charness`, after the project. To move over:
`npm uninstall -g telegramcode && npm install -g charness`. The `telegramcode`
command, the `~/.config/telegramcode` config, the `~/.telegramCode` data dir and
the `TELEGRAMCODE_*` variables stay as they were, so an existing setup carries
over unchanged; `charness` is a new alias of the command.

### Added
- **Requests and answers.** A message, a voice note or a scheduled run opens a
  request; the agent answers it with the `answer_request` tool (progress,
  question or final), and every answer is pinned in the topic (only the latest
  stays pinned). An agent that ends its turn without answering is woken, and
  the operator is alerted when waking gives up. A usage-limit stop answers the
  open request.
- **`/verbosity` views**: Stream only, Stream + answers, Answers only. In
  Answers only, an agent that keeps writing after its final answer is reminded
  to send whatever matters.
- **Sleeping Claude conversations.** An idle json-stream conversation is
  compacted and its process stopped; the next message resumes it. A third
  Claude backend, per-turn, stops the process after every turn.
- **Compaction**: `/compact` on every agent backend, compaction on idle, the
  agent's own `compact_conversation` tool, and the summary posted to the topic
  on request (`/compact_summary`, off by default). Every compaction summary
  names the skills to load again.
- **Usage limits**: wait for the reset and resume by itself
  (`/auto_continue_limits`).
- **`/reminders`**: reminders the bot posts and pins itself, without an agent.
- **Watchdog checks**: `schedule_create` with a `checkCommand` runs a check on
  schedule and wakes the agent on the first failure.
- **`/timezone`**: one instance-wide time zone for schedules and timestamps.
- **`/model`**: a two-level picker with pages and per-provider disabling;
  the model and effort are shown when an agent starts or switches.
- **OpenCode `/connect`** works with ordinary providers.
- **Replies**: the replied-to message goes into the agent's prompt, and a
  replied-to photo, file or voice note is named with the bot's saved copy.
- **Voice**: transcription is retried after a timeout or a transient error.
- **`send_messages_to_user`**: each message may carry a file.
- **Jira Cloud connector** (`CONNECTORS=jira`): an issue assigned to the AI
  account becomes a request in its own session, and the answers come back as
  comments.
- **Docker**: the whole bot runs in one container (`docker/`).

### Fixed
- Many fixes in output streaming, session restore after a restart, OpenCode
  event routing and the Claude screen scrape; see the git history.

## Earlier changes, shipped in the 2.0.x packages

### Changed
- **`WORK_DIR` is no longer fatal.** Launch `telegramcode` from the parent
  folder containing your projects — that `$PWD` becomes the work root.
  `WORK_ROOT` is now an advanced override (services / containers where the
  process cwd can't be controlled); a stray legacy `WORK_DIR` is ignored, not a
  startup error.
- **`ALLOWED_GROUP_ID` is now optional.** Leave it empty to auto-pair with the
  first forum supergroup an admin contacts the bot from; set it only to pin a
  specific group before first contact.
- **OpenCode no longer interrupts a running turn for a new prompt.** A prompt
  sent while OpenCode is busy is queued by `prompt_async` and picked up promptly
  instead of aborting the live turn (which only lost work). Claude keeps its
  Escape-and-wait — its TUI ignores typed input mid-turn.
- **Bot UI language is resolved per Telegram chat.** A `/language` override wins,
  otherwise the bot uses Telegram `language_code`, then the last seen chat
  locale, then English; the old global env language knob is removed.

## 2.1.0 — 2026-05-13

**Audit fixes release.** Full repo audit (50 findings across security,
concurrency, resource handling, error contracts, infra) closed in 20
focused commits. See `agent/tasks/actual/2026-05-13-audit-fixes.md` for
the full plan; highlights below.

### Security
- **Two RCEs closed** in `claudeCliAdapter`: `sendInput` and
  `startSession`/`resumeSession` built tmux command lines via
  `execSync` with `JSON.stringify`-interpolated user input, letting any
  allowed user run arbitrary host commands via `$(…)` / backticks in a
  thread message. Reroute all tmux calls onto the argv-based helper;
  single-quote every element of the final `tmux new-session` shell
  command (S1).
- **Forum-topic auth bypass** closed: `forum_topic_created` /
  `_closed` / `_reopened` are now gated on `ALLOWED_USERS`, not just
  the chat allowlist. A non-allowed admin previously could rename a
  topic to fuzzy-match a sensitive WORK_ROOT subdir and have the next
  allowed-user message launch an agent there (S2).
- **OpenCode SSE cross-thread events**: `permission.asked` and
  `question.asked` events without `sessionID` used to fan out to every
  active thread, auto-approving permissions and stacking duplicate
  questions. Now any event without a `sessionID` is dropped (S5).
- **SSRF guard** on `OPENCODE_URL` (loopback by default, opt in with
  `OPENCODE_ALLOW_REMOTE=1`); 30 s timeout on every fetch; abortable
  SSE reader; 10-minute wall-clock cap on SSE reconnect (S7).
- **Docker hardening**: drop `user: root`, `cap_drop: [ALL]`,
  `security_opt: no-new-privileges`, bounded `mem_limit`/`pids_limit`,
  healthcheck. `.docker-entrypoint.sh` uses `runuser -- "$@"` instead
  of `su -c "$*"` so argv stays argv. claude-code install moved to
  build time with a pinned version (S16).

### Bugs
- `resume_<idx>` callback: full session id is recovered from a
  per-thread map instead of being truncated into callback_data, which
  used to make OpenCode resume target a non-existent id (S4).
- Pinned-banner pipeline serialised per key so concurrent adapter
  events can't stack duplicate pinned messages (S6).
- OpenCode lifecycle: per-key serialisation of start/stop, cleanup of
  `statusDebounceTimer` and `reconnectTimer` on stop, explicit
  teardown of every session after `restartServer` (S8).
- Claude adapter: auto-Enter / auto-Accept timers tracked + cleared on
  stop; `pollOutput` uses self-rescheduling `setTimeout` with
  re-entrancy guard; `adoptExistingTmuxSession` rejects zombie panes
  with no live child; capture-pane scrollback raised to 2000 lines (S9).
- `/clear` snapshots message ids under `state.withLock` so agent
  messages pushed mid-deletion can't slip out of tracking (S11).
- `/output` flips `markNeedsNewMessage` and surfaces "+N more chunks
  omitted" instead of silently dropping (S11).
- `/new` routes through `applyBinding` so collision warnings reach the
  new thread (S11).
- `switchThreadAdapter` clears the previous adapter's stored session id
  so post-restart reattach doesn't pick the wrong adapter (S12).
- In-memory per-thread maps GC'd against `state.json` every 60 s so
  orphan entries from UI-deleted topics don't linger (S13).
- Numeric model-selection reply unconditionally returns; previously
  fell through to NL-start + agent-forward when `setModel` was absent
  (S12).
- `downloadFile` capped at 5 redirects with 20 s `setTimeout`;
  `transcribeAudio` got the same timeout and a proper error handler
  installed before `form.pipe(req)`. Voice file URL now built via
  `ctx.telegram.getFileLink` so the bot token isn't materialised in a
  JS string (S14).

### Contracts
- `AgentAdapter` events documented: `startSession` throws on failure,
  `error` is for async failures after a successful start, `closed` is
  unsolicited death, `stopped` is explicit teardown. Claude's two
  start paths now throw + clean up. `setModel` unified to
  `Promise<string | null>`. OpenCode SSE giveup emits `closed` so the
  bot wipes persisted ids (S10).

### Hygiene
- `tsconfig.json`: `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `exclude: src/__tests__/**`.
- `package.json`: drop `ts-node`, move `typescript` to devDeps,
  `private: true`, `engines.node >=22`.
- `BOT_LANG` lowercased + trimmed with a warn on unknown values.
- 19 hardcoded English `ctx.answerCbQuery` strings migrated to a new
  `cb.*` namespace in i18n.
- `.env.example` no longer leaks the author's home path; the two-
  instance example uses `REPLACE_ME` so a copy-pasted file fails
  validation visibly.
- DATA_DIR resolved via `resolveDataDir()` everywhere; previously the
  two adapters dropped state files in `$HOME` instead of `DATA_DIR`,
  breaking two-instance isolation (S3).

### Tests
- 13 new tests: i18n placeholders + fallback (S19/#50), agent NL
  trigger parser extracted into `src/agentTrigger.ts` with full ru/en
  coverage (S19/#25), state.json forward-compat round-trip with an
  unknown future field. 98 tests passing (R9/R10 still skipped).

### Deferred
- `noUncheckedIndexedAccess` in `tsconfig.json` (106 errors fallout —
  needs a careful per-site task).
- Complete MarkdownV2 escaper (regression risk).
- bot.ts test coverage (3300 LOC — separate task).

## 2.0.0 — 2026-05-12

**Breaking release.** The bot now routes through a Telegram forum
supergroup with one topic per task; the 1.x "one bot = one private chat
= one folder" mode is removed. See [Migration](README.md#migration-from-1x).

### Added
- **Forum-supergroup routing.** `ThreadKey = (chatId, threadId)` is the
  routing key everywhere; threads are bound to subfolders of `WORK_ROOT`
  and run their own `claude` or `opencode` session in parallel.
- **Persistent state** (`src/state.ts`) — `${DATA_DIR}/state.json` with
  atomic writes (write tmp → fsync fd → rename → fsync parent dir),
  per-key async-lock for concurrent `/bind`, corrupted-file archival to
  `state.json.corrupted-<ts>` with a fresh restart, debounced saves with
  immediate flush on critical paths.
- **Restart-safe sessions** — claude tmux sessions named
  `claude-${chatId}-${threadId}` are re-adopted on boot via
  `tmux ls`; opencode SSE streams are reopened from persisted
  `opencodeSessionId`. Orphan tmux sessions are killed.
- **Per-thread Claude session id** — `crypto.randomUUID()` →
  `claude --session-id <uuid>` on a fresh start, `--resume <uuid>` on
  resume. Fixes the 1.x picker hang.
- **MCP hierarchy** — user (`~/.claude/settings.json`) /
  group (`${DATA_DIR}/mcp.json`) /
  project (`${workDir}/.mcp.json`) /
  thread (`${DATA_DIR}/threads/<key>.json`). `${VAR}` placeholders are
  expanded by the bot before claude sees the config; tmp files are
  written `0600` and cleaned up on `stopSession`.
- **Commands.** `/bind`, `/unbind`, `/where` (per topic);
  `/ls`, `/list`, `/new`, `/status` (global), `/doctor`, `/mcp`,
  `/whoami`, `/version`, context-aware `/help`, `/stop-all`.
- **Path traversal protection** — NFC normalisation, control-char
  rejection, `realpathSync` + strict containment, symlink-out rejection,
  `/bind .` rejection.
- **Auto-welcome** when the bot is added to a forum supergroup, and
  rich post-bind welcome with CLAUDE.md / .mcp.json / git stats.
- **Token-bucket rate limiter** — 1 token/sec per chat, burst 5,
  layered with reactive 429-retry. Prevents the multi-thread N-msg/sec
  storm that would otherwise breach Telegram's per-chat budget.
- **i18n** — `BOT_LANG=ru|en` (default ru) via `src/i18n.ts`.
- **Two-instance docker-compose** (`examples/docker-compose.yml`) — pet
  + work, isolated `DATA_DIR`, group, token, `OPENCODE_URL` port.
- **Test suite** — `yarn test` (node:test + tsx). 54 tests cover R1
  (ThreadKey round-trip), R2 (gating matrix), R3 (path-traversal
  corpus), R4 (legacy file migration), R5 (concurrent state writes),
  R6 (corrupted state archival), R7 (rate-limit token bucket + 429
  retry), R8 (send-error classification).

### Changed
- **`WORK_DIR` → `WORK_ROOT`.** `WORK_DIR` is now fatal — bot fails to
  start with a migration hint. `WORK_ROOT` points at the *parent* folder
  containing your projects.
- **`ALLOWED_GROUP_ID` is required.** Without it the bot has no idea
  which forum supergroup to listen to.
- **`DATA_DIR`** — single-instance default `~/.telegramCode`, mandatory
  for two-instance setups.
- **`--dangerously-skip-permissions`** hardcoded for symmetry with
  opencode's auto-approve.
- **`/clear`** scoped to the current thread (uses persisted message ids),
  chunked at 100 per call, surfaces the Telegram 48 h limit.
- **README** rewritten end-to-end around forum supergroup setup,
  troubleshooting, MCP hierarchy, two-instance compose, migration.

### Removed
- One-bot-per-private-chat mode and `WORK_DIR` env var.
- Legacy `~/.telegram-bot-messages.json` (renamed to `.bak` on first
  start; no message-id migration into the new schema).

### Deferred (Phase 9+)
- `/mcp-add`, `/mcp-remove`, `/mcp-restart` UI commands.
- OpenCode per-thread MCP override.
- Routines / opencode-scheduler integration (`/schedule`,
  `/schedule-cloud`) — Phase 8.
- Claude Code hooks integration + `--input-format stream-json`
  rewrite — Phase 9.

### Stage 7 polish (shipped 2026-05-12)
- Per-thread pinned status banner (`📁 subdir · agent · model ·
  state`) — edits in place on every adapter lifecycle event,
  unpinned on `/unbind`.
- Fuzzy auto-bind on `forum_topic_created` — separator drift
  (`my-api` ↔ `my_api` ↔ `my api`) is folded alongside case + NFC.
- `/bind` keyboard pagination at 20 folders/page with
  `[⬅️ Prev] [N/M] [Next ➡️]` nav row; `WORK_ROOT` listing cap
  raised 50 → 200.
- R9 (tmux re-attach) and R10 (claude `--resume` on bogus UUID)
  filed as documented skip-tests pending an integration harness.

### Migration
1. Stop the 1.x bot.
2. Create a forum supergroup, add the bot, follow
   [README Quick Start](README.md#2-create-the-forum-supergroup).
3. Rename `WORK_DIR` → `WORK_ROOT` and point at the parent folder.
4. Add `ALLOWED_GROUP_ID` (find it via `/whoami` in the group).
5. Set `DATA_DIR` if you run multiple instances on one host.
6. `docker compose up -d`.

The legacy `~/.telegram-bot-messages.json` is moved to `.bak` on first
start; message-id history does not migrate.
