<h1 align="center">Charness</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/charness"><img src="https://img.shields.io/npm/v/charness?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/charness"><img src="https://img.shields.io/node/v/charness?logo=node.js" alt="Node.js version"></a>
  <a href="https://github.com/olosegres/charness/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/charness" alt="license"></a>
</p>

<h2 align="center">Harness for running Claude Code / OpenCode agents in the cloud or on your laptop, controlled from Telegram or Jira.</h2>

**Charness is a gateway that controls all your Claude Code and OpenCode sessions.** It runs them for you and brings their controls to the entry point you prefer — Telegram and Jira are supported now.

- **In Telegram** you control your agents through a bot or a group, so it becomes a terminal for OpenCode and Claude Code — every thread is like a terminal tab, plus scheduling and voice control.
- **In Jira** it starts an agent when you assign a ticket to a special user: the agent reads the description, comments and attachments and does the work according to the ticket's status — like a real employee.

*In Telegram it may literally become your J.A.R.V.I.S. 😄 You talk — Charness does the rest. Send a voice note from the street — and an agent on your server opens the browser, calls your APIs, writes code, edits a video, drafts a post, generates an image, answers your email or messages someone for you, and sends you the result. It never sleeps: it keeps working while you do. Plug in a tool — and that becomes one more thing it can do.*

<p align="center">It runs fine on your laptop. But it is called a <b>c</b>loud <b>harness</b> for a reason — put it on a VPS or VDS and your agents keep working while the laptop sleeps. Give an agent a cron schedule and it takes on a recurring task by itself, in the background, while you do something else.</p>

<p align="center">
  <img src="docs/images/hero-v2.png" alt="Charness — all your agents in Telegram; chat, code, ship; powerful slash commands" width="900" />
</p>

## Use cases

One topic is one AI pipeline: its own project folder, its own agent, its own schedule and checks. Some ways to use it:

- **Development** — fix bugs, review changes and work through Jira issues: assign a ticket to the agent's user, or drive it from a topic by text or voice.
- **Marketing** — a topic with the product docs and brand notes: the agent drafts copy, landing-page variants and campaign plans and sends the files back.
- **Blogging and content** — draft, edit and illustrate posts in one folder; a scheduled agent can prepare the next draft or the content plan every week.
- **Research** — an agent reads the sources and papers in a notes folder and keeps a running write-up; ask follow-ups in the same topic.
- **Video production** — scripts, cuts, subtitles and renders on a server with the tools installed; the agent sends the finished clips back into the topic.
- **Images** — with an image tool or model connected (an MCP server or a CLI on the server), the agent generates pictures and sends them into the topic.
- **Email and messengers** — with a mail or messenger tool connected (an MCP server), the agent answers an email or sends a message for you; ask it by voice, check the result in the topic.
- **Monitoring and on-call** — a scheduled check runs a command (a service, a deploy, a disk, a URL), stays silent while it passes, and on the first failure tells the topic in one line and wakes the agent with the output.
- **Personal assistant and planning** — reminders and recurring tasks: a morning plan, a weekly review, a "finish this tomorrow at 9" hand-off, all by voice from your phone.
- **Data analysis and reports** — drop a spreadsheet or a CSV into the topic; the agent analyses it and sends back charts and a report, and a cron job rebuilds the report every week.
- **Translation and localization** — an agent keeps a project's locale files in sync: translates new strings and checks the existing ones.
- **Inbox triage and support** — a scheduled agent sorts incoming messages or support requests (through the MCP servers you connect), drafts replies and posts what needs a human.
- **News aggregation** — a morning digest in a topic: the agent collects the sources you list and posts them as one digest message.
- **Tracking new research and publications** — arXiv, blogs, releases of the tools you depend on: a scheduled agent checks them and posts a short summary of what is new.

## Quick start

