# Changelog

## Unreleased

**A message you forward into a topic now reaches the agent marked as forwarded — from whom and when it was originally sent — instead of passing for your own words.**
Before, the agent got only the text of a forwarded message: two bot alerts you forwarded as examples were read as your own report, and nothing told it they came from somewhere else.
Now:
  - A forwarded text, a caption, a voice note (its transcript) and a file or an album lead with one line — «[Forwarded message · from: channel "Ops Alerts" · originally sent: 2026-11-06T14:20:00+04:00]». It names the origin (a user with their @username, a hidden user, a chat or a channel, with the post's signature when it has one) and the original send time on your `/timezone` clock. The origin's name is quoted and cleaned of brackets and control characters, so a channel titled to look like an instruction cannot close the line and speak outside it.
  - Each forwarded message is marked on its own: several forwards followed by your own words reach the agent as separate messages, every forward with its own origin and only your words unmarked. A forward that is also a reply carries the reply quote and the mark. A message typed into a terminal topic reaches the shell as before, unmarked.
  - A forwarded message is content, never an order: a forwarded `/quit` runs no command and stops nothing, a forwarded `/review the diff` reaches the agent marked instead of as a slash command of your own, a forwarded «1» answers no pending question and picks no option, and a forwarded «claude» starts no agent. The agent reads each of them marked.
  - A reply to a message you forwarded earlier names who first wrote it — «[Replying to an earlier message · from: user, forwarded from channel "Ops Alerts"]» — so the forwarded words do not pass for yours one step later.
  - A forwarded message (or a reply) that waits for the agent — behind a usage-limit wait, a restart, a failed post — is posted again with its mark and its quote: the request keeps the prompt as it was posted, not the bare text.
  - A scheduled run held over a usage-limit wait rides after the message that ends the wait, under a line of its own («[Held over the usage-limit wait — not part of the message above]»), and no longer sits under that message's reply quote or forwarded mark as if it were part of it.

**A scheduled run and a check alert no longer pin themselves into the topic, and the alert says what happened in a sentence instead of printing a command line.**
Before, every fired schedule and every check alert was pinned (the pins piled up as run history), and a check alert printed the shell command, its exit code and the raw output — «🚨 Check "watch builder S2" failed: exit 1 (every 5m) $ kill -0 4242 2>/dev/null || { echo "worker 4242 exited"; exit 1; }; …» — which says neither what happened nor why.
Now:
  - A scheduled run is announced by one silent line — «⏰ Scheduled: Nightly build · every day at 02:00», with the catch-up note when it fires late — and the prompt it carries is folded under it in an expandable quotation (the instruction to the agent is there when you want it, out of the way when you do not). Nothing is pinned: pins stay for the agent's questions and for `/reminders`, which are meant to ring through a muted topic.
  - The schedule in that line is said in your language and never as a cron expression: a fixed step reads «every 5 min», and a shape no wording fits (twice a day, weekday office hours) shows its next run, «next: 2026-06-07 18:00» — and «the last run» on the final run of an N-times schedule, which has no next one. If Telegram ever refuses a message's markup (this one, an agent's formatted output — new messages and edits alike —, its status, thinking and sub-agent frames, a pairing message), the same words arrive as plain text instead of with the tags showing.
  - A check's first failure is one silent sentence, never the command: «🔔 Check "API health" fired — waking the agent.» with the failure and the tail of the output folded under it. A watch on a worker says «✅ Worker "builder S2" finished (2 h 5 min). Reading the result.» when the worker is gone, or «⚠️ Worker "builder S2" has been silent for 45 min. Checking whether it hung.» when its run directory went quiet. When the check passes again: «✅ Check "API health" is back to normal.», or «✅ Worker "builder S2" is working again.» for a worker watch. The agent still gets the command, the exit code and the output in its prompt.
  - Alert pins left by earlier versions are unpinned by themselves at the check's next run (or when it is cancelled), so nothing stays pinned for good; a pin Telegram did not answer for is tried again at the run after. Pins of old scheduled-run announcements were never tracked and stay until you unpin them.
  - The agent's confirmation of a new schedule, which a topic shows as a tool result, is one line — `Scheduled "Nightly build": daily at 02:00; next: 2026-06-07 02:00` — plus the id it cancels by, so a schedule read in the wrong timezone shows at once. `isPinSilent` of `schedule_create` is still accepted and does nothing.

## 3.10.0 — 2026-11-06

**A MacBook runner with its lid closed no longer gets a new job that dies when the Mac sleeps — it waits like an offline runner, and `runners` says «lid closed».**
Before, a Mac runner with the lid shut (no external display) slept about a minute and a half later, and on power macOS woke it for a minute or two every quarter of an hour; the runner reconnected in those windows, looked available, and a job that landed there was cut when the Mac went back to sleep.
Now:
  - A Mac runner puts its lid in the request that makes its link, so the charness host knows it before the runner is online, and then looks every 10 seconds and tells the host when it changes. Closed means the lid is shut and closing it sleeps the Mac; a lid shut with an external display keeping the Mac awake, an open lid, a Mac without a lid and an unreadable reading all count as open, so such a runner works as before. Other systems never report a lid.
  - A lid-closed runner takes no NEW job: `remote-run` and `exec` skip it, a runner named with `--runner` is refused with «has its lid closed», and `--needs ios` waits for it (`--runner-wait`, 15 minutes by default) exactly as for an offline runner. A job already running there is not touched, and `status`, `wait`, `logs` and `kill` of it work.
  - `remote-run runners`, `charness runners ls` and `/runners` show «lid closed» instead of «online». Opening the lid makes the Mac available within about 10 seconds and a waiting job starts. A Mac that wakes for a minute with the lid still shut is never available, not even for a second: the lid it has is in the request that brings it online. A host that refuses the reports is not asked again at every look (30 s, doubling to 5 minutes).

**An always-on Mac runner that updated itself now gets the missing iOS login-session agent by itself — no second paste of the admin line, and `runners` no longer says «needs a login» when the real problem is something else.**
Before, a Mac paired before the login session's agent existed updated to the new version but never received the agent: `runners` kept saying «ios: needs a login of runner» although the account was logged in, and only pasting the `sudo` pairing line again helped.
Now:
  - When the runner starts (an update restarts it) and once an hour, a runner kept running by an admin's line looks for the agent in the account's own `~/Library/LaunchAgents`. A missing or older definition is written and loaded into the account's login session — no admin rights, they are the account's own files — and an agent that is already running is replaced only while the Mac runs no job.
  - With nobody logged in as the account the file is written and launchd loads it at the next login, and `runners` keeps saying a login is needed.
  - A running agent is replaced only while the Mac has no job running or waiting in its queue; the queue is looked at again right before the old agent is stopped.
  - When it cannot be done (the folder cannot be written, `launchctl` refuses), `runners` and a refused `--needs ios` job say so with the reason instead of «needs a login»: «log out and back in as the account, or paste a fresh admin line from /runners» when the agent's definition is in place (logging in loads it), «paste a fresh admin line» when it is not. «Nobody is logged in» is believed only when launchd says the login domain does not exist AND the account runs none of the processes of a login session.

**A voice note that waits for its text now shows «🎙 Transcribing the voice message…» in the topic, so it no longer looks lost.**
Before, while the bot waited for a local speech engine that was still loading its model (up to 2 minutes), the topic showed nothing until the 🎤 transcript — a voice note that took a while looked as if it had been dropped.
Now:
  - When the text is not there 3 seconds after the voice note arrives, the bot posts a silent note (no notification, even in an unmuted topic); a warm engine answers sooner and the topic shows nothing. A voice note waiting in line behind an earlier one in the same topic gets its note too.
  - The note is deleted the moment the 🎤 transcript arrives, or when the voice note fails (the failure notice stays as before) — the delete goes out before the transcript, and a stalled one never holds the transcript back for more than a moment.
  - A bot restart while the note is up removes it as well: a graceful stop (a hot reload) deletes it — also one whose send is still on its way —, and the next start deletes one left by a crash.
  - A temporary-status message (the «working…», thinking or sub-agent line, or this note) whose delete fails for a bad moment at a restart — no answer from Telegram, a rate limit, a server error — is no longer forgotten: it stays recorded and is deleted at the next restart, instead of staying in the topic for good.

