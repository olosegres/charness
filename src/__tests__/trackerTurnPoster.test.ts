/**
 * @description What a tracker conversation's request prompt and issue update do once handed to the session post
 * (`requests/trackerTurnPoster.ts`, the part of `createJiraSessionDeps` in `bot.ts` that talks to the wake-up engine), over a REAL
 * request ledger and a REAL wake-up engine with the session post faked. Load-bearing facts proven here:
 *   • a posted request prompt, and a forwarded issue update, have the turn they start watched — and the update's words are owed an
 *     answer from then on;
 *   • an issue update HELD over a usage-limit wait starts no turn, yet the request owes an answer from the moment it is held
 *     (persisted), so the turn that finally carries it — a restart during the wait included — ends silent, never quiet under a watch;
 *   • a held request prompt is not tracked (its prompt rides the wait's resume), a failed post is handed to the engine's retries
 *     before it is thrown back, and the person's activity is noted before the post.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { RequestWakeUpEngine } from '../requests/wakeUpEngine';
import { createTrackerTurnPoster, type TrackerTurnPoster } from '../requests/trackerTurnPoster';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import type { OpenRequestState, RequestAlertReason, RequestWakeUpReason } from '../requests/types';
import type { PostToSessionResult, SessionPromptText } from '../postToSession';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

const issueKey: SessionKey = makeJiraKey('PROJ-1');
const handOver = { kind: 'trackerEvent' as const, attributes: { issueKey: 'PROJ-1', triggerId: '100', requester: 'ann' } };
const backstopMs = 90 * 60 * 1000;
const prompt: SessionPromptText = { fullText: 'the comment', buildText: () => 'the comment' };
const idleProbe: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };

let fakeHome: string;
let originalHome: string | undefined;
let dataDir: string;
let nowMs: number;
let probe: SessionTurnProbe;
let posts: string[];
let activity: string[];
let wakeUps: Array<{ requestId: string; reason: RequestWakeUpReason }>;
let alerts: Array<{ requestId: string; reason: RequestAlertReason }>;
let createdStores: StateStore[] = [];
let engines: RequestWakeUpEngine[] = [];
let nextPostResult: PostToSessionResult;
/** The requests the engine watched in the issue as the faked post returned: what was tracked INSIDE the post. */
let watchedAsPostReturned: string[];

async function createLedger(): Promise<RequestLedger> {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  createdStores.push(store);
  const ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
    now: () => nowMs,
    releaseAlert: async () => {},
  });
  await ledger.load();
  return ledger;
}

/** An engine over `ledger` whose request is read as waiting for a passing watch. */
function createEngine(ledger: RequestLedger): RequestWakeUpEngine {
  const engine = new RequestWakeUpEngine({
    ledger,
    probeTurn: () => probe,
    prepareWakeUpSession: async () => true,
    forwardWakeUp: async (_key, request, message) => { wakeUps.push({ requestId: request.id, reason: message.reason }); },
    deliverAlert: async (_key, request, reason) => {
      alerts.push({ requestId: request.id, reason });
      return '777';
    },
    backstopMs,
    getScheduleWait: () => 'watching',
    now: () => nowMs,
  });
  engines.push(engine);
  return engine;
}

function createPoster(engine: RequestWakeUpEngine): TrackerTurnPoster {
  return createTrackerTurnPoster({
    post: async (key, _prompt, options) => {
      posts.push(keyToString(key));
      // As `postToSession` does: the caller's step once the prompt is written, before the settled reminders and the return.
      if (nextPostResult.ok && !nextPostResult.isHeld) await options.afterForward?.();
      watchedAsPostReturned = engine.getWatchedRequestIdsOf(key);
      return nextPostResult;
    },
    notePersonActivity: (key) => { activity.push(`${keyToString(key)} @${posts.length} posts`); },
    getEngine: () => engine,
  });
}

async function endTurnSilently(engine: RequestWakeUpEngine): Promise<void> {
  probe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
  await engine.pollWatchedTurns();
  probe = { ...probe, isBusy: false };
  await engine.pollWatchedTurns();
}

/** The open request of the issue as the persisted ledger holds it, answered `progress` once (nothing owed yet). */
async function createAnsweredRequest(ledger: RequestLedger): Promise<OpenRequestState> {
  const request = await ledger.createRequest(issueKey, handOver);
  await ledger.updateOpenRequest(request.id, { progressAnswerCount: 1 });
  return request;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-trackerposter-'));
  process.env.HOME = fakeHome;
  dataDir = path.join(fakeHome, 'data');
  nowMs = 1_000_000_000;
  probe = idleProbe;
  posts = [];
  activity = [];
  wakeUps = [];
  alerts = [];
  nextPostResult = { ok: true, isHeld: false };
  watchedAsPostReturned = [];
});

