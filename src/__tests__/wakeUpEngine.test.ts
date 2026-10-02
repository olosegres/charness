/**
 * @description The wake-up engine (`requests/wakeUpEngine.ts`, request/answer
 * core S4) over a REAL request ledger, with a scripted session probe, recorded
 * wake-ups / alerts and a controlled clock: the polls and sweeps the timers would
 * run are called directly, so every rule is driven step by step.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { RequestWakeUpEngine } from '../requests/wakeUpEngine';
import { progressFollowUpDelayMs, type SessionTurnProbe } from '../requests/wakeUpRules';
import type { ClosedRequestRecord, RequestAlertReason, RequestWakeUpReason } from '../requests/types';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const backstopMs = 90 * 60 * 1000;
const alertMessageRef = '777';

let fakeHome: string;
let originalHome: string | undefined;
let dataDir: string;
let nowMs: number;
let probe: SessionTurnProbe;
let wakeUps: Array<{ requestId: string; reason: RequestWakeUpReason }>;
let alerts: Array<{ requestId: string; reason: RequestAlertReason }>;
let releasedAlerts: string[];
let closedRecords: ClosedRequestRecord[];
let isWakeUpDeliverable: boolean;

async function createLedger(): Promise<RequestLedger> {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  const ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
    now: () => nowMs,
    onRequestClosed: (record) => closedRecords.push(record),
  });
  await ledger.load();
  return ledger;
}

function createEngine(ledger: RequestLedger): RequestWakeUpEngine {
  return new RequestWakeUpEngine({
    ledger,
    probeTurn: () => probe,
    deliverWakeUp: async (_key, request, reason) => {
      wakeUps.push({ requestId: request.id, reason });
      return isWakeUpDeliverable;
    },
    deliverAlert: async (_key, request, reason) => {
      alerts.push({ requestId: request.id, reason });
      return alertMessageRef;
    },
    releaseAlert: async (_key, alertRef) => { releasedAlerts.push(alertRef); },
    backstopMs,
    now: () => nowMs,
  });
}

/** A turn the request's message started, then ended idle with nothing answered. */
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
  alerts = [];
  releasedAlerts = [];
  closedRecords = [];
  isWakeUpDeliverable = true;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('silent turns', () => {
  it('a silent turn is woken at once; the second alerts, stops waking and holds the alert', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
    assert.equal(ledger.getOpenRequest(topicKey)?.silentTurnCount, 1);

    // The reminder's own turn ends silent too.
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }]);
    assert.equal(wakeUps.length, 1, 'no second wake-up');
    const stopped = ledger.getOpenRequest(topicKey);
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

    assert.equal(closedRecords.at(-1)?.alertRef, alertMessageRef);
  });

  it('a request closed while its alert went out has the alert released at once', async () => {
    const ledger = await createLedger();
    const engine = new RequestWakeUpEngine({
      ledger,
      probeTurn: () => probe,
      deliverWakeUp: async () => true,
      deliverAlert: async (_key, request) => {
        await ledger.closeRequest(request.id, 'final'); // the answer lands meanwhile
        return alertMessageRef;
      },
      releaseAlert: async (_key, alertRef) => { releasedAlerts.push(alertRef); },
      backstopMs,
      now: () => nowMs,
    });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await ledger.updateOpenRequest(request.id, { silentTurnCount: 1 });
    await engine.trackForwardedTurn(topicKey, request.id);

    await endTurnSilently(engine);

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
    assert.equal(ledger.getOpenRequest(topicKey)?.isWakeStopped, true);
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

describe('progress answers', () => {
  it('a turn that sent progress is followed up 15 min later, never while the session works', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));

    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [], 'no wake-up right after a progress note');
    assert.equal(ledger.getOpenRequest(topicKey)?.nextWakeAt, nowMs + progressFollowUpDelayMs);

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

  it('the follow-up time survives a restart', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await engine.trackForwardedTurn(topicKey, request.id);
    await ledger.updateOpenRequest(request.id, (current) => ({ progressAnswerCount: current.progressAnswerCount + 1 }));
    await endTurnSilently(engine);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the debounced save land

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

    assert.equal(ledger.getOpenRequest(topicKey), undefined);
    assert.equal(closedRecords.at(-1)?.closeReason, 'cancelled');
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
    assert.equal(ledger.getOpenRequest(topicKey)?.id, second.id);
    assert.equal(ledger.getOpenRequest(topicKey)?.silentTurnCount, 0);
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
