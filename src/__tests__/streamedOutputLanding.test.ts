/**
 * @description `landStreamedOutputWithinLimit` (`utils/streamedOutputLanding.ts`): what stands between an agent's tool call and
 * the text it streamed before it. The landing may take as long as Telegram does, but not forever — a send that never finishes
 * must not hold the agent's tool call (and with it its turn) for ever: after the limit it is warned about and the caller goes
 * on. A landing that fails is logged, never thrown at the caller. Timers are mock timers; the logs are captured.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { landStreamedOutputWithinLimit, streamedOutputLandingLimitMs } from '../utils/streamedOutputLanding';

/** Let every promise reaction already queued run. */
function settleReactions(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('landStreamedOutputWithinLimit', () => {
  let warnings: ReturnType<typeof mock.method<Console, 'warn'>>;
  let errors: ReturnType<typeof mock.method<Console, 'error'>>;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    warnings = mock.method(console, 'warn', () => {});
    errors = mock.method(console, 'error', () => {});
  });
  afterEach(() => {
    mock.timers.reset();
    warnings.mock.restore();
    errors.mock.restore();
  });

  it('is over as soon as the landing is, and says nothing', async () => {
    let isLanded = false;

    await landStreamedOutputWithinLimit(async () => { isLanded = true; }, 'topic A');

    assert.equal(isLanded, true);
    assert.equal(warnings.mock.callCount(), 0);
    assert.equal(errors.mock.callCount(), 0);
  });

  it('a landing that never ends is given up on after the limit: the caller goes on, with one warning that names the owner', async () => {
    let isOver = false;
    const waiting = landStreamedOutputWithinLimit(() => new Promise<void>(() => {}), 'topic A').then(() => { isOver = true; });

    mock.timers.tick(streamedOutputLandingLimitMs - 1);
    await settleReactions();
    assert.equal(isOver, false, 'still waiting just inside the limit');

    mock.timers.tick(1);
    await waiting;

    assert.equal(isOver, true);
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0].arguments.join(' ')), /topic A/);
  });

  it('a landing that ends in time cancels the limit: no warning when the timer would have run out', async () => {
    let finishLanding: () => void = () => {};
    const waiting = landStreamedOutputWithinLimit(() => new Promise<void>((resolve) => { finishLanding = resolve; }), 'topic A');

    finishLanding();
    await waiting;
    mock.timers.tick(streamedOutputLandingLimitMs * 2);
    await settleReactions();

    assert.equal(warnings.mock.callCount(), 0);
  });

  it('a landing that fails — also by throwing before it returns a promise — is logged and never thrown at the caller', async () => {
    await landStreamedOutputWithinLimit(async () => { throw new Error('the send path is down'); }, 'topic A');
    await landStreamedOutputWithinLimit(() => { throw new Error('the adapter is gone'); }, 'topic B');

    assert.equal(errors.mock.callCount(), 2);
    assert.match(String(errors.mock.calls[0].arguments.join(' ')), /topic A.*the send path is down/);
    assert.match(String(errors.mock.calls[1].arguments.join(' ')), /topic B.*the adapter is gone/);
  });

  it('starts the landing at once: the caller may await it later, and a failure meanwhile is not an unhandled rejection', async () => {
    const events: string[] = [];
    const landing = landStreamedOutputWithinLimit(async () => { events.push('landing started'); throw new Error('failed early'); }, 'topic A');
    events.push('caller continues');
    await settleReactions();
    await landing;

    assert.deepEqual(events, ['landing started', 'caller continues']);
    assert.equal(errors.mock.callCount(), 1);
  });
});
