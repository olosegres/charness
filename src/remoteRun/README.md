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

The pure planners (`cliArgs`, `cleanReport`, `pathPatterns`, `projectConfig`, `runnersConfig`, `sendPlan`, `depsPlan`, `jobId`, `jobState`, `jobFormat`,
`probe`, `pruneReport`, `exitCodes`, `leaseTiming`, `safeCopy`) know nothing of ssh; the I/O modules (`ssh`, `rsync`, `runnerClient`, `runners`,
`submit`, `foreground`, `jobFiles`, `commands`) are thin over them. The CLI loads **no env file** (it would read the PROJECT's `.env`:
agents run it from project folders) and never touches `DATA_DIR` or the state store.

## Files

- **Config** — `~/.config/charness/runners.json` (`runnersConfig.ts`), one per OS user, beside the global env file whatever `ENV_FILE`
  says (a Jira agent has neither `ENV_FILE` nor `DATA_DIR`): the hand-made runners. The paired ones come from the hub's registry
  `~/.config/charness/runners/paired.json` (`pairedRunners.ts`). `runnersCatalog.ts` is the only place that knows both: hand-made first, then
  paired, a name in both is an error naming it. An entry of either may carry `minFreeGb` and `copyMaxIdleDays` (the disk upkeep, «Prune» below): `ssh.ts` hands them to every script call as `REMOTE_RUN_MIN_FREE_GB` / `REMOTE_RUN_COPY_MAX_IDLE_DAYS`. The bot MCP offers the instruction bullet while the catalog lists a runner
  (`runnerSummary.ts` reads the catalog on every connect, both files stamp-cached).
- **Local cache** — `${XDG_CACHE_HOME:-~/.cache}/charness/remote-run/` (0700): ssh control sockets (`ssh/`), the last probe of each runner
  (`<runner>.probe.json`: named by the runner, and a name is handed on to the next machine — so a paired runner reads it only if it was taken since the runner was paired; removing the runner from the hub deletes it, while a runner that unpaired itself leaves it behind and the pairing floor ignores it), and `jobs/<id>.json` — the main box's own record of which local project a job came from.
  `XDG_CACHE_HOME` is on the tracker agents' environment allowlist (`utils/agentEnvironment.ts`), so the bot and every agent follow the same rule and
  share this one cache — the runner lines of the agents' bullet (`runnerSummary.ts`), the `/runners` screen and `remote-run` itself read the same snapshots.
  (Before, a tracker agent's cache followed `HOME` while the bot's did not, and what one wrote the other could not read.)
- **Runner** — `<workDir>/`: `bin/runner-<sha8>.sh`; `tmp/lease.*` (a lease watcher's state, removed when it ends, `prune` sweeps what a killed one left);
  `p/<slug>/{tree,stage/<job>,jobs/<job>,manifest,deps.hash,used,lock,size-kb}`.
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
- **A Mac whose lid is closed is never picked either** (`lid-closed` report, `probe.ts`): the runner told the hub (the `lid` request, `runners/linkControl.ts`) that its lid is
  shut with nothing keeping it awake, so `probeRunner` returns it without a probe — snapshot only — and `pickRunner` skips it like an offline one (a named one is refused with «has its
  lid closed», the message of a pick that finds nobody names it: «(lid closed, so not used: mac)»), `planRunnerWait` waits for it like for an offline paired runner
  («waiting for a runner with ios (mac has its lid closed)»), `exec` is refused. A job that already runs there is reached by its id (`openJobClient`) and never picked, so
  `status` / `wait` / `logs` / `kill` and a running foreground run are untouched.
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
  give one to a LaunchDaemon), and into `no — the iOS Simulator check failed: <reason>` for any other failure (no runtime installed, the device could not be created). On a Mac kept
  running as an always-on service (`service=system-service`) the answer comes first from the login session's agent (`gui/agent.json`, see «the login session» in
  `runner.sh`): no agent beating means `cap_ios=no` with `ios build: needs a login of <account>` — or, when the link tried to install the agent itself and could not
  (`gui/install-failure`, one line `<cure> <reason>`, `runnerUtility/guiAgentHeal.ts`), with `ios build: the login session's agent could not be loaded (<reason>) - log out and back in as
  <account>, or paste a fresh admin line from /runners in an admin account's terminal` (cure `login`: its definition is in place) or `… could not be installed (<reason>) - paste a fresh
  admin line from /runners in an admin account's terminal` (cure `admin`); a job staged with `--needs ios` (`needs-ios` in its folder) is refused with those
  words by `submit` / `lease` / its own start; with an agent EVERY job's steps (marked or not) run in the account's login session through `gui/requests/`, and without one the
  jobs that do not need iOS run in the daemon as before. `exec` is not routed. The files are written by `charness-runner` (`pause`, `service install`, the iOS check of the service).