**A watch on a worker now keeps its topic alive: while the worker runs, the bot posts a short silent status line every 15 minutes, so the topic never looks frozen while the agent is away.**
Before, a watch on a detached worker said nothing for as long as the worker ran — a builder that worked 7 hours overnight left its topic without a message for 7 hours, and the only remedy was a schedule that woke the manager agent every 50 minutes (tokens and context spent per heartbeat, and nothing posted while the agent compacts).
Now:
  - The bot itself posts the line — «⏳ builder S2 · works 30 min · now: Bash: Run the unit tests» — every 15 minutes while the watch passes, with no agent wake and no tokens, so it keeps coming while the agent is idle, compacting or stopped. It is sent silently and never pinned, and each new line replaces the previous one (posted first, the old one deleted), so the topic holds one line at the bottom of the activity.
  - «now» is the worker's last text or tool call, read from the newest `events*.jsonl` in its run directory, for Claude Code (`stream-json`) and OpenCode (`--format json`) workers; a worker that hangs shows as a «now» that does not change, and the 45-minute stall alert still fires.
  - The line stops when the check fails (the worker finished or hung — the existing alert and agent wake take over), is cancelled, or the topic leaves its folder, and its last line is deleted with it. A topic on the answers-only view, and a Jira issue, get no line.
  - Any check can opt in: `schedule_create` takes `statusWorkerRunDir` (a worker's run directory) or `statusCommand` (its first output line is «now»), and `statusEveryMinutes` (5–240, default 15), together with `checkCommand`. The worker-watch recipe in the bot's tool texts and in the `charness-manager` skill passes them and now ticks every 5 minutes instead of 10, so an exited worker is noticed within 5 minutes.

**A voice note sent while the machine is busy is no longer lost to «the local engine was not ready in 15 s» — the voice now waits for the local engine to finish loading.**
Before, the bot gave up on the local speech engine 15 seconds after starting it; the model load takes 2–3 seconds on an idle machine but longer than that on a busy one, so the engine was killed unfinished, the voice failed, and the next voice began the load from zero — it failed the same way, again and again.
Now:
  - A local engine that is alive and still loading is waited for, up to 2 minutes from its start; a voice that arrives meanwhile (or after a bot reload) waits for the same start instead of launching another. Only an engine that dies, or one that is still loading after 2 minutes, fails the voice — and the failure now says so («the local engine was still loading its model after 120 s»); a slow load also leaves a line in the bot log. The 2 minutes are counted from the engine's own start, so an engine that is replaced after it died gets its own 2 minutes.
  - When another engine follows the local one in the list, a voice waits for the local engine's start only about 15 seconds and then moves on to the next engine, while the local engine keeps loading — so the next voice finds it ready. When the local engine is the last one, the voice waits for it.
  - The engine starts loading the moment a voice note arrives, before its download, when it is the first engine of the list; a hosted engine in front starts nothing. A start that fails then is one failed start for that voice, not two, and is logged. That early ask never judges an engine that is busy and slow to answer, so several voice notes in a row cannot get a busy engine replaced; the voice's own request still does, so an engine that is really stuck is still replaced.
  - The local engine now stays loaded for 60 minutes after the last voice note instead of 15 (it holds about 0.5 GB while loaded; «⏱ Exit after idle» on its `/stt` card sets it). The 15 was the old default that the bot itself had written into `stt.json` — so at the next start a stored «15 minutes» is dropped and the engine follows the new default (if you chose 15 yourself, pick it again on the card; a 15 picked from now on stays), and `stt.json` now stores only the settings that differ from the defaults. The file keeps the layout every earlier charness reads, so rolling back or downgrading does not turn voice off; a note beside it, `stt.defaults-migrated`, records the migration, and a file an older charness saved in between (it writes the defaults back) is migrated again at the next update.

**The `sudo` pairing line is safer and says what it does, and the owner is told when a runner's link comes from somewhere else.**
Before, the line was silent between the paste and «paired», ran the runner account's code with the admin's own terminal attached and with a Node from anywhere, installed the runner's packages against open version ranges, let a second machine replace a runner's link without a word, and left the commands that remove an always-on service to the machine's own program, which the account can change.
Now:
  - The lines tell each step as they go — checking the account, downloading the package, installing the runner program, checking the machine, pairing, getting Pueue, finding rsync, installing the service — one line each, with cycling dots on a terminal.
  - When the code is used or runs out, the Telegram message with the admin account's `sudo` line turns into «paired» or «expired» and the message with the runner account's plain line is deleted (a message you deleted by hand counts as settled). A machine's default name drops the `.local` its network adds.
  - `charness runners ls` shows how a machine is kept running as it is now, waits at most 8 seconds for a machine to say so, does not ask a silent machine again for 10 minutes, and says on its row when the report it shows is older than the machine's link and the machine did not answer.
  - Everything the admin line runs as the account — the pairing, the service install — runs with no terminal attached (a session of its own, no input, its output passed on with the control characters removed), so code the account can change never reaches the admin's terminal and cannot hold the paste either: a step that leaves a process behind holding its output ends at its deadline, a stop signal (Ctrl-C) always ends the step — also one that arrives the instant the step starts — and a second one kills it outright. The pairing moved from the shell into the root step, which also made the line shorter.
  - The admin line never uses a Node.js inside a home folder or one that the runner account can write (root must not run what the account can change): it picks one outside every home (`sudo`'s own, or Homebrew's or `/usr/local`'s) or stops with the way to install one, so the runner's launcher and service do not depend on a folder that may be closed. Both pairing lines warn when the runner account can read other users' homes (macOS: `750`, group `staff`), naming them with the one-line fix `sudo chmod 700 /Users/<name>`.
  - The runner installs its packages with `npm ci` from a lockfile that the hub's package carries — made from `yarn.lock` for exactly the packages the runner needs (`ssh2` and `zod` with what they use), each pinned by tarball and hash — instead of `npm install` against open version ranges, so an update can never pull a version that was published after the hub last ran it.
  - The hub notes where each runner's link connects from, and the bot posts one message in General, pinned, when a link comes from another address than the one before it (and whether it took the place of one still up) or when two links keep replacing each other: a job on the machine can read its key, and a second machine with it would otherwise replace the first without a sound. `charness runners ls` and `/runners` keep the note until the runner is removed or paired again.
  - Removing a runner that runs as an always-on service tells you — in `charness runners remove` and in a second message of the `/runners` Remove button — that the service keeps running on the machine until an admin there stops it, with the exact `launchctl` / `rm` commands; `charness runners service-removal <name>` prints them for a runner that stays. The charness host makes them, no longer the machine's own `charness-runner service uninstall`, which only points at them: the agents run as that account and can change what it prints.
  - `docs/remote-run.md` now says what a job on the runner machine can reach — the machine's own network (the LAN, VPN interfaces, its localhost services) — with a `pf` rule for a Mac and an `nftables` one for Linux that fence the runner account, that each paste of the admin line gives the charness host root on the machine once, and that an admin line should not be pasted again on a runner that has already run jobs with a charness older than this one.

**A job on a runner now runs in a UTF-8 locale, so CocoaPods (and any tool that insists on one) no longer crashes on `pod install`.**
Before, every job ran with `LC_ALL=C` — the runner script's own setting for stable text handling — and CocoaPods refused to start on it («Unicode Normalization not appropriate for ASCII-8BIT»), so an iOS dependency step failed on a Mac that was otherwise fine.
Now a job (and `remote-run exec`) gets `LC_ALL=C.UTF-8`, or `en_US.UTF-8` where the machine has no `C.UTF-8`, and only a machine with neither keeps `C`; the runner's own scripts keep `C`.

**The runner's iOS check no longer says `ios: no` on a Mac whose Simulator works.**
Before, the boot check paired the newest iOS runtime with the last iPhone of the device-type list — and a new runtime runs only a few device types (one Xcode's newest runtime ran just «iPhone Duo»), so `simctl create` refused the pair with «Incompatible device» and `charness remote-run runners` showed the Mac as unable to build for iOS.
Now the check takes the device types each runtime itself lists as supported and boots the newest iPhone of the newest runtime that has one.

**`charness remote-run --runner <name> exec <command>` now runs the command on that runner instead of starting a job whose command is the word `exec`.**
Before, options came first and the first word after them was always the job's command, so `--runner studio-mac exec ls` queued a job `exec ls` — the shell's own `exec` builtin, which replaces the job's shell and ends it — and the agent got a job result instead of the listing it asked for.
Now `exec` after `--runner` is the `exec` subcommand on that runner, any other option before `exec` is refused with a line saying `exec` takes only `--runner`, and any other subcommand name after options (`--bg ls build`) is refused with the way to run a command that is called so: put `--` before it.

**`charness remote-run … | head` no longer dies with a stack trace and a job killed for no visible reason — it stops its job and says why.**
Before, once the reader of the pipe had gone, the next line of output hit the closed pipe, remote-run crashed on the write error, and its job was left to the runner's lease to kill a few seconds later (exit 137) — with nothing on the screen naming the closed stdout.
Now a foreground run or `exec` whose stdout was closed stops its job at once, says «stdout was closed … — job box1-abc234 was stopped on box1; to read only a part of a long output, start it with --bg and use `logs <id> --tail <lines>`» on stderr and exits 141 (the shell's code for SIGPIPE); `logs -f`, `wait` and `ls` simply end.

**A failed dependencies step now shows its real error — the first error lines of its output and of the build log the tool names — instead of only the last lines, where the cause is not.**
Before, `charness remote-run wait` showed the last 50 lines of a failed `yarn install`, which were yarn's own summary («sqlite3 couldn't be built successfully, logs can be found here: …/build.log»); the real error — a Python without `distutils` in the native build — sat far above, and the build log was in a temp folder on the runner, so finding the cause took a hand-made `exec` of the step again.
Now the job's log ends with the first eight error-looking lines of the step and the first eight of each `build.log` it names (a log the tool already removed is named as gone, with `-e YARN_ENABLE_INLINE_BUILDS=1` to get the build output into the log), so the cause is in what `wait` and a foreground run print.

**`charness remote-run --send <path>` sends a held-back secret-looking file for one call, and the «held back» line is said once per change instead of before every run.**
Before, a `.env.test` or a `.pem` fixture that a test needs on the runner could only be opted in with `send:` in the project's `.remote-run` — a file a read-only checkout cannot take — and a project with sixteen such fixtures printed all sixteen names before every single run, until nobody read the line.
Now `--send <path>` (repeatable, a pattern relative to the project root, also for a file git ignores) sends the named files for that call alone and says so; the held-back line names the first five files and comes again only when the list changes — a file added, removed or opted in.

**A runner's jobs keep `yarn` and `pnpm` when the link restarts under another Node, and `charness remote-run runners` shows which Node and yarn the jobs run with.**
Before, `yarn` was on a job's PATH only when somebody had enabled it for the very Node that ran the link — a Node from nvm ships Corepack without its shims — so when the link restarted under another Node (nvm's default changed), the next job ended with `yarn: command not found` (exit 127) and nothing in `runners` hinted at why.
Now the runner offers `yarn` and `pnpm` as Corepack shims in its own `bin` whenever the Node and the system do not have them (at every link start and on `charness-runner check`; a Node without Corepack is reported in the log), and `runners` — in the terminal and in `/runners` — has a line `jobs run with: Node v24.22.2 · yarn 1.22.22`, with `yarn: NONE` when a job that calls it would fail.

**A runner's Simulators are kept silent: an iOS job on a Mac no longer plays its sound to whoever sits at it.**
Before, an app's voice preview in an iOS test on the runner Mac came out of the Mac's speakers — the owner heard it in a call in another account of the same machine — because a Simulator plays through the host's audio, whichever account runs it.
Now the runner silences each booted Simulator itself — its own volume state, set to 0 once its boot has finished and again after every boot — and touches nothing of the Mac's volume, output or mute; a command that fails is a line in the runner's log, never a failed job. It is a third-party measurement, not Apple's documentation, and the first seconds after a boot are not covered: the first real run on a Mac confirms it.

**iOS builds on an always-on Mac now run in the runner account's login session — where Xcode's nested builds work — and say honestly when there is none.**
Before, every job of a Mac kept running by the admin line's LaunchDaemons ran in launchd's System session, where the nested `xcodebuild` of an Expo build crashed (SIGTRAP at «Resolve Package Graph»; the same build passed from a LaunchAgent in the account's session), so an iOS build needed a hand-made wrapper around every command — and the runner said «ios: no — needs the runner user's login session» whenever the Simulator would not boot.
Now the admin line also loads a small LaunchAgent into the account's own login session (at once when there is one, at its next login otherwise): a job with `--needs ios` runs its dependencies and command there, as the same account with the same environment; with no session `charness remote-run runners` says «ios build: needs a login of runner», the job is refused with those words, and nothing logs in by itself — after a reboot, log in as the account once and switch back. Replacing a loaded service by pasting the admin line again waits for running jobs (it is refused until they are done), and removing the daemons removes the agent with them.

**A crash or restart of the login session's agent no longer leaves an iOS build running beside the next job.**
Before, a step the agent ran (an `xcodebuild`, say) was its own process group that a dying agent did not take along, so the job was cut with 125, its project lock went to the next job, and the orphaned build kept writing into the same tree and the job's log.
Now the agent records each step's process group and the job script ends that group (TERM, KILL after 10 s) before it goes on; an agent that starts ends the groups of the instance before it. And the agent no longer crashes when the job script has already removed a cut step's folder by the time the step's end is noticed.

**The Simulator silencer no longer boots a Simulator that a job has just shut down, and it also runs on a Mac whose link runs in a login session.**
Before, it waited for a device's boot with `simctl bootstatus -b`, which boots a device that is not booted — a device shut down between the list and the call stayed up with nobody to stop it — and it ran only inside the always-on Mac's login-session agent, so a Mac kept running by a user service or by `charness-runner run` was not silenced at all.
Now it asks `bootstatus` without `-b`, and a link that runs in a login session silences its own Simulators the same way; what a Simulator booted from the System session looks like to it is not verified and is said so in the docs.

**On an always-on Mac every job now runs in the runner account's login session while it exists — an iOS build no longer needs to be marked to avoid the System session's crash.**
Before, only a job started with `--needs ios` went through the login-session agent, so an iOS build sent to the Mac with `--runner mac` and no `--needs ios` still ran in the System session and hit the nested-`xcodebuild` crash with no hint of why.
Now every job's steps go through the agent while the session exists; with no session the jobs that do not need iOS run in the daemon as before, and `--needs ios` is refused with «ios build: needs a login of <account>». The agents' instructions and `charness remote-run --help` now say that an iOS build or a Simulator test always carries `--needs ios`.

**A runner now keeps its machine awake while it runs — lid open, the Mac never sleeps; lid closed, it sleeps as usual — and `runners` says whether it does.**
Before, a Mac runner that went idle between two jobs fell asleep, dropped the link, and the next job found it offline — the thing `caffeinate` does by hand — and nothing told the owner it was the Mac's sleep.
Now the link holds an idle-sleep assertion for as long as it runs — `caffeinate -i` on a Mac, `systemd-inhibit --what=idle` on Linux — tied to the link's process, so stopping, removing or crashing the runner lets the machine sleep again with no orphan; it never touches `pmset` or any admin power setting. Where it cannot (no tool, no D-Bus) `charness remote-run runners` and `/runners` (all 12 languages) say `keeps awake: NO — <why>`, otherwise `keeps awake: yes (…)`. A closed lid still sleeps the machine, and a laptop left open on battery drains it.

**After a reboot the login-session agent never signals a process it merely finds recorded on disk — an old process-group number may name Finder or the Dock by now.**
Before, the request folders of an always-on Mac survived a reboot, and the agent that started at the account's next login sent SIGTERM and then SIGKILL to the process group written in them; pids restart after a boot, so that number could belong to an unrelated group of the account (Finder, the Dock, a Simulator, the new agent itself), and a reused pid could make a dead job script look alive.
Now a request folder written before the system booted is removed without a signal, a recorded group is signalled only while its leader still has the start time recorded beside it, the job script's pid is checked the same way, an iOS step with no agent beating is refused at once with «ios build: needs a login of <account>», the job script ends a step's group before it goes on even when a restarted agent answered 125 itself, and a request folder that vanishes under the agent — or a group that cannot be recorded, or a request that cannot be handled at all — no longer crashes it, hangs the job or leaves a build running: such a step is ended and its job told it could not start.

**A runner stopped by Ctrl-C or a group kill now shuts down cleanly — the second signal no longer kills it under its own clean-up.**
Before, the app handled the first SIGINT/SIGTERM with a `once` handler, and a stop usually brings two (the launcher passes its TERM on while a terminal or a group kill hands the app another a few milliseconds later): the second took the default action and ended the process in the middle of the shutdown, so the sleep assertion's state file stayed behind and the stop did not run its clean-up (seen as a flake of the link flow under load).
Now the stop handlers stay installed, the first signal stops the runner and the later ones are ignored; the same goes for the login-session agent.

**`charness remote-run … exec` no longer prints a stray `mv: cannot stat …` line after the command's exit code.**
Before, when a quick command ended, the runner's lease could still be writing its heartbeat into a folder that had just been removed, and the `mv` error reached the caller's stderr after the exit marker — the line the CLI takes as the last one.
Now that heartbeat write is silent, so the marker is the last thing on stderr.

**A job whose command ignores SIGTERM is now always killed after the grace time, also when the runner is busy.**
Before, a stop that came from the lease's own watcher (the caller's connection lost, or an interrupt racing it) recorded the job as killed and only then looked for its process group to send the SIGKILL; the lease ended that watcher as soon as the record appeared, so on a loaded machine it could die in between and the command went on running in a job that already read as killed, with nothing left to stop it.
Now the kill ignores TERM and HUP once it has begun, so the SIGKILL always follows its record.

**`charness remote-run logs -f` no longer prints a stray `No such file or directory` line, with the runner's path in it, for a job whose log is not there yet.**
Before, the runner script measured the log with `wc -c < "$jd/log" 2> /dev/null`, and the shell reports a failed input redirect before the `2>` of the same command applies, so the message reached the caller's stderr.
Now the size is read with the `2>` first, and a missing log reads as an empty one.

## 3.9.1 — 2026-11-04

**An @-mention of the AI account in a Jira issue it is already working on no longer makes it believe the issue is not handed to it, and no longer stops its build.**
Before, the prompt for every @-mention said «The issue is not handed to you (assignee: nobody, …) — answer only, change nothing», because the bot never read the issue's assignee for that prompt. On an issue assigned to the AI account in a work status, with its hand-over request still open, a mention by another trusted person landed in the same session: the agent took the note for the state of the issue, dropped its build, and the bot's normal hand-back then reassigned the issue to the requester.
Now the assignee is read, and the note tells the cases apart. An issue assigned to the AI account in one of the project's trigger statuses with a hand-over request open is «handed to you»: the read-only limit applies only to that one answer, the open request is named and goes on unchanged, and a request for work in the comment is not taken on — a change has to come from that hand-over's requester or a new hand-over. The note is checked again right before it reaches the agent — also when the prompt waited behind a running turn or a usage limit, or is resent — and drops a hand-over that got its final answer meanwhile; it says the request was open when the comment came in, so a finished one is never resumed. With no hand-over request open, the same issue gets the answer-only note. An issue held by someone else, or assigned to the AI account in a status it does not work in, still gets the answer-only note, now naming the real assignee — and, while a hand-over request is open, saying that the request is not affected.

## 3.9.0 — 2026-11-03

**Pairing a runner from an admin account is now one paste: the pairing offers a `sudo` line that checks the account, pairs it and keeps it running — the line for the runner account itself stays as the second option.**
Before, the one-time line had to be pasted into the terminal of the account that will run the jobs — awkward when you are logged in as an admin and that account is one you never log in to — and the commands to keep it running came afterwards.
Now `/runners` → **＋ Pair a new runner** (and `charness runners pair`, with `--account <name>`) offers two lines for one code, in two messages: first `sudo sh -c '…' sh runner`, to run from an admin account of the runner machine, then the plain line for the runner account. The admin line checks the account named by its last word — `runner` unless you change it: it must exist, and it is refused if it is root or an admin (or if its groups cannot be read), because it runs the agents' code; nothing ever creates an account — pairs the machine **as that account** (its files are its own, not root's), and then installs its always-on service: on a Mac the LaunchDaemon that runs as the account, on Linux its systemd user service with lingering switched on. The account runs the agents' code, so root never runs, reads through or writes into anything that account can change: the line downloads the package into a folder of its own, has the account pair itself from it, and runs the service step from the same copy — the account's own side is done by the account's program through `sudo -u`. Pasting the admin line runs code from this charness host as root on that machine (the Telegram message and the CLI's text say so); the plain line trusts the host only with the runner account. A Mac's daemons write their logs as the account, never through a folder root opens. Both messages turn into «paired» or «expired» together; a service step that fails leaves the account paired and says to paste a fresh admin line, which finds the account paired, closes its own code on the charness host and only installs the service (its Telegram messages then say the line was used on a machine that was already paired, and `charness runners pair --wait` exits 0). For the same reason `service install --system` on the runner is gone (an always-on service is installed by the admin line, and removed by the plain `launchctl` commands that `charness-runner service uninstall` prints).

