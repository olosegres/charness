/**
 * @description The wake-up engine (`requests/wakeUpEngine.ts`, request/answer
 * core S4) over a REAL request ledger, with a scripted session probe, recorded
 * wake-ups / alerts and a controlled clock: the polls and sweeps the timers would
 * run are called directly, so every rule is driven step by step.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { unnumberedProcessGeneration } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { answerRequest } from '../requests/answerRequest';
import type { AnswerSink } from '../platform/answerSink';
import { RequestWakeUpEngine, restartWakeStaggerMs, unwatchedSweepMs } from '../requests/wakeUpEngine';
import { createSessionTurnProbe } from '../requests/sessionTurnProbe';
import { maxWakeUpsPerRequest, progressFollowUpDelayMs, progressFollowUpMaxAgeMs, type SessionTurnProbe, type WakeUpRuleSet } from '../requests/wakeUpRules';
import type { OpenRequestState, RequestAlertReason, RequestWakeUpReason } from '../requests/types';
import type { RequestScheduleWait } from '../requests/scheduleWait';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import type { WakeUpMessage } from '../requests/requestHeader';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const backstopMs = 90 * 60 * 1000;
const alertMessageRef = '777';

let fakeHome: string;
let originalHome: string | undefined;
let dataDir: string;
let nowMs: number;
let probe: SessionTurnProbe;
let wakeUps: Array<{ requestId: string; reason: RequestWakeUpReason }>;
let wakeUpMessages: WakeUpMessage[];
let alerts: Array<{ requestId: string; reason: RequestAlertReason }>;
let releasedAlerts: string[];
let isWakeUpDeliverable: boolean;
/** What each wake-up asked a session for — a request's own prompt may start one, a reminder never (R28). */
let preparedFor: WakeUpMessage[];
/** Runs while the session is being resumed for a reminder (the resume race). */
let duringWakeUpResume: (() => Promise<void>) | null;

/** Every store a test made, flushed before its folder goes: a pending save would otherwise fail on the removed folder. */
let createdStores: StateStore[] = [];

async function createLedger(): Promise<RequestLedger> {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  createdStores.push(store);
  const ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
    now: () => nowMs,
    releaseAlert: async (alert) => { releasedAlerts.push(alert.alertRef); },
  });
  await ledger.load();
  return ledger;
}

const recordWakeUp = async (_key: SessionKey, request: OpenRequestState, message: WakeUpMessage): Promise<void> => {
  wakeUps.push({ requestId: request.id, reason: message.reason });
  wakeUpMessages.push(message);
};

/**
 * What a test instance changes in the engine's dependencies: the windows it shortens (`CHARNESS_TEST_TIMINGS`) and the optional ports it
 * supplies; absent: the production ones.
 */
interface EngineOverrides {
  refreshProcessState?: (key: SessionKey) => void;
  sweepIntervalMs?: number;
  firstPostRetryDelayMs?: number;
  restartWakeStaggerMs?: number;
  noteRestartWakeDelivered?: (key: SessionKey) => void;
  progressFollowUpMs?: number;
  getScheduleWait?: (key: SessionKey, request: OpenRequestState) => RequestScheduleWait;
  getWakeUpRules?: (key: SessionKey) => WakeUpRuleSet;
}

function createEngine(ledger: RequestLedger, overrides: EngineOverrides = {}): RequestWakeUpEngine {
  return new RequestWakeUpEngine({
    ledger,
    probeTurn: () => probe,
    prepareWakeUpSession: async (_key, message) => {
      preparedFor.push(message);
      await duringWakeUpResume?.();
      return isWakeUpDeliverable;
    },
    forwardWakeUp: recordWakeUp,
    deliverAlert: async (_key, request, reason) => {
      alerts.push({ requestId: request.id, reason });
      return alertMessageRef;
    },
    backstopMs,
    ...overrides,
    now: () => nowMs,
  });
}

/** A turn the request's message started, then ended idle with nothing answered. */
/** The reasons of the wake-ups recorded so far, read through a call so a test's own assertions do not narrow the list's type. */
function getWakeUpReasons(): RequestWakeUpReason[] {
  return wakeUps.map((wakeUp) => wakeUp.reason);
}

async function endTurnSilently(engine: RequestWakeUpEngine): Promise<void> {
  probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
  await engine.pollWatchedTurns();
  probe = { ...probe, isBusy: false };
  await engine.pollWatchedTurns();
}

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-wakeups-'));
  process.env.HOME = fakeHome;
  dataDir = path.join(fakeHome, 'data');
  nowMs = 1_000_000_000;
  probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
  wakeUps = [];
  wakeUpMessages = [];
  alerts = [];
  releasedAlerts = [];
  isWakeUpDeliverable = true;
  preparedFor = [];
  duringWakeUpResume = null;
});

afterEach(async () => {
  await Promise.all(createdStores.map((store) => store.flush()));
  createdStores = [];
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('two requesters in one conversation', () => {
  const operatorOrigin = { kind: 'message' as const, attributes: { requester: '424242' } };
  const colleagueOrigin = { kind: 'message' as const, attributes: { requester: '535353' } };

  it('each open request is watched to its own turn end: the answered one closes, the silent one is woken', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const operatorRequest = await ledger.createRequest(topicKey, operatorOrigin);
    await engine.trackForwardedTurn(topicKey, operatorRequest.id);
    const colleagueRequest = await ledger.createRequest(topicKey, colleagueOrigin);
    await engine.trackForwardedTurn(topicKey, colleagueRequest.id);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey).map((request) => request.id), [operatorRequest.id, colleagueRequest.id], 'both stay open');

    // The agent answers the colleague's request during the turn, never the operator's.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await ledger.closeRequest(colleagueRequest.id, 'final');
    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();

    assert.deepEqual(wakeUps, [{ requestId: operatorRequest.id, reason: 'silentTurn' }], 'only the unanswered request is woken');
    assert.equal(ledger.getOpenRequestById(operatorRequest.id)?.request.silentTurnCount, 1);
  });

  it('the operator taking over cancels every open request of the conversation', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const operatorRequest = await ledger.createRequest(topicKey, operatorOrigin);
    const colleagueRequest = await ledger.createRequest(topicKey, colleagueOrigin);
    await engine.trackForwardedTurn(topicKey, operatorRequest.id);
    await engine.trackForwardedTurn(topicKey, colleagueRequest.id);

    await engine.cancelConversation(topicKey);

    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), []);
    for (const id of [operatorRequest.id, colleagueRequest.id]) {
      const lookup = ledger.getRequest(id);
      assert.equal(lookup?.isOpen === false ? lookup.request.closeReason : null, 'cancelled', id);
    }
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'nothing left to wake');
  });

  it('the cancel names the person\'s requests it closed whose words the agent never took in — a switch to another agent tells them, the bridge carries only what the transcript holds (review 25 #3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const unread = await ledger.createRequest(topicKey, operatorOrigin, { createPrompt: () => 'fix the build' });
    const read = await ledger.createRequest(topicKey, colleagueOrigin, { createPrompt: () => 'and the docs' });
    await ledger.updateOpenRequest(read.id, { isPromptTakenIn: true });
    const fire = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } }, { createPrompt: () => 'the scheduled run' });
    for (const request of [unread, read, fire]) await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // The live process still lists what was written as unread: the agent has read none of it yet (review 26 #1 reads that too).
    probe = { ...probe, hasUnconsumedInput: true };

    assert.deepEqual(await engine.cancelConversation(topicKey), [unread.id], 'not the one taken in (its words are in the transcript), not the scheduler\'s (no person\'s words)');
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), [], 'all of them closed');
    assert.deepEqual(await engine.cancelConversation(topicKey), [], 'a second cancel closes nothing, so it names nothing');
  });

  describe('what the live process says at the command decides «never taken in», not only the mark the poll writes (review 26 #1)', () => {
    const livePid = 7;
    /** A person's request whose prompt was written to the live process `livePid`, tracked; its mark not yet written by any poll. */
    async function trackWrittenRequest(ledger: RequestLedger, engine: RequestWakeUpEngine, origin = operatorOrigin): Promise<string> {
      const request = await ledger.createRequest(topicKey, origin, { createPrompt: () => 'fix the build' });
      probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false, processGeneration: livePid };
      await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
      assert.equal(ledger.getOpenRequestById(request.id)?.request.isPromptTakenIn, undefined, 'precondition: no poll has marked it');
      return request.id;
    }

    it('a prompt the live process has echoed (nothing unread) is taken in: its person is not told, though no poll marked it yet', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      await trackWrittenRequest(ledger, engine);
      probe = { ...probe, hasUnconsumedInput: false };
      assert.deepEqual(await engine.cancelConversation(topicKey), [], 'the agent read it: its words are in the conversation it had');
    });

    it('one the live process still lists as unread is named', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      const requestId = await trackWrittenRequest(ledger, engine);
      assert.deepEqual(await engine.cancelConversation(topicKey), [requestId]);
    });

    it('a backend with no unread signal (the tmux Claude; OpenCode has its own count) holds what was written to it in its own conversation: written is taken in', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      // The tmux Claude: no unread signal (`hasUnconsumedInput` null), its live session named `unnumberedProcessGeneration`; no busy or output
      // seen yet. OpenCode reads its own unread count, as the json-stream Claude reads its echo: the tests above.
      probe = { isActive: true, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false, processGeneration: unnumberedProcessGeneration };
      const request = await ledger.createRequest(topicKey, operatorOrigin, { createPrompt: () => 'fix the build' });
      await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
      assert.deepEqual(await engine.cancelConversation(topicKey), [], 'OpenCode stored it in its session; the bridge reads it from there');
    });

    it('a prompt written to a process a re-spawn replaced died unread there: named, whatever the new process lists', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      const requestId = await trackWrittenRequest(ledger, engine);
      probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: livePid + 1 };
      assert.deepEqual(await engine.cancelConversation(topicKey), [requestId]);
    });

    it('a prompt still waiting in a start\'s or a stop\'s window is not the cancel\'s to tell: that window drops it and tells its person', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      const request = await ledger.createRequest(topicKey, operatorOrigin, { createPrompt: () => 'held by the stop' });
      probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true, isWindowOpen: true };
      await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
      assert.deepEqual(await engine.cancelConversation(topicKey), [], 'told once, by the drop');
    });

    it('an echo the process already wrote, though no poll has read it yet, takes its prompt in: the reading reads the process first (review 28, own pass)', async () => {
      const ledger = await createLedger();
      const refreshed: string[] = [];
      const engine = createEngine(ledger, {
        refreshProcessState: (key) => {
          refreshed.push(keyToString(key));
          // The echo sat in the process's output log, unread: reading it is what takes the prompt in.
          probe = { ...probe, hasUnconsumedInput: false };
        },
      });
      await trackWrittenRequest(ledger, engine);
      assert.deepEqual(await engine.cancelConversation(topicKey), [], 'the agent read it: the bridge carries it, nobody is told it was lost');
      assert.deepEqual(refreshed, [keyToString(topicKey)], 'read once, by the reading');
    });

    it('a reading taken before the command replaced the process decides, not the probe of the process that replaced it (the /resume pick)', async () => {
      const ledger = await createLedger();
      const engine = createEngine(ledger);
      await trackWrittenRequest(ledger, engine);
      probe = { ...probe, hasUnconsumedInput: false };
      const reading = engine.readPromptsReachedOrHeld(topicKey);
      // The picked conversation's process replaced the old one: a new number, nothing unread.
      probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: livePid + 1 };
      assert.deepEqual(await engine.cancelConversation(topicKey, reading), [], 'read off the old process while it was live');
    });
  });
});

describe('silent turns', () => {
  it('a silent turn is woken at once; the second alerts, stops waking and holds the alert', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 1);

    // The reminder's own turn ends silent too.
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
    assert.equal(wakeUps.length, 1, 'no second wake-up');
    const stopped = ledger.getNewestOpenRequest(topicKey);
    assert.equal(stopped?.isWakeStopped, true);
    assert.equal(stopped?.alertRef, alertMessageRef);

    // Nothing wakes it again, the backstop included.
    nowMs += 2 * backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.equal(wakeUps.length, 1);
    assert.equal(alerts.length, 1);
  });

  it('the alert is released when its request closes', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.updateOpenRequest(request.id, { silentTurnCount: 1 });
    await engine.trackForwardedTurn(topicKey, request.id);
    await endTurnSilently(engine);

    await ledger.closeRequest(request.id, 'final');
    await new Promise((resolve) => setImmediate(resolve));

    const closed = ledger.getRequest(request.id);
    assert.equal(closed?.isOpen === false ? closed.request.alertRef : null, alertMessageRef);
    assert.deepEqual(releasedAlerts, [alertMessageRef]);
  });

  it('a request closed while its alert went out has the alert released at once', async () => {
    const ledger = await createLedger();
    const engine = new RequestWakeUpEngine({
      ledger,
      probeTurn: () => probe,
      prepareWakeUpSession: async () => true,
      forwardWakeUp: recordWakeUp,
      deliverAlert: async (_key, request) => {
        await ledger.closeRequest(request.id, 'final'); // the answer lands meanwhile
        return alertMessageRef;
      },
      backstopMs,
      now: () => nowMs,
    });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.updateOpenRequest(request.id, { silentTurnCount: 1 });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(releasedAlerts, [alertMessageRef]);
  });

  it('a session that cannot be reached for the reminder alerts and stops', async () => {
    isWakeUpDeliverable = false;
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);

    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'wakeFailed' }]);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isWakeStopped, true);
  });

  it('the wake-up cap alerts instead of a further wake-up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.updateOpenRequest(request.id, { wakeCount: 10 });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);

    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'wakeCap' }]);
  });
});

describe('the resume race', () => {
  it('a request answered while its session was being resumed gets no reminder and no alert', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    duringWakeUpResume = async () => { await ledger.closeRequest(request.id, 'final'); };

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, [], 'the stale reminder is dropped');
    assert.deepEqual(alerts, [], 'a dropped reminder is not a failure');
  });

  it('a request replaced while its session was being resumed: no reminder for either', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    let newer: OpenRequestState | undefined;
    duringWakeUpResume = async () => {
      newer = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    };

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
    const open = ledger.getNewestOpenRequest(topicKey);
    assert.equal(open?.id, newer?.id);
    assert.notEqual(open?.id, request.id);
    assert.equal(open?.isWakeStopped, false, 'the newer request is not marked stopped');
  });
});

describe('failures', () => {
  it('a reminder that throws on its way out counts as undeliverable: alert, stop', async () => {
    const ledger = await createLedger();
    const engine = new RequestWakeUpEngine({
      ledger,
      probeTurn: () => probe,
      prepareWakeUpSession: async () => true,
      forwardWakeUp: async () => { throw new Error('tmux is gone'); },
      deliverAlert: async (_key, request, reason) => {
        alerts.push({ requestId: request.id, reason });
        return alertMessageRef;
      },
      backstopMs,
      now: () => nowMs,
    });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);

    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'wakeFailed' }]);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isWakeStopped, true);
  });

  it('one conversation that fails never stops the others, and a tick never rejects', async () => {
    const otherKey: SessionKey = makeTelegramKey(-1001234567890, 43);
    const ledger = await createLedger();
    const engine = new RequestWakeUpEngine({
      ledger,
      probeTurn: (key) => {
        if (key.thread === topicKey.thread) throw new Error('unknown adapter');
        return probe;
      },
      prepareWakeUpSession: async () => true,
      forwardWakeUp: recordWakeUp,
      deliverAlert: async () => null,
      backstopMs,
      now: () => nowMs,
    });
    await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const healthy = await ledger.createRequest(otherKey, { kind: 'message', attributes: {} });

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, [{ requestId: healthy.id, reason: 'backstop' }]);
  });
});

