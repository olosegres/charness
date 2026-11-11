/**
 * @description `getOpenCodeServerHealth`: what one health probe of the OpenCode server concludes, over REAL loopback servers.
 * A probe that gets no answer in time is not "no server": a server that is busy or starved of CPU answers late, and reading
 * that as "down" made the bot start a duplicate on a port that was served (and "fail to start") or stop a server it owns that
 * was merely slow. So a timeout is asked again, a bounded number of times, and the probe says HOW it ended:
 *
 *   healthy      — 200
 *   unauthorized — 401: a server protected by a password the bot does not hold (the probe sends the one it holds)
 *   unhealthy    — the server answered, not OK (a 503 while it is not ready): asking again would get the same answer
 *   unreachable  — nothing took the connection (refused, reset, no route): no server listens; asking again changes nothing
 *   unanswered   — the connection was taken, no answer came in time, on every attempt: busy, starved or hung
 *
 * The attempt time and the number of retries are options so these tests need not wait out the production 2 s.
 *
 * `probeOpenCodePort` is the second half: before a server is started onto a port, the port is probed with a plain TCP connect, and
 * only a REFUSED connection proves it free. A connect that is accepted means a holder; a connect that gets no answer (the accept
 * queue of a hung or overloaded listener is full) or fails with anything else proves nothing, and is not taken for "free".
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getOpenCodeServerCredentialFilePath, getOpenCodeServerHealth, openCodeHealthAttemptTimeoutMs, openCodeHealthTimeoutRetries, probeOpenCodePort } from '../installManager';
import { startFullBacklogListener } from './fullBacklogListener';

const testAttemptTimeoutMs = 100;
/**
 * For the cases where the server answers at once (or refuses at once) and the time limit is NOT what is tested: the first `fetch` of a test
 * process is cold, and on a loaded machine it can take longer than `testAttemptTimeoutMs` — the probe then asks again, as designed, and a
 * test that counts requests fails on the retry instead of on anything wrong.
 */
const promptServerAttemptTimeoutMs = 10_000;
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
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: true, version: '1.2.3', outcome: 'healthy' });
    assert.equal(healthRequestCount, 1);
  });

  it('a server that answers but is not OK is unhealthy, and is not asked again: the answer would be the same', async () => {
    await startServer((_number, response) => response.writeHead(503).end());
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: false, version: null, outcome: 'unhealthy' });
    assert.equal(healthRequestCount, 1);
  });

  it('a server that refuses the probe\'s password is unauthorized — not merely unhealthy — and is not asked again', async () => {
    await startServer((_number, response) => response.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' }).end());
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
    assert.deepEqual(health, { healthy: false, version: null, outcome: 'unauthorized' });
    assert.equal(healthRequestCount, 1);
  });

  it('the probe sends the password the bot saved for this server, and only to this server', async () => {
    const authorizations: (string | undefined)[] = [];
    healthRequestCount = 0;
    server = http.createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      answerHealthy(response);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.OPENCODE_URL = serverUrl;
    const savedPassword = 'a-saved-generation-password';
    fs.writeFileSync(getOpenCodeServerCredentialFilePath(), JSON.stringify({ endpoint: serverUrl, password: savedPassword }), { mode: 0o600 });
    try {
      await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
      fs.writeFileSync(getOpenCodeServerCredentialFilePath(), JSON.stringify({ endpoint: 'http://127.0.0.1:1', password: savedPassword }), { mode: 0o600 });
      await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
    } finally {
      fs.rmSync(getOpenCodeServerCredentialFilePath(), { force: true });
    }
    assert.deepEqual(authorizations, [`Basic ${Buffer.from(`opencode:${savedPassword}`).toString('base64')}`, undefined]);
  });

  it('a port nothing listens on is unreachable', async () => {
    await startServer((_number, response) => answerHealthy(response));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const health = await getOpenCodeServerHealth({ attemptTimeoutMs: promptServerAttemptTimeoutMs });
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

describe('probeOpenCodePort', () => {
  /** A connect check short enough not to slow the tests. */
  const testProbeTimeoutMs = 200;

  it('a port whose listener takes the connection is in use', async () => {
    await startServer(() => {});
    const port = (server!.address() as AddressInfo).port.toString();
    assert.equal((await probeOpenCodePort(port, { timeoutMs: testProbeTimeoutMs })).state, 'inUse');
  });

  it('a port that refuses the connection is free: the one answer that proves it', async () => {
    await startServer(() => {});
    const port = (server!.address() as AddressInfo).port.toString();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    assert.deepEqual(await probeOpenCodePort(port, { timeoutMs: testProbeTimeoutMs }), { state: 'free', detail: 'the connection was refused' });
  });

  it('a port whose listener gives no answer to a connect (a full accept queue) is NOT free: unknown, not "nothing listens"', async () => {
    const listener = await startFullBacklogListener();
    try {
      assert.deepEqual(
        await probeOpenCodePort(listener.port.toString(), { timeoutMs: testProbeTimeoutMs }),
        { state: 'unknown', detail: `the connection timed out after ${testProbeTimeoutMs} ms` },
      );
    } finally {
      listener.stop();
    }
  });

  it('a connect that fails with anything but a refusal is NOT free either: unknown', async () => {
    // The limited broadcast address is unreachable at once (ENETUNREACH or EACCES, by the host), with no DNS and no wait.
    const probe = await probeOpenCodePort('9', { host: '255.255.255.255', timeoutMs: testProbeTimeoutMs });
    assert.equal(probe.state, 'unknown');
    assert.match(probe.detail, /^the connection failed with E[A-Z]+$/);
  });
});
