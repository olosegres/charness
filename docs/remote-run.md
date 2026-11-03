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
- **The runner machine** (Linux or macOS) needs outbound internet to that sshd, Node 22.12 or newer, `ssh` and `tar`. The utility
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
     copy — and **everything it runs as the account has no terminal**: a session of its own, no standard input, its output passed through the
     admin's process with the control characters removed, so code the account can change never gets the admin's terminal: on a Mac the LaunchDaemon that runs as the account, on Linux its systemd user service with lingering switched on
     (`loginctl enable-linger`; the install itself runs as the account). **Root never runs, reads through or writes into anything the
     account can change** — the account runs the agents' code, so its folder is not trusted: root writes only the LaunchDaemon
     definitions into `/Library/LaunchDaemons` and calls `launchctl` / `loginctl`; everything of the account's own (its Pueue, its record,
     its user service) is done by the account's own program, started with `sudo -u`.
   - **What the admin line trusts.** Pasting it **runs code from this charness host as root on this machine**: the line is text
     the charness host made, and the program root runs from it is the one in the charness host's own install — so whoever can change that
     install (its user, and the agents that run as that user) controls what runs as root here, and what it installs stays after the paste.
     The plain line trusts the charness host only with the runner account. Paste the admin line only for a charness host you would let run
     code as root on this machine.
   - **The code in the line.** `sudo` asks for the admin's password once and writes the command line — the pairing code with it — to the
     system log. The code is single use and good for 10 minutes: a line that was used is dead, and so is a retry's (see below), which
     closes its own code. A line that was refused (no such account, an admin account…) leaves its code open until it expires — on purpose,
     so you can fix the account and paste it again.
   - **Node.** Both root and the account run one Node, and the line picks it itself: the `node` that `sudo` finds, else
     `/opt/homebrew/bin/node`, `/usr/local/bin/node` or `/usr/bin/node` — **never a Node inside a home folder** (`/Users/<name>`, `/home/<name>`,
     root's own; judged by its real path, so a link that leads into one does not count), one the account can run, 22.12 or newer. Root runs nothing
     from somebody's home, and the runner's launcher and the daemons' `PATH` carry this Node, so a runner must not stop the day that home is closed
     or nvm moves on. With none, the line stops before anything is fetched and says to install Node system-wide (`brew install node` on a Mac, the OS
     package, nodejs.org); the plain line (the second message) uses the Node of the runner account's own login and warns when it lives in
     another user's home, and `charness-runner service install` refuses one.
   - **Homes the runner account can read.** macOS makes every home `750` with group `staff`, and a standard account is in `staff`, so by default
     the agents' jobs — and the npm packages they install — can read the source code, keys and tokens of the people who use the machine. **Both
     lines** end with a warning naming the homes the runner account can read (the admin line asks as that account, not with root's rights) and the
     one-line fix for each: `sudo chmod 700 /Users/<name>`. After closing a home that used to hold the Node, install Node system-wide first.
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
`~/.charness-runner/bin`, the folder of the `node` that runs the utility, Homebrew and the system folders, the Android SDK where the
usual installers put it — and nothing of the charness host's environment. Anything else (`PATH` additions for a Node from nvm, `JAVA_HOME`,
a token) goes into `~/.charness-runner/env`, one `KEY=VALUE` per line, read again for every job.

**iOS on a Mac LaunchDaemon.** Apple does not give the iOS Simulator to a daemon or to a process started as another user. The utility
tries for real — it boots and deletes a Simulator when the service starts and when Xcode changes — and reports `ios` only if that
worked. If the Simulator refuses to boot, `runners` says «ios: no — needs the runner user's login session»; if the check fails for another reason (no
runtime installed, `simctl` cannot be run) it shows that reason; and while the check of a fresh start is still running it says «the iOS Simulator is
being checked». Android emulators (`-no-window`), Jest, Playwright
and Docker work from the daemon.

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

The file is checked strictly: an unknown key or a bad value is an error that names the field (never a value). It is read on every
call, so an edit applies at once; agents learn that runners exist when the first one is listed (see [Agents](#agents)).

## The commands

```
charness remote-run [--runner <name>] [--needs <cap>] [--runner-wait <dur>] [--group <g>] [--timeout <dur>]
                    [--with-git] [-e NAME=VALUE]… [--bg] <command…>
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
first word is a subcommand name goes after `--`: `charness remote-run -- ls build/`. The words of the command are joined with spaces
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
- **`runners`**: one short block per runner, all probed at once (at most 20 s; a runner that does not answer in time is shown offline
  with its last snapshot):

  ```
  box1 — online · Ubuntu 24.04 (Linux 6.8, x86_64)
    CPU AMD Ryzen 7 9700X 8-Core Processor, 8 cores / 16 threads, load 2.1 · RAM 63 GB, 41 GB free · disk 180 GB free (work dir)
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
SIGTERM / SIGHUP), **137** when the job was killed (`kill`, a lost lease), **2** for a command line it cannot read. Its own lines go
to stderr prefixed `remote-run:`; the job's output goes to stdout.

## Files there, and back

The project is the git working tree the command runs in (anything else is refused with a message).

- **Sent**: tracked and untracked files that `.gitignore` does not name, submodules included, deletions mirrored. Files the runner
  keeps for itself (`node_modules`, `build`, `Pods`, caches — everything ignored) are never touched. `.git` is not sent unless
  `--with-git`, and a copy that got one for a run does not keep it for the next plain run.
- **Never sent** unless `.remote-run` opts them in with `send:`: secret-looking files — `.env`, `.env.*` (except `.env.example`,
  `.env.sample`, `.env.template`), `*.pem`, `*.p12`, `*.key`, `.npmrc`. `remote-run` says which ones it held back. A file name with a
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

Patterns are relative to the project root. `*` is any run of characters inside one path segment, `?` one character, `**` a whole
segment of any depth; a pattern naming a folder brings everything below it. `snapshots` is the folder at the root only —
`**/snapshots` any folder of that name.

## Queue, limits, cleanup

Two runs of one project queue on the runner: each runs against the tree **as it was when it was submitted**, one after the other.
(A queued run holds one of its Pueue group's slots while it waits.) A queued foreground run prints «waiting for job <id> of this
project» and keeps waiting, bounded by its `--timeout`. Other projects run in parallel up to the group limits. Job records, logs and
result files on the runner are removed after 3 days, a project copy not used for 30 days.

`kill` sends SIGTERM to the job's whole process group and SIGKILL after 10 s. A process that leaves the group on purpose (`setsid`,
as a Gradle daemon or the adb server do) survives by design — it is the runner's long-lived helper, not the job's.

## Agents

While `runners.json` lists at least one runner or one is paired, the bot MCP's instructions (Telegram topics and tracker conversations alike) carry
one bullet: what remote-run is for, `runners` first, and `--bg` plus `wait` in the background for anything longer than the tool
timeout — with one line under it per runner: its name, its OS and what it could do when it was last probed (`mac — macOS 15.1, android,
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
