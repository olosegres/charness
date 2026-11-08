#!/usr/bin/env bash
# charness remote-run — the script that runs ON a runner (never on the main box).
#
# `charness remote-run` uploads this file to <workDir>/bin/runner-<sha8>.sh and calls it over ssh. Every subcommand takes
# the runner's work dir first:   runner.sh <subcommand> <workDir> [arguments…]
# Pueue is reached through PUEUE_BIN / PUEUE_CONFIG (both optional), set by the caller on every call.
#
# A PAIRED runner (`charness-runner`, src/runnerUtility) keeps its work dir as <state>/work in its own state folder; `probe` reads three
# files there and reports them — nothing else in this script knows about pairing. A hand-made runner has none of them:
#   <state>/paused          exists → paused=yes (written by `charness-runner pause`; the main box never sends a job to a paused runner)
#   <state>/service         one word: user-service | system-service (no file = run by hand: service=foreground)
#   <state>/ios-check.json  the runner's iOS Simulator boot check (one JSON line): "status": "pass"|"fail"|"skipped" and "reason": "…"|null
#   <state>/gui/            the login session's agent of an always-on Mac (service=system-service): agent.json is its heartbeat, requests/<id>/ the steps
#                           it runs for a job that needs iOS (`needs-ios` in the job folder) — see «the login session» below
# <state> counts only when it holds config.json and keys/ (a work dir that merely is called «work» is not one).
#
# bash 3.2-compatible on purpose (the stock bash of macOS): no associative arrays, no `wait -n`, no `mapfile`, no
# `timeout(1)`, no `read -t` (its timeout status differs between 3.2 and 4+), no GNU-only flags. Time limits are done by background watchdogs.
#
# Subcommands (the contract is in src/remoteRun/README.md):
#   probe        key=value lines: OS, CPU, RAM, disk, jobs, capabilities (paused / service / iOS boot check of a paired runner); `probe <work> prune`: a view of the runners that may start the background prune of a short disk
#   prepare      layout for a job, Pueue daemon + groups, prune
#   lease        add the job to Pueue, stream its log, kill it when the caller's heartbeat stops (foreground run)
#   submit       add the job to Pueue and return (--bg)
#   job          the Pueue task itself: lock → apply the staged tree → deps → command → result files
#   follow       stream a job's log until it ends (logs -f)
#   wait         block until the job ends
#   result       key=value facts of a job (exit code, phase, markers)
#   meta         the job's meta.json
#   tail         the last N lines of a job's log
#   kill         stop a job: SIGTERM, SIGKILL after 10 s
#   exec         one-off command in the project's copy, leased like a foreground job
#   workdir      the work dir as an absolute path
#   pueue        run Pueue itself with the configured binary and config
#   jobs         the meta.json of every job of a project (or of all), as a JSON array
#   prune        remove old jobs, stale stage dirs, project copies unused for days, and — while the disk is short of free space — the least recently used ones
#   clean        remove ONE project copy on request (`clean <work> <slug>`): refused while a job of it runs or waits, an exec runs in it, a job is being submitted, or a job ended lately whose results nobody fetched; says what it freed
#   simctl-cleanup  `xcrun simctl delete unavailable` on a Mac, bounded; started detached by the probe of a view of the runners at most once a day, never called by hand
#   fetched      mark a finished job's results as fetched (`fetched <work> - <job>`): `wait`, `fetch` and a foreground run say so once they have the files, and `clean` then does not keep the copy for them
#   measure-copies  write down how big each project copy is (p/<slug>/size-kb); `probe` and `prepare` start it detached, it is never called by hand
#   sync-tree    the apply step alone (tests)

# The script's own tools (sort, sed, grep) run in the C locale: byte-wise and the same everywhere. The user's commands do NOT — see job_locale.
LC_ALL=C
export LC_ALL
set -u

# ─────────────────────────── constants ───────────────────────────

kill_grace_sec=10
# After a SIGKILL of a step's group the script looks this many times (0.2 s apart) for a member that is still there before it goes on.
kill_settle_polls=10
pueue_start_wait_sec=8
default_timeout_sec=10800
job_keep_days=3
# A project copy nobody has used for this many days is removed (the runner's config can say another number: REMOTE_RUN_COPY_MAX_IDLE_DAYS).
copy_keep_days=3
stage_keep_days=1
# The free space the work dir's disk should keep: the smaller of this many GiB and this percent of the disk (REMOTE_RUN_MIN_FREE_GB replaces both; 0 = no target).
min_free_cap_gb=60
min_free_percent=15
kib_per_gib=1048576
minutes_per_day=1440
# A job without an exit file and without a task is a submit that is still sending its files: its project copy is in use while its job folder or anything in its
# stage folder was touched this recently (a first upload of a big project goes quiet in the job folder for as long as it takes, but not in the stage folder).
pending_submit_grace_min=30
# The result files of a job that ended this recently are still on their way to whoever submitted it (`wait`, `fetch`): the copy that holds them is in use.
result_keep_min=60
# `prune` runs one at a time per work dir: the lock of the copy-removal step (tmp/prune.lock) is believed while its holder lives and the lock is younger than this.
prune_lock_max_age_min=120
# The age (minutes) after which `check_lock_is_stale` calls a lock stale although its holder lives (a pid can be given to anything); 0 = no limit, as for a project's lock, which a job of any length holds.
# The prune lock sets its own for the length of its calls.
lock_max_age_min=0
# A prune that finds another one at its copy-removal step waits for it this long, looking every prune_poll_sec (then goes on: it never hangs on one).
prune_wait_sec=600
prune_poll_sec=1
# A removal that freed less than this although the copy was measured bigger says the disk's free figure is not following (APFS snapshots, purgeable space): removing more copies would
# empty the runner for nothing, so the prune stops...
no_progress_freed_kb=1048576
# ...but only after this many such removals in a row did that (a copy too small to judge, or never measured, between them is not counted either way): a job writing to the same disk meanwhile can eat the space one removal freed.
no_progress_stop_after=2
# The refusal of a submit names this many of the biggest copies.
refusal_copy_count=3
# `prepare` ends with this exit code when the disk is still short of free space after the prune (28 is ENOSPC); src/remoteRun/pruneReport.ts has the same number.
low_disk_exit_code=28
# Set by the free-space prune (prune_copies_for_space) for the refusal that may follow it, and by the last removal for its report.
prune_stopped_without_gain=0
last_freed_kb=
# Set by probe_slow: 1 when Xcode answered (a Mac that can build for iOS).
probe_has_xcode=0
# `xcrun simctl delete unavailable` (the simulators of runtimes that are gone) is tried at most this often, and given this long.
simctl_cleanup_interval_hours=24
simctl_cleanup_sec=120
# 1 = the caller is a `clean`: a job that ended lately whose results were fetched (the `fetched` mark in its folder) does not keep the copy (the prune does not know that: it keeps it result_keep_min).
clean_ignores_fetched=0
# Set by check_copy_dir_is_busy when it says «in use»: why (lock | exec | running | queued | submitting | results) and which job (`-` when none).
copy_busy_kind=
copy_busy_job=-
drain_interval_sec=0.2
probe_step_sec=4
exit_file_wait_sec=5
task_id_wait_sec=5
heartbeat_poll_sec=1
# How long a job waiting for its project's lock sleeps between two attempts (a test shortens it to race many waiters quickly).
lock_poll_sec=1
# A failed dependencies step names this many of its first error lines (and of its build log's) — few enough that `wait`'s last 50 lines hold them all.
failed_step_error_lines=8
# The login session's agent (`charness-runner gui-agent`) beats every 5 s; one that has not for this long is gone (or the session is).
gui_agent_stale_sec=20
# What makes a line of a tool's output an error line.
error_line_pattern='error|fatal|fail|exception|cannot|couldn|not found|no such|denied'

# ─────────────────────────── helpers ───────────────────────────

# The locale a job's commands run in: a UTF-8 one, never `C`. Tools that read the locale refuse or crash on `C` (CocoaPods: «Unicode Normalization
# not appropriate for ASCII-8BIT»), and a job that wants another one says so with -e LC_ALL=… (the job's variables are applied after this). The first
# of C.UTF-8 (Linux) and en_US.UTF-8 (macOS) that this machine has — judged by the charmap it gives — else C: a machine with neither is no worse.
pick_job_locale() {
  local candidate
  for candidate in C.UTF-8 en_US.UTF-8 en_US.utf8; do
    case $(LC_ALL=$candidate locale charmap 2> /dev/null) in
      [Uu][Tt][Ff]-8 | [Uu][Tt][Ff]8) printf '%s\n' "$candidate"; return 0 ;;
    esac
  done
  printf 'C\n'
}
job_locale=$(pick_job_locale)

die() {
  printf 'remote-run-runner: %s\n' "$*" >&2
  exit 125
}

# Own progress lines of a job, written into its log; the caller shows lines with this prefix on stderr.
say() {
  printf 'remote-run: %s\n' "$*"
}

pq() {
  "${PUEUE_BIN:-pueue}" ${PUEUE_CONFIG:+-c "$PUEUE_CONFIG"} "$@"
}

pueued_bin() {
  if [ -n "${PUEUE_BIN:-}" ] && [ -x "$(dirname "$PUEUE_BIN")/pueued" ]; then
    printf '%s\n' "$(dirname "$PUEUE_BIN")/pueued"
  else
    printf 'pueued\n'
  fi
}

# A name that is safe to use as one path component.
check_name() {
  case $1 in
    '' | *[!A-Za-z0-9._-]* | .*) die "bad name: $1" ;;
  esac
}

# A relative path inside a project: no leading slash, no ".." component.
check_relative_path() {
  case $1 in
    /*) return 1 ;;
  esac
  case "/$1/" in
    */../*) return 1 ;;
  esac
  return 0
}

# Sets work, slug, job and every directory derived from them. A slug of "-" means "the project this job id belongs to" (the commands
# that take only a job id): found by looking for the job's folder.
set_paths() {
  work=$1
  slug=${2:-}
  job=${3:-}
  if [ "$slug" = "-" ] && [ -n "$job" ]; then
    slug=
    local found
    for found in "$work"/p/*/jobs/"$job"; do
      [ -d "$found" ] && slug=$(basename "$(dirname "$(dirname "$found")")") && break
    done
    [ -n "$slug" ] || die "no such job: $job"
  fi
  check_name "$slug"
  proj="$work/p/$slug"
  tree="$proj/tree"
  jobs_dir="$proj/jobs"
  lock="$proj/lock"
  if [ -n "$job" ]; then
    case $job in *[!a-z0-9-]* | -*) die "bad job id: $job" ;; esac
    jd="$jobs_dir/$job"
    stage="$proj/stage/$job"
  fi
}

set_phase() {
  printf '%s\n' "$1" > "$jd/phase"
}

read_file() {
  cat "$1" 2>/dev/null
}

# A Mac that idle-sleeps in the middle of a job drops the link and stalls the build: while the process $1 runs, `caffeinate -i -w` holds
# the idle-sleep assertion and ends by itself with it. A sibling, not a wrapper: the command keeps its own signals and exit status.
# Nothing on other systems, or where caffeinate is missing.
keep_awake_while() {
  [ "$(uname -s)" = Darwin ] && command -v caffeinate > /dev/null 2>&1 || return 0
  caffeinate -i -w "$1" > /dev/null 2>&1 < /dev/null &
}

# ─────────────────────────── the login session (always-on Mac) ───────────────────────────

# A Mac runner kept running by LaunchDaemons has no login session of its own, and Xcode's nested builds crash in the System session the daemons
# run in. The runner account's LaunchAgent (`charness-runner gui-agent`, runnerUtility/guiAgent.ts) runs in the account's GUI session while there
# is one; EVERY job's steps run THERE while it does (`gui_step_uses_agent`), through request folders under <state>/gui/requests/. A job that needs iOS
# (`needs-ios` in its folder, written for `--needs ios`) is refused with the reason when there is none, and `probe` says the same of `ios`; any other job
# then runs in the daemon as before. No auto-login, no guess.

# Does this runner's work go through a login session's agent: a paired runner that is kept running by an always-on service?
gui_session_expected() {
  read_runner_state
  [ -n "$runner_state" ] && [ "$(head -n 1 "$runner_state/service" 2> /dev/null)" = system-service ]
}

# A whole-number field of the agent's heartbeat file (one JSON line).
gui_agent_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$runner_state/gui/agent.json" 2> /dev/null | head -n 1
}

# Is the agent there: its process alive and its heartbeat fresh?
gui_agent_alive() {
  local pid beat now
  pid=$(gui_agent_field pid)
  beat=$(gui_agent_field beatAtMs)
  [ -n "$pid" ] && [ -n "$beat" ] || return 1
  kill -0 "$pid" 2> /dev/null || return 1
  now=$(($(date +%s) * 1000))
  [ $((now - beat)) -le $((gui_agent_stale_sec * 1000)) ]
}

# What a job that needs iOS is told when there is no login session to run it in (also what `probe` says of `ios`). A link that tried to put the agent in place
# itself (runnerUtility/guiAgentHeal.ts) and could not leaves `<cure> <reason>` in <state>/gui/install-failure: `login` — the definition is in place, so the account
# logging out and in loads it — or `admin` — it is not, and only a fresh admin line writes and loads it. A record without a cure word reads as `admin`.
gui_refusal_text() {
  local line cure reason
  line=$(head -n 1 "${runner_state:-}/gui/install-failure" 2> /dev/null | tr -d '[:cntrl:]')
  cure=${line%% *}
  case $line in
    *' '*) reason=${line#* } ;;
    *) reason= ;;
  esac
  case $cure in
    login) printf "ios build: the login session's agent could not be loaded (%s) - log out and back in as %s, or paste a fresh admin line from /runners in an admin account's terminal" "$reason" "$(id -un)" ;;
    admin) printf "ios build: the login session's agent could not be installed (%s) - paste a fresh admin line from /runners in an admin account's terminal" "$reason" ;;
    '') printf 'ios build: needs a login of %s' "$(id -un)" ;;
    *) printf "ios build: the login session's agent could not be installed (%s) - paste a fresh admin line from /runners in an admin account's terminal" "$line" ;;
  esac
}

# Does THIS job need the login session — it needs iOS (`needs-ios`), and the runner is an always-on service? Such a job is refused without one.
gui_job_needs_session() {
  [ -n "${jd:-}" ] && [ -f "$jd/needs-ios" ] && gui_session_expected
}

