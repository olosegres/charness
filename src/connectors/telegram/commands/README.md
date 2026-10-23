# `src/connectors/telegram/commands/` — Telegram command modules

Slash commands and their buttons that were decomposed out of `bot.ts`, one file per feature. A file exports
`create<Feature>(ports)`; `bot.ts` builds ONE ports bag (`BotCore` in `botCore.ts`: the telegraf instance, the
neutral `command` registrar, the topic send helpers, a state getter) and calls the factory and its `register…()`
functions where the handlers used to be registered. A module never imports `bot.ts` (guarded by
`__tests__/compositionRootImports.test.ts`).

- **Registration order is part of the contract.** Commands go through the neutral router, so only their names
  matter; telegraf runs the FIRST matching `action` / `on`, so a `register…Callbacks()` call keeps the position
  of its old registrations, and a module's patterns must stay disjoint from the ones registered after it.
- **`state` is assigned at boot, after registration:** read it through `getState()` when a handler RUNS, never
  copy it out of the ports.
- **State `bot.ts` also touches is passed in** (a map or set it owns); state private to a feature lives in its
  factory.
- A port-free helper is a plain export of its file (its test imports it without booting `bot.ts`).
- **A button's error or notice reaches the user whole.** A toast holds 200 characters, so an error/notice text goes through
  `callbackToast.ts`: `answerCallbackWithWholeText(ctx, text, postWhole)` (a text that fits IS the toast, a longer one is cut
  for the toast — ellipsis, on a grapheme boundary, so a family or flag emoji is never split — and posted in full as a message)
  or, built once per module from its `replyToThread` port, `createWholeTextAnswerer(replyToThread)` → `(ctx, key, text)`.
  Never `.slice(0, n)` a text into `answerCbQuery`, and no module keeps its own copy of the cut (`cb.model_error`,
  `cb.effort_error`, the display-mode errors, `/limits`, `/accounts`, `/stt` all use the helper). A text the thread already
  carries in full (a pending question's answer: the question message is edited to "✅ …: <answer>") uses
  `answerCallbackWithFittedText` — the toast only, cut when long, no second copy — but only while that edit succeeded
  (`applyQuestionAnswer` says so); a message that could not be edited, and a re-asked question's label (`reask_<i>`, nothing
  else shows it whole), use the whole-text variant. Telegram refuses a toast over 200 characters, so a bare
  `answerCbQuery(text)` of a user-visible label is a bug.
