/**
 * @description Coverage for `scheduler/delivery.ts` (S4) — the `deliver`
 * callback the engine fires: announce → pin → ensure-session → (wait-for-idle)
 * → forward, and the `DeliveryOutcome` it reports.
 *
 * Every side effect is injected, so these run with no Telegram, no adapter, and
 * a FAKE clock: `sleep(ms)` advances a mutable `now` cursor and resolves on a
 * microtask, so the wait-for-idle loop's pauses are deterministic and a test can
 * assert the EXACT elapsed time / poll count. A single `callLog` records the
 * order of announce/pin/forward so step ordering is load-bearing (a delivery
 * that skipped a step or reordered them could not pass).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduleDelivery,
  buildFireAnnouncement,
  prependScheduledRunMarker,
  unboundDeliveryError,
  type ScheduleDeliveryDeps,
} from '../scheduler/delivery';
import { busyPollIntervalMs, waitIdleTimeoutMs, type EnsureSessionResult } from '../postToSession';
import {
  checkIsReminderSchedule,
  getUnboundPausableSchedules,
} from '../scheduler/deliveryKind';
import { describeSchedule } from '../scheduler/recurrence';
import type { CheckRunResult } from '../scheduler/checkRun';
import { checkStatusCommandTimeoutSec } from '../scheduler/checkStatus';
import { getReminderScheduleText } from '../utils/reminderScheduleText';
import { runWithLocale } from '../i18n';
import type { FireContext, ScheduleRecord } from '../scheduler/types';

const threadKey = '-1001234567890:11';

function makeJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'remind-abc123',
    threadKey,
    name: 'Daily reminder',
    spec: { kind: 'cron', cronExpr: '0 9 * * *' },
    prompt: 'Check the deploy status',
    createdBy: 'agent',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    nextRunAt: Date.parse('2026-06-07T09:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A bot-LOCAL reminder: same record shape, `deliveryKind: 'reminder'`. Its
 * `prompt` is the text POSTED into the topic, never forwarded anywhere.
 */
function makeReminder(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return makeJob({
    id: 'take-the-pills-abc123',
    name: 'Take the pills',
    prompt: 'Take the evening pills',
    createdBy: 'user',
    deliveryKind: 'reminder',
    ...overrides,
  });
}

const onTime: FireContext = { kind: 'on-time' };

interface CallLogEntry {
  step:
    | 'announce'
    | 'pin'
    | 'ensureSession'
    | 'forward'
    | 'runCheck'
    | 'setCheckFailing'
    | 'recordAlertPin'
    | 'readWorkerActivity'
    | 'postStatus'
    | 'recordStatusLine'
    | 'deleteMessage';
  detail?: unknown;
}

/**
 * Build delivery deps with a shared call log + a fake clock. `busyFlips` is the
 * sequence of `checkBusy` return values consumed left-to-right (the last value
 * sticks once exhausted); `sleep` advances `now` so the wait loop is deterministic.
 */
