/**
 * @description The `answer_request` contract (`requests/answerRequest.ts`,
 * request/answer core S3) over a REAL request ledger and a recording answer sink:
 * the close rule of each kind, late answers to closed requests, the unknown /
 * out-of-scope refusal, failed delivery, and the wait for the ledger load.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { answerRequest, type AnswerRequestArgs } from '../requests/answerRequest';
import type { RequestOrigin } from '../requests/types';
import type { AnswerDeliveryResult, AnswerSink, AnswerSinks, RequestAnswerDelivery } from '../platform/answerSink';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const otherTopicKey: SessionKey = makeTelegramKey(-1001234567890, 99);
const origin: RequestOrigin = { kind: 'message', attributes: {} };

interface RecordingSink extends AnswerSink {
  deliveries: Array<{ key: SessionKey; delivery: RequestAnswerDelivery }>;
  nextResult: AnswerDeliveryResult;
}

let fakeHome: string;
let originalHome: string | undefined;
let ledger: RequestLedger;
let sink: RecordingSink;
let sinks: AnswerSinks;

function createRecordingSink(): RecordingSink {
  const recording: RecordingSink = {
    deliveries: [],
    nextResult: { ok: true },
    async deliverAnswer(key, delivery) {
      recording.deliveries.push({ key, delivery });
      return recording.nextResult;
    },
  };
  return recording;
}

function createArgs(requestId: string, overrides: Partial<AnswerRequestArgs> = {}): AnswerRequestArgs {
  return {
    requestId,
    kind: 'final',
    body: 'the result',
    checkIsConversationInScope: (conversationKey) => conversationKey === keyToString(topicKey),
    ...overrides,
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-answers-'));
  process.env.HOME = fakeHome;
  const dataDir = path.join(fakeHome, 'data');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
  });
  sink = createRecordingSink();
  sinks = new Map([['telegram', sink]]);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('answerRequest close rules', () => {
  it('final and question close the request; the answer reaches the sink with the request origin', async () => {
    await ledger.load();
    const finalRequest = await ledger.createRequest(topicKey, origin);

    const finalOutcome = await answerRequest({ ledger, answerSinks: sinks }, createArgs(finalRequest.id));

    assert.equal(finalOutcome.ok, true);
    assert.deepEqual(sink.deliveries, [{
      key: topicKey,
      delivery: { requestId: finalRequest.id, kind: 'final', body: 'the result', origin, isRequestOpen: true },
    }]);
    const closedFinal = ledger.getRequest(finalRequest.id);
    assert.equal(closedFinal?.isOpen === false ? closedFinal.request.closeReason : null, 'final');

    const questionRequest = await ledger.createRequest(topicKey, origin);
    await answerRequest({ ledger, answerSinks: sinks }, createArgs(questionRequest.id, { kind: 'question' }));
    const closedQuestion = ledger.getRequest(questionRequest.id);
    assert.equal(closedQuestion?.isOpen === false ? closedQuestion.request.closeReason : null, 'question');
    assert.equal(ledger.getOpenRequest(topicKey), undefined);
  });

  it('progress answers keep the request open and are all counted, concurrent ones included', async () => {
    await ledger.load();
    const request = await ledger.createRequest(topicKey, origin);
    const progressArgs = createArgs(request.id, { kind: 'progress' });

    const outcomes = await Promise.all([
      answerRequest({ ledger, answerSinks: sinks }, progressArgs),
      answerRequest({ ledger, answerSinks: sinks }, progressArgs),
      answerRequest({ ledger, answerSinks: sinks }, progressArgs),
    ]);

    assert.ok(outcomes.every((outcome) => outcome.ok));
    assert.equal(sink.deliveries.length, 3);
    assert.equal(ledger.getOpenRequest(topicKey)?.id, request.id);
    assert.equal(ledger.getOpenRequest(topicKey)?.progressAnswerCount, 3);
  });

  it('a late answer to a superseded request is delivered and changes no request', async () => {
    await ledger.load();
    const superseded = await ledger.createRequest(topicKey, origin);
    const current = await ledger.createRequest(topicKey, origin);

    const outcome = await answerRequest({ ledger, answerSinks: sinks }, createArgs(superseded.id));

    assert.equal(outcome.ok, true);
    assert.match(outcome.ok ? outcome.message : '', /already closed \(superseded\)/);
    assert.equal(sink.deliveries[0]?.delivery.isRequestOpen, false);
    assert.deepEqual(ledger.getOpenRequest(topicKey), current, 'the newer request is untouched');
    const lookup = ledger.getRequest(superseded.id);
    assert.equal(lookup?.isOpen === false ? lookup.request.closeReason : null, 'superseded');
  });
});

describe('answerRequest refusals', () => {
  it('an unknown id and an id outside the scope are refused alike, and nothing is sent', async () => {
    await ledger.load();
    const elsewhere = await ledger.createRequest(otherTopicKey, origin);

    const unknown = await answerRequest({ ledger, answerSinks: sinks }, createArgs('req_unknown0'));
    const outOfScope = await answerRequest({ ledger, answerSinks: sinks }, createArgs(elsewhere.id));

    assert.equal(unknown.ok, false);
    assert.equal(outOfScope.ok, false);
    assert.equal(
      outOfScope.ok ? '' : outOfScope.error.replace(elsewhere.id, 'ID'),
      unknown.ok ? '' : unknown.error.replace('req_unknown0', 'ID'),
    );
    assert.deepEqual(sink.deliveries, []);
    assert.equal(ledger.getOpenRequest(otherTopicKey)?.id, elsewhere.id);
  });

  it('a failed delivery is reported and leaves the request open for a retry', async () => {
    await ledger.load();
    const request = await ledger.createRequest(topicKey, origin);
    sink.nextResult = { ok: false, error: 'the surface is down' };

    const outcome = await answerRequest({ ledger, answerSinks: sinks }, createArgs(request.id));

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.error, /NOT delivered: the surface is down/);
    assert.deepEqual(ledger.getOpenRequest(topicKey), request);
  });

  it('a platform without an answer sink is refused, nothing changes', async () => {
    registerTestSessionKeyCodec();
    const trackerKey = makeTestKey('PROJ', 'PROJ-123');
    await ledger.load();
    const request = await ledger.createRequest(trackerKey, origin);

    const outcome = await answerRequest(
      { ledger, answerSinks: sinks },
      createArgs(request.id, { checkIsConversationInScope: () => true }),
    );

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.error, /platform "test"/);
    assert.equal(ledger.getOpenRequest(trackerKey)?.id, request.id);
  });

  it('a delivery warning is passed on with the success', async () => {
    await ledger.load();
    const request = await ledger.createRequest(topicKey, origin);
    sink.nextResult = { ok: true, warning: 'posted, but not handed back' };

    const outcome = await answerRequest({ ledger, answerSinks: sinks }, createArgs(request.id));

    assert.match(outcome.ok ? outcome.message : '', /Note: posted, but not handed back/);
  });
});

describe('answerRequest during boot', () => {
  it('waits for the ledger load instead of refusing a valid id', async () => {
    // A request from a previous run, persisted before this "boot".
    await ledger.load();
    const request = await ledger.createRequest(topicKey, origin);
    const storeAfterRestart = new StateStore(path.join(fakeHome, 'data'), { saveDebounceMs: 5 });
    await storeAfterRestart.init();
    const ledgerAfterRestart = new RequestLedger({
      store: storeAfterRestart,
      history: new RotatingJsonlFile(path.join(fakeHome, 'data', 'requests.jsonl'), requestHistoryMaxBytes),
    });

    const pending = answerRequest({ ledger: ledgerAfterRestart, answerSinks: sinks }, createArgs(request.id));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sink.deliveries, [], 'nothing happens before the load');
    await ledgerAfterRestart.load();

    const outcome = await pending;
    assert.equal(outcome.ok, true);
    assert.equal(sink.deliveries.length, 1);
  });
});
