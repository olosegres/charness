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