- **How the link keeps the machine awake** (`awake=` caffeinate | systemd-inhibit | no, `awake_detail=`; `probe_awake` reads `<state>/awake`, `keepAwake.ts` writes it): a holder
  that is no longer alive is `no`; no file says nothing. `runners` shows it as `keeps awake: yes (…)` / `keeps awake: NO — <why>`.
- **A Mac does not sleep under a job**: a step that `runner.sh` runs ITSELF — the job's command and its dependencies step on a hand-made ssh runner, or on a paired
  runner with no login session to go through, and `exec` — gets a sibling `caffeinate -i -w <pid>` (it ends with the process; the command keeps its signals and exit
  status). Nothing off a Mac or without `caffeinate`. A step the login session's agent runs gets none: a PAIRED runner's link holds the idle-sleep assertion for the
  whole time it runs (`keepAwake.ts`, below), so the machine stays awake under it all the same.

## Contracts

**Which files.** `git ls-files -co --exclude-standard -z`, per checked-out submodule; minus `exclude:`; secret-looking names
(`.env`, `.env.*` except `.example/.sample/.template`, `*.pem`, `*.p12`, `*.key`, `.npmrc`) held back unless `send:` names them — or this
call's `--send` does (`planSendList`'s `callSend`; the files only it opted in are `sentOnRequest` and named on every call); the held-back line is
said when the list changes, not on every submit (`heldBackNotice.ts`: a hash per project in `<cache>/held-back/`); a name with a newline is refused.
`.git` only with `--with-git`.

**Path patterns** (`pull:`, `exclude:`, `send:`, `install-key:`) are compiled once to extended regular expressions that `RegExp` (main box) and
`grep -E` / bash `=~` (runner) read the same way — `remoteRunPathPatterns.test.ts` runs all three over the same samples.

