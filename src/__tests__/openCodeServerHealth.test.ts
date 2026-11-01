/**
 * @description `getOpenCodeServerHealth`: what one health probe of the OpenCode server concludes, over REAL loopback servers.
 * A probe that gets no answer in time is not "no server": a server that is busy or starved of CPU answers late, and reading
 * that as "down" made the bot start a duplicate on a port that was served (and "fail to start") or stop a server it owns that
 * was merely slow. So a timeout is asked again, a bounded number of times, and the probe says HOW it ended:
 *
 *   healthy      — 200
 *   unhealthy    — the server answered, not OK (a 503 while it is not ready): asking again would get the same answer
 *   unreachable  — nothing took the connection (refused, reset, no route): no server listens; asking again changes nothing
 *   unanswered   — the connection was taken, no answer came in time, on every attempt: busy, starved or hung
 *
 * The attempt time and the number of retries are options so these tests need not wait out the production 2 s.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getOpenCodeServerHealth, openCodeHealthAttemptTimeoutMs, openCodeHealthTimeoutRetries } from '../installManager';

const testAttemptTimeoutMs = 100;
/** Late enough for a test attempt to give up, soon enough that the next one meets an answer. */
const lateAnswerDelayMs = 250;

let server: http.Server | null = null;
let savedOpenCodeUrl: string | undefined;
let healthRequestCount = 0;

/** Start a loopback server whose `/global/health` is answered by `answer` (given the 1-based request number); point OPENCODE_URL at it. */
async function startServer(answer: (requestNumber: number, response: http.ServerResponse) => void): Promise<void> {
  healthRequestCount = 0;
  server = http.createServer((request, response) => {
    if (request.url !== '/global/health') {
      response.writeHead(404).end();
      return;
    }
    healthRequestCount += 1;
    answer(healthRequestCount, response);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const answerHealthy = (response: http.ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ healthy: true, version: '1.2.3' }));
};

beforeEach(() => {
  savedOpenCodeUrl = process.env.OPENCODE_URL;
});

afterEach(async () => {
  if (savedOpenCodeUrl === undefined) delete process.env.OPENCODE_URL;
  else process.env.OPENCODE_URL = savedOpenCodeUrl;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('getOpenCodeServerHealth', () => {
  it('a server that answers 200 is healthy, with its version, after one request', async () => {
    await startServer((_number, response) => answerHealthy(response));
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: true, version: '1.2.3', outcome: 'healthy' });
    assert.equal(healthRequestCount, 1);
  });

  it('a server that answers but is not OK is unhealthy, and is not asked again: the answer would be the same', async () => {
    await startServer((_number, response) => response.writeHead(503).end());
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: false, version: null, outcome: 'unhealthy' });
    assert.equal(healthRequestCount, 1);
  });

  it('a port nothing listens on is unreachable', async () => {
    await startServer((_number, response) => answerHealthy(response));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: false, version: null, outcome: 'unreachable' });
  });

  it('an answer that comes after the attempt time is waited for by asking again: healthy, not "no server"', async () => {
    await startServer((number, response) => {
      if (number === 1) setTimeout(() => answerHealthy(response), lateAnswerDelayMs);
      else answerHealthy(response);
    });
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: true, version: '1.2.3', outcome: 'healthy' });
    assert.equal(healthRequestCount, 2, 'the first attempt gave up, the second was answered');
  });

  it('a server that never answers is unanswered after the first attempt and every retry, and not a request more', async () => {
    await startServer(() => {});
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs, timeoutRetries: 2 });
    assert.deepEqual(health, { healthy: false, version: null, outcome: 'unanswered' });
    assert.equal(healthRequestCount, 3);
  });

  it('with no retries a single silent attempt ends it (the /status read, which only shows the version)', async () => {
    await startServer(() => {});
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: testAttemptTimeoutMs, timeoutRetries: 0 });
    assert.equal(health.outcome, 'unanswered');
    assert.equal(healthRequestCount, 1);
  });

  it('the defaults are the production ones: 2 s an attempt and two retries after the first', () => {
    assert.equal(openCodeHealthAttemptTimeoutMs, 2000);
    assert.equal(openCodeHealthTimeoutRetries, 2);
  });
});
