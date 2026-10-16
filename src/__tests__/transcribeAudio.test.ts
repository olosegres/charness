/**
 * @description Voice transcription must survive a flaky provider: a transient
 * failure (timeout / network error / 408 / 409 / 5xx / 429) is retried after
 * 5 s and then 15 s so a single Groq stall no longer loses the voice note, while
 * a permanent failure (other 4xx) fails at once. The pure schedule is asserted directly;
 * the retry loop drives the real `transcribeAudio` against a local HTTP server
 * scripted per attempt (with shortened delays so the suite stays fast).
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createCustomEndpoint,
  createGroqEndpoint,
  createOpenAiEndpoint,
  getTranscribeFailureKind,
  getTranscribeRetryDelayMs,
  transcribeAudio,
  transcribeRetryDelaysMs,
  type TranscribeRetryInfo,
  type TranscriptionEndpoint,
} from '../utils/transcribeAudio';

type AttemptHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

// A scriptable server: each request consumes the next handler from a queue.
let server: http.Server;
let endpoint: TranscriptionEndpoint;
let handlers: AttemptHandler[] = [];
let receivedRequests: Array<{ authorization?: string; body: string }> = [];
let audioPath = '';
let emptyAudioPath = '';

const testTimeoutMs = 300;
const testRetryDelaysMs = [10, 20];
const splitWriteGapMs = 30;
/** Guards the no-hang tests: a pending promise must fail the test, not stall the suite. */
const noHangTestTimeoutMs = 5_000;

before(async () => {
  server = http.createServer((req, res) => {
    const handler = handlers.shift();
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedRequests.push({ authorization: req.headers.authorization, body });
      if (!handler) {
        res.statusCode = 500;
        res.end('no handler queued');
        return;
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('test server has no port');
  endpoint = {
    url: `http://127.0.0.1:${address.port}/openai/v1/audio/transcriptions`,
    apiKey: 'test-key',
    model: 'whisper-test-model',
  };

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'transcribe-test-'));
  audioPath = path.join(tempDir, 'voice.ogg');
  emptyAudioPath = path.join(tempDir, 'empty.ogg');
  await fsp.writeFile(audioPath, 'fake-ogg-bytes');
  await fsp.writeFile(emptyAudioPath, '');
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(path.dirname(audioPath), { recursive: true, force: true });
});

function resetServer(nextHandlers: AttemptHandler[]): void {
  handlers = nextHandlers;
  receivedRequests = [];
}

function respondWith(status: number, body: string, headers: Record<string, string> = {}): AttemptHandler {
  return (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
}

const transcribed = (text: string) => respondWith(200, JSON.stringify({ text }));
const hangWithoutResponse: AttemptHandler = () => { /* never respond → client timeout fires */ };
const dropConnection: AttemptHandler = (req) => { req.socket.destroy(); };
// Headers + part of the body, then a reset: only the RESPONSE is destroyed.
const dropConnectionMidBody: AttemptHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"te', () => { req.socket.destroy(); });
};
/** Deliver the body in two writes split INSIDE a multi-byte UTF-8 character. */
function transcribedSplitMidCharacter(text: string): AttemptHandler {
  return (_req, res) => {
    const bodyBytes = Buffer.from(JSON.stringify({ text }), 'utf8');
    const firstCharStart = bodyBytes.indexOf(Buffer.from(text, 'utf8'));
    const splitAt = firstCharStart + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(bodyBytes.subarray(0, splitAt), () => {
      setTimeout(() => res.end(bodyBytes.subarray(splitAt)), splitWriteGapMs);
    });
  };
}

function runTranscription(filePath = audioPath) {
  const retries: TranscribeRetryInfo[] = [];
  const resultPromise = transcribeAudio(filePath, endpoint, {
    timeoutMs: testTimeoutMs,
    retryDelaysMs: testRetryDelaysMs,
    onRetry: (info) => { retries.push(info); },
  });
  return { resultPromise, retries };
}

test('default retry schedule: 1st retry after 5 s, 2nd after 15 s', () => {
  assert.deepEqual(transcribeRetryDelaysMs, [5_000, 15_000]);
});

test('endpoint builders: Groq and OpenAI carry their URL and model, a custom server defaults to whisper-1', () => {
  assert.deepEqual(createGroqEndpoint('gsk'), {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    apiKey: 'gsk',
    model: 'whisper-large-v3',
  });
  assert.deepEqual(createOpenAiEndpoint('sk'), {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: 'sk',
    model: 'whisper-1',
  });
  assert.deepEqual(createCustomEndpoint({ url: 'http://stt.example/v1/audio/transcriptions' }), {
    url: 'http://stt.example/v1/audio/transcriptions',
    apiKey: undefined,
    model: 'whisper-1',
  });
  assert.equal(createCustomEndpoint({ url: 'http://stt.example/x', model: 'custom-model' }).model, 'custom-model');
});

test('failure kind: 429 is rate-limited, 408/409/5xx transient, other 4xx permanent', () => {
  assert.equal(getTranscribeFailureKind(429), 'rateLimited');
  assert.equal(getTranscribeFailureKind(408), 'transient');
  assert.equal(getTranscribeFailureKind(409), 'transient');
  assert.equal(getTranscribeFailureKind(500), 'transient');
  assert.equal(getTranscribeFailureKind(503), 'transient');
  assert.equal(getTranscribeFailureKind(400), 'permanent');
  assert.equal(getTranscribeFailureKind(401), 'permanent');
});

test('retry delay: follows the schedule, stops when it is used up or the failure is permanent', () => {
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'transient', retryIndex: 0 }), 5_000);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'transient', retryIndex: 1 }), 15_000);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'transient', retryIndex: 2 }), null);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'permanent', retryIndex: 0 }), null);
});

