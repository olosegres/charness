// Machine-translated from en. Native review welcome.

export const uzDict: Record<string, string> = {
  'access.denied': 'Kirish rad etildi.',
  'access.group_only': 'Men faqat sozlangan forum supergruppada ishlayman.',

  'thread.no_binding':
    '📁 Bu mavzu papkaga bog‘lanmagan. /bind <subdir> ishlating yoki ro‘yxatdan tanlang.',
  'thread.bind_required':
    '📁 Avval papkani bog‘lang: /bind <subdir>. Agent faqat bog‘langan papkada ishlaydi.',
  'thread.bound': '📁 `{subdir}` ga bog‘landi.\n/claude yoki /opencode ni ishga tushiring.',
  'thread.unbound': '📁 Bog‘lanish olib tashlandi.',
  'thread.general_no_agent':
    'General papkaga bog‘lanmagan — agent bilan gaplashish uchun mavzu mavzusiga o‘ting.',
  'thread.welcome_bound':
    '👋 Mavzu yaratildi va `{subdir}` ga avtomatik bog‘landi (mavzu nomi quyi papkaga mos keldi).\n/claude yoki /opencode ni ishga tushiring.',
  'thread.welcome_pick':
    '👋 Mavzu yaratildi. Papkani bog‘lang: /bind <subdir>, yoki quyidan tanlang.',
  'thread.bind_collision':
    '⚠️ `{subdir}` papkasi allaqachon quyidagi mavzular tomonidan ishlatilmoqda: {threads}.\nBog‘lanish qo‘shildi; seanslar mustaqil qoladi (o‘z tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 `{subdir}` papkasi bog‘langan. Dialogni boshlash uchun /claude yoki /opencode ni ishga tushiring.',

  'bind.usage': 'Foydalanish: /bind <subdir>\nMisol: /bind overview',
  'bind.current': '📂 Joriy bog‘lanish: `{subdir}`',
  'bind.current_none': '📂 Hali bog‘lanmagan',
  'bind.in_general': '/bind faqat mavzu mavzularida ishlaydi, General da emas.',
  'bind.invalid_chars': '❌ Papka nomida boshqaruv belgilari bo‘lmasligi kerak.',
  'bind.not_found': '❌ `{subdir}` papkasi `WORK_ROOT` (`{workRoot}`) ostida topilmadi.',
  'bind.outside_root': '❌ Yo‘l `WORK_ROOT` dan tashqariga chiqadi.',
  'bind.not_directory': '❌ `{subdir}` mavjud, lekin papka emas.',

  'bind.leave_button': '⬅️ Joriy katalogni tark etish',
  'bind.create_button': '➕ Yangi papka yaratish',
  'bind.create_prompt':
    '✏️ Yangi papka nomini yuboring (`WORK_ROOT` ostida yaratiladi). Har qanday buyruq bekor qiladi.',
  'bind.create_cb': 'Yangi papka yaratilmoqda…',
  'bind.create_empty': '❌ Nom bo‘sh. Papka nomini yuboring.',
  'bind.create_separator': '❌ Nomda `/` yoki `\\` bo‘lmasligi kerak. Oddiy nom yuboring.',
  'bind.create_dot_segment': '❌ `.` va `..` papka nomi sifatida ishlatilmaydi.',
  'bind.create_hidden': '❌ Nom nuqta bilan boshlanmasligi kerak.',
  'bind.create_invalid_chars': '❌ Papka nomida boshqaruv belgilari bo‘lmasligi kerak.',
  'bind.create_exists': '📁 `{subdir}` papkasi allaqachon mavjud — bog‘lanmoqda.',
  'bind.create_failed': '❌ Papkani yaratib bo‘lmadi: {error}',

  'ls.header': '📁 `{workRoot}` quyi papkalari:',
  'ls.empty': '📁 `WORK_ROOT` ostida bog‘lanadigan quyi papkalar yo‘q.',
  'list.header': '🧵 Mavzu bog‘lanishlari ({count}):',
  'list.empty': '🧵 Hali bog‘lanishlar yo‘q. Mavzu yarating va /bind ni ishga tushiring.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new bog‘langan mavzu ichida ishlaydi — mavzuni oching va uning agent seansini qayta boshlash uchun /new ni ishga tushiring.',

  'help.general':
    '*General dagi buyruqlar:*\n' +
    '/ls — `WORK_ROOT` quyi papkalarini sanab o‘ting\n' +
    '/list — mavzularni sanab o‘ting\n' +
    '/status — barcha mavzular holati\n' +
    '/quitall — har bir ishlayotgan agentni to‘xtating\n' +
    '/whoami /version — debugging\n\n' +
    'Agent bilan gaplashish uchun — mavzu mavzusini oching.',
  'help.thread_unbound':
    '*Mavzu papkaga bog‘lanmagan.*\n' +
    '/bind <subdir> — bog‘lash (yoki ro‘yxatdan tanlash)\n' +
    '/ls — `WORK_ROOT` quyi papkalari (General da)',
  'help.thread_bound':
    '*Mavzu `{subdir}` ga bog‘langan.*\n' +
    '/claude /opencode — agentni boshlash\n' +
    '/connect — OpenCode provayder API kalitini ulash (default OpenAI)\n' +
    '/disconnect — provayderning saqlangan hisob ma\'lumotlarini o\'chirish\n' +
    '/terminal — bu papkada shell ochish\n' +
    '/new — seansni qayta boshlash (eskisi → /sessions)\n' +
    '/model /sessions — almashtirish\n' +
    '/effort — reasoning effort darajasi\n' +
    "/verbosity — chiqish batafsilligi va mavzu nimani ko'rsatadi (oqim / javoblar)\n" +
    '/quit /status /output — boshqaruv\n' +
    '/compact — agent kontekstini siqish\n' +
    '/compact_on_idle — bo‘sh turgandan keyin avtosiqish (almashtirgich)\n' +
    '/auto_continue_limits — foydalanish limitidan keyin avtodavom (almashtirgich)\n' +
    '/clear — mavzu xabarlarini o‘chirish\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI tugmalar (Claude)\n' +
    '/bind — bog‘lanishni boshqarish',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot guruh admini',
  'doctor.can_manage_topics': '`can_manage_topics` berilgan',
  'doctor.can_delete_messages': '`can_delete_messages` berilgan',
  'doctor.can_pin_messages': '`can_pin_messages` berilgan',
  'doctor.privacy_off': 'Privacy mode o‘chirilgan',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, so‘ng Bot ni o‘chiring va qayta qo‘shing',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} quyi papka)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI o‘rnatilgan',
  'doctor.opencode_installed': 'opencode CLI o‘rnatilgan',
  'doctor.state_valid':
    'state.json yaroqli ({bindings} bog‘lanish, {active} faol)',
  'doctor.state_archived':
    'oldingi state.json buzilgan edi, arxiv: {path}',
  'doctor.cli_missing':
    'PATH da topilmadi (avto-o‘rnatish /claude yoki /opencode da ishlaydi)',
  'doctor.no_admin_info':
    'Bot huquqlarini o‘qib bo‘lmadi — getChatMember muvaffaqiyatsiz',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Tayyorgarlik ro‘yxati:\n' +
    '1️⃣ Meni guruh admini qiling, huquqlar:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, so‘ng meni o‘chiring va qayta qo‘shing\n' +
    '3️⃣ Nimadir yetishmasligini ko‘rish uchun /doctor ni ishga tushiring\n' +
    '4️⃣ Har bir mavzu mavzusida /bind <subdir> ni ishga tushiring va agentni boshlang\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 `{subdir}` ga bog‘landi',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} server',
  'binding.welcome.git': '• git: filial `{branch}`{detail}',
  'binding.welcome.git_clean': ', toza',
  'binding.welcome.git_dirty': ', tasdiqlanmagan o‘zgarishlar',
  'binding.welcome.git_none': '• git: boshlanmagan',
  'binding.welcome.start_prompt': 'Suhbatni boshlang:',

  'mcp.header': '🔌 *Ushbu mavzu uchun MCP serverlar:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP serverlar sozlanmagan.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Mavzuning belgilangan holati (Stage 7) mavjud bo‘lmaydi',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(bog‘lanish yo‘q)',

  'pair.success': '✅ Guruh bog‘landi. id: `{groupId}`. Bot endi bu supergruppaga xizmat qiladi.',
  'pair.locked':
    'ℹ️ Guruh id si `ALLOWED_GROUP_ID` orqali o‘rnatilgan — avto-bog‘lanish o‘chirilgan. ' +
    'Guruhni o‘zgartirish uchun o‘zgaruvchini o‘zgartiring va Bot ni qayta ishga tushiring.',
  'pair.only_forum': '❌ /pair faqat forum supergruppada ishlaydi (Topics ni yoqing).',
  'pair.not_admin': '❌ Faqat guruh administratori yoki yaratuvchisi Bot ni bog‘lay oladi.',
  'pair.not_paired': 'guruh hali bog‘lanmagan (pairing rejimi)',
  'pair.dm': "ℹ️ DM rejimida /pair kerak emas — Bot sizning shaxsiy chattingizga xizmat qiladi.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(mavjud emas)',
  'status.global_header': '📊 *Barcha mavzular* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Hali mavzular yo‘q.',
  'status.thread_report': 'Holat:\n\nAgent: {agent}\nJild: {subdir}\nSessiya: {session}',
  'status.thread_view': "Ko'rinish: {view}",
  'status.thread_model': 'Model: {model}',
  'status.thread_effort': 'Kuch: {effort}',
  'status.thread_started': 'Boshlangan: {started}',
  'status.thread_running': 'ishlamoqda',
  'status.thread_stopped': 'to‘xtatilgan',
  'status.thread_no_agent': 'yo‘q (/claude yoki /opencode ni ishga tushiring)',
  'status.thread_no_binding': '(bog‘lanish yo‘q — WORK_ROOT)',
  'status.thread_workdir': 'Ishchi jild: {workDir}',
  'status.thread_runtime_version': 'Ishlash versiyasi: {version}',
  'status.thread_context': 'Kontekst: {used} / {limit} token',
  'language.status': '🌐 Til: {display}',
  'language.set_success': '✅ Bu chat tili `{locale}` qilib o‘rnatildi.',
  'language.auto_success': '✅ Til avtomatik rejimga qaytarildi. Joriy: {display}.',
  'language.invalid': '⚠️ `{locale}` locale qo‘llab-quvvatlanmaydi. Mavjud: {locales}.',

  'timezone.status': '🌍 Vaqt mintaqasi: {zone} — hozir {now}',
  'timezone.usage':
    'Foydalanish: /timezone <IANA mintaqasi>  ·  /timezone +04:00  ·  /timezone auto\nYoki argumentsiz /timezone yuboring va ro‘yxatdan tanlang.',
  'timezone.set_success': '✅ Vaqt mintaqasi: {zone} — hozir {now}\nQayta hisoblangan jadvallar: {count}',
  'timezone.auto_success':
    '✅ Vaqt mintaqasi host mintaqasiga qaytarildi: {zone} — hozir {now}\nQayta hisoblangan jadvallar: {count}',
  'timezone.invalid':
    '⚠️ Noma’lum vaqt mintaqasi `{zone}`. IANA nomini (masalan, `Europe/Moscow`) yoki qat’iy siljishni (masalan, `+04:00`) kiriting. Ro‘yxatdan tanlash uchun /timezone yuboring.',
  'timezone.offset_unsupported':
    '⚠️ `{zone}` siljishini qo‘llab bo‘lmaydi — faqat butun soatli siljishlar ishlaydi. Buning o‘rniga mintaqangizning IANA nomini kiriting (masalan, +05:30 uchun `Asia/Kolkata`).',
  'timezone.fixed_offset_warning':
    '⚠️ Qat’iy siljish yozgi vaqtga ergashmaydi — yilning yarmida bir soat xato bo‘ladi.',
  'timezone.picker_regions': '🌍 Vaqt mintaqasi: {zone}\nHozir: {now}\n\nMintaqani tanlang:',
  'timezone.picker_zones': '🌍 {region} — {page}/{total}-sahifa',
  'timezone.picker_expired': 'Bu ro‘yxat eskirgan — /timezone ni qayta yuboring.',

  'agent.ready': '{label} `{subdir}`{argsSuffix} da tayyor\n{infoBlock}Xabar yuboring:',
  'agent.ready_model': '🧠 Model: {model}',
  'agent.no_session': 'Agent ishlamayapti. /claude yoki /opencode bilan boshlang.',
  'agent.session_ended': '{label}: seans tugadi',
  'agent.stopped': '{label} to‘xtatildi',
  'agent.exit_signal_sent': 'Ikki marta Ctrl+C yuborildi — {label} chiqmoqda',
  'agent.already_active': '{label} bu yerda allaqachon ishlamoqda. Xabar yuboring yoki /quit.',
  'agent.starting': '`{subdir}` da {label} boshlanmoqda…',
  'agent.queued_starting': '⏳ {label} hali boshlanmoqda — xabarizingiz navbatda va tayyor bo‘lgach yuboriladi.',
  'agent.question_hint': 'ℹ️ variant raqami bilan javob bering (masalan 1) yoki y/n. Shuningdek: /up /down harakat, /enter tasdiqlash, /c bekor qilish.',
  'agent.start_failed': '{label} ni boshlab bo‘lmadi: {error}',
  'agent.no_response': '⚠️ Agent so‘rovingizni qabul qildi, lekin javob berishni boshlamadi — sessiya qotib qolgan bo‘lishi mumkin. Qayta yuboring yoki yangi sessiya uchun /new.',
  'agent.session_restarting': '⚠️ Agent javob bermadi — sessiya qotib qolganga o‘xshaydi. Uni qayta ishga tushirib, so‘rovingizni qayta bajaraman…',
  'agent.session_recovering': '⚠️ Agent javob bermadi — tiklayapman (suhbatingiz saqlanadi) va so‘rovingizni qayta bajaraman…',
  'agent.question_cancelled_for_prompt': '⚠️ Oldingi savol bekor qilindi — yangi so‘rovingiz bajarilmoqda.',
  'agent.question_cancelled_msg_label': '❌ Savol bekor qilindi: {header}',
  'agent.login_code_relayed': '🔐 Kirish kodi Claude ga yuborildi — token xabari tarixdan o‘chirildi.',
  'agent.login_url': '🔐 Claude ga kirish uchun ushbu havolani oching, kirishni yakunlang va kodni shu yerga joylashtiring:\n{url}',
  'agent.login_success': '✅ Claude ga kirildi.',
  'agent.login_failed': '⚠️ Claude ga kirib bo‘lmadi. Qayta urinish uchun /login ni ishga tushiring.',
  'agent.workingIndicator': '{glyph} ishlamoqda…',
  'terminal.ready': '🖥 `{subdir}`{argsSuffix} da terminal tayyor\nHar bir xabar buyruq sifatida bajariladi. /c — Ctrl+C, /up /down — tarix, /tab — to‘ldirish, /quit — yopish.',

  'effort.choose': '⚙️ Joriy effort: {current}\nDarajani tanlang:',
  'effort.current_none': 'o‘rnatilmagan',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort: {effort}\nO‘zgartirish uchun /effort',
  'effort.invalid_level': '⚠️ `{level}` darajasi yaroqsiz. Mavjud: {valid}.',
  'effort.not_available': 'ℹ️ Joriy model uchun reasoning effort darajalari mavjud emas.',
  'effort.not_supported': 'ℹ️ `{model}` modelida reasoning effort darajalari yo‘q.',
  'effort.start_agent_first': 'ℹ️ Daraja saqlandi. Agent ishlamayapti — keyingi boshlashda qo‘llanadi.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` tozalandi: yangi `{model}` model uni qo‘llab-quvvatlamaydi.',
  'effort.unsupported_backend': '{label} uchun effort boshqaruvi qo‘llab-quvvatlanmaydi.',
  'effort.no_session': 'Agent ishlamayapti. /claude yoki /opencode bilan boshlang.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds}s o‘yladi',
  'thinking.choose': '☁️ Joriy thinking rejimi: {current}\nRejim tanlang:',
  'thinking.set_success': '✅ Thinking rejimi: {mode}',
  'thinking.invalid_mode': '⚠️ `{mode}` rejimi yaroqsiz. Mavjud: {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'qisqa',
  'thinking.mode.full': "to'liq",

  'toolResults.choose': '🔧 Joriy tool-natija rejimi: {current}\nRejim tanlang:',
  'toolResults.set_success': '✅ Tool-natija rejimi: {mode}',
  'toolResults.invalid_mode': '⚠️ `{mode}` rejimi yaroqsiz. Mavjud: {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'qisqa',
  'toolResults.mode.full': "to'liq",
  'toolResults.truncated_footer': '… (qisqartirilgan, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'vosita',

  'subagent.status_elapsed': '🤖 sub-agent: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sub-agent ishlamoqda …',
  'subagent.delegating_status': '🤖 Topshirilmoqda: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sub-agent',
  'subagent.choose': '🤖 Joriy sub-agent rejimi: {current}\nRejim tanlang:',
  'subagent.set_success': '✅ Sub-agent rejimi: {mode}',
  'subagent.invalid_mode': '⚠️ `{mode}` rejimi yaroqsiz. Mavjud: {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'qisqa',
  'subagent.mode.full': "to'liq",

  'verbosity.choose': "🔊 Chiqish — batafsillik: {current} · ko'rinish: {view}\n1-qator — oqim batafsilligi · 2-qator — bu mavzu nimani ko'rsatadi:",
  'verbosity.set_success': '✅ Chiqish batafsilligi: {mode} (thinking, tool-natijalar, sub-agentlar)',
  'verbosity.invalid_mode': "⚠️ `{mode}` noto'g'ri. Batafsillik darajalari: {valid}. Ko'rinishlar: {views}.",
  'verbosity.custom': 'maxsus (thinking: {thinking} · vositalar: {toolResults} · sub-agentlar: {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'qisqa',
  'verbosity.mode.full': "to'liq",
  'verbosity.view.stream': "To'liq oqim",
  'verbosity.view.streamAnswers': 'Oqim + javoblar',
  'verbosity.view.answers': 'Faqat javoblar',
  'verbosity.view_set_success': "✅ Bu mavzu ko'rsatadi: {view} (keyingi xabardan boshlab)",

  'model.set_success': '🧠 Model tanlandi: {model}',
  'model.saved_for_next_start': 'Model saqlandi: {model} — keyingi agent boshlashda qo‘llanadi.',
  'model.start_agent_first': 'Faol seans yo‘q. Avval agentni boshlang.',
  'model.current_default': 'standart',
  'model.none_available': '🧠 Joriy: {current}\n\nMavjud model yo\'q. /model <provider/model> orqali qo\'lda tanlang.',
  'model.invalid_number': '❌ Raqam noto\'g\'ri. Ro\'yxatni ko\'rish uchun /model ni ishga tushiring.',
  'model.pick_provider': '🧠 Joriy: {current}\n\nProvayderni tanlang:',
  'model.all_hidden': '🧠 Joriy: {current}\n\nBarcha provayderlar yashirilgan. Birini qaytarish uchun 👁 ni bosing.',
  'model.hidden_header': '🙈 Bu ro\'yxatdan yashirilgan — qaytarish uchun 👁 ni bosing.',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ provayderlar',
  'model.prev_button': '⬅️ Oldingi',
  'model.next_button': 'Keyingi ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} ta model · sahifa {page}/{totalPages}\nJoriy: {current}',
  'model.page_hint': 'Tanlash uchun raqam bilan javob bering yoki qidirish uchun /model <nom>.',
  'model.page_hint_buttons_only': 'Almashtirish uchun modelni bosing yoki qidirish uchun /model <nom>.',

  'disconnect.unsupported_backend': 'Bu buildda OpenCode provayderini uzish mavjud emas.',
  'disconnect.invalid_provider': '❌ Provayder id noto\'g\'ri: {provider}. Masalan: /disconnect openrouter',
  'disconnect.no_providers': 'Uziladigan provayder yo\'q.',
  'disconnect.pick_provider': 'Uzish uchun provayderni tanlang — uning saqlangan hisob ma\'lumotlari o\'chiriladi:',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ {provider} provayderi uzildi — saqlangan hisob ma\'lumotlari o\'chirildi.',
  'disconnect.still_active_env': '⚠️ {provider} uchun saqlangan hisob ma\'lumotlari o\'chirildi, lekin u hali ham faol: OpenCode uni muhit o\'zgaruvchisi orqali yoqadi. O\'sha o\'zgaruvchini olib tashlang va OpenCode ni qayta ishga tushiring yoki /model orqali ro\'yxatdan yashiring.',
  'disconnect.failed': '⚠️ {provider} ni uzib bo\'lmadi: {reason}',

  'rename_session.usage': 'Foydalanish: /rename_session <yangi sarlavha>',
  'rename_session.start_agent_first': 'Faol seans yo‘q. Avval agentni boshlang (/claude yoki /opencode).',
  'rename_session.unsupported_backend': '{label} uchun seans nomini o‘zgartirish qo‘llab-quvvatlanmaydi.',
  'rename_session.success': '✅ Seans nomi o‘zgartirildi: {title}',
  'rename_session.failed': '⚠️ Seans nomini o‘zgartirib bo‘lmadi: {reason}',

  'compact.started': '🧹 Seans konteksti siqilmoqda — agent qisqa mazmundan davom etadi.',
  'compact.done': '✅ Kontekst siqildi.',
  'compact.done_tokens': '✅ Kontekst siqildi: {pre} → {post} token.',
  'compact.summaryHeader': '📄 Siqish xulosasi:',
  'compact.start_agent_first': 'Faol seans yo‘q. Avval agentni boshlang (/claude yoki /opencode).',
  'compact.unsupported_backend': '{label} uchun kontekstni siqish qo‘llab-quvvatlanmaydi.',
  'compact.model_unresolved': '⚠️ Siqib bo‘lmaydi: bu seans uchun model aniqlanmadi. /model bilan tanlang va qayta urinib ko‘ring.',
  'compact.failed': '⚠️ Seans kontekstini siqib bo‘lmadi: {reason}',
  'compact.busy': '⚠️ Agent hozir band — joriy navbat tugagach /compact ni qayta ishga tushiring.',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN UZBEK: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 Bo‘sh turganda kesh orqali tokenlarni tejash uchun avtomatik siqildi.\nO‘chirish uchun /compact_on_idle ni ishga tushiring.',
  'compactOnIdle.on': 'YONIQ',
  'compactOnIdle.off': 'O‘CHIQ',
  'compactOnIdle.title': '🧹 Bu mavzu uchun bo‘sh turganda avtosiqish: {state}\n\nSeans ~55 daqiqa bo‘sh tursa, tokenlarni tejash uchun uning konteksti avtomatik siqiladi (prompt keshi hali iliq).\n\nBarcha mavzular uchun bir vaqtda o‘zgartirish uchun buni General mavzusida ishga tushiring.',
  'compactOnIdle.titleGeneral': '🧹 Bo‘sh turganda avtosiqish — BARCHA mavzular uchun standart: {state}\n\nSeans ~55 daqiqa bo‘sh tursa, tokenlarni tejash uchun uning konteksti avtomatik siqiladi.\n\nHar bir mavzu buni o‘zining /compact_on_idle bilan bekor qila oladi.',
  'compactOnIdle.enableButton': 'Yoqish',
  'compactOnIdle.disableButton': 'O‘chirish',
  'compactOnIdle.setThisTopic': '✅ Bo‘sh turganda avtosiqish: bu mavzu uchun {state}.',
  'compactOnIdle.setGlobal': '✅ Bo‘sh turganda avtosiqish: BARCHA mavzular uchun {state} (mavzu bo‘yicha bekor qilishlar amal qiladi).',
  'compactOnIdle.unsupported': 'Bo‘sh turganda avtosiqish faol agent seansiga taalluqli. Avval bog‘langan mavzuda /claude yoki /opencode ni ishga tushiring.',
  'compactOnIdle.pendingQuestionReask': '❓ Sizda hali javob berilmagan savol bor. Javob berib davom etish uchun variantni bosing:',
  'compactSummary.on': 'YONIQ',
  'compactSummary.off': "O‘CHIQ",
  'compactSummary.title':
    '📄 Bu mavzuga siqish xulosasini joylash: {state}\n\nSiqishdan keyin agentning to‘liq xulosasi mavzuga yoziladi, shunda nima saqlanganini ko‘rasiz.\n\nBarcha mavzular uchun birdan almashtirish uchun buni General mavzusida bajaring.',
  'compactSummary.titleGeneral':
    '📄 Siqish xulosasini joylash — BARCHA mavzular uchun standart: {state}\n\nSiqishdan keyin agentning to‘liq xulosasi mavzuga yoziladi, shunda nima saqlanganini ko‘rasiz.\n\nHar bir mavzu buni o‘z /compact_summary bilan almashtira oladi.',
  'compactSummary.enableButton': 'Yoqish',
  'compactSummary.disableButton': "O‘chirish",
  'compactSummary.setThisTopic': '✅ Siqish xulosasi: bu mavzu uchun {state}.',
  'compactSummary.setGlobal': '✅ Siqish xulosasi: BARCHA mavzular uchun {state} (mavzu bo‘yicha almashtirishlar kuchda qoladi).',
  'compactSummary.unsupported': 'Shellda siqiladigan kontekst yo‘q, shuning uchun joylanadigan xulosa ham yo‘q.',

  'autoContinueLimits.on': 'YONIQ',
  'autoContinueLimits.off': 'O‘CHIQ',
  'autoContinueLimits.title': '🚧 Bu mavzu uchun foydalanish limitidan keyin avtodavom: {state}\n\nAgent foydalanish yoki seans limitiga yetganda, bot oyna qayta tiklanishini kutadi va so‘ng agentga o‘zi davom etishni aytadi (davom etish xabari pinlanadi, shuning uchun ovozi o‘chirilgan mavzuda ham bildirishnoma keladi).\n\nBarcha mavzular uchun bir vaqtda o‘zgartirish uchun buni General mavzusida ishga tushiring.',
  'autoContinueLimits.titleGeneral': '🚧 Foydalanish limitidan keyin avtodavom — BARCHA mavzular uchun standart: {state}\n\nAgent foydalanish yoki seans limitiga yetganda, bot oyna qayta tiklanishini kutadi va so‘ng agentga o‘zi davom etishni aytadi.\n\nHar bir mavzu buni o‘zining /auto_continue_limits bilan bekor qila oladi.',
  'autoContinueLimits.enableButton': 'Yoqish',
  'autoContinueLimits.disableButton': 'O‘chirish',
  'autoContinueLimits.skipButton': '⏭ Bir marta o‘tkazish',
  'autoContinueLimits.skipDone': 'Bu davom etish o‘tkazib yuborildi.',
  'autoContinueLimits.skipExpired': 'O‘tkazadigan narsa yo‘q — bu kutish allaqachon tugagan.',
  'autoContinueLimits.skippedNotice': '⏭ O‘tkazib yuborildi: bu safar o‘zim davom ettirmayman. Qachon davom etishni yozing — bu mavzu uchun avtodavom yoniq qoladi.',
  'autoContinueLimits.noticeHint': 'Shu bitta davom etishni o‘tkazib yuborish yoki bu mavzu uchun avtodavomni o‘chirish uchun /auto_continue_limits ni ishga tushiring.',
  'autoContinueLimits.setThisTopic': '✅ Foydalanish limitidan keyin avtodavom: bu mavzu uchun {state}.',
  'autoContinueLimits.setGlobal': '✅ Foydalanish limitidan keyin avtodavom: BARCHA mavzular uchun {state} (mavzu bo‘yicha bekor qilishlar amal qiladi).',
  'autoContinueLimits.limitReachedDisabled': '🚧 Foydalanish limitiga yetildi. Bu mavzu uchun avtodavom o‘chirilgan, shuning uchun kutaman — qachon davom etishni yozing (avtomatik davom etish uchun /auto_continue_limits on).',

  'connect.prompt_key': '🔑 Keyingi xabar sifatida `{provider}` uchun API kalitni yuboring. Kalit xabarini tarixdan o‘chiraman.',
  'connect.empty_key': '❌ API kalit bo‘sh. Keyingi xabar sifatida kalitni yuboring.',
  'connect.invalid_key': '❌ Bu API kalitiga o‘xshamaydi (unda bo‘shliqlar yoki lotin bo‘lmagan belgilar bor). Keyingi xabar sifatida faqat kalitni yuboring yoki /connect ni qayta ishga tushiring.',
  'connect.invalid_provider': '❌ Yaroqsiz provayder id `{provider}`. Misol: /connect openai',
  'connect.unsupported_provider': '⚠️ `{provider}` provayderi ushbu oqim orqali oddiy API-kalit kirishini qo‘llab-quvvatlamaydi. Ushbu provayder uchun OpenCode UI/CLI dan foydalaning.',
  'connect.unsupported_backend': 'Ushbu build da OpenCode provayder autentifikatsiyasi mavjud emas.',
  'connect.failed': '⚠️ `{provider}` ulanmadi: {reason}',
  'connect.success': '✅ Provayder `{provider}` ulandi. OpenCode server qayta ishga tushirilmadi.',
  'connect.cancelled': 'API kalit kiritish bekor qilindi.',
  'connect.pick_method': '`{provider}` ni qanday ulash kerak? Usulni tanlang:',
  'connect.no_methods': '⚠️ `{provider}` uchun autentifikatsiya usullari topilmadi.',
  'connect.oauth_device': '🔓 `{provider}` ni ulash uchun: {url} ni oching va `{code}` kodini kiriting, so‘ng tasdiqlang. Serverda *headless* usulidan foydalaning. Tugagach shu yerda xabar beraman.',
  'connect.oauth_url_only': '🔓 `{provider}` ni ulash uchun: {url} ni oching va kirishni yakunlang. Tugagach shu yerda xabar beraman.',
  'connect.oauth_paste': '🔑 Tasdiqlagach, kodni keyingi xabar sifatida shu yerga joylang — uni tarixdan o‘chiraman.',
  'connect.oauth_waiting': '⏳ Avtorizatsiya kutilmoqda…',
  'connect.oauth_loopback': '🔑 Tasdiqlagandan so‘ng brauzeringiz yuklanmaydigan `localhost` sahifasini ochishga urinadi — bu yerda bu normal holat. O‘sha URL manzilini manzil satridan nusxalab, keyingi xabar sifatida joylang (yoki faqat `code` qiymatini). Men uni tarixdan o‘chiraman va kirishni yakunlayman.',
  'connect.oauth_invalid_reply': '❌ Bu na callback URL ga, na avtorizatsiya kodiga o‘xshaydi. Tasdiqlagandan so‘ng brauzeringizdan `localhost` callback URL manzilini joylang (yoki `code` qiymatini).',
  'connect.oauth_callback_no_flow': '⚠️ Bu OAuth callback URL ga o‘xshaydi, lekin hozir bu yerda kirish jarayoni yo‘q — men uni o‘chirdim. Qaytadan boshlash uchun /connect ni ishga tushiring.',
  'connect.oauth_success': '✅ `{provider}` OAuth orqali ulandi. OpenCode server credentiallari yangilandi.',
  'connect.oauth_failed': '⚠️ `{provider}` uchun OAuth kirish yakunlanmadi. /connect ni qayta ishga tushiring.',
  'quit_all.none_active': 'Ishlayotgan agentlar yo‘q — to‘xtatishga hech narsa yo‘q.',
  'quit_all.summary': '🚪 {total} faol agentdan {stopped} to‘xtatildi.',
  'quit_all.general_only': '`/quit-all` faqat General mavzusida mavjud.',

  'clearMessages.summary':
    '🗑 {total} dan {deleted} xabar o‘chirildi. ' +
    'Telegram 48 soatdan eski xabarlarni o‘chirishdan bosh tortadi — qolgani tarixda qoladi.',
  'clearMessages.no_messages': 'Bu mavzuda o‘chirish uchun xabarlar yo‘q.',

  'edited.hint':
    '✏️ Men tahrirlangan xabarlarni yangi kirish deb hisoblamayman — tuzatishni alohida xabar sifatida yuboring.',

  'voice.no_api_key':
    'Ovoz uchun `GROQ_API_KEY` (bepul) yoki `OPENAI_API_KEY` kerak.',
  'voice.failed': 'Ovoz xabarini transkripsiya qilib bo‘lmadi.',
  'voice.retrying': '⚠️ Ovoz xabarini transkripsiya qilib bo‘lmadi ({error}). {seconds} soniyadan keyin qayta urinaman…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Fayl Bot API cheklovini ({cap} MB) oshdi — uni yuklab ololmayman. Kichikroq fayl yuboring.',
  'file.download_failed': '📎 Faylni yuklab bo‘lmadi. Qayta urinib ko‘ring.',

  'error.workdir.gone':
    '📁 `{subdir}` papkasi diskdan g‘oyib bo‘ldi. /bind <newdir> ni ishga tushiring.',
  'error.tg.thread.deleted':
    '⚠️ Mavzu Telegram da o‘chirildi; bog‘lanish tozalandi.',
  'error.tg.thread.closed':
    '🔒 {key} mavzusi yopiq — Telegram klientingizda qayta oching yoki butunlay o‘chiring.',
  'error.tg.perm.delete':
    '🔐 Xabarlarni o‘chira olmayman. Bot ga `can_delete_messages` bering.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` yetishmayapti. Meni guruh admini qiling.',
  'error.state.corrupted':
    '⚠️ state.json buzilgan edi; bog‘lanishlar qayta o‘rnatildi. Kerak bo‘lsa /buy ni qayta ishga tushiring.',
  'error.start_in_general':
    'General da agentni boshlab bo‘lmaydi — bu xizmat mavzusi. Mavzu mavzusini oching.',

  'cb.access_denied': 'Kirish rad etildi',
  'cb.bind_only_topical': '/bind faqat mavzu mavzularida ishlaydi',
  'cb.binding_to': '{subdir} ga bog‘lanmoqda…',
  'cb.no_active_session': 'Faol seans yo‘q',
  'cb.model_error': 'Xato: {error}',
  'cb.model_set': 'Model: {model}',
  'cb.model_provider_gone': 'Bu provayder endi yo\'q — /model ni qayta ishga tushiring',
  'cb.model_hidden': 'Yashirildi: {provider}',
  'cb.model_shown': 'Ko\'rsatildi: {provider}',
  'cb.disconnect_expired': 'Bu uzish menyusi eskirdi — /disconnect ni qayta ishga tushiring',
  'cb.not_supported': '{label} uchun qo‘llab-quvvatlanmaydi',
  'cb.unknown_agent': 'Noma‘lum agent',
  'cb.agent_switched': '{label} ga almashtirildi',
  'cb.resume_only_topical': 'Resume faqat mavzu mavzularida ishlaydi',
  'cb.bind_folder_first': 'Avval /buy bilan papkani bog‘lang',
  'cb.agent_not_running': 'Agent ishlamayapti',
  'cb.no_pending_question': 'Kutilayotgan savol yo‘q',
  'cb.connect_method_expired': 'Bu ulanish menyusi eskirdi — /connect ni qayta ishga tushiring',
  'cb.invalid_option': 'Yaroqsiz variant',
  'cb.sent_option': 'Yuborildi: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Xato: {error}',
  'cb.claudeMode_already': 'Allaqachon faol',
  'cb.claudeMode_switching': 'Almashtirilmoqda…',
  'claudeMode.pick': '⚙️ Claude Code backend — joriy: {label}\nBackend tanlang (almashtirish bir xil suhbatni saqlaydi):',
  'claudeMode.not_claude': "Bu mavzu Claude Code da emas — /claude_mode faqat Claude backend ini almashtiradi.",
  'claudeMode.already': 'Allaqachon {label}.',
  'claudeMode.set_idle': '⚙️ Claude backend: {label} — keyingi boshlashda qo‘llanadi.',
  'claudeMode.switched_resumed': '⚙️ {label} ga almashtirildi — bir xil suhbat davom etdi.',
  'claudeMode.switched_fresh': '⚙️ {label} ga almashtirildi — yangi seans boshlandi.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Xato: {error}',
  'cb.toolresults_set': 'Tool-natijalar: {mode}',
  'cb.toolresults_error': 'Xato: {error}',
  'cb.subagent_set': 'Sub-agentlar: {mode}',
  'cb.subagent_error': 'Xato: {error}',
  'cb.verbosity_set': 'Chiqish batafsilligi: {mode}',
  'cb.verbosity_error': 'Xato: {error}',
  'cb.view_set': "Bu mavzu ko'rsatadi: {view}",

  'session.list_header': 'Davom ettiriladigan seanslar ({label}):',
  'session.list_footer': 'Davom ettirish 1–{max} · chiqish 0',
  'session.none': 'Bu papkada davom ettiriladigan seanslar yo‘q.',
  'session.cancelled': 'Bekor qilindi. Seans tanlovchi yopildi.',
  'session.invalid': 'Yaroqsiz raqam. 1 dan {max} gacha qiymat kiriting.',
  'session.resumed': 'Seans davom etdi. Xabaringizni yuboring:',
  'session.resume_failed': 'Seansni davom ettirib bo‘lmadi: {error}',
  'session.expired': 'Seans ro‘yxati eskirgan. /sessions ni qayta ishga tushiring.',
  'session.load_failed': 'Seanslarni yuklab bo‘lmadi.',

  'resume.context_header': '↩️ Davom etdi — oxirgi {count} xabar:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot offlayn bo‘lganda {count} xabar o‘tkazib yuborildi. Seansdan eng so‘nggisi:',
  'recap.restartedFallbackHeader': '🔄 Bot qayta ishga tushirildi. Seansdan eng so‘nggisi:',
  'recap.stillWorkingLine': '⏳ Agent hali ishlamoqda…',

  'trace.onThisThreadReply': '🔎 Ushbu mavzu uchun trace yoqildi.',
  'trace.offThisThreadReply': '🔎 Ushbu mavzu uchun trace o‘chirildi.',
  'trace.onAllThreadsReply': '🔎 Barcha mavzular uchun trace yoqildi.',
  'trace.offAllThreadsReply': '🔎 Hamma joyda trace o‘chirildi («all» flagi va mavzu ro‘yxati tozalandi).',
  'trace.statusReply':
    '🔎 Trace — bu mavzu: {thisThread}\nBarcha mavzular: {allThreads}\nTraced mavzular: {count}',
  'trace.statusOnLabel': 'yoqilgan',
  'trace.statusOffLabel': "o'chirilgan",
  'trace.usageHint': 'Foydalanish: /trace on | off | on all | off all | (argsiz — holat)',

  'timestamps.onReply':
    '🕐 Vaqt belgilari yoqildi: agentga yuborilgan har bir prompt yuqori qatorga yuborish vaqtini oladi (mavzuga post qilinmaydi).',
  'timestamps.offReply': '🕐 Bu mavzu uchun vaqt belgilari o‘chirildi.',
  'timestamps.statusOnReply': '🕐 Vaqt belgilari: bu mavzu uchun yoqilgan.',
  'timestamps.statusOffReply': '🕐 Vaqt belgilari: bu mavzu uchun o‘chirilgan.',
  'timestamps.usageHint': 'Foydalanish: /timestamps on | off | (argsiz — holat)',

  'schedule.fired':
    '⏰ Reja «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — {time} da o‘tkazib yuborildi, qazib olinmoqda',
  'schedule.checkFailed':
    '🚨 «{name}» tekshiruvi o‘tmadi: {failure} ({schedule}){missedNote}\n$ {command}\n\n{output}\n\nAgentni uyg‘otyapman. Tekshiruv yana o‘tmaguncha boshqa ogohlantirish bo‘lmaydi.',
  'schedule.checkRecovered': '✅ «{name}» tekshiruvi yana o‘tmoqda.',
  'schedule.pausedUnbound':
    '⏸ Pauzadagi rejalalar: {count} — mavzu papkasidan uzildi. /buy ularni qaytaradi.',
  'schedule.resumedRebind': '▶️ Rejalar davom etdi: {count} (keyingi ishga tushirish hozirdan qayta hisoblanadi).',
  'schedule.noAgent':
    "⚠️ Hech narsa rejalashtirilmadi — bu mavzuda hech qanday agent ishlamayapti, shuning uchun rejalashtirilgan ishga tushirish uchun hech narsa bo'lmaydi. Avval /claude yoki /opencode ni ishga tushiring.",
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN UZBEK what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN UZBEK what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN UZBEK what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': 'har kuni {time}da',
  'reminders.scheduleWeekdays': 'ish kunlari {time}da',
  'reminders.scheduleWeekly': '{weekday} {time}da',
  'reminders.scheduleMonthly': 'har oyning {dayOfMonth}-kuni {time}da',
  'reminders.scheduleOnce': '{date} {time}da',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': 'bugun {time}da',
  'reminders.nextRunTomorrow': 'ertaga {time}da',
  'reminders.nextRunOnDate': '{date} {time}da',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 Eslatmalar',
  'reminders.hubEmptyLine': 'Hozircha eslatma yo‘q.',
  'reminders.hubActiveLine': 'Faol: {count}',
  'reminders.hubLimitLine':
    'Faol: {count} — {limit} chegarasiga yetildi. Yangisini qo‘shish uchun bittasini o‘chiring.',
  'reminders.addButton': '➕ Qo‘shish',
  'reminders.listButton': '📋 Ro‘yxat ({count})',
  'reminders.closeButton': '✕ Yopish',
  'reminders.closedNotice': '🔔 Eslatmalar yopildi.',
  'reminders.listTitle': '📋 Eslatmalar ({count})',
  'reminders.listPageLine': '{page}/{total}-sahifa',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ Oldingi',
  'reminders.listNextButton': 'Keyingi ›',
  'reminders.listBackToHubButton': '‹ Orqaga',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'Qachon: {schedule}',
  'reminders.cardText': 'Matn: «{text}»',
  'reminders.cardNext': 'Keyingi: {next}',
  'reminders.cardDeleteButton': '🗑 O‘chirish',
  'reminders.cardBackToListButton': '‹ Ro‘yxatga',
  'reminders.createdTitle': '✅ Eslatma yaratildi',
  'reminders.doneListButton': '📋 Ro‘yxat',
  'reminders.wizardTitle': '🔔 Yangi eslatma',
  'reminders.pickRepeat': 'Takrorlash: {value}',
  'reminders.pickDate': 'Sana: {value}',
  'reminders.pickWeekday': 'Hafta kuni: {value}',
  'reminders.pickDayOfMonth': 'Oyning kuni: {value}',
  'reminders.pickTime': 'Vaqt: {value}',
  'reminders.pickText': 'Matn: «{value}»',
  'reminders.stepRepeatQuestion': 'QADAM 1/4 · Qanchalik tez-tez?',
  'reminders.stepDateQuestion': 'QADAM 2/4 · Qaysi kun?',
  'reminders.stepDateGridQuestion': 'QADAM 2/4 · Sanani tanlang:',
  'reminders.stepWeekdayQuestion': 'QADAM 2/4 · Haftaning qaysi kuni?',
  'reminders.stepDayOfMonthQuestion': 'QADAM 2/4 · Oyning qaysi kuni?',
  'reminders.stepDayOfMonthGridQuestion': 'QADAM 2/4 · Oyning kunini tanlang:',
  'reminders.stepTimeQuestion': 'QADAM 3/4 · Soat nechada?',
  'reminders.stepHourQuestion': 'QADAM 3/4 · Soatni tanlang:',
  'reminders.stepMinuteQuestion': 'QADAM 3/4 · {hour}:__ — daqiqalarni tanlang:',
  'reminders.stepTextQuestion':
    'QADAM 4/4 · Eslatma matnini yuboring — yozing yoki ovozli xabar qoldiring.',
  'reminders.repeatOnceButton': 'Bir marta',
  'reminders.repeatDailyButton': 'Har kuni',
  'reminders.repeatWeekdaysButton': 'Ish kunlari',
  'reminders.repeatWeeklyButton': 'Har hafta',
  'reminders.repeatMonthlyButton': 'Har oy',
  'reminders.dateTodayButton': 'Bugun',
  'reminders.dateTomorrowButton': 'Ertaga',
  'reminders.dateOtherButton': '✏️ Boshqa sana…',
  'reminders.dayOfMonthOtherButton': '✏️ Boshqa kun…',
  'reminders.timeOtherButton': '🕐 Boshqa vaqt',
  'reminders.backButton': '‹ Orqaga',
  'reminders.cancelButton': '✕ Bekor qilish',
  'reminders.weekdayMondayButton': 'Dush',
  'reminders.weekdayTuesdayButton': 'Sesh',
  'reminders.weekdayWednesdayButton': 'Chor',
  'reminders.weekdayThursdayButton': 'Pay',
  'reminders.weekdayFridayButton': 'Jum',
  'reminders.weekdaySaturdayButton': 'Shan',
  'reminders.weekdaySundayButton': 'Yak',
  'reminders.errorPastTime':
    '⚠️ Bu vaqt allaqachon o‘tib ketdi. Keyinroq vaqtni tanlang yoki orqaga qaytib kunni o‘zgartiring.',
  'reminders.errorInvalidDate': '⚠️ Bunday sana mavjud emas. Boshqasini tanlang.',
  'reminders.errorInvalidTime':
    '⚠️ O‘sha kunda bunday vaqt yo‘q — soat o‘zgaradi. Boshqa vaqtni tanlang.',
  'reminders.errorTextTooLong':
    '⚠️ Matn juda uzun (ko‘pi bilan {limit} belgi) va saqlanmadi. Qisqarog‘ini yuboring.',
  'reminders.cancelledNotice': '✕ Bekor qilindi',
  'reminders.expiredNotice': '✕ Muddati tugadi — eslatma matni kelmadi.',
  'reminders.capReachedNotice':
    '⚠️ Bu mavzuda allaqachon {limit} ta eslatma bor — yangisini qo‘shishdan oldin bittasini o‘chiring.',
  'reminders.wizardExpiredCbAnswer': 'Bu ekran eskirgan — /reminders ni qayta ishga tushiring.',
  'reminders.deletedCbAnswer': '🗑 O‘chirildi',
  'reminders.deleteGoneCbAnswer': 'Allaqachon o‘chirilgan.',
  'reminders.cardExpiredCbAnswer': 'Bu eslatma endi yo‘q.',

  'apiRetry.transientNotice':
    '⏳ API tezlik bilan cheklangan — {minutes} daqiqadan keyin avtomatik qayta urinish (urinish {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Foydalanish chegarasiga yetdi — {minutes} daqiqadan keyin qayta urinish (urinish {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Foydalanish chegarasiga yetdi — reset dan keyin avtomatik davom etish (~{time}).',
  'apiRetry.resuming': '↻ Davom etilmoqda…',
  'apiRetry.limitResetResuming': '✅ Limit oynasi qayta tiklandi — bu mavzudagi ishni davom ettiraman.',
  'apiRetry.giveUp':
    '⚠️ {attempts} urinishdan keyin davom etib bo‘lmadi. Davom ettirishda xabar yuboring.',
  'apiRetry.continueNudge': "To'xtagan joyingizdan davom eting.",
  'apiRetry.loggedOutClaude':
    '⚠️ Claude tizimdan chiqdi — davom etish uchun /login ni ishga tushiring.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: yaroqsiz e\'tilbar ma\'lumotlar — opencode serverini qayta ishga tushiring.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Tayyor — bot tredlari va guruh mavzularidagi xabarlarni qayta ishlay olaman.',
  'startup.header_not_ready':
    '⚠️ Sozlash tugallanmagan. Men bilan ishlashni boshlash uchun quyidagi qadamlarni bajaring:',
  'startup.item.create_group':
    'Mavzular (Topics) yoqilgan forum superguruhini yarating, so‘ng uni bog‘lash uchun u yerda menga xabar yuboring.',
  'startup.item.grant_admin':
    'Meni quyidagi huquqlar bilan administrator qiling: {missing}.',
  'startup.item.bind_topic':
    'Mavzu yarating va uni /bind buyrug‘i bilan papkaga bog‘lang.',
  'startup.item.install_agent':
    'Agent CLI o‘rnating — claude yoki opencode.',
  'startup.item.optional_groq':
    '(ixtiyoriy) Ovozli kiritishni yoqish uchun .env fayliga GROQ_API_KEY qo‘shing va qayta ishga tushiring.',
  'startup.item.optional_owner':
    '(ixtiyoriy) Ushbu holatni shaxsiy chatingizda olish uchun OWNER_USER_ID ni belgilang.',
  'requests.alert.notAnsweringNotice': '⚠️ {requestId} so‘roviga javob berilmadi: agent javob bermay navbatlarini yakunladi va eslatmalar to‘xtatildi. Ushbu mavzudagi seansni tekshiring.',
  'requests.alert.unreachableNotice': '⚠️ {requestId} so‘roviga javob berilmadi: eslatma yuborish uchun agent seansiga ulanib bo‘lmadi. Ushbu mavzudagi seansni tekshiring.',
  'requests.limit.answerAfterResetNotice': '🚧 Foydalanish limitiga yetildi — javob {time} dan keyin keladi.',
  'requests.limit.answerNextAttemptNotice': '🚧 Foydalanish limitiga yetildi — keyingi urinish {time} da.',
};
