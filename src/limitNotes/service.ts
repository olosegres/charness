/**
 * @description The accounts note at the moments the bot reaches the agent anyway: a turn start (the note rides the ONE prompt text
 * the forward writes), the result of a bot send tool, and the two tool calls that make a conversation count as orchestrating
 * workers (`claude_profiles`, a worker watch). Decisions and texts are `plan.ts`'s; this is the glue over ports, so the bot hands in
 * its state, its usage cache and its clock and a test hands in fakes.
 *
 * A note is a passenger, never a cause (README § Lifecycle safety): this module has no port that stamps activity, writes to an
 * agent, wakes a session, sets «working» or touches a request — it can only READ the conversation's state and WRITE its own
 * record. It never throws: a note that cannot be worked out is logged and skipped, the prompt or tool result goes on without it.
 */

import { checkIsJsonStreamBackend, openCodeAdapterName } from '../adapters/adapterNames';
import { keyToString, type SessionKey } from '../sessionKey';
import type { ClaudeProfilesReport } from '../utils/claudeUsage';
import {
  buildLimitNoteFingerprint,
  buildLimitNoteText,
  checkHasFreshLimitUsage,
  decideLimitNote,
  getLimitNoteRecordAfterDeliveredNote,
  getLimitNoteRecordAfterProfilesCall,
  getLimitNoteRecordAfterWorkerWatch,
  limitNoteSkipReasons,
  type LimitNoteMoment,
  type LimitNoteRecord,
  type LimitNoteWindows,
  type OpenCodeProviderUsages,
} from './plan';

/**
 * How long a turn-start or send-result note may be in flight before it is forgotten: well past the longest write into an agent's
 * input (the FIFO stall budget, 2 min). A mid-turn note has no such expiry: its owner, the inbox, ends it on every exit.
 */
export const limitNoteInFlightMaxMs = 5 * 60 * 1000;

/** The moment's name in a log line. */
const noteMomentLabels: Record<LimitNoteMoment, string> = { turnStart: 'turn-start', midTurn: 'mid-turn', sendResult: 'send-result' };

/** @description What the notes read and write. `getReport` is the report `claude_profiles` answers with (no second ranking). */
export interface LimitNotesPorts {
  getRecord: (key: SessionKey) => LimitNoteRecord | undefined;
  setRecord: (key: SessionKey, record: LimitNoteRecord | null) => void;
  /** The interval in ms the conversation is under (its own choice, else General's, else the default); `null` = Off. */
  getIntervalMs: (key: SessionKey) => number | null;
  getWindows: () => LimitNoteWindows;
  getReport: (nowMs: number) => ClaudeProfilesReport;
  getOpenCodeUsage: () => OpenCodeProviderUsages;
  getTimezone: () => string;
  /** The backend (adapter name) the conversation's agent runs; `undefined` when none is known. */
  getBackendName: (key: SessionKey) => string | undefined;
  getNowMs: () => number;
  log: (line: string) => void;
}

/**
 * @description A note worked out for a turn start or for a running Claude turn. While it is in flight — taken, not yet delivered — no
 * other note is taken for the conversation, so two carrier prompts close together (a voice and a text, a message and a scheduled
 * run), or a prompt and a mid-turn note, never both carry one. Exactly one of the two ends it: `markDelivered` records it once the
 * prompt that carries it reached the session (or the hook took the inbox file that holds it); `release` gives it back when it did not
 * (the write failed, the session was gone, the inbox was withdrawn unseen), so the note stays due. A note delivered after a newer look
 * or note was recorded never rolls that record back (`getLimitNoteRecordAfterDeliveredNote`).
 */
export interface TakenNote {
  text: string;
  markDelivered: () => void;
  release: () => void;
}

