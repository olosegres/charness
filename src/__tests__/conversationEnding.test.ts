import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationEndings } from '../utils/conversationEnding';
import { KeyedTransitionQueue } from '../utils/keyedTransitionQueue';

/** Endings over a real transition queue keyed by the conversation's own string, and a way to hold the queue busy. */
function createEndings(): { endings: ConversationEndings<string>; queue: KeyedTransitionQueue; holdQueue: (key: string) => () => void } {
  const queue = new KeyedTransitionQueue();
  const endings = new ConversationEndings<string>({ toConversationKey: (key) => key, runTransition: (key, transition) => queue.run(key, transition) });
  const holdQueue = (key: string): (() => void) => {
    let finish = (): void => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    void queue.run(key, () => gate);
    return () => finish();
  };
  return { endings, queue, holdQueue };
}

describe('ConversationEndings: a command holds its conversation as ending from the moment it knows (review 24 #1)', () => {
  it('a hold marks the conversation at once, before its transition is even queued — the command may still await a toast or a send', () => {
    const { endings } = createEndings();
    assert.equal(endings.checkIsEnding('chat:1'), false);
    const ending = endings.hold('chat:1');
    assert.equal(endings.checkIsEnding('chat:1'), true, 'held from the tap');
    assert.equal(endings.checkIsEnding('chat:2'), false, 'another conversation is not held');
    ending.release();
    assert.equal(endings.checkIsEnding('chat:1'), false);
  });

  it('a transition queued ahead sees the mark while the command waits behind it; the hold ends as the command\'s own transition begins', async () => {
    const { endings, queue, holdQueue } = createEndings();
    const finishAhead = holdQueue('chat:1');
    let seenAhead: boolean | null = null;
    const ahead = queue.run('chat:1', async () => { seenAhead = endings.checkIsEnding('chat:1'); });
    let seenInOwn: boolean | null = null;
    const ending = endings.hold('chat:1');
    const own = ending.run(async () => {
      seenInOwn = endings.checkIsEnding('chat:1');
      return 'released';
    });
    finishAhead();
    await ahead;
    assert.equal(seenAhead, true, 'the stop queued ahead drops what it held');
    assert.equal(await own, 'released', 'the command gets its transition\'s result');
    assert.equal(seenInOwn, false, 'what the command starts itself is the next conversation, never dropped');
    assert.equal(endings.checkIsEnding('chat:1'), false);
  });

  it('a count: two overlapping commands keep the mark until both let go', async () => {
    const { endings, holdQueue } = createEndings();
    const finishAhead = holdQueue('chat:1');
    const first = endings.hold('chat:1');
    const second = endings.hold('chat:1');
    first.release();
    assert.equal(endings.checkIsEnding('chat:1'), true, 'the second still holds it');
    let seenInSecond: boolean | null = null;
    const secondRun = second.run(async () => { seenInSecond = endings.checkIsEnding('chat:1'); });
    finishAhead();
    await secondRun;
    assert.equal(seenInSecond, false);
  });

  it('a release is idempotent: a command that stops short and also lets go in its `finally` takes nothing from another command\'s hold', async () => {
    const { endings } = createEndings();
    const shortOne = endings.hold('chat:1');
    const other = endings.hold('chat:1');
    shortOne.release();
    shortOne.release();
    assert.equal(endings.checkIsEnding('chat:1'), true, 'the other command\'s hold stands');
    await other.run(async () => undefined);
    other.release();
    assert.equal(endings.checkIsEnding('chat:1'), false);
  });

  it('a transition that throws, or a queue that rejects before it begins, still ends the hold', async () => {
    const { endings } = createEndings();
    await assert.rejects(endings.hold('chat:1').run(async () => { throw new Error('the stop failed'); }), /the stop failed/);
    assert.equal(endings.checkIsEnding('chat:1'), false);
    const refusing = new ConversationEndings<string>({ toConversationKey: (key) => key, runTransition: () => Promise.reject(new Error('the re-spawn wait threw')) });
    await assert.rejects(refusing.hold('chat:1').run(async () => 'never'), /the re-spawn wait threw/);
    assert.equal(refusing.checkIsEnding('chat:1'), false, 'never left held');
  });
});
