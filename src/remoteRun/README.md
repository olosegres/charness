# `src/remoteRun/` — `charness remote-run`

Run a command on another machine (a **runner**: one PAIRED with this charness — `src/runners/` — or reached by ordinary ssh) and get its
output, exit code and declared result files back as if it had run here. User-facing description and setup: [`docs/remote-run.md`](../../docs/remote-run.md). Here: the contracts.

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
  says (a Jira agent has neither `ENV_FILE` nor `DATA_DIR`): the hand-made runners. The paired ones come from the hub's registry
  `~/.config/charness/runners/paired.json` (`pairedRunners.ts`). `runnersCatalog.ts` is the only place that knows both: hand-made first, then
  paired, a name in both is an error naming it. The bot MCP offers the instruction bullet while the catalog lists a runner
  (`runnerSummary.ts` reads the catalog on every connect, both files stamp-cached).
- **Local cache** — `${XDG_CACHE_HOME:-~/.cache}/charness/remote-run/` (0700): ssh control sockets (`ssh/`), the last probe of each runner
  (`<runner>.probe.json`), and `jobs/<id>.json` — the main box's own record of which local project a job came from.
  `XDG_CACHE_HOME` is on the tracker agents' environment allowlist (`utils/agentEnvironment.ts`), so the bot and every agent follow the same rule and
  share this one cache — the runner lines of the agents' bullet (`runnerSummary.ts`), the `/runners` screen and `remote-run` itself read the same snapshots.
  (Before, a tracker agent's cache followed `HOME` while the bot's did not, and what one wrote the other could not read.)
- **Runner** — `<workDir>/`: `bin/runner-<sha8>.sh`; `tmp/lease.*` (a lease watcher's state, removed when it ends, `prune` sweeps what a killed one left);
  `p/<slug>/{tree,stage/<job>,jobs/<job>,manifest,deps.hash,used,lock}`.
  `slug` = `<basename>-<sha256(hostname:uid:root)[0..10]>`. A job folder holds `meta.json`, `cmd`, `env`, `pull.ere`, `pull.roots`, `manifest`,
  `install-command`/`install-key`, `log`, `phase`, `pid`, `task-id`, `exit`, markers (`timeout`, `killed`, `failed-step`), `artifacts/`.

## Paired runners

A registry entry becomes the same `RunnerConfig` a `runners.json` entry is (`pairedRunners.ts`), so everything above the ssh layer — script
upload, rsync, Pueue, the lease — is phase 1 unchanged. Only the ssh options differ: destination `charness-runner-<id>`, no host and port but
`ProxyCommand=<node> <cli.js> runner-proxy <hub dir>/link/<id>.sock`, the host key pinned under `HostKeyAlias` from the hub's own `known_hosts`
(`StrictHostKeyChecking=yes`, never learned), the hub's key only (`IdentitiesOnly`, `IdentityAgent=none`), `-F /dev/null`. Every path on that line is
`%`-escaped for ssh (`UserKnownHostsFile` is a whitespace-separated LIST in ssh's option parser and `ControlPath` takes one word, so such a path is double-quoted inside the option when it has a space — `ssh.ts` does it for the `ControlPath` of every call too, and drops the shared connection for a cache path it cannot quote) and refused when it holds a quote, a backslash, `$`, a backtick or a line break (rsync's `-e` splitter and ssh must read the same
words: single quotes around a word, double quotes inside it, never a quote inside a single-quoted word — rsync cannot nest them). Pueue's binary and
config are found from the reported work dir with the layout `runnerUtility/runnerHome.ts` writes down (`work/`, `bin/`, `pueue/` side by side).

- **Online** = the link's unix socket accepts a connection (`runners/linkControl.ts`), asked before any ssh call; offline says «the runner is not
  connected» and its last seen is the link's own heartbeat (the last probe's time only when there is none).