describe('progress answers', () => {
  it('a turn that sent progress is followed up 15 min later, never while the session works', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'no wake-up right after a progress note');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextWakeAt, nowMs + progressFollowUpDelayMs);

    nowMs += progressFollowUpDelayMs - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);

    nowMs += 1;
    probe = { ...probe, isBusy: true };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'never into a live turn');

    probe = { ...probe, isBusy: false };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'progressFollowUp' }]);
  });

  it('an agent that answers every reminder with a progress note is never given up on: the cap counts reminders it left unanswered', async () => {
    // A long pipeline or e2e run: the agent waits on it and reports at each reminder, well past the cap of reminders.
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    const answerWithProgress = () => ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await answerWithProgress();
    await endTurnSilently(engine);

    for (let reminder = 1; reminder <= maxWakeUpsPerRequest + 2; reminder += 1) {
      nowMs += progressFollowUpDelayMs;
      await engine.sweepUnwatchedRequests();
      assert.equal(wakeUps.length, reminder, `reminder ${reminder} is delivered`);
      await answerWithProgress();
      await endTurnSilently(engine);
    }

    assert.deepEqual(alerts, [], 'no alert: the agent answered every reminder');
    const open = ledger.getNewestOpenRequest(topicKey);
    assert.equal(open?.isWakeStopped, false);
    assert.equal(open?.wakeCount, 0);
    assert.equal(open?.nextWakeAt, nowMs + progressFollowUpDelayMs);
  });

  it('at hour 12 a progress note arms no more follow-up, but the request is not given up: no alert, no wake stop (the slot stays), the backstop still wakes it', async () => {
    const wakeStopped: string[] = [];
    const store = new StateStore(dataDir, { saveDebounceMs: 5 });
    await store.init();
    createdStores.push(store);
    const ledger = new RequestLedger({
      store,
      history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
      now: () => nowMs,
      onRequestWakeStopped: (_key, request) => { wakeStopped.push(request.id); },
    });
    await ledger.load();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(makeJiraKey('PROJ-12'), { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-12', triggerId: '1', requester: 'r' } });
    const key = makeJiraKey('PROJ-12');

    // Twelve hours of a long run, the agent reporting at the end of each turn.
    nowMs += progressFollowUpMaxAgeMs;
    await engine.trackForwardedTurn(key, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);

    const open = ledger.getNewestOpenRequest(key);
    assert.equal(open?.isWakeStopped, false, 'not given up');
    assert.equal(open?.nextWakeAt, undefined, 'no follow-up armed');
    assert.deepEqual(alerts, []);
    assert.deepEqual(wakeStopped, [], 'the ledger never reported a wake stop: the task-agent slot stays held');

    nowMs += progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'no reminder 15 min later any more');

    nowMs += backstopMs - progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }], 'nothing seen working on it for the backstop window: woken');
    assert.deepEqual(alerts, []);
  });

  it('the follow-up time survives a restart', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    await Promise.all(createdStores.map((store) => store.flush())); // the debounced save, landed before the "restart"

    const engineAfterRestart = createEngine(await createLedger());
    nowMs += progressFollowUpDelayMs;
    await engineAfterRestart.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'progressFollowUp' }]);
  });
});

describe('what is not a turn end', () => {
  it('an idle report before the backend took in the message is not the end of this turn', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, []);

    probe = { ...probe, hasUnconsumedInput: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
  });

  it('without a consumption signal, an idle session right after the forward is not a turn end', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    probe = { isActive: true, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, []);

    engine.noteAgentOutput(topicKey);
    await engine.pollWatchedTurns();
    assert.equal(wakeUps.length, 1);
  });

  it('a pending question, a compaction or an armed retry holds the turn open', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, []);

    probe = { ...probe, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(wakeUps.length, 1);
  });
});

describe('usage limits', () => {
  /** An armed limit wait holds the turn; the session is idle. */
  const limitWaitProbe: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true };

  it('nothing wakes the request during the wait, and at the resume its counters start from zero', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    // One silent turn and the cap reached: without the reset the next silent turn alerts.
    await ledger.updateOpenRequest(request.id, { silentTurnCount: 1, wakeCount: 10, nextWakeAt: nowMs });

    probe = limitWaitProbe;
    nowMs += 2 * backstopMs;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'no wake-up, follow-up or backstop during the wait');
    assert.deepEqual(alerts, []);

    // The limit window reset: the bot forwarded its "continue" nudge.
    await engine.trackContinuationTurn(topicKey, { isCountersReset: true });
    const resumed = ledger.getNewestOpenRequest(topicKey);
    assert.equal(resumed?.silentTurnCount, 0);
    assert.equal(resumed?.wakeCount, 0);
    assert.equal(resumed?.nextWakeAt, undefined);

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
    assert.deepEqual(alerts, []);
  });

  it('the nudge\'s turn is watched afresh: the idle the error left is not its end', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: null, isTurnEndBlocked: false };
    await engine.pollWatchedTurns(); // the request's own turn was seen working before the error

    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });
    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();

    assert.deepEqual(wakeUps, [], 'a backend without a consumption signal has not started the nudge\'s turn yet');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0);
  });

  it('a retry that is not a limit wait keeps the counters', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.updateOpenRequest(request.id, { silentTurnCount: 1, wakeCount: 3 });

    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });

    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 1);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.wakeCount, 3);
  });

  it('a wait that will not end by itself stops every wake-up, the backstop included', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await engine.stopWakingForLimitWait(topicKey);
    await endTurnSilently(engine);
    nowMs += 2 * backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, [], 'not a technical failure: the operator decides when to continue');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.id, request.id, 'the request stays open');
  });

  it('a limit stop is lifted when a limit wait ends with a resume; the rules\' own give-up is not', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.stopWakingForLimitWait(topicKey);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isLimitStopped, true);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isWakeStopped, false, 'not the rules\' give-up');

    // Auto-resume back on, a later limit wait ended with its resume.
    await engine.trackContinuationTurn(topicKey, { isCountersReset: true });
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isLimitStopped, undefined);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'waking again');

    await ledger.updateOpenRequest(request.id, { isWakeStopped: true });
    await engine.trackContinuationTurn(topicKey, { isCountersReset: true });
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isWakeStopped, true, 'an alert / cap give-up stays');
  });

  it('a transient retry\'s resume does not lift a limit stop', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.stopWakingForLimitWait(topicKey);

    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });
    await endTurnSilently(engine);

    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isLimitStopped, true);
    assert.deepEqual(wakeUps, []);
  });

  it('a stop that lands while the session is being resumed for a reminder drops it: no reminder, no alert', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    duringWakeUpResume = async () => { await engine.stopWakingForLimitWait(topicKey); };

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.id, request.id);
  });

  it('a stop that lands after the sweep took its snapshot wins over the stale decision', async () => {
    const stoppedKey: SessionKey = makeTelegramKey(-1001234567890, 43);
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const first = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.createRequest(stoppedKey, { kind: 'message', attributes: {} });
    // While the first conversation's session is resumed, the operator skips the second one's resume.
    duringWakeUpResume = async () => {
      duringWakeUpResume = null;
      await engine.stopWakingForLimitWait(stoppedKey);
    };

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, [{ requestId: first.id, reason: 'backstop' }]);
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(stoppedKey)?.wakeCount, 0, 'the stale decision changed nothing');
  });

  it('a watch replaced while a poll is running is not judged by the turn it replaced', async () => {
    const nudgedKey: SessionKey = makeTelegramKey(-1001234567890, 43);
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const first = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const nudged = await ledger.createRequest(nudgedKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, first.id);
    await engine.trackForwardedTurn(nudgedKey, nudged.id);
    // A backend without a consumption signal: both turns were seen working.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: null, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    // While the first conversation is reminded, a retry's "continue" nudge reaches the second.
    duringWakeUpResume = async () => {
      duringWakeUpResume = null;
      await engine.trackContinuationTurn(nudgedKey, { isCountersReset: false });
    };

    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();

    assert.deepEqual(wakeUps, [{ requestId: first.id, reason: 'silentTurn' }], 'the nudge\'s turn has not started yet');
    assert.equal(ledger.getNewestOpenRequest(nudgedKey)?.silentTurnCount, 0);
  });

  it('stopping the wake-ups never rejects, even when the ledger write fails', async () => {
    const ledger = await createLedger();
    await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const engine = new RequestWakeUpEngine({
      ledger: {
        getOpenRequestById: (id) => ledger.getOpenRequestById(id),
        listOpenRequestsOf: (key) => ledger.listOpenRequestsOf(key),
        listOpenRequests: () => ledger.listOpenRequests(),
        updateOpenRequest: async () => { throw new Error('state.json is read-only'); },
        closeRequest: (id, reason) => ledger.closeRequest(id, reason),
        recordAlert: (key, id, alertRef) => ledger.recordAlert(key, id, alertRef),
      },
      probeTurn: () => probe,
      prepareWakeUpSession: async () => true,
      forwardWakeUp: recordWakeUp,
      deliverAlert: async () => null,
      backstopMs,
      now: () => nowMs,
    });

    await engine.stopWakingForLimitWait(topicKey);
  });
});

describe('the backstop', () => {
  it('a dead session is left to the backstop, which wakes it after the window', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    probe = { isActive: false, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, [], 'a dead process is not a turn end');

    nowMs += backstopMs - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);

    nowMs += 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
  });

  it('a busy session counts as an unwatched request\'s activity only while the turn running is one the bot wrote — a turn the CLI started by itself (a finished task\'s, a looping session job\'s) pushes no backstop ahead (review 17 #4)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const createdAt = ledger.getNewestOpenRequest(topicKey)?.createdAt ?? 0;
    // The CLI's own job loops: every sweep finds its turn busy.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, isCliOwnTurn: true };
    for (let sweep = 0; sweep < 3; sweep += 1) {
      nowMs += backstopMs / 3;
      await engine.sweepUnwatchedRequests();
    }
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.lastTurnActivityAt, undefined, 'no activity of this request');
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }], `the backstop counted from the request's creation (${createdAt})`);

    // A turn the bot wrote is the request's lost turn: its busy time still counts.
    const other = await ledger.createRequest(makeTelegramKey(-1001234567890, 77), { kind: 'message', attributes: {} });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();
    assert.equal(ledger.listOpenRequestsOf(makeTelegramKey(-1001234567890, 77)).find((open) => open.id === other.id)?.lastTurnActivityAt, nowMs);
  });

  it('a watch whose turn end can never be seen is handed to the backstop', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    // An input counter that never settles: idle, unblocked, never taken in.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: false };
    nowMs += backstopMs - 1;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'still inside the window');

    nowMs += 1;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
  });

  it('a watch held open by a pending question is never handed over', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true };
    nowMs += 2 * backstopMs;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();

    assert.deepEqual(wakeUps, []);
    probe = { ...probe, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the watch kept deciding the turn end');
  });

  it('a session seen working pushes the backstop back', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    nowMs += backstopMs - 1000;
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();

    nowMs += 1000;
    probe = { ...probe, isBusy: false };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'the window restarted at the last activity');

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.equal(wakeUps.length, 1);
  });
});

describe('closing ends the watch', () => {
  it('a person taking over closes the request silently and nothing wakes it', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await engine.cancelConversation(topicKey);

    assert.equal(ledger.getNewestOpenRequest(topicKey), undefined);
    const closed = ledger.getRequest(request.id);
    assert.equal(closed?.isOpen === false ? closed.request.closeReason : null, 'cancelled');
    await endTurnSilently(engine);
    nowMs += 2 * backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
  });

  it('an answered or superseded request stops being watched, its successor untouched', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const first = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, first.id);
    const second = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    await endTurnSilently(engine);

    assert.deepEqual(wakeUps, []);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.id, second.id);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0);
  });

  it('a forward for a request that is not the open one is not watched', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const first = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    await engine.trackForwardedTurn(topicKey, first.id);
    await endTurnSilently(engine);

    assert.deepEqual(wakeUps, []);
  });
});

