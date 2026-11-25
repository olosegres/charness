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

describe('ConversationEndings: a person\'s message is refused while a command ends or replaces the conversation (review 25 #1, #2)', () => {
  it('refused from the hold until the command\'s transition has SETTLED — past the moment its hold ends, through the release\'s own stop', async () => {
    const { endings, holdQueue } = createEndings();
    const finishAhead = holdQueue('chat:1');
    const ending = endings.hold('chat:1');
    assert.equal(endings.checkIsRefusingMessages('chat:1'), true, 'refused from the tap, ahead of the transition');
    assert.equal(endings.checkIsRefusingMessages('chat:2'), false, 'another conversation takes messages');
    let finishOwn = (): void => {};
    let seenInOwn: { isEnding: boolean; isRefusing: boolean } | null = null;
    const own = ending.run(() => {
      seenInOwn = { isEnding: endings.checkIsEnding('chat:1'), isRefusing: endings.checkIsRefusingMessages('chat:1') };
      return new Promise<void>((resolve) => { finishOwn = resolve; });
    });
    finishAhead();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seenInOwn, { isEnding: false, isRefusing: true }, 'the hold ends as the transition begins; the refusal does not: the process it stops takes no message');
    assert.equal(endings.checkIsRefusingMessages('chat:1'), true, 'still refused while the release stops the process');
    finishOwn();
    await own;
    assert.equal(endings.checkIsRefusingMessages('chat:1'), false, 'the next message, after the command, is the next conversation\'s');
  });

  it('a command that stops short lets go of both; a transition that throws or a queue that rejects too', async () => {
    const { endings } = createEndings();
    const shortOne = endings.hold('chat:1');
    shortOne.release();
    assert.equal(endings.checkIsRefusingMessages('chat:1'), false);
    await assert.rejects(endings.hold('chat:1').run(async () => { throw new Error('the stop failed'); }), /the stop failed/);
    assert.equal(endings.checkIsRefusingMessages('chat:1'), false);
    const refusing = new ConversationEndings<string>({ toConversationKey: (key) => key, runTransition: () => Promise.reject(new Error('the re-spawn wait threw')) });
    await assert.rejects(refusing.hold('chat:1').run(async () => 'never'), /the re-spawn wait threw/);
    assert.equal(refusing.checkIsRefusingMessages('chat:1'), false);
  });

  it('a move refuses messages of its own until its first prompt reached the other backend — beyond its hold\'s transition, which is only the old backend\'s stop', async () => {
    const { endings } = createEndings();
    const stopRefusing = endings.refuseMessages('chat:1');
    const ending = endings.hold('chat:1');
    await ending.run(async () => undefined);
    ending.release();
    assert.equal(endings.checkIsEnding('chat:1'), false, 'nothing queued ahead is dropped any more');
    assert.equal(endings.checkIsRefusingMessages('chat:1'), true, 'a message still meets the move');
    stopRefusing();
    stopRefusing();
    assert.equal(endings.checkIsRefusingMessages('chat:1'), false, 'and an idempotent end');
  });
});

describe('ConversationEndings: a bot-made post waits while a command refuses messages, and goes to what follows (review 26 #5)', () => {
  it('resolves at once when nothing refuses messages', async () => {
    const { endings } = createEndings();
    await endings.waitForMessagesAccepted('chat:1');
  });

  it('waits until every refusal of the conversation has ended — a move\'s own and a hold\'s, whichever ends last — and only for its own conversation', async () => {
    const { endings } = createEndings();
    const stopRefusing = endings.refuseMessages('chat:1');
    const ending = endings.hold('chat:1');
    let isDone = false;
    const waiting = endings.waitForMessagesAccepted('chat:1').then(() => { isDone = true; });
    await endings.waitForMessagesAccepted('chat:2');
    await ending.run(async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isDone, false, 'the move still refuses: its first prompt has not reached the other backend');
    stopRefusing();
    await waiting;
    assert.equal(isDone, true);
  });

  it('a refusal taken again in the tick the last one ended keeps it waiting', async () => {
    const { endings } = createEndings();
    const first = endings.refuseMessages('chat:1');
    let isDone = false;
    const waiting = endings.waitForMessagesAccepted('chat:1').then(() => { isDone = true; });
    first();
    const second = endings.refuseMessages('chat:1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isDone, false);
    second();
    await waiting;
  });
});

describe('ConversationEndings: the refusal serial a scheduled run compares with its pick (mini-review of round 29, #2)', () => {
  it('stays the same with no refusal between two reads, and only for its own conversation does a refusal move it', () => {
    const { endings } = createEndings();
    const atPick = endings.readRefusalSerial('chat:1');
    assert.equal(endings.readRefusalSerial('chat:1'), atPick);
    endings.refuseMessages('chat:2')();
    assert.equal(endings.readRefusalSerial('chat:1'), atPick, 'another conversation\'s command');
  });

  it('a command that began AND ended between two reads is seen — a move\'s own refusal and a hold alike — though no wait was still refusing at the second read', async () => {
    const { endings } = createEndings();
    const atPick = endings.readRefusalSerial('chat:1');
    endings.refuseMessages('chat:1')();
    const afterMove = endings.readRefusalSerial('chat:1');
    assert.notEqual(afterMove, atPick, 'a refusal taken and released');
    assert.equal(endings.checkIsRefusingMessages('chat:1'), false, 'nothing refuses any more');
    await endings.hold('chat:1').run(async () => undefined);
    assert.notEqual(endings.readRefusalSerial('chat:1'), afterMove, 'a hold run to its end');
  });
});