function createHarness(options: {
  busyValues?: boolean[];
  ensureResult?: EnsureSessionResult;
  announceId?: number | null;
  pinThrows?: boolean;
  forwardThrows?: boolean;
  checkResult?: CheckRunResult | null;
  /** How long the announce takes on the fake clock (the paced send under load). */
  announceDelayMs?: number;
  /** The fake clock's start (default: a fixed instant that predates every fixture job). */
  startMs?: number;
  /** Whether the topic shows status lines (default yes: a Telegram topic with a stream view). */
  isStatusShown?: boolean;
  /** What the worker did last, per the run-directory source (default: nothing readable). */
  workerActivity?: string | null;
  /** The status post fails (a null id), or throws. */
  statusPost?: 'fails' | 'throws';
  /** `recordStatusLine` says the job is gone. */
  isJobGoneWhenRecording?: boolean;
  /** Deleting a message, or reading the worker's log, throws. */
  failing?: Array<'deleteMessage' | 'readWorkerActivity' | 'recordStatusLine'>;
  /** The result of a `runCheck` for one particular command (the status command), in place of `checkResult`. */
  commandResults?: Record<string, CheckRunResult>;
  statusIntervalOverrideMs?: number;
} = {}) {
  const callLog: CallLogEntry[] = [];
  const forwardedTexts: string[] = [];
  let nowMs = options.startMs ?? 1_000_000;
  let nextStatusMessageId = 501;
  const busyValues = options.busyValues ?? [false];
  let busyIndex = 0;

  const deps: ScheduleDeliveryDeps = {
    announce: async (key, text) => {
      callLog.push({ step: 'announce', detail: { key, text } });
      nowMs += options.announceDelayMs ?? 0;
      return options.announceId === undefined ? 42 : options.announceId;
    },
    pin: async (key, messageId, isSilent) => {
      callLog.push({ step: 'pin', detail: { key, messageId, isSilent } });
      if (options.pinThrows) throw new Error('not enough rights to pin');
    },
    checkBusy: () => {
      const value = busyValues[Math.min(busyIndex, busyValues.length - 1)];
      busyIndex += 1;
      return value;
    },
    ensureSession: async (key, fallbackAdapterName) => {
      callLog.push({ step: 'ensureSession', detail: { key, fallbackAdapterName } });
      return options.ensureResult ?? { ok: true, isFresh: false };
    },
    forwardPrompt: async (key, text) => {
      callLog.push({ step: 'forward', detail: { key, text } });
      forwardedTexts.push(text);
      if (options.forwardThrows) throw new Error('forward boom');
    },
    runCheck: async (key, command, timeoutMs) => {
      callLog.push({ step: 'runCheck', detail: { key, command, timeoutMs } });
      const commandResult = options.commandResults?.[command];
      if (commandResult !== undefined) return commandResult;
      return options.checkResult === undefined
        ? { exitCode: 0, signal: null, isTimedOut: false, output: '' }
        : options.checkResult;
    },
    setCheckFailing: async (jobId, isFailing) => {
      callLog.push({ step: 'setCheckFailing', detail: { jobId, isFailing } });
    },
    recordAlertPin: async (jobId, messageId) => {
      callLog.push({ step: 'recordAlertPin', detail: { jobId, messageId } });
    },
    checkIsStatusShown: () => options.isStatusShown ?? true,
    postStatus: async (key, text) => {
      callLog.push({ step: 'postStatus', detail: { key, text } });
      if (options.statusPost === 'throws') throw new Error('send boom');
      if (options.statusPost === 'fails') return null;
      const messageId = nextStatusMessageId;
      nextStatusMessageId += 1;
      return messageId;
    },
    deleteMessage: async (key, messageId) => {
      callLog.push({ step: 'deleteMessage', detail: { key, messageId } });
      if (options.failing?.includes('deleteMessage')) throw new Error('delete boom');
    },
    readWorkerActivity: async (key, runDir) => {
      callLog.push({ step: 'readWorkerActivity', detail: { key, runDir } });
      if (options.failing?.includes('readWorkerActivity')) throw new Error('read boom');
      return options.workerActivity ?? null;
    },
    recordStatusLine: async (jobId, line) => {
      callLog.push({ step: 'recordStatusLine', detail: { jobId, line } });
      if (options.failing?.includes('recordStatusLine')) throw new Error('record boom');
      return options.isJobGoneWhenRecording !== true;
    },
    statusIntervalOverrideMs: options.statusIntervalOverrideMs,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };

  return { deps, callLog, forwardedTexts, getNow: () => nowMs };
}

test('happy path: announce → pin → ensureSession → forward, in order; delivered', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((entry) => entry.step),
    ['announce', 'pin', 'ensureSession', 'forward'],
  );
});

test('pin: silent flag honored — default notifies (isSilent=false)', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob(), onTime);
  const pin = callLog.find((e) => e.step === 'pin');
  assert.equal((pin?.detail as { isSilent: boolean }).isSilent, false);
});

test('pin: silent flag honored — job.isPinSilent makes the pin silent', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ isPinSilent: true }), onTime);
  const pin = callLog.find((e) => e.step === 'pin');
  assert.equal((pin?.detail as { isSilent: boolean }).isSilent, true);
});

test('announce send failed (null id) → pin skipped, delivery still proceeds to forward', async () => {
  const { deps, callLog } = createHarness({ announceId: null });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((e) => e.step),
    ['announce', 'ensureSession', 'forward'],
    'a failed announce skips pin but never blocks delivery',
  );
});

test('pin failure → console.warn, delivery continues; outcome still delivered', async () => {
  const { deps, callLog } = createHarness({ pinThrows: true });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  // forward still ran after the failed pin
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forward must run despite pin failure');
});

test('busy session: polls until checkBusy flips false, then forwards', async () => {
  // active+busy on first probe (after ensureSession), busy for 2 more polls,
  // then idle. The post-ensureSession busy gate consumes one read; the loop
  // consumes the rest.
  const { deps, callLog } = createHarness({ busyValues: [true, true, false] });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forwards once idle');
});

test('busy past timeout: forwards anyway after exactly waitIdleTimeoutMs of polling', async () => {
  // checkBusy is ALWAYS true → the loop runs until the deadline, then forwards.
  const { deps, callLog, getNow } = createHarness({ busyValues: [true] });
  const startNow = getNow();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forwards anyway after the timeout');
  // The loop sleeps in busyPollIntervalMs hops and stops once now() >= deadline.
  // deadline = start + waitIdleTimeoutMs; it sleeps ceil(timeout/interval) times.
  const elapsed = getNow() - startNow;
  const expectedPolls = Math.ceil(waitIdleTimeoutMs / busyPollIntervalMs);
  assert.equal(elapsed, expectedPolls * busyPollIntervalMs, 'polled exactly up to the timeout');
  assert.ok(elapsed >= waitIdleTimeoutMs, 'waited at least the full timeout before giving up');
});

test('no session: ensureSession called with the job lastAdapterName', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: true, isFresh: false } });
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ lastAdapterName: 'opencode' }), onTime);

  const ensure = callLog.find((e) => e.step === 'ensureSession');
  assert.equal((ensure?.detail as { fallbackAdapterName?: string }).fallbackAdapterName, 'opencode');
});

