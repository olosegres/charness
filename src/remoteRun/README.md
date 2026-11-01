# `src/remoteRun/` — `charness remote-run`

Run a command on another machine (a **runner**, reached by ordinary ssh) and get its output, exit code and declared result files
back as if it had run here. User-facing description and setup: [`docs/remote-run.md`](../../docs/remote-run.md). Here: the contracts.

"Runner" is the machine. "Worker" already means a detached agent process and the hot-mode child in charness — never use it for this.

## Shape

```
main box                                                            runner (stock sshd, an account of its own)
─────────                                                           ──────────────────────────────────────────
remoteRunCli.ts → commands.ts ──ssh (one master per runner)──►      <workDir>/bin/runner-<sha8>.sh   (remoteRun/runner.sh, uploaded by hash)
  submit.ts   rsync --files-from ───────────────────────────►      p/<slug>/stage/<job>/
  foreground.ts / jobFiles.ts ◄── rsync --no-links ─────────        p/<slug>/jobs/<job>/artifacts/
                                                                    Pueue (queue, groups) runs `runner.sh job …`
```

The pure planners (`cliArgs`, `pathPatterns`, `projectConfig`, `runnersConfig`, `sendPlan`, `depsPlan`, `jobId`, `jobState`, `jobFormat`,
`probe`, `exitCodes`, `leaseTiming`, `safeCopy`) know nothing of ssh; the I/O modules (`ssh`, `rsync`, `runnerClient`, `runners`,
`submit`, `foreground`, `jobFiles`, `commands`) are thin over them. The CLI loads **no env file** (it would read the PROJECT's `.env`:
agents run it from project folders) and never touches `DATA_DIR` or the state store.

## Files

- **Config** — `~/.config/charness/runners.json` (`runnersConfig.ts`), one per OS user, beside the global env file whatever `ENV_FILE`
  says (a Jira agent has neither `ENV_FILE` nor `DATA_DIR`). The bot MCP offers the instruction bullet while it lists a runner
  (`checkIsRemoteRunOffered`, stamp-cached).
- **Local cache** — `${XDG_CACHE_HOME:-~/.cache}/charness/remote-run/` (0700): ssh control sockets (`ssh/`), the last probe of each runner
  (`<runner>.probe.json`), and `jobs/<id>.json` — the main box's own record of which local project a job came from.
