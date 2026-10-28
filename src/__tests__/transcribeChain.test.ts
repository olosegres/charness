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
import { transcribeWithEngines, type TranscribeFallbackInfo } from '../stt/transcribeChain';
import { defaultSttTimeout, type ResolvedSttEngine, type SttTimeout } from '../stt/sttSettings';
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
  overrides: { durationSeconds?: number; language?: string | null; filePath?: string } = {},
) {
  const fallbacks: TranscribeFallbackInfo[] = [];
  const retries: TranscribeRetryInfo[] = [];
  const result = await transcribeWithEngines(overrides.filePath ?? audioPath, engines, {
    durationSeconds: overrides.durationSeconds,
    language: overrides.language ?? null,
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

test('Node\'s own timer honours the re-arm: after a report of audio queued ahead, a silent engine is cut no sooner than the extended budget', { timeout: noHangTestTimeoutMs }, async () => {
  // Real timers, real socket. Only the LOWER bound is asserted: a timer never fires early, so a slow host can only make this
  // truer, while a code that kept the first 200 ms would cut the engine long before the extended 600.
  let reportedAtMs = 0;
  let closedAtMs = 0;
  const closed = createSignal();
  reset([(_req, res) => {
    res.on('close', () => { closedAtMs = performance.now(); closed.resolve(); });
    reportedAtMs = performance.now();
    reportQueuedAudio(res, '0.4');
  }], [transcribed('rescued')]);
  const { result } = await runChain([createEngine('local', first, fastTimeout), createEngine('second', second)], { durationSeconds: shortVoiceSeconds });
  assert.equal(result.engine, 'second');
  await closed.promise;
  assert.ok(closedAtMs - reportedAtMs >= extendedBudgetMs - timerEarlySlackMs, `cut ${closedAtMs - reportedAtMs} ms after the report, the extended budget is ${extendedBudgetMs} ms`);
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
