// Machine-translated from en. Native review welcome.

export const hiDict: Record<string, string> = {
  'access.denied': 'पहुँच अस्वीकृत।',
  'access.group_only': 'मैं केवल कॉन्फ़िगर किए गए फ़ोरम सुपरग्रुप में काम करता हूँ।',

  'thread.no_binding':
    '📁 यह थ्रेड किसी फ़ोल्डर से बाउंड नहीं है। /bind <subdir> का उपयोग करें या सूची से चुनें।',
  'thread.bind_required':
    '📁 पहले फ़ोल्डर बाइंड करें: /bind <subdir>। एजेंट केवल बाउंड फ़ोल्डर में चलता है।',
  'thread.bound': '📁 `{subdir}` से बाउंड।\n/claude या /opencode चलाएँ।',
  'thread.unbound': '📁 बाइंडिंग हटाई गई।',
  'thread.general_no_agent':
    'General किसी फ़ोल्डर से बाउंड नहीं है — एजेंट से बात करने के लिए एक विषय-वस्तु थ्रेड पर स्विच करें।',
  'thread.welcome_bound':
    '👋 थ्रेड बनाया गया और स्वतः `{subdir}` से बाउंड किया गया (थ्रेड नाम एक सबफ़ोल्डर से मेल खाया)।\n/claude या /opencode चलाएँ।',
  'thread.welcome_pick':
    '👋 थ्रेड बनाया गया। फ़ोल्डर बाइंड करें: /bind <subdir>, या नीचे से चुनें।',
  'thread.bind_collision':
    '⚠️ फ़ोल्डर `{subdir}` पहले से थ्रेड्स द्वारा उपयोग में है: {threads}.\nबाइंडिंग जोड़ी गई; सत्र स्वतंत्र रहते हैं (अपना tmux/SSE)।',
  'thread.no_agent_with_binding':
    '📁 फ़ोल्डर `{subdir}` बाउंड है। संवाद शुरू करने के लिए /claude या /opencode चलाएँ।',

  'bind.usage': 'उपयोग: /bind <subdir>\nउदाहरण: /bind overview',
  'bind.current': '📂 वर्तमान बाइंडिंग: `{subdir}`',
  'bind.current_none': '📂 अभी तक बाउंड नहीं',
  'bind.in_general': '/bind केवल विषय-वस्तु थ्रेड्स में काम करता है, General में नहीं।',
  'bind.invalid_chars': '❌ फ़ोल्डर नाम में नियंत्रण वर्ण नहीं होने चाहिए।',
  'bind.not_found': '❌ फ़ोल्डर `{subdir}` `WORK_ROOT` (`{workRoot}`) के अंतर्गत नहीं मिला।',
  'bind.outside_root': '❌ पथ `WORK_ROOT` के बाहर जाता है।',
  'bind.not_directory': '❌ `{subdir}` मौजूद है लेकिन एक फ़ोल्डर नहीं है।',

  'bind.leave_button': '⬅️ वर्तमान डायरेक्टरी छोड़ें',
  'bind.create_button': '➕ नया फ़ोल्डर बनाएँ',
  'bind.create_prompt':
    '✏️ नए फ़ोल्डर का नाम भेजें (`WORK_ROOT` के अंतर्गत बनाया जाएगा)। कोई भी कमांड रद्द करता है।',
  'bind.create_cb': 'नया फ़ोल्डर बनाया जा रहा है…',
  'bind.create_empty': '❌ नाम खाली है। फ़ोल्डर नाम भेजें।',
  'bind.create_separator': '❌ नाम में `/` या `\\` नहीं होना चाहिए। सरल नाम भेजें।',
  'bind.create_dot_segment': '❌ `.` और `..` को फ़ोल्डर नाम के रूप में नहीं इस्तेमाल किया जा सकता।',
  'bind.create_hidden': '❌ नाम बिंदु से शुरू नहीं होना चाहिए।',
  'bind.create_invalid_chars': '❌ फ़ोल्डर नाम में नियंत्रण वर्ण नहीं होने चाहिए।',
  'bind.create_exists': '📁 फ़ोल्डर `{subdir}` पहले से मौजूद है — बाइंड किया जा रहा है।',
  'bind.create_failed': '❌ फ़ोल्डर बनाने में विफल: {error}',

  'ls.header': '📁 `{workRoot}` के सबफ़ोल्डर:',
  'ls.empty': '📁 `WORK_ROOT` के अंतर्गत कोई बाइंड करने योग्य सबफ़ोल्डर नहीं।',
  'list.header': '🧵 थ्रेड बाइंडिंग ({count}):',
  'list.empty': '🧵 अभी तक कोई बाइंडिंग नहीं। एक थ्रेड बनाएँ और /bind चलाएँ।',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new एक बाउंड टॉपिक के अंदर काम करता है — एक थ्रेड खोलें और उसके एजेंट सत्र को पुनः प्रारंभ करने के लिए /new चलाएँ।',

  'help.general':
    '*General में कमांड:*\n' +
    '/ls — `WORK_ROOT` सबफ़ोल्डर सूचीबद्ध करें\n' +
    '/list — थ्रेड सूचीबद्ध करें\n' +
    '/status — सभी थ्रेड्स की स्थिति\n' +
    '/quitall — हर चल रहे एजेंट को बंद करें\n' +
    '/whoami /version — डिबग\n\n' +
    'एजेंट से बात करने के लिए — एक विषय-वस्तु थ्रेड खोलें।',
  'help.thread_unbound':
    '*थ्रेड किसी फ़ोल्डर से बाउंड नहीं है।*\n' +
    '/bind <subdir> — बाइंड करें (या सूची से चुनें)\n' +
    '/ls — `WORK_ROOT` सबफ़ोल्डर (General में)',
  'help.thread_bound':
    '*थ्रेड `{subdir}` से बाउंड है।*\n' +
    '/claude /opencode — एजेंट शुरू करें\n' +
    '/connect — OpenCode प्रदाता API कुंजी कनेक्ट करें (डिफ़ॉल्ट OpenAI)\n' +
    '/disconnect — किसी प्रदाता के सहेजे गए क्रेडेंशियल हटाएँ\n' +
    '/terminal — इस फ़ोल्डर में शेल खोलें\n' +
    '/new — सत्र पुनः प्रारंभ करें (पुराना → /sessions)\n' +
    '/model /sessions — स्विच\n' +
    '/effort — reasoning effort स्तर\n' +
    '/verbosity — आउटपुट विस्तार (thinking/tools/सब-एजेंट)\n' +
    '/quit /status /output — नियंत्रण\n' +
    '/compact — एजेंट संदर्भ संक्षिप्त करें\n' +
    '/compact_on_idle — निष्क्रियता के बाद स्वतः संक्षेपण (टॉगल)\n' +
    '/auto_continue_limits — उपयोग-सीमा के बाद स्वतः पुनःआरंभ (टॉगल)\n' +
    '/clear — थ्रेड संदेश हटाएँ\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI कुंजी (Claude)\n' +
    '/bind — बाइंडिंग प्रबंधित करें',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot ग्रुप एडमिन है',
  'doctor.can_manage_topics': '`can_manage_topics` प्रदान किया गया',
  'doctor.can_delete_messages': '`can_delete_messages` प्रदान किया गया',
  'doctor.can_pin_messages': '`can_pin_messages` प्रदान किया गया',
  'doctor.privacy_off': 'Privacy mode अक्षम',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, फिर Bot को हटाकर पुनः जोड़ें',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} सबफ़ोल्डर)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI स्थापित',
  'doctor.opencode_installed': 'opencode CLI स्थापित',
  'doctor.state_valid':
    'state.json मान्य ({bindings} बाइंडिंग, {active} सक्रिय)',
  'doctor.state_archived':
    'पिछला state.json दूषित था, संग्रह: {path}',
  'doctor.cli_missing':
    'PATH में नहीं मिला (/claude या /opencode पर ऑटो-इंस्टॉल चलेगा)',
  'doctor.no_admin_info':
    'Bot के अधिकार नहीं पढ़ सकते — getChatMember विफल',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'तैयारी चेकलिस्ट:\n' +
    '1️⃣ मुझे ग्रुप एडमिन बनाएँ अधिकारों के साथ:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, फिर मुझे हटाकर पुनः जोड़ें\n' +
    '3️⃣ /doctor चलाएँ और देखें क्या कमी है\n' +
    '4️⃣ प्रत्येक विषय-वस्तु थ्रेड में /bind <subdir> चलाएँ और एजेंट शुरू करें\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 `{subdir}` से बाउंड',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} सर्वर',
  'binding.welcome.git': '• git: शाखा `{branch}`{detail}',
  'binding.welcome.git_clean': ', स्वच्छ',
  'binding.welcome.git_dirty': ', अप्रतिबद्ध परिवर्तन',
  'binding.welcome.git_none': '• git: प्रारंभ नहीं किया गया',
  'binding.welcome.start_prompt': 'एक बातचीत शुरू करें:',

  'mcp.header': '🔌 *इस थ्रेड के लिए MCP सर्वर:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 कोई MCP सर्वर कॉन्फ़िगर नहीं।',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'थ्रेड की पिन की गई स्थिति (Stage 7) अनुपलब्ध रहेगी',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(कोई बाइंडिंग नहीं)',

  'pair.success': '✅ ग्रुप जोड़ा गया। id: `{groupId}`। Bot अब इस सुपरग्रुप को सेवा दे रहा है।',
  'pair.locked':
    'ℹ️ ग्रुप id `ALLOWED_GROUP_ID` के माध्यम से सेट है — ऑटो-पेयरिंग अक्षम है। ' +
    'ग्रुप बदलने के लिए वेरिएबल बदलें और Bot पुनः प्रारंभ करें।',
  'pair.only_forum': '❌ /pair केवल फ़ोरम सुपरग्रुप में काम करता है (Topics सक्षम करें)।',
  'pair.not_admin': '❌ केवल ग्रुप व्यवस्थापक या निर्माता Bot को जोड़ सकता है।',
  'pair.not_paired': 'ग्रुप अभी तक जोड़ा नहीं गया (पेयरिंग मोड)',
  'pair.dm': "ℹ️ DM मोड में /pair की आवश्यकता नहीं — Bot आपकी निजी चैट सेवा देता है।",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(अनुपलब्ध)',
  'status.global_header': '📊 *सभी थ्रेड्स* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 अभी तक कोई थ्रेड नहीं।',
  'status.thread_report': 'स्थिति:\n\nएजेंट: {agent}\nफ़ोल्डर: {subdir}\nसत्र: {session}',
  'status.thread_model': 'मॉडल: {model}',
  'status.thread_effort': 'प्रयास: {effort}',
  'status.thread_started': 'शुरू हुआ: {started}',
  'status.thread_running': 'चल रहा है',
  'status.thread_stopped': 'रुका हुआ',
  'status.thread_no_agent': 'कोई नहीं (/claude या /opencode शुरू करें)',
  'status.thread_no_binding': '(कोई बाइंडिंग नहीं — WORK_ROOT)',
  'status.thread_workdir': 'कार्य निर्देशिका: {workDir}',
  'status.thread_runtime_version': 'रनटाइम संस्करण: {version}',
  'status.thread_context': 'संदर्भ: {used} / {limit} टोकन',
  'language.status': '🌐 भाषा: {display}',
  'language.set_success': '✅ इस चैट की भाषा `{locale}` सेट की गई।',
  'language.auto_success': '✅ भाषा ऑटो पर रीसेट की गई। मौजूदा: {display}।',
  'language.invalid': '⚠️ locale `{locale}` समर्थित नहीं है। उपलब्ध: {locales}.',

  'timezone.status': '🌍 समय क्षेत्र: {zone} — अभी {now}',
  'timezone.usage':
    'उपयोग: /timezone <IANA क्षेत्र>  ·  /timezone +04:00  ·  /timezone auto\nया बिना तर्क के /timezone भेजें और सूची से चुनें।',
  'timezone.set_success': '✅ समय क्षेत्र: {zone} — अभी {now}\nपुनर्गणना किए गए शेड्यूल: {count}',
  'timezone.auto_success':
    '✅ समय क्षेत्र होस्ट क्षेत्र पर रीसेट: {zone} — अभी {now}\nपुनर्गणना किए गए शेड्यूल: {count}',
  'timezone.invalid':
    '⚠️ अज्ञात समय क्षेत्र `{zone}`। IANA नाम (जैसे `Europe/Moscow`) या स्थिर ऑफसेट (जैसे `+04:00`) का उपयोग करें। सूची से चुनने के लिए /timezone भेजें।',
  'timezone.offset_unsupported':
    '⚠️ ऑफसेट `{zone}` लागू नहीं हो सकता — केवल पूरे घंटे वाले ऑफसेट काम करते हैं। इसके बजाय अपने क्षेत्र का IANA नाम दें (जैसे +05:30 के लिए `Asia/Kolkata`)।',
  'timezone.fixed_offset_warning':
    '⚠️ स्थिर ऑफसेट डेलाइट सेविंग का पालन नहीं करता — आधे साल यह एक घंटा गलत रहेगा।',
  'timezone.picker_regions': '🌍 समय क्षेत्र: {zone}\nअभी: {now}\n\nक्षेत्र चुनें:',
  'timezone.picker_zones': '🌍 {region} — पृष्ठ {page}/{total}',
  'timezone.picker_expired': 'यह सूची पुरानी है — /timezone दोबारा भेजें।',

  'agent.ready': '{label} `{subdir}`{argsSuffix} में तैयार\n{infoBlock}एक संदेश भेजें:',
  'agent.ready_model': '🧠 मॉडल: {model}',
  'agent.no_session': 'कोई एजेंट नहीं चल रहा। /claude या /opencode से शुरू करें।',
  'agent.session_ended': '{label}: सत्र समाप्त',
  'agent.stopped': '{label} रुक गया',
  'agent.exit_signal_sent': 'दोहरा Ctrl+C भेजा गया — {label} बंद हो रहा है',
  'agent.already_active': '{label} पहले से यहाँ चल रहा है। संदेश भेजें या /quit।',
  'agent.starting': '`{subdir}` में {label} शुरू हो रहा है…',
  'agent.queued_starting': '⏳ {label} अभी शुरू हो रहा है — आपका संदेश कतार में है, तैयार होने पर भेजा जाएगा।',
  'agent.question_hint': 'ℹ️ विकल्प नंबर (जैसे 1) या y/n से उत्तर दें। और भी: /up /down चलाने के लिए, /enter पुष्टि करने, /c रद्द करने।',
  'agent.start_failed': '{label} शुरू करने में विफल: {error}',
  'agent.no_response': '⚠️ एजेंट ने आपका अनुरोध स्वीकार किया पर जवाब देना शुरू नहीं किया — सत्र अटका हो सकता है। इसे फिर भेजें, या नए सत्र के लिए /new करें।',
  'agent.session_restarting': '⚠️ एजेंट ने जवाब नहीं दिया — सत्र अटका लगता है। इसे पुनः आरंभ कर आपका अनुरोध दोबारा चला रहा हूँ…',
  'agent.session_recovering': '⚠️ एजेंट ने जवाब नहीं दिया — पुनर्प्राप्त कर रहा हूँ (आपकी बातचीत सुरक्षित है) और आपका अनुरोध दोबारा चला रहा हूँ…',
  'agent.question_cancelled_for_prompt': '⚠️ पिछला प्रश्न रद्द — आपका नया अनुरोध चल रहा है।',
  'agent.question_cancelled_msg_label': '❌ प्रश्न रद्द: {header}',
  'agent.login_code_relayed': '🔐 लॉगिन कोड Claude को भेजा गया — टोकन संदेश इतिहास से हटाया गया।',
  'agent.login_url': '🔐 Claude में साइन इन करने के लिए यह लिंक खोलें, साइन-इन पूरा करें, फिर कोड यहाँ पेस्ट करें:\n{url}',
  'agent.login_success': '✅ Claude में साइन इन हो गए।',
  'agent.login_failed': '⚠️ Claude साइन-इन विफल। पुनः प्रयास के लिए /login चलाएँ।',
  'agent.workingIndicator': '{glyph} काम कर रहा है…',
  'terminal.ready': '🖥 `{subdir}`{argsSuffix} में टर्मिनल तैयार\nहर संदेश एक कमांड के रूप में चलता है। /c — Ctrl+C, /up /down — इतिहास, /tab — पूर्णता, /quit — बंद।',

  'effort.choose': '⚙️ वर्तमान effort: {current}\nएक स्तर चुनें:',
  'effort.current_none': 'सेट नहीं',
  'effort.set_success': '✅ Effort: {level}',
  'effort.current_hint': '⚙️ Effort: {effort}\nबदलने के लिए /effort चलाएँ',
  'effort.invalid_level': '⚠️ स्तर `{level}` अमान्य है। उपलब्ध: {valid}।',
  'effort.not_available': 'ℹ️ वर्तमान मॉडल के लिए कोई reasoning effort स्तर उपलब्ध नहीं।',
  'effort.not_supported': 'ℹ️ मॉडल `{model}` में कोई reasoning effort स्तर नहीं है।',
  'effort.start_agent_first': 'ℹ️ स्तर सहेजा गया। कोई एजेंट नहीं चल रहा — अगली शुरुआत पर लागू होगा।',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` हटाया गया: नया मॉडल `{model}` इसे समर्थन नहीं करता।',
  'effort.unsupported_backend': '{label} के लिए effort नियंत्रण समर्थित नहीं।',
  'effort.no_session': 'कोई एजेंट नहीं चल रहा। /claude या /opencode से एक शुरू करें।',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds} सेकंड तक सोचा',
  'thinking.choose': '☁️ वर्तमान thinking मोड: {current}\nएक मोड चुनें:',
  'thinking.set_success': '✅ Thinking मोड: {mode}',
  'thinking.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'thinking.mode.minimal': 'न्यून',
  'thinking.mode.short': 'संक्षिप्त',
  'thinking.mode.full': 'पूर्ण',

  'toolResults.choose': '🔧 वर्तमान टूल-परिणाम मोड: {current}\nएक मोड चुनें:',
  'toolResults.set_success': '✅ टूल-परिणाम मोड: {mode}',
  'toolResults.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'toolResults.mode.minimal': 'न्यून',
  'toolResults.mode.short': 'संक्षिप्त',
  'toolResults.mode.full': 'पूर्ण',
  'toolResults.truncated_footer': '… (संक्षिप्त, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'टूल',

  'subagent.status_elapsed': '🤖 सब-एजेंट: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 सब-एजेंट काम कर रहा है …',
  'subagent.delegating_status': '🤖 सौंपा जा रहा: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'सब-एजेंट',
  'subagent.choose': '🤖 वर्तमान सब-एजेंट मोड: {current}\nएक मोड चुनें:',
  'subagent.set_success': '✅ सब-एजेंट मोड: {mode}',
  'subagent.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'subagent.mode.minimal': 'न्यून',
  'subagent.mode.short': 'संक्षिप्त',
  'subagent.mode.full': 'पूर्ण',

  'verbosity.choose': '🔊 वर्तमान आउटपुट विस्तार: {current}\nएक स्तर चुनें:',
  'verbosity.set_success': '✅ आउटपुट विस्तार: {mode} (thinking, टूल-परिणाम, सब-एजेंट)',
  'verbosity.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'verbosity.custom': 'कस्टम (thinking: {thinking} · टूल: {toolResults} · सब-एजेंट: {subagent})',
  'verbosity.mode.minimal': 'न्यून',
  'verbosity.mode.short': 'संक्षिप्त',
  'verbosity.mode.full': 'पूर्ण',

  'model.set_success': '🧠 मॉडल सेट किया गया: {model}',
  'model.saved_for_next_start': 'मॉडल सहेजा गया: {model} — अगली एजेंट शुरुआत पर लागू।',
  'model.start_agent_first': 'कोई सक्रिय सत्र नहीं। पहले एक एजेंट शुरू करें।',
  'model.current_default': 'डिफ़ॉल्ट',
  'model.none_available': '🧠 वर्तमान: {current}\n\nकोई मॉडल उपलब्ध नहीं है। /model <provider/model> से मैन्युअल रूप से सेट करें।',
  'model.invalid_number': '❌ अमान्य संख्या। सूची देखने के लिए /model चलाएँ।',
  'model.pick_provider': '🧠 वर्तमान: {current}\n\nएक प्रदाता चुनें:',
  'model.all_hidden': '🧠 वर्तमान: {current}\n\nसभी प्रदाता छिपे हुए हैं। किसी एक को वापस लाने के लिए 👁 दबाएँ।',
  'model.hidden_header': '🙈 इस सूची से छिपाया गया — वापस लाने के लिए 👁 दबाएँ।',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ प्रदाता',
  'model.prev_button': '⬅️ पिछला',
  'model.next_button': 'अगला ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} मॉडल · पृष्ठ {page}/{totalPages}\nवर्तमान: {current}',
  'model.page_hint': 'चुनने के लिए संख्या भेजें, या खोजने के लिए /model <नाम>।',
  'model.page_hint_buttons_only': 'बदलने के लिए किसी मॉडल पर टैप करें, या खोजने के लिए /model <नाम>।',

  'disconnect.unsupported_backend': 'इस बिल्ड में OpenCode प्रदाता डिस्कनेक्ट उपलब्ध नहीं है।',
  'disconnect.invalid_provider': '❌ अमान्य प्रदाता id {provider}। उदाहरण: /disconnect openrouter',
  'disconnect.no_providers': 'डिस्कनेक्ट करने के लिए कोई प्रदाता नहीं।',
  'disconnect.pick_provider': 'डिस्कनेक्ट करने के लिए प्रदाता चुनें — उसके सहेजे गए क्रेडेंशियल हटा दिए जाएँगे:',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ प्रदाता {provider} डिस्कनेक्ट हुआ — सहेजे गए क्रेडेंशियल हटा दिए गए।',
  'disconnect.still_active_env': '⚠️ {provider} के सहेजे गए क्रेडेंशियल हटा दिए गए, लेकिन वह अब भी सक्रिय है: OpenCode उसे एक एनवायरनमेंट वेरिएबल से सक्षम करता है। उस वेरिएबल को हटाकर OpenCode पुनः आरंभ करें, या /model से उसे सूची में छिपा दें।',
  'disconnect.failed': '⚠️ {provider} डिस्कनेक्ट नहीं हो सका: {reason}',

  'rename_session.usage': 'उपयोग: /rename_session <नया शीर्षक>',
  'rename_session.start_agent_first': 'कोई सक्रिय सत्र नहीं। पहले एक एजेंट शुरू करें (/claude या /opencode)।',
  'rename_session.unsupported_backend': '{label} के लिए सत्र नाम परिवर्तन समर्थित नहीं।',
  'rename_session.success': '✅ सत्र का नाम बदला गया: {title}',
  'rename_session.failed': '⚠️ सत्र का नाम बदलने में विफल: {reason}',

  'compact.started': '🧹 सत्र का संदर्भ संक्षिप्त किया जा रहा है — एजेंट सारांश से आगे बढ़ेगा।',
  'compact.done': '✅ संदर्भ संक्षिप्त कर दिया गया।',
  'compact.done_tokens': '✅ संदर्भ संक्षिप्त कर दिया गया: {pre} → {post} टोकन।',
  'compact.summaryHeader': '📄 संक्षेपण का सारांश:',
  'compact.start_agent_first': 'कोई सक्रिय सत्र नहीं। पहले एक एजेंट शुरू करें (/claude या /opencode)।',
  'compact.unsupported_backend': '{label} के लिए संदर्भ संक्षेपण समर्थित नहीं।',
  'compact.model_unresolved': '⚠️ संक्षिप्त नहीं कर सकते: इस सत्र के लिए कोई मॉडल तय नहीं है। /model से एक चुनें और फिर प्रयास करें।',
  'compact.failed': '⚠️ सत्र का संदर्भ संक्षिप्त करने में विफल: {reason}',
  'compact.busy': '⚠️ एजेंट अभी व्यस्त है — वर्तमान टर्न पूरा होने पर फिर से /compact चलाएँ।',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN HINDI: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 निष्क्रिय रहने पर कैश के ज़रिए टोकन बचाने के लिए स्वतः संक्षिप्त कर दिया गया।\nबंद करने के लिए /compact_on_idle चलाएँ।',
  'compactOnIdle.on': 'चालू',
  'compactOnIdle.off': 'बंद',
  'compactOnIdle.title': '🧹 इस विषय के लिए निष्क्रियता पर स्वतः संक्षेपण: {state}\n\nजब सत्र ~55 मिनट निष्क्रिय रहता है, तो टोकन बचाने के लिए इसका संदर्भ स्वतः संक्षिप्त हो जाता है (प्रॉम्प्ट कैश अभी भी गर्म रहता है)।\n\nसभी विषयों के लिए एक साथ बदलने हेतु इसे General विषय में चलाएँ।',
  'compactOnIdle.titleGeneral': '🧹 निष्क्रियता पर स्वतः संक्षेपण — सभी विषयों के लिए डिफ़ॉल्ट: {state}\n\nजब कोई सत्र ~55 मिनट निष्क्रिय रहता है, तो टोकन बचाने के लिए इसका संदर्भ स्वतः संक्षिप्त हो जाता है।\n\nप्रत्येक विषय अपने /compact_on_idle से इसे बदल सकता है।',
  'compactOnIdle.enableButton': 'सक्षम करें',
  'compactOnIdle.disableButton': 'अक्षम करें',
  'compactOnIdle.setThisTopic': '✅ निष्क्रियता पर स्वतः संक्षेपण: इस विषय के लिए {state}।',
  'compactOnIdle.setGlobal': '✅ निष्क्रियता पर स्वतः संक्षेपण: सभी विषयों के लिए {state} (प्रति-विषय ओवरराइड अब भी लागू रहते हैं)।',
  'compactOnIdle.unsupported': 'निष्क्रियता पर स्वतः संक्षेपण किसी सक्रिय एजेंट सत्र पर लागू होता है। पहले किसी बाउंड विषय में /claude या /opencode शुरू करें।',
  'compactOnIdle.pendingQuestionReask': '❓ आपका एक प्रश्न अब भी लंबित है। उत्तर देकर आगे बढ़ने के लिए किसी विकल्प पर टैप करें:',
  'compactSummary.on': 'चालू',
  'compactSummary.off': 'बंद',
  'compactSummary.title':
    '📄 इस विषय में संक्षेपण का सारांश पोस्ट करें: {state}\n\nसंक्षेपण के बाद एजेंट का पूरा सारांश विषय में लिखा जाता है, ताकि आप देख सकें कि क्या रखा गया।\n\nसभी विषयों के लिए एक साथ बदलने के लिए, इसे General विषय में चलाएँ।',
  'compactSummary.titleGeneral':
    '📄 संक्षेपण का सारांश पोस्ट करें — सभी विषयों के लिए डिफ़ॉल्ट: {state}\n\nसंक्षेपण के बाद एजेंट का पूरा सारांश विषय में लिखा जाता है, ताकि आप देख सकें कि क्या रखा गया।\n\nप्रत्येक विषय अपने /compact_summary से इसे बदल सकता है।',
  'compactSummary.enableButton': 'चालू करें',
  'compactSummary.disableButton': 'बंद करें',
  'compactSummary.setThisTopic': '✅ संक्षेपण का सारांश: इस विषय के लिए {state}।',
  'compactSummary.setGlobal': '✅ संक्षेपण का सारांश: सभी विषयों के लिए {state} (प्रति-विषय बदलाव फिर भी लागू रहते हैं)।',
  'compactSummary.unsupported': 'शेल के पास संक्षिप्त करने योग्य संदर्भ नहीं है, इसलिए पोस्ट करने के लिए कोई सारांश नहीं है।',

  'autoContinueLimits.on': 'चालू',
  'autoContinueLimits.off': 'बंद',
  'autoContinueLimits.title': '🚧 इस विषय के लिए उपयोग-सीमा के बाद स्वतः पुनःआरंभ: {state}\n\nजब एजेंट उपयोग या सत्र की सीमा पर पहुँचता है, तो बॉट अवधि रीसेट होने तक प्रतीक्षा करता है और प्रतीक्षा के बाद स्वयं एजेंट से आगे बढ़ने को कहता है (पुनःआरंभ संदेश पिन किया जाता है, इसलिए म्यूट किए विषय में भी सूचना मिलती है)।\n\nसभी विषयों के लिए एक साथ बदलने हेतु इसे General विषय में चलाएँ।',
  'autoContinueLimits.titleGeneral': '🚧 उपयोग-सीमा के बाद स्वतः पुनःआरंभ — सभी विषयों के लिए डिफ़ॉल्ट: {state}\n\nजब कोई एजेंट उपयोग या सत्र की सीमा पर पहुँचता है, तो बॉट अवधि रीसेट होने तक प्रतीक्षा करता है और फिर स्वयं एजेंट से आगे बढ़ने को कहता है।\n\nप्रत्येक विषय अपने /auto_continue_limits से इसे बदल सकता है।',
  'autoContinueLimits.enableButton': 'सक्षम करें',
  'autoContinueLimits.disableButton': 'अक्षम करें',
  'autoContinueLimits.skipButton': '⏭ एक बार छोड़ें',
  'autoContinueLimits.skipDone': 'यह पुनःआरंभ छोड़ दिया गया।',
  'autoContinueLimits.skipExpired': 'छोड़ने को कुछ नहीं — यह प्रतीक्षा पहले ही समाप्त हो चुकी है।',
  'autoContinueLimits.skippedNotice': '⏭ छोड़ दिया: मैं इसे स्वयं पुनः शुरू नहीं करूँगा। कब जारी रखना है, मुझे लिखें — इस विषय के लिए स्वतः पुनःआरंभ चालू रहेगा।',
  'autoContinueLimits.noticeHint': 'इस एक पुनःआरंभ को छोड़ने या इस विषय के लिए स्वतः पुनःआरंभ बंद करने हेतु /auto_continue_limits चलाएँ।',
  'autoContinueLimits.setThisTopic': '✅ उपयोग-सीमा के बाद स्वतः पुनःआरंभ: इस विषय के लिए {state}।',
  'autoContinueLimits.setGlobal': '✅ उपयोग-सीमा के बाद स्वतः पुनःआरंभ: सभी विषयों के लिए {state} (प्रति-विषय ओवरराइड अब भी लागू रहते हैं)।',
  'autoContinueLimits.limitReachedDisabled': '🚧 उपयोग-सीमा पूरी हो गई। इस विषय के लिए स्वतः पुनःआरंभ बंद है, इसलिए मैं रुका हूँ — कब जारी रखना है, मुझे लिखें (स्वतः जारी रखने के लिए /auto_continue_limits on)।',

  'connect.prompt_key': '🔑 अगले संदेश में `{provider}` के लिए API key भेजें। मैं key संदेश को इतिहास से हटा दूँगा।',
  'connect.empty_key': '❌ API key खाली है। अगले संदेश में key भेजें।',
  'connect.invalid_key': '❌ यह API key जैसा नहीं लगता (इसमें स्पेस या गैर-लैटिन अक्षर हैं)। अगले संदेश में केवल key भेजें, या /connect फिर से चलाएँ।',
  'connect.invalid_provider': '❌ अमान्य प्रदाता id `{provider}`। उदाहरण: /connect openai',
  'connect.unsupported_provider': '⚠️ प्रदाता `{provider}` इस प्रवाह के माध्यम से सरल API-key लॉगिन का समर्थन नहीं करता। इस प्रदाता के लिए OpenCode UI/CLI का उपयोग करें।',
  'connect.unsupported_backend': 'इस बिल्ड में OpenCode प्रदाता प्रमाणीकरण उपलब्ध नहीं।',
  'connect.failed': '⚠️ `{provider}` कनेक्ट करने में विफल: {reason}',
  'connect.success': '✅ प्रदाता `{provider}` कनेक्ट हो गया। OpenCode सर्वर पुनः प्रारंभ नहीं हुआ।',
  'connect.cancelled': 'API key प्रविष्टि रद्द।',
  'connect.pick_method': '`{provider}` को कैसे कनेक्ट करें? एक तरीका चुनें:',
  'connect.no_methods': '⚠️ `{provider}` के लिए कोई प्रमाणीकरण तरीका नहीं मिला।',
  'connect.oauth_device': '🔓 `{provider}` कनेक्ट करने के लिए: {url} खोलें और कोड `{code}` दर्ज करें, फिर अधिकृत करें। सर्वर पर *headless* तरीका उपयोग करें। पूरा होने पर मैं यहाँ पुष्टि करूँगा।',
  'connect.oauth_url_only': '🔓 `{provider}` कनेक्ट करने के लिए: {url} खोलें और साइन-इन पूरा करें। पूरा होने पर मैं यहाँ पुष्टि करूँगा।',
  'connect.oauth_paste': '🔑 अधिकृत करने के बाद, कोड को अगले संदेश के रूप में यहाँ पेस्ट करें — मैं इसे इतिहास से हटा दूँगा।',
  'connect.oauth_waiting': '⏳ अधिकृतिकरण की प्रतीक्षा…',
  'connect.oauth_loopback': '🔑 अधिकृत करने के बाद, आपका ब्राउज़र एक `localhost` पेज खोलने की कोशिश करेगा जो लोड नहीं होगा — यहाँ यह अपेक्षित है। उस URL को एड्रेस बार से कॉपी करें और अगले संदेश के रूप में पेस्ट करें (या केवल `code` मान)। मैं इसे इतिहास से हटा दूँगा और साइन-इन पूरा करूँगा।',
  'connect.oauth_invalid_reply': '❌ यह न तो callback URL जैसा लगता है और न ही auth code जैसा। अधिकृत करने के बाद, अपने ब्राउज़र से `localhost` callback URL (या `code` मान) पेस्ट करें।',
  'connect.oauth_callback_no_flow': '⚠️ यह OAuth callback URL जैसा लगता है, लेकिन यहाँ कोई साइन-इन प्रगति में नहीं है — मैंने इसे हटा दिया। फिर से शुरू करने के लिए /connect चलाएँ।',
  'connect.oauth_success': '✅ `{provider}` OAuth के माध्यम से कनेक्ट हुआ। OpenCode सर्वर के क्रेडेंशियल फिर से लोड किए गए।',
  'connect.oauth_failed': '⚠️ `{provider}` के लिए OAuth साइन-इन पूरा नहीं हुआ। /connect फिर से चलाएँ।',
  'quit_all.none_active': 'कोई एजेंट नहीं चल रहा — रोकने के लिए कुछ नहीं।',
  'quit_all.summary': '🚪 {total} में से {stopped} सक्रिय एजेंट बंद किए।',
  'quit_all.general_only': '`/quit-all` केवल General टॉपिक में उपलब्ध है।',

  'clearMessages.summary':
    '🗑 {total} में से {deleted} संदेश हटाए। ' +
    'Telegram 48 घंटे से पुराने संदेश हटाने से इनकार करता है — बाकी इतिहास में रहते हैं।',
  'clearMessages.no_messages': 'इस थ्रेड में हटाने के लिए कोई संदेश नहीं।',

  'edited.hint':
    '✏️ मैं संपादित संदेशों को नया इनपुट नहीं मानता — सुधार एक अलग संदेश के रूप में भेजें।',

  'voice.no_api_key':
    'वॉइस के लिए `GROQ_API_KEY` (मुफ़्त) या `OPENAI_API_KEY` चाहिए।',
  'voice.failed': 'वॉइस संदेश ट्रांसक्राइब करने में विफल।',
  'voice.retrying': '⚠️ वॉइस संदेश ट्रांसक्राइब करने में विफल ({error})। {seconds} सेकंड में फिर से कोशिश की जाएगी…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 फ़ाइल Bot API सीमा ({cap} MB) से बड़ी है — मैं इसे डाउनलोड नहीं कर सकता। एक छोटी फ़ाइल भेजें।',
  'file.download_failed': '📎 फ़ाइल डाउनलोड करने में विफल। पुनः प्रयास करें।',

  'error.workdir.gone':
    '📁 फ़ोल्डर `{subdir}` डिस्क से गायब हो गया। /bind <newdir> चलाएँ।',
  'error.tg.thread.deleted':
    '⚠️ थ्रेड Telegram में हटा दिया गया; बाइंडिंग हटाई गई।',
  'error.tg.thread.closed':
    '🔒 थ्रेड {key} बंद है — अपने Telegram क्लाइंट में पुनः खोलें, या पूरी तरह हटाएँ।',
  'error.tg.perm.delete':
    '🔐 संदेश हटा नहीं सकते। Bot को `can_delete_messages` प्रदान करें।',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` अनुपलब्ध। मुझे ग्रुप एडमिन बनाएँ।',
  'error.state.corrupted':
    '⚠️ state.json दूषित था; बाइंडिंग रीसेट की गई। आवश्यकतानुसार /bind पुनः चलाएँ।',
  'error.start_in_general':
    'General में एजेंट शुरू नहीं कर सकते — वह एक सेवा टॉपिक है। एक विषय-वस्तु थ्रेड खोलें।',

  'cb.access_denied': 'पहुँच अस्वीकृत',
  'cb.bind_only_topical': '/bind केवल विषय-वस्तु थ्रेड्स में काम करता है',
  'cb.binding_to': '{subdir} से बाइंड हो रहा है…',
  'cb.no_active_session': 'कोई सक्रिय सत्र नहीं',
  'cb.model_error': 'त्रुटि: {error}',
  'cb.model_set': 'मॉडल: {model}',
  'cb.model_provider_gone': 'वह प्रदाता अब नहीं है — /model फिर चलाएँ',
  'cb.model_hidden': 'छिपाया: {provider}',
  'cb.model_shown': 'दिखाया: {provider}',
  'cb.disconnect_expired': 'यह डिस्कनेक्ट मेनू समाप्त हो गया — /disconnect फिर चलाएँ',
  'cb.not_supported': '{label} के लिए समर्थित नहीं',
  'cb.unknown_agent': 'अज्ञात एजेंट',
  'cb.agent_switched': '{label} पर स्विच किया',
  'cb.resume_only_topical': 'Resume केवल विषय-वस्तु थ्रेड्स में काम करता है',
  'cb.bind_folder_first': 'पहले /bind से फ़ोल्डर बाइंड करें',
  'cb.agent_not_running': 'एजेंट नहीं चल रहा',
  'cb.no_pending_question': 'कोई लंबित प्रश्न नहीं',
  'cb.connect_method_expired': 'यह कनेक्ट मेनू समाप्त हो गया — /connect फिर से चलाएँ',
  'cb.invalid_option': 'अमान्य विकल्प',
  'cb.sent_option': 'भेजा: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'त्रुटि: {error}',
  'cb.claudeMode_already': 'पहले से सक्रिय',
  'cb.claudeMode_switching': 'स्विच कर रहा है…',
  'claudeMode.pick': '⚙️ Claude Code बैकएंड — वर्तमान: {label}\nएक बैकएंड चुनें (स्विच वही बातचीत बनाए रखता है):',
  'claudeMode.not_claude': "यह टॉपिक Claude Code पर नहीं है — /claude_mode केवल Claude का बैकएंड बदलता है।",
  'claudeMode.already': 'पहले से {label}।',
  'claudeMode.set_idle': '⚙️ Claude बैकएंड: {label} — अगली शुरुआत पर लागू।',
  'claudeMode.switched_resumed': '⚙️ {label} पर स्विच — वही बातचीत जारी।',
  'claudeMode.switched_fresh': '⚙️ {label} पर स्विच — नया सत्र शुरू।',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'त्रुटि: {error}',
  'cb.toolresults_set': 'टूल-परिणाम: {mode}',
  'cb.toolresults_error': 'त्रुटि: {error}',
  'cb.subagent_set': 'सब-एजेंट: {mode}',
  'cb.subagent_error': 'त्रुटि: {error}',
  'cb.verbosity_set': 'आउटपुट विस्तार: {mode}',
  'cb.verbosity_error': 'त्रुटि: {error}',

  'session.list_header': 'पुनः आरंभ करने योग्य सत्र ({label}):',
  'session.list_footer': 'पुनः आरंभ 1–{max} · बाहर निकलने के लिए 0 भेजें',
  'session.none': 'इस फ़ोल्डर में पुनः आरंभ करने योग्य कोई सत्र नहीं।',
  'session.cancelled': 'रद्द। सत्र चयनकर्ता बंद।',
  'session.invalid': 'अमान्य नंबर। 1 से {max} तक का मान दर्ज करें।',
  'session.resumed': 'सत्र पुनः आरंभ। अपना संदेश भेजें:',
  'session.resume_failed': 'सत्र पुनः आरंभ विफल: {error}',
  'session.expired': 'सत्र सूची पुरानी है। /sessions पुनः चलाएँ।',
  'session.load_failed': 'सत्र लोड करने में विफल।',

  'resume.context_header': '↩️ पुनः आरंभ — अंतिम {count} संदेश:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot ऑफ़लाइन रहने पर {count} संदेश छूटे। सत्र का नवीनतम:',
  'recap.restartedFallbackHeader': '🔄 Bot पुनः प्रारंभ। सत्र का नवीनतम:',
  'recap.stillWorkingLine': '⏳ एजेंट अभी भी काम कर रहा है…',

  'trace.onThisThreadReply': '🔎 इस थ्रेड के लिए ट्रेस सक्षम।',
  'trace.offThisThreadReply': '🔎 इस थ्रेड के लिए ट्रेस अक्षम।',
  'trace.onAllThreadsReply': '🔎 सभी थ्रेड्स के लिए ट्रेस सक्षम।',
  'trace.offAllThreadsReply': '🔎 सभी जगह ट्रेस अक्षम («all» फ़्लैग और थ्रेड सूची साफ़)।',
  'trace.statusReply':
    '🔎 Trace — यह थ्रेड: {thisThread}\nसभी थ्रेड्स: {allThreads}\nट्रेस किए गए थ्रेड्स: {count}',
  'trace.statusOnLabel': 'चालू',
  'trace.statusOffLabel': 'बंद',
  'trace.usageHint': 'उपयोग: /trace on | off | on all | off all | (बिना तर्क — स्थिति)',

  'timestamps.onReply':
    '🕐 टाइमस्टैम्प सक्षम: एजेंट को भेजा गया प्रत्येक प्रॉम्प्ट पहली पंक्ति में समय प्राप्त करता है (टॉपिक में पोस्ट नहीं)।',
  'timestamps.offReply': '🕐 इस थ्रेड के लिए टाइमस्टैम्प अक्षम।',
  'timestamps.statusOnReply': '🕐 टाइमस्टैम्प: इस थ्रेड के लिए चालू।',
  'timestamps.statusOffReply': '🕐 टाइमस्टैम्प: इस थ्रेड के लिए बंद।',
  'timestamps.usageHint': 'उपयोग: /timestamps on | off | (बिना तर्क — स्थिति)',

  'schedule.fired':
    '⏰ शेड्यूल «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — {time} पर छूटा, पकड़ रहा हूँ',
  'schedule.checkFailed':
    '🚨 जाँच «{name}» विफल: {failure} ({schedule}){missedNote}\n$ {command}\n\n{output}\n\nएजेंट को जगा रहा हूँ। जाँच फिर से पास होने तक और अलर्ट नहीं आएँगे।',
  'schedule.checkRecovered': '✅ जाँच «{name}» फिर से पास हो रही है।',
  'schedule.pausedUnbound':
    '⏸ रुके हुए शेड्यूल: {count} — टॉपिक अपने फ़ोल्डर से अनबाउंड हो गया। /bind उन्हें वापस लाएगा।',
  'schedule.resumedRebind': '▶️ शेड्यूल पुनः शुरू: {count} (अगला रन अब से पुनः गणना)।',
  'schedule.noAgent':
    '⚠️ कुछ भी शेड्यूल नहीं हुआ — इस टॉपिक में कोई एजेंट नहीं चल रहा, इसलिए शेड्यूल किए गए रन के पास शुरू करने के लिए कुछ नहीं होगा। पहले /claude या /opencode शुरू करें।',
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN HINDI what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN HINDI what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN HINDI what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': 'हर दिन {time} बजे',
  'reminders.scheduleWeekdays': 'कार्यदिवसों पर {time} बजे',
  'reminders.scheduleWeekly': '{weekday} को {time} बजे',
  'reminders.scheduleMonthly': 'हर महीने {dayOfMonth} तारीख को {time} बजे',
  'reminders.scheduleOnce': '{date} को {time} बजे',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': 'आज {time} बजे',
  'reminders.nextRunTomorrow': 'कल {time} बजे',
  'reminders.nextRunOnDate': '{date} को {time} बजे',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 रिमाइंडर',
  'reminders.hubEmptyLine': 'अभी कोई रिमाइंडर नहीं।',
  'reminders.hubActiveLine': 'सक्रिय: {count}',
  'reminders.hubLimitLine':
    'सक्रिय: {count} — {limit} की सीमा पूरी हो गई। नया जोड़ने के लिए एक हटाएँ।',
  'reminders.addButton': '➕ जोड़ें',
  'reminders.listButton': '📋 सूची ({count})',
  'reminders.closeButton': '✕ बंद करें',
  'reminders.closedNotice': '🔔 रिमाइंडर बंद किए गए।',
  'reminders.listTitle': '📋 रिमाइंडर ({count})',
  'reminders.listPageLine': 'पृष्ठ {page}/{total}',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ पिछला',
  'reminders.listNextButton': 'अगला ›',
  'reminders.listBackToHubButton': '‹ वापस',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'कब: {schedule}',
  'reminders.cardText': 'टेक्स्ट: "{text}"',
  'reminders.cardNext': 'अगला: {next}',
  'reminders.cardDeleteButton': '🗑 हटाएँ',
  'reminders.cardBackToListButton': '‹ सूची पर',
  'reminders.createdTitle': '✅ रिमाइंडर बन गया',
  'reminders.doneListButton': '📋 सूची',
  'reminders.wizardTitle': '🔔 नया रिमाइंडर',
  'reminders.pickRepeat': 'दोहराव: {value}',
  'reminders.pickDate': 'तारीख: {value}',
  'reminders.pickWeekday': 'सप्ताह का दिन: {value}',
  'reminders.pickDayOfMonth': 'महीने का दिन: {value}',
  'reminders.pickTime': 'समय: {value}',
  'reminders.pickText': 'टेक्स्ट: "{value}"',
  'reminders.stepRepeatQuestion': 'चरण 1/4 · कितनी बार?',
  'reminders.stepDateQuestion': 'चरण 2/4 · कौन सा दिन?',
  'reminders.stepDateGridQuestion': 'चरण 2/4 · तारीख चुनें:',
  'reminders.stepWeekdayQuestion': 'चरण 2/4 · सप्ताह का कौन सा दिन?',
  'reminders.stepDayOfMonthQuestion': 'चरण 2/4 · महीने का कौन सा दिन?',
  'reminders.stepDayOfMonthGridQuestion': 'चरण 2/4 · महीने का दिन चुनें:',
  'reminders.stepTimeQuestion': 'चरण 3/4 · किस समय?',
  'reminders.stepHourQuestion': 'चरण 3/4 · घंटा चुनें:',
  'reminders.stepMinuteQuestion': 'चरण 3/4 · {hour}:__ — मिनट चुनें:',
  'reminders.stepTextQuestion':
    'चरण 4/4 · रिमाइंडर का टेक्स्ट भेजें — टाइप करें या वॉइस नोट रिकॉर्ड करें।',
  'reminders.repeatOnceButton': 'एक बार',
  'reminders.repeatDailyButton': 'दैनिक',
  'reminders.repeatWeekdaysButton': 'कार्यदिवस',
  'reminders.repeatWeeklyButton': 'साप्ताहिक',
  'reminders.repeatMonthlyButton': 'मासिक',
  'reminders.dateTodayButton': 'आज',
  'reminders.dateTomorrowButton': 'कल',
  'reminders.dateOtherButton': '✏️ अन्य तारीख…',
  'reminders.dayOfMonthOtherButton': '✏️ अन्य दिन…',
  'reminders.timeOtherButton': '🕐 अन्य समय',
  'reminders.backButton': '‹ वापस',
  'reminders.cancelButton': '✕ रद्द करें',
  'reminders.weekdayMondayButton': 'सोम',
  'reminders.weekdayTuesdayButton': 'मंगल',
  'reminders.weekdayWednesdayButton': 'बुध',
  'reminders.weekdayThursdayButton': 'गुरु',
  'reminders.weekdayFridayButton': 'शुक्र',
  'reminders.weekdaySaturdayButton': 'शनि',
  'reminders.weekdaySundayButton': 'रवि',
  'reminders.errorPastTime': '⚠️ वह समय बीत चुका है। कोई बाद का समय चुनें, या वापस जाकर दिन बदलें।',
  'reminders.errorInvalidDate': '⚠️ वह तारीख मौजूद नहीं है। कोई दूसरी चुनें।',
  'reminders.errorInvalidTime':
    '⚠️ उस दिन वह समय मौजूद नहीं है — घड़ी बदलती है। कोई दूसरा समय चुनें।',
  'reminders.errorTextTooLong':
    '⚠️ यह टेक्स्ट बहुत लंबा है (अधिकतम {limit} अक्षर) और सहेजा नहीं गया। छोटा टेक्स्ट भेजें।',
  'reminders.cancelledNotice': '✕ रद्द किया गया',
  'reminders.expiredNotice': '✕ समय समाप्त — रिमाइंडर का टेक्स्ट कभी नहीं आया।',
  'reminders.capReachedNotice':
    '⚠️ इस टॉपिक में पहले से {limit} रिमाइंडर हैं — नया जोड़ने से पहले एक हटाएँ।',
  'reminders.wizardExpiredCbAnswer': 'यह विज़ार्ड पुराना हो गया — /reminders फिर चलाएँ।',
  'reminders.deletedCbAnswer': '🗑 हटाया गया',
  'reminders.deleteGoneCbAnswer': 'पहले ही हटाया गया।',
  'reminders.cardExpiredCbAnswer': 'वह रिमाइंडर मौजूद नहीं है।',

  'apiRetry.transientNotice':
    '⏳ API दर-सीमित — {minutes} मिनट में स्वतः पुनः प्रयास (प्रयास {attempt})।',
  'apiRetry.usageLimitDelayNotice':
    '🚧 उपयोग सीमा पहुँची — {minutes} मिनट में पुनः प्रयास (प्रयास {attempt})।',
  'apiRetry.usageLimitResetNotice':
    '🚧 उपयोग सीमा पहुँची — रीसेट के बाद स्वतः पुनः ( ~{time})।',
  'apiRetry.resuming': '↻ पुनः शुरू…',
  'apiRetry.limitResetResuming': '✅ सीमा की अवधि रीसेट हो गई — मैं इस विषय में काम फिर शुरू कर रहा हूँ।',
  'apiRetry.giveUp':
    '⚠️ {attempts} प्रयासों के बाद पुनः शुरू नहीं कर सका। जब जारी रखना हो तो संदेश भेजें।',
  'apiRetry.continueNudge': 'जहाँ रुके थे वहाँ से जारी रखें।',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude लॉगआउट है — जारी रखने के लिए /login चलाएँ।',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: अमान्य क्रेडेंशियल — opencode सर्वर पुनः प्रारंभ करें।',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ तैयार — मैं बॉट थ्रेड और ग्रुप टॉपिक में संदेश संभाल सकता हूँ।',
  'startup.header_not_ready':
    '⚠️ सेटअप अधूरा है। मेरे साथ काम शुरू करने के लिए, कृपया ये चरण पूरे करें:',
  'startup.item.create_group':
    'Topics सक्षम के साथ एक फ़ोरम सुपरग्रुप बनाएँ, फिर उसे जोड़ने के लिए वहाँ मुझे एक संदेश भेजें।',
  'startup.item.grant_admin':
    'मुझे इन अधिकारों के साथ एडमिन बनाएँ: {missing}।',
  'startup.item.bind_topic':
    'एक टॉपिक बनाएँ और /bind से उसे किसी फ़ोल्डर से बाँधें।',
  'startup.item.install_agent':
    'एक एजेंट CLI इंस्टॉल करें — claude या opencode।',
  'startup.item.optional_groq':
    '(वैकल्पिक) वॉइस इनपुट सक्षम करने के लिए अपनी .env में GROQ_API_KEY जोड़ें और पुनः आरंभ करें।',
  'startup.item.optional_owner':
    '(वैकल्पिक) यह स्थिति अपने निजी चैट में पाने के लिए OWNER_USER_ID सेट करें।',
};
