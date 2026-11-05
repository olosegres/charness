/**
 * @description The engine chain against two scriptable local servers: a
 * non-last engine is tried ONCE and any failure moves on at once, the LAST one
 * keeps the retry schedule, an empty transcript or an empty file is definitive
 * (never a fallback trigger), and each engine's timeout scales with the voice.
 *
 * The timeout of an attempt is Node's own socket timeout (`req.setTimeout`), armed with the budget the code derives from the
 * voice and re-armed when the engine reports audio queued ahead. A test that lets that deadline race a server delay measures
 * how long the host stalls between two timers, not the code (the budgets ranged from 50 to 300 ms and failed whenever a loaded
 * host paused the process for as long). So the budget tests RECORD what the code asks of `req.setTimeout` and fire the timeout by
 * hand where a scenario means «too late»; the server answers on events, never on a delay. One test keeps the real timer, with a
 * bound a slow host can only make more true.
 */

import { test, before, after, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcribeWithEngines, warmUpFirstEngine, type TranscribeFallbackInfo, type WarmedEndpoint } from '../stt/transcribeChain';
import type { TranscriptionEndpoint } from '../utils/transcribeAudio';
import { defaultSttTimeout, type ResolvedSttEngine, type SttEndpointRequest, type SttTimeout } from '../stt/sttSettings';
import { queuedAudioSecondsHeader, type TranscribeRetryInfo } from '../utils/transcribeAudio';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface ScriptedServer {
  server: http.Server;
  url: string;
  handlers: Handler[];
  bodies: string[];
}

let first: ScriptedServer;
let second: ScriptedServer;
let audioPath = '';
let emptyAudioPath = '';

const testRetryDelaysMs = [10, 20];
/** 0.1 s + 100 % of the voice: a 0-second voice times out after 100 ms. */
const fastTimeout: SttTimeout = { baseSeconds: 0.1, percentOfDuration: 100 };
const noHangTestTimeoutMs = 5_000;
/** 0.1 s + 100 % of (a 0.1 s voice + 0.4 s queued ahead). */
const extendedBudgetMs = 600;
/** A timer can fire a millisecond before `performance.now()` says its time is up. */
const timerEarlySlackMs = 20;

async function startServer(): Promise<ScriptedServer> {
  const scripted: ScriptedServer = { server: http.createServer(), url: '', handlers: [], bodies: [] };
  scripted.server.on('request', (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      scripted.bodies.push(body);
      const handler = scripted.handlers.shift();
      if (!handler) {
        res.statusCode = 500;
        res.end('no handler queued');
        return;
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => scripted.server.listen(0, '127.0.0.1', resolve));
  const address = scripted.server.address();
  if (!address || typeof address !== 'object') throw new Error('test server has no port');
  scripted.url = `http://127.0.0.1:${address.port}/v1/audio/transcriptions`;
  return scripted;
}

before(async () => {
  first = await startServer();
  second = await startServer();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'transcribe-chain-'));
  audioPath = path.join(tempDir, 'voice.ogg');
  emptyAudioPath = path.join(tempDir, 'empty.ogg');
  await fsp.writeFile(audioPath, 'fake-ogg-bytes');
  await fsp.writeFile(emptyAudioPath, '');
});

after(async () => {
  for (const scripted of [first, second]) {
    scripted.server.closeAllConnections();
    await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
  }
  await fsp.rm(path.dirname(audioPath), { recursive: true, force: true });
});

/** A voice shorter than the engine's 0.1 s base budget is still a real length (unlike a 0, which means unknown). */
const shortVoiceSeconds = 0.1;

function reset(firstHandlers: Handler[], secondHandlers: Handler[] = []): void {
  first.handlers = firstHandlers;
  first.bodies = [];
  second.handlers = secondHandlers;
  second.bodies = [];
}

const respondWith = (status: number, body: string): Handler => (_req, res) => {
  res.writeHead(status);
  res.end(body);
};
const transcribed = (text: string) => respondWith(200, JSON.stringify({ text }));
const hang: Handler = () => { /* never answers → the engine's timeout fires */ };

function createEngine(name: string, scripted: ScriptedServer, timeout: SttTimeout = defaultSttTimeout): ResolvedSttEngine {
  return {
    id: name,
    kind: 'url',
    name,
    timeout,
    getEndpoint: () => Promise.resolve({ url: scripted.url, apiKey: `${name}-key`, model: 'test-model' }),
  };
}

