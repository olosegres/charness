# Commands

Every command of the Telegram bot, one section each — what it does, its text forms and its aliases. The features behind a
command (accounts, usage limits, scheduling, todo lists, …) are described inside the section of the command that drives
them. How the agents run (the Claude Code backends, OpenCode, restarts, the bot's own tools for the agent) is in
[backends.md](backends.md); installing and configuring is in [SETUP.md](../SETUP.md); the overview is the [README](../README.md).

- **Commands available in any topic**
  - [`/claude`, `/opencode`, `/oc`](#claude-opencode-oc)
  - [`/terminal`](#terminal)
  - [`/claude_mode`](#claude_mode)
  - [`/login`](#login)
  - [`/model`](#model)
  - [`/accounts`](#accounts)
  - [`/effort`](#effort)
  - [`/verbosity`](#verbosity)
  - [`/thinking`](#thinking)
  - [`/tool_results`](#tool_results)
  - [`/subagent`](#subagent)
  - [`/sessions`](#sessions)
  - [`/rename_session`](#rename_session)
  - [`/quit`, `/q`](#quit-q)
  - [`/new`](#new)
  - [`/status`](#status)
  - [`/output`](#output)
  - [`/c`, `/y`, `/n`](#c-y-n)
  - [`/enter`, `/up`, `/down`, `/tab`](#enter-up-down-tab)
  - [`/interrupt`, `/esc`, `/escape`](#interrupt-esc-escape)
  - [`/schedule`](#schedule)
  - [`/stt`](#stt)
  - [`/todo`](#todo)
  - [`/reminders`](#reminders)
  - [`/clear_messages`](#clear_messages)
  - [`/clear`](#clear)
  - [`/compact`](#compact)
  - [`/compact_on_idle`](#compact_on_idle)
  - [`/compact_summary`](#compact_summary)
  - [`/bot_skills`](#bot_skills)
  - [`/task_agents`](#task_agents)
  - [`/limits`](#limits)
  - [`/limits_autoswitch`](#limits_autoswitch)
  - [`/bind`](#bind)
  - [`/topic`](#topic)
  - [`/mcp`](#mcp)
- **Info and ops (work anywhere)**
  - [`/start`](#start)
  - [`/help`](#help)
  - [`/ls`](#ls)
  - [`/list`](#list)
  - [`/doctor`](#doctor)
  - [`/version`](#version)
  - [`/update`](#update)
  - [`/whoami`](#whoami)
  - [`/trace`](#trace)
  - [`/timestamps`](#timestamps)
  - [`/language`, `/lang`](#language-lang)
  - [`/timezone`](#timezone)
  - [`/pair`](#pair)
- **General-only**
  - [`/quitall`](#quitall)
  - [`/runners`](#runners)
- **Plain messages, voice and files**
  - [Natural language and voice](#natural-language-and-voice)
  - [File intake](#file-intake)
  - [Reply context](#reply-context)

## Commands available in any topic

Most commands work in any topic; a binding (`/bind`) is required only to
actually start an agent or terminal in the folder.

### `/claude`, `/opencode`, `/oc`

Start agent in this topic's bound folder.

### `/terminal`

Open a raw `$SHELL` in the bound folder.

#### Raw terminal

`/terminal` binds the topic to a real interactive `$SHELL` (in tmux) in the
bound folder — a third backend alongside the agents, mutually exclusive
with them. Every plain message is typed in as a command; output streams
back as one rolling message per command. Raw keys reuse the TUI commands:
`/c` (Ctrl-C), `/up` `/down` (history), `/tab` (completion), `/enter`.
Restart-safe like the agents: the shell survives a bot restart and is
re-adopted. Known v1 limitation: full-screen TUIs (vim, htop, less) render
messy; normal commands, builds, and logs stream cleanly. The shell comes
from the `SHELL` env (fallback `/bin/bash`).

### `/claude_mode`

Switch this topic's Claude backend (json-stream ⇄ per-turn ⇄ tmux, deprecated); bare shows a picker. The backends themselves are described in [Claude Code backends](backends.md#claude-code-backends-claude_mode).

### `/login`

Signs a Claude account in. It works on all three Claude Code backends; the json-stream backends run the sign-in out-of-band, posting the link into the topic and taking the pasted code back — see [Claude Code backends](backends.md#claude-code-backends-claude_mode). More accounts are added from [`/accounts`](#accounts).

### `/model`

Switch model through a two-level picker: providers, then that provider's models (10 per page). On OpenCode the first row is 🕘 Recently used — a flat list of the models picked before, across providers (bot-wide, most recent first, up to 10), one tap to switch; it appears once something has been picked. Each provider row has a 🙈 to hide it from the picker (bot-wide, persisted; 👁 brings it back) — `/model <provider/model>` still reaches a hidden provider. If OpenCode is waiting on an old provider's retry, the next prompt interrupts that wait and starts with the selected model instead of sitting queued behind it.

### `/accounts`

Every account the bot works with, on one screen. **Claude accounts** (when you keep several subscriptions signed in): each profile with its email, plan (personal Pro/Max or corporate Team/Enterprise), how many topics use it and its usage windows, ✓ on the active one; tap a profile to switch this topic (a running session is restarted under it, same conversation — at the end of its turn if it is working; on a topic that runs OpenCode the tap switches the topic to Claude on that account, after a confirmation when there is a conversation to hand over); in **General** the pick becomes the default for all topics. The title says where the topic really runs (`Claude «work»`, `OpenCode openai/gpt-5`) and the ✓ sits on that row — on no account while OpenCode runs. Per profile: 🔑 signs it in again, 🗑 removes it (after a confirmation; for `default`, which IS `~/.claude`, «remove» signs it out — see below). The usage lines give each window's percentage USED and when it resets as a time from now (`5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h`; «🔄 in 2h», «🔄 in 2d 1h», «🔄 in 30m»; Fable only on a plan that has its own weekly window); when the 5h window's reset is unknown the weekly one is shown in its place, and with no reset at all only the percentage. The hint paragraph under the account list says the percentages are used. «➕ Claude account» asks for a name and runs the sign-in; «➕ Claude API account (Console credits)» adds an account billed to a Claude Console organization's API credits (`💳`, see [An account billed to API credits](#an-account-billed-to-api-credits-claude-console)). **OpenCode providers**: the connected ones are listed with how each is signed in (`ChatGPT subscription` with its ~5 h / ~7 d usage windows like an account's, `API key`). In a topic a provider row is `[provider] [🔑] [🔌]`: a tap switches the topic to the provider through its model page (✓ on the model it runs, ⛔ on a limited one; a provider with one model is picked at once), 🔑 connects it again, 🔌 disconnects it (it asks, then removes the stored credentials; a provider OpenCode enables from an environment variable, e.g. `OPENROUTER_API_KEY`, stays active — the reply says so and points at hiding it in `/model`); in **General** a provider row is «🔌 Disconnect &lt;provider&gt;» and 🔑 only; «➕ OpenCode provider» asks for the provider id and continues with the connect flow (OAuth methods when available, otherwise an API key whose message is deleted from Telegram). What happens when an account hits a usage limit is set in `/limits_autoswitch`. Text forms: `/accounts add <name>`, `/accounts add <name> api`, `/accounts use <name>`, `/accounts use <provider>/<model>` (an OpenCode model, in a topic), `/accounts login <name>`, `/accounts remove <name>`, `/accounts autoswitch on|off`. `/account`, `/connect [provider [key]]` and `/disconnect [provider]` still work as hidden aliases (the menu lists only `/accounts`).

#### Several accounts

If you hold more than one Claude subscription (a personal Pro/Max and a
corporate Team/Enterprise seat, say), the bot keeps each signed in as its own
**profile** and lets you choose, per topic, which one a Claude session runs on —
so one account's usage limit does not stop every topic.

- The profile `default` is your existing `~/.claude` login; nothing is migrated.
  An added profile is a Claude config directory of its own under
  `DATA_DIR/claude-profiles/<name>/` (the CLI gets it through
  `CLAUDE_CONFIG_DIR`): it holds that account's login, while the transcripts,
  settings, skills, plugins and your user memory are symlinks back into
  `~/.claude` — every account sees the same hooks and skills, and a conversation
  started under one account resumes under another.
- **Adding an account:** `/accounts` → «➕ Claude account» (or `/accounts add work`) — give it
  a short name, then open the sign-in link the bot posts **in a browser that is
  signed in as that other account** (an incognito window or another browser
  profile keeps your current login out of the way), finish the sign-in and paste
  the code back into the topic. The code message is deleted; the bot confirms
  with the account's email and plan.
- **Switching:** tap a profile in `/accounts` or an account on the `/limits`
  board (or `/accounts use <name>`). A
  running session on the default (stream) backend is restarted under the new
  account with the same conversation — right away when idle, at the end of its
  turn when it is working; a sleeping topic simply resumes under it. The
  tmux-scrape backend is reopened the same way when idle and waits for the next
  start when busy. In the **General** topic the pick is the default for all
  topics; a topic with its own pick keeps it («↩ Follow the default» drops it).
  A profile that is not signed in cannot be picked. On a topic that runs OpenCode the
  pick is a switch to Claude on that account (see [*A manual switch between Claude and
  OpenCode asks first*](#limits_autoswitch) under the fallback models). While a usage-limit wait is armed a
  pick is the limit move: the wait ends and the work continues on the account you tapped.
- **Removing:** «🗑 Remove» deletes the profile's login directory. The profile
  that is currently the instance default cannot be removed (pick another one in
  General first); topics that had picked the removed profile return to the
  default and the confirmation says how many. For `default` (`~/.claude`
  itself) «remove» means **sign out**: after a confirmation that says running
  sessions on it will stop working, only the stored subscription login
  (`claudeAiOauth` in `~/.claude/.credentials.json`; MCP tokens beside it stay)
  is deleted — `projects/`, settings, skills, plugins and memory are never
  touched — and the account is hidden from the list, the recommendation and the
  fallback ranking until it is signed in again (`/accounts login default`).
- A child `claude` the agent starts inherits the same `CLAUDE_CONFIG_DIR`, so
  it runs on the topic's account too.
- **Usage per account.** Under each profile `/accounts` shows how much of each
  subscription window is used and when it resets:
  the 5-hour session window, the weekly window (all models) and Fable's own
  weekly window (left out entirely on a plan without one). A line reads
  `5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h` — the
  percentage is USED. A reset is shown as a time from
  now (`🔄 in 2d 1h`; the two largest units, minutes only under an hour); an
  unknown 5h reset shows the weekly one, and with no reset at all only the
  percentage is shown. `charness claude-profiles` prints
  the same relative form; its `--json` and the MCP tool keep ISO instants. The bot reads the figures with
  each profile's own login every 10 minutes, when `/accounts` or `/limits` opens and when an
  agent asks (the ChatGPT subscription of an OpenCode provider is read the same way, see [`/limits`](#limits)); a json-stream session's own rate-limit events keep them current
  between polls. A token the CLI has not renewed yet shows the last figures as
  `(stale)`; a profile whose session was refused on a window is marked
  `⛔ at its limit until …` and is skipped by the recommendation below.
- **Another account takes over on a limit.** When a topic's account hits a
  usage limit the bot looks at the [fallback chain](#limits_autoswitch);
  without one it moves the topic to the signed-in profile whose weekly limit resets
  soonest (fresh figures, not marked limited, below 100 % on the windows the topic's model
  drains and with the five-hour window under 90 % — the order a new agent's account is picked in, see below). The limit
  notice carries «🔁 Switch to &lt;entry&gt;» buttons, best first: a tap moves the
  topic there (the running session is restarted under the new account with the
  same conversation), drops the wait for the reset and tells the agent to
  continue right away. With **switching** on («🔁 Auto switch to a
  fallback model» in `/limits_autoswitch`, or `/limits_autoswitch switch on`; in General the default for all
  topics) the bot does the same by itself and posts one short line — «Account
  «a» hit its usage limit — this topic continues on «b». The limit resets
  &lt;time&gt;. Switch: /limits». The target is named by its account alone
  and gets its model only when the switch changes it («b» (sonnet)); an
  OpenCode rung is written without quotes on either side — the target as
  «OpenCode provider/model», the side that hit its limit as «Model
  provider/model». It is ON by default, also with a single signed-in
  account: with no other account and no list there is nothing to move to and the bot waits for the reset, but a list with another
  account or an OpenCode entry is used from the first limit on — an OpenCode entry hands the conversation over in compacted form,
  across backends. Turn it off in `/limits_autoswitch` (in General, or for one topic) and the notice offers the buttons instead. The exhausted profile is marked
  limited until its window resets, so it is not picked again before then. The
  reset itself does not move the topic back: `/limits`, which the notice names,
  lists every account and provider with its usage and one tap moves the topic
  (see [`/limits`](#limits)). Only a wait that ends on another entry
  moves a topic by itself (see [`/limits_autoswitch`](#limits_autoswitch)). When nothing can take over the bot waits
  for the reset as before. A Claude session that works when a limit hits is
  moved at once (the turn is dead; background tasks it started are stopped and
  the notice says so); only a tmux Claude session with nothing to resume yet is
  left to the end of its turn.
- **Which account for a child process.** An agent that launches a detached
  `claude` (a worker, a reviewer) asks the bot's `telegramBot` MCP tool
  `claude_profiles` — optionally with the model it will run — and gets every
  profile with its windows plus `recommended`. A **new** agent goes to the usable
  profile whose weekly limit resets soonest, so what would burn soonest is spent
  first; usable means signed in, not marked limited, below 100 % on the windows the
  model drains (the session window and the shared weekly window bound every model;
  Fable additionally drains its own weekly window, and Fable's window at 100 % takes
  out Fable only) and the five-hour window under 90 % — a profile above that waits,
  the next reset is taken. Resets less than a minute apart count as one moment and
  the lower five-hour percent decides; an unknown reset ranks after every known
  one. An account billed to API credits is never picked for a new agent, nor is one
  whose entries in `/limits_autoswitch` are all left out. A **resumed** worker
  passes `currentProfile` (the profile it last ran on) and stays on it unless the
  account is signed out, marked limited, out of credits or at 100 % on a window
  the model drains; the 90 % ceiling does not apply to it. One that broke off on a
  usage limit passes `isStoppedByLimit` too: the bot re-reads that account's usage
  and leaves it out whatever the figures say, and the worker resumes the same
  session at once on the answer. With nothing usable `recommended` is `null` and
  `nextAvailable` names the account and the instant that frees up first, for a
  one-off resume (an account a limit just stopped, whose figures show no blocker
  yet, frees up at its five-hour reset); when no account names a time, the manager
  asks you and retries in about 30 minutes. The first line of the answer states why:
  it stays on the warm account, moved (the account stopped on a limit or can no
  longer run), soonest weekly reset, or none usable. The agent then
  starts the child with `CLAUDE_CONFIG_DIR=<configDir>` (`null` = the default
  profile: set nothing). The same answer from a shell, for a worker without
  MCP: `charness claude-profiles [--best] [--model <name>] [--current <name>
  [--stopped-by-limit]] [--json]` —
  `--best` prints just the directory (an empty line for the default; exit 1 and
  `next: …` on stderr when nothing is usable), so
  `CLAUDE_CONFIG_DIR="$(charness claude-profiles --best --model fable)"`
  works as is; it reads the bot's cache off `DATA_DIR/state.json` and cannot
  re-read an account's usage, so `--stopped-by-limit` only leaves the account out.

#### An account billed to API credits (Claude Console)

Besides subscriptions, an account can bill the **API credits of a Claude Console
organization** — useful as a fallback when every subscription is at its limit.
Such an account pays per request (no 5-hour or weekly windows: its limit is the
balance), so the bot never uses it without you choosing it.

- **Adding one:** `/accounts` → «➕ Claude API account (Console credits)» (or
  `/accounts add console api`) — give it a name. The bot runs
  `claude auth login --console` for it: open the link, sign in to the Console
  organization whose credits it should spend and paste the code back. Claude
  Code then creates an API key in that organization's workspace and keeps it in
  the account's own directory (`DATA_DIR/claude-profiles/<name>/`), where only
  that account's sessions read it. Your Console role must allow creating a key
  («Claude Code» or «Developer»).
- **Or paste a key:** while that sign-in waits, paste an existing API key
  (`sk-ant-api…`, on its own or as an `ANTHROPIC_API_KEY=…` line) instead of the
  code. The message is deleted at once (so is a key pasted where the name is
  asked, or typed on the `/accounts` command line), the key
  is checked with the API (a refused key is not stored), then kept in the
  account's directory (`0600`) and handed to its sessions only, through an
  `apiKeyHelper` in that account's launch settings — never in `state.json`, never
  in an environment variable an agent or a child process could read, never in
  the trace (any `sk-ant-…` text is redacted from it). `/accounts login <name>`
  of an API account runs the same flow again; a later Console sign-in replaces
  a pasted key.
- The Console's keyless sign-in («Sign in with your Console account» in
  Claude Code's own `/login`) is **not** used: it is stored outside the account's
  directory, for the whole machine, and signs the subscriptions out.
- Every other account stays a subscription exactly as before: the bot still
  removes any `ANTHROPIC_API_KEY` from the environment of every session and of
  every sign-in.
- **Recognising one:** `/accounts` shows it as `console — you@example.com, 💳 API
  · pay per use` (`💳 API key · pay per use` for a pasted key), `/status` marks
  the account `· 💳 API`, and picking it — in a topic, or as the default in
  General — says that every request is billed. The bot reads the billing from
  `claude auth status` each time it checks the account, so a mistaken
  subscription login shows as a subscription.
- **Never used by itself.** It has no windows, so to every headroom rule it
  would look inexhaustible: the `claude_profiles` recommendation (and
  `charness claude-profiles --best`) never picks it for a new agent (a worker
  already running on it stays), the within-Claude switch
  never offers it, and «🔄 Fill from connected» in `/limits_autoswitch` puts it
  LAST in the fallback list and left out of automatic switching (🚫). To use it,
  tap it on the `/limits` board (`Claude · console 💳`) — or include its entry
  («✅ Use») so a limit notice offers it, or switches to it by itself with
  switching on. A rebuilt list keeps it included once you did.
- **When the credits run out** («Credit balance is too low») the bot does not
  wait for a reset — there is none — and never retries hourly. The topic gets
  one `💸` notice, the account is marked as out of credits (`💸` in
  `/limits_autoswitch`, `/accounts`, `/limits` and `/status`) and the fallback
  list decides as for a limit: switching on moves the topic at once, otherwise
  the notice carries «🔁 Switch to …» buttons. If nothing can take over now but
  another entry comes back at a known time (a subscription's weekly reset), the
  topic waits for that and continues there; otherwise the notice is all. The
  mark lasts until you act: pick the account again (after topping the balance
  up), or sign it in again — or until a request on it goes through again. A
  rate limit of the API (429) is still a short retry.
- **What it spent.** On the default (stream) backend every turn reports the
  conversation's running cost; the bot counts the part each turn on the API
  account added (a subscription turn of the same conversation is never
  counted) and shows the total under the account in `/accounts` and `/limits`
  (`💳 $12.34 spent since 23.10 · last turn $0.21`), on `/status`, in the line a
  limit switch onto the account adds («billed per request … $X spent through
  the bot so far») and in its «credits used up» notice. It is what the bot
  saw, not the organization's balance — that one is on the Console's Billing
  page. The tmux backend reports no cost.

### `/effort`

Reasoning effort. **In a topic:** shows the level its session runs and where the next start's level comes from («medium — as in General» / «high — set for this topic»; a running session keeps the level it started with when General moves on: «xhigh (medium from the next start) — as in General») with a button per level — Claude: the native `/effort` levels (`low…ultracode`); OpenCode: the current model's variants, applied per-prompt; General's `ultracode` is the model's highest variant and `auto` sends no variant — and «As in General (medium)», named with the level the topic will really get (OpenCode: rounded to the model's variants), which drops the topic's own pick (a live session is brought to the default at once). **In General:** the default effort for every topic that has no effort of its own (✓ on the current one; `medium` until you pick), saved to `settings.json` and applied from each topic's next session start or wake-up — running sessions are not restarted. No env configuration — see [Instance settings](../SETUP.md#instance-settings-settingsjson).

### `/verbosity`

Output-verbosity macro (`minimal|short|full`): sets the thinking, tool-results and sub-agent display prefs at once; `/thinking`, `/tool_results`, `/subagent` point-override afterwards. Mixed prefs show as "custom" in the picker. The picker's second row (or `/verbosity stream|stream_answers|answers`) sets what the topic SHOWS — "Stream only" (default), "Stream + answers" (the stream plus the agent's pinned answers) or "Answers only" (the pinned answers, no stream; an agent that keeps writing after its final answer is reminded once to send what matters); the answers are written like for a manager or QA — brief and to the point; a switch applies from the next message, and `/status` names the view.

### `/thinking`

Chain-of-thought display: `full` keeps the reasoning, `short` collapses to "💭 thought for Ns", `minimal` keeps only the live working cue.

### `/tool_results`

Completed tool-call output: `full` whole body, `short` capped (15 lines / 1200 chars), `minimal` transient 🔧 status only.

### `/subagent`

Sub-agent transcript: status-only with a ticking elapsed counter (`minimal`/`short`), or streamed "🤖 ⤷" chunks (`full`).

### `/sessions`

List & resume previous sessions in this folder.

### `/rename_session`

Rename the current live session (OpenCode; Claude transcripts have no title).

### `/quit`, `/q`

End the session — Claude: graceful double Ctrl+C; OpenCode/terminal: `stopSession`. Releases the persisted session id, so a bot restart won't auto-reattach it (resume later via `/sessions`). A topic whose agent process is gone but whose session is kept (it "sleeps": the next message, file, voice note, `/compact`, `/model` or `/effort` resumes it by itself) is released the same way.

### `/new`

End the current session and start a fresh one (same adapter).

### `/status`

This thread's status: agent, bound folder, the Claude account it runs on and the resolved workdir; a live session also shows the model it is actually running, the effort it runs (when the default moved on under it: «xhigh (medium from the next start)»), start time, runtime version and context use (anything the backend cannot report renders as unknown). On a Claude topic the account is its profile (name · email as in `/accounts`, `· 💳 API` for an account billed to API credits — with a line of what it spent through the bot — marked ⛔ while it is at its limit, with a second row for a switch still pending); an OpenCode topic's model already names its provider. In General: a global view of all topics and the active agents.

### `/output`

Last 500 lines of agent output (sent as at most 5 chunks; the overflow is reported as omitted).

### `/c`, `/y`, `/n`

Ctrl+C / "y" / "n"

### `/enter`, `/up`, `/down`, `/tab`

tmux key passthrough.

### `/interrupt`, `/esc`, `/escape`

Interrupt the running turn — Claude gets a raw Escape (which also dismisses a selector), OpenCode aborts the generation; the conversation stays and your next message steers the agent. A question the agent is waiting on is closed first (rejected on OpenCode, declined on the Claude stream-json backends) and its message stays in the topic with a «not answered» note in place of the buttons (the same note a message you send instead of answering, `/quit`, `/new` or a stopped session leaves; a question is never deleted). A pending sign-in, account-name prompt or `/topic` wizard is cancelled first instead (the agent is not interrupted). Not supported in a `/terminal` topic.

### `/schedule`

Schedule a prompt in free text — the agent parses the time and owns the job.

#### Scheduler

A topic can have scheduled prompts: at fire time the bot posts the prompt
into the topic, pins the announcement (pins accumulate as run history),
waits for a busy agent to go idle (up to 10 min, rather than interrupting
live work) and delivers it — reusing the active session or starting one
with the thread's last-used backend.

- `/schedule <free text>` is a thin wrapper — the bot owns no date parsing.
  The agent interviews you (bare `/schedule`) or parses "every day at 9" /
  "tomorrow 15:00" itself, then calls the bot-injected `schedule_create` /
  `schedule_list` / `schedule_cancel` MCP tools (cron, one-shot, or
  N-times; min interval 5 min; up to 30 agent jobs per topic — reminders are
  counted separately, see [`/reminders`](#reminders)).
- Restart-safe: timers re-arm at boot; a run missed during downtime fires
  one catch-up annotated with the missed time.
- Leaving a folder pauses the topic's scheduled prompts; `/bind` resumes
  them (an expired one-shot is dropped). Reminders keep running — see
  [`/reminders`](#reminders). Run history: `DATA_DIR/scheduler-runs.jsonl`.
- **Checks (watchdogs).** `schedule_create` also takes a `checkCommand` (with a cron schedule): the bot runs the command in the topic's bound folder on schedule and stays silent while it exits 0; on the first failure after a pass it pins an alert and wakes the agent with the job's prompt, the exit code and the tail of the output. Checks survive bot restarts.

### `/stt`

Voice recognition, from any topic (General included); instance-wide, applied to the next voice note — no restart. The main screen holds only what applies to recognition as a whole: the ordered list of **engines** (the first that works answers; when one fails the next takes over) — one full-width button each (`1. GigaAM (local) · running · 10s+25% · ✓` — name, the local engine's short state, timeout `base s + % of the voice`, ✓ usable / ✗ disabled or skipped) — then «➕ Add engine», «🌐 Language» (auto or `ru en uk de fr es`) and «✖️ Close». A tap on an engine opens its **card**: ⬆️ Up / ⬇️ Down, ✅ Use / 🚫 Don't use, ⏱ Timeout (presets), then what the kind adds — 🔑 key for **Groq**, **OpenAI** or a **custom** OpenAI-compatible server (its address, a base like `http://host:8000` is completed; then «does it need a key?»), and 🗑 Remove. A pasted key is deleted from the topic the moment it is accepted, never shown again and kept out of the logs; an address with a login in it is refused. **GigaAM (local)** (Russian only, runs on this machine) is added through «➕ Add engine» like the others: installed, it joins the list at once; not installed, a confirmation (≈ 400 MB on disk; ≈ 0.5 GB RAM while it runs, up to ≈ 0.9 GB on a long voice, nothing while stopped) leads to the install with a live progress message, and the message becomes its card. Its card holds everything local: the status line (ready · running / stopped / paused after failed starts / installing / not installed), «⏱ Exit after idle» (5 / 15 / 30 / 60 min or never), «⚙️ Workers» (1 / 2 / 4 / 8), «🔄 Try again now» (while paused), «Remove from list» (the files stay) and «🗑 Remove model files». Everything lives in one file, `stt.json` — see [Voice input](../SETUP.md#voice-input). `/voice` and `/speech` are hidden aliases.

### `/todo`

The agent's published todo list for this topic: in work, the queue in order, done today, and the project it shares a board with («Project ▸»: automatic, join another topic's project, own project). In General: every project's board and the settings. Read-only — tell the agent to change a list.

#### Shared todo lists

Each conversation — a Telegram topic or a Jira issue — keeps a short published todo list: what its agent is
working on now, what is queued and in what order, and what it finished. Stand-up level: a few task-sized items,
never the agent's micro-steps. The agent keeps it itself through the bot's `todo_update` tool (its instructions ask
it to add an item **before** it starts any task, its own fixes included, and to close it as soon as it is done);
nothing is ever removed silently — an item is closed as done or dropped.

`/todo` in a topic shows its list:

```
📋 Todo — flows-speedup

▶ In work
   Speed up limits flow tests (src/__tests__/limits*) — since 13:05

▷ Queue
   1. Shorten the Jira poll window
   2. Bump tsx

✓ Done today
   Fix .env leak in envLoader — 12:40
```

The view is read-only: to change the list, tell the agent. The list belongs to the topic, not to the session —
`/new`, `/quit`, switching backends and restarting the bot keep it. When the agent sends its final answer while its
list still shows work in progress it did not touch, the bot reminds it (in the tool result) to record what changed.
The lists live in `DATA_DIR/todos/`; items closed more than 30 days ago move to `DATA_DIR/todos/archive/`.

**Projects: the agents of one repository see each other's lists.** Topics whose folders are checkouts or worktrees
of the same git repository (found by its first commit, so a clone with another remote counts too) form one project;
two topics on one folder are always together, and a folder that is no git checkout is a project of its own. Every
prompt the bot hands an agent then carries the **project board** — on a fresh context (a new session, a wake-up after
the session slept, a compaction, `/clear`) the whole board and the agent's own list, later only the topics whose list
changed since the agent last saw them, and nothing when none did:

```
[Project board · charness · 2 other topics]
#flows-speedup (charness) — active 2 min ago
  ▶ Speed up limits flow tests (src/__tests__/limits*) — since 13:05
  ▷ queue: 1. Shorten the Jira poll window · 2. Bump tsx (+3 more)
  ✓ 2026-10-24: Fix .env leak in envLoader (12:40)
#docs (notes) — asleep since 11:02, list 3 h old
  ▶ README "how it works" section
```

The agent's own `todo_update` answers the same way, so every update is an overlap check. A change in another topic
never wakes an agent by itself: an idle or sleeping agent learns of it at its next prompt or update, and a **working**
one in the middle of its turn — Claude with the result of its next tool call (a hook the bot adds to every Claude
session it starts), OpenCode as a short message it reads between steps. The board is capped (five items of
each kind per topic, about 3000 characters, the most recently active topics first); the agent can read the whole of
it with `todo_read`. **`/todo` → Project ▸** in a topic overrides the grouping: join another topic's project, keep
an own project, or go back to automatic. A Jira conversation is on the board too, named by its issue key and summary
(the summary only when the trusted group would show it); `jira.json` projects list their repositories in `repos` to
share a board with the topics on them ([Jira setup](../SETUP.md#jira-setup)).

**`/todo` in General** lists every project with its topics: what each has in work, whether it sleeps, how long its
queue is.

**A list that went stale is pointed out to the agent.** Once an agent has worked for an hour (counted from the end of
the first turn after its last update; a topic that was quiet for days is not reminded on its first turn) without
updating its list, the next prompt it gets — from you, a scheduled run, a "continue" — carries one line asking it to
update it. An agent that keeps working with no prompt reaching it (its own background tasks) gets the reminder as a
short prompt of its own, at the end of a turn — never into a running turn, never by waking a sleeping session (a
topic on the per-turn Claude backend sleeps after every turn, so it gets the line with its next prompt only), and
never while a request waits for its answer, a usage limit holds the topic or the topic runs on an account billed to
API credits. After two reminders in a row without an update the bot stays silent until the agent updates or someone
writes in the topic. The reminder itself is never posted to the topic; a standalone one shows the typing indicator
while the agent reads it, and what the agent writes in that turn (usually nothing) is relayed as usual.

**`/todo` in General → Settings** turns the shared lists off for the whole instance (agents are then not offered the
tool) and sets the reminder's interval (off, 30 min, 1 h, 2 h, 4 h). An instance without a General topic sets the
same in `settings.json` ([Instance settings](../SETUP.md#instance-settings-settingsjson)).

### `/reminders`

Reminders set with buttons only — the bot posts and pins them itself, with no agent involved; works in any topic, bound or not.

#### Reminders

A reminder is the bot's own notification, not a job for an agent: at the due
time the bot posts your text into the topic and pins it — and the pin is what
notifies you through a muted topic. Nothing is started and nothing is
interrupted, so reminders work in **any** topic, with or without a bound
folder and with or without a running agent.

`/reminders` opens a hub with «➕ Add», «📋 List (N)» and «✕ Close». Add walks
four steps, all in the same message:

1. **How often** — once, every day, weekdays, weekly, monthly.
2. **Which day** — a date (today / tomorrow / a date grid), a weekday, or a
   day of the month. Skipped for "every day" and "weekdays".
3. **What time** — four quick presets, or «🕐 Other time» → the hour, then
   the minutes in 5-minute steps.
4. **The text** — type it or send a voice note, up to 1000 characters.

Steps 1–3 are buttons only: the reminder text is the one thing you type.
`‹ Back` changes a pick, `✕ Cancel` drops the wizard, and any command cancels
it. Picking a time that has already passed says so instead of quietly moving
the reminder to tomorrow, and a text over the limit is refused with nothing
saved — send a shorter one and the reminder is created from that.

The finished reminder shows when it fires, its text and its next run. «📋
List» pages through the topic's reminders (8 per page); tapping one opens it
with a «🗑 Delete» button — the card shows exactly what you are deleting, so
there is no extra confirmation step. A topic holds up to 100 reminders — counted
separately from the agent's scheduled prompts, so neither takes slots from the
other — and they survive a restart, with one missed while the bot was down firing
a single catch-up.

Reminders are yours, not the agent's: the scheduling tools an agent can call
do not see them, so it can neither list nor delete them.

### `/clear_messages`

Delete bot messages in this topic (up to 48h, Telegram limit).

### `/clear`

Forwarded to the agent (Claude wipes context; OpenCode plain text) — not a bot command anymore. Also purges the topic's file-intake dir.

### `/compact`

Compact the agent's context — a real, confirmed compaction on OpenCode and on the default (stream) Claude backend; the tmux Claude backend has the literal command forwarded (its TUI compacts); terminal: not supported.

### `/compact_on_idle`

Toggle auto-compaction after ~55 min idle (Enable/Disable picker; `AGENT_IDLE_MINUTES` sets the window). Per topic; run it in **General** to set the default for all topics. On by default. Each idle compaction posts one short notice; the picker's «Show summary» / «Hide summary» row (the `/compact_summary` switch) adds the agent's full summary after it. Fires at most once per active period (until you write again); if a question was pending it is re-asked with tappable buttons after the compaction and the first copy stays as a record (see [The agent's questions](#the-agents-questions)). On the json-stream backends the idle mark also STOPS the agent process, compaction or not — the topic sleeps and your next message resumes it (`/status` says so).

### `/compact_summary`

Toggle posting the agent's full summary after a compaction — `/compact`, the idle compaction and the agent's own `compact_conversation` (Enable/Disable picker). Every compaction summary — also the one the agent CLI or OpenCode makes by itself when the context overflows — ends with a numbered checklist of what the agent does next, whose first item reloads the skills it had loaded. Per topic; run it in **General** to set the default for all topics. Off by default: a compaction ends in a short line. On OpenCode it also hides the summary OpenCode streams itself.

### `/bot_skills`

Switch the skills Charness gives its agents on or off. In **General**: On / Off for the whole instance (the screen shows the value in force; `"botSkills"` in `settings.json` is the default while General never chose, ON when nothing says otherwise). In a topic: On / Off / «As in General (value)», the current choice marked ✓. One-shot picker — a tap turns it into the confirmation; typed `on` / `off` (and `general` in a topic) apply at once. A running agent keeps its skills until its next start. On an OpenCode topic the skills stay listed (one server serves every topic); only the hint to load the manager changes.

#### Skills the bot gives its agents

Every agent session the bot starts — Claude Code or OpenCode, in a topic or a
Jira conversation — also gets three skills that ship with Charness
(`agent-plugin/`):

- `charness-manager` — driving a plan through detached workers with the bot's
  own tools: one worker on the checkout at a time, an independent review, and a
  bot check per worker that wakes the agent when the worker exits OR stops
  writing for 45 minutes (pinned silently: a finished worker fires it too);
- `charness-delegate-claude` / `charness-delegate-opencode` — launching,
  watching and resuming a detached `claude -p` / `opencode run` worker.

Claude Code lists them as `charness:charness-manager`, …; OpenCode by their
names. Your own and your projects' skills stay as they are, and your sessions
outside the bot do not get these. For Claude Code the bot passes
`--plugin-dir`; for OpenCode it starts its server with `OPENCODE_CONFIG_DIR`
naming a folder in `DATA_DIR` — if you set `OPENCODE_CONFIG_DIR` yourself, yours
is kept and OpenCode topics go without these skills. They update with the bot.

They can be switched off with `/bot_skills` (in General for the instance, in a topic for that topic). The value is read in this
order, the first that is set wins: the topic's own choice, General's value, `"botSkills"` in [`settings.json`](../SETUP.md#instance-settings-settingsjson) (the way an instance without General — a
Jira-only one — sets it), then **on**. A Jira conversation has no choice of its own: it follows the instance value. With the
skills off a Claude conversation starts and resumes without `--plugin-dir`, and the bot MCP's instructions no longer tell its agent to
load `charness-manager` (the worker-watch recipe stays in `schedule_create`'s description); a running agent keeps its skills until its
next start. OpenCode has ONE server for every topic, so only the instance value counts there: the server is replaced at the bot's next
start, once nothing works in it, by one started without (or, when turned back on, with) the folder. A topic's own choice changes the
manager hint of its OpenCode folder only when the OpenCode server next restarts, and OpenCode topics sharing a folder share the hint
(it stays while any of them has the skills on).

### `/task_agents`

The cap on tracker task agents — how many conversations of a connected tracker (Jira issues) may work on a hand-over at once, for the whole bot; an issue over it waits in one queue and starts by itself ([Jira setup](../SETUP.md#jira-setup)). In **General**: a one-shot picker 5 / 10 / 15 / 20 / 30 / No limit with the value in force marked ✓ (a tap turns it into the confirmation), or any whole number typed after the command (`/task_agents 12`; `0` or `off` = no limit, 100 the most — anything else is refused with the range). The screen names where the value comes from — set in General, `"taskAgents": { "maxConcurrent": … }` in [`settings.json`](../SETUP.md#instance-settings-settingsjson) (the default while General never chose, and the way an instance without General sets it), or the built-in 5 — and, on an instance that serves Jira, how many agents work now and how many wait. In a topic it only reports the value and says it is changed in General.

### `/limits`

The **switch board**: every signed-in Claude account and every connected OpenCode provider on one screen. The **message** carries the figures — `Usage (% used)` and a line per account in the same wording `/accounts` uses (`default — ⏱ 5h 14% 🔄 in 3h · week 3% 🔄 in 6d`; `⛔ at its limit until …` while the account is limited; `(stale)` when the last poll could not refresh), a provider signed in through a ChatGPT subscription after them (`openai (ChatGPT) — ⏱ 5h 12% 🔄 in 3h · week 40% 🔄 in 4d`), the two automatic-switching settings' state with a link to `/limits_autoswitch`, and the caption «Choose the active model:». The **buttons** are one full-width name each — `✓ Claude · work`, `Claude · default`, `OpenCode · openai`, `Claude · console 💳` for an account billed to API credits — with no figure on them (the figures do not fit a phone's button); ✓ marks where the topic runs; a signed-out account is not listed. **A tap switches this topic**: another Claude account (the running session restarts under it, same conversation — at the end of its turn when it is working), an OpenCode provider (opens its model page, 10 models per page with ⛔ on a limited one; a provider with one model switches at once), the ✓ row (the model page of where the topic runs: change the model). Across backends with a conversation to hand over the bot asks first (✅ Continue / ✖️ Cancel); while a usage-limit wait is armed the tap is the limit move — the wait ends and the work continues, no question — and «⏭ Skip once» is offered. An unbound topic is told to bind a folder first. In **General** a Claude row sets the default account for all topics (the caption reads «Choose the default Claude account:»), and an OpenCode row only says that a model is picked inside a topic. The limit notice names this command. The old text forms `/limits rebuild`, `/limits clear`, `/limits switch …`, `/limits wait …` still work (they are `/limits_autoswitch`'s verbs). The setup of the automatic switching is [`/limits_autoswitch`](#limits_autoswitch).

#### Usage limits and the fallback models

When a topic's agent stops on a usage limit — a Claude account window, an
OpenAI quota through OpenCode, a Google quota spent for the day or the plan — the
bot can keep the work going somewhere else instead of waiting (a per-minute
throttle, or a reset a few minutes away, is simply retried). Two screens split
the job:
**`/limits` is the switch board** — every signed-in Claude account and every connected
OpenCode provider with its usage, one tap to move the topic there by hand — and
**`/limits_autoswitch` is the setup of the automatic switching**: ONE
instance-wide, ordered list of **fallback models** (where to go), top = preferred,
and the two settings (auto switch, wait for the reset):

- **The board.** `/limits` (see the command table) is where the notice sends you
  («The limit resets &lt;time&gt;. Switch: /limits»): a Claude account row changes the
  account (model and conversation kept), an OpenCode provider row opens its model page
  and a pick changes the model (the same session), the ✓ row changes the model of where
  the topic runs, and across backends with a conversation the bot asks first. Every
  entry point — a board row, an `/accounts` row, a model page, `/accounts use` — takes the
  one switch path, so a pick behaves the same wherever it is made. While a limit wait is
  armed a tap is the limit move: another account, another provider or model, and — on the
  limited Claude account itself — a model the limit does not cover (a Fable-only weekly limit
  does not stop `opus` or `sonnet`; the usage windows say what is exhausted) continue the work
  at once; a pick still inside the limit's scope (Fable again, or any model while the session or
  the shared weekly window is exhausted — Fable drains both too — or when the windows are unknown)
  only changes the model and the wait stays. A tap that switched answers with a short «✅ This topic runs on …».
- **OpenCode usage.** A provider signed in through a **ChatGPT subscription** (the `openai`
  provider with an `oauth` record in OpenCode's `auth.json`) shows its ~5 h and ~7 d
  windows in the `/limits` message and in `/accounts`, read the way a Claude account's are: the stored
  token as it is (never refreshed by the bot; an expired one marks the figures out of date),
  every 10 minutes and when a screen opens, cached in `state.json`. API-key providers and
  other subscriptions show only how they are signed in (`/accounts`); a model that hit a limit carries `⛔ <reset>` on its model page.
  A failed read just leaves the provider without a usage line.

### `/limits_autoswitch`

The setup of automatic switching on a usage limit, with a short text: a title, what the topic runs on and where its two settings come from. **Fallback models** — an ordered list of Claude accounts (with an optional model) and OpenCode providers with a model, top = preferred, where a topic continues when its agent hits a limit. One full-width button per entry (`✓ 1. Claude · work · opus`, `2. Claude · default ⛔ 14:00`, `3. OpenCode · openai · gpt-5 🚫` — ✓ where the topic runs, ⛔ limited until, 🔒 not signed in, ❓ no longer offered, 💸 API credits used up, 🚫 left out of automatic switching); a tap opens that entry in the same message with ⬆️ Up / ⬇️ Down, 🚫 Don't use / ✅ Use (a left-out entry stays usable by hand through `/model` and `/accounts`), 🗑 Remove and ⬅️ Back. Below the list: «➕ Add» (account or provider, then the model; an entry of a backend the list does not use yet — an OpenCode model next to Claude accounts, or the reverse — asks first, because a limit then hands a conversation over in compacted form; including a 🚫 entry that does that asks the same way), «🔄 Fill from connected» (a draft from what is connected; entries you left out stay left out; an account billed to API credits comes last and left out unless you had included it; asks first when a list exists), «🗑 Clear». The list is ONE instance-wide list and is editable from every topic. **Two settings** decide what a limit does: «🔁 Auto switch» — auto switch to a fallback model (ON by default, also with one account; the topic moves to the first entry of the list with room — an OpenCode entry included, which hands the conversation over in compacted form; turned OFF, the limit notice carries «🔁 Switch to …» buttons instead) and «⏳ Wait for reset» — wait for the reset and continue (ON by default; while a wait is armed the topic screen also offers «⏭ Skip once»). In General they are the defaults for all topics and each is one button that flips the value. In a regular topic each is one short full-width button showing the effective value (`🔁 Auto switch: ON`; one line of text above the list says where each value comes from — `🔁 as in General · ⏳ set for this topic`); a tap opens the setting in the same message with ON / OFF / «As in General (<the General value>)» — the topic's own choice marked ✓ — and ⬅️ Back, and a choice applies and returns to the screen. Switch ON: the topic moves to the first available entry at once. OFF: buttons on the notice, and if none is pressed the bot waits for the reset (waiting ON); both OFF: it only reports the limit. When every enabled entry, the current one included, is limited, the wait ends at the EARLIEST reset and the topic continues on that entry (the notice names it and the time). Text forms: `/limits_autoswitch rebuild`, `/limits_autoswitch clear`, `/limits_autoswitch switch on|off|same`, `/limits_autoswitch wait on|off|same` (the same verbs work after `/limits`). `/fallback` and `/auto_continue_limits [on|off]` still work as hidden aliases. The board that switches a topic by hand is [`/limits`](#limits).

#### Fallback models and automatic switching

- **Waiting out a limit.** When the agent hits a usage / session limit the bot reads the reset time out of the error (honouring the timezone the provider quotes; a mere warning such as `Approaching session limit · resets …` or the switch onto extra usage is not a limit), waits, then tells the agent to continue by itself and pins the "work resumed" message so a muted topic still notifies you; `/limits_autoswitch` turns waiting off per topic and `/limits` skips a single resume.
- **Left out of switching.** ✅ / 🚫 on a row includes or excludes that entry from
  automatic switching and from the notice's switch buttons. A connected
  provider (say OpenAI on OpenCode) can stay usable by hand through `/model`
  while the bot never moves a limited topic onto it. With an EMPTY chain the
  bot still ranks the other signed-in Claude accounts by the soonest weekly reset; once the
  chain has entries, only its ✅ entries count — all of them left out means
  no switch, the wait stands.
- **Entries.** A Claude account profile (`/accounts`) with an optional model
  (`fable`, `opus`, `sonnet`, `haiku`; «keep the topic's model» otherwise), or
  an OpenCode provider with a model (`openai/gpt-5`, `google/gemini-2.5-pro`,
  …). Only what is actually connected is offered: the signed-in profiles, and
  the providers the OpenCode server is authenticated for (its live catalog).
- **Drafting.** «🔄 Fill from connected» (or `/limits_autoswitch rebuild`) writes a draft from what
  is signed in: the Claude accounts in their `/accounts` order (keeping the
  topic's model), then the OpenCode models topics picked recently, then every
  other provider's strongest model; an account or provider you had left out of
  switching (🚫) stays left out. Tap an entry to move it (⬆️ Up / ⬇️ Down),
  include or leave it out, or remove it; add with «➕ Add» (pick the account or
  provider, then the model). Editing works from **every** topic (it is one
  instance-wide list); a topic also sees ✓ on the entry it runs on now.
- **On a limit** the bot marks the exhausted entry limited until its window
  resets (the reset the error names, else the account's session window, else
  an hour), skips entries that are limited, not signed in or no longer offered,
  and takes the first remaining one. A topic whose account or model was picked
  by hand (`/accounts`, `/model`) is left alone until it hits its own limit —
  then the chain decides, from the top. The «🔁 Auto switch»
  setting (auto switch to a fallback model) applies: OFF puts «🔁 Switch to …» buttons on the
  limit notice, ON (the default) switches by itself. No entry available → the wait
  (when «⏳ Wait for reset» is ON) — **for the entry that
  comes back first**: when every enabled entry, the topic's current one
  included, is limited, the armed wait is re-aimed at the entry whose limit
  resets EARLIEST (the notice says which model the topic will continue on and
  when, also with auto switch OFF). The target rides in the persisted retry
  record, so a restart keeps it; when the timer fires the topic is moved there
  first (a context bridge across backends), then the usual continue prompt
  follows. If the current entry resets first (or within a minute of the first),
  nothing changes.
- **Within a backend** the conversation is kept: Claude account → account keeps
  the transcript (`--resume` under the other account), OpenCode provider →
  provider keeps the session and changes the model. **Across backends**
  (Claude ↔ OpenCode) the topic's agent changes: the old session is stopped
  and its id parked, the new one is started (or resumed, when the topic ran on
  that backend before) and its first prompt is a **context bridge** — why it
  takes over, the previous agent's last turns verbatim (and, for a Claude
  conversation that was compacted, the summary of that compaction as context,
  never as something you said), and the instruction to
  check the project state (git status / diff / log) before carrying on and to
  report in one short message what the task is, what is done and what remains.
  A later `/claude` or `/opencode` returns to the parked conversation; `/new`
  and `/quit` release it as usual.
- **A manual switch between Claude and OpenCode asks first.** `/claude` or `/opencode` (also the agent
  buttons and the natural-language «start …» phrases) on a topic that runs the other backend, and a Claude
  account tapped in `/accounts` or on the `/limits` board (or `/accounts use <name>`) — and an OpenCode provider's model picked on a topic that runs Claude — move the topic the same
  way as a limit does — parked conversation of the target resumed, the context bridge as its first prompt (text typed
  with the command, `/opencode do X`, rides in it). When the topic holds a conversation to hand over (an agent with at
  least one turn, running or asleep) the bot first asks «🔁 Switch this topic from OpenCode to Claude «work»? The
  conversation context will be handed over in compacted form.» with ✅ Continue / ✖️ Cancel: Continue switches and
  turns the question into one line saying so, Cancel changes nothing; either consumes the keyboard, and an old
  question only says it is out of date. A topic with nothing to hand over (no agent, or one just started and not yet
  spoken to) switches at once, and a Claude account tapped on a Claude topic applies at once, as before. `/model`
  lists only the current backend's models, so it never switches backend.
- The reset of the exhausted entry does **not** move the topic back by itself —
  the switch notice names the reset time. The one thing that can is the wait: when
  every enabled entry is limited, the wait is re-aimed at the entry that resets
  first, and that may be the one the topic left (see above).

### `/bind`

Bare: current binding + folder picker, with «leave current dir» (the old `/unbind`) and «create new folder» buttons.

### `/topic`

`/topic [name]` — open another forum topic on a folder, without leaving this one. Asks the new topic's name (`/topic <name>` takes it from the command), then the folder: «📁 &lt;folder&gt; (as here)» — the folder this topic is bound to — or «📂 Other folder», which is the `/bind` picker with «create new folder»; in General and in an unbound topic the picker comes at once. Then the bot creates the topic (it needs the `can_manage_topics` right — `/doctor` checks it), binds it, shows the usual binding welcome there and turns the question into the answer with an «Open topic →» button. «✖️ Cancel» on the question and in the picker, and `/esc` at any step, end it. No agent starts by itself: start one in the new topic as in any bound topic. Works in the group only — in the bot's private chat it says so.

### `/mcp`

List MCP servers active for this thread.

## Info and ops (work anywhere)

### `/start`

Intro: work root + available agents.

### `/help`

Context-aware help.

### `/ls`

List the project subfolders of the folder the bot was launched from.

### `/list`

List existing topics and their bindings.

### `/doctor`

Self-diagnose: admin rights, privacy mode, paths, CLIs.

### `/version`

Versions: bot, claude, opencode, node, tmux; a line when an update is available.

### `/update`

Self-update screen: what this instance runs (npm / git, hot), automatic updates `Automatic` · `Notify only` · `Off` (default automatic), the «what's new» switch, Check now, Update now. Controls in General, read-only elsewhere; typed forms `/update on|notify|off`, `/update whatsnew on|off`, `/update check`, `/update now` — see [Updating](../SETUP.md#updating).

**Updates itself.** The bot checks for a new version hourly, installs it when no agent is working, restarts in place (same process, agents keep running) and says in General what changed; npm installs and git checkouts, hot mode and Docker included. Off with `/update` in General. See [Updating](../SETUP.md#updating).

### `/whoami`

Show userId, chatId, threadId, isAllowed, binding.

### `/trace`

Output-trace recorder (`on`/`off`, `on all`/`off all`; bare = status).

#### Observability

- **Output trace** (Telegram) — ON by default for every thread: each incoming update,
  adapter emit, and outgoing Bot API call (with outcome, incl. 429 details)
  is recorded into hourly buckets `DATA_DIR/output-trace-*.jsonl` (pruned
  after 6h). `/trace off all` turns it off durably; bare `/trace` reports
  status. This is the source of truth when debugging "a message never
  reached the topic".
- **Console tee** — the bot's stdout/stderr is mirrored to
  `DATA_DIR/bot-console-*.log` (same hourly buckets, same 6h prune), so
  boot logs stay readable post-incident without the operator's terminal.

### `/timestamps`

Prepend the send time to prompts forwarded to the agent (`on`/`off`; bare = status).

- **`/timestamps on`** (Telegram) — prepends each forwarded prompt's send time
  (local-offset ISO) so a days-long session knows what "yesterday" means.
  Agent-facing only, default off, persisted per topic.

### `/language`, `/lang`

Set the bot UI language for this chat; bare opens an endonym picker (sorted A→Z by English name), `/language auto` returns to automatic per-chat detection.

### `/timezone`

Set the timezone every clock the bot touches speaks in — schedules, agent time context, time renders. `/timezone Europe/Moscow`, `/timezone +04:00`, `/timezone auto` (host zone); bare opens a region → zone picker. Instance-wide, not per chat.

#### Timezone

The bot runs on the host clock, which on a typical server is UTC. `/timezone`
declares yours ONCE, instance-wide, and every clock the bot touches follows:

- **Schedules** fire at your wall-clock time. Changing the zone PRESERVES the
  wall clock — "9am" stays 9am rather than drifting by the offset — and every
  job's next run is recomputed on the spot (an expired one-shot is dropped).
- **The agent** is told the current time and zone with each `/schedule` request,
  and carries the zone in its thread-context preamble, so "remind me tomorrow at
  9" resolves against your clock instead of the model's assumption.
- **Time renders** — "missed at HH:MM", schedule descriptions, `/timestamps`
  injection and the `schedule_list` next-run stamp all read in your zone.

```
/timezone Europe/Moscow     # IANA name
/timezone +04:00            # fixed offset (accepted; does not follow DST)
/timezone                   # region → zone picker
/timezone auto              # back to the host zone
```

The current zone and its wall clock also show in `/status`. Nothing is stored
until you set one, so an install that never runs `/timezone` behaves exactly as
it did before.

### `/pair`

Bind this forum supergroup to the bot (re-point auto-pairing) — works from any topic of the target group; a numeric `ALLOWED_GROUP_ID` env locks pairing.

## General-only

### `/quitall`

End every active agent in every bound topic (also releases their session ids).

### `/runners`

The machines your agents can send tests and builds to (`charness remote-run`), paired from Telegram. **General only, admins only** — in a topic it points to General, and a button tapped from a topic is refused. One message, redrawn in place:

- **The list.** Each machine with its name, online or «offline since …», paused, system and how it is kept running (run by hand, user service, always-on system service); when it is online also its hardware (CPU, load, RAM, disk), its jobs (running, queued, projects) and what it can do — Android, iOS, Docker, Playwright, with the reason for a «no». The list opens at once from what the bot already knows, then asks the online machines (up to 20 s) and redraws; a machine that does not answer keeps its last snapshot, marked «as it was then». Empty: «No runners yet.» A long list is split over pages (**‹ Previous / Next ›**, «Page 2 of 3»); what a machine reports about itself is shortened to fit.
- **＋ Pair a new runner** posts two messages (secrets — the output trace records only their length), two lines for one code, valid 10 minutes, single use, whichever is used first. The first is for an **admin account** of the runner machine (`sudo sh -c '…' sh '…' runner`): it checks the account named by the last word of the line (`runner` unless you change it: it must exist and must not be an admin or root — it runs the agents' code), pairs it **as that account** and installs its always-on service, all in one paste — and while it does, it runs code from this charness host as root on that machine (the message says so). The second is the plain line to run **as the runner account itself**, without admin rights; it prints how to keep the runner running. Either installs `charness-runner` there from this charness's own package and pairs the machine, telling each step as it goes (checking the account, downloading the package, installing the runner program, checking the machine, pairing, getting Pueue, finding rsync, installing the service — one line each, with dots that cycle while a step runs on a terminal); the FIRST message then turns into «Runner “name” paired …» and the line is gone from it, or after 10 minutes into «Pairing code expired.», or — when the admin line was pasted for a machine that was already paired and only installed its service — into «This line was used on a machine that was already paired — nothing new was paired.» — and the SECOND message is deleted, so the result is not said twice (if Telegram will not delete it, it is edited to a short pointer at the first) — also after a bot restart or when the code was used while the bot was down (the bot keeps its own record of the messages it sent, and which is the first, and tries again what Telegram refused — a message you deleted by hand counts as settled, nothing is retried for it). The first time, the bot asks **which address runners dial**: it proposes a public address of this machine when it answers with this machine's own ssh key, or you send `host` / `host:port` — checked the same way, a mismatch names the key that answered and the bot asks again. The address is kept in [`settings.json`](../SETUP.md#instance-settings-settingsjson) (`runnerHost`).
- **Pause / Resume** keeps a machine attached but sends it no jobs. **Remove** asks first («Its key is deleted and it stops connecting. Jobs running there are killed.»), then deletes its key line and registry entry and cuts its link; the jobs it was running are stopped at once through the link (a machine that was offline stops them itself when it finds out it was removed — the hub's answer at its next connection, or a refused key that lasts 12 hours), and the machine says it was removed and retries at most hourly. The tap is answered at once and a message in General then says what happened — the jobs stopped; or the machine was offline, so they were not, and it stops them itself once its key has been refused for 12 hours; or they could not be stopped from here (the reset failed, or the link state could not be read) and the machine does the same; a registry that cannot be written is reported there instead of «removed».
- Buttons carry the registry's revision and the machine's place in the whole list, so a keyboard left in the history only says «the list changed — here it is again» and draws the current list.

The same actions without Telegram (an instance that serves only Jira): `charness runners [ls | pair --host <address> [--account <name>] | remove <name> | service-removal <name> | pause <name> | resume <name>]`. `ls` shows «how it is kept running» as each machine last reported it (any probe refreshes the report — the Telegram list, `charness remote-run runners`, a job start), the same rule as the Telegram list; it first asks the machines that are online whose report is older than their link (a service installed after the pairing starts the link anew) or have none, and only those — a listing that finds every report fresh makes no ssh call, it waits at most 8 seconds for an answer, and a machine that gave none is shown as it was last known and not asked again for 10 minutes (or until its link begins anew) — so a silent machine never costs a wait at every listing — and its row says «(last report from before its link started; it did not answer)» (or «no report yet») instead of presenting that report as how it is kept running now; a machine is «online» exactly when its link is, whatever its probe says. A machine's default name drops the ending its network adds to the host name (`studio-mac.local` is `studio-mac`). The hub also notes where each machine's link connects from (the address sshd sees): when a link comes from another address than the one before it — or two links keep replacing each other, from two addresses, within minutes — the machine's row in `ls` and its block in `/runners` say so (where from now, where from before, when; for a link that took the place of one still up: remove the runner and pair it again if that was not your change of network), because a job on the machine can read its key and a second machine with it would replace the first without a sound.

## Plain messages, voice and files

What happens to a message that is not a command: text, voice notes, files and replies.

### Natural language and voice

In a bound topic you can also type:
- `claude fix the bug` / `opencode add tests`
- A plain message after `/claude` is already running → routed as input.

Voice messages are transcribed by the speech engines you set up with `/stt` (Groq,
OpenAI, any OpenAI-compatible server, or the local GigaAM engine — see [Voice input](../SETUP.md#voice-input)) and follow
the same routing. The engines form an ordered chain: when one fails, the next one answers within the
same voice note. The last one retries a temporary failure automatically (after 5 s, then 15 s) and
says so in the topic — no need to re-record the voice note.

`/terminal` is never started from a natural-language phrase — only the
explicit command opens a shell.

### The agent's questions

When the agent asks a question (Claude Code's `AskUserQuestion`, OpenCode's question tool) the bot posts it with one button per option and
pins it, so even a muted topic notifies you once. You answer by tapping an option or by typing its number. **The message is never deleted**:
it keeps the header, the question and the numbered options (a long question gives up its option descriptions, and shows as plain text if
Telegram cannot parse its formatting, so the result always fits), and under them stands how it ended in place of the buttons:

- **«✅ Answer: …»** — you tapped or typed an option (several questions in one call are shown one after the other, each with its own result).
- **«❌ Not answered»** — you wrote something else instead (the message goes to the agent as a prompt), sent `/esc`, `/quit`, `/quitall` or
  `/new`, left the folder, picked another conversation or backend, «create new folder» of `/bind` dropped it, or the agent's process ended, or the
  bot's request to the agent failed, with the question open. The same note stands on a question the bot finds orphaned when it restarts (its agent is gone).
- **«↓ Asked again below»** — the question was put again further down (the agent's output landed under it, or the idle compaction
  re-asked it): this is the older copy, kept as a record, and it says so only once the new copy is really there. When the agent keeps
  writing while the question waits, the question is put at the bottom again each time; the first message stays as the record and only the
  newest copy is live — the copies in between are removed, so there are at most two.

The pin is released whenever the question ends.

**After an idle compaction** (see [`/compact_on_idle`](#compact_on_idle)) a question that was pending is asked again with new buttons:
the first copy loses its buttons at once and keeps its text as a record, with «↓ Asked again below» once the new copy is posted (or
«❌ Not answered» if it could not be sent, or you wrote something else while the compaction ran — then nothing is asked again; a bot
restart in that time asks the question again when the conversation can still be resumed — nobody had the chance to answer — and leaves the
«❌ Not answered» note only when the conversation is gone). A number typed while the compaction runs answers the question as a tap would, and the
new copy is not posted. The new copy answers to a tap or a typed number, and ends like any question: with your
answer, or with «❌ Not answered» if you write something else, the conversation ends (`/quit`, `/quitall`, `/new`, leaving the folder, a
stopped or closed session, a switch to another conversation or backend) or the agent asks a newer question. A button left on an older
copy answers nothing and closes that copy with «❌ Not answered», and a restart of the bot keeps the new copy's buttons working while
the conversation sleeps. A number typed while the new copy is being sent (or while the compaction runs) shows the answer only once the agent has really got it; if the
conversation cannot be started, the question stays open with its buttons — asked again at once if the compaction was over. A second tap on
a copy that is already being answered changes nothing: the answer stays the last word on the message.

### File intake

Send a file to a bound topic with an active agent and the bot hands it to
the agent:

- Six kinds: photo, document (incl. PDF), video, video note, audio,
  animation. Voice is **not** intake — it stays on the transcription path.
- The file is downloaded to `DATA_DIR/files/<chatId>_<threadId>/`
  (bot-owned, never inside your project folder) and announced to the agent
  as `[Telegram file] … saved to: <path>` plus your caption.
- A media album (several files sent as one message) is batched into ONE
  combined `[Telegram album]` prompt instead of N separate ones.
- Limits and cleanup: 20 MB per file (Telegram Bot API cap); forwarding a
  bare `/clear` purges the topic's intake dir (the agent's context is gone,
  so the files are useless); files older than 30 days are swept daily.

### Reply context

Reply to a message in a topic and the quoted text is folded into the prompt the agent receives, so it sees what you point at without re-pasting; works for text, voice and files (a photo, a document, an album…), both agents; a reply TO a photo, file or voice note names it, with the path of the bot's saved copy when it has one.