afterEach(async () => {
  for (const engine of engines) engine.stop();
  engines = [];
  await Promise.all(createdStores.map((store) => store.flush()));
  createdStores = [];
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('postRequest', () => {
  it('notes the person\'s activity before the post, and watches the turn the prompt started: its words are owed an answer', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver);
    await createPoster(engine).postRequest(issueKey, request.id, prompt);
    assert.deepEqual(activity, [`${keyToString(issueKey)} @0 posts`], 'the idle-compaction latch is cleared before the request is posted');
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).includes(request.id), true, 'the turn is watched');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'a watch passing does not excuse a silent turn on a request prompt');
  });

  it('the turn is watched INSIDE the post, right after the write — before the post delivers the reminders it was handed — so a reminder that joins the turn is watched after this request, which started it (review 16 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver);
    await createPoster(engine).postRequest(issueKey, request.id, prompt);
    assert.deepEqual(watchedAsPostReturned, [request.id]);
  });

  it('a held request prompt is not tracked — its prompt rides the wait\'s resume (R21)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver);
    nextPostResult = { ok: true, isHeld: true };
    await createPoster(engine).postRequest(issueKey, request.id, prompt);
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).includes(request.id), false);
  });

  it('a failed post is handed to the engine\'s retries (R28) before the failure is thrown back to the connector', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver, { createPrompt: (id) => `[Request ${id}]` });
    nextPostResult = { ok: false, reason: 'forward-failed', error: 'the pipe is gone' };
    await assert.rejects(createPoster(engine).postRequest(issueKey, request.id, prompt), /the pipe is gone/);
    assert.notEqual(ledger.getNewestOpenRequest(issueKey)?.nextPostRetryAt, undefined, 'a retry is scheduled');
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).includes(request.id), false, 'nothing is watched for a prompt that never got in');
  });
});

describe('postUpdate', () => {
  it('a forwarded update watches the turn it starts for the request its text named, and its words are owed an answer', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createAnsweredRequest(ledger);
    await createPoster(engine).postUpdate(issueKey, prompt, () => request.id);
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).includes(request.id), true);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true);
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'a comment left unanswered is reminded though a watch passes');
  });

  it('the update\'s turn is watched inside the post too, for the request its text names (read once the update is written) (review 16 #2)', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createAnsweredRequest(ledger);
    await createPoster(engine).postUpdate(issueKey, prompt, () => request.id);
    assert.deepEqual(watchedAsPostReturned, [request.id]);
  });

  it('a failure is thrown back to the connector, which decides the comment again — nothing is watched or marked owed', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createAnsweredRequest(ledger);
    nextPostResult = { ok: false, reason: 'forward-failed', error: 'the pipe is gone' };
    await assert.rejects(createPoster(engine).postUpdate(issueKey, prompt, () => request.id), /the pipe is gone/);
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).length, 0);
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, undefined);
  });

  it('a HELD update starts no turn, yet the request owes an answer from the moment it is held — persisted, so a restart during the wait changes nothing', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createAnsweredRequest(ledger);
    nextPostResult = { ok: true, isHeld: true };
    await createPoster(engine).postUpdate(issueKey, prompt, () => request.id);
    assert.equal(engine.getWatchedRequestIdsOf(issueKey).length, 0, 'no turn started for it');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true, 'owed from the moment it is held');
    engine.stop();

    // The wait ends after a restart that lost every watch: the «continue» nudge that carries the held comment starts a plain turn.
    const restarted = createEngine(ledger);
    await restarted.trackContinuationTurn(issueKey, { isCountersReset: true });
    await endTurnSilently(restarted);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }], 'the held comment is not read as a quiet turn under the passing watch');
  });

  it('the same under the alarm\'s watch: a fire riding the request after the wait carries the held comment and still owes it an answer', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await createAnsweredRequest(ledger);
    nextPostResult = { ok: true, isHeld: true };
    await createPoster(engine).postUpdate(issueKey, prompt, () => request.id);
    await engine.trackForwardedTurn(issueKey, request.id, { isRequestPrompt: false, isScheduledRun: true });
    await endTurnSilently(engine);
    assert.deepEqual(wakeUps, [{ requestId: request.id, reason: 'silentTurn' }]);
    await endTurnSilently(engine);
    assert.deepEqual(alerts, [{ requestId: request.id, reason: 'silentTurns' }], 'and gives up as ever');
  });

  it('a held update for a request that already owes an answer, or for one that is gone, changes nothing and throws nothing', async () => {
    const ledger = await createLedger();
    const engine = createEngine(ledger);
    const request = await ledger.createRequest(issueKey, handOver);
    nextPostResult = { ok: true, isHeld: true };
    const poster = createPoster(engine);
    await poster.postUpdate(issueKey, prompt, () => request.id);
    await poster.postUpdate(issueKey, prompt, () => request.id);
    await poster.postUpdate(issueKey, prompt, () => 'req_gone0001');
    assert.equal(ledger.getNewestOpenRequest(issueKey)?.isPersonInputUnanswered, true);
  });
});
