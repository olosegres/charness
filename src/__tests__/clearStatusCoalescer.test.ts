/**
 * @description `clearStatusCoalescer` (`utils/clearStatusCoalescer.ts`): a stop drops the thread's not-yet-sent status frame and
 * cancels its 429 defer-retry timer, so no «🔧 tool» / «working…» frame queued before the stop appears after it. The agent's
 * text is not its business (a stop gives it a final attempt — `groupOutputBacklog.test.ts`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearStatusCoalescer, type ClearableStatusCoalescer } from '../utils/clearStatusCoalescer';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('clearStatusCoalescer', () => {
  it('drops the pending status frame', () => {
    const coalescer: ClearableStatusCoalescer = { pendingText: 'Thinking… stale frame that must not surface after stop' };

    clearStatusCoalescer(coalescer);

    assert.equal(coalescer.pendingText, null);
  });

  it('cancels the status defer-retry timer so it never fires after stop', async () => {
    let retryFired = false;
    const coalescer: ClearableStatusCoalescer = {
      pendingText: 'Thinking… deferred during a 429 cooldown',
      // A real armed timer mirroring the cooldown-defer retry: if the clear
      // does NOT cancel it, it fires into a stopped session.
      deferRetryTimer: setTimeout(() => {
        retryFired = true;
      }, 10),
    };

    clearStatusCoalescer(coalescer);

    assert.equal(coalescer.pendingText, null, 'status pendingText must be dropped');
    assert.equal(coalescer.deferRetryTimer, null, 'defer-retry timer handle must be nulled');

    await delay(30);
    assert.equal(retryFired, false, 'cancelled defer-retry timer must never fire');
  });

  it('tolerates a thread that never had a status frame (undefined state)', () => {
    // `clearThreadQueues` in bot.ts looks the map up with `.get()`, which returns undefined for such a thread.
    assert.doesNotThrow(() => clearStatusCoalescer(undefined));
  });
});