describe('a request whose prompt never reached the agent is re-posted, not reminded (R21)', () => {
  const prompt = '[Request · from: PROJ-12]\nThe whole request text.';

  it('a post that never happened: the backstop re-posts the stored prompt; once it was taken in, a wake-up reminds', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.prompt, prompt);

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUpMessages, [{ reason: 'backstop', text: prompt, isRequestPrompt: true }]);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'not read yet');

    // The re-posted prompt's turn runs and ends silently: it was taken in, so the next wake-up is a reminder.
    await endTurnSilently(engine);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
    assert.equal(wakeUpMessages.length, 2);
    assert.equal(wakeUpMessages[1].isRequestPrompt, false);
    assert.match(wakeUpMessages[1].text, new RegExp(`^\\[Reminder · request ${request.id} is still open\\]`));
  });

  it('the posted prompt\'s turn taken in marks it at once; a session that died before reading it does not', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: false };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'still unread');
    // A dead backend has nothing unread to report — that is not the prompt being read.
    probe = { isActive: false, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'the session died first: the prompt was never read');

    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
  });

  it('a held turn end is read like any other: a prompt the backend still lists as unread stays unread, one it took in is marked — the prompt of the turn that failed was read (review 17 #3: decision 45 (a) revisited after the CLI was measured)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // Queued behind the turn that failed: the adapter keeps it listed until its own turn echoes it.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    await engine.pollWatchedTurns();
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'still listed: unread');
    // Its own turn took it in (the CLI runs a message queued behind a failed turn as its next turn); the hold still stands.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true, 'read: a resume reminds instead of repeating it');
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [request.id], 'held: not decided');
  });

  it('a request whose held turn the bot then stops waking — «wait for reset» off — keeps a prompt still listed as unread unread: the resume posts it again', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    await engine.pollWatchedTurns();
    await engine.stopWakingForLimitWait(topicKey);
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);
  });

  it('a watch whose prompt is still listed as unread after a turn that ended in an error result is neither decided nor marked at the turn-end settle; its own turn decides it (review 17 #1)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // The turn ahead of it ended in an error the bot does not hold: idle, nothing held, the message still listed.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: false };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    await engine.pollWatchedTurns();
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [request.id], 'running: its turn has not started');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0);
    assert.deepEqual(getWakeUpReasons(), []);
    // Its turn runs, takes it in and ends silent: now it is decided, and the prompt marked read.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
    assert.deepEqual(getWakeUpReasons(), ['silentTurn']);
  });

  it('a prompt written to a process that a re-spawn replaced is never read as taken in off the new one: the turn\'s end posts it again, never a bare reminder (review 18 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    // Written into process 1 while its turn runs, queued there.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false, processGeneration: 1 };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // The account move after a limit re-spawns it at once: process 2 lists nothing unread, and the move still holds the turn end.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true, processGeneration: 2 };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'not read off the process that replaced the one it was written to');
    // Nothing carried it into process 2: the turn end is decided, and its wake is the prompt itself.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 2 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);
    assert.deepEqual(wakeUpMessages, [{ reason: 'silentTurn', text: prompt, isRequestPrompt: true }]);
  });

  it('a forward that carries the prompt again names the process of that write — it is read off that one; a forward that does not carry it leaves it where it was (review 18 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false, processGeneration: 1 };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 2 };
    // A plain «continue» into process 2 joins the watch: the prompt is not in it.
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: false, isContinuation: true, isConversationForward: true });
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'still in process 1, which is gone');
    // The resume's «continue» carries the prompt (R21: not taken in), written to process 2, which takes it in.
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isContinuation: true, isConversationForward: true });
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
  });

  /** A prompt buffered behind a start's window, written by the replay into process 2, then read off process `readOffProcess`. */
  async function readBufferedPromptOff(readOffProcess: number): Promise<boolean | undefined> {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    // The window is open: the prompt waits in the buffer, and the probe names no process.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // The replay writes it into process 2 (still the start for the probe).
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true, processGeneration: 2 };
    engine.noteReplayedWrite(topicKey);
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: readOffProcess };
    await engine.pollWatchedTurns();
    return ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn;
  }

  it('a prompt that waited in a buffer names no process until the replay writes it, and is read off the process the replay wrote it to (review 18 #2)', async () => {
    assert.equal(await readBufferedPromptOff(2), true);
  });

  it('a buffered prompt the replay wrote into a process that was replaced before it read it is not read off the replacing one (review 18 #2)', async () => {
    assert.equal(await readBufferedPromptOff(3), undefined);
  });

  it('a prompt the live process took in is marked at the settle of a turn end it holds — the re-spawn of a deferred switch right after it, or the per-turn stop, does not make it read as unread (review 18 #2: the turn end is where it is seen)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false, processGeneration: 1 };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    // Process 1 took it in, and its turn ends held (a re-spawn about to start): the turn-end settle decides nothing, but sees the prompt read.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: true, processGeneration: 1 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [request.id], 'held: not decided');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
    // One tick later the re-spawn replaces the process; its turn end is decided off process 2: a reminder, not the prompt again.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 2 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(wakeUpMessages.length, 1);
    assert.equal(wakeUpMessages[0].isRequestPrompt, false);
    assert.match(wakeUpMessages[0].text, new RegExp(`^\\[Reminder · request ${request.id} is still open\\]`));
  });

  it('a request prompt whose buffer was dropped is neither decided nor marked at an unrelated write into a new process; its wake, when the stale drop hands it to the backstop, posts the prompt again (review 19 #1)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    // A resume's window is open: the prompt waits in the buffer, and the probe names no process.
    probe = { isActive: false, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    // The buffer is dropped and a new process comes up; an unrelated prompt is written into it (no replay runs: nothing is named).
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 2 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    await engine.pollWatchedTurns();
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [request.id], 'not decided: its turn never started');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0);
    assert.equal(wakeUpMessages.length, 0, 'no bare reminder');
    // Nothing works on it for the whole backstop window: the stale drop hands it to the sweep, whose wake re-posts the prompt.
    nowMs += backstopMs;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUpMessages.map((message) => ({ text: message.text, isRequestPrompt: message.isRequestPrompt })), [{ text: prompt, isRequestPrompt: true }]);
  });

  it('a request prompt that reached no process takes no other turn\'s busy time as its activity: its stale drop is not pushed ahead (review 20, self-check)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: false, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    const activityAtTrack = ledger.getNewestOpenRequest(topicKey)?.lastTurnActivityAt;
    // Its window dropped it; process 2 runs other turns.
    nowMs += 60_000;
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 2 };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.lastTurnActivityAt, activityAtTrack, 'another turn\'s busy time is not this request\'s');
  });

  it('a prompt written to the tmux Claude, which cannot number its processes, is decided at the turn\'s end once `/claude_mode` moved the conversation to json-stream: read as written to another process and posted again, never held for the stale drop as «never written» (review 21 #1 b)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    // The real probe, over the thread's adapter as the switch replaces it: the tmux Claude has no process numbers and cannot tell unread input.
    type ProbedAdapter = ReturnType<Parameters<typeof createSessionTurnProbe>[0]['getAdapter']>;
    let threadAdapter: ProbedAdapter = { checkIsActive: () => true, checkIsBusy: () => true };
    const readProbe = createSessionTurnProbe({
      getAdapter: () => threadAdapter,
      checkHasPendingQuestion: () => false,
      checkHasQuestionPin: () => false,
      checkIsCompacting: () => false,
      getApiRetryTimer: () => undefined,
      checkIsWedgeRecoveryInFlight: () => false,
      checkIsRetryKickInFlight: () => false,
      checkIsApiErrorInHandling: () => false,
      checkIsSessionStarting: () => false,
      checkIsReplayingBufferedPrompts: () => false,
      serializeKey: keyToString,
    });
    // Written into the tmux session while its turn runs.
    probe = readProbe(topicKey);
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    // `/claude_mode` stops the tmux process and resumes the conversation on json-stream: its process 7 is idle and lists nothing unread.
    threadAdapter = { checkIsActive: () => true, checkIsBusy: () => false, checkHasUnconsumedInput: () => false, getProcessGeneration: () => 7 };
    probe = readProbe(topicKey);
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 1, 'decided at the new process\'s idle, not held');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined, 'not read off a process it was not written to');
    assert.deepEqual(wakeUpMessages, [{ reason: 'silentTurn', text: prompt, isRequestPrompt: true }], 'its wake posts the prompt again');
  });

  it('a request prompt whose process went down for a re-spawn between its write and its track is named from the write: decided at the new process\'s idle and posted again, never held as «never written» (review 22 nit 2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    // Written into process 5 (the write choke point stamps it)…
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false, processGeneration: 5 };
    engine.noteWrite(topicKey);
    // …then a re-spawn takes 5 down before the post's track reads the probe: no live process, no window.
    probe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    // Process 6 is up, idle, with nothing unread: the prompt died with 5.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 6 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 1, 'decided at 6\'s idle, not held for the stale drop');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);
    assert.deepEqual(wakeUpMessages, [{ reason: 'silentTurn', text: prompt, isRequestPrompt: true }], 'its wake posts the prompt again');
  });

  it('a cancelled conversation\'s write stamp goes with it: a watch of the next conversation tracked while no process is live and no window holds its prompt names no process — never read as written into the one before, so not decided at the next idle as its silent turn (review 23 nit 6, review 24 nit 6)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    // The conversation's last write, into process 5; then the conversation ends (`/new`, a release).
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 5 };
    engine.noteWrite(topicKey);
    await engine.cancelConversation(topicKey);
    // The next conversation's request, tracked with no live process and no window — the case the stamp names a watch from.
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 6 };
    await engine.deliverOrHandOverWake(topicKey, await engine.settleEndedTurnsOf(topicKey));
    // Named from a stamp of 5, it would read 6's idle as the end of a turn its prompt died in (the re-spawn case above): a silent turn,
    // posted again. Unnamed, it is a prompt never written, which an idle does not decide.
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0, 'not decided as a silent turn');
    assert.deepEqual(wakeUpMessages, [], 'nothing posted again');
  });

  it('a prompt tracked while a window holds it is never named from an earlier write: its replay names it (review 22 nit 2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 5 };
    engine.noteWrite(topicKey);
    // A stop's window opens; the prompt waits in it.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true, isWindowOpen: true };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true, isPersonInput: true });
    // The replay writes it into process 7, which takes it in.
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true, processGeneration: 7 };
    engine.noteReplayedWrite(topicKey);
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 7 };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true, 'named 7 by the replay, not 5 by the earlier write');
  });

  it('a backend that cannot tell its processes apart is read as before', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } }, { createPrompt: () => prompt });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: true, isTurnEndBlocked: false };
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, true);
  });

  it('a reminder\'s turn never marks the prompt taken in; a request without a prompt is reminded as before', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const withPrompt = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await engine.trackForwardedTurn(topicKey, withPrompt.id);
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPromptTakenIn, undefined);

    const plain = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns(); // the superseded request's watch goes
    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.equal(wakeUpMessages.at(-1)?.isRequestPrompt, false);
    assert.match(wakeUpMessages.at(-1)?.text ?? '', new RegExp(`request ${plain.id} is still open`));
  });
});

describe('a request whose post failed is retried soon, outside the wake-up cap (R28)', () => {
  const prompt = '[Request · from: PROJ-12]\nThe whole request text.';
  const minuteMs = 60 * 1000;

  async function createFailedPost(ledger: RequestLedger, engine: RequestWakeUpEngine): Promise<OpenRequestState> {
    const request = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await engine.notePostFailed(topicKey, request.id);
    return request;
  }

  it('the prompt is posted again a minute later, under its own reason, without spending a wake-up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await createFailedPost(ledger, engine);
    nowMs += minuteMs - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUpMessages, [], 'not due yet');

    nowMs += 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUpMessages, [{ reason: 'postRetry', text: prompt, isRequestPrompt: true }]);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.wakeCount, 0);
  });

  it('a test instance\'s first retry delay posts it again that much later; a retry that fails again still waits 5 minutes', async () => {
    const firstPostRetryDelayMs = 5_000;
    const ledger = await createLedger();
    const engine = createEngine(ledger, { firstPostRetryDelayMs });
    await createFailedPost(ledger, engine);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextPostRetryAt, nowMs + firstPostRetryDelayMs, 'armed at the shorter delay');
    nowMs += firstPostRetryDelayMs - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUpMessages, [], 'not due yet');

    isWakeUpDeliverable = false;
    nowMs += 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(preparedFor.map((message) => message.reason), ['postRetry'], 'tried at the shorter delay — and failed again');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextPostRetryAt, nowMs + 5 * minuteMs, 'only the first delay is shortened');
  });

  it('a retry that fails again tries after 5, then 15 minutes, with no alert; then the backstop takes over', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await createFailedPost(ledger, engine);
    isWakeUpDeliverable = false;
    for (const delayMs of [minuteMs, 5 * minuteMs, 15 * minuteMs]) {
      nowMs += delayMs;
      await engine.sweepUnwatchedRequests();
    }
    // Not `deepEqual(alerts, [])`: it would narrow `alerts` to `never[]` for the reasons read below.
    assert.equal(alerts.length, 0, 'a retry is not a reminder the agent ignored');
    const spent = ledger.getNewestOpenRequest(topicKey);
    assert.equal(spent?.postRetryCount, 3);
    assert.equal(spent?.nextPostRetryAt, undefined);
    assert.equal(spent?.isWakeStopped, false);

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(alerts.map((alert) => alert.reason), ['wakeFailed'], 'the backstop\'s own failure alerts as before');
  });

  it('the session is prepared for the request\'s own prompt — what lets a tracker start one when none ever came up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await createFailedPost(ledger, engine);
    nowMs += minuteMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(preparedFor.map((message) => [message.reason, message.isRequestPrompt]), [['postRetry', true]]);
  });

  it('a retry still pending when the prompt reaches the session another way — a limit resume — never fires', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createFailedPost(ledger, engine);
    await engine.trackContinuationTurn(topicKey, { isCountersReset: true, carriedRequestIds: [request.id] });
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextPostRetryAt, undefined);

    // The resumed turn sends a progress note and ends: the follow-up is the next wake-up, not a retry.
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    nowMs += minuteMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);
    nowMs += progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'progressFollowUp' }]);
  });

  it('a request already gone or replaced is not scheduled', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const first = await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} }, { createPrompt: () => prompt });
    await engine.notePostFailed(topicKey, first.id);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextPostRetryAt, undefined);
  });
});

describe('a request whose first post is still starting its session (J7b)', () => {
  /** The REAL probe over a scripted adapter: until its start ends the session is not up. */
  function probeSession(isStarting: boolean): SessionTurnProbe {
    return createSessionTurnProbe({
      getAdapter: () => ({ checkIsActive: () => !isStarting, checkIsBusy: () => false }),
      checkHasPendingQuestion: () => false,
      checkHasQuestionPin: () => false,
      checkIsCompacting: () => false,
      getApiRetryTimer: () => undefined,
      checkIsWedgeRecoveryInFlight: () => false,
      checkIsRetryKickInFlight: () => false,
      checkIsApiErrorInHandling: () => false,
      checkIsSessionStarting: () => isStarting,
      checkIsReplayingBufferedPrompts: () => false,
      serializeKey: keyToString,
    })(topicKey);
  }

  it('the sweep leaves it alone however old it is — no wake-up, no alert — and takes it once the start is over', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    // Older than the backstop window — a short window and a slow start meet exactly here.
    nowMs += 2 * backstopMs;

    probe = probeSession(true);
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'its post is starting the session: nothing has gone quiet');
    assert.equal(alerts.length, 0);
    assert.equal(preparedFor.length, 0, 'no resume or start was attempted on top of the one under way');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.wakeCount, 0);

    // The control: the same request, the same age, the start over and nothing seen on it — due.
    probe = probeSession(false);
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
  });

  it('a nudge buffered while the session starts keeps its watch: the replayed turn is judged by the watch, not left to the backstop', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    // The limit resume's "continue" nudge went into the startup buffer; the watch is registered now,
    // while the session is not up yet (the real probe over a starting session).
    probe = probeSession(true);
    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'a start under way is a hold, not a dead session');

    // The session is up, the nudge replayed and taken in, its turn runs — then ends silent.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the watch survived the start and saw the turn end');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 1);
  });
});

describe('the tail after a final answer, where the view hides the stream', () => {
  /** The answer-tail reminders forwarded, by conversation. */
  let tailReminders: Array<{ key: string; text: string }>;
  let isTailWatched: boolean;
  let isTailRemindable: boolean;

  function createTailEngine(ledger: RequestLedger): RequestWakeUpEngine {
    tailReminders = [];
    isTailWatched = true;
    isTailRemindable = true;
    return new RequestWakeUpEngine({
      ledger,
      probeTurn: () => probe,
      prepareWakeUpSession: async () => true,
      forwardWakeUp: recordWakeUp,
      deliverAlert: async () => null,
      backstopMs,
      checkIsAnswerTailWatched: () => isTailWatched,
      remindAnswerTail: async (key, text) => {
        if (isTailRemindable) tailReminders.push({ key: keyToString(key), text });
        return isTailRemindable;
      },
      now: () => nowMs,
    });
  }

  /** A request answered with a final, its turn still running. */
  async function answerFinal(ledger: RequestLedger, engine: RequestWakeUpEngine): Promise<OpenRequestState> {
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await ledger.closeRequest(request.id, 'final');
    engine.noteAnswerDelivered(topicKey, request.id, 'final');
    return request;
  }

  /** The agent writes one message `afterMs` from now. */
  function writeAfter(engine: RequestWakeUpEngine, afterMs: number): void {
    nowMs += afterMs;
    engine.noteAnswerTailOutput(topicKey);
  }

  async function endTurn(engine: RequestWakeUpEngine): Promise<void> {
    probe = { ...probe, isBusy: false };
    await engine.sweepUnwatchedRequests();
  }

  it('two more messages after the answer: a reminder at the turn end, naming the request; its replies are followed up to the cap', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    const request = await answerFinal(ledger, engine);
    writeAfter(engine, 2_000);
    writeAfter(engine, 15_000);

    await engine.sweepUnwatchedRequests();
    assert.equal(tailReminders.length, 0, 'never while the turn runs');
    await endTurn(engine);
    assert.equal(tailReminders.length, 1);
    assert.equal(tailReminders[0].key, keyToString(topicKey));
    assert.match(tailReminders[0].text, new RegExp(`after your final answer to request ${request.id}`));

    // The agent sends what mattered and goes on writing (a background job's result comes later): followed again.
    for (let reminder = 2; reminder <= 4; reminder++) {
      engine.noteAnswerDelivered(topicKey, request.id, 'final');
      writeAfter(engine, 60_000);
      await endTurn(engine);
    }
    assert.equal(tailReminders.length, 3, 'three reminders per answered request, never a loop');

    // Another request's answer has its own count.
    const next = await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    await endTurn(engine);
    assert.equal(tailReminders.length, 4);
    assert.match(tailReminders[3].text, new RegExp(next.id));
    assert.deepEqual(wakeUps, [], 'a tail reminder is not a wake-up of an open request');
  });

  it('one message later than 30 s is enough', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    await answerFinal(ledger, engine);
    writeAfter(engine, 5 * 60_000);
    await endTurn(engine);
    assert.equal(tailReminders.length, 1);
  });

  it('a closing line right after the answer is no tail, and the tail goes once the session stopped', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    await answerFinal(ledger, engine);
    writeAfter(engine, 2_000);
    await endTurn(engine);
    probe = { ...probe, isActive: false };
    await engine.sweepUnwatchedRequests();
    // Text that comes after the stop (a later session) is not this answer's tail any more.
    probe = { ...probe, isActive: true };
    writeAfter(engine, 60_000);
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(tailReminders, []);
  });

  it('a turn that keeps looking busy is reminded after 30 quiet minutes, not before', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    nowMs += 30 * 60_000 - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(tailReminders, []);
    nowMs += 1;
    await engine.sweepUnwatchedRequests();
    assert.equal(tailReminders.length, 1);
  });

  it('any later answer ends the tail; a new request takes over from it', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    const request = await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    engine.noteAnswerDelivered(topicKey, request.id, 'progress');
    await endTurn(engine);
    assert.deepEqual(tailReminders, [], 'the agent spoke to the requester after it wrote');

    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    const next = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, next.id);
    await endTurn(engine);
    assert.deepEqual(tailReminders, [], 'what the agent writes now is owed to the open request');
  });

  it('a person taking over, a view that shows the stream, or an unreachable session: no reminder, no retry', async () => {
    const ledger = await createLedger();
    const engine = createTailEngine(ledger);
    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    await engine.cancelConversation(topicKey);
    await endTurn(engine);
    assert.deepEqual(tailReminders, [], 'taken over');

    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    isTailWatched = false;
    await endTurn(engine);
    assert.deepEqual(tailReminders, [], 'switched to a view with the stream');

    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    assert.deepEqual(tailReminders, [], 'not watched when the answer came');
    isTailWatched = true;
    await answerFinal(ledger, engine);
    writeAfter(engine, 60_000);
    isTailRemindable = false;
    await endTurn(engine);
    await endTurn(engine);
    assert.deepEqual(tailReminders, [], 'unreachable, and not tried again');
  });
});

