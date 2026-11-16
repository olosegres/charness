/**
 * @description `surfacePinnedNotice` / `releasePinnedNoticeSlot` (`connectors/telegram/pinnedNoticeSlot.ts`): the one-per-episode
 * pinned notices of a topic — the logged-out notice and the limit-resumed notice. The topic is muted, so the pin is the
 * notification: one notice per episode, never two, and a post whose outcome is unknown (the Bot API did not answer within the
 * send queue's deadline) may already be in the topic, so it must not be posted again.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedNoticePendingSentinel, releasePinnedNoticeSlot, surfacePinnedNotice, type PinnedNoticeSlots } from '../connectors/telegram/pinnedNoticeSlot';
import type { ThreadSendOutcome } from '../connectors/telegram/sendOutcome';

const topic = '-1001111111111:42';

/** Ports whose posts end as `outcomes`, one per post, recording every post and pin. */
function createRecordingPorts(outcomes: ThreadSendOutcome[]) {
  const events: string[] = [];
  let postIndex = 0;
  return {
    events,
    ports: {
      send: async (): Promise<ThreadSendOutcome> => {
        const outcome = outcomes[postIndex++];
        events.push(`post → ${outcome.kind}`);
        return outcome;
      },
      pin: async (messageId: number): Promise<void> => {
        events.push(`pin ${messageId}`);
      },
    },
  };
}

describe('surfacePinnedNotice', () => {
  it('posts and pins the notice once per episode: the next event of the episode posts nothing', async () => {
    const slots: PinnedNoticeSlots = new Map();
    const { events, ports } = createRecordingPorts([{ kind: 'sent', messageId: 501 }]);

    await surfacePinnedNotice(slots, topic, ports);
    await surfacePinnedNotice(slots, topic, ports);

    assert.deepEqual(events, ['post → sent', 'pin 501']);
    assert.equal(slots.get(topic), 501);
  });

  it('a burst of events posts one notice: the slot is taken before the post is answered', async () => {
    const slots: PinnedNoticeSlots = new Map();
    const { events, ports } = createRecordingPorts([{ kind: 'sent', messageId: 501 }]);

    await Promise.all([surfacePinnedNotice(slots, topic, ports), surfacePinnedNotice(slots, topic, ports)]);

    assert.deepEqual(events, ['post → sent', 'pin 501']);
  });

  it('a post that failed frees the slot: the next event of the episode posts the notice again', async () => {
    const slots: PinnedNoticeSlots = new Map();
    const { events, ports } = createRecordingPorts([{ kind: 'failed', isRetryable: true }, { kind: 'sent', messageId: 502 }]);

    await surfacePinnedNotice(slots, topic, ports);
    assert.equal(slots.has(topic), false, 'the slot is free after the failure');
    await surfacePinnedNotice(slots, topic, ports);

    assert.deepEqual(events, ['post → failed', 'post → sent', 'pin 502']);
  });

  it('a post whose outcome is unknown keeps the slot: the notice may be in the topic, and no second one is posted under it', async () => {
    const slots: PinnedNoticeSlots = new Map();
    const { events, ports } = createRecordingPorts([{ kind: 'unknown' }, { kind: 'sent', messageId: 503 }]);

    await surfacePinnedNotice(slots, topic, ports);
    await surfacePinnedNotice(slots, topic, ports);

    assert.deepEqual(events, ['post → unknown'], 'one post, nothing pinned: its id is not known');
    assert.equal(slots.get(topic), pinnedNoticePendingSentinel);
  });

  it('a slot freed while the post was under way (a teardown) is not taken back, and the notice is not pinned', async () => {
    const slots: PinnedNoticeSlots = new Map();
    const events: string[] = [];
    await surfacePinnedNotice(slots, topic, {
      send: async () => {
        releasePinnedNoticeSlot(slots, topic);
        events.push('post → sent');
        return { kind: 'sent', messageId: 504 };
      },
      pin: async (messageId) => { events.push(`pin ${messageId}`); },
    });

    assert.deepEqual(events, ['post → sent']);
    assert.equal(slots.has(topic), false);
  });
});

describe('releasePinnedNoticeSlot', () => {
  it('frees the slot and gives back the pinned notice to unpin; a slot whose pin never landed gives none', async () => {
    const slots: PinnedNoticeSlots = new Map([[topic, 501], ['-1001111111111:43', pinnedNoticePendingSentinel]]);

    assert.equal(releasePinnedNoticeSlot(slots, topic), 501);
    assert.equal(releasePinnedNoticeSlot(slots, '-1001111111111:43'), null);
    assert.equal(releasePinnedNoticeSlot(slots, '-1001111111111:44'), null, 'no slot, nothing to unpin');
    assert.equal(slots.size, 0);
  });
});
