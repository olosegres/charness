/**
 * The accounts note at the moments the bot reaches the agent (`limitNotes/service.ts`), over fake ports: a turn start, the result of
 * a send tool, the two calls that make a conversation orchestrate workers, and the lifecycle rule that a note is a passenger — it
 * reads the usage cache and the conversation's record, writes only that record, and never fails the prompt or tool result it rides on.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsAccountsNoteBackend, checkIsAccountsNoteCarried, createLimitNotes, getAccountsNoteQuietMs, limitNoteInFlightMaxMs, type LimitNotes, type LimitNotesPorts } from '../limitNotes/service';
import { buildLimitNoteFingerprint, defaultLimitNoteWindows, limitNoteMinQuietMs, type LimitNoteRecord } from '../limitNotes/plan';
import { claudePerTurnAdapterName, claudeJsonStreamAdapterName, claudeTmuxAdapterName, openCodeAdapterName, terminalAdapterName } from '../adapters/adapterNames';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { buildClaudeProfilesCreditReport } from '../utils/claudeProfileUsageViews';
import { buildReport, buildViews, hourMs, minuteMs, nowMs } from './limitNotesFixtures';

const key = makeTelegramKey(-1001111111111, 11);

/** The ports of a fake bot: what each call asked for is kept so a test can say what the notes touched — and what they never could. */
function createHarness(overrides: Partial<LimitNotesPorts> = {}, backend: string = openCodeAdapterName) {
  const records = new Map<string, LimitNoteRecord>();
  const calls: string[] = [];
  const logs: string[] = [];
  const state = { report: buildReport(), backend: backend as string | undefined, intervalMs: hourMs as number | null, nowMs };
  const ports: LimitNotesPorts = {
    getRecord: (target) => { calls.push('getRecord'); return records.get(keyToString(target)); },
    setRecord: (target, record) => { calls.push('setRecord'); if (record === null) records.delete(keyToString(target)); else records.set(keyToString(target), record); },
    getIntervalMs: () => { calls.push('getIntervalMs'); return state.intervalMs; },
    getWindows: () => { calls.push('getWindows'); return defaultLimitNoteWindows; },
    getReport: () => { calls.push('getReport'); return state.report; },
    getOpenCodeUsage: () => { calls.push('getOpenCodeUsage'); return {}; },
    getTimezone: () => { calls.push('getTimezone'); return 'UTC'; },
    getBackendName: () => { calls.push('getBackendName'); return state.backend; },
    getNowMs: () => state.nowMs,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { notes: createLimitNotes(ports), records, calls, logs, state };
}

const orchestrating = (patch: LimitNoteRecord = {}): LimitNoteRecord => ({ lastOrchestratedAt: nowMs - hourMs, lastNoteAt: nowMs - 70 * minuteMs, fingerprint: 'rec=old', ...patch });

describe('checkIsAccountsNoteBackend / checkIsAccountsNoteCarried / getAccountsNoteQuietMs', () => {
  it('Claude on the json-stream host (both lifecycles) and OpenCode get notes; the terminal and the deprecated tmux Claude do not', () => {
    for (const name of [claudeJsonStreamAdapterName, claudePerTurnAdapterName, openCodeAdapterName]) assert.equal(checkIsAccountsNoteBackend(name), true, name);
    for (const name of [terminalAdapterName, claudeTmuxAdapterName, 'something-else']) assert.equal(checkIsAccountsNoteBackend(name), false, name);
  });

  it('a prompt is decorated only when its caller marked it a carrier, it is no slash command, and the backend gets notes', () => {
    const base = { isCarrier: true, isSlashCommand: false, adapterName: claudeJsonStreamAdapterName };
    assert.equal(checkIsAccountsNoteCarried(base), true);
    assert.equal(checkIsAccountsNoteCarried({ ...base, isCarrier: false }), false, 'a retry nudge, a hand-over, a replay, a wake-up, a todo reminder, a lost-work note, an answer: no carrier flag');
    assert.equal(checkIsAccountsNoteCarried({ ...base, isCarrier: undefined }), false);
    assert.equal(checkIsAccountsNoteCarried({ ...base, isSlashCommand: true }), false, 'the tmux `/compact` and `/clear` are control tokens');
    assert.equal(checkIsAccountsNoteCarried({ ...base, adapterName: terminalAdapterName }), false);
    assert.equal(checkIsAccountsNoteCarried({ ...base, adapterName: claudeTmuxAdapterName }), false);
  });

  it('the quiet before a turn start is measured from the last turn end, and only while nothing runs', () => {
    assert.equal(getAccountsNoteQuietMs({ lastTurnEndAt: nowMs - 40 * minuteMs, isBusy: false, nowMs }), 40 * minuteMs);
    assert.equal(getAccountsNoteQuietMs({ lastTurnEndAt: nowMs - 40 * minuteMs, isBusy: true, nowMs }), null, 'a message queued into a running turn finds no quiet');
    assert.equal(getAccountsNoteQuietMs({ lastTurnEndAt: nowMs - 40 * minuteMs, isBusy: undefined, nowMs }), null, 'a backend that cannot say is not read as idle');
    assert.equal(getAccountsNoteQuietMs({ lastTurnEndAt: 0, isBusy: false, nowMs }), null, 'no turn ended (or another session): unknown');
    assert.equal(getAccountsNoteQuietMs({ lastTurnEndAt: nowMs + minuteMs, isBusy: false, nowMs }), 0, 'a clock that stepped back reads as no quiet, never negative');
  });
});

describe('the turn-start note', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it('an orchestrating conversation whose reminder is due gets the reminder text; nothing is recorded until the prompt reached the session', () => {
    harness.records.set(keyToString(key), orchestrating());
    const note = harness.notes.takeTurnStartNote(key, null);
    assert.ok(note !== null, 'a reminder is due');
    assert.match(note.text, /^\[Accounts · 14:05\] Next new Claude worker → work \(soonest weekly reset\)/);
    assert.match(note.text, /Call claude_profiles right before your next launch or resume/);
    assert.deepEqual(harness.records.get(keyToString(key)), orchestrating(), 'a forward that failed keeps the note for the next prompt');
    note.release();
    assert.equal(harness.notes.takeTurnStartNote(key, null)?.text, note.text, 'and, given back, the next prompt carries it');
  });

  it('delivered: the time and the fingerprint of the picture it showed are recorded, and the next turn start has nothing due', () => {
    harness.records.set(keyToString(key), orchestrating());
    harness.notes.takeTurnStartNote(key, null)?.markDelivered();
    const recorded = harness.records.get(keyToString(key));
    assert.equal(recorded?.lastNoteAt, nowMs);
    assert.match(recorded?.fingerprint ?? '', /^rec=work\|default:2uo\|work:6uo\|gpt=-$/);
    assert.equal(recorded?.lastOrchestratedAt, nowMs - hourMs, 'the orchestration mark is not moved by a note');
    assert.equal(harness.notes.takeTurnStartNote(key, null), null);
  });

  it('the summary rides a turn start after the quiet period when the picture changed — and not before it', () => {
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    assert.equal(harness.notes.takeTurnStartNote(key, limitNoteMinQuietMs - 1), null);
    const note = harness.notes.takeTurnStartNote(key, limitNoteMinQuietMs);
    assert.match(note?.text ?? '', /^\[Accounts · 14:05 · changed\] work 62 % \(resets in 1 d 19 h\) → next new worker; default 20 % \(5 d\)\.$/);
  });

  it('with the setting Off, or on a conversation that never orchestrated, no usage report is even built', () => {
    harness.records.set(keyToString(key), orchestrating());
    harness.state.intervalMs = null;
    assert.equal(harness.notes.takeTurnStartNote(key, null), null);
    assert.equal(harness.notes.takeSendResultNote(key), null);
    harness.state.intervalMs = hourMs;
    harness.records.delete(keyToString(key));
    assert.equal(harness.notes.takeTurnStartNote(key, null), null);
    harness.records.set(keyToString(key), { lastNoteAt: nowMs - 5 * hourMs });
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'a note record alone is no orchestration');
    assert.equal(harness.calls.includes('getReport'), false);
  });

  it('a backend that gets no notes — the terminal, the tmux Claude, an unknown one — gets none', () => {
    harness.records.set(keyToString(key), orchestrating());
    for (const backend of [terminalAdapterName, claudeTmuxAdapterName, undefined]) {
      harness.state.backend = backend;
      assert.equal(harness.notes.takeTurnStartNote(key, null), null, `${backend}`);
      assert.equal(harness.notes.takeSendResultNote(key), null, `${backend}`);
    }
    assert.equal(harness.calls.includes('getReport'), false);
  });

  it('nothing fresh in the usage cache: no note, and ONE log line per spell — not one per prompt', () => {
    harness.records.set(keyToString(key), orchestrating());
    harness.state.report = buildReport(62, true);
    assert.equal(harness.notes.takeTurnStartNote(key, null), null);
    assert.equal(harness.notes.takeTurnStartNote(key, null), null);
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], /no account has a fresh usage figure/);
    harness.state.report = buildReport();
    const note = harness.notes.takeTurnStartNote(key, null);
    assert.ok(note !== null, 'fresh again: the note comes');
    note.release();
    harness.state.report = buildReport(62, true);
    harness.notes.takeTurnStartNote(key, null);
    assert.equal(harness.logs.length, 2, 'a new spell is logged again');
  });
});

