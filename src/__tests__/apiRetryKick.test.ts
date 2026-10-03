/**
 * @description The API-error retry's lifecycle across a bot restart
 * (`apiRetryKick.ts`): a retry is armed and saved, its timer fires and the kick
 * posts its notice and hands over the "continue" nudge, the bot restarts and
 * restores what it saved. Run for a Telegram topic and for a Jira issue (their
 * kicks differ: the notices are Telegram-only, an issue's own session is resumed
 * first).
 *
 * The property: the saved record means "ARMED". A kick that has run its course —
 * the nudge delivered, no session to nudge, or a delivery that threw — leaves
 * nothing saved, so a restart (hot mode restarts on every code change) never fires
 * it again: no second "resuming" notice, no second nudge. A nudge that only waits in
 * the startup buffer behind another caller's session start has NOT run its course:
 * the buffer is in memory, so a restart loses it, and what a fresh spawn leaves in the
 * session log gives the boot recovery nothing to find — the saved record is what
 * fires it again. It goes when the buffer replays the nudge or drops it for good.
 *
 * Real timers, driven by node:test's mock clock; the world around the kick (the
 * session, the topic, the request ledger) is recorded fakes.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { keyFromString, keyToString, unregisterSessionKeyCodec, type SessionKey } from '../sessionKey';
import { StartupPromptBuffer } from '../startupPromptBuffer';
import { deliverPromptOrBuffer } from '../utils/promptDelivery';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';
import {
  apiRetryCatchUpDelayMs,
  restoreApiRetryTimers,
  runApiRetryKick,
  type ApiRetryEnsureOutcome,
  type ApiRetryKickDeps,
  type ApiRetryTimerEntry,
  type ApiRetryTopicNotice,
} from '../apiRetryKick';
import type { ApiRetryState } from '../types';
import { maxTimeoutMs } from '../scheduler/engine';

registerTestSessionKeyCodec();
process.on('exit', () => unregisterSessionKeyCodec('test'));

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const issueKey: SessionKey = makeTestKey('PROJ', 'PROJ-7');
const continueNudge = 'continue';
const fireAtInThePast = 1_000;
const clockMs = 1_000_000;

/** The bot's side of the story: what is saved, what is armed, what was done. */
interface World {
  /** The saved twin (`state.json` `apiRetries`) — survives a "restart". */
  saved: Record<string, ApiRetryState>;
  /** The in-memory retry map and in-flight set — rebuilt by a "restart". */
  entries: Map<string, ApiRetryTimerEntry>;
  kicksInFlight: Set<string>;
  notices: Array<{ key: string; notice: ApiRetryTopicNotice }>;
  nudges: Array<{ key: string; text: string }>;
  /** The bot's startup buffer — in memory only, so a "restart" empties it. */
  startupBuffer: StartupPromptBuffer;
  continuations: Array<{ key: string; isCountersReset: boolean; isRequestPrompt: boolean }>;
  ownSessionResumes: string[];
  clears: string[];
  ensureOutcome: ApiRetryEnsureOutcome;
  /** Runs while the nudge is being handed over (a recurrence, a user message, a crash). */
  duringDelivery: (() => void) | null;
  deliveryError: Error | null;
  untakenRequestPrompt: string | undefined;
  kicks: Array<Promise<void>>;
}

let world: World;