describe('the sweep timer', () => {
  /** The wake-ups of one request (a function: the asserts above narrow the shared list itself). */
  const listWakeUpsOf = (requestId: string): Array<{ requestId: string; reason: RequestWakeUpReason }> => wakeUps.filter((wakeUp) => wakeUp.requestId === requestId);
  /** Let the sweep a timer tick started run to its end (its awaits are real promises). */
  const settleSweep = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it('started, it sweeps on the production minute, or on the shorter interval a test instance sets', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const engines: RequestWakeUpEngine[] = [];
    try {
      const testSweepIntervalMs = 5_000;
      const shortLedger = await createLedger();
      const defaultLedger = await createLedger();
      const shortEngine = createEngine(shortLedger, { sweepIntervalMs: testSweepIntervalMs });
      const defaultEngine = createEngine(defaultLedger);
      engines.push(shortEngine, defaultEngine);
      const shortRequest = await shortLedger.createRequest(topicKey, { kind: 'message', attributes: {} });
      const defaultRequest = await defaultLedger.createRequest(topicKey, { kind: 'message', attributes: {} });
      nowMs += backstopMs;
      shortEngine.start();
      defaultEngine.start();

      mock.timers.tick(testSweepIntervalMs - 1);
      await settleSweep();
      assert.deepEqual(wakeUps, [], 'no sweep before the interval');
      mock.timers.tick(1);
      await settleSweep();
      assert.deepEqual(wakeUps, [{ requestId: shortRequest.id, reason: 'backstop' }], 'the shorter interval swept its backstopped request; the default one did not yet');
      mock.timers.tick(unwatchedSweepMs - testSweepIntervalMs);
      await settleSweep();
      assert.deepEqual(listWakeUpsOf(defaultRequest.id), [{ requestId: defaultRequest.id, reason: 'backstop' }], 'the production minute swept the other');
    } finally {
      for (const engine of engines) engine.stop();
      mock.timers.reset();
    }
  });
});

describe('the restart wake: a tracker conversation whose process was found gone resumes its open requests at once, not at the backstop', () => {
  const issueKey = makeJiraKey('PROJ-1');
  const otherIssueKey = makeJiraKey('PROJ-2');
  const handOver = (requester: string) => ({ kind: 'trackerEvent' as const, attributes: { issueKey: 'PROJ-1', triggerId: '100', requester } });
  /** The session as a boot leaves it: the process gone, the conversation asleep. */
  const goneProbe: SessionTurnProbe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false };

  it('a request whose prompt was taken in gets the restarted reminder; one that never was gets its prompt again (R21) — in ONE forward, every request watched', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    probe = goneProbe;
    const takenIn = await ledger.createRequest(issueKey, handOver('ann'), { createPrompt: (id) => `[Request ${id} · from: PROJ-1 assigned to you by Ann]` });
    await ledger.updateOpenRequest(takenIn.id, { isPromptTakenIn: true });
    const neverRead = await ledger.createRequest(issueKey, handOver('bob'), { createPrompt: (id) => `[Request ${id} · from: PROJ-1 assigned to you by Bob]` });
    await engine.wakeAfterRestart(issueKey);
    assert.equal(wakeUpMessages.length, 1, 'one forward for the conversation');
    const [message] = wakeUpMessages;
    assert.equal(message.reason, 'restarted');
    assert.ok(message.text.includes(`[Reminder · request ${takenIn.id} is still open]`), message.text);
    assert.ok(message.text.includes('Your session ended and was resumed while you were working on it (the bot or your process restarted); carry on.'), message.text);
    assert.ok(message.text.includes(`[Request ${neverRead.id} · from: PROJ-1 assigned to you by Bob]`), 'the unread prompt again, not a reminder of it');
    assert.equal(message.isRequestPrompt, true, 'a request prompt rides it, so a session may be started for it');
    assert.deepEqual(preparedFor.map((prepared) => prepared.reason), ['restarted']);
    for (const request of ledger.listOpenRequestsOf(issueKey)) {
      assert.equal(request.wakeCount, 1, 'it counts against the cap');
      assert.equal(request.lastTurnActivityAt, nowMs, 'the backstop counts from now');
    }
    // The one turn it starts is watched for both: a silent end wakes both, at once.
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps.slice(1).map((wakeUp) => [wakeUp.requestId, wakeUp.reason]).sort(), [[takenIn.id, 'silentTurn'], [neverRead.id, 'silentTurn']].sort());
  });

  it('leaves alone a request with its own next step or none at all: a post retry, a progress follow-up, a give-up, a limit stop — and a session that works or is blocked', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver('ann'));
    probe = goneProbe;
    for (const update of [{ nextPostRetryAt: nowMs + 60_000 }, { nextWakeAt: nowMs + progressFollowUpDelayMs }, { isWakeStopped: true }, { isLimitStopped: true }]) {
      await ledger.updateOpenRequest(request.id, update);
      await engine.wakeAfterRestart(issueKey);
      assert.deepEqual(wakeUps, [], JSON.stringify(update));
      await ledger.updateOpenRequest(request.id, { nextPostRetryAt: undefined, nextWakeAt: undefined, isWakeStopped: false, isLimitStopped: undefined });
    }
    for (const working of [{ ...goneProbe, isActive: true, isBusy: true }, { ...goneProbe, isTurnEndBlocked: true }]) {
      probe = working;
      await engine.wakeAfterRestart(issueKey);
      assert.deepEqual(wakeUps, [], JSON.stringify(working));
    }
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps.map((wakeUp) => wakeUp.reason), ['restarted'], 'with nothing of its own, it is woken');
  });

  it('a request the engine already watches (a prompt that reached the session meanwhile) is not woken again', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver('ann'));
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: false };
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, []);
  });

  it('it counts toward the cap: a request at its last wake gets the cap alert, not an eleventh wake', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver('ann'));
    await ledger.updateOpenRequest(request.id, { wakeCount: maxWakeUpsPerRequest });
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'wakeCap' }]);
  });

  it('a resume that fails, or a request answered while the session came up, forwards nothing — and raises no alert: the backstop takes it', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver('ann'));
    probe = goneProbe;
    isWakeUpDeliverable = false;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getOpenRequestById(request.id)?.request.isWakeStopped, false, 'still wakeable by the backstop');

    isWakeUpDeliverable = true;
    duringWakeUpResume = async () => {
      await ledger.closeRequest(request.id, 'final');
    };
    nowMs += restartWakeStaggerMs;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, [], 'answered meanwhile: nothing to remind');
  });

  it('scheduled per conversation, a stagger apart and the first a stagger after the boot; a second call while one waits changes nothing; the delivery is noted', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: nowMs });
    const delivered: string[] = [];
    const engines: RequestWakeUpEngine[] = [];
    try {
      const ledger = await createLedger();
      const engine = createEngine(ledger, { restartWakeStaggerMs: 30_000, noteRestartWakeDelivered: (key) => delivered.push(keyToString(key)) });
      engines.push(engine);
      await ledger.createRequest(issueKey, handOver('ann'));
      await ledger.createRequest(otherIssueKey, { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-2', triggerId: '200', requester: 'ann' } });
      probe = goneProbe;
      assert.equal(engine.scheduleRestartWake(issueKey), true);
      assert.equal(engine.scheduleRestartWake(otherIssueKey), true);
      assert.equal(engine.scheduleRestartWake(issueKey), false, 'one wake per conversation at a time');

      mock.timers.tick(29_999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(wakeUps, [], 'nothing before the first stagger: the connector\'s first poll goes first');
      mock.timers.tick(1);
      for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(wakeUps.length, 1, 'the first conversation, alone');
      assert.deepEqual(delivered, ['jira:PROJ:PROJ-1']);
      mock.timers.tick(30_000);
      for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(wakeUps.length, 2, 'the second, a stagger later');
      assert.deepEqual(delivered, ['jira:PROJ:PROJ-1', 'jira:PROJ:PROJ-2']);
    } finally {
      for (const engine of engines) engine.stop();
      mock.timers.reset();
    }
  });
  it('a process that ended with the agent\'s OWN work pending wakes a request a passing watch holds — once, the watch notwithstanding; a boot does not', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: nowMs });
    const engines: RequestWakeUpEngine[] = [];
    try {
      const ledger = await createLedger();
      const engine = createEngine(ledger, { restartWakeStaggerMs: 30_000, getScheduleWait: () => 'watching' });
      engines.push(engine);
      const request = await ledger.createRequest(issueKey, handOver('ann'));
      await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
      probe = goneProbe;

      assert.equal(engine.scheduleRestartWake(issueKey), false, 'a boot: held by the watch, nobody is woken');
      assert.equal(engine.scheduleRestartWake(issueKey, { isLostWork: true }), true, 'the agent\'s own work died with the process: scheduled');
      mock.timers.tick(30_000);
      for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'restarted' }], 'woken once, the lost-work note rides this wake');
      assert.equal(ledger.getNewestOpenRequest(issueKey)?.wakeCount, 1, 'it counts against the wake-up cap like any wake');

      // The wake\'s turn: nothing is owed and the watch passes — the agent reads the note and may stay silent.
      await endTurnSilently(engine);
      assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'restarted' }], 'a quiet end: no reminder for it');
      assert.deepEqual(alerts, []);
      assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);
    } finally {
      for (const engine of engines) engine.stop();
      mock.timers.reset();
    }
  });

  it('the lost-work wake of a request a passing watch holds is worded like the fire header: answer only with what the requester must know; every other wake keeps the plain «answer it»', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const held = await ledger.createRequest(issueKey, handOver('ann'));
    await ledger.updateOpenRequest(held.id, { progressAnswerCount: 1 });
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey, { isLostWork: true });
    assert.equal(wakeUpMessages.length, 1);
    assert.equal(wakeUpMessages[0].isAnswerOptional, true, 'nothing is owed and the watch passes: the answer is optional');
    assert.ok(wakeUpMessages[0].text.includes('only with what the requester must know'), wakeUpMessages[0].text);
    assert.ok(!wakeUpMessages[0].text.includes('kind "final" if the work is done'));

    // A request that owes an answer is woken with the plain reminder, a lost-work loss or not.
    wakeUpMessages = [];
    await endTurnSilently(engine);
    const owed = await ledger.createRequest(issueKey, handOver('bob'));
    await ledger.updateOpenRequest(owed.id, { progressAnswerCount: 1, isPersonInputUnanswered: true });
    await engine.wakeAfterRestart(issueKey, { isLostWork: true });
    const mixed = wakeUpMessages.at(-1);
    assert.equal(mixed?.isAnswerOptional, undefined, 'one of the two requests is owed an answer: the forward is not optional as a whole');
    assert.ok(mixed?.text.includes('kind "final" if the work is done'), 'bob\'s reminder says «answer it»');
    assert.ok(mixed?.text.includes('only with what the requester must know'), 'ann\'s reminder keeps its own wording');
  });

  it('a follow-up a passing watch holds does not keep the lost-work wake away: a note in its own fire\'s turn under `armed`, the watch passes again, the process dies with its own work pending → woken once, the answer optional (review 14 #2)', async () => {
    const ledger = await createLedger();
    let wait: RequestScheduleWait = 'armed';
    const engine = createEngine(ledger, { getScheduleWait: () => wait });
    const held = await ledger.createRequest(issueKey, handOver('ann'));
    await ledger.updateOpenRequest(held.id, { progressAnswerCount: 1 });
    // The watch fired «silent» during a long compile; its fire rides the hand-over, the agent answers «still running» and keeps the watch.
    await engine.trackForwardedTurn(issueKey, held.id, { isRequestPrompt: false, isScheduledRun: true, isRequestJob: true });
    await ledger.updateOpenRequest(held.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.notEqual(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, undefined, 'a note under a watch that fired: followed up');
    // The compile prints again: the check passes, the watch holds the request — its follow-up will never fire.
    wait = 'watching';
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey, { isLostWork: true });
    assert.deepEqual(getWakeUpReasons(), ['restarted'], 'the lost-work wake still comes');
    assert.equal(wakeUpMessages[0].isAnswerOptional, true);
  });

  it('a lost-work wake that wakes nobody says so in the log — the bot already promised the wake', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const stopped = await ledger.createRequest(issueKey, handOver('ann'));
    await ledger.updateOpenRequest(stopped.id, { isWakeStopped: true });
    probe = goneProbe;
    const logged: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => { logged.push(parts.join(' ')); };
    try {
      await engine.wakeAfterRestart(issueKey, { isLostWork: true });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(wakeUps, []);
    assert.ok(logged.some((line) => line.includes('lost-work wake') && line.includes('woke no request')), logged.join('\n'));
  });

  it('a wake with no lost-work loss behind it — the unheld request of a boot — is the plain reminder', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    await ledger.createRequest(issueKey, handOver('ann'));
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.equal(wakeUpMessages.length, 1);
    assert.notEqual(wakeUpMessages[0].isAnswerOptional, true);
    assert.ok(!wakeUpMessages[0].text.includes('only with what the requester must know'));
  });

  it('a loss that comes while a boot wake already waits turns that wake into a lost-work one: the request a watch holds is woken with the others', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: nowMs });
    const engines: RequestWakeUpEngine[] = [];
    try {
      const ledger = await createLedger();
      const engine = createEngine(ledger, {
        restartWakeStaggerMs: 30_000,
        getScheduleWait: (_key, request) => (request.origin.attributes.requester === 'ann' ? 'watching' : 'none'),
      });
      engines.push(engine);
      const held = await ledger.createRequest(issueKey, handOver('ann'));
      await ledger.updateOpenRequest(held.id, { progressAnswerCount: 1 });
      const unheld = await ledger.createRequest(issueKey, handOver('bob'));
      probe = goneProbe;
      assert.equal(engine.scheduleRestartWake(issueKey), true, 'a boot wake: bob\'s request is not held');
      assert.equal(engine.scheduleRestartWake(issueKey, { isLostWork: true }), false, 'one wake per conversation at a time');
      mock.timers.tick(30_000);
      for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
      const wakeCounts = new Map(ledger.listOpenRequestsOf(issueKey).map((request) => [request.id, request.wakeCount]));
      assert.equal(wakeCounts.get(unheld.id), 1);
      assert.equal(wakeCounts.get(held.id), 1, 'the loss was remembered: ann\'s request, held by its watch, is woken too');
    } finally {
      for (const engine of engines) engine.stop();
      mock.timers.reset();
    }
  });
});

