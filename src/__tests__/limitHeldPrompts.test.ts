/**
 * @description Prompts held during an armed usage-limit wait (Jira plan R23):
 * the queue's bound and dedup, what the resume forwards, and that a held prompt
 * is NEVER dropped — it rides the prompt the operator sends to end the wait, or
 * survives a session end (and a restart) to reach the next session. Plus the
 * bot's wiring, shared by the scheduler and Jira.
 */

/** Test case: N/A — Charness has no Jira tracker. */

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
  type LimitHeldPrompt,
} from '../utils/limitHeldPrompts';
import { LimitHeldPromptQueue } from '../utils/limitHeldPromptQueue';

const topicKey = makeTelegramKey(-1001234567890, 42);
const otherTopicKey = makeTelegramKey(-1001234567890, 43);
const scheduledRun = '[Scheduled run "digest"]\nCollect the news.';
const otherScheduledRun = '[Scheduled run "backup"]\nCheck the backups.';
/** The same run, as it reads once it arrives late (R27). */
const scheduledRunDueAt = (clock: string): string => `[Scheduled run "digest" · was due at 2026-10-03 ${clock}]\nCollect the news.`;
const prompts = (...texts: string[]): LimitHeldPrompt[] => texts.map((text) => ({ text }));

describe('getHeldPromptsWith', () => {
  it('appends in order and drops the oldest past the bound', () => {
    assert.deepEqual(getHeldPromptsWith(prompts('a'), { text: 'b' }), { held: prompts('a', 'b'), droppedCount: 0 });
    const full = prompts(...Array.from({ length: limitHeldPromptsMax }, (_, index) => `p${index}`));
    assert.deepEqual(getHeldPromptsWith(full, { text: 'newest' }), { held: [...full.slice(1), { text: 'newest' }], droppedCount: 1 });
  });

  it('a recurring job firing all through a long wait is held once, like one catch-up', () => {
    assert.deepEqual(getHeldPromptsWith(prompts(scheduledRun, 'b'), { text: scheduledRun }), { held: prompts(scheduledRun, 'b'), droppedCount: 0 });
  });

  it('…even though each fire says another due time (R27): the first is kept, nothing else is pushed out', () => {
    const others = prompts(...Array.from({ length: limitHeldPromptsMax - 1 }, (_, index) => `p${index}`));
    let held: LimitHeldPrompt[] = [...others, { text: scheduledRun, heldText: scheduledRunDueAt('09:00') }];
    for (const clock of ['09:15', '09:30', '09:45']) {
      const next = getHeldPromptsWith(held, { text: scheduledRun, heldText: scheduledRunDueAt(clock) });
      assert.equal(next.droppedCount, 0);
      held = next.held;
    }
    assert.deepEqual(held, [...others, { text: scheduledRun, heldText: scheduledRunDueAt('09:00') }]);
  });
});

describe('getTextWithHeldPrompts / getHeldPromptsText', () => {
  it('the forwarded text first, then the held prompts in arrival order — a held copy of the text itself is not repeated', () => {
    assert.equal(getTextWithHeldPrompts('mine', prompts('a', 'b')), 'mine\n\na\n\nb');
    assert.equal(getTextWithHeldPrompts(scheduledRun, prompts(scheduledRun, 'b')), `${scheduledRun}\n\nb`);
  });

  it('a held run says when it was due; the same run forwarded at once is not repeated by its late copy (R27)', () => {
    const held: LimitHeldPrompt[] = [{ text: scheduledRun, heldText: scheduledRunDueAt('09:00') }, { text: 'b' }];
    assert.equal(getTextWithHeldPrompts('mine', held), `mine\n\n${scheduledRunDueAt('09:00')}\n\nb`);
    assert.equal(getTextWithHeldPrompts(scheduledRun, held), `${scheduledRun}\n\nb`);
  });

  it('on their own: one message, or nothing', () => {
    assert.equal(getHeldPromptsText(prompts('a', 'b')), 'a\n\nb');
    assert.equal(getHeldPromptsText([{ text: scheduledRun, heldText: scheduledRunDueAt('09:00') }]), scheduledRunDueAt('09:00'));
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
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), prompts(scheduledRun));
  });

  it('a late copy is stored only where it differs; a recurring run is held once across fires (R27)', async () => {
    const store = await createStore();
    const queue = createQueue(store);
    assert.equal(queue.holdPrompt(topicKey, scheduledRun, scheduledRunDueAt('09:00')), true);
    assert.equal(queue.holdPrompt(topicKey, scheduledRun, scheduledRunDueAt('09:15')), true);
    assert.equal(queue.holdPrompt(topicKey, otherScheduledRun, otherScheduledRun), true);
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), [
      { text: scheduledRun, heldText: scheduledRunDueAt('09:00') },
      { text: otherScheduledRun },
    ]);
    isLimitWaitArmed = false;
    assert.equal(queue.releaseAll(topicKey), `${scheduledRunDueAt('09:00')}\n\n${otherScheduledRun}`);
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
    assert.deepEqual(restartedStore.getLimitHeldPrompts(topicKey), prompts(scheduledRun));

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
    assert.deepEqual(store.getLimitHeldPrompts(topicKey), prompts(scheduledRun));
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
    assert.match(hold, /if \(requestLimitWaitAnswerDeps\?\.ledger\.listOpenRequestsOf\(key\)\.some\(\(request\) => request\.prompt === text\)\) \{/);
    assert.match(hold, /return limitHeldPrompts\.holdPrompt\(key, text, heldText\);/);
    assert.match(botSource, /checkIsLimitWaitArmed: \(key\) => getArmedApiRetry\(key\)\?\.kind === 'usageLimit',/);
  });

  it('the scheduler and the Jira connector post through the same hold', () => {
    assert.match(getFunction('function createSessionPostDeps('), /holdForLimitResume: \(conversationKey, text, heldText\) => holdPromptForLimitResume\(keyFromString\(conversationKey\), text, heldText\),/);
    assert.match(getFunction('function createJiraSessionDeps('), /const sessionPostDeps = createSessionPostDeps\(\);/);
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
    const loop = replay.indexOf('await startupPromptBuffer.replayPrompts(');
    const release = replay.indexOf('limitHeldPrompts.releaseAll(key)');
    assert.ok(loop > 0 && release > loop);
    assert.match(getFunction('async function startAgentSession('), /void replayBufferedPrompts\(key\);/);
  });

  it('a tracker\'s limit texts name the instance\'s timezone; a topic\'s do not (R31)', () => {
    const texts = getFunction('function getLimitWaitTexts(');
    assert.match(texts, /const zoneSuffix = checkIsTelegramKey\(key\) \? '' : ` \$\{getCurrentTimezone\(\)\}`;/);
    assert.match(texts, /const time = `\$\{formatLocalClockWithDateIfNotToday\([^`]+\)\}\$\{zoneSuffix\}`;/);
  });

  it('a held Jira request is watched when its prompt is posted, not when it was held', () => {
    assert.match(getFunction('function createJiraSessionDeps('), /if \(!posted\.isHeld\) await requestWakeUpEngine\?\.trackForwardedTurn\(key, requestId, \{ isRequestPrompt: true \}\);/);
  });
});
