/**
 * @description The bot's own answer to an open request when a usage limit stops
 * the agent (`requests/limitWaitAnswer.ts`, request/answer core S5), over a REAL
 * request ledger and wake-up engine with a recording answer sink.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { RequestWakeUpEngine } from '../requests/wakeUpEngine';
import {
  answerOpenRequestForLimitWait,
  getLimitWaitForNewRequest,
  getUsageLimitWaitIdentity,
  type LimitEpisodeState,
  type LimitWaitAnswerDeps,
  type UsageLimitWait,
} from '../requests/limitWaitAnswer';
import type { AnswerDeliveryResult, AnswerSink, RequestAnswerDelivery } from '../platform/answerSink';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const answerBody = 'Usage limit reached — the answer will come after 22:50.';
const resetAt = 1_700_000_000_000;

let fakeHome: string;
let originalHome: string | undefined;
let deliveries: RequestAnswerDelivery[];
let deliveryResult: AnswerDeliveryResult;

async function createDeps(): Promise<LimitWaitAnswerDeps & { ledger: RequestLedger }> {
  const dataDir = path.join(fakeHome, 'data');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  const ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
  });
  await ledger.load();
  const engine = new RequestWakeUpEngine({
    ledger,
    probeTurn: () => ({ isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false }),
    prepareWakeUpSession: async () => true,
    forwardWakeUp: async () => {},
    deliverAlert: async () => null,
    backstopMs: 90 * 60 * 1000,
  });
  const sink: AnswerSink = {
    deliverAnswer: async (_key, delivery) => {
      deliveries.push(delivery);
      return deliveryResult;
    },
    deliverAlert: async () => ({ ok: true }),
    releaseAlert: async () => {},
  };
  return { ledger, engine, answerSinks: new Map([['telegram', sink]]) };
}

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-limitwait-'));
  process.env.HOME = fakeHome;
  deliveries = [];
  deliveryResult = { ok: true };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('answerOpenRequestForLimitWait', () => {
  const afterReset: UsageLimitWait = { kind: 'afterReset', resetAt, fireAt: resetAt + 1000 };

  it('answers the open request with a progress note that keeps it open and is not the agent\'s progress', async () => {
    const deps = await createDeps();
    const request = await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'answered');

    assert.deepEqual(deliveries, [{
      requestId: request.id,
      kind: 'progress',
      body: answerBody,
      origin: request.origin,
      isRequestOpen: true,
    }]);
    const open = deps.ledger.getNewestOpenRequest(topicKey);
    assert.equal(open?.id, request.id);
    assert.equal(open?.progressAnswerCount, 0, 'no 15-minute follow-up is started by the bot\'s own note');
    assert.equal(open?.isLimitStopped, undefined, 'auto-resume continues the work: wake-ups are only paused');
  });

  it('each request hears about a wait once: a repeat is deduplicated, a newer request answered again', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'answered');

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'alreadyAnswered');
    assert.equal(deliveries.length, 1);

    // A scheduled run opened later in the same wait.
    const later = await deps.ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: {} });
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'answered');
    assert.deepEqual(deliveries.map((delivery) => delivery.requestId).slice(1), [later.id]);
  });

  it('every requester\'s open request in the conversation hears about the wait, each once', async () => {
    const deps = await createDeps();
    const operatorRequest = await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    const colleagueRequest = await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '535353' } });
    const wait: UsageLimitWait = { kind: 'afterReset', resetAt, fireAt: resetAt + 1 };

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, wait, answerBody), 'answered');
    assert.deepEqual(deliveries.map((delivery) => delivery.requestId).sort(), [operatorRequest.id, colleagueRequest.id].sort());
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, wait, answerBody), 'alreadyAnswered');
    assert.equal(deliveries.length, 2, 'the repeat delivers nothing');
  });

  it('a repeated error and a request opened at the same moment answer once', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    // A state write still in flight: both calls read the request before either claims it.
    const busyLedger: LimitWaitAnswerDeps['ledger'] = {
      listOpenRequestsOf: (key) => deps.ledger.listOpenRequestsOf(key),
      updateOpenRequest: async (id, update) => {
        await new Promise((resolve) => setImmediate(resolve));
        return deps.ledger.updateOpenRequest(id, update);
      },
    };
    const racingDeps = { ...deps, ledger: busyLedger };

    const outcomes = await Promise.all([
      answerOpenRequestForLimitWait(racingDeps, topicKey, afterReset, answerBody),
      answerOpenRequestForLimitWait(racingDeps, topicKey, afterReset, answerBody),
    ]);

    assert.deepEqual([...outcomes].sort(), ['alreadyAnswered', 'answered']);
    assert.equal(deliveries.length, 1);
  });

  it('a new wait (re-armed after a skipped resume) is answered again on the same request', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody);

    const rearmed: UsageLimitWait = { kind: 'nextAttempt', fireAt: resetAt + 60_000 };
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, rearmed, answerBody), 'answered');
    assert.equal(deliveries.length, 2);
  });

  it('with auto-resume off every request is stopped by a LIMIT stop, not the rules\' own give-up', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const off: UsageLimitWait = { kind: 'autoResumeOff' };

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, off, answerBody), 'answered');
    const first = deps.ledger.getNewestOpenRequest(topicKey);
    assert.equal(first?.isLimitStopped, true);
    assert.equal(first?.isWakeStopped, false);

    await deps.ledger.createRequest(topicKey, { kind: 'trackerEvent', attributes: {} });
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, off, answerBody), 'answered');
    assert.equal(deps.ledger.getNewestOpenRequest(topicKey)?.isLimitStopped, true, 'the later request is stopped too');
  });

  it('without an open request nothing is answered and the plain notice stays', async () => {
    const deps = await createDeps();

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'notAnswered');
    assert.deepEqual(deliveries, []);
  });

  it('a failed delivery, or a platform without a sink, falls back to the plain notice and is retried later', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    deliveryResult = { ok: false, error: 'Telegram is unreachable' };
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'notAnswered');
    const unserved = { ...deps, answerSinks: new Map() };
    assert.equal(await answerOpenRequestForLimitWait(unserved, topicKey, afterReset, answerBody), 'notAnswered');

    deliveryResult = { ok: true };
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, afterReset, answerBody), 'answered');
  });
});

describe('getLimitWaitForNewRequest', () => {
  const idle: LimitEpisodeState = { armedLimitWait: null, isAutoResumeOffNoticed: false, isAutoResumeOn: true };

  it('outside a limit wait a new request hears nothing', () => {
    assert.equal(getLimitWaitForNewRequest(idle), null);
  });

  it('during an armed wait it hears that wait, its instant kept when re-armed from disk', () => {
    const wait: UsageLimitWait = { kind: 'afterReset', resetAt, fireAt: resetAt + 1000 };
    assert.deepEqual(getLimitWaitForNewRequest({ ...idle, armedLimitWait: { fireAt: wait.fireAt, wait } }), wait);
    assert.deepEqual(
      getLimitWaitForNewRequest({ ...idle, armedLimitWait: { fireAt: resetAt } }),
      { kind: 'nextAttempt', fireAt: resetAt },
    );
  });

  it('after a limit hit with auto-resume off it hears "auto-resume is off" — unless auto-resume was turned back on', () => {
    const offEpisode: LimitEpisodeState = { ...idle, isAutoResumeOffNoticed: true, isAutoResumeOn: false };
    assert.deepEqual(getLimitWaitForNewRequest(offEpisode), { kind: 'autoResumeOff' });
    assert.equal(getLimitWaitForNewRequest({ ...offEpisode, isAutoResumeOn: true }), null);
  });
});

describe('getUsageLimitWaitIdentity', () => {
  it('two arming of a wait differ; the reset-known and unknown forms of one arming match', () => {
    const fireAt = resetAt + 1000;
    assert.equal(
      getUsageLimitWaitIdentity({ kind: 'afterReset', resetAt, fireAt }),
      getUsageLimitWaitIdentity({ kind: 'nextAttempt', fireAt }),
    );
    assert.notEqual(
      getUsageLimitWaitIdentity({ kind: 'nextAttempt', fireAt }),
      getUsageLimitWaitIdentity({ kind: 'nextAttempt', fireAt: fireAt + 1 }),
    );
  });
});
