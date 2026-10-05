/**
 * @description One session transition per conversation at a time (lifecycle plan
 * L2 review / L3): two triggers that hit a sleeping topic together produce ONE
 * resume (the second runs after and finds the session live); a trigger during
 * the idle stop waits for it; a transition that throws never blocks the next;
 * different keys do not wait for each other.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedTransitionQueue } from '../utils/keyedTransitionQueue';

/** A sleeping conversation whose resume takes a tick, as the bot's does. */
function createSleepingConversation() {
  let isActive = false;
  const resumes: string[] = [];
  const ensure = async (trigger: string): Promise<void> => {
    if (isActive) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    resumes.push(trigger);
    isActive = true;
  };
  return { ensure, resumes, checkIsActive: () => isActive, suspend: () => { isActive = false; } };
}

describe('KeyedTransitionQueue', () => {
  it('two concurrent triggers on one sleeping conversation produce ONE resume', async () => {
    const queue = new KeyedTransitionQueue();
    const conversation = createSleepingConversation();
    await Promise.all([
      queue.run('topic', () => conversation.ensure('text')),
      queue.run('topic', () => conversation.ensure('file')),
    ]);
    assert.deepEqual(conversation.resumes, ['text'], 'the second trigger found the session live');
    assert.equal(queue.checkIsInFlight('topic'), false, 'released once both settled');
  });

  it('a trigger during the idle stop waits for the stop, then resumes', async () => {
    const queue = new KeyedTransitionQueue();
    const conversation = createSleepingConversation();
    await queue.run('topic', () => conversation.ensure('first'));
    const order: string[] = [];
    const stop = queue.run('topic', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      conversation.suspend();
      order.push('stopped');
    });
    assert.equal(queue.checkIsInFlight('topic'), true);
    const resume = queue.run('topic', async () => {
      await conversation.ensure('message during the stop');
      order.push('resumed');
    });
    await Promise.all([stop, resume]);
    assert.deepEqual(order, ['stopped', 'resumed']);
    assert.deepEqual(conversation.resumes, ['first', 'message during the stop']);
    assert.equal(conversation.checkIsActive(), true, 'the message got a live session after the stop');
  });

  it('a transition that throws is reported to its caller and does not block the next', async () => {
    const queue = new KeyedTransitionQueue();
    const failing = queue.run('topic', async () => { throw new Error('resume refused'); });
    const next = queue.run('topic', async () => 'ran');
    await assert.rejects(failing, /resume refused/);
    assert.equal(await next, 'ran');
  });

  it('different keys run side by side', async () => {
    const queue = new KeyedTransitionQueue();
    const order: string[] = [];
    const slow = queue.run('a', async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); order.push('a'); });
    const fast = queue.run('b', async () => { order.push('b'); });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['b', 'a']);
  });
});