test('ensureSession unbound → outcome failed with the distinct unbound error; no forward', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'unbound' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'failed', error: unboundDeliveryError });
  assert.ok(!callLog.some((e) => e.step === 'forward'), 'an unbound topic never forwards');
});

test('ensureSession start-failed → outcome failed with a readable reason; no forward', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'start-failed' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.equal(outcome.status, 'failed');
  assert.notEqual(outcome.error, unboundDeliveryError, 'start-failure is distinct from unbound');
  assert.ok(!callLog.some((e) => e.step === 'forward'));
});

test('ensureSession no-adapter → outcome failed with a distinct "no agent selected" reason; no forward', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'no-adapter' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'no agent selected for this topic');
  assert.notEqual(outcome.error, unboundDeliveryError, 'no-adapter is distinct from unbound');
  assert.ok(!callLog.some((e) => e.step === 'forward'), 'a topic with no agent never forwards');
});

test('forward throws → outcome failed carrying the thrown message', async () => {
  const { deps } = createHarness({ forwardThrows: true });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'forward boom');
});

test('catch-up fireContext: announcement carries the missed note with HH:MM', async () => {
  const missedAtMs = Date.parse('2026-06-07T09:00:00.000Z');
  const at = new Date(missedAtMs);
  const expectedTime = `${at.getHours().toString().padStart(2, '0')}:${at.getMinutes().toString().padStart(2, '0')}`;

  const text = buildFireAnnouncement(makeJob(), { kind: 'catch-up', missedAtMs });
  assert.ok(text.includes(expectedTime), `expected missed-at time ${expectedTime} in "${text}"`);
  assert.ok(text.includes('Daily reminder'), 'announcement names the job');
  assert.ok(text.includes('Check the deploy status'), 'announcement carries the prompt');
});

test('on-time fireContext: announcement has NO missed note', async () => {
  const text = buildFireAnnouncement(makeJob(), onTime);
  // The ru/en missedNote both contain "missed"/"пропущено"; neither should appear.
  assert.ok(!/missed|пропущено/i.test(text), `on-time run must not annotate a miss: "${text}"`);
});

test('forwarded prompt is prefixed with the scheduled-run marker carrying the job name', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ name: 'Nightly build', prompt: 'run the build' }), onTime);

  const forward = callLog.find((e) => e.step === 'forward');
  const text = (forward?.detail as { text: string }).text;
  assert.equal(text, prependScheduledRunMarker('Nightly build', 'run the build'));
  assert.ok(text.startsWith('[Scheduled run "Nightly build"]'), 'marker leads the prompt');
  assert.ok(text.includes('run the build'), 'original prompt is preserved after the marker');
});

/** `YYYY-MM-DD HH:MM` in the process timezone, computed here independently of the code under test. */
function formatExpectedLocalDateTime(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

test('a run held over a usage-limit wait says when it was due — the fire time, or a catch-up\'s missed time (R27)', async () => {
  const held: { text: string; heldText?: string }[] = [];
  // The announce and pin go through the paced send queue: the due time is the fire's, not theirs.
  const { deps, callLog, getNow } = createHarness({ announceDelayMs: 5 * 60 * 1000 });
  deps.holdForLimitResume = (_key, text, heldText) => {
    held.push({ text, heldText });
    return true;
  };
  const deliver = createScheduleDelivery(deps);
  const firedAtMs = getNow();
  assert.deepEqual(await deliver(makeJob({ name: 'Nightly build', prompt: 'run the build' }), onTime), { status: 'delivered' });
  const missedAtMs = Date.parse('2026-06-07T09:00:00.000Z');
  await deliver(makeJob({ name: 'Nightly build', prompt: 'run the build' }), { kind: 'catch-up', missedAtMs });

  const run = '[Scheduled run "Nightly build"]\nrun the build';
  assert.deepEqual(held, [
    { text: run, heldText: `[Scheduled run "Nightly build" · was due at ${formatExpectedLocalDateTime(firedAtMs)}]\nrun the build` },
    { text: run, heldText: `[Scheduled run "Nightly build" · was due at ${formatExpectedLocalDateTime(missedAtMs)}]\nrun the build` },
  ], 'held as the same run — the note is what it says once it arrives late');
  assert.ok(!callLog.some((entry) => entry.step === 'forward'), 'held, not forwarded');
});

test('a run forwarded at once carries no due note (R27)', async () => {
  const { deps, forwardedTexts } = createHarness();
  deps.holdForLimitResume = () => false;
  await createScheduleDelivery(deps)(makeJob({ name: 'Nightly build', prompt: 'run the build' }), onTime);
  assert.deepEqual(forwardedTexts, ['[Scheduled run "Nightly build"]\nrun the build']);
});

// ─── reminders (bot-local delivery kind) ─────────────────────────────
//
// A reminder's whole delivery is announce + pin: no session is started, none is
// touched. The load-bearing assertions below are the ZERO call counts on
// `ensureSession` / `forwardPrompt` — an outcome of `delivered` alone would also
// pass if the agent path still ran and happened to succeed.

test('reminder: announces + pins and NEVER touches the agent; delivered', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeReminder(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((entry) => entry.step),
    ['announce', 'pin'],
    'a reminder stops after the pin',
  );
  assert.equal(callLog.filter((entry) => entry.step === 'ensureSession').length, 0);
  assert.equal(callLog.filter((entry) => entry.step === 'forward').length, 0);
});

