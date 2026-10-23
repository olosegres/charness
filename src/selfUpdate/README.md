# `src/selfUpdate/` — the bot keeps itself current

An instance finds a new version, installs it when nobody is using the bot, restarts invisibly (agents keep running)
and says in General what changed. Settings live only in `settings.json` (`autoUpdate` `on|notify|off`, `whatsNew`),
changed from `/update` in General — never an env var.

Pure decisions first, effects after:

- `updateModes.ts`, `constants.ts` — the modes and every named duration / limit (check 1 h, first check 10 min, npm hold 4 h,
  quiet 10 min, install timeout 10 min, self-check 60 s, hot-build deadline 10 min, boot confirm 60 s, 2 unconfirmed boots,
  8 notes).
- `semver.ts` — parse, compare and the `engines.node` range forms; an unreadable range is "unknown", never a refusal.
- `installKind.ts` — what this install IS, from the package folder and what is writable: `npmGlobal` (prefix writable),
  `checkout` (a git checkout, `npm link` and a mounted one included, writable, with `scripts/self-update.sh`), `notifyOnly`
  (read-only, pnpm / yarn / bun, a project-local install, a Node without `process.execve`) and `ephemeral` (npx). Never decided
  by "is this a container".
- `updatePolicy.ts` — `decideNpmUpdate` (hold, no downgrade / prerelease / deprecated, `engines.node`, a major only offered),
  `decideGitUpdate` (a range that adds a `MIGRATION_*.md` is the checkout's "major"; a failed commit is not retried),
  `getIdleVerdict` (no agent working, no unconsumed input, no sign-in or wizard, no human message for the quiet period).
- `releaseNotes.ts` — the what's-new summary from the INSTALLED `CHANGELOG.md`: npm = the sections after `from` up to `to`;
  checkout = the entries a `git diff` of the file ADDED. The entry splitter is `../changelogEntries.ts`, the same one the
  release gate uses (every entry opens with a bold first sentence, which is the headline).
- `types.ts` — what `state.json` keeps (`selfUpdate`, `lastRunVersion`).

Sources — what talks to the world, each behind a `CommandRunner` (`commandRunner.ts`: `execFile` with a deadline, never
throws, a result the caller words):

- `npmSource.ts` — `npm view charness@latest version engines deprecated --json`; `npm install -g --prefix <prefix>
  charness@X` with the npm NEXT TO the running `node` (nvm-safe, the user's `.npmrc` honoured), scripts on (node-pty builds);
  a rollback adds `--prefer-offline`. Never sudo.
- `hostLock.ts` — one installer per host: `<prefix>/lib/node_modules/.charness-update.lock` (created exclusively, pid + start
  time; taken over when its pid is dead or it is older than 30 min). The others find the new version on disk and restart onto it.
- `gitSource.ts` — drives `scripts/self-update.sh`: `--check` (fetch only → `status=behind|upToDate|skip`, `reason`, `from`,
  `to`, `behind`, `migrationGuides`), apply with `--hold-breaking` (exit 3 = held at a range that adds a `MIGRATION_*.md`), the
  whole-file diff of `CHANGELOG.md` for the notes, and the rollback (`git reset --keep <from>`, `yarn install` when the lock
  moved, `yarn build` unless a hot watcher rebuilds). Hot mode: nodemon watches only `dist/` and `tsc -w` writes there only for a
  compiled source, so a range that changed none (docs, the CHANGELOG, scripts, tests, the manifests — `checkChangesEmittedSource`)
  gets `reloadHotWorker`, a touch of `dist/cli/botEntry.js`, from the pull and from a hot rollback; without it no worker would
  replace the old one and the build deadline would roll a good pull back.
- `selfCheck.ts` — `charness self-check [--expect <version>]` (hidden), run on a NEW install before the switch: the version,
  `node-pty`'s native binding, every built module importable (entry points and tests left out; `bot.js` only `node --check`ed,
  it exits without its settings), under a throwaway `DATA_DIR`.

Restart and rollback:

- `launchEnvironment.ts` — the environment as it was at launch, snapshotted by `cli.ts`'s FIRST import, before any `.env` is
  read. A re-exec uses it, so an edited `.env` is read afresh and a removed key is gone.
- `restart.ts` — `process.execve` in place (the SAME pid: systemd, pm2, nohup, a foreground terminal see nothing): the new image is
  `node <packageRoot>/dist/cli.js <the original arguments>`; its problems (a missing node or `cli.js`) are found BEFORE anything is
  shut down; an `execve` that fails is logged and ends with exit 75 rather than a silent death.
- `hotSupervisor.ts` + `cli/hot.ts` — a worker reload is all an update needs until a file the SUPERVISOR loaded changed. At its
  start the supervisor writes `DATA_DIR/hot-supervisor.json` (pid, start token, hash of every `dist/` module it loaded); a worker
  that finds one changed signals it with `SIGUSR2` — only when the pid still has that start token — and the supervisor stops
  `tsc -w` and nodemon, leaves the OpenCode server and the speech sidecar alone, and re-executes itself. A supervisor that predates
  this has no record and no handler: it is never signalled (an unhandled `SIGUSR2` kills a process).
- `updatePending.ts` + `bootRollback.ts` — `DATA_DIR/update-pending.json` is written BEFORE the switch. Each boot of an unconfirmed
  version counts itself in (in `cli/bot.ts`, once the instance lock is held and before the bot module is imported — a start that loses
  the lock is not a boot) — except a boot that asks the hot supervisor to
  re-execute, which hands its count back (that end is deliberate, and without it a healthy supervisor update would leave one boot
  of the budget); the boot after two unconfirmed ones puts the previous version back (npm: reinstall from the cache; checkout:
  `git reset --keep` + rebuild) and restarts onto it — a plain process by `execve`, a hot worker by exiting cleanly so its watcher
  rebuilds. The marker stays as `rolledBack` / `rollbackFailed` for the restored version to report; the running bot deletes it once
  the new version is confirmed. Not covered: a supervisor that crashes before it starts a worker counts no boots — an update whose
  new `cli/hot.ts` cannot even load is not rolled back by this.

The engine and what the operator sees:

- `updateEngine.ts` — one engine per process over ports (clock, settings, state, sources, idle verdict, posting, restart, marker,
  supervisor): nothing in it touches the world, so its whole flow runs in a test against fakes with a fake clock. `runBootStep`
  settles the last update (confirms it after 60 s, announces a version change, reports a rollback, notices a newer install on disk
  or a stale supervisor); `start` arms the hourly check; the idle loop installs, restarts or signals the supervisor at the first
  idle moment (`getIdleVerdict`); `requestInstall` is the tap's entry (`isUserRequested` skips only the quiet period); `getStatus` /
  `getOffer` feed the `/update` screen. Targets already announced or failed are remembered in the `selfUpdate` record in
  `state.json` (`notifiedTargets`, `failedTargets`) so a restart never repeats a message or retries a failure.
- `updateMessages.ts` — what the engine says in General, as DATA (`UpdateMessage`); `renderUpdateMessage` words it with `t()` in the
  chat's language. The what's-new entries stay English (the CHANGELOG's own words); a message the operator must act on is pinned.
- `updateRuntime.ts` — the process-bound half of the ports: install kind, sources, host lock, the marker, the supervisor record.
  `bot.ts` passes in the rest (settings, state, idle verdict, General, the shutdown sequence) when it builds the engine.
- The screen: `utils/updateScreenPlan.ts` (pure text + buttons, callbacks `upd_mode_*`, `upd_notes_*`, `upd_check`, `upd_go_<target>`; an announcement's own install button is `upd_ann_<target>`)
  rendered by `connectors/telegram/commands/selfUpdate.ts`; controls are General's, writes go to `settings.json` only.

Verified by hand with a real `opencode serve` spawned the way the supervisor spawns it (a direct child with piped stdio) and then
`process.execve`d: the server keeps answering after its stdout pipe is closed. An inherited child that EXITS later stays defunct
(`Z`) until the supervisor itself exits — Node reaps only the children it spawned — a process-table entry and nothing more.
