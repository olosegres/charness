/**
 * @description Russian catalog — hand-maintained. Not
 * machine-translated; kept as the reference set the project shipped with.
 */

export const ruDict: Record<string, string> = {
  'access.denied': 'Доступ запрещён.',
  'access.group_only': 'Я работаю только в настроенной forum-супергруппе.',

  'thread.no_binding':
    '📁 Этот тред не привязан к папке. Используй /bind <subdir> или выбери из списка.',
  'thread.bind_required':
    '📁 Сначала привяжи папку: /bind <subdir>. Агент запускается только в привязанной папке.',
  'thread.bound': '📁 Привязано к `{subdir}`.\nЗапусти /claude или /opencode.',
  'thread.unbound': '📁 Привязка снята.',
  'thread.general_no_agent':
    'General не привязан к папке — перейди в тематический тред для разговора с агентом.',
  'thread.welcome_bound':
    '👋 Тред создан и автоматически привязан к `{subdir}` (имя треда совпало с подпапкой).\nЗапусти /claude или /opencode.',
  'thread.welcome_pick':
    '👋 Тред создан. Привяжи папку: /bind <subdir>, или выбери из списка ниже.',
  'thread.bind_collision':
    '⚠️ Папка `{subdir}` уже используется в тредах: {threads}.\nПривязка добавлена; сессии независимы (свой tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 Папка `{subdir}` привязана. Запусти /claude или /opencode чтобы начать диалог.',

  'bind.usage': 'Использование: /bind <subdir>\nПример: /bind overview',
  'bind.current': '📂 Сейчас привязано: `{subdir}`',
  'bind.current_none': '📂 Пока не привязано',
  'bind.in_general':
    '/bind работает только в тематических тредах, не в General.',
  'bind.invalid_chars': '❌ В имени папки запрещены управляющие символы.',
  'bind.not_found': '❌ Папка `{subdir}` не найдена в `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Путь выходит за пределы `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` существует, но это не папка.',

  'bind.leave_button': '⬅️ Покинуть текущую папку',
  'bind.create_button': '➕ Создать новую папку',
  'bind.create_prompt':
    '✏️ Пришли название новой папки (будет создана в `WORK_ROOT`). Любая команда отменяет.',
  'bind.create_cb': 'Создаю новую папку…',
  'bind.create_empty': '❌ Название пустое. Пришли название папки.',
  'bind.create_separator': '❌ Название не должно содержать `/` или `\\`. Пришли простое имя.',
  'bind.create_dot_segment': '❌ `.` и `..` нельзя использовать как имя папки.',
  'bind.create_hidden': '❌ Имя не должно начинаться с точки.',
  'bind.create_invalid_chars': '❌ В названии папки запрещены управляющие символы.',
  'bind.create_exists': '📁 Папка `{subdir}` уже существует — привязываю к ней.',
  'bind.create_failed': '❌ Не удалось создать папку: {error}',

  'ls.header': '📁 Подпапки `{workRoot}`:',
  'ls.empty': '📁 В `WORK_ROOT` нет подходящих подпапок.',
  'list.header': '🧵 Привязки тредов ({count}):',
  'list.empty': '🧵 Привязок ещё нет. Создай тред и напиши /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new работает внутри привязанного треда — открой тред и выполни /new, чтобы перезапустить сессию агента.',

  'help.general':
    '*Команды в General:*\n' +
    '/ls — подпапки `WORK_ROOT`\n' +
    '/list — список тредов\n' +
    '/status — статус всех тредов\n' +
    '/quitall — завершить всех агентов\n' +
    '/whoami /version — debug\n\n' +
    'Чтобы начать диалог с агентом — открой тематический тред.',
  'help.thread_unbound':
    '*Тред не привязан к папке.*\n' +
    '/bind <subdir> — привязать (или выбери в списке)\n' +
    '/ls — подпапки `WORK_ROOT` (в General)',
  'help.thread_bound':
    '*Тред привязан к `{subdir}`.*\n' +
    '/claude /opencode — старт агента\n' +
    '/connect — подключить OpenCode provider API key (по умолчанию OpenAI)\n' +
    '/disconnect — удалить сохранённые ключи провайдера\n' +
    '/terminal — открыть shell в этой папке\n' +
    '/new — перезапустить сессию (старая → /sessions)\n' +
    '/model /sessions — переключение\n' +
    '/effort — уровень reasoning effort\n' +
    '/verbosity — детализация вывода (размышления/инструменты/суб-агенты)\n' +
    '/quit /status /output — контроль\n' +
    '/compact — сжать контекст агента\n' +
    '/compact_on_idle — авто-сжатие после простоя (переключатель)\n' +
    '/auto_continue_limits — авто-продолжение после лимита использования (переключатель)\n' +
    '/clear — удалить сообщения треда\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI-команды (Claude)\n' +
    '/bind — управление binding',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Бот — админ группы',
  'doctor.can_manage_topics': 'Право `can_manage_topics`',
  'doctor.can_delete_messages': 'Право `can_delete_messages`',
  'doctor.can_pin_messages': 'Право `can_pin_messages`',
  'doctor.privacy_off': 'Privacy mode выключен',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, потом удали и добавь бота заново',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} подпапок)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI установлен',
  'doctor.opencode_installed': 'opencode CLI установлен',
  'doctor.state_valid':
    'state.json валиден ({bindings} bindings, {active} активных)',
  'doctor.state_archived':
    'Прошлый state.json был повреждён, архив: {path}',
  'doctor.cli_missing':
    'не найдено в PATH (auto-install сработает при /claude или /opencode)',
  'doctor.no_admin_info':
    'не могу прочитать права бота — getChatMember failed',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Готовность к работе:\n' +
    '1️⃣ Сделай меня админом группы с правами:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, потом удали и добавь бота заново\n' +
    '3️⃣ Запусти /doctor — увижу проблемы сразу\n' +
    '4️⃣ В каждом тематическом треде сделай /bind <subdir> и запусти агента\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Привязано к `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} серверов',
  'binding.welcome.git': '• git: ветка `{branch}`{detail}',
  'binding.welcome.git_clean': ', чисто',
  'binding.welcome.git_dirty': ', изменения не закоммичены',
  'binding.welcome.git_none': '• git: не инициализирован',
  'binding.welcome.start_prompt': 'Начни диалог:',

  'mcp.header': '🔌 *MCP-серверы для этого треда:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP-серверы не настроены.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Pinned-статус треда (Этап 7) будет недоступен',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(нет привязки)',

  'pair.success': '✅ Группа привязана. id: `{groupId}`. Бот готов к работе в этой супергруппе.',
  'pair.locked':
    'ℹ️ id группы задан через `ALLOWED_GROUP_ID` — авто-привязка отключена. ' +
    'Чтобы сменить группу, измени переменную и перезапусти бота.',
  'pair.only_forum': '❌ /pair работает только в forum-супергруппе (включи Topics).',
  'pair.not_admin': '❌ Привязать бота может только администратор или создатель группы.',
  'pair.not_paired': 'группа ещё не привязана (режим pairing)',
  'pair.dm': 'ℹ️ /pair не нужен в режиме DM — бот работает в твоём личном чате.',
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(недоступно)',
  'status.global_header': '📊 *Все треды* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Тредов пока нет.',
  'status.thread_report': 'Статус:\n\nАгент: {agent}\nПапка: {subdir}\nСессия: {session}',
  'status.thread_model': 'Модель: {model}',
  'status.thread_effort': 'Усилие: {effort}',
  'status.thread_started': 'Запущено: {started}',
  'status.thread_running': 'работает',
  'status.thread_stopped': 'остановлена',
  'status.thread_no_agent': 'нет (запустите /claude или /opencode)',
  'status.thread_no_binding': '(нет привязки — WORK_ROOT)',
  'status.thread_workdir': 'Рабочая папка: {workDir}',
  'status.thread_runtime_version': 'Версия среды: {version}',
  'status.thread_context': 'Контекст: {used} / {limit} токенов',
  'language.status': '🌐 Язык: {display}',
  'language.set_success': '✅ Язык для этого чата: `{locale}`.',
  'language.auto_success': '✅ Автовыбор языка включён. Сейчас: {display}.',
  'language.invalid': '⚠️ Локаль `{locale}` не поддерживается. Доступно: {locales}.',

  'timezone.status': '🌍 Часовой пояс: {zone} — сейчас {now}',
  'timezone.usage':
    'Использование: /timezone <зона IANA>  ·  /timezone +04:00  ·  /timezone auto\nИли отправь /timezone без аргумента, чтобы выбрать из списка.',
  'timezone.set_success': '✅ Часовой пояс: {zone} — сейчас {now}\nРасписаний пересчитано: {count}',
  'timezone.auto_success':
    '✅ Часовой пояс сброшен на зону хоста: {zone} — сейчас {now}\nРасписаний пересчитано: {count}',
  'timezone.invalid':
    '⚠️ Неизвестный часовой пояс `{zone}`. Укажи имя IANA (например, `Europe/Moscow`) или фиксированное смещение (например, `+04:00`). Отправь /timezone, чтобы выбрать из списка.',
  'timezone.offset_unsupported':
    '⚠️ Смещение `{zone}` применить нельзя — работают только смещения, кратные целому часу. Укажи имя зоны IANA (например, `Asia/Kolkata` для +05:30).',
  'timezone.fixed_offset_warning':
    '⚠️ Фиксированное смещение не учитывает переход на летнее время — полгода оно будет ошибаться на час.',
  'timezone.picker_regions': '🌍 Часовой пояс: {zone}\nСейчас: {now}\n\nВыбери регион:',
  'timezone.picker_zones': '🌍 {region} — страница {page}/{total}',
  'timezone.picker_expired': 'Этот список устарел — отправь /timezone ещё раз.',

  'agent.ready': '{label} готов в `{subdir}`{argsSuffix}\n{infoBlock}Отправь сообщение:',
  'agent.ready_model': '🧠 Модель: {model}',
  'agent.no_session': 'Агент не запущен. /claude или /opencode — старт.',
  'agent.session_ended': '{label}: сессия завершена',
  'agent.stopped': '{label} остановлен',
  'agent.exit_signal_sent': 'Послан двойной Ctrl+C — {label} завершает работу',
  'agent.already_active': '{label} уже работает в этом треде. Отправь сообщение или /quit.',
  'agent.starting': 'Запускаю {label} в `{subdir}`…',
  'agent.queued_starting': '⏳ {label} ещё запускается — сообщение в очереди, отправлю как только будет готов.',
  'agent.question_hint': 'ℹ️ Ответь цифрой варианта (например 1) или y/n. Также: /up /down — выбор, /enter — подтвердить, /c — отмена.',
  'agent.start_failed': 'Не удалось запустить {label}: {error}',
  'agent.no_response': '⚠️ Агент принял запрос, но так и не начал отвечать — возможно, сессия зависла. Отправьте ещё раз или /new для новой сессии.',
  'agent.session_restarting': '⚠️ Агент не ответил — сессия зависла. Перезапускаю её и повторяю запрос…',
  'agent.session_recovering': '⚠️ Агент не ответил — восстанавливаю (диалог сохранён) и повторяю запрос…',
  'agent.question_cancelled_for_prompt': '⚠️ Предыдущий вопрос отменён — выполняю новый запрос.',
  'agent.question_cancelled_msg_label': '❌ Вопрос отменён: {header}',
  'agent.login_code_relayed': '🔐 Код входа передан в Claude — сообщение с токеном удалено из истории.',
  'agent.login_url': '🔐 Чтобы войти в Claude, откройте эту ссылку, завершите вход и вставьте код сюда:\n{url}',
  'agent.login_success': '✅ Вход в Claude выполнен.',
  'agent.login_failed': '⚠️ Не удалось войти в Claude. Наберите /login, чтобы повторить.',
  'agent.workingIndicator': '{glyph} работаю…',
  'terminal.ready': '🖥 Терминал готов в `{subdir}`{argsSuffix}\nЛюбое сообщение выполнится как команда. /c — Ctrl+C, /up /down — история, /tab — автодополнение, /quit — закрыть.',

  'effort.choose': '⚙️ Текущий effort: {current}\nВыбери уровень:',
  'effort.current_none': 'не задан',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort: {effort}\nИзменить — /effort',
  'effort.invalid_level': '⚠️ Уровень `{level}` недопустим. Доступные: {valid}.',
  'effort.not_available': 'ℹ️ Для текущей модели уровни reasoning effort недоступны.',
  'effort.not_supported': 'ℹ️ Модель `{model}` не поддерживает уровни reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Уровень сохранён. Агент не запущен — применю при следующем старте.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` сброшен: новая модель `{model}` его не поддерживает.',
  'effort.unsupported_backend': 'Управление effort не поддерживается для {label}.',
  'effort.no_session': 'Агент не запущен. Сначала /claude или /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 думал {seconds} с',
  'thinking.choose': '☁️ Текущий режим размышлений: {current}\nВыбери режим:',
  'thinking.set_success': '✅ Режим размышлений: {mode}',
  'thinking.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'thinking.mode.minimal': 'минимум',
  'thinking.mode.short': 'кратко',
  'thinking.mode.full': 'подробно',

  'toolResults.choose': '🔧 Текущий режим результатов инструментов: {current}\nВыбери режим:',
  'toolResults.set_success': '✅ Режим результатов инструментов: {mode}',
  'toolResults.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'toolResults.mode.minimal': 'минимум',
  'toolResults.mode.short': 'кратко',
  'toolResults.mode.full': 'подробно',
  'toolResults.truncated_footer': '… (обрезано, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'инструмент',

  'subagent.status_elapsed': '🤖 суб-агент: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 суб-агент работает …',
  'subagent.delegating_status': '🤖 Делегирую: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'суб-агент',
  'subagent.choose': '🤖 Текущий режим суб-агентов: {current}\nВыбери режим:',
  'subagent.set_success': '✅ Режим суб-агентов: {mode}',
  'subagent.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'subagent.mode.minimal': 'минимум',
  'subagent.mode.short': 'кратко',
  'subagent.mode.full': 'подробно',

  'verbosity.choose': '🔊 Текущая детализация вывода: {current}\nВыбери уровень:',
  'verbosity.set_success': '✅ Детализация вывода: {mode} (размышления, инструменты, суб-агенты)',
  'verbosity.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'verbosity.custom': 'смешанный (размышления: {thinking} · инструменты: {toolResults} · суб-агенты: {subagent})',
  'verbosity.mode.minimal': 'минимум',
  'verbosity.mode.short': 'кратко',
  'verbosity.mode.full': 'подробно',

  'model.set_success': '🧠 Модель выбрана: {model}',
  'model.saved_for_next_start': 'Модель сохранена: {model} — применится при старте агента.',
  'model.start_agent_first': 'Нет активной сессии. Сначала запусти агента.',
  'model.current_default': 'по умолчанию',
  'model.none_available': '🧠 Текущая: {current}\n\nСписок моделей пуст. Задай модель вручную: /model <provider/model>.',
  'model.invalid_number': '❌ Неверный номер. Запусти /model, чтобы увидеть список.',
  'model.pick_provider': '🧠 Текущая: {current}\n\nВыбери провайдера:',
  'model.all_hidden': '🧠 Текущая: {current}\n\nВсе провайдеры скрыты. Нажми 👁, чтобы вернуть один из них.',
  'model.hidden_header': '🙈 Скрыто из этого списка — нажми 👁, чтобы вернуть.',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ провайдеры',
  'model.prev_button': '⬅️ Назад',
  'model.next_button': 'Вперёд ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — моделей: {count} · страница {page}/{totalPages}\nТекущая: {current}',
  'model.page_hint': 'Ответь номером, чтобы выбрать, или /model <название> для поиска.',
  'model.page_hint_buttons_only': 'Нажми на модель, чтобы переключиться, или /model <название> для поиска.',

  'disconnect.unsupported_backend': 'Отключение провайдеров OpenCode недоступно в этой сборке.',
  'disconnect.invalid_provider': '❌ Неверный id провайдера {provider}. Пример: /disconnect openrouter',
  'disconnect.no_providers': 'Нет провайдеров для отключения.',
  'disconnect.pick_provider': 'Выбери провайдера для отключения — сохранённые учётные данные будут удалены:',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ Провайдер {provider} отключён — сохранённые учётные данные удалены.',
  'disconnect.still_active_env': '⚠️ Сохранённые учётные данные {provider} удалены, но провайдер всё ещё активен: OpenCode включает его через переменную окружения. Убери эту переменную и перезапусти OpenCode, либо скрой провайдера в /model.',
  'disconnect.failed': '⚠️ Не удалось отключить {provider}: {reason}',

  'rename_session.usage': 'Использование: /rename_session <новое название>',
  'rename_session.start_agent_first': 'Нет активной сессии. Сначала запусти агента (/claude или /opencode).',
  'rename_session.unsupported_backend': 'Переименование сессии не поддерживается для {label}.',
  'rename_session.success': '✅ Сессия переименована: {title}',
  'rename_session.failed': '⚠️ Не удалось переименовать сессию: {reason}',

  'compact.started': '🧹 Сжимаю контекст сессии — агент продолжит с краткой выжимки.',
  'compact.done': '✅ Контекст сжат.',
  'compact.done_tokens': '✅ Контекст сжат: {pre} → {post} токенов.',
  'compact.start_agent_first': 'Нет активной сессии. Сначала запусти агента (/claude или /opencode).',
  'compact.unsupported_backend': 'Сжатие контекста не поддерживается для {label}.',
  'compact.model_unresolved': '⚠️ Нельзя сжать: для этой сессии не определена модель. Выбери её через /model и попробуй снова.',
  'compact.failed': '⚠️ Не удалось сжать контекст сессии: {reason}',
  'compact.busy': '⚠️ Агент сейчас занят — запусти /compact снова, когда текущий ход завершится.',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN RUSSIAN: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 Контекст автоматически сжат при простое, чтобы сэкономить токены за счёт кэша.\nЗапусти /compact_on_idle, чтобы отключить.',
  'compactOnIdle.on': 'ВКЛ',
  'compactOnIdle.off': 'ВЫКЛ',
  'compactOnIdle.title': '🧹 Авто-сжатие при простое для этого топика: {state}\n\nКогда сессия простаивает ~55 мин, её контекст сжимается автоматически, чтобы сэкономить токены (кэш промпта ещё тёплый).\n\nЧтобы переключить для ВСЕХ топиков сразу, запусти это в топике General.',
  'compactOnIdle.titleGeneral': '🧹 Авто-сжатие при простое — по умолчанию для ВСЕХ топиков: {state}\n\nКогда сессия простаивает ~55 мин, её контекст сжимается автоматически, чтобы сэкономить токены.\n\nКаждый топик может переопределить это своим /compact_on_idle.',
  'compactOnIdle.enableButton': 'Включить',
  'compactOnIdle.disableButton': 'Выключить',
  'compactOnIdle.setThisTopic': '✅ Авто-сжатие при простое: {state} для этого топика.',
  'compactOnIdle.setGlobal': '✅ Авто-сжатие при простое: {state} для ВСЕХ топиков (переопределения по топикам продолжают действовать).',
  'compactOnIdle.unsupported': 'Авто-сжатие при простое работает для активной сессии агента. Сначала запусти /claude или /opencode в привязанном топике.',
  'compactOnIdle.pendingQuestionReask': '❓ У тебя остался неотвеченный вопрос. Нажми на вариант, чтобы ответить и продолжить:',

  'autoContinueLimits.on': 'ВКЛ',
  'autoContinueLimits.off': 'ВЫКЛ',
  'autoContinueLimits.title': '🚧 Авто-продолжение после лимита использования для этого топика: {state}\n\nКогда агент упирается в лимит использования или сессии, бот ждёт сброса окна и затем сам просит агента продолжить (сообщение о продолжении закрепляется, поэтому даже в заглушённом топике придёт уведомление).\n\nЧтобы переключить для ВСЕХ топиков сразу, запусти это в топике General.',
  'autoContinueLimits.titleGeneral': '🚧 Авто-продолжение после лимита использования — по умолчанию для ВСЕХ топиков: {state}\n\nКогда агент упирается в лимит использования или сессии, бот ждёт сброса окна и затем сам просит агента продолжить.\n\nКаждый топик может переопределить это своим /auto_continue_limits.',
  'autoContinueLimits.enableButton': 'Включить',
  'autoContinueLimits.disableButton': 'Выключить',
  'autoContinueLimits.skipButton': '⏭ Пропустить один раз',
  'autoContinueLimits.skipDone': 'Это продолжение пропущено.',
  'autoContinueLimits.skipExpired': 'Пропускать нечего — это ожидание уже завершилось.',
  'autoContinueLimits.skippedNotice': '⏭ Пропущено: этот раз я сам продолжать не буду. Напиши, когда продолжать — авто-продолжение для этого топика остаётся включённым.',
  'autoContinueLimits.noticeHint': 'Запусти /auto_continue_limits, чтобы пропустить это продолжение или выключить авто-продолжение для этого топика.',
  'autoContinueLimits.setThisTopic': '✅ Авто-продолжение после лимита использования: {state} для этого топика.',
  'autoContinueLimits.setGlobal': '✅ Авто-продолжение после лимита использования: {state} для ВСЕХ топиков (переопределения по топикам продолжают действовать).',
  'autoContinueLimits.limitReachedDisabled': '🚧 Достигнут лимит использования. Авто-продолжение для этого топика выключено, поэтому я жду — напиши, когда продолжать (/auto_continue_limits on, чтобы продолжать автоматически).',

  'connect.prompt_key': '🔑 Пришли API key для `{provider}` следующим сообщением. Я удалю сообщение с ключом из истории.',
  'connect.empty_key': '❌ API key пустой. Пришли ключ следующим сообщением.',
  'connect.invalid_key': '❌ Это не похоже на API-ключ (есть пробелы или не-латинские символы). Пришли следующим сообщением только сам ключ или запусти /connect заново.',
  'connect.invalid_provider': '❌ Некорректный provider id `{provider}`. Например: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` не поддерживает простой API-key вход через этот flow. Используй OpenCode UI/CLI для этого provider.',
  'connect.unsupported_backend': 'OpenCode provider auth недоступен в этом билде.',
  'connect.failed': '⚠️ Не удалось подключить `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` подключён. OpenCode server не перезапускался.',
  'connect.cancelled': 'Ввод API key отменён.',
  'connect.pick_method': 'Как подключить `{provider}`? Выберите способ:',
  'connect.no_methods': '⚠️ Для `{provider}` не найдено способов авторизации.',
  'connect.oauth_device': '🔓 Чтобы подключить `{provider}`: откройте {url} и введите код `{code}`, затем подтвердите вход. На сервере выбирайте *headless*-способ. Сообщу здесь, когда будет готово.',
  'connect.oauth_url_only': '🔓 Чтобы подключить `{provider}`: откройте {url} и завершите вход. Сообщу здесь, когда будет готово.',
  'connect.oauth_paste': '🔑 После подтверждения пришлите код следующим сообщением — я удалю его из истории.',
  'connect.oauth_waiting': '⏳ Ожидаю авторизацию…',
  'connect.oauth_loopback': '🔑 После подтверждения браузер попробует открыть страницу `localhost`, которая не загрузится — это нормально. Скопируй этот URL из адресной строки и пришли следующим сообщением (или только значение `code`). Я удалю его из истории и завершу вход.',
  'connect.oauth_invalid_reply': '❌ Это не похоже ни на callback-URL, ни на код авторизации. После подтверждения пришли `localhost`-callback URL из браузера (или значение `code`).',
  'connect.oauth_callback_no_flow': '⚠️ Похоже на OAuth callback-URL, но сейчас вход не выполняется — я его удалил. Запусти /connect, чтобы начать заново.',
  'connect.oauth_success': '✅ `{provider}` подключён через OAuth. Учётные данные сервера OpenCode обновлены.',
  'connect.oauth_failed': '⚠️ Вход через OAuth для `{provider}` не завершён. Запустите /connect ещё раз.',
  'quit_all.none_active': 'Нет активных агентов — нечего останавливать.',
  'quit_all.summary': '🚪 Завершено {stopped} из {total} активных агентов.',
  'quit_all.general_only': 'Команда `/quit-all` доступна только в General-топике.',

  'clearMessages.summary':
    '🗑 Удалено {deleted} сообщений из {total}. ' +
    'Telegram не отдаёт ничего старше 48 ч — остальные останутся в истории.',
  'clearMessages.no_messages': 'Нет сообщений для удаления в этом треде.',

  'edited.hint':
    '✏️ Редактирование сообщений я не вижу как новый ввод — отправь правку отдельным сообщением.',

  'voice.no_api_key':
    'Для голоса нужен `GROQ_API_KEY` (бесплатно) или `OPENAI_API_KEY`.',
  'voice.failed': 'Не удалось распознать голосовое.',
  'voice.retrying': '⚠️ Не удалось распознать голосовое ({error}). Повторю через {seconds} с…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Файл больше лимита Bot API ({cap} МБ) — скачать его я не могу. Пришли файл поменьше.',
  'file.download_failed': '📎 Не удалось скачать файл. Попробуй ещё раз.',

  'error.workdir.gone':
    '📁 Папка `{subdir}` исчезла с диска. Сделай /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ Тред удалён в Telegram, binding очищен.',
  'error.tg.thread.closed':
    '🔒 Тред {key} закрыт — переоткрой его в клиенте Telegram, или удали полностью.',
  'error.tg.perm.delete':
    '🔐 Не могу удалить сообщения. Выдай право `can_delete_messages` админу бота.',
  'error.tg.perm.manage_topics':
    '🔐 Не хватает прав `can_manage_topics`. Сделай меня админом группы.',
  'error.state.corrupted':
    '⚠️ state.json был повреждён, привязки пересозданы. Повтори /bind где нужно.',
  'error.start_in_general':
    'Запускать агента в General нельзя — это служебный топик. Открой тематический тред.',

  'cb.access_denied': 'Доступ запрещён',
  'cb.bind_only_topical': '/bind работает только в тематических тредах',
  'cb.binding_to': 'Привязываю к {subdir}…',
  'cb.no_active_session': 'Нет активной сессии',
  'cb.model_error': 'Ошибка: {error}',
  'cb.model_set': 'Модель: {model}',
  'cb.model_provider_gone': 'Провайдера больше нет — запусти /model заново',
  'cb.model_hidden': 'Скрыт: {provider}',
  'cb.model_shown': 'Показан: {provider}',
  'cb.disconnect_expired': 'Это меню отключения устарело — запусти /disconnect заново',
  'cb.not_supported': 'Не поддерживается для {label}',
  'cb.unknown_agent': 'Неизвестный агент',
  'cb.agent_switched': 'Переключено на {label}',
  'cb.resume_only_topical': 'Resume работает только в тематических тредах',
  'cb.bind_folder_first': 'Сначала привяжи папку через /bind',
  'cb.agent_not_running': 'Агент не запущен',
  'cb.no_pending_question': 'Нет ожидающего вопроса',
  'cb.connect_method_expired': 'Меню подключения устарело — запустите /connect снова',
  'cb.invalid_option': 'Некорректный вариант',
  'cb.sent_option': 'Отправлено: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Ошибка: {error}',
  'cb.claudeMode_already': 'Уже активно',
  'cb.claudeMode_switching': 'Переключаю…',
  'claudeMode.pick': '⚙️ Режим Claude Code — сейчас: {label}\nВыбери бэкенд (переключение сохраняет тот же диалог):',
  'claudeMode.not_claude': 'Этот топик не на Claude Code — /claude_mode переключает только бэкенд Claude.',
  'claudeMode.already': 'Уже {label}.',
  'claudeMode.set_idle': '⚙️ Бэкенд Claude: {label} — применится при следующем старте.',
  'claudeMode.switched_resumed': '⚙️ Переключено на {label} — тот же диалог продолжен.',
  'claudeMode.switched_fresh': '⚙️ Переключено на {label} — начата свежая сессия.',
  'cb.thinking_set': 'Размышления: {mode}',
  'cb.thinking_error': 'Ошибка: {error}',
  'cb.toolresults_set': 'Результаты инструментов: {mode}',
  'cb.toolresults_error': 'Ошибка: {error}',
  'cb.subagent_set': 'Суб-агенты: {mode}',
  'cb.subagent_error': 'Ошибка: {error}',
  'cb.verbosity_set': 'Детализация вывода: {mode}',
  'cb.verbosity_error': 'Ошибка: {error}',

  'session.list_header': 'Сессии для возобновления ({label}):',
  'session.list_footer': 'Отправьте 1–{max} чтобы возобновить · 0 для выхода',
  'session.none': 'Нет сессий для возобновления в этой папке.',
  'session.cancelled': 'Отменено. Выбор сессии закрыт.',
  'session.invalid': 'Неверный номер. Введите число от 1 до {max}.',
  'session.resumed': 'Сессия возобновлена. Отправьте сообщение:',
  'session.resume_failed': 'Не удалось возобновить сессию: {error}',
  'session.expired': 'Список сессий устарел. Запустите /sessions заново.',
  'session.load_failed': 'Не удалось загрузить список сессий.',

  'resume.context_header': '↩️ Возобновлено — последние {count} сообщений:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Пока бот был недоступен, пропущено сообщений: {count}. Последнее из сессии:',
  'recap.restartedFallbackHeader': '🔄 Бот перезапущен. Последнее из сессии:',
  'recap.stillWorkingLine': '⏳ Агент всё ещё работает…',

  'trace.onThisThreadReply': '🔎 Трейс включён для этого треда.',
  'trace.offThisThreadReply': '🔎 Трейс выключен для этого треда.',
  'trace.onAllThreadsReply': '🔎 Трейс включён для ВСЕХ тредов.',
  'trace.offAllThreadsReply': '🔎 Трейс выключен везде (флаг «all» и список тредов очищены).',
  'trace.statusReply':
    '🔎 Трейс — этот тред: {thisThread}\nВсе треды: {allThreads}\nТредов в трейсе: {count}',
  'trace.statusOnLabel': 'вкл',
  'trace.statusOffLabel': 'выкл',
  'trace.usageHint': 'Использование: /trace on | off | on all | off all | (без аргумента — статус)',

  'timestamps.onReply':
    '🕐 Метки времени включены: каждый промпт агенту получает время отправки первой строкой (в топик не постится).',
  'timestamps.offReply': '🕐 Метки времени выключены для этого треда.',
  'timestamps.statusOnReply': '🕐 Метки времени: вкл для этого треда.',
  'timestamps.statusOffReply': '🕐 Метки времени: выкл для этого треда.',
  'timestamps.usageHint': 'Использование: /timestamps on | off | (без аргумента — статус)',

  'schedule.fired':
    '⏰ Расписание «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — пропущено в {time}, догоняю',
  'schedule.pausedUnbound':
    '⏸ Расписаний на паузе: {count} — топик отвязан от папки. /bind вернёт их в строй.',
  'schedule.resumedRebind': '▶️ Расписаний возобновлено: {count} (следующий запуск пересчитан от текущего момента).',
  'schedule.noAgent':
    '⚠️ Ничего не запланировано — в этой теме не запущен ни один агент, поэтому запланированному запуску нечего будет запустить. Сначала запустите /claude или /opencode.',
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN RUSSIAN what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN RUSSIAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN RUSSIAN what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': 'каждый день в {time}',
  'reminders.scheduleWeekdays': 'по будням в {time}',
  'reminders.scheduleWeekly': '{weekday} в {time}',
  'reminders.scheduleMonthly': '{dayOfMonth}-го числа в {time}',
  'reminders.scheduleOnce': '{date} в {time}',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': 'сегодня в {time}',
  'reminders.nextRunTomorrow': 'завтра в {time}',
  'reminders.nextRunOnDate': '{date} в {time}',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 Напоминания',
  'reminders.hubEmptyLine': 'Напоминаний пока нет.',
  'reminders.hubActiveLine': 'Активных: {count}',
  'reminders.hubLimitLine':
    'Активных: {count} — достигнут лимит {limit}. Удали одно, чтобы добавить новое.',
  'reminders.addButton': '➕ Добавить',
  'reminders.listButton': '📋 Список ({count})',
  'reminders.closeButton': '✕ Закрыть',
  'reminders.closedNotice': '🔔 Напоминания закрыты.',
  'reminders.listTitle': '📋 Напоминания ({count})',
  'reminders.listPageLine': 'Страница {page} из {total}',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ Пред.',
  'reminders.listNextButton': 'След. ›',
  'reminders.listBackToHubButton': '‹ Назад',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'Когда: {schedule}',
  'reminders.cardText': 'Текст: «{text}»',
  'reminders.cardNext': 'Дальше: {next}',
  'reminders.cardDeleteButton': '🗑 Удалить',
  'reminders.cardBackToListButton': '‹ К списку',
  'reminders.createdTitle': '✅ Напоминание создано',
  'reminders.doneListButton': '📋 Список',
  'reminders.wizardTitle': '🔔 Новое напоминание',
  'reminders.pickRepeat': 'Повтор: {value}',
  'reminders.pickDate': 'Дата: {value}',
  'reminders.pickWeekday': 'День недели: {value}',
  'reminders.pickDayOfMonth': 'День месяца: {value}',
  'reminders.pickTime': 'Время: {value}',
  'reminders.pickText': 'Текст: «{value}»',
  'reminders.stepRepeatQuestion': 'ШАГ 1/4 · Как часто?',
  'reminders.stepDateQuestion': 'ШАГ 2/4 · Какой день?',
  'reminders.stepDateGridQuestion': 'ШАГ 2/4 · Выбери дату:',
  'reminders.stepWeekdayQuestion': 'ШАГ 2/4 · Какой день недели?',
  'reminders.stepDayOfMonthQuestion': 'ШАГ 2/4 · Какое число месяца?',
  'reminders.stepDayOfMonthGridQuestion': 'ШАГ 2/4 · Выбери число месяца:',
  'reminders.stepTimeQuestion': 'ШАГ 3/4 · В какое время?',
  'reminders.stepHourQuestion': 'ШАГ 3/4 · Выбери час:',
  'reminders.stepMinuteQuestion': 'ШАГ 3/4 · {hour}:__ — выбери минуты:',
  'reminders.stepTextQuestion':
    'ШАГ 4/4 · Отправь текст напоминания — напиши его или запиши голосовое.',
  'reminders.repeatOnceButton': 'Один раз',
  'reminders.repeatDailyButton': 'Каждый день',
  'reminders.repeatWeekdaysButton': 'Будни',
  'reminders.repeatWeeklyButton': 'Еженедельно',
  'reminders.repeatMonthlyButton': 'Ежемесячно',
  'reminders.dateTodayButton': 'Сегодня',
  'reminders.dateTomorrowButton': 'Завтра',
  'reminders.dateOtherButton': '✏️ Другая дата…',
  'reminders.dayOfMonthOtherButton': '✏️ Другое число…',
  'reminders.timeOtherButton': '🕐 Другое время',
  'reminders.backButton': '‹ Назад',
  'reminders.cancelButton': '✕ Отмена',
  'reminders.weekdayMondayButton': 'Пн',
  'reminders.weekdayTuesdayButton': 'Вт',
  'reminders.weekdayWednesdayButton': 'Ср',
  'reminders.weekdayThursdayButton': 'Чт',
  'reminders.weekdayFridayButton': 'Пт',
  'reminders.weekdaySaturdayButton': 'Сб',
  'reminders.weekdaySundayButton': 'Вс',
  'reminders.errorPastTime':
    '⚠️ Это время уже прошло. Выбери время позже или вернись и поменяй день.',
  'reminders.errorInvalidDate': '⚠️ Такой даты не существует. Выбери другую.',
  'reminders.errorInvalidTime':
    '⚠️ Такого времени в этот день нет — переход на другое время. Выбери другое время.',
  'reminders.errorTextTooLong':
    '⚠️ Текст слишком длинный (максимум {limit} символов) и НЕ сохранён. Отправь короче.',
  'reminders.cancelledNotice': '✕ Отменено',
  'reminders.expiredNotice': '✕ Истекло — текст напоминания так и не пришёл.',
  'reminders.capReachedNotice':
    '⚠️ В этой теме уже {limit} напоминаний — удали одно, прежде чем добавить новое.',
  'reminders.wizardExpiredCbAnswer': 'Этот мастер устарел — запусти /reminders заново.',
  'reminders.deletedCbAnswer': '🗑 Удалено',
  'reminders.deleteGoneCbAnswer': 'Уже удалено.',
  'reminders.cardExpiredCbAnswer': 'Этого напоминания больше нет.',

  'apiRetry.transientNotice':
    '⏳ API перегружен (rate limit) — повторю автоматически через {minutes} мин (попытка {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Лимит исчерпан — повторю через {minutes} мин (попытка {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Лимит исчерпан — продолжу автоматически после сброса (~{time}).',
  'apiRetry.resuming': '↻ Продолжаю…',
  'apiRetry.limitResetResuming': '✅ Окно лимита сброшено — продолжаю работу в этом топике.',
  'apiRetry.giveUp':
    '⚠️ Не смог возобновить после {attempts} попыток. Напиши, когда продолжить.',
  'apiRetry.continueNudge': 'Продолжай с того места, где ты остановился.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude разлогинен — отправь /login, чтобы продолжить.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: неверные учётные данные — перезапусти opencode-сервер.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Готов — я могу обрабатывать сообщения в тредах бота и темах группы.',
  'startup.header_not_ready':
    '⚠️ Настройка не завершена. Чтобы начать работу со мной, выполните эти шаги:',
  'startup.item.create_group':
    'Создайте форум-супергруппу с включёнными темами (Topics) и отправьте мне там сообщение, чтобы привязать её.',
  'startup.item.grant_admin':
    'Сделайте меня админом с правами: {missing}.',
  'startup.item.bind_topic':
    'Создайте тему и привяжите её к папке командой /bind.',
  'startup.item.install_agent':
    'Установите агентский CLI — claude или opencode.',
  'startup.item.optional_groq':
    '(необязательно) Добавьте GROQ_API_KEY в .env и перезапустите, чтобы включить голосовой ввод.',
  'startup.item.optional_owner':
    '(необязательно) Задайте OWNER_USER_ID, чтобы получать этот статус в личном чате.',
};
