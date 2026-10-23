/**
 * `getForumTopicCreatedAction`: what a `forum_topic_created` service message leads to.
 *
 * Load-bearing facts proven here:
 *   • the bot's OWN topic (`/topic` created it) is ignored, and the admin check is never asked for it — the
 *     `[security] … (not a group admin)` warning was logged for it before;
 *   • a creator who is not an authorised user, and a message without a creator, only cache the name;
 *   • an authorised creator binds or gets the picker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getForumTopicCreatedAction } from '../connectors/telegram/forumTopicCreated';

const botUserId = 7000000001;
const adminUserId = 424242;
const memberUserId = 515151;

/** An admin check that records whether it was asked: only `adminUserId` passes. */
function createAdminCheck(creatorId: number | undefined): { check: () => Promise<boolean>; getCallCount: () => number } {
  let callCount = 0;
  return {
    check: async () => {
      callCount += 1;
      return creatorId === adminUserId;
    },
    getCallCount: () => callCount,
  };
}

describe('getForumTopicCreatedAction', () => {
  it('the bot\'s own topic is ignored without asking whether the bot is an admin', async () => {
    const adminCheck = createAdminCheck(botUserId);
    assert.equal(await getForumTopicCreatedAction({ creatorId: botUserId, botUserId, checkIsCreatorAllowed: adminCheck.check }), 'ignoreOwn');
    assert.equal(adminCheck.getCallCount(), 0);
  });

  it('a member who is not an authorised user only has the name cached', async () => {
    const adminCheck = createAdminCheck(memberUserId);
    assert.equal(await getForumTopicCreatedAction({ creatorId: memberUserId, botUserId, checkIsCreatorAllowed: adminCheck.check }), 'cacheNameOnly');
    assert.equal(adminCheck.getCallCount(), 1);
  });

  it('a service message without a creator only has the name cached', async () => {
    const adminCheck = createAdminCheck(undefined);
    assert.equal(await getForumTopicCreatedAction({ creatorId: undefined, botUserId, checkIsCreatorAllowed: adminCheck.check }), 'cacheNameOnly');
    assert.equal(adminCheck.getCallCount(), 0);
  });

  it('an authorised creator binds or gets the picker', async () => {
    const adminCheck = createAdminCheck(adminUserId);
    assert.equal(await getForumTopicCreatedAction({ creatorId: adminUserId, botUserId, checkIsCreatorAllowed: adminCheck.check }), 'bindOrPick');
  });

  it('while the bot\'s own id is not known yet, its topic goes through the admin check like anyone\'s', async () => {
    const adminCheck = createAdminCheck(botUserId);
    assert.equal(await getForumTopicCreatedAction({ creatorId: botUserId, botUserId: undefined, checkIsCreatorAllowed: adminCheck.check }), 'cacheNameOnly');
    assert.equal(adminCheck.getCallCount(), 1);
  });
});
