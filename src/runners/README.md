# `src/runners/` — the hub side of paired runners

A **runner** is a machine that runs the agents' tests and builds (`charness remote-run`, phase 1). This folder is how a charness
**hub** attaches one WITHOUT a VPN, an open port, root, or a second sshd: the runner dials OUT to the hub's stock sshd, and everything
rides inside the forced command of the runner's key. The runner's side is `src/runnerUtility/`; the phase-1 core it reuses is
`src/remoteRun/` (nothing there changes except where a paired runner is looked up).

## Shape

```
runner machine                                   hub (stock sshd, the owning user's authorized_keys)
──────────────                                   ─────────────────────────────────────────────────
charness-runner ──ssh, outbound──► sshd ─forced command─► <dir>/gate ─► charness runner-gate  --dir D --keys K runner <id>
  ssh2 Client: exec('link')                                  stdin/stdout = the channel
  ssh2 SERVER over that channel ◄── ssh2 CLIENT (the gate) ─ checks the runner's pinned host key, logs in with hub_ed25519
                                                              │ listens on  D/link/<id>.sock
  stock `ssh` of remote-run ─ProxyCommand: charness runner-proxy <sock> ─► sock ─► client.forwardOut() ─► the runner's server
```

The roles turn around inside the channel: the runner is the ssh SERVER of an ssh session whose client is the gate. Each connection
to `link/<id>.sock` becomes a `direct-tcpip` channel that the runner's server hands to a second ssh server instance — an ordinary ssh
session for stock OpenSSH (ControlMaster, rsync, `exec`, all of phase 1 unchanged).

## The safety line

OpenSSH cannot restrict a key's forwarding of **unix sockets** (`permitopen` / `permitlisten` cover TCP only; the server code says
«XXX fine grained permissions»), and a key that may forward can open ANY unix socket of the account — the bot's tmux sockets
included. So a runner's key gets NO forwarding at all: `restrict` plus a forced command. The gate takes the request from
`SSH_ORIGINAL_COMMAND` and matches it as a whole against the words the key's role allows; a shell login, a different word, or extra
arguments are refused. The gate's ssh client refuses every channel and global request the runner side opens (nothing is registered
for them in `ssh2`). The hub's own side never trusts the runner's data: public keys are matched against a strict pattern before they
are written into `authorized_keys`, ids and hosts against strict patterns before they reach a command line, and messages sent to a
runner name no hub path.

## Files (`~/.config/charness/runners/`, 0700, one per OS user)

| File | Holds |
|------|-------|
| `paired.json` | `rev` + the attached runners (`hubRegistry.ts`): id, name, public key + fingerprint, the runner's host key, work dir, reported OS / arch / version / service kind, `pairedAtMs`, `pairId`, hub-side `isPaused` |
| `pending.json` | the pairing codes that are out: id, temporary PUBLIC key, expiry, address, label, the offering instance's opaque `messageRef` |
| `hub_ed25519(.pub)` | the hub's client key, made at the first pairing (one for all runners) |
| `known_hosts` | derived: `charness-runner-<id> <host key>` for the stock `ssh` calls through the links |
| `gate` | the `sh` wrapper `exec '<node>' '<cli.js>' runner-gate "$@"`, rewritten at every start (`gateWrapper.ts`) |
| `lock.<n>` | the registry lock (`hubLock.ts`): the holder is whoever made the highest number; no file is ever deleted on someone else's word, so two contenders that found one dead holder cannot both take over; a holder that is ALIVE (its pid and start time) is never overtaken — a hung one blocks the registry for the waiter, who fails after 15 s, instead of risking two writers |
| `link/<id>.sock`, `link/<id>.json` | the socket of the gate that holds the link, and its pid / since / heartbeat / ended; deleted when the runner is removed (`cutRunnerLink`), and any left for a runner the registry does not know are swept (`sweepOrphanLinkRecords`) |
| `package/` | the packed hub package (`<id>.tgz`) and `current.json` (its source stamp) |

Everything derived (`known_hosts`, the managed `authorized_keys` block) is rendered from the two registry files (`syncDerivedHubFiles`),
never edited on its own. A registry file that does not validate stops the caller with the field named — never read as empty, which would
be rewritten empty.

