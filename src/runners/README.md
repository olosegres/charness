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
| `closed.json` | a TRACE, not registry truth: the codes that were closed UNUSED (`cancel`; `hubRegistry.ts`, `readClosedCodes` / `recordClosedCode`) — id and when, the newest fifty, nothing dropped for age. It lets the Telegram messages read «this line was used on a machine that was already paired» (not «expired») and `runners pair --wait` exit 0; a code counts as closed only when it is ALSO gone from `pending.json`. Written in the same transaction that drops the code and BEFORE it, best effort (a failed write is a log line, never a failed close); read leniently (a file that cannot be used reads as none and the caller says so once), and by the watcher only when a message settles without a runner |
| `hub_ed25519(.pub)` | the hub's client key, made at the first pairing (one for all runners) |
| `known_hosts` | derived: `charness-runner-<id> <host key>` for the stock `ssh` calls through the links |
| `gate` | the `sh` wrapper `exec '<node>' '<cli.js>' runner-gate "$@"`, rewritten at every start (`gateWrapper.ts`) |
| `lock.<n>` | the registry lock (`hubLock.ts`): the holder is whoever made the highest number; no file is ever deleted on someone else's word, so two contenders that found one dead holder cannot both take over; a holder that is ALIVE (its pid and start time) is never overtaken — a hung one blocks the registry for the waiter, who fails after 15 s, instead of risking two writers |
| `link/<id>.sock`, `link/<id>.json` | the socket of the gate that holds the link, and its pid / since / heartbeat / ended; deleted when the runner is removed (`cutRunnerLink`), and any left for a runner the registry does not know are swept (`sweepOrphanLinkRecords`) |
| `link/<id>.lid` | the runner's last report about its LID: `{isClosed, reportedAtMs, linkEpochMs?}` (see «The lid» below). A file of its own: the gate rewrites `<id>.json` every ten seconds and the report comes from another process. Deleted and swept with the other two |
| `package/` | the packed hub package (`<id>.tgz`) and `current.json` (its source stamp) |

Everything derived (`known_hosts`, the managed `authorized_keys` block) is rendered from the two registry files (`syncDerivedHubFiles`),
never edited on its own. A registry file that does not validate stops the caller with the field named — never read as empty, which would
be rewritten empty.

