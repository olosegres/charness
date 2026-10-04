// Machine-translated from en. Native review welcome.

export const kaDict: Record<string, string> = {
  'access.denied': 'წვდომა უარყოფილია.',
  'access.group_only': 'მე მხოლოდ კონფიგურირებულ ფორუმ სუპერჯგუფში ვმუშაობ.',

  'thread.no_binding':
    '📁 ეს თემა არ არის დაკავშირებული საქაღალდესთან. გამოიყენეთ /bind <subdir> ან აირჩიეთ სიიდან.',
  'thread.bind_required':
    '📁 ჯერ დააკავშირეთ საქაღალდე: /bind <subdir>. აგენტი მუშაობს მხოლოდ დაკავშირებულ საქაღალდეში.',
  'thread.bound': '📁 დაკავშირებულია `{subdir}`-თან.\nგაუშვით /claude ან /opencode.',
  'thread.unbound': '📁 კავშირი მოხსნილია.',
  'thread.general_no_agent':
    'General არ არის დაკავშირებული საქაღალდესთან — გადადით თემატურ თემაში აგენტთან სასაუბროდ.',
  'thread.welcome_bound':
    '👋 თემა შეიქმნა და ავტომატურად დაკავშირდა `{subdir}`-თან (თემის სახელი ემთხვევა ქვესაქაღალდეს).\nგაუშვით /claude ან /opencode.',
  'thread.welcome_pick':
    '👋 თემა შეიქმნა. დააკავშირეთ საქაღალდე: /bind <subdir>, ან აირჩიეთ ქვემოდან.',
  'thread.bind_collision':
    '⚠️ საქაღალდე `{subdir}` უკვე გამოიყენება თემების მიერ: {threads}.\nკავშირი დამატებულია; სესიები დარჩენილია დამოუკიდებელი (საკუთარი tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 საქაღალდე `{subdir}` დაკავშირებულია. გაუშვით /claude ან /opencode დიალოგის დასაწყებად.',

  'bind.usage': 'გამოყენება: /bind <subdir>\nმაგალითი: /bind overview',
  'bind.current': '📂 მიმდინარე კავშირი: `{subdir}`',
  'bind.current_none': '📂 ჯერ არ არის დაკავშირებული',
  'bind.in_general': '/bind მუშაობს მხოლოდ თემატურ თემებში, General-ში არა.',
  'bind.invalid_chars': '❌ საქაღალდის სახელი არ უნდა შეიცავდეს კონტროლის სიმბოლოებს.',
  'bind.not_found': '❌ საქაღალდე `{subdir}` ვერ მოიძებნა `WORK_ROOT`-ის ქვეშ (`{workRoot}`).',
  'bind.outside_root': '❌ ბილიკი გადადის `WORK_ROOT`-ის ფარგლებს გარეთ.',
  'bind.not_directory': '❌ `{subdir}` არსებობს, მაგრამ საქაღალდე არ არის.',

  'bind.leave_button': '⬅️ მიმდინარე დირექტორიის დატოვება',
  'bind.create_button': '➕ ახალი საქაღალდის შექმნა',
  'bind.create_prompt':
    '✏️ გამოგვიგზავნეთ ახალი საქაღალდის სახელი (შეიქმნება `WORK_ROOT`-ის ქვეშ). ნებისმიერი ბრძანება აუქმებს.',
  'bind.create_cb': 'ახალი საქაღალდის შექმნა…',
  'bind.create_empty': '❌ სახელი ცარიელია. გამოგვიგზავნეთ საქაღალდის სახელი.',
  'bind.create_separator': '❌ სახელი არ უნდა შეიცავდეს `/` ან `\\`. გამოგვიგზავნეთ მარტივი სახელი.',
  'bind.create_dot_segment': '❌ `.` და `..` არ შეიძლება გამოყენებულ იქნას როგორც საქაღალდის სახელი.',
  'bind.create_hidden': '❌ სახელი არ უნდა იწყებოდეს წერტილით.',
  'bind.create_invalid_chars': '❌ საქაღალდის სახელი არ უნდა შეიცავდეს კონტროლის სიმბოლოებს.',
  'bind.create_exists': '📁 საქაღალდე `{subdir}` უკვე არსებობს — მიმდინარეობს დაკავშირება.',
  'bind.create_failed': '❌ საქაღალდის შექმნა ვერ მოხერხდა: {error}',

  'ls.header': '📁 `{workRoot}`-ის ქვესაქაღალდეები:',
  'ls.empty': '📁 `WORK_ROOT`-ის ქვეშ დასაკავშირებელი ქვესაქაღალდეები არ არის.',
  'list.header': '🧵 თემების კავშირები ({count}):',
  'list.empty': '🧵 ჯერ კავშირები არ არის. შექმენით თემა და გაუშვით /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new მუშაობს დაკავშირებულ თემაში — გახსენით თემა და გაუშვით /new მისი აგენტის სესიის გადასატვირთად.',

  'help.general':
    '*ბრძანებები General-ში:*\n' +
    '/ls — `WORK_ROOT` ქვესაქაღალდეების სია\n' +
    '/list — თემების სია\n' +
    '/status — ყველა თემის სტატუსი\n' +
    '/quitall — ყველა მომუშავე აგენტის გამორთვა\n' +
    '/whoami /version — გამართვა\n\n' +
    'აგენტთან სასაუბროდ — გახსენით თემატური თემა.',
  'help.thread_unbound':
    '*თემა არ არის დაკავშირებული საქაღალდესთან.*\n' +
    '/bind <subdir> — დაკავშირება (ან სიიდან არჩევა)\n' +
    '/ls — `WORK_ROOT` ქვესაქაღალდეები (General-ში)',
  'help.thread_bound':
    '*თემა დაკავშირებულია `{subdir}`-თან.*\n' +
    '/claude /opencode — აგენტის გაშვება\n' +
    '/connect — OpenCode პროვაიდერის API გასაღების დაკავშირება (ნაგულისხმევად OpenAI)\n' +
    '/disconnect — პროვაიდერის შენახული სერთიფიკატების წაშლა\n' +
    '/terminal — shell-ის გახსნა ამ საქაღალდეში\n' +
    '/new — სესიის გადატვირთვა (ძველი → /sessions)\n' +
    '/model /sessions — გადართვა\n' +
    '/effort — reasoning effort დონე\n' +
    '/verbosity — გამოტანის დეტალურობა და რას აჩვენებს თემა (ნაკადი / პასუხები)\n' +
    '/quit /status /output — კონტროლი\n' +
    '/compact — აგენტის კონტექსტის შეკუმშვა\n' +
    '/compact_on_idle — უმოქმედობის შემდეგ ავტო-შეკუმშვა (გადამრთველი)\n' +
    '/auto_continue_limits — ავტო-გაგრჯელება გამოყენების ლიმიტის შემდეგ (გადამრთველი)\n' +
    '/clear — თემის შეტყობინებების წაშლა\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI ღილაკები (Claude)\n' +
    '/bind — კავშირის მართვა',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot არის ჯგუფის ადმინი',
  'doctor.can_manage_topics': '`can_manage_topics` მინიჭებულია',
  'doctor.can_delete_messages': '`can_delete_messages` მინიჭებულია',
  'doctor.can_pin_messages': '`can_pin_messages` მინიჭებულია',
  'doctor.privacy_off': 'Privacy mode გამორთულია',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, შემდეგ წაშალეთ და ხელახლა დაამატეთ Bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} ქვესაქაღალდე)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI დაყენებულია',
  'doctor.opencode_installed': 'opencode CLI დაყენებულია',
  'doctor.state_valid':
    'state.json ვალიდურია ({bindings} კავშირი, {active} აქტიური)',
  'doctor.state_archived':
    'წინა state.json დაზიანებული იყო, არქივი: {path}',
  'doctor.cli_missing':
    'PATH-ში ვერ მოიძებნა (ავტო-ინსტალაცია გაუშვება /claude ან /opencode-ზე)',
  'doctor.no_admin_info':
    'Bot-ის უფლებების წაკითხვა ვერ ხერხდება — getChatMember ვერ შედგა',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'მზადყოფის ჩეკლისტი:\n' +
    '1️⃣ გამახლეთ ჯგუფის ადმინად უფლებებით:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, შემდეგ წამშალეთ და ხელახლა დაამატეთ\n' +
    '3️⃣ გაუშვით /doctor რა აკლია ნახვად\n' +
    '4️⃣ თითოეულ თემატურ თემაში გაუშვით /bind <subdir> და გაუშვით აგენტი\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 დაკავშირებულია `{subdir}`-თან',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} სერვერი',
  'binding.welcome.git': '• git: ბრენჩი `{branch}`{detail}',
  'binding.welcome.git_clean': ', სუფთა',
  'binding.welcome.git_dirty': ', დადასტურებული ცვლილებები',
  'binding.welcome.git_none': '• git: ინიციალიზებული არ არის',
  'binding.welcome.start_prompt': 'დაიწყეთ საუბარი:',

  'mcp.header': '🔌 *ამ თემისთვის MCP სერვერები:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP სერვერები არ არის კონფიგურირებული.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'თემის მიმაგრებული სტატუსი (Stage 7) მიუწვდომელი იქნება',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(კავშირი არ არის)',

  'pair.success': '✅ ჯგუფი დაკავშირდა. id: `{groupId}`. Bot ახლა ამ სუპერჯგუფს ემსახურება.',
  'pair.locked':
    'ℹ️ ჯგუფის id დაყენებულია `ALLOWED_GROUP_ID`-ით — ავტო-დაკავშირება გამორთულია. ' +
    'ჯგუფის შესაცვლელად შეცვალეთ ცვლადი და გადატვირთეთ Bot.',
  'pair.only_forum': '❌ /pair მუშაობს მხოლოდ ფორუმ სუპერჯგუფში (ჩართეთ Topics).',
  'pair.not_admin': '❌ მხოლოდ ჯგუფის ადმინისტრატორი ან შემქმნელი შეიძლება დააკავშიროს Bot.',
  'pair.not_paired': 'ჯგუფი ჯერ არ არის დაკავშირებული (დაკავშირების რეჟიმი)',
  'pair.dm': "ℹ️ DM რეჟიმში /pair არ არის საჭირო — Bot ემსახურება თქვენს პირად ჩატს.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(მიუწვდომელი)',
  'status.global_header': '📊 *ყველა თემა* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 ჯერ თემები არ არის.',
  'status.thread_report': 'სტატუსი:\n\nაგენტი: {agent}\nსაქაღალდე: {subdir}\nსესია: {session}',
  'status.thread_view': 'ხედი: {view}',
  'status.thread_model': 'მოდელი: {model}',
  'status.thread_effort': 'ძალისხმევა: {effort}',
  'status.thread_started': 'დაიწყო: {started}',
  'status.thread_running': 'მუშაობს',
  'status.thread_stopped': 'გაჩერებული',
  'status.thread_no_agent': 'არცერთი (გაუშვით /claude ან /opencode)',
  'status.thread_no_binding': '(მიბმის გარეშე — WORK_ROOT)',
  'status.thread_workdir': 'სამუშაო საქაღალდე: {workDir}',
  'status.thread_runtime_version': 'გაშვებული ვერსია: {version}',
  'status.thread_context': 'კონტექსტი: {used} / {limit} ტოკენი',
  'language.status': '🌐 ენა: {display}',
  'language.set_success': '✅ ამ ჩატის ენა დაყენდა `{locale}`-ზე.',
  'language.auto_success': '✅ ენა დაბრუნდა ავტომატურ რეჟიმზე. მიმდინარე: {display}.',
  'language.invalid': '⚠️ locale `{locale}` არ არის მხარდაჭერილი. ხელმისაწვდომია: {locales}.',

  'timezone.status': '🌍 დროის სარტყელი: {zone} — ახლა {now}',
  'timezone.usage':
    'გამოყენება: /timezone <IANA სარტყელი>  ·  /timezone +04:00  ·  /timezone auto\nან გამოაგზავნეთ /timezone არგუმენტის გარეშე სიიდან ასარჩევად.',
  'timezone.set_success': '✅ დროის სარტყელი: {zone} — ახლა {now}\nგადათვლილი განრიგები: {count}',
  'timezone.auto_success':
    '✅ დროის სარტყელი დაბრუნდა ჰოსტის სარტყელზე: {zone} — ახლა {now}\nგადათვლილი განრიგები: {count}',
  'timezone.invalid':
    '⚠️ უცნობი დროის სარტყელი `{zone}`. გამოიყენეთ IANA სახელი (მაგ. `Europe/Moscow`) ან ფიქსირებული წანაცვლება (მაგ. `+04:00`). სიიდან ასარჩევად გამოაგზავნეთ /timezone.',
  'timezone.offset_unsupported':
    '⚠️ წანაცვლება `{zone}` ვერ გამოიყენება — მუშაობს მხოლოდ მთელი საათის წანაცვლებები. ამის ნაცვლად მიუთითე შენი სარტყლის IANA სახელი (მაგალითად, `Asia/Kolkata` +05:30-ისთვის).',
  'timezone.fixed_offset_warning':
    '⚠️ ფიქსირებული წანაცვლება ზაფხულის დროს არ მიჰყვება — წელიწადის ნახევარი ერთი საათით აცდება.',
  'timezone.picker_regions': '🌍 დროის სარტყელი: {zone}\nახლა: {now}\n\nაირჩიეთ რეგიონი:',
  'timezone.picker_zones': '🌍 {region} — გვერდი {page}/{total}',
  'timezone.picker_expired': 'ეს სია მოძველდა — გამოაგზავნეთ /timezone ხელახლა.',

  'agent.ready': '{label} მზადაა `{subdir}`{argsSuffix}-ში\n{infoBlock}გამოგვიგზავნეთ შეტყობინება:',
  'agent.ready_model': '🧠 მოდელი: {model}',
  'agent.no_session': 'აგენტი არ არის გაშვებული. /claude ან /opencode გასაშვებად.',
  'agent.session_ended': '{label}: სესია დასრულდა',
  'agent.stopped': '{label} გაჩერდა',
  'agent.exit_signal_sent': 'ორმაგი Ctrl+C გაგზავნილია — {label} იხურება',
  'agent.already_active': '{label} უკვე მუშაობს აქ. გამოგვიგზავნეთ შეტყობინება ან /quit.',
  'agent.starting': 'გაშვება {label} `{subdir}`-ში…',
  'agent.queued_starting': '⏳ {label} ჯერ იწყება — თქვენი შეტყობინება რიგშია და გაგზავნილი იქნება როგორც კი მზად იქნება.',
  'agent.question_hint': 'ℹ️ უპასუხეთ ვარიანტის ნომრით (მაგ. 1) ან y/n. ასევე: /up /down გადასაადგილებლად, /enter დასადასტურებლად, /c გასაუქმებლად.',
  'agent.start_failed': '{label}-ის გაშვება ვერ მოხერხდა: {error}',
  'agent.no_response': '⚠️ აგენტმა მიიღო თქვენი მოთხოვნა, მაგრამ პასუხის გაცემა ვერ დაიწყო — სესია შესაძლოა გაიჭედა. ხელახლა გააგზავნეთ ან /new ახალი სესიისთვის.',
  'agent.session_restarting': '⚠️ აგენტმა არ უპასუხა — სესია გაჭედილია. თავიდან ვუშვებ და თქვენს მოთხოვნას ხელახლა ვასრულებ…',
  'agent.session_recovering': '⚠️ აგენტმა არ უპასუხა — ვაღდგენ (თქვენი დიალოგი შენარჩუნებულია) და თქვენს მოთხოვნას ხელახლა ვასრულებ…',
  'agent.question_cancelled_for_prompt': '⚠️ წინა შეკითხვა გაუქმებულია — თქვენი ახალი მოთხოვნა მუშაობს.',
  'agent.question_cancelled_msg_label': '❌ შეკითხვა გაუქმებულია: {header}',
  'agent.login_code_relayed': '🔐 შესვლის კოდი გადაგზავნილია Claude-სთვის — ტოკენის შეტყობინება ისტორიიდან წაშლილია.',
  'agent.login_url': '🔐 Claude-ში შესასვლელად გახსენით ეს ბმული, დაასრულეთ შესვლა და ჩასვით კოდი აქ:\n{url}',
  'agent.login_success': '✅ Claude-ში შესვლა შესრულდა.',
  'agent.login_failed': '⚠️ Claude-ში შესვლა ვერ მოხერხდა. ხელახლა საცდელად გაუშვით /login.',
  'agent.workingIndicator': '{glyph} ვმუშაობ…',
  'terminal.ready': '🖥 ტერმინალი მზადაა `{subdir}`{argsSuffix}-ში\nთითოეული შეტყობინება შესრულდება როგორც ბრძანება. /c — Ctrl+C, /up /down — ისტორია, /tab — შევსება, /quit — დახურვა.',

  'effort.choose': '⚙️ მიმდინარე effort: {current}\nაირჩიეთ დონე:',
  'effort.current_none': 'არ არის დაყენებული',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort: {effort}\nშესაცვლელად გაუშვით /effort',
  'effort.invalid_level': '⚠️ დონე `{level}` არასწორია. ხელმისაწვდომი: {valid}.',
  'effort.not_available': 'ℹ️ მიმდინარე მოდელისთვის reasoning effort დონეები არ არის ხელმისაწვდომი.',
  'effort.not_supported': 'ℹ️ მოდელს `{model}` არ აქვს reasoning effort დონეები.',
  'effort.start_agent_first': 'ℹ️ დონე შენახულია. აგენტი არ არის გაშვებული — მოქმედებს შემდეგ გაშვებაზე.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` გასუფთავდა: ახალი მოდელი `{model}` არ უჭერს მხარს.',
  'effort.unsupported_backend': '{label}-ისთვის effort კონტროლი არ არის მხარდაჭერილი.',
  'effort.no_session': 'აგენტი არ არის გაშვებული. გაუშვით /claude ან /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds}წმ ფიქრობდა',
  'thinking.choose': '☁️ მიმდინარე thinking რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'thinking.set_success': '✅ Thinking რეჟიმი: {mode}',
  'thinking.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'thinking.mode.minimal': 'მინიმალური',
  'thinking.mode.short': 'მოკლე',
  'thinking.mode.full': 'სრული',

  'toolResults.choose': '🔧 მიმდინარე ხელსაწყოს-შედეგის რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'toolResults.set_success': '✅ ხელსაწყოს-შედეგის რეჟიმი: {mode}',
  'toolResults.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'toolResults.mode.minimal': 'მინიმალური',
  'toolResults.mode.short': 'მოკლე',
  'toolResults.mode.full': 'სრული',
  'toolResults.truncated_footer': '… (შეკვეცილი, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'ხელსაწყო',

  'subagent.status_elapsed': '🤖 ქვე-აგენტი: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 ქვე-აგენტი მუშაობს …',
  'subagent.delegating_status': '🤖 დელეგირება: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'ქვე-აგენტი',
  'subagent.choose': '🤖 მიმდინარე ქვე-აგენტის რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'subagent.set_success': '✅ ქვე-აგენტის რეჟიმი: {mode}',
  'subagent.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'subagent.mode.minimal': 'მინიმალური',
  'subagent.mode.short': 'მოკლე',
  'subagent.mode.full': 'სრული',

  'verbosity.choose': '🔊 გამოტანა — დეტალურობა: {current} · ხედი: {view}\nრიგი 1 — ნაკადის დეტალურობა · რიგი 2 — რას აჩვენებს ეს თემა:',
  'verbosity.set_success': '✅ გამოტანის დეტალურობა: {mode} (thinking, ხელსაწყოს შედეგები, ქვე-აგენტები)',
  'verbosity.invalid_mode': '⚠️ `{mode}` არასწორია. დეტალურობის დონეები: {valid}. ხედები: {views}.',
  'verbosity.custom': 'მორგინილი (thinking: {thinking} · ხელსაწყოები: {toolResults} · ქვე-აგენტები: {subagent})',
  'verbosity.mode.minimal': 'მინიმალური',
  'verbosity.mode.short': 'მოკლე',
  'verbosity.mode.full': 'სრული',
  'verbosity.view.stream': 'სრული ნაკადი',
  'verbosity.view.streamAnswers': 'ნაკადი + პასუხები',
  'verbosity.view.answers': 'მხოლოდ პასუხები',
  'verbosity.view_set_success': '✅ ეს თემა აჩვენებს: {view} (მოქმედებს შემდეგი შეტყობინებიდან)',

  'model.set_success': '🧠 მოდელი დაყენდა: {model}',
  'model.saved_for_next_start': 'მოდელი შენახულია: {model} — მოქმედებს შემდეგ აგენტის გაშვებაზე.',
  'model.start_agent_first': 'აქტიური სესია არ არის. ჯერ გაუშვით აგენტი.',
  'model.current_default': 'ნაგულისხმევი',
  'model.none_available': '🧠 მიმდინარე: {current}\n\nხელმისაწვდომი მოდელები არ არის. დააყენეთ ხელით: /model <provider/model>.',
  'model.invalid_number': '❌ არასწორი ნომერი. სიის სანახავად გაუშვით /model.',
  'model.pick_provider': '🧠 მიმდინარე: {current}\n\nაირჩიეთ პროვაიდერი:',
  'model.all_hidden': '🧠 მიმდინარე: {current}\n\nყველა პროვაიდერი დამალულია. დააჭირეთ 👁-ს ერთ-ერთის დასაბრუნებლად.',
  'model.hidden_header': '🙈 დამალულია ამ სიიდან — დასაბრუნებლად დააჭირეთ 👁.',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ პროვაიდერები',
  'model.prev_button': '⬅️ წინა',
  'model.next_button': 'შემდეგი ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} მოდელი · გვერდი {page}/{totalPages}\nმიმდინარე: {current}',
  'model.page_hint': 'უპასუხეთ ნომრით ასარჩევად, ან /model <სახელი> საძებნელად.',
  'model.page_hint_buttons_only': 'შესაცვლელად დააჭირეთ მოდელს, ან /model <სახელი> საძებნელად.',

  'disconnect.unsupported_backend': 'ამ ბილდში OpenCode პროვაიდერის გათიშვა მიუწვდომელია.',
  'disconnect.invalid_provider': '❌ არასწორი პროვაიდერის id {provider}. მაგალითი: /disconnect openrouter',
  'disconnect.no_providers': 'გასათიში პროვაიდერი არ არის.',
  'disconnect.pick_provider': 'აირჩიეთ გასათიში პროვაიდერი — მისი შენახული სერთიფიკატები წაიშლება:',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ პროვაიდერი {provider} გაითიშა — შენახული სერთიფიკატები წაიშალა.',
  'disconnect.still_active_env': '⚠️ {provider}-ის შენახული სერთიფიკატები წაიშალა, მაგრამ ის კვლავ აქტიურია: OpenCode მას გარემოს ცვლადით რთავს. წაშალეთ ეს ცვლადი და გადატვირთეთ OpenCode, ან დამალეთ იგი /model-ით.',
  'disconnect.failed': '⚠️ {provider}-ის გათიშვა ვერ მოხერხდა: {reason}',

  'rename_session.usage': 'გამოყენება: /rename_session <ახალი სათაური>',
  'rename_session.start_agent_first': 'აქტიური სესია არ არის. ჯერ გაუშვით აგენტი (/claude ან /opencode).',
  'rename_session.unsupported_backend': '{label}-ისთვის სესიის სახელის შეცვლა არ არის მხარდაჭერილი.',
  'rename_session.success': '✅ სესიის სახელი შეიცვალა: {title}',
  'rename_session.failed': '⚠️ სესიის სახელის შეცვლა ვერ მოხერხდა: {reason}',

  'compact.started': '🧹 სესიის კონტექსტი იკუმშება — აგენტი გააგრძელებს შეჯამებიდან.',
  'compact.done': '✅ კონტექსტი შეიკუმშა.',
  'compact.done_tokens': '✅ კონტექსტი შეიკუმშა: {pre} → {post} ტოკენი.',
  'compact.summaryHeader': '📄 შეკუმშვის შეჯამება:',
  'compact.start_agent_first': 'აქტიური სესია არ არის. ჯერ გაუშვით აგენტი (/claude ან /opencode).',
  'compact.unsupported_backend': '{label}-ისთვის კონტექსტის შეკუმშვა არ არის მხარდაჭერილი.',
  'compact.model_unresolved': '⚠️ შეკუმშვა ვერ ხდება: ამ სესიისთვის მოდელი ვერ დადგინდა. აირჩიეთ /model-ით და სცადეთ ხელახლა.',
  'compact.failed': '⚠️ სესიის კონტექსტის შეკუმშვა ვერ მოხერხდა: {reason}',
  'compact.busy': '⚠️ აგენტი ამჟამად დაკავებულია — ხელახლა გაუშვი /compact მიმდინარე რაუნდის დასრულების შემდეგ.',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN GEORGIAN: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 უმოქმედობისას ავტომატურად შეიკუმშა, ქეშის ხარჯზე ტოკენების დასაზოგად.\nგამოსართავად გაუშვი /compact_on_idle.',
  'compactOnIdle.on': 'ჩართ.',
  'compactOnIdle.off': 'გამორთ.',
  'compactOnIdle.title': '🧹 ამ თემისთვის უმოქმედობისას ავტო-შეკუმშვა: {state}\n\nროცა სესია ~55 წუთი უმოქმედოა, მისი კონტექსტი ავტომატურად იკუმშება ტოკენების დასაზოგად (პრომფთის ქეში ჯერ ისევ თბილია).\n\nყველა თემისთვის ერთდროულად გადასართავად გაუშვი ეს General თემაში.',
  'compactOnIdle.titleGeneral': '🧹 უმოქმედობისას ავტო-შეკუმშვა — ნაგულისხმევი ყველა თემისთვის: {state}\n\nროცა სესია ~55 წუთი უმოქმედოა, მისი კონტექსტი ავტომატურად იკუმშება ტოკენების დასაზოგად.\n\nყოველ თემას შეუძლია ეს გადააჭარბოს საკუთარი /compact_on_idle-ით.',
  'compactOnIdle.enableButton': 'ჩართვა',
  'compactOnIdle.disableButton': 'გამორთვა',
  'compactOnIdle.setThisTopic': '✅ უმოქმედობისას ავტო-შეკუმშვა: {state} ამ თემისთვის.',
  'compactOnIdle.setGlobal': '✅ უმოქმედობისას ავტო-შეკუმშვა: {state} ყველა თემისთვის (თემების მიხედვით გადაფარვები კვლავ მოქმედებს).',
  'compactOnIdle.unsupported': 'უმოქმედობისას ავტო-შეკუმშვა მოქმედებს აქტიურ აგენტის სესიაზე. ჯერ დაბმულ თემაში გაუშვი /claude ან /opencode.',
  'compactOnIdle.pendingQuestionReask': '❓ შენ ჯერ კიდევ გაქვს უპასუხო კითხვა. შეეხე ვარიანტს, რომ უპასუხო და გააგრძელო:',
  'compactSummary.on': 'ჩართული',
  'compactSummary.off': 'გამორთული',
  'compactSummary.title':
    '📄 შეკუმშვის შეჯამების გამოქვეყნება ამ თემაში: {state}\n\nშეკუმშვის შემდეგ აგენტის სრული შეჯამება ეწერება თემაში, რომ დაინახოთ, რა შენარჩუნდა.\n\nყველა თემისთვის ერთდროულად გადასართავად გაუშვით ეს General თემაში.',
  'compactSummary.titleGeneral':
    '📄 შეკუმშვის შეჯამების გამოქვეყნება — ნაგულისხმევი ყველა თემისთვის: {state}\n\nშეკუმშვის შემდეგ აგენტის სრული შეჯამება ეწერება თემაში, რომ დაინახოთ, რა შენარჩუნდა.\n\nყოველ თემას მაინც შეუძლია ეს საკუთარი /compact_summary-ით გადააწეროს.',
  'compactSummary.enableButton': 'ჩართვა',
  'compactSummary.disableButton': 'გამორთვა',
  'compactSummary.setThisTopic': '✅ შეკუმშვის შეჯამება: {state} ამ თემისთვის.',
  'compactSummary.setGlobal': '✅ შეკუმშვის შეჯამება: {state} ყველა თემისთვის (თემების ინდივიდუალური პარამეტრები კვლავ მოქმედებს).',
  'compactSummary.unsupported': 'გარსს არ აქვს შესაკუმში კონტექსტი, ამიტომ გამოსაქვეყნებელი შეჯამებაც არ არსებობს.',

  'autoContinueLimits.on': 'ჩართ.',
  'autoContinueLimits.off': 'გამორთ.',
  'autoContinueLimits.title': '🚧 ამ თემისთვის ავტო-გაგრჯელება გამოყენების ლიმიტის შემდეგ: {state}\n\nროცა აგენტი გამოყენების ან სესიის ლიმიტს აღწევს, ბოტი დაელოდება ფანჯრის განულებას და შემდეგ თავად ეუბნება აგენტს, გააგრჯელოს (გაგრჯელების შეტყობინება იპინება, ასე რომ დადუმებულ თემაშიც მიიღებ შეტყობინებას).\n\nყველა თემისთვის ერთდროულად გადასართავად გაუშვი ეს General თემაში.',
  'autoContinueLimits.titleGeneral': '🚧 ავტო-გაგრჯელება გამოყენების ლიმიტის შემდეგ — ნაგულისხმევი ყველა თემისთვის: {state}\n\nროცა აგენტი გამოყენების ან სესიის ლიმიტს აღწევს, ბოტი დაელოდება ფანჯრის განულებას და შემდეგ თავად ეუბნება აგენტს, გააგრჯელოს.\n\nყოველ თემას შეუႫლია ეს გადააჭარბოს საკუთარი /auto_continue_limits-ით.',
  'autoContinueLimits.enableButton': 'ჩართვა',
  'autoContinueLimits.disableButton': 'გამორთვა',
  'autoContinueLimits.skipButton': '⏭ ერთხელ გამოტოვება',
  'autoContinueLimits.skipDone': 'ეს გაგრძელება გამოტოვებულია.',
  'autoContinueLimits.skipExpired': 'გამოსატოვებელი არაფერია — ეს ლოდინი უკვე დასრულდა.',
  'autoContinueLimits.skippedNotice': '⏭ გამოტოვებულია: ამას თვითონ არ გავაგრძელებ. მომწერე, როდის გავაგრძელო — ამ თემისთვის ავტო-გაგრძელება ჩართული რჩება.',
  'autoContinueLimits.noticeHint': 'ამ ერთი გაგრძელების გამოსატოვებლად ან ამ თემისთვის ავტო-გაგრძელების გამოსართავად გაუშვი /auto_continue_limits.',
  'autoContinueLimits.setThisTopic': '✅ ავტო-გაგრჯელება გამოყენების ლიმიტის შემდეგ: {state} ამ თემისთვის.',
  'autoContinueLimits.setGlobal': '✅ ავტო-გაგრჯელება გამოყენების ლიმიტის შემდეგ: {state} ყველა თემისთვის (თემების მიხედვით გადაფარვები კვლავ მოცემებს).',
  'autoContinueLimits.limitReachedDisabled': '🚧 გამოყენების ლიმიტი მიღწეულია. ამ თემისთვის ავტო-გაგრჯელება გამორთულია, ამიტომ ველოდები — მომწერე, როდის გავაგრჯო (/auto_continue_limits on ავტომატური გაგრჯელებისთვის).',

  'connect.prompt_key': '🔑 შემდეგ შეტყობინებად გამოგვიგზავნეთ `{provider}`-ის API გასაღები. გასაღების შეტყობინებას ისტორიიდან წავშლი.',
  'connect.empty_key': '❌ API გასაღები ცარიელია. შემდეგ შეტყობინებად გამოგვიგზავნეთ გასაღები.',
  'connect.invalid_key': '❌ ეს არ ჰგავს API key-ს (შეიცავს ჰარებს ან არა-ლათინურ სიმბოლოებს). შემდეგ შეტყობინებად გამოგზავნეთ მხოლოდ key, ან თავიდან გაუშვით /connect.',
  'connect.invalid_provider': '❌ არასწორი პროვაიდერის id `{provider}`. მაგალითი: /connect openai',
  'connect.unsupported_provider': '⚠️ პროვაიდერი `{provider}` არ უჭერს მხარს მარტივი API-გასაღებით შესვლას ამ პროცესით. გამოიყენეთ OpenCode UI/CLI ამ პროვაიდერისთვის.',
  'connect.unsupported_backend': 'ამ ბილდში OpenCode პროვაიდერის ავთენტიფიკაცია მიუწვდომელია.',
  'connect.failed': '⚠️ `{provider}`-ის დაკავშირება ვერ მოხერხდა: {reason}',
  'connect.success': '✅ პროვაიდერი `{provider}` დაკავშირდა. OpenCode სერვერი არ გადატვირთულა.',
  'connect.cancelled': 'API გასაღების შეყვანა გაუქმებულია.',
  'connect.pick_method': 'როგორ დააკავშიროთ `{provider}`? აირჩიეთ მეთოდი:',
  'connect.no_methods': '⚠️ `{provider}`-ისთვის ავთენტიფიკაციის მეთოდი ვერ მოიძებნა.',
  'connect.oauth_device': '🔓 `{provider}`-ის დასაკავშირებლად: გახსენით {url} და შეიყვანეთ კოდი `{code}`, შემდეგ დაადასტურეთ. სერვერზე გამოიყენეთ *headless* მეთოდი. დასრულებისას აქ დაგიდასტურებთ.',
  'connect.oauth_url_only': '🔓 `{provider}`-ის დასაკავშირებლად: გახსენით {url} და დაასრულეთ შესვლა. დასრულებისას აქ დაგიდასტურებთ.',
  'connect.oauth_paste': '🔑 დადასტურების შემდეგ ჩასვით კოდი აქ შემდეგ შეტყობინებად — ისტორიიდან წავშლი.',
  'connect.oauth_waiting': '⏳ ველოდები ავტორიზაციას…',
  'connect.oauth_loopback': '🔑 ავტორიზაციის შემდეგ თქვენი ბრაუზერი შეეცდება გახსნას `localhost` გვერდი, რომელიც ვერ ჩაიტვირთება — აქ ეს მოსალოდნელია. დააკოპირეთ ეს URL მისამართის ზოლიდან და ჩასვით შემდეგ შეტყობინებად (ან მხოლოდ `code` მნიშვნელობა). მე წავშლი მას ისტორიიდან და დავასრულებ შესვლას.',
  'connect.oauth_invalid_reply': '❌ ეს არც callback URL-ს ჰგავს და არც ავტორიზაციის კოდს. ავტორიზაციის შემდეგ ჩასვით `localhost` callback URL თქვენი ბრაუზერიდან (ან `code` მნიშვნელობა).',
  'connect.oauth_callback_no_flow': '⚠️ ეს OAuth callback URL-ს ჰგავს, მაგრამ აქ ამჟამად შესვლა არ მიმდინარეობს — მე წავშალე იგი. თავიდან დასაწყებად გაუშვით /connect.',
  'connect.oauth_success': '✅ `{provider}` დაკავშირდა OAuth-ით. OpenCode სერვერის რწმუნებათა მონაცემები განახლდა.',
  'connect.oauth_failed': '⚠️ `{provider}`-ის OAuth შესვლა არ დასრულდა. ხელახლა გაუშვით /connect.',
  'quit_all.none_active': 'აგენტები არ არის გაშვებული — გასაჩერებელი არაფერია.',
  'quit_all.summary': '🚪 გაჩერდა {stopped} / {total} აქტიური აგენტი.',
  'quit_all.general_only': '`/quit-all` ხელმისაწვდომია მხოლოდ General თემაში.',

  'clearMessages.summary':
    '🗑 წაიშალა {deleted} / {total} შეტყობინება. ' +
    'Telegram უარყოფს 48 საათზე ძველი შეტყობინებების წაშლას — დანარჩენი რჩება ისტორიაში.',
  'clearMessages.no_messages': 'ამ თემაში წასაშლელი შეტყობინებები არ არის.',

  'edited.hint':
    '✏️ მე არ მივიჩნევ შესწორებულ შეტყობინებებს როგორც ახალ შეყვანას — გამოგვიგზავნეთ შესწორება ცალკე შეტყობინებად.',

  'voice.no_api_key':
    'ხმისთვის სჭირდება `GROQ_API_KEY` (უფასო) ან `OPENAI_API_KEY`.',
  'voice.failed': 'ხმოვანი შეტყობინების ტრანსკრიფცია ვერ მოხერხდა.',
  'voice.retrying': '⚠️ ხმოვანი შეტყობინების ტრანსკრიფცია ვერ მოხერხდა ({error}). ხელახლა ვცდი {seconds} წამში…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 ფაილი აღემატება Bot API ზღვარს ({cap} მბ) — ვერ გადმოწერ. გამოგვიგზავნეთ უფრო მცირე ფაილი.',
  'file.download_failed': '📎 ფაილის გადმოწერა ვერ მოხერხდა. კიდევ სცადეთ.',

  'error.workdir.gone':
    '📁 საქაღალდე `{subdir}` დისკიდან გაქრა. გაუშვით /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ თემა წაიშალა Telegram-ში; კავშირი გასუფთავდა.',
  'error.tg.thread.closed':
    '🔒 თემა {key} დახურულია — ხელახლა გახსენით თქვენს Telegram კლიენტში, ან სრულად წაშალეთ.',
  'error.tg.perm.delete':
    '🔐 შეტყობინებების წაშლა ვერ ხერხდება. მიეცით Bot-ს `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` აკლია. გამახლეთ ჯგუფის ადმინად.',
  'error.state.corrupted':
    '⚠️ state.json დაზიანებული იყო; კავშირები გადატვირთულია. სადცა საჭიროა ხელახლა გაუშვით /bind.',
  'error.start_in_general':
    'General-ში აგენტს ვერ გაუშვებთ — ეს სერვისის თემაა. გახსენით თემატური თემა.',

  'cb.access_denied': 'წვდომა უარყოფილია',
  'cb.bind_only_topical': '/bind მუშაობს მხოლოდ თემატურ თემებში',
  'cb.binding_to': 'დაკავშირება {subdir}-თან…',
  'cb.no_active_session': 'აქტიური სესია არ არის',
  'cb.model_error': 'შეცდომა: {error}',
  'cb.model_set': 'მოდელი: {model}',
  'cb.model_provider_gone': 'ეს პროვაიდერი აღარ არსებობს — გაუშვით /model ხელახლა',
  'cb.model_hidden': 'დამალულია: {provider}',
  'cb.model_shown': 'ნაჩვენებია: {provider}',
  'cb.disconnect_expired': 'გათიშვის ეს მენიუ ვადაგასულია — გაუშვით /disconnect ხელახლა',
  'cb.not_supported': '{label}-ისთვის არ არის მხარდაჭერილი',
  'cb.unknown_agent': 'უცნობი აგენტი',
  'cb.agent_switched': 'გადართულია {label}-ზე',
  'cb.resume_only_topical': 'Resume მუშაობს მხოლოდ თემატურ თემებში',
  'cb.bind_folder_first': 'ჯერ დააკავშირეთ საქაღალდე /bind-ით',
  'cb.agent_not_running': 'აგენტი არ არის გაშვებული',
  'cb.no_pending_question': 'მოლოდინის შეკითხვა არ არის',
  'cb.connect_method_expired': 'ეს დაკავშირების მენიუ ვადაგასულია — ხელახლა გაუშვით /connect',
  'cb.invalid_option': 'არასწორი ვარიანტი',
  'cb.sent_option': 'გაგზავნილია: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'შეცდომა: {error}',
  'cb.claudeMode_already': 'უკვე აქტიურია',
  'cb.claudeMode_switching': 'გადართვა…',
  'claudeMode.pick': '⚙️ Claude Code ბექენდი — მიმდინარე: {label}\nაირჩიეთ ბექენდი (გადართვა ინარჩუნებს იგივე საუბარს):',
  'claudeMode.not_claude': "ეს თემა Claude Code-ზე არ არის — /claude_mode მხოლოდ Claude-ის ბექენდს ცვლის.",
  'claudeMode.already': 'უკვე {label}.',
  'claudeMode.set_idle': '⚙️ Claude ბექენდი: {label} — მოქმედებს შემდეგ გაშვებაზე.',
  'claudeMode.switched_resumed': '⚙️ გადართულია {label}-ზე — იგივე საუბარი გაგრძელდა.',
  'claudeMode.switched_fresh': '⚙️ გადართულია {label}-ზე — ახალი სესია დაიწყო.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'შეცდომა: {error}',
  'cb.toolresults_set': 'ხელსაწყოს შედეგები: {mode}',
  'cb.toolresults_error': 'შეცდომა: {error}',
  'cb.subagent_set': 'ქვე-აგენტები: {mode}',
  'cb.subagent_error': 'შეცდომა: {error}',
  'cb.verbosity_set': 'გამოტანის დეტალურობა: {mode}',
  'cb.verbosity_error': 'შეცდომა: {error}',
  'cb.view_set': 'ეს თემა აჩვენებს: {view}',

  'session.list_header': 'გასაგრძელებელი სესიები ({label}):',
  'session.list_footer': 'გამოგვიგზავნეთ 1–{max} გასაგრძელებლად · 0 გასასვლელად',
  'session.none': 'ამ საქაღალდეში გასაგრძელებელი სესიები არ არის.',
  'session.cancelled': 'გაუქმებულია. სესიის არჩევა დახურულია.',
  'session.invalid': 'არასწორი ნომერი. შეიყვანეთ მნიშვნელობა 1-დან {max}-მდე.',
  'session.resumed': 'სესია გაგრძელდა. გამოგვიგზავნეთ შეტყობინება:',
  'session.resume_failed': 'სესიის გაგრძელება ვერ მოხერხდა: {error}',
  'session.expired': 'სესიების სია მოძველდა. ხელახლა გაუშვით /sessions.',
  'session.load_failed': 'სესიების ჩატვირთვა ვერ მოხერხდა.',

  'resume.context_header': '↩️ გაგრძელდა — ბოლო {count} შეტყობინება:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot-ის გათიშვისას {count} შეტყობინება გამოტოვდა. სესიის უახლესი:',
  'recap.restartedFallbackHeader': '🔄 Bot გადატვირთულია. სესიის უახლესი:',
  'recap.stillWorkingLine': '⏳ აგენტი ჯერ კიდევ მუშაობს…',

  'trace.onThisThreadReply': '🔎 ტრეისიng ჩართულია ამ თემისთვის.',
  'trace.offThisThreadReply': '🔎 ტრეისიng გამორთულია ამ თემისთვის.',
  'trace.onAllThreadsReply': '🔎 ტრეისიng ჩართულია ყველა თემისთვის.',
  'trace.offAllThreadsReply': '🔎 ტრეისიng გამორთულია ყველგან («all» ალამი და თემების სია გასუფთავდა).',
  'trace.statusReply':
    '🔎 Trace — ეს თემა: {thisThread}\nყველა თემა: {allThreads}\nტრეისინგის თემები: {count}',
  'trace.statusOnLabel': 'ჩართული',
  'trace.statusOffLabel': 'გამორთული',
  'trace.usageHint': 'გამოყენება: /trace on | off | on all | off all | (არგუმენტის გარეშე — სტატუსი)',

  'timestamps.onReply':
    '🕐 დროის შტამპები ჩართულია: აგენტისთვის გადაგზავნილი თითოეული ბრძანება იღებს გაგზავნის დროს როგორც პირველ ხაზზე (თემაში არასოდეს ქვეყნდება).',
  'timestamps.offReply': '🕐 დროის შტამპები გამორთულია ამ თემისთვის.',
  'timestamps.statusOnReply': '🕐 დროის შტამპები: ჩართულია ამ თემისთვის.',
  'timestamps.statusOffReply': '🕐 დროის შტამპები: გამორთულია ამ თემისთვის.',
  'timestamps.usageHint': 'გამოყენება: /timestamps on | off | (არგუმენტის გარეშე — სტატუსი)',

  'schedule.fired':
    '⏰ განრიგი «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — გამოტოვებულია {time}-ზე, მიწევს',
  'schedule.checkFailed':
    '🚨 შემოწმება «{name}» ვერ გაიარა: {failure} ({schedule}){missedNote}\n$ {command}\n\n{output}\n\nაგენტს ვაღვიძებ. ახალი გაფრთხილება აღარ იქნება, სანამ შემოწმება ისევ არ გაივლის.',
  'schedule.checkRecovered': '✅ შემოწმება «{name}» ისევ გადის.',
  'schedule.pausedUnbound':
    '⏸ შეჩერებული განრიგები: {count} — თემა მოხსნილია თავის საქაღალდიდან. /bind დააბრუნებს მათ.',
  'schedule.resumedRebind': '▶️ განრიგები გაგრძელდა: {count} (შემდეგი გაშვება ხელახლა გამოითვლება ახლანდელი დროიდან).',
  'schedule.noAgent':
    '⚠️ არაფერი დაიგეგმა — ამ თემაში არცერთი აგენტი არ მუშაობს, ამიტომ დაგეგმილ გაშვებას გასაშვები არაფერი ექნება. ჯერ გაუშვით /claude ან /opencode.',
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN GEORGIAN what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN GEORGIAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN GEORGIAN what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': 'ყოველდღე {time}-ზე',
  'reminders.scheduleWeekdays': 'სამუშაო დღეებში {time}-ზე',
  'reminders.scheduleWeekly': '{weekday} {time}-ზე',
  'reminders.scheduleMonthly': '{dayOfMonth} რიცხვში {time}-ზე',
  'reminders.scheduleOnce': '{date} {time}-ზე',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': 'დღეს {time}-ზე',
  'reminders.nextRunTomorrow': 'ხვალ {time}-ზე',
  'reminders.nextRunOnDate': '{date} {time}-ზე',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 შეხსენებები',
  'reminders.hubEmptyLine': 'შეხსენებები ჯერ არ არის.',
  'reminders.hubActiveLine': 'აქტიური: {count}',
  'reminders.hubLimitLine':
    'აქტიური: {count} — {limit}-ის ლიმიტი მიღწეულია. ახლის დასამატებლად წაშალეთ ერთი.',
  'reminders.addButton': '➕ დამატება',
  'reminders.listButton': '📋 სია ({count})',
  'reminders.closeButton': '✕ დახურვა',
  'reminders.closedNotice': '🔔 შეხსენებები დაიხურა.',
  'reminders.listTitle': '📋 შეხსენებები ({count})',
  'reminders.listPageLine': 'გვერდი {page}/{total}',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ წინა',
  'reminders.listNextButton': 'შემდეგი ›',
  'reminders.listBackToHubButton': '‹ უკან',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'როდის: {schedule}',
  'reminders.cardText': 'ტექსტი: «{text}»',
  'reminders.cardNext': 'შემდეგი: {next}',
  'reminders.cardDeleteButton': '🗑 წაშლა',
  'reminders.cardBackToListButton': '‹ სიაში',
  'reminders.createdTitle': '✅ შეხსენება შეიქმნა',
  'reminders.doneListButton': '📋 სია',
  'reminders.wizardTitle': '🔔 ახალი შეხსენება',
  'reminders.pickRepeat': 'გამეორება: {value}',
  'reminders.pickDate': 'თარიღი: {value}',
  'reminders.pickWeekday': 'კვირის დღე: {value}',
  'reminders.pickDayOfMonth': 'თვის დღე: {value}',
  'reminders.pickTime': 'დრო: {value}',
  'reminders.pickText': 'ტექსტი: «{value}»',
  'reminders.stepRepeatQuestion': 'ნაბიჯი 1/4 · რა სიხშირით?',
  'reminders.stepDateQuestion': 'ნაბიჯი 2/4 · რომელი დღე?',
  'reminders.stepDateGridQuestion': 'ნაბიჯი 2/4 · აირჩიეთ თარიღი:',
  'reminders.stepWeekdayQuestion': 'ნაბიჯი 2/4 · კვირის რომელი დღე?',
  'reminders.stepDayOfMonthQuestion': 'ნაბიჯი 2/4 · თვის რომელი დღე?',
  'reminders.stepDayOfMonthGridQuestion': 'ნაბიჯი 2/4 · აირჩიეთ თვის დღე:',
  'reminders.stepTimeQuestion': 'ნაბიჯი 3/4 · რომელ საათზე?',
  'reminders.stepHourQuestion': 'ნაბიჯი 3/4 · აირჩიეთ საათი:',
  'reminders.stepMinuteQuestion': 'ნაბიჯი 3/4 · {hour}:__ — აირჩიეთ წუთები:',
  'reminders.stepTextQuestion':
    'ნაბიჯი 4/4 · გამოგზავნეთ შეხსენების ტექსტი — დაწერეთ ან ჩაწერეთ ხმოვანი შეტყობინება.',
  'reminders.repeatOnceButton': 'ერთხელ',
  'reminders.repeatDailyButton': 'ყოველდღე',
  'reminders.repeatWeekdaysButton': 'ორშ-პარ',
  'reminders.repeatWeeklyButton': 'ყოველ კვირას',
  'reminders.repeatMonthlyButton': 'ყოველ თვეს',
  'reminders.dateTodayButton': 'დღეს',
  'reminders.dateTomorrowButton': 'ხვალ',
  'reminders.dateOtherButton': '✏️ სხვა თარიღი…',
  'reminders.dayOfMonthOtherButton': '✏️ სხვა დღე…',
  'reminders.timeOtherButton': '🕐 სხვა დრო',
  'reminders.backButton': '‹ უკან',
  'reminders.cancelButton': '✕ გაუქმება',
  'reminders.weekdayMondayButton': 'ორშ',
  'reminders.weekdayTuesdayButton': 'სამ',
  'reminders.weekdayWednesdayButton': 'ოთხ',
  'reminders.weekdayThursdayButton': 'ხუთ',
  'reminders.weekdayFridayButton': 'პარ',
  'reminders.weekdaySaturdayButton': 'შაბ',
  'reminders.weekdaySundayButton': 'კვი',
  'reminders.errorPastTime':
    '⚠️ ეს დრო უკვე გავიდა. აირჩიეთ უფრო გვიანი დრო, ან დაბრუნდით და შეცვალეთ დღე.',
  'reminders.errorInvalidDate': '⚠️ ასეთი თარიღი არ არსებობს. აირჩიეთ სხვა.',
  'reminders.errorInvalidTime':
    '⚠️ იმ დღეს ეს დრო არ არსებობს — საათები გადაინაცვლებს. აირჩიეთ სხვა დრო.',
  'reminders.errorTextTooLong':
    '⚠️ ტექსტი ძალიან გრძელია (მაქსიმუმ {limit} სიმბოლო) და არ შეინახა. გამოაგზავნეთ უფრო მოკლე.',
  'reminders.cancelledNotice': '✕ გაუქმდა',
  'reminders.expiredNotice': '✕ ვადა გასულია — შეხსენების ტექსტი არ მოვიდა.',
  'reminders.capReachedNotice':
    '⚠️ ამ თემაში უკვე {limit} შეხსენებაა — ახლის დამატებამდე წაშალეთ ერთი.',
  'reminders.wizardExpiredCbAnswer': 'ეს ვიზარდი მოძველებულია — გაუშვით /reminders ხელახლა.',
  'reminders.deletedCbAnswer': '🗑 წაიშალა',
  'reminders.deleteGoneCbAnswer': 'უკვე წაშლილია.',
  'reminders.cardExpiredCbAnswer': 'ეს შეხსენება აღარ არსებობს.',

  'apiRetry.transientNotice':
    '⏳ API სიხშირით შეზღუდული — ავტომატური ხელახლე ცდა {minutes} წუთში (მცდელობა {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 გამოყენების ზღვარს მიაღწია — ხელახლე ცდა {minutes} წუთში (მცდელობა {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 გამოყენების ზღვარს მიაღწია — ავტომატური გაგრძელება გადატვირთვის შემდეგ (~{time}).',
  'apiRetry.resuming': '↻ გაგრძელება…',
  'apiRetry.limitResetResuming': '✅ ლიმიტის ფანႻარა განულდა — ამ თემაში მუშაობას განვაგრჯობ.',
  'apiRetry.giveUp':
    '⚠️ {attempts} ცდის შემდეგ ვერ გაგრძელდა. როცა გაგრძელება გსურთ გამოგვიგზავნეთ შეტყობინება.',
  'apiRetry.continueNudge': 'გააგრძელე იმ ადგილიდან, სადაც გაჩერდი.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude გამოსულია — გასაგრძელებლად გაუშვით /login.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: არასწორი ავტორიზაციის მონაცემები — გადატვირთეთ opencode სერვერი.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ მზადაა — შემიძლია დავამუშავო შეტყობინებები ბოტის თრედებსა და ჯგუფის თემებში.',
  'startup.header_not_ready':
    '⚠️ კონფიგურაცია დაუსრულებელია. ჩემთან სამუშაოდ, გთხოვთ, დაასრულოთ ეს ნაბიჯები:',
  'startup.item.create_group':
    'შექმენით ფორუმ-სუპერჯგუფი ჩართული თემებით (Topics) და მომწერეთ იქ, რომ დაწყვილდეს.',
  'startup.item.grant_admin':
    'გამხადეთ ადმინი შემდეგი უფლებებით: {missing}.',
  'startup.item.bind_topic':
    'შექმენით თემა და მიაბით საქაღალდეს /bind ბრძანებით.',
  'startup.item.install_agent':
    'დააინსტალირეთ აგენტის CLI — claude ან opencode.',
  'startup.item.optional_groq':
    '(არასავალდებულო) ხმოვანი შეყვანის ჩასართავად დაამატეთ GROQ_API_KEY თქვენს .env-ში და გადატვირთეთ.',
  'startup.item.optional_owner':
    '(არასავალდებულო) დააყენეთ OWNER_USER_ID, რომ ეს სტატუსი მიიღოთ თქვენს პირად ჩატში.',
  'requests.alert.notAnsweringNotice': '⚠️ მოთხოვნა {requestId} უპასუხოდ დარჩა: აგენტმა სვლები პასუხის გარეშე დაასრულა და შეხსენებები შეწყდა. შეამოწმეთ სესია ამ თემაში.',
  'requests.alert.unreachableNotice': '⚠️ მოთხოვნა {requestId} უპასუხოდ დარჩა: შეხსენებისთვის აგენტის სესიასთან დაკავშირება ვერ მოხერხდა. შეამოწმეთ სესია ამ თემაში.',
  'requests.limit.answerAfterResetNotice': '🚧 გამოყენების ლიმიტი ამოიწურა — პასუხი მოვა {time}-ის შემდეგ.',
  'requests.limit.answerNextAttemptNotice': '🚧 გამოყენების ლიმიტი ამოიწურა — შემდეგი მცდელობა {time}-ზე.',
};
