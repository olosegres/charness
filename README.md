<h1 align="center">Charness</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/charness"><img src="https://img.shields.io/npm/v/charness?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/charness"><img src="https://img.shields.io/node/v/charness?logo=node.js" alt="Node.js version"></a>
  <a href="https://github.com/olosegres/charness/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/charness" alt="license"></a>
</p>

<h2 align="center">Run multiple Claude Code / OpenCode agents and connect them to your Telegram or Jira.</h2>

- **In Telegram** you control your agents through a bot or a group, so it becomes a terminal for OpenCode and Claude Code — every thread is like a terminal tab, plus scheduling and voice control.
- **In Jira** it starts an agent when you assign a ticket to a special user: the agent reads the description, comments and attachments and does the work according to the ticket's status — like a real employee.

<p align="center">It runs fine on your laptop. But it is called a <b>c</b>loud <b>harness</b> for a reason — put it on a server and your agents keep working while the laptop sleeps.</p>

<p align="center">
  <img src="docs/images/hero-v2.png" alt="Charness — all your agents in Telegram; chat, code, ship; powerful slash commands" width="900" />
</p>

## What it does

### Common (any surface)

These hold whichever surface you drive it from — the same core serves all of them:

- **Agent backends** — OpenCode (native server API over HTTP+SSE) and Claude Code (three backends — json-stream, per-turn and tmux)
- **Sleeping agents** — a Claude json-stream topic's process is stopped when idle (or after every turn in per-turn mode) and the next message resumes the same conversation by itself, prompt cache still warm
- **Several Claude accounts** — keep more than one Claude subscription signed in side by side and choose per topic which one a session runs on (`/accounts`); every account's usage windows are shown next to it. See [Several accounts](#several-accounts-accounts)
- **Waits out usage limits** — when the agent hits a usage / session limit the bot reads the reset time out of the error (honouring the timezone the provider quotes), waits, then tells the agent to continue by itself and pins the "work resumed" message so a muted topic still notifies you; `/limits` turns waiting off per topic or skips a single resume. With a **fallback chain** (`/limits`: other Claude accounts, OpenCode providers and models, in your order of preference) the limit notice offers «🔁 Switch to …» buttons to move the topic to the next entry with room and continue at once — or the bot does it by itself when you turn switching on; across backends the new agent gets a context bridge with the previous one's last turns
- **Restart-safe** — agents run as external processes (tmux, `opencode serve`) that the bot re-adopts after a restart instead of killing them; a prompt sent while a session boots is buffered and replayed. See [Restart behaviour](#restart-behaviour)

### Telegram

Charness turns Telegram into a terminal for running agentic CLIs. Open as
many tabs as you need — even two on the same project for parallel work — and
drive the agents from your phone or tablet, voice messages included.

Think **OpenClaw for vibe coding**, driven entirely from Telegram: no complex
setup, no extra dashboards — direct access to your own **OpenCode** /
**Claude Code** running on your machine or server.

- **Simple setup & management** — install the CLI, put your bot token in one `.env`, bind a topic to a folder, and run; everything after is managed from Telegram — no dashboards
- **Multi-thread / topic** — one topic per directory with your agent; two topics can share one folder for parallel work — run almost unlimited agents in parallel
- **Two chat surfaces** — forum-group topics and the owner's bot DM, both served at once by default, with tabs on either
- **Raw terminal** — `/terminal` binds a topic to a real `$SHELL` in the project folder
- **Notifications** — when the agent asks a question, the bot pins that message so even a muted topic notifies you: the pin pierces mute, giving exactly one notification per question (unpinned once you answer)
- **Scheduled & self-driving runs** — `/schedule` arms cron / one-shot / N-times jobs per topic, and the agent can schedule *itself* via injected MCP tools: nightly reviews, recurring reports, a "finish this tomorrow at 9" hand-off. Each job fires as a fresh session with your prompt; restart-safe, with one catch-up for a run missed while the bot was down
- **Reminders** — `/reminders` sets a plain reminder with inline buttons (how often, which day, what time, then the text by typing or voice); at the due time the bot posts and pins it itself, so even a muted topic notifies you. No agent, no bound folder, no date parsing — works in any topic, General included
- **Inbound files** — photos / documents / video / audio sent to a topic are saved and announced to the agent; albums arrive as one prompt
- **Outbound files** — the agent sends files back to you — a generated chart, a screenshot, a log, a rendered PDF — single files or albums, straight into the topic
- **Voice input** — voice notes are transcribed by an ordered chain of engines — Groq, OpenAI or your own OpenAI-compatible server — set up in `/stt` (or `stt.json`); a local GigaAM engine is optional; if one fails, the next takes over
- **Display verbosity and view** — `/verbosity` (plus `/thinking`, `/tool_results`, `/subagent`) per topic: detail `minimal|short|full`, and what the topic shows — `stream` (default), `stream_answers` or `answers` (only the agent's pinned answers, no stream)
- **Time-aware prompts** — `/timestamps on` prepends each forwarded prompt's send time (local-offset ISO), so a days-long session knows what "yesterday" or "2 days ago" means; agent-facing only, per topic
- **Reply context** — reply to a message in a topic and the quoted text is folded into the prompt the agent receives, so it sees what you point at without re-pasting; works for text, voice and files (a photo, a document, an album…), both agents; a reply TO a photo, file or voice note names it, with the path of the bot's saved copy when it has one
- **Your timezone** — `/timezone Europe/Moscow` once, and schedules fire at your wall-clock time while the agent is told what time it actually is; no server-clock guessing

#### Two surfaces: group topics, bot DM, or both

The bot serves two Telegram surfaces:

- **Forum supergroup** — every topic is a tab. The most familiar UX: a visible
  topic list, per-topic names and icons, quick switching between agents. The
  trade-off is Telegram's group throughput cap (about 20 messages/min per
  group), so the bot paces and coalesces heavy output streams.
- **The bot's own DM** (owner only) — the private
  chat runs in topic mode too, so you get the same thread-per-agent tabs
  there, and live output streams through Telegram's native draft "cursor":
  the reply grows in place in one message instead of arriving as a flood of
  separate messages.

## Quick start

1. `npm install -g charness` (needs Node ≥ 22.12).
2. Put your bot token (from [@BotFather](https://t.me/BotFather)) into `~/.config/charness/.env` as
   `TELEGRAM_BOT_TOKEN=…`.
3. Run `charness` from the folder that holds your projects: `cd ~/projects && charness`.
4. In your Telegram group (or the bot's DM): `/bind <subfolder>` in a topic, then `/claude` or `/opencode` and
   talk to the agent — text or voice.

Full setup — Telegram, Jira, environment, updating: [SETUP.md](SETUP.md)

## Reference

### Commands (Telegram)

#### In any topic

Most commands work in any topic; a binding (`/bind`) is required only to
actually start an agent or terminal in the folder.

| Command | Description |
|---|---|
| `/claude`, `/opencode`, `/oc` | Start agent in this topic's bound folder |
| `/terminal` | Open a raw `$SHELL` in the bound folder — see [Raw terminal](#raw-terminal-terminal-telegram) |
| `/claude_mode` | Switch this topic's Claude backend (json-stream ⇄ per-turn ⇄ tmux-scrape); bare shows a picker — see [Claude Code backends](#claude-code-backends-claude_mode) |
| `/model` | Switch model through a two-level picker: providers, then that provider's models (10 per page). On OpenCode the first row is 🕘 Recently used — a flat list of the models picked before, across providers (bot-wide, most recent first, up to 10), one tap to switch; it appears once something has been picked. Each provider row has a 🙈 to hide it from the picker (bot-wide, persisted; 👁 brings it back) — `/model <provider/model>` still reaches a hidden provider. If OpenCode is waiting on an old provider's retry, the next prompt interrupts that wait and starts with the selected model instead of sitting queued behind it |
| `/accounts` | Every account the bot works with, on one screen. **Claude accounts** (when you keep several subscriptions signed in): each profile with its email, plan (personal Pro/Max or corporate Team/Enterprise), how many topics use it and its usage windows, ✓ on the active one; tap a profile to switch this topic (a running session is restarted under it, same conversation — at the end of its turn if it is working); in **General** the pick becomes the default for all topics. Per profile: 🔑 signs it in again, 🗑 removes it (after a confirmation; for `default`, which IS `~/.claude`, «remove» signs it out — see below). The usage lines give each window's percentage USED and when it resets as a time from now (`5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h`; «🔄 in 2h», «🔄 in 2d 1h», «🔄 in 30m»; Fable only on a plan that has its own weekly window); when the 5h window's reset is unknown the weekly one is shown in its place, and with no reset at all only the percentage. The hint paragraph under the account list says the percentages are used. «➕ Claude account» asks for a name and runs the sign-in. **OpenCode providers**: the connected ones are listed with a «🔌 Disconnect <provider>» button and a 🔑 (connect again) each (the disconnect asks, then removes the stored credentials; a provider OpenCode enables from an environment variable, e.g. `OPENROUTER_API_KEY`, stays active — the reply says so and points at hiding it in `/model`); «➕ OpenCode provider» asks for the provider id and continues with the connect flow (OAuth methods when available, otherwise an API key whose message is deleted from Telegram). In a topic the bot moved off a limited account or model, the first row is a «↩️ Back to …» button that moves the topic back there. What happens when an account hits a usage limit is set in `/limits`. Text forms: `/accounts add <name>`, `/accounts use <name>`, `/accounts login <name>`, `/accounts remove <name>`, `/accounts autoswitch on\|off`. `/account`, `/connect [provider [key]]` and `/disconnect [provider]` still work as hidden aliases (the menu lists only `/accounts`). See [Several accounts](#several-accounts-accounts) |
| `/effort` | Reasoning effort. **In a topic:** shows the level its session runs and where the next start's level comes from («medium — as in General» / «high — set for this topic»; a running session keeps the level it started with when General moves on: «xhigh (medium from the next start) — as in General») with a button per level — Claude: the native `/effort` levels (`low…ultracode`); OpenCode: the current model's variants, applied per-prompt; General's `ultracode` is the model's highest variant and `auto` sends no variant — and «As in General (medium)», named with the level the topic will really get (OpenCode: rounded to the model's variants), which drops the topic's own pick (a live session is brought to the default at once). **In General:** the default effort for every topic that has no effort of its own (✓ on the current one; `medium` until you pick), saved to `settings.json` and applied from each topic's next session start or wake-up — running sessions are not restarted. No env configuration — see [Instance settings](SETUP.md#instance-settings-settingsjson) |
| `/verbosity` | Output-verbosity macro (`minimal\|short\|full`): sets the thinking, tool-results and sub-agent display prefs at once; `/thinking`, `/tool_results`, `/subagent` point-override afterwards. Mixed prefs show as "custom" in the picker. The picker's second row (or `/verbosity stream\|stream_answers\|answers`) sets what the topic SHOWS — "Stream only" (default), "Stream + answers" (the stream plus the agent's pinned answers) or "Answers only" (the pinned answers, no stream; an agent that keeps writing after its final answer is reminded once to send what matters); the answers are written like for a manager or QA — brief and to the point; a switch applies from the next message, and `/status` names the view |
| `/thinking` | Chain-of-thought display: `full` keeps the reasoning, `short` collapses to "💭 thought for Ns", `minimal` keeps only the live working cue |
| `/tool_results` | Completed tool-call output: `full` whole body, `short` capped (15 lines / 1200 chars), `minimal` transient 🔧 status only |
| `/subagent` | Sub-agent transcript: status-only with a ticking elapsed counter (`minimal`/`short`), or streamed "🤖 ⤷" chunks (`full`) |
| `/sessions` | List & resume previous sessions in this folder |
| `/rename_session` | Rename the current live session (OpenCode; Claude transcripts have no title) |
| `/quit`, `/q` | End the session — Claude: graceful double Ctrl+C; OpenCode/terminal: `stopSession`. Releases the persisted session id, so a bot restart won't auto-reattach it (resume later via `/sessions`). A topic whose agent process is gone but whose session is kept (it "sleeps": the next message, file, voice note, `/compact`, `/model` or `/effort` resumes it by itself) is released the same way |
| `/new`, `/clear_session` | End the current session and start a fresh one (same adapter) |
| `/status` | This thread's status: agent, bound folder, the Claude account it runs on and the resolved workdir; a live session also shows the model it is actually running, the effort it runs (when the default moved on under it: «xhigh (medium from the next start)»), start time, runtime version and context use (anything the backend cannot report renders as unknown). On a Claude topic the account is its profile (name · email as in `/accounts`, marked ⛔ while it is at its limit, with a second row for a switch still pending); an OpenCode topic's model already names its provider |
| `/output` | Last 500 lines of agent output (sent as at most 5 chunks; the overflow is reported as omitted) |
| `/c`, `/y`, `/n` | Ctrl+C / "y" / "n" |
| `/enter`, `/up`, `/down`, `/tab` | tmux key passthrough |
| `/esc`, `/escape` | Send a raw Escape — interrupt the current turn / dismiss a selector |
| `/schedule` | Schedule a prompt in free text — the agent parses the time and owns the job; see [Scheduler](#scheduler-schedule-telegram) |
| `/stt` | Voice recognition on one screen, from any topic (General included); instance-wide, applied to the next voice note — no restart. An ordered list of **engines** (the first that works answers; when one fails the next takes over): one full-width button each (`1. GigaAM (local) · 10s+25% · ✓` — name, timeout `base s + % of the voice`, ✓ usable / ✗ disabled or skipped); a tap opens it with ⬆️ Up / ⬇️ Down, ✅ Use / 🚫 Don't use, ⏱ Timeout (presets), 🔑 key and 🗑 Remove. «➕ Add engine»: **Groq**, **OpenAI** or a **custom** OpenAI-compatible server (its address, a base like `http://host:8000` is completed; then «does it need a key?»). A pasted key is deleted from the topic the moment it is accepted, never shown again and kept out of the logs; an address with a login in it is refused. **Language**: auto or `ru en uk de fr es`. **Local recognition** (GigaAM, Russian only, runs on this machine): «🖥 Enable local recognition» confirms the cost (≈ 400 MB on disk, ≈ 0.5–0.8 GB RAM only while it runs), installs it with a live progress message and puts it first in the list; the screen shows its state (not installed / installing / ready, not running / running / paused after failed starts) with «🔄 Try again now», «⏱ Exit after idle» (5 / 15 / 30 / 60 min or never), «⚙️ Workers» (1 / 2 / 4 / 8) and «🗑 Remove local engine files». Everything lives in one file, `stt.json` — see [Voice input](SETUP.md#voice-input). `/voice` and `/speech` are hidden aliases |
| `/reminders` | Reminders set with buttons only — the bot posts and pins them itself, with no agent involved; works in any topic, bound or not. See [Reminders](#reminders-reminders-telegram) |
| `/clear_messages` | Delete bot messages in this topic (up to 48h, Telegram limit) |
| `/clear` | Forwarded to the agent (Claude wipes context; OpenCode plain text) — not a bot command anymore. Also purges the topic's file-intake dir |
| `/compact` | Compact the agent's context — a real, confirmed compaction on OpenCode and on the default (stream) Claude backend; the tmux Claude backend has the literal command forwarded (its TUI compacts); terminal: not supported |
| `/compact_on_idle` | Toggle auto-compaction after ~55 min idle (Enable/Disable picker; `AGENT_IDLE_MINUTES` sets the window). Per topic; run it in **General** to set the default for all topics. On by default. Each idle compaction posts one short notice; the picker's «Show summary» / «Hide summary» row (the `/compact_summary` switch) adds the agent's full summary after it. Fires at most once per active period (until you write again); if a question was pending it is re-asked with tappable buttons after the compaction. On the json-stream backends the idle mark also STOPS the agent process, compaction or not — the topic sleeps and your next message resumes it (`/status` says so) |
| `/compact_summary` | Toggle posting the agent's full summary after a compaction — `/compact`, the idle compaction and the agent's own `compact_conversation` (Enable/Disable picker). Per topic; run it in **General** to set the default for all topics. Off by default: a compaction ends in a short line. On OpenCode it also hides the summary OpenCode streams itself |
| `/limits` | Everything about a usage limit on one screen, with a short text: at the top each Claude account's **usage windows** exactly as `/accounts` shows them, under a «Usage (% used)» heading (`default — ⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h`; a signed-out account is named, one never polled is left out), then what the topic runs on and where its two settings come from. **Fallback models** — an ordered list of Claude accounts (with an optional model) and OpenCode providers with a model, top = preferred, where a topic continues when its agent hits a limit. One full-width button per entry (`1. Claude · work · opus ⛔ 14:00` — limited until, 🔒 not signed in, ❓ no longer offered, 🚫 left out of automatic switching, ✓ where the topic runs); a tap opens that entry in the same message with ⬆️ Up / ⬇️ Down, 🚫 Don't use / ✅ Use (a left-out entry stays usable by hand through `/model` and `/accounts`), 🗑 Remove and ⬅️ Back. Below the list: «➕ Add» (account or provider, then the model), «🔄 Fill from connected» (a draft from what is connected; entries you left out stay left out; asks first when a list exists), «🗑 Clear». The list is ONE instance-wide list and is editable from every topic. **Two settings** decide what a limit does: «🔁 Auto switch» — auto switch to a fallback model (OFF by default: the limit notice carries «🔁 Switch to …» buttons instead) and «⏳ Wait for reset» — wait for the reset and continue (ON by default; while a wait is armed the topic screen also offers «⏭ Skip once»). In General they are the defaults for all topics and each is one button that flips the value. In a regular topic each is one short full-width button showing the effective value (`🔁 Auto switch: ON`; one line of text above the list says where each value comes from — `🔁 as in General · ⏳ set for this topic`); a tap opens the setting in the same message with ON / OFF / «As in General (<the General value>)» — the topic's own choice marked ✓ — and ⬅️ Back, and a choice applies and returns to the screen. Switch ON: the topic moves to the first available entry at once. OFF: buttons on the notice, and if none is pressed the bot waits for the reset (waiting ON); both OFF: it only reports the limit. When every enabled entry, the current one included, is limited, the wait ends at the EARLIEST reset and the topic continues on that entry (the notice names it and the time). Text forms: `/limits rebuild`, `/limits clear`, `/limits switch on\|off\|same`, `/limits wait on\|off\|same`. `/fallback` and `/auto_continue_limits [on\|off]` still work as hidden aliases. See [Usage limits and the fallback models](#usage-limits-and-the-fallback-models-limits) |
| `/bind` | Bare: current binding + folder picker, with «leave current dir» (the old `/unbind`) and «create new folder» buttons |
| `/mcp` | List MCP servers active for this thread |

#### Info / ops (work anywhere)

| Command | Description |
|---|---|
| `/start` | Intro: work root + available agents |
| `/help` | Context-aware help |
| `/ls` | List the project subfolders of the folder the bot was launched from |
| `/list` | List existing topics and their bindings |
| `/status` | This topic's status; in General — a global view of all topics + active agents. A non-General topic also reports the account it runs on (Claude profile · email, ⛔ at its limit) and the resolved workdir; a live one the model actually running, runtime version and context use (unknown when the backend cannot report it) |
| `/doctor` | Self-diagnose: admin rights, privacy mode, paths, CLIs |
| `/version` | Versions: bot, claude, opencode, node, tmux |
| `/whoami` | Show userId, chatId, threadId, isAllowed, binding |
| `/trace` | Output-trace recorder (`on`/`off`, `on all`/`off all`; bare = status) — see [Observability](#observability) |
| `/timestamps` | Prepend the send time to prompts forwarded to the agent (`on`/`off`; bare = status) |
| `/language`, `/lang` | Set the bot UI language for this chat; bare opens an endonym picker (sorted A→Z by English name), `/language auto` returns to automatic per-chat detection |
| `/timezone` | Set the timezone every clock the bot touches speaks in — schedules, agent time context, time renders. `/timezone Europe/Moscow`, `/timezone +04:00`, `/timezone auto` (host zone); bare opens a region → zone picker. Instance-wide, not per chat |
| `/pair` | Bind this forum supergroup to the bot (re-point auto-pairing) — works from any topic of the target group; a numeric `ALLOWED_GROUP_ID` env locks pairing |

#### General-only

| Command | Description |
|---|---|
| `/quit-all`, `/quitall` | End every active agent in every bound topic (also releases their session ids) |

#### Natural language

In a bound topic you can also type:
- `claude fix the bug` / `opencode add tests`
- A plain message after `/claude` is already running → routed as input.

Voice messages are transcribed by the speech engines you set up with `/stt` (Groq,
OpenAI, any OpenAI-compatible server, or the local GigaAM engine — see [Voice input](SETUP.md#voice-input)) and follow
the same routing. The engines form an ordered chain: when one fails, the next one answers within the
same voice note. The last one retries a temporary failure automatically (after 5 s, then 15 s) and
says so in the topic — no need to re-record the voice note.

`/terminal` is never started from a natural-language phrase — only the
explicit command opens a shell.

### Claude Code backends (`/claude_mode`)

"Claude Code" in a topic is one user-facing choice with three interchangeable
backends:

- **json-stream** (`/claude_mode json`) — `claude -p` in stream-json mode as
  an external tmux-hosted process emitting structured events. Cleaner
  output, and it survives bot restarts (the bot re-adopts the process and
  replays what was produced during the downtime). After ~55 min idle
  (`AGENT_IDLE_MINUTES`) the process is stopped — right after the idle
  compaction when `/compact_on_idle` allows one. The **default**.
- **per-turn** (`/claude_mode per-turn`) — the same host, stopped right
  after every answer. Nothing is lost: the conversation sleeps and your next
  message resumes it. Needs Claude Code 2.1.287 or newer; the switch is
  refused when the topic's last known version is older.
- **tmux-scrape** (`/claude_mode tmux`) — the classic TUI driven by
  keystrokes inside tmux; output is scraped from the pane. Never stopped
  automatically.

A stopped json-stream conversation **sleeps**: `/status` says so, and the next
message, file, voice note, `/compact`, `/model` or `/effort` resumes it by
itself — same session, prompt cache still warm, no "started" notice. A
process is never stopped while it works (a running turn, a background task,
a message not yet taken in). Only `/quit`, `/new` and leaving the folder end
the conversation.

`/login` works on all three backends. tmux-scrape hosts the sign-in inside its
TUI; the json-stream backends (which have no TUI) run it **out-of-band** — the bot spawns
`claude auth login` in a pty, posts the sign-in link into the topic, and takes
your pasted code back (the code message is deleted and a 🔐 confirmation is
posted). While the sign-in waits for the code, a message that is not a code
is answered with a waiting hint instead of being swallowed; `/esc` cancels
the pending sign-in (the link message says so).

All three drive the same `claude` CLI against the same on-disk
transcript, so `/claude_mode` switches a live topic seamlessly — the
conversation resumes on the other backend. The pick persists per topic
(▶️ Claude and `/claude` reopen it; on a sleeping topic they resume it).
Billing note: the json-stream backends strip `ANTHROPIC_API_KEY` from the
agent's env, so usage bills to your Claude subscription rather than an API key.

### Several accounts (`/accounts`)

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
- **Switching:** tap a profile in `/accounts` (or `/accounts use <name>`). A
  running session on the default (stream) backend is restarted under the new
  account with the same conversation — right away when idle, at the end of its
  turn when it is working; a sleeping topic simply resumes under it. The
  tmux-scrape backend is reopened the same way when idle and waits for the next
  start when busy. In the **General** topic the pick is the default for all
  topics; a topic with its own pick keeps it («↩ Follow the default» drops it).
  A profile that is not signed in cannot be picked.
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
  agent asks; a json-stream session's own rate-limit events keep them current
  between polls. A token the CLI has not renewed yet shows the last figures as
  `(stale)`; a profile whose session was refused on a window is marked
  `⛔ at its limit until …` and is skipped by the recommendation below.
- **Another account takes over on a limit.** When a topic's account hits a
  usage limit the bot looks at the [fallback chain](#usage-limits-and-the-fallback-models-limits);
  without one it ranks the other signed-in profiles by headroom on the windows
  the topic's model drains (fresh figures, not marked limited). The limit
  notice carries «🔁 Switch to <entry>» buttons, best first: a tap moves the
  topic there (the running session is restarted under the new account with the
  same conversation), drops the wait for the reset and tells the agent to
  continue right away. With **switching** on («🔁 Auto switch to a
  fallback model» in `/limits`, or `/limits switch on`; in General the default for all
  topics) the bot does the same by itself and posts one short line — «Account
  «a» hit its usage limit — this topic continues on «b». The limit resets
  <time>; switch back: /accounts». The target is named by its account alone
  and gets its model only when the switch changes it («b» (sonnet)); an
  OpenCode target reads «OpenCode provider/model». It is OFF by default: moving
  work between subscriptions is your call. The exhausted profile is marked
  limited until its window resets, so it is not picked again before then; the
  topic is never moved back by itself — switch it back by hand when the window
  resets. Every switch (automatic, from a button, or your own pick during the
  wait) is remembered per topic, and `/accounts` in that topic then shows one
  button on top, «↩️ Back to «a» (limit resets <time>)» — the reset only while
  that account is still limited, a tap always switches. It works in every
  direction, to or from OpenCode too, and moves the topic through the same
  move the limit switch uses, without a «continue» message (nothing was
  interrupted). It is forgotten once the topic goes back or you change the
  topic by hand — an account pick that moves it, a model, another agent
  (`/claude`, `/opencode`) — and it survives a restart. In General nothing
  changes. When nothing can take over the bot waits for the reset as before. A
  Claude session that works when a limit hits is moved at once (the turn is
  dead; background tasks it started are stopped and the notice says so); only a
  tmux Claude session with nothing to resume yet is left to the end of its turn.
- **Which account for a child process.** An agent that launches a detached
  `claude` (a worker, a reviewer) asks the bot's `telegramBot` MCP tool
  `claude_profiles` — optionally with the model it will run — and gets every
  profile with its windows plus `recommended`: the signed-in, unlimited profile
  with the most headroom (Fable → Fable's weekly window and the session window;
  any other model → the shared weekly window and the session window). It then
  starts the child with `CLAUDE_CONFIG_DIR=<configDir>` (`null` = the default
  profile: set nothing). The same answer from a shell, for a worker without
  MCP: `charness claude-profiles [--best] [--model <name>] [--json]` —
  `--best` prints just the directory (an empty line for the default), so
  `CLAUDE_CONFIG_DIR="$(charness claude-profiles --best --model fable)"`
  works as is; it reads the bot's cache off `DATA_DIR/state.json`.

### Usage limits and the fallback models (`/limits`)

When a topic's agent stops on a usage limit — a Claude account window, an
OpenAI quota through OpenCode, a Google `RESOURCE_EXHAUSTED` — the bot can keep
the work going somewhere else instead of waiting. `/limits` holds ONE
instance-wide, ordered list of **fallback models** (where to go), top = preferred:

- **Left out of switching.** ✅ / 🚫 on a row includes or excludes that entry from
  automatic switching and from the notice's switch buttons. A connected
  provider (say OpenAI on OpenCode) can stay usable by hand through `/model`
  while the bot never moves a limited topic onto it. With an EMPTY chain the
  bot still ranks the other signed-in Claude accounts by headroom; once the
  chain has entries, only its ✅ entries count — all of them left out means
  no switch, the wait stands.
- **Entries.** A Claude account profile (`/accounts`) with an optional model
  (`fable`, `opus`, `sonnet`, `haiku`; «keep the topic's model» otherwise), or
  an OpenCode provider with a model (`openai/gpt-5`, `google/gemini-2.5-pro`,
  …). Only what is actually connected is offered: the signed-in profiles, and
  the providers the OpenCode server is authenticated for (its live catalog).
- **Drafting.** «🔄 Fill from connected» (or `/limits rebuild`) writes a draft from what
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
  setting (auto switch to a fallback model) applies: OFF (the default) puts «🔁 Switch to …» buttons on the
  limit notice, ON switches by itself. No entry available → the wait
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
  takes over, the previous agent's last turns verbatim, and the instruction to
  check the project state (git status / diff / log) before carrying on and to
  report in one short message what the task is, what is done and what remains.
  A later `/claude` or `/opencode` returns to the parked conversation; `/new`
  and `/quit` release it as usual.
- The topic is **never moved back by itself** when the exhausted entry resets
  — the switch notice names the reset time; switch back by hand (`/accounts`,
  `/model`, `/claude`, `/opencode`).

### Scheduler (`/schedule`) (Telegram)

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
  counted separately, see below).
- Restart-safe: timers re-arm at boot; a run missed during downtime fires
  one catch-up annotated with the missed time.
- Leaving a folder pauses the topic's scheduled prompts; `/bind` resumes
  them (an expired one-shot is dropped). Reminders keep running — see
  below. Run history: `DATA_DIR/scheduler-runs.jsonl`.

### Reminders (`/reminders`) (Telegram)

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

### Raw terminal (`/terminal`) (Telegram)

`/terminal` binds the topic to a real interactive `$SHELL` (in tmux) in the
bound folder — a third backend alongside the agents, mutually exclusive
with them. Every plain message is typed in as a command; output streams
back as one rolling message per command. Raw keys reuse the TUI commands:
`/c` (Ctrl-C), `/up` `/down` (history), `/tab` (completion), `/enter`.
Restart-safe like the agents: the shell survives a bot restart and is
re-adopted. Known v1 limitation: full-screen TUIs (vim, htop, less) render
messy; normal commands, builds, and logs stream cleanly. The shell comes
from the `SHELL` env (fallback `/bin/bash`).

### File intake (Telegram)

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

### Observability

- **Output trace** (Telegram) — ON by default for every thread: each incoming update,
  adapter emit, and outgoing Bot API call (with outcome, incl. 429 details)
  is recorded into hourly buckets `DATA_DIR/output-trace-*.jsonl` (pruned
  after 6h). `/trace off all` turns it off durably; bare `/trace` reports
  status. This is the source of truth when debugging "a message never
  reached the topic".
- **Console tee** — the bot's stdout/stderr is mirrored to
  `DATA_DIR/bot-console-*.log` (same hourly buckets, same 6h prune), so
  boot logs stay readable post-incident without the operator's terminal.
- **`/timestamps on`** (Telegram) — prepends each forwarded prompt's send time
  (local-offset ISO) so a days-long session knows what "yesterday" means.
  Agent-facing only, default off, persisted per topic.

### Timezone (Telegram)

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

### Bot-injected agent tools

The bot injects its own `telegramBot` MCP server into every bot-started session
— for Claude via a generated `--mcp-config`, for OpenCode via runtime
registration. It is loopback-only (`127.0.0.1`, on an OS-chosen free port unless
`SCHEDULER_MCP_PORT` explicitly pins one) and authenticated with per-session
HMAC bearer tokens scoped to the thread / directory. Every generated registration
also carries a unique client identity, so cancellation affects only the originating
agent even when two clients use the same JSON-RPC request id. It exposes:

- `schedule_create` / `schedule_list` / `schedule_cancel` — the agent-side
  scheduling API behind `/schedule`;
- `compact_conversation` — lets the agent compact its OWN session when you ask it
  to in plain words ("compact our conversation"). It arms the compaction and
  returns immediately; the bot runs the real compaction the moment the current
  turn finishes (never mid-turn);
- `send_file_to_user` — lets the agent push files from the bound folder into the
  topic. A single MP4 uses Bot API `sendVideo`; eligible all-video and mixed
  photo/video albums use `sendMediaGroup`, with each MP4 represented by an
  `InputMediaVideo` entry. `as_file:true` explicitly forces documents. Secure
  outbound file traversal currently requires Linux; on macOS this tool
  fails closed until a native descriptor-relative bridge is available. Existing
  path, count, caption, and size caps apply; canonical upload basenames have
  control characters and quoted-string metacharacters replaced before they enter multipart headers. Cancelling
  the MCP call removes queued work. While any upload stream is still being
  consumed, cancellation destroys the streams and aborts Telegraf, then returns
  `AbortError` after terminal cleanup. Once every request-body stream has ended,
  cancellation is too late to abort safely: the operation awaits Telegram's
  response, and any returned message IDs are durably recorded before success.
  Directory-scoped
  calls re-check the topic binding both before opening files and inside the
  per-topic delivery queue immediately before dispatch, so a queued call cannot
  continue after the topic is rebound elsewhere. Delivery and its durable
  `/clear_messages` tracking update share one per-topic queue transaction; the
  complete response-ID batch is on disk before success is reported. If Telegram
  has accepted a delivery but local tracking/cleanup then fails, the tool returns
  success with a warning and never retries. If the connection fails after an
  upload starts and Telegram's response never arrives, the tool returns a
  machine-readable, non-error `deliveryUnknown` outcome with `retryable:false`,
  preventing accidental duplicates.
- `send_messages_to_user` — delivers a batch of DISCRETE messages into the topic,
  each item posted as its OWN Telegram message in order (never merged) — for a
  per-item digest and similar. Each item is either a plain text string OR an
  object `{text?, path?, as_file?}` that may carry ONE attachment: a `path` item
  reuses the SAME secure `send_file_to_user` pipeline (path relative to the bound
  folder, supported photos inline, `.gif` as animation, `.mp4` as video, everything else a document,
  `as_file` forces a document), with `text` used as the media caption (trimmed to
  1024 chars — send long prose as its own text-only item). Items are validated up
  front (an empty object is rejected and nothing is sent); a total send failure
  returns an error, a partial one stays successful but reports how many landed,
  and an ambiguous attachment delivery surfaces as the same non-retryable
  `deliveryUnknown` outcome as `send_file_to_user`. Capped at 50 items per call.

This server is bot-owned plumbing; if its port fails to bind, the bot still
boots — only these agent-facing tools go inert. (Your own MCP servers still work
independently: Claude auto-loads them from `~/.claude/settings.json` and a
project's `.mcp.json`; inspect what's active in a thread with `/mcp`.)

Third-party OpenCode MCP servers, including a separate `telegram-mcp`, belong to
the OpenCode configuration of the Linux user that runs the bot. They are not
injected by Charness; run `opencode mcp list` as that user to verify them.

### Restart behaviour

Bot restarts are designed to be invisible: agents run in external
processes (`tmux`, `opencode serve`), so the bot re-adopts them instead
of killing them. In hot mode the long-lived supervisor starts the initial
`opencode serve` before `nodemon`, outside the replaceable worker's process
tree. If a worker later starts a replacement server after a crash, credential
reload, or late install, a one-shot host reparents that generation outside the
same tree before startup completes. An endpoint-bound process identity file
under `DATA_DIR` records a bot-started generation as `starting` before its host
releases it, then promotes it to `ready` after health succeeds. A successor can
therefore stop a pre-bind startup by its process-group identity, while `ready`
or adopted ownership is revalidated against the exact hostname and port before
a signal is sent, without trusting a reused PID or assuming an adopted listener
owns its process group.
A source rebuild therefore does not terminate an in-flight OpenCode turn.
The supervisor reads the same checkout `.env` as the worker before the initial
start. Hot mode supports Linux and macOS; it refuses to start on Windows because
nodemon cannot gracefully drain its worker tree there.
On boot the bot:

1. Loads `state.json` (archives to `state.json.corrupted-<ts>` if parse
   fails, then starts fresh and notifies in General) and classifies the
   boot as a hot reload vs cold start from the persisted heartbeat gap.
2. Re-adopts live sessions per backend:
   - **Claude tmux-scrape** (`claude-…`) and **terminal** (`term-…`)
     sessions still in `state.json` are re-attached; orphan bot-owned
     tmux sessions are killed. The current pane seeds the baseline, so
     nothing is re-flooded into the topic.
   - **Claude json-stream** (`cjson-…`) runs as an external process
     (stdin held on a FIFO, stdout appended to a file), so the restart
     never kills it: the bot adopts it and replays the downtime tail
     from the persisted offset — an in-flight turn is delivered
     end-to-end, and a pending interactive question is restored from its
     on-disk sidecar. A topic whose process is gone (stopped at the idle
     mark, or after its turn in per-turn mode) is NOT restarted at boot:
     it sleeps, and your next message resumes it. An adopted process
     started under an earlier bot build keeps that build's bot tools, so it
     is stopped once idle and resumed with the current ones.
   - **OpenCode** threads re-resume their stored session ids over the
     shared SSE stream. `opencode serve` itself is reconciled: a dead
     server is auto-restarted and the sessions restored (the in-flight
     reply is lost); a live server running an outdated binary is killed
     and respawned on the current one.
3. Re-arms pending API-error retries and scheduler timers; a run missed
   during the downtime fires one catch-up annotated with the missed time.
   A usage-limit wait that the previous process never recognised is also
   picked up: for a Claude json-stream topic the bot re-reads the tail of
   the session's output log and arms the resume itself (only for a limit
   error younger than 12 hours, only when nothing is armed already, and
   never the same one twice — a resume you skipped stays skipped).
4. Stays silent on a quiet hot reload; a bounded recap of missed output
   is posted only when the agent kept working while the bot was down.
5. Schedules `setMyCommands` so the Telegram client picks up the menu.

Explicit `/quit`, `/quit-all`, and leaving a folder (the `/bind` «leave
current dir» button) release the persisted session ids — those sessions
are not auto-reattached on the next boot (they stay reachable via
`/sessions`).

Closed-but-not-deleted topics keep their binding; only `400: message
thread not found` from a send triggers binding cleanup. Closed topics
are detected by `TOPIC_CLOSED` errors and surface a friendly message
asking the user to reopen.

In the Docker container (see [Run with Docker](SETUP.md#run-with-docker)) the same holds for a bot restart
inside the container; a restart of the container itself ends every agent process, and each conversation
resumes with its next message.

If you run the bot under `systemd`/`systemd-run`, set `KillMode=process`.
The default `control-group` mode kills tmux and `opencode serve` children,
which defeats restart/reattach. Process restarts intentionally leave agent
sessions alive; use `/quit` or `/quit-all` when you want to terminate them.

### Troubleshooting

#### Bot doesn't see text (Telegram)

You disabled privacy mode in @BotFather **after** adding the bot. The
flag is cached on join. Fix:

1. Remove the bot from the group.
2. (Re-confirm in @BotFather → `/setprivacy` → this bot → `Disable`.)
3. Add the bot back.

Verify with `/doctor` — the privacy line should report it as disabled.

#### `/bind` says "folder not found" (Telegram)

The folder you launched from doesn't contain a subfolder with that name (or
it's a symlink pointing outside it). Run `/ls` to see what's available, or fix
the host path. Path-traversal attempts (`../`, absolute paths,
NUL bytes, NFC-vs-NFD mismatches) are rejected by design — see
`validateSubdir` in `src/validation.ts`.

#### "Missing right" / `/clear_messages` does nothing (Telegram)

The bot needs admin rights `can_delete_messages` and `can_pin_messages`
in addition to `can_manage_topics`. Open group settings → admins →
the bot → tick the missing boxes. `/doctor` shows the exact gap.

#### Two instances on the same machine fight each other

You forgot to set distinct `DATA_DIR` and `OPENCODE_URL`. The bot logs
`[startup] DATA_DIR=<path>` on boot — if both instances log the same
path, give each its own `DATA_DIR` and `OPENCODE_URL` port and restart both.

#### Claude opens a session picker instead of resuming

The 1.x adapter invoked `claude --resume` with no UUID and relied on the
interactive picker, which doesn't survive a non-interactive pty. 2.0
generates a UUID with `crypto.randomUUID()`, passes it via
`--session-id`, and resumes via `--resume <uuid>`. If you see a picker
anyway, your local claude CLI is older than 2.1.x — upgrade with
`npm i -g @anthropic-ai/claude-code` (the bot also auto-installs on
first use, see `src/installManager.ts`).

#### OpenCode "address already in use"

Two instances on the same host with the same `OPENCODE_URL`. Pick a
different port for the second instance (e.g. `4097`).

### FAQ

**How do I run Claude Code from my phone?**
Install Charness on your own machine or VPS, create a Telegram bot, and bind a forum topic (or the bot's DM) to a project folder. Start a Claude Code session in that topic and you drive it entirely from Telegram: type prompts, send voice notes, or drop in files, and the agent's output streams back into the same topic. Your phone never runs the agent; it stays on your machine.

**Can I control OpenCode without opening any ports?**
Yes. The bot only makes outbound connections to Telegram, so nothing listens for inbound traffic and you never expose a port. OpenCode runs as a local HTTP server that the bot talks to on loopback, and you reach it from anywhere through Telegram.

**How do I run a coding agent on a VPS and drive it from Telegram?**
Set up your VPS once with git, your repos, the agent CLIs, and `charness`, then launch the bot from your projects folder. You get an always-on dev box you drive from any device: phone, tablet, or voice. Because the agent lives on the server, it keeps working even when your laptop sleeps, and the same sessions are still reachable over plain SSH.

**Does my session survive a restart?**
Yes, both a bot restart and an agent-server restart. State is persisted to disk; on restart the bot re-attaches to the running Claude session in tmux or re-connects to OpenCode, and an in-flight turn is delivered once it is back. A prompt sent during startup is buffered and replayed, never dropped.

**Does it run both Claude Code and OpenCode?**
Yes. Each topic picks its backend independently: OpenCode over its native HTTP+SSE server, or Claude Code (tmux or json-stream). One topic is one project with its own isolated session, like terminal tabs, and two topics can point at the same folder for parallel work.

**Can I talk to the agent by voice?**
Yes. Send a voice message to a topic and it is transcribed (by Groq, OpenAI or your own Whisper-compatible server) and forwarded to the agent as a normal prompt, so you can vibe code hands-free from your phone.

### Documentation

- **[SETUP.md](SETUP.md)** — installing and configuring: Telegram, Jira, environment, updating; Docker as an alternative to npm.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — architecture and local development (build, test, hot-reload, Docker dev loop).
- **[MIGRATION_1_TO_2.md](MIGRATION_1_TO_2.md)** — upgrading a 1.x install to 2.0.

### The story behind it

I started running Claude Code on my own machine, and I kept wanting to check on it after I stepped away from the desk. Back then there was no way to reach it from a phone, so I put together a small bot that launched the agent and let me talk to it over Telegram. It ran on my own computer, which had to stay on the whole time.

Then I moved the whole thing onto a server that never sleeps, added OpenCode next to Claude Code, and it grew into what it is now: voice control, file intake, scheduling, a raw terminal, and sessions that survive restarts. These days I run it every day and drive everything from my phone or tablet, no laptop required.

The project was called TelegramCode before it became Charness: its npm package was `telegramcode` up to 2.0.3 and is `charness` since 3.0.0.

Full write-up: [Vibe-coding by voice, from my phone](https://dev.to/olosegres/vibe-coding-by-voice-from-my-phone-claude-code-and-opencode-over-telegram-j75).

### License

MIT
