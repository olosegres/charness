#!/usr/bin/env bash
# charness self-update — pull-based deployment refresh, no root required.
#
# Run as the checkout's OWNING user (interactively, from cron, or by the bot's own updater). Safe by
# construction: fast-forward only; skips silently when the tree has tracked
# changes, a merge/rebase is in progress, or local history diverged from the
# upstream (a dev clone that is ahead of origin is normal and is never touched).
#
# A hot-mode instance (`charness hot`: tsc -w + nodemon) picks the pulled
# source up automatically; a non-hot instance gets `yarn build` here plus a
# restart notice — this script never kills or restarts processes itself.
#
#   scripts/self-update.sh                   update (what cron runs)
#   scripts/self-update.sh --check           fetch only, change nothing, say what an update would do
#   scripts/self-update.sh --hold-breaking   update, unless the incoming range ADDS a MIGRATION_*.md
#
# The machine-readable result is `key=value` lines on stdout, one per line, the rest is a log:
#   status=updated|upToDate|behind|skip|held   reason=dirty|diverged|noUpstream|inProgress|fetchFailed (with skip)
#   from=<short sha>  to=<short sha>  behind=<commits>  migrationGuides=<MIGRATION_*.md the range adds, space separated>
# `--check` prints the log on stderr, so its stdout holds only those lines. Exit 3: held back by --hold-breaking.
set -euo pipefail

heldBreakingExitCode=3
shortShaLength=7

mode=update
holdBreaking=0
for argument in "$@"; do
  case "$argument" in
    --check) mode=check ;;
    --hold-breaking) holdBreaking=1 ;;
    *) printf '[self-update] unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

repoDir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repoDir"

log() {
  if [ "$mode" = check ]; then printf '[self-update] %s\n' "$*" >&2; else printf '[self-update] %s\n' "$*"; fi
}
emit() { printf '%s=%s\n' "$1" "$2"; }

# Say why this run changes nothing, then stop (a skip is never an error).
skip() {
  log "$2 — skip"
  emit status skip
  emit reason "$1"
  exit 0
}

# cron ships a minimal environment — load nvm so node/yarn resolve (an update needs yarn; a check does not).
if [ "$mode" = update ] && ! command -v yarn >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
command -v git >/dev/null 2>&1 || { log "git not found"; exit 1; }
if [ "$mode" = update ]; then
  command -v yarn >/dev/null 2>&1 || { log "yarn not found (nvm not loadable?)"; exit 1; }
fi
[ -d .git ] || { log "$repoDir is not a git checkout"; exit 1; }

# One update at a time (cron-overlap guard). A check changes nothing and needs no lock.
if [ "$mode" = update ]; then
  exec 9>"$repoDir/.git/self-update.lock"
  flock -n 9 || { log "another self-update is already running — skip"; exit 0; }
fi

# Never touch a checkout mid-work.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  skip inProgress "merge/rebase in progress"
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  skip dirty "tracked changes in the working tree"
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$upstream" ]; then
  skip noUpstream "current branch tracks no upstream"
fi

branch="$(git symbolic-ref --quiet --short HEAD || true)"
remote="$(git config "branch.${branch}.remote" 2>/dev/null || true)"
remote="${remote:-origin}"
if ! git fetch --quiet "$remote"; then
  if [ "$mode" = check ]; then skip fetchFailed "fetching $remote failed"; fi
  log "fetching $remote failed"
  emit status skip
  emit reason fetchFailed
  exit 1
fi

localHead="$(git rev-parse '@')"
remoteHead="$(git rev-parse '@{u}')"
short() { git rev-parse --short="$shortShaLength" "$1"; }

if [ "$localHead" = "$remoteHead" ]; then
  log "already up to date ($(short '@'))"
  emit status upToDate
  emit from "$(short '@')"
  emit to "$(short '@')"
  emit behind 0
  emit migrationGuides ""
  exit 0
fi

mergeBase="$(git merge-base '@' '@{u}')"
if [ "$localHead" != "$mergeBase" ]; then
  skip diverged "local history is ahead of / diverged from $upstream (dev clone?)"
fi

# A migration guide ADDED by the range means a rename or a breaking change an operator (or the agent running
# this instance) must read: say so in the log this script is run for, where it is seen.
migrationGuides="$(git diff --name-only --diff-filter=A "$localHead" "$remoteHead" | grep -E '^MIGRATION_.*\.md$' | tr '\n' ' ' | sed 's/ $//' || true)"
behindCount="$(git rev-list --count "$localHead..$remoteHead")"

if [ "$mode" = check ]; then
  emit status behind
  emit from "$(short "$localHead")"
  emit to "$(short "$remoteHead")"
  emit behind "$behindCount"
  emit migrationGuides "$migrationGuides"
  exit 0
fi

if [ "$holdBreaking" = 1 ] && [ -n "$migrationGuides" ]; then
  log "breaking change — the range adds ${migrationGuides}; not merged (read it, then update by hand or confirm in the bot)"
  emit status held
  emit from "$(short "$localHead")"
  emit to "$(short "$remoteHead")"
  emit behind "$behindCount"
  emit migrationGuides "$migrationGuides"
  exit "$heldBreakingExitCode"
fi

git merge --ff-only --quiet '@{u}'
log "updated $(short "$localHead")..$(short '@') ($(git rev-list --count "$localHead..HEAD") commits)"

changedFiles="$(git diff --name-only "$localHead" HEAD)"
checkChanged() { printf '%s\n' "$changedFiles" | grep -qxE "$1"; }

manifestChanged=0
if checkChanged 'yarn\.lock|package\.json'; then
  manifestChanged=1
  log "dependency manifest changed — running yarn install"
  yarn install --immutable
  # The Docker entrypoint reinstalls whenever this stamp differs from the lock's hash; refresh it, or the next
  # container start repeats the install this script just did.
  lockHash="$(sha256sum yarn.lock | cut -d' ' -f1)"
  for stamp in node_modules/.charness-image node_modules/.telegramcode-image; do
    if [ -f "$stamp" ]; then printf '%s\n' "$lockHash" > "$stamp"; fi
  done
fi

# A running hot supervisor (tsc -w on THIS checkout) rebuilds dist and nodemon
# restarts the worker on its own; build here only when no watcher owns the dir.
if pgrep -f "$repoDir/node_modules/.bin/tsc" >/dev/null 2>&1; then
  log "hot mode detected — tsc -w rebuilds, nodemon restarts the worker"
  if [ "$manifestChanged" = 1 ]; then
    # tsc -w does not re-resolve modules installed after a failed compile;
    # touching tsconfig forces a full reconfigure+recompile with the new deps.
    touch tsconfig.json
    log "nudged tsc -w (touch tsconfig.json) to recompile with the new dependencies"
  fi
else
  log "no hot watcher on this checkout — building"
  yarn build
  log "NOTE: restart the bot process to pick up the new build (this script never restarts anything)"
fi

# The hot SUPERVISOR does not reload itself (nodemon restarts only the worker):
# a supervisor that predates the bot's own updater needs a manual `charness hot` restart.
if checkChanged 'src/cli\.ts|src/cli/hot\.ts|nodemon\.json'; then
  log "WARNING: hot-supervisor files changed (src/cli.ts / src/cli/hot.ts / nodemon.json) — restart 'charness hot' manually"
fi

if [ -n "$migrationGuides" ]; then
  log "WARNING: breaking change — read ${migrationGuides} and the top entry of CHANGELOG.md before the next restart"
fi

emit status updated
emit from "$(short "$localHead")"
emit to "$(short '@')"
emit behind "$behindCount"
emit migrationGuides "$migrationGuides"
