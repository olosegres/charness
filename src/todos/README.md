# `src/todos/` — the shared agent todo registry

Every conversation (a Telegram topic, a Jira issue) keeps a short PUBLISHED todo list, so agents working in one
project's other topics see what each other is doing and never fix the same thing unknowingly. The agent writes it
through the bot MCP (`todo_update`, `todo_read`); the operator reads it with `/todo`. Nothing here knows Telegram or
Jira: the platform-specific parts (the `/todo` view, a topic's name) are injected.

## Store (`store.ts`)

- **One file per conversation**, `DATA_DIR/todos/<conversation slug>.json` (the key slug with `_` for `:`), written
  atomically and cached in memory. Calls are synchronous: the bot is the only writer, so two writes never interleave.
- **The file store is the truth and the full history.** A closed item older than 30 days moves to
  `todos/archive/<slug>.jsonl` at the next save; `todo_read`'s history reads it back. Nothing is ever deleted.
- **A list belongs to the CONVERSATION, never to a session**: `/new`, `/quit`, a backend switch and a restart keep it.
- An unreadable file is set aside (`<name>.corrupt-<time>`) with one error line, and the list starts empty.

## Items and order (`types.ts`, `merge.ts`, `order.ts`)

- An item: `id` (`t1`, `t2`, … per conversation, never reused), `title` (≤ 200), `status` queued | inWork | done |
  dropped, `note` (≤ 500), `source`, `ref` (a tracker key / link), created / updated / started / closed times. Title,
  note and ref are kept on ONE line (`getSingleLineTodoText`): they are pasted into other agents' prompts as board
  lines, where a line break could pass one agent's text off as a bot-made block.
- **The array order of the open items IS the queue order** — no separate position numbers. The one total order
  (`getTodoItemsInOrder`): in-work items first, then the queue, then the closed items by close time, newest first.
- **`todo_update` is an UPSERT** (`applyTodoUpdate`): no id → a new item (queued, last, unless `status` / `position`
  say otherwise); an id → only the named fields change; removal = `dropped`; `order` = open ids in the wanted order,
  the unlisted ones after them in their order. Nothing disappears by omission. **All or nothing**: a call with any
  error saves nothing and names every problem.
- `revision` moves only when the CONTENT changed (a peer's board compares it); `lastUpdateAt` moves on every call — a
  call that changes nothing still says "the list is accurate".

## What a list shows (`format.ts`)

- `getTodoListView` is the ONE place that decides what a list shows: in work, the queue in order, the done items of the
  last local days (the agent: today and yesterday; `/todo`: today). Dropped items show only in the history.
- The agent's own list carries the item ids (it patches by them); agent-facing text is English on every surface.

## Service (`registry.ts`)

- `updateTodos` / `readTodos` answer the tools; the MCP surface only routes the conversation its token names here —
  an agent can never touch another conversation's list.
- **The final-answer hint (D8):** an `answer_request` `final` to an open request whose conversation still shows
  in-work items, while the list was not updated during that request (`lastUpdateAt` before the request's creation),
  gets one line asking to record the change — in the tool result, no extra turn.

## Staleness reminder (`nag.ts`, `reminderEngine.ts`)

- **Stale = WORKED time, not wall time** (D10): the reminder engine polls the conversations' sessions (the wake-up
  engine's turn probe, `todoReminderPollMs`) and counts the WORKING polls — busy and nothing holding the turn (a
  session waiting on a question is busy, its agent does nothing); a late poll counts at most three intervals.
  The clock starts at the first turn end after an update (`nag.clockStartedAt`), so neither the update's own turn nor
  days of quiet count. A busy → idle edge is a turn end; agent output marks a turn too short for a poll; and the
  adapter's own `turnEnded` (json-stream, every terminal `result`, any platform) is a turn end too — the per-turn
  lifecycle stops the process right after it, before any poll could find it idle. A per-turn session counts as
  asleep for the standalone reminder (`isStoppingAfterTurn`): it gets the line with its next prompt only.
- The work is kept in memory between turn ends and stored with the list at a turn end (`nag` in the topic file), so a
  restart loses at most a running turn's share. A turn that ends right before a stop may be read as ended only by the
  next process — or not at all — and the clock then starts a turn later.
- **Form a** — the reminder line rides the next prompt from any source at the ONE choke point (`forwardPromptToAgent`
  takes it through `takeTodoPromptReminder`; never a slash command, a shell line or the standalone reminder itself).
- **Form b** — at a turn end, only when every gate of D12 holds (`decideStandaloneTodoReminder` names each failing one;
  a due reminder that a gate holds back logs one line): posted through `postToIdleSession` — never a resume, never an
  interrupt — as a technical prompt (`isTechnicalPrompt`: no request, never replayed, no interrupt). In a Jira
  conversation nothing of that turn reaches the issue: the agent can answer only through `answer_request`, and no
  request is open (a gate), so it is no hand-over and spends no run budget (D58).
- A delivered reminder (either form) starts the work count afresh and counts as ignored until the next update; after
  `todoReminderMaxIgnored` (2) the bot is silent until the agent updates or a person writes (`notePersonActivity`,
  beside the compact-on-idle latch).
- **Settings:** `settings.json` `todo: { isEnabled, reminderMinutes }` (`instanceSettings.ts`), defaults on / 60 min,
  set from `/todo` in General. Off = the tools are not offered (the MCP `todos` port is read per request), no board,
  no reminder, no final-answer hint.

## Projects (`projects.ts`)

- **Automatic by repository** (D15): a topic's bound folder → its git common dir (`git rev-parse --git-common-dir`,
  resolved against the folder, cached 10 min) → the repository's ROOT COMMIT (`git rev-list --max-parents=0`, a 30 s
  bound, cached by common dir: one history walk per repository) — the same in every clone and worktree; the project's
  name is its first member's repository folder name (a worktree or a submodule names its repository, a clone its own
  folder). A folder that is no checkout is a project of its folder. A failed read is tried again after 30 s, and a
  failure on a folder that has `.git` is logged once — the topic is a project of its own meanwhile.