test('retry delay: a 429 waits for Retry-After but never less than the schedule', () => {
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'rateLimited', retryIndex: 0, retryAfterSec: 30 }), 30_000);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'rateLimited', retryIndex: 0, retryAfterSec: 2 }), 5_000);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'rateLimited', retryIndex: 1 }), 15_000);
  assert.equal(getTranscribeRetryDelayMs({ failureKind: 'rateLimited', retryIndex: 2, retryAfterSec: 1 }), null);
});

test('succeeds on the first attempt: sends the key and model, no retry', async () => {
  resetServer([transcribed('hello voice')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'hello voice' });
  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].authorization, 'Bearer test-key');
  assert.match(receivedRequests[0].body, /whisper-test-model/);
  assert.match(receivedRequests[0].body, /fake-ogg-bytes/);
  assert.deepEqual(retries, []);
});

test('the language hint is a form field only when it is set', async () => {
  resetServer([transcribed('with language'), transcribed('without language')]);
  const withLanguage = await transcribeAudio(audioPath, { ...endpoint, language: 'ru' }, { timeoutMs: testTimeoutMs });
  assert.deepEqual(withLanguage, { ok: true, text: 'with language' });
  const withoutLanguage = await transcribeAudio(audioPath, endpoint, { timeoutMs: testTimeoutMs });
  assert.deepEqual(withoutLanguage, { ok: true, text: 'without language' });
  assert.match(receivedRequests[0].body, /name="language"\r\n\r\nru\r\n/);
  assert.doesNotMatch(receivedRequests[1].body, /name="language"/);
});

test('a keyless custom server gets no Authorization header', async () => {
  resetServer([transcribed('no key')]);
  const keyless = await transcribeAudio(audioPath, { url: endpoint.url, model: endpoint.model }, { timeoutMs: testTimeoutMs });
  assert.deepEqual(keyless, { ok: true, text: 'no key' });
  assert.equal(receivedRequests[0].authorization, undefined);
});

