// Machine-translated from en. Native review welcome.

export const zhDict: Record<string, string> = {
  'access.denied': '访问被拒绝。',
  'access.group_only': '我只在配置的论坛超级群组中工作。',

  'thread.no_binding':
    '📁 该话题未绑定文件夹。使用 /bind <subdir> 或从列表中选择。',
  'thread.bind_required':
    '📁 请先绑定文件夹：/bind <subdir>。代理仅在已绑定的文件夹中运行。',
  'thread.bound': '📁 已绑定到 `{subdir}`。\n运行 /claude 或 /opencode。',
  'thread.unbound': '📁 绑定已解除。',
  'thread.general_no_agent':
    'General 未绑定文件夹 — 切换到主题话题与代理对话。',
  'thread.welcome_bound':
    '👋 话题已创建并自动绑定到 `{subdir}`（话题名匹配了子文件夹）。\n运行 /claude 或 /opencode。',
  'thread.welcome_pick':
    '👋 话题已创建。绑定文件夹：/bind <subdir>，或从下方列表选择。',
  'thread.bind_collision':
    '⚠️ 文件夹 `{subdir}` 已被以下话题使用：{threads}。\n绑定已添加；会话保持独立（各自的 tmux/SSE）。',
  'thread.no_agent_with_binding':
    '📁 文件夹 `{subdir}` 已绑定。运行 /claude 或 /opencode 开始对话。',

  'bind.usage': '用法：/bind <subdir>\n示例：/bind overview',
  'bind.current': '📂 当前绑定：`{subdir}`',
  'bind.current_none': '📂 尚未绑定',
  'bind.in_general': '/bind 仅在主题话题中有效，不在 General 中。',
  'bind.invalid_chars': '❌ 文件夹名不得包含控制字符。',
  'bind.not_found': '❌ 在 `WORK_ROOT` (`{workRoot}`) 下未找到文件夹 `{subdir}`。',
  'bind.outside_root': '❌ 路径超出 `WORK_ROOT`。',
  'bind.not_directory': '❌ `{subdir}` 存在，但不是文件夹。',

  'bind.leave_button': '⬅️ 离开当前目录',
  'bind.create_button': '➕ 创建新文件夹',
  'bind.create_prompt':
    '✏️ 发送新文件夹名称（将在 `WORK_ROOT` 下创建）。任何命令都会取消。',
  'bind.create_cb': '正在创建新文件夹…',
  'bind.create_empty': '❌ 名称为空。请发送文件夹名称。',
  'bind.create_separator': '❌ 名称不得包含 `/` 或 `\\`。请发送简单名称。',
  'bind.create_dot_segment': '❌ `.` 和 `..` 不能用作文件夹名。',
  'bind.create_hidden': '❌ 名称不得以点开头。',
  'bind.create_invalid_chars': '❌ 文件夹名不得包含控制字符。',
  'bind.create_exists': '📁 文件夹 `{subdir}` 已存在 — 正在绑定。',
  'bind.create_failed': '❌ 创建文件夹失败：{error}',

  'ls.header': '📁 `{workRoot}` 的子文件夹：',
  'ls.empty': '📁 `WORK_ROOT` 下没有可绑定的子文件夹。',
  'list.header': '🧵 话题绑定（{count}）：',
  'list.empty': '🧵 暂无绑定。创建话题并运行 /bind。',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new 在已绑定的话题内使用 — 打开话题并运行 /new 以重启其代理会话。',

  'help.general':
    '*General 中的命令：*\n' +
    '/ls — 列出 `WORK_ROOT` 子文件夹\n' +
    '/list — 列出话题\n' +
    '/status — 所有话题的状态\n' +
    '/quitall — 退出所有运行中的代理\n' +
    '/whoami /version — 调试\n\n' +
    '要与代理对话 — 打开一个主题话题。',
  'help.thread_unbound':
    '*话题未绑定文件夹。*\n' +
    '/bind <subdir> — 绑定（或从列表选择）\n' +
    '/ls — `WORK_ROOT` 子文件夹（在 General 中）',
  'help.thread_bound':
    '*话题已绑定到 `{subdir}`。*\n' +
    '/claude /opencode — 启动代理\n' +
    '/connect — 连接 OpenCode provider API key（默认 OpenAI）\n' +
    '/disconnect — 删除某个 provider 已保存的凭据\n' +
    '/terminal — 在此文件夹中打开 shell\n' +
    '/new — 重启会话（旧的 → /sessions）\n' +
    '/model /sessions — 切换\n' +
    '/effort — reasoning effort 级别\n' +
    '/verbosity — 输出详细度（thinking/tools/子代理）\n' +
    '/quit /status /output — 控制\n' +
    '/compact — 压缩代理上下文\n' +
    '/compact_on_idle — 空闲后自动压缩（开关）\n' +
    '/auto_continue_limits — 达到用量上限后自动继续（开关）\n' +
    '/clear — 删除话题消息\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI 按键（Claude）\n' +
    '/bind — 管理绑定',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot 是群组管理员',
  'doctor.can_manage_topics': '`can_manage_topics` 已授予',
  'doctor.can_delete_messages': '`can_delete_messages` 已授予',
  'doctor.can_pin_messages': '`can_pin_messages` 已授予',
  'doctor.privacy_off': 'Privacy mode 已禁用',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable，然后移除并重新添加 bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`：`{workRoot}`（{count} 个子文件夹）',
  'doctor.datadir_path': '`DATA_DIR`：`{dataDir}`',
  'doctor.claude_installed': 'claude CLI 已安装',
  'doctor.opencode_installed': 'opencode CLI 已安装',
  'doctor.state_valid':
    'state.json 有效（{bindings} 个绑定，{active} 个活跃）',
  'doctor.state_archived':
    '之前的 state.json 已损坏，归档：{path}',
  'doctor.cli_missing':
    '在 PATH 中未找到（自动安装将在 /claude 或 /opencode 时运行）',
  'doctor.no_admin_info':
    '无法读取 bot 权限 — getChatMember 失败',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    '就绪清单：\n' +
    '1️⃣ 将我设为群组管理员，权限包括：\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable，然后移除并重新添加我\n' +
    '3️⃣ 运行 /doctor 查看缺少什么\n' +
    '4️⃣ 在每个主题话题中运行 /bind <subdir> 并启动代理\n\n' +
    '`WORK_ROOT`：`{workRoot}`',

  'binding.welcome.header': '📁 已绑定到 `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} 个服务器',
  'binding.welcome.git': '• git: 分支 `{branch}`{detail}',
  'binding.welcome.git_clean': ', 干净',
  'binding.welcome.git_dirty': ', 有未提交的更改',
  'binding.welcome.git_none': '• git: 未初始化',
  'binding.welcome.start_prompt': '开始对话：',

  'mcp.header': '🔌 *此话题的 MCP 服务器：*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 未配置 MCP 服务器。',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': '话题的置顶状态（Stage 7）将不可用',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '（无绑定）',

  'pair.success': '✅ 群组已配对。id: `{groupId}`。Bot 现在为此超级群组服务。',
  'pair.locked':
    'ℹ️ 群组 id 通过 `ALLOWED_GROUP_ID` 设置 — 自动配对已禁用。 ' +
    '要切换群组，请更改变量并重启 bot。',
  'pair.only_forum': '❌ /pair 仅在论坛超级群组中有效（启用 Topics）。',
  'pair.not_admin': '❌ 只有群组管理员或创建者才能配对 bot。',
  'pair.not_paired': '群组尚未配对（配对模式）',
  'pair.dm': "ℹ️ DM 模式下不需要 /pair — bot 服务于你的私聊。",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '（不可用）',
  'status.global_header': '📊 *所有话题*（{total}）：',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 暂无话题。',
  'status.thread_report': '状态：\n\n代理：{agent}\n文件夹：{subdir}\n会话：{session}',
  'status.thread_model': '模型：{model}',
  'status.thread_effort': '推理强度：{effort}',
  'status.thread_started': '启动时间：{started}',
  'status.thread_running': '运行中',
  'status.thread_stopped': '已停止',
  'status.thread_no_agent': '无（启动 /claude 或 /opencode）',
  'status.thread_no_binding': '（无绑定 — WORK_ROOT）',
  'status.thread_workdir': '工作目录：{workDir}',
  'status.thread_runtime_version': '运行版本：{version}',
  'status.thread_context': '上下文：{used} / {limit} 个 token',
  'language.status': '🌐 语言：{display}',
  'language.set_success': '✅ 此聊天的语言已设为 `{locale}`。',
  'language.auto_success': '✅ 语言已重置为自动。当前：{display}。',
  'language.invalid': '⚠️ 不支持 locale `{locale}`。可用：{locales}。',

  'timezone.status': '🌍 时区：{zone} — 当前 {now}',
  'timezone.usage':
    '用法：/timezone <IANA 时区>  ·  /timezone +04:00  ·  /timezone auto\n或直接发送 /timezone（不带参数）从列表中选择。',
  'timezone.set_success': '✅ 时区：{zone} — 当前 {now}\n已重新计算的计划任务：{count}',
  'timezone.auto_success':
    '✅ 时区已重置为主机时区：{zone} — 当前 {now}\n已重新计算的计划任务：{count}',
  'timezone.invalid':
    '⚠️ 未知时区 `{zone}`。请使用 IANA 名称（如 `Europe/Moscow`）或固定偏移（如 `+04:00`）。发送 /timezone 可从列表中选择。',
  'timezone.offset_unsupported':
    '⚠️ 偏移 `{zone}` 无法生效——只有整小时偏移可用。请改用所在时区的 IANA 名称（例如 +05:30 对应 `Asia/Kolkata`）。',
  'timezone.fixed_offset_warning':
    '⚠️ 固定偏移不跟随夏令时——半年内会相差一小时。',
  'timezone.picker_regions': '🌍 时区：{zone}\n当前：{now}\n\n请选择区域：',
  'timezone.picker_zones': '🌍 {region} — 第 {page}/{total} 页',
  'timezone.picker_expired': '该列表已过期——请重新发送 /timezone。',

  'agent.ready': '{label} 已就绪，在 `{subdir}`{argsSuffix}\n{infoBlock}发送消息：',
  'agent.ready_model': '🧠 模型：{model}',
  'agent.no_session': '没有运行中的代理。运行 /claude 或 /opencode 启动。',
  'agent.session_ended': '{label}：会话已结束',
  'agent.stopped': '{label} 已停止',
  'agent.exit_signal_sent': '已发送两次 Ctrl+C — {label} 正在退出',
  'agent.already_active': '{label} 已在此运行。发送消息或 /quit。',
  'agent.starting': '正在 `{subdir}` 中启动 {label}…',
  'agent.queued_starting': '⏳ {label} 仍在启动中 — 你的消息已排队，就绪后发送。',
  'agent.question_hint': 'ℹ️ 回复选项编号（如 1）或 y/n。还有：/up /down 移动，/enter 确认，/c 取消。',
  'agent.start_failed': '启动 {label} 失败：{error}',
  'agent.no_response': '⚠️ 智能体已接收你的请求但一直没有开始回复——会话可能已卡住。请重新发送，或用 /new 开启新会话。',
  'agent.session_restarting': '⚠️ 智能体没有响应——会话似乎卡住了。正在重启并重新执行你的请求…',
  'agent.session_recovering': '⚠️ 智能体没有响应——正在恢复（保留你的对话）并重新执行你的请求…',
  'agent.question_cancelled_for_prompt': '⚠️ 上一个问题已取消 — 正在执行你的新请求。',
  'agent.question_cancelled_msg_label': '❌ 问题已取消：{header}',
  'agent.login_code_relayed': '🔐 登录码已转发给 Claude — 包含 token 的消息已从历史中删除。',
  'agent.login_url': '🔐 要登录 Claude，请打开此链接，完成登录，然后把代码粘贴回这里：\n{url}',
  'agent.login_success': '✅ 已登录 Claude。',
  'agent.login_failed': '⚠️ Claude 登录失败。运行 /login 重试。',
  'agent.workingIndicator': '{glyph} 工作中…',
  'terminal.ready': '🖥 终端已就绪，在 `{subdir}`{argsSuffix}\n每条消息作为命令执行。/c — Ctrl+C，/up /down — 历史，/tab — 补全，/quit — 关闭。',

  'effort.choose': '⚙️ 当前 effort: {current}\n选择级别：',
  'effort.current_none': '未设置',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort：{effort}\n运行 /effort 可更改',
  'effort.invalid_level': '⚠️ 级别 `{level}` 无效。可用：{valid}。',
  'effort.not_available': 'ℹ️ 当前模型没有可用的 reasoning effort 级别。',
  'effort.not_supported': 'ℹ️ 模型 `{model}` 没有 reasoning effort 级别。',
  'effort.start_agent_first': 'ℹ️ 级别已保存。没有运行中的代理 — 下次启动时应用。',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` 已清除：新模型 `{model}` 不支持它。',
  'effort.unsupported_backend': '{label} 不支持 effort 控制。',
  'effort.no_session': '没有运行中的代理。用 /claude 或 /opencode 启动。',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 思考了 {seconds} 秒',
  'thinking.choose': '☁️ 当前 thinking 模式: {current}\n选择模式：',
  'thinking.set_success': '✅ Thinking 模式: {mode}',
  'thinking.invalid_mode': '⚠️ 模式 `{mode}` 无效。可用：{valid}。',
  'thinking.mode.minimal': '最简',
  'thinking.mode.short': '简短',
  'thinking.mode.full': '完整',

  'toolResults.choose': '🔧 当前工具结果模式: {current}\n选择模式：',
  'toolResults.set_success': '✅ 工具结果模式: {mode}',
  'toolResults.invalid_mode': '⚠️ 模式 `{mode}` 无效。可用：{valid}。',
  'toolResults.mode.minimal': '最简',
  'toolResults.mode.short': '简短',
  'toolResults.mode.full': '完整',
  'toolResults.truncated_footer': '…（已截断，/tool_results full）',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': '工具',

  'subagent.status_elapsed': '🤖 子代理: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 子代理工作中 …',
  'subagent.delegating_status': '🤖 委派中: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': '子代理',
  'subagent.choose': '🤖 当前子代理模式: {current}\n选择模式：',
  'subagent.set_success': '✅ 子代理模式: {mode}',
  'subagent.invalid_mode': '⚠️ 模式 `{mode}` 无效。可用：{valid}。',
  'subagent.mode.minimal': '最简',
  'subagent.mode.short': '简短',
  'subagent.mode.full': '完整',

  'verbosity.choose': '🔊 当前输出详细度: {current}\n选择级别：',
  'verbosity.set_success': '✅ 输出详细度: {mode}（thinking、工具结果、子代理）',
  'verbosity.invalid_mode': '⚠️ 模式 `{mode}` 无效。可用：{valid}。',
  'verbosity.custom': '自定义（thinking: {thinking} · 工具: {toolResults} · 子代理: {subagent}）',
  'verbosity.mode.minimal': '最简',
  'verbosity.mode.short': '简短',
  'verbosity.mode.full': '完整',

  'model.set_success': '🧠 模型已设为：{model}',
  'model.saved_for_next_start': '模型已保存：{model} — 下次代理启动时应用。',
  'model.start_agent_first': '没有活跃会话。请先启动代理。',
  'model.current_default': '默认',
  'model.none_available': '🧠 当前：{current}\n\n没有可用模型。请用 /model <provider/model> 手动指定。',
  'model.invalid_number': '❌ 编号无效。运行 /model 查看列表。',
  'model.pick_provider': '🧠 当前：{current}\n\n选择一个提供商：',
  'model.all_hidden': '🧠 当前：{current}\n\n所有提供商都已隐藏。点击 👁 恢复其中一个。',
  'model.hidden_header': '🙈 已从此列表隐藏 — 点击 👁 恢复。',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ 提供商',
  'model.prev_button': '⬅️ 上一页',
  'model.next_button': '下一页 ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} 个模型 · 第 {page}/{totalPages} 页\n当前：{current}',
  'model.page_hint': '回复编号即可选择，或用 /model <名称> 搜索。',
  'model.page_hint_buttons_only': '点击模型即可切换，或用 /model <名称> 搜索。',

  'disconnect.unsupported_backend': '此构建不支持断开 OpenCode provider 连接。',
  'disconnect.invalid_provider': '❌ 提供商 id 无效：{provider}。示例：/disconnect openrouter',
  'disconnect.no_providers': '没有可断开的提供商。',
  'disconnect.pick_provider': '选择要断开的提供商 — 其已保存的凭据将被删除：',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ 已断开提供商 {provider} — 已保存的凭据已删除。',
  'disconnect.still_active_env': '⚠️ {provider} 的已保存凭据已删除，但它仍处于启用状态：OpenCode 通过环境变量启用它。请取消该变量并重启 OpenCode，或通过 /model 将其从列表中隐藏。',
  'disconnect.failed': '⚠️ 断开 {provider} 失败：{reason}',

  'rename_session.usage': '用法：/rename_session <新标题>',
  'rename_session.start_agent_first': '没有活跃会话。请先启动代理（/claude 或 /opencode）。',
  'rename_session.unsupported_backend': '{label} 不支持会话重命名。',
  'rename_session.success': '✅ 会话已重命名：{title}',
  'rename_session.failed': '⚠️ 重命名会话失败：{reason}',

  'compact.started': '🧹 正在压缩会话上下文 — 代理将基于摘要继续。',
  'compact.done': '✅ 上下文已压缩。',
  'compact.done_tokens': '✅ 上下文已压缩：{pre} → {post} tokens。',
  'compact.summaryHeader': '📄 压缩摘要：',
  'compact.start_agent_first': '没有活跃会话。请先启动代理（/claude 或 /opencode）。',
  'compact.unsupported_backend': '{label} 不支持压缩上下文。',
  'compact.model_unresolved': '⚠️ 无法压缩：此会话未解析出模型。请用 /model 选择一个后重试。',
  'compact.failed': '⚠️ 压缩会话上下文失败：{reason}',
  'compact.busy': '⚠️ 代理正忙——请在当前回合结束后再次运行 /compact。',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN CHINESE: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 空闲时已自动压缩，借助缓存节省 token。\n运行 /compact_on_idle 可关闭。',
  'compactOnIdle.on': '开',
  'compactOnIdle.off': '关',
  'compactOnIdle.title': '🧹 本话题的空闲自动压缩：{state}\n\n当会话空闲约 55 分钟时，会自动压缩其上下文以节省 token（此时提示缓存仍是热的）。\n\n要一次性切换所有话题，请在 General 话题中运行此命令。',
  'compactOnIdle.titleGeneral': '🧹 空闲自动压缩——所有话题的默认值：{state}\n\n当会话空闲约 55 分钟时，会自动压缩其上下文以节省 token。\n\n每个话题仍可用自己的 /compact_on_idle 覆盖此设置。',
  'compactOnIdle.enableButton': '启用',
  'compactOnIdle.disableButton': '停用',
  'compactOnIdle.setThisTopic': '✅ 空闲自动压缩：本话题 {state}。',
  'compactOnIdle.setGlobal': '✅ 空闲自动压缩：所有话题 {state}（各话题的覆盖设置仍然有效）。',
  'compactOnIdle.unsupported': '空闲自动压缩适用于活动的代理会话。请先在已绑定的话题中启动 /claude 或 /opencode。',
  'compactOnIdle.pendingQuestionReask': '❓ 你还有一个待回答的问题。点击一个选项来回答并继续：',

  'autoContinueLimits.on': '开',
  'autoContinueLimits.off': '关',
  'autoContinueLimits.title': '🚧 本话题达到用量上限后自动继续：{state}\n\n当智能体触及用量或会话上限时，机器人会等到窗口重置，然后自行让智能体继续（继续的消息会被置顶，因此静音话题也会通知你）。\n\n要一次性切换所有话题，请在 General 话题中运行此命令。',
  'autoContinueLimits.titleGeneral': '🚧 达到用量上限后自动继续——所有话题的默认值：{state}\n\n当智能体触及用量或会话上限时，机器人会等到窗口重置，然后自行让智能体继续。\n\n每个话题仍可用自己的 /auto_continue_limits 覆盖此设置。',
  'autoContinueLimits.enableButton': '启用',
  'autoContinueLimits.disableButton': '停用',
  'autoContinueLimits.skipButton': '⏭ 跳过一次',
  'autoContinueLimits.skipDone': '已跳过本次继续。',
  'autoContinueLimits.skipExpired': '没有可跳过的内容——本次等待已结束。',
  'autoContinueLimits.skippedNotice': '⏭ 已跳过：本次我不会自行继续。请告诉我何时继续——本话题的自动继续仍然开启。',
  'autoContinueLimits.noticeHint': '运行 /auto_continue_limits 可跳过这一次继续，或关闭本话题的自动继续。',
  'autoContinueLimits.setThisTopic': '✅ 达到用量上限后自动继续：本话题 {state}。',
  'autoContinueLimits.setGlobal': '✅ 达到用量上限后自动继续：所有话题 {state}（各话题的覆盖设置仍然有效）。',
  'autoContinueLimits.limitReachedDisabled': '🚧 已达到用量上限。本话题的自动继续已关闭，所以我会等待——请告诉我何时继续（若要自动恢复，请运行 /auto_continue_limits on）。',

  'connect.prompt_key': '🔑 在下一条消息中发送 `{provider}` 的 API key。我会从历史中删除包含 key 的消息。',
  'connect.empty_key': '❌ API key 为空。请在下一条消息中发送 key。',
  'connect.invalid_key': '❌ 这看起来不像 API key（包含空格或非拉丁字符）。请在下一条消息中仅发送 key，或重新运行 /connect。',
  'connect.invalid_provider': '❌ 无效的 provider id `{provider}`。示例：/connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` 不支持通过此流程的简单 API key 登录。请为此 provider 使用 OpenCode UI/CLI。',
  'connect.unsupported_backend': '此构建中不可用 OpenCode provider 认证。',
  'connect.failed': '⚠️ 连接 `{provider}` 失败：{reason}',
  'connect.success': '✅ Provider `{provider}` 已连接。OpenCode 服务器未重启。',
  'connect.cancelled': 'API key 输入已取消。',
  'connect.pick_method': '如何连接 `{provider}`？选择一种方式：',
  'connect.no_methods': '⚠️ 未找到 `{provider}` 的认证方式。',
  'connect.oauth_device': '🔓 连接 `{provider}`：打开 {url} 并输入代码 `{code}`，然后授权。在服务器上请使用 *headless* 方式。完成后我会在这里确认。',
  'connect.oauth_url_only': '🔓 连接 `{provider}`：打开 {url} 并完成登录。完成后我会在这里确认。',
  'connect.oauth_paste': '🔑 授权后，将代码作为下一条消息粘贴到这里 — 我会从历史中删除它。',
  'connect.oauth_waiting': '⏳ 等待授权…',
  'connect.oauth_loopback': '🔑 授权后，你的浏览器会尝试打开一个无法加载的 `localhost` 页面——这在这里是正常的。请从地址栏复制该 URL 并作为下一条消息粘贴回来（或仅粘贴 `code` 值）。我会将其从历史记录中删除并完成登录。',
  'connect.oauth_invalid_reply': '❌ 这看起来既不像回调 URL，也不像授权码。授权后，请从浏览器粘贴 `localhost` 回调 URL（或 `code` 值）。',
  'connect.oauth_callback_no_flow': '⚠️ 这看起来像是一个 OAuth 回调 URL，但这里当前没有正在进行的登录——我已将其删除。请运行 /connect 重新开始。',
  'connect.oauth_success': '✅ `{provider}` 已通过 OAuth 连接。OpenCode 服务器凭据已重新加载。',
  'connect.oauth_failed': '⚠️ `{provider}` 的 OAuth 登录未完成。请再次运行 /connect。',
  'quit_all.none_active': '没有运行中的代理 — 无需停止。',
  'quit_all.summary': '🚪 已停止 {stopped}/{total} 个活跃代理。',
  'quit_all.general_only': '`/quit-all` 仅在 General 话题中可用。',

  'clearMessages.summary':
    '🗑 已删除 {deleted}/{total} 条消息。 ' +
    'Telegram 拒绝删除超过 48 小时的消息 — 其余留在历史中。',
  'clearMessages.no_messages': '此话题中没有可删除的消息。',

  'edited.hint':
    '✏️ 我不将编辑的消息视为新输入 — 请将更正作为单独消息发送。',

  'voice.no_api_key':
    '语音需要 `GROQ_API_KEY`（免费）或 `OPENAI_API_KEY`。',
  'voice.failed': '语音转录失败。',
  'voice.retrying': '⚠️ 语音转录失败（{error}）。{seconds} 秒后重试…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 文件超过 Bot API 限制（{cap} MB） — 我无法下载。请发送较小的文件。',
  'file.download_failed': '📎 下载文件失败。请重试。',

  'error.workdir.gone':
    '📁 文件夹 `{subdir}` 已从磁盘消失。运行 /bind <newdir>。',
  'error.tg.thread.deleted':
    '⚠️ 话题已在 Telegram 中删除；绑定已清除。',
  'error.tg.thread.closed':
    '🔒 话题 {key} 已关闭 — 在 Telegram 客户端中重新打开，或完全删除。',
  'error.tg.perm.delete':
    '🔐 无法删除消息。请授予 bot `can_delete_messages`。',
  'error.tg.perm.manage_topics':
    '🔐 缺少 `can_manage_topics`。请将我设为群组管理员。',
  'error.state.corrupted':
    '⚠️ state.json 已损坏；绑定已重置。在需要的地方重新运行 /bind。',
  'error.start_in_general':
    '不能在 General 中启动代理 — 那是服务话题。请打开主题话题。',

  'cb.access_denied': '访问被拒绝',
  'cb.bind_only_topical': '/bind 仅在主题话题中有效',
  'cb.binding_to': '正在绑定到 {subdir}…',
  'cb.no_active_session': '没有活跃会话',
  'cb.model_error': '错误：{error}',
  'cb.model_set': '模型：{model}',
  'cb.model_provider_gone': '该提供商已不存在 — 请重新运行 /model',
  'cb.model_hidden': '已隐藏：{provider}',
  'cb.model_shown': '已显示：{provider}',
  'cb.disconnect_expired': '此断开菜单已过期 — 请重新运行 /disconnect',
  'cb.not_supported': '{label} 不支持',
  'cb.unknown_agent': '未知代理',
  'cb.agent_switched': '已切换到 {label}',
  'cb.resume_only_topical': 'Resume 仅在主题话题中有效',
  'cb.bind_folder_first': '请先通过 /bind 绑定文件夹',
  'cb.agent_not_running': '代理未运行',
  'cb.no_pending_question': '没有待处理问题',
  'cb.connect_method_expired': '此连接菜单已过期 — 请再次运行 /connect',
  'cb.invalid_option': '无效选项',
  'cb.sent_option': '已发送：{option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': '错误：{error}',
  'cb.claudeMode_already': '已激活',
  'cb.claudeMode_switching': '切换中…',
  'claudeMode.pick': '⚙️ Claude Code 后端 — 当前: {label}\n选择后端（切换保持同一对话）：',
  'claudeMode.not_claude': "此话题不在 Claude Code 上 — /claude_mode 仅切换 Claude 的后端。",
  'claudeMode.already': '已是 {label}。',
  'claudeMode.set_idle': '⚙️ Claude 后端: {label} — 下次启动时应用。',
  'claudeMode.switched_resumed': '⚙️ 已切换到 {label} — 同一对话已恢复。',
  'claudeMode.switched_fresh': '⚙️ 已切换到 {label} — 已开始新会话。',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': '错误：{error}',
  'cb.toolresults_set': '工具结果: {mode}',
  'cb.toolresults_error': '错误：{error}',
  'cb.subagent_set': '子代理: {mode}',
  'cb.subagent_error': '错误：{error}',
  'cb.verbosity_set': '输出详细度: {mode}',
  'cb.verbosity_error': '错误：{error}',

  'session.list_header': '可恢复的会话（{label}）：',
  'session.list_footer': '发送 1–{max} 恢复 · 0 退出',
  'session.none': '此文件夹中没有可恢复的会话。',
  'session.cancelled': '已取消。会话选择器已关闭。',
  'session.invalid': '无效编号。请输入 1 到 {max} 之间的值。',
  'session.resumed': '会话已恢复。发送你的消息：',
  'session.resume_failed': '恢复会话失败：{error}',
  'session.expired': '会话列表已过期。请重新运行 /sessions。',
  'session.load_failed': '加载会话失败。',

  'resume.context_header': '↩️ 已恢复 — 最近 {count} 条消息：',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot 离线期间错过了 {count} 条消息。会话最新消息：',
  'recap.restartedFallbackHeader': '🔄 Bot 已重启。会话最新消息：',
  'recap.stillWorkingLine': '⏳ 代理仍在工作…',

  'trace.onThisThreadReply': '🔎 已为此话题启用追踪。',
  'trace.offThisThreadReply': '🔎 已为此话题禁用追踪。',
  'trace.onAllThreadsReply': '🔎 已为所有话题启用追踪。',
  'trace.offAllThreadsReply': '🔎 已在所有地方禁用追踪（«all» 标志和话题列表已清除）。',
  'trace.statusReply':
    '🔎 Trace — 此话题: {thisThread}\n所有话题: {allThreads}\n追踪的话题: {count}',
  'trace.statusOnLabel': '开',
  'trace.statusOffLabel': '关',
  'trace.usageHint': '用法：/trace on | off | on all | off all |（无参数 — 状态）',

  'timestamps.onReply':
    '🕐 时间戳已启用：每个转发给代理的 prompt 会将发送时间作为第一行（从不在话题中发布）。',
  'timestamps.offReply': '🕐 已为此话题禁用时间戳。',
  'timestamps.statusOnReply': '🕐 时间戳：此话题已开启。',
  'timestamps.statusOffReply': '🕐 时间戳：此话题已关闭。',
  'timestamps.usageHint': '用法：/timestamps on | off |（无参数 — 状态）',

  'schedule.fired':
    '⏰ 定时任务「{name}」({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — 在 {time} 错过，正在追赶',
  'schedule.pausedUnbound':
    '⏸ 已暂停的定时任务: {count} — 话题已从文件夹解绑。/bind 将恢复它们。',
  'schedule.resumedRebind': '▶️ 已恢复的定时任务: {count}（下次运行从现在重新计算）。',
  'schedule.noAgent':
    '⚠️ 未创建任何计划 — 此话题中没有运行中的代理，因此计划运行将无内容可启动。请先启动 /claude 或 /opencode。',
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN CHINESE what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN CHINESE what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN CHINESE what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': '每天 {time}',
  'reminders.scheduleWeekdays': '工作日 {time}',
  'reminders.scheduleWeekly': '每{weekday} {time}',
  'reminders.scheduleMonthly': '每月 {dayOfMonth} 日 {time}',
  'reminders.scheduleOnce': '{date} {time}',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': '今天 {time}',
  'reminders.nextRunTomorrow': '明天 {time}',
  'reminders.nextRunOnDate': '{date} {time}',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 提醒',
  'reminders.hubEmptyLine': '还没有提醒。',
  'reminders.hubActiveLine': '活动中：{count}',
  'reminders.hubLimitLine': '活动中：{count} — 已达到 {limit} 条的上限。删除一条才能再添加。',
  'reminders.addButton': '➕ 添加',
  'reminders.listButton': '📋 列表（{count}）',
  'reminders.closeButton': '✕ 关闭',
  'reminders.closedNotice': '🔔 已关闭提醒。',
  'reminders.listTitle': '📋 提醒（{count}）',
  'reminders.listPageLine': '第 {page}/{total} 页',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ 上一页',
  'reminders.listNextButton': '下一页 ›',
  'reminders.listBackToHubButton': '‹ 返回',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': '时间：{schedule}',
  'reminders.cardText': '内容：「{text}」',
  'reminders.cardNext': '下次：{next}',
  'reminders.cardDeleteButton': '🗑 删除',
  'reminders.cardBackToListButton': '‹ 回列表',
  'reminders.createdTitle': '✅ 提醒已创建',
  'reminders.doneListButton': '📋 列表',
  'reminders.wizardTitle': '🔔 新建提醒',
  'reminders.pickRepeat': '重复：{value}',
  'reminders.pickDate': '日期：{value}',
  'reminders.pickWeekday': '星期：{value}',
  'reminders.pickDayOfMonth': '每月几日：{value}',
  'reminders.pickTime': '时间：{value}',
  'reminders.pickText': '内容：「{value}」',
  'reminders.stepRepeatQuestion': '步骤 1/4 · 多久一次？',
  'reminders.stepDateQuestion': '步骤 2/4 · 哪一天？',
  'reminders.stepDateGridQuestion': '步骤 2/4 · 选择日期：',
  'reminders.stepWeekdayQuestion': '步骤 2/4 · 星期几？',
  'reminders.stepDayOfMonthQuestion': '步骤 2/4 · 每月几日？',
  'reminders.stepDayOfMonthGridQuestion': '步骤 2/4 · 选择每月的日期：',
  'reminders.stepTimeQuestion': '步骤 3/4 · 什么时间？',
  'reminders.stepHourQuestion': '步骤 3/4 · 选择小时：',
  'reminders.stepMinuteQuestion': '步骤 3/4 · {hour}:__ — 选择分钟：',
  'reminders.stepTextQuestion': '步骤 4/4 · 发送提醒内容 — 输入文字或录一条语音。',
  'reminders.repeatOnceButton': '一次',
  'reminders.repeatDailyButton': '每天',
  'reminders.repeatWeekdaysButton': '工作日',
  'reminders.repeatWeeklyButton': '每周',
  'reminders.repeatMonthlyButton': '每月',
  'reminders.dateTodayButton': '今天',
  'reminders.dateTomorrowButton': '明天',
  'reminders.dateOtherButton': '✏️ 其他日期…',
  'reminders.dayOfMonthOtherButton': '✏️ 其他日子…',
  'reminders.timeOtherButton': '🕐 其他时间',
  'reminders.backButton': '‹ 返回',
  'reminders.cancelButton': '✕ 取消',
  'reminders.weekdayMondayButton': '周一',
  'reminders.weekdayTuesdayButton': '周二',
  'reminders.weekdayWednesdayButton': '周三',
  'reminders.weekdayThursdayButton': '周四',
  'reminders.weekdayFridayButton': '周五',
  'reminders.weekdaySaturdayButton': '周六',
  'reminders.weekdaySundayButton': '周日',
  'reminders.errorPastTime': '⚠️ 该时间已经过去。请选择更晚的时间，或返回上一步更改日期。',
  'reminders.errorInvalidDate': '⚠️ 该日期不存在。请另选一个。',
  'reminders.errorInvalidTime': '⚠️ 那一天没有这个时刻 — 当天要调整时钟。请另选一个时间。',
  'reminders.errorTextTooLong': '⚠️ 文本太长（最多 {limit} 个字符），未保存。请发送更短的内容。',
  'reminders.cancelledNotice': '✕ 已取消',
  'reminders.expiredNotice': '✕ 已过期 — 始终没有收到提醒内容。',
  'reminders.capReachedNotice': '⚠️ 此话题已有 {limit} 条提醒 — 请先删除一条再添加。',
  'reminders.wizardExpiredCbAnswer': '此向导已过期 — 请重新运行 /reminders。',
  'reminders.deletedCbAnswer': '🗑 已删除',
  'reminders.deleteGoneCbAnswer': '已经删除了。',
  'reminders.cardExpiredCbAnswer': '该提醒已不存在。',

  'apiRetry.transientNotice':
    '⏳ API 速率受限 — {minutes} 分钟后自动重试（第 {attempt} 次）。',
  'apiRetry.usageLimitDelayNotice':
    '🚧 用量限制已达到 — {minutes} 分钟后重试（第 {attempt} 次）。',
  'apiRetry.usageLimitResetNotice':
    '🚧 用量限制已达到 — 重置后自动恢复（~{time}）。',
  'apiRetry.resuming': '↻ 恢复中…',
  'apiRetry.limitResetResuming': '✅ 限额窗口已重置——我继续本话题的工作。',
  'apiRetry.giveUp':
    '⚠️ {attempts} 次尝试后无法恢复。需要继续时给我发消息。',
  'apiRetry.continueNudge': '从你停下的地方继续。',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude 已登出 — 运行 /login 继续。',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: 凭据无效 — 重启 opencode 服务器。',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ 已就绪 — 我可以处理机器人会话和群组话题中的消息。',
  'startup.header_not_ready':
    '⚠️ 设置尚未完成。要开始与我协作，请完成以下步骤：',
  'startup.item.create_group':
    '创建一个启用了话题的论坛超级群组，然后在其中给我发送一条消息以完成配对。',
  'startup.item.grant_admin':
    '将我设为管理员并授予以下权限：{missing}。',
  'startup.item.bind_topic':
    '创建一个话题，并使用 /bind 将其绑定到一个文件夹。',
  'startup.item.install_agent':
    '安装一个智能体 CLI —— claude 或 opencode。',
  'startup.item.optional_groq':
    '（可选）将 GROQ_API_KEY 添加到你的 .env 并重启以启用语音输入。',
  'startup.item.optional_owner':
    '（可选）设置 OWNER_USER_ID 以在你的私聊中接收此状态。',
};
