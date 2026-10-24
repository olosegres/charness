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

### Self-update (the bot updates itself)

`src/selfUpdate/` (its README has the contracts) is an engine over ports: `updatePolicy.ts` decides, `updateEngine.ts` runs
the hourly check, the idle loop and the boot step against fakes in tests, `updateRuntime.ts` binds it to this process
(install kind, npm / git sources, host lock), `bot.ts` supplies the settings, the idle verdict and General. Three facts to
keep when touching the restart path:

- **A restart in place is `process.execve`** (the same pid) of `node <packageRoot>/dist/cli.js <original arguments>` with
  the environment as it was at launch — `cli.ts`'s FIRST import snapshots it, so an edited `.env` is read afresh. Nothing
  may be imported before `launchEnvironment`.
- **The hot supervisor re-executes itself** when a file it loaded changed: at start it writes `DATA_DIR/hot-supervisor.json`
  (pid, start token, hash of every loaded `dist/` module); a new worker compares it with `dist/` and, at its idle point,
  sends `SIGUSR2` — only when pid and start token match. The supervisor stops `tsc -w` and nodemon, leaves the OpenCode
  server and the speech sidecar alone and `execve`s `cli.js hot`. A supervisor that predates this has no record and is
  never signalled (an unhandled `SIGUSR2` kills a process).
- **`update-pending.json` is written BEFORE the switch**; every boot counts itself in (`cli/bot.ts`, once the instance lock is held and before the bot
  module is imported), the boot after two unconfirmed ones rolls back, the running bot confirms 60 s after launch.

The flows run it for real: `selfUpdateNpmE2e` (a loopback registry — `e2e/fakeNpmRegistry.ts` — and a real global install into
a temp prefix), `selfUpdateCheckoutE2e` (a checkout copy, a bare remote and a second clone — `e2e/checkoutFixture.ts`),
`selfUpdateHotE2e` (the real `charness hot`), `selfUpdateEntrypointE2e` (the image's own `docker/entrypoint.sh` and
`restart-bot.sh` with their paths pointed into a temp folder — the one thing it cannot run is the container itself). The
harness writes `settings.json` with `autoUpdate: off` for every instance, so no flow updates the checkout it runs from.

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
yarn test:flows   # the `*E2e.test.ts` flows, 16 files at a time (they mostly wait
                  # on their fakes, not the CPU); each file must finish in 20 min
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

A flow does not wait out the production windows in real time: its env file sets `CHARNESS_TEST_TIMINGS`, a JSON object
of named overrides (`src/testTimings.ts`: `telegramSendIntervalMs` — the global send pacer's 2 s, `jiraPollIntervalMs` —
below the 10 s floor of `jira.json`, `requestSweepIntervalMs` and `requestFirstPostRetryDelayMs` — the wake-up engine's
minutes, `limitProbeDelayMs` — the two-minute probe of an unconfirmed usage limit, `stateSaveDebounceMs` — `state.json`'s
500 ms save debounce, `openCodeServerUpBudgetMs` — the OpenCode server's 60 s of retries, `backgroundHoldMaxMs` — the 6 h the
agent's own pending work holds a json-stream process). It is the ONE test-only timing seam,
never a setting: unset, every window is the production one; a value may only shorten its window (each key is capped at its
production value); set, the boot prints `[test-timings] … overrides active`, and
an unknown key or a bad value stops the start naming it.

The Docker dev loop (never `docker compose restart` — it ignores
`depends_on`):

```bash
docker compose down charness && docker compose up -d charness   # examples/docker-compose.yml
docker compose logs -f charness             # tail logs
docker exec charness-main charness-restart-bot   # restart only the bot; agents keep running
```

## Releases

Two workflows. **`.github/workflows/test.yml` (`Tests`)** runs typecheck, build and the FULL `yarn test` on every push to
`main`. **`.github/workflows/publish.yml`** releases charness to npm without anyone doing anything: every day at 09:17
(Asia/Tbilisi) it decides by itself: nothing shipped changed → a green run, no tag, no publish; otherwise it checks the tests
of the commit it would release (below), checks the package, commits `chore(release): X.Y.Z`, tags `vX.Y.Z`, publishes to the
`latest` dist-tag with provenance (npm trusted publishing from the `release` environment, no npm token anywhere) and creates
the GitHub Release from the CHANGELOG section. Red anywhere → no tag, no publish, the run is red; the next day's run tries
again by itself. The logic is in `src/release/` (pure `releasePlan.ts` and `testGate.ts` + the `cli.ts` wrapper, run by
`tsx`, never built into `dist/`).

- **Tests gate:** the release does not run the suite again when the exact commit already passed. It asks GitHub for the
  `Tests` workflow's runs of that commit's SHA (the newest run of the commit decides): **passed** → go on; **no run at all**
  (a manual dispatch before CI ran) → the release runs the suite itself; **failed or still running** → the daily run
  releases nothing that day and ends green with the reason (a red head is not skipped over to an older green commit), a
  manual dispatch or a hand-pushed tag fails with it. The release commit may differ from the tested one ONLY in
  `package.json`'s `"version"` line and `CHANGELOG.md`: `verify-delta` checks the diff before the tag and again in the publish
  job (the tag against the tested SHA) and refuses otherwise. A hand-pushed tag (`npm version`, then push `main` with the tag) is gated through its
  PARENT: when the commit before the tag has a green `Tests` run and the tag differs from it only in the version and the CHANGELOG,
  that run is the gate — the tag's own run, started by the same push, is not waited for. When the parent is not green or the tag
  carries more than the bump, the tagged commit's own run decides (still running → refused: re-run the release once it is green).
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
  push `main` with the tag; the workflow gates that tag on its commit's `Tests` run (above) and publishes it.
- **CHANGELOG:** `## Unreleased` becomes `## X.Y.Z — YYYY-MM-DD` (Tbilisi date) with a fresh empty `## Unreleased`
  above; that section is the GitHub Release text and ships inside the package. Every entry of it — a top-level
  paragraph or `- ` bullet, in any `###` subsection — starts with a bold first sentence (`**…**`); the run fails,
  quoting the line, otherwise (`changelogFormat.test.ts` fails first on a commit that breaks it). An empty
  `## Unreleased` is filled with the `feat` / `fix` subjects.
- **Package check** before any tag: the tarball holds `dist/cli.js`, `stt/gigaam_sidecar.py`, `CHANGELOG.md`,
  `README.md`, `LICENSE` and no `src/` or tests, and `charness --version` of it, installed into a temp prefix, prints
  the new version (`yarn tsx src/release/cli.ts check-pack`, after `yarn build`). `bin` paths are written
  `dist/cli.js`, never `./dist/cli.js`: npm >= 11.10 silently drops a "./" entry from the manifest it publishes (3.3.0
  reached the registry without its commands), so `check-pack` and `packageManifest.test.ts` refuse one, and
  `check-publish` (`npm publish --dry-run`, run before the tag and again right before the publish) refuses a package.json
  that npm reports it would drop or rewrite anything from.
- **After a release** the clone is one commit behind `main`: `git pull --rebase` before pushing. A new CHANGELOG entry
  goes under `## Unreleased` (a push that races the release can conflict there; the run then fails with nothing
  published).
