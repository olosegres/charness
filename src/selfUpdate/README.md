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
