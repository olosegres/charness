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
# <state> counts only when it holds config.json and keys/ (a work dir that merely is called «work» is not one).
#
# bash 3.2-compatible on purpose (the stock bash of macOS): no associative arrays, no `wait -n`, no `mapfile`, no
# `timeout(1)`, no `read -t` (its timeout status differs between 3.2 and 4+), no GNU-only flags. Time limits are done by background watchdogs.
#
# Subcommands (the contract is in src/remoteRun/README.md):
#   probe        key=value lines: OS, CPU, RAM, disk, jobs, capabilities (paused / service / iOS boot check of a paired runner)
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
#   prune        remove old jobs, stale stage dirs and unused project copies
#   sync-tree    the apply step alone (tests)

LC_ALL=C
export LC_ALL
set -u

# ─────────────────────────── constants ───────────────────────────

kill_grace_sec=10
pueue_start_wait_sec=8
default_timeout_sec=10800
job_keep_days=3
copy_keep_days=30
stage_keep_days=1
drain_interval_sec=0.2
probe_step_sec=4
exit_file_wait_sec=5
task_id_wait_sec=5
heartbeat_poll_sec=1
# How long a job waiting for its project's lock sleeps between two attempts (a test shortens it to race many waiters quickly).
lock_poll_sec=1

# ─────────────────────────── helpers ───────────────────────────

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
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
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
  wait

  echo "disk_free_mb=$(kb_to_mb "$(probe_step_output disk | awk 'NR == 2 { print $4 }')")"
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
    if [ "${ios_boot_status:-}" = failed ]; then
      # Xcode is there, but the runner's own service could not boot a Simulator (Apple: none is available outside a login session).
      echo "cap_ios=no"
      echo "cap_ios_detail=needs the runner user's login session"
    elif [ -n "$runner_state" ] && [ -z "$ios_boot_status" ]; then
      # A paired runner writes its record every time its link starts: none yet means the check of THIS start is still running, and an
      # answer from an earlier start (another account, another kind of service) must not be offered meanwhile.
      echo "cap_ios=no"
      echo "cap_ios_detail=the iOS Simulator is being checked"
    else
      echo "cap_ios=yes"
      if [ "$(probe_step_status simctl)" = 0 ]; then
        echo "cap_ios_detail=Xcode $xcode_version, $(probe_step_output simctl | grep -c '(Shutdown)\|(Booted)') simulators"
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

# paused= / service= / runner_version= / ios_boot= of a paired runner (nothing for a hand-made one).
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
  return 0
}

cmd_probe() {
  work=$1
  mkdir -p "$work" 2> /dev/null
  read_runner_state
  echo "os=$(uname -s)"
  echo "arch=$(uname -m)"
  echo "kernel=$(uname -r)"
  case $(uname -s) in
    Linux) probe_linux ;;
    Darwin) probe_darwin ;;
  esac
  probe_slow
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
  prune_work "$work" "$slug"
  echo "work=$(cd "$work" && pwd -P)"
}

# Has the job in folder $1 ended? It wrote its exit file; or it never got a Pueue task (its submit failed half-way); or its process is
# gone (a runner script of an earlier version SIGKILLed it without recording that). One that waits in the queue, or runs, has not.
check_job_dir_ended() {
  [ -f "$1/exit" ] && return 0
  [ -f "$1/task-id" ] || return 0
  local recorded_pid
  recorded_pid=$(read_file "$1/pid")
  [ -n "$recorded_pid" ] && ! kill -0 "$recorded_pid" 2> /dev/null
}

# Is Pueue's task number $1 the task of job $2? Pueue hands a number it has freed (a task that was removed, or cleaned) to the next task
# added, and `pueue wait` / `pueue remove` of a number act on whoever holds it — so a job's recorded number is only good while the task
# under it carries the job's own label. The label filter is Pueue's (`status --json label=…`: an exact match), the answer the task's id.
check_task_belongs_to_job() {
  pq status --json "label=rr-$2" 2> /dev/null | grep -Eq "\"$1\": ?\{ ?\"id\": ?$1[,}]"
}

# Remove: jobs older than the keep time (and their Pueue tasks), leftover stage dirs, project copies unused for long.
prune_work() {
  local work_dir=$1
  local keep_slug=${2:-}
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
  find "$work_dir/p" -mindepth 2 -maxdepth 2 -name used -type f -mtime +"$copy_keep_days" 2> /dev/null | while IFS= read -r used_file; do
    old_copy=$(dirname "$used_file")
    [ "$(basename "$old_copy")" = "$keep_slug" ] && continue
    [ -e "$old_copy/lock" ] && continue
    rm -rf "$old_copy"
  done
}

cmd_prune() {
  prune_work "$1" ""
}