test('reminder: delivers even when ensureSession WOULD fail (unbound topic / General)', async () => {
  // A reminder needs no folder and no agent, so the dep that fails every
  // agent-prompt fire must not be reachable at all.
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'unbound' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeReminder(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.equal(
    callLog.filter((entry) => entry.step === 'ensureSession').length,
    0,
    'the failing dep is never invoked',
  );
  assert.equal(callLog.filter((entry) => entry.step === 'forward').length, 0);
});

test('reminder: announcement leads with the reminder text and names the schedule', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  const reminder = makeReminder();
  await deliver(reminder, onTime);

  const announcement = (callLog[0].detail as { text: string }).text;
  assert.ok(announcement.startsWith('🔔'), `reminder announcement must be belled: "${announcement}"`);
  assert.ok(announcement.includes('Take the evening pills'), 'the reminder text is the content');
  assert.ok(
    !announcement.includes('Schedule "'),
    `a reminder must not be framed as an agent prompt: "${announcement}"`,
  );
});

test('reminder: the announced schedule is the LOCALIZED text, not English describeSchedule', async () => {
  // The whole point of routing the reminder branch through
  // `getReminderScheduleText`: the fire announcement must read EXACTLY as the
  // `/reminders` list row and card do. Asserting against the shared renderer (not
  // a literal) is what makes the two impossible to drift apart; the negative
  // assertion pins that `describeSchedule`'s English-only wording is NOT used
  // here, which is the defect this replaced.
  const reminder = makeReminder();
  const announcement = buildFireAnnouncement(reminder, onTime);
  const localized = getReminderScheduleText(reminder.spec);

  assert.equal(localized, 'every day at 09:00', 'the en wording of this fixture spec');
  assert.ok(announcement.includes(localized), `expected "${localized}" in "${announcement}"`);
  assert.notEqual(describeSchedule(reminder.spec), localized, 'the two renderers differ, as designed');
  assert.ok(
    !announcement.includes(describeSchedule(reminder.spec)),
    `the English-only describeSchedule text must not reach a reminder: "${announcement}"`,
  );
});

test('reminder: a non-English locale announces the schedule through the same renderer', async () => {
  // Proves the announcement resolves through `t` rather than a hardcoded string:
  // once the translation scope lands, this locale's wording changes with it and
  // the announcement follows automatically.
  const reminder = makeReminder();
  runWithLocale('ru', () => {
    const announcement = buildFireAnnouncement(reminder, onTime);
    assert.ok(
      announcement.includes(getReminderScheduleText(reminder.spec)),
      `the ru announcement must carry the ru schedule text: "${announcement}"`,
    );
  });
});

test('agent-prompt fire KEEPS English describeSchedule (only the reminder branch changed)', async () => {
  const job = makeJob();
  const announcement = buildFireAnnouncement(job, onTime);
  assert.ok(
    announcement.includes(describeSchedule(job.spec)),
    `a prompt job still names its schedule the old way: "${announcement}"`,
  );
});

test('reminder: announce send failed (null id) → pin skipped, still delivered', async () => {
  const { deps, callLog } = createHarness({ announceId: null });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeReminder(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((entry) => entry.step),
    ['announce'],
    'nothing to pin, and nothing else to do',
  );
});

