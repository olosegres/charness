# Running heavy commands on another machine — `charness remote-run`

An agent edits files on the machine the bot lives on. A test suite, a build or an emulator run can take most of that
machine's CPU and memory for an hour. `charness remote-run` sends such a command to a **runner** — another machine you reach
by ordinary ssh — runs it in a copy of the project there, and brings back its output, its exit code and the result files you
declare, as if the command had run locally. Every agent of the OS user that runs charness can call it: Telegram topics
(Claude and OpenCode), Jira agents, and you in a shell.

In this phase a runner is a machine **you set up by hand** and list in a file. Pairing machines from Telegram is not part of it.

## What you need on the runner

- A Linux or macOS machine you can `ssh` to with a key, and **an account of its own** for charness. The runner runs your project's
  code (tests are code): give it an unprivileged account with no secrets in its home, and nothing of the main machine's environment
  is sent to it.
- `bash`, `rsync` (3.1.3 or newer: older ones compare file times in whole seconds, so an edit made within a second of the previous
  version of the same length can be missed; on macOS `brew install rsync`) and **[Pueue](https://github.com/Nukesor/pueue) 4**
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

### Reach it without a prompt, once

`remote-run` never asks anything: ssh runs with `BatchMode=yes`, so a password prompt or an unknown host key is an error. Make
`ssh runner@runner.example true` work from the main machine's user by hand — key login, and the host key accepted once. It
never turns host-key checking off; it uses whatever your ssh config says.

The key must also work **without an ssh-agent and without a passphrase prompt**: agents of a tracker (Jira) start with a minimal
environment that has no `SSH_AUTH_SOCK`, so a key that is only held by an agent works for a Telegram agent and is rejected
(«permission denied») for a Jira one. Use a key file with no passphrase — `"sshOptions": ["-i", "/home/user/.ssh/runner_key"]` in
`runners.json`, or an `IdentityFile` for the host in your ssh config — and make it a key that opens only the runner's account.

## `~/.config/charness/runners.json`

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
charness remote-run [--runner <name>] [--needs <cap>] [--group <g>] [--timeout <dur>] [--with-git]
                    [-e NAME=VALUE]… [--bg] <command…>
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

While `runners.json` lists at least one runner, the bot MCP's instructions (Telegram topics and tracker conversations alike) carry
one bullet: what remote-run is for, `runners` first, and `--bg` plus `wait` in the background for anything longer than the tool
timeout. Nobody without a runner sees any change. A running agent reads the instructions at connect, so it sees the bullet after its
next session start or idle cycle.

A **Jira** agent runs with a minimal environment: it reaches `charness` through the bot's `PATH`. If the bot's `PATH` lacks it (or
the instance's env file sets `PATH`), map it in `jira.json` `agentBinaries` (see [Jira setup](../SETUP.md#jira-setup)) — for example
`"charness": "/home/user/.nvm/versions/node/v22/bin/charness"`. Its environment also lacks `SSH_AUTH_SOCK` (see
[above](#reach-it-without-a-prompt-once)) and `XDG_CACHE_HOME`: the local cache (ssh control sockets, and the main machine's own note of
which project each job came from) then follows `HOME` — `~/.cache/charness/remote-run/` — so when the other agents run with
`XDG_CACHE_HOME` set, a job one of them submitted is not one a Jira agent can fetch the files of («this machine did not submit the job
as this user»); its output and exit code still come with `wait`. Jobs belong to the agent that submitted them.

## Troubleshooting

- `runners` says **offline (ssh: …)**: run the ssh command by hand. «the host key is not trusted yet — connect once by hand» means
  exactly that; «the key was rejected» is the account's `authorized_keys`.
- **Pueue: MISSING** on a runner: install it as above or set `pueue.bin`.
- A job «lost the connection» message: the runner stops the job by itself when its heartbeat lease (45 s) runs out; `ls` shows it.
- Where the files live: the runner's `workDir`; the main machine keeps ssh control sockets and the last probe of each runner in
  `~/.cache/charness/remote-run/`.