describe('a request waits for its schedule', () => {
  const issueKey = makeJiraKey('PROJ-1');
  const handOver = { kind: 'trackerEvent' as const, attributes: { issueKey: 'PROJ-1', triggerId: '100', requester: 'ann' } };
  const goneProbe: SessionTurnProbe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false };

  it('a progress note with an armed watch: no follow-up, however long it runs — the engine never prods it', async () => {
    const ledger = await createLedger();
    let wait: RequestScheduleWait = 'watching';
    const engine = createEngine(ledger, { getScheduleWait: () => wait });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));

    await endTurnSilently(engine);
    const settled = ledger.getNewestOpenRequest(issueKey);
    assert.equal(settled?.nextWakeAt, undefined, 'no follow-up scheduled');
    assert.equal(settled?.silentTurnCount, 0);
    assert.equal(settled?.lastTurnActivityAt, nowMs);

    nowMs += backstopMs * 3;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'neither a follow-up nor the backstop while the watch holds it');
    assert.deepEqual(alerts, []);

    // The watch is gone (cancelled, ended): the normal rules take the request back — the backstop, counted from the last activity.
    wait = 'none';
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
  });

  it('a turn that ends with no answer while the watch is armed is not silent: no wake, no counter, no alert — turn after turn', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id);
    for (let turn = 0; turn < 3; turn += 1) {
      await endTurnSilently(engine);
      await engine.trackForwardedTurn(issueKey, request.id);
    }
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.wakeCount, 0);
  });

  it('the same silent turn without a watch is woken as before', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'none' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
  });

  it('a scheduled run\'s turn that ends without an answer stays quiet (a woken agent with nothing to report); an ordinary one does not', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'two scheduled turns with nothing to report, nothing owed: no wake, no alert');
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);

    await engine.trackForwardedTurn(issueKey, request.id);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'a turn of any other kind is judged as before');
  });

  it('a requester\'s new message that the agent leaves unanswered is woken as a silent turn even while a watch passes — a request prompt and an issue update alike', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the request\'s own prompt: no quiet turn for a person\'s words');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1);

    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'a requester\'s comment, unanswered twice: the rules give up as ever');
  });

  it('the REAL silent-turn chain under a passing watch ends in the give-up alert: the engine\'s own reminder turn keeps counting — a watch never leaves a requester unanswered for good', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the request\'s own prompt, unanswered: the engine sends its silentTurn reminder');
    assert.deepEqual(alerts, []);

    // The reminder's turn was tracked by the engine itself (not a request prompt, no person input) and ends silently too.
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the second silence gives up, as without a watch');
    assert.equal(wakeUps.length, 1, 'no third wake');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isWakeStopped, true);
  });

  // The scheduler's request (a Telegram topic's `scheduledRun`, `src/requests/README.md` § Scheduled runs): the fire that opens it
  // tracks its turn as the request's own prompt AND a scheduled run (the topic settler); a later fire RIDES it (`isScheduledRun`, no
  // prompt) — a fire never replaces it while it lives. Reports 9–11 are its cases.
  const fireOrigin = { kind: 'scheduledRun' as const, attributes: { requester: 'scheduler' } };
  const fireOpening = { isRequestPrompt: true, isScheduledRun: true } as const;
  const fireRiding = { isRequestPrompt: false, isScheduledRun: true } as const;

  it('the scheduler\'s request a fire opened, left with no answer, closes silently — no reminder, no alert, no backstop', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'no silentTurn reminder for an alarm nobody was told about');
    assert.deepEqual(alerts, []);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), [], 'closed at its quiet end: nothing waits for it, nothing is woken at the backstop');
    const closed = ledger.getRequest(fireRequest.id);
    assert.equal(closed && !closed.isOpen ? closed.request.closeReason : null, 'cancelled', 'cancelled: nothing was answered, nothing is posted');
    nowMs += 2 * backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);
  });

  it('never answered, it closes at the end of ANY of its turns: the backstop\'s reminder after a lost turn ends silent → closed, not chased', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await ledger.updateOpenRequest(fireRequest.id, { isPromptTakenIn: true });
    // The fire's turn was lost (a restart): only the persisted request is left, and the backstop reminds it.
    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(getWakeUpReasons(), ['backstop']);
    await endTurnSilently(engine);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), [], 'the reminder\'s silent end closes it: nobody was ever told anything');
    assert.deepEqual(getWakeUpReasons(), ['backstop'], 'no silentTurn reminder');
    assert.deepEqual(alerts, []);
  });

  it('a progress note keeps it open (the agent said something); an ordinary request\'s silent turn is still woken', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.equal(ledger.listOpenRequestsOf(topicKey).length, 1, 'the request stays open');

    const ordinary = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    await engine.trackForwardedTurn(topicKey, ordinary.id, { isRequestPrompt: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: ordinary.id, reason: 'silentTurn' }]);
  });

  it('answered `progress`, it is an ordinary answered request: its follow-up reminder ending silent is a silent turn, then the give-up — never a silent close (report 9)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    // «Found a broken migration, fixing it»: the real update of a progress answer, then the turn ends — a follow-up is due in 15 minutes.
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.equal(ledger.listOpenRequestsOf(topicKey).length, 1, 'the request stays open');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextWakeAt, nowMs + progressFollowUpDelayMs);

    nowMs += progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(getWakeUpReasons(), ['progressFollowUp']);
    // The follow-up reminder\'s turn: the agent lost the thread and says nothing. The operator was told «working on it»: not a quiet end.
    await endTurnSilently(engine);
    assert.equal(ledger.listOpenRequestsOf(topicKey).length, 1, 'still open: nothing closed it silently');
    assert.deepEqual(getWakeUpReasons(), ['progressFollowUp', 'silentTurn'], 'a reminder for the silence');
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: fireRequest.id, reason: 'silentTurns' }], 'the second silence tells the operator, as for any answered request');
  });

  it('the watch armed under it fires and RIDES it: the agent that handled the alarm and ended silent is quiet under `armed` — not reminded, not closed — and the backstop takes it as on a Jira hand-over (reports 10 and 11 #2)', async () => {
    const ledger = await createLedger();
    let wait: RequestScheduleWait = 'watching';
    const engine = createEngine(ledger, { getScheduleWait: () => wait });
    // The recipe: a fire opens the scheduler's request, the agent arms a watch under it, answers `progress`, ends the turn.
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'held by the watch');

    // The watch's check fails (`armed`): its fire rides the same request — no new one is opened.
    wait = 'armed';
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireRiding);
    await endTurnSilently(engine);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey).map((open) => open.id), [fireRequest.id], 'the operator\'s «working on it» stands: the request stays open');
    assert.deepEqual(wakeUps, [], 'no reminder: the agent restarted the worker and said nothing, as it may');
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextWakeAt, undefined, 'the quiet end under the watch clears any follow-up');

    // Nobody re-armed and the check keeps failing: the backstop reminds it, and that reminder is an ordinary silent turn.
    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(getWakeUpReasons(), ['backstop']);
    await endTurnSilently(engine);
    assert.deepEqual(getWakeUpReasons(), ['backstop', 'silentTurn']);
  });

  it('an unrelated job\'s fire rides the answered request too: its own silent end is quiet, but the progress follow-up still chases the request (report 10)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    const followUpAt = ledger.getNewestOpenRequest(topicKey)?.nextWakeAt;
    assert.equal(followUpAt, nowMs + progressFollowUpDelayMs);

    // An hourly «check X» fires with nothing to report.
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireRiding);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'the fire\'s turn is quiet');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextWakeAt, followUpAt, 'an unrelated alarm leaves the follow-up alone');
    nowMs += progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    await endTurnSilently(engine);
    assert.deepEqual(getWakeUpReasons(), ['progressFollowUp', 'silentTurn'], 'the request the operator was told about is still chased');
  });

  it('a second fire that joins its RUNNING turn rides it: a progress note sent then keeps it open and is followed up — not a silent close (report 11 #3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    // The next fire waited for the busy session, then was forwarded into the turn still running: it rides the same request.
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireRiding);
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey).map((open) => open.id), [fireRequest.id], 'answered in the merged turn: it stays open');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.nextWakeAt, nowMs + progressFollowUpDelayMs, 'followed up as any progress note');
  });

  it('after the bot gave up on it, the next fire\'s new request replaces it and carries nothing over: its silent end closes it silently — no reminder, no second alert (report 11 #1)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const answered = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, answered.id, fireOpening);
    await ledger.updateOpenRequest(answered.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    nowMs += progressFollowUpDelayMs;
    await engine.sweepUnwatchedRequests();
    await endTurnSilently(engine);
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: answered.id, reason: 'silentTurns' }], 'the operator was told it could not finish');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isWakeStopped, true);

    // An hour later an unrelated job fires with nothing to report: the given-up request is ridden by nothing, so a new one opens.
    const next = await ledger.createRequest(topicKey, fireOrigin);
    assert.deepEqual(next.supersededRequestIds, [answered.id]);
    const wakesBefore = wakeUps.length;
    await engine.trackForwardedTurn(topicKey, next.id, fireOpening);
    await endTurnSilently(engine);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), [], 'closed silently: nobody was told anything about this run');
    assert.equal(wakeUps.length, wakesBefore, 'no reminder');
    assert.deepEqual(alerts, [{ requestId: answered.id, reason: 'silentTurns' }], 'no second «could not finish»');
  });

  it('the continuation variant: answered `progress` in the fire\'s turn, then an API error and the bot\'s «continue» ending silent — the fire\'s turn stays quiet and the request open; the backstop\'s reminder is then a silent turn (report 9)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await ledger.updateOpenRequest(fireRequest.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.equal(ledger.listOpenRequestsOf(topicKey).length, 1, 'answered earlier: the silent continuation does not close it');
    assert.deepEqual(wakeUps, [], 'a «continue» keeps the fire\'s kind, as on a Jira hand-over');
    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    await endTurnSilently(engine);
    assert.deepEqual(getWakeUpReasons(), ['backstop', 'silentTurn'], 'the operator was told «working on it»: a later silence is chased');
  });

  it('never answered, it is still closed through a «continue»: closed silently when the agent has nothing to report', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
    await engine.trackForwardedTurn(topicKey, fireRequest.id, fireOpening);
    await engine.trackContinuationTurn(topicKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(ledger.listOpenRequestsOf(topicKey), [], 'nothing was ever answered: settled');
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(alerts, []);
  });

  it('a fire that waited behind a person\'s turn joins it, never takes it over: the unanswered request prompt is still a silent turn, the reminder chain still ends in the alert', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    // The fire's post waited for the busy session and was forwarded into the turn that was still running: the same request id.
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'a requester\'s prompt left unanswered, the alarm notwithstanding');
    assert.deepEqual(alerts, []);
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the reminder chain gives up as ever');
  });

  it('the same for a requester\'s issue update and for the engine\'s own reminder turn: a fire that joined them does not wash their words or their count out', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'an issue update, joined by a fire: still a person\'s turn');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1);

    // The reminder's own turn is on; a fire is forwarded into it before it ends: the pending count must survive the fire.
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the count kept growing: the merged turn is not the alarm\'s');
  });

  it('a fire\'s turn on a request that owes a person an answer is a silent turn, not the alarm\'s quiet one: the reminder names the request, the next silence gives up — a recurring job never keeps the requester unanswered', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    // The person's turn was lost to a restart: nothing is tracked, the words are still owed (persisted).
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, isPersonInputUnanswered: true });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the fire says nothing about the comment: reminded, as the backstop would have');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1);

    // The next fire joins the reminder\'s turn and the turn ends silent again: the give-up.
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isWakeStopped, true);
  });

  it('a fire\'s turn with a silent turn pending counts it too — after a restart during the engine\'s own reminder the fire\'s silence gives up at once, and a fire on an answered request stays quiet', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, silentTurnCount: 1, wakeCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);

    const other = await ledger.createRequest(issueKey, { ...handOver, attributes: { ...handOver.attributes, requester: 'bob' } });
    await ledger.updateOpenRequest(other.id, { progressAnswerCount: 1 });
    wakeUps = [];
    alerts = [];
    await engine.trackForwardedTurn(issueKey, other.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'nothing owed to bob: the woken agent may stay silent');
    assert.deepEqual(alerts, []);
  });
  it('a person\'s turn whose watch the engine lost (a restart) is taken back by the backstop although a watch passes — a request prompt and an issue update alike, down to the give-up', async () => {
    for (const person of [{ isRequestPrompt: true }, { isRequestPrompt: false, isPersonInput: true }]) {
      wakeUps = [];
      alerts = [];
      const ledger = await createLedger();
      const before = createEngine(ledger, { getScheduleWait: () => 'watching' });
      const request = await ledger.createRequest(issueKey, handOver);
      await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
      await before.trackForwardedTurn(issueKey, request.id, person);
      assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true, 'the person\'s words are owed an answer, on the persisted request');
      before.stop();

      // The restart: the in-memory watch is gone, the new engine has the persisted request only.
      const after = createEngine(ledger, { getScheduleWait: () => 'watching' });
      probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
      nowMs += backstopMs - 1;
      await after.sweepUnwatchedRequests();
      assert.deepEqual(wakeUps, [], 'not before the backstop');
      nowMs += 1;
      await after.sweepUnwatchedRequests();
      assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }], 'the backstop takes the turn back, the passing watch notwithstanding');

      // The backstop's own reminder turn is silent too (no person's words in it, yet an answer is owed): the chain gives up.
      await endTurnSilently(after);
      assert.deepEqual(getWakeUpReasons(), ['backstop', 'silentTurn']);
      await endTurnSilently(after);
      assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the give-up comes');
      after.stop();
    }
  });

  it('the same from a silent turn pending and no watch at all: a restart does not hold the request under a passing watch', async () => {
    const ledger = await createLedger();
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, silentTurnCount: 1, wakeCount: 1, lastTurnActivityAt: nowMs });
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
  });

  it('a person\'s words answered with a progress note are owed no more: the passing watch holds the request again, after a restart too', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    // What `answer_request` does with a progress note: the count rises and the person's words are answered.
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, []);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, undefined);
    engine.stop();

    const restarted = createEngine(ledger, { getScheduleWait: () => 'watching' });
    nowMs += 2 * backstopMs;
    await restarted.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'nothing is owed: the watch holds the request as before');
    assert.equal(restarted.scheduleRestartWake(issueKey), false, 'and no restart wake is even scheduled');
    restarted.stop();
  });

  it('a restart wake is not held by a watch for a conversation that owes a person an answer — the boot schedules it, it wakes the request at once', async () => {
    const ledger = await createLedger();
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, isPersonInputUnanswered: true });
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    assert.equal(engine.scheduleRestartWake(issueKey), true, 'the wake is scheduled');
    engine.stop();
    probe = goneProbe;
    await createEngine(ledger, { getScheduleWait: () => 'watching' }).wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'restarted' }]);
  });

  it('a bot «continue» into a fire\'s turn keeps it the alarm\'s: a woken agent whose turn hit an API error is not reminded for staying silent', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'none' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'still the alarm\'s turn: quiet');
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);
  });

  it('a bot «continue» into a person\'s turn whose words are still unanswered: left unanswered it is still a silent turn — a request prompt and an issue update alike', async () => {
    for (const person of [{ isRequestPrompt: true }, { isRequestPrompt: false, isPersonInput: true }]) {
      wakeUps = [];
      const ledger = await createLedger();
      const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
      const request = await ledger.createRequest(issueKey, handOver);
      await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
      await engine.trackForwardedTurn(issueKey, request.id, person);
      await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
      await endTurnSilently(engine);
      assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], JSON.stringify(person));
      engine.stop();
    }
  });

  it('a continuation after an error does not inherit «progress sent» from before the error: it ends silently → a silent turn, no 15-minute follow-up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'none' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    // The turn sent a progress note, then hit an API error and went idle; the retry nudges it to continue.
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the note was before the error: this turn said nothing');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, undefined, 'no follow-up');
  });

  it('a person\'s words answered with a progress note before an API error are owed no more: under a passing watch the continuation may end silently — no reminder, no give-up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    // The note: what `answer_request` does with a progress answer — the count rises and the person's words are answered.
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'the agent said «waiting for the worker» and ended the turn: nothing is owed');
    assert.deepEqual(alerts, []);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);
  });

  it('a continuation that sends a progress note of its own is a progress turn: the follow-up (no watch) or quiet (a watch) as for any', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'none' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, []);
    assert.notEqual(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, undefined, 'the follow-up of a progress note');
  });

  it('a bot «continue» with no watch left (the restart lost it) starts a plain turn that reads the persisted request: owed → silent, not owed → quiet under a watch', async () => {
    const ledger = await createLedger();
    const owedKey = issueKey;
    const settledKey = makeJiraKey('PROJ-2');
    const owed = await ledger.createRequest(owedKey, handOver);
    await ledger.updateOpenRequest(owed.id, { progressAnswerCount: 1, isPersonInputUnanswered: true });
    const settled = await ledger.createRequest(settledKey, { ...handOver, attributes: { ...handOver.attributes, issueKey: 'PROJ-2' } });
    await ledger.updateOpenRequest(settled.id, { progressAnswerCount: 1 });
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });

    await engine.trackContinuationTurn(owedKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: owed.id, reason: 'silentTurn' }], 'a person\'s words are owed an answer: no quiet turn');

    wakeUps = [];
    await engine.trackContinuationTurn(settledKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'nothing is owed and a watch passes: the agent may say nothing');
  });

  it('an API-error retry\'s «continue» keeps a pending silent turn: the continuation that ends silently is the second one and gives up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, silentTurnCount: 1, wakeCount: 1 });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1, 'the retry does not wipe the count');
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
  });

  it('a requester\'s comment held over a usage-limit wait is owed from the moment it is held: after a restart the wait\'s «continue» that carries it ends silent, not quiet under a watch', async () => {
    const ledger = await createLedger();
    const before = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await before.notePersonInputHeld(issueKey, request.id);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true);
    before.stop();

    const restarted = createEngine(ledger, { getScheduleWait: () => 'watching' });
    await restarted.trackContinuationTurn(issueKey, { isCountersReset: true });
    await endTurnSilently(restarted);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
    await endTurnSilently(restarted);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the chain gives up as ever');
  });

  it('a held comment marks only an open request of that conversation that does not owe it already, and never a scheduler fire\'s own request', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const fireRequest = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } });
    await engine.notePersonInputHeld(topicKey, fireRequest.id);
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.isPersonInputUnanswered, undefined, 'the alarm\'s request owes nobody');
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.notePersonInputHeld(topicKey, request.id);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, undefined, 'another conversation\'s request is not touched');
    await engine.notePersonInputHeld(issueKey, 'req_gone0001');
  });

  it('a progress answer delivered in a turn the restart then lost leaves the request owed no more: the backstop does not take it, the agent waiting on its watch is not given up on', async () => {
    const ledger = await createLedger();
    const before = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    // The first turn on the prompt ended silent: the reminder is out, count 1.
    await before.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await endTurnSilently(before);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1);
    wakeUps = [];

    // In the reminder's turn the agent answers `progress` (the real tool), arms its watch and keeps working — then the bot restarts.
    const sink: AnswerSink = { deliverAnswer: async () => ({ ok: true }), deliverAlert: async () => ({ ok: true }), releaseAlert: async () => {} };
    const outcome = await answerRequest(
      { ledger, answerSinks: new Map([['jira', sink]]) },
      { requestId: request.id, kind: 'progress', body: 'on it', checkIsConversationInScope: (conversationKey) => conversationKey === keyToString(issueKey) },
    );
    assert.equal(outcome.ok, true);
    before.stop();

    const restarted = createEngine(ledger, { getScheduleWait: () => 'watching' });
    nowMs += 2 * backstopMs;
    await restarted.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'answered: nothing is owed, the watch holds the request');
    assert.deepEqual(alerts, []);
    assert.equal(restarted.scheduleRestartWake(issueKey), false);
  });

  it('another request\'s watched turn does not push an owed request\'s backstop ahead: a recurring job\'s fires cannot keep a lost message unanswered for as long as the job lives', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    // The operator's request: its turn was lost to a restart before the agent answered (nothing is watched for it).
    const lost = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    const lostActivityAt = nowMs;
    await ledger.updateOpenRequest(lost.id, { progressAnswerCount: 1, isPersonInputUnanswered: true, lastTurnActivityAt: lostActivityAt });

    // A cron job fires every 30 min for two hours; each fire opens its own request, whose turn is the one watched, and the busy
    // session is sampled by the sweep meanwhile.
    for (let fire = 0; fire < 4; fire += 1) {
      nowMs += 30 * 60 * 1000;
      const fireRequest = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } });
      await engine.trackForwardedTurn(topicKey, fireRequest.id, { isRequestPrompt: true });
      probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
      await engine.sweepUnwatchedRequests();
      await endTurnSilently(engine);
    }
    assert.equal(ledger.listOpenRequestsOf(topicKey).find((request) => request.id === lost.id)?.lastTurnActivityAt, lostActivityAt, 'the fires\' busy time is not the lost request\'s activity');

    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: lost.id, reason: 'backstop' }], 'measured from its own last activity, the backstop takes the owed request back');
  });

  it('the busy session is still the request\'s own activity when nothing else is watched (a long lost turn is not prodded mid-work); with another request\'s turn watched it is that turn\'s, whatever the request owes', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const lost = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    await ledger.updateOpenRequest(lost.id, { progressAnswerCount: 1, isPersonInputUnanswered: true, lastTurnActivityAt: nowMs });
    nowMs += 60 * 60 * 1000;
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();
    assert.equal(ledger.listOpenRequestsOf(topicKey).find((request) => request.id === lost.id)?.lastTurnActivityAt, nowMs, 'its own lost turn: activity recorded');

    // With another request\'s turn watched, a request that owes nothing records nothing either (review 13 #1): under `watching` it is held
    // anyway, a pending follow-up is woken by `nextWakeAt`, which activity does not move — and under `armed` / `none` without a
    // follow-up the backstop is its only wake, which another request\'s turn must not push.
    const answered = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '535353' } });
    const answeredActivityAt = nowMs - 1;
    await ledger.updateOpenRequest(answered.id, { progressAnswerCount: 1, lastTurnActivityAt: answeredActivityAt });
    const other = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } });
    await engine.trackForwardedTurn(topicKey, other.id, { isRequestPrompt: true });
    nowMs += 60 * 60 * 1000;
    await engine.sweepUnwatchedRequests();
    assert.equal(ledger.listOpenRequestsOf(topicKey).find((request) => request.id === answered.id)?.lastTurnActivityAt, answeredActivityAt, 'another request\'s turn: not this request\'s activity');
  });

  for (const wait of ['armed', 'none'] as const) {
    it(`a request that owes nothing and has no follow-up (${wait}: ${wait === 'armed' ? 'its watch fired and nobody handled it' : 'its watch was dropped'}) keeps its backstop while an unrelated job fires every 30 min: the sweep does not count the other turns as its activity (review 13 #1)`, async () => {
      const ledger = await createLedger();
      const answered = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
      const engine = createEngine(ledger, { getScheduleWait: (_key, request) => (request.id === answered.id ? wait : 'none') });
      const ownLastActivityAt = nowMs;
      await ledger.updateOpenRequest(answered.id, { progressAnswerCount: 1, lastTurnActivityAt: ownLastActivityAt });
      const fireOrigin = { kind: 'scheduledRun' as const, attributes: { requester: 'scheduler' } };
      for (let fire = 0; fire < 3; fire += 1) {
        nowMs += 30 * 60 * 1000;
        // «Check the deploy, say only if broken»: nothing to ride, so the fire opens the scheduler's request; its turn is the one watched.
        const fireRequest = await ledger.createRequest(topicKey, fireOrigin);
        await engine.trackForwardedTurn(topicKey, fireRequest.id, { isRequestPrompt: true, isScheduledRun: true });
        probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
        await engine.pollWatchedTurns();
        await engine.sweepUnwatchedRequests();
        assert.equal(ledger.listOpenRequestsOf(topicKey).find((request) => request.id === answered.id)?.lastTurnActivityAt, ownLastActivityAt, `fire ${fire + 1}: not the answered request's activity`);
        probe = { ...probe, isBusy: false };
        await engine.pollWatchedTurns();
        await engine.sweepUnwatchedRequests();
      }
      assert.deepEqual(wakeUps, [{ requestId: answered.id, reason: 'backstop' }], '90 min after its OWN last activity the backstop takes it back, the fires notwithstanding');
    });
  }

  it('a watch armed in a «continue» turn is recorded under the hand-over the agent works on, not under a mention the nudge only carried along', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const handOverOfAnn = await ledger.createRequest(issueKey, handOver);
    const mentionOfBob = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { ...handOver.attributes, requester: 'bob' } });
    // The agent works on ann's hand-over: its prompt starts the watch, it answers `progress`, then an API error stops the turn.
    await engine.trackForwardedTurn(issueKey, handOverOfAnn.id, { isRequestPrompt: true });
    await ledger.updateOpenRequest(handOverOfAnn.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey).sort(), [handOverOfAnn.id, mentionOfBob.id].sort(), 'the nudge watches every open request');
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [handOverOfAnn.id], 'only the hand-over\'s watch started with a forward of its own');

    assert.equal(engine.getArmingRequestIdOf(issueKey), handOverOfAnn.id, 'the job waits for the request the agent works on');
  });

  it('the job goes to the request whose own forward STARTED the turn, whoever\'s words or fire joined it later — a mention\'s turn is not taken over by the hand-over\'s comment', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const handOverOfAnn = await ledger.createRequest(issueKey, handOver);
    const mentionOfBob = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { ...handOver.attributes, requester: 'bob' } });
    await ledger.updateOpenRequest(handOverOfAnn.id, { progressAnswerCount: 1 });

    // Bob's mention starts a turn; ann's comment on the hand-over is forwarded into it a few minutes later.
    await engine.trackForwardedTurn(issueKey, mentionOfBob.id, { isRequestPrompt: true });
    nowMs += 5 * 60 * 1000;
    await engine.trackForwardedTurn(issueKey, handOverOfAnn.id, { isRequestPrompt: false, isPersonInput: true });
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [mentionOfBob.id, handOverOfAnn.id], 'both are own forwards, the oldest first');
    assert.equal(engine.getArmingRequestIdOf(issueKey), mentionOfBob.id, 'the agent works on bob\'s request: the benchmark\'s watch is its');

    // A recurring job riding the hand-over joins the turn the same way, and a merge keeps the earlier start.
    nowMs += 5 * 60 * 1000;
    await engine.trackForwardedTurn(issueKey, handOverOfAnn.id, { isRequestPrompt: false, isScheduledRun: true });
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [mentionOfBob.id, handOverOfAnn.id]);
    assert.equal(engine.getArmingRequestIdOf(issueKey), mentionOfBob.id);
  });

  it('the reverse case: the hand-over\'s turn, a mention joining it — the job stays the hand-over\'s, and a merge never moves a watch\'s start', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const handOverOfAnn = await ledger.createRequest(issueKey, handOver);
    const mentionOfBob = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { ...handOver.attributes, requester: 'bob' } });
    await engine.trackForwardedTurn(issueKey, handOverOfAnn.id, { isRequestPrompt: true });
    nowMs += 60 * 1000;
    await engine.trackForwardedTurn(issueKey, mentionOfBob.id, { isRequestPrompt: true });
    nowMs += 60 * 1000;
    await engine.trackForwardedTurn(issueKey, handOverOfAnn.id, { isRequestPrompt: false, isPersonInput: true });
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [handOverOfAnn.id, mentionOfBob.id]);
    assert.equal(engine.getArmingRequestIdOf(issueKey), handOverOfAnn.id);
  });

  it('a restart wake watches the hand-over and a mention together: the watch armed in that turn goes to the hand-over', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOverOfAnn = await ledger.createRequest(issueKey, handOver);
    const mentionOfBob = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { ...handOver.attributes, requester: 'bob' } });
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey).sort(), [handOverOfAnn.id, mentionOfBob.id].sort(), 'one forward, both requests watched');
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [], 'neither watch started with a forward of its own');
    assert.equal(engine.getArmingRequestIdOf(issueKey), handOverOfAnn.id, 'a hand-over before a newer mention');
  });

  it('a request woken alone by a restart is the forward\'s own: the conversation-wide mark is for a forward that carried several requests', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const only = await ledger.createRequest(issueKey, handOver);
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(engine.getOwnForwardWatchedRequestIdsOf(issueKey), [only.id], 'one request woken: the forward is its alone');
  });

  it('a requester\'s comment forwarded into a running turn AFTER the agent\'s progress note is not answered by that note: the turn ends silent, reminded at once — not left to the 90-minute backstop', async () => {
    for (const person of [{ isRequestPrompt: false, isPersonInput: true }, { isRequestPrompt: true }]) {
      wakeUps = [];
      const ledger = await createLedger();
      const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
      const request = await ledger.createRequest(issueKey, handOver);
      await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
      // The agent answers early (the real update of `answer_request`) and keeps working; the comment joins the running turn.
      await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
      await engine.trackForwardedTurn(issueKey, request.id, person);
      assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true, 'the new words are owed an answer');

      await endTurnSilently(engine);
      assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], `${JSON.stringify(person)}: an earlier note is not their answer`);
      engine.stop();
    }
  });

  it('a note sent AFTER the comment joined the turn does answer it: the turn ends as a progress one', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'answered after the words arrived: quiet under the watch');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 0);
  });

  it('a limit resume that re-posts ONE request\'s prompt marks only that request owed: another requester\'s answered request waiting on its watch gets the plain «continue»', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const handOverOfBob = { ...handOver, attributes: { ...handOver.attributes, requester: 'bob' } };
    const answered = await ledger.createRequest(issueKey, handOver, { createPrompt: (id) => `[Request ${id} · from ann]` });
    await ledger.updateOpenRequest(answered.id, { progressAnswerCount: 1, isPromptTakenIn: true });
    // A mention that came during the wait: its prompt was held, the session never took it in.
    const held = await ledger.createRequest(issueKey, handOverOfBob, { createPrompt: (id) => `[Request ${id} · from bob]` });

    await engine.trackContinuationTurn(issueKey, { isCountersReset: true, carriedRequestIds: [held.id] });
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((request) => request.id === answered.id)?.isPersonInputUnanswered, undefined, 'ann\'s answered request owes nothing');
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((request) => request.id === held.id)?.isPersonInputUnanswered, true, 'bob\'s words rode the message: owed');

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: held.id, reason: 'silentTurn' }], 'only the request whose prompt was re-posted is reminded; the waiting one stays quiet');
    assert.deepEqual(alerts, []);
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((request) => request.id === answered.id)?.silentTurnCount, 0);
  });

  it('a «continue» carries only the requests named when it was BUILT: one opened before its replay is no request prompt of it — not owed for it, not read as taken in with it (review 21 nit 3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOverOfBob = { ...handOver, attributes: { ...handOver.attributes, requester: 'bob' } };
    // A mention held over the wait: the limit resume's message is built with its prompt, and waits in a startup window.
    const held = await ledger.createRequest(issueKey, handOver, { createPrompt: (id) => `[Request ${id} · from ann]` });
    const carriedRequestIds = [held.id];
    // Bob's comment opens a request meanwhile; its own post waits for the idle behind the nudge's turn.
    const later = await ledger.createRequest(issueKey, handOverOfBob, { createPrompt: (id) => `[Request ${id} · from bob]` });
    // The replay writes the message into process 3 and the continuation is tracked, with the requests named at the build.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, processGeneration: 3 };
    await engine.trackContinuationTurn(issueKey, { isCountersReset: true, carriedRequestIds });
    const readOpen = (requestId: string): OpenRequestState | undefined => ledger.listOpenRequestsOf(issueKey).find((request) => request.id === requestId);
    assert.equal(readOpen(held.id)?.isPersonInputUnanswered, true, 'ann\'s words rode the message: owed');
    assert.equal(readOpen(later.id)?.isPersonInputUnanswered, undefined, 'bob\'s did not');
    // The message's turn took what it carried in: ann's prompt is read, bob's — still waiting for its own write — is not.
    await engine.pollWatchedTurns();
    assert.equal(readOpen(held.id)?.isPromptTakenIn, true);
    assert.equal(readOpen(later.id)?.isPromptTakenIn, undefined, 'never marked off a message it was not in');
  });

  it('the end of a limit wait zeroes the counters but never the person\'s unanswered words: what was owed stays owed', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, isPersonInputUnanswered: true, silentTurnCount: 1, wakeCount: 1 });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: true });
    const reset = ledger.getNewestOpenRequest(issueKey);
    assert.equal(reset?.silentTurnCount, 0);
    assert.equal(reset?.wakeCount, 0);
    assert.equal(reset?.isPersonInputUnanswered, true);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'still owed: not a quiet turn');
  });

  it('a request prompt a fire joined is still marked taken in (R21): the merged watch keeps being a request prompt\'s', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver, { createPrompt: (id) => `[Request ${id} · from: PROJ-1]` });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPromptTakenIn, true);
  });

  it('a fire riding a request leaves its pending post retry alone — it carries none of the request\'s message; the request\'s own forward drops it', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver, { createPrompt: (id) => `[Request ${id} · from: PROJ-1]` });
    await engine.notePostFailed(issueKey, request.id);
    assert.notEqual(ledger.getNewestOpenRequest(issueKey)?.nextPostRetryAt, undefined, 'a retry is scheduled');
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    assert.notEqual(ledger.getNewestOpenRequest(issueKey)?.nextPostRetryAt, undefined, 'the fire\'s forward did not deliver the request\'s prompt');
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextPostRetryAt, undefined, 'the request\'s own forward did');
  });

  it('a failing check counts only at a turn\'s end: the agent that handled the wake is not silent, a wake nobody handled falls to the backstop', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'the turn that handled the wake: not silent');

    nowMs += backstopMs - 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);
    nowMs += 1;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }], 'the check nobody handled does not hold the request forever');
  });

  it('a watch that fired and nobody re-armed: the fire\'s turn (its «continue» too) stays quiet, but the backstop\'s reminders are silent turns — the give-up comes after two, not after ten wakes', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'the turn that handled the wake, an API error and its «continue» included: not silent');

    nowMs += backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }]);
    await endTurnSilently(engine);
    assert.deepEqual(getWakeUpReasons(), ['backstop', 'silentTurn'], 'the reminder\'s turn ended silent: no quiet turn for a reminder under a watch nobody re-armed');
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'the give-up, instead of ten reminders ninety minutes apart');
  });

  // Review 12 #2: a fire of ANOTHER job that only rides the request (a tracker's newest open request, a topic's scheduler's request).
  const otherJobFire = { isRequestPrompt: false, isScheduledRun: true, isRequestJob: false } as const;
  const thirtyMinutesMs = 30 * 60 * 1000;

  it('under a watch that fired and nobody handled, another job\'s fire every 30 min neither handles it nor counts as the request\'s activity: the backstop still wakes the request 90 min after its OWN last activity', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    // Answered `progress` earlier, its watch fired, and the agent died in the wake: only the persisted request is left.
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, lastTurnActivityAt: nowMs });
    const ownLastActivityAt = nowMs;
    for (let fire = 0; fire < 2; fire += 1) {
      nowMs += thirtyMinutesMs;
      // «Every 30 min look at CI, comment only if red»: its job was armed under a finished request, so it rides this one.
      await engine.trackForwardedTurn(issueKey, request.id, otherJobFire);
      await endTurnSilently(engine);
      await engine.sweepUnwatchedRequests();
    }
    assert.deepEqual(wakeUps, [], 'the fires\' turns are quiet, and 60 min after its own activity the backstop is not due yet');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.lastTurnActivityAt, ownLastActivityAt, 'neither the forward, nor the busy turn, nor its quiet end is the request\'s activity');
    nowMs += thirtyMinutesMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'backstop' }], '90 min after its own last activity: the fired watch nobody handled is taken back');
  });

  it('another job\'s fire leaves the request\'s due follow-up alone under `armed` too; the request\'s own watch\'s fire still clears it (the agent that handled the wake)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    const followUpAt = nowMs + progressFollowUpDelayMs;
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, nextWakeAt: followUpAt });
    await engine.trackForwardedTurn(issueKey, request.id, otherJobFire);
    await endTurnSilently(engine);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, followUpAt, 'an unrelated alarm does not wipe the follow-up');
    nowMs = followUpAt;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(getWakeUpReasons(), ['progressFollowUp']);

    const own = await ledger.createRequest(issueKey, { ...handOver, attributes: { ...handOver.attributes, requester: 'bob' } });
    await ledger.updateOpenRequest(own.id, { progressAnswerCount: 1, nextWakeAt: nowMs + progressFollowUpDelayMs });
    await engine.trackForwardedTurn(issueKey, own.id, { isRequestPrompt: false, isScheduledRun: true, isRequestJob: true });
    await endTurnSilently(engine);
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((open) => open.id === own.id)?.nextWakeAt, undefined, 'the request\'s own watch fired and was handled: held, nothing due');
  });

  it('another job\'s fire that joins the request\'s OWN fire turn, and a «continue» of either, keep the turn the request\'s own — a merge is its own if either side is', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, nextWakeAt: nowMs + progressFollowUpDelayMs });
    await engine.trackForwardedTurn(issueKey, request.id, otherJobFire);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true, isRequestJob: true });
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, undefined, 'its own watch\'s fire joined: the wake was handled');
  });

  it('a «continue» of another job\'s fire writes no activity on the ridden request either — its forward, like the fire\'s, is not the request\'s (review 13 #3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    const ownLastActivityAt = nowMs;
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, lastTurnActivityAt: ownLastActivityAt });
    nowMs += 10 * 60 * 1000;
    await engine.trackForwardedTurn(issueKey, request.id, otherJobFire);
    nowMs += 60 * 1000;
    // The fire's turn hit an API error: the bot's «continue» joins the watch, which stays another job's.
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.lastTurnActivityAt, ownLastActivityAt, 'the «continue» forward recorded nothing');
  });

  it('a «continue» of another job\'s fire alone stays another job\'s turn: the request\'s follow-up stands', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'armed' });
    const request = await ledger.createRequest(issueKey, handOver);
    const followUpAt = nowMs + progressFollowUpDelayMs;
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1, nextWakeAt: followUpAt });
    await engine.trackForwardedTurn(issueKey, request.id, otherJobFire);
    await engine.trackContinuationTurn(issueKey, { isCountersReset: false });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'still a fire\'s turn: quiet');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, followUpAt);
  });

  it('a restart wake skips a request a watch holds and still wakes the others — the port is asked about each request', async () => {
    const ledger = await createLedger();
    const watched = await ledger.createRequest(issueKey, { ...handOver, attributes: { ...handOver.attributes, requester: 'ann' } });
    const unwatched = await ledger.createRequest(issueKey, { ...handOver, attributes: { ...handOver.attributes, requester: 'bob' } });
    await ledger.updateOpenRequest(watched.id, { progressAnswerCount: 1 });
    const asked: string[] = [];
    const engine = createEngine(ledger, {
      getScheduleWait: (_key, request) => {
        asked.push(request.id);
        return request.id === watched.id ? 'watching' : 'none';
      },
    });
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps.map((wakeUp) => wakeUp.requestId), [unwatched.id]);
    assert.ok(asked.includes(watched.id));
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((request) => request.id === watched.id)?.wakeCount, 0, 'no wake counted for the watched one');
  });

  it('a conversation whose only request is watched is not woken at a restart at all, and the follow-up of a progress note stays held too', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getScheduleWait: () => 'watching' });
    const request = await ledger.createRequest(issueKey, handOver);
    await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
    probe = goneProbe;
    await engine.wakeAfterRestart(issueKey);
    assert.deepEqual(wakeUps, []);
    assert.deepEqual(preparedFor, [], 'no session was even prepared');

    await ledger.updateOpenRequest(request.id, { nextWakeAt: nowMs + 1 });
    nowMs += progressFollowUpDelayMs;
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, []);
  });

  it('the boot\'s restart wake is not even scheduled for a conversation whose every request a watch holds — it spends no stagger slot; one with an unheld request still is', async () => {
    const ledger = await createLedger();
    const heldKey = makeJiraKey('PROJ-1');
    const mixedKey = makeJiraKey('PROJ-2');
    const held = await ledger.createRequest(heldKey, { ...handOver, attributes: { ...handOver.attributes, issueKey: 'PROJ-1' } });
    const mixedHeld = await ledger.createRequest(mixedKey, { ...handOver, attributes: { ...handOver.attributes, issueKey: 'PROJ-2', requester: 'ann' } });
    await ledger.createRequest(mixedKey, { ...handOver, attributes: { ...handOver.attributes, issueKey: 'PROJ-2', requester: 'bob' } });
    await ledger.updateOpenRequest(held.id, { progressAnswerCount: 1 });
    await ledger.updateOpenRequest(mixedHeld.id, { progressAnswerCount: 1 });
    const engine = createEngine(ledger, {
      getScheduleWait: (_key, request) => (request.id === held.id || request.id === mixedHeld.id ? 'watching' : 'none'),
    });
    assert.equal(engine.scheduleRestartWake(heldKey), false, 'nothing to wake: no timer');
    assert.equal(engine.scheduleRestartWake(mixedKey), true, 'bob\'s request is not held');
    // The one scheduled wake takes the first stagger: a held conversation did not push it back.
    assert.equal(engine.scheduleRestartWake(heldKey), false);
    engine.stop();
  });

  it('names the requests whose turns it watches — the ones the agent works on — and drops them when the turn ends or the request closes', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handedOver = await ledger.createRequest(issueKey, handOver);
    const mention = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { issueKey: 'PROJ-1', triggerId: 'mention:1', requester: 'bob' } });
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), []);
    await engine.trackForwardedTurn(issueKey, handedOver.id, { isRequestPrompt: true });
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), [handedOver.id], 'not the newer request: only the one whose turn runs');
    await engine.trackForwardedTurn(issueKey, mention.id);
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey).sort(), [handedOver.id, mention.id].sort());
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [], 'another conversation has none');
    await ledger.closeRequest(mention.id, 'final');
    await engine.pollWatchedTurns();
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), [handedOver.id], 'a closed request is dropped by the next poll');
  });

  it('a test instance\'s shorter follow-up delay is the one a progress note waits for', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { progressFollowUpMs: 5_000 });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.nextWakeAt, nowMs + 5_000);
    nowMs += 5_000;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'progressFollowUp' }]);
  });
});