export interface LimitNotes {
  /** The note the prompt of this turn start carries, or `null` (nothing due, not an orchestrator, Off, …). */
  takeTurnStartNote: (key: SessionKey, quietMs: number | null) => TakenNote | null;
  /** The reminder a running Claude turn reads after its next tool call (never the summary), or `null`. The caller delivers it, then `markDelivered`s or `release`s it. */
  takeMidTurnNote: (key: SessionKey) => TakenNote | null;
  /** The note a bot send tool's result carries (recorded as delivered at once: the result goes back to the agent now), or `null`. */
  takeSendResultNote: (key: SessionKey) => string | null;
  /**
   * The agent called `claude_profiles`: it looked, and it orchestrates workers. The picture it is taken to hold is the notes' OWN report
   * (the one every later decision fingerprints), never the answer it got: that one was built for its model and its resumed account, and
   * differs from the notes' whenever the call was a resume — a «changed» summary right after the agent looked.
   */
  noteProfilesCall: (key: SessionKey) => void;
  /** The agent armed a worker watch: it orchestrates workers. */
  noteWorkerWatch: (key: SessionKey) => void;
}

/**
 * @description Whether the backend gets notes: Claude on the json-stream host (both lifecycles) and OpenCode. Not the terminal (no
 * agent) and not the deprecated, frozen tmux-scrape Claude.
 */
export function checkIsAccountsNoteBackend(adapterName: string): boolean {
  return checkIsJsonStreamBackend(adapterName) || adapterName === openCodeAdapterName;
}

/**
 * @description Whether the forward of a prompt decorates it with the accounts note: only a prompt a caller marked as a carrier (a
 * person's message that opened a request, a tracker post, a scheduled run — every other caller of the forward leaves the flag off),
 * never a slash command (a control token a block would corrupt), and only on a backend that gets notes.
 */
export function checkIsAccountsNoteCarried(input: { isCarrier: boolean | undefined; isSlashCommand: boolean; adapterName: string }): boolean {
  return input.isCarrier === true && !input.isSlashCommand && checkIsAccountsNoteBackend(input.adapterName);
}

/**
 * @description How long the agent was quiet before a turn start, for the summary's «it woke up»: since its last turn ended, and
 * only while nothing runs (`isBusy` false) — a message queued into a running turn finds a session that is not quiet. Read from the
 * persisted turn-end stamp, which a person's own message never moves (the activity stamp the idle timer uses is stamped at the
 * message's arrival, before the forward). `null` = unknown (no turn ended yet, a different session, a busy or unreadable one).
 */
export function getAccountsNoteQuietMs(input: { lastTurnEndAt: number; isBusy: boolean | undefined; nowMs: number }): number | null {
  if (input.lastTurnEndAt <= 0 || input.isBusy !== false) return null;
  return Math.max(0, input.nowMs - input.lastTurnEndAt);
}