function createFailingEngine(name: string, error: Error): ResolvedSttEngine {
  return { id: name, kind: 'gigaam', name, timeout: defaultSttTimeout, getEndpoint: () => Promise.reject(error) };
}

/** What the code asked of the request timeout (`req.setTimeout`) during one test. */
interface RequestTimeouts {
  /** Every budget asked, in order (ms) — the arming one, then each re-arm. */
  asksMs: number[];
  /** Resolves once `count` budgets have been asked (the code has handled the engine's report). */
  waitForAsks: (count: number) => Promise<void>;
  /** The timeout passes: runs the callback the code armed, as Node would when the socket stayed silent for the budget. */
  fire: () => void;
}

/**
 * Replace `ClientRequest.prototype.setTimeout` for the test (restored at its end): nothing is armed, so no wall-clock deadline can
 * pass behind the test's back; the test fires it itself. The request, the socket and the server stay real.
 */
function recordRequestTimeouts(context: TestContext): RequestTimeouts {
  const asksMs: number[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let onTimeout: (() => void) | null = null;
  context.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: http.ClientRequest, timeoutMs: number, callback?: () => void) {
    asksMs.push(timeoutMs);
    // Like Node: a re-arm without a callback keeps the one armed first.
    if (callback) onTimeout = callback;
    for (const waiter of waiters) if (asksMs.length >= waiter.count) waiter.resolve();
    return this;
  });
  return {
    asksMs,
    waitForAsks: (count) => (asksMs.length >= count ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ count, resolve }); })),
    fire: () => {
      if (!onTimeout) throw new Error('no request timeout is armed');
      onTimeout();
    },
  };
}

/** Budgets are computed in floating point (0.1 + 0.7 s is 799.99… ms): equal to within half a millisecond. */
function assertBudgetsMs(actualMs: readonly number[], expectedMs: readonly number[]): void {
  assert.equal(actualMs.length, expectedMs.length, `budgets asked: ${JSON.stringify(actualMs)}`);
  for (const [index, expected] of expectedMs.entries()) {
    assert.ok(Math.abs(actualMs[index] - expected) < 0.5, `budget ${index + 1} is ${expected} ms, was ${actualMs[index]} (all: ${JSON.stringify(actualMs)})`);
  }
}

/** Something a handler signals and a test awaits. */
function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** An interim `102 Processing` reporting the audio queued ahead. Node has no API for a 1xx with custom headers: it goes straight to the socket, before writeHead. */
function reportQueuedAudio(res: http.ServerResponse, queuedSeconds: string): void {
  res.socket?.write(`HTTP/1.1 102 Processing\r\n${queuedAudioSecondsHeader}: ${queuedSeconds}\r\n\r\n`);
}

async function runChain(
  engines: ResolvedSttEngine[],
  overrides: { durationSeconds?: number; language?: string | null; filePath?: string; warmedEndpoint?: WarmedEndpoint | null } = {},
) {
  const fallbacks: TranscribeFallbackInfo[] = [];
  const retries: TranscribeRetryInfo[] = [];
  const result = await transcribeWithEngines(overrides.filePath ?? audioPath, engines, {
    durationSeconds: overrides.durationSeconds,
    language: overrides.language ?? null,
    warmedEndpoint: overrides.warmedEndpoint,
    retryDelaysMs: testRetryDelaysMs,
    onFallback: (info) => { fallbacks.push(info); },
    onRetry: (info) => { retries.push(info); },
  });
  return { result, fallbacks, retries };
}

test('the first engine answers: the second is never asked, and the answering engine is reported', async () => {
  reset([transcribed('from first')], [transcribed('from second')]);
  const { result, fallbacks } = await runChain([createEngine('first', first), createEngine('second', second)]);
  assert.deepEqual(result, { ok: true, text: 'from first', engine: 'first' });
  assert.deepEqual(fallbacks, []);
  assert.equal(second.bodies.length, 0);
  assert.match(first.bodies[0], /test-model/);
});

