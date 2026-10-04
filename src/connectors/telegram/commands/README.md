# `src/connectors/telegram/commands/` — Telegram command modules

Slash commands and their buttons that were decomposed out of `bot.ts`, one file per feature. A file exports
`create<Feature>(ports)`; `bot.ts` builds ONE ports bag (`BotCore` in `botCore.ts`: the telegraf instance, the
neutral `command` registrar, the topic send helpers, a state getter) and calls the factory and its `register…()`
functions where the handlers used to be registered. A module never imports `bot.ts`.

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

`/model` (the provider → models picker), `/effort`, `/connect`, `/disconnect` and the ten buttons behind them. The
module registers in THREE places: `registerProviderCommands` (where `/connect` and `/disconnect` sat),
`registerModelCommands` (`/model`, `/effort`) and `registerModelCallbacks`; the neighbouring `/claude_mode`
stays in `bot.ts` between the first two. The per-thread picker state (`awaitingModelSelection`,
`threadModelLists`, the pending-connect and snapshot maps, the other input-mode sets) is owned by `bot.ts`,
which clears it on teardown and reads it in the text handler, and is passed in. A bare digit is read as a model
pick only while `awaitingModelSelection` holds the thread, and every numbered pick — typed or tapped — disarms
it. A pasted provider key is deleted from the topic as a secret only when it can be a real key; an implausible
one stays visible and the connect stays armed. The OAuth buttons reach the sign-in driver
(`../../../agentLogin/`) through the `startOpenCodeOAuthLogin` port.
