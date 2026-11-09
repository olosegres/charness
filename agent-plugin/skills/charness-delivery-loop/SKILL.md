---
name: charness-delivery-loop
description: "Only when this session lists NO other manager skill (neither the project's nor the user's own): a small built-in delivery loop for orchestrating detached workers — modes, builder and reviewer roles, the finish step, parallel work in worktrees, the queue, briefing. In a Charness-run session load it together with `charness-orchestration`, which holds the bot's tools. A general manager skill is listed → follow that one and do not load this."
---

# Delivery loop (the fallback manager)

You orchestrate: workers build, test, review and commit; you decide, keep the plan honest and keep the user
informed. You never write product code and never review a diff yourself. The bot's mechanics (launching, the watch
check, accounts, reaching the user) are in `charness-orchestration`; this skill is only the loop.

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
- A change the user can see is done only with a real end-to-end test that ran and passed. Never accept a stub, a
  lower-level substitute or "test debt".
- Your own bookkeeping commits (a plan edit, a recorded decision) need no approval, in either mode; workers
  commit their own work.

## Parallel work and the queue

- Reviewers and researchers run without limit alongside everything else: they only read.
- Builders: each separately released task — one that could be reviewed, merged or reverted on its own; every separate
  ask in the queue counts, even when the project ships one release a day — gets its own git worktree and branch, named
  in its brief; the builder commits only there. A lone task, or the scopes of ONE plan or task, works on the current
  checkout. Two tasks touching the same file queue.
- Serialize what shares state: builds, test runs (devices, ports, e2e lanes — through their locks) and commits
  (one at a time, path-limited). Two workers never share a file, a port, a browser profile or a device at once.
- Every new ask joins the queue the moment it is said; start it at once when nothing it needs is taken, else tell
  the user its place. A long run never holds the queue: while a worker waits on a long run (a full suite, a remote
  job, a busy lane), start the next independent task — in its own worktree when it is released separately.

## Briefing

- Brief for a ready plan: its path, "implement it yourself, spawn no sub-agents", and — when several scopes go to
  one builder — "your scopes are one batch: test each pointwise (unit tests and only its own new or changed e2e
  flows), the full suites run once at the finish".
- Brief without a plan: like a colleague who just walked in — the goal, file paths, what to change and why. Never
  "based on your findings, implement it".
- Name the skills the worker must load, never their content, and never restate project rules.
- Role skills such as `developer`, `task-review`, `review`, `commit`: name them when the project offers them.
  Otherwise state the role in words — builder: implement, test, self-review, commit each scope, no push;
  reviewer: read the commit range against the plan or the user's asks and report findings, change nothing.
- Reuse the warm session: rework, the next small scope, or the next role on the same task resumes the SAME worker
  session instead of starting a fresh one.

## Delivery loop — a ready plan

1. **Build.** One builder for the whole plan (or a group of small scopes); it commits each scope as it is green.
   A large or risky scope, or an independent part running in parallel, may get a builder of its own.
2. **Bookkeeping.** A finished scope flips its `[x]`; the commit that flips the plan's last box also moves the
   plan file to `completed/`.
3. **Finish — only when the whole task is done, never per scope:**
   1. A fresh reviewer reviews ALL the task's commits once. Its brief: the plan path or the user's asks nearly
      verbatim, the commit range, and the absolute path of its report file outside the worktree (e.g. its run
      directory) — it writes nothing inside the worktree. Findings go back to a builder as rework, then a new review.
   2. Clean → merge the task's branch into the base by fast-forward and remove its worktree. A branch that cannot
      fast-forward goes back to its builder: rebase onto the base, rerun the tests the base's new commits affect.
   3. A builder fetches; if the branch or its base moved on the remote, it pulls and rebases; then it runs ALL test
      suites in full and fixes every failure.
   4. Any fixes in 3 → a separate reviewer reviews just those fixes (same report path rule), then back to 3. Push
      only after a full green run with no fixes after it.
   Each loop runs up to 20 cycles while the findings are concrete local fixes, telling the user about each cycle
   past the third — even when new findings keep landing in the same area. A major finding, or the 20 cycles used
   up: stop, leave the work for inspection, report. Never propose cutting the agreed scope to escape the loop.
4. **Push** only when the user allowed it (in chat or in their own instructions); otherwise report it ready to
   push — as a question the user will notice.

## No plan yet — interactive

- **Bugs and small reworks:** capture each into a living plan the moment it is said (stable ids, never renumber,
  never drop a deferral). An unambiguous one goes to a builder at once; only a fork you cannot resolve goes to
  the user first.
- **A feature or idea:** capture a draft; a researcher worker investigates the code and the web, decides every
  point itself and returns a summary, its decisions and only the forks it could not resolve. Show them, record
  the locked decisions, and ask before switching to building.

## Finally

Confirm from the reports that every changed file is listed, verification passed, the reviews are clean and the
plan is archived. Blocked or incomplete → leave the plan as it is for inspection. Report one line of outcome.