- **No prompt waits for git.** Two reads of one folder share one git run, and one repository's folders share one
  history walk. The root commits persist by common dir in `todos/repositories.json` as the LAST KNOWN answer: after a
  restart it answers at once, while the process still walks each repository once in the background — a rewritten
  history (or a folder re-initialised at the same path) is corrected and logged; a failed walk keeps the stored one. A prompt and the mid-turn poll take only what is
  known (`knownOnly`): a folder's last answer, kept past its TTL while it is read again; while a bound folder was never
  read, the grouping is unknown and the prompt carries no board — nothing counts as seen, so the next one carries it.
  The reads start at boot and at every bind, so only a new repository's first walk can leave a prompt without its
  board. A `todo_*` tool and `/todo` wait for git.
- **Jira** (D57): a conversation's project lists `repos` in `jira.json`; conversations that share a name are one
  board, and a topic whose repository folder has that name joins it. The name joins the union ONLY when a Jira
  conversation names it, so unrelated repositories with one folder name never meet. No `repos` → one shared board.
- **Overrides** (D16): `state.json` `todoProjectOverrides` — `own` or `join` another conversation; a join of a
  conversation that is no longer bound falls back to automatic. Unbinding takes a topic off every board (the list stays).

## Board (`board.ts`, `tools.ts`)

- What each agent has SEEN is stored with its list (`boardSeen`: each peer's `revision` and when), so sleep, a
  restart and a hot reload keep it. A fresh context forgets it (`noteFreshContext`, called at the points that clear
  the thread-context preamble marker — session start, stop, close, `/clear` — and at every completed compaction or
  lost conversation, `noteConversationContextReset`), so the next prompt carries the whole board and the own list.
- `takePromptBoard` (at `forwardPromptToAgent`, every turn start the bot makes — the standalone reminder included,
  never a slash command or a shell line): whole board on a fresh context, else `[Project board — changes since HH:MM]`
  with the peers whose `revision` moved, else nothing. `todo_update` / `todo_read` (`tools.ts`) answer the own list
  and the same delta; `todo_read` with `scope: project` the whole board (a larger cap). A peer that never published is
  left out. A peer change never starts a turn (D21).
- D18 caps: per peer 5 in work, the first 5 queued (+N), 5 done of the last two local days by date, titles 120
  characters; the block ≤ 3000 characters, the most recently active peers first, the rest named for `todo_read`.
- Labels (D55): a topic `#<topic name> (<folder>)`; a Jira peer `<KEY> «<summary>»`, the summary the connector last
  showed that issue's agent (memory only; `null` = withheld by the trusted group, then the key alone).

## Mid-turn delivery (`midTurn.ts`)

- **Claude** (probed on Claude Code 2.1.310: a `PostToolUse` hook's `additionalContext` reaches the model in
  `claude -p` stream-json): the launch `--settings` file (`utils/claudeCompactHook.ts`, shared by the json-stream and
  tmux backends and by a key profile's own file) carries a `PostToolUse` command hook with no matcher. With the inbox
  dir empty — nearly every tool call — it only reads its input and exits; while an inbox waits, the bot's own `node`
  (its path written at every launch) parses the input as JSON, takes its top-level `session_id` (only `[A-Za-z0-9_-]`,
  so nothing outside the inbox is reachable), MOVES `DATA_DIR/todos/inbox/<session id>.json` aside and prints it —
  ready hook JSON, `additionalContext` ≤ 10,000 characters — and prints nothing without one; it always exits 0. A
  sub-agent's tool call fires the hook with the SAME `session_id` and an `agent_id` (Claude Code 2.1.310): the hook
  skips it, so only the main agent takes the inbox. Only top-level fields decide, in any order — a tool's input or
  output naming `agent_id` is never one.
- The reminder poll hands every BUSY session what changed since its agent last saw the board (`peekChanges`, never
  marked seen there): Claude gets the inbox written (atomically; the same changes are not rewritten), and the changes
  count as seen once a later poll finds the file gone. OpenCode gets a NOTE INTO ITS RUNNING TURN
  (`AgentAdapter.queueNoteIntoRunningTurn`): `prompt_async`, read between steps, posted WITHOUT the new-prompt path —
  that path resets the turn (its response accumulators, so a reply streamed around it splits into two messages) and
  aborts a provider retry. The note is refused while a provider retry is waited out or the session is not busy, and
  the changes count as seen only once it was accepted. An idle or sleeping session gets nothing (D21). The poll runs
  while the lists are on, the staleness reminder off or not.
- A turn start the bot makes withdraws a waiting inbox (`discardInbox`) — its prompt carries the changes. The boot
  clears every inbox: this process does not know what an old one carries, and what it carried is still unseen.