**Every change is a transaction under the registry lock** (`hubPairing.ts`, `runTransaction`): (1) the `authorized_keys` block is checked
first — a damaged one stops the operation before anything is written; (2) the AUTHORITATIVE files are written, `paired.json` then
`pending.json`; (3) the derived files are rewritten from the registry (and the link files of runners it no longer holds are swept, unless that runner's gate is still running — cutting its link needs the pid) — and this step runs at the end of EVERY operation, a plain
`ls` or sweep included, so a step that failed, or a crash between two writes, is mended by whatever runs next (a failed derived write is
reported as `HubDerivedFilesError`). A code is single use because the runner is recorded with the id of the code that made it, even if the
pending entry outlives a crash; the SAME machine asking again for a used code is answered again (idempotent). A runner that left
`paired.json` is refused by every gate request (`package`, `link`, `version`) at once, whatever its key line — or an ssh connection it already has
open, which keeps the key's options — still allows. Two requests are answered anyway, because their answer IS «not paired»: `unpair` (idempotent) and `identity` (`{ok:false}`, nothing else — it is how a runner whose `link` was refused tells a removal from a failure).

**`authorized_keys`.** charness owns ONE marked block (`authorizedKeysBlockStart` … `End`), replaced as a whole; every other line is
kept byte for byte; a damaged block (a marker without its twin, two blocks) is NOT edited. The file is written 0600 through a temp
file and a rename, into the target of a symlink. Lines:

```
restrict,expiry-time="YYYYMMDDHHMMSSZ",command="<dir>/gate --dir <dir> --keys <file> redeem <pairId>" ssh-ed25519 … charness-pairing:<pairId>
restrict,command="<dir>/gate --dir <dir> --keys <file> runner <runnerId>" ssh-ed25519 … charness-runner:<runnerId>
```

The forced command names the folder and the keys file, so a gate never depends on `$HOME` / `DATA_DIR` (a flow test points a loopback
sshd at a temp file and the gate never touches the real one). A path with a quote, a backslash or a line break is refused (sshd cannot
escape a backslash in `command="…"`).

## Pairing

1. `createPairing` (under the lock): a temporary ed25519 key, its `pending.json` entry, its `authorized_keys` line (expires in 10 min),
   and the **pair code** `cr1.<base64url JSON>` (`pairCode.ts`: host, port, account, the hub's ssh host key to pin, the temporary
   PRIVATE key, the pair id). The code is a secret until used or expired: never logged; decode errors name fields, never values.
2. `bootstrapLine.ts` renders the one `sh -c '…'` line for the operator: it writes the key and a `known_hosts` line to a private temp
   folder, runs `ssh … bootstrap > package.tgz`, unpacks it and starts `runnerCli.js pair --bootstrap <folder> <code>`. The
   unpacked package has no `node_modules`: the runner's `pair` step reaches its install step on Node built-ins only.
3. The runner calls `redeem` with its own new public key and host key (`gateProtocol.ts`). `redeemPairing` (one critical section):
   code must be in `pending.json` and not expired, the key not yet registered; it adds the runner (a unique name — `-2`, `-3`, … —
   against paired AND hand-made runners), deletes the pending entry (**this is what makes the code single use**), rewrites
   `known_hosts` and the block (the temporary line goes, the permanent one comes).
   The hub commits a redemption (the runner registered, the temporary key deleted) BEFORE the runner has the answer. A runner that loses
   it recovers with its PERMANENT key: it writes `pairing.json` before redeeming, and asks `identity` whenever it finds that file without a
   `config.json` (see `src/runnerUtility/README.md`).
4. `sweepExpiredPairings` drops expired codes and hands them back (the bot edits its messages to «expired»); sshd already refuses an
   expired key by itself (`expiry-time`).

The address check (`hubAddress.ts`) runs before a code is made: `ssh-keyscan` at the address must give the key `ssh-keyscan` gives on
this machine's own loopback port — otherwise the runner would be told to pin a stranger's key.

## The gate (`gate.ts`)

| Key | Request | Answer |
|-----|---------|--------|
| temporary | `bootstrap` | marker line (`id=<package id>`), then the packed package as gzip (only while the code is open) |
| temporary | `redeem` | marker line, then `{ok, runnerId, name, hubPublicKey, label, host, port}` or `{ok:false, reason}` |
| runner | `link` | marker line (`package=<id>`), then the ssh session of `gateLink.ts` |
| runner | `package` | marker line, then the packed package |
| runner | `version` | marker line with the hub's current `package=<id>`, nothing else — a linked runner asks every few minutes over its open connection |
| runner | `identity` | marker line, then what `redeem` answered for this key's runner — the way back for a runner whose answer was lost (see below) |
| runner | `unpair` | marker line, then `{ok}`; the hub removes the runner and cuts its link |

A **marker line** (`--charness-gate-1-- <request> key=value…`) opens every answer, after a line break that ends any unfinished line a shell
rc printed; the reader discards what comes before it, so a chatty shell rc on the hub cannot corrupt the stream. The runner utility reads
with `readUntilGateMarker`; the pasted `sh` line finds the marker with `grep -b` among the first 64 KiB and cuts the archive out with
`tail -c` (a binary payload is never touched by a text tool). The package id in the `link` marker lets an idle runner notice that the
hub changed and update itself.

**The link** (`gateLink.ts`). The gate is an `ssh2` client over its own stdio, verifies the runner's server host key against the pinned one
(ed25519 only), logs in with the hub key, and listens on `link/<id>.sock`. **Newest link wins**: a starting gate binds its socket under a name of
its own and renames it onto `link/<id>.sock` (atomic; `net.Server.close()` deletes by path, so a gate that bound the link path itself
would delete its successor's file when it left); the replaced gate sees the file at the path change at its next check (10 s) and leaves.
A leaving gate never deletes the file at the path (check-then-delete is not atomic against a successor's rename): a leftover socket file only
refuses connections, the next gate renames over it, and `remove` deletes it. The same check ends a gate
whose runner left the registry. An ssh keepalive (15 s × 3) ends a gate whose peer is gone — a stock sshd with `ClientAliveInterval 0`
never would. A runner is **online** when its socket accepts a connection (`linkControl.ts`); `link/<id>.json` says who holds it and
when it was last seen. `remove` deletes the socket and stops the gate if the recorded pid still is that runner's gate (checked with `ps`).

**`runner-proxy <socket>`** is the `ProxyCommand` of the ssh calls: it joins ssh's stdio to the socket; nothing listening → «the runner
is not connected» on stderr and exit 255 (ssh's own «connection failed»).

## The package (`hubPackage.ts`)

The hub's own `package.json`, `remoteRun/runner.sh` and `dist/` (no tests, `.d.ts`, source maps) as a deterministic tar (`tarArchive.ts`:
fixed times and order) in a gzip. Its **id** is the first 16 hex digits of the sha256 of the tar before compression. The cache in
`package/` is reused while a stamp of the sources (path, size, mtime) is unchanged. Gates and packers are not coordinated, so nothing is
deleted on a packer's word: an archive is published whole by a rename, `current.json` is only a pointer that heals itself, a superseded
archive is removed only after 10 minutes, and a gate opens the archive at once (`openHubPackage`) — a deleted file stays readable through
the open handle.

## The Telegram screen

`/runners` (`connectors/telegram/commands/runners.ts`) is the hub's other front end. What it adds to this folder: `hubAddressCandidates.ts` (the routable
addresses of this machine and the first one that answers with its own sshd — proposed at the first pairing; the chosen address is `runnerHost` in
`settings.json`), `runnersOverview.ts` (the registry + link status + last snapshots without ssh, then a live probe of the online machines through the
phase-1 client), the paired runner as a phase-1 `RunnerConfig` is built by `remoteRun/pairedRunners.ts` (`runner-proxy` as the `ProxyCommand`, the hub key, this folder's
`known_hosts`; its Pueue paths follow the layout of `runnerUtility/runnerHome.ts`) — the screen's probe uses the same builder `remote-run` does. The registry holds credentials only: which Telegram message offers a code is each
instance's own record (`connectors/telegram/runnerPairingMessages.ts`), so a second charness of the same OS user neither edits nor loses it (`pending.json`'s
`messageRef` stays for a front end that wants it; the Telegram one does not use it).

## CLI

`charness runners [ls | pair --host <host[:port]> [--label] [--wait] | remove <name> | pause <name> | resume <name>]` (`runnersCli.ts`)
is the headless twin of `/runners`: it loads no env file and never touches `DATA_DIR`. `ls` reads the screen's first step (`runnersOverview.ts`: registry, links, last snapshots) and makes no ssh call, so it is instant and "online" is exactly "the link is up"; "how it is kept running" is what the machine last reported (`getCurrentServiceKind`, fed by every probe: the `/runners` screen, `remote-run runners`, a job start), not the word the registry took at pairing — and the registry's word only for a machine nobody has probed yet. `charness runner-gate` and `charness runner-proxy`
are hidden (named by `authorized_keys` and `ProxyCommand`). `src/cli.ts` is a hot-supervisor file: a deploy that touches it needs a full
service restart after `tsc -w` is green.

## Tests

`src/__tests__/runners*.test.ts`: the code codec, the block editor (foreign lines kept, damaged blocks refused), the line shapes, the
registry (single-use `redeem` under concurrency, expiry sweep, names, removal), the gate's argument parsing and request routing and its
answers over streams, the link against a stand-in ssh2 server (including the socket takeover), the proxy, the tar writer and package id,
the bootstrap line against a real `sh`, the address check.