**Every change is a transaction under the registry lock** (`hubPairing.ts`, `runTransaction`): (1) the `authorized_keys` block is checked
first — a damaged one stops the operation before anything is written; (2) the AUTHORITATIVE files are written, `paired.json` then
`pending.json`; (3) the derived files are rewritten from the registry (and the link files of runners it no longer holds are swept, unless that runner's gate is still running — cutting its link needs the pid; best effort: a folder that cannot be listed is reported through the context's `log` — a warning line unless a test or caller injects its own — and never fails the operation) — and this step runs at the end of EVERY operation, a plain
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
   and the **pair code** `cr2.<user>,<host>,<port>,<id>,<host key type>,<host key>,<private key body>` (`pairCode.ts`: the account, the host,
   the port, the pair id, the hub's ssh host key to pin, the temporary PRIVATE key). The code is a secret until used or expired: never logged; decode errors name
   fields, never values. The pasted line does not carry the code: it holds these values ONCE, as shell variables it needs itself before there is any program to
   decode a code, and the shell joins them into the code it hands the utility (`"cr2.$u,$h,$p,<id>,$y,$z,$k"`; `joinPairCodeFields` is the one place that knows
   the order, and a test runs the line and compares). Version 1 (`cr1.<base64url JSON>`) is still read, never written.
2. `bootstrapLine.ts` renders the ONE line for the operator. As the runner account (the line without its `sudo`) it writes
   the key and a `known_hosts` line to a private temp folder, runs `ssh … bootstrap > package.tgz`, unpacks it and starts `runnerCli.js pair
   --bootstrap <folder> <code>`. The unpacked package has no `node_modules`: the runner's `pair` step reaches its install step on Node
   built-ins only. The ADMIN line, `sudo sh -c '<script>' sh <account>`, keeps one rule: **root never executes, reads through or writes
   into anything the runner account can change.** As root it checks the account (exists; not root; not in the admin groups of
   `runnerUtility/adminCheck.ts`, and a failing `id -Gn` is a refusal; the OS is macOS or Linux), makes its download (the fetch steps are shared with the no-sudo way) into
   a root-owned folder in `/tmp` (readable by the account, `--no-same-owner`; the key files in it stay 0600), has the account pair itself from
   that copy, and runs `rootServiceCli.js install <account> --bootstrap … <code>` from the same copy (Node built-ins only: the copy has no
   dependencies; `runnerUtility/adminService.ts`). That ONE program has the account pair itself (`sudo -u <account> -H node …/runnerCli.js pair …
   --service-follows`) and then installs the service; the shell runs nothing as the account. Every step that runs as the account has NO
   terminal: a session of its own, `/dev/null` for input, its output piped through the root step with the control characters stripped
   (`runnerUtility/isolatedCommand.ts`) — the account runs the agents' code, and code it can change must not get the admin's terminal. The
   script also INSTALLS the runner's own Node, which root and the service run under — by the package's own `remoteRun/ensureNode.sh`, run as root from the root-owned copy right after the download (kept out of the pasted line: a Telegram message holds 4096 characters): the newest LTS official nodejs.org build from 22.12 up to 24 (the last line with Corepack), SHA-256 checked, unpacked by root into `/usr/local/lib/charness-runner/node/v<version>` without the archive's owners — the base judged before root writes into it, an install judged before root runs it; never one inside a home folder, judged by its real path (`readlink -f`, or by hand where it is missing), never one the account can WRITE or whose folder it can write (`sudo -u <account> test -w`: root must never run what the account can change; the root step asks the same again). The plain line runs the same script as the account, into `~/.charness-runner/node`.
   The root step warns last about the homes of other users that the account can read (`sudo chmod 700 <home>`). The account is the line's LAST word (editable by hand; `charness runners pair --account`), and
   a second paste for an account that is already paired only installs the service.

   **ONE line, two ways** (`renderScript`): by who runs it. As root (`sudo …`, the line as offered) it is everything above. Run by a NON-root user — the
   same line without its leading `sudo`, in the terminal of the runner account itself, for a person without admin rights — it pairs THAT account: the last word
   must equal `id -un` (it refuses «you are not <word>: run the line as <word> or with sudo» before anything is fetched, so a main account with a leftover
   `runner` at the end is never paired by mistake; nothing else judges the account — in particular not the characters of its name, which only root's way restricts to
   plain letters, digits, `.`, `_` and `-` because there the name goes to `id`, `sudo -u` and the root step: an account a directory service names `user@realm` pairs itself), the copy is made in the account's own `$TMPDIR` and stays private (700),
   `ensureNode.sh own` installs the runner's Node in `~/.charness-runner/node`, and `runnerCli.js pair --bootstrap …` runs under it — no service (the pairing
   prints the «keep it running» help). The shell variables `r` (1 = root) and `b` (the folder of the copy) carry the difference; every value of the pairing is in the script
   ONCE (the shell joins them into the code). A Telegram message holds 4096 characters, so ONE message carries the line (~2.8 KB with an ed25519 host key, ~3.1 KB with RSA 2048) and its explanation
   (`runners.pairingIntro`, ≤ ~470 characters in every language) — which is why the line holds each value once and its messages are short.
   `runnersScreenPlan.test.ts` measures every locale with every host-key type at the longest host name (253) and hub account (64) the registry accepts: all fit up to
   RSA 3072, and RSA 4096 fits at ordinary names. What cannot fit (RSA 4096 and more with the longest names) is caught when the line is offered
   (`offerPairing`): the code is closed (`cancelPairing`) and the answer names the length and `charness runners pair --host <address>`; a send Telegram refuses closes
   its code the same way. `connectors/telegram/runnerPairingMessages.ts` follows the message.

   **What the admin line trusts.** Pasting it runs code from this charness host as root on the runner machine: the line is
   hub-generated text run under `sudo`, and the program root runs from it is `rootServiceCli.js` out of the hub's own install (packed into
   `package/`), both owned by the hub's OS user — and its agents; what it installs outlasts the paste. The same line run without `sudo` by the runner account trusts the hub only with
   that account. The Telegram message (`runners.pairingIntro`, all locales) and the CLI's text (`charness runners pair`) say it, and
   `docs/remote-run.md` does too. The code is in `sudo`'s log: a refused line
   leaves it open on purpose (fix the account, paste again); an already-paired account's line closes its own code with `cancel` — which is no failure: the messages and `--wait` say the line did its job.
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
| temporary | `cancel` | marker line, then `{ok}` (`true`: the code was open and is closed now — its entry and key line are gone and `closed.json` notes it; `false`: unknown, spent or expired). Idempotent. Sent by an admin line pasted for an account that is already paired (`runPair`): the code will never be redeemed |
| runner | `link` | marker line (`package=<id> epoch=<the link's start in ms>`, and `lid=recorded` when the lid the request carried was written to the record), then the ssh session of `gateLink.ts`. The command may be `link lid=closed` / `link lid=open` (exactly that): the lid is recorded before the marker is sent and the socket bound |
| runner | `package` | marker line, then the packed package |
| runner | `version` | marker line with the hub's current `package=<id>`, nothing else — a linked runner asks every few minutes over its open connection |
| runner | `identity` | marker line, then what `redeem` answered for this key's runner — the way back for a runner whose answer was lost (see below) |
| runner | `unpair` | marker line, then `{ok}`; the hub removes the runner and cuts its link |
| runner | `lid` | stdin `closed` or `open`, optionally followed by a space and the link's epoch (digits); marker line, then `{ok}` — `ok:false` and exit 1 for any other body, the record unchanged. A report whose epoch is older than the record's is dropped and answered `ok:true` |

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