describe('a turn-start note is in flight until its prompt is written', () => {
  let harness: ReturnType<typeof createHarness>;
  const secondKey = makeTelegramKey(-1001111111111, 12);
  beforeEach(() => {
    harness = createHarness();
    harness.records.set(keyToString(key), orchestrating());
    harness.records.set(keyToString(secondKey), orchestrating());
  });

  it('two carrier prompts close together: only the first carries a note — the second reads the record the first has not written yet', () => {
    const first = harness.notes.takeTurnStartNote(key, null);
    assert.ok(first !== null);
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'a voice and a text, or a message and a scheduled run, never both carry it');
    first.markDelivered();
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'delivered: recorded, nothing due');
    assert.equal(harness.records.get(keyToString(key))?.lastNoteAt, nowMs);
  });

  it('once delivered it is no longer in flight: the next note is held back only by the interval, never by the delivered one', () => {
    harness.state.intervalMs = minuteMs;
    harness.notes.takeTurnStartNote(key, null)?.markDelivered();
    harness.state.nowMs = nowMs + 2 * minuteMs;
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null, 'the minute has passed since the last note: due again, and nothing in flight holds it');
  });

  it('another conversation is not held by it', () => {
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null);
    assert.ok(harness.notes.takeTurnStartNote(secondKey, null) !== null);
  });

  it('a prompt that did not reach the session gives the note back: nothing is recorded and the next carrier prompt carries it', () => {
    const first = harness.notes.takeTurnStartNote(key, null);
    first?.release();
    assert.deepEqual(harness.records.get(keyToString(key)), orchestrating(), 'a failed write leaves the record as it was');
    assert.equal(harness.notes.takeTurnStartNote(key, null)?.text, first?.text);
  });

  it('while one is in flight no send result carries a note either', () => {
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    const note = harness.notes.takeTurnStartNote(key, limitNoteMinQuietMs);
    assert.ok(note !== null);
    assert.equal(harness.notes.takeSendResultNote(key), null);
    note.release();
    assert.ok(harness.notes.takeSendResultNote(key) !== null, 'given back: free again');
  });

  it('a note whose prompt never reached any end (a forward that threw before the write) is forgotten after the in-flight window — one lost path never silences the conversation for good', () => {
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null);
    harness.state.nowMs = nowMs + limitNoteInFlightMaxMs - 1;
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'still in flight inside the window');
    harness.state.nowMs = nowMs + limitNoteInFlightMaxMs;
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null, 'forgotten at the window\'s end');
  });
});

