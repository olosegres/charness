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
  moved, `yarn build` unless a hot watcher rebuilds).
- `selfCheck.ts` — `charness self-check [--expect <version>]` (hidden), run on a NEW install before the switch: the version,
  `node-pty`'s native binding, every built module importable (entry points and tests left out; `bot.js` only `node --check`ed,
  it exits without its settings), under a throwaway `DATA_DIR`.
