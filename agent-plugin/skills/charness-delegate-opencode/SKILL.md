---
name: charness-delegate-opencode
description: "In a Charness-run session, use to launch, watch, finish and resume a builder, reviewer or researcher as a detached `opencode run` process instead of an in-process sub-agent: model and variant, deny rules, its JSON event log, the bot watch check, resuming the same session. Load charness-manager first."
---

# Detached OpenCode worker (Charness session)

A worker is `opencode run`: it exits when its turn goes idle and keeps the session for a later run. Load
`charness-manager` first — it holds the delivery loop and the watch check this skill arms.

## Model and variant

- The model and variant the user named; otherwise the ones this conversation runs on. `opencode models` lists
  what the configured providers offer — pick a listed model and a variant it supports.

## Launch

1. Make a private run directory and write the brief into `<run-dir>/brief.md`: the task and its context (the
   worker does not see this conversation), the skills it must load by name, every resource another live process
   holds, "spawn no sub-agents", "wait for your own tests before ending your turn", and "report every changed
   file and how you verified".
2. Run it:

```bash
setsid nohup env OPENCODE_CONFIG_CONTENT='{"permission":{"bash":{"git push*":"deny","git reset --hard*":"deny","git clean*":"deny","git branch -D*":"deny"}}}' \
  opencode run --auto --dir "<checkout>" --model "<provider>/<model>" --variant "<variant>" \
  --format json --title "<scope>" \
  < "<run-dir>/brief.md" > "<run-dir>/events.jsonl" 2> "<run-dir>/stderr.log" &
echo $! > "<run-dir>/pid"
```

- `setsid nohup` detaches the worker from your process, so the bot stopping your idle process never ends it.
- `--auto` approves every request that is not denied — the deny rules are the only guard, the brief is not one.
  Never edit the global OpenCode permissions for this.
- Without `--auto` the CLI refuses ordinary requests and the worker stalls.
3. Check the PID: `ps -o args= -p "$(cat "<run-dir>/pid")"` must show `opencode run … --title <scope>`. If it
   does not (the launcher handed over to a new process), take the newest match,
   `pgrep -n -f "opencode.* run .*--title <scope>"` (a launcher may run the binary as a child: two matches), and
   write that one PID into the pid file — the watch fires "worker exited" at once on a PID that is not the worker.
4. Record the session id — the top-level `sessionID` of the first JSON event in `events.jsonl` — with the
   checkout and run directory in the plan, then arm the watch check from `charness-manager` with this PID and
   run directory.

## Watch and finish

- The log gets an event per finished step or tool call, not per token: one long command can leave it quiet. Add
  the folder that command writes to into the watch check.
- Read progress from the tool calls, not only the text events:

```bash
jq -r 'select(.type=="tool_use" or .type=="text") |
  (.part.tool // "SAY") + (.part.state.metadata.exit // "" | if .=="" then "" else " exit=\(.)" end)
  + " :: " + ((.part.state.title // .part.text // "") | gsub("\\s+";" ") | .[0:120])' \
  "<run-dir>/events.jsonl" | tail -30
```

- Trust the `exit=` of a command over what the worker says about it.
- Done means the process is gone AND its last turn holds the task's result without an `error` event or a failed
  tool. A `step_finish` may still be followed by another step. When unsure: `opencode export <session-id>`.

## Resume

- Confirm the old PID is gone, then repeat the launch with `--session "<session-id>"`, a new brief and new log
  files, and arm a new check. Keep the checkout, model and variant. Never `--continue` or `--fork`.
- A turn stopped by a provider's usage limit: resume the same session with another provider's model whose
  context window holds the session.
- To stop a worker: confirm the PID is that worker (`ps -o args= -p <pid>`), `kill -TERM <pid>`, confirm it is
  gone. Never kill the OpenCode server or a process you did not start.
