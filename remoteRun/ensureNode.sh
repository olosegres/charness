#!/bin/sh
# ensureNode.sh — gives a runner its OWN Node.js: the official build from nodejs.org, checked against nodejs.org's SHASUMS256.txt, in a folder of its own
# that no package manager (brew, nvm, an OS package) ever touches or moves. A runner never runs on a shared Node: a system one is the admin's to change,
# and a job that wants a package manager or a global package cannot write into a system folder.
#
#   ensureNode.sh root <account> [<base> [<homes> [<dist> [<major>]]]]   the ADMIN pairing line, as ROOT, from its root-owned copy of the package (never
#                                                                         from the account's folder), BEFORE anything is started under Node
#   ensureNode.sh own <base> [<dist> [<major>]]                          as the runner account itself: the plain line, a runner that moves off a system
#                                                                         Node, and an own install that looks for a newer release of its line
#
# Prints the real path of the `node` binary on stdout, or says why there is none on stderr (exit 1). Everything meant for a person goes to stderr.
#
# Which Node: the newest LTS release of Node.js that is $min_major.$min_minor or newer AND still ships Corepack (Node.js $max_major at most: 25 and later
# do not), read from nodejs.org/dist/index.json for this machine (linux or darwin, x64 or arm64). With a <major> given (an install that is already there
# asks for the newest release of ITS line) it is the newest release of that line, LTS or not. The release's own SHASUMS256.txt names its archive and
# the SHA-256, which is compared with the download BEFORE a byte of it is unpacked; the archive is fetched with curl or wget (a total time limit on
# each) and unpacked into a work folder next to its final place and moved there whole: a folder `<base>/v<version>` is complete or absent. One that is
# there and runs is REUSED — a second pairing downloads an archive only for a newer release — and when nodejs.org cannot be reached the newest install
# already in <base> is used, with a line saying so. The trust is TLS to nodejs.org (the same as every installer of Node); the signature of
# SHASUMS256.txt is not checked. Only x86-64 and ARM64 machines, glibc Linux and macOS can be runners: nodejs.org's Linux builds need glibc.
#
# `root`: <base> is `/usr/local/lib/charness-runner/node`, a folder only root can write. The Node is unpacked by root, owned by root, never writable by
# group or others, and it qualifies only when ALL of these hold (checked every time, also for a reused install — and BEFORE root runs any Node of it):
#   - its real path (links followed) is outside every home folder: /Users/<name>, /home/<name>, root's own. A program in a home is the other user's to
#     change, and the runner would stop working the day that home is closed (chmod 700);
#   - the account can run it (`sudo -u <account> test -x`) and CANNOT write it, nor any folder above it (`test -w`): root runs it, and root must never
#     execute anything the account — which runs the agents' code — can change. The base is judged before root writes into it: the deepest folder of it
#     that exists, then its real path, which is what every later step uses (so a link cannot be pointed elsewhere between the check and the use);
#   - it is Node.js $min_major.$min_minor or newer.
# The account is judged with `sudo -u <account> test …` only: nothing of the account's is executed. `$2` is validated by the line (a plain account name).
# A root install is refreshed only by the next admin line.
#
# `own`: <base> is the account's own folder (`~/.charness-runner/node`); nobody else is involved, so none of the above is asked.
#
# Test seams, used by the unit tests and not by the line: `$4` replaces the home patterns (space-separated `case` patterns), `$5` / `$3` the download
# place (a `file://` folder laid out like nodejs.org/dist). `<major>` is the last argument of both modes.
set -u
unfit_reason=
writable_at=
min_major=22
min_minor=12
max_major=24
default_dist=https://nodejs.org/dist
default_root_base=/usr/local/lib/charness-runner/node
shasums_timeout=60
archive_timeout=900

say() { echo "charness-runner: $*" >&2; }
fail() { say "$*"; exit 1; }

mode=${1:-}
case $mode in
  root)
    [ $# -ge 2 ] || fail "usage: ensureNode.sh root <account> [<base>]"
    a=$2
    base=${3:-$default_root_base}
    homes=${4:-"/Users/* /home/* */root/*"}
    dist=${5:-$default_dist}
    line=${6:-}
    umask 022;;
  own)
    [ $# -ge 2 ] || fail "usage: ensureNode.sh own <base>"
    a=
    base=$2
    homes=
    dist=${3:-$default_dist}
    line=${4:-}
    umask 077;;
  *) fail "usage: ensureNode.sh root <account> | own <base>";;
esac
case $line in ""|*[!0-9]*) [ -z "$line" ] || fail "the line of Node.js to keep to must be a major number, not $line";; esac

case $(uname -s) in
  Linux) os=linux;;
  Darwin) os=darwin;;
  *) fail "only macOS and Linux";;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64;;
  aarch64|arm64) arch=arm64;;
  *) fail "a runner supports only x86-64 and ARM64 processors, and this one is $(uname -m)";;
