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

`/model` (the provider → models picker), `/effort`, `/connect`, `/disconnect` and the twelve buttons behind them. The
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
`/limits` (`fallbackChain.ts`); here live the write path (`applyAutoContinueLimits`, exported to that module
through a port) and the alias: `on|off` apply, a bare `/auto_continue_limits` opens the `/limits` view
(`openLimitsView` port). A regular topic sets its own override (`null` drops it, back to the instance
default), General the instance-wide default. Turning the EFFECTIVE value off drops the topic's armed resume and
stops waking its request, but only when a wait WAS armed. A tap on an old `acl_*` button consumes its picker into
a keyboard-less confirmation. The usage-limit notice appends the shared pointer through
`appendAutoContinueLimitsHint` and its own «skip once» button consumes the picker through the returned
`consumeAutoContinueLimitsPicker`.

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
command or `/esc` disarms it through `cancelProfileNameCapture`). A profile that is not signed in cannot be
picked; the instance default is refused until General picks another; «remove» of `default` signs `~/.claude` out (`signOutDefaultClaudeLogin`: only the stored `claudeAiOauth` login, never `projects/` / settings / skills / memory) and marks its hidden record `isRemoved`, which hides it from the rows and from `buildClaudeProfileUsageViews` (so the rankings) until a probe finds it signed in again (the `getHomeClaudeDir` port lets a test sign out a decoy); removing a
profile drops the topic picks that named it (the state returns them, so their sessions are moved at once).
Under each row the picker prints the profile's usage windows (`utils/claudeUsage.ts`: session, weekly, Fable
weekly — percent used → a relative reset `🔄 in 2d 1h` (`formatClaudeUsageBucket`; an unknown 5h reset shows the weekly one)), read off the record's snapshot
after `refreshClaudeUsage({ maxAgeMs })` ran beside the status probes; the default profile's probe result
goes to its hidden record too, so the usage ranking and the CLI twin know whether it is signed in. The auto-switch-on-limit toggle left the picker for `/limits` (a pointer line stays); `/account autoswitch
on|off` and the old `acct_autosw_on` / `acct_autosw_off` buttons still work and write the same setting through the
`applyAutoSwitch` port (`fallbackChain.ts` owns the write and the confirmation). A provider row mirrors an account row: «🔌 Disconnect <provider>» (`acct_dc_<i>`, asks first) and 🔑
(`acct_dcre_<i>`, the `/connect` method picker); both index the provider list snapshotted per screen message.

## `fallbackChain.ts`

`/limits` (hidden alias `/fallback`; `/auto_continue_limits` opens the same screen) and the buttons
`fbk_op_<i>_<rev>` (open a rung's detail view in the same message), and in that view `fbk_up_<i>_<rev>`, `fbk_dn_<i>_<rev>`, `fbk_tg_<i>_<rev>` (include / leave out of automatic switching), `fbk_rm_<i>_<rev>`,
`fbk_add`, `fbk_addc_<profile>`, `fbk_addcm_<profile>_<model|->`, `fbk_addp_<i>`, `fbk_addpg_<page>`, `fbk_addm_<i>`,
`fbk_prop`, `fbk_propok`, `fbk_clear`, `fbk_back`, the two settings `fbk_asw_on|off|same` (auto switch to a fallback
model) and `fbk_wait_on|off|same` (wait for the reset; written through the `applyAutoContinue` port), plus `fbsw_<episode>_<i>` on a
usage-limit notice: the instance-wide priority chain of backend + account / provider + model a topic continues
on when its agent hits a usage limit (`utils/fallbackChain.ts`). The list is edited from EVERY topic (one instance-wide list; a topic also gets ✓ on its own position, the
three-state rows — on / off / as General — for the two settings' overrides, and «skip once» while a limit wait is
armed). The main screen is one full-width button per rung (`formatRowButtonLabel`, the one place the label is built) and the
closing priority paragraph; the message text carries no numbered list. A tap opens `renderRungDetail` in the same message (⬆️ hidden on
the first rung, ⬇️ on the last; up / down / toggle re-render the view at the rung's new place, remove returns to the list); a rung with `disabled: true` is skipped by
`pickFallbackCandidates` and kept disabled by a rebuild (`proposeFallbackChain(detection, previous)`); the screen is meant
for repeated use and re-renders in place. Every edit button BAKES the chain's content revision (8 hex digits of
an FNV-1a over the entries): a keyboard posted before a later edit is refused as stale and only re-rendered, so
an old index can never act on another rung. The two-step «add» keeps a snapshot per picker MESSAGE
(`addSnapshots`: the providers listed, then the chosen provider's models) that the index buttons resolve
against; a Claude account bakes its name and model in the data. The module owns no detection or switch: it
asks the bot through ports for what is connected (`detectFallbackOptions` — the profile views, the OpenCode
catalog, the recent `/model` picks, the limit marks), the topic's current rung (`getTopicPosition`) and the
switch a notice button triggers (`takeSwitchOffer`: the bot checks the episode is still the topic's open one and
the index is inside that episode's remembered candidates, moves the topic and resumes the work; the notice is
edited into the confirmation, a stale tap only answers the callback).
