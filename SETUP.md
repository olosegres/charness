# Setup

How to install, configure and run Charness. The common part comes first — where to run it, install, the
environment, several instances on one host, updating; then follow the surface you use:
[Telegram](#telegram-setup) or [Jira](#jira-setup). The whole bot can also run in a container instead of through
npm — see [Alternatives](#alternatives) at the end. What Charness does is in the [README](README.md).

## Common setup

### Where to run the bot server

The bot runs anywhere the agent CLIs run:

- **Your own working machine** — the simplest start: launch `charness`
  from your projects parent folder and your laptop/desktop becomes the
  backend. The catch: agents are only reachable while the machine is on and
  awake.
- **A remote server (cloud VPS/VDS or bare metal)** — the more convenient
  setup: organize your working environment there once (git + your repos,
  Claude Code / OpenCode, `charness`) and you get an always-on dev box you
  drive from any device through Telegram — phone, tablet, voice. When picking
  one, a bare-metal server without virtualization beats a virtualized VPS/VDS:
  its NVMe drives are usually much faster, which matters once you also build
  and run a dev server there, not just the agents. Classic terminal access to
  the very same Claude sessions stays available over SSH — run plain `claude`
  in the project folder: it reads the same `~/.claude/projects/<cwd-slug>/`
  session store the bot uses, so a session started in a Telegram thread can
  be picked up in the terminal and vice versa.

### Install the CLI

```bash
npm install -g charness      # needs Node ≥ 22.12
```

This registers the `charness` command; the former `telegramcode` command (and
`telegramCode`) still works as an alias. Coming from the old `telegramcode` npm
package (2.x)? Run `npm uninstall -g telegramcode` first: both install the same
commands. The config, `DATA_DIR` and sessions carry over as they are: a
`~/.config/telegramcode/.env` is still read while `~/.config/charness/.env` does
not exist, and a `~/.telegramCode` data dir is still used while `~/.charness` does
not exist. At a cold start the bot renames those two dirs itself (leaving a symlink
at the old path) and says so; every old name still in use prints one deprecation
line. What it does, its limits and the steps by hand:
[MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md).

### Environment variables

These settings apply to every surface. The Telegram ones — the bot token, the group and the DM, voice — are listed
under [Telegram environment variables](#telegram-environment-variables).

#### External Optional

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `~/.charness` (an existing `~/.telegramCode` is kept while `~/.charness` does not exist) | Per-instance state. **Mandatory** if you run two bots on the same host — otherwise both share `state.json` and `mcp.json` and corrupt each other |

Agent provider/auth setup is normally done inside the agents themselves:
`claude login` for Claude CLI and `/connect <provider-id>` (for example,
`/connect openrouter`) or OpenCode's own config/plugins for OpenCode. No provider
API key env var is required by the bot for text sessions. For OpenCode, install
any third-party provider plugins or authentication resolvers before launch if
your chosen providers need them.

#### Advanced / Not Normally Needed

| Variable | Default | Set only when |
|---|---|---|
| `WORK_ROOT` | `$PWD` | You cannot control the process cwd; normal launch uses `cd <projects-parent> && charness` |
| `OPENCODE_URL` | `http://localhost:4096` | You use a custom OpenCode port or external server; the port must differ per instance |
| `OPENCODE_USERNAME` | `opencode` | `OPENCODE_PASSWORD` is set for a protected OpenCode server |
| `OPENCODE_PASSWORD` | — | Connecting to a protected OpenCode server |
| `OPENCODE_ALLOW_REMOTE` | — | `OPENCODE_URL` intentionally points outside loopback |
| `OPENCODE_BIN` | (auto) | The `opencode` binary is not on PATH or you use a fork |
| `CLAUDE_BIN` | (auto) | The `claude` binary is not on PATH due to nvm/asdf/systemd PATH differences |
| `ANTHROPIC_API_KEY` | — | A custom MCP/OpenCode plugin/auth resolver explicitly reads it; not needed for normal Claude CLI auth. The json-stream Claude backend strips it from the agent's env (subscription billing) |
| `SCHEDULER_MCP_PORT` | an OS-chosen free loopback port | You need a stable, explicitly chosen port; it must differ from this instance's `OPENCODE_URL` port |
| `CLAUDE_SCRAPE_DEBUG` | off | You are debugging Claude tmux scraping and need full RAW/FILTERED chunks |
| `AGENT_IDLE_MINUTES` | `55` | A json-stream Claude topic idle for this long is compacted (when `/compact_on_idle` allows) and its process stopped; the session sleeps and the next message resumes it — shorten it only for a test; a non-positive or non-numeric value keeps the default |
| `REQUEST_BACKSTOP_MINUTES` | `90` | A request (a Jira hand-over, a message in an answers-only topic) with nothing seen working on it for this long is re-posted to its session — shorten it only for a test; a non-positive or non-numeric value keeps the default |
| `TMUX_SOCKET_NAME` | — (the default tmux server) | The instance must run its agents on its OWN tmux server (`tmux -L <name>`; any plain name except `default`). Recommended for a second instance on one host: at boot an instance kills every agent session on its server that its own state does not know |
| `ENV_FILE` | — | Absolute path of the ONLY env file to read — no `~/.config/charness/.env`, no `$PWD/.env`; its values win over the inherited environment. Set it in the launching environment, never inside an env file (the start refuses that). `scripts/run-isolated.sh <env-file>` (in a checkout) starts an instance with a clean environment plus this variable |
| `CONNECTORS` | `telegram` | Experimental: the surfaces this instance serves, as a comma list — see [Jira setup](#jira-setup). An instance that lists `jira` refuses to start on Node below 22.12 and without `ENV_FILE`, `TMUX_SOCKET_NAME` and `DATA_DIR/jira.json`, and — with Telegram off — with a `TELEGRAM_BOT_TOKEN` or any `ATLASSIAN_*` variable in its environment. Any instance refuses to start on a `DATA_DIR` that holds conversations of a surface it does not serve |

> `WORK_DIR` (1.x) is retired. Use the wrapper from the desired parent folder
> instead of carrying the old env forward.

### Two instances on one host

Two host instances, or a host instance next to a container: each pair of variables below must differ to avoid
silent corruption. Two containers need only different tokens and groups (Telegram), `DATA_DIR`s, container names and
hostnames: their ports and tmux servers are their own.

| What | Why it must differ |
|---|---|
| `TELEGRAM_BOT_TOKEN` (Telegram) | Telegram routes updates to a single long-poller per token; sharing → message loss |
| `ALLOWED_GROUP_ID` (Telegram) | The bot gates by group id; sharing → cross-instance leakage |
| `WORK_ROOT` | Each instance manages its subtree; sharing → tmux name collisions |
| `DATA_DIR` | `state.json` / `mcp.json` / `threads/` per instance; sharing → corrupted JSON |
| `OPENCODE_URL` port | OpenCode server binds the port; second start fails with `EADDRINUSE` and you'd silently share sessions |
| `SCHEDULER_MCP_PORT` | Optional stable scheduler-MCP port; if set, it must differ from that instance's `OPENCODE_URL` port |
| `TMUX_SOCKET_NAME` | Optional, recommended: each instance's boot kills the agent sessions on its tmux server that its own state does not know — on one shared server, the other instance's |

### Updating

An npm install updates with `npm install -g charness@latest`; then restart `charness` (what survives a restart:
[Restart behaviour](README.md#restart-behaviour)).

**An update that renames something ships a migration guide** — read it before the restart. The names that were
renamed from TelegramCode to Charness (environment variables, the data dir, the Docker names, …) still work for
now and print a deprecation line at start; the steps are in
[MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md), the summary in the top entry of
[CHANGELOG.md](CHANGELOG.md). `scripts/self-update.sh` names a newly added migration guide in its log.

#### Updating a checkout (self-update, no root)

A checkout — the one the [Docker container](#run-with-docker) runs, or a clone from
[DEVELOPMENT.md](DEVELOPMENT.md#local-development) — updates with `scripts/self-update.sh` (not in the npm package).
It refreshes the checkout in place, running as the checkout's owning user — no root, no cross-user copying. It is
safe to run blindly (e.g. from cron):

- fast-forward only: it skips silently when the tree has tracked changes, a
  merge/rebase is in progress, or local history diverged from the upstream —
  a dev clone that is ahead of origin is never touched;
- `yarn install --immutable` runs only when `yarn.lock` / `package.json`
  changed;
- a hot-mode instance (`charness hot`) rebuilds and restarts the worker
  by itself (after a dependency install the script touches `tsconfig.json`
  so `tsc -w` recompiles with the new modules); a non-hot instance gets
  `yarn build` plus a restart notice — the script never kills processes;
- changes to the hot supervisor itself (`src/cli.ts`, `src/cli/hot.ts`,
  `nodemon.json`) are flagged with a warning: those need a manual
  `charness hot` restart (nodemon reloads only the worker).

For unattended updates give the deploying user read access to the repo (e.g.
a read-only GitLab deploy key on a passphrase-less SSH key) and add a cron
entry:

```cron
*/10 * * * * /path/to/charness/scripts/self-update.sh >> "$HOME/.local/state/charness/self-update.log" 2>&1
```

(create the log directory once: `mkdir -p ~/.local/state/charness`).

## Telegram setup

Four steps: create a bot, (optionally) set up a group, launch from your projects folder, bind a topic to an agent.
The CLI is installed first — see [Install the CLI](#install-the-cli). After the steps: the
[required files structure](#required-files-structure) and the
[Telegram environment variables](#telegram-environment-variables).

> **[manual]** tags a step you must do by hand in the Telegram app — an agent
> running on the host can't do it for you. Everything unmarked is a host-side
> command (or file edit) that can be automated.

### 1. Create the bot

**[manual]** In Telegram, with @BotFather:

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow prompts.
2. Save the token (`123456789:ABCdef...`).
3. **Disable privacy mode** — same chat: `/setprivacy` → pick this bot →
   `Disable`. Without this the bot only sees `/commands`, not free-form text.

<p><img src="docs/images/01-botfather.png" width="360" alt="@BotFather: /newbot to get the token, then /setprivacy → this bot → Disable" /></p>

Put the token where the bot reads it — the global config `.env`:

```bash
mkdir -p ~/.config/charness
$EDITOR ~/.config/charness/.env
```

```dotenv
# ~/.config/charness/.env — the one place your keys live
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
# GROQ_API_KEY=...     # optional: free voice transcription
# OWNER_USER_ID=...    # set to drive the bot from its DM (step 2)
```

All keys the bot needs live in this one file — the bot token and the optional
`GROQ_API_KEY` for voice sit side by side, no separate stores. (Agent
provider auth is the exception, and lives inside the agents themselves:
`claude login` for Claude, `/connect` or OpenCode's own config for OpenCode —
see [Environment Variables](#environment-variables).) The wrapper loads env
from two locations, in order — a global base and an optional per-project
override:

1. `~/.config/charness/.env` — base, set once, used everywhere.
2. `$PWD/.env` — per-project tweaks (last write wins).

The full annotated template is `.env.example` (shipped with the package and in
the repo).

### 2. Set up a group (optional) or DM

The bot serves a **forum supergroup**, the **owner's private chat (DM)**, or
both at once (`CHAT_MODE`, default `both`). The group is the nicest UX — a
visible topic list, per-topic names/icons, quick agent switching — but it is
**optional**: with `OWNER_USER_ID` set you can run entirely from the bot's DM.

**To use a group (recommended)** — **[manual]**, all in the Telegram client:

1. In a Telegram client: `New Group` → name it → add the bot.
2. Open group settings → enable **Topics** (Forum mode).
3. Promote the bot to admin with these rights:
   - `Manage Topics` (required — bind/create threads)
   - `Delete Messages` (for `/clear_messages`)
   - `Pin Messages` (per-thread status banner + question alerts; `/doctor`
     warns if missing, but the bot still runs without it)
4. **Remove the bot from the group and add it again.** Telegram caches the
   privacy-mode flag on join; without re-adding, the bot keeps private-mode and
   ignores free-form messages (see
   [Troubleshooting → Bot doesn't see text](README.md#bot-doesnt-see-text-telegram)).

<p>
  <img src="docs/images/02-enable-topics.png" width="360" alt="Group settings → Topics toggle enabled (Forum mode)" />
  <img src="docs/images/03-promote-admin.png" width="360" alt="Bot admin rights: Manage Topics, Delete Messages, Pin Messages ticked" />
</p>

The group **id is automatic** — leave `ALLOWED_GROUP_ID` empty and the bot
auto-pairs with the first forum supergroup an admin talks to it from (the
`-100…` id is saved to `state.json`; re-point later with `/pair`). To pin a
specific id by hand, set `ALLOWED_GROUP_ID` to the numeric value (a group
**name** is not accepted) — that also disables auto-pairing. **Access control:**
whoever is a creator/administrator of that group may drive the bot — there is no
separate allow-list.

**To use the DM instead (or as well):** **[manual]** send `/start` to
[@userinfobot](https://t.me/userinfobot) for your numeric user id, then add it
(host-side) to the same `.env`:

```dotenv
OWNER_USER_ID=987654321
```

With the default `CHAT_MODE=both`, an unset `OWNER_USER_ID` just leaves the DM
surface inert (group-only); set it and the DM lights up alongside the group. Use
`CHAT_MODE=dm` to skip the group entirely.

### 3. Launch from your projects folder

```bash
cd ~/projects && charness
```

That `$PWD` — the parent folder holding your repositories — is the folder the
bot works in; each topic binds to a subfolder under it. There's nothing else to
configure for it. A single-instance lockfile (`$DATA_DIR/instance.lock`) stops a
second bot starting under the same user; stale locks (after `kill -9`) are
reclaimed automatically.

### 4. Bind a topic and talk to an agent

This step is **[manual]** — it all happens inside the Telegram app.

**In the group:**

1. Open the group; in the General topic send `/ls` — the bot lists subfolders
   under the work root.
2. Create a topic (the `+` button).
3. In the new topic: `/bind <subdir>` (auto-bound if the topic name matches a
   subdir).
4. `/claude` or `/opencode` → talk to the agent (text or voice).

<p><img src="docs/images/04-bind-and-run.png" width="360" alt="A topic bound with /bind, /claude started, and the agent replying" /></p>

**In the DM:** the same commands, one thread per agent — `/ls`,
`/bind <subdir>`, then `/claude` or `/opencode`.

Then: `/quit` ends the session; bare `/bind` inspects/reconfigures the binding;
`/clear_messages` deletes the topic's bot messages.

> **Continue the same session from a terminal.** No wrapper needed: run
> `claude --dangerously-skip-permissions` in the project folder. It is the same
> binary and the same `~/.claude/projects/<cwd-slug>/` session store the bot
> uses, so a thread started in Telegram can be picked up with `claude --resume`
> and vice versa.

### Required files structure

Launch `charness` from the parent folder that holds your project repos —
that `$PWD` is the work root, and every topic binds to a subfolder under it:

```
$PWD=/home/user/src                     ← run the bot here ($PWD = work root)
├── projectA/         ← Topic "projectA"        (claude)
├── projectB/         ← Topic "projB-frontend"  (claude)
│                     ← Topic "projB-backend"   (opencode)   ← one folder, two topics
│                     ← Topic "projB-refactor"  (claude)
└── projectC/         ← Topic "projectC"         (opencode)

Telegram forum supergroup
├── Bot is admin with can_manage_topics + can_delete_messages + can_pin_messages
└── Routes each topic by (chatId, threadId) → remembered in state.json
```

**What the bot remembers (`state.json`).** So a restart is seamless, the bot
saves which topic is bound to which folder, each topic's live agent session (to
re-attach it after a reboot), your per-topic preferences (agent, model,
reasoning effort, language, display verbosity), scheduled prompts, and the
paired group id. This file lives in `DATA_DIR` (default `~/.charness`) and
is written safely, so a crash can't corrupt it.

### Telegram environment variables

The settings of the Telegram surface; the ones every surface shares are under
[Environment variables](#environment-variables).

#### Set Before Launch

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather. Telegram only: a Jira-only instance refuses to start with it set — see [Jira setup](#jira-setup) |

Start from the parent folder containing your projects: `cd ~/projects && charness`.
That `$PWD` is the folder the bot works in — nothing else to set for it.

**Access control.** There is no user allow-list. Whoever is a **creator or
administrator of the served forum group** may talk to the agent — read live from
Telegram (`getChatAdministrators`) and cached for 1h. Promote someone in the
group to grant access; demote/remove them to revoke it — the bot subscribes to
`chat_member` updates, so an admin change invalidates the cache and takes
effect immediately (the 1h TTL is only the fallback). The bot must be a group
admin itself (it already needs that to create topics and pin). Anonymous admins
can't be matched from their messages, so post non-anonymously. The DM surface
(when enabled) is gated separately: only the configured `OWNER_USER_ID` may
talk to the bot there.

> **Security model — group admin (or the DM owner) ⇒ shell on the host.** The agents run with
> permission checks disabled (`--dangerously-skip-permissions` for Claude,
> auto-approve for OpenCode) and `/terminal` opens a raw `$SHELL` in the bound
> folder, so anyone who can talk to the bot can execute arbitrary commands as
> the bot's OS user. Only promote people you would trust with SSH access to
> that machine, and keep the served group itself private.

#### External Optional (Telegram)

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_GROUP_ID` | (auto-pair) | Numeric forum supergroup id (`-100…`). Leave empty to auto-pair with the first forum group a group **admin/creator** contacts the bot from (id is saved to `state.json`; re-point with `/pair`). A **name** is not accepted. A numeric value disables auto-pairing |
| `CHAT_MODE` | `both` | Which surface(s) this instance serves: `group`, `dm`, or `both` — see [Two surfaces](README.md#two-surfaces-group-topics-bot-dm-or-both) |
| `OWNER_USER_ID` | — | **Optional.** Numeric Telegram user id of the owner — leave it unset to run group-only (the DM surface stays inert; a group works fully without it). Set it only to enable the owner-DM surface; **required** solely for `CHAT_MODE=dm` |
| `GROQ_API_KEY` | — | Recommended for voice transcription. Without it, voice messages are not transcribed unless you intentionally configure the OpenAI fallback |

**Localized in 12 languages** — the bot UI (commands, buttons, notices) speaks
中文, English, Français, ქართული, Deutsch, हिन्दी, 日本語, Português, Русский,
Español, Українська, Oʻzbekcha. The language is automatic per Telegram chat:
explicit `/language <locale>` override wins, then the sender's Telegram client
language, then the last supported Telegram locale seen for that chat, then
English.
Supported locales: `en`, `de`, `fr`, `es`, `pt`, `ru`, `zh`, `ja`, `hi`, `uz`,
`ka`, `uk`. Bare `/language` opens a single-message inline picker with each language
shown by its own name (endonym), sorted A→Z by English name, and a `🌐 Auto` button
(all 12 fit at once — no pagination). Tapping a language (or `🌐 Auto`) applies it, then the menu
disappears and a short confirmation stays in the chosen language;
`/language auto` returns a DM/group to automatic selection.

#### Advanced (Telegram)

| Variable | Default | Set only when |
|---|---|---|
| `OPENAI_API_KEY` | — | You intentionally use OpenAI Whisper as the voice fallback instead of Groq |
| `SHELL` | `/bin/bash` | You want `/terminal` to open a different shell than your login shell (host env var, not set by the bot) |

## Jira setup

A Jira instance runs on its own — a `DATA_DIR`, a work root, a private tmux server and one env file. How the
connector behaves is described in [`src/connectors/jira/README.md`](src/connectors/jira/README.md).

1. Create a Jira account for the AI (its API token is the instance's only secret) and note its account id.
2. Recommended: create or choose a Jira group of the people whose words may steer the AI (for example
   `ai-trusted`), and give the AI account the *Browse users and groups* global permission so that it can read
   the group. Then the agent reads only the text and files of its members and of Jira's apps and automations,
   and only their hand-overs start it.
3. An instance of its own: a `DATA_DIR`, a `WORK_ROOT` with one folder per project, a private tmux server, and
   an env file that is the ONLY configuration it reads:

   ```bash
   # /path/to/jira-instance.env
   CONNECTORS=jira
   DATA_DIR=/path/to/jira-instance/data
   WORK_ROOT=/path/to/jira-instance/work
   TMUX_SOCKET_NAME=jira-instance
   OPENCODE_URL=http://localhost:4097   # a port of its own — the default 4096 is refused (other instances use it)
   JIRA_AI_API_TOKEN=...                # referenced by jira.json below, never written there
   ```

4. `DATA_DIR/jira.json` — the allowlist, the trusted group and the credentials (`${VAR}` expands from the env file; an unknown
   key is an error):

   ```json
   {
     "site": "example.atlassian.net",
     "email": "ai-account@example.com",
     "apiToken": "${JIRA_AI_API_TOKEN}",
     "accountId": "<the AI account's id>",
     "projects": {
       "PROJ": { "folder": "proj", "triggerStatuses": ["In Progress"], "extraFields": ["customfield_10042"] }
     },
     "trustedGroup": "ai-trusted",
     "pollIntervalSeconds": 90,
     "runBudgetPer24h": 5,
     "model": "opus",
     "effort": "high"
   }
   ```

   `trustedGroup` (optional, but without it everyone who can edit or comment steers the agent) is the group's
   NAME — one group per instance; a team with several trust circles runs a second instance. The instance
   resolves it to the group's id at start, so renaming the group while it runs keeps working, and reads its
   members again whenever its last read is older than 5 minutes: a removed member loses the AI's trust within
   that time. List only projects where only your team can write, and where no automation acts on text or
   actions from outside it — an e-mail handler, a portal form, a copy from another project, a rule that
   hands an issue to the AI when someone outside the team acts: an app's or automation's text and hand-over
   are trusted, so such a rule brings that outside text, or that person's hand-over, to the agent. Nor list a
   project where anyone outside the team holds the *Edit all comments* permission: Jira Cloud keeps no history
   of a comment's edits, so a comment is judged by its author and its LAST editor only — an outsider's edit of a
   member's comment, followed by a member's own edit, reads as trusted.

   `projects` maps each served project key to its folder under `WORK_ROOT` and the status names in which an
   assigned issue is a request; the agent loads that folder's project memory (`CLAUDE.md`, `.claude/`, … in it
   and in every parent) like any Claude Code session, while your user-level Claude setup stays out of its
   sessions — except that for a folder under HOME that walk reads `~/.claude/CLAUDE.md` back in.
   `pollIntervalSeconds` is 10–600 (default 90);
   `runBudgetPer24h` defaults to 5; `model` and `effort` set the sessions' Claude model and reasoning effort
   (optional; absent → `opus` and `high`, either key overrides only its own default). `extraFields` (optional,
   none by default) names fields by id (`customfield_…`, or a system one like `duedate`) the agent should see next to the standard
   ones, shown under their site name; an id the site does not list is logged at start and left out. `agentBinaries` (optional, host runtime) maps a tool name to the absolute path of an executable — for
   example `{ "ffmpeg": "/opt/tools/ffmpeg" }` — which is checked at start and put on the agents' PATH. `adapter` is `claude-json-stream` (the default — the agent process is stopped when an issue
   idles) or `claude-per-turn` (stopped after every answer); either way the issue's conversation sleeps between
   requests and the next request resumes it.

5. Start it with a clean environment, so nothing of the calling shell reaches it:

   ```bash
   env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 ENV_FILE=/path/to/jira-instance.env charness
   ```

   (In a checkout, `scripts/run-isolated.sh /path/to/jira-instance.env` does the same.)

   The start refuses a missing `ENV_FILE`, `TMUX_SOCKET_NAME` or `jira.json`, an `OPENCODE_URL` on the default
   port, a `TELEGRAM_BOT_TOKEN` or any `ATLASSIAN_*` variable when Telegram is off, a token that belongs to
   another account, an unknown project or status, a `trustedGroup` the site does not have or the AI account
   may not read, and a `DATA_DIR` holding another surface's state. An unreachable Jira does not refuse the start —
   polling backs off and resumes.

The agent sessions of a Jira instance run without the user-level Claude settings, hooks and skills, with the
bot's MCP server only, without the native question tool, and with an environment reduced to a short allowlist
— the Jira token is not in the agent's environment. The agent still runs as the instance's OS user and can read
the instance's env file and `DATA_DIR`, so run the instance under an OS user that holds nothing else, with an AI
account that sees only the allowlisted projects. **A production Jira account runs only in the Docker container**
([Run with Docker](#run-with-docker)): there the agent can still read the instance's env file and `DATA_DIR`,
but nothing of the host outside the container's mounts. Module details: `src/connectors/jira/README.md`.

## Alternatives

The npm install above is the way to run Charness; this is the alternative to it.

### Run with Docker

Choose this over the npm install for **isolation** — the agents reach only the folders you mount — or for **a ready
environment**: the image brings Node 22, tmux, git and ffmpeg, and the bot installs Claude Code and OpenCode the first
time it starts each, so the host needs only Docker and a clone of this repository.

The whole bot runs in one container: the bot itself, tmux, every agent it starts (Claude Code in any backend,
`/terminal`, OpenCode and its server) and the bot's MCP server. Everything works as on a host; the host only
lends the container the folders it mounts, so the bot and its agents see nothing else of the machine.

```
host                                        container charness-<instance>
your instance env file (tokens)   ── ro ──▶  the bot (hot mode) + a restart loop
DATA_DIR, WORK_ROOT               ──────▶    tmux, the agents, OpenCode, the bot MCP
a clone of this repository        ──────▶    /opt/charness
the agents' home folder           ──────▶    /home/charness: their Claude / OpenCode
                                              login, sessions and CLI installs
```

1. **Image and checkout.** Clone the repository for the container (a full clone of its own, not a worktree and
   not the checkout a host instance runs from) and build the image from it:

   ```bash
   git clone https://github.com/olosegres/charness /srv/charness/checkout
   cd /srv/charness/checkout && docker build -t charness -f docker/Dockerfile .
   ```

   The image holds only system tools (tmux, git, ffmpeg, ripgrep, …) and the yarn the checkout's `package.json`
   names (build from the checkout's root, which is how the build reads it; rebuild after a yarn bump so no
   container has to download it). On first start the container installs the checkout's dependencies for the
   image and builds it; the bot installs Claude Code and OpenCode into the agents' home.
2. **Instance env file**, as for a host install (`TELEGRAM_BOT_TOKEN`, `DATA_DIR`, `WORK_ROOT`, …). It stays on
   the host and is mounted read-only. Every host path it names (`DATA_DIR`, `WORK_ROOT`, `TMUX_TMPDIR`, …) is
   mounted at the SAME path, so `state.json`, sessions and file paths stay valid inside and an instance can move
   between host and container unchanged.
3. **Run** (or use `examples/docker-compose.yml`):

   ```bash
   docker run -d --name charness-main --hostname charness-main \
     --restart unless-stopped --stop-timeout 60 \
     -v /srv/charness/checkout:/opt/charness \
     -v /srv/charness/home:/home/charness \
     -v /srv/charness/data:/srv/charness/data \
     -v /srv/projects:/srv/projects \
     -v /srv/charness/instance.env:/srv/charness/instance.env:ro \
     -e ENV_FILE=/srv/charness/instance.env \
     charness
   ```

   No port is published: Telegram is long polling, and the bot's MCP server and the OpenCode server listen on the
   container's own loopback. Keep the `--hostname` fixed and unique per instance: the instance lock tells its own
   restarted container from another machine by it.
4. **Log the agents in once**, with the account the agents should use (a separate one is best):
   `docker exec -it charness-main claude`, then `/login` (or `/login` in a topic). OpenCode: `/connect` in a
   topic, or `docker exec -it charness-main opencode auth login`. Never copy your own `~/.claude` login in:
   a second holder of its refresh token can log the first one out. For git, put a `.gitconfig` and an SSH key of
   their own into the agents' home.

Running it:

- **Restart the bot only** (agents keep running and are adopted): `docker exec charness-main
  charness-restart-bot`. A crashed bot is restarted by the container after 20 s.
- **Update the bot**: `docker exec charness-main /opt/charness/scripts/self-update.sh` (by hand or from
  a timer on the host); hot mode picks the change up. A change to `src/cli.ts`, `src/cli/hot.ts` or `nodemon.json`
  needs the bot restart above. **Update Claude Code / OpenCode**: they update themselves in the agents' home, or
  `docker exec charness-main npm install -g @anthropic-ai/claude-code` / `… opencode-ai`.
- **A container restart is a reboot**: every agent process ends; each conversation resumes with its next message.
- **Rootless Docker** (recommended): the container's root is your user, so everything written on the mounts is
  yours. **Rootful Docker**: add `--user "$(id -u):$(id -g)"` and give that user the agents' home.
- **Moving a host instance in**: stop it first (the lock refuses a lock written on another host), mount its
  folders at their paths, and copy its conversations' folders from `~/.claude/projects/` into the agents' home
  `.claude/projects/` — without them each conversation starts a fresh session on its next message.
- **What the agents can read**: everything mounted, the instance env file with its tokens, `DATA_DIR` and the
  checkout included. The container keeps the rest of the host out of reach; running the agents as a second user
  inside the container would close that gap later.