# Does THIS step go through the agent? On an always-on Mac EVERY job's steps do, while the login session exists (an iOS build is not always marked, and
# the session is what the account's own jobs would see); a job that needs iOS does even when it cannot (its step is cut, never run in the System session);
# any other job, with no session, runs in the daemon as it always did.
gui_step_uses_agent() {
  [ -n "${jd:-}" ] && gui_session_expected && { [ -f "$jd/needs-ios" ] || gui_agent_alive; }
}

# Refuse a job that needs iOS before it is queued when there is no session to run it in.
refuse_without_gui_session() {
  gui_job_needs_session || return 0
  gui_agent_alive || die "$(gui_refusal_text)"
}

# The start time of process $1 as `ps` says it, whitespace squeezed — the way runnerUtility/guiAgent.ts records and compares it (the C locale is this script's own).
gui_process_start() {
  ps -o lstart= -p "$1" 2> /dev/null | tr -s ' \t' ' ' | sed 's/^ //; s/ $//'
}

# Is process group $1 the group of the step whose leader started at $2 (`pgid-start` of the request folder)? The folders live on disk and a pid is handed out again
# — after a reboot, after a wrap — to something unrelated of the account (the Dock, the agent itself). So a recorded id is signalled only while the process with
# that pid still has the recorded start; or while no process has it and the group still has members (a pid is not handed out while a group carries it).
# No recorded start, or no `ps` to ask: not a group to signal.
gui_group_is_recorded() {
  local current
  [ -n "$2" ] && command -v ps > /dev/null 2>&1 || return 1
  current=$(gui_process_start "$1")
  if [ -n "$current" ]; then
    [ "$current" = "$2" ]
    return
  fi
  kill -0 -- "-$1" 2> /dev/null
}

# End the process group of a step the agent started (its id is in the request folder's `pgid`, its leader's start beside it): TERM, and KILL after the grace if
# anything is left. A step is a process group of its own (`setsid`), so an agent that died did not take it down — and the job's lock is released next, to a job
# that would run in the same tree beside an `xcodebuild` still writing into it.
gui_end_step_group() {
  local pgid recorded waited=0
  pgid=$(cat "$1/pgid" 2> /dev/null)
  # `cat`'s own stderr goes to /dev/null: a redirect of `tr`'s input from a file that is not there fails in the shell, before any `2>` of the command applies.
  recorded=$(cat "$1/pgid-start" 2> /dev/null | tr -s ' \t' ' ' | sed 's/^ //; s/ $//')
  case $pgid in '' | *[!0-9]*) return 0 ;; esac
  [ "$pgid" -gt 1 ] || return 0
  gui_group_is_recorded "$pgid" "$recorded" || return 0
  kill -TERM -- "-$pgid" 2> /dev/null || return 0
  while kill -0 -- "-$pgid" 2> /dev/null && [ "$waited" -lt $((kill_grace_sec * 5)) ]; do
    nap 0.2
    waited=$((waited + 1))
  done
  if gui_group_is_recorded "$pgid" "$recorded" && kill -KILL -- "-$pgid" 2> /dev/null; then
    # SIGKILL lands when each process is next scheduled: on a busy machine the group is still there when `kill` returns. The script goes on to release the job's lock, so it
    # waits (bounded) until no member is left — never beside one that is still dying.
    waited=0
    while kill -0 -- "-$pgid" 2> /dev/null && [ "$waited" -lt "$kill_settle_polls" ]; do
      nap 0.2
      waited=$((waited + 1))
    done
    # Past the bound the script cannot wait for ever, but it does not go on silently either: the job's output says a member of the group outlived SIGKILL.
    if kill -0 -- "-$pgid" 2> /dev/null; then
      say "the step's process group ($pgid) is still alive after SIGKILL: the job goes on, and its lock is released, beside it"
    fi
  fi
  return 0
}

# One step of a job, run by the agent in the login session: a request folder it picks up (`go` last), the step's output appended to the job's log by the agent
# itself, the exit code in `exit`. A kill is a `kill` file; the agent kills a step whose job script (`owner`, its start in `owner-start`) is gone.
# A job that needs iOS with no agent beating is refused here — no request is written for an agent that may appear a moment later and start a step nobody
# waits for. The step is cut with 125 when the agent stops, or is another instance than the one asked — and its process group is ended HERE, before the folder
# goes and the job's lock with it, on that path and on the one where a restarted agent answered 125 itself (`cut`); see gui_end_step_group.
gui_run_step() {
  local directory=$1
  local command_text=$2
  if [ -f "$jd/needs-ios" ] && ! gui_agent_alive; then
    say "$(gui_refusal_text)"
    step_code=125
    return 0
  fi
  gui_step_count=$((${gui_step_count:-0} + 1))
  local request="$runner_state/gui/requests/$job.$gui_step_count"
  local started_at
  started_at=$(gui_agent_field startedAtMs)
  rm -rf "$request"
  if ! mkdir -p "$request" 2> /dev/null; then
    say "the login session's agent folder cannot be written ($request)"
    step_code=125
    return 0
  fi
  printf '%s' "$directory" > "$request/cwd"
  printf '%s' "$command_text" > "$request/command"
  printf '%s' "$job_locale" > "$request/locale"
  printf '%s' "$jd/log" > "$request/log"
  printf '%s' "$$" > "$request/owner"
  gui_process_start "$$" > "$request/owner-start"
  if [ -s "$jd/env" ]; then cp "$jd/env" "$request/env"; else : > "$request/env"; fi
  : > "$request/go"
  local looks=0
  while [ ! -f "$request/exit" ]; do
    [ "$killed" -eq 1 ] && [ ! -f "$request/kill" ] && : > "$request/kill"
    looks=$((looks + 1))
    if [ $((looks % 5)) -eq 0 ] && { ! gui_agent_alive || [ "$(gui_agent_field startedAtMs)" != "$started_at" ]; }; then
      say "the login session's agent stopped while this step ran: the step was cut"
      gui_end_step_group "$request"
      step_code=125
      rm -rf "$request"
      return 0
    fi
    nap 0.2
  done
  step_code=$(cat "$request/exit")
  case $step_code in '' | *[!0-9]*) step_code=125 ;; esac
  # A restarted agent cut the step (and told us so): its group got a TERM and gets its KILL after the grace — the job must not go on before it is gone.
  [ -f "$request/cut" ] && gui_end_step_group "$request"
  rm -rf "$request"
}

# ─────────────────────────── probe ───────────────────────────

kb_to_mb() {
  awk -v kb="$1" 'BEGIN { printf "%d", kb / 1024 }'
}

probe_linux() {
  local os_name os_version
  os_name=Linux
  os_version=
  if [ -r /etc/os-release ]; then
    os_name=$(. /etc/os-release; printf '%s' "${NAME:-Linux}")
    os_version=$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")
  fi
  echo "os_name=$os_name"
  echo "os_version=$os_version"
  echo "cpu_model=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo | head -n 1)"
  local threads cores
  threads=$(grep -c '^processor' /proc/cpuinfo)
  cores=$(awk -F: '/^physical id/ { p = $2 } /^core id/ { print p ":" $2 }' /proc/cpuinfo | sort -u | wc -l | tr -d ' ')
  [ "$cores" -gt 0 ] 2> /dev/null || cores=$threads
  echo "cpu_cores=$cores"
  echo "cpu_threads=$threads"
  echo "load=$(cut -d' ' -f1 /proc/loadavg)"
  echo "ram_total_mb=$(kb_to_mb "$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)")"
  echo "ram_free_mb=$(kb_to_mb "$(sed -n 's/^MemAvailable:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)")"
}

probe_darwin() {
  echo "os_name=$(sw_vers -productName 2> /dev/null || echo macOS)"
  echo "os_version=$(sw_vers -productVersion 2> /dev/null)"
  echo "cpu_model=$(sysctl -n machdep.cpu.brand_string 2> /dev/null)"
  echo "cpu_cores=$(sysctl -n hw.physicalcpu 2> /dev/null)"
  echo "cpu_threads=$(sysctl -n hw.logicalcpu 2> /dev/null)"
  echo "load=$(sysctl -n vm.loadavg 2> /dev/null | tr -d '{}' | awk '{ print $1 }')"
  local mem_bytes page_size free_pages
  mem_bytes=$(sysctl -n hw.memsize 2> /dev/null)
  page_size=$(sysctl -n hw.pagesize 2> /dev/null)
  free_pages=$(vm_stat 2> /dev/null | awk '/^Pages (free|inactive|speculative):/ { gsub("\\.", "", $NF); sum += $NF } END { print sum + 0 }')
  echo "ram_total_mb=$(awk -v b="$mem_bytes" 'BEGIN { printf "%d", b / 1048576 }')"
  echo "ram_free_mb=$(awk -v p="$free_pages" -v s="${page_size:-4096}" 'BEGIN { printf "%d", p * s / 1048576 }')"
}

# capability lines: cap_<name>=yes|no and cap_<name>_detail=<words>
probe_android() {
  local acceleration=
  case $(uname -s) in
    Linux) [ -r /dev/kvm ] && [ -w /dev/kvm ] && acceleration=KVM ;;
    Darwin) [ "$(sysctl -n kern.hv_support 2> /dev/null)" = 1 ] && acceleration=HVF ;;
  esac
  local emulator_path=
  local sdk_root
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [ -n "$sdk_root" ] && [ -x "$sdk_root/emulator/emulator" ] && emulator_path="$sdk_root/emulator/emulator" && break
  done
  [ -z "$emulator_path" ] && emulator_path=$(command -v emulator 2> /dev/null || true)
  if [ -n "$acceleration" ] && [ -n "$emulator_path" ]; then
    echo "cap_android=yes"
    echo "cap_android_detail=$acceleration, emulator"
  else
    echo "cap_android=no"
    if [ -z "$acceleration" ] && [ -z "$emulator_path" ]; then
      echo "cap_android_detail=no hardware acceleration, no emulator binary"
    elif [ -z "$acceleration" ]; then
      echo "cap_android_detail=no hardware acceleration (KVM / HVF)"
    else
      echo "cap_android_detail=no emulator binary"
    fi
  fi
}

probe_playwright() {
  local browsers_dir=${PLAYWRIGHT_BROWSERS_PATH:-}
  if [ -z "$browsers_dir" ]; then
    case $(uname -s) in
      Darwin) browsers_dir="$HOME/Library/Caches/ms-playwright" ;;
      *) browsers_dir="$HOME/.cache/ms-playwright" ;;
    esac
  fi
  local found=
  local kind
  for kind in chromium firefox webkit; do
    if ls -d "$browsers_dir/$kind-"* > /dev/null 2>&1; then
      found="${found:+$found, }$kind"
    fi
  done
  if [ -n "$found" ]; then
    echo "cap_playwright=yes"
    echo "cap_playwright_detail=$found"
  else
    echo "cap_playwright=no"
    echo "cap_playwright_detail=no browsers installed"
  fi
}

# Jobs by their files: running = a live job process, queued = submitted and not started, finished = has an exit file.
probe_jobs() {
  local running=0 queued=0
  local active_slugs=
  local job_dir slug pid
  for job_dir in "$work"/p/*/jobs/*/; do
    [ -d "$job_dir" ] || continue
    [ -f "$job_dir/exit" ] && continue
    [ -f "$job_dir/task-id" ] || continue
    slug=$(basename "$(dirname "$(dirname "$job_dir")")")
    pid=$(read_file "$job_dir/pid")
    if [ -n "$pid" ] && check_runner_pid_alive "$pid"; then
      running=$((running + 1))
    elif [ -z "$pid" ]; then
      queued=$((queued + 1))
    else
      continue
    fi
    case " $active_slugs " in
      *" $slug "*) ;;
      *) active_slugs="$active_slugs $slug" ;;
    esac
  done
  local project_count=0
  local counted
  for counted in $active_slugs; do project_count=$((project_count + 1)); done
  echo "jobs_running=$running"
  echo "jobs_queued=$queued"
  echo "jobs_projects=$project_count"
}

# disk_total_mb and disk_min_free_mb (what the runner wants kept free; 0 = no target) from the disk step's "<total kb> <free kb>" ($1), and whether the disk is short of it
# (probe_disk_is_short, acted on by cmd_probe once the slow questions are over).
probe_disk_target() {
  probe_disk_is_short=0
  local total_kb=${1%% *} free_kb=${1##* } target_kb
  case "$total_kb$free_kb" in
    '' | *[!0-9]*) return 0 ;;
  esac
  target_kb=$(get_min_free_kb "$total_kb")
  echo "disk_total_mb=$(kb_to_mb "$total_kb")"
  echo "disk_min_free_mb=$(kb_to_mb "$target_kb")"
  [ "$target_kb" -gt 0 ] && [ "$free_kb" -lt "$target_kb" ] && probe_disk_is_short=1
  return 0
}