function createKickDeps(): ApiRetryKickDeps {
  return {
    entries: world.entries,
    kicksInFlight: world.kicksInFlight,
    now: () => clockMs,
    resumeOwnSession: async (key) => { world.ownSessionResumes.push(keyToString(key)); },
    ensureSession: async () => world.ensureOutcome,
    postTopicNotice: (key, notice) => { world.notices.push({ key: keyToString(key), notice }); },
    getResumeMessage: () => world.untakenRequestPrompt === undefined
      ? { text: continueNudge, isRequestPrompt: false }
      : { text: world.untakenRequestPrompt, isRequestPrompt: true },
    // The bot's own buffer-or-forward unit over a real startup buffer, so what the kick learns about a
    // buffered nudge is what the bot would tell it.
    deliverNudge: async (key, text, onBufferedSettled) => {
      world.duringDelivery?.();
      if (world.deliveryError) throw world.deliveryError;
      return deliverPromptOrBuffer(
        {
          startupBuffer: world.startupBuffer,
          forwardPrompt: async (target, prompt) => { world.nudges.push({ key: keyToString(target), text: prompt }); },
          announceQueued: async () => {},
        },
        key,
        text,
        world.startupBuffer.checkIsStarting(keyToString(key)),
        onBufferedSettled,
      );
    },
    trackContinuation: async (key, options) => { world.continuations.push({ key: keyToString(key), ...options }); },
    clearSavedRetry: (key) => {
      world.clears.push(keyToString(key));
      delete world.saved[keyToString(key)];
    },
  };
}

/** What the bot does at boot: re-arm every saved record; a due timer runs the kick. */
function boot(options: { isServed?: (key: SessionKey) => boolean } = {}): number {
  world.entries = new Map();
  world.kicksInFlight = new Set();
  world.startupBuffer = new StartupPromptBuffer();
  return restoreApiRetryTimers(
    {
      entries: world.entries,
      now: () => clockMs,
      isServed: options.isServed ?? (() => true),
      fire: (key) => { world.kicks.push(runApiRetryKick(createKickDeps(), key)); },
    },
    { ...world.saved },
  );
}

/** The bot's forward to a conversation's live session, as far as the test sees it: the prompt lands in `nudges`. */
function forwardToSession(key: SessionKey): (text: string) => Promise<void> {
  return async (text) => { world.nudges.push({ key: keyToString(key), text }); };
}

/** Let every due timer fire and every kick run to its end. */
async function runDueTimers(): Promise<void> {
  mock.timers.tick(maxTimeoutMs);
  await Promise.all(world.kicks);
}

function saveRetry(key: SessionKey, record: Partial<ApiRetryState> = {}): void {
  world.saved[keyToString(key)] = { kind: 'usageLimit', attempt: 1, fireAt: fireAtInThePast, ...record };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  world = {
    saved: {},
    entries: new Map(),
    kicksInFlight: new Set(),
    notices: [],
    nudges: [],
    startupBuffer: new StartupPromptBuffer(),
    continuations: [],
    ownSessionResumes: [],
    clears: [],
    ensureOutcome: { ok: true },
    duringDelivery: null,
    deliveryError: null,
    untakenRequestPrompt: undefined,
    kicks: [],
  };
});

afterEach(() => {
  mock.timers.reset();
});

