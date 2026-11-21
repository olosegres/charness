# `src/limitNotes/` — the accounts note

An agent that launches workers picks an account once and never looks again, so it keeps spending accounts whose limits reset
late. The bot hands such a conversation a short **accounts note**: which account the next new Claude worker goes to and why,
when each limit resets — so what resets first is spent first. Agent-facing English, never posted to the topic.

## The planner (`plan.ts`) — pure

No clock, no state, no I/O: the caller hands in the report, the record, the setting and `nowMs`.

- **Who gets notes.** A conversation whose agent called `claude_profiles` or armed a worker watch in the last 7 days
  (`LimitNoteRecord.lastOrchestratedAt`). Plain chat and builder topics never see one.
- **Two shapes.** `reminder` (the pick with its reason and its week and five-hour figures, the next one or two accounts in launch order, the
  ChatGPT window, «call `claude_profiles` right before your next launch or resume»; scheduled) and `summary` (one line of the
  same figures, no instruction; only when the picture changed).
- **`decideLimitNote`** answers the shape or `null` with every reason (`limitNoteSkipReasons`, named so a log line says why
  nothing came):
  - gates for both shapes: orchestrating, not Off, a fresh figure in the usage cache (`checkHasFreshLimitUsage`);
  - reminder — turn start or mid-turn, once the interval has passed since the last note OR the agent's last `claude_profiles`
    call (calling it IS looking; never either → due); a send result carries none;
  - summary — a send result, or a turn start after 30 min of quiet (a woken session); never mid-turn; only when the
    fingerprint differs from the last note's (none stored = differs) and 30 min after it;
  - both due → the reminder alone.
- **`buildLimitNoteFingerprint`**: the recommended account; per account the `/limits` list offers its weekly use in 10-point
  steps, usable now, five-hour window past the 90 % launch ceiling; the ChatGPT weekly use in 10-point steps. A stale figure is
  its own state (`?`).
- **`buildLimitNoteText`**: from the report `claude_profiles` answers with (`buildClaudeProfilesCreditReport`) — the same pick,
  and the accounts after it are the report's `launchOrder` — the one list `getClaudeLaunchOrder` builds and the pick is the head
  of; never a second ranking. The pick's reason is `describeClaudeLaunchOutcome`'s wording. A stale figure reads
  «usage unknown», a window whose reset has passed 0 % with no countdown, an API account its credit estimate.
- **Setting.** `/limits_reminders`: every 1 h (default) / 2 h / 4 h / Off. `resolveLimitRemindersMinutes(general, topic)`: a
  topic's own choice, else General's, else the default; a stored number no choice names counts as no choice.
- The three windows (quiet, summary floor, orchestration) travel as `LimitNoteWindows`, so a flow can shorten them.

## Lifecycle safety — a note is a passenger, never a cause

Every later scope of this feature keeps these seven rules; each has a test.

1. Never activity: no `lastActivityAt` stamp, no idle-timer re-arm, no held-mark logic touched.
2. Never input: no write of its own to an agent (the turn-start note is part of the ONE prompt text, the Claude mid-turn note is
   hook `additionalContext`, the send-result note is tool-result text); no unconsumed-input entry, no request, no working signal.
3. Never wakes: no path calls `ensureAgentSession` or a resume; only a session that is active AND busy gets a mid-turn note.
4. Never «working»: no typing, no busy flag, no indicator refresh, no stdout or tool event.
5. Never into a held turn: compaction, limit wait / retry kick, question wait, wedge recovery, session start.
6. The deferred account switch and the self-update idle verdict read nothing a note moves.
7. Restart-safe: note state persists, a restart neither bursts reminders nor leaves an inbox file behind.