test('a refused connection falls through to the next engine at once, with no retry pause', async () => {
  const closed = await startServer();
  const deadUrl = closed.url;
  await new Promise<void>((resolve) => closed.server.close(() => resolve()));
  const refusing: ResolvedSttEngine = {
    ...createEngine('refusing', first),
    getEndpoint: () => Promise.resolve({ url: deadUrl, model: 'm' }),
  };
  reset([], [transcribed('rescued')]);
  const { result, fallbacks, retries } = await runChain([refusing, createEngine('second', second)]);
  assert.deepEqual(result, { ok: true, text: 'rescued', engine: 'second' });
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].from, 'refusing');
  assert.equal(fallbacks[0].to, 'second');
  assert.match(fallbacks[0].error, /ECONNREFUSED/);
  assert.deepEqual(retries, [], 'a non-last engine is never retried');
});

test('a hung engine is cut by its own timeout and the chain moves on, with no retry pause', { timeout: noHangTestTimeoutMs }, async () => {
  reset([hang], [transcribed('after timeout')]);
  const { result, fallbacks, retries } = await runChain(
    [createEngine('slow', first, fastTimeout), createEngine('second', second)],
    { durationSeconds: shortVoiceSeconds },
  );
  assert.deepEqual(result, { ok: true, text: 'after timeout', engine: 'second' });
  assert.deepEqual(fallbacks.map((fallback) => fallback.error), ['transcription timed out']);
  assert.deepEqual(retries, []);
});

test('a timeout that passes while the engine is silent falls through to the next engine', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  const arrived = createSignal();
  reset([() => arrived.resolve()], [transcribed('after timeout')]);
  const chain = runChain([createEngine('slow', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  await arrived.promise;
  timeouts.fire();
  const { result, fallbacks } = await chain;
  assert.deepEqual(result, { ok: true, text: 'after timeout', engine: 'second' });
  assert.deepEqual(fallbacks.map((fallback) => fallback.error), ['transcription timed out']);
  assertBudgetsMs(timeouts.asksMs.slice(0, 1), [200]);
});

test('the timeout grows with the voice: a 5 s voice is given far more than a 0.1 s one', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  // 0.1 s + 100 % of the voice: 0.1 s → 200 ms, 5 s → 5.1 s.
  reset([transcribed('short')]);
  await runChain([createEngine('slow', first, fastTimeout)], { durationSeconds: shortVoiceSeconds });
  reset([transcribed('long')]);
  const longVoice = await runChain([createEngine('slow', first, fastTimeout)], { durationSeconds: 5 });
  assert.deepEqual(longVoice.result, { ok: true, text: 'long', engine: 'slow' });
  assertBudgetsMs(timeouts.asksMs, [200, 5100]);
});

test('the local engine\'s report of the audio queued ahead extends the budget by it: a voice waiting in line is not timed out', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  // Reported 0.4 s ahead → 0.1 + 0.5 = 600 ms instead of the voice's own 200. The engine answers only once the code has acted on
  // the report, so nothing but the budget decides.
  reset([async (_req, res) => {
    reportQueuedAudio(res, '0.4');
    await timeouts.waitForAsks(2);
    res.writeHead(200);
    res.end(JSON.stringify({ text: 'waited its turn' }));
  }], [transcribed('never used')]);
  const queued = await runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  assert.deepEqual(queued.result, { ok: true, text: 'waited its turn', engine: 'local' });
  assert.deepEqual(queued.fallbacks, []);
  assertBudgetsMs(timeouts.asksMs, [200, extendedBudgetMs]);
});

test('a report of nothing ahead leaves the voice its own budget', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  reset([(_req, res) => reportQueuedAudio(res, '0.0')], [transcribed('rescued')]);
  const chain = runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  await timeouts.waitForAsks(2);
  timeouts.fire();
  const nothingAhead = await chain;
  assert.equal(nothingAhead.result.engine, 'second');
  assertBudgetsMs(timeouts.asksMs.slice(0, 2), [200, 200]);
});

test('a later report of a longer queue extends the budget again: the voice ahead turned out longer than first known', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  // 0.1 s voice: 200 ms for the first report (0 ahead); the second names 0.6 s ahead → 0.1 + 0.7 = 800 ms from then on.
  reset([async (_req, res) => {
    reportQueuedAudio(res, '0.0');
    await timeouts.waitForAsks(2);
    reportQueuedAudio(res, '0.6');
    await timeouts.waitForAsks(3);
    res.writeHead(200);
    res.end(JSON.stringify({ text: 'after the longer queue' }));
  }], [transcribed('never used')]);
  const result = await runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  assert.deepEqual(result.result, { ok: true, text: 'after the longer queue', engine: 'local' });
  assertBudgetsMs(timeouts.asksMs, [200, 200, 800]);
});

