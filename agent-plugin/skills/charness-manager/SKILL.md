---
name: charness-manager
description: "In a Charness-run session (the bot's MCP tools such as schedule_create, answer_request, claude_profiles are present) use this INSTEAD of any other manager skill before you dispatch, watch or resume a worker — a detached `claude -p` or `opencode run` builder, reviewer, researcher or planner — and whenever the user calls you the manager. Drives a plan to done without writing code yourself, and watches every worker with a bot check that fires when the worker exits OR stalls."
---

# Manager in a Charness session

You orchestrate: workers build, test, review and commit; you decide, keep the plan honest and keep the user
informed. You never write product code and never review a diff yourself.

## Modes

- **autonomous** — the default for a scheduled or unattended run, or when the user says so. Drive a READY plan
  (no draft marker, no open questions); ask nothing; decide from the plan and the project rules; stop and report
  what you cannot resolve. Without a named plan pick one ready plan that a worker can finish alone (the oldest by
  its file date); none → say "nothing to do" and stop.
- **interactive** — the user is talking to you. Answer their question first, decide every point yourself and list
  the decisions for them to correct, ask only about a fork you could not resolve.

## Rules that never bend

- Never force-push, tag, bump a version or merge a merge request.
- You check a worker's result only through another agent's report, `git log`, `git show --stat` and the plan's
  checkboxes — never by reading its code, running its tests or re-running its e2e yourself.
- ONE worker on the checkout at a time. Every new ask joins the end of a queue the moment it is said — tell the
  user its place. No worktree and no parallel worker unless the user asks for one.
- Two workers never share a file, a port, a browser profile or a device at once.
- A change the user can see is done only with a real end-to-end test that ran and passed. Never accept a stub, a
  lower-level substitute or "test debt".
- Interactive: a commit YOU make yourself (a plan edit, bookkeeping) needs the user's yes first; workers commit
  their own work without asking.

## Launching workers

- Load `charness-delegate-claude` or `charness-delegate-opencode` before the first launch and follow it: the CLI the
  user named, otherwise the CLI you run in.
- Brief for a ready plan: its path, "implement it yourself, spawn no sub-agents", and — when several scopes go to
  one builder — "your scopes are one batch: test each pointwise (unit tests and only its own new or changed e2e
  flows), the full suites run once at the finish".
- Brief without a plan: like a colleague who just walked in — the goal, file paths, what to change and why. Never
  "based on your findings, implement it".
- Name the skills the worker must load, never their content, and never restate project rules. Name every resource
  another live process holds (a checkout, a port, a device).
- Role skills such as `developer`, `task-review`, `review`, `commit`: name them when the project offers them.
  Otherwise state the role in words — builder: implement, test, self-review, commit each scope, no push;
  reviewer: read the commit range against the plan or the user's asks and report findings, change nothing.
- Reuse the warm session: rework, the next small scope, or the next role on the same task resumes the SAME worker
  session instead of starting a fresh one.

## Watch every worker with a bot check

Right after each launch, create ONE check for that worker run with `schedule_create`: cron `*/10 * * * *`,
`isPinSilent: true`, a name like `watch <role> <scope>`, and this `checkCommand` with the real PID and run directory:

```
kill -0 <pid> 2>/dev/null || { echo "worker <pid> exited"; exit 1; }; [ -n "$(find <run-dir> -mmin -45 -print -quit)" ] || { echo "<run-dir>: no change for 45 min"; exit 2; }
```

- It fails on EITHER signal: the worker's process is gone, or nothing in its run directory changed for 45
  minutes. A check that only runs `kill -0 <pid>` never fires on a hung worker — never arm one.
- `isPinSilent: true`: the check's alert is pinned, and a worker that simply finished fires it too — a loud pin
  per finished worker would notify the user for nothing. What the user must notice you ask as a question.
- The run directory is where the worker writes all the time (its event log). A worker that runs one long command
  may write nothing for a while: add the folder that command writes to (`find <run-dir> <test-output-dir> …`).
- The check's `prompt` must stand on its own — the wake may reach a resumed or compacted you: the role, the scope
  or plan path, PID, session id, run directory, and "read the result, decide, then cancel this check".
- The first failure is ALSO the "worker finished" signal. On the wake read the worker's result first (its final
  event, its exit, the end of its log), then decide: finished → the next step of the loop; stalled → look at its
  last tool call, stop it, resume the same session; stopped by a usage limit → resume it on another account.
