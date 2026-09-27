/**
 * Test case: N/A — TelegramCode has no Jira tracker
 *
 * @description Unit tests for {@link ../utils/reminderFlow} — the three
 * `/reminders` rules that depend on the bot's surroundings rather than on the
 * wizard's step machine.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): each of these fails
 * SILENTLY in production, which is why they are pinned here rather than left to a
 * live check.
 * - At the per-thread schedule cap the hub must NOT offer «add» — the create
 *   would be rejected by the store, so the button could only ever fail — and the
 *   body must say why, or the operator sees a button vanish with no explanation.
 *   The cap is over the thread's WHOLE schedule list, so a topic full of
 *   `/schedule` jobs must withhold «add» too.
 * - The step-4 text wait must be DISARMED by every transition that leaves the text
 *   step, or «‹ Back» out of step 4 leaves it capturing the next ordinary message.
 * - The step-4 text wait MUST expire. It intercepts every plain message in the
 *   topic, so an abandoned wizard would swallow, hours later, a prompt meant for
 *   the agent. The boundary is asserted exactly (at the window it is already
 *   expired), because an off-by-one here is invisible until it eats a message.
 * - The wait is single-use: it is CLAIMED by the message that consumes it, so two
 *   messages arriving together (telegraf handles updates concurrently) cannot each
 *   create a reminder from the one wizard. The loser must fall through to normal
 *   handling — and must NOT be told the wait expired, which would retire the wizard
 *   under the winner's feet.
 * - An over-long reminder text is REJECTED, never truncated or accepted. Accepted, it
 *   breaks three screens at once: the "created" edit fails so the operator thinks
 *   nothing happened, the card (the only place with a delete button) cannot open, and
 *   at fire time the announcement fails while the run is recorded as delivered.
 * - A tap from a DEAD screen routes `foreign` (strip that keyboard, change
 *   nothing) while a tap for the LIVE wizard routes `apply`. Conflating the two
 *   either feeds an abandoned wizard's picks into the live one, or strips the live
 *   wizard's keyboard and leaves it unfinishable.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  checkIsReminderTextWaitKept,
  getReminderHubPlan,
  getReminderTextAcceptance,
  getReminderTextCaptureRoute,
  getReminderWizardTapRoute,
  reminderTextWaitMs,
  type ReminderTextCaptureRoute,
} from '../utils/reminderFlow';
import {
  applyReminderWizardCallback,
  buildReminderBackCallback,
  buildReminderQuickTimeCallback,
  buildReminderRepeatCallback,
  createReminderWizardId,
  createReminderWizardState,
  reminderTextMaxLength,
  type ReminderWizardTransition,
} from '../utils/reminderWizard';
import { maxSchedulesPerThread } from '../scheduler/store';

// ─── hub plan ────────────────────────────────────────────────────────

test('an empty topic says so and still offers add', () => {
  assert.deepEqual(getReminderHubPlan({ reminderCount: 0, scheduleCount: 0, maxSchedules: 30 }), {
    body: 'empty',
    isAddOffered: true,
  });
});

test('a populated topic under the cap shows the count and offers add', () => {
  assert.deepEqual(getReminderHubPlan({ reminderCount: 3, scheduleCount: 3, maxSchedules: 30 }), {
    body: 'active',
    isAddOffered: true,
  });
});

test('AT the cap: add is withdrawn and the body explains why', () => {
  // The button is dropped and the `atLimit` body is what tells the operator to
  // delete one — a silently missing button is a dead end.
  assert.deepEqual(getReminderHubPlan({ reminderCount: 30, scheduleCount: 30, maxSchedules: 30 }), {
    body: 'atLimit',
    isAddOffered: false,
  });
});

test('PAST the cap (a pre-existing overfull thread) is still at the limit', () => {
  assert.deepEqual(getReminderHubPlan({ reminderCount: 31, scheduleCount: 31, maxSchedules: 30 }), {
    body: 'atLimit',
    isAddOffered: false,
  });
});

test('one below the cap still offers add — the boundary is not off by one', () => {
  const plan = getReminderHubPlan({ reminderCount: 29, scheduleCount: 29, maxSchedules: 30 });
  assert.equal(plan.isAddOffered, true);
  assert.equal(plan.body, 'active');
});

test('the cap counts AGENT-PROMPT jobs too — the store enforces one shared limit', () => {
  // The dead end this guards: a topic whose 30 slots are `/schedule` jobs used to
  // draw «add», walk the operator through all four steps, and only then have the
  // store reject the create. `createScheduleForThread` compares the thread's WHOLE
  // list, so the hub must too.
  const plan = getReminderHubPlan({ reminderCount: 0, scheduleCount: 30, maxSchedules: 30 });
  assert.equal(plan.isAddOffered, false, 'no «add» when the thread is full of prompt jobs');
  assert.equal(plan.body, 'atLimit', 'and the body says why the button is gone');
});

test('a mixed topic is capped on the TOTAL, not on its reminders alone', () => {
  const full = getReminderHubPlan({ reminderCount: 2, scheduleCount: 30, maxSchedules: 30 });
  assert.equal(full.isAddOffered, false);
  const roomLeft = getReminderHubPlan({ reminderCount: 2, scheduleCount: 29, maxSchedules: 30 });
  assert.equal(roomLeft.isAddOffered, true, 'one free slot still offers add');
  assert.equal(roomLeft.body, 'active', 'the body still counts the REMINDERS, not the schedules');
});

test('the plan is exercised against the REAL scheduler cap, not a test constant', () => {
  // The cap the store enforces is the one the hub must agree with; a drift between
  // them is exactly how a button that can only fail gets drawn.
  assert.equal(
    getReminderHubPlan({
      reminderCount: maxSchedulesPerThread,
      scheduleCount: maxSchedulesPerThread,
      maxSchedules: maxSchedulesPerThread,
    }).isAddOffered,
    false,
  );
  assert.equal(
    getReminderHubPlan({
      reminderCount: maxSchedulesPerThread - 1,
      scheduleCount: maxSchedulesPerThread - 1,
      maxSchedules: maxSchedulesPerThread,
    }).isAddOffered,
    true,
  );
});

test('a zero cap is at the limit rather than a special case', () => {
  assert.deepEqual(getReminderHubPlan({ reminderCount: 0, scheduleCount: 0, maxSchedules: 0 }), {
    body: 'atLimit',
    isAddOffered: false,
  });
});

// ─── step-4 text wait: armed by, and only by, the text step ──────────

/**
 * Whether the step-4 wait survives each transition. Keyed by the union, so a
 * transition kind added later fails to COMPILE here until it is classified on
 * purpose — the wait must never be left armed off the text step by default.
 */
