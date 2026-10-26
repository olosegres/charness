# `src/trackers/` — what every tracker connector shares

Today: the cap on tracker task agents (decision D10). Nothing here knows Jira, Telegram or a connector's wire format: a connector
passes a `SessionKey` and gets a decision.

## The cap (`taskAgentLimit.ts`)

`/task_agents` (General) and `settings.json` `taskAgents.maxConcurrent` set how many tracker conversations may work on a hand-over at
once, for the WHOLE bot. One value, read in this order, the first that is set wins: General's value (`state.json`
`taskAgentsMaxConcurrent`), `settings.json`, the built-in default `5`. `0` = no limit (a value, not «never chose»); a typed or hand-edited
number is a whole number up to `taskAgentsMaxConcurrentUpperBound` (100). The cap is read at every question, so a change applies at the
next hand-over with no restart.

## The slots and the wait list (`taskAgentSlots.ts`)

- **A slot is a tracker conversation with an open hand-over request** (origin `trackerEvent`), counted off the request ledger on every
  question — nothing about the running agents is stored, so a restart cannot get the count wrong. One conversation holds ONE slot however
  many hand-overs it has open; a mention request (`trackerMention`) holds none; a request the wake-up engine gave up on
  (`isWakeStopped`) holds none (its alert is out and the issue handed back).
- **`checkIn(key, triggerId)`** → `granted` (the conversation holds a slot already, or it is within the free slots counted from the head of
  the list) or `queued` (it joins the list; `isNewlyQueued` is true once — the moment to say so). A grant is a RESERVATION until
  `noteStarted` (the request is open: the ledger counts it) or `noteStartFailed` (opening it failed), so two connectors polling at once
  never share the last slot. A failed start gives the slot back and keeps the place, but a place whose last start failed does not count as
  AHEAD of the places behind it (one broken issue never holds the others up), and the `taskAgentStartFailureLimit`th (3) failure in a row moves
  it to the end of the list, logged once (`[tasks] … failed to start 3 times in a row`); the failure counts are memory only, so a restart gives
  every place a fresh start.
- **The list is ONE FIFO for every connector**, `state.json` `taskAgentWaitList` (`TaskAgentWaitEntry`: conversation key, the waiting
  trigger id, when it joined), flushed when it changes — a restart keeps the order. A place whose conversation holds a slot already does not
  count; `pruneWaiting(platform, …)` and `dropWaiting` take out what a connector no longer vouches for; `dropUnserved` takes out the places of
  a connector this process does not serve (they could never start and would hold up the others).
- **`onSlotFreed`** wakes the listeners — a connector polls at once instead of at its next interval — while somebody waits, when a slot may
  have freed or room appeared: the ledger's `onRequestClosed` (through `noteRequestClosed`: a hand-over closes for good; one merely replaced
  by a newer one of its conversation frees nothing), the ledger's `onRequestWakeStopped` (through `noteRequestWakeStopped`: the wake-up engine
  gave up — the request stays open but holds no slot), and a raised cap. The cap is read at every question; a read that is not a poll's own
  check-in (`getStatus`, which the `/task_agents` screen calls, and `noteLimitMayHaveChanged`, which `/task_agents` calls after writing
  General's value) wakes the listeners when the cap went UP since the last read. A hand edit of `settings.json` is found by the first such read,
  or by the next poll's check-ins, which honour it directly.

Wired in `bot.ts` once the request ledger is loaded; the Jira side is `connectors/jira/README.md` («The cap on task agents»), the screen
`connectors/telegram/commands/README.md` (`taskAgents.ts`).