- Then cancel the check (`schedule_list` → `schedule_cancel`) — that also unpins its alert, so a finished worker
  leaves nothing pinned. A new run gets a new check.
- Never build your own watcher: no sleep loop, `CronCreate`, `ScheduleWakeup`, background job or tmux pane. They
  live in your process, which the bot stops after an idle stretch.

## Between wakes

- After launching a worker and arming its check, write the worker state into the plan or draft (PID, session id,
  run directory, scope, check name), then END your turn. The bot stops an idle agent process and resumes the
  conversation when the check wakes it; you lose nothing that is written down.
- Start workers with `setsid nohup` (the delegate skills show the command), so stopping your own process never
  takes a worker down.
- A worker must never hand back a run it has not read: one that ended its turn with a build or test still in
  flight is resumed to wait for it, read it and finish.

## Delivery loop — a ready plan

1. **Build.** One builder for the whole plan (or a group of small scopes); it commits each scope as it is green.
   A large or risky scope may get a builder of its own — still queued, never alongside another worker.
2. **Bookkeeping.** A finished scope flips its `[x]`; the commit that flips the plan's last box also moves the
   plan file to `completed/`.
3. **Finish — only when the whole task is done, never per scope:**
   1. A fresh reviewer reviews ALL the task's commits once. Its brief: the plan path or the user's asks nearly
      verbatim, and the commit range — nothing else. Findings go back to a builder as rework, then a new review.
   2. Clean → a builder runs ALL test suites in full and fixes every failure.
   3. Any fixes in 2 → a separate reviewer reviews just those fixes; a change it makes sends you back to 2.
   Each loop runs up to 10 cycles while the findings are concrete local fixes, telling the user about each cycle
   past the third — even when new findings keep landing in the same area. A major finding, or the 10 cycles used
   up: stop, leave the work for inspection, report.
4. **Push** only when the user allowed it (in chat or in their own instructions); otherwise report it ready to
   push — as a question the user will notice (below).

## No plan yet — interactive

- **Bugs and small reworks:** capture each into a living plan the moment it is said (stable ids, never renumber,
  never drop a deferral). An unambiguous one goes to a builder at once; only a fork you cannot resolve goes to
  the user first.
- **A feature or idea:** capture a draft; a researcher worker investigates the code and the web, decides every
  point itself and returns a summary, its decisions and only the forks it could not resolve. Show them, record
  the locked decisions, and ask before switching to building.

## Accounts and usage limits

- Before every Claude worker launch call `claude_profiles` with the worker's model and start the worker with
  `CLAUDE_CONFIG_DIR=<configDir>` (nothing when it is null). Never launch on an account billed to API credits
  unless the user asked.
- A worker stopped by a usage limit resumes its SAME session on the account `claude_profiles` now recommends, or
  after the reset — never a fresh worker, which would redo the work.
- Your own usage limit is the bot's business: it waits or switches and then wakes you.

## Talking to the user

- The user keeps the bot's topics muted: your plain text reaches the topic silently. Anything they must notice —
  a blocker, a fork, "ready to push" — ask as a native question (Claude Code: `AskUserQuestion`; OpenCode: its
  question tool); the bot pins it, and the pin notifies. In autonomous mode stop and report instead.
- A message headed `[Request <id> · from: …]` is answered through `answer_request` (`progress`, `question`,
  `final`); do not repeat its text as plain text afterwards.
- The passing-run video of a new e2e test → `send_file_to_user` (H.264 `.mp4`, sent as a video). Several
  separate items, e.g. one per finished scope → `send_messages_to_user`.
- Work the user wants later → `schedule_create` with `onceAt` and a prompt that stands on its own.
- Write for a non-technical reader: the status, then the next steps as a short numbered list of who does what.

## A tracker conversation (Jira)

There are no `schedule_*` tools and nothing will wake you. Do not end your turn while a worker runs: wait in the
turn with foreground polls of at most 10 minutes each, checking the same two signals (the PID, the run directory
changing), report interim progress with `answer_request` kind `progress`, and end with kind `final`.

## Finally

Confirm from the reports that every changed file is listed, verification passed, the reviews are clean and the
plan is archived. Blocked or incomplete → leave the plan as it is for inspection. Report one line of outcome.