describe('the mid-turn note', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness({}, claudeJsonStreamAdapterName);
    harness.records.set(keyToString(key), orchestrating());
  });

  it('a reminder that is due is read by the running turn; nothing is recorded until the hook took it, and the record then shows the picture it carried', () => {
    const note = harness.notes.takeMidTurnNote(key);
    assert.ok(note !== null, 'the reminder is due');
    assert.match(note.text, /^\[Accounts · 14:05\] Next new Claude worker → work/);
    assert.deepEqual(harness.records.get(keyToString(key)), orchestrating(), 'offered is not delivered');
    note.markDelivered();
    assert.equal(harness.records.get(keyToString(key))?.lastNoteAt, nowMs);
    assert.match(harness.records.get(keyToString(key))?.fingerprint ?? '', /^rec=work\|/);
  });

  it('never the summary: a changed picture inside a turn that is not yet due for a reminder waits for the next turn start or send result', () => {
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    assert.equal(harness.notes.takeMidTurnNote(key), null);
  });

  it('while it waits in the inbox no other note is taken for the conversation — and withdrawn unseen it is given back and stays due', () => {
    const note = harness.notes.takeMidTurnNote(key);
    assert.ok(note !== null);
    assert.equal(harness.notes.takeMidTurnNote(key), null, 'one in flight');
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'a prompt does not carry a second one');
    assert.equal(harness.notes.takeSendResultNote(key), null);
    note.release();
    assert.deepEqual(harness.records.get(keyToString(key)), orchestrating(), 'a withdrawn note records nothing');
    assert.equal(harness.notes.takeMidTurnNote(key)?.text, note.text);
  });

  it('a conversation that never orchestrated, Off, and a backend that gets no notes have none — the same gates as every moment', () => {
    harness.records.delete(keyToString(key));
    assert.equal(harness.notes.takeMidTurnNote(key), null);
    harness.records.set(keyToString(key), orchestrating());
    harness.state.intervalMs = null;
    assert.equal(harness.notes.takeMidTurnNote(key), null);
    harness.state.intervalMs = hourMs;
    harness.state.backend = terminalAdapterName;
    assert.equal(harness.notes.takeMidTurnNote(key), null);
  });

  it('a note that cannot be worked out is skipped, never thrown into the engine\'s poll', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const failing = createHarness({ getReport: () => { throw new Error('usage cache unreadable'); } }, claudeJsonStreamAdapterName);
      failing.records.set(keyToString(key), orchestrating());
      assert.doesNotThrow(() => failing.notes.takeMidTurnNote(key));
      assert.equal(failing.notes.takeMidTurnNote(key), null);
    } finally {
      console.error = original;
    }
  });
});