describe('turn boundaries: a forward settles the watches whose turn already ended (review 14 #1)', () => {
  const issueKey = makeJiraKey('PROJ-7');
  const handOverOf = (requester: string) => ({ kind: 'trackerEvent' as const, attributes: { issueKey: 'PROJ-7', triggerId: '100', requester } });
  const mentionOf = (requester: string) => ({ kind: 'trackerMention' as const, attributes: { issueKey: 'PROJ-7', triggerId: 'mention:1', requester } });
  const busyProbe: SessionTurnProbe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
  const idleProbe: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };

  it('a mention forwarded within seconds of the hand-over\'s turn end — before the poll saw the idle — starts a turn of its OWN: its job is armed under it, the hand-over is decided from its own end, and the mention\'s busy time is not the hand-over\'s', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, handOverOf('ann'));
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    await ledger.updateOpenRequest(handOver.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    // The hand-over's turn ends; the mention waited for it and is forwarded a few seconds later, before the 10 s poll tick.
    probe = idleProbe;
    const handOverEndAt = nowMs;
    const settled = engine.settleEndedTurnsOf(issueKey);
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), [], 'the ended watch is dropped at once, before the write');
    await (await settled)();
    const mention = await ledger.createRequest(issueKey, mentionOf('bob'));
    await engine.trackForwardedTurn(issueKey, mention.id, { isRequestPrompt: true });
    assert.equal(engine.getArmingRequestIdOf(issueKey), mention.id, 'a watch armed in the mention\'s turn is the mention\'s');
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((open) => open.id === handOver.id)?.nextWakeAt, handOverEndAt + progressFollowUpDelayMs, 'the hand-over\'s note is followed up from ITS turn\'s end');

    nowMs += 5 * 60 * 1000;
    probe = busyProbe;
    await engine.pollWatchedTurns();
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((open) => open.id === handOver.id)?.lastTurnActivityAt, handOverEndAt, 'the mention\'s busy turn is not the hand-over\'s activity');
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((open) => open.id === mention.id)?.lastTurnActivityAt, nowMs);
  });

  it('in a topic: a fire that waited behind the operator\'s ended turn opens the scheduler\'s request — the watch armed while handling it is the scheduler\'s request\'s', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const operator = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    await engine.trackForwardedTurn(topicKey, operator.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    await ledger.updateOpenRequest(operator.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, isPersonInputUnanswered: undefined }));
    probe = idleProbe;
    await (await engine.settleEndedTurnsOf(topicKey))();
    const fireRequest = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } });
    await engine.trackForwardedTurn(topicKey, fireRequest.id, { isRequestPrompt: true, isScheduledRun: true });
    assert.equal(engine.getArmingRequestIdOf(topicKey), fireRequest.id);
  });

  it('a turn still RUNNING keeps its watch: the forward joins it (the merge rule\'s own premise)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, handOverOf('ann'));
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    await (await engine.settleEndedTurnsOf(issueKey))();
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), [handOver.id], 'still running: nothing is decided');
    const mention = await ledger.createRequest(issueKey, mentionOf('bob'));
    await engine.trackForwardedTurn(issueKey, mention.id, { isRequestPrompt: true });
    assert.equal(engine.getArmingRequestIdOf(issueKey), handOver.id, 'the hand-over started the running turn the mention joined');
  });

  it('a silent end found by the settle is decided and persisted before the write, and its reminder is delivered only when the caller says — after the new prompt\'s write, as the tick would have (review 15 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, handOverOf('ann'));
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    probe = idleProbe;
    const deliverWakes = await engine.settleEndedTurnsOf(issueKey);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.silentTurnCount, 1, 'decided and persisted');
    assert.deepEqual(wakeUps, [], 'the reminder waits for the caller: the waited prompt is written first and starts the turn');
    // The waited mention is written and tracked here; then the reminder joins its turn.
    const mention = await ledger.createRequest(issueKey, mentionOf('bob'));
    await engine.trackForwardedTurn(issueKey, mention.id, { isRequestPrompt: true });
    await deliverWakes();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn']);
    assert.equal(engine.getArmingRequestIdOf(issueKey), mention.id, 'the mention started the turn: a watch armed in it is the mention\'s');
  });

  it('a turn end\'s reminder is HANDED to a post on its way to its write: it is delivered after the post\'s own prompt, so the request that waited starts the turn (review 16 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, handOverOf('ann'));
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    // A mention's post waits for the hand-over's turn; that turn ends silent and the adapter's turn end settles it.
    const releasePost = engine.notePostInFlight(issueKey);
    probe = idleProbe;
    await engine.deliverOrHandOverWake(issueKey, await engine.settleEndedTurnsOf(issueKey));
    assert.equal(ledger.listOpenRequestsOf(issueKey).find((open) => open.id === handOver.id)?.silentTurnCount, 1, 'decided and persisted at the turn end');
    assert.deepEqual(getWakeUpReasons(), [], 'handed to the post: nothing written yet');
    // The post's settle takes it; the post writes the mention and watches its turn, then delivers.
    const deliverAfterWrite = await engine.settleEndedTurnsForPost(issueKey);
    assert.deepEqual(getWakeUpReasons(), []);
    const mention = await ledger.createRequest(issueKey, mentionOf('bob'));
    await engine.trackForwardedTurn(issueKey, mention.id, { isRequestPrompt: true });
    await deliverAfterWrite();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn'], 'the reminder follows the mention');
    assert.equal(wakeUps.at(0)?.requestId, handOver.id);
    assert.equal(engine.getArmingRequestIdOf(issueKey), mention.id, 'the mention started the turn the reminder joined: a watch armed in it is the mention\'s');
    await releasePost();
    assert.equal(getWakeUpReasons().length, 1, 'the release has nothing left to deliver');
  });

  it('while a post is in flight the poll\'s decision is handed to it too; a release delivers what no post took — a post held over a limit, an ensure that failed (review 16 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, handOverOf('ann'));
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: true });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    const releaseFirst = engine.notePostInFlight(issueKey);
    const releaseSecond = engine.notePostInFlight(issueKey);
    probe = idleProbe;
    await engine.pollWatchedTurns();
    assert.deepEqual(getWakeUpReasons(), [], 'the poll found the silent end and handed its reminder to the posts in flight');
    await releaseFirst();
    assert.deepEqual(getWakeUpReasons(), [], 'another post is still on its way: it may take it');
    await releaseFirst();
    await releaseSecond();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn'], 'the last post left without taking it: delivered at its release, once');
    await engine.deliverOrHandOverWake(issueKey, async () => { wakeUps.push({ requestId: 'req_later', reason: 'progressFollowUp' }); });
    assert.equal(getWakeUpReasons().length, 2, 'no post in flight: a wake-up goes out at once');
  });

  it('a watch whose turn ends while the bot still handles its API error is not decided — not at the turn end, not by the poll — and the stop drops it: no reminder, no give-up (review 16 #1)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const handOver = await ledger.createRequest(issueKey, { ...handOverOf('ann') });
    await ledger.updateOpenRequest(handOver.id, { silentTurnCount: 1, wakeCount: 1 });
    await engine.trackForwardedTurn(issueKey, handOver.id, { isRequestPrompt: false });
    probe = busyProbe;
    await engine.pollWatchedTurns();
    // The reminder's turn ended on a usage limit with «wait for reset» off: the error result left nothing unconsumed.
    probe = { ...idleProbe, isTurnEndBlocked: true };
    await engine.deliverOrHandOverWake(issueKey, await engine.settleEndedTurnsOf(issueKey));
    await engine.pollWatchedTurns();
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), [handOver.id], 'held: the turn that ended on the error is not decided');
    // The bot's handling lands: the open request is answered and no longer woken.
    await engine.stopWakingForLimitWait(issueKey);
    probe = idleProbe;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(engine.getWatchedRequestIdsOf(issueKey), []);
    assert.deepEqual(getWakeUpReasons(), [], 'no reminder written into the limited session');
    assert.deepEqual(alerts, [], 'no «could not finish»');
    const request = ledger.listOpenRequestsOf(issueKey).find((open) => open.id === handOver.id);
    assert.equal(request?.silentTurnCount, 1, 'the turn that ended on the error was no silent turn');
    assert.equal(request?.isLimitStopped, true);
  });

  it('a watch made while the session starts — its prompt waits in the startup buffer — is never decided by the replay\'s settle: the start is held, and the turn is decided at its REAL end (review 15 #1)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const startingProbe: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    probe = startingProbe;
    const operator = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    // Buffered during the start, tracked at once (the old behaviour the poll alone never mistook).
    await engine.trackForwardedTurn(topicKey, operator.id, { isRequestPrompt: true });
    // The replay's own write settles first: the probe reads the replay as the start.
    await (await engine.settleEndedTurnsOf(topicKey))();
    await engine.pollWatchedTurns();
    assert.deepEqual(engine.getWatchedRequestIdsOf(topicKey), [operator.id], 'still watched through the replay');
    assert.equal(ledger.getNewestOpenRequest(topicKey)?.silentTurnCount, 0);
    // After the replay the prompt is written and not yet read, then the agent works on it, then the turn ends silent.
    probe = { ...idleProbe, hasUnconsumedInput: true };
    await engine.pollWatchedTurns();
    probe = busyProbe;
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, [], 'no reminder before the agent\'s turn');
    probe = idleProbe;
    await (await engine.settleEndedTurnsOf(topicKey))();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn'], 'one silent turn, one reminder');
    assert.deepEqual(alerts, [], 'not the give-up');
  });
});