test('Node\'s own timer honours the re-arm: after a report of audio queued ahead, a silent engine is cut no sooner than the extended budget, counted from the re-arm', { timeout: noHangTestTimeoutMs }, async (context) => {
  // What a recorded timeout cannot show is that Node itself re-arms a request's timeout when `setTimeout(ms)` is called again
  // without a callback, and that the callback given first still fires. So the re-arm is Node's own, on a real timer. The FIRST
  // arming is not: the client reads the engine's report some time after the server writes it, and a host that pauses for longer
  // than the first budget (200 ms) runs the overdue timers BEFORE it reads the socket, so a real first deadline could cut the engine
  // before it ever saw the report. Here the first call only registers the callback, as Node does, and arms nothing. The bound is
  // counted from the client's own re-arm and is one-sided: a timer never fires early, so a slow host can only make it truer.
  const originalSetTimeout = http.ClientRequest.prototype.setTimeout;
  let rearmedAtMs = 0;
  let closedAtMs = 0;
  const closed = createSignal();
  context.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: http.ClientRequest, timeoutMs: number, callback?: () => void) {
    if (callback) return this.once('timeout', callback);
    rearmedAtMs = performance.now();
    return originalSetTimeout.call(this, timeoutMs);
  });
  reset([(_req, res) => {
    res.on('close', () => { closedAtMs = performance.now(); closed.resolve(); });
    reportQueuedAudio(res, '0.4');
  }], [transcribed('rescued')]);
  const { result } = await runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  assert.equal(result.engine, 'second');
  await closed.promise;
  assert.ok(rearmedAtMs > 0, 'the code re-armed the timeout when the report came');
  assert.ok(closedAtMs - rearmedAtMs >= extendedBudgetMs - timerEarlySlackMs, `cut ${closedAtMs - rearmedAtMs} ms after the re-arm, the extended budget is ${extendedBudgetMs} ms`);
});

test('an absurdly long reported queue is capped at the longest timer Node can hold', { timeout: noHangTestTimeoutMs }, async () => {
  // Node cannot hold a timer over 2^31-1 ms: it warns (TimeoutOverflowWarning) and shortens it to 1 ms.
  const warnings: string[] = [];
  const recordWarning = (warning: Error) => { warnings.push(warning.name); };
  process.on('warning', recordWarning);
  const reportHugeQueueThenAnswer: Handler = (_req, res) => {
    reportQueuedAudio(res, '1e12');
    setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({ text: 'after a huge queue' })); }, 100);
  };
  try {
    reset([reportHugeQueueThenAnswer], [transcribed('never used')]);
    const result = await runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: 5 });
    assert.deepEqual(result.result, { ok: true, text: 'after a huge queue', engine: 'local' });
    // A warning is emitted on the next tick: let it arrive before checking.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === 'TimeoutOverflowWarning'), []);
  } finally {
    process.off('warning', recordWarning);
  }
});

test('a voice whose Telegram duration is 0 (or missing) is of unknown length, not a 0-second voice: it gets the unknown-length budget', { timeout: noHangTestTimeoutMs }, async (context) => {
  const timeouts = recordRequestTimeouts(context);
  // 0.1 s + 100 % of the voice: a real 0.1 s voice has 200 ms; an unknown length is budgeted as a minute (60.1 s), so the long
  // voice a sender gave no duration for is not cut.
  for (const unknownLength of [0, undefined]) {
    reset([transcribed('in time')], [transcribed('never used')]);
    const unknown = await runChain([createEngine('slow', first, fastTimeout), createEngine('second', second)], { durationSeconds: unknownLength });
    assert.deepEqual(unknown.result, { ok: true, text: 'in time', engine: 'slow' }, `duration ${unknownLength}`);
    assert.deepEqual(unknown.fallbacks, []);
  }
  assertBudgetsMs(timeouts.asksMs, [60_100, 60_100]);
});

