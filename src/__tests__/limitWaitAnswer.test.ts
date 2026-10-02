/**
 * @description The bot's own answer to an open request when a usage limit stops
 * the agent (`requests/limitWaitAnswer.ts`, request/answer core S5), over a REAL
 * request ledger and wake-up engine with a recording answer sink.
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
import { answerOpenRequestForLimitWait, type LimitWaitAnswerDeps } from '../requests/limitWaitAnswer';
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
  it('answers the open request with a progress note that keeps it open and is not the agent\'s progress', async () => {
    const deps = await createDeps();
    const request = await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    const isAnswered = await answerOpenRequestForLimitWait(deps, topicKey, { kind: 'afterReset', resetAt }, answerBody);

    assert.equal(isAnswered, true, 'the plain limit notice is replaced');
    assert.deepEqual(deliveries, [{
      requestId: request.id,
      kind: 'progress',
      body: answerBody,
      origin: request.origin,
      isRequestOpen: true,
    }]);
    const open = deps.ledger.getOpenRequest(topicKey);
    assert.equal(open?.id, request.id);
    assert.equal(open?.progressAnswerCount, 0, 'no 15-minute follow-up is started by the bot\'s own note');
    assert.equal(open?.isWakeStopped, false, 'auto-resume continues the work: wake-ups are only paused');
  });

  it('with auto-resume off the request stops being woken until the operator writes', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, { kind: 'autoResumeOff' }, answerBody), true);

    const open = deps.ledger.getOpenRequest(topicKey);
    assert.equal(open?.isWakeStopped, true);
    assert.equal(open?.nextWakeAt, undefined);
  });

  it('without an open request nothing is answered and the plain notice stays', async () => {
    const deps = await createDeps();

    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, { kind: 'nextAttempt', fireAt: resetAt }, answerBody), false);
    assert.deepEqual(deliveries, []);
  });

  it('a failed delivery, or a platform without a sink, falls back to the plain notice', async () => {
    const deps = await createDeps();
    await deps.ledger.createRequest(topicKey, { kind: 'message', attributes: {} });

    deliveryResult = { ok: false, error: 'Telegram is unreachable' };
    assert.equal(await answerOpenRequestForLimitWait(deps, topicKey, { kind: 'afterReset', resetAt }, answerBody), false);

    const unserved = { ...deps, answerSinks: new Map() };
    assert.equal(await answerOpenRequestForLimitWait(unserved, topicKey, { kind: 'afterReset', resetAt }, answerBody), false);
  });
});