test('reminder: pin failure degrades to a warning; outcome still delivered', async () => {
  const { deps, callLog } = createHarness({ pinThrows: true });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeReminder(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(callLog.some((entry) => entry.step === 'pin'), 'the pin was attempted');
});

test('reminder: catch-up fire carries the missed-at note', async () => {
  const missedAtMs = Date.parse('2026-06-07T09:00:00.000Z');
  const at = new Date(missedAtMs);
  const expectedTime = `${at.getHours().toString().padStart(2, '0')}:${at.getMinutes().toString().padStart(2, '0')}`;

  const text = buildFireAnnouncement(makeReminder(), { kind: 'catch-up', missedAtMs });
  assert.ok(text.includes(expectedTime), `expected missed-at time ${expectedTime} in "${text}"`);
  assert.ok(text.includes('Take the evening pills'), 'the reminder text is still the content');
});

test('reminder: on-time fire has NO missed note', async () => {
  const text = buildFireAnnouncement(makeReminder(), onTime);
  assert.ok(!/missed|пропущено/i.test(text), `on-time reminder must not annotate a miss: "${text}"`);
});

test('regression: a record with NO deliveryKind still ensures a session and forwards', async () => {
  // Absent means the original agent-prompt behaviour — the whole reason the
  // discriminator is optional (no state migration for persisted jobs).
  const job = makeJob();
  assert.equal(job.deliveryKind, undefined, 'the fixture carries no delivery kind');

  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(job, onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.equal(callLog.filter((entry) => entry.step === 'ensureSession').length, 1);
  assert.equal(callLog.filter((entry) => entry.step === 'forward').length, 1);
  const forwarded = (callLog.find((entry) => entry.step === 'forward')?.detail as { text: string }).text;
  assert.ok(forwarded.startsWith('[Scheduled run "Daily reminder"]'), 'prompt path keeps its marker');
});

// ─── delivery-kind helpers (the unbound-pause policy) ────────────────

test('checkIsReminderSchedule: true only for the reminder kind', () => {
  assert.equal(checkIsReminderSchedule({ deliveryKind: 'reminder' }), true);
  assert.equal(checkIsReminderSchedule({}), false, 'absent means the agent-prompt kind');
});

test('getUnboundPausableSchedules: a mixed thread pauses only the agent prompts', () => {
  const promptJob = makeJob({ id: 'nightly-build-1' });
  const reminder = makeReminder({ id: 'pills-2' });
  const otherPrompt = makeJob({ id: 'standup-3' });

  const pausable = getUnboundPausableSchedules([promptJob, reminder, otherPrompt]);
  assert.deepEqual(
    pausable.map((record) => record.id),
    ['nightly-build-1', 'standup-3'],
    'the reminder stays armed while the prompt jobs park',
  );
});

test('getUnboundPausableSchedules: a reminder-only thread pauses nothing (no notice)', () => {
  const pausable = getUnboundPausableSchedules([makeReminder({ id: 'a' }), makeReminder({ id: 'b' })]);
  assert.deepEqual(pausable, [], 'count 0 ⇒ the caller posts no paused-notice');
});

test('getUnboundPausableSchedules: an empty thread yields an empty list', () => {
  assert.deepEqual(getUnboundPausableSchedules([]), []);
});

// ─── check (watchdog) kind ───────────────────────────────────────────

function makeCheck(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return makeJob({
    id: 'api-health-abc123',
    name: 'API health',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'Find out why the API is down and restart it.',
    deliveryKind: 'check',
    checkCommand: 'curl -fsS http://127.0.0.1:8080/health',
    ...overrides,
  });
}

const failedRun: CheckRunResult = { exitCode: 7, signal: null, isTimedOut: false, output: 'curl: (7) Failed to connect\n' };

test('check: a passing run after a pass posts nothing and wakes nobody', async () => {
  const { deps, callLog } = createHarness();
  const outcome = await createScheduleDelivery(deps)(makeCheck(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(callLog.map((entry) => entry.step), ['runCheck']);
  assert.deepEqual(callLog[0].detail, {
    key: threadKey,
    command: 'curl -fsS http://127.0.0.1:8080/health',
    timeoutMs: 60_000,
  });
});

test('check: the first failure stores the flag, pins the alert, then wakes the agent', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun });
  const outcome = await createScheduleDelivery(deps)(makeCheck({ checkTimeoutSec: 20 }), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((entry) => entry.step),
    ['runCheck', 'setCheckFailing', 'announce', 'pin', 'recordAlertPin', 'ensureSession', 'forward'],
  );
  assert.equal((callLog[0].detail as { timeoutMs: number }).timeoutMs, 20_000);
  assert.deepEqual(callLog[4].detail, { jobId: 'api-health-abc123', messageId: 42 }, 'the pinned alert is remembered on its job');
  assert.deepEqual(callLog[1].detail, { jobId: 'api-health-abc123', isFailing: true });

  const alert = (callLog[2].detail as { text: string }).text;
  assert.match(alert, /API health/);
  assert.match(alert, /exit 7/);
  assert.match(alert, /\$ curl -fsS/);
  assert.match(alert, /Failed to connect/);
  assert.equal((callLog[3].detail as { isSilent: boolean }).isSilent, false, 'the alert pin notifies');

  const prompt = (callLog[6].detail as { text: string }).text;
  assert.ok(prompt.startsWith('[Scheduled check "API health" failed]'));
  assert.match(prompt, /Result: exit 7/);
  assert.match(prompt, /Failed to connect/);
  assert.ok(prompt.endsWith('Find out why the API is down and restart it.'), 'the job prompt comes last');
});

test('check: an alert whose pin failed is not remembered as pinned', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun, pinThrows: true });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await createScheduleDelivery(deps)(makeCheck(), onTime);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(!callLog.some((entry) => entry.step === 'recordAlertPin'));
});

test('check: a failure while already failing stays silent', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun });
  const outcome = await createScheduleDelivery(deps)(makeCheck({ isCheckFailing: true }), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(callLog.map((entry) => entry.step), ['runCheck']);
});

test('check: a pass after a failure clears the flag and posts one unpinned line', async () => {
  const { deps, callLog } = createHarness();
  const outcome = await runWithLocale('en', () =>
    createScheduleDelivery(deps)(makeCheck({ isCheckFailing: true }), onTime),
  );

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(callLog.map((entry) => entry.step), ['runCheck', 'setCheckFailing', 'announce']);
  assert.deepEqual(callLog[1].detail, { jobId: 'api-health-abc123', isFailing: false });
  assert.equal((callLog[2].detail as { text: string }).text, '✅ Check "API health" passes again.');
});

