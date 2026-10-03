/**
 * @description Prompts held during an armed usage-limit wait (Jira plan R23):
 * the queue's bound and dedup, what the resume forwards, and that a held prompt
 * is NEVER dropped — it rides the prompt the operator sends to end the wait, or
 * survives a session end (and a restart) to reach the next session. Plus the
 * bot's wiring, shared by the scheduler and Jira.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import {
  getHeldPromptsText,
  getHeldPromptsWith,
  getLimitResumeMessage,
  getTextWithHeldPrompts,
  limitHeldPromptsMax,
} from '../utils/limitHeldPrompts';
import { LimitHeldPromptQueue } from '../utils/limitHeldPromptQueue';

const topicKey = makeTelegramKey(-1001234567890, 42);
const otherTopicKey = makeTelegramKey(-1001234567890, 43);
const scheduledRun = '[Scheduled run "digest"]\nCollect the news.';
const otherScheduledRun = '[Scheduled run "backup"]\nCheck the backups.';

describe('getHeldPromptsWith', () => {
  it('appends in order and drops the oldest past the bound', () => {
    assert.deepEqual(getHeldPromptsWith(['a'], 'b'), { held: ['a', 'b'], droppedCount: 0 });
    const full = Array.from({ length: limitHeldPromptsMax }, (_, index) => `p${index}`);
    assert.deepEqual(getHeldPromptsWith(full, 'newest'), { held: [...full.slice(1), 'newest'], droppedCount: 1 });
  });

  it('a recurring job firing all through a long wait is held once, like one catch-up', () => {
    assert.deepEqual(getHeldPromptsWith([scheduledRun, 'b'], scheduledRun), { held: [scheduledRun, 'b'], droppedCount: 0 });
  });
});

describe('getTextWithHeldPrompts / getHeldPromptsText', () => {
  it('the forwarded text first, then the held prompts in arrival order — a held copy of the text itself is not repeated', () => {
    assert.equal(getTextWithHeldPrompts('mine', ['a', 'b']), 'mine\n\na\n\nb');
    assert.equal(getTextWithHeldPrompts(scheduledRun, [scheduledRun, 'b']), `${scheduledRun}\n\nb`);
  });

  it('on their own: one message, or nothing', () => {
    assert.equal(getHeldPromptsText(['a', 'b']), 'a\n\nb');
    assert.equal(getHeldPromptsText([]), null);
  });
});

describe('getLimitResumeMessage', () => {
  it('the "continue" nudge resumes the interrupted turn — held prompts ride it, they never replace it', () => {
    assert.deepEqual(getLimitResumeMessage({ continueNudge: 'continue', untakenRequestPrompt: undefined }), { text: 'continue', isRequestPrompt: false });
  });

  it('a request whose prompt never reached the agent gets that prompt instead (R21)', () => {
    assert.deepEqual(getLimitResumeMessage({ continueNudge: 'continue', untakenRequestPrompt: 'req' }), { text: 'req', isRequestPrompt: true });
  });
});

describe('LimitHeldPromptQueue — a held prompt is never dropped', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let dataDir: string;
  let createdStores: StateStore[];
  let isLimitWaitArmed: boolean;

  async function createStore(): Promise<StateStore> {
    const store = new StateStore(dataDir, { saveDebounceMs: 5 });
    await store.init();
    createdStores.push(store);
    return store;
  }

  function createQueue(store: StateStore): LimitHeldPromptQueue {
    return new LimitHeldPromptQueue({ store, checkIsLimitWaitArmed: () => isLimitWaitArmed });
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-held-'));
    process.env.HOME = fakeHome;
    dataDir = path.join(fakeHome, 'data');
    createdStores = [];
    isLimitWaitArmed = true;
  });

  afterEach(async () => {
    await Promise.all(createdStores.map((store) => store.flush()));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('no wait armed: nothing is held, the post goes on', async () => {
    isLimitWaitArmed = false;
    const store = await createStore();
    assert.equal(createQueue(store).holdPrompt(topicKey, scheduledRun), false);
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), []);
  });

  it('while the wait is armed nothing is released', async () => {
    const store = await createStore();
    const queue = createQueue(store);
    assert.equal(queue.holdPrompt(topicKey, scheduledRun), true);
    assert.equal(queue.releaseWithForward(topicKey, 'continue'), 'continue');
    assert.equal(queue.releaseAll(topicKey), null);
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), [scheduledRun]);
  });

  it('the operator\'s message ends the wait: the held prompts go right after it, in arrival order, once', async () => {
    const store = await createStore();
    const queue = createQueue(store);
    queue.holdPrompt(topicKey, scheduledRun);
    queue.holdPrompt(topicKey, otherScheduledRun);

    isLimitWaitArmed = false; // the operator wrote: the wait is cancelled
    assert.equal(queue.releaseWithForward(topicKey, 'my question'), `my question\n\n${scheduledRun}\n\n${otherScheduledRun}`);
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), []);
    assert.equal(queue.releaseWithForward(topicKey, 'next'), 'next', 'delivered once');
  });

  it('the session ends with the wait: the held prompts outlive it, and a restart, and go to the next session', async () => {
    const store = await createStore();
    createQueue(store).holdPrompt(topicKey, scheduledRun);
    isLimitWaitArmed = false; // the session ended: the wait is cancelled, nothing is forwarded

    await store.flush();
    const restartedStore = await createStore();
    const restartedQueue = createQueue(restartedStore);
    assert.deepEqual(restartedStore.getLimitHeldPrompts(topicKey), [scheduledRun]);

    // The next session starts with nothing typed during its boot: they go on their own.
    assert.equal(restartedQueue.releaseAll(topicKey), scheduledRun);
    assert.equal(restartedQueue.releaseAll(topicKey), null);
    await restartedStore.flush();
    assert.deepEqual((await createStore()).getLimitHeldPrompts(topicKey), [], 'the release is saved too');
  });

  it('each conversation keeps its own', async () => {
    const store = await createStore();
    const queue = createQueue(store);
    queue.holdPrompt(topicKey, scheduledRun);
    isLimitWaitArmed = false;
    assert.equal(queue.releaseAll(otherTopicKey), null);
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), [scheduledRun]);
  });
});

describe('the bot holds and releases them (R23)', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const getFunction = (header: string): string => {
    const start = botSource.indexOf(header);
    assert.ok(start >= 0, header);
    return botSource.slice(start, botSource.indexOf('\n}\n', start));
  };

  it('only an ARMED usage-limit wait holds; the open request\'s own prompt stays with its request', () => {
    const hold = getFunction('function holdPromptForLimitResume(');
    assert.match(hold, /if \(getArmedApiRetry\(key\)\?\.kind !== 'usageLimit'\) return false;/);
    assert.match(hold, /if \(requestLimitWaitAnswerDeps\?\.ledger\.getOpenRequest\(key\)\?\.prompt === text\) \{/);
    assert.match(hold, /return limitHeldPrompts\.holdPrompt\(key, text\);/);
    assert.match(botSource, /checkIsLimitWaitArmed: \(key\) => getArmedApiRetry\(key\)\?\.kind === 'usageLimit',/);
  });

  it('the scheduler and the Jira connector post through the same hold', () => {
    assert.match(getFunction('function createSessionPostDeps('), /holdForLimitResume: \(conversationKey, text\) => holdPromptForLimitResume\(keyFromString\(conversationKey\), text\),/);
    assert.match(getFunction('function wireScheduler('), /\.\.\.createSessionPostDeps\(\),/);
  });

  it('ending the wait never drops them: cancelling it leaves them alone', () => {
    assert.doesNotMatch(getFunction('function cancelApiRetry('), /limitHeldPrompts\./);
  });

  it('they ride the next prompt forwarded to a live session — the operator\'s message, the resume\'s nudge — and a recovery replays them', () => {
    const forward = getFunction('async function forwardPromptToAgent(');
    assert.match(forward, /const textWithHeld = isReplayable && adapter\.checkIsActive\(key\) \? limitHeldPrompts\.releaseWithForward\(key, text\) : text;/);
    const fold = forward.indexOf('limitHeldPrompts.releaseWithForward');
    const cache = forward.indexOf('lastForwardedPrompt.set(keyToString(key), body);');
    assert.ok(fold > 0 && cache > fold, 'folded before the wedge-recovery cache');
  });

  it('a new session gets them after anything typed during its boot, or on their own', () => {
    const replay = getFunction('async function replayBufferedPrompts(');
    const loop = replay.indexOf('for (const prompt of prompts)');
    const release = replay.indexOf('limitHeldPrompts.releaseAll(key)');
    assert.ok(loop > 0 && release > loop);
    assert.match(getFunction('async function startAgentSession('), /void replayBufferedPrompts\(key\);/);
  });

  it('the resume forwards the nudge, or the untaken request prompt of a limit wait (R21)', () => {
    const fire = getFunction('async function fireApiRetryWithLocale(');
    assert.match(fire, /untakenRequestPrompt: entry\.kind === 'usageLimit'\n\s*\? getPromptNotTakenIn\(requestLimitWaitAnswerDeps\?\.ledger\.getOpenRequest\(key\)\)\n\s*: undefined,/);
    assert.match(fire, /await forwardPromptToAgent\(key, getThreadAdapter\(key\), resume\.text\);/);
    assert.match(fire, /isRequestPrompt: resume\.isRequestPrompt,/);
  });
});