for (const [label, key] of [['a Telegram topic', topicKey], ['a Jira issue', issueKey]] as const) {
  const isTelegram = key === topicKey;
  const keyString = keyToString(key);

  describe(`${label}: a retry that fired is not fired again by a restart`, () => {
    it('delivered: one notice (a topic only), one nudge — and the restart that follows finds nothing armed', async () => {
      saveRetry(key);
      assert.equal(boot(), 1, 'the first boot re-arms the saved retry');
      await runDueTimers();

      assert.deepEqual(world.nudges, [{ key: keyString, text: continueNudge }]);
      assert.deepEqual(
        world.notices.map(({ notice }) => notice),
        isTelegram ? [{ kind: 'resuming', retryKind: 'usageLimit' }] : [],
        'a tracker issue has no topic to say it in (R6)',
      );
      assert.deepEqual(world.ownSessionResumes, isTelegram ? [] : [keyString], 'an issue resumes its own session first (R26)');

      // The bot restarts: what it saved is all it has.
      const rearmedAfterRestart = boot();
      await runDueTimers();
      assert.equal(world.nudges.length, 1, 'no second nudge');
      assert.equal(world.notices.length, isTelegram ? 1 : 0, 'no second notice');
      assert.equal(rearmedAfterRestart, 0, 'nothing armed after the restart');
      assert.deepEqual(world.saved, {});
    });

    it('buffered behind another caller\'s session start: the record stays, so a restart before the replay fires the retry again', async () => {
      saveRetry(key, { kind: 'transient', attempt: 2 });
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();

      assert.deepEqual(world.nudges, [], 'it waits in the startup buffer, not in the session');
      assert.equal(world.startupBuffer.checkIsStarting(keyString), true);
      assert.deepEqual(world.saved[keyString], { kind: 'transient', attempt: 2, fireAt: fireAtInThePast }, 'still armed: nothing has been delivered');
      assert.deepEqual(world.clears, []);

      // The bot restarts mid-start: the buffer is in memory, the nudge is gone, and the new session's log holds no
      // error for the boot recovery to find — the saved record is all that is left to resume from.
      const rearmedAfterRestart = boot();
      assert.equal(rearmedAfterRestart, 1, 'the restored retry is armed again');
      await runDueTimers();

      assert.deepEqual(world.nudges, [{ key: keyString, text: continueNudge }], 'the nudge reaches the session the restart brought up');
      assert.deepEqual(world.saved, {}, 'and now it has run its course');
      assert.equal(
        world.notices.filter(({ notice }) => notice.kind === 'resuming').length,
        isTelegram ? 2 : 0,
        'the price of firing again: a topic reads "resuming" once per fire',
      );
    });

    it('buffered, then replayed: the record goes with the replay — a restart after it fires nothing', async () => {
      saveRetry(key);
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();
      assert.equal(keyString in world.saved, true, 'kept while the nudge waits');

      await world.startupBuffer.replayPrompts(keyString, { isSessionActive: true, forward: forwardToSession(key) });
      assert.deepEqual(world.nudges, [{ key: keyString, text: continueNudge }]);
      assert.deepEqual(world.saved, {}, 'cleared once the buffer handed the nudge to the session');
      assert.deepEqual(world.clears, [keyString], 'cleared exactly once');

      assert.equal(boot(), 0, 'nothing is armed after the restart');
      await runDueTimers();
      assert.equal(world.nudges.length, 1, 'no second nudge');
      assert.equal(world.notices.length, isTelegram ? 1 : 0, 'no second notice');
    });

    it('buffered, then the replay\'s forward throws: still spent — nobody re-delivers it, and a restart would not fix what threw', async () => {
      saveRetry(key);
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();
      const logged = mock.method(console, 'error', () => {});
      try {
        await world.startupBuffer.replayPrompts(keyString, {
          isSessionActive: true,
          forward: async () => { throw new Error('adapter went away'); },
        });
      } finally {
        logged.mock.restore();
      }
      assert.deepEqual(world.saved, {});
      assert.equal(boot(), 0);
    });

    it('buffered, then the start fails: the nudge is dropped for good, so the retry is spent and a restart does not fire it', async () => {
      saveRetry(key);
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();
      assert.equal(keyString in world.saved, true);

      const warned = mock.method(console, 'warn', () => {});
      try {
        world.startupBuffer.discardPrompts(keyString);
        assert.equal(warned.mock.calls.length, 1, 'one line says the retry was spent without reaching a session');
      } finally {
        warned.mock.restore();
      }
      assert.deepEqual(world.saved, {}, 'the starter reported the failed start; the open request is left to the wake-up engine');
      assert.deepEqual(world.nudges, []);

      assert.equal(boot(), 0);
    });

    it('buffered, then drained into a session that is not active: dropped for good, the record goes', async () => {
      saveRetry(key);
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();

      const warned = mock.method(console, 'warn', () => {});
      try {
        await world.startupBuffer.replayPrompts(keyString, { isSessionActive: false, forward: forwardToSession(key) });
      } finally {
        warned.mock.restore();
      }
      assert.deepEqual(world.nudges, [], 'nothing was forwarded to a dead session');
      assert.deepEqual(world.saved, {});
    });

    for (const [settleLabel, settle] of [
      ['replayed', () => world.startupBuffer.replayPrompts(keyString, { isSessionActive: true, forward: forwardToSession(key) })],
      ['dropped', async () => { world.startupBuffer.discardPrompts(keyString); }],
    ] as const) {
      it(`a recurrence armed while the nudge waits keeps ITS saved record when the old nudge is ${settleLabel}`, async () => {
        saveRetry(key, { attempt: 1 });
        boot();
        world.startupBuffer.markStarting(keyString); // another caller's session start is under way
        await runDueTimers();

        // The nudge waits; the next error arms attempt 2 — a NEW entry and its own saved record.
        const newer: ApiRetryTimerEntry = { timer: setTimeout(() => {}, 60_000), attempt: 2, kind: 'usageLimit', firedAt: null, fireAt: clockMs + 60_000 };
        world.entries.set(keyString, newer);
        world.saved[keyString] = { kind: 'usageLimit', attempt: 2, fireAt: newer.fireAt };

        const warned = mock.method(console, 'warn', () => {});
        try {
          await settle();
        } finally {
          warned.mock.restore();
        }
        assert.deepEqual(world.saved[keyString], { kind: 'usageLimit', attempt: 2, fireAt: clockMs + 60_000 }, 'the older nudge settling must not undo it');
        assert.equal(world.entries.get(keyString), newer);
        assert.deepEqual(world.clears, []);
      });
    }

    it('buffered, then the retry is cancelled (a user message, /new): the settling nudge clears nothing — the cancel already did', async () => {
      saveRetry(key);
      boot();
      world.startupBuffer.markStarting(keyString); // another caller's session start is under way
      await runDueTimers();

      // What `cancelApiRetry` does: the entry and the saved record go together.
      world.entries.delete(keyString);
      delete world.saved[keyString];
      await world.startupBuffer.replayPrompts(keyString, { isSessionActive: true, forward: forwardToSession(key) });
      assert.deepEqual(world.clears, [], 'no second clear for a retry that no longer exists');
    });

    it('no session to resume: nothing forwarded, the topic told once why, and a restart does not try (or tell) again', async () => {
      world.ensureOutcome = { ok: false, reason: 'start-failed', message: 'could not start' };
      saveRetry(key);
      boot();
      await runDueTimers();

      assert.deepEqual(world.nudges, [], 'a forward would hit a dead adapter');
      assert.deepEqual(world.continuations, [], 'no turn was started to watch');
      assert.deepEqual(
        world.notices.map(({ notice }) => notice),
        isTelegram ? [{ kind: 'noSession', message: 'could not start' }] : [],
      );

      const rearmedAfterRestart = boot();
      await runDueTimers();
      assert.equal(world.notices.length, isTelegram ? 1 : 0, 'the reason is not posted again');
      assert.deepEqual(world.nudges, []);
      assert.equal(rearmedAfterRestart, 0);
    });

    it('the delivery threw: the kick is spent too, so the restart does not repeat it', async () => {
      world.deliveryError = new Error('adapter went away');
      const logged = mock.method(console, 'error', () => {});
      try {
        saveRetry(key);
        boot();
        await runDueTimers();
        assert.equal(logged.mock.calls.length, 1, 'the failure is logged, not thrown into the timer');
      } finally {
        logged.mock.restore();
      }

      assert.equal(boot(), 0, 'nothing is armed after the restart');
      await runDueTimers();
      assert.equal(world.nudges.length, 0, 'and nothing is nudged');
    });

    it('while it runs the retry is in flight; afterwards it is released and the fired entry stays for the recurrence grace window', async () => {
      saveRetry(key);
      boot();
      let wasInFlight = false;
      world.duringDelivery = () => { wasInFlight = world.kicksInFlight.has(keyString); };
      await runDueTimers();

      assert.equal(wasInFlight, true);
      assert.equal(world.kicksInFlight.has(keyString), false);
      const fired = world.entries.get(keyString);
      assert.equal(fired?.timer, null, 'no longer armed');
      assert.equal(fired?.firedAt, clockMs, 'a recurrence within the grace window escalates the attempt');
    });

    it('a recurrence armed while the nudge is handed over keeps ITS saved record — the old kick must not clear it', async () => {
      saveRetry(key, { attempt: 1 });
      boot();
      world.duringDelivery = () => {
        // The agent answered the nudge with the limit again: the bot armed attempt 2 — a NEW entry and a saved record.
        const newer: ApiRetryTimerEntry = { timer: setTimeout(() => {}, 60_000), attempt: 2, kind: 'usageLimit', firedAt: null, fireAt: clockMs + 60_000 };
        world.entries.set(keyString, newer);
        world.saved[keyString] = { kind: 'usageLimit', attempt: 2, fireAt: newer.fireAt };
      };
      mock.timers.tick(apiRetryCatchUpDelayMs);
      await Promise.all(world.kicks);

      assert.deepEqual(world.saved[keyString], { kind: 'usageLimit', attempt: 2, fireAt: clockMs + 60_000 });
      assert.equal(world.entries.get(keyString)?.attempt, 2);
    });

    it('the nudge carries the open request\'s own prompt when the agent never took it in, and the continuation watch says so (R21)', async () => {
      world.untakenRequestPrompt = '[Request req_1] the whole task';
      saveRetry(key);
      boot();
      await runDueTimers();

      assert.deepEqual(world.nudges, [{ key: keyString, text: '[Request req_1] the whole task' }]);
      assert.deepEqual(world.continuations, [{ key: keyString, isCountersReset: true, isRequestPrompt: true }]);
    });

    it('a transient retry does not restart the wake-up counters; a limit wait does', async () => {
      saveRetry(key, { kind: 'transient' });
      boot();
      await runDueTimers();
      assert.deepEqual(world.continuations, [{ key: keyString, isCountersReset: false, isRequestPrompt: false }]);
      assert.deepEqual(
        world.notices.map(({ notice }) => notice),
        isTelegram ? [{ kind: 'resuming', retryKind: 'transient' }] : [],
      );
    });
  });
}