const textWaitByTransitionKind: Record<ReminderWizardTransition['kind'], boolean> = {
  render: false,
  awaitText: true,
  createNow: true,
  cancelled: false,
  backToHub: false,
  error: false,
  expired: false,
};

const transitionKinds: ReminderWizardTransition['kind'][] = [
  'render',
  'awaitText',
  'createNow',
  'cancelled',
  'backToHub',
  'error',
  'expired',
];

test('only the two transitions that END on the text step keep the wait armed', () => {
  assert.equal(
    transitionKinds.length,
    Object.keys(textWaitByTransitionKind).length,
    'every transition kind must be listed here',
  );
  for (const kind of transitionKinds) {
    assert.equal(
      checkIsReminderTextWaitKept(kind),
      textWaitByTransitionKind[kind],
      `transition "${kind}" classified wrongly`,
    );
  }
});

test('«‹ Back» out of step 4 yields a transition that DISARMS the text wait', () => {
  // The defect this pins: back from step 4 re-asks the TIME, so a wait left armed
  // would capture the operator's next ordinary message and create the reminder from
  // the very picks they went back to change — and that message never reaches the
  // agent it was meant for.
  const wizardId = createReminderWizardId(1_700_000_000_000);
  const nowMs = Date.parse('2026-06-07T10:00:00.000Z');

  const afterRepeat = applyReminderWizardCallback({
    state: createReminderWizardState(wizardId),
    callbackData: buildReminderRepeatCallback(wizardId, 'daily'),
    nowMs,
  });
  assert.equal(afterRepeat.kind, 'render');
  if (afterRepeat.kind !== 'render') return;

  const afterTime = applyReminderWizardCallback({
    state: afterRepeat.state,
    callbackData: buildReminderQuickTimeCallback(wizardId, 0),
    nowMs,
  });
  assert.equal(afterTime.kind, 'awaitText', 'a complete pick set arms step 4');
  assert.equal(checkIsReminderTextWaitKept(afterTime.kind), true);
  if (afterTime.kind !== 'awaitText') return;
  assert.equal(afterTime.state.step, 'text');

  const afterBack = applyReminderWizardCallback({
    state: afterTime.state,
    callbackData: buildReminderBackCallback(wizardId),
    nowMs,
  });
  assert.equal(afterBack.kind, 'render');
  assert.equal(checkIsReminderTextWaitKept(afterBack.kind), false, 'back off step 4 disarms it');
  if (afterBack.kind !== 'render') return;
  assert.equal(afterBack.state.step, 'time', 'the screen asks for a time again');
});

