---
name: charness-delegate-claude
description: "In a Charness-run session, use to launch, watch, finish and resume a builder, reviewer, investigator or planner as a detached `claude -p` process instead of an in-process sub-agent: the account from claude_profiles, the role's model and effort, a full-privilege worker with deny rules, its event log, the bot watch check, resuming the same session. Load charness-manager first."
---

# Detached Claude Code worker (Charness session)

A worker is `claude -p`: one turn per process, the conversation kept between runs by its session id. Load
`charness-manager` first — it holds the delivery loop and the watch check this skill arms.

## Account, model, effort

- New worker: call `claude_profiles` with the worker's model and no `currentProfile`. Start the worker with
  `CLAUDE_CONFIG_DIR=<configDir>` of the `recommended` profile (nothing when its `configDir` is null); without it
  the worker drains YOUR account. The bot picks the account whose weekly limit resets soonest.
- `recommended: null`: no account is usable now. Do not launch; `schedule_create` with `onceAt` = `nextAvailable.at`
  and a prompt that stands on its own (plan path, scope, what to launch), then end the turn. If `nextAvailable` is
  null too, no account names a time it frees up: ask the user a native question (nothing can run, no time known) and
  `schedule_create` a one-off retry about 30 minutes ahead, with such a prompt.
- Confirm the login under that directory: `env -u ANTHROPIC_API_KEY claude auth status --text`.
- Role defaults, unless the user names others:
  - builder (code, tests, debugging, live runs): `--model sonnet --effort xhigh`;
  - investigator (a cause still unclear after a builder failed on it twice): `--model opus --effort high`;
  - reviewer: `--model opus --effort high`; a small or mechanical diff (docs, tests only): `--effort medium`;
  - planner and the research feeding a plan: `--model opus --effort high`, `xhigh` for a large feature.
- Never Sonnet for work on data persistence (storage, DB schema and migrations, sync, merge and conflict
  resolution, backups — anything that can lose or corrupt user data): every role runs on Opus, a builder at
  `--model opus --effort xhigh` (`max` for a deep investigation). This beats the role defaults above.
- Never Fable for a worker: it drains the shared session and weekly limits fastest.
- The first `system`/`init` event must name the requested model; on a mismatch stop the worker and tell the user.

## Launch

1. Make a private run directory, generate a UUID for the session, write the brief into `<run-dir>/brief.md`:
   the task and its context (the worker does not see this conversation), the skills it must load by name, every
   resource another live process holds, and "report every changed file and how you verified".
2. Run it in the target checkout:

```bash
setsid nohup env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="<configDir>" \
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 BASH_MAX_TIMEOUT_MS=7200000 \
  claude -p --session-id "<uuid>" --model "<model>" --effort "<effort>" \
  --dangerously-skip-permissions \
  --disallowedTools Agent "Bash(git push *)" "Bash(git reset --hard *)" "Bash(git clean *)" "Bash(git branch -D *)" \
  --output-format stream-json --verbose --include-partial-messages \
  < "<run-dir>/brief.md" > "<run-dir>/events.jsonl" 2> "<run-dir>/stderr.log" &
echo $! > "<run-dir>/pid"
```

- Leave out `CLAUDE_CONFIG_DIR=…` for the default profile.
- `setsid nohup` detaches the worker from your process, so the bot stopping your idle process never ends it.
- `--disallowedTools` takes several values, so an option must follow it, never the prompt.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` stops the worker from backgrounding a run that would die when its turn
  ends; `BASH_MAX_TIMEOUT_MS` lets one foreground command run up to 2 hours. Longer work → split it.
- Full privileges with deny rules, never a restricted allowlist: a refused ordinary command ends the worker's
  turn early.
- A checkout below the folder that holds `.claude/skills` does not see those skills: add
  `--add-dir "<that folder>"` and check that the `init` event's `skills` lists every skill the brief names.
3. Check the PID: `ps -o args= -p "$(cat "<run-dir>/pid")"` must show `claude -p … <uuid>`. If it does not (the CLI
   handed over to a new process), take it from `pgrep -f "^claude -p .*<uuid>"` and write that into the pid file.
4. Record the UUID, the profile name you launched on, the checkout and the run directory in the plan, then arm the
   watch check from `charness-manager` with this PID and run directory.

## Watch and finish

- Progress: `python3 <this skill's base directory>/summarize-events.py <run-dir>/events.jsonl` — the tools it ran
  last, its last words, the final result, the account's usage windows.
- A quiet log alone does not prove a hang: look at the last tool call and API retries before stopping a worker.
- Done means ALL of: a final event `"type": "result"` with `"is_error": false`, the task's actual output in it,
  and the process gone. `"subtype": "success"` alone is not enough — it also appeared on an auth failure.

## Resume

- Confirm the old PID is gone, then repeat the launch with `--resume "<uuid>"` instead of `--session-id`, a new
  brief and new log files (`events-2.jsonl`, …), and arm a new check. Never `--continue` or `--fork-session`.
- Keep the model, effort and flags of the first run.
- The account: call `claude_profiles` with `currentProfile` = the profile name recorded at launch; the worker stays on
  it unless it can no longer run. Launch under the `recommended` profile's `configDir`, record that name.
- A run rejected on a usage limit ("You've hit your session limit"): call `claude_profiles` with `currentProfile` and
  `isStoppedByLimit: true`, and resume the SAME session at once under the `recommended` profile — never wait while an
  account is usable. `recommended: null` → `schedule_create` with `onceAt` = `nextAvailable.at` and a prompt that
  stands on its own (resume this session, call `claude_profiles` again); `nextAvailable` null too → ask the user a
  native question and `schedule_create` the same one-off retry about 30 minutes ahead.
- To stop a worker: confirm the PID is that worker (`ps -o args= -p <pid>`), `kill -TERM <pid>`, confirm it is
  gone. Never kill by name, never a process you did not start.
