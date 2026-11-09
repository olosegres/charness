---
name: charness-orchestration
description: "Adds the bot's tools to a manager skill; it holds no delivery loop. In a Charness-run session (the bot's MCP tools such as schedule_create, answer_request, claude_profiles are present) load it together with this session's general manager skill (the project's or the user's own) before you dispatch, watch or resume a worker — a detached `claude -p` or `opencode run` builder, reviewer, researcher or planner — and follow that skill for the loop. This one wins only on the bot's mechanics: the watch check that fires when a worker exits OR stalls, ending the turn between wakes, accounts, reaching the user. No general manager skill listed → load `charness-delivery-loop` as well."
---

# Orchestration add-on for a Charness session

This skill adds the bot's tools to your manager skill and holds no delivery loop. Follow the session's general manager
skill (the project's or the user's own) for modes, the loop, review, parallel work, the queue, briefing and finishing.
None listed → load `charness-delivery-loop` too. Where both speak of the same thing, this skill wins only on the
mechanics below: launching, detaching, watching, waking, accounts and reaching the user.

## Launching workers

- Load `charness-delegate-claude` or `charness-delegate-opencode` before the first launch and follow it: the CLI the
  user named, otherwise the CLI you run in.
- A worker that runs tests on a runner shares it with other jobs: its test scripts bind ports from `$REMOTE_RUN_PORT_BASE`, use
  the simulator `$REMOTE_RUN_IOS_SIMULATOR_UDID` and never run `simctl shutdown all` or name `booted`; the tool's `--help` has the rest.
- Name every resource another live process holds (a checkout, a port, a device) in the brief.

## Watch every worker with a bot check

Right after each launch, `touch "<run-dir>/watch-armed"`, then create ONE check for that worker run with
`schedule_create`: cron `*/5 * * * *`, `statusWorkerRunDir: "<run-dir>", statusEveryMinutes: 15`, a name like
`watch <role> <scope>`, and this `checkCommand` with the real PID and run directory (`<run-dir>` is an absolute path:
the check runs in the topic's folder, so a relative path or `~` points elsewhere):

```
kill -0 <pid> 2>/dev/null || { echo "worker <pid> exited"; exit 1; }; [ -n "$(find "<run-dir>" -mmin -45 -print -quit)" ] || { echo "<run-dir>: no change for 45 min"; exit 2; }; [ -n "$(find "<run-dir>/watch-armed" -mmin -150 -print -quit)" ] || { echo "<run-dir>/watch-armed: older than 2 h 30 min, or missing"; exit 3; }
```

- It fails on ANY of three signals: the worker's process is gone, nothing in its run directory changed for 45
  minutes, or the watch was armed 2 h 30 min ago — the worker has run that long without a report. A check that
  only runs `kill -0 <pid>` never fires on a hung worker — never arm one.
- The third signal counts from the age of `<run-dir>/watch-armed`: `touch` it right before you arm the check, and
  again whenever you re-arm one (a check fires only once, so after you looked at a worker that is fine, a new check
  needs a fresh clock). A run directory without that file fails the third test at the first run — a forgotten `touch`
  wakes you at once.
- One check may cover several runs of one step (parallel reviewers): it fires only when ALL of them have ended —
  replace the first test with `kill -0 <a> 2>/dev/null || kill -0 <b> 2>/dev/null || { echo "workers <a> <b> exited"; exit 1; }`
  — and its silence test names every run directory: `find "<run-dir-a>" "<run-dir-b>" -mmin -45 -print -quit`. The
  `watch-armed` marker of the third test goes in the first of them.
- Runner availability and capability — for a worker that waits on a runner, and for the start of an unattended batch
  that needs one: read the runner's line in `charness remote-run runners`. It must be online AND its `can:` part must
  name what the job needs — a runner that is online but shows `ios: no (…)` cannot run an iOS job, so it is not free.
- When it fires the topic gets one silent sentence («Worker "<role> <scope>" finished (2 h 5 min)», «… silent for
  45 min» or «… running 2 h 30 min without a report»), never the command and never a pin — a worker that simply finished fires it too. What the user must
  notice you ask as a question.
- The status arguments make the BOT post a silent status line into the topic every 15 minutes while the check
  passes (`⏳ <name> · works 30 min · now: <the worker's last action>`), replacing the previous one — no wake, no
  tokens, so the topic never looks frozen while you are away. Never arm a schedule of your own for status lines.
- The run directory is where the worker writes all the time (its event log). A worker that runs one long command
  may write nothing for a while: add the folder that command writes to (`find "<run-dir>" "<test-output-dir>" …`).
- The check's `prompt` must stand on its own — the wake may reach a resumed or compacted you: the role, the scope
  or plan path, PID, session id, run directory, and "read the result, decide, then cancel this check".
- The first failure is ALSO the "worker finished" signal. On the wake read the worker's result first (its final
  event, its exit, the end of its log), then decide: finished → the next step of the loop; stalled → look at its
  last tool call, stop it, resume the same session; running 2 h 30 min without a report → look at what it is doing
  now and step in, or, when it is fine, `touch` the marker and arm a new check; stopped by a usage limit → resume it
  at once on another account (Accounts and usage limits).
- Then cancel the check (`schedule_list` → `schedule_cancel`) — that also deletes its status line, so a finished
  worker leaves nothing behind. A new run gets a new check.
- Never build your own watcher: no sleep loop, `CronCreate`, `ScheduleWakeup`, background job or tmux pane. They
  live in your process, which the bot stops after an idle stretch.

## Between wakes

- After launching a worker and arming its check, write the worker state into the plan or draft (PID, session id,
  account profile name, run directory, scope, check name), then END your turn. The bot stops an idle agent process and resumes the
  conversation when the check wakes it; you lose nothing that is written down.
- Start workers with `setsid nohup` (the delegate skills show the command), so stopping your own process never
  takes a worker down.
- A worker must never hand back a run it has not read: one that ended its turn with a build or test still in
  flight is resumed to wait for it, read it and finish.

## Accounts and usage limits

- Before every Claude worker launch call `claude_profiles` with the worker's model and start the worker with
  `CLAUDE_CONFIG_DIR=<configDir>` of `recommended` (nothing when it is null). Take the account it names without
  asking — it follows the operator's /limits auto-switch list (an API-credit account first, then the soonest weekly reset).
- Record the profile name beside the worker's session id. Every resume calls `claude_profiles` with
  `currentProfile` = that name, so a warm worker stays on its account.
- A worker stopped by a usage limit resumes its SAME session at once, never a fresh worker (which would redo the
  work): call `claude_profiles` with `currentProfile` and `isStoppedByLimit: true` and resume under the account it
  recommends. `recommended: null` → nothing is usable: `schedule_create` a one-off resume (`onceAt` =
  `nextAvailable.at`) whose prompt stands on its own. `nextAvailable` null too → no account names a time it frees
  up: ask the user a native question (nothing can run) and `schedule_create` the same one-off retry about 30
  minutes ahead.
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

## Closing a task that ran on a runner

Done, and the LAST open task of its project folder (the tasks of one folder share ONE copy on a runner), which ran on a
runner (`charness remote-run`)? Run `charness remote-run clean` in that folder BEFORE you remove the folder or worktree
(the copy's name goes with it) and before you report; never delete other tasks' copies by hand. Report one line of outcome.