test('check: a timeout is a failure and names its limit', async () => {
  const { deps, callLog } = createHarness({
    checkResult: { exitCode: null, signal: 'SIGTERM', isTimedOut: true, output: '' },
  });
  await createScheduleDelivery(deps)(makeCheck(), onTime);

  const prompt = (callLog.find((entry) => entry.step === 'forward')?.detail as { text: string }).text;
  assert.match(prompt, /Result: timeout 60s/);
  assert.match(prompt, /\(no output\)/);
});

test('check: an unbound topic runs nothing and fails with the unbound error (the bot pauses it)', async () => {
  const { deps, callLog } = createHarness({ checkResult: null });
  const outcome = await createScheduleDelivery(deps)(makeCheck(), onTime);

  assert.deepEqual(outcome, { status: 'failed', error: unboundDeliveryError });
  assert.deepEqual(callLog.map((entry) => entry.step), ['runCheck']);
});

test('getUnboundPausableSchedules: a check pauses with the prompt jobs', () => {
  const pausable = getUnboundPausableSchedules([makeCheck({ id: 'c' }), makeReminder({ id: 'r' })]);
  assert.deepEqual(pausable.map((record) => record.id), ['c']);
});

// ─── the status line of a passing check ──────────────────────────────

const minuteMs = 60_000;
const jobCreatedAtMs = Date.parse('2026-06-06T00:00:00.000Z');
const workerRunDir = '/runs/builder-s2';

/** A worker watch: a check named like the recipe's, with a run-directory status source, created at `jobCreatedAtMs`. */
function makeWorkerWatch(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return makeCheck({
    id: 'watch-builder-s2-abc123',
    name: 'watch builder S2',
    checkCommand: 'kill -0 4242',
    statusWorkerRunDir: workerRunDir,
    ...overrides,
  });
}

function getStepNames(callLog: CallLogEntry[]): string[] {
  return callLog.map((entry) => entry.step);
}

function getStatusText(callLog: CallLogEntry[]): string {
  return (callLog.find((entry) => entry.step === 'postStatus')?.detail as { text: string }).text;
}

test('status: a passing run 15 minutes after the check was created posts the line, silently and without waking the agent', async () => {
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 15 * minuteMs, workerActivity: 'Bash: Run the unit tests' });
  const outcome = await runWithLocale('en', () => createScheduleDelivery(deps)(makeWorkerWatch(), onTime));

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getStepNames(callLog), ['runCheck', 'readWorkerActivity', 'postStatus', 'recordStatusLine']);
  assert.deepEqual(callLog[1].detail, { key: threadKey, runDir: workerRunDir });
  assert.equal(getStatusText(callLog), '⏳ builder S2 · works 15 min · now: Bash: Run the unit tests');
  assert.deepEqual(callLog[3].detail, { jobId: 'watch-builder-s2-abc123', line: { messageId: 501, postedAtMs: jobCreatedAtMs + 15 * minuteMs } });
  assert.ok(
    !callLog.some((entry) => entry.step === 'ensureSession' || entry.step === 'forward' || entry.step === 'announce' || entry.step === 'pin'),
    'the line is the bot’s own: no session is ensured, no prompt forwarded, nothing announced or pinned',
  );
});

test('status: a new line is recorded FIRST and the previous one deleted after, so a crash never loses the id of the live line', async () => {
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 30 * minuteMs, workerActivity: 'Edit: src/a.ts' });
  await runWithLocale('en', () =>
    createScheduleDelivery(deps)(makeWorkerWatch({ statusMessageId: 88, lastStatusAt: jobCreatedAtMs + 15 * minuteMs }), onTime),
  );

  assert.deepEqual(getStepNames(callLog), ['runCheck', 'readWorkerActivity', 'postStatus', 'recordStatusLine', 'deleteMessage']);
  assert.deepEqual(callLog[4].detail, { key: threadKey, messageId: 88 }, 'the OLD line goes, never the new one');
  assert.equal(getStatusText(callLog), '⏳ builder S2 · works 30 min · now: Edit: src/a.ts', 'elapsed counts from the check’s creation');
});

test('status: nothing readable from the worker still posts the line, without its «now»', async () => {
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 45 * minuteMs, workerActivity: null });
  await runWithLocale('en', () => createScheduleDelivery(deps)(makeWorkerWatch(), onTime));
  assert.equal(getStatusText(callLog), '⏳ builder S2 · works 45 min');
});

test('status: a line that is not due yet posts nothing — before the first, and between two', async () => {
  const beforeFirst = createHarness({ startMs: jobCreatedAtMs + 10 * minuteMs });
  await createScheduleDelivery(beforeFirst.deps)(makeWorkerWatch(), onTime);
  assert.deepEqual(getStepNames(beforeFirst.callLog), ['runCheck']);

  const betweenTwo = createHarness({ startMs: jobCreatedAtMs + 40 * minuteMs });
  await createScheduleDelivery(betweenTwo.deps)(makeWorkerWatch({ statusMessageId: 88, lastStatusAt: jobCreatedAtMs + 30 * minuteMs }), onTime);
  assert.deepEqual(getStepNames(betweenTwo.callLog), ['runCheck']);
});