esac
# A shell started under Rosetta says x86_64 on an Apple Silicon Mac; the native build is the right one there.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; fi
# nodejs.org's Linux builds are glibc builds. A runner never runs on a system Node, so there is no way round this: it cannot be a runner.
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then fail "this Linux uses musl libc (Alpine), and nodejs.org's Node.js builds, which every runner runs on, need glibc: this machine cannot be a runner"; fi
# How nodejs.org's index.json names the build of this machine.
case $os-$arch in
  linux-x64) index_file=linux-x64;;
  linux-arm64) index_file=linux-arm64;;
  darwin-x64) index_file=osx-x64-tar;;
  darwin-arm64) index_file=osx-arm64-tar;;
esac

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

# Is $1, or a folder above it, writable by the account? Sets `writable_at` to the first one found.
account_can_write() {
  w=$1
  while [ -n "$w" ] && [ "$w" != / ]; do
    if sudo -u "$a" test -w "$w"; then writable_at=$w; return 0; fi
    w=${w%/*}
  done
  return 1
}

# Root mode: may root run from the real path $1? Not when it is inside a home, nor when the account can write it or a folder above it. Sets `unfit_reason`.
place_is_fit() {
  unfit_reason=
  if in_a_home "$1"; then
    unfit_reason="$1 is inside a home folder: root runs nothing from somebody's home. Pass a folder outside the homes"
    return 1
  fi
  writable_at=
  if account_can_write "$1"; then
    unfit_reason="$a can write $writable_at, and root runs this Node.js: a folder only root can write is needed (the default is $default_root_base)"
    return 1
  fi
  return 0
}

refuse_unfit_place() {
  place_is_fit "$1" || fail "$unfit_reason"
}

# May root run the Node program $1? (Own mode: always.) The same rules as for a place, and the account must be able to run it. Sets `unfit_reason`.
node_place_is_fit() {
  [ "$mode" = root ] || return 0
  fit_real=$(real_path "$1") || { unfit_reason="cannot find the real path of $1"; return 1; }
  place_is_fit "$fit_real" || return 1
  sudo -u "$a" test -x "$fit_real" || { unfit_reason="$a cannot run $fit_real: its folders must be open to everyone"; return 1; }
  return 0
}

in_a_home() {
  set -f
  for pattern in $homes; do
    case $1 in $pattern) set +f; return 0;; esac
  done
  set +f
  return 1
}

# Does the Node program $1 run and is it $min_major.$min_minor or newer?
node_is_usable() {
  "$1" -e "var v=process.versions.node.split(/[.]/);process.exit(v[0]>$min_major||v[0]==$min_major&&v[1]>=$min_minor?0:1)" >/dev/null 2>&1
}

# fetch <url> <file> <seconds>: curl, else wget; both with a time limit for the whole transfer (wget only has per-read ones, so it runs under `timeout` where
# the machine has one) and https only after a redirect.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto-redir '=https' --connect-timeout 20 --max-time "$3" -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then timeout "$3" wget -q -T 60 -t 2 -O "$2" "$1"
    elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$3" wget -q -T 60 -t 2 -O "$2" "$1"
    else wget -q -T 60 -t 2 -O "$2" "$1"
    fi
  else
    say "neither curl nor wget is on this machine, so Node.js cannot be downloaded: install one of them and paste again"
    return 2
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else return 1
  fi
}

# The newest install in <base> whose Node runs (and, as root, that root may run — one that is not is skipped, never executed), as its version folder name
# (`v22.20.1`), or nothing. With a <major> given, only that line.
newest_installed() {
  best=; best_rank=-1
  for folder in "$base"/v*; do
    [ -x "$folder/bin/node" ] || continue
    v=${folder##*/v}
    case $v in ""|*[!0-9.]*) continue;; esac
    major=${v%%.*}; rest=${v#*.}
    case $rest in *.*) ;; *) continue;; esac
    minor=${rest%%.*}; patch=${rest#*.}
    case $patch in ""|*.*) continue;; esac
    [ -z "$line" ] || [ "$major" = "$line" ] || continue
    node_place_is_fit "$folder/bin/node" || continue
    node_is_usable "$folder/bin/node" || continue
    rank=$((major * 1000000 + minor * 1000 + patch))
    if [ "$rank" -gt "$best_rank" ]; then best_rank=$rank; best=v$v; fi
  done
  printf '%s\n' "$best"
}

# select_release <index.json>: the release to install, as `v22.20.1`, or nothing. Of the LTS releases that have a build for this machine (or, with a <major>
# given, the releases of that line), the highest version from $min_major.$min_minor up to $max_major (Node.js 25 and later do not ship Corepack, which the
# runner's yarn and pnpm come from) — by number, not by date: a security release of an older line can be the newest entry.
select_release() {
  if [ -n "$line" ]; then candidates=$(grep "^{\"version\":\"v$line[.]" "$1" | grep "\"$index_file\"")
  else candidates=$(grep '"lts":"' "$1" | grep "\"$index_file\"")
  fi
  printf '%s\n' "$candidates" | sed -n 's/^{"version":"v\([0-9]*\)\.\([0-9]*\)\.\([0-9]*\)".*/\1 \2 \3/p' | {
    best=; best_rank=-1
    while read -r maj min pat; do
      [ "$maj" -ge "$min_major" ] && [ "$maj" -le "$max_major" ] || continue
      if [ "$maj" -eq "$min_major" ] && [ "$min" -lt "$min_minor" ]; then continue; fi
      rank=$((maj * 1000000 + min * 1000 + pat))
      if [ "$rank" -gt "$best_rank" ]; then best_rank=$rank; best=v$maj.$min.$pat; fi
    done
    printf '%s\n' "$best"
  }
}

