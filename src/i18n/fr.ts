// Machine-translated from en. Native review welcome.

export const frDict: Record<string, string> = {
  'access.denied': 'Accès refusé.',
  'access.group_only': 'Je ne fonctionne que dans le super-groupe forum configuré.',

  'thread.no_binding':
    '📁 Ce fil n\'est pas lié à un dossier. Utilisez /bind <subdir> ou choisissez dans la liste.',
  'thread.bind_required':
    '📁 Liez d\'abord un dossier : /bind <subdir>. L\'agent ne fonctionne que dans le dossier lié.',
  'thread.bound': '📁 Lié à `{subdir}`.\nLancez /claude ou /opencode.',
  'thread.unbound': '📁 Lien effacé.',
  'thread.general_no_agent':
    'General n\'est pas lié à un dossier — passez à un fil thématique pour parler à un agent.',
  'thread.welcome_bound':
    '👋 Fil créé et lié automatiquement à `{subdir}` (nom du fil correspondait à un sous-dossier).\nLancez /claude ou /opencode.',
  'thread.welcome_pick':
    '👋 Fil créé. Liez un dossier : /bind <subdir>, ou choisissez-en un ci-dessous.',
  'thread.bind_collision':
    '⚠️ Le dossier `{subdir}` est déjà utilisé par les fils : {threads}.\nLien ajouté ; les sessions restent indépendantes (tmux/SSE séparés).',
  'thread.no_agent_with_binding':
    '📁 Le dossier `{subdir}` est lié. Lancez /claude ou /opencode pour commencer le dialogue.',

  'bind.usage': 'Utilisation : /bind <subdir>\nExemple : /bind overview',
  'bind.current': '📂 Actuellement lié : `{subdir}`',
  'bind.current_none': '📂 Pas encore lié',
  'bind.in_general': '/bind ne fonctionne que dans les fils thématiques, pas dans General.',
  'bind.invalid_chars': '❌ Le nom du dossier ne doit pas contenir de caractères de contrôle.',
  'bind.not_found': '❌ Dossier `{subdir}` introuvable sous `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Le chemin sort de `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` existe mais n\'est pas un dossier.',

  'bind.leave_button': '⬅️ Quitter le dossier actuel',
  'bind.create_button': '➕ Créer un nouveau dossier',
  'bind.create_prompt':
    '✏️ Envoyez le nom du nouveau dossier (il sera créé sous `WORK_ROOT`). Toute commande annule.',
  'bind.create_cb': 'Création d\'un nouveau dossier…',
  'bind.create_empty': '❌ Le nom est vide. Envoyez un nom de dossier.',
  'bind.create_separator': '❌ Le nom ne doit pas contenir `/` ou `\\`. Envoyez un nom simple.',
  'bind.create_dot_segment': '❌ `.` et `..` ne peuvent pas être utilisés comme nom de dossier.',
  'bind.create_hidden': '❌ Le nom ne doit pas commencer par un point.',
  'bind.create_invalid_chars': '❌ Le nom du dossier ne doit pas contenir de caractères de contrôle.',
  'bind.create_exists': '📁 Le dossier `{subdir}` existe déjà — liaison en cours.',
  'bind.create_failed': '❌ Échec de la création du dossier : {error}',

  'ls.header': '📁 Sous-dossiers de `{workRoot}` :',
  'ls.empty': '📁 Aucun sous-dossier liaisable sous `WORK_ROOT`.',
  'list.header': '🧵 Liens de fils ({count}) :',
  'list.empty': '🧵 Aucun lien pour l\'instant. Créez un fil et lancez /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new fonctionne dans un fil lié — ouvrez un fil et lancez /new pour redémarrer sa session d\'agent.',

  'help.general':
    '*Commandes dans General :*\n' +
    '/ls — lister les sous-dossiers `WORK_ROOT`\n' +
    '/list — lister les fils\n' +
    '/status — état de tous les fils\n' +
    '/quitall — arrêter tous les agents en cours\n' +
    '/whoami /version — débogage\n\n' +
    'Pour parler à un agent — ouvrez un fil thématique.',
  'help.thread_unbound':
    '*Le fil n\'est pas lié à un dossier.*\n' +
    '/bind <subdir> — lier (ou choisir dans la liste)\n' +
    '/ls — sous-dossiers `WORK_ROOT` (dans General)',
  'help.thread_bound':
    '*Fil lié à `{subdir}`.*\n' +
    '/claude /opencode — démarrer un agent\n' +
    '/connect — connecter une clé API de provider OpenCode (OpenAI par défaut)\n' +
    '/disconnect — supprimer les identifiants enregistrés d\'un provider\n' +
    '/terminal — ouvrir un shell dans ce dossier\n' +
    '/new — redémarrer la session (l\'ancienne → /sessions)\n' +
    '/model /sessions — basculer\n' +
    '/effort — niveau de reasoning effort\n' +
    '/verbosity — détail de sortie et ce que le sujet affiche (flux / réponses)\n' +
    '/quit /status /output — contrôle\n' +
    '/compact — compacter le contexte de l\'agent\n' +
    '/compact_on_idle — compactage auto après inactivité (bascule)\n' +
    '/auto_continue_limits — reprise auto après une limite d’usage (bascule)\n' +
    '/clear — supprimer les messages du fil\n' +
    '/c /y /n /enter /up /down /tab /esc — touches TUI (Claude)\n' +
    '/bind — gérer la liaison',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Le bot est admin du groupe',
  'doctor.can_manage_topics': '`can_manage_topics` accordé',
  'doctor.can_delete_messages': '`can_delete_messages` accordé',
  'doctor.can_pin_messages': '`can_pin_messages` accordé',
  'doctor.privacy_off': 'Privacy mode désactivé',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, puis retirer et ré-ajouter le bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT` : `{workRoot}` ({count} sous-dossiers)',
  'doctor.datadir_path': '`DATA_DIR` : `{dataDir}`',
  'doctor.claude_installed': 'claude CLI installé',
  'doctor.opencode_installed': 'opencode CLI installé',
  'doctor.state_valid':
    'state.json valide ({bindings} liens, {active} actifs)',
  'doctor.state_archived':
    'l\'ancien state.json était corrompu, archive : {path}',
  'doctor.cli_missing':
    'introuvable dans PATH (auto-install se lancera sur /claude ou /opencode)',
  'doctor.no_admin_info':
    'impossible de lire les droits du bot — getChatMember échoué',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Checklist de mise en service :\n' +
    '1️⃣ Faites de moi un admin de groupe avec les droits :\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, puis retirez et ré-ajoutez-moi\n' +
    '3️⃣ Lancez /doctor pour voir ce qui manque\n' +
    '4️⃣ Dans chaque fil thématique, lancez /bind <subdir> et démarrez un agent\n\n' +
    '`WORK_ROOT` : `{workRoot}`',

  'binding.welcome.header': '📁 Lié à `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md : {size}',
  'binding.welcome.mcp_json': '• `.mcp.json` : {count} serveurs',
  'binding.welcome.git': '• git : branche `{branch}`{detail}',
  'binding.welcome.git_clean': ', propre',
  'binding.welcome.git_dirty': ', modifications non validées',
  'binding.welcome.git_none': '• git : non initialisé',
  'binding.welcome.start_prompt': 'Démarrez une conversation :',

  'mcp.header': '🔌 *Serveurs MCP pour ce fil :*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 Aucun serveur MCP configuré.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Le statut épinglé du fil (Stage 7) sera indisponible',

  'whoami.report':
    '👤 user : `{userId}`\n💬 chat : `{chatId}`\n🧵 thread : `{threadId}`\n' +
    '🔐 allowed : {allowed}\n📁 binding : {binding}',
  'whoami.binding_unbound': '(aucun lien)',

  'pair.success': '✅ Groupe apparié. id : `{groupId}`. Le bot sert désormais ce super-groupe.',
  'pair.locked':
    'ℹ️ L\'id du groupe est défini via `ALLOWED_GROUP_ID` — l\'auto-appariement est désactivé. ' +
    'Pour changer de groupe, modifiez la variable et redémarrez le bot.',
  'pair.only_forum': '❌ /pair ne fonctionne que dans un super-groupe forum (activez Topics).',
  'pair.not_admin': '❌ Seul un administrateur ou créateur du groupe peut apparier le bot.',
  'pair.not_paired': 'groupe non encore apparié (mode pairing)',
  'pair.dm': "ℹ️ /pair n'est pas nécessaire en mode DM — le bot sert votre chat privé.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node : {node}\n' +
    'tmux : {tmux}\n' +
    'claude : {claude}\n' +
    'opencode : {opencode}',
  'version.unknown': '(indisponible)',
  'status.global_header': '📊 *Tous les fils* ({total}) :',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Aucun fil pour l\'instant.',
  'status.thread_report': 'Statut :\n\nAgent : {agent}\nDossier : {subdir}\nSession : {session}',
  'status.thread_view': 'Vue : {view}',
  'status.thread_model': 'Modèle : {model}',
  'status.thread_effort': 'Effort : {effort}',
  'status.thread_started': 'Démarré : {started}',
  'status.thread_running': 'en cours',
  'status.thread_stopped': 'arrêté',
  'status.thread_no_agent': 'aucun (lancez /claude ou /opencode)',
  'status.thread_no_binding': '(aucun lien — WORK_ROOT)',
  'status.thread_workdir': 'Répertoire de travail : {workDir}',
  'status.thread_runtime_version': 'Version d’exécution : {version}',
  'status.thread_context': 'Contexte : {used} / {limit} jetons',
  'language.status': '🌐 Langue : {display}',
  'language.set_success': '✅ Langue définie sur `{locale}` pour ce chat.',
  'language.auto_success': '✅ Langue réinitialisée en automatique. Actuelle : {display}.',
  'language.invalid': '⚠️ Locale `{locale}` non prise en charge. Disponibles : {locales}.',

  'timezone.status': '🌍 Fuseau horaire : {zone} — il est {now}',
  'timezone.usage':
    'Utilisation : /timezone <zone IANA>  ·  /timezone +04:00  ·  /timezone auto\nOu envoie /timezone sans argument pour choisir dans une liste.',
  'timezone.set_success': '✅ Fuseau horaire : {zone} — il est {now}\nPlanifications recalculées : {count}',
  'timezone.auto_success':
    '✅ Fuseau horaire réinitialisé sur celui de l’hôte : {zone} — il est {now}\nPlanifications recalculées : {count}',
  'timezone.invalid':
    '⚠️ Fuseau horaire `{zone}` inconnu. Utilise un nom IANA (par ex. `Europe/Moscow`) ou un décalage fixe (par ex. `+04:00`). Envoie /timezone pour choisir dans une liste.',
  'timezone.offset_unsupported':
    '⚠️ Le décalage `{zone}` ne peut pas être appliqué — seuls les décalages en heures entières fonctionnent. Utilise plutôt le nom IANA de ta zone (par exemple `Asia/Kolkata` pour +05:30).',
  'timezone.fixed_offset_warning':
    '⚠️ Un décalage fixe ne suit pas l’heure d’été — il sera décalé d’une heure la moitié de l’année.',
  'timezone.picker_regions': '🌍 Fuseau horaire : {zone}\nMaintenant : {now}\n\nChoisis une région :',
  'timezone.picker_zones': '🌍 {region} — page {page}/{total}',
  'timezone.picker_expired': 'Cette liste est obsolète — renvoie /timezone.',

  'agent.ready': '{label} prêt dans `{subdir}`{argsSuffix}\n{infoBlock}Envoyez un message :',
  'agent.ready_model': '🧠 Modèle : {model}',
  'agent.no_session': 'Aucun agent en cours. /claude ou /opencode pour démarrer.',
  'agent.session_ended': '{label} : session terminée',
  'agent.stopped': '{label} arrêté',
  'agent.exit_signal_sent': 'Double Ctrl+C envoyé — {label} en cours d\'arrêt',
  'agent.already_active': '{label} fonctionne déjà ici. Envoyez un message ou /quit.',
  'agent.starting': 'Démarrage de {label} dans `{subdir}`…',
  'agent.queued_starting': '⏳ {label} démarre encore — votre message est en file d\'attente et sera envoyé dès qu\'il sera prêt.',
  'agent.question_hint': 'ℹ️ Répondez avec le numéro d\'option (ex. 1) ou y/n. Aussi : /up /down pour naviguer, /enter pour confirmer, /c pour annuler.',
  'agent.start_failed': 'Échec du démarrage de {label} : {error}',
  'agent.no_response': '⚠️ L’agent a accepté votre demande mais n’a jamais commencé à répondre — la session est peut-être bloquée. Renvoyez-la, ou /new pour une nouvelle session.',
  'agent.session_restarting': '⚠️ L’agent n’a pas répondu — la session semble bloquée. Je la redémarre et relance votre demande…',
  'agent.session_recovering': '⚠️ L’agent n’a pas répondu — récupération (votre conversation est conservée) et relance de votre demande…',
  'agent.question_cancelled_for_prompt': '⚠️ Question précédente annulée — exécution de votre nouvelle requête.',
  'agent.question_cancelled_msg_label': '❌ Question annulée : {header}',
  'agent.login_code_relayed': '🔐 Code de connexion transmis à Claude — le message avec le jeton a été supprimé de l\'historique.',
  'agent.login_url': '🔐 Pour te connecter à Claude, ouvre ce lien, termine la connexion, puis colle le code ici :\n{url}',
  'agent.login_success': '✅ Connecté à Claude.',
  'agent.login_failed': '⚠️ Échec de la connexion à Claude. Lance /login pour réessayer.',
  'agent.workingIndicator': '{glyph} travail…',
  'terminal.ready': '🖥 Terminal prêt dans `{subdir}`{argsSuffix}\nChaque message est exécuté comme une commande. /c — Ctrl+C, /up /down — historique, /tab — complétion, /quit — fermer.',

  'effort.choose': '⚙️ Effort actuel : {current}\nChoisissez un niveau :',
  'effort.current_none': 'non défini',
  'effort.set_success': '✅ Effort : {level}',
  'effort.current_hint': '⚙️ Effort : {effort}\nLancez /effort pour le changer',
  'effort.invalid_level': '⚠️ Niveau `{level}` invalide. Disponibles : {valid}.',
  'effort.not_available': 'ℹ️ Aucun niveau de reasoning effort disponible pour le modèle actuel.',
  'effort.not_supported': 'ℹ️ Le modèle `{model}` n\'a pas de niveaux de reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Niveau enregistré. Aucun agent en cours — sera appliqué au prochain démarrage.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` effacé : le nouveau modèle `{model}` ne le prend pas en charge.',
  'effort.unsupported_backend': 'Le contrôle d\'effort n\'est pas pris en charge pour {label}.',
  'effort.no_session': 'Aucun agent en cours. Démarrez-en un avec /claude ou /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 a réfléchi pendant {seconds}s',
  'thinking.choose': '☁️ Mode de thinking actuel : {current}\nChoisissez un mode :',
  'thinking.set_success': '✅ Mode de thinking : {mode}',
  'thinking.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'court',
  'thinking.mode.full': 'complet',

  'toolResults.choose': '🔧 Mode de résultats d\'outils actuel : {current}\nChoisissez un mode :',
  'toolResults.set_success': '✅ Mode de résultats d\'outils : {mode}',
  'toolResults.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'court',
  'toolResults.mode.full': 'complet',
  'toolResults.truncated_footer': '… (tronqué, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'outil',

  'subagent.status_elapsed': '🤖 sous-agent : {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sous-agent travaille …',
  'subagent.delegating_status': '🤖 Délégation : {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sous-agent',
  'subagent.choose': '🤖 Mode de sous-agent actuel : {current}\nChoisissez un mode :',
  'subagent.set_success': '✅ Mode de sous-agent : {mode}',
  'subagent.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'court',
  'subagent.mode.full': 'complet',

  'verbosity.choose': '🔊 Sortie — détail : {current} · vue : {view}\nLigne 1 — détail du flux · Ligne 2 — ce que ce sujet affiche :',
  'verbosity.set_success': '✅ Verbosité de sortie : {mode} (thinking, résultats d\'outils, sous-agents)',
  'verbosity.invalid_mode': "⚠️ `{mode}` n'est pas valide. Niveaux de détail : {valid}. Vues : {views}.",
  'verbosity.custom': 'personnalisé (thinking : {thinking} · outils : {toolResults} · sous-agents : {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'court',
  'verbosity.mode.full': 'complet',
  'verbosity.view.stream': 'Flux complet',
  'verbosity.view.streamAnswers': 'Flux + réponses',
  'verbosity.view.answers': 'Réponses seules',
  'verbosity.view_set_success': '✅ Ce sujet affiche : {view} (dès le prochain message)',

  'model.set_success': '🧠 Modèle défini sur : {model}',
  'model.saved_for_next_start': 'Modèle enregistré : {model} — s\'appliquera au prochain démarrage d\'agent.',
  'model.start_agent_first': 'Aucune session active. Démarrez d\'abord un agent.',
  'model.current_default': 'par défaut',
  'model.none_available': '🧠 Actuel : {current}\n\nAucun modèle disponible. Définis-en un manuellement avec /model <provider/model>.',
  'model.invalid_number': '❌ Numéro invalide. Lance /model pour voir la liste.',
  'model.pick_provider': '🧠 Actuel : {current}\n\nChoisis un fournisseur :',
  'model.all_hidden': '🧠 Actuel : {current}\n\nTous les fournisseurs sont masqués. Touche 👁 pour en rétablir un.',
  'model.hidden_header': '🙈 Masqué de ce sélecteur — touche 👁 pour rétablir.',
  'model.provider_button': '📦 {provider} ({count})',
  'model.hidden_provider_button': '🙈 {provider} ({count})',
  'model.hide_button': '🙈',
  'model.show_button': '👁',
  'model.back_button': '⬅️ fournisseurs',
  'model.prev_button': '⬅️ Préc.',
  'model.next_button': 'Suiv. ➡️',
  'model.page_button': '{page}/{totalPages}',
  'model.page_header': '🧠 {provider} — {count} modèles · page {page}/{totalPages}\nActuel : {current}',
  'model.page_hint': 'Réponds avec un numéro pour choisir, ou /model <nom> pour rechercher.',
  'model.page_hint_buttons_only': 'Touche un modèle pour changer, ou /model <nom> pour rechercher.',

  'disconnect.unsupported_backend': 'La déconnexion de providers OpenCode n\'est pas disponible dans cette build.',
  'disconnect.invalid_provider': '❌ Identifiant de fournisseur invalide {provider}. Exemple : /disconnect openrouter',
  'disconnect.no_providers': 'Aucun fournisseur à déconnecter.',
  'disconnect.pick_provider': 'Choisis un fournisseur à déconnecter — ses identifiants enregistrés seront supprimés :',
  'disconnect.provider_button': '🔌 {provider}',
  'disconnect.success': '✅ Fournisseur {provider} déconnecté — identifiants enregistrés supprimés.',
  'disconnect.still_active_env': '⚠️ Les identifiants enregistrés pour {provider} ont été supprimés, mais le fournisseur reste actif : OpenCode l\'active via une variable d\'environnement. Supprime cette variable et redémarre OpenCode, ou masque le fournisseur via /model.',
  'disconnect.failed': '⚠️ Échec de la déconnexion de {provider} : {reason}',

  'rename_session.usage': 'Utilisation : /rename_session <nouveau titre>',
  'rename_session.start_agent_first': 'Aucune session active. Démarrez d\'abord un agent (/claude ou /opencode).',
  'rename_session.unsupported_backend': 'Le renommage de session n\'est pas pris en charge pour {label}.',
  'rename_session.success': '✅ Session renommée : {title}',
  'rename_session.failed': '⚠️ Échec du renommage de la session : {reason}',

  'compact.started': '🧹 Compactage du contexte de la session — l\'agent continue à partir du résumé.',
  'compact.done': '✅ Contexte compacté.',
  'compact.done_tokens': '✅ Contexte compacté : {pre} → {post} tokens.',
  'compact.summaryHeader': '📄 Résumé du compactage :',
  'compact.start_agent_first': 'Aucune session active. Démarrez d\'abord un agent (/claude ou /opencode).',
  'compact.unsupported_backend': 'Le compactage du contexte n\'est pas pris en charge pour {label}.',
  'compact.model_unresolved': '⚠️ Compactage impossible : aucun modèle n\'est résolu pour cette session. Choisissez-en un avec /model puis réessayez.',
  'compact.failed': '⚠️ Échec du compactage du contexte de la session : {reason}',
  'compact.busy': '⚠️ L\'agent est occupé pour le moment — relance /compact une fois le tour en cours terminé.',
  'compact.closingSectionInstruction': 'After the summary, append a final section wrapped EXACTLY between a line containing only {startMarker} and a line containing only {endMarker}. Inside that section, write IN FRENCH: (1) one or two terse sentences on what we were doing and the immediate next step; (2) if you asked the user a question that is still unanswered, restate that question and list its answer options. Write nothing after {endMarker}.',
  'compactOnIdle.notice': '🧹 Compacté automatiquement en cas d’inactivité pour économiser des tokens via le cache.\nLance /compact_on_idle pour le désactiver.',
  'compactOnIdle.on': 'ACTIVÉ',
  'compactOnIdle.off': 'DÉSACTIVÉ',
  'compactOnIdle.title': '🧹 Compactage auto en cas d’inactivité pour ce sujet : {state}\n\nQuand la session reste inactive ~55 min, son contexte est compacté automatiquement pour économiser des tokens (le cache de prompt est encore chaud).\n\nPour le changer pour TOUS les sujets d’un coup, lance ceci dans le sujet General.',
  'compactOnIdle.titleGeneral': '🧹 Compactage auto en cas d’inactivité — défaut pour TOUS les sujets : {state}\n\nQuand une session reste inactive ~55 min, son contexte est compacté automatiquement pour économiser des tokens.\n\nChaque sujet peut le remplacer avec son propre /compact_on_idle.',
  'compactOnIdle.enableButton': 'Activer',
  'compactOnIdle.disableButton': 'Désactiver',
  'compactOnIdle.setThisTopic': '✅ Compactage auto en cas d’inactivité : {state} pour ce sujet.',
  'compactOnIdle.setGlobal': '✅ Compactage auto en cas d’inactivité : {state} pour TOUS les sujets (les remplacements par sujet s’appliquent toujours).',
  'compactOnIdle.unsupported': 'Le compactage auto en cas d’inactivité s’applique à une session d’agent active. Lance d’abord /claude ou /opencode dans un sujet lié.',
  'compactOnIdle.pendingQuestionReask': '❓ Tu as encore une question en attente. Touche une option pour y répondre et continuer :',
  'compactSummary.on': 'ACTIVÉ',
  'compactSummary.off': 'DÉSACTIVÉ',
  'compactSummary.title':
    '📄 Publier le résumé du compactage dans ce sujet : {state}\n\nAprès un compactage, le résumé complet de l\'agent est écrit dans le sujet, pour que vous voyiez ce qui a été conservé.\n\nPour changer cela pour TOUS les sujets, lancez cette commande dans le sujet General.',
  'compactSummary.titleGeneral':
    '📄 Publier le résumé du compactage — défaut pour TOUS les sujets : {state}\n\nAprès un compactage, le résumé complet de l\'agent est écrit dans le sujet, pour que vous voyiez ce qui a été conservé.\n\nChaque sujet peut toujours le remplacer avec son propre /compact_summary.',
  'compactSummary.enableButton': 'Activer',
  'compactSummary.disableButton': 'Désactiver',
  'compactSummary.setThisTopic': '✅ Résumé du compactage : {state} pour ce sujet.',
  'compactSummary.setGlobal': '✅ Résumé du compactage : {state} pour TOUS les sujets (les remplacements par sujet s\'appliquent toujours).',
  'compactSummary.unsupported': 'Un shell n\'a pas de contexte à compacter, donc il n\'y a aucun résumé à publier.',

  'autoContinueLimits.on': 'ACTIVÉ',
  'autoContinueLimits.off': 'DÉSACTIVÉ',
  'autoContinueLimits.title': '🚧 Reprise automatique après une limite d’usage pour ce sujet : {state}\n\nQuand l’agent atteint une limite d’usage ou de session, le bot attend la réinitialisation de la fenêtre puis demande lui-même à l’agent de continuer (le message de reprise est épinglé, ainsi un sujet en sourdine te notifie quand même).\n\nPour le changer pour TOUS les sujets d’un coup, lance ceci dans le sujet General.',
  'autoContinueLimits.titleGeneral': '🚧 Reprise automatique après une limite d’usage — défaut pour TOUS les sujets : {state}\n\nQuand un agent atteint une limite d’usage ou de session, le bot attend la réinitialisation de la fenêtre puis demande lui-même à l’agent de continuer.\n\nChaque sujet peut le remplacer avec son propre /auto_continue_limits.',
  'autoContinueLimits.enableButton': 'Activer',
  'autoContinueLimits.disableButton': 'Désactiver',
  'autoContinueLimits.skipButton': '⏭ Passer une fois',
  'autoContinueLimits.skipDone': 'Cette reprise a été passée.',
  'autoContinueLimits.skipExpired': 'Rien à passer — cette attente est déjà terminée.',
  'autoContinueLimits.skippedNotice': '⏭ Passé : je ne reprendrai pas celle-ci tout seul. Écris-moi quand continuer — la reprise automatique reste activée pour ce sujet.',
  'autoContinueLimits.noticeHint': 'Lance /auto_continue_limits pour passer cette reprise ou désactiver la reprise automatique pour ce sujet.',
  'autoContinueLimits.setThisTopic': '✅ Reprise automatique après une limite d’usage : {state} pour ce sujet.',
  'autoContinueLimits.setGlobal': '✅ Reprise automatique après une limite d’usage : {state} pour TOUS les sujets (les remplacements par sujet s’appliquent toujours).',
  'autoContinueLimits.limitReachedDisabled': '🚧 Limite d’usage atteinte. La reprise automatique est désactivée pour ce sujet, j’attends donc — écris-moi quand continuer (/auto_continue_limits on pour reprendre automatiquement).',

  'connect.prompt_key': '🔑 Envoyez la clé API pour `{provider}` comme prochain message. Je supprimerai le message contenant la clé de l\'historique.',
  'connect.empty_key': '❌ La clé API est vide. Envoyez la clé comme prochain message.',
  'connect.invalid_key': '❌ Cela ne ressemble pas à une API key (elle contient des espaces ou des caractères non latins). Envoyez uniquement la key comme prochain message, ou relancez /connect.',
  'connect.invalid_provider': '❌ ID de provider invalide `{provider}`. Exemple : /connect openai',
  'connect.unsupported_provider': '⚠️ Le provider `{provider}` ne prend pas en charge la connexion par clé API simple via ce flux. Utilisez l\'UI/CLI OpenCode pour ce provider.',
  'connect.unsupported_backend': 'L\'auth de provider OpenCode n\'est pas disponible dans ce build.',
  'connect.failed': '⚠️ Échec de la connexion à `{provider}` : {reason}',
  'connect.success': '✅ Provider `{provider}` connecté. Le serveur OpenCode n\'a pas été redémarré.',
  'connect.cancelled': 'Saisie de clé API annulée.',
  'connect.pick_method': 'Comment connecter `{provider}` ? Choisis une méthode :',
  'connect.no_methods': '⚠️ Aucune méthode d\'authentification trouvée pour `{provider}`.',
  'connect.oauth_device': '🔓 Pour connecter `{provider}` : ouvre {url} et saisis le code `{code}`, puis autorise. Sur un serveur, utilise la méthode *headless*. Je confirmerai ici une fois terminé.',
  'connect.oauth_url_only': '🔓 Pour connecter `{provider}` : ouvre {url} et termine la connexion. Je confirmerai ici une fois terminé.',
  'connect.oauth_paste': '🔑 Après autorisation, colle le code ici comme prochain message — je le supprimerai de l\'historique.',
  'connect.oauth_waiting': '⏳ En attente d\'autorisation…',
  'connect.oauth_loopback': '🔑 Après autorisation, votre navigateur tentera d\'ouvrir une page `localhost` qui ne se chargera pas — c\'est normal ici. Copiez cette URL depuis la barre d\'adresse et collez-la comme prochain message (ou juste la valeur `code`). Je la supprimerai de l\'historique et terminerai la connexion.',
  'connect.oauth_invalid_reply': '❌ Cela ne ressemble ni à une URL de callback ni à un code d\'autorisation. Après autorisation, collez l\'URL de callback `localhost` depuis votre navigateur (ou la valeur `code`).',
  'connect.oauth_callback_no_flow': '⚠️ Cela ressemble à une URL de callback OAuth, mais aucune connexion n\'est en cours ici — je l\'ai supprimée. Lancez /connect pour recommencer.',
  'connect.oauth_success': '✅ `{provider}` connecté via OAuth. Les identifiants du serveur OpenCode ont été actualisés.',
  'connect.oauth_failed': '⚠️ La connexion OAuth pour `{provider}` ne s\'est pas terminée. Relance /connect.',
  'quit_all.none_active': 'Aucun agent en cours — rien à arrêter.',
  'quit_all.summary': '🚪 {stopped} sur {total} agents actifs arrêtés.',
  'quit_all.general_only': '`/quit-all` n\'est disponible que dans le topic General.',

  'clearMessages.summary':
    '🗑 {deleted} sur {total} messages supprimés. ' +
    'Telegram refuse de supprimer ce qui date de plus de 48 h — le reste reste dans l\'historique.',
  'clearMessages.no_messages': 'Aucun message à supprimer dans ce fil.',

  'edited.hint':
    "✏️ Je ne traite pas les messages modifiés comme une nouvelle entrée — envoyez la correction dans un message séparé.",

  'voice.no_api_key':
    'La voix nécessite `GROQ_API_KEY` (gratuit) ou `OPENAI_API_KEY`.',
  'voice.failed': 'Échec de la transcription du message vocal.',
  'voice.retrying': '⚠️ Échec de la transcription du message vocal ({error}). Nouvel essai dans {seconds} s…',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Le fichier dépasse la limite Bot API ({cap} Mo) — je ne peux pas le télécharger. Envoyez un fichier plus petit.',
  'file.download_failed': '📎 Échec du téléchargement du fichier. Veuillez réessayer.',

  'error.workdir.gone':
    '📁 Le dossier `{subdir}` a disparu du disque. Lancez /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ Le fil a été supprimé dans Telegram ; lien effacé.',
  'error.tg.thread.closed':
    '🔒 Le fil {key} est fermé — rouvrez-le dans votre client Telegram, ou supprimez-le entièrement.',
  'error.tg.perm.delete':
    '🔐 Impossible de supprimer les messages. Accordez au bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` manquant. Faites-moi admin du groupe.',
  'error.state.corrupted':
    '⚠️ state.json était corrompu ; liens réinitialisés. Relancez /bind si nécessaire.',
  'error.start_in_general':
    'Impossible de démarrer un agent dans General — c\'est un topic de service. Ouvrez un fil thématique.',

  'cb.access_denied': 'Accès refusé',
  'cb.bind_only_topical': '/bind ne fonctionne que dans les fils thématiques',
  'cb.binding_to': 'Liaison à {subdir}…',
  'cb.no_active_session': 'Aucune session active',
  'cb.model_error': 'Erreur : {error}',
  'cb.model_set': 'Modèle : {model}',
  'cb.model_provider_gone': 'Ce fournisseur n\'existe plus — relance /model',
  'cb.model_hidden': 'Masqué : {provider}',
  'cb.model_shown': 'Affiché : {provider}',
  'cb.disconnect_expired': 'Ce menu de déconnexion a expiré — relance /disconnect',
  'cb.not_supported': 'Non pris en charge pour {label}',
  'cb.unknown_agent': 'Agent inconnu',
  'cb.agent_switched': 'Basculé vers {label}',
  'cb.resume_only_topical': 'Resume ne fonctionne que dans les fils thématiques',
  'cb.bind_folder_first': 'Liezez d\'abord un dossier via /bind',
  'cb.agent_not_running': 'Agent non en cours',
  'cb.no_pending_question': 'Aucune question en attente',
  'cb.connect_method_expired': 'Ce menu de connexion a expiré — relance /connect',
  'cb.invalid_option': 'Option invalide',
  'cb.sent_option': 'Envoyé : {option}',
  'cb.effort_set': 'Effort : {level}',
  'cb.effort_error': 'Erreur : {error}',
  'cb.claudeMode_already': 'Déjà actif',
  'cb.claudeMode_switching': 'Basculement…',
  'claudeMode.pick': '⚙️ Backend Claude Code — actuel : {label}\nChoisissez un backend (le basculement garde la même conversation) :',
  'claudeMode.not_claude': "Ce topic n'est pas sur Claude Code — /claude_mode ne bascule que le backend de Claude.",
  'claudeMode.already': 'Déjà {label}.',
  'claudeMode.set_idle': '⚙️ Backend Claude : {label} — s\'appliquera au prochain démarrage.',
  'claudeMode.switched_resumed': '⚙️ Basculé vers {label} — même conversation reprise.',
  'claudeMode.switched_fresh': '⚙️ Basculé vers {label} — nouvelle session démarrée.',
  'cb.thinking_set': 'Thinking : {mode}',
  'cb.thinking_error': 'Erreur : {error}',
  'cb.toolresults_set': 'Résultats d\'outils : {mode}',
  'cb.toolresults_error': 'Erreur : {error}',
  'cb.subagent_set': 'Sous-agents : {mode}',
  'cb.subagent_error': 'Erreur : {error}',
  'cb.verbosity_set': 'Verbosité de sortie : {mode}',
  'cb.verbosity_error': 'Erreur : {error}',
  'cb.view_set': 'Ce sujet affiche : {view}',

  'session.list_header': 'Sessions à reprendre ({label}) :',
  'session.list_footer': 'Envoyez 1–{max} pour reprendre · 0 pour quitter',
  'session.none': 'Aucune session à reprendre dans ce dossier.',
  'session.cancelled': 'Annulé. Sélecteur de session fermé.',
  'session.invalid': 'Numéro invalide. Entrez une valeur de 1 à {max}.',
  'session.resumed': 'Session reprise. Envoyez votre message :',
  'session.resume_failed': 'Échec de la reprise de session : {error}',
  'session.expired': 'La liste des sessions est périmée. Relancez /sessions.',
  'session.load_failed': 'Échec du chargement des sessions.',

  'resume.context_header': '↩️ Repris — {count} derniers messages :',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ {count} message(s) manqué(s) pendant que le bot était hors ligne. Dernier de la session :',
  'recap.restartedFallbackHeader': '🔄 Bot redémarré. Dernier de la session :',
  'recap.stillWorkingLine': '⏳ L\'agent travaille encore…',

  'trace.onThisThreadReply': '🔎 Traçage activé pour ce fil.',
  'trace.offThisThreadReply': '🔎 Traçage désactivé pour ce fil.',
  'trace.onAllThreadsReply': '🔎 Traçage activé pour TOUS les fils.',
  'trace.offAllThreadsReply': '🔎 Traçage désactivé partout (le flag « all » et la liste des fils sont effacés).',
  'trace.statusReply':
    '🔎 Trace — ce fil : {thisThread}\nTous les fils : {allThreads}\nFils tracés : {count}',
  'trace.statusOnLabel': 'activé',
  'trace.statusOffLabel': 'désactivé',
  'trace.usageHint': 'Utilisation : /trace on | off | on all | off all | (sans argument — statut)',

  'timestamps.onReply':
    '🕐 Horodatage activé : chaque prompt transmis à l\'agent reçoit l\'heure d\'envoi comme première ligne (jamais posté dans le topic).',
  'timestamps.offReply': '🕐 Horodatage désactivé pour ce fil.',
  'timestamps.statusOnReply': '🕐 Horodatage : activé pour ce fil.',
  'timestamps.statusOffReply': '🕐 Horodatage : désactivé pour ce fil.',
  'timestamps.usageHint': 'Utilisation : /timestamps on | off | (sans argument — statut)',

  'schedule.fired':
    '⏰ Planification « {name} » ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — manqué à {time}, rattrapage',
  'schedule.checkFailed':
    '🚨 Vérification « {name} » en échec : {failure} ({schedule}){missedNote}\n$ {command}\n\n{output}\n\nJe réveille l’agent. Plus d’alerte tant que la vérification n’est pas de nouveau réussie.',
  'schedule.checkRecovered': '✅ La vérification « {name} » réussit de nouveau.',
  'schedule.pausedUnbound':
    '⏸ Planifications en pause : {count} — le topic a été détaché de son dossier. /bind les restaurera.',
  'schedule.resumedRebind': '▶️ Planifications reprises : {count} (prochain recalculé à partir de maintenant).',
  'schedule.noAgent':
    "⚠️ Rien de planifié — aucun agent n'est actif dans ce sujet, une exécution planifiée n'aurait donc rien à lancer. Démarre d'abord /claude ou /opencode.",
  'schedule.currentTimeNote':
    'Current time is {now} in timezone {zone}. Resolve every relative time phrasing ("tomorrow", "in 2 hours", "9am") against THAT clock — the schedule fires in the same timezone.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN FRENCH what you scheduled.\n\n{timeNote}\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN FRENCH what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN FRENCH what you scheduled.\n\n{timeNote}',

  // ── /reminders (bot-local reminders: buttons only, no agent involved) ──
  'reminders.fired': '🔔 {text}\n\n📅 {schedule}{missedNote}',
  'reminders.scheduleDaily': 'chaque jour à {time}',
  'reminders.scheduleWeekdays': 'en semaine à {time}',
  'reminders.scheduleWeekly': '{weekday} à {time}',
  'reminders.scheduleMonthly': 'le {dayOfMonth} à {time}',
  'reminders.scheduleOnce': '{date} à {time}',
  'reminders.scheduleRaw': 'cron {text}',
  'reminders.nextRunToday': 'aujourd’hui à {time}',
  'reminders.nextRunTomorrow': 'demain à {time}',
  'reminders.nextRunOnDate': '{date} à {time}',
  'reminders.nextRunNone': '—',
  'reminders.hubTitle': '🔔 Rappels',
  'reminders.hubEmptyLine': 'Aucun rappel pour l’instant.',
  'reminders.hubActiveLine': 'Actifs : {count}',
  'reminders.hubLimitLine':
    'Actifs : {count} — la limite de {limit} est atteinte. Supprime-en un pour en ajouter un autre.',
  'reminders.addButton': '➕ Ajouter',
  'reminders.listButton': '📋 Liste ({count})',
  'reminders.closeButton': '✕ Fermer',
  'reminders.closedNotice': '🔔 Rappels fermés.',
  'reminders.listTitle': '📋 Rappels ({count})',
  'reminders.listPageLine': 'Page {page} sur {total}',
  'reminders.listRow': '🔔 {name} · {schedule}',
  'reminders.listPrevButton': '‹ Précédent',
  'reminders.listNextButton': 'Suivant ›',
  'reminders.listBackToHubButton': '‹ Retour',
  'reminders.cardTitle': '🔔 {name}',
  'reminders.cardWhen': 'Quand : {schedule}',
  'reminders.cardText': 'Texte : « {text} »',
  'reminders.cardNext': 'Prochain : {next}',
  'reminders.cardDeleteButton': '🗑 Supprimer',
  'reminders.cardBackToListButton': '‹ À la liste',
  'reminders.createdTitle': '✅ Rappel créé',
  'reminders.doneListButton': '📋 Liste',
  'reminders.wizardTitle': '🔔 Nouveau rappel',
  'reminders.pickRepeat': 'Répétition : {value}',
  'reminders.pickDate': 'Date : {value}',
  'reminders.pickWeekday': 'Jour de la semaine : {value}',
  'reminders.pickDayOfMonth': 'Jour du mois : {value}',
  'reminders.pickTime': 'Heure : {value}',
  'reminders.pickText': 'Texte : « {value} »',
  'reminders.stepRepeatQuestion': 'ÉTAPE 1/4 · À quelle fréquence ?',
  'reminders.stepDateQuestion': 'ÉTAPE 2/4 · Quel jour ?',
  'reminders.stepDateGridQuestion': 'ÉTAPE 2/4 · Choisis une date :',
  'reminders.stepWeekdayQuestion': 'ÉTAPE 2/4 · Quel jour de la semaine ?',
  'reminders.stepDayOfMonthQuestion': 'ÉTAPE 2/4 · Quel jour du mois ?',
  'reminders.stepDayOfMonthGridQuestion': 'ÉTAPE 2/4 · Choisis un jour du mois :',
  'reminders.stepTimeQuestion': 'ÉTAPE 3/4 · À quelle heure ?',
  'reminders.stepHourQuestion': 'ÉTAPE 3/4 · Choisis l’heure :',
  'reminders.stepMinuteQuestion': 'ÉTAPE 3/4 · {hour}:__ — choisis les minutes :',
  'reminders.stepTextQuestion':
    'ÉTAPE 4/4 · Envoie le texte du rappel — écris-le ou enregistre un message vocal.',
  'reminders.repeatOnceButton': 'Une fois',
  'reminders.repeatDailyButton': 'Quotidien',
  'reminders.repeatWeekdaysButton': 'En semaine',
  'reminders.repeatWeeklyButton': 'Hebdomadaire',
  'reminders.repeatMonthlyButton': 'Mensuel',
  'reminders.dateTodayButton': 'Aujourd’hui',
  'reminders.dateTomorrowButton': 'Demain',
  'reminders.dateOtherButton': '✏️ Autre date…',
  'reminders.dayOfMonthOtherButton': '✏️ Autre jour…',
  'reminders.timeOtherButton': '🕐 Autre heure',
  'reminders.backButton': '‹ Retour',
  'reminders.cancelButton': '✕ Annuler',
  'reminders.weekdayMondayButton': 'lun',
  'reminders.weekdayTuesdayButton': 'mar',
  'reminders.weekdayWednesdayButton': 'mer',
  'reminders.weekdayThursdayButton': 'jeu',
  'reminders.weekdayFridayButton': 'ven',
  'reminders.weekdaySaturdayButton': 'sam',
  'reminders.weekdaySundayButton': 'dim',
  'reminders.errorPastTime':
    '⚠️ Cette heure est déjà passée. Choisis une heure plus tardive, ou reviens en arrière et change le jour.',
  'reminders.errorInvalidDate': '⚠️ Cette date n’existe pas. Choisis-en une autre.',
  'reminders.errorInvalidTime':
    '⚠️ Cette heure n’existe pas ce jour-là — changement d’heure. Choisis une autre heure.',
  'reminders.errorTextTooLong':
    '⚠️ Ce texte est trop long ({limit} caractères maximum) et n’a PAS été enregistré. Envoies-en un plus court.',
  'reminders.cancelledNotice': '✕ Annulé',
  'reminders.expiredNotice': '✕ Expiré — le texte du rappel n’est jamais arrivé.',
  'reminders.capReachedNotice':
    '⚠️ Ce sujet a déjà {limit} rappels — supprime-en un avant d’en ajouter un autre.',
  'reminders.wizardExpiredCbAnswer': 'Cet assistant est obsolète — relance /reminders.',
  'reminders.deletedCbAnswer': '🗑 Supprimé',
  'reminders.deleteGoneCbAnswer': 'Déjà supprimé.',
  'reminders.cardExpiredCbAnswer': 'Ce rappel n’existe plus.',

  'apiRetry.transientNotice':
    '⏳ API limité en débit — nouvelle tentative automatique dans {minutes} min (tentative {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Limite d\'utilisation atteinte — nouvelle tentative dans {minutes} min (tentative {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Limite d\'utilisation atteinte — reprise automatique après reset (~{time}).',
  'apiRetry.resuming': '↻ Reprise…',
  'apiRetry.limitResetResuming': '✅ La fenêtre de limite est réinitialisée — je reprends le travail dans ce sujet.',
  'apiRetry.giveUp':
    '⚠️ Impossible de reprendre après {attempts} tentatives. Écrivez-moi quand continuer.',
  'apiRetry.continueNudge': 'Continuez là où vous vous êtes arrêté.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude est déconnecté — lancez /login pour continuer.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode : identifiants invalides — redémarrez le serveur opencode.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Prêt — je peux traiter les messages dans les fils du bot et les sujets de groupe.',
  'startup.header_not_ready':
    '⚠️ Configuration incomplète. Pour commencer à travailler avec moi, veuillez terminer ces étapes :',
  'startup.item.create_group':
    'Créez un supergroupe de forum avec les Sujets activés, puis envoyez-moi un message là-bas pour l’associer.',
  'startup.item.grant_admin':
    'Faites de moi un administrateur avec ces droits : {missing}.',
  'startup.item.bind_topic':
    'Créez un sujet et liez-le à un dossier avec /bind.',
  'startup.item.install_agent':
    'Installez un CLI d’agent — claude ou opencode.',
  'startup.item.optional_groq':
    '(optionnel) Ajoutez GROQ_API_KEY à votre .env et redémarrez pour activer la saisie vocale.',
  'startup.item.optional_owner':
    '(optionnel) Définissez OWNER_USER_ID pour recevoir ce statut dans votre chat privé.',
  'requests.alert.notAnsweringNotice': "⚠️ La demande {requestId} est restée sans réponse : l'agent a terminé ses tours sans répondre et les rappels ont abandonné. Vérifiez la session dans ce sujet.",
  'requests.alert.unreachableNotice': "⚠️ La demande {requestId} est restée sans réponse : la session de l'agent était injoignable pour un rappel. Vérifiez la session dans ce sujet.",
  'requests.limit.answerAfterResetNotice': '🚧 Limite d’utilisation atteinte — la réponse arrivera après {time}.',
  'requests.limit.answerNextAttemptNotice': '🚧 Limite d’utilisation atteinte — prochaine tentative à {time}.',
};