test('status: the job’s own statusEveryMinutes sets the interval, and the test seam overrides it', async () => {
  const half = createHarness({ startMs: jobCreatedAtMs + 20 * minuteMs });
  await createScheduleDelivery(half.deps)(makeWorkerWatch({ statusEveryMinutes: 30 }), onTime);
  assert.deepEqual(getStepNames(half.callLog), ['runCheck'], '20 minutes is not due for a 30-minute interval');

  const overridden = createHarness({ startMs: jobCreatedAtMs + 20 * minuteMs, statusIntervalOverrideMs: 5 * minuteMs });
  await createScheduleDelivery(overridden.deps)(makeWorkerWatch({ statusEveryMinutes: 30 }), onTime);
  assert.ok(getStepNames(overridden.callLog).includes('postStatus'), 'the seam’s 5 minutes wins over the job’s 30');
});

test('status: a check WITHOUT a status source behaves exactly as before — silent while it passes, however long it runs', async () => {
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 600 * minuteMs });
  const outcome = await createScheduleDelivery(deps)(makeCheck(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getStepNames(callLog), ['runCheck']);
});

test('status: a statusCommand source runs in the bound folder with its own short timeout; its first output line is «now»', async () => {
  const { deps, callLog } = createHarness({
    startMs: jobCreatedAtMs + 15 * minuteMs,
    commandResults: { 'cat progress.txt': { exitCode: 0, signal: null, isTimedOut: false, output: '\n  step 4 of 9: linking  \nstep detail\n' } },
  });
  await runWithLocale('en', () =>
    createScheduleDelivery(deps)(makeCheck({ name: 'Nightly build', statusCommand: 'cat progress.txt' }), onTime),
  );

  assert.deepEqual(getStepNames(callLog), ['runCheck', 'runCheck', 'postStatus', 'recordStatusLine']);
  assert.deepEqual(callLog[1].detail, { key: threadKey, command: 'cat progress.txt', timeoutMs: checkStatusCommandTimeoutSec * 1000 });
  assert.equal(getStatusText(callLog), '⏳ Nightly build · works 15 min · now: step 4 of 9: linking');
});

test('status: a statusCommand that fails or times out leaves the «now» out; the line is still posted', async () => {
  for (const failedRun of [
    { exitCode: 3, signal: null, isTimedOut: false, output: 'no such file' },
    { exitCode: null, signal: 'SIGTERM' as const, isTimedOut: true, output: 'partial' },
  ]) {
    const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 15 * minuteMs, commandResults: { 'cat progress.txt': failedRun } });
    await runWithLocale('en', () => createScheduleDelivery(deps)(makeCheck({ name: 'Nightly build', statusCommand: 'cat progress.txt' }), onTime));
    assert.equal(getStatusText(callLog), '⏳ Nightly build · works 15 min');
  }
});

test('status: the first FAILURE deletes the line before the alert, and the alert still goes out when the delete throws', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun, startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(deps)(makeWorkerWatch({ statusMessageId: 88, lastStatusAt: jobCreatedAtMs + 45 * minuteMs }), onTime);

  assert.deepEqual(
    getStepNames(callLog),
    ['runCheck', 'recordStatusLine', 'deleteMessage', 'setCheckFailing', 'announce', 'pin', 'recordAlertPin', 'ensureSession', 'forward'],
    'the line goes first; no new line is posted under the alert; the agent is woken as before',
  );
  assert.deepEqual(callLog[1].detail, { jobId: 'watch-builder-s2-abc123', line: null });
  assert.deepEqual(callLog[2].detail, { key: threadKey, messageId: 88 });

  const hostile = createHarness({ checkResult: failedRun, failing: ['recordStatusLine', 'deleteMessage'] });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const outcome = await createScheduleDelivery(hostile.deps)(makeWorkerWatch({ statusMessageId: 88 }), onTime);
    assert.deepEqual(outcome, { status: 'delivered' });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(getStepNames(hostile.callLog).includes('announce') && getStepNames(hostile.callLog).includes('forward'), 'a status line cannot stop the alert');
});

test('status: a failed run with no line in the topic touches no status dep at all', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun });
  await createScheduleDelivery(deps)(makeWorkerWatch(), onTime);
  assert.ok(!callLog.some((entry) => entry.step === 'recordStatusLine' || entry.step === 'deleteMessage' || entry.step === 'postStatus'));
});