- **Paused runners are never picked**: from the hub (`paired.json` `isPaused`) or on the runner itself (the probe's `paused=yes`). A named runner that is
  paused is refused with who paused it and how to resume; the skipped ones are named in the «no runner is online» message.
- **`--needs <cap>` waits** for a paired runner that is offline and, when last seen, had the capability and Pueue and was not paused
  (`runnerWait.ts`): it says so once, looks again every 10 s (`runnerWaitTiming.ts`; the test seam `CHARNESS_TEST_TIMINGS` `remoteRunRunnerPollMs`
  may only shorten it) and gives up after `--runner-wait` (default 15 min, `0` = fail at once) with the pick's own message and 125. A runner nobody
  can say can do the job (no runner has the capability, one never seen, a hand-made one, a named one) is not waited for: 125 at once, as in phase 1.
  An interrupt — heard from the first look to the last, in a sleep AND in a probe — ends it with 130 / 143 / 129 and starts no job: the ssh calls of
  a probe in flight are killed and the call settles when its client has exited (`runSshCommand` does not wait for `close`: after login the background
  ControlPersist master holds the client's pipes until the remote command ends — `ControlPersist` ends the master only 60 s after it has gone idle —
  and `waitForChildEnd` lets the pipes go whenever the call is cut off, also after the client had exited by itself), and a runner a probe answers with
  after the interrupt is not taken. A SECOND interrupt during the wait ends the process at once with the first one's code (`interrupts.ts`), so a call
  that did not stop can never swallow Ctrl-C. The deadline is hard: the catalog is read AGAIN at every look (a runner
  paused or removed from the hub meanwhile is given up on, whatever it does next), every look is told what is left of the wait and its probe is cut
  there, none starts with under a second left, and a runner that answers after the deadline is refused — the job is never started late.
- **What a paired runner says in `probe`** (`runner.sh`, read from its state folder — the parent of the work dir, recognised by `config.json` and
  `keys/`; a hand-made runner has none of it): `paused=` (the file `paused` exists), `service=` (the file `service`: `user-service` | `system-service`;
  none = `foreground`), `runner_version=` (`current/package.json`), and from `ios-check.json` (`"status": "pass"|"fail"|"skipped"`, `"reason"` — the line `runnerUtility/iosCheck.ts` writes; a paired Mac with Xcode and no record yet answers `ios: no — the iOS Simulator is being checked`) `ios_boot=` /
  `ios_boot_detail=`. A failed boot check turns `cap_ios` into `no — needs the runner user's login session` when the Simulator itself refused to boot (Apple does not
  give one to a LaunchDaemon), and into `no — the iOS Simulator check failed: <reason>` for any other failure (no runtime installed, the device could not be created). The files are written by `charness-runner` (`pause`, `service install`, the iOS check of the service).
- **A Mac does not sleep under a job**: the job's command (and `exec`) runs with a sibling `caffeinate -i -w <pid>` (it ends with the process; the
  command keeps its signals and exit status). Nothing off a Mac or without `caffeinate`.

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
`jobs/<job>/artifacts/` (walking only the folders of `pull.roots` — the fixed prefixes of the `pull:` patterns, `getPathPatternSearchRoots` —
never `node_modules` or a build folder; `.` when a pattern starts with a wildcard; no `pull.roots` from an older main box = the whole copy; a
root with a symlink on its way is skipped), releases the lock. Two jobs of one project therefore queue and each runs the tree as it was when IT was submitted.

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

**A job's Pueue task number is not its identity.** Pueue gives a number it has freed to the next task added, and `pueue wait` / `pueue remove`
act on whoever holds a number (a number nobody holds: `wait` returns 0 at once). A job killed while queued loses its task that way, so
`kill` marks it `task-removed` and writes its exit; every wait (`wait`, `logs -f`, the lease) is cut as soon as the job's exit file exists
(`wait_for_task`), and prune removes a task only when it is not marked and Pueue says the task under that number carries the job's own
label (`check_task_belongs_to_job`: `pueue status --json label=rr-<job>`).

**Prune** (on every submit) removes jobs older than 3 days that ended (an exit file, no task, or — for one an earlier script SIGKILLed unrecorded —
a process that is gone), stage folders older than a day **unless their job is
still queued** (a job can wait behind a busy group for days), lease/probe scratch state and project copies unused for 30 days.