**Submit = stage, the job applies.** The main box stages the tree into `stage/<job>/` (`rsync --copy-dest=<tree>`, never `--link-dest`: a job
rewriting a file in place would change a queued job's stage; `--modify-window=-1`: compare nanoseconds, rsync's whole-second quick
check skips a same-length edit made within a second). The job (`runner.sh job`) takes the project lock, deletes
`old manifest − new manifest` from `tree/`, applies the stage, runs the dependencies step when its key differs from `deps.hash` (a failed one ends with `describe_failed_step`: the FIRST error lines of its output and of the `build.log` the tool names — what `wait`'s last 50 lines do not hold), runs the
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
That record is what ends the lease's wait, and the lease then ends its watcher: so the kill ignores TERM and HUP from the moment it begins (`hard_kill_job`), or a watcher
ended between the record and its SIGKILL left a command that ignores SIGTERM running in a job that already read as killed.

**A job's Pueue task number is not its identity.** Pueue gives a number it has freed to the next task added, and `pueue wait` / `pueue remove`
act on whoever holds a number (a number nobody holds: `wait` returns 0 at once). A job killed while queued loses its task that way, so
`kill` marks it `task-removed` and writes its exit; every wait (`wait`, `logs -f`, the lease) is cut as soon as the job's exit file exists
(`wait_for_task`), and prune removes a task only when it is not marked and Pueue says the task under that number carries the job's own
label (`check_task_belongs_to_job`: `pueue status --json label=rr-<job>`).

**Prune** (`prune_work`; on every submit in `prepare`, and `prune` itself) removes jobs older than 3 days that ended (an exit file, no task, or — for one an earlier script SIGKILLed unrecorded —
a process that is gone), stage folders older than a day **unless their job is
still queued** (a job can wait behind a busy group for days), lease/probe scratch state, and project copies — two rules, both skipping a copy that is IN USE
(`check_copy_dir_is_busy`: its lock is held by a live job — a stale lock is not —; an `exec` runs in it (`exec.<pid>`, written by `cmd_exec` before it looks at the copy, removed by its exit hook, which also
touches `used`; the marker of a pid that is gone, or that a reboot gave to a process that is not the script's, is cleared); a job of it waits or runs (a task, no dead process); a job of it ended less than 60 minutes ago (`result_keep_min`: its result files are about to be
fetched); or a job of it is being submitted — no task yet, and its job folder or its `stage/<job>` touched (ctime: rsync keeps the source mtimes) less than 30 minutes ago, because a first upload of a
big project is quiet in the job folder for as long as it takes) and the copy of the job being submitted (`prepare`'s slug). `used` means last ACTIVITY: `prepare`, `exec` (start and end), `finish_job`, `finish_killed_job`:
- **by age**: unused (`p/<slug>/used` older than) 3 days — `copyMaxIdleDays` of the runner's config, `REMOTE_RUN_COPY_MAX_IDLE_DAYS` on the script;
- **by free space**: while `df -Pk` of the work dir says less is free than the target — the smaller of 60 GB and 15 % of the disk, `minFreeGb` / `REMOTE_RUN_MIN_FREE_GB` (0 = off) — the copy with the oldest `used` mark goes first
  (`prepare` touches it, so does `exec`), then the next, until the target is met or only protected copies are left.
A removal moves the copy to `p/.trash-<slug>-<pid>` with one rename (a submit that meets the name afterwards makes a copy of its own; a cut-off removal is finished by the next prune — not while the pid in
the name lives, nor while the folder holds something in use), and asks the busy question AGAIN of the moved folder (the check that chose the copy and the rename are two steps, and a `prepare` can land between them):
a copy that turned out in use is put back (`remove_project_copy` returns 3; when its name was taken meanwhile it stays under its trash name). Then it makes the tree writable (`chmod -R u+rwX`:
CocoaPods' xcframeworks are read-only folders that stop `rm`), removes it, and prints `removed=<slug> freed_kb=<n> why=idle|space` (freed = the change of free space across it; `stuck=<slug>` when it would not go; nothing for
a copy another prune took first or one that turned out in use) —
`submit.ts` shows each as one line. The free-space loop stops, with `stopped=<slug> freed_kb=<n> size_kb=<n>`, after a removal that freed under 1 GB from a copy whose written size is over 1 GB (`no_progress_freed_kb`:
APFS keeps the space of deleted files while Time Machine snapshots hold it; removing every copy would still not help) — but only after `no_progress_stop_after` (2) such removals in a row, since a job writing to the same disk meanwhile can eat what one removal freed («in a row» counts only removals that can say something: a copy measured at most 1 GB, or not measured, between two of them neither counts nor resets the count; a removal that freed what it should resets it). The copy-removal step of
`prune_work` is one at a time per work dir by a lock file `tmp/prune.lock`, which is the PROJECT LOCK's own mechanism (`acquire_prune_lock` calls `create_lock_file`, `check_lock_is_stale`, `break_stale_lock` with `job`
empty and `lock_max_age_min` set — «The project lock» below has the proofs for a holder that is gone; a lock broken for its AGE, with a live holder, is outside them, see the comment of `acquire_prune_lock`): the exclusive create makes the creator win whatever the clocks and the pids say (markers ordered by their mtimes would let two prunes
that start in the same tick, or a bash 3.2 that compares whole seconds, both pass). It is held while its holder is one of the script's own processes and it is younger than 2 h (a pid can be given to anything). A prune that
finds the lock held leaves the step when it was started as the probe's detached `prune` (`prune_work … skip`) or when its own disk is not short (what the other one does is what the idle copies need), and otherwise waits for
it up to `prune_wait_sec` (10 min), then goes on WITHOUT the lock (and never gives back one it did not take): a waiting prune removes alongside the first one only after that wait, or when it breaks a lock its holder has
held for over 2 h. `prepare` ignores SIGPIPE while it prunes, so a caller that hangs up (its call timed out) does not end the removal after the copy it is at. `prepare` dies with «the project copy was
being removed» when its job folder is gone after the prune. `prepare` ends with **exit 28** and one line on stderr when the disk is still short after the prune (free, target, the biggest copies from their `size-kb`, the way out); it takes back the job folder and stage it made, and a first-ever copy of the project with them.
`prepare` therefore gets a 15-minute call timeout (`prepareCallTimeoutMs`): removing copies of tens of GB takes minutes.
The refusal measures nothing: it names the copies that have a written `size-kb` and counts the others («and N not measured yet»; `prepare` starts `measure-copies` just before it, so the next submit has sizes).
`probe` never prunes inline (it must answer in seconds, or the runner would read as offline): on a short disk it starts `prune` **detached** (`start_detached_run`, one at a time by a pid file in `tmp/`) — only when called as `probe <work> prune`, which a
VIEW of the runners does (`probeRunners` with `isPruneAllowed`: `remote-run runners`, the bot's `/runners`); the probe `chooseClient` makes for a run or an `exec` does not: that prune has no `keep_slug`, and the project about to be used is typically the least recently used copy. It reports `disk_total_mb`, `disk_min_free_mb`,
`copies_count`, `copies_size_mb` and `copies_unmeasured` — the sizes are the `p/<slug>/size-kb` figures that the detached `measure-copies` (started by `prepare` and `probe` when a figure is missing or older than the copy's `used` mark — a copy is measured again only after it was used, never by the clock; `du -sk` of a copy takes long) wrote; `runners` and the bot's `/runners` show count and total.

**Clean** (`charness remote-run clean [<slug>]`; `runCleanCommand` over `runner.sh clean <work> <slug>`) is the explicit twin of the prune for ONE copy, on every runner of the catalog in parallel: the copy of the project the command is run
in (`getProjectContext(cwd).slug`; no «project» groups several slugs, so there is no wider form) or the named one. The script does no removal of its own: `cmd_clean` takes the copy-removal lock (`begin_copy_removal … always`: waits for a prune at work up to
`prune_wait_sec` whatever the disk says, then goes on), asks `check_copy_is_busy` and removes with `remove_and_report_copy … clean` — the same rename, second look at the moved folder, `chmod`, `rm` and `removed=<slug> freed_kb=<n> why=clean` line as the
prune, so a job that turns up between the check and the rename puts the copy back. What differs: `result_keep_min` is 0 for it (a job that ENDED lately protects a copy from the prune, which guesses; the owner who cleans does not need it), while a job that runs or
waits, an `exec`, a job being submitted and a held project lock refuse it. The script answers with ONE line (`removed=` · `absent=<slug>` · `busy=<slug> kind=<lock|exec|running|queued|submitting|results> job=<id|->` · `stuck=<slug>`) and exits 0
whenever it could answer; `cleanReport.ts` parses it and words the line per runner. The CLI exits 125 when a copy is still there although it was asked to go (busy, stuck, a call that ran past the 15 minutes of `prepareCallTimeoutMs`, a failure) and 0
otherwise — also when a runner could not be reached (a paired one whose link is down or whose Mac's lid is shut is not called, as for a probe), so a sleeping Mac does not fail the closing of a task. A removal that the caller hangs up on goes on (`trap '' PIPE`). The
manager skill and the bot MCP's remote-run bullet tell agents to run it when a task is closed; the bullet has the shortest wording that says so (the Telegram text is near Claude Code's cut).

**A recorded pid is only believed while it is the script's own** (`check_runner_pid_alive`: `kill -0` AND a command line that names the script's file — `…/runner-<hash>.sh` of any version, or `…/runner.sh` from a checkout —,
never `actions-runner/runsvc.sh`, `runner-01/runsvc.sh` or whatever else has «runner» in its name or its folder: the last path component must be exactly `runner-<8 hex>.sh` or `runner.sh`; the command line is asked in full, `ps -ww`, since procps cuts it to an exported `$COLUMNS`; a `ps` that cannot answer counts as alive). After a crash or a reboot the number may belong to a daemon, and a bare `kill -0` would keep a copy in use, a project's queue
behind a lock nobody holds, a job «running» in `probe`, and — worst — let `kill` signal a stranger's process group. It guards every pid the script wrote down: a job's `pid` file (`check_job_dir_ended`, `check_job_ended`, `probe_jobs`,
`signal_job_group`), a project lock's holder and a breaker's right (`check_lock_is_stale`, `check_breaker_is_alive`), an `exec` marker, a trash folder's remover and the pid file of a detached run.

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
and exit 130/143/129. A closed stdout (`| head`) is the same interrupt under the name SIGPIPE, exit 141: Node ignores the real signal and
turns the EPIPE of the write into an error, which `createProcessIo` (`watchClosedOutput`) raises through `raiseStdoutClosed` to every
`addInterruptHandler` — a foreground run and `exec` kill what they own and say why (`describeInterruptCause`); `logs -f`, `wait` and the
read-only commands own nothing and just end; a closed stderr is dropped. The real SIGPIPE is never listened for: removing its last listener
makes Node stop ignoring it, and the next write to any closed pipe of the process would end the process (a unit-test process died of it). The watcher reads the stream with plain blocking reads and compares clocks — never `read -t`, whose exit status for a
timeout differs between bash 3.2 and 4+ — and replaces its beat file atomically (an empty read must not be an arithmetic error: it ends the
whole subshell).

**Exit codes of remote-run itself**: the command's own pass through; 125 it failed (no runner, ssh, sync, deps step), 124 timeout,
130/143/129 interrupted locally, 141 stdout closed (a pipe into `head`), 137 job killed, 2 bad usage.

## Trust

- The runner is **not trusted to write into the main box.** Result files are rsynced with `--no-links` into a temp folder, then only regular
  files a `pull:` pattern names are copied into the project (`safeCopy.ts`: no symlink on the way, never over a directory, no setuid).
  *Which* project is the main box's own record (`jobRecords.ts`), never the job's `meta.json` on the runner.
- ssh is always `BatchMode=yes`, host keys as the operator's ssh config says (never `StrictHostKeyChecking=no`); no environment variable of the
  main box goes over; names that reach a remote shell are checked (`runner.sh`: `check_name`, job ids, relative paths).
- A runner runs the project's code: use an account of its own, no secrets on it.

## Tests

Unit tests (`src/__tests__/remoteRun*.test.ts`) cover every planner (the paired runners' ssh options and catalog in `remoteRunPairedRunners.test.ts`, the wait in `remoteRunRunnerWait.test.ts`), the CLI entry, the MCP bullet, the runner script (probe, apply step,
prune, the lease through `exec`, the disk upkeep — `remoteRunRunnerScriptDisk.test.ts`: LRU order, the protected copies, read-only folders, the refusal and the sizes, against the real script and a `df` / `du` on the PATH that read a `fake-kb` file per copy), ssh quoting against a real shell and file selection against real git repositories.
The flow (`remoteRunE2e.test.ts` and `remoteRunLifecycleE2e.test.ts`, side by side with a runner each, helpers in `remoteRunE2e/remoteRunFlowHarness.ts`: a single file was close to the 20 minutes a flow may take) drives the BUILT CLI against a throwaway loopback `sshd` (no root) and a private Pueue in temp dirs
(`remoteRunE2e/remoteRunFlowKit.ts`), with decoy jobs that write their own and a child's pid so "nothing left" is asserted on real pids.
`remoteRunPairedE2e.test.ts` runs the same CLI through a PAIRED runner (the runner-link flow's hub and runner machine, `runnerLinkE2e/runnerLinkFlowKit.ts`): pass / fail codes, live output, `--bg` + `wait`, interrupt, `exec`, paused, `--needs` with the runner offline.
A killed or timed-out flow cannot leak daemons: `remoteRunFlowSweep.ts` ends everything that names the layout or runs in it, from the
test's teardown, from a detached reaper, and at the next start. It needs `sshd`, `ssh`, `rsync`, Pueue and `yarn build`; a local run without
them is skipped with the reason, CI (`CI=true`) installs them and fails without.