// ─── step-4 text capture window ──────────────────────────────────────

/** An unclaimed wait, the state every inbound message meets first. */
function getUnclaimedRoute(armedAtMs: number | null, nowMs: number): ReminderTextCaptureRoute {
  return getReminderTextCaptureRoute({ armedAtMs, isClaimed: false, nowMs });
}

test('no wizard waiting → the message is handled normally', () => {
  assert.equal(getUnclaimedRoute(null, 1_000), 'notArmed');
});

test('inside the window the message IS the reminder text', () => {
  const armedAtMs = 1_000_000;
  assert.equal(getUnclaimedRoute(armedAtMs, armedAtMs), 'capture');
  assert.equal(getUnclaimedRoute(armedAtMs, armedAtMs + 60_000), 'capture');
  assert.equal(
    getUnclaimedRoute(armedAtMs, armedAtMs + reminderTextWaitMs - 1),
    'capture',
    'the last millisecond inside the window still captures',
  );
});

test('AT the window the wait has already expired — the message must get through', () => {
  // Asserted exactly at the boundary: an off-by-one here means an abandoned wizard
  // eats one more message that should have reached the agent.
  const armedAtMs = 1_000_000;
  assert.equal(getUnclaimedRoute(armedAtMs, armedAtMs + reminderTextWaitMs), 'expired');
  assert.equal(getUnclaimedRoute(armedAtMs, armedAtMs + reminderTextWaitMs * 4), 'expired');
});

test('the wait window is 15 minutes', () => {
  assert.equal(reminderTextWaitMs, 15 * 60 * 1000);
});

// ─── step-4 text wait: claimed by exactly one message ────────────────

test('a CLAIMED wait routes the second concurrent message to normal handling', () => {
  // The defect this pins: telegraf handles updates concurrently and only the voice
  // path is serialized per thread, so two messages arriving together both passed the
  // route and each created a reminder from the one wizard.
  const armedAtMs = 1_000_000;
  assert.equal(
    getReminderTextCaptureRoute({ armedAtMs, isClaimed: false, nowMs: armedAtMs + 1_000 }),
    'capture',
    'the first message wins the wait',
  );
  assert.equal(
    getReminderTextCaptureRoute({ armedAtMs, isClaimed: true, nowMs: armedAtMs + 1_000 }),
    'claimed',
    'the second must not capture as well',
  );
});

test('a claim beats the expiry check — the winner is not retired mid-create', () => {
  // A claim means the winner is already turning that wizard's message into the
  // created card. Reporting `expired` underneath it would retire the wizard and
  // relabel the very message being finished.
  const armedAtMs = 1_000_000;
  assert.equal(
    getReminderTextCaptureRoute({
      armedAtMs,
      isClaimed: true,
      nowMs: armedAtMs + reminderTextWaitMs * 2,
    }),
    'claimed',
  );
});

