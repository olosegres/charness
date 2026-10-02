/**
 * @description The request ledger (`requests/requestLedger.ts`, core plan S2):
 * one open request per conversation in `state.json`, closed requests in the
 * `requests.jsonl` history, the supersede rule, and the reload at boot.
 *
 * Every test uses a real `StateStore` over a temp `DATA_DIR` (with a fake HOME so
 * the legacy-migration probe never touches the real one) and a real history file,
 * so "survives a restart" is proven by building a SECOND store + ledger over the
 * same files, not by inspecting memory.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import {
  RequestLedger,
  RequestLedgerNotLoadedError,
  parseClosedRequestLine,
  requestHistoryMaxBytes,
} from '../requests/requestLedger';
import type { ClosedRequestRecord, RequestOrigin } from '../requests/types';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const otherTopicKey: SessionKey = makeTelegramKey(-1001234567890, 99);
const messageOrigin: RequestOrigin = { kind: 'message', attributes: {} };
const trackerOrigin: RequestOrigin = { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-123', triggerId: '10001' } };
const requestIdRe = /^req_[A-Za-z0-9_-]{8}$/;
const saveDebounceMs = 5;

let fakeHome: string;
let dataDir: string;
let historyPath: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-requests-'));
  process.env.HOME = fakeHome;
  dataDir = path.join(fakeHome, 'data');
  historyPath = path.join(dataDir, 'requests.jsonl');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function createStore(): Promise<StateStore> {
  const store = new StateStore(dataDir, { saveDebounceMs });
  await store.init();
  return store;
}

async function createLoadedLedger(store: StateStore, now: () => number = Date.now): Promise<RequestLedger> {
  const ledger = new RequestLedger({ store, history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes), now });
  await ledger.load();
  return ledger;
}

function readHistory(): ClosedRequestRecord[] {
  if (!fs.existsSync(historyPath)) return [];
  return fs
    .readFileSync(historyPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = parseClosedRequestLine(line);
      assert.ok(record, `history line did not parse: ${line}`);
      return record;
    });
}

describe('RequestLedger before load', () => {
  it('refuses every call until load() resolved, then whenLoaded resolves', async () => {
    const store = await createStore();
    const ledger = new RequestLedger({ store, history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes) });
    assert.equal(ledger.checkIsLoaded(), false);
    await assert.rejects(ledger.createRequest(topicKey, messageOrigin), RequestLedgerNotLoadedError);
    assert.throws(() => ledger.getRequest('req_AAAAAAAA'), RequestLedgerNotLoadedError);

    let isWhenLoadedResolved = false;
    const whenLoaded = ledger.whenLoaded().then(() => { isWhenLoadedResolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isWhenLoadedResolved, false, 'whenLoaded must wait for load()');

    await ledger.load();
    await whenLoaded;
    assert.equal(ledger.checkIsLoaded(), true);
    assert.equal(ledger.getRequest('req_AAAAAAAA'), null);
  });

  it('an unreadable history rejects load() and leaves the ledger unloaded', async () => {
    const store = await createStore();
    fs.mkdirSync(historyPath, { recursive: true }); // a directory where the file should be
    const ledger = new RequestLedger({ store, history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes) });
    await assert.rejects(ledger.load());
    assert.equal(ledger.checkIsLoaded(), false);
  });
});

describe('RequestLedger requests', () => {
  it('creates an open request with a fresh id and zeroed counters, persisted per conversation', async () => {
    const createdAt = 1_000;
    const store = await createStore();
    const ledger = await createLoadedLedger(store, () => createdAt);

    const request = await ledger.createRequest(topicKey, trackerOrigin);

    assert.match(request.id, requestIdRe);
    assert.deepEqual(request, {
      id: request.id,
      origin: trackerOrigin,
      createdAt,
      progressAnswerCount: 0,
      silentTurnCount: 0,
      wakeCount: 0,
      isWakeStopped: false,
    });
    assert.deepEqual(store.getOpenRequest(topicKey), request);
    assert.deepEqual(ledger.getRequest(request.id), {
      isOpen: true,
      conversationKey: keyToString(topicKey),
      request,
    });
  });

  it('a new request in the same conversation supersedes the open one; other conversations are untouched', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);
    const first = await ledger.createRequest(topicKey, messageOrigin);
    const elsewhere = await ledger.createRequest(otherTopicKey, messageOrigin);

    const second = await ledger.createRequest(topicKey, messageOrigin);

    assert.notEqual(second.id, first.id);
    assert.equal(ledger.getOpenRequest(topicKey)?.id, second.id);
    assert.equal(ledger.getOpenRequest(otherTopicKey)?.id, elsewhere.id);
    const firstLookup = ledger.getRequest(first.id);
    assert.equal(firstLookup?.isOpen, false);
    assert.equal(firstLookup?.isOpen === false ? firstLookup.request.closeReason : null, 'superseded');
    assert.deepEqual(readHistory().map((record) => [record.id, record.closeReason, record.conversationKey]), [
      [first.id, 'superseded', keyToString(topicKey)],
    ]);
  });

  it('concurrent requests in one conversation leave exactly one open and lose none', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);

    const created = await Promise.all([
      ledger.createRequest(topicKey, messageOrigin),
      ledger.createRequest(topicKey, messageOrigin),
      ledger.createRequest(topicKey, messageOrigin),
    ]);

    const openId = ledger.getOpenRequest(topicKey)?.id;
    const supersededIds = readHistory().map((record) => record.id);
    assert.equal(supersededIds.length, 2);
    assert.deepEqual([openId, ...supersededIds].sort(), created.map((request) => request.id).sort());
  });

  it('closes an open request once; a second close and a close of an unknown id change nothing', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);
    const request = await ledger.createRequest(topicKey, messageOrigin);

    const closed = await ledger.closeRequest(request.id, 'final');

    assert.equal(closed?.closeReason, 'final');
    assert.equal(ledger.getOpenRequest(topicKey), undefined);
    assert.equal(await ledger.closeRequest(request.id, 'cancelled'), null);
    assert.equal(await ledger.closeRequest('req_unknown0', 'cancelled'), null);
    assert.deepEqual(readHistory().map((record) => [record.id, record.closeReason]), [[request.id, 'final']]);
    assert.deepEqual(ledger.listOpenRequests(), []);
  });

  it('updates the counters of an open request, and never the successor of a superseded one', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);
    const first = await ledger.createRequest(topicKey, messageOrigin);

    const updated = await ledger.updateOpenRequest(first.id, { progressAnswerCount: 1, nextWakeAt: 5_000 });
    assert.equal(updated?.progressAnswerCount, 1);
    assert.equal(store.getOpenRequest(topicKey)?.nextWakeAt, 5_000);

    const second = await ledger.createRequest(topicKey, messageOrigin);
    assert.equal(await ledger.updateOpenRequest(first.id, { silentTurnCount: 2 }), null);
    assert.equal(ledger.getOpenRequest(topicKey)?.silentTurnCount, 0);
    assert.equal(ledger.getOpenRequest(topicKey)?.id, second.id);
  });

  it('keys requests by any platform, not only Telegram', async () => {
    registerTestSessionKeyCodec();
    const trackerKey = makeTestKey('PROJ', 'PROJ-123');
    const store = await createStore();
    const ledger = await createLoadedLedger(store);

    const request = await ledger.createRequest(trackerKey, trackerOrigin);

    assert.deepEqual(ledger.listOpenRequests(), [{ key: trackerKey, request }]);
    assert.equal(ledger.getRequest(request.id)?.conversationKey, keyToString(trackerKey));
  });
});

describe('RequestLedger across a restart', () => {
  it('reloads the open set from state.json and knows closed requests from the history', async () => {
    const storeBefore = await createStore();
    const ledgerBefore = await createLoadedLedger(storeBefore);
    const stillOpen = await ledgerBefore.createRequest(topicKey, trackerOrigin);
    await ledgerBefore.updateOpenRequest(stillOpen.id, { wakeCount: 3, lastTurnActivityAt: 7_000 });
    const answered = await ledgerBefore.createRequest(otherTopicKey, messageOrigin);
    await ledgerBefore.closeRequest(answered.id, 'question');
    await storeBefore.flush();

    const ledgerAfter = await createLoadedLedger(await createStore());

    assert.deepEqual(ledgerAfter.getOpenRequest(topicKey), { ...stillOpen, wakeCount: 3, lastTurnActivityAt: 7_000 });
    const answeredLookup = ledgerAfter.getRequest(answered.id);
    assert.equal(answeredLookup?.isOpen, false);
    assert.equal(answeredLookup?.isOpen === false ? answeredLookup.request.closeReason : null, 'question');
    assert.equal(ledgerAfter.getRequest('req_unknown0'), null);
  });

  it('drops an open entry the history already shows closed (crash between the two writes)', async () => {
    const storeBefore = await createStore();
    const ledgerBefore = await createLoadedLedger(storeBefore);
    const request = await ledgerBefore.createRequest(topicKey, messageOrigin);
    await storeBefore.flush();
    // The history line landed but the process died before state.json dropped the entry.
    const closedLine: ClosedRequestRecord = {
      ...request,
      conversationKey: keyToString(topicKey),
      closedAt: request.createdAt + 1,
      closeReason: 'final',
    };
    fs.appendFileSync(historyPath, `${JSON.stringify(closedLine)}\n`);

    const storeAfter = await createStore();
    assert.equal(storeAfter.getOpenRequest(topicKey)?.id, request.id, 'precondition: still open on disk');
    const ledgerAfter = await createLoadedLedger(storeAfter);

    assert.equal(ledgerAfter.getOpenRequest(topicKey), undefined);
    assert.equal(ledgerAfter.getRequest(request.id)?.isOpen, false);
  });

  it('skips unreadable history lines instead of failing the load', async () => {
    const storeBefore = await createStore();
    const ledgerBefore = await createLoadedLedger(storeBefore);
    const request = await ledgerBefore.createRequest(topicKey, messageOrigin);
    await ledgerBefore.closeRequest(request.id, 'final');
    const closedLine = readHistory()[0];
    const nonStringAttributeLine = {
      ...closedLine,
      id: 'req_badAttrs',
      origin: { kind: 'trackerEvent', attributes: { issueKey: 123 } },
    };
    fs.appendFileSync(
      historyPath,
      '{"id":"req_truncat\n{"id":"req_noReason","conversationKey":"x"}\n' +
        `${JSON.stringify(nonStringAttributeLine)}\n`,
    );

    const ledgerAfter = await createLoadedLedger(await createStore());

    assert.equal(ledgerAfter.getRequest(request.id)?.isOpen, false);
    assert.equal(ledgerAfter.getRequest('req_noReason'), null);
    assert.equal(ledgerAfter.getRequest('req_badAttrs'), null);
  });
});

describe('RequestLedger durability and the closed-id window', () => {
  it('a new request is on disk before its id is handed out — no flush, no debounce wait', async () => {
    // A long debounce: only an explicit durable save can make the file current.
    const store = new StateStore(dataDir, { saveDebounceMs: 60_000 });
    await store.init();
    const ledger = new RequestLedger({ store, history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes) });
    await ledger.load();

    const request = await ledger.createRequest(topicKey, messageOrigin);

    const onDisk: { openRequests?: Record<string, { id: string }> } = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'),
    );
    assert.equal(onDisk.openRequests?.[keyToString(topicKey)]?.id, request.id);
  });

  it('keeps only the most recent closed ids, at runtime and after a reload', async () => {
    const closedIndexMaxSize = 2;
    const store = await createStore();
    const ledger = new RequestLedger({
      store,
      history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes),
      closedIndexMaxSize,
    });
    await ledger.load();
    const closedIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const request = await ledger.createRequest(topicKey, messageOrigin);
      await ledger.closeRequest(request.id, 'final');
      closedIds.push(request.id);
    }

    assert.equal(ledger.getRequest(closedIds[0]), null, 'the oldest fell out of the window');
    assert.equal(ledger.getRequest(closedIds[1])?.isOpen, false);
    assert.equal(ledger.getRequest(closedIds[2])?.isOpen, false);

    const reloaded = new RequestLedger({
      store: await createStore(),
      history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes),
      closedIndexMaxSize,
    });
    await reloaded.load();
    assert.equal(reloaded.getRequest(closedIds[0]), null);
    assert.equal(reloaded.getRequest(closedIds[2])?.isOpen, false);
  });

  it('a functional update runs on the current request under the lock', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);
    const request = await ledger.createRequest(topicKey, messageOrigin);

    await Promise.all([1, 2, 3].map(() =>
      ledger.updateOpenRequest(request.id, (current) => ({ wakeCount: current.wakeCount + 1 })),
    ));

    assert.equal(ledger.getOpenRequest(topicKey)?.wakeCount, 3);
  });
});

describe('RequestLedger close history', () => {
  it('records every close exactly once, whatever closed it', async () => {
    const store = await createStore();
    const ledger = await createLoadedLedger(store);

    const superseded = await ledger.createRequest(topicKey, messageOrigin);
    const answered = await ledger.createRequest(topicKey, messageOrigin);
    await ledger.closeRequest(answered.id, 'final');
    await ledger.closeRequest(answered.id, 'final');

    assert.deepEqual(
      readHistory().map((record) => [record.id, record.closeReason]),
      [[superseded.id, 'superseded'], [answered.id, 'final']],
    );
  });
});

describe('RequestLedger alert release', () => {
  const alertRef = '777';

  function createReleasingLedger(store: StateStore, released: string[], isReleaseFailing = false): RequestLedger {
    return new RequestLedger({
      store,
      history: new RotatingJsonlFile(historyPath, requestHistoryMaxBytes),
      releaseAlert: async (alert) => {
        if (isReleaseFailing) throw new Error('telegram is unreachable');
        released.push(`${alert.conversationKey}#${alert.alertRef}`);
      },
    });
  }

  const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const releasedRef = `${keyToString(topicKey)}#${alertRef}`;

  it('a recorded alert is on disk at once — no debounce wait', async () => {
    const store = new StateStore(dataDir, { saveDebounceMs: 60_000 });
    await store.init();
    const ledger = createReleasingLedger(store, []);
    await ledger.load();
    const request = await ledger.createRequest(topicKey, messageOrigin);

    assert.equal(await ledger.recordAlert(topicKey, request.id, alertRef), true);

    const onDisk: { openRequests?: Record<string, { alertRef?: string }> } = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'),
    );
    assert.equal(onDisk.openRequests?.[keyToString(topicKey)]?.alertRef, alertRef);
  });

  it('closing a request releases its alert, and only then forgets it', async () => {
    const store = await createStore();
    const released: string[] = [];
    const ledger = createReleasingLedger(store, released);
    await ledger.load();
    const request = await ledger.createRequest(topicKey, messageOrigin);
    await ledger.recordAlert(topicKey, request.id, alertRef);

    await ledger.closeRequest(request.id, 'final');
    await flushMicrotasks();

    assert.deepEqual(released, [releasedRef]);
    assert.deepEqual(store.getUnreleasedRequestAlerts(), {});
  });

  it('an alert recorded after its request closed is released at once', async () => {
    const store = await createStore();
    const released: string[] = [];
    const ledger = createReleasingLedger(store, released);
    await ledger.load();
    const request = await ledger.createRequest(topicKey, messageOrigin);
    await ledger.closeRequest(request.id, 'final');

    assert.equal(await ledger.recordAlert(topicKey, request.id, alertRef), false);
    await flushMicrotasks();

    assert.deepEqual(released, [releasedRef]);
  });

  it('a release that did not happen before the crash is done at the next load', async () => {
    const storeBefore = await createStore();
    const ledgerBefore = createReleasingLedger(storeBefore, [], true);
    await ledgerBefore.load();
    const request = await ledgerBefore.createRequest(topicKey, messageOrigin);
    await ledgerBefore.recordAlert(topicKey, request.id, alertRef);
    await ledgerBefore.closeRequest(request.id, 'final');
    await flushMicrotasks();
    await storeBefore.flush();
    assert.ok(storeBefore.getUnreleasedRequestAlerts()[request.id], 'precondition: still to release');

    const storeAfter = await createStore();
    const released: string[] = [];
    await createReleasingLedger(storeAfter, released).load();
    await flushMicrotasks();

    assert.deepEqual(released, [releasedRef]);
    assert.deepEqual(storeAfter.getUnreleasedRequestAlerts(), {});
  });

  it('an open entry with an alert that the history shows closed has its alert released at load', async () => {
    const storeBefore = await createStore();
    const ledgerBefore = createReleasingLedger(storeBefore, []);
    await ledgerBefore.load();
    const request = await ledgerBefore.createRequest(topicKey, messageOrigin);
    await ledgerBefore.recordAlert(topicKey, request.id, alertRef);
    // The history line landed but the process died before state.json dropped the entry.
    const closedLine: ClosedRequestRecord = {
      ...request,
      alertRef,
      conversationKey: keyToString(topicKey),
      closedAt: request.createdAt + 1,
      closeReason: 'final',
    };
    fs.appendFileSync(historyPath, `${JSON.stringify(closedLine)}\n`);

    const storeAfter = await createStore();
    const released: string[] = [];
    const ledgerAfter = createReleasingLedger(storeAfter, released);
    await ledgerAfter.load();
    await flushMicrotasks();

    assert.equal(ledgerAfter.getOpenRequest(topicKey), undefined);
    assert.deepEqual(released, [releasedRef]);
    assert.deepEqual(storeAfter.getUnreleasedRequestAlerts(), {});
  });
});