describe('the send-result note', () => {
  it('a changed picture rides the result and counts as delivered at once — the next result carries nothing', () => {
    const harness = createHarness();
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    const text = harness.notes.takeSendResultNote(key);
    assert.match(text ?? '', /^\[Accounts · 14:05 · changed\] work 62 %/);
    assert.equal(harness.records.get(keyToString(key))?.lastNoteAt, nowMs);
    assert.equal(harness.notes.takeSendResultNote(key), null, 'unchanged, and inside the floor');
  });

  it('never the reminder, however overdue: only a change is worth a send result', () => {
    const harness = createHarness();
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 5 * hourMs, fingerprint: undefined }));
    harness.state.report = buildReport();
    const text = harness.notes.takeSendResultNote(key);
    assert.ok(text !== null && !text.includes('claude_profiles'), 'the one-line summary, without the instruction');
  });

  it('an unchanged picture, or a change inside the 30-min floor, is silent', () => {
    const harness = createHarness();
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    harness.notes.takeSendResultNote(key);
    harness.state.report = buildReport(80);
    harness.state.nowMs = nowMs + 10 * minuteMs;
    assert.equal(harness.notes.takeSendResultNote(key), null, 'changed 10 min after a note: the floor holds it back');
    harness.state.nowMs = nowMs + 31 * minuteMs;
    assert.ok(harness.notes.takeSendResultNote(key) !== null, 'after the floor it comes');
  });
});

