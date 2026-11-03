# `src/runnerUtility/` — `charness-runner`

The program that turns a machine into a **runner** of a charness hub (`src/runners/` is the hub side; read its README first for the
safety line and the gate protocol). It needs outbound internet to the hub's sshd and nothing else: no inbound port, no admin, no VPN.
Node ≥ 22.12, `ssh`, `tar`; Pueue and rsync it installs or finds itself.

## Shape

```
pasted line (sh) ──ssh bootstrap──► unpacked hub package, NO node_modules
   └► runnerCli.js pair --bootstrap <folder> <code>       builtins only (appInstall.ts, progress.ts, runnerHome.ts)
         └► npm ci --omit=dev --ignore-scripts (the package's own lock) into ~/.charness-runner/app.<id>/, then starts THAT copy: `pair <code>`
               └► runnerCommands.runPair: check screen → redeem over ssh (temp key, pinned hub host key) → config.json,
                  `current` → app.<id>, launcher, tools (Pueue, rsync) → «Paired with charness …»
charness-runner run  (through bin/charness-runner, a sh loop: exit 75 = restart onto an update)
   └► linkLoop: ssh2 client → hub (pinned host key, runner key) → exec('link') → readUntilGateMarker → channel
         └► runnerServers: link server (the gate is its ssh CLIENT) ─direct-tcpip channel─► session server (the hub's stock ssh)
                                                                                              └► exec: bash -c <cmd>, clean env
```

## Files (`~/.charness-runner/`, 0700)

`config.json` (who it serves: hub address, **pinned** host key, the hub's public key — the only key the servers accept — its id and name,
the id of the installed package), `status.json` (link state, written by `run`, read by `status`), `keys/` (the client key, the built-in
server's host key — both from `generateEd25519KeyPair`, which reads every key back), `app.<id>/` + `current` (installed copies of the
hub's package; `current` is a symlink replaced atomically; the previous copy is kept), `bin/` (`charness-runner` launcher, `pueue`,
`pueued`, a built `rsync`), `env` (the operator's `KEY=VALUE` lines, read again for every job), `work/` (phase 1's work dir), `pueue/`
(a private Pueue: own directories and unix socket; its daemon is started by `run` if it is not answering — a link restart never touches
the queue), `logs/`, `build/`.

## Contracts