test('recovers after a TIMEOUT (the reported symptom) and announces the retry', async () => {
  resetServer([hangWithoutResponse, transcribed('after timeout')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after timeout' });
  assert.deepEqual(retries, [{ attemptNumber: 1, error: 'transcription timed out', delayMs: 10 }]);
});

test('recovers after a dropped connection', async () => {
  resetServer([dropConnection, transcribed('after reset')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after reset' });
  assert.equal(retries.length, 1);
});

test('recovers after the connection drops MID-RESPONSE instead of hanging', { timeout: noHangTestTimeoutMs }, async () => {
  resetServer([dropConnectionMidBody, transcribed('after mid-body reset')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after mid-body reset' });
  assert.equal(retries.length, 1);
});

test('keeps a multi-byte transcript intact when the body arrives split mid-character', async () => {
  resetServer([transcribedSplitMidCharacter('Привет, мир')]);
  const { resultPromise } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'Привет, мир' });
});

test('recovers on the THIRD attempt after two 5xx, pausing on the schedule', async () => {
  resetServer([
    respondWith(503, '{"error":{"message":"over capacity"}}'),
    respondWith(502, 'bad gateway'),
    transcribed('third time lucky'),
  ]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'third time lucky' });
  assert.deepEqual(retries, [
    { attemptNumber: 1, error: 'HTTP 503: over capacity', delayMs: 10 },
    { attemptNumber: 2, error: 'HTTP 502: bad gateway', delayMs: 20 },
  ]);
});

test('retries a 429 without Retry-After on the schedule', async () => {
  resetServer([respondWith(429, '{"error":{"message":"slow down"}}'), transcribed('after 429')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after 429' });
  assert.deepEqual(retries, [{ attemptNumber: 1, error: 'HTTP 429: slow down', delayMs: 10 }]);
});

test('a 429 waits for its Retry-After header when it is longer than the schedule', async () => {
  resetServer([respondWith(429, '{"error":{"message":"slow down"}}', { 'retry-after': '1' }), transcribed('after wait')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after wait' });
  assert.deepEqual(retries, [{ attemptNumber: 1, error: 'HTTP 429: slow down', delayMs: 1_000 }]);
});

test('retries a 408 Request Timeout from the provider', async () => {
  resetServer([respondWith(408, '{"error":{"message":"request timeout"}}'), transcribed('after 408')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: true, text: 'after 408' });
  assert.deepEqual(retries, [{ attemptNumber: 1, error: 'HTTP 408: request timeout', delayMs: 10 }]);
});

test('a 2xx with no text or a malformed body fails at once, without a retry', async () => {
  resetServer([respondWith(200, JSON.stringify({ text: '' })), transcribed('never reached')]);
  const emptyText = runTranscription();
  assert.deepEqual(await emptyText.resultPromise, { ok: false, error: 'transcription returned empty text', isDefinitive: true });
  assert.equal(receivedRequests.length, 1);
  assert.deepEqual(emptyText.retries, []);

  resetServer([respondWith(200, '<html>proxy page</html>'), transcribed('never reached')]);
  const malformed = runTranscription();
  assert.deepEqual(await malformed.resultPromise, {
    ok: false,
    error: 'malformed response from Whisper API: <html>proxy page</html>',
  });
  assert.equal(receivedRequests.length, 1);
  assert.deepEqual(malformed.retries, []);
});

test('gives up after 3 attempts and reports the last error with the attempt count', async () => {
  resetServer([hangWithoutResponse, respondWith(500, 'down'), respondWith(503, 'still down')]);
  const { resultPromise, retries } = runTranscription();
  assert.deepEqual(await resultPromise, { ok: false, error: 'HTTP 503: still down (after 3 attempts)' });
  assert.equal(receivedRequests.length, 3);
  assert.equal(retries.length, 2);
});

test('fails at once on a permanent 4xx, without a retry', async () => {
  resetServer([respondWith(401, '{"error":{"message":"invalid api key"}}'), transcribed('never reached')]);
  const { resultPromise, retries } = runTranscription();
  // Not definitive: another engine may well accept what this one refused.
  assert.deepEqual(await resultPromise, { ok: false, error: 'HTTP 401: invalid api key' });
  assert.equal(receivedRequests.length, 1);
  assert.deepEqual(retries, []);
});

test('an empty download fails at once without calling the provider', async () => {
  resetServer([transcribed('never reached')]);
  const { resultPromise, retries } = runTranscription(emptyAudioPath);
  assert.deepEqual(await resultPromise, { ok: false, error: 'downloaded audio is empty', isDefinitive: true });
  assert.equal(receivedRequests.length, 0);
  assert.deepEqual(retries, []);
});

test('refreshEndpoint is asked before every retry, never before the first attempt, and its endpoint is used', async () => {
  resetServer([respondWith(503, 'busy'), respondWith(503, 'busy'), transcribed('third time')]);
  const asked: number[] = [];
  const result = await transcribeAudio(audioPath, endpoint, {
    timeoutMs: testTimeoutMs,
    retryDelaysMs: testRetryDelaysMs,
    refreshEndpoint: async () => {
      asked.push(receivedRequests.length);
      return { ...endpoint, apiKey: `refreshed-${asked.length}` };
    },
  });
  assert.deepEqual(result, { ok: true, text: 'third time' });
  assert.deepEqual(asked, [1, 2], 'asked after the 1st and the 2nd failure');
  assert.deepEqual(receivedRequests.map((request) => request.authorization), ['Bearer test-key', 'Bearer refreshed-1', 'Bearer refreshed-2']);
});

test('a refreshEndpoint that rejects ends the attempts with its message', async () => {
  resetServer([respondWith(503, 'busy'), transcribed('never reached')]);
  const result = await transcribeAudio(audioPath, endpoint, {
    timeoutMs: testTimeoutMs,
    retryDelaysMs: testRetryDelaysMs,
    refreshEndpoint: async () => { throw new Error('the engine is gone'); },
  });
  assert.deepEqual(result, { ok: false, error: 'the engine is gone' });
  assert.equal(receivedRequests.length, 1);
});
