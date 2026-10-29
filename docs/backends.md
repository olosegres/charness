# Agent backends

Charness is a proxy between a chat (a Telegram topic, a Jira issue) and an agentic CLI. This page describes the backends it
drives — **Claude Code** (three interchangeable backends) and **OpenCode** — how they behave when the bot restarts, and the
tools the bot injects into every agent session. Alongside the agents there is one non-AI backend, the raw shell of
[`/terminal`](commands.md#terminal). The last section is about the two Telegram surfaces a topic can live on: a forum group or the bot's DM. The commands are in [commands.md](commands.md); installing and configuring is in
[SETUP.md](../SETUP.md); the overview is the [README](../README.md).

## Claude Code backends (`/claude_mode`)

"Claude Code" in a topic is one user-facing choice with three interchangeable
backends:

- **json-stream** (`/claude_mode json`) — `claude -p` in stream-json mode as
  an external tmux-hosted process emitting structured events. Cleaner
  output, and it survives bot restarts (the bot re-adopts the process and
  replays what was produced during the downtime). After ~55 min idle
  (`AGENT_IDLE_MINUTES`) the process is stopped — right after the idle
  compaction when `/compact_on_idle` allows one — but never while the agent's
  own work is pending: a background command, Monitor or sub-agent it started, a
  finished task's result it is about to read, a `CronCreate` job or a `/loop`
  wakeup it scheduled.
  That work keeps the process for up to 6 h after the agent's last turn, so a
  task nobody hears from does not keep it forever. When that work is lost
  anyway (a crash, a process gone after a restart, a `/model` / `/effort` /
  account restart, a task let go after 6 h), the topic gets one plain line and
  the agent is resumed with a note to check that work again — or, after a
  forgotten task or a second loss within 10 minutes, your next message carries
  the note. The **default**.
- **per-turn** (`/claude_mode per-turn`) — the same host, stopped right
  after every answer. Nothing is lost: the conversation sleeps and your next
  message resumes it. Needs Claude Code 2.1.287 or newer; the switch is
  refused when the topic's last known version is older.
- **tmux-scrape** (`/claude_mode tmux`) — **deprecated**: frozen, no longer
  developed (no new features, only keeps working as it is), so use json-stream
  instead. The picker and `/status` mark it «deprecated»; it stays selectable
  and a topic already on it keeps working — nothing migrates it. The classic
  TUI driven by keystrokes inside tmux; output is scraped from the pane. Never
  stopped automatically.

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

## OpenCode

OpenCode runs as a local HTTP server (`opencode serve`) that the bot talks to on loopback: prompts go to its HTTP API and one
SSE event stream carries the output of every topic. One server serves all topics; a topic's bound folder selects the server
instance it works in. Nothing listens on a public port. The model is picked with [`/model`](commands.md#model) (the effort
with [`/effort`](commands.md#effort), which OpenCode encodes as the model's variant), the providers are connected, switched
and disconnected in [`/accounts`](commands.md#accounts), and a usage limit is handled by
[`/limits_autoswitch`](commands.md#limits_autoswitch). How the server survives a bot restart is described in
[Restart behaviour](#restart-behaviour); the MCP server the bot registers with it in
[Bot-injected agent tools](#bot-injected-agent-tools).

## Restart behaviour

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
When `opencode serve` itself dies, the bot brings it back the same way a session
start does — installing the binary first if it is missing, retrying a failed
start for about a minute — and restores the sessions silently: only a topic whose
reply was in progress is told it was lost, and a message sent meanwhile is held
and delivered once the server is back. Only if every attempt fails does a topic
get one short line saying the next message will try again (the error itself goes
to the bot log).
A turn's failure is posted once, although OpenCode reports most failures twice
(the session error and the failed message); a provider plugin's `[Debug Info]`
block (opencode-antigravity-auth appends one with your Google project id) is kept
out of the topic and stays in the bot log. Gemini's "Requests ending with a model
turn are not supported" — OpenCode v1's agent loop sends a history that ends on
the model's own turn, fixed upstream only in v2 — gets one short line and the
bot's "continue" at once, which is a user turn; the same refusal right after it
ends with the usual give-up line.
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
     on-disk sidecar (one whose process is gone cannot be answered: its message
     stays in the topic with a «not answered» note in place of the buttons, and
     its pin is released). A topic whose process is gone (stopped at the idle
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

In the Docker container (see [Run with Docker](../SETUP.md#run-with-docker)) the same holds for a bot restart
inside the container; a restart of the container itself ends every agent process, and each conversation
resumes with its next message.

If you run the bot under `systemd`/`systemd-run`, set `KillMode=process`.
The default `control-group` mode kills tmux and `opencode serve` children,
which defeats restart/reattach. Process restarts intentionally leave agent
sessions alive; use `/quit` or `/quit-all` when you want to terminate them.

## Bot-injected agent tools

The bot injects its own `telegramBot` MCP server into every bot-started session
— for Claude via a generated `--mcp-config`, for OpenCode via runtime
registration. It is loopback-only (`127.0.0.1`, on an OS-chosen free port unless
`SCHEDULER_MCP_PORT` explicitly pins one) and authenticated with per-session
HMAC bearer tokens scoped to the thread / directory. Every generated registration
also carries a unique client identity, so cancellation affects only the originating
agent even when two clients use the same JSON-RPC request id. It exposes:

- `schedule_create` / `schedule_list` / `schedule_cancel` — the agent-side
  scheduling API behind `/schedule`;
- `todo_update` / `todo_read` — the agent's published todo list (see [Shared todo
  lists](commands.md#shared-todo-lists)), offered in Telegram topics and Jira issues alike;
- `compact_conversation` — lets the agent compact its OWN session when you ask it
  to in plain words ("compact our conversation"). It arms the compaction and
  returns immediately; the bot runs the real compaction the moment the current
  turn finishes (never mid-turn);
- `send_file_to_user` — lets the agent push files from the bound folder into the
  topic. A single MP4 uses Bot API `sendVideo`; eligible all-video and mixed
  photo/video albums use `sendMediaGroup`, with each MP4 represented by an
  `InputMediaVideo` entry. `as_file:true` explicitly forces documents. A file is
  opened so that a path swapped after validation cannot reach outside the bound
  folder: on Linux component by component beneath a pinned folder descriptor
  (`/proc/self/fd`); on Windows and macOS by its canonical path, held to the
  validated file's device/inode identity and resolved again inside the folder
  after the open. Existing
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

## Two surfaces: group topics, bot DM, or both

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