describe('the two calls that make a conversation orchestrate workers', () => {
  it('`claude_profiles`: the reminder clock restarts, the conversation orchestrates, the picture now is on record', () => {
    const harness = createHarness();
    harness.notes.noteProfilesCall(key);
    const recorded = harness.records.get(keyToString(key));
    assert.equal(recorded?.lastProfilesCallAt, nowMs);
    assert.equal(recorded?.lastOrchestratedAt, nowMs);
    assert.match(recorded?.fingerprint ?? '', /^rec=work\|/);
    assert.equal(recorded?.lastNoteAt, undefined, 'a call is no note');
    assert.equal(harness.notes.takeTurnStartNote(key, null), null, 'no reminder for the next interval');
    harness.state.nowMs = nowMs + hourMs;
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null, 'and one an hour later');
  });

  it('the picture on record is the notes\' OWN, not the answer the agent got: a resume-shaped answer differs from it, yet the next send result carries no «changed» summary', () => {
    const harness = createHarness();
    // The agent resumed a worker that ran on `default`: its answer stays on that warm account, the notes' report ranks `work` first.
    const agentAnswer = buildClaudeProfilesCreditReport(buildViews(), 'sonnet', nowMs, { currentProfile: 'default', chainScope: null });
    assert.equal(agentAnswer.recommended, 'default');
    assert.equal(harness.state.report.recommended, 'work');
    assert.notEqual(buildLimitNoteFingerprint(agentAnswer, {}, nowMs), buildLimitNoteFingerprint(harness.state.report, {}, nowMs), 'precondition: the two pictures differ');

    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 5 * hourMs, fingerprint: undefined }));
    harness.notes.noteProfilesCall(key);
    assert.equal(harness.records.get(keyToString(key))?.fingerprint, buildLimitNoteFingerprint(harness.state.report, {}, nowMs));
    assert.equal(harness.notes.takeSendResultNote(key), null, 'the agent just looked: nothing changed');
    harness.state.report = buildReport(80);
    assert.ok(harness.notes.takeSendResultNote(key) !== null, 'and a real change after that is still told');
  });

  it('a worker watch: the conversation orchestrates, nothing else moves — and a reminder is due at its next turn start, for an agent that never looked', () => {
    const harness = createHarness();
    harness.records.set(keyToString(key), { lastNoteAt: nowMs - 2 * hourMs, fingerprint: 'rec=old' });
    harness.notes.noteWorkerWatch(key);
    assert.deepEqual(harness.records.get(keyToString(key)), { lastNoteAt: nowMs - 2 * hourMs, fingerprint: 'rec=old', lastOrchestratedAt: nowMs });
    assert.ok(harness.notes.takeTurnStartNote(key, null) !== null);
  });

  it('is recorded whatever the setting says: turning reminders on later finds the conversation already known', () => {
    const harness = createHarness();
    harness.state.intervalMs = null;
    harness.notes.noteWorkerWatch(key);
    harness.notes.noteProfilesCall(key);
    harness.state.intervalMs = hourMs;
    assert.equal(harness.records.get(keyToString(key))?.lastOrchestratedAt, nowMs);
  });
});

describe('a note is a passenger, never a cause', () => {
  it('it can only read the usage cache and the clock and read / write its own record: no other port exists, and these are all it ever calls', () => {
    const harness = createHarness();
    harness.records.set(keyToString(key), orchestrating({ lastNoteAt: nowMs - 40 * minuteMs }));
    harness.notes.takeTurnStartNote(key, limitNoteMinQuietMs)?.markDelivered();
    harness.notes.takeMidTurnNote(key)?.release();
    harness.notes.takeSendResultNote(key);
    harness.notes.noteProfilesCall(key);
    harness.notes.noteWorkerWatch(key);
    const allowed = new Set(['getRecord', 'setRecord', 'getIntervalMs', 'getWindows', 'getReport', 'getOpenCodeUsage', 'getTimezone', 'getBackendName']);
    assert.deepEqual([...new Set(harness.calls)].filter((name) => !allowed.has(name)), []);
    const operations: LimitNotes = createHarness().notes;
    assert.deepEqual(Object.keys(operations).sort(), ['noteProfilesCall', 'noteWorkerWatch', 'takeMidTurnNote', 'takeSendResultNote', 'takeTurnStartNote'], 'five operations, none of them an activity stamp, a write to an agent or a wake');
  });

  it('a note that cannot be worked out is skipped and logged, the prompt or result goes on — never a throw', () => {
    const original = console.error;
    const errors: string[] = [];
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    try {
      const harness = createHarness({ getReport: () => { throw new Error('usage cache unreadable'); } });
      harness.records.set(keyToString(key), orchestrating());
      assert.equal(harness.notes.takeTurnStartNote(key, null), null);
      assert.equal(harness.notes.takeSendResultNote(key), null);
      assert.equal(errors.length, 2);
      assert.match(errors[0], /the turn-start note failed, nothing is added: usage cache unreadable/);

      const failingWrite = createHarness({ setRecord: () => { throw new Error('disk full'); } });
      failingWrite.records.set(keyToString(key), orchestrating());
      const note = failingWrite.notes.takeTurnStartNote(key, null);
      assert.doesNotThrow(() => note?.markDelivered());
      assert.doesNotThrow(() => failingWrite.notes.noteWorkerWatch(key));
      assert.doesNotThrow(() => failingWrite.notes.noteProfilesCall(key));
    } finally {
      console.error = original;
    }
  });
});