/** @description The notes over `ports`. */
export function createLimitNotes(ports: LimitNotesPorts): LimitNotes {
  /** Whether the «nothing fresh» line was logged since figures last were fresh: said once per spell, not at every prompt. */
  let isNoFreshUsageLogged = false;
  /**
   * The notes in flight, by conversation: when each was taken, and whether it expires. A turn-start note whose prompt never reached
   * a write that ends it (a forward that threw before the write) is forgotten after {@link limitNoteInFlightMaxMs}, so one lost
   * path cannot silence the conversation for good. A mid-turn note never expires: it waits in the inbox for as long as no tool call
   * finishes (a long watch, a `sleep`), and every way out of the inbox ends it — taken, withdrawn, replaced, cleared, a failed write.
   * Were it forgotten meanwhile, a send result would carry a second note beside it.
   */
  const notesInFlight = new Map<string, { takenAtMs: number; isExpiring: boolean }>();

  function runGuarded<TResult>(key: SessionKey, what: string, fallback: TResult, work: () => TResult): TResult {
    try {
      return work();
    } catch (error) {
      console.error(`[limit-notes] ${keyToString(key)}: ${what} failed, nothing is added:`, error instanceof Error ? error.message : error);
      return fallback;
    }
  }

  function checkIsNoteInFlight(key: SessionKey, nowMs: number): boolean {
    const inFlight = notesInFlight.get(keyToString(key));
    if (inFlight === undefined) return false;
    if (!inFlight.isExpiring || nowMs - inFlight.takenAtMs < limitNoteInFlightMaxMs) return true;
    notesInFlight.delete(keyToString(key));
    return false;
  }

  /** The note of `moment` for `key`, with what recording it needs; `null` when none is due. */
  function prepareNote(key: SessionKey, moment: LimitNoteMoment, quietMs: number | null): { text: string; fingerprint: string } | null {
    const backendName = ports.getBackendName(key);
    if (backendName === undefined || !checkIsAccountsNoteBackend(backendName)) return null;
    const record = ports.getRecord(key);
    // A plain chat or a builder topic never called `claude_profiles` nor armed a watch: no report is built for it.
    if (record?.lastOrchestratedAt === undefined) return null;
    const intervalMs = ports.getIntervalMs(key);
    if (intervalMs === null) return null;
    const nowMs = ports.getNowMs();
    if (checkIsNoteInFlight(key, nowMs)) return null;
    const report = ports.getReport(nowMs);
    const openCodeUsage = ports.getOpenCodeUsage();
    const hasFreshUsage = checkHasFreshLimitUsage(report);
    const fingerprint = buildLimitNoteFingerprint(report, openCodeUsage, nowMs);
    const decision = decideLimitNote({ moment, record, intervalMs, fingerprint, hasFreshUsage, quietMs, nowMs, windows: ports.getWindows() });
    if (hasFreshUsage) isNoFreshUsageLogged = false;
    if (decision.shape === null) {
      if (decision.skipReasons.includes(limitNoteSkipReasons.noFreshUsage) && !isNoFreshUsageLogged) {
        isNoFreshUsageLogged = true;
        ports.log(`[limit-notes] no accounts note: no account has a fresh usage figure (the usage cache holds stale or no snapshots)`);
      }
      return null;
    }
    return { text: buildLimitNoteText(decision.shape, report, openCodeUsage, ports.getTimezone(), nowMs), fingerprint };
  }

  /** The note of `moment` for `key`, put in flight until its owner delivers or releases it. */
  function takeNote(key: SessionKey, moment: LimitNoteMoment, quietMs: number | null): TakenNote | null {
    const note = prepareNote(key, moment, quietMs);
    if (note === null) return null;
    const takenAtMs = ports.getNowMs();
    notesInFlight.set(keyToString(key), { takenAtMs, isExpiring: moment !== 'midTurn' });
    return {
      text: note.text,
      markDelivered: () => {
        notesInFlight.delete(keyToString(key));
        runGuarded(key, `recording the ${noteMomentLabels[moment]} note`, undefined, () => recordNote(key, note.fingerprint, takenAtMs));
      },
      release: () => { notesInFlight.delete(keyToString(key)); },
    };
  }

  function recordNote(key: SessionKey, fingerprint: string, takenAtMs: number): void {
    const record = ports.getRecord(key);
    const recorded = getLimitNoteRecordAfterDeliveredNote(record, { atMs: ports.getNowMs(), takenAtMs, fingerprint });
    if (recorded !== record) ports.setRecord(key, recorded);
  }

  return {
    takeTurnStartNote: (key, quietMs) => runGuarded(key, 'the turn-start note', null, () => takeNote(key, 'turnStart', quietMs)),
    takeMidTurnNote: (key) => runGuarded(key, 'the mid-turn note', null, () => takeNote(key, 'midTurn', null)),
    takeSendResultNote: (key) => runGuarded(key, 'the send-result note', null, () => {
      const note = prepareNote(key, 'sendResult', null);
      if (note === null) return null;
      recordNote(key, note.fingerprint, ports.getNowMs());
      return note.text;
    }),
    noteProfilesCall: (key) => runGuarded(key, 'recording a claude_profiles call', undefined, () => {
      const nowMs = ports.getNowMs();
      const fingerprint = buildLimitNoteFingerprint(ports.getReport(nowMs), ports.getOpenCodeUsage(), nowMs);
      ports.setRecord(key, getLimitNoteRecordAfterProfilesCall(ports.getRecord(key), { atMs: nowMs, fingerprint }));
    }),
    noteWorkerWatch: (key) => runGuarded(key, 'recording a worker watch', undefined, () => {
      ports.setRecord(key, getLimitNoteRecordAfterWorkerWatch(ports.getRecord(key), ports.getNowMs()));
    }),
  };
}
