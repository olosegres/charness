#!/bin/sh
# pickNode.sh <account> — run as ROOT by the admin pairing line, from its root-owned copy of the package (never from the account's folder), BEFORE
# anything is started under Node. Prints the real path of the Node.js that root and the runner's service will run under, or says why there is none
# (exit 1). A Node qualifies only when ALL of these hold:
#   - its real path (links followed) is outside every home folder: /Users/<name>, /home/<name>, root's own. A program in a home is the other user's to
#     change, and the runner's launcher and daemons would stop working the day that home is closed (chmod 700) or its version manager moves on;
#   - the account can run it (`sudo -u <account> test -x`) and CANNOT write it, nor any folder above it (`test -w`): root runs it, and root must never
#     execute anything the account — which runs the agents' code — can change;
#   - it is Node.js 22.12 or newer.
# Candidates: the `node` of sudo's own PATH first, then Homebrew's (Apple Silicon, Intel).
#
# The account is judged with `sudo -u <account> test …` only: nothing of the account's is executed. `$1` is validated by the line (a plain account name).
# Test seam, used by the unit tests and not by the line: `$2` replaces the home patterns (space-separated `case` patterns), `$3` the system candidates.
set -u
a=$1
homes=${2:-"/Users/* /home/* */root/*"}
candidates=${3:-"/opt/homebrew/bin/node /usr/local/bin/node"}
min_major=22
min_minor=12

fail() { echo "charness-runner: $*" >&2; exit 1; }

# The real path of $1, links followed. Without `readlink -f` (macOS before 12.3) the links are followed by hand and the folder is resolved by `cd -P`.
real_path() {
  readlink -f "$1" 2>/dev/null && return 0
  p=$1; hops=0
  while [ -L "$p" ] && [ "$hops" -lt 20 ]; do
    l=$(readlink "$p") || return 1
    case $l in /*) p=$l;; *) p=${p%/*}/$l;; esac
    hops=$((hops + 1))
  done
  [ -e "$p" ] || return 1
  d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$d" "${p##*/}"
}

# Is $1, or a folder above it, writable by the account?
account_can_write() {
  w=$1
  while [ -n "$w" ] && [ "$w" != / ]; do
    sudo -u "$a" test -w "$w" && return 0
    w=${w%/*}
  done
  return 1
}

in_a_home() {
  set -f
  for pattern in $homes; do
    case $1 in $pattern) set +f; return 0;; esac
  done
  set +f
  return 1
}

for c in $(command -v node 2>/dev/null) $candidates; do
  r=$(real_path "$c") || continue
  in_a_home "$r" && continue
  sudo -u "$a" test -x "$r" || continue
  account_can_write "$r" && continue
  "$r" -e "var v=process.versions.node.split(/[.]/);process.exit(v[0]>$min_major||v[0]==$min_major&&v[1]>=$min_minor?0:1)" || continue
  printf '%s\n' "$r"
  exit 0
done
fail "no Node.js $min_major.$min_minor+ outside home folders that $a cannot write: install one system-wide (macOS: brew install node), paste again"
