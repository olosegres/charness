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

## Not here yet

`service install|uninstall` (systemd user unit + linger, LaunchAgent, `--system` LaunchDaemon), `pause|resume`, `unpair`, the iOS Simulator
boot check — scope 3. `remote-run` reaching a paired runner — scope 4.

## Tests

`src/__tests__/runnerUtility*.test.ts` (env, home/launcher/config/keys, tools, machine report and admin check, the servers driven
the way the hub drives them, the link loop's backoff / removed state / update decision) and the process-level flow
`runnerLinkE2e.test.ts` (kit: `runnerLinkE2e/runnerLinkFlowKit.ts`): the real pasted line, `charness-runner run`, plain ssh through
`runner-proxy`, restart, gate killed, the runner key's refusals (each against an endpoint the test owns, with the session kept up), an expired
line, a line aimed at a server with another host key, a runner whose hub changes its host key, a package change found by polling, a lost
redemption answer, remove.