## 3.8.0 — 2026-11-02

**Charness can now make a one-time pairing line for a runner machine — `charness runners pair` — and keeps the machines that used it in a registry (`charness runners ls | remove | pause | resume`); the runner's own side and the use of paired runners by `remote-run` follow in the same release.**
Before, a runner was set up by hand over plain ssh: an account, a key, Pueue and `rsync` in the right places, and an entry in `runners.json`.
Now the hub side of pairing exists, with nothing to open and nothing to run as root on the charness host: `charness runners pair --host <address>` checks that the address answers with this machine's own ssh server, then prints one line (valid 10 minutes, single use) to run on the runner machine. A runner's key in `~/.ssh/authorized_keys` — kept in one marked block, every other line left as it is — may run nothing but charness's own `runner-gate`: no shell, no port or unix-socket forwarding (OpenSSH cannot limit forwarding of unix sockets, and a key that could forward one could open the bot's tmux sockets). The gate hands the machine the hub's own charness package, takes its keys when the line is used, and then holds the machine's permanent connection: the runner dials out to the hub, the hub reaches it through a unix socket (`charness runner-proxy`), so the runner needs no open port and no VPN.
The registry (`~/.config/charness/runners/`) lists each machine with its OS, how it is kept running and whether it is paused; `remove` deletes its key and cuts its link at once.
A machine attaches itself with the new `charness-runner` program that the pasted line installs (Node, `ssh` and `tar` are all it needs): it checks the machine, installs Pueue from a pinned, checksummed release and finds or builds rsync, then `charness-runner run` holds the connection — reconnecting by itself after a restart, a reboot or a network change, and updating itself from the hub when it is idle. The hub reaches it with plain ssh through `charness runner-proxy`. A machine the hub removed says so and asks again only once an hour.
`charness-runner service install` keeps the runner running without a terminal and across reboots — a systemd user service on Linux (with lingering, no admin), a LaunchAgent on a Mac, and with one `sudo … service install --system --user <account>` a LaunchDaemon that runs as that account, logged in or not; the queue is a service of its own, so an update of the link never touches a running job. `pause` / `resume` take a machine out of rotation, `unpair` tells the hub, stops the runner on the machine and the jobs it was running (and refuses to claim success while the runner still runs), and when the hub removes a runner the background jobs its agents left running there are stopped at once through the link (a machine that was off stops them itself when the hub tells it it is not paired, or when the hub has refused its key for 12 hours — a refused key alone is also what a hub with a locked home folder looks like, so a shorter guess could kill a long run). On a Mac the runner really tries to boot the iOS Simulator (when the link starts and whenever Xcode changes) to know whether iOS runs there.
Agents use a paired runner exactly like a hand-made one — `charness remote-run` lists paired runners after the `runners.json` ones, over the same rsync, Pueue and lease, reaching them through the link (no `runners.json` entry, no ssh setup): `runners` shows each one online or «the runner is not connected» with when it was last seen, its program and how it is kept running, and a paused one — from the hub or on the machine itself — is never picked (a named one is refused with who paused it and how to resume). `--needs android|ios|docker|playwright` no longer fails at once when the only runner that can do it is a paired one that is offline: the command says it is waiting, looks again every 10 seconds and runs as soon as the runner is back, up to `--runner-wait` (15 minutes by default, `0` = fail at once); a capability no runner has still fails at once. A Mac runner keeps itself awake while a job runs, and a Mac whose service cannot boot an iOS Simulator (Apple allows none outside a login session) no longer claims `ios`, and the answer of an earlier start (another account, another kind of service) is not offered while the new start checks again.
Agents are told which runners exist: while a runner is paired or listed in `runners.json`, the bot's instructions to every agent (Telegram topics and Jira issues alike) carry the `remote-run` bullet with one line per runner — `mac — macOS 15.1, android, playwright` — so an agent knows what to ask for with `--needs` before it runs `charness remote-run runners` for the live state (the list gets the room under Claude Code's 4,096-character limit on a server's instructions — the text of a Telegram topic was already within a few hundred characters of it, so several of the bot's own bullets are now shorter and the rest of the list is counted: «… and 2 more»); Jira agents now get the bot's `XDG_CACHE_HOME`, so they share the bot's remote-run cache (the probes the instructions are built from, the ssh connections, the record of a job's project) instead of keeping one of their own. Nobody without a runner sees any change.
`/runners` in General does the same from Telegram: the list of the machines (online or «offline since …», what each one is, how it is kept running, and — for the online ones — hardware, jobs and what it can do: Android, iOS, Docker, Playwright), **＋ Pair a new runner** (the one-time line arrives as a message that turns into «paired» or «expired»; the first time the bot asks which address runners dial, proposes this machine's public address when it answers with its own ssh key, and keeps the choice in `settings.json`), and Pause / Resume / Remove per machine (Remove asks first). The pairing line is a credential: the output trace records only the length of that message. A long list is split over pages (Previous / Next) that each fit a Telegram message, and a Remove question is never replaced by a list that finishes loading later. A pairing message always reaches its end: it turns into «paired» or «expired» even if the bot was stopped when its line was used or ran out (also after a stop of more than a day), an edit Telegram refuses is tried again, a line that is still valid is never turned into «expired» by a concurrent pairing, and another charness of the same user never touches it.

**`charness remote-run` no longer fails when the folder it keeps its cache in has a space in its name.**
Before, the shared-connection setting of every ssh call named that folder unquoted, so on an account whose cache path held a space (a home folder like `/home/my user`) ssh refused the options with «extra arguments at end of line» and no command reached the runner.
Now the path is quoted, a `%` in it is written the way ssh expects, and a path that ssh cannot be given safely (a quote, a backslash, a `$`) turns the shared connection off instead of failing the call.

**`charness remote-run` no longer hangs past its 20-second check of the runners when a runner's shared ssh connection is still open.**
Before, a runner that gave no answer within 20 seconds was reported offline and its ssh call was killed — but the command then went on waiting for that call's output to end, and with the shared connection kept open for a minute after use that output ended only when the runner's own command did (or about 45 seconds after a network drop), so `charness remote-run runners`, and the check before every run, could stay stuck far past the 20 seconds.
Now a call that is cut off — by the 20-second limit, or by the command being interrupted — ends when its ssh process does, and a probe that was cut off is never taken for an answer: the runner is reported offline and nothing of its partial output is kept.

**A busy OpenCode server is no longer mistaken for a missing one — the bot no longer starts a second server on its port, or replaces it, just because it answered late.**
Before, a health check that got no answer within 2 seconds counted as «no server». On a slow or loaded host that made the bot start another OpenCode server on a port that was already served — it died of «address already in use» and the start was reported as failed — and a server the bot had started itself was stopped and replaced for being slow to answer.
Now a silent check is asked again (three tries of 2 seconds) before it counts, and the bot never starts a server onto a port that is not proven free (only a refused connection proves it). A slow server is used as it is; a server the bot started that stays silent on all three tries is replaced as before, after about 6 seconds instead of 2; a port held by a silent process the bot did not start gets a clear error («port … is in use … will not start another server on the port») instead of a failed start — also for a port whose holder does not even answer a connection. `/status` still waits for one try only.

### Removed

**The `/clear_session` alias of `/new` is gone — `/new` is the one command that restarts a topic's session.**
Before, `/clear_session` did exactly what `/new` does and had a row of its own in the command menu, which made the menu longer and the two names look like two commands.
Now only `/new` exists (the menu row and the `(alias …)` text are gone); typing `/clear_session` is no longer a bot command.

## 3.7.0 — 2026-11-01

**The answers of `send_messages_to_user` and `send_file_to_user` now say what was sent, per kind — «Delivered 3 messages: 1 text, 2 documents.», «Sent 3 files: 1 photo, 2 documents.» — so an agent can see when a file did not go out as the kind it meant.**
Before, they only counted («Delivered 3 messages to the topic», «Sent 3 file(s) to the topic»), so a batch of images that arrived as plain text or as documents read as a full success.
Now the answer names what landed — texts, photos, videos, animations, documents — taken from what Telegram was actually asked to render: a photo sent with `as_file`, one over the photo size limit, or one in an album that fell back to documents is counted as a document.

**An agent that misnames a field when it calls one of the bot's tools now gets an error that says which field and what to write — attachments no longer vanish unseen.**
Before, a key the tool does not know was dropped silently: an agent that sent three images to `send_messages_to_user` as `{text, filePath}` (the field is `path`) had them posted as three text-only messages, and the tool still answered «Delivered 3 messages».
Now every bot tool refuses a key it does not list, at the top of a call or inside an item, and answers with the key, the nearest allowed one («unknown key `filePath` — did you mean `path`?») and the allowed keys; nothing is sent. `send_file_to_user` called with `path` instead of `paths` is told the same.

**Agents can now send heavy commands — test suites, builds, emulator runs — to another machine with `charness remote-run`, and get the output, the exit code and the result files back as if the command had run here.**
Before, everything an agent ran landed on the one machine the bot lives on, so a long test suite or an emulator run could take most of its CPU and memory for an hour while other agents waited on it.
Now you list machines you reach by ssh in `~/.config/charness/runners.json` (set up by hand: an account of its own, `rsync`, Pueue — see `docs/remote-run.md`), and an agent runs `charness remote-run yarn test` (or `--bg` plus `wait` for a long run): the project is synced there (tracked and untracked files, never what `.gitignore` names, never secret-looking files unless `.remote-run` says so), the command runs in a copy, its output streams back, and an interrupt, a timeout or a lost connection stops the whole remote job.
`charness remote-run runners` shows each machine's CPU, memory, disk, load and what it can do (Android, iOS, Docker, Playwright); `ls`, `status`, `logs`, `wait`, `kill`, `fetch` and `exec` manage the jobs. Two runs of one project queue on the runner, each against the files as they were when it was started.
Agents (Telegram topics and Jira issues alike) are told about it only while at least one runner is listed; without one nothing changes.

**A message no longer gets lost when Telegram has closed the connection the bot was about to reuse — it is sent again, once, on a fresh connection.**
Before, the bot kept its connections to Telegram open and reused them; when Telegram had closed an idle one a moment earlier (most often while the bot was starved of CPU), the next send failed with «socket hang up» and was dropped — a notice or a reply simply never appeared in the topic.
Now a send that fails this way — at once, before Telegram has started to answer — is retried once on a new connection, the answer to a button tap and the edit of a picker included. It is not retried after a timeout, once Telegram has begun to answer, when the connection broke only after a while, or on a connection that was new anyway, and a file the agent sends is not retried this way (it keeps its own delivery rules). If Telegram did take the message and the connection broke before a single byte of its answer, the retry cannot tell that from a closed connection and could post the message twice; that is rare.
The bot also closes a connection that sat unused for 30 seconds itself, long before Telegram would, so an ordinary pause between two messages does not meet a closed one. When it retries, the bot log says «pooled connection was closed by the server».

**Stopping every agent from General is typed `/quitall` — the «only available in the General topic» refusal now says so, in all 12 languages.**
Before, that refusal (and the docs) told you to use `/quit-all`, but Telegram ends a command at the hyphen, so `/quit-all` reached the bot as plain `/quit` and stopped only the one topic's agent, not all of them.
The refusal and the docs now name `/quitall`, the spelling the command menu lists; the command itself is unchanged.

**A question the agent asks now stays in the topic however it ends: answered, it shows your answer in place of the buttons; left alone, a note says it was not answered.**
Before, answering replaced the whole question with a short «✅ header: answer», walking away from it (another message, `/esc`) replaced it with «❌ Question cancelled», and re-posting or re-asking a question deleted the first message — so what the agent had asked was gone from the topic.
Now the message is never deleted: it keeps the question and its options, with «✅ Answer: …», «❌ Not answered» or «↓ Asked again below» under them, also when the question is re-asked after the idle compaction, when you leave the folder, or its agent is gone.
A question that waits through a long stream of the agent's output is put at the bottom again each time: the first message stays as the record and the newest copy is the live one, the copies in between are removed — also across a bot restart.
A bot restart in the middle of an idle compaction asks the question again when its conversation can still be resumed, instead of leaving it «Not answered» though you never had the chance to answer.
The pin works as before: one notification when the question comes, removed when it ends. The details are in `docs/commands.md`, «The agent's questions».

**Typing or saying «claude» (or `клод`) to start the agent now opens the same backend `/claude` does — json-stream by default, or the one the topic picked — not the deprecated tmux one.**
Before, a start phrase — in a text message or a voice note — handed the bare name `claude` on, which is the tmux backend's own name, so the phrase quietly
started the frozen tmux backend while `/claude` and the ▶️ Claude button opened the topic's backend. All three now open the same backend;
`opencode` and `terminal` are unchanged, and a topic that picked the tmux backend with `/claude_mode` still gets it.

**Binding a topic to a folder now leaves ONE message in the topic — the full welcome with the folder's facts and the start buttons — whichever way it happens.**
Before, a bind also posted extra messages that stayed in the topic as plainer copies of the same news: picking a folder with `/bind` (typed, tapped
in the picker or «create new folder») added a short «📁 Bound to `x`. Run /claude or /opencode.» just before the welcome, a topic the bot bound by
itself because its name matches a folder got a separate 👋 «auto-bound» greeting, a folder other topics already use got a separate ⚠️ warning, and
«create new folder» given the name of an existing folder added a «Folder already exists» note.
Now only the welcome is posted: a row in it says the bot bound the topic because its name matches the folder, another says the folder was there
already, and another names the topics that already use the folder — also when the bot bound the topic by itself. A topic is named there by the name
the bot saw it made with (or an admin renamed it to), else by a link that opens it; the name a non-admin gave a topic is not kept on its binding, since
the agent's thread context would repeat it. Only topics of the SAME chat are named: topics of other chats the bot serves (another group, a private chat) are
only counted, «+2 more» (a topic of this chat that has no name and no link to show is counted too), so one chat never learns what another calls its topics. A folder that does not exist still just gets its reason. When a topic is bound again, or leaves its folder, the buttons of its previous welcome (▶️ Claude, ▶️ OpenCode, 📋 Resume) are removed: they act on the topic's CURRENT folder, whatever the old message says, so an old welcome can no longer start an agent from a folder the topic has left. `/topic`'s «create new folder» still tells the topic
you typed the name in that the folder existed.
The `/bind` picker is now one-shot: once a folder is bound through it (a tap or «create new folder»), or «Leave current dir» is used, the picker message
is deleted — its «not bound, pick from the list» text would no longer be true — so an old tap cannot rebind the topic, and a second tap landing while the
first is still binding (on a folder, «create new folder» or «Leave current dir») is told «This picker was already used.» instead of binding or unbinding
twice; a refused pick, paging and the create-folder prompt leave it in place, and a tap whose answer reaches Telegram too late still does what it asked. Pickers the bot closes after a bind are refused at once, even those it could not delete (the bot keeps that in memory: after a restart a picker that still has its buttons works again), and a typed folder name that arrives while a tap holds the picker is told so instead of being dropped.
A «create new folder» wait ends with the bind or the leave that follows it, so the next plain message is never taken for a folder name, and its «send the folder
name» prompt is deleted with the bind (a refused name keeps it). Every plain message in an unbound topic posts a new folder picker, so a bind or a leave — by a tap,
a typed `/bind <folder>` or the bot's own auto-bind — deletes ALL the pickers still open in that topic, not only the tapped one: no stale one is left to rebind it.
When the bot binds a non-admin's topic on an admin's first message there, a plain message is answered by the welcome alone, without the extra «bound, run /claude» hint, and a
start phrase like `claude` still starts the agent; the topic is then stored under the matched folder's own name, never under the member's spelling. The
removed texts are gone from all 12 languages, the new rows and the toast are in all 12.
A topic you create whose name matches no folder now remembers that name for 24 hours: the folder picker you bind it through keeps it (the «also used by» row of a
later topic on that folder names it), and if a folder with that name appears meanwhile, your next message in the topic binds it by itself.

**`/task_agents` in General sets how many task agents may work at once — a number from the picker or any number you type.**
It opens a one-shot picker (5 / 10 / 15 / 20 / 30 / No limit, the value in force marked ✓) whose tap turns it into its confirmation;
`/task_agents 12` sets any whole number from 1 to 100, and `0` or `off` means no limit (a number over 100, a decimal or a word is refused with the
range). The screen names where the value comes from — set in General, `settings.json`, or the built-in default — and, on an instance that serves
Jira, how many agents work now and how many wait. General's own value beats `settings.json`'s once it is set, and a higher number starts the issues waiting for a slot at once; in a topic the command only reports
the value and says it is changed in General. The texts are in all 12 languages. General's `/help` also names it, and escapes the underscores of
its command names, so a pair of them can no longer be read as italics.

**The agents that work on Jira issues now run under ONE cap for the whole bot — 5 at once by default — and an issue over it waits in a queue and starts by itself.**
Before, every issue handed to the AI account started its agent at once, with nothing limiting how many ran together. Now the number of
tracker task agents working at the same time is capped for all projects together: `"taskAgents": { "maxConcurrent": 5 }` in
`settings.json` (`0` = no limit, 100 the most; read without a restart; nothing set means 5, so an instance gets the cap with this update).
An agent takes a slot when its issue is handed over and gives it back when it hands the issue back (a question or the final answer), when its
request is cancelled, or when the wake-up engine gave up on it and handed the issue back; an issue with several hand-overs open still holds one
slot, and an @-mention (answer only) never takes one or waits. An issue over the cap gets ONE short comment — «⏳ The AI is working on 5 tasks at
once, its limit, so this issue is queued (2 issues are ahead of it). It starts by itself when a slot frees up» — and stays assigned to the AI. The
waiting issues are one first-in-first-out list for the whole bot, kept in `state.json` so a restart keeps the order; the first one starts the
moment a slot frees — an agent hands its issue back, a request is cancelled, the wake-up engine gives up on one, or the cap is raised with
`/task_agents` — because the Jira poll then runs at once instead of at its next interval (a raise made by editing `settings.json` is noticed when
the bot next reads the file, at the latest at the next poll). An issue moved away from the AI while it waits leaves the list; an issue whose
start fails (its text cannot be read, say) keeps its place but no longer holds up the ones behind it, and after three failed starts in a row it
moves to the end of the list. A lower cap never stops an agent that is already working. A mistyped `taskAgents` is logged once as
`[Settings] settings.json taskAgents.maxConcurrent: …` and the built-in 5 applies.

**The "↩️ Resumed — last 3 messages" preview no longer shows what Claude Code records for itself: a `/compact` you ran there shows as just `/compact`.**
Before, resuming a conversation whose last entries were a command run in Claude Code itself printed the raw `<local-command-caveat>`,
`<command-name>… <command-args>…` (with the whole, often very long, argument text) and `<local-command-stdout>` entries as if they were your
messages, and a skill loaded in the last turn flooded the topic with its whole text. Now a command shows as its name only (a `!` shell command as
`!ls`), and the entries Claude Code flags as its own are left out — the summary a compaction leaves, a loaded skill's text, the caveat before a
command, image notes, messages from another session — as is an entry that is only a command's output, a reminder or a task notification. The
entries left out do not count: the preview still shows the last three real messages. A message of yours is shown whole, also when it pastes or
mentions one of these tags; only a `<system-reminder>` block that a hook appended to it is cut. The same goes for the recap after a bot restart
and for the titles in the `/sessions` list. When a limit moves a topic to another agent, the summary of the conversation's earlier compaction
(Claude topics) is handed over as context, labelled as such, and never as something you said.

**The skills Charness gives its agents can now be switched off — `/bot_skills` in General for the whole instance, in a topic for that topic only.**
A deployment whose workspace instructions name skills of their own (a Jira-only instance, say) no longer has to live with the bot's
`charness-manager` and delegate skills beside them, nor with the hint in the bot MCP's instructions to load the manager. `/bot_skills` opens a
one-shot picker: in General On / Off for the instance, in a topic On / Off / «As in General» with the current choice marked; a tap turns the picker
into its confirmation (the texts are in all 12 languages). An instance without General sets the default with `"botSkills": "on" | "off"` in
`settings.json` (read without a restart; General's own choice beats it once made; nothing set means ON, exactly as before). With the switch off a
Claude conversation starts and resumes without the bot's skills folder, and the hint is gone from its instructions (the worker-watch recipe in
`schedule_create` stays: it is a tool fact, not a skill). A running agent keeps its skills until its next start (the idle stop and resume, a new
session or a model change). OpenCode has one server for every topic, so only the instance value counts there: the server is replaced at the
bot's next start, once nothing works in it, by one started without (or, when turned back on, with) the skills folder — a `settings.json` that says
`off` is followed already by the server the hot supervisor starts first — and a topic's own choice changes only its hint — its screen says the listed skills stay, that the hint changes when the OpenCode server next restarts and that the
OpenCode topics of one folder share it. General's screen names where the value comes from (set in General, `settings.json`, or the built-in
default). A mistyped `botSkills` is logged once as `[Settings] settings.json botSkills: …`
and ON applies.

**The tmux backend for Claude Code is now marked deprecated: it is frozen and no longer developed, and `/claude_mode` says so.**
Before, nothing told you that, so you could pick a backend that gets no new features. The `/claude_mode` picker now shows it as
«🖥 tmux (deprecated)» with a line pointing to the recommended json-stream backend, the same hint follows a switch to it, `/status`
flags a topic that runs on it, and the command's menu text says «tmux (deprecated)». Nothing else changes: it stays selectable, a topic
already on it keeps working exactly as before and nothing is migrated for you. The texts are in all 12 languages.

**The local speech recognition (GigaAM) now recognises a voice message to its last second also when it is an MP3, an M4A or two OGG files joined into one.**
Before, an MP3 without a length header (a cut-out stream, or a variable-bitrate file) was read for only its first seconds — 6.7 s of a 40 s
file — the second half of two OGG files joined into one was dropped, and an M4A (AAC) was refused, so the next engine in your list
answered it or nothing did. Telegram's usual OGG/Opus voice notes are read exactly as before. The three formats are now decoded with
`av` (ffmpeg's libraries) in the engine's private Python environment: after this update the local engine re-installs itself once (about
a minute and a ~35 MB download, ~100 MB more disk; the model is not downloaded again, progress shows in General), and a voice sent
meanwhile goes to the next engine in your list.

**Every compaction summary now ends with a numbered checklist of what the agent does next, and its first item is to load the skills it had loaded.**
After a compaction the continuing session often skipped reloading its skills and worked without them. The checklist is now asked for on every path:
the idle compaction, `/compact`, the compaction the agent arms itself (`compact_conversation`), and the one the agent CLI or OpenCode runs by
itself when the context overflows. Item 1 is «load these skills» with their exact names (no such item when none was loaded), then the next steps the
summary already records, in order — none invented. The list is the last thing in the summary; where the idle compaction asks for the closing
«where we stopped» section, it is that section's last part. An OpenCode server that was already running gets the new text too: the plugin file in
OpenCode's plugin folder now carries a hash of its text in its name (`charness-compaction-<hash>.js`), so at the bot's next start a project folder
whose instance loaded an older text is recreated (when nothing runs in it; a working one is retried at the next start) and the older copies of the
file are removed.

**A usage-limit resume that finds its session gone no longer says «resumed» right before «no session».** When the bot restarted while a
topic waited for a limit's reset and the conversation was ended in the same moment, the topic read the pinned «work resumed» notice and
then «no session». The «resumed» notice now goes out only after a session took the "continue" prompt.

**A hot-mode bot no longer keeps running the old build after a big update because its TypeScript watcher went blind.** After a pull of
dozens of commits followed by a dependency install, the watcher could miss the changed files (the operating system drops file-change
events when too many arrive while the compiler is busy): it then reported errors that did not exist, or a clean build that emitted
nothing, `touch tsconfig.json` did not help and only a full service restart did, while the bot kept serving the old code without a
word. The hot supervisor now compares the watcher with the sources every 30 s and, when a source stays a minute newer than the build,
restarts the watcher alone (when it reports errors, only after a fresh compile finds none) — the bot, its agents and the supervisor
stay up, and the update reaches the worker like any other.

**Switching to the next entry of the fallback list on a usage limit is now ON by default, also with a single signed-in account.** The
«🔁 Auto switch» setting of `/limits_autoswitch` used to start OFF, so a limit stranded the work on the limit notice until someone
tapped «Switch to …» even when another entry had room. Now a topic that hits a limit moves by itself to the first entry of the list
with room — another Claude account, or an OpenCode provider and model, which hands the conversation over to a different agent in
compacted form. With one account and no list there is nothing to move to, so the bot waits for the reset as before, and an account
or an entry added later is used from the first limit on. An instance where you turned it OFF (in General or for one topic) keeps
your choice; if you do not want conversations handed to OpenCode by themselves, turn it OFF or leave OpenCode out of the list.

**Agents now get Charness's own orchestration skills.** Every agent session the bot starts — Claude Code in a topic or a Jira
conversation (the stream and the tmux backend) and OpenCode — gets the bot's skills: `charness-manager` for driving work
through detached workers with the bot's own tools, and `charness-delegate-claude` / `charness-delegate-opencode` for
launching, watching and resuming those workers (Claude Code lists them as `charness:charness-manager`, …). The manager
watches every worker with a bot check that fires when the worker exits OR stops writing for 45 minutes — a check that only
asks whether the process is alive never fires on a hung worker. Its alert pins silently, since a worker that simply finished
fires it too, and cancelling a watchdog check (`schedule_cancel`) unpins the alerts it pinned. A user or project skill of the same kind stays as it is, a Claude
Code older than 2.0.25 (which has no `--plugin-dir`) starts without them, the operator's own sessions outside the bot do not
get these skills, and an `OPENCODE_CONFIG_DIR` the operator set is kept (its
OpenCode topics then go without them). An OpenCode server the bot runs that an earlier version started is replaced at the bot's
next start once nothing works in it; a server the bot does not own is left as it is.

**A `/claude` sent right after `/quit` no longer loses its new session at start.** The ended session killed its tmux session a
second time, by name and without waiting, after the stop had killed it already; on a busy host that second kill could run once
the new session had created its own tmux session of the same name, and the start then failed with "the CLI exited before its
initialize handshake". An explicit stop kills the tmux session once. And `/quit` now says «stopped» only when the session is
stopped: a `/claude` sent on that reply used to be told "already running", and then nothing ran.

**A prompt that waited for the agent's running turn is no longer lost when the process is stopped right after that turn.** A Jira
hand-over or a scheduled run that arrived while the agent was still working was written to the process the per-turn stop had
just ended and dropped; the agent got it only minutes later, as a whole re-post. The prompt now makes sure the conversation is
awake again before it is sent, so the agent reads it once, as it was built.

**A usage-limit switch no longer prompts the agent twice.** Moving a limited topic to another model or account re-spawns the
session for a few seconds; a reminder for the interrupted request could land in that gap on top of the "continue" prompt the
move sends, and the agent answered twice (one answer's streamed text was lost). The request is no longer reminded while the
move is under way.

**A new turn's text no longer lands inside the previous turn's message.** When the Telegram API was slow, the previous turn's
last text could finish sending after the next prompt had gone to the agent, and the next turn's first text was then appended
to that message by an edit instead of starting its own. The "new message" mark now belongs to the first text queued after it,
and text still waiting when your next prompt goes out is no longer pulled into the new reply's message.

**The text a turn streamed before it failed now arrives before the error notice, and a restart no longer repeats an error already handled.**
A turn that ended on an error (a usage limit, an API error, an interrupt) kept its last text in the answer batch while the notice
went out at once: the text showed up below the limit notice, the switch offer and the usage board, and a bot restart in that
moment replayed the turn together with its error — a second notice or error line for a limit that was already announced, or a lost
auto-retry. The turn's text is now sent first, and the bot saves where it stopped reading at the end of the turn, as it does for
a turn that succeeded.

**A message sent right after a bot restart no longer mixes with a turn that was running when the bot went down.** The restarted
bot reads what the agent wrote while it was down a moment after it starts; a prompt that reached the agent before that (the
bot's own resume after a usage limit, a scheduled run, your message) reset the reply the replayed text still belonged to, so the
old turn's text could end up inside the new reply's message, and an error of the old turn took the new turn's place — shown as
a plain "Claude error" line and not retried. A prompt now waits for that replay (at most 30 s) before it is sent; if the agent is gone
when the wait ends, the topic says so and the request the message opened is closed, instead of the bot later asking the agent about
an answer it never started.

**A usage limit that stopped the agent while the bot was down is now handled once after the restart.** The restarted bot found the
limit error twice — once when it checked the agent's log at start (it resumes the topic at once when the window is over), and
once more when it read what the agent wrote during the downtime. The second copy was handled as a fresh limit: the topic got a
"Usage limit reached" notice for a window that was already over (for a reset written as a clock time, a wait of up to a day),
a second "work resumed" message, and the agent a second "Continue" prompt and a second turn. The first one now owns the
episode and the replayed copy is left out.

**A bot restart in the middle of a per-turn topic's turn no longer wipes that turn's working files.** The cleanup at start took the
running agent of a per-turn topic for a leftover and deleted its output log and pipes while the agent was still working, so the bot
could neither read the rest of the turn nor write to the agent: the answer never reached the topic. The daily cleanup did the same to
a turn that happened to be running then. The cleanup now knows both Claude lifecycles.

**After a restart, a usage limit that ended a turn while the bot was down no longer keeps the account marked limited for a day.** When the
restarted bot read that limit error from what the agent wrote during the downtime, it worked out a reset named by its clock
("resets 10:20am") from the moment it read the error, not from the moment the error happened: a window that had closed half an
hour before was taken as closing tomorrow, and the account stayed limited — shown so on `/limits`, passed over by the account
switch — for up to a day. The reset is now worked out from the time the agent's transcript recorded the error.

**A working agent now hears of another topic's todo change in the middle of its turn.** Claude gets the project
board's changes with the result of its next tool call (a `PostToolUse` hook in the settings file the bot starts every
Claude session with), OpenCode as a queued message it reads between steps; an idle or sleeping agent is never woken
for it.

**The agents of one repository now see each other's todo lists.** Topics on checkouts or worktrees of the same git
repository form a project, and every prompt an agent gets carries the project board — the whole of it on a fresh
context, later only what changed in the other topics — as does its own `todo_update`; another topic's change never
wakes an agent. `/todo` → Project ▸ joins another topic's project or keeps an own one, `/todo` in General lists every
project, and Jira conversations share a board with the topics on the repositories their `jira.json` project lists in
the new `repos` key.

**An agent that works for an hour without updating its todo list is reminded to.** The next prompt it gets carries
one line; an agent that keeps working on its own gets a short prompt of its own at the end of a turn — never into a
running turn, a sleeping session, an unanswered request, a usage limit or an account billed to API credits — and the
bot falls silent after two ignored reminders. `/todo` in General → Settings turns the lists off or sets the interval
(off, 30 min, 1 h, 2 h, 4 h); an instance without General sets `todo` in `settings.json`.

**Agents publish what they work on, and `/todo` shows it.** Every topic's agent now keeps a short published todo list
— in work, the queue in order, done — through a new bot tool, adding an item before it starts a task and closing it
when it is done; `/todo` in a topic shows the list. It belongs to the topic, so `/new`, `/quit`, a backend switch and
a restart keep it, and a final answer while the list still shows unfinished work reminds the agent to update it. Jira
conversations publish the same way.

**Voice notes with pauses no longer lose phrases.** The local recognition (GigaAM) now cuts every voice at its pauses and
recognises the parts separately, so a phrase said after a pause is no longer dropped or merged into the previous one
(for example, "…купи хлеб? … и ещё молоко" could come out as just "…купи хлеб"). Nothing is cut away: the parts cover the whole
voice. After this update the local engine re-installs itself once (about a minute, the model is not downloaded again, the
progress shows in General); a voice sent meanwhile goes to the next engine in your list, or, with no other engine, the bot
asks you to send it again when the engine is ready.

**Voice notes from different topics are transcribed in the order they were sent.** The local recognition used to let
a short voice jump ahead of a longer one sent before it from another topic; now each voice waits its turn, and the bot
waits for it as long as its turn takes instead of giving up after the time its own length needs. A voice the bot has
stopped waiting for is no longer recognised in vain.

**Agents now launch workers on the Claude account whose weekly limit resets soonest, keep a resumed worker on its own account, and move a worker stopped by a limit to another account at once.**
Before, a worker (or a topic whose account hit its limit, with no `/limits_autoswitch` list) went to the account with the most room left, so an account about to
expire its week unused sat idle while the one with a fresh week took the work. Now a new worker starts on the usable account that resets its weekly window
first (an account whose five-hour window is at 90 % or more waits; Fable's own window takes out only Fable), a resumed worker stays on the account it
ran on, and one that broke off on a usage limit is resumed on another account straight away instead of waiting. When no account is usable the answer says
which one frees up first and when, so the manager schedules a single resume for that moment; when no account can say when it frees up, the manager asks you
and tries again in about half an hour. An account switched off in `/limits_autoswitch` is never picked
for a new worker, and one billed to API credits never is either. `charness claude-profiles` takes `--current <name>` and `--stopped-by-limit` for the same,
and a topic stopped by a limit with no list of its own now moves to the account that resets soonest rather than the roomiest.

## 3.6.1 — 2026-10-26

**An agent @-mentioned on a Jira issue that is already assigned to it no longer asks to be assigned.** When the issue
is assigned to the AI account but sits in a status the project does not hand work over in, the agent now says the
status is what is missing and names the statuses it works in for that project; on an issue assigned to someone else
it names those statuses too.

## 3.6.0 — 2026-10-24

**If the agent's background work is lost anyway, the agent is told and the topic gets one line.** When a Claude process
ends with its own work pending — it crashed, it was gone after a restart, `/model`, `/effort` or an account change
restarted it (cutting off its turn too), or a task nobody heard from for 6 h was let go — the topic gets one plain line
naming the lost work, and the agent is resumed at once with a short note to check that work and start again what is still
needed (after a forgotten task, or a second loss within 10 minutes, the note waits for your next message instead). A
usage-limit switch to another account or backend, or a `/claude_mode` switch, says so in its own reply and the agent's next prompt carries the note; a topic
that comes back to a backend it left tells that agent too. `/loop` wakeups (`ScheduleWakeup`) now count as pending work
like `CronCreate` jobs, and the agent's instructions steer anything that must happen later to the bot's own scheduler.

**The agent's background work is no longer cut off by an automatic stop.** On the default Claude backend the process
used to be stopped in the seconds between a background task's end and the agent's turn that reads its result — the
result was lost and the topic went quiet until you wrote. Now a background command, Monitor or sub-agent the agent
started, the result it is about to read and a `CronCreate` job it scheduled all keep the process (for up to 6 h after the
agent's last turn, so a forgotten task does not keep it forever). After a bot update that changed its tools, a running
agent is no longer stopped early either: it is compacted and stopped at its normal idle mark, and resumes with the new
tools.

**On native Windows the bot now says which features do not work there and points to WSL2.** Claude and `/terminal` need
tmux, a self-update cannot restart the bot in place, hot mode refuses to start and the local speech engine cannot be
installed; at a cold start the bot prints one console line, posts one short notice in General (in the chat's language) and
shows the same line in `/doctor`, with a link to the new SETUP.md section «Windows (WSL2)»: install WSL, the config and
projects inside Linux, Windows programs from WSL, and a recipe for a PC with no monitor that starts the bot at Windows boot
without anyone logged in. A `/doctor` warning that has no hint no longer ends in a dangling dash.

**An answer tapped on a question the bot re-asked after an idle compaction is no longer lost when the tap lands while
the agent is being stopped.** The idle stop that follows the re-asked question could finish while the tap was being
answered; the chosen option was then kept for a session start that never came, and the agent never got it. The answer
now wakes the conversation as any message does.

## 3.5.0 — 2026-10-23

**You can see what an account billed to API credits has spent.** On the default Claude backend each turn's cost is
counted for such an account — only the part that turn added to the conversation, never a subscription turn's — and shown
under the account in `/accounts` and `/limits` (`💳 $12.34 spent since 23.10 · last turn $0.21`), on `/status`, when a
limit switches a topic onto it («billed per request … spent through the bot so far») and in its «credits used up»
notice. It is what the bot saw, not the Console's balance. A request on the account that goes through again also ends
its «credits used up» mark.

**An account billed to API credits never spends money unasked, and «Credit balance is too low» no longer waits for a
reset that never comes.** The `claude_profiles` recommendation and `charness claude-profiles --best` never name such an
account, the switch to another Claude account never offers it, and «🔄 Fill from connected» puts it last in the
fallback list and left out of automatic switching — tap it on the `/limits` board (`Claude · console 💳`), or include it.
When its credits run out, the topic gets one `💸` notice instead of hourly retries, the account is marked as out of
credits (`💸` in `/limits_autoswitch`, `/accounts`, `/limits`, `/status`) until you pick it or sign it in again, and the
fallback list takes over as for a limit: an available entry, a «Switch to …» button, or a wait for an entry that comes
back at a known time. An API rate limit (429) is still a short retry.

**A Claude account can bill the API credits of a Claude Console organization.** `/accounts` → «➕ Claude API account
(Console credits)» (or `/accounts add <name> api`) signs it in with `claude auth login --console`, which creates an API
key in that organization and keeps it in the account's own directory; or paste an existing API key while the sign-in
waits (on its own or as an `ANTHROPIC_API_KEY=…` line) — the message is deleted, the key is checked with the API and kept
for that account only, never in `state.json` or in an environment variable. A key pasted where the name is asked, or typed
on the `/accounts` command line, is deleted too. `/accounts` shows such an account as `💳 API · pay per use`, `/status` marks it
`💳 API`, and picking it says every request is billed. Your subscription accounts are unchanged: they still never
see an `ANTHROPIC_API_KEY`. Any `sk-ant-…` text is redacted from the output trace.

## 3.4.0 — 2026-10-23

**Charness now updates itself.** Every hour the bot checks for a new version; when nobody is using it — no agent working,
no input waiting, nobody has written for 10 minutes — it installs it and restarts in place, the same process, so every agent
keeps running, and General gets «Updated a → b» with what the new version brought. An npm install takes a version 4 hours
after it appeared; a git checkout takes a pull (in hot mode the supervisor re-executes itself when one of its own files
changed — in Docker the entrypoint sees no exit); a major version, a version that needs a newer Node or a checkout range
that adds a migration guide is offered with a button instead of installed, and a version that does not start is rolled
back. `/update` in General switches it between Automatic (the default), Notify only and Off, switches the «what's new»
list and shows what the last check saw; `/version` says when an update is available.

**`/topic` opens another topic on a folder.** `/topic` asks for the new topic's name (`/topic <name>` takes it from the
command), then for the folder: the one this topic is bound to («as here») or another one from the same picker as `/bind`,
«create new folder» included — in General and in an unbound topic the picker comes first. The bot creates the topic, binds
it, greets it as `/bind` does and answers with an «Open topic →» button; no agent starts by itself. The bot needs the
`can_manage_topics` right (without it the usual hint is shown), «✖️ Cancel» (on the folder question and in the picker) and
`/esc` (at any step) end it, and in the bot's private chat, which has no topics, the command says so.

**`/interrupt` stops a running OpenCode turn.** `/esc` answered «Not supported for OpenCode», so an OpenCode topic had
no way to stop the agent and redirect it. `/interrupt` (the new name of `/esc` — both work, and `/interrupt` is in the
command menu) aborts the generation, cancels a question the agent was waiting on, and leaves the conversation as it
is: the next message steers the agent. On the Claude
stream-json backends `/esc` now also declines a question the agent is waiting on (it used to leave it open under the
aborted turn). Stopping a turn before the agent had written anything (also with `/c`) is no longer taken for a stuck
session, whose "recovery" ran the request again.

## 3.3.2 — 2026-10-23

**On Windows the bot can start an `opencode` that npm installed.** 3.3.0 found npm's `opencode.cmd` on PATH but still
started the bare `opencode`, which Windows cannot run that way, so the OpenCode server did not come up. The bot now runs
the script npm's shim wraps (another batch file through `cmd.exe`), and installing a missing CLI works on Windows too.

**A Claude CLI that dies as it starts is reported as a failed start.** The topic used to be told the session was
«ready», then that it «ended» — once per attempt — after waiting out a 15-second handshake each time. It now gets one
line with the CLI's own error, at once.

**When the agent cannot be started again for a message, the topic gets one line saying why.** A message or a button tap
that had to wake a sleeping conversation added «No agent running» under the start's own reason. And a re-asked
question's buttons stopped working when its answer reached no session — they keep working now.

**Gemini's «Requests ending with a model turn are not supported» recovers even right after another retry.** It was
counted as a repeat of any retry in the two minutes before — Google's short «reset after 2s» retry, for one — and the
bot gave up without continuing the work. Each kind of retry still stops at its own limit when they alternate.

**A `/compact` that fails the way the turn before it did is shown.** The failure was taken for the previous turn's,
already posted, and dropped: neither shown nor retried.

**A daily quota's «retry your request in 30s» keeps the usual usage-limit wait.** Only a retry hint placed right after
«retry» was recognised; with a few words in between, the bot waited 30 seconds and marked the model limited for that long.

**The give-up line reads right for one attempt.** «Couldn't resume after 1 attempts» is now «Couldn't resume (attempts:
1)», in every language.

## 3.3.1 — 2026-10-23

**The npm listing names the `charness` command again.** The 3.3.0 listing on npm showed no commands (installs
and `npx` still worked, the package itself carried them).

## 3.3.0 — 2026-10-23

**A usage limit waits until the exact reset when the provider sends one, instead of a guessed hour.** Claude reports the
reset of the window that refused the request, but the bot read it only from the message text. A wording that names no
time, such as «This request would exceed your account's rate limit», fell back to a retry every hour once the limit was
confirmed. On the default Claude backend the wait now ends at the reset Claude reported. A ChatGPT subscription limit on
OpenCode now waits until the reset in the provider's response (`resets_at`, or `resets_in_seconds`), not the hourly retry.
An older Claude Code's `Claude AI usage limit reached|<epoch>` is read the same way.

**The agent can send files to the topic on Windows and macOS.** `send_file_to_user`, and `send_messages_to_user` with a
file, refused with «secure file sending is unsupported on win32», and an agent could stop its work over it. Files are now
opened by their checked path on those systems, held to the file that was checked inside the bound folder, so a path
swapped meanwhile still cannot reach outside it. If a send does fail, the agent is told to give the file's path in its
reply and carry on.

**On Windows the bot finds the agent CLI installed on PATH.** It looked the tool up with `which`, which Windows lacks,
so an installed `opencode` read as missing.

**Gemini's «Requests ending with a model turn are not supported» on OpenCode recovers by itself.** OpenCode v1 sometimes
sends Gemini a conversation that ends on the model's own turn, and the turn stopped with the provider's raw text. The
topic now gets one short line and the bot continues the work at once; if the same refusal comes right back, it says it
could not resume, as for other errors.

**An OpenCode failure is posted once, without an auth plugin's debug block.** OpenCode reports most failures twice, and
both were posted, each as the provider's whole message cut at 500 characters — with opencode-antigravity-auth that
included a «[Debug Info]» block naming your Google project. One line is posted now, and the block stays in the bot log.
A sub-agent's failed step is posted once too: only its session error shows.

**Google's «You have exhausted your capacity on this model. Your quota will reset after …» is read by its duration.** The
Gemini subscription and Antigravity quotas say this both for a cap that clears in seconds («after 2s») and for a spent plan
(«after 146h52m11s»). The seconds-long one was announced as «🚧 Usage limit reached» with an hour's wait, and an hours-long
one inside Google's RESOURCE_EXHAUSTED was retried a few times and given up. A reset within a few minutes is now a short
retry; a longer one is waited for until the time it names. A daily quota keeps the usual hour-long wait: the short
«Please retry in 40s» Google sends beside it is a retry hint, not the time the quota resets.

**A voice message no longer fails when two starts of the local speech engine meet.** When the bot restarted while the
local engine was loading, the second start finds the first one running and steps aside — on a busy machine that was taken
for a failed start, and the voice was not transcribed by the local engine.

**A reset time written without a time zone is no longer guessed.** An ISO stamp with no zone («resets at 2026-10-22
23:29») was read in the bot's own zone — hours off when the provider meant another. It now counts only with a zone after it;
otherwise the reset is treated as unknown and the topic retries hourly (or as the provider's Retry-After says).

**A reset written in several parts («reset in 2 hours 30 minutes») is read whole.** Only the first part was read, so
the topic resumed half an hour early (OpenCode Go writes its limits that way, «in 1 day 3 hours» too), hit the limit
again and used up a retry.

**Anthropic's «This request would exceed your account's rate limit» is checked before the topic waits for the reset.** The
same refusal also comes while the account shows plenty of room, and the bot took it for an exhausted window: «🚧 Usage limit
reached — will auto-resume after reset» and hours of waiting. It now retries once after two minutes, and waits for the reset
only when the refusal comes again right after that retry — or when the account's usage shows a window at 100 %.

**A sub-agent's limit, or another session's in the same folder, no longer stops the topic.** On OpenCode a sub-agent runs
in a child session — often on another model or provider — and the folder's events can also carry a session the topic does
not own (your own `opencode` in the same folder, an old session still retrying). Their quota errors were taken for the
topic's: «🚧 Usage limit reached», the topic's messages held and its model marked limited while its own agent kept working.
Only the topic's own session can arm a limit wait now.

**An OpenCode error's response headers no longer turn it into a usage limit, or set its reset.** The bot read the whole
error OpenCode relays, response headers included, and headers name limits and resets of their own: a plain 400 could be
announced as «🚧 Usage limit reached», and a real limit could be given the reset of a per-minute counter (or a stamp a day
away). Now only what the provider said — its message, its response body, the status code — is read, and a reset that the
message does not name comes from the provider's Retry-After.

**A per-minute provider throttle is no longer announced as an exhausted usage limit.** Google answers a used-up
PER-MINUTE Gemini quota with the same «You exceeded your current quota … Please retry in 40s» / «Resource has been
exhausted» as a per-day one, and a concurrency or tokens-per-minute cap reads «exceeded your rate limit» / «limit
exceeded». The bot took all of them for a usage limit: «🚧 Usage limit reached» and a wait of an hour or more for a
limit that cleared in seconds. They are now retried within minutes; a quota that names a day, a week or a month — and
the explicit usage windows — still waits for its reset.

**Two requests opened in the same instant keep their order.** When two people wrote to a topic within the same
millisecond, the bot could take the older request for the newer one — and answer or remind the wrong person first.

**«⏭ Skip once» and a given-up limit wait stay settled across a bot restart.** When a Claude topic's limit wait ended
without its resume — skipped, given up, or taken over — the next restart (hot mode restarts on every update) found the
same limit error at the end of the agent's log and armed the wait again: the «usage limit reached» notice came back and the
topic was resumed after all. Such a wait is now remembered as handled; a new limit error later is still picked up.

**A weekly usage limit waits for its reset date instead of retrying every hour.** A limit more than a day away is written
with its date — «You've hit your weekly limit · resets Oct 25, 3pm» — which the bot could not read: it resumed the topic into
the limit every hour, and after six tries gave up with «Couldn't resume». It now waits for that date and time (in the zone
the message names) and resumes once.

**A usage-limit reset written with its time zone is read in that zone.** Claude Code names the zone it wrote the reset in
— «You've hit your session limit · resets 2:10pm (Europe/Moscow)» — and the bot read the clock in its own zone instead: when
the two differ, the topic resumed too early (and hit the limit again) or waited hours too long. Daylight saving is the named
zone's own.

**A usage warning is no longer announced as an exhausted limit.** Claude Code warns before a limit is reached —
«Approaching session limit · resets 11:29pm», «You've used 90% of your weekly limit · resets …», and «… continuing with usage
credits» / «Now using extra usage» once paid extra usage takes over. On a topic running Claude in tmux mode the bot read the
warning as the limit itself: it posted «🚧 Usage limit reached — will auto-resume after reset (~<time>)» while the account still
had room, and the work waited for the reset. Only the real block («You've hit your session limit · resets …») stops a topic now.

**After a restart, a limit that had already reset is no longer announced as exhausted until the next day.** When the bot
came back to a topic still parked on a limit error (`resets 10:50pm`), it read the reset time against the restart instead
of the error, so a window that had reset at 22:50 became «resumes after reset (~tomorrow 22:50)». The topic now resumes at
once with the «limit window has reset» line, and no limit notice.

**An OpenCode server that goes down no longer floods the topics with errors and drops their sessions.** When `opencode
serve` stopped, the bot made one attempt to start it again; if that attempt failed — the binary not found («spawn opencode
ENOENT»), a slow start — every OpenCode topic got the raw error and lost its session, and a message sent meanwhile failed
with «fetch failed». A session start or resume that found the server down failed the same way. Now every way of bringing the
server up installs a missing binary first and retries for about a minute. A restart is silent: the sessions are restored,
only a topic whose reply was in progress is told it was lost, and a message sent during the restart is delivered once the
server is back. Only if every attempt fails does a topic get one short line, in its language, saying the next message will
try again — and that next message no longer claims the conversation was lost and starts a new one. A binary that only lives
in `~/.npm-global/bin` is no longer reinstalled on every start.

**A conversation whose transcript Claude Code's cleanup removed no longer kills the topic's agent.** Claude Code deletes
the transcripts of old conversations; a running agent that is stopped after that writes only a metadata stub back, which the
CLI refuses to resume («No conversation found»). The bot took the stub for a conversation: a change of account, model or
effort ended with an error in the topic and a dead agent, and the next message failed the same way. A transcript is now
resumed only when it holds messages. A topic whose conversation is gone gets one line saying so and a fresh session — on its
next message, and also when an account, model or effort change re-spawned its running agent onto the lost conversation (it
starts again under the same id; the agent has forgotten the earlier context, which the line says). The same goes for a sleeping
conversation whose transcript the cleanup removed entirely (no agent was running to leave a stub): the bot remembers that
it took turns. A session that never took a turn has no transcript and nothing to lose: it wakes silently. A re-spawn waits
up to 5 s for the old process to exit and kills it if it will not, so two agents never run on one conversation.

**The `/limits` board showed the old ✓ after a slow default change.** Changing the default Claude account from General
re-spawns every running topic that follows it, which can take about half a minute; Telegram had stopped waiting for the
tap by then, the pop-up was refused, and the board was never redrawn until the next `/limits`. The board (and `/accounts`,
the model pages, `/limits_autoswitch` — the limit notice's «Switch to …» button included — and the `/model` and `/effort` pickers)
now always finish what the tap does, and a confirmation whose pop-up could not be shown is posted as a message.

**`/limits` is a switch board: every account and provider with its usage, one tap to move the topic.** The message opens
with `Usage (% used)` and a line per signed-in Claude account in the `/accounts` wording — `default — ⏱ 5h 14% 🔄 in 3h · week 3%
🔄 in 6d`, `⛔ at its limit until Sun 01:00` while limited — and the ChatGPT subscription's windows after them (`openai (ChatGPT) — ⏱ 5h …`),
then the automatic-switching state and the caption «Choose the active model:». Below it every signed-in Claude account and each connected
OpenCode provider is one button with its name only — `✓ Claude · work`, `Claude · default`, `OpenCode · openai` (the figures do not fit a
phone's button) — and a tap switches this topic: another
account (model and conversation kept), an OpenCode provider (its model page opens; the same OpenCode session just changes the
model), the ✓ row (change the model of where the topic runs). Across backends with a conversation to hand over it asks first;
while a usage-limit wait is armed the tap is the limit move (on the limited Claude account a model the limit does not cover — `opus` under a Fable-only weekly limit — continues the work too). The usage-limit notice now ends «The limit resets <time>.
Switch: /limits». In General a Claude row sets the default account.

**Fable is judged on all three of its windows.** The session window and the shared weekly «all models» window bound every
model, Fable included; Fable additionally drains its own weekly window. The `claude_profiles` recommendation (MCP tool and
`charness claude-profiles`), the fallback chain's availability and the account ranking on a limit used to look at Fable's own
window and the session window only, so an account with its shared weekly window exhausted could still be recommended for Fable.

**The fallback setup is its own screen, `/limits_autoswitch`.** The ordered fallback list, «🔁 Auto switch» and «⏳ Wait for
reset» moved there from the old `/limits` (minus the usage block); its rows now read `✓ 1. Claude · work · opus` /
`3. OpenCode · openai · gpt-5`. `/limits rebuild|clear|switch|wait …`, `/fallback` and `/auto_continue_limits` keep working.

**`/accounts` tells the truth about OpenCode.** Its title and ✓ say where the topic really runs (`OpenCode openai/gpt-5`),
an OpenCode provider row switches the topic to that provider through the model page (`/accounts use <provider>/<model>` is
the typed form), and a provider signed in with a ChatGPT subscription shows its ~5 h / ~7 d usage windows like a Claude account.

**A default reasoning effort for the whole instance: `/effort` in General.** New sessions no longer start on `xhigh`
in every topic that never picked a level: the default is `medium`, and the General topic's `/effort` sets it for all
topics at once (saved in `settings.json`, see [SETUP.md § Instance settings](SETUP.md#instance-settings-settingsjson)).
A topic's own `/effort` pick still wins, and «As in General» in a topic gives it up again.

**Voice recognition: one settings file, `/stt`, and a recogniser that runs on your machine.** The speech engines
(Groq, OpenAI, any OpenAI-compatible server, and the local GigaAM v3) are an ordered list in `stt.json`, edited from
`/stt` or by hand. Details: [SETUP.md § Voice input](SETUP.md#voice-input).

**A shorter notice when a usage limit moves a topic to another account or model.** One line now says which account
(or OpenCode model) hit its limit, where the topic continues — its model only when the switch changes it — when the
limit resets, and `/limits` to switch, instead of repeating every label and listing four commands.

**Switching a topic between Claude and OpenCode by hand now asks first, and a Claude account tapped in `/accounts` on an
OpenCode topic really switches.** `/claude`, `/opencode` (and the agent buttons / «start …» phrases) on a topic that
runs the other backend, and a Claude account picked in `/accounts` (`/accounts use <name>`) on an OpenCode topic —
which only recorded the pick before — ask «Switch this topic from OpenCode to Claude «work»? The conversation context
will be handed over in compacted form.» with ✅ Continue / ✖️ Cancel when there is a conversation to hand over; Continue
moves the topic the way a usage limit does (the other backend's parked conversation is resumed, the context bridge is the
first prompt), Cancel changes nothing, and a topic with nothing to hand over switches at once. `/limits_autoswitch` asks
the same way before a rung of a backend the list does not use yet is added or included again.

**An answer tapped on a re-asked question no longer gets lost.** The idle compaction posts the re-asked question just
before it stops the agent's process; a tap while that process was being stopped went to it and vanished. Such a tap is
now held and reaches the agent once the conversation is resumed, like a message typed at that moment. A tap or a message
that came a moment before the stop began, and was still on its way to the agent when it started, is held or wakes the
conversation the same way.

### Upgrading
- **`/limits` is a different screen now.** The fallback list and the two settings are in `/limits_autoswitch`; `/limits`
  is the switch board. Old buttons on an old `/limits` message keep working and re-render that message as
  `/limits_autoswitch`; the text forms (`/limits rebuild`, `/limits switch on`, …) keep working too. A bot menu entry for
  `/limits_autoswitch` is added at the next start.
- **A new outgoing request.** When OpenCode holds a ChatGPT subscription login for the `openai` provider, the bot reads
  its usage windows with the stored token from `https://chatgpt.com/backend-api/wham/usage` (every 10 minutes and when
  `/limits` or `/accounts` opens). The token is never refreshed or logged; an API-key provider triggers no request.
- **The default effort is `medium` now (it was `xhigh`).** Topics with no `/effort` pick of their own start their next
  session on `medium`; running sessions keep their level. To get the old behaviour back, pick `xhigh` in General's
  `/effort` (or write `{ "defaultEffort": "xhigh" }` into `settings.json` beside your env file).
- **`GROQ_API_KEY` / `OPENAI_API_KEY` move out of the env file.** At the first start without a `stt.json` the bot
  copies them into it (Groq first) and logs a `[deprecated]` line; from then on the env keys are ignored. Use `/stt`
  or edit `stt.json`, and delete the keys from the env file when convenient.
- **`stt.json` lives beside your real env file** (a symlinked `.env` is resolved: it goes next to the target). That
  directory must be writable and survive restarts.
- **Docker: mount the config DIRECTORY, not only the env file.** `examples/docker-compose.yml` now takes
  `INSTANCE_CONFIG_DIR` (the directory that holds the env file) in place of `INSTANCE_ENV_FILE`: move the env file into
  a directory of its own, e.g. `/srv/charness/config/instance.env`, mount that directory writable and point `ENV_FILE`
  at the file inside it (`docker run` form: SETUP.md § Run with Docker). With the old single-file mount `stt.json` lands
  on the container's own disk: it is lost whenever the container is re-created, and the old keys are copied in again each
  time. The bot warns at boot when it runs in a container and `stt.json` is not on a mount (`[STT] … is on this
  container's own disk`), and when the directory cannot be written at all. The local engine itself is not available in
  the Docker image yet (no `python3-venv`).

### Added
- **`/effort` in General** sets the instance default; **`/effort` in a topic** shows where its level comes from and
  offers «As in General». `/status`, the ready notice and the pinned banner show the level a topic's session really runs —
  after a General change a running session keeps its level, shown as «xhigh (medium from the next start)». OpenCode
  rounds General's value to the model's variants (`ultracode` = its highest, `auto` = no variant).
  The default lives in `settings.json` (beside `stt.json`), hand-editable without a restart.
- **`/stt`**: the main screen is the engine list, «➕ Add engine» and the language; each engine has a card (order, use /
  don't use, timeout, and a key for the hosted ones); Groq, OpenAI and a custom server are added through «➕ Add engine».
  A pasted key or an address with a login is deleted from the topic at once and kept out of the logs and the output trace.
- **Local recognition (GigaAM v3, Russian):** a recogniser process that starts with the first voice that needs it,
  survives hot reloads, stops after idle time and with its owner, and falls back to the next engine on any failure.
  It is added through «➕ Add engine» like any other (a confirmation and a live install progress when the model is not
  installed), and everything local-specific — status, idle exit, workers, try again after failed starts, remove from list,
  remove the model files — is on its own card, not on the main screen; the cloud engines' cards show only the common
  controls and their key or address. Memory: about 0.5 GB while it runs, up to about 0.9 GB on a long voice.

### Fixed
- A voice note whose Telegram `duration` is 0 (a sender that gave no length) is treated as of unknown length, not as a
  0-second voice: it gets the same time budget as a voice without a length, so a long one no longer falls back to the
  next engine at the bare base timeout.
- Going from Claude to OpenCode and back (`/opencode` then `/claude`, a usage-limit switch to an OpenCode model and back) resumes
  the Claude conversation the topic left; it used to come back to a fresh one, because leaving OpenCode overwrote the
  parked Claude conversation id with the OpenCode session's. The same holds the other way round.
- A Claude json-stream session re-attached after a bot restart keeps its model (a `/model` pick, or Jira's configured
  one) when it is re-spawned for an effort or account change; it used to restart on Claude's default model.
- An OpenCode model that has no effort levels shows none: `/status`, the pinned banner and the ready notice no longer
  name General's default for a session that runs without any level (`/effort` already said «not available»).

## 3.2.0 — 2026-10-16

**Renamed: what was left under the TelegramCode name is now Charness.** The old names still work and each one
in use prints a `[deprecated]` line at start — rename them when you see it. Steps for an npm install, a source
checkout with self-update and Docker: [MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md).

### Breaking / renamed
- **`charness` is the command in every message, help text and document.** `telegramcode` and `telegramCode`
  stay as aliases.
- **Global config: `~/.config/charness/.env`** (was `~/.config/telegramcode/.env`; the older
  `~/.config/telegram-code` too). Moved by the automatic migration below; by hand:
  `mv ~/.config/telegramcode ~/.config/charness`.
- **Default data dir: `~/.charness`** (was `~/.telegramCode`). An existing `~/.telegramCode` is kept while
  `~/.charness` does not exist; an explicit `DATA_DIR` is untouched. Moved by the automatic migration below; by
  hand, with the bot stopped and no agent running — or set `DATA_DIR` to the old path to keep it.
- **Hot-mode variables: `CHARNESS_HOT_RELOAD`, `CHARNESS_OPENCODE_PROCESS_FILE`** (were `TELEGRAMCODE_HOT_RELOAD`,
  `TELEGRAMCODE_OPENCODE_PROCESS_FILE`). The supervisor sets both; restart `charness hot` once after the update.
- **MCP client-id header: `x-charness-mcp-client-id`** (was `x-telegramcode-mcp-client-id`); the server accepts
  both.
- **OpenCode compaction plugin: `charness-compaction.js`** (was `telegramcode-compaction.js`); the old file is
  removed when the new one is installed.
- **Docker: image, service and container `charness`, `charness-main`**; mounts `/opt/charness`,
  `/home/charness`; restart command `charness-restart-bot`; compose variables `CHARNESS_DATA_DIR`,
  `CHARNESS_WORK_ROOT`. A running container of the old image is not affected; the new entrypoint accepts the old
  mount points and `telegramcode-restart-bot` still works.

### Added
- **Automatic migration at a cold start.** The bot moves `~/.config/telegramcode` (or the older
  `~/.config/telegram-code`) to `~/.config/charness` and the default `~/.telegramCode` to `~/.charness`, leaves a
  relative symlink at each old path (running agents and scripts keep working), renames `TELEGRAMCODE_*` keys to
  `CHARNESS_*` in the config file it moved (the original kept as `.env.bak`) and logs one `[migrate]` line per
  action. It runs under the instance lock before the state is loaded, only on the plain start and the hot
  supervisor's start (never on a worker reload), never for an explicit `DATA_DIR` or an `ENV_FILE` instance,
  and is idempotent. Details: [MIGRATION_RENAME_TO_CHARNESS.md](MIGRATION_RENAME_TO_CHARNESS.md#automatic-migration).
- `scripts/self-update.sh` names a newly added `MIGRATION_*.md` in its log.
- **Jira: an @-mention of the AI account in a comment wakes it to answer**, without the issue being handed over:
  it reads and checks, changes nothing, and its answer is a comment. On with a `trustedGroup` (only a trusted
  author and last editor count); `wakeOnMention: false` turns it off. See SETUP.md § Jira.
- **Jira: an answer notifies the person it is for** — it @-mentions the requester of a mention and the authors
  of the comments it replies to.
- **Answers are written briefly, in plain words, for a manager or QA** — on Jira issues and in Telegram topics
  alike.

### Changed
- Jira: a hand-over is noticed within 30 s by default (`pollIntervalSeconds` default 30, was 90).

### Fixed
- Jira: a mention no longer displaces a hand-over without a requester, and a superseded question no longer asks
  to assign the issue back.
- A Claude session adopted under the old data-dir path is no longer re-spawned as another account.

## 3.0.0 — 2026-10-07

**Published as `charness`.** The npm package is renamed from `telegramcode` to
`charness`, after the project. To move over:
`npm uninstall -g telegramcode && npm install -g charness`. The `telegramcode`
command, the `~/.config/telegramcode` config, the `~/.telegramCode` data dir and
the `TELEGRAMCODE_*` variables stay as they were, so an existing setup carries
over unchanged; `charness` is a new alias of the command.

### Added
- **Requests and answers.** A message, a voice note or a scheduled run opens a
  request; the agent answers it with the `answer_request` tool (progress,
  question or final), and every answer is pinned in the topic (only the latest
  stays pinned). An agent that ends its turn without answering is woken, and
  the operator is alerted when waking gives up. A usage-limit stop answers the
  open request.
- **`/verbosity` views**: Stream only, Stream + answers, Answers only. In
  Answers only, an agent that keeps writing after its final answer is reminded
  to send whatever matters.
- **Sleeping Claude conversations.** An idle json-stream conversation is
  compacted and its process stopped; the next message resumes it. A third
  Claude backend, per-turn, stops the process after every turn.
- **Compaction**: `/compact` on every agent backend, compaction on idle, the
  agent's own `compact_conversation` tool, and the summary posted to the topic
  on request (`/compact_summary`, off by default). Every compaction summary
  names the skills to load again.
- **Usage limits**: wait for the reset and resume by itself
  (`/auto_continue_limits`).
- **`/reminders`**: reminders the bot posts and pins itself, without an agent.
- **Watchdog checks**: `schedule_create` with a `checkCommand` runs a check on
  schedule and wakes the agent on the first failure.
- **`/timezone`**: one instance-wide time zone for schedules and timestamps.
- **`/model`**: a two-level picker with pages and per-provider disabling;
  the model and effort are shown when an agent starts or switches.
- **OpenCode `/connect`** works with ordinary providers.
- **Replies**: the replied-to message goes into the agent's prompt, and a
  replied-to photo, file or voice note is named with the bot's saved copy.
- **Voice**: transcription is retried after a timeout or a transient error.
- **`send_messages_to_user`**: each message may carry a file.
- **Jira Cloud connector** (`CONNECTORS=jira`): an issue assigned to the AI
  account becomes a request in its own session, and the answers come back as
  comments.
- **Docker**: the whole bot runs in one container (`docker/`).

### Fixed
- Many fixes in output streaming, session restore after a restart, OpenCode
  event routing and the Claude screen scrape; see the git history.

## Earlier changes, shipped in the 2.0.x packages

### Changed
- **`WORK_DIR` is no longer fatal.** Launch `telegramcode` from the parent
  folder containing your projects — that `$PWD` becomes the work root.
  `WORK_ROOT` is now an advanced override (services / containers where the
  process cwd can't be controlled); a stray legacy `WORK_DIR` is ignored, not a
  startup error.
- **`ALLOWED_GROUP_ID` is now optional.** Leave it empty to auto-pair with the
  first forum supergroup an admin contacts the bot from; set it only to pin a
  specific group before first contact.
- **OpenCode no longer interrupts a running turn for a new prompt.** A prompt
  sent while OpenCode is busy is queued by `prompt_async` and picked up promptly
  instead of aborting the live turn (which only lost work). Claude keeps its
  Escape-and-wait — its TUI ignores typed input mid-turn.
- **Bot UI language is resolved per Telegram chat.** A `/language` override wins,
  otherwise the bot uses Telegram `language_code`, then the last seen chat
  locale, then English; the old global env language knob is removed.

## 2.1.0 — 2026-05-13

**Audit fixes release.** Full repo audit (50 findings across security,
concurrency, resource handling, error contracts, infra) closed in 20
focused commits. See `agent/tasks/actual/2026-05-13-audit-fixes.md` for
the full plan; highlights below.

### Security
- **Two RCEs closed** in `claudeCliAdapter`: `sendInput` and
  `startSession`/`resumeSession` built tmux command lines via
  `execSync` with `JSON.stringify`-interpolated user input, letting any
  allowed user run arbitrary host commands via `$(…)` / backticks in a
  thread message. Reroute all tmux calls onto the argv-based helper;
  single-quote every element of the final `tmux new-session` shell
  command (S1).
- **Forum-topic auth bypass** closed: `forum_topic_created` /
  `_closed` / `_reopened` are now gated on `ALLOWED_USERS`, not just
  the chat allowlist. A non-allowed admin previously could rename a
  topic to fuzzy-match a sensitive WORK_ROOT subdir and have the next
  allowed-user message launch an agent there (S2).
- **OpenCode SSE cross-thread events**: `permission.asked` and
  `question.asked` events without `sessionID` used to fan out to every
  active thread, auto-approving permissions and stacking duplicate
  questions. Now any event without a `sessionID` is dropped (S5).
- **SSRF guard** on `OPENCODE_URL` (loopback by default, opt in with
  `OPENCODE_ALLOW_REMOTE=1`); 30 s timeout on every fetch; abortable
  SSE reader; 10-minute wall-clock cap on SSE reconnect (S7).
- **Docker hardening**: drop `user: root`, `cap_drop: [ALL]`,
  `security_opt: no-new-privileges`, bounded `mem_limit`/`pids_limit`,
  healthcheck. `.docker-entrypoint.sh` uses `runuser -- "$@"` instead
  of `su -c "$*"` so argv stays argv. claude-code install moved to
  build time with a pinned version (S16).

### Bugs
- `resume_<idx>` callback: full session id is recovered from a
  per-thread map instead of being truncated into callback_data, which
  used to make OpenCode resume target a non-existent id (S4).
- Pinned-banner pipeline serialised per key so concurrent adapter
  events can't stack duplicate pinned messages (S6).
- OpenCode lifecycle: per-key serialisation of start/stop, cleanup of
  `statusDebounceTimer` and `reconnectTimer` on stop, explicit
  teardown of every session after `restartServer` (S8).
- Claude adapter: auto-Enter / auto-Accept timers tracked + cleared on
  stop; `pollOutput` uses self-rescheduling `setTimeout` with
  re-entrancy guard; `adoptExistingTmuxSession` rejects zombie panes
  with no live child; capture-pane scrollback raised to 2000 lines (S9).
- `/clear` snapshots message ids under `state.withLock` so agent
  messages pushed mid-deletion can't slip out of tracking (S11).
- `/output` flips `markNeedsNewMessage` and surfaces "+N more chunks
  omitted" instead of silently dropping (S11).
- `/new` routes through `applyBinding` so collision warnings reach the
  new thread (S11).
- `switchThreadAdapter` clears the previous adapter's stored session id
  so post-restart reattach doesn't pick the wrong adapter (S12).
- In-memory per-thread maps GC'd against `state.json` every 60 s so
  orphan entries from UI-deleted topics don't linger (S13).
- Numeric model-selection reply unconditionally returns; previously
  fell through to NL-start + agent-forward when `setModel` was absent
  (S12).
- `downloadFile` capped at 5 redirects with 20 s `setTimeout`;
  `transcribeAudio` got the same timeout and a proper error handler
  installed before `form.pipe(req)`. Voice file URL now built via
  `ctx.telegram.getFileLink` so the bot token isn't materialised in a
  JS string (S14).

### Contracts
- `AgentAdapter` events documented: `startSession` throws on failure,
  `error` is for async failures after a successful start, `closed` is
  unsolicited death, `stopped` is explicit teardown. Claude's two
  start paths now throw + clean up. `setModel` unified to
  `Promise<string | null>`. OpenCode SSE giveup emits `closed` so the
  bot wipes persisted ids (S10).

### Hygiene
- `tsconfig.json`: `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `exclude: src/__tests__/**`.
- `package.json`: drop `ts-node`, move `typescript` to devDeps,
  `private: true`, `engines.node >=22`.
- `BOT_LANG` lowercased + trimmed with a warn on unknown values.
- 19 hardcoded English `ctx.answerCbQuery` strings migrated to a new
  `cb.*` namespace in i18n.
- `.env.example` no longer leaks the author's home path; the two-
  instance example uses `REPLACE_ME` so a copy-pasted file fails
  validation visibly.
- DATA_DIR resolved via `resolveDataDir()` everywhere; previously the
  two adapters dropped state files in `$HOME` instead of `DATA_DIR`,
  breaking two-instance isolation (S3).

### Tests
- 13 new tests: i18n placeholders + fallback (S19/#50), agent NL
  trigger parser extracted into `src/agentTrigger.ts` with full ru/en
  coverage (S19/#25), state.json forward-compat round-trip with an
  unknown future field. 98 tests passing (R9/R10 still skipped).

### Deferred
- `noUncheckedIndexedAccess` in `tsconfig.json` (106 errors fallout —
  needs a careful per-site task).
- Complete MarkdownV2 escaper (regression risk).
- bot.ts test coverage (3300 LOC — separate task).

## 2.0.0 — 2026-05-12

**Breaking release.** The bot now routes through a Telegram forum
supergroup with one topic per task; the 1.x "one bot = one private chat
= one folder" mode is removed. See [Migration](README.md#migration-from-1x).

### Added
- **Forum-supergroup routing.** `ThreadKey = (chatId, threadId)` is the
  routing key everywhere; threads are bound to subfolders of `WORK_ROOT`
  and run their own `claude` or `opencode` session in parallel.
- **Persistent state** (`src/state.ts`) — `${DATA_DIR}/state.json` with
  atomic writes (write tmp → fsync fd → rename → fsync parent dir),
  per-key async-lock for concurrent `/bind`, corrupted-file archival to
  `state.json.corrupted-<ts>` with a fresh restart, debounced saves with
  immediate flush on critical paths.
- **Restart-safe sessions** — claude tmux sessions named
  `claude-${chatId}-${threadId}` are re-adopted on boot via
  `tmux ls`; opencode SSE streams are reopened from persisted
  `opencodeSessionId`. Orphan tmux sessions are killed.
- **Per-thread Claude session id** — `crypto.randomUUID()` →
  `claude --session-id <uuid>` on a fresh start, `--resume <uuid>` on
  resume. Fixes the 1.x picker hang.
- **MCP hierarchy** — user (`~/.claude/settings.json`) /
  group (`${DATA_DIR}/mcp.json`) /
  project (`${workDir}/.mcp.json`) /
  thread (`${DATA_DIR}/threads/<key>.json`). `${VAR}` placeholders are
  expanded by the bot before claude sees the config; tmp files are
  written `0600` and cleaned up on `stopSession`.
- **Commands.** `/bind`, `/unbind`, `/where` (per topic);
  `/ls`, `/list`, `/new`, `/status` (global), `/doctor`, `/mcp`,
  `/whoami`, `/version`, context-aware `/help`, `/stop-all`.
- **Path traversal protection** — NFC normalisation, control-char
  rejection, `realpathSync` + strict containment, symlink-out rejection,
  `/bind .` rejection.
- **Auto-welcome** when the bot is added to a forum supergroup, and
  rich post-bind welcome with CLAUDE.md / .mcp.json / git stats.
- **Token-bucket rate limiter** — 1 token/sec per chat, burst 5,
  layered with reactive 429-retry. Prevents the multi-thread N-msg/sec
  storm that would otherwise breach Telegram's per-chat budget.
- **i18n** — `BOT_LANG=ru|en` (default ru) via `src/i18n.ts`.
- **Two-instance docker-compose** (`examples/docker-compose.yml`) — pet
  + work, isolated `DATA_DIR`, group, token, `OPENCODE_URL` port.
- **Test suite** — `yarn test` (node:test + tsx). 54 tests cover R1
  (ThreadKey round-trip), R2 (gating matrix), R3 (path-traversal
  corpus), R4 (legacy file migration), R5 (concurrent state writes),
  R6 (corrupted state archival), R7 (rate-limit token bucket + 429
  retry), R8 (send-error classification).

### Changed
- **`WORK_DIR` → `WORK_ROOT`.** `WORK_DIR` is now fatal — bot fails to
  start with a migration hint. `WORK_ROOT` points at the *parent* folder
  containing your projects.
- **`ALLOWED_GROUP_ID` is required.** Without it the bot has no idea
  which forum supergroup to listen to.
- **`DATA_DIR`** — single-instance default `~/.telegramCode`, mandatory
  for two-instance setups.
- **`--dangerously-skip-permissions`** hardcoded for symmetry with
  opencode's auto-approve.
- **`/clear`** scoped to the current thread (uses persisted message ids),
  chunked at 100 per call, surfaces the Telegram 48 h limit.
- **README** rewritten end-to-end around forum supergroup setup,
  troubleshooting, MCP hierarchy, two-instance compose, migration.

### Removed
- One-bot-per-private-chat mode and `WORK_DIR` env var.
- Legacy `~/.telegram-bot-messages.json` (renamed to `.bak` on first
  start; no message-id migration into the new schema).

### Deferred (Phase 9+)
- `/mcp-add`, `/mcp-remove`, `/mcp-restart` UI commands.
- OpenCode per-thread MCP override.
- Routines / opencode-scheduler integration (`/schedule`,
  `/schedule-cloud`) — Phase 8.
- Claude Code hooks integration + `--input-format stream-json`
  rewrite — Phase 9.

### Stage 7 polish (shipped 2026-05-12)
- Per-thread pinned status banner (`📁 subdir · agent · model ·
  state`) — edits in place on every adapter lifecycle event,
  unpinned on `/unbind`.
- Fuzzy auto-bind on `forum_topic_created` — separator drift
  (`my-api` ↔ `my_api` ↔ `my api`) is folded alongside case + NFC.
- `/bind` keyboard pagination at 20 folders/page with
  `[⬅️ Prev] [N/M] [Next ➡️]` nav row; `WORK_ROOT` listing cap
  raised 50 → 200.
- R9 (tmux re-attach) and R10 (claude `--resume` on bogus UUID)
  filed as documented skip-tests pending an integration harness.

### Migration
1. Stop the 1.x bot.
2. Create a forum supergroup, add the bot, follow
   [README Quick Start](README.md#2-create-the-forum-supergroup).
3. Rename `WORK_DIR` → `WORK_ROOT` and point at the parent folder.
4. Add `ALLOWED_GROUP_ID` (find it via `/whoami` in the group).
5. Set `DATA_DIR` if you run multiple instances on one host.
6. `docker compose up -d`.

The legacy `~/.telegram-bot-messages.json` is moved to `.bak` on first
start; message-id history does not migrate.
