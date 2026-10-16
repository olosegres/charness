/**
 * @description The engine chain against two scriptable local servers: a
 * non-last engine is tried ONCE and any failure moves on at once, the LAST one
 * keeps the retry schedule, an empty transcript or an empty file is definitive
 * (never a fallback trigger), and each engine's timeout scales with the voice.
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcribeWithEngines, type TranscribeFallbackInfo } from '../stt/transcribeChain';
import { defaultSttTimeout, type ResolvedSttEngine, type SttTimeout } from '../stt/sttSettings';
import type { TranscribeRetryInfo } from '../utils/transcribeAudio';

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

async function runChain(
  engines: ResolvedSttEngine[],
  overrides: { durationSeconds?: number; language?: string | null; filePath?: string } = {},
) {
  const fallbacks: TranscribeFallbackInfo[] = [];
  const retries: TranscribeRetryInfo[] = [];
  const startedAtMs = Date.now();
  const result = await transcribeWithEngines(overrides.filePath ?? audioPath, engines, {
    durationSeconds: overrides.durationSeconds,
    language: overrides.language ?? null,
    retryDelaysMs: testRetryDelaysMs,
    onFallback: (info) => { fallbacks.push(info); },
    onRetry: (info) => { retries.push(info); },
  });
  return { result, fallbacks, retries, elapsedMs: Date.now() - startedAtMs };
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

test('a timeout falls through, and the budget is derived from the voice length', { timeout: noHangTestTimeoutMs }, async () => {
  reset([hang], [transcribed('after timeout')]);
  const { result, fallbacks, elapsedMs } = await runChain(
    [createEngine('slow', first, fastTimeout), createEngine('second', second)],
    { durationSeconds: 0 },
  );
  assert.deepEqual(result, { ok: true, text: 'after timeout', engine: 'second' });
  assert.deepEqual(fallbacks.map((fallback) => fallback.error), ['transcription timed out']);
  assert.ok(elapsedMs < 2_000, `0.1 s base on a 0 s voice must not wait long (took ${elapsedMs} ms)`);
});

test('the timeout grows with the voice: a longer voice outlasts a delay that kills a short one', { timeout: noHangTestTimeoutMs }, async () => {
  const answerAfter = (delayMs: number, text: string): Handler => (_req, res) => {
    setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({ text })); }, delayMs);
  };
  // 0.1 s + 100 % of the voice: 0 s → 100 ms (the 500 ms answer is too late), 5 s → 5.1 s (it is in time).
  reset([answerAfter(500, 'too late')], [transcribed('rescued')]);
  const shortVoice = await runChain([createEngine('slow', first, fastTimeout), createEngine('second', second)], { durationSeconds: 0 });
  assert.equal(shortVoice.result.engine, 'second');

  reset([answerAfter(500, 'in time')], [transcribed('never used')]);
  const longVoice = await runChain([createEngine('slow', first, fastTimeout), createEngine('second', second)], { durationSeconds: 5 });
  assert.deepEqual(longVoice.result, { ok: true, text: 'in time', engine: 'slow' });
  assert.deepEqual(longVoice.fallbacks, []);
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