- **Runner** — `<workDir>/`: `bin/runner-<sha8>.sh`; `tmp/lease.*` (a lease watcher's state, removed when it ends, `prune` sweeps what a killed one left);
  `p/<slug>/{tree,stage/<job>,jobs/<job>,manifest,deps.hash,used,lock}`.
  `slug` = `<basename>-<sha256(hostname:uid:root)[0..10]>`. A job folder holds `meta.json`, `cmd`, `env`, `pull.ere`, `manifest`,
  `install-command`/`install-key`, `log`, `phase`, `pid`, `task-id`, `exit`, markers (`timeout`, `killed`, `failed-step`), `artifacts/`.

## Contracts

**Which files.** `git ls-files -co --exclude-standard -z`, per checked-out submodule; minus `exclude:`; secret-looking names
(`.env`, `.env.*` except `.example/.sample/.template`, `*.pem`, `*.p12`, `*.key`, `.npmrc`) held back unless `send:` names them;
a name with a newline is refused. `.git` only with `--with-git`.

**Path patterns** (`pull:`, `exclude:`, `send:`, `install-key:`) are compiled once to extended regular expressions that `RegExp` (main box) and
`grep -E` / bash `=~` (runner) read the same way — `remoteRunPathPatterns.test.ts` runs all three over the same samples.

**Submit = stage, the job applies.** The main box stages the tree into `stage/<job>/` (`rsync --copy-dest=<tree>`, never `--link-dest`: a job
rewriting a file in place would change a queued job's stage; `--modify-window=-1`: compare nanoseconds, rsync's whole-second quick
check skips a same-length edit made within a second). The job (`runner.sh job`) takes the project lock, deletes
`old manifest − new manifest` from `tree/`, applies the stage, runs the dependencies step when its key differs from `deps.hash`, runs the
command (`bash -c`, `-e` variables, own timeout watchdog), copies the files that match `pull.ere` and are newer than the start marker into
`jobs/<job>/artifacts/`, releases the lock. Two jobs of one project therefore queue and each runs the tree as it was when IT was submitted.

**Time limit** (`--timeout`, default 3 h, both modes) counts from the moment the job is queued (`queued-at`, written when it is handed to Pueue):
a foreground run's timer starts there, and the job script starts its watchdog with what is left — a job that waited its whole limit behind a busy
group is over (124) the moment it starts, its command never runs.

**`.git` only with `--with-git`.** The stage carries a `.git` only then; applying a stage that has none removes the `.git` an earlier
`--with-git` run left in the copy.

**Probe.** `runners` gives the whole probe 20 s. Its slow questions (Pueue, the disk, Xcode, the simulators, Docker) are asked at once, each
bounded by 4 s, so a hung one costs 4 s in all; an Xcode that does not answer is «did not answer in time», not «not found», and a slow
simctl keeps the Xcode version without inventing a simulator count.

**A job that had to be SIGKILLed** (it ignored SIGTERM through `kill`, a lost lease or the time limit) cannot write its own result, so whoever kills
it records it first (`finish_killed_job`: exit 137, or 124 when the limit did it, `phase=done`, a finish time) — it is then an ended job like any
other, and the next job of its project takes the lock over at once.

**Prune** (on every submit) removes jobs older than 3 days that ended (an exit file, no task, or — for one an earlier script SIGKILLed unrecorded —
a process that is gone), stage folders older than a day **unless their job is
still queued** (a job can wait behind a busy group for days), lease/probe scratch state and project copies unused for 30 days.

**The project lock** is a file created with the shell's own exclusive create (`set -C`, `open(O_EXCL)`) holding the holder's pid and job — never
`mkdir`: the uutils coreutils that current Ubuntu installs as `/usr/bin/mkdir` let simultaneous `mkdir` of one path all succeed (265 of 1200 races with five
contenders on the dev box), which gave two jobs of a project the lock together. A lock is stale when its process is gone, its job has an exit record, or
it has no holder and is over a minute old; a stale lock is broken by ONE waiter, which checks and removes it inside a short-lived mutex of the same kind
(`lock.breaking`), and a job gives back only a lock that is still its own.

**Job state** is the job's own files first (`exit` is authoritative); Pueue's task list (label `rr-<id>`) only when there is no exit file
(a job killed hard). `pueue wait` exits 0 for a failed task: Pueue's result is never used as a code.

**Lease.** A foreground run (and `exec`) runs `runner.sh lease`/`exec` over ssh, which itself adds the job to Pueue and reads a heartbeat byte
the CLI writes every `lease/9`. No byte for the lease (45 s; the test seam `CHARNESS_TEST_TIMINGS` `remoteRunLeaseMs` may only shorten it, at
least 3 s), or the end of the stream → the runner kills the job (a caller that finishes normally needs no lease: the job it guarded is over and
the lease script stops its watcher; an interrupted `exec` ends its stream on purpose to have its command stopped). A stock sshd (`ClientAliveInterval 0`) never notices a half-open
connection; this is what ends an orphaned job. SIGINT/SIGTERM/SIGHUP locally kill the job first (SIGTERM to its process group, SIGKILL after 10 s)
and exit 130/143/129. The watcher reads the stream with plain blocking reads and compares clocks — never `read -t`, whose exit status for a
timeout differs between bash 3.2 and 4+ — and replaces its beat file atomically (an empty read must not be an arithmetic error: it ends the
whole subshell).

**Exit codes of remote-run itself**: the command's own pass through; 125 it failed (no runner, ssh, sync, deps step), 124 timeout,
130/143/129 interrupted locally, 137 job killed, 2 bad usage.

## Trust

- The runner is **not trusted to write into the main box.** Result files are rsynced with `--no-links` into a temp folder, then only regular
  files a `pull:` pattern names are copied into the project (`safeCopy.ts`: no symlink on the way, never over a directory, no setuid).
  *Which* project is the main box's own record (`jobRecords.ts`), never the job's `meta.json` on the runner.
- ssh is always `BatchMode=yes`, host keys as the operator's ssh config says (never `StrictHostKeyChecking=no`); no environment variable of the
  main box goes over; names that reach a remote shell are checked (`runner.sh`: `check_name`, job ids, relative paths).
- A runner runs the project's code: use an account of its own, no secrets on it.

## Tests

Unit tests (`src/__tests__/remoteRun*.test.ts`) cover every planner, the CLI entry, the MCP bullet, the runner script (probe, apply step,
prune, the lease through `exec`), ssh quoting against a real shell and file selection against real git repositories.
The flow `remoteRunE2e.test.ts` drives the BUILT CLI against a throwaway loopback `sshd` (no root) and a private Pueue in temp dirs
(`remoteRunE2e/remoteRunFlowKit.ts`), with decoy jobs that write their own and a child's pid so "nothing left" is asserted on real pids.
A killed or timed-out flow cannot leak daemons: `remoteRunFlowSweep.ts` ends everything that names the layout or runs in it, from the
test's teardown, from a detached reaper, and at the next start. It needs `sshd`, `ssh`, `rsync`, Pueue and `yarn build`; a local run without
them is skipped with the reason, CI (`CI=true`) installs them and fails without.