test('status: a failure while already failing stays silent and leaves no new line', async () => {
  const { deps, callLog } = createHarness({ checkResult: failedRun, startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(deps)(makeWorkerWatch({ isCheckFailing: true }), onTime);
  assert.deepEqual(getStepNames(callLog), ['runCheck']);
});

test('status: a pass after a failure announces the recovery, then the line when it is due', async () => {
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 60 * minuteMs, workerActivity: 'Bash: Build' });
  await runWithLocale('en', () => createScheduleDelivery(deps)(makeWorkerWatch({ isCheckFailing: true }), onTime));

  assert.deepEqual(getStepNames(callLog), ['runCheck', 'setCheckFailing', 'announce', 'readWorkerActivity', 'postStatus', 'recordStatusLine']);
});

test('status: a topic that does not show the stream (answers-only, a tracker) deletes the line and posts none', async () => {
  const withLine = createHarness({ isStatusShown: false, startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(withLine.deps)(makeWorkerWatch({ statusMessageId: 88 }), onTime);
  assert.deepEqual(getStepNames(withLine.callLog), ['runCheck', 'recordStatusLine', 'deleteMessage']);
  assert.deepEqual(withLine.callLog[1].detail, { jobId: 'watch-builder-s2-abc123', line: null });

  const withoutLine = createHarness({ isStatusShown: false, startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(withoutLine.deps)(makeWorkerWatch(), onTime);
  assert.deepEqual(getStepNames(withoutLine.callLog), ['runCheck'], 'nothing to delete, nothing to read, nothing to post');
});

test('status: back on a stream view the lines resume at the next due run', async () => {
  // The line was deleted while the topic was answers-only (the record kept only `lastStatusAt`), so the next due run posts.
  const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 60 * minuteMs, workerActivity: 'Bash: Test' });
  await runWithLocale('en', () => createScheduleDelivery(deps)(makeWorkerWatch({ lastStatusAt: jobCreatedAtMs + 30 * minuteMs }), onTime));
  assert.deepEqual(getStepNames(callLog), ['runCheck', 'readWorkerActivity', 'postStatus', 'recordStatusLine']);
});

test('status: the job’s final run posts no line and removes the existing one', async () => {
  const onceWatch = createHarness({ startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(onceWatch.deps)(
    makeWorkerWatch({ spec: { kind: 'once', onceAtIso: '2026-06-06T01:00:00.000Z' }, statusMessageId: 88 }),
    onTime,
  );
  assert.deepEqual(getStepNames(onceWatch.callLog), ['runCheck', 'recordStatusLine', 'deleteMessage']);

  const lastOfN = createHarness({ startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(lastOfN.deps)(
    makeWorkerWatch({ spec: { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 1 }, statusMessageId: 88 }),
    onTime,
  );
  assert.deepEqual(getStepNames(lastOfN.callLog), ['runCheck', 'recordStatusLine', 'deleteMessage']);

  const notLastOfN = createHarness({ startMs: jobCreatedAtMs + 60 * minuteMs });
  await createScheduleDelivery(notLastOfN.deps)(
    makeWorkerWatch({ spec: { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 } }),
    onTime,
  );
  assert.ok(getStepNames(notLastOfN.callLog).includes('postStatus'), 'an N-times check with runs left still posts');
});

test('status: a failed post keeps the previous line and records nothing — the next run tries again', async () => {
  const { deps, callLog } = createHarness({ statusPost: 'fails', startMs: jobCreatedAtMs + 30 * minuteMs });
  const outcome = await createScheduleDelivery(deps)(makeWorkerWatch({ statusMessageId: 88, lastStatusAt: jobCreatedAtMs + 15 * minuteMs }), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(getStepNames(callLog), ['runCheck', 'readWorkerActivity', 'postStatus']);
});

test('status: a job cancelled while its line was being posted: the new line is deleted, the old one is left to the cancel', async () => {
  const { deps, callLog } = createHarness({ isJobGoneWhenRecording: true, startMs: jobCreatedAtMs + 30 * minuteMs });
  await createScheduleDelivery(deps)(makeWorkerWatch({ statusMessageId: 88, lastStatusAt: jobCreatedAtMs + 15 * minuteMs }), onTime);

  assert.deepEqual(getStepNames(callLog), ['runCheck', 'readWorkerActivity', 'postStatus', 'recordStatusLine', 'deleteMessage']);
  assert.deepEqual(callLog[4].detail, { key: threadKey, messageId: 501 }, 'the line just posted has no record to point at it');
});

test('status: a throwing send, log read or record never turns a passing check into a failed run', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const scenarios: Array<{ label: string; options: Parameters<typeof createHarness>[0] }> = [
      { label: 'send throws', options: { statusPost: 'throws' } },
      { label: 'log read throws', options: { failing: ['readWorkerActivity'] } },
      { label: 'record throws', options: { failing: ['recordStatusLine'] } },
    ];
    for (const { label, options } of scenarios) {
      const { deps, callLog } = createHarness({ startMs: jobCreatedAtMs + 15 * minuteMs, ...options });
      const outcome = await createScheduleDelivery(deps)(makeWorkerWatch(), onTime);
      assert.deepEqual(outcome, { status: 'delivered' }, label);
      assert.ok(!callLog.some((entry) => entry.step === 'forward'), `${label}: the agent is not woken`);
    }
  } finally {
    console.warn = originalWarn;
  }
});