**The project lock** is a file created with the shell's own exclusive create (`set -C`, `open(O_EXCL)`) holding the holder's pid and job — never
`mkdir`: the uutils coreutils that current Ubuntu installs as `/usr/bin/mkdir` let simultaneous `mkdir` of one path all succeed (265 of 1200 races with five
contenders on the dev box), which gave two jobs of a project the lock together. A lock is stale when its process is gone, its job has an exit record, or
it has no holder and is over a minute old; a stale lock is broken by ONE waiter, the one that wins the *right* to break the lock of that very dead holder: a file
`lock.breaking.<pid>.<job>.<n>` made with the same exclusive create (the others yield). Once the winner has seen the lock still carries that
holder and is still stale, nothing else can remove or replace it (a named holder is gone for good and its job id is unique; a lock with no
holder written is stale only when over a minute old, which a lock that is about to be written never is), and a lock another job took meanwhile
is left alone. A winner that is gone — its process dead, or its job ended while its pid went to another process — leaves its file, and the next
waiter takes generation `n+1`; never by the age of the file, so a slow breaker keeps its right; a job that takes the lock clears the files (they name holders that are gone). A job gives back only a
lock that is still its own. The pause between a waiting job's attempts is `lock_poll_sec` (a second; the tests shorten it).

**Job state** is the job's own files first (`exit` is authoritative); Pueue's task list (label `rr-<id>`) only when there is no exit file
(a job killed hard). `pueue wait` exits 0 for a failed task: Pueue's result is never used as a code.

**Lease.** A foreground run (and `exec`) runs `runner.sh lease`/`exec` over ssh, which itself adds the job to Pueue and reads a heartbeat byte
the CLI writes every `lease/9`. No byte for the lease (45 s; the test seam `CHARNESS_TEST_TIMINGS` `remoteRunLeaseMs` may only shorten it, at
least 3 s), or the end of the stream → the runner kills the job (a caller that finishes normally needs no lease: the job it guarded is over and
the lease script stops its watcher; an interrupted `exec` ends its stream on purpose to have its command stopped). `exec` ends by printing a marker line with the
command's code on stderr (`\036remote-run-exit:<code>`, cut out by `createExitMarkerFilter`): ssh's own 255 means a lost connection only
when that marker never came, so a command that exits 255 keeps its code. A stock sshd (`ClientAliveInterval 0`) never notices a half-open
connection; this is what ends an orphaned job. SIGINT/SIGTERM/SIGHUP locally kill the job first (SIGTERM to its process group, SIGKILL after 10 s; the local `--timeout` is the same kill with the reason `timeout`, so a run that the CLI's own timer ended is recorded as timed out (124), like one the runner's watchdog ended first, never as killed; `runner.sh kill` answers `already-ended <code>` for a job that had finished, and the CLI says so instead of «killed»)
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

Unit tests (`src/__tests__/remoteRun*.test.ts`) cover every planner (the paired runners' ssh options and catalog in `remoteRunPairedRunners.test.ts`, the wait in `remoteRunRunnerWait.test.ts`), the CLI entry, the MCP bullet, the runner script (probe, apply step,
prune, the lease through `exec`), ssh quoting against a real shell and file selection against real git repositories.
The flow (`remoteRunE2e.test.ts` and `remoteRunLifecycleE2e.test.ts`, side by side with a runner each, helpers in `remoteRunE2e/remoteRunFlowHarness.ts`: a single file was close to the 20 minutes a flow may take) drives the BUILT CLI against a throwaway loopback `sshd` (no root) and a private Pueue in temp dirs
(`remoteRunE2e/remoteRunFlowKit.ts`), with decoy jobs that write their own and a child's pid so "nothing left" is asserted on real pids.
`remoteRunPairedE2e.test.ts` runs the same CLI through a PAIRED runner (the runner-link flow's hub and runner machine, `runnerLinkE2e/runnerLinkFlowKit.ts`): pass / fail codes, live output, `--bg` + `wait`, interrupt, `exec`, paused, `--needs` with the runner offline.
A killed or timed-out flow cannot leak daemons: `remoteRunFlowSweep.ts` ends everything that names the layout or runs in it, from the
test's teardown, from a detached reaper, and at the next start. It needs `sshd`, `ssh`, `rsync`, Pueue and `yarn build`; a local run without
them is skipped with the reason, CI (`CI=true`) installs them and fails without.