**The lid** (`linkControl.ts`: `readLidState` / `writeLidState`; `runnerUtility/lidState.ts` is the other end). A MacBook whose lid is closed with nothing keeping it
awake is about to sleep, and wakes in the dark for a minute or two every so often on power: a job that lands then is cut. The runner says where its lid is in the request that
makes the link (`link lid=closed|open`, `gateProtocol.ts` `formatLinkCommand` / `parseLinkLidArgument`; the key's forced command matches that exact text): `runGateLink` writes
`link/<id>.lid` — `{isClosed, reportedAtMs, linkEpochMs}`, the hub's own clock, the link's epoch being when this gate began — FIRST, before it prints the marker (which names the
epoch, and `lid=recorded` when the write worked — a runner whose marker lacks it reports the lid itself) and before it binds the socket, so the runner is never online with a lid the hub has not heard about. Afterwards the runner sends `lid closed|open <epoch>` on the connection it
holds when the lid CHANGES; a report from a link with a smaller epoch than the record's is dropped (answered like a taken one), so a report that is delivered late — a Mac fell
asleep with it in flight — cannot overwrite what its next link said, and a gate that began earlier than the record's does not overwrite it either (two links racing). A link that says
nothing (a runner that is not a Mac, an older one) leaves the record as it was. The record OUTLIVES the link (the next link's request replaces it at once) and is read only beside an
online link: `getRunnerLinkStatus` returns `isLidClosed` for the runner whose socket accepts; an offline runner is offline whatever it said. A record that does not read (damaged, a
foreign shape) means an open lid — a runner is never taken out of use by a file nobody can read; and a link that could not carry the lid (an older hub, a record that could not be written) is followed by the runner's own report at its first look. `remoteRun/runners.ts` turns an online runner with a closed lid into the report `lid-closed` WITHOUT asking it (the ssh call may hang as the Mac falls asleep): not picked,
a named one refused, `--needs` waits like for an offline one, `exec` refused; a job that already runs there, and `status` / `wait` / `logs` / `kill` of it, never go through a pick.
`runners ls` and `/runners` say «lid closed» for «online».

**Where a link comes from** (`linkConcern.ts`). A job on the runner's machine can read the runner's key, and «newest link wins» means a second
connection with it silently replaces the first — whoever holds the key could be that machine, receive the project code the agents send to it and
answer with made-up results. So the gate records the address of each link (`parseSshClientSource`: the first word of sshd's `SSH_CLIENT`, an IP
address and nothing else) in `link/<id>.json` (`source`), and when a link comes from another address than the one before it, the change
(`sourceChanges`: from, to, when, and whether the old link was still up — its heartbeat younger than three check intervals — when the new one took its
place; the last five are kept). `getLinkConcern` turns them into what is worth telling: **the source changed** (it does NOT expire: it stays until the runner is removed or paired again, the status file goes with it — where from now,
where from before, when, and — for a live replacement — «if that is not your change of network, remove this runner and pair it again») or **a fight**
(three changes within ten minutes: two links, two addresses, each replacing the other, the runner reconnecting by itself). `charness runners ls`
puts it in parentheses on the machine's row and the `/runners` screen under its block (`runners.linkSourceChangedNote`, `…ReplacedNote`,
`…FightNote`, every language), and the bot SAYS it once: `watchLinkConcernsOnce` (every look of the watcher, with the pairing messages) posts ONE message
in General per new concern — `<name>: <the note>` — and pins it (the operator runs every topic muted; a pin pierces it). What it already told is the
instance's own record, `DATA_DIR/runner-link-notices.json` (`connectors/telegram/runnerLinkNotices.ts`): a concern is told apart by the time of its
newest change, so the next look, a restart and the rest of a fight tell nothing again; with no General to post in, or a send that failed, it is tried
again at the next look. What it cannot see: two machines that share one address (one network behind one NAT show one source), and
a source that is unknown (no `SSH_CLIENT`, a status file an older gate wrote) never counts as a change.

**Removing an always-on service** (`serviceRemoval.ts`). Removing a runner here leaves its two LaunchDaemons running on the machine until an admin
removes them (nothing of charness runs as root there). The commands — `sudo launchctl bootout system/<link label>`, the same for the queue's label,
`sudo rm /Library/LaunchDaemons/<link label>.plist /Library/LaunchDaemons/<queue label>.plist` — are made by the HUB, not by the account's own program
(the agents run as that account and can change what it prints, and an admin would run the line with `sudo`): the labels are a hash in hex of the
state folder (`getServiceNames`), which the hub gets from the work folder the runner reported at pairing (`getRunnerHomePaths(home).workDir`; one that
is not a state folder's own gets no commands, and a note on how to find the daemons by hand). They are shown where the operator removes a runner —
`charness runners remove` prints them after the removal, the `/runners` Remove button answers with a second message (`runners.removedServiceText`, every
language) — and by `charness runners service-removal <name>` for a runner that stays. The account's `charness-runner service uninstall` / `unpair` print
a POINTER to those, never a command.

**`runner-proxy <socket>`** is the `ProxyCommand` of the ssh calls: it joins ssh's stdio to the socket; nothing listening → «the runner
is not connected» on stderr and exit 255 (ssh's own «connection failed»).

## The package (`hubPackage.ts`)

The hub's own `remoteRun/runner.sh` and `dist/` (no tests, `.d.ts`, source maps), a `package.json` CUT DOWN to the runner's own runtime
dependencies (`ssh2`, `zod`: `runnerRuntimePackages`; the hub's name, version, licence and engines) and the `package-lock.json` that pins them, as a
deterministic tar (`tarArchive.ts`: fixed times and order) in a gzip. The lock (`runnerLock.ts`) is made from `yarn.lock` for exactly that closure
(six packages: `ssh2`, its three runtime dependencies, `tweetnacl`, `zod`; optional native add-ons and Yarn's implicit `node-gyp` are left out), pins
each package by registry tarball AND `sha512` integrity (`yarn.lock` has no such hash: `yarn runner-lock` fetches them once from the registry and keeps
them), is committed as `remoteRun/runner-package-lock.json` and shipped by the npm package; a unit test fails while it does not match `yarn.lock` /
`package.json`, or when the runner's own code imports a package it lacks. The runner installs it with `npm ci --omit=dev --ignore-scripts`, so what a
runner runs is what the hub has run and never a version published since (the audit's finding: `npm install` against open ranges would have pulled a
hijacked release into an always-on process at the next auto-update). Its **id** is the first 16 hex digits of the sha256 of the tar before compression. The cache in
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
is the headless twin of `/runners`: it loads no env file and never touches `DATA_DIR`. `ls` reads the screen's first step (`runnersOverview.ts`: registry, links, last snapshots) and asks only the machines that are online whose report is older than their link (a service installed after the pairing starts the link anew) or missing (`refreshStaleSnapshots`: a listing that finds every report fresh makes no ssh call, waits `staleRefreshDeadlineMs` (8 s) at most, and remembers a machine that gave no answer in `<cache>/<name>.probe-failed.json` — `{attemptedAtMs, linkSinceMs}`, forgotten with the report on removal — so that the next listings show it as last known until its link begins anew or `probeRetryAfterMs` (10 min) passes; such a row — online, report older than its link or missing, no answer — carries `isReportDoubtful` and `formatRunnerListLine` names the doubt beside it); "online" is exactly "the link is up", whatever the probe says; "how it is kept running" is what the machine last reported (`getCurrentServiceKind`, fed by every probe: the `/runners` screen, `remote-run runners`, a job start, the refresh), not the word the registry took at pairing — and the registry's word only for a machine nobody has probed yet. `charness runner-gate` and `charness runner-proxy`
are hidden (named by `authorized_keys` and `ProxyCommand`). `src/cli.ts` is a hot-supervisor file: a deploy that touches it needs a full
service restart after `tsc -w` is green.

## Tests

`src/__tests__/runners*.test.ts`: the code codec, the block editor (foreign lines kept, damaged blocks refused), the line shapes, the
registry (single-use `redeem` under concurrency, expiry sweep, names, removal), the gate's argument parsing and request routing and its
answers over streams, the link against a stand-in ssh2 server (including the socket takeover), the proxy, the tar writer and package id,
the bootstrap line against a real `sh`, the address check.
