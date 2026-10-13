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

`/auto_continue_limits` and its buttons `acl_on` / `acl_off`: whether the bot waits out a usage-limit window and
resumes the agent by itself. A regular topic sets its own override, General the instance-wide default. The
command is deliberately not gated on a session — a limit can hit any topic and the preference must be settable
before it does. Turning it off drops the topic's armed resume and stops waking its request, but only when a wait
WAS armed. The picker shows a «skip once» row only while a resume is armed; a tap consumes the picker into a
keyboard-less confirmation. The usage-limit notice appends the shared pointer through
`appendAutoContinueLimitsHint` and its own «skip once» button consumes the picker through the returned
`consumeAutoContinueLimitsPicker`.

## `claudeAccounts.ts`

`/account` (`/accounts`) and the buttons `acct_use_<name>`, `acct_follow`, `acct_add`, `acct_login_menu`,
`acct_rm_menu`, `acct_back`, `acct_login_<name>`, `acct_rm_<name>`, `acct_rmok_<name>`: which Claude account
profile (`utils/claudeProfiles.ts`) a topic's Claude sessions run on. A button BAKES the profile name into its
data (names are slugs of at most 32 characters, so the data stays under 64 bytes) — an old keyboard can never act
on another profile. A regular topic sets its own pick, General the instance default; the picker is meant for
repeated use and re-renders in place. The module owns no process: it asks the bot through ports to probe
`claude auth status --json` under a profile's directory (`readClaudeAuthStatus`, refreshed on every render so the
list shows the CLI's truth), to start the sign-in relay for a profile (`startClaudeProfileLogin` →
`agentLogin/`), and to move live sessions onto a changed pick (`applyClaudeProfile` for one topic,
`applyClaudeProfileEverywhere` after a General pick, a removal or a finished sign-in). «Add» without a name arms a
per-topic name capture the text handler consults (`checkIsAwaitingProfileName` / `submitProfileName`; a slash
command or `/esc` disarms it through `cancelProfileNameCapture`). A profile that is not signed in cannot be
picked; `default` is never removed; the instance default is refused until General picks another; removing a
profile drops the topic picks that named it (the state returns them, so their sessions are moved at once).
Under each row the picker prints the profile's usage windows (`utils/claudeUsage.ts`: session, weekly, Fable
weekly — percent used → reset in the instance zone, `getInstanceTimezone`), read off the record's snapshot
after `refreshClaudeUsage({ maxAgeMs })` ran beside the status probes; the default profile's probe result
goes to its hidden record too, so the usage ranking and the CLI twin know whether it is signed in. The picker's
last row is the auto-switch-on-limit toggle (`acct_autosw_on` / `acct_autosw_off`, `/account autoswitch on|off`;
OFF by default; General sets the instance default, a topic its override — `utils/claudeLimitSwitch.ts`). The
module also owns the `acsw_<episode>_<name>` button a usage-limit notice carries: the tap goes to the
`takeLimitSwitchOffer` port (the bot checks the episode is still the topic's open one, moves the topic and
resumes the work) and the notice is edited into the confirmation; a stale tap only answers the callback.