test('an HTTP 500 or a 4xx from a non-last engine falls through; so does an endpoint that rejects', async () => {
  reset([respondWith(500, '{"error":{"message":"boom"}}')], [transcribed('after 500')]);
  const afterServerError = await runChain([createEngine('first', first), createEngine('second', second)]);
  assert.equal(afterServerError.result.engine, 'second');
  assert.equal(afterServerError.fallbacks[0].error, 'HTTP 500: boom');
  assert.equal(first.bodies.length, 1, 'a 5xx is not retried on a non-last engine');

  reset([respondWith(401, '{"error":{"message":"bad key"}}')], [transcribed('after 401')]);
  const afterClientError = await runChain([createEngine('first', first), createEngine('second', second)]);
  assert.equal(afterClientError.result.engine, 'second');

  reset([], [transcribed('after spawn failure')]);
  const afterRejection = await runChain([createFailingEngine('local', new Error('sidecar did not start')), createEngine('second', second)]);
  assert.deepEqual(afterRejection.result, { ok: true, text: 'after spawn failure', engine: 'second' });
  assert.deepEqual(afterRejection.fallbacks, [{ from: 'local', to: 'second', error: 'sidecar did not start' }]);
  assert.deepEqual(afterRejection.retries, []);
});

test('an empty transcript is definitive: no fallback, Groq-style silence hallucinations are not "fixed" by another engine', async () => {
  reset([respondWith(200, JSON.stringify({ text: '' }))], [transcribed('invented words')]);
  const { result, fallbacks } = await runChain([createEngine('first', first), createEngine('second', second)]);
  assert.deepEqual(result, { ok: false, error: 'transcription returned empty text', isDefinitive: true, engine: 'first' });
  assert.deepEqual(fallbacks, []);
  assert.equal(second.bodies.length, 0);
});

test('an empty audio file is definitive too and calls no engine', async () => {
  reset([transcribed('never')], [transcribed('never')]);
  const { result, fallbacks } = await runChain([createEngine('first', first), createEngine('second', second)], {
    filePath: emptyAudioPath,
  });
  assert.deepEqual(result, { ok: false, error: 'downloaded audio is empty', isDefinitive: true, engine: 'first' });
  assert.deepEqual(fallbacks, []);
  assert.equal(first.bodies.length + second.bodies.length, 0);
});

test('only the LAST engine retries: a 503 then a 200 is retried on the schedule and announced', async () => {
  reset([respondWith(500, 'down')], [respondWith(503, '{"error":{"message":"busy"}}'), transcribed('second wind')]);
  const { result, fallbacks, retries } = await runChain([createEngine('first', first), createEngine('last', second)]);
  assert.deepEqual(result, { ok: true, text: 'second wind', engine: 'last' });
  assert.equal(fallbacks.length, 1);
  assert.deepEqual(retries, [{ attemptNumber: 1, error: 'HTTP 503: busy', delayMs: 10 }]);
  assert.equal(second.bodies.length, 2);
});

test('a single engine is the last one: it retries, and gives up with the attempt count', async () => {
  reset([respondWith(503, 'a'), respondWith(503, 'b'), respondWith(503, 'c')]);
  const { result, retries } = await runChain([createEngine('only', first)]);
  assert.deepEqual(result, { ok: false, error: 'HTTP 503: c (after 3 attempts)', engine: 'only' });
  assert.equal(retries.length, 2);
});

test('when every engine fails the LAST error is reported', async () => {
  reset([respondWith(500, '{"error":{"message":"first down"}}')], [respondWith(400, '{"error":{"message":"second refuses"}}')]);
  const { result, fallbacks } = await runChain([createEngine('first', first), createEngine('last', second)]);
  assert.deepEqual(result, { ok: false, error: 'HTTP 400: second refuses', engine: 'last' });
  assert.deepEqual(fallbacks.map((fallback) => fallback.error), ['HTTP 500: first down']);
});

test('the last engine whose endpoint rejects ends the chain with that error', async () => {
  const { result } = await runChain([createFailingEngine('local', new Error('unhealthy until 12:05'))]);
  assert.deepEqual(result, { ok: false, error: 'unhealthy until 12:05', engine: 'local' });
});

test('no engines → a clear failure instead of a hang', async () => {
  const { result } = await runChain([]);
  assert.deepEqual(result, { ok: false, error: 'no speech engine available' });
});