# copies_count= / copies_size_mb= / copies_unmeasured= : the project copies, their size from the figures `measure-copies` wrote down (an out-of-date one still counts; the number of copies
# with no figure, or used since their figure was written, is copies_unmeasured). Asking never waits for a `du`: a missing figure starts the measuring detached.
probe_copies() {
  local count=0 total_kb=0 unmeasured=0 copy_dir size_file size_kb
  for copy_dir in "$work"/p/*/; do
    [ -d "$copy_dir" ] || continue
    count=$((count + 1))
    size_file="${copy_dir}size-kb"
    size_kb=$(read_file "$size_file")
    case $size_kb in
      '' | *[!0-9]*) unmeasured=$((unmeasured + 1)) ;;
      *)
        total_kb=$((total_kb + size_kb))
        [ "${copy_dir}used" -nt "$size_file" ] && unmeasured=$((unmeasured + 1))
        ;;
    esac
  done
  echo "copies_count=$count"
  echo "copies_size_mb=$(kb_to_mb "$total_kb")"
  echo "copies_unmeasured=$unmeasured"
  [ "$unmeasured" -gt 0 ] && start_detached_run "$work" measure-copies
  return 0
}

# The probe's slow questions — Pueue, the disk, Xcode and its simulators, Docker — are asked at once, each bounded by probe_step_sec, so
# a hung one costs that much in all, not that much each: the caller gives the whole probe 20 s, and a Mac with a slow simctl, a stalled
# mount and a sleeping Docker would otherwise read as offline. One step: output in $probe_dir/<name>.out, its status in <name>.status
# (137: it was cut off; no file: it never finished).
start_probe_step() {
  local name=$1
  local limit=$2
  shift 2
  (
    "$@" > "$probe_dir/$name.out" 2> /dev/null < /dev/null &
    local command_pid=$!
    ( sleep "$limit"; kill -9 "$command_pid" ) > /dev/null 2>&1 &
    local watchdog_pid=$!
    wait "$command_pid" 2> /dev/null
    echo "$?" > "$probe_dir/$name.status"
    kill "$watchdog_pid" > /dev/null 2>&1
  ) &
}

probe_step_status() {
  read_file "$probe_dir/$1.status"
}

probe_step_output() {
  read_file "$probe_dir/$1.out"
}

# What a tool answered to `--version` (its first line, cut short): `none` when it is not on this PATH — a job that calls it ends with exit 127 —
# and `unknown` when it is there but did not answer in time.
probe_tool_version() {
  local name=$1
  command -v "$name" > /dev/null 2>&1 || { echo none; return 0; }
  if [ "$(probe_step_status "$name")" = 0 ]; then
    probe_step_output "$name" | head -n 1 | cut -c1-40
  else
    echo unknown
  fi
}

# The simulators of OLDER runtimes than the newest of the same platform and major (`iOS 26.5` next to `iOS 27.1` is not older: another major; `iOS 26.4` next to `iOS 26.5` is), from the text of
# `xcrun simctl list devices available` on stdin: `iOS 26.4:11,watchOS 11.0:2` (runtime:devices), nothing when there are none. Only information: nothing here deletes anything.
list_older_simulator_runtimes() {
  awk '
    # The order of two versions of the SAME major (the major is the group, so it is not part of the rank).
    function key(version,   parts, count) {
      count = split(version, parts, ".")
      return (count > 1 ? parts[2] : 0) * 1000 + (count > 2 ? parts[3] : 0)
    }
    /^-- / {
      runtime = ""
      header = $0
      sub(/^-- /, "", header)
      sub(/ --$/, "", header)
      if (match(header, /^[A-Za-z]+ [0-9]+(\.[0-9]+)*/)) {
        runtime = substr(header, RSTART, RLENGTH)
        split(runtime, words, " ")
        split(words[2], numbers, ".")
        group[runtime] = words[1] " " numbers[1]
        rank[runtime] = key(words[2])
        if (!(runtime in listed)) { listed[runtime] = 1; order[++count] = runtime }
        if (!(group[runtime] in newest) || rank[runtime] > newest[group[runtime]]) newest[group[runtime]] = rank[runtime]
      }
      next
    }
    /^ +[^ ].*\([A-Za-z ]+\) *$/ { if (runtime != "") devices[runtime]++ }
    END {
      for (index_ = 1; index_ <= count; index_++) {
        runtime = order[index_]
        if (devices[runtime] > 0 && rank[runtime] < newest[group[runtime]]) {
          output = output (output == "" ? "" : ",") runtime ":" devices[runtime]
        }
      }
      if (output != "") print output
    }
  '
}

probe_slow() {
  mkdir -p "$work/tmp"
  probe_dir="$work/tmp/probe.$$.$RANDOM"
  mkdir -p "$probe_dir" || return 1
  local is_darwin=0
  [ "$(uname -s)" = Darwin ] && is_darwin=1
  local has_docker=0
  command -v docker > /dev/null 2>&1 && has_docker=1
  start_probe_step pueue "$probe_step_sec" "${PUEUE_BIN:-pueue}" ${PUEUE_CONFIG:+-c "$PUEUE_CONFIG"} --version
  start_probe_step disk "$probe_step_sec" df -Pk "$work"
  if [ "$is_darwin" -eq 1 ]; then
    start_probe_step xcode "$probe_step_sec" xcodebuild -version
    start_probe_step simctl "$probe_step_sec" xcrun simctl list devices available
  fi
  [ "$has_docker" -eq 1 ] && start_probe_step docker "$probe_step_sec" docker info
  # The tools of a job as THIS call sees them: the PATH a job runs with is the one of the ssh command that queued it, and so is the probe's.
  # `yarn` may be Corepack's shim, which would fetch a yarn on its first run — never ask it to wait for an answer from the user.
  command -v node > /dev/null 2>&1 && start_probe_step node "$probe_step_sec" node --version
  command -v yarn > /dev/null 2>&1 && start_probe_step yarn "$probe_step_sec" env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn --version
  wait

  echo "disk_free_mb=$(kb_to_mb "$(probe_step_output disk | awk 'NR == 2 { print $4 }')")"
  probe_disk_target "$(probe_step_output disk | awk 'NR == 2 { print $2, $4 }')"
  echo "job_node=$(probe_tool_version node)"
  echo "job_yarn=$(probe_tool_version yarn)"
  if [ "$(probe_step_status pueue)" = 0 ]; then
    echo "pueue=$(probe_step_output pueue | awk '{ print $NF }')"
  else
    echo "pueue=missing"
  fi
  if [ "$is_darwin" -eq 0 ]; then
    echo "cap_ios=no"
    echo "cap_ios_detail=$(uname -s)"
  elif [ "$(probe_step_status xcode)" = 0 ]; then
    local xcode_version
    xcode_version=$(probe_step_output xcode | head -n 1 | sed 's/^Xcode //')
    probe_has_xcode=1
    local older_runtimes
    if gui_session_expected && ! gui_agent_alive; then
      # An always-on Mac runs its iOS work in the account's login session: with none, builds crash (Xcode's nested builds) and the Simulator will not boot.
      echo "cap_ios=no"
      echo "cap_ios_detail=$(gui_refusal_text)"
    elif [ "${ios_boot_status:-}" = failed ]; then
      # Xcode is there, but the runner's own check failed. The Simulator refusing to boot is Apple's rule (none is available outside a login
      # session); any other reason (no runtime installed, the device could not be created) is shown as it is — the login session would be a
      # wrong cure. «the Simulator did not» is `iosBootFailureReasonPrefix` in runnerUtility/iosCheck.ts.
      echo "cap_ios=no"
      case "$ios_boot_detail" in
        "the Simulator did not"*) echo "cap_ios_detail=needs the runner user's login session" ;;
        ?*) echo "cap_ios_detail=the iOS Simulator check failed: $ios_boot_detail" ;;
        *) echo "cap_ios_detail=the iOS Simulator check failed" ;;
      esac
    elif [ -n "$runner_state" ] && [ -z "$ios_boot_status" ]; then
      # A paired runner writes its record every time its link starts: none yet means the check of THIS start is still running, and an
      # answer from an earlier start (another account, another kind of service) must not be offered meanwhile.
      echo "cap_ios=no"
      echo "cap_ios_detail=the iOS Simulator is being checked"
    else
      echo "cap_ios=yes"
      if [ "$(probe_step_status simctl)" = 0 ]; then
        echo "cap_ios_detail=Xcode $xcode_version, $(probe_step_output simctl | grep -c '(Shutdown)\|(Booted)') simulators"
        older_runtimes=$(probe_step_output simctl | list_older_simulator_runtimes)
        [ -z "$older_runtimes" ] || echo "sim_older_runtimes=$older_runtimes"
      else
        # A slow simctl is no reason to say there is no Xcode, nor to invent a simulator count.
        echo "cap_ios_detail=Xcode $xcode_version"
      fi
    fi
  else
    echo "cap_ios=no"
    if [ "$(probe_step_status xcode)" = 137 ] || [ -z "$(probe_step_status xcode)" ]; then
      echo "cap_ios_detail=Xcode did not answer in time"
    else
      echo "cap_ios_detail=Xcode not found"
    fi
  fi
  if [ "$has_docker" -eq 0 ]; then
    echo "cap_docker=no"
    echo "cap_docker_detail=docker not installed"
  elif [ "$(probe_step_status docker)" = 0 ]; then
    echo "cap_docker=yes"
    echo "cap_docker_detail="
  else
    echo "cap_docker=no"
    echo "cap_docker_detail=daemon not reachable"
  fi
  rm -rf "$probe_dir"
}

# The state folder of the charness-runner this work dir belongs to (sets runner_state; empty for a hand-made runner), and what it says
# about the machine: sets ios_boot_status (ok | failed | unchecked, empty off a Mac or without a check) and ios_boot_detail.
read_runner_state() {
  runner_state=
  ios_boot_status=
  ios_boot_detail=
  local candidate
  candidate=$(dirname "$work")
  [ "$(basename "$work")" = work ] && [ -f "$candidate/config.json" ] && [ -d "$candidate/keys" ] || return 0
  runner_state=$candidate
  local check="$runner_state/ios-check.json"
  [ -f "$check" ] || return 0
  if grep -q '"status"[[:space:]]*:[[:space:]]*"pass"' "$check"; then
    ios_boot_status=ok
  elif grep -q '"status"[[:space:]]*:[[:space:]]*"fail"' "$check"; then
    ios_boot_status=failed
  else
    ios_boot_status=unchecked
  fi
  ios_boot_detail=$(sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$check" | head -n 1)
}

# awake= (caffeinate | systemd-inhibit | no) and awake_detail= of a paired runner: how its link keeps the machine awake, from `<state>/awake` (one line,
# `<method> <holder pid>` or `none <reason>`; runnerUtility/keepAwake.ts). A holder that is gone is `no`, whatever the file says; no file (a link of an older
# version, or none ever started) says nothing.
probe_awake() {
  local awake_file="$runner_state/awake" method detail
  [ -f "$awake_file" ] || return 0
  read -r method detail < "$awake_file"
  case $method in
    caffeinate | systemd-inhibit)
      case $detail in
        '' | *[!0-9]*) echo "awake=no"; echo "awake_detail=the state of the sleep assertion is unreadable" ;;
        *)
          if kill -0 "$detail" 2> /dev/null; then
            echo "awake=$method"
          else
            echo "awake=no"
            echo "awake_detail=the $method process of the link is gone"
          fi
          ;;
      esac
      ;;
    none)
      echo "awake=no"
      echo "awake_detail=$detail"
      ;;
  esac
}

# paused= / service= / runner_version= / ios_boot= / awake= of a paired runner (nothing for a hand-made one).
probe_runner_state() {
  [ -n "$runner_state" ] || return 0
  if [ -f "$runner_state/paused" ]; then echo "paused=yes"; else echo "paused=no"; fi
  local service
  service=$(head -n 1 "$runner_state/service" 2> /dev/null)
  case $service in
    user-service | system-service) echo "service=$service" ;;
    '') echo "service=foreground" ;;
    *) echo "service=unknown" ;;
  esac
  echo "runner_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runner_state/current/package.json" 2> /dev/null | head -n 1)"
  [ -n "$ios_boot_status" ] && echo "ios_boot=$ios_boot_status"
  [ -n "$ios_boot_detail" ] && echo "ios_boot_detail=$ios_boot_detail"
  probe_awake
  return 0
}

cmd_probe() {
  work=$1
  # $2 = `prune`: the caller is a VIEW of the runners (`remote-run runners`, the bot's /runners) and may start the background prune on a short disk. The probe that picks a runner for a run or an `exec`
  # never does: that prune has no copy to keep, and the project about to be used is typically the least recently used one — the very one it would take before the job's own `prepare` arrives.
  probe_may_prune=${2:-}
  mkdir -p "$work" 2> /dev/null
  read_runner_state
  echo "os=$(uname -s)"
  echo "arch=$(uname -m)"
  echo "kernel=$(uname -r)"
  case $(uname -s) in
    Linux) probe_linux ;;
    Darwin) probe_darwin ;;
  esac
  probe_has_xcode=0
  probe_slow
  # A Mac with Xcode forgets the simulators of runtimes that are gone, when a view of the runners asks (a run or an `exec` never waits for it: it is started detached, and at most once a day).
  [ "$probe_has_xcode" -eq 1 ] && [ "$probe_may_prune" = prune ] && start_simctl_cleanup_if_due
  # A disk short of free space frees itself, when a view of the runners asks for it: the prune runs detached (a probe must answer in seconds, removing a copy takes minutes).
  [ "${probe_disk_is_short:-0}" -eq 1 ] && [ "$probe_may_prune" = prune ] && start_detached_run "$work" prune
  probe_copies
  probe_jobs
  probe_android
  probe_playwright
  probe_runner_state
}

# ─────────────────────────── pueue ───────────────────────────