describe('restoring the saved retries at boot', () => {
  it('re-arms each record at its own time: a future one when it is due, a past one after the catch-up delay', async () => {
    saveRetry(topicKey, { fireAt: clockMs + 60_000 });
    saveRetry(issueKey, { fireAt: fireAtInThePast });
    assert.equal(boot(), 2);

    mock.timers.tick(apiRetryCatchUpDelayMs - 1);
    assert.equal(world.kicks.length, 0, 'not in the adopt tick: a freshly adopted pane may still be repainting');
    mock.timers.tick(1);
    await Promise.all(world.kicks);
    assert.deepEqual(world.nudges.map(({ key }) => key), [keyToString(issueKey)], 'only the past one has fired');

    mock.timers.tick(60_000);
    await Promise.all(world.kicks);
    assert.deepEqual(world.nudges.map(({ key }) => key), [keyToString(issueKey), keyToString(topicKey)]);
  });

  it('a retry of a platform this instance does not serve is neither armed nor dropped (R10)', () => {
    saveRetry(topicKey);
    saveRetry(issueKey);
    assert.equal(boot({ isServed: (key) => key.platform === 'telegram' }), 1);

    assert.deepEqual([...world.entries.keys()], [keyToString(topicKey)]);
    assert.deepEqual(Object.keys(world.saved).sort(), [keyToString(issueKey), keyToString(topicKey)].sort(), 'the other instance\'s record stays');
  });

  it('a corrupt key is skipped; the boot goes on', () => {
    world.saved['not a key'] = { kind: 'transient', attempt: 1, fireAt: fireAtInThePast };
    saveRetry(topicKey);
    assert.throws(() => keyFromString('not a key'), 'the key really is unreadable');
    assert.equal(boot(), 1);
  });

  it('a wait longer than the longest timer is clamped to it (a longer delay would fire at once)', () => {
    saveRetry(topicKey, { fireAt: clockMs + 10 * maxTimeoutMs });
    boot();
    mock.timers.tick(maxTimeoutMs - 1);
    assert.equal(world.kicks.length, 0);
    mock.timers.tick(1);
    assert.equal(world.kicks.length, 1, 'it fires at the clamp');
  });
});

