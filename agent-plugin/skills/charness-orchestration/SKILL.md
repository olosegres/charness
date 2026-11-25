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
  user named, otherwise the one a general delegate skill names for the role, otherwise `worker.cli` of `claude_profiles`
  asked with the worker's `role` (the bot's default — your own instructions win), otherwise the CLI you run in.
- A worker that runs tests on a runner shares it with other jobs: its test scripts bind ports from `$REMOTE_RUN_PORT_BASE`, use
  the simulator `$REMOTE_RUN_IOS_SIMULATOR_UDID` and never run `simctl shutdown all` or name `booted`; the tool's `--help` has the rest.
- Name every resource another live process holds (a checkout, a port, a device) in the brief.

## Watch every worker with a bot check

Right after each launch, `touch "<run-dir>/watch-armed"`, then create ONE check for that worker run with
`schedule_create`: cron `*/5 * * * *`, `statusWorkerRunDir: "<run-dir>", statusEveryMinutes: 15`, a name like
`watch <role> <scope>`, and this `checkCommand` with the real PID and run directory (`<run-dir>` is an absolute path:
the check runs in the topic's folder, so a relative path or `~` points elsewhere):

```
kill -0 <pid> 2>/dev/null || { echo "worker <pid> exited"; exit 1; }; [ -n "$(find "<run-dir>" -mmin -45 -print -quit)" ] || { echo "<run-dir>: no change for 45 min"; exit 2; }; [ -e "<run-dir>/watch-armed" ] || { echo "<run-dir>/watch-armed: missing, touch it when you arm the watch"; exit 4; }; [ -n "$(find "<run-dir>/watch-armed" -mmin -150 -print -quit)" ] || { echo "<run-dir>/watch-armed: older than 2 h 30 min"; exit 3; }
```

- It fails on ANY of three signals: the worker's process is gone, nothing in its run directory changed for 45
  minutes, or the watch was armed 2 h 30 min ago — the worker has run that long without a report. A check that
  only runs `kill -0 <pid>` never fires on a hung worker — never arm one.
- The third signal counts from the age of `<run-dir>/watch-armed`: `touch` it right before you arm the check — also when
  you resume a worker and arm a new check on its reused run directory, where the marker of the first run is old. A
  check alerts once per failing episode and passes again when its tests do: after you looked at a worker that is fine,
  `touch` the marker again and KEEP the same check — it passes at its next run and watches on (the topic reads «Worker
  … is working again»); never arm a second one beside it. A run directory without that file fails at the first run with
  its own exit code 4 (the topic reads «Check fired», the output «watch-armed: missing»): `touch` it and the check
  passes again.
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
  now and step in, or, when it is fine, `touch` the marker and KEEP this check (do not cancel it); stopped by a usage
  limit → resume it at once on another account (Accounts and usage limits).
- Then cancel the check (`schedule_list` → `schedule_cancel`) — unless you kept it for a worker that is fine — which
  also deletes its status line, so a finished worker leaves nothing behind. A new run gets a new check.
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

- Before EVERY worker launch or resume call `claude_profiles` — with the worker's model, or its `role` when nothing you follow
  names the model (the answer then says which CLI too); on a resume also `currentProfile` (the
  profile name recorded at launch) and `lastRunEndedAt` (the last write of its log, an ISO instant) — and start the worker with
  `CLAUDE_CONFIG_DIR=<configDir>` of `recommended`, on a resume of `resume.profile` (nothing when the `configDir` is null; without
  it the worker drains YOUR account). Take it without asking: it follows the operator's /limits auto-switch list — an API-credit account first, then the
  soonest weekly reset, so what expires first is spent first. Never reuse an earlier answer. Record the profile name beside the
  worker's session id.
- `resume.verdict: handOver` → do not resume that worker on another account. Give its work to a NEW worker on `resume.profile` (brief:
  the old run's report, the worktree, the findings); a reviewer that already runs on that account may apply its own findings, then a
  fresh reviewer checks the result. `resume.verdict: resume` → resume the session under `resume.profile` (where it ran, unless it
  stopped on a limit).
- The exception: a worker cut off MID-RUN by a usage limit («You've hit your session limit», «Credit balance is too low») — a fresh
  worker would redo the unfinished run, so call `claude_profiles` with `currentProfile` and `isStoppedByLimit: true` and resume the
  SAME session at once under `resume.profile`.
- `recommended: null` → nothing is usable: do not launch. `schedule_create` a one-off resume (`onceAt` = `nextAvailable.at`) whose
  prompt stands on its own (the plan path, the scope, what to launch, «call `claude_profiles` again»), then end the turn.
  `nextAvailable` null too → no account names a time it frees up: ask the user a native question (nothing can run) and
  `schedule_create` the same one-off retry about 30 minutes ahead.
- An `[Accounts …]` note (at a wake, in a send tool's result, during a turn) says where the limits stand: plan your next launch on it
  and call `claude_profiles` right before it. No reply is needed; a worker that is running stays where it is.
- A role the user allowed on both CLIs: start it where the limit resets sooner and still has room.
- A worker that only waits for a shared lane is not kept running: resume it when the lane frees.
- Your own usage limit is the bot's business: it waits or switches and then wakes you.

## Talking to the user

- The user keeps the bot's topics muted: your plain text reaches the topic silently. Anything they must notice —
  a blocker, a fork, "ready to push" — ask as a native question (Claude Code: `AskUserQuestion`; OpenCode: its
  question tool); the bot pins it, and the pin notifies. In autonomous mode stop and report instead.
- A question never stops your work: when the bot sets it aside, go on; the answer comes later as a message.
- A message headed `[Request <id> · from: …]` is answered through `answer_request` (`progress`, `question`,
  `final`); do not repeat its text as plain text afterwards. A header that says to answer only when you have a result
  (a scheduled run) may be left unanswered: with nothing to report, end the turn silently.
- The passing-run video of a new e2e test → `send_file_to_user` (H.264 `.mp4`, sent as a video). Several
  separate items, e.g. one per finished scope → `send_messages_to_user`.
- Work the user wants later → `schedule_create` with `onceAt` and a prompt that stands on its own.
- Write for a non-technical reader: the status, then the next steps as a short numbered list of who does what.

## Talking to peers

- A peer session's name changes on every resume: address it by the `from=` of its latest message, or look it up
  with ListAgents first.

## A tracker conversation (Jira)

The same tools and the same watch recipe as in a topic (the sections above). What differs on an issue: the bot posts NOTHING
there for a scheduled run, a check or a status — a comment always notifies the requester and the issue's watchers — so none
of the topic's lines exist (no status line, no «worker finished» sentence, no «working again»), and the check's status
arguments only mark it as a worker watch.

- After the launch and the armed check, answer `answer_request` kind `progress` (what runs, where — its link — and when it
  should end, never only «I'll report when it finishes»), then END your turn. Do not poll the worker. The bot stops your idle
  process; when the check fails (the worker finished, went silent, or ran 2 h 30 min without a report) it resumes you in THIS
  issue, behind a header that names the request open then. A new comment on the issue reaches you at the bot's next poll of
  the issue, asleep or not; while a turn runs it waits up to 10 minutes for it to end, then joins it.
- At a wake read the worker's result first and decide as above; never give a `final` answer with a run you have not read.
  Answer the request the header names (`answer_request` with that id) only with a result the requester needs — a
  milestone, the final answer. A wake you handled with nothing to report ends
  silently: no comment, no "still waiting". The exception is a header that says the request still owes the requester an answer
  (a comment the bot lost track of): answer it in this turn.
- A header that says `no request is open`: the request you armed the job under is finished. An answer to it still becomes a
  comment but hands nothing back — answer only what the requester must know, and cancel the job (`schedule_cancel`) if it
  served only that request.
- A job outlives its request: when the work it served is done, cancel it. A watchdog meant to outlive the work (a health check, a
  daily job) is armed and then the request is answered `final`: the job keeps running and its fires say `no request is open`, or ride
  the request open at the time (a later hand-over, a mention: answer that request only with what its requester must know, not about the
  job). A job left armed under a request you keep open holds that request waiting — not reminded between turns while it owes nobody an
  answer; a requester's comment you leave unanswered still is — and its task-agent slot taken for as long as the job lives.
- A screenshot or the passing-run video goes into the answer itself: its path in `answer_request`'s `files` (an H.264
  `.mp4` plays in the comment); `send_file_to_user` posts files in a comment of their own.

## Closing a task that ran on a runner

Done, and the LAST open task of its project folder (the tasks of one folder share ONE copy on a runner), which ran on a
runner (`charness remote-run`)? Run `charness remote-run clean` in that folder BEFORE you remove the folder or worktree
(the copy's name goes with it) and before you report; never delete other tasks' copies by hand. Report one line of outcome.