# Start the daemon once when it does not answer, with its output away from the ssh channel (it would keep the call open).
ensure_pueued() {
  if pq status > /dev/null 2>&1; then
    return 0
  fi
  "$(pueued_bin)" ${PUEUE_CONFIG:+-c "$PUEUE_CONFIG"} -d > /dev/null 2>&1 < /dev/null
  local started=$SECONDS
  while [ $((SECONDS - started)) -lt "$pueue_start_wait_sec" ]; do
    pq status > /dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# groups = "name=parallel,name=parallel"
apply_groups() {
  printf '%s\n' "$1" | tr ',' '\n' | while IFS= read -r pair; do
    name=${pair%%=*}
    parallel=${pair#*=}
    [ -n "$name" ] || continue
    [ "$name" = default ] || pq group add "$name" > /dev/null 2>&1
    pq parallel -g "$name" "$parallel" > /dev/null 2>&1
  done
}

# ─────────────────────────── prepare / prune ───────────────────────────

cmd_prepare() {
  set_paths "$1" "$2" "$3"
  local groups=${4:-}
  # Ids are 30 random bits, made on the caller's side: a clash would make two jobs share one folder.
  if [ -e "$jd/meta.json" ] || [ -e "$jd/task-id" ]; then
    die "job id already in use: $job"
  fi
  mkdir -p "$work/bin" "$tree" "$proj/stage" "$jobs_dir" "$stage" "$jd" || die "cannot create the layout under $work"
  : > "$jd/log"
  touch "$proj/used"
  if ! ensure_pueued; then
    die "Pueue daemon is not reachable and could not be started (check PUEUE_BIN / the pueue settings of this runner)"
  fi
  apply_groups "$groups"
  # The caller may hang up while this removes copies for minutes (its call has a time limit): writing a report line to a closed pipe is no reason to die half-way (SIGPIPE would end the removal after
  # the copy it is at). Only here: elsewhere a closed pipe still ends a pipeline early, as it should.
  trap '' PIPE
  prune_work "$work" "$slug"
  trap - PIPE
  # A prune that ran at the same moment may have taken the folder this job was just given (its copy looked unused): say so, never answer with a folder that is gone.
  [ -d "$jd" ] || die "the project copy was being removed while this job was prepared — submit again"
  # Before the refusal, so that the next submit has sizes to name.
  start_detached_run "$work" measure-copies
  refuse_when_disk_is_short
  echo "work=$(cd "$work" && pwd -P)"
}

# Has the job in folder $1 ended? It wrote its exit file; or it never got a Pueue task (its submit failed half-way); or its process is
# gone (a runner script of an earlier version SIGKILLed it without recording that). One that waits in the queue, or runs, has not.
check_job_dir_ended() {
  [ -f "$1/exit" ] && return 0
  [ -f "$1/task-id" ] || return 0
  local recorded_pid
  recorded_pid=$(read_file "$1/pid")
  [ -n "$recorded_pid" ] && ! check_runner_pid_alive "$recorded_pid"
}

# Is Pueue's task number $1 the task of job $2? Pueue hands a number it has freed (a task that was removed, or cleaned) to the next task
# added, and `pueue wait` / `pueue remove` of a number act on whoever holds it — so a job's recorded number is only good while the task
# under it carries the job's own label. The label filter is Pueue's (`status --json label=…`: an exact match), the answer the task's id.
check_task_belongs_to_job() {
  pq status --json "label=rr-$2" 2> /dev/null | grep -Eq "\"$1\": ?\{ ?\"id\": ?$1[,}]"
}

# Remove: jobs older than the keep time (and their Pueue tasks), leftover stage dirs, project copies unused for long. $3 = `skip`: when another prune is at the copy-removal step,
# leave that step to it (the probe's detached prune); otherwise wait for it, bounded (a submit's: it needs the disk's free figure AFTER the other one is done).
prune_work() {
  local work_dir=$1
  local keep_slug=${2:-}
  local when_busy=${3:-wait}
  [ -d "$work_dir/p" ] || return 0
  find "$work_dir/p" -mindepth 3 -maxdepth 3 -path '*/jobs/*' -type d -mtime +"$job_keep_days" 2> /dev/null | while IFS= read -r old_job; do
    check_job_dir_ended "$old_job" || continue
    task=$(read_file "$old_job/task-id")
    if [ -n "$task" ] && [ ! -f "$old_job/task-removed" ] && check_task_belongs_to_job "$task" "$(basename "$old_job")"; then
      pq remove "$task" > /dev/null 2>&1
    fi
    rm -rf "$old_job"
  done
  find "$work_dir/p" -mindepth 3 -maxdepth 3 -path '*/stage/*' -type d -mtime +"$stage_keep_days" 2> /dev/null | while IFS= read -r old_stage; do
    # A job that is queued in Pueue (a task, no exit yet) has not applied its stage: behind a busy group it can wait for days.
    check_job_dir_ended "$(dirname "$(dirname "$old_stage")")/jobs/$(basename "$old_stage")" || continue
    rm -rf "$old_stage"
  done
  # Lease state of a watcher that was killed hard (a live one rewrites its beat every few seconds, so its folder is never this old).
  find "$work_dir/tmp" -mindepth 1 -maxdepth 1 -mtime +"$stage_keep_days" 2> /dev/null | while IFS= read -r old_lease; do
    rm -rf "$old_lease"
  done
  begin_copy_removal "$work_dir" "$when_busy" || return 0
  remove_leftover_trash "$work_dir"
  prune_idle_copies "$work_dir" "$keep_slug"
  prune_copies_for_space "$work_dir" "$keep_slug"
  end_copy_removal "$work_dir"
}

cmd_prune() {
  prune_work "$1" "" skip
}

# ─────────────────────────── project copies: age, free space, size ───────────────────────────

# The settings a runner's config can replace arrive in the environment of every call (the main box sets them from runners.json / the registry); a
# value that is not a plain number is the same as none.
get_copy_keep_days() {
  case ${REMOTE_RUN_COPY_MAX_IDLE_DAYS:-} in
    '' | *[!0-9]*) ;;
    *) [ "$((10#$REMOTE_RUN_COPY_MAX_IDLE_DAYS))" -gt 0 ] && { printf '%s\n' "$((10#$REMOTE_RUN_COPY_MAX_IDLE_DAYS))"; return 0; } ;;
  esac
  printf '%s\n' "$copy_keep_days"
}

# disk_total_kb and disk_free_kb of the disk under directory $1 (`df -Pk`: 1024-byte blocks, the same layout on Linux and macOS); both empty when df says nothing usable.
read_disk_kb() {
  local line
  line=$(df -Pk "$1" 2> /dev/null | awk 'NR == 2 { print $2, $4 }')
  disk_total_kb=${line%% *}
  disk_free_kb=${line##* }
  case "$disk_total_kb$disk_free_kb" in
    '' | *[!0-9]*) disk_total_kb=; disk_free_kb= ;;
  esac
}

# The free space (KiB) the disk should keep, given its total size $1; 0 = no target.
get_min_free_kb() {
  case ${REMOTE_RUN_MIN_FREE_GB:-} in
    '' | *[!0-9]*) ;;
    *) printf '%s\n' "$((10#$REMOTE_RUN_MIN_FREE_GB * kib_per_gib))"; return 0 ;;
  esac
  local cap_kb=$((min_free_cap_gb * kib_per_gib))
  local share_kb=$(($1 * min_free_percent / 100))
  if [ "$share_kb" -lt "$cap_kb" ]; then printf '%s\n' "$share_kb"; else printf '%s\n' "$cap_kb"; fi
}

# Is the disk under directory $1 short of its free-space target? Sets disk_total_kb, disk_free_kb and min_free_kb; false when the target is off or the disk unreadable.
check_disk_is_short() {
  read_disk_kb "$1"
  [ -n "$disk_free_kb" ] || return 1
  min_free_kb=$(get_min_free_kb "$disk_total_kb")
  [ "$min_free_kb" -gt 0 ] && [ "$disk_free_kb" -lt "$min_free_kb" ]
}

# Is process $1 alive AND one of this script's own (`bash …/runner-<hash>.sh …`, or `…/runner.sh` run from a checkout)? A pid written into a job folder, a lock, a marker, a trash name or a pid file outlives its
# process, and after a crash or a reboot the number may belong to a daemon: `kill -0` alone would keep a copy "in use" for good, a project's queue stuck behind a lock no job holds, and a `kill` would signal a
# stranger. The name is matched as the script's exact file name — `runner-<8 hex>.sh` (what `runnerClient.ts` uploads; any version counts) or `runner.sh` — as the LAST path component: a `case` pattern's `*` also
# crosses `/`, so a looser `*/runner-*.sh` would take `…/runner-01/runsvc.sh` (a self-hosted GitHub runner's service, long-lived on a build Mac) for ours. `ps -ww` asks for the whole command line: procps cuts
# the column to an exported `$COLUMNS` even into a pipe, and a cut line would read a LIVE job, lock holder or exec as a stranger. A `ps` that cannot answer (not there, or a BusyBox one that rejects `-ww`, `-p` or
# `-o command=`) says nothing about the process that `kill -0` just saw alive: it counts as alive.
check_runner_pid_alive() {
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2> /dev/null || return 1
  command -v ps > /dev/null 2>&1 || return 0
  local command_line
  command_line=$(ps -ww -p "$1" -o command= 2> /dev/null) || return 0
  [ -n "$command_line" ] || return 0
  case $command_line in
    */runner-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].sh | */runner-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].sh[\ \;]* | */runner.sh | */runner.sh[\ \;]*) return 0 ;;
  esac
  return 1
}

# Is the project copy in folder $1 in use — never to be removed? Its lock is held by a live job; or an `exec` runs in it (`exec.<pid>`: exec takes no lock and leaves no job folder, so it writes this
# marker, and a marker of a process that is gone is cleared); or a job of it waits or runs; or a job ended less than result_keep_min ago (its result files are about to be fetched); or a job of
# it is being submitted (no task yet, no exit, and its job folder or its stage folder touched less than pending_submit_grace_min ago: a long upload only moves files in the stage folder).
# When it is, copy_busy_kind (exec | running | queued | submitting | results | lock — the most telling first) and copy_busy_job (the job id, or `-`) say why: `clean` tells its caller.
check_copy_dir_is_busy() {
  local copy_dir=$1
  copy_busy_kind=
  copy_busy_job=-
  local marker marker_pid
  for marker in "$copy_dir"/exec.*; do
    [ -e "$marker" ] || continue
    marker_pid=${marker##*/exec.}
    case $marker_pid in '' | *[!0-9]*) continue ;; esac
    if check_runner_pid_alive "$marker_pid"; then
      copy_busy_kind=exec
      return 0
    fi
    rm -f "$marker"
  done
  local job_dir job_name
  for job_dir in "$copy_dir"/jobs/*/; do
    [ -d "$job_dir" ] || continue
    job_name=$(basename "$job_dir")
    if [ -f "$job_dir/exit" ]; then
      # A job that ended lately has its result files and log here until whoever submitted it has fetched them: `wait`, `fetch` and a foreground run leave the `fetched` mark when they have. A `clean` believes the mark
      # (it was asked for this copy), the prune does not look for it (it only guesses).
      if [ -n "$(find "$job_dir/exit" -maxdepth 0 -mmin -"$result_keep_min" 2> /dev/null)" ] && ! { [ "$clean_ignores_fetched" -eq 1 ] && [ -f "$job_dir/fetched" ]; }; then
        copy_busy_kind=results
        copy_busy_job=$job_name
        return 0
      fi
      continue
    fi
    if ! check_job_dir_ended "$job_dir"; then
      copy_busy_kind=queued
      [ -n "$(read_file "$job_dir/pid")" ] && copy_busy_kind=running
      copy_busy_job=$job_name
      return 0
    fi
    # No task yet, no exit: a submit that is still sending its files looks like this; a job nobody touched for a while is one that failed half-way.
    if [ -n "$(find "$job_dir" -maxdepth 0 -mmin -"$pending_submit_grace_min" 2> /dev/null)" ] ||
      [ -n "$(find "$copy_dir/stage/$job_name" -cmin -"$pending_submit_grace_min" 2> /dev/null | head -n 1)" ]; then
      copy_busy_kind=submitting
      copy_busy_job=$job_name
      return 0
    fi
  done
  # The lock is looked at LAST: a job that runs holds it, and «job X is running» says more than «its lock is held by X». What is left is a lock whose holder shows in no job folder.
  if [ -e "$copy_dir/lock" ] && ! ( lock="$copy_dir/lock"; jobs_dir="$copy_dir/jobs"; check_lock_is_stale ); then
    local holder_pid holder_job
    read_lock_holder "$copy_dir/lock"
    copy_busy_kind=lock
    copy_busy_job=${holder_job:--}
    return 0
  fi
  return 1
}

# The same for slug $2 under work dir $1. A name that is not a plain slug is not ours to judge: it counts as in use.
check_copy_is_busy() {
  case $2 in
    '' | *[!A-Za-z0-9._-]* | .*) copy_busy_kind=name; copy_busy_job=-; return 0 ;;
  esac
  check_copy_dir_is_busy "$1/p/$2"
}

# The copy-removal step is one at a time per work dir: of copies being removed by a prune that is still at it, a second prune would remove more than needed (the disk's free figure moves only when the
# first one's `rm` ends) and `rm` the same folders. Its lock is `tmp/prune.lock`, made and broken by the project lock's own helpers (`create_lock_file`: the exclusive create, so the creator wins whatever the
# clocks say; `check_lock_is_stale`; `break_stale_lock`: the generation-numbered right to break) — here with no job (`job` empty), `lock_max_age_min` set so a holder that has been at it for hours does not count
# (a pid can be given to anything), and the pid test being `check_runner_pid_alive`. Fails when the lock is held, or when another process is breaking a stale one (it looks again soon). The project lock's
# proof of the break (a named holder is gone for good) covers a holder that is gone; a lock broken for its AGE has a live holder, so there a holder that ends at that very moment can have its lock replaced by a
# new one that is then removed: two prunes at once for a few milliseconds after a two-hour hold, which `remove_and_report_copy` tolerates (a copy that is already gone is code 2).
acquire_prune_lock() {
  local lock="$1/tmp/prune.lock" jobs_dir= job= lock_max_age_min=$prune_lock_max_age_min
  while ! create_lock_file "$lock"; do
    check_lock_is_stale && break_stale_lock && continue
    return 1
  done
  # The rights to break the lock name holders that are gone and can never hold it again: nothing needs them any more.
  rm -f "$lock".breaking.* 2> /dev/null
  return 0
}

# Take the copy-removal step. A prune that finds another at it leaves the step (and says so by failing) when $2 is `skip`, or when it is `wait` and its own disk is not short (what the other one does is
# what the idle copies need); else (`wait` on a short disk, and `always`: a `clean`, which was asked for this very copy and has no disk to judge by) it waits for it, up to prune_wait_sec, and then goes on
# without the lock: it never hangs on one.
begin_copy_removal() {
  local work_dir=$1 when_busy=$2
  mkdir -p "$work_dir/tmp" 2> /dev/null
  local waited_since=$SECONDS
  until acquire_prune_lock "$work_dir"; do
    if [ "$when_busy" = skip ]; then return 1; fi
    if [ "$when_busy" = wait ] && ! check_disk_is_short "$work_dir"; then return 1; fi
    [ $((SECONDS - waited_since)) -ge "$prune_wait_sec" ] && return 0
    ( trap '' TERM; exec sleep "$prune_poll_sec" )
  done
  return 0
}

# Give the lock back — only if it is still this process's own (a prune that went on after its wait never had it).
end_copy_removal() {
  local holder_pid holder_job
  read_lock_holder "$1/tmp/prune.lock"
  [ "$holder_pid" = "$$" ] && rm -f "$1/tmp/prune.lock"
  return 0
}

# A removal that was cut off (ssh dropped, the machine slept) leaves its folder under a `.trash-<slug>-<pid>` name: the next prune finishes it — unless the pid of the one that made it still lives
# (it is at it), or the folder holds something in use (a copy that got busy as it was moved aside and could not be put back).
remove_leftover_trash() {
  local leftover
  for leftover in "$1"/p/.trash-*; do
    [ -e "$leftover" ] || continue
    finish_trash_removal "$leftover"
  done
  return 0
}

# Finish the removal of the moved-aside folder $1 (`p/.trash-<slug>-<pid>`). Returns 0 gone · 1 its remover still lives (it is at it) · 2 something in it is in use (left as it is; copy_busy_kind says what) · 3 it would not go.
finish_trash_removal() {
  local leftover=$1
  check_runner_pid_alive "${leftover##*-}" && return 1
  check_copy_dir_is_busy "$leftover" && return 2
  remove_path_even_if_read_only "$leftover" || return 3
}

# Is $1 the moved-aside folder of project copy $2 — `p/.trash-<slug>-<pid>` with a number for the pid (another slug that starts with this one's name is not)?
check_is_trash_of_slug() {
  case ${1##*/} in
    .trash-"$2"-*) ;;
    *) return 1 ;;
  esac
  case ${1##*/.trash-"$2"-} in
    '' | *[!0-9]*) return 1 ;;
  esac
}