test('the language hint rides to every engine only when it is set', async () => {
  reset([transcribed('with')], []);
  await runChain([createEngine('first', first)], { language: 'ru' });
  assert.match(first.bodies[0], /name="language"\r\n\r\nru\r\n/);

  reset([transcribed('without')], []);
  await runChain([createEngine('first', first)], { language: null });
  assert.doesNotMatch(first.bodies[0], /name="language"/);
});

test('a retry of the last engine asks it for its endpoint again — a process that came back elsewhere is found', async () => {
  reset([respondWith(503, '{"error":{"message":"restarting"}}')], [transcribed('on the new port')]);
  let asked = 0;
  const comesBackElsewhere: ResolvedSttEngine = {
    id: 'g',
    kind: 'gigaam',
    name: 'gigaam',
    timeout: defaultSttTimeout,
    getEndpoint: () => {
      asked++;
      return Promise.resolve({ url: (asked === 1 ? first : second).url, apiKey: 'token', model: 'gigaam' });
    },
  };
  const { result, retries } = await runChain([comesBackElsewhere], { language: 'ru' });
  assert.deepEqual(result, { ok: true, text: 'on the new port', engine: 'gigaam' });
  assert.equal(asked, 2);
  assert.equal(retries.length, 1);
  assert.equal(first.bodies.length, 1);
  assert.equal(second.bodies.length, 1);
  assert.match(second.bodies[0], /name="language"\r\n\r\nru\r\n/, 'the language hint rides on the refreshed endpoint too');
});

test('a retry whose endpoint cannot be had ends the voice with that reason', async () => {
  reset([respondWith(503, 'down')]);
  let asked = 0;
  const cannotRestart: ResolvedSttEngine = {
    id: 'g',
    kind: 'gigaam',
    name: 'gigaam',
    timeout: defaultSttTimeout,
    getEndpoint: () => {
      asked++;
      return asked === 1 ? Promise.resolve({ url: first.url, model: 'gigaam' }) : Promise.reject(new Error('gigaam is unhealthy until 14:05'));
    },
  };
  const { result, retries } = await runChain([cannotRestart]);
  assert.deepEqual(result, { ok: false, error: 'gigaam is unhealthy until 14:05', engine: 'gigaam' });
  assert.equal(retries.length, 1, 'the retry was announced before the endpoint was asked for');
});

test('a non-last engine is asked for its endpoint once — it is not retried', async () => {
  reset([respondWith(503, 'down')], [transcribed('rescued')]);
  let asked = 0;
  const firstEngine: ResolvedSttEngine = {
    ...createEngine('first', first),
    getEndpoint: () => {
      asked++;
      return Promise.resolve({ url: first.url, model: 'm' });
    },
  };
  const { result } = await runChain([firstEngine, createEngine('last', second)]);
  assert.equal(result.engine, 'last');
  assert.equal(asked, 1);
});

/** An engine of the given kind whose endpoint the test settles by hand; it counts how often it was asked. */
function createControlledEngine(kind: ResolvedSttEngine['kind'], name: string = kind): {
  engine: ResolvedSttEngine;
  getAsked: () => number;
  /** What each ask said about itself (`{ isWarmUp: true }` for a warm-up, nothing for a voice). */
  getRequests: () => Array<SttEndpointRequest | undefined>;
  answer: (endpoint: TranscriptionEndpoint) => void;
  reject: (error: Error) => void;
} {
  let asked = 0;
  const requests: Array<SttEndpointRequest | undefined> = [];
  let answer: (endpoint: TranscriptionEndpoint) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const engine: ResolvedSttEngine = {
    id: name,
    kind,
    name,
    timeout: defaultSttTimeout,
    getEndpoint: (request) => {
      asked++;
      requests.push(request);
      return new Promise<TranscriptionEndpoint>((resolve, rejectPromise) => { answer = resolve; reject = rejectPromise; });
    },
  };
  return { engine, getAsked: () => asked, getRequests: () => requests, answer: (endpoint) => answer(endpoint), reject: (error) => reject(error) };
}

/** Let the promise callbacks (and an unhandled rejection, raised after the microtasks) run. */
async function settleCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const logWarningNowhere = (): void => {};

