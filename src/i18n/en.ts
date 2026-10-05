/**
 * @description Canonical English catalog — the reference every other locale
 * falls back to. A key missing in any locale resolves here. When adding a new
 * key, add it here FIRST, then mirror it in every other locale file.
 */

export const enDict: Record<string, string> = {
  'access.denied': 'Access denied.',
  'access.group_only': 'I only work in the configured forum supergroup.',

  'thread.no_binding':
    '📁 This thread is not bound to a folder. Use /bind <subdir> or pick from the list.',
  'thread.bind_required':
    '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.',
  'thread.bound': '📁 Bound to `{subdir}`.\nRun /claude or /opencode.',
  'thread.unbound': '📁 Binding cleared.',
  'thread.general_no_agent':
    'General is not bound to a folder — switch to a topical thread to talk to an agent.',
  'thread.welcome_bound':
    '👋 Thread created and auto-bound to `{subdir}` (topic name matched a subfolder).\nRun /claude or /opencode.',
  'thread.welcome_pick':
    '👋 Thread created. Bind a folder: /bind <subdir>, or pick one below.',
  'thread.bind_collision':
    '⚠️ Folder `{subdir}` is already used by threads: {threads}.\nBinding added; sessions stay independent (own tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 Folder `{subdir}` is bound. Run /claude or /opencode to start the dialog.',

  'bind.usage': 'Usage: /bind <subdir>\nExample: /bind overview',
  'bind.current': '📂 Currently bound: `{subdir}`',
  'bind.current_none': '📂 Not bound yet',
  'bind.in_general': '/bind only works in topical threads, not in General.',
  'bind.invalid_chars': '❌ Folder name must not contain control characters.',
  'bind.not_found': '❌ Folder `{subdir}` not found under `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Path escapes `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` exists but is not a directory.',

  'bind.leave_button': '⬅️ Leave current dir',
  'bind.create_button': '➕ Create new folder',
  'bind.create_prompt':
    '✏️ Send the new folder name (it will be created under `WORK_ROOT`). Any command cancels.',
  'bind.create_cb': 'Creating a new folder…',
  'bind.create_empty': '❌ Name is empty. Send a folder name.',
  'bind.create_separator': '❌ Name must not contain `/` or `\\`. Send a plain name.',
  'bind.create_dot_segment': '❌ `.` and `..` cannot be used as a folder name.',
  'bind.create_hidden': '❌ Name must not start with a dot.',
  'bind.create_invalid_chars': '❌ Folder name must not contain control characters.',
  'bind.create_exists': '📁 Folder `{subdir}` already exists — binding to it.',
  'bind.create_failed': '❌ Failed to create the folder: {error}',

  'ls.header': '📁 Subfolders of `{workRoot}`:',
  'ls.empty': '📁 No bindable subfolders under `WORK_ROOT`.',
  'list.header': '🧵 Thread bindings ({count}):',
  'list.empty': '🧵 No bindings yet. Create a thread and run /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new works inside a bound topic — open a thread and run /new to restart its agent session.',

  'help.general':
    '*Commands in General:*\n' +
    '/ls — list `WORK_ROOT` subfolders\n' +
    '/list — list threads\n' +
    '/status — status of all threads\n' +
    '/quitall — quit every running agent\n' +
    '/whoami /version — debug\n\n' +
    'To talk to an agent — open a topical thread.',
  'help.thread_unbound':
    '*Thread is not bound to a folder.*\n' +
    '/bind <subdir> — bind (or pick from the list)\n' +
    '/ls — `WORK_ROOT` subfolders (in General)',
  'help.thread_bound':
    '*Thread bound to `{subdir}`.*\n' +
    '/claude /opencode — start an agent\n' +
    '/connect — connect an OpenCode provider API key (OpenAI by default)\n' +
    '/disconnect — remove a provider\'s stored credentials\n' +
    '/terminal — open a shell in this folder\n' +
    '/new — restart the session (old one → /sessions)\n' +
    '/model /sessions — switch\n' +
    '/effort — reasoning-effort level\n' +
    '/verbosity — output detail and what the topic shows (stream / answers)\n' +
    '/quit /status /output — control\n' +
    '/compact — compact agent context\n' +
    '/compact_on_idle — auto-compact after idle (toggle)\n' +
    '/auto_continue_limits — auto-resume after a usage limit (toggle)\n' +
    '/clear — delete thread messages\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI keys (Claude)\n' +
    '/bind — manage binding',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot is a group admin',
  'doctor.can_manage_topics': '`can_manage_topics` granted',
  'doctor.can_delete_messages': '`can_delete_messages` granted',
  'doctor.can_pin_messages': '`can_pin_messages` granted',
  'doctor.privacy_off': 'Privacy mode disabled',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, then remove and re-add the bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} subfolders)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI installed',
  'doctor.opencode_installed': 'opencode CLI installed',
  'doctor.state_valid':
    'state.json valid ({bindings} bindings, {active} active)',
  'doctor.state_archived':
    'previous state.json was corrupted, archive: {path}',
  'doctor.cli_missing':
    'not found in PATH (auto-install will run on /claude or /opencode)',
  'doctor.no_admin_info':
    'cannot read bot rights — getChatMember failed',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Ready-to-work checklist:\n' +
    '1️⃣ Make me a group admin with rights:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, then remove and re-add me\n' +
    '3️⃣ Run /doctor to see what is still missing\n' +
    '4️⃣ In each topical thread run /bind <subdir> and start an agent\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Bound to `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} servers',
  'binding.welcome.git': '• git: branch `{branch}`{detail}',
  'binding.welcome.git_clean': ', clean',
  'binding.welcome.git_dirty': ', uncommitted changes',
  'binding.welcome.git_none': '• git: not initialised',
  'binding.welcome.start_prompt': 'Start a conversation:',

  'mcp.header': '🔌 *MCP servers for this thread:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 No MCP servers configured.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Pinned thread status (Stage 7) will be unavailable',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(no binding)',

  'pair.success': '✅ Group paired. id: `{groupId}`. The bot is now serving this supergroup.',
  'pair.locked':
    'ℹ️ The group id is set via `ALLOWED_GROUP_ID` — auto-pairing is disabled. ' +
    'To switch groups, change the variable and restart the bot.',
  'pair.only_forum': '❌ /pair only works inside a forum supergroup (enable Topics).',
  'pair.not_admin': '❌ Only a group administrator or creator can pair the bot.',
  'pair.not_paired': 'group not paired yet (pairing mode)',
  'pair.dm': "ℹ️ /pair isn't needed in DM mode — the bot serves your private chat.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(unavailable)',
  'status.global_header': '📊 *All threads* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 No threads yet.',
  'status.thread_report': 'Status:\n\nAgent: {agent}\nFolder: {subdir}\nSession: {session}',
  'status.thread_view': 'View: {view}',
  'status.thread_model': 'Model: {model}',
  'status.thread_effort': 'Effort: {effort}',
  'status.thread_started': 'Started: {started}',
  'status.thread_running': 'running',
  'status.thread_stopped': 'stopped',
  'status.thread_sleeping': 'sleeping — resumes on the next message',
  'status.thread_no_agent': 'none (start /claude or /opencode)',
  'status.thread_no_binding': '(no binding — WORK_ROOT)',
  'status.thread_workdir': 'Working directory: {workDir}',
  'status.thread_runtime_version': 'Runtime version: {version}',
  'status.thread_context': 'Context: {used} / {limit} tokens',
  'language.status': '🌐 Language: {display}',
  'language.set_success': '✅ Language set to `{locale}` for this chat.',
  'language.auto_success': '✅ Language reset to auto. Current: {display}.',
  'language.invalid': '⚠️ Locale `{locale}` is not supported. Available: {locales}.',

  'timezone.status': '🌍 Timezone: {zone} — now {now}',
  'timezone.usage':
    'Usage: /timezone <IANA zone>  ·  /timezone +04:00  ·  /timezone auto\nOr send /timezone with no argument to pick from a list.',
  'timezone.set_success': '✅ Timezone: {zone} — now {now}\nSchedules recomputed: {count}',
  'timezone.auto_success':
    '✅ Timezone reset to the host zone: {zone} — now {now}\nSchedules recomputed: {count}',
  'timezone.invalid':
    '⚠️ Unknown timezone `{zone}`. Use an IANA name (e.g. `Europe/Moscow`) or a fixed offset (e.g. `+04:00`). Send /timezone to pick from a list.',
  'timezone.offset_unsupported':
    '⚠️ The offset `{zone}` cannot be applied — only whole-hour offsets take effect. Use your zone\'s IANA name instead (e.g. `Asia/Kolkata` for +05:30).',
  'timezone.fixed_offset_warning':
    '⚠️ A fixed offset does not follow daylight saving time — it will be an hour off for half the year.',
  'timezone.picker_regions': '🌍 Timezone: {zone}\nNow: {now}\n\nPick a region:',
  'timezone.picker_zones': '🌍 {region} — page {page}/{total}',
  'timezone.picker_expired': 'That list is out of date — send /timezone again.',

  'agent.ready': '{label} ready in `{subdir}`{argsSuffix}\n{infoBlock}Send a message:',
  'agent.ready_model': '🧠 Model: {model}',
  'agent.no_session': 'No agent running. /claude or /opencode to start.',
  'agent.session_ended': '{label}: session ended',
  'agent.stopped': '{label} stopped',
  'agent.sleeping_released': 'The sleeping session was released — the next message starts a fresh one.',
  'agent.resume_failed_fresh': '⚠️ The previous conversation could not be resumed — a fresh session was started.',
  'agent.exit_signal_sent': 'Double Ctrl+C sent — {label} exiting',
  'agent.already_active': '{label} is already running here. Send a message or /quit.',
  'agent.starting': 'Starting {label} in `{subdir}`…',
  'agent.queued_starting': '⏳ {label} is still starting — your message is queued and will be sent once it is ready.',
  'agent.question_hint': 'ℹ️ Reply with the option number (e.g. 1) or y/n. Also: /up /down to move, /enter to confirm, /c to cancel.',
  'agent.start_failed': 'Failed to start {label}: {error}',
  'agent.no_response': '⚠️ The agent accepted your request but never started responding — the session may be stuck. Send it again, or /new to start a fresh session.',
  'agent.session_restarting': '⚠️ The agent didn\'t respond — the session looks stuck. Restarting it and re-running your request…',
  'agent.session_recovering': '⚠️ The agent didn\'t respond — recovering (your conversation is kept) and re-running your request…',
  'agent.question_cancelled_for_prompt': '⚠️ Previous question cancelled — running your new request.',
  'agent.question_cancelled_msg_label': '❌ Question cancelled: {header}',
  'agent.login_code_relayed': '🔐 Login code relayed to Claude — the token message was deleted from history.',
  'agent.login_url': '🔐 To sign in to Claude, open this link, complete sign-in, then paste the code back here:\n{url}',
  'agent.login_success': '✅ Signed in to Claude.',
  'agent.login_failed': '⚠️ Claude sign-in failed. Run /login to try again.',
  'login.esc_hint': '/esc to cancel',
  'login.waiting_code': '⏳ Waiting for the login code — paste the code from the sign-in link as your next message.',
  'login.cancelled': '✖ Login cancelled. Messages go to the agent again.',
  'agent.workingIndicator': '{glyph} working…',
  'terminal.ready': '🖥 Terminal ready in `{subdir}`{argsSuffix}\nEvery message runs as a command. /c — Ctrl+C, /up /down — history, /tab — completion, /quit — close.',

  'effort.choose': '⚙️ Current effort: {current}\nPick a level:',
  'effort.current_none': 'not set',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort: {effort}\nRun /effort to change it',
  'effort.invalid_level': '⚠️ Level `{level}` is not valid. Available: {valid}.',
  'effort.not_available': 'ℹ️ No reasoning-effort levels are available for the current model.',
  'effort.not_supported': 'ℹ️ Model `{model}` has no reasoning-effort levels.',
  'effort.start_agent_first': 'ℹ️ Level saved. No agent running — it will apply on next start.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` cleared: the new model `{model}` does not support it.',
  'effort.unsupported_backend': 'Effort control is not supported for {label}.',
  'effort.no_session': 'No agent running. Start one with /claude or /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 thought for {seconds}s',
  'thinking.choose': '☁️ Current thinking mode: {current}\nPick a mode:',
  'thinking.set_success': '✅ Thinking mode: {mode}',
  'thinking.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'short',
  'thinking.mode.full': 'full',

  'toolResults.choose': '🔧 Current tool-results mode: {current}\nPick a mode:',
  'toolResults.set_success': '✅ Tool-results mode: {mode}',
  'toolResults.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'short',
  'toolResults.mode.full': 'full',
  'toolResults.truncated_footer': '… (truncated, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'tool',

  'subagent.status_elapsed': '🤖 sub-agent: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sub-agent working …',
  'subagent.delegating_status': '🤖 Delegating: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sub-agent',
  'subagent.choose': '🤖 Current sub-agent mode: {current}\nPick a mode:',
  'subagent.set_success': '✅ Sub-agent mode: {mode}',
  'subagent.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'short',
  'subagent.mode.full': 'full',

  'verbosity.choose': '🔊 Verbosity — detail: {current} · view: {view}\nRow 1 — detail of the stream · Row 2 — what this topic shows:',
  'verbosity.set_success': '✅ Output verbosity: {mode} (thinking, tool results, sub-agents)',
  'verbosity.invalid_mode': '⚠️ `{mode}` is not valid. Detail levels: {valid}. Views: {views}.',
  'verbosity.custom': 'custom (thinking: {thinking} · tools: {toolResults} · sub-agents: {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'short',
  'verbosity.mode.full': 'full',
  'verbosity.view.stream': 'Stream only',
  'verbosity.view.streamAnswers': 'Stream + answers',
  'verbosity.view.answers': 'Answers only',
  'verbosity.view_set_success': '✅ This topic shows: {view} (applies from the next message)',

  'model.set_success': '🧠 Model set to: {model}',
  'model.saved_for_next_start': 'Model saved: {model} — applies on next agent start.',
  'model.start_agent_first': 'No active session. Start an agent first.',
  'model.current_default': 'default',
  'model.none_available': '🧠 Current: {current}\n\nNo models available. Use /model <provider/model> to set one manually.',
  'model.invalid_number': '❌ Invalid number. Run /model to see the list.',
  'model.pick_provider': '🧠 Current: {current}\n\nPick a provider:',
  'model.all_hidden': '🧠 Current: {current}\n\nEvery provider is hidden. Tap 👁 to bring one back.',
  'model.hidden_header': '🙈 Hidden from this picker — tap 👁 to restore.',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ providers',
  'model.prev_button': '⬅️ Prev',
  'model.next_button': 'Next ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} models · page {page}/{totalPages}\nCurrent: {current}',
  'model.page_hint': 'Reply with a number to pick, or /model <name> to search.',
  'model.page_hint_buttons_only': 'Tap a model to switch, or /model <name> to search.',

  'disconnect.unsupported_backend': 'OpenCode provider disconnect is not available in this build.',
  'disconnect.invalid_provider': '❌ Invalid provider id {provider}. Example: /disconnect openrouter',
  'disconnect.no_providers': 'No providers to disconnect.',
  'disconnect.pick_provider': 'Pick a provider to disconnect — its stored credentials will be removed:',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ Provider {provider} disconnected — stored credentials removed.',
  'disconnect.still_active_env': '⚠️ Stored credentials for {provider} were removed, but it is still active: OpenCode enables it from an environment variable. Unset that variable and restart OpenCode to drop it, or hide it from the picker via /model.',
  'disconnect.failed': '⚠️ Failed to disconnect {provider}: {reason}',

  'rename_session.usage': 'Usage: /rename_session <new title>',
  'rename_session.start_agent_first': 'No active session. Start an agent first (/claude or /opencode).',
  'rename_session.unsupported_backend': 'Session rename is not supported for {label}.',
  'rename_session.success': '✅ Session renamed: {title}',
  'rename_session.failed': '⚠️ Failed to rename the session: {reason}',

  'compact.started': '🧹 Compacting the session context — the agent continues from the summary.',
  'compact.done': '✅ Context compacted.',
  'compact.done_tokens': '✅ Context compacted: {pre} → {post} tokens.',
  'compact.summaryHeader': '📄 Compaction summary:',
  'compact.start_agent_first': 'No active session. Start an agent first (/claude or /opencode).',
  'compact.unsupported_backend': 'Context compaction is not supported for {label}.',
  'compact.model_unresolved': '⚠️ Cannot compact: no model is resolved for this session. Pick one with /model and try again.',
  'compact.failed': '⚠️ Failed to compact the session context: {reason}',
  'compact.busy': '⚠️ The agent is busy right now — run /compact again once the current turn finishes.',
  // Agent-facing (appended to the compaction prompt); English instructions, but
  // the "IN <language>" directive is baked per locale like the schedule.* templates.
  'compact.closingSectionInstruction':
    'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN ENGLISH: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',

  'compactOnIdle.notice':
    '🧹 Auto compacted on idle to save tokens via cache.\nRun /compact_on_idle to disable it.',
  'compactOnIdle.on': 'ON',
  'compactOnIdle.off': 'OFF',
  'compactOnIdle.title':
    '🧹 Auto-compact on idle for this topic: {state}\n\nWhen the session sits idle for ~55 min its context is compacted automatically to save tokens (the prompt cache is still warm).\n\nTo switch it for ALL topics at once, run this in the General topic.',
  'compactOnIdle.titleGeneral':
    '🧹 Auto-compact on idle — default for ALL topics: {state}\n\nWhen a session sits idle for ~55 min its context is compacted automatically to save tokens.\n\nEach topic can still override this with its own /compact_on_idle.',
  'compactOnIdle.enableButton': 'Enable',
  'compactOnIdle.disableButton': 'Disable',
  'compactOnIdle.setThisTopic': '✅ Auto-compact on idle: {state} for this topic.',
  'compactOnIdle.setGlobal': '✅ Auto-compact on idle: {state} for ALL topics (per-topic overrides still apply).',
  'compactOnIdle.unsupported': 'Auto-compact on idle applies to an active agent session. Start /claude or /opencode in a bound topic first.',
  'compactOnIdle.pendingQuestionReask': '❓ You still have a pending question. Tap an option to answer it and continue:',
  'compactSummary.on': 'ON',
  'compactSummary.off': 'OFF',
  'compactSummary.title':
    '📄 Post the compaction summary in this topic: {state}\n\nAfter a compaction the agent\'s full summary is written into the topic, so you can see what it kept.\n\nTo switch it for ALL topics at once, run this in the General topic.',
  'compactSummary.titleGeneral':
    '📄 Post the compaction summary — default for ALL topics: {state}\n\nAfter a compaction the agent\'s full summary is written into the topic, so you can see what it kept.\n\nEach topic can still override this with its own /compact_summary.',
  'compactSummary.enableButton': 'Enable',
  'compactSummary.disableButton': 'Disable',
  'compactSummary.setThisTopic': '✅ Compaction summary: {state} for this topic.',
  'compactSummary.setGlobal': '✅ Compaction summary: {state} for ALL topics (per-topic overrides still apply).',
  'compactSummary.unsupported': 'A shell has no context to compact, so there is no summary to post.',

  'autoContinueLimits.on': 'ON',
  'autoContinueLimits.off': 'OFF',
  'autoContinueLimits.title':
    '🚧 Auto-resume after a usage limit for this topic: {state}\n\nWhen the agent hits a usage / session limit, the bot waits for the window to reset and then tells the agent to continue by itself (the resume message is pinned, so a muted topic still notifies you).\n\nTo switch it for ALL topics at once, run this in the General topic.',
  'autoContinueLimits.titleGeneral':
    '🚧 Auto-resume after a usage limit — default for ALL topics: {state}\n\nWhen an agent hits a usage / session limit, the bot waits for the window to reset and then tells the agent to continue by itself.\n\nEach topic can still override this with its own /auto_continue_limits.',
  'autoContinueLimits.enableButton': 'Enable',
  'autoContinueLimits.disableButton': 'Disable',
  'autoContinueLimits.skipButton': '⏭ Skip once',
  'autoContinueLimits.skipDone': 'This resume was skipped.',
  'autoContinueLimits.skipExpired': 'Nothing to skip — this wait is already over.',
  'autoContinueLimits.skippedNotice':
    '⏭ Skipped: I will not resume this one by myself. Write to me when to continue — auto-resume stays on for this topic.',
  'autoContinueLimits.noticeHint':
    'Run /auto_continue_limits to skip this one resume or to turn auto-resume off for this topic.',
  'autoContinueLimits.setThisTopic': '✅ Auto-resume after a usage limit: {state} for this topic.',
  'autoContinueLimits.setGlobal': '✅ Auto-resume after a usage limit: {state} for ALL topics (per-topic overrides still apply).',
  'autoContinueLimits.limitReachedDisabled':
    '🚧 Usage limit reached. Auto-resume is off for this topic, so I will wait — write to me when to continue (/auto_continue_limits on to resume automatically).',

  'connect.prompt_key': '🔑 Send the API key for `{provider}` as the next message. I will delete the key message from history.',
  'connect.empty_key': '❌ API key is empty. Send the key as the next message.',
  'connect.invalid_key': '❌ That does not look like an API key (it has spaces or non-Latin characters). Send just the key as the next message, or run /connect again.',
  'connect.invalid_provider': '❌ Invalid provider id `{provider}`. Example: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` does not support a simple API-key login through this flow. Use the OpenCode UI/CLI for this provider.',
  'connect.unsupported_backend': 'OpenCode provider auth is not available in this build.',
  'connect.failed': '⚠️ Failed to connect `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` connected. OpenCode server was not restarted.',
  'connect.cancelled': 'API key entry cancelled.',
  'connect.pick_method': 'How do you want to connect `{provider}`? Pick a method:',
  'connect.no_methods': '⚠️ No auth methods found for `{provider}`.',
  'connect.oauth_device': '🔓 To connect `{provider}`: open {url} and enter the code `{code}`, then authorize. On a server, use the *headless* method. I\'ll confirm here when it\'s done.',
  'connect.oauth_url_only': '🔓 To connect `{provider}`: open {url} and complete sign-in. I\'ll confirm here when it\'s done.',
  'connect.oauth_paste': '🔑 After authorizing, paste the code here as the next message — I\'ll delete it from history.',
  'connect.oauth_waiting': '⏳ Waiting for authorization…',
  'connect.oauth_loopback': '🔑 After authorizing, your browser will try to open a `localhost` page that fails to load — that\'s expected here. Copy that URL from the address bar and paste it back as the next message (or just the `code` value). I\'ll delete it from history and finish sign-in.',
  'connect.oauth_invalid_reply': '❌ That does not look like a callback URL or an auth code. After authorizing, paste the `localhost` callback URL from your browser (or the `code` value).',
  'connect.oauth_callback_no_flow': '⚠️ That looks like an OAuth callback URL, but no sign-in is in progress here — I deleted it. Run /connect to start again.',
  'connect.oauth_success': '✅ `{provider}` connected via OAuth. OpenCode server credentials were reloaded.',
  'connect.oauth_failed': '⚠️ OAuth sign-in for `{provider}` didn\'t complete. Run /connect to try again.',

  'quit_all.none_active': 'No agents running — nothing to stop.',
  'quit_all.summary': '🚪 Quit {stopped} of {total} active agents.',
  'quit_all.general_only': '`/quit-all` is only available in the General topic.',

  'clearMessages.summary':
    '🗑 Deleted {deleted} of {total} messages. ' +
    'Telegram refuses to delete anything older than 48 h — the rest stays in history.',
  'clearMessages.no_messages': 'No messages to delete in this thread.',

  'edited.hint':
    '✏️ I don\'t treat edited messages as new input — send the correction as a separate message.',

  'voice.no_api_key':
    'Voice requires `GROQ_API_KEY` (free) or `OPENAI_API_KEY`.',
  'voice.failed': 'Failed to transcribe voice message.',
  'voice.retrying': '⚠️ Failed to transcribe voice message ({error}). Retrying in {seconds} s…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 File exceeds the Bot API limit ({cap} MB) — I can\'t download it. Send a smaller file.',
  'file.download_failed': '📎 Failed to download the file. Please try again.',

  'error.workdir.gone':
    '📁 Folder `{subdir}` is gone from disk. Run /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ Thread was deleted in Telegram; binding cleared.',
  'error.tg.thread.closed':
    '🔒 Thread {key} is closed — reopen it in your Telegram client, or delete it entirely.',
  'error.tg.perm.delete':
    '🔐 Can\'t delete messages. Grant the bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 Missing `can_manage_topics`. Make me a group admin.',
  'error.state.corrupted':
    '⚠️ state.json was corrupted; bindings reset. Re-run /bind where needed.',
  'error.start_in_general':
    'Can\'t start an agent in General — that\'s a service topic. Open a topical thread.',

  'cb.access_denied': 'Access denied',
  'cb.bind_only_topical': '/bind only works in topical threads',
  'cb.binding_to': 'Binding to {subdir}…',
  'cb.no_active_session': 'No active session',
  'cb.model_error': 'Error: {error}',
  'cb.model_set': 'Model: {model}',
  'cb.model_provider_gone': 'That provider is gone — run /model again',
  'cb.model_hidden': 'Hidden: {provider}',
  'cb.model_shown': 'Shown: {provider}',
  'cb.disconnect_expired': 'This disconnect menu expired — run /disconnect again',
  'cb.not_supported': 'Not supported for {label}',
  'cb.unknown_agent': 'Unknown agent',
  'cb.agent_switched': 'Switched to {label}',
  'cb.resume_only_topical': 'Resume only works in topical threads',
  'cb.bind_folder_first': 'Bind a folder first via /bind',
  'cb.agent_not_running': 'Agent not running',
  'cb.no_pending_question': 'No pending question',
  'cb.connect_method_expired': 'This connect menu expired — run /connect again',
  'cb.invalid_option': 'Invalid option',
  'cb.sent_option': 'Sent: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Error: {error}',
  'cb.claudeMode_already': 'Already active',
  'cb.claudeMode_switching': 'Switching…',
  'claudeMode.pick': '⚙️ Claude Code backend — current: {label}\nPick a backend (switching keeps the same conversation):',
  'claudeMode.not_claude': "This topic isn't on Claude Code — /claude_mode only switches Claude's backend.",
  'claudeMode.already': 'Already {label}.',
  'claudeMode.set_idle': '⚙️ Claude backend: {label} — applies on next start.',
  'claudeMode.switched_resumed': '⚙️ Switched to {label} — same conversation resumed.',
  'claudeMode.switched_fresh': '⚙️ Switched to {label} — started a fresh session.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Error: {error}',
  'cb.toolresults_set': 'Tool results: {mode}',
  'cb.toolresults_error': 'Error: {error}',
  'cb.subagent_set': 'Sub-agents: {mode}',
  'cb.subagent_error': 'Error: {error}',
  'cb.verbosity_set': 'Output verbosity: {mode}',
  'cb.verbosity_error': 'Error: {error}',
  'cb.view_set': 'This topic shows: {view}',

  'session.list_header': 'Sessions to resume ({label}):',
  'session.list_footer': 'Send 1–{max} to resume · 0 to exit',
  'session.none': 'No resumable sessions in this folder.',
  'session.cancelled': 'Cancelled. Session picker closed.',
  'session.invalid': 'Invalid number. Enter a value from 1 to {max}.',
  'session.resumed': 'Session resumed. Send your message:',
  'session.resume_failed': 'Failed to resume session: {error}',
  'session.expired': 'Session list is stale. Run /sessions again.',
  'session.load_failed': 'Failed to load sessions.',

  'resume.context_header': '↩️ Resumed — last {count} messages:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Missed {count} message(s) while the bot was down. Latest from the session:',
  'recap.restartedFallbackHeader': '🔄 Bot restarted. Latest from the session:',
  'recap.stillWorkingLine': '⏳ The agent is still working…',

  'trace.onThisThreadReply': '🔎 Tracing enabled for this thread.',
  'trace.offThisThreadReply': '🔎 Tracing disabled for this thread.',
  'trace.onAllThreadsReply': '🔎 Tracing enabled for ALL threads.',
  'trace.offAllThreadsReply': '🔎 Tracing disabled everywhere (the «all» flag and the thread list are cleared).',
  'trace.statusReply':
    '🔎 Trace — this thread: {thisThread}\nAll threads: {allThreads}\nTraced threads: {count}',
  'trace.statusOnLabel': 'on',
  'trace.statusOffLabel': 'off',
  'trace.usageHint': 'Usage: /trace on | off | on all | off all | (no arg — status)',

  'timestamps.onReply':
    '🕐 Timestamps enabled: every prompt forwarded to the agent gets the send time as its top line (never posted to the topic).',
  'timestamps.offReply': '🕐 Timestamps disabled for this thread.',
  'timestamps.statusOnReply': '🕐 Timestamps: on for this thread.',
  'timestamps.statusOffReply': '🕐 Timestamps: off for this thread.',
  'timestamps.usageHint': 'Usage: /timestamps on | off | (no arg — status)',

  'schedule.fired':
    '⏰ Schedule "{name}" ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — missed at {time}, catching up',
  'schedule.checkFailed':
    '🚨 Check "{name}" failed: {failure} ({schedule}){missedNote}\n$ {command}\n\n{output}\n\nWaking the agent. No more alerts until the check passes again.',
  'schedule.checkRecovered': '✅ Check "{name}" passes again.',
  'schedule.pausedUnbound':
    '⏸ Schedules paused: {count} — the topic was unbound from its folder. /bind will bring them back.',
  'schedule.resumedRebind': '▶️ Schedules resumed: {count} (next run recomputed from now).',
  'schedule.noAgent':
    '⚠️ Nothing scheduled — no agent is running in this topic, so a scheduled run would have nothing to launch. Start /claude or /opencode first.',
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN ENGLISH what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN ENGLISH what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN ENGLISH what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  // A fired reminder LEADS with its own text: this message gets pinned, and the
  // pin's notification previews its first line — the operator must read the
  // reminder itself there, not a header. {schedule} is the LOCALIZED schedule
  // text (`utils/reminderScheduleText`), the same words the list and the card
  // show; {missedNote} is the shared catch-up annotation.
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',

  // Schedule wording — one per descriptor kind. `scheduleRaw` renders a cron
  // shape the wizard cannot create (an agent-made job) verbatim.
  'reminders.scheduleDaily': 'every day at {time}',
  'reminders.scheduleWeekdays': 'weekdays at {time}',
  'reminders.scheduleWeekly': '{weekday} at {time}',
  'reminders.scheduleMonthly': 'day {dayOfMonth} at {time}',
  'reminders.scheduleOnce': '{date} at {time}',
  'reminders.scheduleRaw': 'cron {text}',

  // Next fire instant.
  'reminders.nextRunToday': 'today at {time}',
  'reminders.nextRunTomorrow': 'tomorrow at {time}',
  'reminders.nextRunOnDate': '{date} at {time}',
  'reminders.nextRunNone': '—',

  // Hub screen.
  'reminders.hubTitle': '🔔 Reminders',
  'reminders.hubEmptyLine': 'No reminders yet.',
  'reminders.hubActiveLine': 'Active: {count}',
  'reminders.hubLimitLine':
    'Active: {count} — the limit of {limit} is reached. Delete one to add another.',
  'reminders.addButton': '➕ Add',
  'reminders.listButton': '📋 List ({count})',
  'reminders.closeButton': '✕ Close',
  'reminders.closedNotice': '🔔 Reminders closed.',

  // List screen.
  'reminders.listTitle': '📋 Reminders ({count})',
  'reminders.listPageLine': 'Page {page} of {total}',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ Prev',
  'reminders.listNextButton': 'Next ›',
  'reminders.listBackToHubButton': '‹ Back',

  // Card + created screen.
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'When: {schedule}',
  'reminders.cardText': 'Text: "{text}"',
  'reminders.cardNext': 'Next: {next}',
  'reminders.cardDeleteButton': '🗑 Delete',
  'reminders.cardBackToListButton': '‹ To list',
  'reminders.createdTitle': '✅ Reminder created',
  'reminders.doneListButton': '📋 List',

  // Add wizard — title, the running summary of what is already picked, and the
  // per-step question.
  'reminders.wizardTitle': '🔔 New reminder',
  'reminders.pickRepeat': 'Repeat: {value}',
  'reminders.pickDate': 'Date: {value}',
  'reminders.pickWeekday': 'Weekday: {value}',
  'reminders.pickDayOfMonth': 'Day of month: {value}',
  'reminders.pickTime': 'Time: {value}',
  // Shown only when a `once` instant went by while the operator was typing: it
  // proves the text they sent was KEPT, so they pick a new time instead of
  // retyping it (a retyped message is no longer captured and reaches the agent).
  'reminders.pickText': 'Text: "{value}"',
  'reminders.stepRepeatQuestion': 'STEP 1/4 · How often?',
  'reminders.stepDateQuestion': 'STEP 2/4 · Which day?',
  'reminders.stepDateGridQuestion': 'STEP 2/4 · Pick a date:',
  'reminders.stepWeekdayQuestion': 'STEP 2/4 · Which weekday?',
  'reminders.stepDayOfMonthQuestion': 'STEP 2/4 · Which day of the month?',
  'reminders.stepDayOfMonthGridQuestion': 'STEP 2/4 · Pick a day of the month:',
  'reminders.stepTimeQuestion': 'STEP 3/4 · At what time?',
  'reminders.stepHourQuestion': 'STEP 3/4 · Pick the hour:',
  'reminders.stepMinuteQuestion': 'STEP 3/4 · {hour}:__ — pick the minutes:',
  'reminders.stepTextQuestion':
    'STEP 4/4 · Send the reminder text — type it or record a voice note.',
  'reminders.repeatOnceButton': 'Once',
  'reminders.repeatDailyButton': 'Every day',
  'reminders.repeatWeekdaysButton': 'Weekdays',
  'reminders.repeatWeeklyButton': 'Weekly',
  'reminders.repeatMonthlyButton': 'Monthly',
  'reminders.dateTodayButton': 'Today',
  'reminders.dateTomorrowButton': 'Tomorrow',
  'reminders.dateOtherButton': '✏️ Other…',
  'reminders.dayOfMonthOtherButton': '✏️ Other…',
  'reminders.timeOtherButton': '🕐 Other time',
  'reminders.backButton': '‹ Back',
  'reminders.cancelButton': '✕ Cancel',
  'reminders.weekdayMondayButton': 'Mon',
  'reminders.weekdayTuesdayButton': 'Tue',
  'reminders.weekdayWednesdayButton': 'Wed',
  'reminders.weekdayThursdayButton': 'Thu',
  'reminders.weekdayFridayButton': 'Fri',
  'reminders.weekdaySaturdayButton': 'Sat',
  'reminders.weekdaySundayButton': 'Sun',

  // Wizard outcomes. A past instant is REPORTED on the time screen, never rolled
  // forward a day — a silent roll reminds the operator 24h off what they asked.
  'reminders.errorPastTime':
    '⚠️ That time has already passed. Pick a later time, or go back and change the day.',
  'reminders.errorInvalidDate': '⚠️ That date does not exist. Pick another one.',
  // A valid date whose wall clock is skipped by a daylight-saving jump — the DATE is
  // fine, so the operator is sent back to the time, never to the day.
  'reminders.errorInvalidTime': '⚠️ That time does not exist on that day — the clocks change. Pick another time.',
  // The text is REJECTED, never shortened: it is the operator's own wording, so the
  // limit is stated and they send a shorter one.
  'reminders.errorTextTooLong':
    '⚠️ That text is too long ({limit} characters max) and was NOT saved. Send a shorter one.',
  'reminders.cancelledNotice': '✕ Cancelled',
  'reminders.expiredNotice': '✕ Expired — the reminder text never arrived.',
  'reminders.capReachedNotice':
    '⚠️ This topic already has {limit} reminders — delete one before adding another.',

  // Callback-query answers (the little toast on a tap).
  'reminders.wizardExpiredCbAnswer': 'This wizard is out of date — run /reminders again.',
  'reminders.deletedCbAnswer': '🗑 Deleted',
  'reminders.deleteGoneCbAnswer': 'Already deleted.',
  'reminders.cardExpiredCbAnswer': 'That reminder is gone.',

  'apiRetry.transientNotice':
    '⏳ API rate-limited — auto-retrying in {minutes} min (attempt {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Usage limit reached — retrying in {minutes} min (attempt {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Usage limit reached — will auto-resume after reset (~{time}).',
  'apiRetry.resuming': '↻ Resuming…',
  'apiRetry.limitResetResuming':
    '✅ The limit window has reset — resuming work in this topic.',
  'apiRetry.giveUp':
    "⚠️ Couldn't resume after {attempts} attempts. Message me when to continue.",
  'apiRetry.continueNudge': 'Continue from where you left off.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude is logged out — run /login to continue.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: invalid credentials — restart the opencode server.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Ready — I can handle messages in bot threads and group topics.',
  'startup.header_not_ready':
    '⚠️ Setup incomplete. To start working with me, please finish these steps:',
  'startup.item.create_group':
    'Create a forum supergroup with Topics enabled, then send me a message there to pair it.',
  'startup.item.grant_admin':
    'Make me an admin with these rights: {missing}.',
  'startup.item.bind_topic':
    'Create a topic and bind it to a folder with /bind.',
  'startup.item.install_agent':
    'Install an agent CLI — claude or opencode.',
  'startup.item.optional_groq':
    '(optional) Add GROQ_API_KEY to your .env and restart to enable voice input.',
  'startup.item.optional_owner':
    '(optional) Set OWNER_USER_ID to receive this status in your private chat.',
  'requests.alert.notAnsweringNotice': '⚠️ Request {requestId} got no answer: the agent ended its turns without answering and the reminders gave up. Check the session in this topic.',
  'requests.alert.unreachableNotice': "⚠️ Request {requestId} got no answer: the agent's session could not be reached to remind it. Check the session in this topic.",
  'requests.limit.answerAfterResetNotice': '🚧 Usage limit reached — the answer will come after {time}.',
  'requests.limit.answerNextAttemptNotice': '🚧 Usage limit reached — next attempt at {time}.',
  'requests.limit.answerAutoResumeOffNotice': '🚧 Usage limit reached. Automatic resume is off, so the work waits until the operator resumes it.',
};
