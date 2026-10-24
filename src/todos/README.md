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
  dropped, `note` (≤ 500), `source`, `ref` (a tracker key / link), created / updated / started / closed times.
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