async function waitUntil(check: () => boolean, description: string): Promise<void> {
  const deadlineMs = Date.now() + noHangTestTimeoutMs;
  while (!check()) {
    if (Date.now() > deadlineMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('warm-up: a local engine that a voice would reach FIRST is asked for its endpoint at once, and only once; any other first engine starts nothing', () => {
  const local = createControlledEngine('gigaam');
  const hosted = createControlledEngine('groq');
  const warmed = warmUpFirstEngine([local.engine, hosted.engine], logWarningNowhere);
  assert.equal(warmed?.engineId, 'gigaam');
  assert.equal(local.getAsked(), 1);
  assert.deepEqual(local.getRequests(), [{ isWarmUp: true }], 'the ask says it is a warm-up: the engine must never act on silence for it');
  assert.equal(hosted.getAsked(), 0, 'the later engine is not touched');

  const hostedFirst = createControlledEngine('groq');
  const localBehind = createControlledEngine('gigaam');
  assert.equal(warmUpFirstEngine([hostedFirst.engine, localBehind.engine], logWarningNowhere), null);
  assert.equal(localBehind.getAsked(), 0, 'a local engine behind a hosted one may never be reached');
  assert.equal(warmUpFirstEngine([], logWarningNowhere), null);
});

test('warm-up: the voice REUSES the warm-up\'s ask — the engine is asked once for the voice, and the answer is the one the warm-up got', async () => {
  reset([transcribed('from the warmed endpoint')]);
  const local = createControlledEngine('gigaam');
  const warmed = warmUpFirstEngine([local.engine], logWarningNowhere);
  local.answer({ url: first.url, apiKey: 'local-key', model: 'm' });

  const { result } = await runChain([local.engine], { warmedEndpoint: warmed });
  assert.deepEqual(result, { ok: true, text: 'from the warmed endpoint', engine: 'gigaam' });
  assert.equal(local.getAsked(), 1, 'one ask in all: the warm-up\'s');
  assert.deepEqual(local.getRequests(), [{ isWarmUp: true }]);
});

test('warm-up: a start that FAILED fast is the voice\'s outcome too — no second ask (no second spawn, no second failed start); a hosted engine behind takes the voice', async () => {
  reset([], [transcribed('from the hosted engine')]);
  const local = createControlledEngine('gigaam');
  const warmed = warmUpFirstEngine([local.engine], logWarningNowhere);
  local.reject(new Error('the local engine exited before it was ready (see sidecar.log)'));
  await settleCallbacks(); // the failure is over before the voice's job gets to the engine

  const { result, fallbacks } = await runChain([local.engine, createEngine('hosted', second)], { warmedEndpoint: warmed });
  assert.deepEqual(result, { ok: true, text: 'from the hosted engine', engine: 'hosted' });
  assert.equal(local.getAsked(), 1, 'the voice did not ask the engine again');
  assert.deepEqual(fallbacks.map((fallback) => fallback.error), ['the local engine exited before it was ready (see sidecar.log)']);

  const lonely = createControlledEngine('gigaam');
  const lonelyWarmed = warmUpFirstEngine([lonely.engine], logWarningNowhere);
  lonely.reject(new Error('the local engine could not be started: spawn failed'));
  await settleCallbacks();
  const lonelyOutcome = await runChain([lonely.engine], { warmedEndpoint: lonelyWarmed });
  assert.deepEqual(lonelyOutcome.result, { ok: false, error: 'the local engine could not be started: spawn failed', engine: 'gigaam' });
  assert.equal(lonely.getAsked(), 1);
});

test('warm-up: only the first ask is the warm-up\'s — a retry of the last engine asks it again; a warm-up of another engine is ignored', async () => {
  reset([respondWith(503, 'down'), transcribed('after the retry')]);
  const local = createControlledEngine('gigaam');
  const warmed = warmUpFirstEngine([local.engine], logWarningNowhere);
  local.answer({ url: first.url, model: 'm' });
  const retryEndpoint = runChain([local.engine], { warmedEndpoint: warmed });
  await waitUntil(() => local.getAsked() === 2, 'the retry to ask the engine itself');
  local.answer({ url: first.url, model: 'm' });
  assert.equal((await retryEndpoint).result.ok, true);

  reset([transcribed('asked normally')]);
  const other = createEngine('other', first);
  let otherAsked = 0;
  const countingOther: ResolvedSttEngine = { ...other, getEndpoint: () => { otherAsked++; return other.getEndpoint(); } };
  const unrelated = createControlledEngine('gigaam', 'someone-else');
  const wrongWarm = warmUpFirstEngine([unrelated.engine], logWarningNowhere);
  const { result } = await runChain([countingOther], { warmedEndpoint: wrongWarm });
  assert.equal(result.ok, true);
  assert.equal(otherAsked, 1, 'the engine the voice meets is asked itself');
});

test('warm-up: a failed start leaves ONE log line (the voice\'s job may end before it ever asks); a good one leaves none', async () => {
  const lines: string[] = [];
  const failing = createControlledEngine('gigaam');
  warmUpFirstEngine([failing.engine], (line) => lines.push(line));
  failing.reject(new Error('the local engine was still loading its model after 120 s (see sidecar.log)'));
  await settleCallbacks();
  assert.deepEqual(lines, ['[STT] warm-up start of gigaam failed: the local engine was still loading its model after 120 s (see sidecar.log)']);

  const good = createControlledEngine('gigaam');
  warmUpFirstEngine([good.engine], (line) => lines.push(line));
  good.answer({ url: first.url, model: 'm' });
  await settleCallbacks();
  assert.equal(lines.length, 1);
});

test('a failed warm-up nobody asks for again never becomes an unhandled rejection', async () => {
  const unhandled: Error[] = [];
  const recordUnhandled = (reason: Error): void => { unhandled.push(reason); };
  process.on('unhandledRejection', recordUnhandled);
  try {
    const local = createControlledEngine('gigaam');
    warmUpFirstEngine([local.engine], logWarningNowhere);
    local.reject(new Error('the local engine could not be started'));
    await settleCallbacks();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

const shortStartBudgetMs = 30;

test('a NON-last engine still starting after its budget hands the voice to the next engine — and its start is not cancelled: the next voice gets it', async () => {
  reset([], [transcribed('from the hosted engine')]);
  const local = createControlledEngine('gigaam');
  const { result, fallbacks } = await runChainWithStartBudget([local.engine, createEngine('hosted', second)]);
  assert.deepEqual(result, { ok: true, text: 'from the hosted engine', engine: 'hosted' });
  assert.equal(fallbacks.length, 1);
  assert.deepEqual([fallbacks[0].from, fallbacks[0].to], ['gigaam', 'hosted']);
  assert.match(fallbacks[0].error, /^gigaam was still starting after \d+ s; it keeps starting for the next voice$/);
  assert.equal(local.getAsked(), 1);

  // The start the first voice gave up on finishes later: nothing breaks, and its failure (or success) belongs to the start.
  const unhandled: Error[] = [];
  const recordUnhandled = (reason: Error): void => { unhandled.push(reason); };
  process.on('unhandledRejection', recordUnhandled);
  try {
    local.reject(new Error('the local engine was still loading its model after 120 s (see sidecar.log)'));
    await settleCallbacks();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

test('a NON-last engine that is ready within its budget is used as before; the LAST engine is waited for however long its start takes', async () => {
  reset([transcribed('from the local engine')]);
  const quick = createControlledEngine('gigaam');
  const quickRun = runChainWithStartBudget([quick.engine, createEngine('hosted', second)]);
  quick.answer({ url: first.url, model: 'm' });
  assert.deepEqual((await quickRun).result, { ok: true, text: 'from the local engine', engine: 'gigaam' });
  assert.deepEqual(quick.getRequests(), [undefined], 'a voice that asks for itself is a plain ask, not a warm-up');

  reset([transcribed('after a long start')]);
  const slow = createControlledEngine('gigaam');
  const slowRun = runChainWithStartBudget([slow.engine]);
  await new Promise<void>((resolve) => setTimeout(resolve, shortStartBudgetMs * 4)); // far past the budget the other engines get
  slow.answer({ url: first.url, model: 'm' });
  const slowOutcome = await slowRun;
  assert.deepEqual(slowOutcome.result, { ok: true, text: 'after a long start', engine: 'gigaam' });
  assert.deepEqual(slowOutcome.fallbacks, []);
});

async function runChainWithStartBudget(engines: ResolvedSttEngine[]) {
  const fallbacks: TranscribeFallbackInfo[] = [];
  const result = await transcribeWithEngines(audioPath, engines, {
    language: null,
    retryDelaysMs: testRetryDelaysMs,
    nonLastEngineStartBudgetMs: shortStartBudgetMs,
    onFallback: (info) => { fallbacks.push(info); },
  });
  return { result, fallbacks };
}