# Remove the path $1 (a folder, a file, a link) however read-only it is. A link goes as the link, never followed. The folders CocoaPods' xcframeworks leave read-only stop `rm`, so a tree is made writable first, and a
# read-only parent is the last resort. Succeeds when nothing is left there.
remove_path_even_if_read_only() {
  local target=$1
  [ -L "$target" ] || chmod -R u+rwX "$target" 2> /dev/null
  rm -rf "$target" 2> /dev/null
  if [ -e "$target" ] || [ -L "$target" ]; then
    chmod u+w "$(dirname "$target")" 2> /dev/null
    rm -rf "$target" 2> /dev/null
  fi
  [ ! -e "$target" ] && [ ! -L "$target" ]
}

# Remove project copy $2 (a slug) under work dir $1. Moved aside by one rename first: a submit that meets the name afterwards makes a copy of its own, and a removal that is cut off is finished by the
# next prune. The busy check that chose the copy and the rename are two steps, and a job can be prepared between them — so it is asked AGAIN of the moved folder, and a copy that turned out in use is put back.
# Returns: 0 removed · 1 would not go · 2 gone already (another prune took it) · 3 in use after all (put back when its name is still free; else left under its trash name, which is never removed while it is in use).
remove_project_copy() {
  local source="$1/p/$2" trash="$1/p/.trash-$2-$$"
  [ -e "$trash" ] && return 1
  if ! mv "$source" "$trash" 2> /dev/null; then
    [ -e "$source" ] && return 1
    return 2
  fi
  if check_copy_dir_is_busy "$trash"; then
    if [ ! -e "$source" ]; then
      mv "$trash" "$source" 2> /dev/null
      # A `prepare` can make the folder between the test and the `mv`, which then moves the copy INTO it: out again, to where the next prune looks for trash (and where its markers are seen).
      [ -e "$source/${trash##*/}" ] && mv "$source/${trash##*/}" "$trash" 2> /dev/null
    fi
    return 3
  fi
  remove_path_even_if_read_only "$trash" || return 1
}

# last_freed_kb = how much the disk under $1 has gained since it had $2 KiB free (0 when it did not grow; empty when df said nothing).
set_freed_kb_since() {
  local work_dir=$1 before_kb=$2
  last_freed_kb=
  read_disk_kb "$work_dir"
  if [ -n "$before_kb" ] && [ -n "$disk_free_kb" ]; then
    last_freed_kb=$((disk_free_kb - before_kb))
    [ "$last_freed_kb" -ge 0 ] || last_freed_kb=0
  fi
}

# Remove copy $2 for reason $3 (idle | space | clean) and say so on stdout, one line the submit shows: `removed=<slug> freed_kb=<n> why=<reason>`; a copy that would not go: `stuck=<slug>`; one that
# an earlier prune took, or that turned out in use, is not said anything of. freed_kb is the change of the disk's free space across the removal (empty when df said nothing).
# Sets last_freed_kb. Returns remove_project_copy's code.
remove_and_report_copy() {
  local work_dir=$1 copy_slug=$2 reason=$3
  local before_kb removal_code
  read_disk_kb "$work_dir"
  before_kb=$disk_free_kb
  remove_project_copy "$work_dir" "$copy_slug"
  removal_code=$?
  case $removal_code in
    0)
      set_freed_kb_since "$work_dir" "$before_kb"
      printf 'removed=%s freed_kb=%s why=%s\n' "$copy_slug" "$last_freed_kb" "$reason"
      ;;
    1) printf 'stuck=%s\n' "$copy_slug" ;;
  esac
  return "$removal_code"
}

# Project copies unused for copy_keep_days (the runner's setting, else the default) are removed, unless in use or the copy of the job being submitted.
prune_idle_copies() {
  local work_dir=$1 keep_slug=$2
  local idle_minutes=$(($(get_copy_keep_days) * minutes_per_day))
  local used_file idle_slug
  while IFS= read -r used_file; do
    idle_slug=$(basename "$(dirname "$used_file")")
    [ "$idle_slug" = "$keep_slug" ] && continue
    check_copy_is_busy "$work_dir" "$idle_slug" && continue
    remove_and_report_copy "$work_dir" "$idle_slug" idle || true
  done < <(find "$work_dir/p" -mindepth 2 -maxdepth 2 -name used -type f -mmin +"$idle_minutes" 2> /dev/null)
}

# While the disk is short of free space, remove the project copies that were used longest ago, one by one, until it is not — except copies in use and the copy of the job being submitted.
# Stops, with a `stopped=` line, after no_progress_stop_after removals in a row that each freed next to nothing from a copy measured bigger: the disk's free figure is not following the removals
# (a Mac's APFS keeps the space of deleted files while Time Machine local snapshots hold it), and going on would remove every copy and refuse anyway; one such removal is not enough to say so
# (a job writing to the same disk meanwhile can eat the space it freed). «In a row» counts only the removals that can say anything: a copy measured at most no_progress_freed_kb, or not measured, between two
# of them neither counts nor resets the count; a removal that freed what it should does reset it. Sets prune_stopped_without_gain for the submit's refusal.
prune_copies_for_space() {
  local work_dir=$1 keep_slug=$2
  local used_file lru_slug size_kb removal_code no_gain_removals=0
  prune_stopped_without_gain=0
  while IFS= read -r used_file; do
    check_disk_is_short "$work_dir" || break
    lru_slug=$(basename "$(dirname "$used_file")")
    [ "$lru_slug" = "$keep_slug" ] && continue
    check_copy_is_busy "$work_dir" "$lru_slug" && continue
    size_kb=$(read_file "$work_dir/p/$lru_slug/size-kb")
    remove_and_report_copy "$work_dir" "$lru_slug" space
    removal_code=$?
    [ "$removal_code" -eq 0 ] || continue
    # Only a copy measured bigger than the threshold says anything about whether the disk follows: one too small or never measured leaves the count as it is (an LRU order of big, small, big, small
    # must not hide a disk that keeps every big copy's space); a removal that freed what it should resets it.
    case "$size_kb:$last_freed_kb" in
      *[!0-9:]* | : | :* | *:) continue ;;
    esac
    [ "$size_kb" -gt "$no_progress_freed_kb" ] || continue
    if [ "$last_freed_kb" -ge "$no_progress_freed_kb" ]; then
      no_gain_removals=0
      continue
    fi
    no_gain_removals=$((no_gain_removals + 1))
    if [ "$no_gain_removals" -ge "$no_progress_stop_after" ]; then
      printf 'stopped=%s freed_kb=%s size_kb=%s\n' "$lru_slug" "$last_freed_kb" "$size_kb"
      prune_stopped_without_gain=1
      break
    fi
  done < <(ls -1tr "$work_dir"/p/*/used 2> /dev/null)
}

# KiB project copy $2 (a slug, under work dir $1) takes, per mode $3: `written` = the figure `measure-copies` wrote into the copy (size-kb), whatever its age, and failure when there is none (never a `du`);
# `current` = that figure unless the copy was used after it was written (then, and when there is none, measured now with `du -sk` and written down — a copy is measured again only when it was used,
# not by the clock: a `du` over millions of files is not something to repeat hourly for copies nobody touched). Fails when the copy cannot be measured.
read_copy_size_kb() {
  local size_file="$1/p/$2/size-kb" size_kb=
  if [ -f "$size_file" ] && { [ "$3" = written ] || ! [ "$1/p/$2/used" -nt "$size_file" ]; }; then
    size_kb=$(read_file "$size_file")
  fi
  case $size_kb in
    '' | *[!0-9]*)
      [ "$3" = written ] && return 1
      size_kb=$(du -sk "$1/p/$2" 2> /dev/null | awk '{ print $1 }')
      case $size_kb in '' | *[!0-9]*) return 1 ;; esac
      { printf '%s\n' "$size_kb" > "$size_file.tmp.$$" && mv "$size_file.tmp.$$" "$size_file"; } 2> /dev/null
      ;;
  esac
  printf '%s\n' "$size_kb"
}

# `5 GB` / `41 GB` / `0.4 GB` for KiB $1 (the words `formatGigabytes` in probe.ts uses).
format_kb_as_gb() {
  awk -v kb="$1" 'BEGIN { g = kb / 1048576; if (g >= 10) printf "%d GB", g + 0.5; else printf "%g GB", int(g * 10 + 0.5) / 10 }'
}

# The submit's refusal when the disk is still short after the prune: free, needed, the biggest copies, the way out. One line on stderr, exit low_disk_exit_code. It never measures anything (a `du` of
# copies of tens of GB would make the refusal that is meant to come at once take minutes): it names the copies whose size was written down and counts the others.
refuse_when_disk_is_short() {
  check_disk_is_short "$work" || return 0
  # This submit goes no further: take back what `prepare` made for it (a project that has nothing else in it, its first submit, goes away with it).
  rm -rf "$jd" "$stage"
  rmdir "$proj/stage" "$jobs_dir" "$tree" 2> /dev/null
  [ -z "$(ls -A "$proj" 2> /dev/null | grep -v -x -e used -e size-kb)" ] && rm -rf "$proj"
  local copy_dir copy_slug size_kb sizes= listing= copies=0 unmeasured=0
  for copy_dir in "$work"/p/*/; do
    [ -d "$copy_dir" ] || continue
    copies=$((copies + 1))
    copy_slug=$(basename "$copy_dir")
    if size_kb=$(read_copy_size_kb "$work" "$copy_slug" written); then
      sizes="$sizes$size_kb $copy_slug"$'\n'
    else
      unmeasured=$((unmeasured + 1))
    fi
  done
  while read -r size_kb copy_slug; do
    listing="${listing:+$listing, }$copy_slug $(format_kb_as_gb "$size_kb")"
  done < <(printf '%s' "$sizes" | sort -rn | head -n "$refusal_copy_count")
  local advice="there is no project copy here to free: the disk is full of other files"
  if [ "$copies" -gt 0 ]; then
    advice="free space with \`charness remote-run clean <slug>\` on the copies of project folders whose last task is closed (\`charness remote-run runners\` shows what they take)"
    local also_unmeasured=
    [ "$unmeasured" -gt 0 ] && also_unmeasured=" (and $unmeasured not measured yet)"
    [ -n "$listing" ] && advice="biggest project copies: $listing$also_unmeasured; $advice"
    [ -z "$listing" ] && advice="$copies project copies, their sizes are still being measured; $advice"
    [ "$prune_stopped_without_gain" -eq 1 ] && advice="$advice. Removing copies did not give their space back (on a Mac: APFS local snapshots or purgeable space; anywhere: jobs writing meanwhile, see docs/remote-run.md)"
  fi
  printf 'remote-run-runner: only %s free on the work disk, the runner needs %s; %s\n' "$(format_kb_as_gb "$disk_free_kb")" "$(format_kb_as_gb "$min_free_kb")" "$advice" >&2
  exit "$low_disk_exit_code"
}

get_script_path() {
  printf '%s\n' "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
}

# Run subcommand $2 of this script on work dir $1 detached (output and input away, so an ssh call that started it returns), unless a run of it is still going.
start_detached_run() {
  local work_dir=$1 subcommand=$2
  local pid_file="$work_dir/tmp/$subcommand.pid" running_pid
  mkdir -p "$work_dir/tmp" 2> /dev/null
  running_pid=$(read_file "$pid_file")
  check_runner_pid_alive "$running_pid" && return 0
  ( nice -n 19 bash "$(get_script_path)" "$subcommand" "$work_dir" > /dev/null 2>&1 < /dev/null & echo "$!" > "$pid_file" )
}