- **A late toast never changes what a handler does.** A handler that works first (a default-account change re-spawns every
  live topic, ~30 s; a model or effort pick re-spawns the session, and a re-spawn waits up to 5 s for the old process) answers
  after Telegram stopped waiting for the query, and the Bot API refuses it as «query is too old». RULE, for every tap handler
  that answers AFTER awaited work (a switch, a re-spawn, a write) and still has something to do after the answer (a re-render,
  an edit, a message): answer through `answerCallbackQuerySafely` (a refused late toast is only logged) — or
  `answerCallbackWithWholeText` / `createWholeTextAnswerer`, which post the text as a message when its toast was lost — never a
  bare `ctx.answerCbQuery`. So the re-render that follows always runs and the confirmation is never dropped. `/limits`,
  `/accounts`, the model pages and `/limits_autoswitch` (the limit notice's «🔁 Switch to …» included) use it for every toast
  (the access-denied answer, which nothing follows, is the one exception); `/model` and `/effort` use it for the answer after
  the pick. A handler that answers FIRST (compaction, the backend-switch question) needs nothing; so does a fast state write
  with nothing after it. The outcome text rides the toast on purpose: a query takes ONE answer, so answering early (before the
  work) would drop the outcome for every pick to spare the rare slow one.
- **A per-MESSAGE snapshot is keyed by chat + message id** (`buildMessageSnapshotKey` in `callbackMessage.ts`): a Telegram message id is unique only within one chat, so a map keyed by the bare id could answer a tap from another chat.

## `displayModes.ts`

`/thinking`, `/tool_results`, `/subagent`, `/verbosity` and the buttons `think_` `toolres_` `subag_` `verb_`
`view_`. Preferences are per topic (`setDisplayPref`) and never reach the agent. A button tap persists the mode,
answers the callback and re-renders the picker's keyboard so the ✓ follows; a view with requests off (`stream`)
closes the topic's open request. `/status` renders the view through `formatTopicView`.

## `reminders.ts`

`/reminders` and its seven buttons (add, hub, close, list page, card, delete, the wizard's own). A reminder is
bot-LOCAL: nothing reaches an agent, so it works in any topic, General and unbound ones included. The in-flight
wizards are memory and live in `bot.ts` (`reminderWizards`, passed in) because dropping a topic's wizard is also
the send-error path's job once the topic is gone. `bot.ts` reaches into the flow from the text and voice
handlers through `claimReminderTextCapture` (the single-use claim of step 4's wait — two concurrent messages
must make ONE reminder) and `finishReminderWizard` / `expireReminderWizard`, and from any command through
`cancelReminderWizard`. The scheduler engine arrives through a getter: it is built after the handlers register.

## `modelProviders.ts`

`/model` (the provider → models picker), `/effort`, `/connect`, `/disconnect` and the thirteen buttons behind them. The
module registers in THREE places: `registerProviderCommands` (where `/connect` and `/disconnect` sat),
`registerModelCommands` (`/model`, `/effort`) and `registerModelCallbacks`; the neighbouring `/claude_mode`
stays in `bot.ts` between the first two. On an OpenCode topic the provider level opens with a "Recently used"
row (`mdlrecent`) — a flat list of the `provider/model` ids picked before, instance-wide, most recent first,
persisted in `state.json` (`recentModels`, written by the single `applyModelSelection` choke point) and filtered
against the live catalog at render time (`utils/modelRecentPlan.ts`); the row is absent when nothing is left.
Its buttons carry the position AND an identity hash of the entry (`mdlr_<i>_<hash>`), so a keyboard left in the
history applies the model printed on it or is refused, never a reordered neighbour. The per-thread picker state (`awaitingModelSelection`,
`threadModelLists`, the pending-connect and snapshot maps, the other input-mode sets) is owned by `bot.ts`,
which clears it on teardown and reads it in the text handler, and is passed in. A bare digit is read as a model
pick only while `awaitingModelSelection` holds the thread, and every numbered pick — typed or tapped — disarms
it. A pasted provider key is deleted from the topic as a secret only when it can be a real key; an implausible
one stays visible and the connect stays armed. The OAuth buttons reach the sign-in driver
(`../../../agentLogin/`) through the `startOpenCodeOAuthLogin` port.

The model level of the picker is drawn by the SHARED model page (`modelPage.ts`, below): `buildModelPageRender` hands it the
`/model` callbacks (`mdlp_` arrows, `mdl_` picks, `mdlback`) and keeps the numbered list and the header for itself.

`/effort` has two faces (`utils/effortPickerPlan.ts` builds the text and rows, the module renders them). **In General** it
is the INSTANCE default effort: the picker says it is the default of every topic without an effort of its own, offers the
Claude levels with ✓ on the current one, and a tap (or `/effort <level>`) writes `defaultEffort` into `settings.json`
(`instanceSettings.ts`, path from the `getInstanceSettingsPath` port) — no adapter involved — then confirms that it applies
from each topic's next session start or wake-up (running sessions are not restarted); a write that fails is said
with the file's path and the errno code, on the button and in the topic, with no confirmation. **In a topic** it shows the
level its RUNNING session uses (`getEffortState().running`; with no live session, the level the next start takes), the next
start's level beside it when that differs («xhigh (medium from the next start)» — a General change never reaches a running
session) and the source of the next start's level (`getOwnEffort` ≠ null → «set for this topic», else «as in General»), a
button per level the backend offers (OpenCode: the model's variants; every level shown, the ✓ and the button's value
included, is the nearest variant when the model lacks it — `getEffortAmongLevels`) and, when the
adapter has `clearEffort`, «As in General (<value>)» (`effortsame`, disjoint from the `effort_<level>` pattern). A pick the
adapter stored but could not apply yet (no agent running → a notice) is a pick all the same: the tap or the typed `/effort <level>`
refreshes the banner and re-renders the picker, and the notice reaches the user whole — as the toast when it fits
(200 characters), else cut for the toast and posted in full as a message (`answerCallbackWithWholeText` in `callbackToast.ts`). A refusal changes nothing
and touches neither. Both screens re-render in
place, text and keyboard, after a tap. `/status`, the ready notice and the pinned banner show `getThreadEffortView`
(the running session's level, else the next start's; the banner and `/status` add the next start's level when it differs); other topics' banners are refreshed by their own lifecycle events, not by a
General change (a burst of edits would queue ahead of agent output).

## `compaction.ts`

`/compact`, `/compact_on_idle` (its buttons `coi_on` / `coi_off`, plus `coi_sum_on` / `coi_sum_off` for the
`/compact_summary` switch on the same picker), `/compact_summary` (`csum_on` / `csum_off`; OFF by default; read
when a compaction finishes, so unlike `/compact_on_idle` it needs no live session), the compact-on-idle
watchdog with its re-ask, the full-summary post (`postCompactionSummary`) and the deferred compaction the
`compact_conversation` MCP tool arms. In General a switch is the instance-wide default, in a regular topic that
topic's override. Execution always goes through
`runThreadCompaction`: only it marks the topic as compacting, so the summary a compaction produces is never
counted as a turn (a manual compaction used to push the idle stamp back and be compacted again one window
later). `bot.ts` calls the returned hooks from the prompt path (`noteThreadActivity`, `noteThreadUserActivity`),
the output path (`markThreadTurnProducedOutput`) and the session lifecycle (`rearmThreadIdleTimer`,
`clearThreadCompaction`), and reads `threadsCompacting` (the typing loop, the request probe) and
`reAskedQuestionOptions` (the re-ask button). The factory must be built BEFORE the module-scope objects that name
its hooks (`routedCommandTriggerDeps`): a destructured `const` is not hoisted like the function it replaced.

## `autoContinueLimits.ts`

The «wait for the reset and continue» setting (the `/auto_continue_limits` alias and the old buttons `acl_on` /
`acl_off`): whether the bot waits out a usage-limit window and resumes the agent by itself. Its screen is
`/limits_autoswitch` (`fallbackChain.ts`); here live the write path (`applyAutoContinueLimits`, exported to that module
through a port) and the alias: `on|off` apply, a bare `/auto_continue_limits` opens the `/limits_autoswitch` view
(`openAutoSwitchView` port). A regular topic sets its own override (`null` drops it, back to the instance
default), General the instance-wide default. Turning the EFFECTIVE value off drops the topic's armed resume and
stops waking its request, but only when a wait WAS armed. A tap on an old `acl_*` button consumes its picker into
a keyboard-less confirmation. The usage-limit notice appends the shared pointer through
`appendAutoContinueLimitsHint` and its own «skip once» button consumes the picker through the returned
`consumeAutoContinueLimitsPicker`.

## `backendSwitch.ts`

The question before a MANUAL switch of a topic between the two agent backends (`bsw_ok` / `bsw_no`): «🔁 Switch this
topic from OpenCode to Claude «work»?» + the shared line `handover.note` («The conversation context will be handed
over in compacted form.»), buttons `handover.continueButton` / `handover.cancelButton` (the same two for the `/limits`
questions). `utils/backendSwitchPlan.ts` decides WHEN it is asked (`checkNeedsBackendSwitchConfirmation`: the topic runs
the other backend AND holds a conversation) and words it; `bot.ts` is the single gate (`askBeforeCrossBackendSwitch`
for `/claude`, `/opencode`, the agent buttons and the natural-language «start …» phrases, `switchTopicByOperator`
for every operator PICK of an account or model — the `/limits` and `/accounts` rows, the model pages, `/accounts use`) and owns the switch itself
(`executeBackendSwitch`: the usage-limit switch's cross-backend move — the bridge is built from the conversation being left, then the two
helpers the limit switch uses too: `moveTopicToOtherBackend` (account pick + `switchThreadAdapter`) and `resumeTopicOnNewSession` (ensure, model pin,
first prompt)). A Claude target carries `isProfilePicked`: an account tap / `/accounts use` records the account as the topic's own pick,
`/claude` only names the account the topic follows and leaves it following General. Both targets carry the `model` a pick names (a Claude alias, an
OpenCode `provider/model`): the question names it and `executeBackendSwitch` pins it after the move (`getBackendSwitchModelToPin`). A conversation
to hand over means an agent with at least one readable turn (`readConversationTurns`; an unreadable transcript counts),
so a just-started agent switches at once. The module keeps one snapshot per question MESSAGE (newest 20, one open
question per topic): a tap with no snapshot, on another topic, or after the topic changed backend only answers «out of
date»; Continue edits the question into «Switching…» then the outcome (or the failure), Cancel into a line naming where
the topic stays; both drop the keyboard. Ports: `getCurrentFamily`, `performBackendSwitch`.

## `claudeAccounts.ts`

`/accounts` (hidden alias `/account`; `/connect` and `/disconnect` are hidden aliases of its OpenCode half, still
registered by `modelProviders.ts`) and the buttons `acct_use_<name>`, `acct_follow`, `acct_add`, `acct_ocadd`,
`acct_dc_<i>`, `acct_dcok_<i>`, `acct_dcre_<i>`, `acct_login_menu`, `acct_rm_menu`, `acct_back`, `acct_login_<name>`,
`acct_rm_<name>`, `acct_rmok_<name>`: which Claude account profile (`utils/claudeProfiles.ts`) a topic's Claude
sessions run on, and the OpenCode providers the server is authenticated for. One screen: a row per Claude account
(pick, 🔑 re-login, 🗑 remove — for `default` a sign-out), a 🔌 row per connected provider, «➕ Claude account» and
«➕ OpenCode provider». The provider rows carry an INDEX into the list snapshotted per screen MESSAGE
(`providerSnapshots`, the newest 50): a tap asks for confirmation, the confirmation disconnects through the
`disconnectOpenCodeProvider` port (`applyProviderDisconnect` of `modelProviders.ts`, flow unchanged), and an
older screen resolves to «out of date» and a re-render. The providers come from the `detectOpenCodeProviders`
port (the live OpenCode catalog; `[]` when unreadable). «➕ OpenCode provider» arms the same per-topic capture as
«➕ Claude account», with the provider kind: the next plain message is the provider id, validated and handed to
`startOpenCodeConnect` (`showConnectMethodPicker` — the `/connect <provider>` method picker, flow unchanged); a bad id
keeps the capture armed. The old login / remove sub-pickers and their buttons keep answering. A button BAKES the profile name into its
data (names are slugs of at most 32 characters, so the data stays under 64 bytes) — an old keyboard can never act
on another profile. A regular topic sets its own pick, General the instance default; the picker is meant for
repeated use and re-renders in place. The module owns no process: it asks the bot through ports to probe
`claude auth status --json` under a profile's directory (`readClaudeAuthStatus`, refreshed on every render so the
list shows the CLI's truth), to start the sign-in relay for a profile (`startClaudeProfileLogin` →
`agentLogin/`), and to move live sessions onto a changed pick (`applyClaudeProfile` for one topic,
`applyClaudeProfileEverywhere` after a General pick, a removal or a finished sign-in). «Add» without a name arms a
per-topic name capture the text handler consults (`checkIsAwaitingProfileName` / `submitProfileName`; a slash
command or `/esc` disarms it through `cancelProfileNameCapture`). A pick on a topic goes through the `switchTopicByOperator` port (`bot.ts`, `utils/operatorSwitchPlan.ts` decides the move): the account changes on a Claude topic, a topic that runs OpenCode switches to Claude — after a question (`backendSwitch.ts`) when a conversation is to be handed over, the pick being recorded only then — and while a usage-limit wait is armed it is the limit move; `asked` posts nothing more, `switched` carries the line to say, `refused` why nothing moved. A profile that is not signed in cannot be picked; the instance default is refused until General picks another; «remove» of `default` signs `~/.claude` out (`signOutDefaultClaudeLogin`: only the stored `claudeAiOauth` login, never `projects/` / settings / skills / memory) and marks its hidden record `isRemoved`, which hides it from the rows and from `buildClaudeProfileUsageViews` (so the rankings) until a probe finds it signed in again (the `getHomeClaudeDir` port lets a test sign out a decoy); removing a
profile drops the topic picks that named it (the state returns them, so their sessions are moved at once).
Under each row the picker prints the profile's usage windows (`utils/claudeProfileUsageLines.ts`, shared with the `/limits` board: session, weekly, Fable
weekly — percent USED, a space, a relative reset `5h 5% 🔄 in 4h` (`formatClaudeUsageBucket`; no arrow; an unknown 5h reset shows the weekly one, no
reset at all the bare percent; the Fable part is written only when the snapshot has that window — `account.row.usageFable`)). The usage hint
(`account.usageHint`, which says the percentages are used) is the paragraph right after the list; the `/limits` board carries the same figures on its buttons and says what they mean in its legend. The lines are read off the record's snapshot
after `refreshClaudeUsage({ maxAgeMs })` ran beside the status probes; the default profile's probe result
goes to its hidden record too, so the usage ranking and the CLI twin know whether it is signed in. The auto-switch-on-limit toggle left the picker for `/limits_autoswitch` (a pointer line stays); `/account autoswitch
on|off` and the old `acct_autosw_on` / `acct_autosw_off` buttons still work and write the same setting through the
`applyAutoSwitch` port (`fallbackChain.ts` owns the write and the confirmation). **Where the topic really runs.** The title (`account.title`: «This topic runs on: Claude «work»» / «OpenCode openai/gpt-5» / «OpenCode» while its
model is unknown) and the ✓ come from the `getTopicRun` port — the backend family of the topic's agent and its rung — not from the pick:
the ✓ sits on the account the Claude session RUNS on (which is not the pick while a switch is deferred), on no account while OpenCode runs, and with
no agent on the pick the next start takes. General keeps its own title and the ✓ on the instance default.