describe('a tracker\'s rules: no reminder on a clock — a progress note with nothing armed gets ONE nudge, the next stall the give-up', () => {
  // The rule\'s branches: src/__tests__/wakeUpRules.test.ts › "a tracker\'s rules"; at process level src/__tests__/jiraRequestWakeE2e.test.ts.
  const issueKey = makeJiraKey('PROJ-30');
  const handOver = { kind: 'trackerEvent' as const, attributes: { issueKey: 'PROJ-30', triggerId: '300', requester: 'ann' } };
  const trackerRules = { getWakeUpRules: (): WakeUpRuleSet => 'tracker' };
  /** What `answerRequest` writes for a delivered progress note: counted, and no silent turn or person\'s words left owed. */
  const deliverProgress = (ledger: RequestLedger, requestId: string) =>
    ledger.updateOpenRequest(requestId, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1, silentTurnCount: 0, isPersonInputUnanswered: undefined }));
  /** A turn runs, the agent does `duringTurn` in it, and the turn ends idle. */
  async function runTurn(engine: RequestWakeUpEngine, duringTurn: () => Promise<unknown>): Promise<void> {
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await duringTurn();
    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();
  }

  it('a progress note with nothing armed: ONE nudge at once, no follow-up on a clock; the nudge\'s turn ends the same way — another note — and the request is given up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });

    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'the nudge, at once');
    assert.ok(wakeUpMessages[0].text.includes('Nothing reminds you on a clock.'), wakeUpMessages[0].text);
    const nudged = ledger.getOpenRequestById(request.id)?.request;
    assert.equal(nudged?.nextWakeAt, undefined, 'no follow-up armed');
    assert.equal(nudged?.stalledTurnCount, 1);

    // The nudge\'s turn: another note — which resets the silent-turn count on delivery, never the stall count — and nothing armed.
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'no second nudge');
    assert.equal(ledger.getOpenRequestById(request.id)?.request.isWakeStopped, true);

    nowMs += progressFollowUpDelayMs + 2 * backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.equal(wakeUps.length, 1, 'given up: nothing wakes it again');
  });

  it('a nudge answered by a watch: the note under it is quiet, the stall count starts again, and nothing wakes the request between turns while the watch passes', async () => {
    let wait: RequestScheduleWait = 'none';
    const ledger = await createLedger();
    const engine = createEngine(ledger, { ...trackerRules, getScheduleWait: () => wait });
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed']);

    await runTurn(engine, async () => {
      wait = 'watching';
      await deliverProgress(ledger, request.id);
    });
    assert.deepEqual(alerts, [], 'the agent armed what wakes it');
    assert.equal(ledger.getOpenRequestById(request.id)?.request.stalledTurnCount, undefined, 'the stall count starts again');
    nowMs += 3 * backstopMs;
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'held by its watch: no follow-up, no backstop');
  });

  it('a requester\'s comment that waited for the stalled turn goes first: the nudge decided at its post is not sent, and the comment\'s turn starts the stall count again', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    // The comment's post waited for the turn; it ends with the note and nothing armed, and the post settles it before its write.
    const releasePost = engine.notePostInFlight(issueKey);
    probe = { ...probe, isBusy: false };
    const deliverAfterWrite = await engine.settleEndedTurnsForPost(issueKey);
    assert.equal(ledger.getOpenRequestById(request.id)?.request.stalledTurnCount, 1, 'the stall is decided at the settle');
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    await deliverAfterWrite();
    await releasePost();
    assert.deepEqual(wakeUps, [], 'the comment is the request\'s next turn: no nudge behind it');
    assert.equal(ledger.getOpenRequestById(request.id)?.request.stalledTurnCount, undefined, 'a person\'s words start the count again');

    // The comment's turn ends with a note and nothing armed: a stall of its own, nudged — not the give-up.
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed']);
    assert.deepEqual(alerts, []);
  });

  it('the agent\'s own pending work holds off the nudge and the give-up however long it runs; once it ended, the turn it started ends with a note and nothing pending: the nudge, then the give-up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    // The agent starts a background poll on the pipeline, sends a note and ends its turn: its own work runs on.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    probe = { ...probe, isBusy: false, hasOwnPendingWork: true };
    await engine.pollWatchedTurns();
    nowMs += 3 * backstopMs;
    await engine.pollWatchedTurns();
    await engine.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'no nudge, no backstop: its own work will wake it');
    assert.deepEqual(alerts, []);

    // The poll ends: the CLI starts the agent's own turn, which sends a note and ends with nothing pending.
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'the normal nudge');
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'then the normal give-up');
  });

  it('a nudge answered by the agent\'s own background work: the stall count starts again, so the next stall after that work is nudged, not given up', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.equal(ledger.getOpenRequestById(request.id)?.request.stalledTurnCount, 1);

    // The nudge's turn starts a background poll and ends with a note.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    probe = { ...probe, isBusy: false, hasOwnPendingWork: true };
    await engine.pollWatchedTurns();
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'held while its work runs');

    // That work ends by itself; the turn it starts ends with a note and nothing pending: a stall that is the first in a row again.
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed', 'nothingArmed']);
    assert.deepEqual(alerts, []);
  });

  it('a nudge answered by a short background command that ends inside one poll interval: the turn-end settle sees it held, so the stall after it is nudged, not given up (review 3 #3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed']);

    // The nudge's turn sends a note, starts a short command and ends: only the adapter's turn-end settle sees the hold.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    probe = { ...probe, isBusy: false, hasOwnPendingWork: true };
    await engine.deliverOrHandOverWake(issueKey, await engine.settleEndedTurnsOf(issueKey));
    // The command ends and the turn it starts ends with nothing pending, before the next poll: settled at its end too.
    probe = { ...probe, hasOwnPendingWork: false };
    await engine.deliverOrHandOverWake(issueKey, await engine.settleEndedTurnsOf(issueKey));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed', 'nothingArmed'], 'its work ended by itself: the count starts again');
    assert.deepEqual(alerts, []);
  });

  it('a nudge answered by a short background command whose own turn is the next thing a poll sees: that turn is the agent\'s own work — no activity, and the stall after it is nudged, not given up (review 3 #3)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed']);

    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    const activityAtNudgeTurn = ledger.getOpenRequestById(request.id)?.request.lastTurnActivityAt;
    // The command ended inside the poll interval: the next poll sees the turn the CLI started by itself for it.
    nowMs += 5 * 60 * 1000;
    probe = { ...probe, isCliOwnTurn: true };
    await engine.pollWatchedTurns();
    assert.equal(ledger.getOpenRequestById(request.id)?.request.lastTurnActivityAt, activityAtNudgeTurn, 'the CLI\'s own turn is no activity');
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed', 'nothingArmed'], 'its work woke it: the count starts again');
    assert.deepEqual(alerts, []);
  });

  it('a topic\'s watch is never marked by the agent\'s own work: its CLI turn is activity, as before', async () => {
    const ledger = await createLedger();
    const topicEngine = createEngine(ledger, { getWakeUpRules: (): WakeUpRuleSet => 'topic' });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await topicEngine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false, hasOwnPendingWork: true };
    await topicEngine.pollWatchedTurns();
    nowMs += 5 * 60 * 1000;
    probe = { ...probe, isCliOwnTurn: true };
    await topicEngine.pollWatchedTurns();
    assert.equal(ledger.getOpenRequestById(request.id)?.request.lastTurnActivityAt, nowMs, 'a topic counts every busy poll of its watched turn');
  });

  it('an answer owed outranks the agent\'s own work: a first turn that ends without a word while its background poll runs is prodded at once', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    probe = { ...probe, isBusy: false, hasOwnPendingWork: true };
    await engine.pollWatchedTurns();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn'], 'the requester never heard a word: as a bot watch would, the poll does not hide that');
  });

  it('an answer owed outranks the agent\'s own work: a requester\'s comment that its turn left unanswered while the poll runs is prodded at once', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    // A note and a background poll: held.
    probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    probe = { ...probe, isBusy: false, hasOwnPendingWork: true };
    await engine.pollWatchedTurns();
    assert.deepEqual(wakeUps, []);
    // The requester comments «also check X»; the agent's turn reads it and ends without an answer, its poll still running.
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isPersonInput: true });
    probe = { ...probe, isBusy: true };
    await engine.pollWatchedTurns();
    probe = { ...probe, isBusy: false };
    await engine.pollWatchedTurns();
    assert.deepEqual(getWakeUpReasons(), ['silentTurn']);
  });

  it('a loop of the agent\'s own (a recurring job) holds the request at most 6 h past its last activity — its own turns are none — then the lapse\'s wake, and the give-up at the next lapse', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, trackerRules);
    const request = await ledger.createRequest(issueKey, handOver);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: true });
    const loopingIdle: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, hasOwnPendingWork: true };
    const loopFire: SessionTurnProbe = { ...loopingIdle, isBusy: true, isCliOwnTurn: true };
    probe = { ...loopingIdle, isBusy: true, hasOwnPendingWork: false };
    await engine.pollWatchedTurns();
    await deliverProgress(ledger, request.id);
    /** Its job fires every half hour for `hours`: each fire a turn the CLI starts by itself, its job still armed after it. */
    const loopFor = async (hours: number): Promise<void> => {
      for (let step = 0; step < hours * 2; step += 1) {
        nowMs += 30 * 60 * 1000;
        probe = loopFire;
        await engine.pollWatchedTurns();
        probe = loopingIdle;
        await engine.pollWatchedTurns();
        await engine.sweepUnwatchedRequests();
      }
    };
    probe = loopingIdle;
    await engine.pollWatchedTurns();
    await loopFor(5.5);
    assert.deepEqual(wakeUps, [], 'held: its own work runs');
    await loopFor(0.5);
    assert.deepEqual(getWakeUpReasons(), ['ownWorkHoldLapsed'], '6 h since its last prompt: a stall, woken with the lapse\'s own line');
    // The lapse's turn: the agent says nothing new and its loop goes on — held again, from that turn.
    probe = { ...loopingIdle, isBusy: true, hasOwnPendingWork: false };
    await engine.pollWatchedTurns();
    probe = loopingIdle;
    await engine.pollWatchedTurns();
    await loopFor(6);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'still looping at the next lapse: given up');
    assert.equal(ledger.getOpenRequestById(request.id)?.request.isWakeStopped, true);
  });

  it('after a restart nothing watches the request: the sweep watches it again while the agent waits on its own work, so the turn that work starts is decided at its end, not at the backstop', async () => {
    const ledger = await createLedger();
    const request = await ledger.createRequest(issueKey, handOver);
    await deliverProgress(ledger, request.id);
    await ledger.updateOpenRequest(request.id, { isPromptTakenIn: true });
    const engineAfterRestart = createEngine(ledger, trackerRules);
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false, hasOwnPendingWork: true };
    nowMs += 2 * backstopMs;
    await engineAfterRestart.sweepUnwatchedRequests();
    assert.deepEqual(wakeUps, [], 'its own work runs: no backstop');

    // The work ends; the turn it starts reads the result and ends with nothing new said and nothing pending.
    await runTurn(engineAfterRestart, async () => {});
    assert.deepEqual(getWakeUpReasons(), ['nothingArmed'], 'the nudge, as without the restart — not a silent turn');
  });

  it('a topic keeps its clock: the same progress note is followed up 15 minutes later', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger, { getWakeUpRules: (key) => (key.platform === 'jira' ? 'tracker' : 'topic') });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id, { isRequestPrompt: true });
    await runTurn(engine, () => deliverProgress(ledger, request.id));
    assert.deepEqual(wakeUps, []);
    assert.equal(ledger.getOpenRequestById(request.id)?.request.nextWakeAt, nowMs + progressFollowUpDelayMs);
  });
});