- **The first step runs without dependencies.** `runnerCli.ts` imports Node built-ins, `appInstall.ts` and `progress.ts` only; everything else is
  loaded lazily after the install. `installDependencies` runs `npm ci --omit=dev --ignore-scripts` (`npmInstallArgs`: exactly what the package's lock records — `runners/runnerLock.ts`) ASYNCHRONOUSLY, so the step line can show that something is happening.
- **Every long step is named in one line** (`progress.ts`, builtins only — the root step uses it too): on a terminal the line is redrawn with dots that
  cycle (`.`, `..`, `...`) while the step runs and ends with «— done» / «— failed» (also when the work returns a failure instead of throwing: `checkIsFailure`); the drawn line is cut to the terminal's width less one column, asked at every redraw, and the step names (`stepLabels`) are short enough to fit 80 columns whole — a line that wraps leaves a new row behind at every redraw; on a pipe or a file, or on a terminal whose width is unknown or under 40 columns, it is one plain line when the step starts. The
  shell part of the pasted lines prints its own two or three first (`bootstrapLine.ts`); the work of a step must not block the event loop. The test seam
  `CHARNESS_TEST_RUNNER_NODE_MODULES` (set only by a flow's environment) links a folder as `node_modules` instead — no registry in a flow.
- **The servers accept ONE key** — the hub's, with a real signature check (`createHubAuthenticator`) — and serve nothing but `exec`: no
  shell, pty, subsystem, x11, agent, or forwarding in either direction; `env` requests are accepted and ignored. The link server serves no
  session at all, it only passes `direct-tcpip` channels to the session server.
- **Exec semantics are sshd's.** `bash -c <cmd>` in a clean environment (`execEnv.ts`: HOME, USER, LOGNAME, LANG, TMPDIR, a PATH of
  `~/.charness-runner/bin` + the `node` folder + Homebrew + system — `getJobPathDirectories`, the one place that order is written —, the Android SDK where installers put it, then the `env` file); the
  `yarn` / `pnpm` of that PATH are made sure of at every link start and `check` (`packageManagerShims.ts`: a manager neither the Node's folder nor the
  system offers gets Corepack's shim in `<root>/bin`, a shim the Node now makes unnecessary is removed; a Node without Corepack is reported, never fatal —
  a link restarted under another Node otherwise lost `yarn` for every job, exit 127), and `runner.sh probe` reports `job_node` / `job_yarn` under that same PATH (`runners` shows them); the
  client's EOF is the command's EOF (phase 1's lease relies on it); a CLOSED channel closes the pipes and does not kill the command; the
  exit status or signal goes back. A running command counts as busy until the process really ends.
- **The attempt ends with the `link` CHANNEL.** The hub's gate dying, or the link being cut, closes that channel while the connection
  to sshd stays up and answers keepalives; the loop watches the channel as well as the connection.
- **A lost answer is recoverable.** The hub commits a redemption before the runner has the answer, and the temporary key is spent. So the
  runner writes `pairing.json` (the hub's address and the code's id — no key) BEFORE it redeems; after any failure of the redemption, and at
  the start of `pair` and `run` when it finds that file without a `config.json`, it asks the gate for its `identity` with its own
  permanent key: the hub's answer is the reply `redeem` gave (`pairingRecovery.ts`). A key the hub does not know means nothing was
  committed and the file is dropped; a hub that cannot be reached leaves it for the next try.
- **The recorded package is the one downloaded.** The pasted line passes `--archive` and `--package-id` (the id the hub announced in the
  marker line of `bootstrap`); the first step hashes the archive against it (`packageId.ts`, builtins only) and `config.json` records THAT
  id. The id in the redemption reply is only what is available now — if it differs, the first `link` triggers the update.
- **Reconnect.** Backoff 1 s doubling to 5 min, ±20 % jitter, reset by a link that held 30 s. The hub refusing the key (a removed runner) is
  the `removed` state: `status` says «This runner was removed by <hub>. Pair again with a new line from /runners.» and it asks once an hour.
- **Updates.** The `link` marker names the hub's package id, and a LINKED runner asks again every 5 minutes (`version`, a short exec on
  the connection it already holds; the test seam `CHARNESS_TEST_TIMINGS` `runnerVersionPollMs` may shorten it); a runner whose id
  differs, **idle** (no command over the link), fetches the package (`package` request on its own connection), checks the archive hashes to the announced id, installs it next to the running copy,
  points `current` at it and exits with 75 — the launcher starts the new copy. A busy runner waits until its last command ends; while the
  update installs the link is closed on purpose and that closing does not start another attempt; a failed update is tried again by the
  next poll after a 10-minute cooldown. Pueue jobs are not commands over the link: a queue never blocks an update.
- **Tools.** Pueue 4.0.4 from the pinned release binaries, each checked against its sha256 before it is kept (`toolInstall.ts`;
  hashes taken from the v4.0.4 assets). rsync ≥ 3.1 is found (PATH, Homebrew, `/usr/local`, `/usr/bin`; Apple's `openrsync` does not count:
  no `--copy-dest`, no `--modify-window=-1`); otherwise rsync 3.4.1 is built from its pinned source with `cc`/`make`, or the one command to
  run is named. The build step is not exercised by the tests (it needs minutes and a compiler).
- **The account.** An admin account (macOS `admin` group; Linux root, `sudo`, `wheel`, `admin`) gets a warning: the agents' code runs with
  its rights.

## Services (`service install|uninstall`)

Two services per runner — the LINK (`charness-runner run` through the launcher) and PUEUED (the queue, a service of its own: a link restart
or an update never touches a queued or running job). Names carry a hash of the state folder (`serviceUnits.ts`), so a stand-in or a second
account never clashes with this one.

| | Linux | macOS | macOS, always on |
|---|---|---|---|
| command | `service install` | `service install` | the admin pairing line (below), once, by an admin |
| what | two systemd USER units | two LaunchAgents | two LaunchDaemons with `UserName=<account>` |
| runs | at boot and without a login, once lingering is on | while the account is logged in (switched away included) | always, also logged out and across fast user switching; as that account, with no extra rights |
| admin | none; `loginctl enable-linger` is tried by the account itself, and where polkit wants an admin the one `sudo loginctl enable-linger <account>` line is printed (the units are installed anyway); an admin can also do it for the account (below) | none | once |

`KillMode=process` (systemd) and `AbandonProcessGroup` (launchd) keep a stop of the link from killing what it started: the commands it
served see their pipes close and finish by themselves (phase 1's lease watcher kills its job on the closed stream). For that to be
enough the launcher passes TERM / INT / HUP on to the app. Pueue runs at `nice`, never `taskpolicy -b` (on Apple Silicon that pins jobs
to the efficiency cores). One kind at a time: installing one while the other's files exist is refused with the command that removes it.

**The admin line** (`runners/bootstrapLine.ts`, `buildAdminBootstrapLine`) does the always-on install, and the guarantee it keeps is: **root never
executes, reads through or writes into anything the runner account can change** (that account runs the agents' code). So root does not run
this program's `service install` from the account's folder, and `--system` on the runner is refused. Instead the line, as root, fetches the
package into a root-owned folder in `/tmp` (readable by the account, `--no-same-owner`), and runs
`node <that copy>/dist/runnerUtility/rootServiceCli.js install <account> --bootstrap <folder> --archive <file> --package-id <id> <code>` —
**Node built-ins only** (`adminService.ts`, `isolatedCommand.ts`, `pairArgs.ts`, `serviceCommon.ts`, `serviceUnits.ts`, `runnerHome.ts`,
`commandRunner.ts`, `progress.ts`), because the copy has no `node_modules`. That one program has the account pair itself from the copy
(`sudo -u <account> -H node <copy>/dist/runnerUtility/runnerCli.js pair … --service-follows`: the pairing prints «the always-on service is installed
next» instead of the «keep it running» commands — `pairArgs.ts`, builtins only because `runnerCli.ts` reads it before any dependency exists) and, only
when that worked, installs the service. The account is looked up in the passwd database, never from its files.

**No step of the account's has a terminal.** The account runs the agents' code, so what it can change must not get the admin's terminal — through
`/dev/tty` a child can write over the screen and, where the system allows it, type into the admin's shell once `sudo` has ended. Every call that
runs AS the account (the pairing, the preparation, the user manager, the service install, the account lookups) goes through ONE runner
(`isolatedCommand.ts`, `runCommandIsolated`): the child starts in a session of its own (`setsid`: no controlling terminal), its standard input is
`/dev/null`, and its output is piped through the root step, which strips the control characters (escape sequences, carriage returns, bells,
bidirectional overrides) before printing or parsing it — what the account says reaches the operator as plain text. A signal to the root step (Ctrl-C)
is passed on to the child's whole group and the root step then dies of it itself (a second signal kills the group outright and ends it at once); a deadline kills the whole group. The
step is settled by the child's EXIT and not only by its pipes closing: a descendant of the account's code that left the group (`setsid`) and keeps the output
open would otherwise hold the paste for ever, so the pipes are cut a short grace after the exit, the deadline or the first signal. (The pairing's own progress
lines come through as plain lines — a terminal-less child draws no dots.) Root's whole part:

- macOS: `sudo -u <account> -H <its launcher> service system-step prepare` — the ACCOUNT's side (`runSystemStep` in `serviceManager.ts`: it is
  paired, no LaunchAgents, Pueue's queue handled, Pueue's configuration and the `system-service` record written; one JSON line back) — then
  root renders the two LaunchDaemon definitions from the account's name and home alone (the answer decides nothing about their text), writes
  them into `/Library/LaunchDaemons` (a folder only root can write), hands them to root:wheel with `lchown`, and loads them with
  `launchctl` (`installLaunchdJobs` in `serviceCommon.ts`, the same rollback the LaunchAgents have). A first install that fails is rolled
  back, and `system-step abandon` (again as the account) forgets the record.
- Linux: `loginctl enable-linger <account>`, then the account's user manager is asked until it answers `running` or `degraded`
  (`sudo -u <account> -H env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user is-system-running`, once a second, 20 tries), then the plain
  `service install` runs AS the account the same way. The result is the ordinary user service — the account removes it itself.

**Removing an always-on service is not this program's to say.** An admin stops the two LaunchDaemons with plain `launchctl` / `rm`, and the commands come
from the hub (`charness runners service-removal <name>`, `charness runners remove`, the Remove button of `/runners`; `src/runners/serviceRemoval.ts`) —
`service uninstall` and `unpair` on the runner print only a pointer to them (`systemServiceRemovalPointer`) and, once the daemons are gone, forget the
service's record. The agents run as this account and can change what this program prints, so a command it printed could be anything.

**What the admin line trusts.** Pasting it runs code from the charness host as root on this machine (see `src/runners/README.md`); the plain
line trusts the host only with the runner account. A Mac's launcher and the daemons' `PATH` carry the Node the line picked: the package's
`remoteRun/pickNode.sh` (run as root from the root-owned copy) chooses it — `sudo`'s own `node`, then `/opt/homebrew/bin`, `/usr/local/bin`; never one whose REAL
path is under a home folder, one the account can run and cannot write (nor a folder above it), ≥ 22.12 — and refuses with the way out when none fits; the
root step asks the same again before it runs anything (`findPathAccountCanWrite`, `findHomeContaining`), and `service install` as the account refuses a Node in ANOTHER user's home. **Homes the account can read**
(`homeFolders.ts`): the admin line's root step asks AS the account (`sudo -u <account> -H test -r <home> -a -x <home>`) about every folder under `/Users` and
`/home` but its own and says last which it can read, with `sudo chmod 700 <home>` for each; the plain line's pairing does the same as the account
itself (and warns about a Node in another user's home). What the account's own program prints is not the admin's source for this. The daemons log through the account's own shell
(`serviceUnits.ts`): launchd is given `/dev/null` for output and no working directory, because it may open them as root before it switches to
`UserName` and the account could have swapped the logs folder for a link; `sh`, already the account, makes the logs folder, enters the home and
opens `logs/<job>.log` itself (so a folder the account cleaned away never leaves a job failing silently into `/dev/null`).

A failed root step is the line's one «`<account>` is paired, but has no service: fix the above and paste a fresh admin line» (the same on both
systems); a fresh line finds the account paired (`runPair` with `--service-follows` says so, CLOSES its own code on the hub with `cancel`, and returns 0) and only installs the service. The
pairing runs with `sudo`'s `PATH`, not the account's login one, so Node must be installed system-wide. **Removing** an always-on service is plain
`launchctl` / `rm` commands for an admin, made by the HUB (`runners/serviceRemoval.ts`: `charness runners remove` / `service-removal <name>`, the Remove button of
`/runners`); `service uninstall` on the account prints only a pointer to them, and forgets the record once the daemons are gone from `launchctl` and from
`/Library/LaunchDaemons`; `unpair` points there.

**Install order** (`prepareManagedStart`) — nothing is started until all of it is true, and a start that fails is rolled back (the services
stopped, their files and the record removed: nothing half-installed):
1. the Pueue binaries exist (a unit that cannot start would restart in a loop);
2. no foreground `charness-runner run` is linked (two links for one runner fight for the hub's socket) — install refuses and says to stop it;
3. a Pueue daemon that NO service owns is dealt with explicitly: while it runs jobs (Running or Paused) it is left alone and the install is
   refused — Pueue kills the jobs it runs when it stops — and an idle one is shut down so the managed one can take the socket. A
   re-install (the record exists) leaves the service's own daemon alone;
4. Pueue's private configuration is written, and the service record (`~/.charness-runner/service`) is written — so the queue starts WITH
   its configuration, and the link, seeing the record, waits for the service's queue instead of starting a daemon of its own;
5. for a LaunchDaemon (installed by root) the queue's folders and the record are handed to the account.

**Uninstall** stops the units / jobs and CHECKS they stopped (`systemctl show -p ActiveState`, `launchctl print`) before it deletes
anything: a service-manager failure, or a unit still running, is reported as not removed and the definitions and the record stay, so it
can be run again; units that are already absent count as removed. `run` does not start its own Pueue daemon when a service manages it —
it waits for the service's.

## State the probe reads (`runner.sh probe`)

`~/.charness-runner/paused` (an empty file; `pause` / `resume`), `~/.charness-runner/service` (one word, `user-service` or
`system-service`, while a service is installed), `~/.charness-runner/ios-check.json` (one line:
`{"status":"pass|fail|skipped","checkedAtMs":…,"xcode":"16.2 (16C5032a)","reason":…}`).

## The iOS Simulator (`iosCheck.ts`)

Apple: the Simulator is not available to a LaunchDaemon or to a process started as another user. So the runner does not infer `ios` from
«Xcode is installed»: every time the link starts (whoever runs it: a terminal, an agent, a daemon — the answer depends on that), and again whenever Xcode changes (looked at once an hour), it really tries — create a device,
boot it, wait for `bootstatus`, delete it (bounded, 180 s; the device is deleted whatever happened). `pass` → the probe says `ios`;
`fail` → «ios: no — needs the runner user's login session» when the Simulator itself refused to boot (the reason begins with
`iosBootFailureReasonPrefix`); any other failed check shows its own reason — `simctl <step> failed: <its error>` when a simctl command does
not work at all (CoreSimulator cannot be reached), «no iOS simulator runtime and iPhone device type are installed» only for a list that
worked and came back empty, «the Simulator device could not be created». On an always-on Mac the check is the login session's agent's (below), not the
daemon's link (which would only write «needs the runner user's login session» over it). The previous record is DELETED when the link starts, and a paired Mac with Xcode and no record answers «ios: no
— the iOS Simulator is being checked» until the new one is written (`runner.sh`), so an answer given by another account or kind of service is
never offered meanwhile. A record that cannot be written is logged by `run`, and the Mac then stays «being checked».

## The login session's agent (`guiAgent.ts`)

An always-on Mac's link and queue are LaunchDaemons in the System session, where Xcode's nested builds crash and the Simulator will not boot. The admin
line therefore also loads a LaunchAgent into the account's own GUI session (`com.charness.runner.gui.<hash>`, `LimitLoadToSessionType` Aqua, restarted only
after a crash, no `AbandonProcessGroup`, which ends what the agent itself left in its own group — NOT its steps, each a process group of its own): `charness-runner gui-agent`. Its definition is the account's own file in
`~/Library/LaunchAgents` (written by `service system-step prepare`, run as the account; root never writes in the account's tree) — the root step only
`launchctl bootstrap gui/<uid>`s it when `print gui/<uid>` says there is a session (booting a loaded one out and waiting until `print` no longer finds it
first: `bootstrap` right after `bootout` fails with error 5), and says in a line, never as a failure, when there is none (it then loads at the account's next
login). `prepare` also refuses a RE-install while Pueue runs a job (the bootouts would cut it).
- **The protocol** (`<state>/gui/`): `agent.json` is the heartbeat (pid, uid, `startedAtMs`, `beatAtMs`, every 5 s; `runner.sh` calls it gone after 20 s or
  when the pid is not alive; `stop` removes it at once). A job that needs iOS (`needs-ios` in its folder, written for `--needs ios`) on a runner whose
  `service` is `system-service` runs each step (`run_step`) as `requests/<job>.<n>/`: `cwd`, `command`, `locale`, `log`, `env` (the job's `-e` lines), `owner`
  (the job script's pid), then `go`. The agent starts `bash -c <command>` in a process group of its own — the environment of an ssh exec (`readExecEnv`),
  `LC_ALL`, then the job's lines — with the job's log opened for append, and writes `exit` (a signal is 128 + its number; a folder that is gone is 126).
  `kill` ends the group (TERM, KILL after 10 s); a dead `owner` ends it too and removes the folder; a started request is never started twice (`started`).
  The script cuts a step with 125 when the heartbeat is gone or another `startedAtMs` answers — and ENDS its process group first (`pgid` in the request folder,
  written by the agent: TERM, KILL after the runner's grace), because a step is a `setsid` group that a dying agent does not take along: without it an `xcodebuild`
  would run on in the tree while the job's lock went to the next job. An agent that starts ends the groups of the instance before it the same way
  (`reapStepsOfEarlierInstances`) and answers a waiting script 125; a vanished script's folder is removed with its group ended.
- **No session** → `submit` / `lease` refuse the job with `ios build: needs a login of <account>`, a queued job refuses at its start, `probe` says
  `cap_ios=no` with the same words (ahead of the boot check's own answer). A runner kept running as a user service, or by hand, is in a session already: none of this applies.
- **The link of an always-on Mac runs no Simulator check** (`checkIsLoginSessionAgentRunner`): the agent does, from the session where the Simulator can boot.
- **It leaves** with the restart code when an update replaced the package and no step runs (launchd starts it again on the new program), and for good —
  removing its own definition — when its daemons' definitions are gone from `/Library/LaunchDaemons`, which is how it goes away with them.
- **Not verifiable on Linux**: what launchd does with the definition (the `bootstrap` into `gui/<uid>`, `LimitLoadToSessionType`, the session ending
  under the agent) and whether Xcode's nested build then really passes in that session — the real run's own finding (it passed from a transient LaunchAgent in
  `gui/<uid>`); the protocol, the script's routing and every command line are tested with real bash on Linux.

## Silent Simulators (`simulatorSilencer.ts`)

A Simulator plays through the HOST's audio output, so an iOS job on a Mac would be heard by whoever sits at it. The login session's agent (below) — or the
link itself, when the link runs in a login session (`planSimulatorWork`: a user service, `charness-runner run`) — runs `createSimulatorSilencer` every 2 s
(`createSilencerLook`: never two ticks at once): each booted device gets `xcrun simctl spawn <udid> notifyutil -s com.apple.springboard.volumestate 0` and `-p`
once `bootstatus` has returned — never `bootstatus -b`, which BOOTS a device that is not booted (one a job's teardown, or the iOS check's `delete`, shut down
since the list was read) — per-device state, nothing of the Mac's own volume, output or mute. The volume is 60 again after every boot (also
`erase`, `clone`), so a device that is no longer booted is forgotten and its next boot is new; `sim_volume` in
`<device data>/var/run/simulatoraudio/audiosettings.plist` (`plutil -extract sim_volume raw`) is read back after 30 s and the command repeated, three
times in all, then one warning in `gui-agent.log` and no more for that boot; a failing command waits 10 s before the next try. The commands run are
exactly the five of the allowlist the test pins (no shell, a device id that is not a UUID is dropped). The mechanism is a third-party measurement, not
Apple's documentation, and its effect lags the command by 4–13 s: what a real Simulator then plays is for the first real run on a Mac to confirm. Unverified too: a
Simulator booted from the System session (an `exec` on an always-on Mac) may not be listed by the agent's `simctl` (each session has its own CoreSimulator service).

## `pause`, `resume`, `unpair`

`pause` writes the flag, `resume` removes it (the hub has a pause of its own, set from `/runners`). **`unpair` makes «unpaired» true.** In
order: (1) a system service (installed by an admin) is not touched from the account — unpair stops there with the admin command and changes
nothing, because a pairing cannot be forgotten under a running daemon that holds it; (2) the hub is told (`unpair` request: it removes the key
line and cuts the link), unless `--local`; (3) the link on this machine is STOPPED and checked to be gone — the user service removed
(verified, see above), a foreground `run` sent TERM and then KILL until its pid is really gone (`localLinkStop.ts`; a pid that now belongs
to another program is recognised by its command line and left alone) — because a running link keeps the keys in memory and goes on serving
the hub's commands and reconnecting whatever the files say; (4) the queue's jobs are stopped (`pueue reset --force`); (5) only then
`config.json`, the keys, the status, the pause and the iOS result are deleted. The installed program, the tools, the work folder and the
queue (now empty) stay. A step that fails stops the command with exit 1 and says what is left; a hub that cannot be reached leaves
everything as it was, and `unpair --local` forgets the pairing here only.

## When the hub removes the runner

Pueue outlives the link by design (a link restart must never kill a job), so a removal has to end the work the hub's agents left running
here — and a refused key alone is not proof of a removal: a hub whose home folder is locked (a volume not yet unlocked after a reboot), whose
file modes changed or whose sshd setting was edited refuses the key the same way, for hours. So the jobs are stopped on evidence only
(`stopAllPueueJobs`: the running ones are killed, the queued ones removed, and it waits until the queue is empty):

- **The hub does it itself** when it removes a runner that is online: `runners/runnerRemoval.ts` pauses the runner and runs
  `pueue reset --force` over the link WHILE IT IS STILL PAIRED (the gate ends a link as soon as its runner has left the registry, which
  would cut the reset off), then removes it and cuts the link. This is the normal case (`/runners` → Remove, `charness runners remove`);
  a stop that fails is logged and said so (the CLI's last line, never «stopped» when it was not), and the removal goes through anyway.
- **The hub's own answer.** A key line that outlived the registry entry makes the gate refuse `link`; the runner then asks `identity`,
  which the gate answers for a runner that is not paired (`{ok:false}`). That is certain: the runner records `removed` and stops its jobs at once.
- **A refused key and nothing more** (the machine was off when it was removed, and the key line was deleted): after two refusals 15 s apart
  (one could be a key file being rewritten) the status says `removed` and the runner asks again every hour, but its jobs are left alone
  until the hub has been refusing for 12 hours (`unconfirmedRemovalStopAfterMs` in `runners/removalTiming.ts`, which the `/runners` removal texts name too) without ever answering, or any other outcome — a network
  failure, a connection — starts the count again. A restart of the utility starts it again too.

## Tests

`src/__tests__/runnerUtility*.test.ts` (env, home/launcher/config/keys, tools, machine report and admin check, the servers driven
the way the hub drives them, the link loop's backoff / removed state / update decision) and the process-level flow
`runnerAdminLineE2e.test.ts` (stand-ins for `sudo` / `id` / `getent` / `loginctl` / `systemctl` in `runnerAdminLineE2e/`; root is `fakeroot`): the
admin line's refusals (no sudo; a missing, admin or root account; an edited name) before anything is fetched or runs as the account, then
pair-as-account from root's own copy → the root step (no dependencies) → the account's service, with the code unspent until then, a trap
in the account's launcher that fails the flow if ROOT ever starts it, a used line refused, and a failing service manager followed by a fresh
line that only installs the service. Unit tests: `runnersBootstrapLine.test.ts` (the line against a real `sh` with stand-ins),
`runnerUtilityAdminService.test.ts` (root's step: every call that names the account's tree goes through `sudo -u`),
`runnerUtilityService.test.ts` (the account's `system-step`, the removal commands). `runnerLinkE2e.test.ts` (kit: `runnerLinkE2e/runnerLinkFlowKit.ts`): the real pasted line, `charness-runner run`, plain ssh through
`runner-proxy`, restart, gate killed, the runner key's refusals (each against an endpoint the test owns, with the session kept up), an expired
line, a line aimed at a server with another host key, a runner whose hub changes its host key, a package change found by polling, a lost
redemption answer, remove.
`remote-run` through a paired runner is `remoteRunPairedE2e.test.ts` (kit `remoteRunE2e/remoteRunFlowKit.ts`), and `/runners` from Telegram end to
end is `runnersScreenE2e.test.ts`.