test('a claim cannot conjure a wait that was never armed', () => {
  assert.equal(
    getReminderTextCaptureRoute({ armedAtMs: null, isClaimed: true, nowMs: 1_000 }),
    'notArmed',
  );
});

// ─── step-4 text length bound ────────────────────────────────────────

test('a text within the bound is accepted, including exactly at it', () => {
  assert.equal(getReminderTextAcceptance('Take the pills'), 'accept');
  assert.equal(getReminderTextAcceptance(''), 'accept', 'emptiness is not this rule\'s business');
  assert.equal(
    getReminderTextAcceptance('x'.repeat(reminderTextMaxLength)),
    'accept',
    'the bound itself is allowed — the boundary must not be off by one',
  );
});

test('a text over the bound is REJECTED, never accepted or shortened', () => {
  // A voice transcript has no length bound of its own, so this is the realistic
  // source: accepted, it produces a message near Telegram's 4096-char cap, and then
  // the created-screen edit, the card and the fire announcement all fail.
  assert.equal(getReminderTextAcceptance('x'.repeat(reminderTextMaxLength + 1)), 'tooLong');
  assert.equal(getReminderTextAcceptance('x'.repeat(reminderTextMaxLength * 5)), 'tooLong');
});

test('the bound leaves real headroom under the Telegram message cap', () => {
  // The text is interpolated into the card and the fire announcement alongside the
  // schedule and next-run lines, so a bound just under 4096 would still break them.
  const telegramMessageCap = 4096;
  assert.ok(
    reminderTextMaxLength < telegramMessageCap / 2,
    `reminderTextMaxLength ${reminderTextMaxLength} leaves too little room for the template`,
  );
});

// ─── wizard tap routing ──────────────────────────────────────────────

test('a tap for the live wizard is applied', () => {
  const wizardId = createReminderWizardId(1_700_000_000_000);
  assert.equal(
    getReminderWizardTapRoute({
      liveWizardId: wizardId,
      callbackData: buildReminderRepeatCallback(wizardId, 'daily'),
    }),
    'apply',
  );
});

test('a tap carrying ANOTHER wizard id is foreign — it must not feed the live wizard', () => {
  const liveWizardId = createReminderWizardId(1_700_000_000_000);
  const abandonedWizardId = createReminderWizardId(1_600_000_000_000);
  assert.notEqual(liveWizardId, abandonedWizardId, 'the ids must differ for this test to mean anything');
  assert.equal(
    getReminderWizardTapRoute({
      liveWizardId,
      callbackData: buildReminderRepeatCallback(abandonedWizardId, 'monthly'),
    }),
    'foreign',
  );
});

test('a tap with NO wizard live at all is foreign', () => {
  const wizardId = createReminderWizardId(1_700_000_000_000);
  assert.equal(
    getReminderWizardTapRoute({
      liveWizardId: null,
      callbackData: buildReminderBackCallback(wizardId),
    }),
    'foreign',
  );
});

test('a malformed / forged callback is foreign, never applied', () => {
  const wizardId = createReminderWizardId(1_700_000_000_000);
  for (const callbackData of [
    '',
    'rw_',
    `rw_${wizardId}`,
    `rw_${wizardId}_zz`,
    `rw_${wizardId}_r_99`,
    'rmadd',
    `rw_${wizardId}_r`,
  ]) {
    assert.equal(
      getReminderWizardTapRoute({ liveWizardId: wizardId, callbackData }),
      'foreign',
      `expected "${callbackData}" to be refused`,
    );
  }
});

test('nav buttons of the live wizard are applied (back / cancel are valid on every step)', () => {
  const wizardId = createReminderWizardId(1_700_000_000_000);
  assert.equal(
    getReminderWizardTapRoute({ liveWizardId: wizardId, callbackData: buildReminderBackCallback(wizardId) }),
    'apply',
  );
});
