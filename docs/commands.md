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
  - [`/compact_self_review`](#compact_self_review)
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
  - [Forwarded messages](#forwarded-messages)

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
  `(stale)` — the bot never renews it itself, and re-reads the token at every poll, so the
  first poll after the CLI ran on that account shows fresh figures again. Stale or not, a window
  whose reset has passed since it was read is shown as a bare `0%` — no countdown, since nothing says when its
  next period ends — never as the old figure with a reset «in 1m»: an account no CLI runs on (a used-up one waiting
  for its reset) has an expired token, so its last reading would otherwise stay at 100 % for good. `0%` means the old
  window is over; what the account has used since, through a login on another machine or another host user, is not
  visible to the bot (`(stale)` says the figures were not re-read). The recommendation, the `claude_profiles`
  figures and the switch of a topic read the same way. A profile whose session was refused on a window is marked
  `⛔ at its limit until …` and is skipped by the recommendation below.
- **Another account takes over on a limit.** When a topic's account hits a
  usage limit the bot looks at the [fallback chain](#limits_autoswitch);
  without one it moves the topic to the signed-in profile whose weekly limit resets
  soonest (fresh figures — or stale ones whose every window has passed its reset: the old windows are over, use since then by another login is unknown —, not marked limited, below 100 % on the windows the topic's model
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
  profile with its windows plus `recommended`. **Your `/limits_autoswitch` list says
  which accounts an agent may be pointed at:** once it holds any Claude account, only
  the accounts with an enabled entry there are recommended (to a new worker and to a
  resumed one alike); an account the list leaves out or has only 🚫 entries for is shown
  with `chainExclusion` (`notListed` / `switchedOff`, and the first line of the answer
  names it) and is never `recommended`. A list with no Claude entry (empty, or OpenCode
  only) restricts nothing: every signed-in subscription account is open, an account billed
  to API credits is not. Among the open accounts, an account billed to API credits goes
  **first** while it is signed in, not limited, its credit is not marked used up and the
  expiry day you gave (`charness claude-profiles credit … --expires`) has not passed (the
  bonus credit is spent before any subscription; several of them keep the list's order);
  then a **new** agent goes to the usable
  subscription whose weekly limit resets soonest, so what would burn soonest is spent
  first; usable means signed in, not marked limited, below 100 % on the windows the
  model drains (the session window and the shared weekly window bound every model;
  Fable additionally drains its own weekly window, and Fable's window at 100 % takes
  out Fable only) and the five-hour window under 90 % — a profile above that waits,
  the next reset is taken. Resets less than a minute apart count as one moment and
  the lower five-hour percent decides; an unknown reset ranks after every known
  one. A **resumed** worker
  passes `currentProfile` (the profile it last ran on) and stays on it unless the
  account is signed out, marked limited, out of credits, left out of the list or at
  100 % on a window the model drains; the 90 % ceiling does not apply to it. One that
  broke off on a usage limit — or on «Credit balance is too low» — passes
  `isStoppedByLimit` too: the bot re-reads that account's usage (an account billed
  to API credits has none: the bot checks it with one tiny request on the account's own
  key — the credit is marked used up only if the API really refuses for the balance, and
  the daily recheck lifts that mark when the credit is back; if the API answers instead,
  or the key cannot be read, or the check gives no answer, the account is only kept off
  agents for an hour — topics are not affected — and an answer from an account whose
  credit renewal was still awaited records the renewal) and leaves it out whatever the
  figures say, and the worker resumes the same session at once on the answer. With nothing usable `recommended` is `null` and
  `nextAvailable` names the account and the instant that frees up first, for a
  one-off resume (an account a limit just stopped, whose figures show no blocker
  yet, frees up at its five-hour reset); when no account names a time, the manager
  asks you and retries in about 30 minutes. The first line of the answer states why:
  it stays on the warm account, moved (the account stopped on a limit or can no
  longer run), API credit first, soonest weekly reset, or none usable. The agent then
  starts the child with `CLAUDE_CONFIG_DIR=<configDir>` (`null` = the default
  profile: set nothing). The bot refreshes the usage figures before it answers, and
  the tool answers within 10 seconds from the last figures instead of hanging: a
  slower refresh goes on in the background, each profile says when its figures
  were read, and a profile whose usage poll was given up on (it ran past 30
  seconds; its request is cancelled) is marked stale until the next poll succeeds.
  `/accounts` and the switch of a topic that hit a usage limit wait for the same
  refresh two seconds at most, like `/limits`. The same answer from a shell, for a worker without
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
- **Never used unless you include it.** It has no windows, so to every headroom rule it
  would look inexhaustible: the within-Claude switch (the one without a list) never
  offers it, and «🔄 Fill from connected» in `/limits_autoswitch` puts it LAST in the
  fallback list and left out of automatic switching (🚫) — and an account the list leaves
  out is not one an agent is pointed at either. To use it, tap it on the `/limits` board
  (`Claude · console 💳`) — or include its entry («✅ Use») so a limit notice offers it,
  switches to it by itself with switching on, **and the `claude_profiles` recommendation
  (and `charness claude-profiles --best`) names it FIRST for every new agent while its
  credit lasts**, before any subscription; when it stops answering (the credit is used
  up) the agents move on to the subscriptions in the list. A rebuilt list keeps it included
  once you did.
- **When the credits run out** («Credit balance is too low») the bot does not
  wait for a reset — there is none — and never retries hourly. The topic gets
  one `💸` notice, the account is marked as out of credits (`💸` in
  `/limits_autoswitch` and `/status`; `/accounts` and `/limits` show it as the
  credit line «🎁 API credit probably used up», see the bonus-credit bullet
  below — only a subscription account a refusal landed
  on keeps the `💸` line there) and the fallback
  list decides as for a limit: switching on moves the topic at once, otherwise
  the notice carries «🔁 Switch to …» buttons. If nothing can take over now but
  another entry comes back at a known time (a subscription's weekly reset), the
  topic waits for that and continues there; otherwise the notice is all. The
  mark lasts until you act: pick the account again (after topping the balance
  up), or sign it in again — or until a request on it goes through again. Your
  pick, sign-in or pasted key ends the mark and lets the account work, but the
  bot keeps the refusal as «unconfirmed» (`🎁 API credit: refused 07.11 — the next
  turn that goes through shows it is back`): the first turn that goes through is
  then the renewal like any other — the spend counter starts at 0 from it — and
  the daily recheck keeps asking meanwhile. A new refusal marks the account
  again. A rate limit of the API (429) is still a short retry.
- **What it spent.** On the default (stream) backend every turn reports the
  conversation's running cost; the bot counts the part each turn on the API
  account added (a subscription turn of the same conversation is never
  counted) and shows the total under the account in `/accounts` and `/limits`
  (`💳 $12.34 spent since 23.10 · last turn $0.21`), on `/status`, in the line a
  limit switch onto the account adds («billed per request … $X spent through
  the bot so far») and in its «credits used up» notice. It is what the bot
  saw, not the organization's balance — that one is on the Console's Billing
  page. The tmux backend reports no cost.
- **The bonus credit.** A Max, Ultra or Team subscription comes with a monthly
  credit for the Claude API, and it lands in the Console organization the API
  account bills. No credential the bot has can read that balance — only the
  Console's Billing page shows it — so the bot tells what it SAW, and the figure
  you give adds to it. Under every API account that has spent anything,
  `/accounts` and `/limits` carry the account's spend, counted in a **period**
  that starts at your last figure, or at the last renewal the bot detected, or —
  with neither — at the account's first counted turn. With neither a figure nor
  a renewal that is the `💳 $6.51 spent since 07.11 · last turn $0.21` line and
  nothing more; a figure or a renewal adds the `🎁` credit line below it (its
  period differs from the lifetime total). «via the bot» is meant: a spend by
  another key or machine is invisible to it.
  - **Your figure.** `charness claude-profiles credit <profile> <remainingUsd>
    [--of <grantUsd>] [--expires YYYY-MM-DD]`, for example
    `credit console 67.71 --of 200 --expires 2026-11-15` (`credit <profile> --clear`
    forgets it; only an account billed to API credits takes one). The line then
    reads `🎁 API credit ≈ $61.20 of $200.00 · $6.51 spent via the bot since 07.11 ·
    expires 15.11` — your figure minus what the bot saw spent since you gave it
    (the grant and the expiry only when you gave them; «≈» because it is an
    estimate). A new figure starts the count over. Give it while the account is
    idle: a turn that runs while you give the figure, or one that finished while
    the bot was down and is replayed afterwards, is counted in full (a turn's
    cost carries no end time to compare with). The day after the expiry day (the
    credit counts as usable through the whole of it, UTC) the line reads
    `🎁 API credit expired 15.11 — give the new figure: charness claude-profiles
    credit <name> <left>`.
  - **Probably used up.** A refusal («Credit balance is too low») turns the credit
    line into `🎁 API credit probably used up · $6.51 spent since 07.11 — top it up,
    then pick the account again` —
    «probably»: the bot cannot be sure; with no figure and no renewal just
    `🎁 API credit probably used up — top it up, then pick the account again` (the
    `💳` line above carries the spend; the tail is the way back the old `💸` line
    told, kept so a topped-up balance is picked again at once). A
    figure you give AFTER a refusal ends the mark (you are saying there is
    money, as a billed turn going through does). Picking the account again ends
    the mark too, but keeps the refusal as «unconfirmed» until a turn goes
    through (see above).
  - **Renewed.** While an account is marked used up the bot asks the API once a
    day, on that account's own key (the pasted key, or the one its Console login
    stored): one request of one token on the cheapest model, a short timeout, no
    retry. Refused for the balance = still used up; any other answer or failure is
    no conclusion (one log line, asked again in a day); an answer means the
    credit is back. A real turn that goes through on the account is such an
    answer too. The bot then records a renewal: the mark ends and the counter
    starts at 0 from that moment, on the **last grant you gave** (the plan never
    decides its size — team grants are pooled), the expiry unknown:
    `🎁 API credit renewed ≈ 08.11 · ≈ $200.00 of $200.00 · $0.00 spent via the bot
    · check expiry in Console › Billing`; with no grant ever given only
    `🎁 API credit renewed ≈ 08.11 · $0.00 spent since`. Only API accounts are
    rechecked, never a subscription; the attempt is recorded in `state.json`
    before the request, so a restart does not bring it round sooner than a day.
    A request goes to `ANTHROPIC_BASE_URL` when the bot's environment sets it (the
    root the account's sessions use), else to the API. A refusal that comes in
    while the request is on its way wins over the answer: no renewal is recorded.
    If the API stops knowing the probe's model (404), the bot logs a WARNING
    naming it and nothing renews by itself until the constant is updated.
    **Which accounts can be asked:** those whose key the bot can read — the pasted
    key, the key a Console login stored in the account's own `.claude.json`, and for
    the `default` profile the `primaryApiKey` in the home `~/.claude.json` — the last
    one only while the default's sessions really run on that Console login's key
    (the CLI prefers an `apiKeyHelper` or a variable over it, and a stale key left by
    an earlier login is not the one the sessions use; the bot learns which from
    `/accounts`' sign-in probe, so a default is not asked until `/accounts` has been
    opened once). An API account that runs on an `apiKeyHelper` of its own (or a
    default profile that does not run on such a key) is never rechecked; the bot says
    so in ONE log line at boot, naming it. An answer that arrives after a newer
    refusal — also one you already acted on by picking the account — does not renew.
  - **For agents.** The `claude_profiles` tool's entry (and `charness claude-profiles
    --json`) of an API account carries the bot's estimate: `spentUsd` in the
    period, `remainingEstimateUsd` and `expiresOn` (only what you gave; `expiresOn`
    is `null` after a renewal), `probablyUsedUp` (a refusal is pending and nothing
    has answered since — also when the expiry day you gave has passed; `false` once
    you picked the account again) and `renewedAt` — `null` / `false`
    for any other account. `charness claude-profiles` prints them after «no
    windows». They are never the Console's balance.
  - **Where it is kept.** Your figure lives in `DATA_DIR/claudeApiCredit.json`, not
    in `state.json` (a running bot rewrites that file from its memory, so a figure
    written there from the command line would be lost); the bot reads the file as
    it changes, no restart. What the bot counts and detects is in the account's
    record in `state.json`.

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
- **What a topic sees.** A scheduled run is announced by one silent line — «⏰ Scheduled: Nightly build · every day at 02:00» (plus «— missed at 02:00, catching up» for a catch-up run) — with the prompt folded under it in an expandable quotation, so the instruction to the agent is there when you want it and out of the way when you do not. Nothing a schedule or a check posts is pinned (the agent's questions still are); `/reminders` stay pinned on purpose, to pierce a muted topic. The schedule is said in your language and never as a cron expression: «every day at 02:00», «every 5 min», or — for a shape no wording fits, such as twice a day — «next: 2026-06-07 18:00». The agent's confirmation of a new schedule is one line (`Scheduled "Nightly build": daily at 02:00; next: 2026-06-07 02:00`) plus the id it cancels by.
- **Checks (watchdogs).** `schedule_create` also takes a `checkCommand` (with a cron schedule): the bot runs the command in the topic's bound folder on schedule and stays silent while it exits 0; on the first failure after a pass it says so in one silent line — «🔔 Check "API health" fired — waking the agent.» with the failure and the output tail folded under it, never the command — and wakes the agent with the job's prompt, the command, the exit code and the tail of the output. When the check passes again the topic gets «✅ Check "API health" is back to normal.» (for a worker watch: «✅ Worker "builder S2" is working again.»). A watch on a detached worker (a check with a `statusWorkerRunDir`) reads «✅ Worker "builder S2" finished (2 h 5 min). Reading the result.» when the worker's process is gone, «⚠️ Worker "builder S2" has been silent for 45 min. Checking whether it hung.» when its run directory stopped changing, or «⚠️ Worker "builder S2" has been running 2 h 30 min without a report. Checking on it.» when 2 h 30 min have passed since the agent armed the watch (the agent `touch`es a `watch-armed` file in the run directory right before it arms the watch, and again when it looked and found the worker fine — the same watch then goes on; a run far over its normal time is a problem to look at now). Checks survive bot restarts. A check with a status source (`statusWorkerRunDir` — a detached worker's run directory — or `statusCommand`, plus `statusEveryMinutes`, 5–240, default 15) also keeps the topic alive while it passes: the bot itself posts one short silent line (`⏳ builder S2 · works 30 min · now: <the worker's last action>`) every interval and deletes the previous one, without waking the agent. Only a topic that shows the agent's stream gets it (not the answers-only view, not a Jira issue); the line is deleted when the check fails, is cancelled, or the topic leaves its folder (`/unbind`).

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

Toggle auto-compaction after ~55 min idle (Enable/Disable picker; `AGENT_IDLE_MINUTES` sets the window). Per topic; run it in **General** to set the default for all topics. On by default. Each idle compaction posts one short notice, followed by the agent's [self-review](#compact_self_review) (when it found any mistakes); the picker's «Show summary» / «Hide summary» row (the `/compact_summary` switch) adds the agent's full summary instead of that section alone, and its «Show self-review» / «Hide self-review» row is the [`/compact_self_review`](#compact_self_review) switch. Fires at most once per active period (until you write again); if a question was pending it is re-asked with tappable buttons after the compaction and the first copy stays as a record (see [The agent's questions](#the-agents-questions)). On the json-stream backends the idle mark also STOPS the agent process, compaction or not — the topic sleeps and your next message resumes it (`/status` says so).

### `/compact_summary`

Toggle posting the agent's full summary after a compaction — `/compact`, the idle compaction and the agent's own `compact_conversation` (Enable/Disable picker). Every compaction summary — also the one the agent CLI or OpenCode makes by itself when the context overflows — ends with a numbered checklist of what the agent does next, whose first item reloads the skills it had loaded. Per topic; run it in **General** to set the default for all topics. Off by default: a compaction ends in a short line. On OpenCode it also hides the summary OpenCode streams itself.

**The agent's self-review — its mistakes that better instructions could prevent — is shown even when the summary is hidden** (unless you switched it off with [`/compact_self_review`](#compact_self_review)). Every compaction summary also carries a section, the self-review, where the agent lists its mistakes in that session — repeated ones above all — that a change to its standing instructions (rules, skills, `CLAUDE.md` / `AGENTS.md`) could have prevented, each with the concrete change and where it would go, in the language of the conversation; the agent only *proposes* them and never edits instructions on its own. The bot posts that section as its own message (under «💡 Agent self-review: what to change in the instructions so the mistakes are not repeated») after `/compact`, the idle compaction, the agent's `compact_conversation` and the compaction the agent CLI or OpenCode makes by itself at a context overflow — with the full summary hidden. With the full summary shown the section is inside it, under the same heading, and is not posted a second time (the marker lines the agent writes around it are never shown, on OpenCode too); when the agent found nothing to report, nothing is posted and no heading appears. Not covered: the deprecated tmux Claude backend (its TUI runs the compaction and the bot gets no completion to read the summary from).

### `/compact_self_review`

Switch the agent's **self-review** on a compaction — the section of the summary where it lists its mistakes and what to change in its instructions — on or off (Enable/Disable picker; typed `on` / `off` apply at once; the same switch is a «Show self-review» / «Hide self-review» row on the [`/compact_on_idle`](#compact_on_idle) picker). Per topic; run it in **General** to set the default for all topics. On by default — the self-review is what [`/compact_summary`](#compact_summary) describes: the mistakes the agent made in the session that a change to its instructions could have prevented, each with the change proposed, posted as its own message even when the summary is hidden.

**Off means the agent is not asked for it at all, and nothing is posted.** The request leaves every compaction's prompt — `/compact`, the idle compaction, the agent's `compact_conversation`, and the compaction the agent CLI or OpenCode makes by itself when the context overflows — so no tokens are spent on the self-review; the loaded-skills reload and the next-steps checklist that end the summary stay. The bot keeps a small flag per agent session (a parked one too) for the compactions the CLI and OpenCode start themselves, so switching it takes effect at once, also in an agent that is already running; an OpenCode sub-agent (Task) session follows the topic it works for. The Claude sessions' flags that nobody owns any more are cleared at the next start of the bot; an OpenCode session's flag stays until a topic uses that session again (the folder is shared by every OpenCode of the account). An agent process that was already running when you updated keeps its old compaction hook, which still asks for the self-review (`/compact` included) until it is stopped and started again (the idle stop does that within an hour).

### `/bot_skills`

Switch the skills Charness gives its agents on or off. In **General**: On / Off for the whole instance (the screen shows the value in force; `"botSkills"` in `settings.json` is the default while General never chose, ON when nothing says otherwise). In a topic: On / Off / «As in General (value)», the current choice marked ✓. One-shot picker — a tap turns it into the confirmation; typed `on` / `off` (and `general` in a topic) apply at once. A running agent keeps its skills until its next start. On an OpenCode topic the skills stay listed (one server serves every topic); only the hint to load the manager changes.

#### Skills the bot gives its agents

Every agent session the bot starts — Claude Code or OpenCode, in a topic or a
Jira conversation — also gets four skills that ship with Charness
(`agent-plugin/`):

- `charness-orchestration` — what the bot adds to a manager skill when an agent
  drives detached workers: a bot check per worker that wakes the agent when the
  worker exits, stops writing for 45 minutes OR has run 2 h 30 min since it was
  armed without a report (a finished worker fires it too; nothing it posts is pinned), the bot's accounts, and how to reach you. It is an
  add-on: the delivery loop (review, parallel work, finishing) is the manager
  skill the session already has — yours or your project's;
- `charness-delivery-loop` — a small built-in delivery loop for a session that
  lists no manager skill of its own (one worktree per separately released task,
  an independent review at the finish, one worker on a shared resource at a time);
- `charness-delegate-claude` / `charness-delegate-opencode` — launching,
  watching and resuming a detached `claude -p` / `opencode run` worker.

Claude Code lists them as `charness:charness-orchestration`, …; OpenCode by their
names. Your own and your projects' skills stay as they are, and your sessions
outside the bot do not get these. For Claude Code the bot passes
`--plugin-dir`; for OpenCode it starts its server with `OPENCODE_CONFIG_DIR`
naming a folder in `DATA_DIR` — if you set `OPENCODE_CONFIG_DIR` yourself, yours
is kept and OpenCode topics go without these skills. They update with the bot.

They can be switched off with `/bot_skills` (in General for the instance, in a topic for that topic). The value is read in this
order, the first that is set wins: the topic's own choice, General's value, `"botSkills"` in [`settings.json`](../SETUP.md#instance-settings-settingsjson) (the way an instance without General — a
Jira-only one — sets it), then **on**. A Jira conversation has no choice of its own: it follows the instance value. With the
skills off a Claude conversation starts and resumes without `--plugin-dir`, and the bot MCP's instructions no longer tell its agent to
load `charness-orchestration` (the worker-watch recipe stays in `schedule_create`'s description); a running agent keeps its skills until its
next start. OpenCode has ONE server for every topic, so only the instance value counts there: the server is replaced at the bot's next
start, once nothing works in it, by one started without (or, when turned back on, with) the folder. A topic's own choice changes the
orchestration hint of its OpenCode folder only when the OpenCode server next restarts, and OpenCode topics sharing a folder share the hint
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

Who may pair: with `OWNER_USER_ID` set, the owner alone — anyone else gets «Only the bot's owner can pair it with a group.»,
and auto-pairing too waits for the owner's own message in a group. Without it, the first group is paired by an admin of
that group (auto-pairing, or `/pair` there); after that only the **creator of the group the bot serves** can move it —
anyone else gets «The bot serves another group; only that group's creator can move it here.» Being an administrator of
the new group is never enough on its own (whoever makes a group is its creator), but it is required too: the bot serves
that group's administrators. If the served group cannot be read any more — you deleted it, or removed the bot from it —
nobody can be confirmed as its creator, and `/pair` answers «The group the bot serves can't be read …»; then, as when its
creator is gone, set `OWNER_USER_ID` (or `ALLOWED_GROUP_ID`) and restart.

## General-only

### `/quitall`

End every active agent in every bound topic (also releases their session ids).

### `/runners`

The machines your agents can send tests and builds to (`charness remote-run`), paired from Telegram. **General only, admins only** — in a topic it points to General, and a button tapped from a topic is refused. One message, redrawn in place:

- **The list.** Each machine with its name, online or «offline since …» (or «lid closed — takes no new jobs»: a MacBook with its lid shut and no external display is about to sleep, so it is given no new job until the lid opens; it shows its last snapshot), paused, system and how it is kept running (run by hand, user service, always-on system service); when it is online also its hardware (CPU, load, RAM, disk), its jobs (running, queued, projects) and what it can do — Android, iOS, Docker, Playwright, with the reason for a «no». The list opens at once from what the bot already knows, then asks the online machines (up to 20 s) and redraws; a machine that does not answer keeps its last snapshot, marked «as it was then». Empty: «No runners yet.» A long list is split over pages (**‹ Previous / Next ›**, «Page 2 of 3»); what a machine reports about itself is shortened to fit.
- **Jobs at once.** Under each machine a button **«name: Jobs at once — N»** (1 when nobody set it) opens a picker on the same message: *How many jobs may name run at once?* with the number now, a suggestion for the machine's size when it has reported its cores and memory (10 cores and 32 GB: 2; an iOS end-to-end job peaks at about 12 GB and four cores), and **1 2 3 4 6 8** with the current one ticked (**‹ Back** draws the list again). A tap saves the number, tells the machine now if it is online, says on the tap which it was — *name: 2 at once*, *…offline and takes this at its next job*, or *…saved, but the machine did not take it now* — and draws the list: each online machine's jobs line ends `· N at once`. **A lower number never stops a job that runs**; it only keeps the next ones waiting. Jobs side by side must use the ports and the simulator the runner gives them: [docs/remote-run.md](remote-run.md#jobs-beside-each-other). The picker is one-shot (it consumes its message); a keyboard from an older list only says the list changed.
- **＋ Pair a new runner** posts ONE message (a secret — the output trace records only its length): the words that explain the line, then the line, valid 10 minutes, single use, and under them a row **Jobs at once: 1 2 3 4** (1 ticked) that picks how many jobs the new machine will run side by side — before the line is used it is kept for the machine to come, just after it changes the runner it made; the settled message names the number (*Jobs at once: 2 — change it in /runners*); the label button explains the row, and a tap on a line that is not open any more (expired, closed, its runner removed) says so. Pasted in an **admin account's** terminal on the runner machine (`sudo sh -c '…' sh runner`) it checks the account named by the last word of the line (`runner` unless you change it: it must exist and must not be an admin or root — it runs the agents' code), pairs it **as that account** and installs its always-on service, all in one paste — and while it does, it runs code from this charness host as root on that machine (the message says so). Without admin rights the same line is run **in the terminal of the runner account itself, without its leading `sudo`**: it then pairs that account only (the last word must be that account's name, or the line refuses) and prints how to keep the runner running. Either installs `charness-runner` there from this charness's own package and pairs the machine, telling each step as it goes (checking the account, downloading the package, installing the runner program, checking the machine, pairing, getting Pueue, finding rsync, installing the service — one line each, with dots that cycle while a step runs on a terminal); the message then turns into «Runner “name” paired …» and the line is gone from it, or after 10 minutes into «Pairing code expired.», or — when the line was pasted for a machine that was already paired and only installed its service — into «This line was used on a machine that was already paired — nothing new was paired.» — also after a bot restart or when the code was used while the bot was down (the bot keeps its own record of the message it sent and tries again what Telegram refused — a message you deleted by hand counts as settled, nothing is retried for it). The line and its words must fit one Telegram message (4096 characters): that holds for ed25519, ECDSA and RSA host keys up to 3072 bits at any host name and hub account the registry accepts, and for a 4096-bit RSA key at ordinary ones; with an RSA host key of 4096 bits with a long host name or hub account, or any RSA host key larger than 4096 bits no message is sent, the code is closed at once, and the bot answers with the length and `charness runners pair --host <address>`, which makes the same line in a terminal on this machine. A message Telegram refuses closes its code the same way. The first time, the bot asks **which address runners dial**: it proposes a public address of this machine when it answers with this machine's own ssh key, or you send `host` / `host:port` — checked the same way, a mismatch names the key that answered and the bot asks again. The address is kept in [`settings.json`](../SETUP.md#instance-settings-settingsjson) (`runnerHost`).
- **Pause / Resume** keeps a machine attached but sends it no jobs. **Remove** asks first («Its key is deleted and it stops connecting. Jobs running there are killed.»), then deletes its key line and registry entry and cuts its link; the jobs it was running are stopped at once through the link (a machine that was offline stops them itself when it finds out it was removed — the hub's answer at its next connection, or a refused key that lasts 12 hours), and the machine says it was removed and retries at most hourly. The tap is answered at once and a message in General then says what happened — the jobs stopped; or the machine was offline, so they were not, and it stops them itself once its key has been refused for 12 hours; or they could not be stopped from here (the reset failed, or the link state could not be read) and the machine does the same; a registry that cannot be written is reported there instead of «removed». For a machine that runs as an always-on service (a Mac's LaunchDaemons) the bot adds a second message: it keeps running there until an admin removes it, and the three `launchctl` / `rm` commands — made by this charness host, not by the machine's own program — to run on that machine as an admin.
- Buttons carry the registry's revision and the machine's place in the whole list, so a keyboard left in the history only says «the list changed — here it is again» and draws the current list.

The same actions without Telegram (an instance that serves only Jira): `charness runners [ls | pair --host <address> [--account <name>] [--jobs-at-once <n>] | remove <name> | service-removal <name> | pause <name> | resume <name> | jobs-at-once <name> <n>]`. `jobs-at-once <name> <n>` (1–8) is the picker's twin: it saves the number, tells the runner now when it is online and says what became of that (told / offline, takes it at its next job / did not take it now); `ls` shows each machine's `N at once` beside its version. `ls` shows «how it is kept running» as each machine last reported it (any probe refreshes the report — the Telegram list, `charness remote-run runners`, a job start), the same rule as the Telegram list; it first asks the machines that are online whose report is older than their link (a service installed after the pairing starts the link anew) or have none, and only those — a listing that finds every report fresh makes no ssh call, it waits at most 8 seconds for an answer, and a machine that gave none is shown as it was last known and not asked again for 10 minutes (or until its link begins anew) — so a silent machine never costs a wait at every listing — and its row says «(last report from before its link started; it did not answer)» (or «no report yet») instead of presenting that report as how it is kept running now; a machine is «online» exactly when its link is, whatever its probe says. A machine's default name drops the ending its network adds to the host name (`studio-mac.local` is `studio-mac`). The hub also notes where each machine's link connects from (the address sshd sees): when a link comes from another address than the one before it — or two links keep replacing each other, from two addresses, within minutes — the bot posts ONE message about it in General and pins it, and the machine's row in `ls` and its block in `/runners` keep saying so until the runner is removed or paired again (where from now, where from before, when; for a link that took the place of one still up: remove the runner and pair it again if that was not your change of network), because a job on the machine can read its key and a second machine with it would replace the first without a sound.

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

While the text is not there yet — a local engine that is still loading its model can take up to 2 minutes — the topic
shows a silent «🎙 Transcribing the voice message…» note, so the voice note does not look lost. It appears only when the
wait passes 3 seconds (a warm engine shows nothing), and is deleted the moment the 🎤 transcript (or the failure notice)
arrives. A restart of the bot removes a note it left behind, too.

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

The quote's header also says who wrote the quoted message, so the agent never takes somebody else's words for yours:

| Who wrote the quoted message | Header the agent reads |
|---|---|
| the agent (this bot) | `from: assistant` |
| you, or another group admin | `from: user` |
| anybody else — a group member who may not talk to the agent, an anonymous admin, a channel | `from: group member "Bob Stone" (@bob), not allowed to talk to you; untrusted text` |

The name is quoted and cleaned like a forwarded message's origin. A reply to a message that was itself forwarded adds `forwarded from …` for its first author.

### Forwarded messages

Forward a message into a topic and the agent is told it is forwarded — and from whom — instead of reading the words as yours: a line like `[Forwarded message · from: channel "Ops Alerts" · originally sent: 2026-11-06T14:20:00+04:00]` leads the text. It names the origin (a user with their @username, a hidden user, a chat or a channel, with the post signature when there is one) and when the message was originally sent, on your `/timezone` clock. The name is quoted and cleaned of brackets and control characters, so what a stranger chose as a title cannot close the line or pass for an instruction. It works for text, captions, voice notes (the transcript carries it) and files, both agents. Each forwarded message is marked on its own, so several forwards followed by your own words stay apart: only your words come unmarked. A forwarded message is only ever read, never obeyed: a forwarded `/quit` stops nothing, a forwarded `/review the diff` reaches the agent as marked text rather than as your slash command, a forwarded «1» answers no pending question or menu, and a forwarded «claude» starts no agent. (A terminal topic types every message into its shell, forwarded or not.) A forwarded message that is also a reply carries both lines, and a reply to a message you forwarded earlier says in its header who first wrote it (`from: user, forwarded from channel "Ops Alerts"`).