# Write down the size of every project copy whose figure is missing, or was written before the copy was last used (`du` of a copy of tens of GB takes long: this runs detached).
cmd_measure_copies() {
  local work_dir=$1 copy_dir
  for copy_dir in "$work_dir"/p/*/; do
    [ -d "$copy_dir" ] || continue
    read_copy_size_kb "$work_dir" "$(basename "$copy_dir")" current > /dev/null
  done
}

# A probe of a VIEW of the runners on a Mac with Xcode starts `simctl-cleanup` detached, unless it ran in the last simctl_cleanup_interval_hours (the stamp `$work/simctl-cleanup.at`, touched by the run itself when it STARTS, so a
# run that hangs or dies is not started again at every probe).
start_simctl_cleanup_if_due() {
  local stamp="$work/simctl-cleanup.at"
  if [ -f "$stamp" ] && [ -z "$(find "$stamp" -maxdepth 0 -mmin +"$((simctl_cleanup_interval_hours * 60))" 2> /dev/null)" ]; then
    return 0
  fi
  start_detached_run "$work" simctl-cleanup
}

# `xcrun simctl delete unavailable`: the simulators whose runtime is gone (an Xcode that was updated or an old runtime that was removed leave them behind: 17 MB each, but their apps' data is 2-10 GB). Nothing else is deleted — no
# erase, no device of an installed runtime, no runtime. Bounded by simctl_cleanup_sec (a watchdog, as the probe's steps: no `timeout(1)` on a Mac); what it said is in `$work/simctl-cleanup.log`.
cmd_simctl_cleanup() {
  local work_dir=$1
  local log="$work_dir/simctl-cleanup.log"
  touch "$work_dir/simctl-cleanup.at"
  command -v xcrun > /dev/null 2>&1 || return 0
  echo "$(date '+%Y-%m-%d %H:%M:%S') xcrun simctl delete unavailable" > "$log"
  xcrun simctl delete unavailable >> "$log" 2>&1 < /dev/null &
  local command_pid=$!
  ( sleep "$simctl_cleanup_sec"; kill -9 "$command_pid" ) > /dev/null 2>&1 &
  local watchdog_pid=$!
  wait "$command_pid" 2> /dev/null
  echo "exit $?" >> "$log"
  kill "$watchdog_pid" > /dev/null 2>&1
  return 0
}

# `clean <work> <slug>`: remove ONE project copy because its owner is done with it (the last task of its project folder was closed), with the removal machinery of the prune — the copy-removal lock, the busy check (asked
# again of the moved-aside folder), the rename + `chmod` + `rm`. What differs from the prune: the copy is named, not guessed; and a job that ENDED lately keeps the copy only while nobody has fetched its results (the
# `fetched` mark of `wait` / `fetch` / a foreground run): the prune keeps it for result_keep_min whatever. A job that runs or waits, an `exec`, a job still being submitted and a held project lock refuse it — then nothing
# is removed. A folder an earlier removal left (`p/.trash-<slug>-<pid>`: cut off, or past its caller's time limit) is finished first, so «clean again» sees it through (when no copy is left and every leftover is being removed by a live process, the answer is `removing=` AT ONCE: that remover holds the copy-removal lock to the end of its `rm`, and waiting for it would only keep the caller silent). The answer is some lines on stdout (the exit status
# is 0 whenever the script could answer): `removed=<slug> freed_kb=<n> why=clean` (the copy, the leftover, or both: one line each) · `absent=<slug>` (no such copy, or a prune took it first) · `removing=<slug>` (a leftover
# whose remover still lives) · `busy=<slug> kind=<kind> job=<id|->` · `stuck=<slug>` (it would not go). Its jobs' logs and result files go with it.
cmd_clean() {
  local work_dir=$1 clean_slug=${2:-}
  check_name "$clean_slug"
  # The caller may hang up while this removes tens of GB (its call has a time limit); the removal goes on to its end.
  trap '' PIPE
  local clean_ignores_fetched=1
  local leftover is_trash_left=0 is_a_remover_gone=0
  for leftover in "$work_dir"/p/.trash-"$clean_slug"-*; do
    [ -e "$leftover" ] && check_is_trash_of_slug "$leftover" "$clean_slug" || continue
    is_trash_left=1
    check_runner_pid_alive "${leftover##*-}" || is_a_remover_gone=1
  done
  if [ ! -d "$work_dir/p/$clean_slug" ] && [ "$is_trash_left" -eq 0 ]; then
    printf 'absent=%s\n' "$clean_slug"
    return 0
  fi
  # No copy, and every leftover is being removed right now: nothing for this call to do, and nothing to wait for. The remover HOLDS the copy-removal lock until its `rm` ends, so waiting for the lock
  # would keep the caller silent for minutes to hear the same thing (or, once the remover is done, to find nothing at all).
  if [ ! -d "$work_dir/p/$clean_slug" ] && [ "$is_a_remover_gone" -eq 0 ]; then
    printf 'removing=%s\n' "$clean_slug"
    return 0
  fi
  begin_copy_removal "$work_dir" always
  local before_kb trash_code is_answered=0
  for leftover in "$work_dir"/p/.trash-"$clean_slug"-*; do
    [ -e "$leftover" ] && check_is_trash_of_slug "$leftover" "$clean_slug" || continue
    read_disk_kb "$work_dir"
    before_kb=$disk_free_kb
    finish_trash_removal "$leftover"
    trash_code=$?
    is_answered=1
    case $trash_code in
      0) set_freed_kb_since "$work_dir" "$before_kb"; printf 'removed=%s freed_kb=%s why=clean\n' "$clean_slug" "$last_freed_kb" ;;
      1) printf 'removing=%s\n' "$clean_slug" ;;
      2) printf 'busy=%s kind=%s job=%s\n' "$clean_slug" "$copy_busy_kind" "$copy_busy_job" ;;
      3) printf 'stuck=%s\n' "$clean_slug" ;;
    esac
  done
  local removal_code=0
  if [ ! -d "$work_dir/p/$clean_slug" ]; then
    removal_code=-1
  elif check_copy_is_busy "$work_dir" "$clean_slug"; then
    removal_code=3
  else
    remove_and_report_copy "$work_dir" "$clean_slug" clean
    removal_code=$?
  fi
  end_copy_removal "$work_dir"
  case $removal_code in
    2) printf 'absent=%s\n' "$clean_slug" ;;
    3) printf 'busy=%s kind=%s job=%s\n' "$clean_slug" "$copy_busy_kind" "$copy_busy_job" ;;
    # Everything that was there went while this call waited for the lock (another remover finished it): said as «nothing there», never as an empty answer.
    -1) [ "$is_answered" -eq 1 ] || printf 'absent=%s\n' "$clean_slug" ;;
  esac
  return 0
}

# `fetched <work> - <job>`: leave the mark that the results of finished job $3 are with whoever submitted it (`wait`, `fetch` and a foreground run call this once they have the files): `clean` then does not keep the copy for them.
cmd_fetched() {
  set_paths "$1" "$2" "$3"
  [ -d "$jd" ] || die "no such job: $job"
  touch "$jd/fetched"
}

# ─────────────────────────── adding the job to Pueue ───────────────────────────

# Quote one word for a shell (single quotes).
quote_word() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

add_job() {
  local group=$1
  local script_path
  script_path=$(get_script_path)
  local command_line
  command_line="exec bash $(quote_word "$script_path") job $(quote_word "$work") $(quote_word "$slug") $(quote_word "$job")"
  local task
  # The job's time limit counts from here (a foreground run's own timer does too): a job that waited its whole limit in the queue is
  # over when it starts (cmd_job), not given the limit again.
  date +%s > "$jd/queued-at"
  task=$(pq add --print-task-id -g "$group" -l "rr-$job" -w "$proj" -- "$command_line") || return 1
  printf '%s\n' "$task" > "$jd/task-id"
}

cmd_submit() {
  set_paths "$1" "$2" "$3"
  refuse_without_gui_session
  add_job "${4:-default}" || die "pueue add failed (does the group \"${4:-default}\" exist on this runner?)"
  echo queued
}

# ─────────────────────────── killing ───────────────────────────

# Signal the whole process group of the job (the script, its command and everything the command started). Pueue runs a task as
# `sh -c <command>` in a process group of its own, and the command line of add_job starts with `exec`, so the job script IS that
# group's leader: a group-wide signal has no wrapper to end first (which made Pueue call the task done while the job still ran).
# The group is read from the LIVE job process at the moment of use and signalled only while the job leads its own group: a stale id,
# or a Pueue that stopped isolating its tasks, can never make this hit another group (pueued's, the caller's).
signal_job_group() {
  local job_pid group_id
  job_pid=$(read_file "$jd/pid")
  [ -n "$job_pid" ] && check_runner_pid_alive "$job_pid" || return 1
  group_id=$(ps -o pgid= -p "$job_pid" 2> /dev/null | tr -d ' ')
  [ -n "$group_id" ] && [ "$group_id" = "$job_pid" ] || return 1
  kill "-$1" -- "-$group_id" 2> /dev/null
}

# Stop a job: a queued one is removed, a running one gets SIGTERM (its whole group) and, after the grace time, Pueue's own kill of the
# whole task tree. $1 says why: `timeout` when the caller's own time limit ran out (recorded like the job's own watchdog does it — 124,
# "timed out" — whichever of the two gets there first), anything else is a kill (137).
kill_job() {
  local task
  task=$(read_file "$jd/task-id")
  [ -n "$task" ] || return 1
  [ -f "$jd/exit" ] && return 0
  if [ "${1:-}" = timeout ]; then
    touch "$jd/timeout"
  else
    touch "$jd/killed"
  fi
  if [ ! -f "$jd/pid" ] && pq remove "$task" > /dev/null 2>&1; then
    # Pueue gives a number it has freed to the next task it is asked to add: from here on `task-id` is a number that may belong to another
    # job, so nothing may act on it any more (`prune_work` skips such a job's task; waiting is decided by the exit file below).
    touch "$jd/task-removed"
    finish_killed_job
    return 0
  fi
  signal_job_group TERM || pq kill "$task" > /dev/null 2>&1
  local started=$SECONDS
  while [ $((SECONDS - started)) -lt "$kill_grace_sec" ]; do
    check_job_ended && return 0
    sleep 0.2
  done
  hard_kill_job "$task"
  sleep 1
  return 0
}

# SIGKILL of the whole group; Pueue's own kill follows only so that its task list agrees. Without a verifiable group, Pueue's kill
# is all there is. A job that is SIGKILLed cannot write its own result, so the result is recorded FIRST: when the caller is the job's own
# watchdog the group-wide SIGKILL takes the watchdog down with the job.
#
# TERM and HUP are ignored from here on: the record is what the lease's main flow (and a `kill` call) waits for, and the main flow ends the lease's
# watcher — this very process, when the watcher's kill is the one that got here first — the moment the record appears. A kill that still had its forks to do
# (`ps` and `tr` in `signal_job_group`: a second or more on a loaded machine) died between the record and its SIGKILL, and a command that ignores SIGTERM lived
# on in a job that was already "ended", with nobody left to stop it. HUP too: a caller's ssh session that closes must not take a kill half-way either.
hard_kill_job() {
  trap '' TERM HUP
  finish_killed_job
  signal_job_group KILL || pq kill "$1" > /dev/null 2>&1
  pq kill "$1" > /dev/null 2>&1
  return 0
}

# A job that was killed (never started and removed from the queue, or SIGKILLed after it ignored SIGTERM): its result is written the way a
# finished job writes it — 124 when its time limit did it, 137 otherwise — so it is an ENDED job: `wait` and `ls` read a code, the next job
# of the project takes over its lock at once, and prune removes it after 3 days like any other.
finish_killed_job() {
  [ -f "$jd/exit" ] && return 0
  local code=137
  [ -f "$jd/timeout" ] && code=124
  rm -rf "$stage"
  printf '%s\n' done > "$jd/phase"
  date +%s > "$jd/finished-at"
  touch "$proj/used"
  printf '%s\n' "$code" > "$jd/exit.tmp" && mv "$jd/exit.tmp" "$jd/exit"
}

# Ended = it wrote its exit file, or its process is gone.
check_job_ended() {
  [ -f "$jd/exit" ] && return 0
  local pid
  pid=$(read_file "$jd/pid")
  [ -n "$pid" ] && ! check_runner_pid_alive "$pid" && return 0
  return 1
}

# Prints `killed`, or `already-ended <code>` for a job that had finished before the kill came (nothing is killed then, and the caller
# must not be told it was).
cmd_kill() {
  set_paths "$1" "$2" "$3"
  if [ -n "$(read_file "$jd/task-id")" ] && [ -f "$jd/exit" ]; then
    echo "already-ended $(read_file "$jd/exit")"
    return 0
  fi
  kill_job "${4:-}" || die "no such job: $job"
  echo killed
}

# ─────────────────────────── log streaming ───────────────────────────

# Print what the log gained since $log_offset, and move the offset.
drain_log() {
  local size
  size=$(wc -c 2> /dev/null < "$jd/log" | tr -d ' ')
  [ -n "$size" ] || return 0
  if [ "$size" -gt "$log_offset" ]; then
    tail -c +"$((log_offset + 1))" "$jd/log" | head -c "$((size - log_offset))"
    log_offset=$size
  fi
}

# Stream the log until the file $jd/drain-stop appears, then print the rest. Runs as a background job.
stream_log() {
  log_offset=${1:-0}
  while [ ! -f "$jd/drain-stop" ]; do
    drain_log
    sleep "$drain_interval_sec"
  done
  drain_log
}

# Return when the job is over: Pueue says its task is done, or the job's exit file is there — whichever comes first, and at once if it
# already is. The exit file is the job's own record. The number of a task that was removed (a queued job that was killed) can be given to
# another job, and `pueue wait` on it would then follow THAT job for as long as it runs (hours, behind a busy group), or return at once
# for a number nobody holds: so the wait is cut as soon as the exit file appears, and the number is never trusted alone.
#
# The Pueue wait runs in a process group of its own (`set -m`, as `exec` does) and the cut signals the GROUP. `pq` is a function, so the
# background job is a subshell and `pueue wait` its child — unless the bash happens to run it in place of the subshell (5.3 can; 5.2, the
# bash of Ubuntu 24.04, does not). A kill of the subshell alone left `pueue wait` running for as long as the task, however many times
# the exit file won the race. Under job control bash no longer gives a background job /dev/null as stdin, so it is given here: in a
# lease the caller's stdin is the heartbeat stream, which only the lease watcher (fd 3) may read.
wait_for_task() {
  [ -f "$jd/exit" ] && return 0
  set -m
  pq wait "$1" < /dev/null > /dev/null 2>&1 &
  local waiter_pid=$!
  set +m
  while kill -0 "$waiter_pid" 2> /dev/null; do
    if [ -f "$jd/exit" ]; then
      # The group, or the process alone when it did not get a group of its own: a group id that is not a live group is harmless.
      kill -- "-$waiter_pid" > /dev/null 2>&1 || kill "$waiter_pid" > /dev/null 2>&1
      break
    fi
    sleep 0.2
  done
  { wait "$waiter_pid"; } 2> /dev/null
  return 0
}

# Stream the log of the task until Pueue reports it done.
follow_until_done() {
  rm -f "$jd/drain-stop"
  stream_log "$1" &
  local streamer_pid=$!
  local task
  task=$(read_file "$jd/task-id")
  [ -n "$task" ] && wait_for_task "$task"
  touch "$jd/drain-stop"
  wait "$streamer_pid" 2> /dev/null
}

# Where `follow` starts in the log: the beginning, the end, or the last N lines.
resolve_follow_offset() {
  local size
  size=$(wc -c 2> /dev/null < "$jd/log" | tr -d ' ')
  size=${size:-0}
  case ${1:-start} in
    end) echo "$size" ;;
    tail:*)
      local tail_bytes
      tail_bytes=$(tail -n "${1#tail:}" "$jd/log" 2> /dev/null | wc -c | tr -d ' ')
      echo $((size - tail_bytes))
      ;;
    *) echo 0 ;;
  esac
}

cmd_follow() {
  set_paths "$1" "$2" "$3"
  local from_offset
  from_offset=$(resolve_follow_offset "${4:-start}")
  follow_until_done "$from_offset"
}

# After Pueue says a task is done, its own last file may still be a moment away: wait for the exit file, or for the job process to
# be gone (killed with SIGKILL, it never writes one), at most five seconds.
wait_for_exit_file() {
  local started=$SECONDS
  while [ ! -f "$jd/exit" ] && [ $((SECONDS - started)) -lt "$exit_file_wait_sec" ]; do
    check_job_ended && return 0
    sleep 0.2
  done
}

cmd_wait() {
  set_paths "$1" "$2" "$3"
  local task
  task=$(read_file "$jd/task-id")
  [ -n "$task" ] || die "no such job: $job"
  wait_for_task "$task"
  wait_for_exit_file
  echo done
}

# The facts of a job, one key=value per line (parsed by jobState.ts).
print_job_facts() {
  echo "slug=$slug"
  echo "exit=$(read_file "$jd/exit")"
  echo "phase=$(read_file "$jd/phase")"
  echo "task=$(read_file "$jd/task-id")"
  echo "started=$(read_file "$jd/started-at")"
  echo "finished=$(read_file "$jd/finished-at")"
  [ -f "$jd/timeout" ] && echo "timeout=1" || echo "timeout=0"
  [ -f "$jd/killed" ] && echo "killed=1" || echo "killed=0"
  [ -f "$jd/pid" ] && echo "has_pid=1" || echo "has_pid=0"
  [ -d "$jd/artifacts" ] && echo "artifacts=1" || echo "artifacts=0"
  echo "failed_step=$(read_file "$jd/failed-step")"
}

cmd_result() {
  set_paths "$1" "$2" "$3"
  [ -d "$jd" ] || die "no such job: $job"
  print_job_facts
}

cmd_meta() {
  set_paths "$1" "$2" "$3"
  cat "$jd/meta.json" 2> /dev/null || die "no such job: $job"
}

# The last N lines of a job's log (all of it when N is "all").
cmd_tail() {
  set_paths "$1" "$2" "$3"
  if [ "${4:-all}" = all ]; then cat "$jd/log" 2> /dev/null; else tail -n "$4" "$jd/log" 2> /dev/null; fi
}

# ─────────────────────────── the lease ───────────────────────────

# The caller writes one byte every few seconds. No byte for the lease time, or the end of its stream, means the caller is gone: the job
# is killed. A caller that finishes normally has no use for the lease any more because the job it guarded is over (the lease script
# stops its watcher when the job ends), and one that wants the job stopped says so with `kill` (an interrupted `exec` ends its stream on purpose, to have its command stopped).
# A stock sshd never notices a half-open connection, so this is the only thing that stops an orphaned job. The stream is the caller's,
# on fd 3 (a background job gets /dev/null as stdin, so the callers keep theirs there). A reader process does plain blocking reads and
# records each byte's arrival time; this loop compares the clock with it once a second — no `read -t`, whose exit status for a timeout
# is not the same in bash 3.2 (macOS) and bash 4+, and which would make a quiet second look like a closed connection.
watch_lease() {
  local lease_sec=$1
  lease_state_dir=
  lease_reader_pid=
  # The traps first: a command that ends at once gets the watcher a SIGTERM before it has done anything, and whatever it created by
  # then must go with it. The name is made here, not by a command substitution, so there is no instant with a dir nobody knows of.
  trap 'end_lease_watch' EXIT
  trap 'exit 143' TERM
  lease_state_dir="$work/tmp/lease.$$.$RANDOM"
  mkdir -p "$lease_state_dir" || return 1
  write_lease_beat
  (
    byte=
    while IFS= read -r -n 1 byte; do
      write_lease_beat
    done
    : > "$lease_state_dir/eof"
  ) <&3 &
  lease_reader_pid=$!
  local verdict=0
  local last_beat
  while :; do
    if [ -f "$lease_state_dir/eof" ]; then
      verdict=1
      break
    fi
    last_beat=$(cat "$lease_state_dir/beat" 2> /dev/null)
    case $last_beat in
      '' | *[!0-9]*) ;;
      *) [ $(($(date +%s) - last_beat)) -ge "$lease_sec" ] && { verdict=1; break; } ;;
    esac
    sleep "$heartbeat_poll_sec"
  done
  end_lease_watch
  return "$verdict"
}

# The time of the latest heartbeat, replaced atomically: a plain `> beat` truncates the file first, and a watcher that read it in
# that instant got an empty string, whose arithmetic is a syntax error that ended the watcher without a verdict.
# SILENT: the watcher's end removes the directory while the reader may be between its `date` and its `mv`, and that `mv: cannot stat …` came out on the
# caller's stderr AFTER the exit marker of `exec` — the marker must be the last thing there (a flake of the exec test under load). A beat that cannot be
# written for a directory that is gone is nothing to say.
write_lease_beat() {
  { date +%s > "$lease_state_dir/beat.new" && mv -f "$lease_state_dir/beat.new" "$lease_state_dir/beat"; } 2> /dev/null
}

end_lease_watch() {
  [ -n "${lease_reader_pid:-}" ] && kill "$lease_reader_pid" > /dev/null 2>&1
  [ -n "${lease_state_dir:-}" ] && rm -rf "$lease_state_dir"
}

ms_to_sec() {
  awk -v ms="$1" 'BEGIN { s = int((ms + 999) / 1000); if (s < 2) s = 2; print s }'
}

cmd_lease() {
  set_paths "$1" "$2" "$3"
  local group=$4
  local lease_sec
  lease_sec=$(ms_to_sec "$5")
  refuse_without_gui_session
  # A background job gets /dev/null as stdin unless job control is on: keep the caller's stream on fd 3 for the watcher.
  exec 3<&0
  add_job "$group" || die "pueue add failed (does the group \"$group\" exist on this runner?)"
  rm -f "$jd/drain-stop"
  stream_log 0 &
  local streamer_pid=$!
  (
    watch_lease "$lease_sec" || kill_job
  ) &
  local watcher_pid=$!
  local task
  task=$(read_file "$jd/task-id")
  wait_for_task "$task"
  kill "$watcher_pid" > /dev/null 2>&1
  wait_for_exit_file
  touch "$jd/drain-stop"
  wait "$streamer_pid" 2> /dev/null
}

# ─────────────────────────── the job (the Pueue task) ───────────────────────────

lock_held=0

# The project lock is a FILE made with the shell's own exclusive create (`set -C`, noclobber: open(O_EXCL)) — never with `mkdir`. The uutils
# coreutils that current Ubuntu ships as /usr/bin/mkdir let several simultaneous `mkdir` of one path ALL succeed (measured here: 265 races
# of 1200 with five contenders), which gave two jobs of one project the lock together. The file holds the holder's pid and job, two lines,
# written by the very redirection that creates it. Succeeds only for the one that created the file.
create_lock_file() {
  ( set -C; printf '%s\n%s\n' "$$" "$job" > "$1" ) 2> /dev/null
}

# Read the lock file $1 into holder_pid and holder_job (empty when it is missing or has no holder written yet).
read_lock_holder() {
  holder_pid=
  holder_job=
  { IFS= read -r holder_pid; IFS= read -r holder_job; } 2> /dev/null < "$1"
  return 0
}

# Is the lock held by nobody any more? Its holder's process is gone (or a stranger's now: check_runner_pid_alive), or its job has an exit record, or it is over lock_max_age_min old (when that is set), or no
# holder was ever written and it is over a minute old (its creator died between creating the file and writing it).
check_lock_is_stale() {
  local holder_pid holder_job
  read_lock_holder "$lock"
  if [ -n "$holder_pid" ] && ! check_runner_pid_alive "$holder_pid"; then
    return 0
  fi
  if [ -n "$holder_job" ] && [ -f "$jobs_dir/$holder_job/exit" ]; then
    return 0
  fi
  if [ "$lock_max_age_min" -gt 0 ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +"$lock_max_age_min" 2> /dev/null)" ]; then
    return 0
  fi
  [ -z "$holder_pid" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2> /dev/null)" ]
}

# Break a stale lock — by ONE waiter at a time, and only the lock of the very holder that was seen dead. Several waiters can see the same
# dead holder at once; if each simply removed the lock, a slow one could remove the lock a faster one had already re-created, and two jobs
# of a project would run on one tree. So the RIGHT to break the lock of holder (pid, job) is a file named for that holder, made with the
# exclusive create: of the waiters that saw it, one wins and the others yield. That holder can never hold the lock again (its process is
# gone, its job id is unique), so once the winner has seen the lock still carries that holder, nothing but the winner can remove it, and a
# lock some other job has taken since is not that holder's and is left alone. Returns 1 when another waiter is at it.
break_stale_lock() {
  local holder_pid holder_job
  read_lock_holder "$lock"
  check_lock_is_stale || return 0
  break_lock_of_holder "$holder_pid" "$holder_job"
}

# The right to break the lock of holder $1/$2 (pid, job): the file `$lock.breaking.<pid>.<job>.<generation>`. A winner that died leaves its
# file behind, held by a process that is gone: the next waiter takes the next generation of the name — and again only one of them wins it.
# A name is made of the holder's own words only (a lock file with something else in it must not name a path).
break_lock_of_holder() {
  local stale_pid=$1 stale_job=$2
  case $stale_pid in *[!0-9]*) stale_pid= ;; esac
  case $stale_job in *[!A-Za-z0-9._-]*) stale_job= ;; esac
  local generation=0 right
  while :; do
    right="$lock.breaking.${stale_pid:-none}.${stale_job:-none}.$generation"
    create_lock_file "$right" && break
    check_breaker_is_alive "$right" && return 1
    generation=$((generation + 1))
  done
  # The lock must carry that holder AND still be stale. For a named holder the second test adds nothing (it is dead for good). For a lock
  # with no holder written it is what matters: every fresh lock is empty for a moment between its creation and the write of its pid, so
  # "no holder" names no one in particular — only the over-a-minute test tells a creator that died from one that is about to write.
  local holder_pid holder_job
  read_lock_holder "$lock"
  if [ "$holder_pid" = "$1" ] && [ "$holder_job" = "$2" ] && check_lock_is_stale; then
    rm -f "$lock"
  fi
  return 0
}

# Is the breaker that made the right file $1 still at it? Its process is alive — the test the lock itself uses, so a breaker that is merely
# slow (a busy disk) keeps its right however long it takes — and its job has no exit record (the lock's second test: a breaker that died
# and whose pid went to some long-lived process would otherwise hold its right for ever, and the project's queue would never drain). A file
# with no process written yet is a breaker between creating it and writing it: it counts until it is over a minute old.
check_breaker_is_alive() {
  local holder_pid holder_job
  read_lock_holder "$1"
  if [ -n "$holder_job" ] && [ -f "$jobs_dir/$holder_job/exit" ]; then
    return 1
  fi
  if [ -n "$holder_pid" ]; then
    check_runner_pid_alive "$holder_pid"
    return
  fi
  [ -z "$(find "$1" -maxdepth 0 -mmin +1 2> /dev/null)" ]
}

acquire_lock() {
  local noticed=0
  local holder_pid holder_job
  while ! create_lock_file "$lock"; do
    [ "$killed" -eq 1 ] && return 1
    if check_lock_is_stale && break_stale_lock; then
      continue
    fi
    if [ "$noticed" -eq 0 ]; then
      read_lock_holder "$lock"
      say "waiting for job ${holder_job:-another job} of this project"
      noticed=1
    fi
    nap "$lock_poll_sec"
  done
  lock_held=1
  # The rights to break the lock name holders that are gone and can never hold it again: nothing needs them any more.
  rm -f "$lock".breaking.* 2> /dev/null
  return 0
}

# Give the lock back — only if it is still ours (a lock that was broken as stale and taken by another job is not ours to remove).
release_lock() {
  if [ "$lock_held" -eq 1 ]; then
    local holder_pid holder_job
    read_lock_holder "$lock"
    if [ "$holder_pid" = "$$" ] && [ "$holder_job" = "$job" ]; then
      rm -f "$lock"
    fi
  fi
  lock_held=0
}

remove_tree_file() {
  check_relative_path "$1" || return 0
  rm -f "$tree/$1"
  local dir
  dir=$(dirname "$1")
  while [ "$dir" != "." ] && rmdir "$tree/$dir" 2> /dev/null; do
    dir=$(dirname "$dir")
  done
}

# The apply step: delete what the previous submit had and this one has not, copy the staged files over, keep this submit's list.
sync_tree() {
  mkdir -p "$tree"
  if [ -f "$proj/manifest" ]; then
    sort "$proj/manifest" > "$jd/manifest.old.sorted"
    sort "$jd/manifest" > "$jd/manifest.new.sorted"
    comm -23 "$jd/manifest.old.sorted" "$jd/manifest.new.sorted" | while IFS= read -r removed_file; do
      remove_tree_file "$removed_file"
    done
  fi
  # --modify-window=-1: compare the mtimes to the nanosecond too — a same-length edit within one second of the previous version is
  # otherwise "unchanged" (rsync's quick check) and the copy would keep the old file.
  rsync -a --modify-window=-1 --exclude=/.git "$stage/" "$tree/" || return 1
  if [ -d "$stage/.git" ]; then
    mkdir -p "$tree/.git"
    rsync -a --modify-window=-1 --delete "$stage/.git/" "$tree/.git/" || return 1
  else
    # `.git` only with --with-git: a copy that got one from an earlier run must not keep serving its stale history.
    rm -rf "$tree/.git"
  fi
  cp "$jd/manifest" "$proj/manifest"
  rm -rf "$stage"
}

cmd_sync_tree() {
  set_paths "$1" "$2" "$3"
  sync_tree || die "apply failed"
}

# The first lines of what is on stdin that look like an error, each cut short and none twice (this script's own lines excluded). The ROOT cause
# comes first: what a tool prints last is its summary of the failure («couldn't be built successfully», «exit code 1»), and the last lines are
# all `wait` shows.
first_error_lines() {
  grep -a -v '^remote-run: ' | grep -a -i -E "$error_line_pattern" | tr -d '\033\r' | cut -c1-240 | awk '!seen[$0]++' | head -n "$failed_step_error_lines"
}

# The dependencies step failed: say why in the job's log, from the step's own output (everything of the log after byte offset $1) — its first
# error lines, and the first error lines of the build log the tool names (yarn: «logs can be found here: …/build.log»; yarn removes it with its
# temp folder when it exits, then the way to get the build output into the log is said instead).
describe_failed_step() {
  local first_errors build_log
  first_errors=$(tail -c +"$(($1 + 1))" "$jd/log" 2> /dev/null | first_error_lines)
  [ -n "$first_errors" ] || return 0
  say "the first errors of the dependencies step (all of its output is in the log):"
  printf '%s\n' "$first_errors" | sed 's/^/remote-run:   /'
  for build_log in $(tail -c +"$(($1 + 1))" "$jd/log" 2> /dev/null | grep -a -o -E 'logs can be found here: [^[:space:])]+/build\.log' | sed 's/.*here: //' | awk '!seen[$0]++' | head -n 2); do
    if [ -f "$build_log" ]; then
      say "the build log the tool names, $build_log — its first errors:"
      first_error_lines < "$build_log" | sed 's/^/remote-run:   /'
    else
      say "the build log the tool names, $build_log, is gone (the tool removes it when it exits): run the step again with -e YARN_ENABLE_INLINE_BUILDS=1 to get the build output into the log"
    fi
  done
}

# bash -c <command> in <directory>, with the job's -e variables, output into the log; sets step_code. Runs as a child so a
# SIGTERM to the job (the `killed` flag) does not abandon it half-way.
run_step() {
  local directory=$1
  local command_text=$2
  if gui_step_uses_agent; then
    gui_run_step "$directory" "$command_text"
    return 0
  fi
  (
    cd "$directory" || exit 126
    LC_ALL=$job_locale
    export LC_ALL
    if [ -s "$jd/env" ]; then
      while IFS= read -r env_line; do export "$env_line"; done < "$jd/env"
    fi
    exec bash -c "$command_text"
  ) < /dev/null &
  local step_pid=$!
  keep_awake_while "$step_pid"
  # The notices bash prints when it reaps a signalled child ("Terminated") are not the job's output.
  { wait "$step_pid"; } 2> /dev/null
  step_code=$?
  while kill -0 "$step_pid" 2> /dev/null; do
    { wait "$step_pid"; } 2> /dev/null
    step_code=$?
  done
}

# A sleep that a group-wide SIGTERM does not end (and bash does not report as "Terminated").
nap() {
  ( trap '' TERM; exec sleep "$1" )
}

# The timeout: from the job's start, covering the lock wait, the install and the command. SIGTERM to the job's group, SIGKILL after the
# grace time (a process that ignores SIGTERM). It polls once a second for the cancel file instead of sleeping the whole limit: a
# sleeper that a group-wide SIGTERM (a kill) ends would look like an expired limit, and a finished job needs no process to reap.
start_watchdog() {
  local limit=$1
  local task
  task=$(read_file "$jd/task-id")
  (
    trap '' TERM
    local started=$SECONDS
    while [ $((SECONDS - started)) -lt "$limit" ]; do
      [ -f "$jd/watchdog-cancel" ] && exit 0
      nap 1
    done
    [ -f "$jd/watchdog-cancel" ] && exit 0
    touch "$jd/timeout"
    signal_job_group TERM || pq kill "$task" > /dev/null 2>&1
    local grace_started=$SECONDS
    while [ $((SECONDS - grace_started)) -lt "$kill_grace_sec" ]; do
      [ -f "$jd/watchdog-cancel" ] && exit 0
      nap 1
    done
    hard_kill_job "$task"
  ) > /dev/null 2>&1 &
}

stop_watchdog() {
  touch "$jd/watchdog-cancel"
}

# True when "$tree/$1" has no symlink in it, so a walk that starts there stays inside the copy (the walk of the whole copy never followed a
# link either).
check_has_no_symlink() {
  local parent physical
  [ ! -L "$tree/$1" ] || return 1
  parent=$(dirname "$1")
  [ "$parent" = . ] && return 0
  physical=$(cd "$tree/$parent" 2> /dev/null && pwd -P) || return 1
  [ "$physical" = "$(cd "$tree" && pwd -P)/$parent" ]
}

# The patterns of a job's pattern file $1 (`pull.ere`, `clean-after-success.ere`: one extended regular expression per line) and the folders to walk for them, from $2 (the matching `.roots`: the fixed prefixes of the patterns).
# Sets the arrays job_patterns and job_roots. Fails when there is nothing to do: no pattern, or no root that exists in the copy with no symlink on its way. `.` among the roots (a pattern that starts with a wildcard),
# or no roots file at all (an older main box) walks the whole copy.
read_job_patterns() {
  job_patterns=()
  job_roots=()
  local pattern root
  while IFS= read -r pattern; do
    [ -n "$pattern" ] && job_patterns+=("$pattern")
  done < "$1"
  [ "${#job_patterns[@]}" -gt 0 ] || return 1
  if [ -s "$2" ]; then
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      if [ "$root" = . ]; then
        job_roots=(.)
        break
      fi
      check_relative_path "$root" && [ -e "$tree/$root" ] && check_has_no_symlink "$root" && job_roots+=("$root")
    done < "$2"
    [ "${#job_roots[@]}" -gt 0 ] || return 1
  else
    job_roots=(.)
  fi
}

# Files the command created or changed that match pull.ere, kept per job. Only the folders in pull.roots are walked (the fixed prefixes of the patterns, `e2e/artifacts`): the copy also holds node_modules and every
# build folder, which a Gradle or Metro build fills with hundreds of thousands of files.
collect_artifacts() {
  [ -s "$jd/pull.ere" ] || return 0
  [ -f "$jd/start-marker" ] || return 0
  read_job_patterns "$jd/pull.ere" "$jd/pull.roots" || return 0
  local pattern candidate relative
  while IFS= read -r -d '' candidate; do
    relative=${candidate#./}
    for pattern in "${job_patterns[@]}"; do
      if [[ $relative =~ $pattern ]]; then
        mkdir -p "$jd/artifacts/$(dirname "$relative")" && cp -p "$tree/$relative" "$jd/artifacts/$relative"
        break
      fi
    done
  done < <(cd "$tree" && find "${job_roots[@]}" -name .git -prune -o -type f -newer "$jd/start-marker" -print0 2> /dev/null)
}

# After a job that SUCCEEDED: remove from the copy what the project's `clean-after-success:` names (a build's intermediates, tens of GB on a Mac, which the next job rebuilds anyway). Off unless the project says
# so. A pattern names a file or a folder (a folder goes whole), inside the copy only: the walk starts from the patterns' fixed prefixes, a root with a symlink on its way is skipped, `.git` is never entered, a candidate that is
# not a clean relative path of the copy (a name with a newline in it can be cut in two) is dropped, and a symlink goes as the link. Read-only folders are handled like the prune does. The lock is still held, so no
# other job of the project sees the tree half-cleaned. Says how many paths went (and which would not) in the job's log; never changes the job's result.
clean_after_success() {
  [ -s "$jd/clean-after-success.ere" ] || return 0
  read_job_patterns "$jd/clean-after-success.ere" "$jd/clean-after-success.roots" || return 0
  local grep_arguments=() pattern candidate relative
  for pattern in "${job_patterns[@]}"; do
    grep_arguments+=(-e "$pattern")
  done
  # The matches are listed first and removed after: a folder removed while `find` is still walking it would only make `find` complain.
  local listing="$jd/clean-after-success.list"
  (cd "$tree" && find "${job_roots[@]}" -name .git -prune -o -print 2> /dev/null | sed -e 's|^\./||' | grep -E "${grep_arguments[@]}") > "$listing" 2> /dev/null
  local removed=0 failed=0
  while IFS= read -r relative; do
    check_relative_path "$relative" || continue
    # Gone already: below a folder that was just removed (the listing has its contents too — a pattern names a folder with everything below it).
    [ -e "$tree/$relative" ] || [ -L "$tree/$relative" ] || continue
    for pattern in "${job_patterns[@]}"; do
      if [[ $relative =~ $pattern ]]; then
        if remove_path_even_if_read_only "$tree/$relative"; then
          removed=$((removed + 1))
        else
          failed=$((failed + 1))
          say "clean-after-success: could not remove $relative"
        fi
        break
      fi
    done
  done < "$listing"
  rm -f "$listing"
  [ "$removed" -gt 0 ] && say "clean-after-success: removed $removed path$([ "$removed" -eq 1 ] || echo s) of the copy"
  return 0
}

finish_job() {
  local code=$1
  if [ -f "$jd/timeout" ]; then
    code=124
    say "timed out after ${timeout_sec}s"
  elif [ "$killed" -eq 1 ]; then
    code=137
    say "job killed"
  fi
  stop_watchdog
  set_phase collecting
  collect_artifacts
  # Only a job that succeeded (its final code, after a timeout or a kill have had their say): its results are collected above, so nothing a `pull:` names is lost to this.
  if [ "$code" -eq 0 ]; then
    set_phase cleaning
    clean_after_success
  fi
  release_lock
  rm -rf "$stage"
  set_phase done
  date +%s > "$jd/finished-at"
  # The copy's mark of use means its last ACTIVITY: a job that queued and ran for hours must not leave its copy looking as old as its submit (the first one a short disk would remove, results and all).
  touch "$proj/used"
  printf '%s\n' "$code" > "$jd/exit.tmp" && mv "$jd/exit.tmp" "$jd/exit"
  exit "$code"
}

cmd_job() {
  set_paths "$1" "$2" "$3"
  exec >> "$jd/log" 2>&1
  printf '%s\n' "$$" > "$jd/pid"
  date +%s > "$jd/started-at"
  set_phase starting
  killed=0
  trap 'killed=1' TERM INT HUP
  # Pueue starts the task before the adder has written its id down.
  local id_wait_started=$SECONDS
  while [ ! -s "$jd/task-id" ] && [ $((SECONDS - id_wait_started)) -lt "$task_id_wait_sec" ]; do
    sleep 0.1
  done
  timeout_sec=$(read_file "$jd/timeout-sec")
  [ -n "$timeout_sec" ] || timeout_sec=$default_timeout_sec
  local limit_sec=$timeout_sec
  local queued_at
  queued_at=$(read_file "$jd/queued-at")
  case $queued_at in
    '' | *[!0-9]*) ;;
    *) limit_sec=$((timeout_sec - ($(date +%s) - queued_at))) ;;
  esac
  if [ "$limit_sec" -le 0 ]; then
    touch "$jd/timeout"
    say "its time limit ran out while it was queued"
    finish_job 124
  fi
  start_watchdog "$limit_sec"

  # The session may have ended while the job waited in the queue.
  if gui_job_needs_session && ! gui_agent_alive; then
    say "$(gui_refusal_text)"
    finish_job 125
  fi

  set_phase waiting-lock
  acquire_lock || finish_job 137

  set_phase syncing
  sync_tree || { say "applying the files failed"; finish_job 125; }

  local subfolder
  subfolder=$(read_file "$jd/subfolder")
  check_relative_path "$subfolder" || { say "bad subfolder"; finish_job 125; }
  [ "$killed" -eq 1 ] && finish_job 137

  local install_command install_key
  install_command=$(read_file "$jd/install-command")
  install_key=$(read_file "$jd/install-key")
  if [ -n "$install_command" ] && [ "$(read_file "$proj/deps.hash")" != "$install_key" ]; then
    set_phase deps
    say "installing dependencies: $install_command"
    local step_log_offset
    step_log_offset=$(wc -c < "$jd/log" | tr -d ' ')
    run_step "$tree" "$install_command"
    if [ "$step_code" -ne 0 ]; then
      rm -f "$proj/deps.hash"
      echo deps > "$jd/failed-step"
      say "the dependencies step failed with exit code $step_code"
      describe_failed_step "$step_log_offset"
      finish_job 125
    fi
    printf '%s\n' "$install_key" > "$proj/deps.hash"
  fi
  [ "$killed" -eq 1 ] && finish_job 137

  touch "$jd/start-marker"
  set_phase running
  run_step "$tree/$subfolder" "$(read_file "$jd/cmd")"
  finish_job "$step_code"
}

# ─────────────────────────── exec ───────────────────────────

# The exit hook of `exec`: its marker goes, and the copy's mark of use is fresh (the command may have run for hours; the copy is not the least recently used one for that).
end_exec_use() {
  rm -f "$exec_marker"
  touch "$proj/used" 2> /dev/null
}

cmd_exec() {
  set_paths "$1" "$2" ""
  local subfolder=$3
  local lease_sec
  lease_sec=$(ms_to_sec "$4")
  shift 4
  check_relative_path "$subfolder" || die "bad subfolder"
  # `exec` takes no lock and leaves no job folder, so this marker is what tells a prune the copy is in use for as long as the command runs (it is written BEFORE the copy is looked at: a
  # prune that moves the copy aside after that finds the marker, and one that did so before leaves no folder to write it in). The exit hook removes it and counts the end as use.
  exec_marker="$proj/exec.$$"
  { printf '%s\n' "$$" > "$exec_marker"; } 2> /dev/null || die "the runner has no copy of this project yet (run a command first)"
  trap 'end_exec_use' EXIT
  [ -d "$tree/$subfolder" ] || die "the runner has no copy of this project yet (run a command first)"
  touch "$proj/used"
  exec 3<&0
  # Own process group, so the lease can stop the command and everything it started.
  set -m
  ( cd "$tree/$subfolder" && LC_ALL=$job_locale && export LC_ALL && exec bash -c "$*" ) < /dev/null &
  local exec_pid=$!
  keep_awake_while "$exec_pid"
  set +m
  (
    if ! watch_lease "$lease_sec"; then
      kill -TERM -- "-$exec_pid" 2> /dev/null
      local grace_started=$SECONDS
      while kill -0 "$exec_pid" 2> /dev/null && [ $((SECONDS - grace_started)) -lt "$kill_grace_sec" ]; do
        sleep 0.2
      done
      kill -KILL -- "-$exec_pid" 2> /dev/null
    fi
  ) &
  local watcher_pid=$!
  wait "$exec_pid"
  local exec_code=$?
  kill "$watcher_pid" > /dev/null 2>&1
  # The command's own code, said out loud: ssh reports 255 for ITS failures, and a command that really exits 255 (ssh and adb do) would
  # look like a lost connection. The marker (RS, the name, the code, a newline) is the last thing on stderr; the CLI takes it out of what it
  # shows. A session that dies before it has none, which is how a lost connection is told from a command that exited 255.
  printf '\036remote-run-exit:%s\n' "$exec_code" >&2
  exit "$exec_code"
}

# ─────────────────────────── jobs / pueue passthrough ───────────────────────────

# One JSON object per job: {"id", "facts": "k=v;k=v", "meta": <meta.json>} — everything `ls` and `status` show, in one call.
cmd_jobs() {
  local work_dir=$1
  local only_slug=${2:-}
  local first=1
  local meta job_dir
  printf '['
  for meta in "$work_dir"/p/${only_slug:-*}/jobs/*/meta.json; do
    [ -f "$meta" ] || continue
    job_dir=$(dirname "$meta")
    set_paths "$work_dir" "$(basename "$(dirname "$(dirname "$job_dir")")")" "$(basename "$job_dir")"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"id":"%s","facts":"%s","meta":' "$job" "$(print_job_facts | tr '\n' ';')"
    cat "$meta"
    printf '}'
  done
  printf ']\n'
}

