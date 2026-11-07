# Running heavy commands on another machine — `charness remote-run`

An agent edits files on the machine the bot lives on. A test suite, a build or an emulator run can take most of that
machine's CPU and memory for an hour. `charness remote-run` sends such a command to a **runner** — another machine — runs it in a
copy of the project there, and brings back its output, its exit code and the result files you declare, as if the command had run
locally. Every agent of the OS user that runs charness can call it: Telegram topics (Claude and OpenCode), Jira agents, and you in a
shell.

A runner is attached in one of two ways:

- **Paired** (the normal way): you copy one line from Telegram (`/runners`) or from `charness runners pair` and run it on the runner
  machine — from an admin account there, or as the runner account itself. No ssh keys, no account setup on the charness host, no Pueue
  or `PATH` work, no open port.
- **Plain ssh** (under [Advanced](#advanced-a-runner-over-plain-ssh)): a machine you reach by ordinary ssh, set up by hand and listed
  in `~/.config/charness/runners.json`. Both kinds can be used together; `remote-run` treats them alike.

## Pair a runner

**What it takes.**

- **The charness host** runs its ordinary ssh server (`sshd`, key login on) and has an address the runner can reach — a public
  address, or one the runner can dial. Nothing else changes there: no root, no extra account, no VPN, no `sshd_config` edit. Pairing
  adds one marked block of key lines to the charness user's `~/.ssh/authorized_keys` and touches no other line. Each key is
  restricted to a single forced command — **no shell, no port or unix-socket forwarding** — so a runner can do nothing on the charness
  host but dial in, fetch charness's own package, hold its link and unpair itself.
- **The runner machine** (Linux or macOS) needs outbound internet to that sshd and to nodejs.org (the pairing installs the runner its own Node.js, see below), `ssh`, `tar` and `curl` or `wget`; it needs no Node.js of its own. The utility
  installs Pueue itself (pinned release, checksum-verified) and uses an `rsync` 3.1 or newer if it finds one — on a Mac without one
  (macOS 15.4 and later ship Apple's `openrsync`, which is not enough) it builds the pinned rsync with the Xcode command line tools, or
  names the one install command. Use **an account of its own** that you do not mind running the agents' code: a standard user, not an
  admin (the utility warns about an admin account, and the admin line below refuses it). Make the account yourself first (System
  Settings → Users & Groups on a Mac, `adduser` on Linux) — nothing here creates one.

**Pairing.**

1. In Telegram, in General, send `/runners` and tap **＋ Pair a new runner** ([`/runners`](commands.md#runners)). The first time the
   bot asks which address runners dial and proposes the public address it finds, after checking that the address answers with this
   machine's own ssh key. Without Telegram (a Jira-only instance): `charness runners pair --host host.example[:port]`.
2. The bot posts **two lines for one code** (two messages — together they are longer than a Telegram message), valid 10 minutes and good
   once, whichever is used first. Either fetches charness's own package from the charness host over ssh (so the versions never differ),
   checks the machine and pairs it, saying each step as it goes (checking the account, downloading the package, installing the runner program, checking the machine, pairing, getting Pueue, finding rsync, installing the service — one line each; on a terminal the line's dots cycle while the step runs). The first message then turns into «Runner “name” paired …» — or «Pairing code expired.» after 10 minutes, or «This line was used on a machine that was already paired — nothing new was paired.» when the line was pasted for a machine that is already paired (a retry, below) — and the second message is deleted (if Telegram will not, it points at the first).
   - **From an admin account of the runner machine** (the first message), `sudo sh -c '…' sh runner` — one paste does everything:
     it checks the account named by the **last word of the line** (`runner` unless you change it) — it must exist, must not be `root`
     or an admin (the account runs the agents' code), and is never created by the line. Then, still as root, it downloads charness's
     package into a folder of its own in `/tmp` (root-owned, readable by the account, removed when the line ends), has the account **pair
     itself from that copy** (`sudo -u <account> -H`: its files belong to it, not to root) and installs its always-on service from the same
     copy: on a Mac the LaunchDaemon that runs as the account, on Linux its systemd user service with lingering switched on
     (`loginctl enable-linger`; the install itself runs as the account). **Everything it runs as the account has no terminal**: a session of its
     own, no standard input, its output passed through the admin's process with the control characters removed, so code the account can change never
     gets the admin's terminal. **Root never runs, reads through or writes into anything the
     account can change** — the account runs the agents' code, so its folder is not trusted: root writes only the LaunchDaemon
     definitions into `/Library/LaunchDaemons` and calls `launchctl` / `loginctl`; everything of the account's own (its Pueue, its record,
     its user service) is done by the account's own program, started with `sudo -u`.
   - **What the admin line trusts.** Pasting it **runs code from this charness host as root on this machine**: the line is text
     the charness host made, and the program root runs from it is the one in the charness host's own install — so whoever can change that
     install (its user, and the agents that run as that user) controls what runs as root here, and what it installs stays after the paste.
     The plain line trusts the charness host only with the runner account. Paste the admin line only for a charness host you would let run
     code as root on this machine. **Each paste gives that host root on this machine once, at that moment** — one `sudo`, one run: no root
     process stays afterwards (the daemons run as the runner account), and pasting a line again gives the same root again.
   - **Do not paste the admin line again on a machine whose runner account has already run jobs — recreate the account instead — unless your
     charness is the version that runs the account's steps with no terminal attached** (the CHANGELOG entry «Everything the admin line runs as the
     account … runs with no terminal attached»). The runner account's files are the agents' to change: a job, or a package it installed, may have
     planted code there. From that version on, root never runs or reads the account's files and the account's own steps run with no terminal, so a
     second paste (the retry below) is safe in that respect; with an older charness the account's code was started with the admin's terminal, which
     it could write over and type into. If the service has to be reinstalled on an older one, delete the account and make a fresh one first.
   - **The code in the line.** `sudo` asks for the admin's password once and writes the command line — the pairing code with it — to the
     system log. The code is single use and good for 10 minutes: a line that was used is dead, and so is a retry's (see below), which
     closes its own code. A line that was refused (no such account, an admin account…) leaves its code open until it expires — on purpose,
     so you can fix the account and paste it again.
   - **Node.** The runner gets **its own Node.js**, whatever the machine has: a Homebrew or system Node is the admin's to change, and a job that
     runs `corepack enable` or `npm i -g` against it fails for lack of rights. The line installs it with a script of the package it has just fetched
     (`remoteRun/ensureNode.sh`, run as root from the root-owned copy): the newest 22.x official build from nodejs.org for the machine, downloaded with
     `curl` or `wget`, its SHA-256 checked against nodejs.org's `SHASUMS256.txt` before it is unpacked (the trust is TLS to nodejs.org), put in place
     whole as `/usr/local/lib/charness-runner/node/v<version>`. Root runs it (the root step, and the pairing it starts as the account), so it must stay
     where the account cannot change it: the script unpacks it as root without taking owners from the archive, takes group and world write away, and
     checks again every time — also for an install that is already there — that its real path is **outside every home folder** (`/Users/<name>`,
     `/home/<name>`, root's own; links followed), that the account can run it and **cannot write it, nor any folder above it**; if the account can (a
     `/usr/local` handed to it), the line stops before anything runs. A second pairing reuses what is there and downloads the archive again only for a
     newer release; with nodejs.org out of reach it uses the newest install it finds and says so; with none, the line stops and says what to check. The
     launcher and the daemons' `PATH` carry this Node, so a runner depends on no package manager and no home. The plain line (the second message)
     does the same as the account itself, into `~/.charness-runner/node`. A runner paired before this (on a system Node) moves to its own at its next
     start after a self-update, without the admin (see «A runner's Node» below).
   - **Homes the runner account can read.** macOS makes every home `750` with group `staff`, and a standard account is in `staff`, so by default
     the agents' jobs — and the npm packages they install — can read the source code, keys and tokens of the people who use the machine. **Both
     lines** end with a warning naming the homes the runner account can read (the admin line asks as that account, not with root's rights) and the
     one-line fix for each: `sudo chmod 700 /Users/<name>`.
   - **Retry.** If the service step fails, the account stays paired and the line says so: **paste a fresh admin line** (from `/runners`)
     after fixing what it printed. A line pasted for an account that is already paired pairs nothing twice, closes its own code on the
     charness host and only installs the service. That is no failure: its Telegram messages read «This line was used on a machine that was already paired — nothing new was paired.», and `charness runners pair --wait` prints the same and exits 0.
   - **As the runner account itself** (the second message), no admin rights: it pairs and prints how to keep the runner running (the table
     below).
3. The runner appears in `/runners` (and in `charness remote-run runners`) with its OS, CPU, memory, disk, load, jobs and what it can
   do. Anyone you give a line to can attach a machine until the code is used or expires — treat them like a password. Without Telegram,
   `charness runners pair --host … [--account <name>]` prints both lines.

**Keep it running.** The pairing is permanent; the link has to be up for jobs to arrive.

| Command on the runner | What it does |
|---|---|
| `~/.charness-runner/bin/charness-runner run` | holds the link in this terminal (Ctrl-C stops) |
| `charness-runner service install` | keeps it running in the background, no admin: a systemd user service on Linux (with `loginctl enable-linger`; where polkit asks for an admin, the one `sudo` line is printed), a LaunchAgent on macOS (while that account is logged in) |
| an admin's fresh admin line (above) | always on — a Mac logged out too, across fast user switching: a LaunchDaemon that runs **as the runner account**, with no extra rights (its output goes to `~/.charness-runner/logs/` written by the account itself, never opened by root). This is the only way to install it: `service install --system` on the runner is refused, because root must not run the account's own program |
| `charness-runner status` | whose charness it serves, the link state, how it is kept running, paused or not, running jobs |
| `charness-runner pause` / `resume` | takes this machine out of rotation, or back in (the hub has its own pause, set in `/runners`) |
| `charness-runner unpair` | tells the charness host to forget it, and stops the link and the queue's jobs here (an always-on service is removed first: see below) |

**Removing an always-on service** (a Mac's LaunchDaemons) takes an admin, with plain commands — no charness program runs as root — and **the commands come from the charness host, never from the runner machine's own program**: the agents run as the runner account and can change what `charness-runner` prints, and an admin would run the line with `sudo`. On the charness host, `charness runners remove <name>` prints them after the removal, the `/runners` **Remove** button sends them in a second message, and `charness runners service-removal <name>` prints them for a runner that stays. They are always these three, with the labels the host derives for that machine (`com.charness.runner.<8 hex digits>` for the link, `com.charness.runner.pueued.<8 hex digits>` for the queue):

```
sudo launchctl bootout system/com.charness.runner.<hash>
sudo launchctl bootout system/com.charness.runner.pueued.<hash>
sudo rm /Library/LaunchDaemons/com.charness.runner.<hash>.plist /Library/LaunchDaemons/com.charness.runner.pueued.<hash>.plist
```

If the machine was removed from the host earlier, `ls /Library/LaunchDaemons | grep com.charness.runner` on it lists the daemons by hand. `charness-runner service uninstall` on the runner account only points back here; once the commands have run, running it again forgets the service there, and `unpair` works.

A restart of the link (an update, a crash) never kills queued or running jobs — Pueue is a service of its own. The link reconnects by
itself after a reboot, sleep or network change, and updates itself from the charness host when it is idle.

**Remove.** `/runners` → **Remove** (or `charness runners remove <name>`): the key line and the registry entry are deleted, the link is
cut, the jobs it was running are stopped (through the link, at once, when it is online; a machine that was off stops them itself once the hub has been refusing it for 12 hours), and the runner says «removed by …» and retries at most hourly. `charness runners pause <name>` /
`resume <name>` keeps a machine attached but sends it no jobs.

**What a job sees.** A command runs as the runner account with a clean environment — `HOME`, `USER`, `LANG`, `TMPDIR`, a `PATH` of
`~/.charness-runner/bin`, the `bin` of the jobs' own npm prefix (`~/.charness-runner/npm/bin`), the folder of the `node` that runs the utility, Homebrew and
the system folders, the Android SDK where the usual installers put it, and `NPM_CONFIG_PREFIX` / `COREPACK_HOME` pointing into `~/.charness-runner`
(see «A runner's Node») — and nothing of the charness host's environment. Anything else (`JAVA_HOME`, a token, a `PATH` addition) goes into
`~/.charness-runner/env`, one `KEY=VALUE` per line, read again for every job (and may change any of the above).

**A runner keeps its machine awake — lid open, never asleep; lid closed, asleep as usual.** While the link runs it holds an IDLE-sleep assertion, the way
`caffeinate -i` does: on a Mac `caffeinate -i -w <the link's pid>`, on Linux `systemd-inhibit --what=idle` around a loop that lasts as long as the link's
process. The holder is tied to the link's process, so a stop, a removal, a crash or a SIGKILL of the runner ends it with the runner — the machine sleeps
normally again, no orphan keeps it awake. Where there is no way (no `caffeinate` or `systemd-inhibit` on the PATH, no D-Bus for the latter, another system)
the link says so in its log and `charness remote-run runners` / `/runners` show `keeps awake: NO — <why>` instead of `keeps awake: yes (…)`; the link comes
up all the same. It never touches `pmset` or any admin power setting, so nothing has to be set on the Mac.
- **What it does not do.** Closing the lid is not idleness: a laptop whose lid is closed sleeps as it always did (and the runner goes offline until it wakes; see the next point for the minutes before that).
  The display may still turn off. The assertion is held on battery too, so a laptop left open on battery under a runner drains it — plug it in. Whether a
  Mac with an external display and power in clamshell mode stays awake is Apple's rule, not the runner's.
- **A MacBook with its lid closed takes no new job.** Measured on a Mac on power: the lid closed with no external display, it sleeps about a minute and a half
  later — and macOS wakes it in the dark for a minute or two every quarter of an hour, in which the runner reconnects and a job that lands there is cut when
  the Mac sleeps again. So a Mac runner looks at its lid every 10 seconds (`ioreg -r -k AppleClamshellState -d 4`) and tells the charness host:
  **closed** means the lid is shut AND closing it sleeps the Mac (`AppleClamshellState` and `AppleClamshellCausesSleep` both Yes) — a lid shut with an external
  display keeping the Mac awake (clamshell mode), a lid that is open, a Mac without a lid and a reading that cannot be made all count as **open**, and the runner
  takes jobs as usual (an unreadable `ioreg` is one line in the runner's log, never a stop). The lid is part of the request that makes the link, so the host knows it
  BEFORE the runner is online: a Mac that wakes for its minute with the lid shut is never, not even for a second, available with the lid of the last time. After that
  the runner reports only a change (a hub that refuses a report is not asked again at every look: 30 s, doubling to 5 minutes). The host treats a lid-closed runner like an
  offline one for NEW jobs:
  `remote-run` and `exec` skip it (a named runner is refused: «has its lid closed»), `--needs` waits for it (`--runner-wait`, as for an offline runner: «waiting for a
  runner with ios (mac has its lid closed)»), and `runners`, `charness runners ls` and `/runners` show «lid closed» in place of «online». A job that already runs
  there, and every command about it (`status`, `wait`, `logs`, `kill`), is not touched. Opening the lid makes the Mac available within about 10 seconds (the
  next look), and a waiting job starts. Non-Mac runners never report a lid, and neither does a hand-made one over plain ssh (it has no runner program to tell). Unverified on a
  real Mac in this form: the `ioreg` output of every macOS version (the key names are the registry's own, not documented by Apple).
- **Only verifiable on the real Mac:** that `caffeinate -i -w` lets a closed lid sleep the machine, and that a SIGKILLed link frees the Mac to sleep again
  (the holder ends with `-w`). On Linux both are tested with the real `systemd-inhibit` (the lock shows in `systemd-inhibit --list` and is gone, holder
  and all, within seconds of the link being SIGKILLed).

**A runner's Node.** A runner runs on its own Node.js (`~/.charness-runner/node/v<version>`, or the root-owned `/usr/local/lib/charness-runner/node/v<version>`
the admin line installs). That Node's folder is not one the account can write, so nothing a job installs goes there: `npm i -g` writes into
`~/.charness-runner/npm` (`NPM_CONFIG_PREFIX`; its `bin` is on the job's `PATH`), Corepack keeps the package managers it downloads in
`~/.charness-runner/corepack` (`COREPACK_HOME`), and a `corepack` wrapper in `~/.charness-runner/bin` (first on the `PATH`) turns `corepack enable` /
`disable` without `--install-directory` — what a project's install step runs — into one for `~/.charness-runner/bin`, where the shims below live. A
runner paired on a system or Homebrew Node moves itself: at the first start of its link after the self-update that brings this, the account downloads
the same verified build into `~/.charness-runner/node` (a self-update runs as the account, not root, so the copy is the account's own — root only ever
runs the one the admin line installed), rewrites its launcher and restarts onto it (a service manager starts the new launcher by itself; a terminal run
says to start it again). If that cannot be done — no network, a full disk, no `curl` or `wget` — the runner stays on the Node it has, its log says
«could not get one: …», and it tries again at its next start; pasting a fresh admin line installs the root-owned Node for the root steps.

**`yarn` and `pnpm` survive a change of Node.** A Node from nvm, Volta or Homebrew has Corepack but not its shims, so `yarn` is on a job's
`PATH` only when somebody enabled it for exactly that Node — and a link restarted under another Node (nvm's default changed, a service
moved) lost it, and every job ended with `yarn: command not found`, exit 127. At every link start, and on `charness-runner check`, the
runner now offers each of `yarn` and `pnpm` that neither the Node's folder nor the system folders have as a Corepack shim in
`~/.charness-runner/bin` (`corepack enable --install-directory`: symlinks, nothing is downloaded before a job first runs it), and removes a
shim it made earlier once the Node itself offers the manager again. A Node without Corepack (25 and later) cannot be helped: the runner says
so in its log, and `charness remote-run runners` shows what jobs run with — `jobs run with: Node v24.22.2 · yarn 1.22.22`, or
`yarn: NONE (a job that calls it ends with exit 127)` — so a Node that changed under a restarted link is visible there, not found by a failed job.

**What a job can reach — the machine's own network.** A job runs as the runner account on the runner machine, so it shares that machine's network: the
home or office LAN (the router's admin page, printers, other computers), every VPN or tunnel interface the machine is on (a WireGuard network included), and
the machine's own localhost services — and so does any npm package a job installs. Nothing in charness fences that: on the charness host a job cannot see
your home devices, on the runner machine it can. If that machine sits inside a network you care about, fence the **runner account** with the machine's own
firewall, by account — the link to the charness host keeps working when the charness host is reached by its public address (if it is reached by a private
or VPN address, let that one through first, as in the examples). Replace `runner` with the account's name and `<hub>` with the address the pairing line dials.

macOS (`pf`; its `user` keyword matches the account that owns the socket):

```
# /etc/pf.anchors/charness.runner
pass out quick proto tcp from any to <hub> port 22 user runner
# if the machine's DNS resolver is a device on the LAN (the router), let the runner account reach it, before the block:
# pass out quick proto { tcp udp } from any to <resolver> port 53 user runner
block return out quick proto { tcp udp } from any to { 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10 } user runner
```

The IPv6 ranges (unique-local `fc00::/7`, link-local `fe80::/10`) matter as much as the IPv4 ones: a LAN device is as reachable over IPv6. `pf` takes `user` only on
`tcp`/`udp` rules, hence `proto`; check the file first with `sudo pfctl -nf /etc/pf.anchors/charness.runner`. **Do not block `lo0`**: a job's own
localhost — the dev server of a project, Metro, the web server a Playwright test starts — is what the e2e jobs run against. Add `anchor "charness.runner"`
and `load anchor "charness.runner" from "/etc/pf.anchors/charness.runner"` to `/etc/pf.conf`, then `sudo pfctl -f /etc/pf.conf` and `sudo pfctl -E`. Check it
before relying on it: as the runner account (a job: `charness remote-run exec -- curl -m 3 http://<a device on your LAN>/`) a connection to a private address
must fail, and one to the charness host must still work.

Linux (`nftables`; `meta skuid` matches the account that owns the socket):

```
# /etc/nftables.d/charness-runner.nft — load with: sudo nft -f /etc/nftables.d/charness-runner.nft
table inet charness_runner {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "runner" ip daddr <hub> tcp dport 22 accept
    # if /etc/resolv.conf names a resolver inside the private ranges (the router), the rejects below stop the runner account's DNS too: let it through first,
    # meta skuid "runner" ip daddr <resolver> udp dport 53 accept
    # meta skuid "runner" ip daddr <resolver> tcp dport 53 accept
    meta skuid "runner" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } reject
    meta skuid "runner" ip6 daddr { fc00::/7, fe80::/10 } reject
  }
}
```

The same check applies, and so does the DNS exception on a Mac (a resolver on the LAN is inside the blocked ranges); a local stub resolver (`127.0.0.53`) needs none. A fence by account protects the network; it does not hide the machine's files from the runner account — see the homes warning above.

**iOS on an always-on Mac: the account's login session.** A LaunchDaemon lives in launchd's System session, and Apple gives neither the iOS Simulator
nor Xcode's nested builds (a package build inside `expo-modules`, SIGTRAP at «Resolve Package Graph») to it. So the admin line also installs a small
**LaunchAgent in the runner account's own login session** (`charness-runner gui-agent`; its definition is the account's own file in `~/Library/LaunchAgents`,
which the admin line loads into the session when there is one and which loads by itself at every login of the account). **While the session exists EVERY
job of an always-on Mac runs its steps — dependencies and command — THERE**, as the same account with the same environment (an iOS build that was not
marked would otherwise crash in the System session without a hint); a runner kept running as a user service or by hand is in a session already and runs
everything where it always did. Without the session, jobs that do not need iOS run in the daemon as before and only `--needs ios` is refused — so an iOS
build or a Simulator test always passes `--needs ios` (the agents' instructions and `remote-run --help` say so). `remote-run exec` runs where the link does. The agent also owns the Mac's Simulator check (it boots and deletes a
Simulator when it starts and when Xcode changes) and keeps every Simulator silent (below).
- **An update installs the agent for you.** A Mac paired before the agent existed — or one whose agent definition a newer charness changed — gets it by itself
  when its runner updates: the runner (which runs as the account) writes the definition into the account's own `~/Library/LaunchAgents` and loads it into the
  account's login session, with no admin and no new paste. It looks again when the runner starts and once an hour. An agent that is already loaded is replaced
  only while the Mac has no job running, paused OR WAITING in its queue (replacing it would cut a build), and the queue is looked at again right before the old agent is
  stopped; otherwise it waits for the next look. Where the account has nobody logged in, the file is written and loads at the account's next login. If that cannot be done
  (the folder cannot be written, `launchctl` refuses), `runners` says so instead of «needs a login»: «ios: no — ios build: the login session's agent could not be loaded
  (<reason>) - log out and back in as runner, or paste a fresh admin line from /runners in an admin account's terminal» when its definition is in place (logging out and in loads
  it), and «… could not be installed (<reason>) - paste a fresh admin line …» when it is not (the admin line finds the account paired and only installs the service).
  *Measured on a real always-on Mac (macOS 26.7.1, 2026-11-05, from inside the service, with the account logged in through Fast User Switching):* the service CAN ask launchd about
  the account's own login domain (`launchctl print gui/<uid>` → exit 0, `session = Aqua`); a domain that does not exist answers «Could not find domain for user gui: <uid>» (exit 112);
  another account's domain answers «Operation not permitted». The service CAN also load an agent into that domain and take it out again: a throwaway agent (another label,
  `RunAtLoad` off, `/usr/bin/true`) was bootstrapped from the service's own context (`launchctl bootstrap gui/<uid> <plist>` → exit 0, no output; `print` → `type = LaunchAgent`;
  `bootout` → exit 0, and it was gone). *Not measured:* what the logged-out account answers — so the runner never takes launchd's «could not find the domain» for «nobody is logged
  in» without also finding none of the session's own processes (`loginwindow`, `Dock`, `Finder`) running as the account; anything else is reported as a failure with launchd's words.
  If the old agent cannot be stopped when it is replaced, the old definition is put back (the next look replaces again) and the way out is the admin line.
- **No session, no iOS — honestly.** With nobody logged in as the account, `runners` says «ios: no — ios build: needs a login of runner», `--needs ios`
  finds no runner for it, and a job that was queued before the session ended is refused with the same words. Nothing logs in by itself: after a reboot,
  log in as the account once at the Mac and switch back to your own account (Fast User Switching keeps its session); the agent starts at that login.
- **The agent stops mid-step** (the session ended, it crashed, an update restarted it): the step ends with 125 and the log says so — never a wait for an
  answer that will not come — and the step's whole process group is ended (TERM, KILL after 10 s) BEFORE the job goes on and its project lock is released,
  so a build the agent left behind never runs on beside the next job; an agent that starts ends the groups of the one before it too. A kill, a timeout or a
  vanished job script ends the step's process group the same way. What an agent finds on disk after a reboot is never trusted: a request folder written before
  the system booted is removed without signalling anything (its recorded ids may name Finder or the Dock by now), and an id is signalled otherwise only while the
  process with that pid still started when it was recorded. A `--needs ios` step with no agent beating is refused at once with the reason.
- **Replacing a loaded service waits for the jobs.** Pasting a fresh admin line over an installed one boots the loaded daemons (and the agent) out and in
  again — `launchctl bootout`, wait until `print` no longer finds them, `bootstrap` (right after a bootout it fails with error 5) — and is refused,
  before anything is touched, while the queue is running a job: let it finish or `charness remote-run kill <id>` it, then paste again.
- **Removing it** needs nothing more than the daemons' commands: the agent notices that its daemons' definitions are gone, removes its own definition
  and leaves (no command an admin pastes names the account's folders — what a runner reports about itself never goes into a `sudo` line).
Android emulators (`-no-window`), Jest, Playwright and Docker work from the daemon as before. If the Simulator refuses to boot even in the session,
`runners` shows the reason of the check («the iOS Simulator check failed: …»), and while a fresh start's check runs, «the iOS Simulator is being checked».

**Silent jobs.** A Simulator plays through the HOST's audio output, whichever account runs it — on the first real run the owner, in a call in another
account of the same Mac, heard an app's voice preview. So the runner keeps every iOS Simulator silent, by the Simulator's own volume and nothing else:
for each booted device, once its boot has finished (`bootstatus` WITHOUT `-b`, which would boot a device that a job's teardown has just shut down),
`xcrun simctl spawn <udid> notifyutil -s com.apple.springboard.volumestate 0` and `-p` the same notification — never the Mac's output, volume or mute, never
anything of the owner's account. It runs where the Simulators are: in the login session's agent on an always-on Mac, in the link itself when the link runs in a
login session (a user service, `charness-runner run`); `~/.charness-runner/logs/` has the log of either. The device's volume is back at 60 after every boot, so a
device that boots again is silenced again, one whose volume (`sim_volume` in its `audiosettings.plist`) does not read back as 0 is told again a few
times, and a failure is a line in `~/.charness-runner/logs/gui-agent.log`, never a stop of a job. **What is and is not known:** the command is a
third-party measurement (the Simlock project's spike on iOS 26.4 and 27.0, Xcode 27.0), not Apple documentation — Apple's Device Hub has the same
control only as a menu (Device > Sound) — and it takes effect 4–13 s after the command, so the first seconds after a boot are not covered. Look at it
once on the Mac: run an iOS job that speaks and listen from another account; if the preview is still heard, `cat ~/.charness-runner/logs/gui-agent.log`
says what the silencer did. **A known limit:** every login session has its own CoreSimulator service, and what a Simulator booted from the System session
(`remote-run exec`, which runs where the link does, or a job while nobody is logged in as the account) looks like to the agent's `simctl list` has not been
verified — it may not see it, and then that Simulator is not silenced. Jobs of an always-on Mac run in the login session while it exists, so theirs are.

## Advanced: a runner over plain ssh

Pairing replaces everything below for a machine that can dial your charness host. Use plain ssh when it cannot (the charness host has
no sshd or no reachable address — a Docker image, a laptop), or when you already have a machine set up this way. You set it up
yourself and list it in a file.

### What you need on the runner

- A Linux or macOS machine you can `ssh` to with a key, and **an account of its own** for charness. The runner runs your project's
  code (tests are code): give it an unprivileged account with no secrets in its home, and nothing of the main machine's environment
  is sent to it.
- `bash`, `rsync` (3.1.3 or newer: older ones compare file times in whole seconds, so an edit made within a second of the previous
  version of the same length can be missed; on macOS see «Put the tools on the runner's PATH» below) and **[Pueue](https://github.com/Nukesor/pueue) 4**
  (the job queue). Pueue is a single static binary:

  ```bash
  mkdir -p ~/.local/bin && cd ~/.local/bin
  base=https://github.com/Nukesor/pueue/releases/download/v4.0.4
  curl -fsSL -O "$base/pueue-x86_64-unknown-linux-musl" -O "$base/pueued-x86_64-unknown-linux-musl"
  mv pueue-x86_64-unknown-linux-musl pueue && mv pueued-x86_64-unknown-linux-musl pueued && chmod +x pueue pueued
  ```

  Pick the asset for your platform from the release page (`aarch64-apple-darwin` for an Apple-silicon Mac, and so on).
- Whatever the project's commands need: Node and a package manager, an Android SDK, Docker, Playwright's browsers. `charness remote-run
  runners` shows what each runner has (below).

#### Put the tools on the runner's PATH

The dependencies step and the command run in the environment of the **non-interactive ssh command** that queued them (Pueue gives a task
the environment of the client that added it, not of its daemon). Such a command does not read `~/.profile`, `~/.zprofile` or the
interactive part of `~/.bashrc`, so its `PATH` is sshd's default, and a Node from nvm, Volta or Homebrew is usually not on it: the first
run then ends with `yarn: command not found` as a failed dependencies step (125). Check what a job will see:

```bash
ssh runner@runner.example 'command -v node yarn rsync pueue'
```

- **bash** (the usual login shell of a Linux runner): on Debian and Ubuntu the bash that sshd starts reads `~/.bashrc` (`man bash`,
  «Invoked by remote shell daemon»; other builds of bash do not read it for ssh at all), but the stock file returns at its top for a
  non-interactive shell (`case $- in *i*) ;; *) return;; esac`), so a `PATH` line an installer appended at the bottom (nvm does) is
  never reached. Put the `export PATH=…` (or nvm's lines) **above** that guard.
- **zsh** (the macOS default): `~/.zshenv` is read by every zsh, ssh commands included (`export PATH=/opt/homebrew/bin:$PATH` there).
- **Any shell**: an absolute path in `install:` (`install: /home/runner/.nvm/versions/node/v22.11.0/bin/yarn install`) covers the
  dependencies step; `-e PATH=…` on the call covers the step and the command (keep the system directories in it:
  `charness remote-run -e PATH=/home/runner/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin yarn test`).

`rsync` is found the same way: the main machine starts it on the runner over ssh, and the runner looks it up on that `PATH`. On macOS
Homebrew's rsync (`brew install rsync`) is not on it, so the system's is used — a 2.6.9-compatible rsync (openrsync since macOS 15),
older than the 3.1.3 needed. Put `/opt/homebrew/bin` (Apple silicon; `/usr/local/bin` on Intel) on the `PATH` as above before relying on a
Mac runner.

`remote-run` starts Pueue's daemon by itself when it does not answer. To run it as a service with limits, so a runaway test cannot
take the machine, use a systemd user unit (and `loginctl enable-linger <account>` so it survives logout):

```ini
# ~/.config/systemd/user/pueued.service
[Unit]
Description=Pueue daemon for charness remote-run

[Service]
ExecStart=/home/user/.local/bin/pueued
Restart=on-failure
# Optional limits (cgroup v2 with controllers delegated to user units; check with `systemctl --user show pueued -p CPUQuota`):
CPUQuota=600%
MemoryMax=24G

[Install]
WantedBy=default.target
```

#### Reach it without a prompt, once

`remote-run` never asks anything: ssh runs with `BatchMode=yes`, so a password prompt or an unknown host key is an error. Make
`ssh runner@runner.example true` work from the main machine's user by hand — key login, and the host key accepted once. It
never turns host-key checking off; it uses whatever your ssh config says.

The key must also work **without an ssh-agent and without a passphrase prompt**: agents of a tracker (Jira) start with a minimal
environment that has no `SSH_AUTH_SOCK`, so a key that is only held by an agent works for a Telegram agent and is rejected
(«permission denied») for a Jira one. Use a key file with no passphrase — `"sshOptions": ["-i", "/home/user/.ssh/runner_key"]` in
`runners.json`, or an `IdentityFile` for the host in your ssh config — and make it a key that opens only the runner's account.

### `~/.config/charness/runners.json`

One file per OS user, shared by every charness instance of that user (a Telegram one and an isolated Jira one alike):

```json
{
  "runners": [
    {
      "name": "box1",
      "ssh": "runner@runner.example",
      "workDir": "/home/user/charness-runner",
      "sshOptions": ["-i", "/home/user/.ssh/runner_key"],
      "pueue": { "bin": "/home/user/.local/bin/pueue", "config": "/home/user/.config/pueue/pueue.yml" },
      "groups": { "default": 2, "emulator": 1 }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits and dashes; unique. Job ids start with it (`box1-k3x9ab`). |
| `ssh` | The ssh destination (`user@host` or a host alias of your ssh config). |
| `sshOptions` | Optional extra `ssh` arguments (`-i`, `-p`, `-J`, …), put before charness's own. |
| `workDir` | Where the runner keeps project copies, job logs and result files: an absolute path on the runner, or `~/…`. Created when missing. |
| `pueue` | Optional `bin` / `config` when Pueue is not on the runner's `PATH` or uses a non-default config. |
| `groups` | Optional Pueue groups and how many jobs each runs at once (`default` always exists). A job joins one with `--group`; two jobs of one *project* never run at the same time whatever the groups say. |
| `minFreeGb` | Optional. The free space the runner keeps on its work disk, in GB; the default is the smaller of 60 GB and 15 % of the disk. `0` turns the free-space upkeep (and the refusal of a submit on a full disk) off; unused copies still go after `copyMaxIdleDays`. See [Queue, limits, cleanup](#queue-limits-cleanup). |
| `copyMaxIdleDays` | Optional. Days a project copy may stay unused before it is removed (default 3). |

A paired runner takes the same two fields from its entry in the hub's `paired.json` (edit it by hand; `charness runners` has no command for them).

The file is checked strictly: an unknown key or a bad value is an error that names the field (never a value). It is read on every
call, so an edit applies at once; agents learn that runners exist when the first one is listed (see [Agents](#agents)).

## The commands

```
charness remote-run [--runner <name>] [--needs <cap>] [--runner-wait <dur>] [--group <g>] [--timeout <dur>]
                    [--with-git] [--send <path>]… [-e NAME=VALUE]… [--bg] <command…>
charness remote-run runners
charness remote-run ls [--all]
charness remote-run status <id>
charness remote-run logs <id> [-f] [--tail N]
charness remote-run wait <id>
charness remote-run kill <id>
charness remote-run fetch <id>
charness remote-run exec [--runner <name>] <command…>
```

Options go **before** the command; parsing stops at the first word that is not an option (like `env` and `ssh`). A command whose
first word is a subcommand name goes after `--`: `charness remote-run -- ls build/`. A subcommand name that follows options is never
run as a job of that name: `--runner box1 exec ls build/` is the `exec` of `ls build/` on `box1` (before `exec` only `--runner` is
understood), and `--bg ls build/` is refused with the way out — put `--` before it. The words of the command are joined with spaces
and run by `bash -c` on the runner, so `charness remote-run 'yarn build && yarn test'` works.

- **Foreground (default)**: syncs the project, runs the dependencies step when needed, runs the command in the same subfolder of the
  runner's copy, streams its output live, and exits with the command's exit code. Interrupting it (Ctrl-C, SIGTERM, an agent tool's
  timeout) or losing the connection kills the whole remote job.
- **`--bg`**: prints the job id at once and returns; the job runs on (an e2e run can take two hours). `wait <id>` blocks until it
  ends, prints the last 50 log lines, brings the result files back and exits with the job's code — Claude can run it in the
  background and is told when it ends. `ls` lists this project's jobs (`--all`: every project of this user), `status` shows one,
  `logs` its output (`-f` follows it), `kill` stops it, `fetch` brings its result files back again.
- **`exec`**: a one-off command in the runner's copy as the last job left it, without syncing (`ls build/`, `adb logcat -d`). On the
  runner of this project's last job unless you name another with `--runner` (with several runners the first one in the file may
  hold no copy, or an old one); a project that has no job yet goes to the first online runner. Not for editing. Killed like a foreground job. Its exit code is the command's own, also 255 — only a connection that dropped before the
  runner reported the code ends with 125.
- **`clean [<slug>]`**: removes a project's copy from every runner and prints what each freed — the copy of the project you run it in, or the one named (the name a runner's disk message gives, `myapp-0a1b2c3d4e`).
  **A copy belongs to a project folder, not to a task:** every task run from one folder uses the same copy on a runner, so run `clean` when the LAST open task of that folder is closed — and before the folder or worktree is removed, since the
  name is lost with it — so that its tens of GB of build output do not wait for the 3-day prune. Refused — exit 125, the copy untouched — while a job of it runs or waits in the queue, an `exec` runs in it, a job is being submitted, or a job
  ended less than an hour ago whose results nobody has fetched (`wait`, `fetch` and a foreground run leave the mark that they have; `fetch <id>` does it too if the owner is gone); the line names the job. The logs and result files of that
  copy's jobs go with it, so `fetch` what you need first. A removal that ran past its time (a very big copy) or was cut off is finished by the next `clean` of the same name. A runner that cannot be reached — offline, its Mac's lid shut, or
  a connection lost while it removed — is said so and does not fail the command: its copy stays (or is finished by the runner as far as it can) until you clean again; a copy that is not there is «nothing to clean». A command that is simply called
  `clean` goes after `--`.
- **`runners`**: one short block per runner, all probed at once (at most 20 s; a runner that does not answer in time is shown offline
  with its last snapshot):

  ```
  box1 — online · Ubuntu 24.04 (Linux 6.8, x86_64)
    CPU AMD Ryzen 7 9700X 8-Core Processor, 8 cores / 16 threads, load 2.1 · RAM 63 GB, 41 GB free · disk 180 GB free (work dir) · 3 project copies, 24 GB
    jobs: 1 running, 2 queued, 2 projects · groups: default 2, emulator 1
    can: android (KVM, emulator) · docker · playwright (chromium) · ios: no (Linux)
  mac — offline (ssh: connection timed out) · last seen 2026-10-30 14:02 UTC — as it was then: macOS 15.1 (Darwin 24.1, arm64)
    …
  ```

  An offline runner shows its last snapshot. `--needs android|ios|docker|playwright` picks the first runner (in file order) that
  answers and has that capability; `--runner <name>` picks one. None fits → exit 125 with this view and why.

- **Paired runners** ([attached](#pair-a-runner) with `/runners` or `charness runners pair`, no `runners.json` entry) are listed after the hand-made ones. A paused
  runner is never picked (`charness runners pause <name>` / `resume <name>`, or `charness-runner pause` on the machine itself). With `--needs`, an
  offline paired runner that had the capability when it was last seen is **waited for**: the command says `waiting for a runner with android (mac
  offline since …)` once, looks again every 10 s and gives up after `--runner-wait` (`15m` by default, `0` = fail at once) with exit 125. A
  capability no runner has, and a hand-made runner that is offline, are not waited for.

`--timeout` (default 3 h, at most 7 days; `90m`, `3h`, `1h30m`, `600` seconds) applies to both modes and counts from the moment the job is
queued on the runner: a job that runs past it is killed and the exit code is 124, and a `--bg` job that waited its whole limit behind a busy
group is over the moment it starts (124) without running its command. `-e NAME=VALUE` passes one environment variable explicitly; **no** variable of the main machine reaches the
runner otherwise.

### Exit codes

The command's own code passes through. `remote-run` itself uses **125** when it failed (no runner, ssh, the file sync, the
dependencies step — the message says which), **124** for a timeout, **130 / 143 / 129** when it was interrupted locally (SIGINT /
SIGTERM / SIGHUP), **141** when its stdout was closed — `charness remote-run … | head` — and it stopped the job it owned (the line on
stderr says so; to read only a part of a long output, start the job with `--bg` and use `logs <id> --tail <lines>`), **137** when the
job was killed (`kill`, a lost lease), **2** for a command line it cannot read. Its own lines go to stderr prefixed `remote-run:`; the
job's output goes to stdout.

## Files there, and back

The project is the git working tree the command runs in (anything else is refused with a message).

- **Sent**: tracked and untracked files that `.gitignore` does not name, submodules included, deletions mirrored. Files the runner
  keeps for itself (`node_modules`, `build`, `Pods`, caches — everything ignored) are never touched. `.git` is not sent unless
  `--with-git`, and a copy that got one for a run does not keep it for the next plain run.
- **Never sent** unless `.remote-run` opts them in with `send:` (for every call) or the call does with `--send <path>` (for that call
  alone, repeatable, the same patterns relative to the project root — also for a file git ignores): secret-looking files — `.env`,
  `.env.*` (except `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.p12`, `*.key`, `.npmrc`. `remote-run` says which ones it
  held back — **once**: the line comes again only when the list changes (a file added, removed or opted in), not before every run; a file
  sent by `--send` is named on every call that sends it, and a `--send` pattern that matches nothing is said too. A file name with a
  newline is refused (named); drop it with `exclude:`.
- **Dependencies**: the install step runs on the runner only when its key changed since the last successful install in that copy (or
  the last one failed). By lockfile: `yarn.lock` → `yarn install --immutable`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`,
  `package-lock.json` → `npm ci`; no lockfile, no step. The key is the lockfile, every `package.json`, `.yarnrc.yml` and `patches/`.
- **Back**: the paths `pull:` lists. After a job, only the matching files the job **created or changed** come back — an untouched
  snapshot never overwrites your edit, and a previous job's leftovers never return. They land at the same paths in the project, so
  updated snapshots show in `git diff`. A foreground run fetches at its end (also on failure); `--bg` jobs by `wait` / `fetch`. The
  files come back into the project the job was submitted from — remembered on the main machine — and nowhere else, and only regular
  files that a `pull:` pattern names; a symlink or a path outside the project is refused. Whatever the patterns say, nothing inside a
  `.git`, nothing inside a folder git takes hooks from (the one `core.hooksPath` names when it is inside the project — husky's
  `.husky/_` brings its parent `.husky` with it — and the conventional `.husky` and `.githooks`), and not the project's own
  `.remote-run` is ever copied in: a hook or a config planted there would run code on the main machine at the next commit. That is
  all remote-run can recognise. A pattern is trust in the runner for what it names, and other things also run at commit or install time
  (a `lint-staged` or `lefthook` config, `package.json` scripts), so keep patterns narrow (`test-results`, not `**`).

### `.remote-run`

Optional, in the project root: `key: value` lines, `#` starts a comment, an unknown key or a bad value is an error naming the line.

```
pull: e2e/artifacts test-results **/__snapshots__
install: yarn install --immutable          # replaces the detected command; "install: none" turns the step off
install-key: yarn.lock package.json patches .yarnrc.yml
exclude: fixtures/huge                     # more paths that are never sent
send: .env.test                            # opt a held-back secret-looking file in
```

A failed dependencies step ends with the **first** error lines of its output (up to 8) and, when the tool names a `build.log` («logs can
be found here: …/build.log» — yarn), the first error lines of that file: a tool's own last lines are its summary («couldn't be built
successfully»), and the cause — a missing Python module, a compiler — is far above them, out of reach of `wait`'s last 50 lines. When
the tool has already removed the build log, the line says so and names the way to get the build output into the job's log:
`-e YARN_ENABLE_INLINE_BUILDS=1` on the call. The step's whole output is in `logs <id>`.

Patterns are relative to the project root. `*` is any run of characters inside one path segment, `?` one character, `**` a whole
segment of any depth; a pattern naming a folder brings everything below it. `snapshots` is the folder at the root only —
`**/snapshots` any folder of that name.

## Queue, limits, cleanup

Two runs of one project queue on the runner: each runs against the tree **as it was when it was submitted**, one after the other.
(A queued run holds one of its Pueue group's slots while it waits.) A queued foreground run prints «waiting for job <id> of this
project» and keeps waiting, bounded by its `--timeout`. Other projects run in parallel up to the group limits. Job records, logs and
result files on the runner are removed after 3 days.

**The runner's disk keeps itself free.** A project copy is a whole checkout with its build output (an iOS build alone is tens of GB), so copies of finished
tasks pile up. On every submit (and when `runners` probes it) the runner removes a project copy that was not used for 3 days (`copyMaxIdleDays`), and while the
disk of its work dir has less free space than it keeps (the smaller of 60 GB and 15 % of the disk; `minFreeGb`) it removes the least recently used copies one by
one until it has. Never removed: a copy whose project lock is held by a live job, a copy an `exec` is running in, a copy with a queued, running or just-submitted job (a first
upload of a big project counts as long as files keep arriving), a copy whose job ended within the last hour (its result files are about to be fetched), and the copy of the job being
submitted. A copy's «last use» is its last activity: a submit, an `exec` (start and end) or the end of one of its jobs. Each removal is one line of the submit's output (`runner mac: removed the project copy app-1a2b3c (freed 41 GB, the disk was short of free space)`); the result
files of a finished job go with its copy. If the disk is still short after that, the submit fails at once (exit 125) instead of a build failing half-way with «No space left on
device»: `runner mac: only 8 GB free on the work disk, the runner needs 60 GB; biggest project copies: app-1a2b3c 41 GB, …; free space with `charness remote-run clean <slug>` …`.
`runners` (and the bot's `/runners`) shows the free space, a **LOW** mark under the target, and how many project copies the runner keeps and what they take (sizes are measured in the
background, and a copy again only after it was used, so a figure can lag: `~` / «so far» while some are not measured yet).

If a submit has to remove copies first it can take minutes: when the runner's last probe found its disk short, the submit says so before it starts, and a preparation that runs past 15 minutes
says to submit again (the runner carries on with the removal as far as it can, and the next submit continues where it stopped). Prunes do not pile up: a submit whose disk is short waits for the one
already at work (up to 10 minutes, then it goes on), one whose disk is fine does not wait at all, and the prune that `runners` starts in the background leaves the work to the one at it. Only a view of the
runners — `runners` and the bot's `/runners` — starts that background prune: the probe a `run` or an `exec` makes first never does, so the project about to be used (typically the least recently used copy)
is not taken before the job's own submit, which keeps its copy, arrives.

**A Mac's disk may not give the space back.** On APFS, `df` leaves out *purgeable* space, and with Time Machine local snapshots a removed project copy frees nothing until the snapshots are thinned
(`tmutil listlocalsnapshots /` lists them, `tmutil thinlocalsnapshots /` thins them; or turn Time Machine's local snapshots off on that Mac). When two removals in a row give next to nothing back from copies
measured much bigger (a small or never-measured copy between them is not counted), the runner stops removing further copies (it would empty itself for nothing), says so, and the refusal names this cause — and the other one it can have anywhere: a job writing to the same
disk meanwhile eats the space a removal frees.

`kill` sends SIGTERM to the job's whole process group and SIGKILL after 10 s. A process that leaves the group on purpose (`setsid`,
as a Gradle daemon or the adb server do) survives by design — it is the runner's long-lived helper, not the job's.

## Agents

While `runners.json` lists at least one runner or one is paired, the bot MCP's instructions (Telegram topics and tracker conversations alike) carry
one bullet: what remote-run is for, `runners` first, `--bg` plus `wait` in the background for anything longer than the tool
timeout, and `clean` for the runner copy of a folder whose last task is closed (never the copies of others) — with one line under it per runner: its name, its OS and what it could do when it was last probed (`mac — macOS 15.1, android,
playwright`; `(paused)` after the name of a runner that is held back; a runner nobody has probed yet shows only its name and, if paired,
the OS it reported). Claude Code cuts a server's instructions at 4,096 characters, so the list gets the room that is left after the rest of the
text — every runner when it fits, else the first ones and «… and N more» (the bullet itself always stays; `runners` is the full list). The lines are a snapshot taken at connect — `charness remote-run runners` has the live state. Nobody without a runner
sees any change. A running agent reads the instructions at connect, so it sees the bullet and the list after its next session start or
idle cycle.

A **Jira** agent runs with a minimal environment: it reaches `charness` through the bot's `PATH`. If the bot's `PATH` lacks it (or
the instance's env file sets `PATH`), map it in `jira.json` `agentBinaries` (see [Jira setup](../SETUP.md#jira-setup)) — for example
`"charness": "/home/user/.nvm/versions/node/v22/bin/charness"`. Its environment also lacks `SSH_AUTH_SOCK` (see
[above](#reach-it-without-a-prompt-once)). `XDG_CACHE_HOME` is passed on (a path, no secret — also when the instance's env file sets it, since the bot follows that value), so a
Jira agent uses the same local cache as the bot and the other agents — ssh control sockets, the last probe of each runner, and the record
of which project each job came from — and the runner lines above see the probes it took.

## Troubleshooting

- `runners` says **offline (ssh: …)**: run the ssh command by hand. «the host key is not trusted yet — connect once by hand» means
  exactly that; «the key was rejected» is the account's `authorized_keys`.
- A paired runner says **offline (the runner is not connected)**: on that machine, `charness-runner status` shows the link state and the last
  error. Nothing holds the link until you run `charness-runner run` or `service install`; after a reboot a terminal `run` is gone, a service
  is not. «removed by …» means the charness host removed it (`/runners`): pair again with a new line.
- **Pueue: MISSING** on a hand-made runner: install it as above or set `pueue.bin` (a paired runner installs its own).
- A job «lost the connection» message: the runner stops the job by itself when its heartbeat lease (45 s) runs out; `ls` shows it.
- Where the files live: the runner's `workDir` (`~/.charness-runner/work/` on a paired one); the main machine keeps ssh control sockets and
  the last probe of each runner in `~/.cache/charness/remote-run/`; the pairing registry is `~/.config/charness/runners/`.