1. `npm install -g charness` (needs Node ≥ 22.12).
2. Put your bot token (from [@BotFather](https://t.me/BotFather)) into `~/.config/charness/.env` as
   `TELEGRAM_BOT_TOKEN=…`.
3. Run `charness` from the folder that holds your projects: `cd ~/projects && charness`.
4. In your Telegram group (or the bot's DM): `/bind <subfolder>` in a topic, then `/claude` or `/opencode` and
   talk to the agent — text or voice.

Full setup — Telegram, Jira, environment, updating: [SETUP.md](SETUP.md)

**Platforms:** Linux, macOS, and Windows via WSL2 — on Windows WSL2 is the recommended and fully supported way
([Windows (WSL2)](SETUP.md#windows-wsl2), with a recipe for an always-on PC with no monitor). Native Windows works with
limits: OpenCode runs, but Claude and `/terminal` need tmux, a self-update cannot restart the bot in place, hot mode refuses
to start and the local speech engine cannot be installed. A native Windows bot says so at start (console, General, `/doctor`).

## FAQ

**How do I run Claude Code from my phone?**
Install Charness on your own machine or VPS, create a Telegram bot, and bind a forum topic (or the bot's DM) to a project folder. Start a Claude Code session in that topic and you drive it entirely from Telegram: type prompts, send voice notes, or drop in files, and the agent's output streams back into the same topic. Your phone never runs the agent; it stays on your machine.

**Can I control OpenCode without opening any ports?**
Yes. The bot only makes outbound connections to Telegram, so nothing listens for inbound traffic and you never expose a port. OpenCode runs as a local HTTP server that the bot talks to on loopback, and you reach it from anywhere through Telegram.

**How do I run a coding agent on a VPS or VDS and drive it from Telegram?**
Set up your VPS once with git, your repos, the agent CLIs, and `charness`, then launch the bot from your projects folder. You get an always-on dev box you drive from any device: phone, tablet, or voice. Because the agent lives on the server, it keeps working even when your laptop sleeps, and the same sessions are still reachable over plain SSH.

**Does my session survive a restart?**
Yes, both a bot restart and an agent-server restart. State is persisted to disk; on restart the bot re-attaches to the running Claude session in tmux or re-connects to OpenCode, and an in-flight turn is delivered once it is back. A prompt sent during startup is buffered and replayed, never dropped.

**Does it run both Claude Code and OpenCode?**
Yes. Each topic picks its backend independently: OpenCode over its native HTTP+SSE server, or Claude Code (json-stream, or the deprecated tmux). One topic is one project with its own isolated session, like terminal tabs, and two topics can point at the same folder for parallel work.

**Can I talk to the agent by voice?**
Yes. Send a voice message to a topic and it is transcribed (by Groq, OpenAI or your own Whisper-compatible server) and forwarded to the agent as a normal prompt, so you can vibe code hands-free from your phone.

**Can agents work in the background or on a schedule?**
Yes. `/schedule` arms cron, one-shot or N-times jobs per topic, so a scheduled agent can do recurring tasks — a nightly review, a morning digest, a weekly report — while you are away, and the agent can schedule itself. A scheduled check watches a service and wakes the agent only when it fails. Jobs survive a bot restart, and a run missed while the bot was down fires once as a catch-up.

## Reference

### Features

The same core serves every surface; each feature links to the commands that drive it ([all commands](docs/commands.md)).

#### Any surface

| Feature | What it does | Commands and docs |
|---|---|---|
| Agent backends | OpenCode (native server API over HTTP+SSE) and Claude Code (three backends — json-stream, per-turn and the deprecated tmux) | [`/claude`, `/opencode`](docs/commands.md#claude-opencode-oc), [`/claude_mode`](docs/commands.md#claude_mode), [`/model`](docs/commands.md#model), [`/effort`](docs/commands.md#effort), [backends](docs/backends.md) |
| Sleeping agents | A Claude json-stream topic's process is stopped when idle (or after every turn in per-turn mode) and the next message resumes the same conversation by itself, prompt cache still warm | [`/claude_mode`](docs/commands.md#claude_mode), [`/status`](docs/commands.md#status), [`/quit`](docs/commands.md#quit-q) |
| Several Claude accounts | Keep more than one Claude subscription signed in side by side and choose per topic which one a session runs on; every account's usage windows are shown next to it, and `/limits` is a one-tap switch board over all of them and over the OpenCode providers | [`/accounts`](docs/commands.md#accounts), [`/limits`](docs/commands.md#limits) |
| Waits out usage limits | When the agent hits a usage / session limit the bot waits for the reset and tells the agent to continue by itself; with a fallback list of other Claude accounts, OpenCode providers and models it moves the topic to the next entry with room and continues at once — or offers you the switch with a tap | [`/limits`](docs/commands.md#limits), [`/limits_autoswitch`](docs/commands.md#limits_autoswitch) |
| Updates itself | Checks for a new version hourly, installs it when no agent is working, restarts in place (agents keep running) and says in General what changed; npm installs and git checkouts, hot mode and Docker included | [`/update`](docs/commands.md#update), [Updating](SETUP.md#updating) |
| Restart-safe | Agents run as external processes (tmux, `opencode serve`) that the bot re-adopts after a restart instead of killing them; a prompt sent while a session boots is buffered and replayed | [Restart behaviour](docs/backends.md#restart-behaviour) |
| Shared todo lists | Every agent publishes a short stand-up list of what it is working on (in work, the queue, done), and the agents of one repository see each other's lists with every prompt, so two of them never fix the same thing unknowingly | [`/todo`](docs/commands.md#todo) |
| Compaction | Compact an agent's context by hand, after ~55 min idle, or by the agent's own request | [`/compact`](docs/commands.md#compact), [`/compact_on_idle`](docs/commands.md#compact_on_idle), [`/compact_summary`](docs/commands.md#compact_summary), [`/compact_self_review`](docs/commands.md#compact_self_review) |
| Tools and skills for agents | Every session the bot starts gets the bot's own MCP tools (schedule, todo, send files) and the manager / delegate skills | [Bot-injected agent tools](docs/backends.md#bot-injected-agent-tools), [`/bot_skills`](docs/commands.md#bot_skills) |
| Runners for heavy commands | Agents send a test suite, a build or an emulator run to another machine: `charness remote-run` syncs the project, runs the command there and brings back the output, the exit code and the result files you declare, and `remote-run runners` shows every machine's CPU, memory, disk, load and what it can do (Android, iOS, Docker, Playwright). Attach a machine by pasting one line from `/runners` on it — no VPN, no open port, no root on this machine; a machine you reach by plain ssh works too | [`/runners`](docs/commands.md#runners), [docs/remote-run.md](docs/remote-run.md), [SETUP.md](SETUP.md#runners-for-heavy-commands-remote-run) |
| Jira | An issue is a conversation: assign a ticket to the agent's user and it works it; a cap on how many issues work at once | [Jira setup](SETUP.md#jira-setup), [`/task_agents`](docs/commands.md#task_agents) |

#### Telegram

Charness turns Telegram into a terminal for running agentic CLIs. Open as many tabs as you need — even two on the same project for parallel work — and drive the agents from your phone or tablet, voice messages included.

Think **OpenClaw for vibe coding**, driven entirely from Telegram: no complex setup, no extra dashboards — direct access to your own **OpenCode** / **Claude Code** running on your machine or server.

| Feature | What it does | Commands and docs |
|---|---|---|
| Simple setup & management | Install the CLI, put your bot token in one `.env`, bind a topic to a folder, and run; everything after is managed from Telegram — no dashboards | [Quick start](#quick-start), [SETUP.md](SETUP.md), [`/doctor`](docs/commands.md#doctor) |
| Multi-thread / topic | One topic per directory with your agent; two topics can share one folder for parallel work — run almost unlimited agents in parallel | [`/bind`](docs/commands.md#bind), [`/topic`](docs/commands.md#topic), [`/list`](docs/commands.md#list) |
| Two chat surfaces | Forum-group topics and the owner's bot DM, both served at once by default, with tabs on either | [Two surfaces](docs/backends.md#two-surfaces-group-topics-bot-dm-or-both) |
| Raw terminal | A topic bound to a real `$SHELL` in the project folder | [`/terminal`](docs/commands.md#terminal) |
| Notifications | When the agent asks a question, the bot pins that message so even a muted topic notifies you: the pin pierces mute, giving exactly one notification per question (unpinned once it ends). A question is never deleted: it stays in the topic as the agent asked it, and in place of its buttons it shows the answer you tapped — or, when you walked away from it, a note that it was left unanswered | — |
| Scheduled & self-driving runs | `/schedule` arms cron / one-shot / N-times jobs per topic, and the agent can schedule *itself* via injected MCP tools: nightly reviews, recurring reports, a "finish this tomorrow at 9" hand-off, checks that wake the agent on failure. Each job fires as a fresh session with your prompt; restart-safe, with one catch-up for a run missed while the bot was down | [`/schedule`](docs/commands.md#schedule) |
| Reminders | A plain reminder set with inline buttons (how often, which day, what time, then the text by typing or voice); at the due time the bot posts and pins it itself, so even a muted topic notifies you. No agent, no bound folder, no date parsing — works in any topic, General included | [`/reminders`](docs/commands.md#reminders) |
| Inbound files | Photos / documents / video / audio sent to a topic are saved and announced to the agent; albums arrive as one prompt | [File intake](docs/commands.md#file-intake) |
| Outbound files | The agent sends files back to you — a generated chart, a screenshot, a log, a rendered PDF — single files or albums, straight into the topic | [Bot-injected agent tools](docs/backends.md#bot-injected-agent-tools) |
| Voice input | Voice notes are transcribed by an ordered chain of engines — Groq, OpenAI or your own OpenAI-compatible server — set up in `/stt` (or `stt.json`); a local GigaAM engine is optional; if one fails, the next takes over | [`/stt`](docs/commands.md#stt), [Voice input](SETUP.md#voice-input) |
| Display verbosity and view | Per topic: detail `minimal\|short\|full`, and what the topic shows — `stream` (default), `stream_answers` or `answers` (only the agent's pinned answers, no stream) | [`/verbosity`](docs/commands.md#verbosity), [`/thinking`](docs/commands.md#thinking), [`/tool_results`](docs/commands.md#tool_results), [`/subagent`](docs/commands.md#subagent) |
| Time-aware prompts | `/timestamps on` prepends each forwarded prompt's send time (local-offset ISO), so a days-long session knows what "yesterday" or "2 days ago" means; agent-facing only, per topic | [`/timestamps`](docs/commands.md#timestamps) |
| Reply context | Reply to a message in a topic and the quoted text is folded into the prompt the agent receives, so it sees what you point at without re-pasting, and who wrote it — a message of somebody who may not talk to the agent is quoted as untrusted text; works for text, voice and files, both agents | [Reply context](docs/commands.md#reply-context) |
| Talkers | An admin lets a group member talk to the agent in ONE topic (or in every topic, from General's list) without making them an admin: `/access` adds them with a tap, a reply or an @username, after a warning that they can make the agent run any command in the folder; the agent reads their words under a mark that says they are not the operator | [`/access`](docs/commands.md#access), [Who may write in a topic](docs/commands.md#who-may-write-in-a-topic) |
| Forwarded messages | Forward a message into a topic and the agent is told it is forwarded, from whom and when it was originally sent — so a forwarded alert or quote is never read as your own words; works for text, voice and files, both agents | [Forwarded messages](docs/commands.md#forwarded-messages) |
| Your timezone | `/timezone Europe/Moscow` once, and schedules fire at your wall-clock time while the agent is told what time it actually is; no server-clock guessing | [`/timezone`](docs/commands.md#timezone) |
| Observability | An always-on output trace and a console log, the source of truth for "a message never reached the topic" | [`/trace`](docs/commands.md#trace), [`/doctor`](docs/commands.md#doctor), [Troubleshooting](docs/troubleshooting.md) |
| Languages | The bot speaks 12 languages, detected per chat and set with `/language` | [`/language`](docs/commands.md#language-lang) |

### Documentation

- **[docs/commands.md](docs/commands.md)** — every command, one section each, with the features behind it: accounts, usage limits and fallback, scheduler, reminders, todo lists, timezone, skills, file intake.
- **[docs/backends.md](docs/backends.md)** — Claude Code and OpenCode backends, restart behaviour, the tools the bot injects into every agent session, and the two Telegram surfaces (group topics, the bot's DM).
- **[docs/remote-run.md](docs/remote-run.md)** — running heavy commands on another machine: pairing a runner, keeping it running, a plain-ssh runner and `runners.json`, `.remote-run`, every `charness remote-run` command, exit codes, what is never sent.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — the bot doesn't see text, `/bind` can't find a folder, missing rights, two instances on one machine.
- **[SETUP.md](SETUP.md)** — installing and configuring: Telegram, Jira, environment, updating; Docker as an alternative to npm.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — architecture and local development (build, test, hot-reload, Docker dev loop).
- **[MIGRATION_1_TO_2.md](MIGRATION_1_TO_2.md)** — upgrading a 1.x install to 2.0.
- **[MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md)** — upgrading an install that still uses the TelegramCode names.

## The story behind it

I started running Claude Code on my own machine, and I kept wanting to check on it after I stepped away from the desk. Back then there was no way to reach it from a phone, so I put together a small bot that launched the agent and let me talk to it over Telegram. It ran on my own computer, which had to stay on the whole time.

Then I moved the whole thing onto a server that never sleeps, added OpenCode next to Claude Code, and it grew into what it is now: voice control, file intake, scheduling, a raw terminal, and sessions that survive restarts. These days I run it every day and drive everything from my phone or tablet, no laptop required.

The project was called TelegramCode before it became Charness: its npm package was `telegramcode` up to 2.0.3 and is `charness` since 3.0.0.

Full write-up: [Vibe-coding by voice, from my phone](https://dev.to/olosegres/vibe-coding-by-voice-from-my-phone-claude-code-and-opencode-over-telegram-j75).

## License

MIT