describe('the bot wires the kick and the restore, and keeps the saved record meaning "armed"', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const kickSource = fs.readFileSync(path.join(__dirname, '..', 'apiRetryKick.ts'), 'utf8');
  const getFunction = (header: string): string => {
    const start = botSource.indexOf(header);
    assert.ok(start >= 0, header);
    return botSource.slice(start, botSource.indexOf('\n}\n', start));
  };
  const kickPorts = ((): string => {
    const start = botSource.indexOf('const apiRetryKickDeps: ApiRetryKickDeps = {');
    assert.ok(start >= 0);
    return botSource.slice(start, botSource.indexOf('\n};\n', start));
  })();

  it('a due timer runs the kick under the thread\'s locale, on the bot\'s own retry map and in-flight set', () => {
    assert.ok(getFunction('async function fireApiRetry(').includes('return withThreadLocale(key, () => runApiRetryKick(apiRetryKickDeps, key));'));
    assert.ok(kickPorts.includes('entries: apiRetryTimers,') && kickPorts.includes('kicksInFlight: apiRetryKicksInFlight,'));
    // The wake-up probe reads the same two: a retry armed or being kicked is not a turn end.
    assert.ok(botSource.includes('getApiRetryTimer: (keyString) => apiRetryTimers.get(keyString)?.timer,'));
    assert.ok(botSource.includes('checkIsRetryKickInFlight: (keyString) => apiRetryKicksInFlight.has(keyString),'));
  });

  it('the session is the thread\'s own: a tracker issue is resumed by id first (R26), then ensured', () => {
    assert.ok(kickPorts.includes('resumeOwnSession: resumeOwnSessionUnlessStarting,'));
    assert.ok(kickPorts.includes('ensureSession: (key) => ensureAgentSession(key),'));
    assert.match(getFunction('async function resumeOwnSessionUnlessStarting('), /if \(!startupPromptBuffer\.checkIsStarting\(keyToString\(key\)\)\) await ensureSessionByResume\(key\);/);
  });

  it('what it hands over is the nudge, or the open request\'s prompt the agent never took in — only for a limit wait (R21)', () => {
    assert.match(kickPorts, /getResumeMessage: \(key, retryKind\) => getLimitResumeMessage\(\{\n\s*continueNudge: t\('apiRetry\.continueNudge'\),\n\s*untakenRequestPrompt: retryKind === 'usageLimit'\n\s*\? getPromptNotTakenIn\(requestLimitWaitAnswerDeps\?\.ledger\.getOpenRequest\(key\)\)\n\s*: undefined,\n\s*\}\),/);
    assert.ok(kickPorts.includes('await requestWakeUpEngine?.trackContinuationTurn(key, options);'));
  });

  it('it reaches a session another start has under way through the startup buffer, never straight to the adapter', () => {
    assert.ok(kickPorts.includes('deliverNudge: (key, text, onBufferedSettled) => deliverPromptOrBuffer(key, text, startupPromptBuffer.checkIsStarting(keyToString(key)), onBufferedSettled),'));
    assert.doesNotMatch(kickPorts, /forwardPromptToAgent\(/, 'a direct forward hits an adapter that is not there yet');
    // The buffer-or-forward unit the whole bot shares: buffered text replays in order once the start finishes.
    assert.ok(getFunction('function deliverPromptOrBuffer(').includes('return deliverPromptWithDeps(promptDeliveryDeps, key, promptText, isStarting, onBufferedSettled);'));
    assert.match(botSource, /startupBuffer: startupPromptBuffer,\n\s*forwardPrompt: \(key, text\) => forwardPromptToAgent\(key, getThreadAdapter\(key\), text\),/);
  });

  it('both ways out of a startup window settle what it held: the replay on a started session, the discard on a failed start', () => {
    // The kick keeps the saved record while its nudge waits in the buffer; only these two can end that wait.
    const replay = getFunction('async function replayBufferedPrompts(');
    assert.match(replay, /await startupPromptBuffer\.replayPrompts\(keyToString\(key\), \{\n\s*isSessionActive,\n\s*forward: \(prompt\) => forwardPromptToAgent\(key, adapter, prompt\),\n\s*\}\);/);
    assert.match(getFunction('async function startAgentSession('), /startupPromptBuffer\.discardPrompts\(kStr\);/);
    assert.doesNotMatch(botSource, /startupPromptBuffer\s*\.drainPrompts\(/, 'a drain that settles nothing would leave a waiting nudge waiting for good');
  });

  it('a topic gets the reason or the "resuming" notice (pinned for a limit wait, a plain line for a transient retry)', () => {
    assert.match(kickPorts, /postTopicNotice: \(key, notice\) => \{\n\s*if \(notice\.kind === 'noSession'\) void replyToThread\(key, notice\.message\);\n\s*else if \(notice\.retryKind === 'usageLimit'\) void surfaceLimitResumedNotice\(key\);\n\s*else void replyToThread\(key, t\('apiRetry\.resuming'\)\);\n\s*\},/);
  });

  it('the kick has no way to close the open request or release what a wait held: it only logs and returns', () => {
    assert.doesNotMatch(kickSource, /closeRequest|cancelConversation|cancelApiRetry|limitHeld/);
  });

  it('every path that arms a retry saves it, and every path that stops it being armed clears the saved record', () => {
    const handle = getFunction('function handleApiError(');
    // Arm: saved before the timer and the entry exist.
    const save = handle.indexOf('.setApiRetry(key, { kind: cls.kind, attempt: action.attempt, fireAt: action.fireAt })');
    const entry = handle.indexOf('apiRetryTimers.set(k, {');
    assert.ok(save > 0 && entry > save, 'arm: the saved twin is written with the entry');
    // Give up: the saved record and the entry go together.
    assert.ok(handle.includes('clearSavedApiRetry(key);\n    apiRetryTimers.delete(k);'), 'give up');
    // Cancel (a user message, a teardown).
    assert.ok(getFunction('function cancelApiRetry(').includes('apiRetryTimers.delete(k);\n  clearSavedApiRetry(key);'), 'cancel');
    // The kick that ran its course.
    assert.ok(kickPorts.includes('clearSavedRetry: clearSavedApiRetry,'), 'a kick that ran its course');
    // One place talks to the store.
    assert.ok(getFunction('function clearSavedApiRetry(').includes('state.clearApiRetry(key)'));
    assert.equal(botSource.match(/state\.clearApiRetry\(/g)?.length, 1, 'the only clear of the saved record');
    assert.equal(botSource.match(/state\s*\.setApiRetry\(/g)?.length, 1, 'the only save of the saved record');
  });

  it('the boot restore re-arms what the state file holds, on the same map, and a due timer runs the kick', () => {
    const restore = getFunction('function restoreApiRetries(');
    assert.ok(restore.includes('entries: apiRetryTimers,'));
    assert.ok(restore.includes('state.getApiRetries(),'));
    assert.match(restore, /fire: \(key\) => \{\n\s*void fireApiRetry\(key\);\n\s*\},/);
  });
});