# The work dir as an absolute path (a `~/…` the caller configured is expanded by the shell before it gets here).
cmd_workdir() {
  mkdir -p "$1" && (cd "$1" && pwd -P)
}

cmd_pueue() {
  shift
  pq "$@"
}

# ─────────────────────────── dispatch ───────────────────────────

main() {
  local subcommand=${1:-}
  [ $# -gt 0 ] && shift
  case $subcommand in
    probe) cmd_probe "$@" ;;
    prepare) cmd_prepare "$@" ;;
    lease) cmd_lease "$@" ;;
    submit) cmd_submit "$@" ;;
    job) cmd_job "$@" ;;
    follow) cmd_follow "$@" ;;
    wait) cmd_wait "$@" ;;
    result) cmd_result "$@" ;;
    meta) cmd_meta "$@" ;;
    tail) cmd_tail "$@" ;;
    kill) cmd_kill "$@" ;;
    exec) cmd_exec "$@" ;;
    pueue) cmd_pueue "$@" ;;
    workdir) cmd_workdir "$@" ;;
    jobs) cmd_jobs "$@" ;;
    prune) cmd_prune "$@" ;;
    measure-copies) cmd_measure_copies "$@" ;;
    clean) cmd_clean "$@" ;;
    simctl-cleanup) cmd_simctl_cleanup "$@" ;;
    fetched) cmd_fetched "$@" ;;
    sync-tree) cmd_sync_tree "$@" ;;
    *) die "unknown subcommand: $subcommand" ;;
  esac
}

# Run as a script it dispatches; sourced (the unit tests call the functions one by one) it only defines them.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