**A provider row** (the `detectOpenCodeProviders` port lists them, `listOpenCodeModels` is the catalog behind a provider's page). In a topic it is
`[provider or ✓ provider · model] [🔑] [🔌]`: the first button (`acct_ocuse_<i>`) switches the topic to the provider — it opens the shared model page (`modelPage.ts`;
`acct_ocpg_<p>` arrows, `acct_ocm_<i>` picks, ⬅️ Back is `acct_back`; a provider with ONE model is picked at once unless the topic runs on it), a pick
goes through `switchTopicByOperator` (`refused` keeps the page, `asked` has no toast, anything else re-renders the screen so the ✓ follows); 🔑 is
`acct_dcre_<i>` (the `/connect` method picker) and 🔌 `acct_dc_<i>` (asks first); all index the provider list snapshotted per screen message, the page's
models are a second per-message snapshot dropped when the screen re-renders. An unbound topic is told to bind a folder first. In General a provider row stays
«🔌 Disconnect <provider>» (`acct_dc_<i>`) and 🔑, and an `acct_ocuse_` tap from an old keyboard only says an OpenCode model is picked inside a topic. The list in
the text says how each provider is signed in (`accounts.providerSubscription` for the `openai` provider's ChatGPT subscription, `accounts.providerApiKey`) and hangs a
subscription's usage windows under it like an account's (`state.openCodeProviderUsage`, `utils/openCodeUsage.ts`). Typed form: `/accounts use <provider>/<model>`
(a value with a `/`; never in General). The factory returns `pickClaudeAccount` (the `/accounts` pick, login check included) for the `/limits` board.

## `fallbackChain.ts`

`/limits_autoswitch` (hidden alias `/fallback`; `/auto_continue_limits` opens the same screen; `/limits` hands it the old text verbs through `runAutoSwitchCommand`) and the buttons
`fbk_op_<i>_<rev>` (open a rung's detail view in the same message), and in that view `fbk_up_<i>_<rev>`, `fbk_dn_<i>_<rev>`, `fbk_tg_<i>_<rev>` (include / leave out of automatic switching), `fbk_rm_<i>_<rev>`,
`fbk_add`, `fbk_addc_<profile>`, `fbk_addcm_<profile>_<model|->`, `fbk_addp_<i>`, `fbk_addpg_<page>`, `fbk_addm_<i>`,
`fbk_prop`, `fbk_propok`, `fbk_clear`, `fbk_back`, the two settings `fbk_asw_on|off|same` (auto switch to a fallback
model) and `fbk_wait_on|off|same` (wait for the reset; written through the `applyAutoContinue` port) with `fbk_set_asw` /
`fbk_set_wait` (a topic's button that opens the setting's sub-menu; the two settings are read through `utils/limitSettings.ts`, which the board shares), plus `fbsw_<episode>_<i>` on a
usage-limit notice: the instance-wide priority chain of backend + account / provider + model a topic continues
on when its agent hits a usage limit (`utils/fallbackChain.ts`). The list is edited from EVERY topic (one instance-wide list; a topic also gets ✓ on its own position, a
sub-menu per setting — on / off / as General — for the two settings' overrides, and «skip once» while a limit wait is
armed). Each setting is ONE short full-width button on the main screen (`buildSettingRow`; the setting's name and its
effective value, `limits.switchButton` / `limits.waitButton` — the source, «as in General» / «set for this topic», is one
line of the message text (`limits.sourceLine`, emoji-keyed to the buttons) and the ✓ of the sub-menu, never on the button,
which a phone would cut again): in General a tap flips the value, in a topic it opens `renderSettingMenu` in the same
message — the setting's name (`limits.switchMenuTitle` / `limits.waitMenuTitle`), then ON / OFF / «As in General (<General value>)» as
full-width buttons (the topic's own choice marked ✓) and Back. The three options are the setting's own `fbk_asw_*` / `fbk_wait_*` callbacks, which
apply the choice and re-render the main screen; three buttons on one row would split the width evenly and cut every label.
The main screen is one full-width button per rung (`formatRowButtonLabel`, the one place the label is built: `[✓ ]<n>. <program> · <account or provider>[ · <model>]` + the state suffix, the ✓ at the start); its message
text is deliberately SHORT — a title (`limits.autoswitchTitle`), what the topic runs on + where its settings come from (General: a one-line
note that they are the defaults), and the list's heading — no usage block (the `/limits` board shows usage), no numbered list, no legend, no how-it-works prose (the rung view
and this README carry those). The usage snapshots are still refreshed through the `refreshClaudeUsage` port when the screen OPENS (`refreshUsageWithinBudget`: a minute's cache, waited
for at most `limitsUsageRefreshBudgetMs` — a slower poll lands at the next render) because a rung's availability reads the windows; a tap re-renders off the cache. A tap opens `renderRungDetail` in the same message (⬆️ hidden on
the first rung, ⬇️ on the last; up / down / toggle re-render the view at the rung's new place, remove returns to the list); a rung with `disabled: true` is skipped by
`pickFallbackCandidates` and kept disabled by a rebuild (`proposeFallbackChain(detection, previous)`); the screen is meant
for repeated use and re-renders in place. Every edit button BAKES the chain's content revision (8 hex digits of
an FNV-1a over the entries): a keyboard posted before a later edit is refused as stale and only re-rendered, so
an old index can never act on another rung. The two-step «add» keeps a snapshot per picker MESSAGE
(`addSnapshots`: the providers listed, then the chosen provider's models) that the index buttons resolve
against (the models are listed by the shared model page, `modelPage.ts`, with a ⛔ mark on a limited one); a Claude account bakes its name and model in the data. The module owns no detection or switch: it
asks the bot through ports for what is connected (`detectFallbackOptions` — the profile views, the OpenCode
catalog, the recent `/model` picks, the limit marks), the topic's current rung (`getTopicPosition`) and the
switch a notice button triggers (`takeSwitchOffer`: the bot checks the episode is still the topic's open one and
the index is inside that episode's remembered candidates, moves the topic and resumes the work; the notice is
edited into the confirmation, a stale tap only answers the callback).

**A rung of a new backend asks first.** Adding a rung whose backend the list does not use yet (rungs in automatic
switching; a non-empty list — `checkIsNewBackendForChain`), or including a 🚫 one that does that, replaces the picker /
detail view in the SAME message with `limits.addConfirm` / `limits.enableConfirm` + `handover.note` and ✅ Continue /
✖️ Cancel: `fbk_addok_<rev>` (the rung rides in the question message's snapshot `pendingAdds`; a tap whose revision no longer
matches, or on a message with no snapshot, re-renders and adds nothing) and `fbk_tgok_<i>_<rev>` (the toggle's own index +
revision), Cancel being `fbk_back` / `fbk_op_<i>_<rev>`. A rung of a backend already in the list is added / enabled at
once. «🔄 Fill from connected» keeps its own confirmation; when the draft holds both backends (`checkIsMixedFallbackChain`)
its text gains the same `handover.note` line.

## `limitsBoard.ts`

`/limits` — the SWITCH BOARD — and its five buttons `lim_c_<i>` (a Claude account row), `lim_o_<i>` (an OpenCode provider row), `lim_pg_<p>` /
`lim_m_<i>` (the open model page's arrow / model) and `lim_back`. The MESSAGE carries every figure; the BUTTONS carry none (they do not fit a phone's
button). Text, joined by blank lines: the usage block (`formatLimitsUsageBlock` in `utils/limitsBoardPlan.ts`: the heading `limits.usageHeading`, then
`<name> — <first usage line>` per signed-in Claude account that has a figure or a limit, then per connected OpenCode provider that reports usage
`openai (ChatGPT) — …`; the lines are `formatClaudeProfileUsageLines`, the ONE renderer `/accounts` uses, so the wording — `⏱ 5h … 🔄 in 3h · week …`,
`⛔ at its limit until …`, `(stale)` — is never a second copy; no line at all ⇒ no block and no heading), the two automatic-switching settings (read through
`utils/limitSettings.ts`, with a link to `/limits_autoswitch`; General prefixes «Defaults for all topics:») and the caption `limits.boardCaption`
(«Choose the active model:»; General `limits.boardCaptionGeneral`, «Choose the default Claude account:»). Every signed-in Claude account (in `/accounts` order)
and every connected OpenCode provider (catalog order) is one full-width button labelled by `buildLimitsBoardRows` as `[✓ ]<program> · <account or provider>` — the ✓ on
the active row only, no model, no usage, no ⛔; a signed-out account is not listed. «⏭ Skip once» (the shared `buildSkipArmedRetryCallbackData`) ends the board while a limit wait is armed.
The usage is refreshed through the `refreshUsage` port when the board OPENS (bounded, `refreshUsageWithinBudget`); a tap re-renders off the cache.

A tap in a topic: an unbound topic is told to bind a folder first; a Claude row goes through the `pickClaudeAccount` port (the `/accounts` pick: login check, then the
switch path), except the ✓ row, which opens the shared model page of the topic's account (the adapter's aliases, from `listClaudeModels`); an OpenCode row opens
its provider's page (`handleProviderTap`: a provider with one model is switched at once unless the topic runs on it); a page pick is `handleModelPick` (see `modelPage.ts`: the short toast, `refused` keeps the page, `asked` has no toast, anything else returns to the board with the ✓ moved). In General a Claude row sets the default account (the same pick
with `isGeneral`), an OpenCode row only toasts `limits.openCodeInTopicOnly`. Every button indexes a per-MESSAGE snapshot (`buildMessageSnapshotKey`, the newest 50): a tap on a message
the board knows nothing about — a restart, another chat — answers `accounts.stale`, re-renders and never acts, and a row button on a page (or a page button on the board) is stale too.
`/limits rebuild|clear|switch|wait …` (the old text forms) go to the `runAutoSwitchCommand` port with the board's own usage text.

## `modelPage.ts`

The model page — one provider's models as full-width buttons, `modelPageSize` (10) to a page — shared by `/model`, the «add a fallback model» step, and the provider pages
of `/limits` and `/accounts`. `buildModelPageButtons` draws only buttons: the screen hands in the `callback_data` of its own pick (an absolute index into the provider's
list), page-arrow and back buttons (`ModelPageCallbacks`) and an optional per-model suffix (`formatOpenCodeModelLimitSuffix`: ` ⛔ 14:00`); the ✓ and the arrows and the
page pill (only with more than one page) are the page's. What a tap DOES stays the screen's, so one page cannot act on another screen's snapshot.

The module also owns what the two screens that PICK A PROVIDER (`limitsBoard.ts`, `claudeAccounts.ts`) must decide identically, so a rule changes in one place:
`decideProviderTap` (no model → out of date; exactly one model and the topic is not on that provider → switch at once; else the page), `buildOpenCodeProviderPage` /
`buildProviderModelPage` (the title «<program> · <provider> — pick the model for this topic:», ✓ on the model the topic runs — `getRunningModelOfProvider`, the one «is this
provider active, with which model» rule — and the ⛔ marks), `handleProviderTap` and `handleModelPick`. A model pick goes through the `switchTopicByOperator` port and is
answered with the SHORT toast `limits.switched` («✅ This topic runs on <where>») built from the outcome's `label` — never the route's own long line, a refusal with its reason (and the
page stays), an asked hand-over question with no toast; anything but a refusal returns to the screen. Each screen keeps only its snapshot maps (bounded: `rememberBoundedSnapshot`
in `callbackMessage.ts`, the newest 50) and its callback data.

## `stt.ts`

`/stt` (hidden aliases `/voice`, `/speech`) and its buttons `stt_<action>[_<arg>…]_<revision>` (every button matches
`sttCallbackRe`, at most 64 bytes): the voice-recognition settings, instance-wide, from any topic. The main screen holds only
what is about recognition as a whole (the engine list with the local engine's short state on its row, Add engine, Language,
Close); each engine has a CARD — the common controls plus what its kind adds (a key; or, for the local engine, status, RAM, idle
exit, workers, try again, remove from list, remove model files). Idle and workers are on the local card and nowhere else. The
module renders and runs effects; WHAT a tap does is decided by pure code in `src/stt/` — `sttScreenPlan.ts` (the
screens as data, the callback codec, `reduceSttAction`: a tap → show a screen / save a config / arm an input /
run an effect) and `sttConfigEdit.ts` (the edits, validated by the same schema as a hand edit). Every callback bakes in
the content hash of the settings (`computeSttRevision`), so a keyboard from before a hand edit answers «settings
changed — refreshed» and re-renders; back / close / cancel are exempt. A save writes `stt.json`, then
`applySettingsChange` stops a sidecar the change invalidates (never starts one). The settings read through
`getResolvedSettings` (the file re-read when it changed). The text of the install progress is `stt/sttInstallReporter.ts`'s.

**Typed input** (a custom server's address, an API key) is the `/connect` pattern with its own state, private to the
factory: the next plain message of the topic answers the armed step (`checkIsAwaitingSttInput` /
`submitSttInput`, hooked into the text handler after the profile-name capture). A plausible key
(`checkIsPlausibleProviderApiKey`) is deleted from the topic the instant it is accepted and is never echoed, logged or
put into an error; an implausible one stays visible (not a secret) and the step re-arms; an address with a login in it
is deleted and re-asked. A slash command, the cancel button, a topic teardown or a 10-minute timeout (which retires the
prompt message) ends the step. While a step is awaited (`getAwaitedSttStep`) the output-trace `recv` preview is
`[redacted: speech engine key]` (key) or `[redacted: speech engine address]` (address, which may carry a login).

**Install**: «Add engine → GigaAM (local)» (offered whenever it is not in the list) — installed: it joins first and its card
opens; an install running: attach to it; not installed: a confirm screen with the cost (Cancel returns to where it was reached from: the main screen from the add menu, the local card from its «⬇️ Install») → `Install` hands the SAME message to the
install job (`installJobs.start`, the progress is edited into it and remembered in `state.json` with `shouldEnableOnDone`); the
tap handler never waits for the job. EVERY end — the tap's own continuation, a boot re-attach to a running job, a job that
finished while the bot was down — goes through `finishInstall`: on success the local engine joins the list first and the message
becomes its card (a full list or an unwritable file is said in the message, never «ready»), on failure the message shows the
error, the log tail and `Retry`; the message is forgotten last. `resumeSttInstallAtBoot` / `startSttAutoInstall` are the
boot and `stt.json`-edit entries `bot.ts` calls (`getGeneralKey` names where an `stt.json`-driven install reports). On the local
card «🗑 Remove model files» asks first (Cancel returns to the card), stops the sidecar, deletes the install and drops the engine
from the list (refused while an install runs — the card is shown again); «Remove from list» keeps the files.

## `topicCommand.ts`

`/topic [name]` and its five buttons (`topic_here_` / `topic_other_` / `topic_folder_<i>` / `topic_page_<n>` / `topic_create_`, each
with the WIZARD id baked in): open another forum topic on a folder. One in-flight wizard per `/topic` run, kept in MEMORY (a restart
drops it and its old keyboards answer «out of date»; the newest 20 live, each for half an hour). The questions are one message that
changes shape: the name (a plain message, `/topic <name>` skips it), the folder question («as here» in a bound topic, the picker at
once in General or an unbound topic), the picker, and finally the answer with the «Open topic →» link — the message is edited, so a
keyboard is always consumed. The picker is `bindPicker.ts`'s `buildBindKeyboard` — `/bind`'s own layout, create row included — with
its buttons re-targeted (`BindPickerCallbacks`) at the wizard; its folders are indexes into the list the wizard listed, so a folder
created meanwhile cannot shift them. The next plain message of the origin topic is the answer to a name question (the topic's, or the
new folder's) while the wizard holds the capture: the text handler asks `checkIsAwaitingTopicInput` / `submitTopicInput`; any
command but `/esc` ends that capture silently (`cancelTopicInput`, called from `exitPendingInputModes`, `armFolderCreation` and the
text handler's slash branch) and leaves a question that waits for a tap alone. The way out of a wizard at ANY step is the «✖️ Cancel»
row (the picker's last row, the folder question's third) and `/esc`: `cancelTopicWizard` ends the topic's newest wizard that is not yet
creating its topic, consumes its message into the notice and returns `false` when there is none — then `/esc` is the interrupt of the
agent. Arming the picker's «create new folder» ends `/bind`'s own armed folder-name question (`disarmFolderCreation` port): the two
would race for the next message. The folder work is the bot's: `createWorkFolder` (the validation and `mkdir` `/bind`'s «create new folder»
does) and `bindNewTopic` (`applyBinding` with the topic's name, then the usual binding welcome — no agent starts, and no collision
warning for a folder the person chose on purpose) come through ports. `createForumTopic` is the Bot API call; its refusal for want of
`can_manage_topics` shows the existing `error.tg.perm.manage_topics` hint. The link is `t.me/c/<chat id without -100>/<topic id>` (a
public group: `t.me/<username>/<topic id>`) — the topic id is the id of its creation service message, which a client opens as the
topic (`buildTopicLink`). The owner's private chat has no topics: `checkIsDmKey` answers it with a line. Whether Telegram also
delivers the bot the `forum_topic_created` service message of its own topic is not documented; the existing handler is harmless
either way: the binding exists by then, and the admin list skips bots, so nothing is auto-bound or greeted for the bot's own topic.
