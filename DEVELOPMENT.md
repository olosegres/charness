# Development

Architecture and local-development notes for Charness. User-facing setup
lives in the [README](README.md); [`CLAUDE.md`](CLAUDE.md) is the short
project map for agents, and each module's behavior is documented next to the
code (`src/<module>/README.md`).

## Architecture

The per-topic folder layout is in [SETUP.md](SETUP.md) under
[Required files structure](SETUP.md#required-files-structure).

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

### Voice recognition (the engine chain and the local sidecar)

A voice note walks an ordered chain of speech engines read from `stt.json` (`src/stt/`). The local GigaAM engine is
the one engine that is a PROCESS of ours, owned by the bot like OpenCode's server but started on demand and stopped
with its owner:

```
voice note ──> transcribeWithEngines ──> engine 1 (local) ──ensure──> sttSidecarOwner ──> gigaam_sidecar.py
                  │   fall back on any      engine 2 (Groq)               │  adopt the record, or spawn;     (ONE process, 127.0.0.1:0,
                  │   failure, no retry     engine 3 (your URL)           │  hosted outside the bot's tree    token, idle exit)
                  └── last engine retries                                 └── DATA_DIR/stt/sidecar.json
owner = the `charness hot` supervisor (a worker reload keeps the sidecar) or the plain bot process;
the sidecar polls its owner and exits within ~2 s of its death, even after a SIGKILL.
```

## Local development

```bash
git clone https://github.com/olosegres/charness && cd charness
yarn install
yarn dev          # tsx watch (fast dev — TS errors crash the process)
yarn typecheck    # strict tsc over all of src/, test code included
                  # (tsconfig.typecheck.json extends tsconfig.json)
yarn build        # tsc → dist/ (tsconfig.json; src/__tests__ is not emitted)
yarn test         # test:unit, then test:flows (node test runner + tsx); build
                  # first — some tests exercise the built dist/cli.js
yarn test:unit    # every file but the flows; each file must finish in 2 min
yarn test:flows   # the `*E2e.test.ts` flows; each file must finish in 20 min
yarn hot          # hot-reload mode: tsc -w + nodemon on dist/ (also
                   # `charness hot` from anywhere) — a broken edit can't
                   # take the bot down; OpenCode generations stay outside the
                   # worker tree, so agent turns survive worker reloads
                   # (Linux/macOS; Windows hot mode is intentionally refused)
```

To run your checkout as the global `charness` command instead of the npm package, `yarn install-link`
(= `yarn install && yarn build && npm link`) symlinks the command to this folder, so a later `yarn build` is picked up
without re-installing; `npm install -g .` installs a copy instead. Configuration and launch are as in
[SETUP.md](SETUP.md).

Node applies `--test-timeout` to a whole test FILE (a `describe`'s own `timeout` cannot extend it), so a file that
hangs or leaves a process alive fails by name when its limit passes, instead of hanging the run. A long-running
flow file must be named `*E2e.test.ts` to get the flows' limit; `live/*Live.test.ts` is run directly (CLAUDE.md).
A flow's own time budget is that same limit less a teardown reserve (`getFlowDeadlineMs`, read from the process's
`--test-timeout`), so a flow that runs long fails first, at the wait that is late and with charness's output tail,
not with the runner's bare timeout. Run one flow directly with `--test-timeout=<ms>`.

The Docker dev loop (never `docker compose restart` — it ignores
`depends_on`):

```bash
docker compose down charness && docker compose up -d charness   # examples/docker-compose.yml
docker compose logs -f charness             # tail logs
docker exec charness-main charness-restart-bot   # restart only the bot; agents keep running
```

## Releases

`.github/workflows/publish.yml` releases charness to npm without anyone doing anything. Every day at 09:17
(Asia/Tbilisi) it decides by itself: nothing shipped changed → a green run, no tag, no publish; otherwise it
typechecks, builds and runs the FULL `yarn test` on the runner, checks the package, commits `chore(release): X.Y.Z`,
tags `vX.Y.Z`, publishes to the `latest` dist-tag with provenance (npm trusted publishing from the `release`
environment, no npm token anywhere) and creates the GitHub Release from the CHANGELOG section. Red anywhere → no
tag, no publish, the run is red; the next day's run tries again by itself. The logic is in `src/release/` (pure
`releasePlan.ts` + the `cli.ts` wrapper, run by `tsx`, never built into `dist/`).

- **Version** (Conventional Commits since the last `v*` tag): a `feat` that changes shipped code → minor; any other
  shipped change (`fix`, `perf`, `refactor`, `revert`, `chore`, …) → patch; `chore(release)` commits never count. A `!`
  after the type or a `BREAKING CHANGE:` footer in ANY commit makes the automatic run **fail**, naming the commits: a
  major is released only by dispatching the workflow with `bump=major`.
- **Nothing to release** (green, nothing tagged): no commits since the last tag, `HEAD` already tagged, or no shipped
  path in the net diff from the tag — `src/**/*.ts` outside `src/__tests__` and `src/release`, `stt/gigaam_sidecar.py`,
  and `package.json` only when `dependencies`, `bin`, `engines`, `files` or `main` differ. A docs-only or tests-only
  day, or a change and its revert, publishes nothing; README / SETUP changes reach the npm page with the next code
  release.
- **Manual run** (Actions → Release to npm → Run workflow): `bump` `auto|patch|minor|major`; `force` releases even when
  the skip rules say skip (never past the breaking-change guard of `auto`); `dryRun` does everything but the push, the
  publish and the GitHub Release and prints the plan, the CHANGELOG diff, the notes and the package check.
- **By hand:** `npm version minor` locally (its `preversion` runs typecheck, build and the tests, its
  `version` script moves the CHANGELOG heading, `.npmrc` gives the commit npm's message `chore(release): X.Y.Z`), then
  push `main` with the tag; the workflow runs the same gate and publishes that tag.
- **CHANGELOG:** `## Unreleased` becomes `## X.Y.Z — YYYY-MM-DD` (Tbilisi date) with a fresh empty `## Unreleased`
  above; that section is the GitHub Release text and ships inside the package. Every entry of it — a top-level
  paragraph or `- ` bullet, in any `###` subsection — starts with a bold first sentence (`**…**`); the run fails,
  quoting the line, otherwise (`changelogFormat.test.ts` fails first on a commit that breaks it). An empty
  `## Unreleased` is filled with the `feat` / `fix` subjects.
- **Package check** before any tag: the tarball holds `dist/cli.js`, `stt/gigaam_sidecar.py`, `CHANGELOG.md`,
  `README.md`, `LICENSE` and no `src/` or tests, and `charness --version` of it, installed into a temp prefix, prints
  the new version (`yarn tsx src/release/cli.ts check-pack`, after `yarn build`).
- **After a release** the clone is one commit behind `main`: `git pull --rebase` before pushing. A new CHANGELOG entry
  goes under `## Unreleased` (a push that races the release can conflict there; the run then fails with nothing
  published).