# ─────────────────────────── adding the job to Pueue ───────────────────────────

# Quote one word for a shell (single quotes).
quote_word() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

add_job() {
  local group=$1
  local script_path
  script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
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
  [ -n "$job_pid" ] && kill -0 "$job_pid" 2> /dev/null || return 1
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
hard_kill_job() {
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
  printf '%s\n' "$code" > "$jd/exit.tmp" && mv "$jd/exit.tmp" "$jd/exit"
}

# Ended = it wrote its exit file, or its process is gone.
check_job_ended() {
  [ -f "$jd/exit" ] && return 0
  local pid
  pid=$(read_file "$jd/pid")
  [ -n "$pid" ] && ! kill -0 "$pid" 2> /dev/null && return 0
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
  size=$(wc -c < "$jd/log" 2> /dev/null | tr -d ' ')
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
  size=$(wc -c < "$jd/log" 2> /dev/null | tr -d ' ')
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
write_lease_beat() {
  date +%s > "$lease_state_dir/beat.new" && mv -f "$lease_state_dir/beat.new" "$lease_state_dir/beat"
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

# Is the lock held by nobody any more? Its holder's process is gone, or its job has an exit record, or no holder was ever written and it
# is over a minute old (its creator died between creating the file and writing it).
check_lock_is_stale() {
  local holder_pid holder_job
  read_lock_holder "$lock"
  if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2> /dev/null; then
    return 0
  fi
  if [ -n "$holder_job" ] && [ -f "$jobs_dir/$holder_job/exit" ]; then
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
    kill -0 "$holder_pid" 2> /dev/null
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

# bash -c <command> in <directory>, with the job's -e variables, output into the log; sets step_code. Runs as a child so a
# SIGTERM to the job (the `killed` flag) does not abandon it half-way.
run_step() {
  local directory=$1
  local command_text=$2
  (
    cd "$directory" || exit 126
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

# Files the command created or changed that match pull.ere (one extended regular expression per line), kept per job. Only the folders in
# pull.roots are walked (the fixed prefixes of the patterns, `e2e/artifacts`): the copy also holds node_modules and every build folder,
# which a Gradle or Metro build fills with hundreds of thousands of files. `.` there (a pattern that starts with a wildcard) or no
# pull.roots at all (an older main box) walks the whole copy.
collect_artifacts() {
  [ -s "$jd/pull.ere" ] || return 0
  [ -f "$jd/start-marker" ] || return 0
  local roots=()
  local root
  if [ -s "$jd/pull.roots" ]; then
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      if [ "$root" = . ]; then
        roots=(.)
        break
      fi
      check_relative_path "$root" && [ -e "$tree/$root" ] && check_has_no_symlink "$root" && roots+=("$root")
    done < "$jd/pull.roots"
    [ "${#roots[@]}" -gt 0 ] || return 0
  else
    roots=(.)
  fi
  local patterns=()
  local pattern
  while IFS= read -r pattern; do
    [ -n "$pattern" ] && patterns+=("$pattern")
  done < "$jd/pull.ere"
  [ "${#patterns[@]}" -gt 0 ] || return 0
  local candidate relative
  while IFS= read -r -d '' candidate; do
    relative=${candidate#./}
    for pattern in "${patterns[@]}"; do
      if [[ $relative =~ $pattern ]]; then
        mkdir -p "$jd/artifacts/$(dirname "$relative")" && cp -p "$tree/$relative" "$jd/artifacts/$relative"
        break
      fi
    done
  done < <(cd "$tree" && find "${roots[@]}" -name .git -prune -o -type f -newer "$jd/start-marker" -print0 2> /dev/null)
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
  release_lock
  rm -rf "$stage"
  set_phase done
  date +%s > "$jd/finished-at"
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
    run_step "$tree" "$install_command"
    if [ "$step_code" -ne 0 ]; then
      rm -f "$proj/deps.hash"
      echo deps > "$jd/failed-step"
      say "the dependencies step failed with exit code $step_code"
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

cmd_exec() {
  set_paths "$1" "$2" ""
  local subfolder=$3
  local lease_sec
  lease_sec=$(ms_to_sec "$4")
  shift 4
  check_relative_path "$subfolder" || die "bad subfolder"
  [ -d "$tree/$subfolder" ] || die "the runner has no copy of this project yet (run a command first)"
  exec 3<&0
  # Own process group, so the lease can stop the command and everything it started.
  set -m
  ( cd "$tree/$subfolder" && exec bash -c "$*" ) < /dev/null &
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
    sync-tree) cmd_sync_tree "$@" ;;
    *) die "unknown subcommand: $subcommand" ;;
  esac
}

# Run as a script it dispatches; sourced (the unit tests call the functions one by one) it only defines them.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