# As root, the base is judged BEFORE anything is created or written in it, and every later step uses its REAL path: a base the account can write (or one that
# leads into a home) would have root unpack into the account's reach, and a link in it that the account re-points between the check and the use would
# do the same.
if [ "$mode" = root ]; then
  probe=$base
  while [ ! -e "$probe" ] && [ "$probe" != / ]; do
    probe=${probe%/*}
    [ -n "$probe" ] || probe=/
  done
  probe_real=$(real_path "$probe") || fail "cannot find the real path of $probe"
  refuse_unfit_place "$probe_real"
fi
mkdir -p "$base" || fail "cannot create $base"
if [ "$mode" = root ]; then
  base=$(real_path "$base") || fail "cannot find the real path of $base"
  refuse_unfit_place "$base"
fi
work=$(mktemp -d "$base/.install.XXXXXXXX") || fail "cannot write into $base"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' INT TERM

release=
if fetch "$dist/index.json" "$work/index.json" "$shasums_timeout"; then
  release=$(select_release "$work/index.json")
  if [ -n "$line" ]; then wanted="Node.js $line.x release"; else wanted="LTS release of Node.js $min_major.$min_minor to $max_major.x"; fi
  [ -n "$release" ] || fail "nodejs.org's list has no $wanted with a build for $os-$arch"
else
  release=$(newest_installed)
  [ -n "$release" ] || fail "could not get the list of Node.js releases from nodejs.org (see above), and there is no Node.js in $base to use instead: check this machine's connection to nodejs.org and paste again"
  say "could not get the list of Node.js releases from nodejs.org: using the Node.js $release that is already installed in $base"
fi

target=$base/$release
if [ -x "$target/bin/node" ] && node_place_is_fit "$target/bin/node" && node_is_usable "$target/bin/node"; then
  say "Node.js $release for the runner is already in $target"
else
  say "installing Node.js $release for the runner into $target (the official build from nodejs.org, checksum checked)"
  archive=node-$release-$os-$arch.tar.gz
  fetch "$dist/$release/SHASUMS256.txt" "$work/SHASUMS256.txt" "$shasums_timeout" || fail "could not get $dist/$release/SHASUMS256.txt: nothing was installed"
  entry=$(grep -E "^[0-9a-f]{64}  $(printf '%s' "$archive" | sed 's/[.]/[.]/g')\$" "$work/SHASUMS256.txt" | head -n 1)
  [ -n "$entry" ] || fail "nodejs.org's SHASUMS256.txt of $release has no $archive"
  sha=${entry%% *}
  fetch "$dist/$release/$archive" "$work/node.tar.gz" "$archive_timeout" || fail "could not download $dist/$release/$archive: nothing was installed"
  got=$(sha256_of "$work/node.tar.gz") || fail "no sha256sum, shasum or openssl on this machine to check the download with: install one and paste again"
  [ "$got" = "$sha" ] || fail "the download of $archive does not match nodejs.org's SHASUMS256.txt (got $got, expected $sha): nothing was installed"
  mkdir "$work/node" || fail "cannot write into $base"
  # `--no-same-owner`: root's files stay root's, never the uid the archive was made with (which could be the account's).
  tar --no-same-owner -xzf "$work/node.tar.gz" -C "$work/node" --strip-components=1 || fail "could not unpack $archive: nothing was installed"
  [ -x "$work/node/bin/node" ] || fail "$archive holds no bin/node: nothing was installed"
  if [ "$mode" = root ]; then
    chmod -R go-w,a+rX "$work/node" || fail "cannot set the rights of the unpacked Node.js"
    chmod 755 "$work/node"
    if [ "$(id -u)" = 0 ]; then chown -R 0:0 "$work/node" || fail "cannot give the unpacked Node.js to root"; fi
  fi
  node_is_usable "$work/node/bin/node" || fail "the Node.js $release that was downloaded does not run on this machine: nothing was installed"
  rm -rf "$target"
  mv "$work/node" "$target" || fail "cannot move the Node.js into $target"
  say "Node.js $release is installed"
fi

r=$(real_path "$target/bin/node") || fail "cannot find the real path of $target/bin/node"
node_place_is_fit "$r" || fail "$unfit_reason"
node_is_usable "$r" || fail "$r does not run, or is older than Node.js $min_major.$min_minor"
printf '%s\n' "$r"
