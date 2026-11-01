# `src/runnerUtility/` — `charness-runner`

The program that turns a machine into a **runner** of a charness hub (`src/runners/` is the hub side; read its README first for the
safety line and the gate protocol). It needs outbound internet to the hub's sshd and nothing else: no inbound port, no admin, no VPN.
Node ≥ 22.12, `ssh`, `tar`; Pueue and rsync it installs or finds itself.

## Shape

```
pasted line (sh) ──ssh bootstrap──► unpacked hub package, NO node_modules
   └► runnerCli.js pair --bootstrap <folder> <code>       builtins only (appInstall.ts, runnerHome.ts)
         └► npm install --omit=dev --ignore-scripts into ~/.charness-runner/app.<id>/, then starts THAT copy: `pair <code>`
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

- **The first step runs without dependencies.** `runnerCli.ts` imports Node built-ins and `appInstall.ts` only; everything else is
  loaded lazily after the install. `installDependencies` runs `npm install --omit=dev --ignore-scripts`. The test seam
  `CHARNESS_TEST_RUNNER_NODE_MODULES` (set only by a flow's environment) links a folder as `node_modules` instead — no registry in a flow.
- **The servers accept ONE key** — the hub's, with a real signature check (`createHubAuthenticator`) — and serve nothing but `exec`: no
  shell, pty, subsystem, x11, agent, or forwarding in either direction; `env` requests are accepted and ignored. The link server serves no
  session at all, it only passes `direct-tcpip` channels to the session server.
- **Exec semantics are sshd's.** `bash -c <cmd>` in a clean environment (`execEnv.ts`: HOME, USER, LOGNAME, LANG, TMPDIR, a PATH of
  `~/.charness-runner/bin` + the `node` folder + Homebrew + system, the Android SDK where installers put it, then the `env` file); the
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
| command | `service install` | `service install` | `sudo …/charness-runner service install --system --user <account>`, once, by an admin |
| what | two systemd USER units | two LaunchAgents | two LaunchDaemons with `UserName=<account>` |
| runs | at boot and without a login, once lingering is on | while the account is logged in (switched away included) | always, also logged out and across fast user switching; as that account, with no extra rights |
| admin | none; `loginctl enable-linger` is tried by the account itself, and where polkit wants an admin the one `sudo loginctl enable-linger <account>` line is printed (the units are installed anyway) | none | once |

`KillMode=process` (systemd) and `AbandonProcessGroup` (launchd) keep a stop of the link from killing what it started: the commands it
served see their pipes close and finish by themselves (phase 1's lease watcher kills its job on the closed stream). For that to be
enough the launcher passes TERM / INT / HUP on to the app. Pueue runs at `nice`, never `taskpolicy -b` (on Apple Silicon that pins jobs
to the efficiency cores). One kind at a time: installing one while the other's files exist is refused with the command that removes it.

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
`fail` → «ios: no — needs the runner user's login session». A helper in that user's GUI session is a follow-up, only if the check fails
where it matters. The previous record is DELETED when the link starts, and a paired Mac with Xcode and no record answers «ios: no — the iOS
Simulator is being checked» until the new one is written (`runner.sh`), so an answer given by another account or kind of service is never
offered meanwhile. The probe says «needs the runner user's login session» only for the Simulator's own boot refusal (a reason that begins with
`iosBootFailureReasonPrefix`); any other failed check — no runtime installed, the device could not be created — shows its own reason. A record that cannot be
written is logged by `run`, and the Mac then stays «being checked».

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
  until the hub has been refusing for 12 hours (`unconfirmedRemovalStopAfterMs`) without ever answering, or any other outcome — a network
  failure, a connection — starts the count again. A restart of the utility starts it again too.

## Tests

`src/__tests__/runnerUtility*.test.ts` (env, home/launcher/config/keys, tools, machine report and admin check, the servers driven
the way the hub drives them, the link loop's backoff / removed state / update decision) and the process-level flow
`runnerLinkE2e.test.ts` (kit: `runnerLinkE2e/runnerLinkFlowKit.ts`): the real pasted line, `charness-runner run`, plain ssh through
`runner-proxy`, restart, gate killed, the runner key's refusals (each against an endpoint the test owns, with the session kept up), an expired
line, a line aimed at a server with another host key, a runner whose hub changes its host key, a package change found by polling, a lost
redemption answer, remove.
`remote-run` through a paired runner is `remoteRunPairedE2e.test.ts` (kit `remoteRunE2e/remoteRunFlowKit.ts`), and `/runners` from Telegram end to
end is `runnersScreenE2e.test.ts`.
