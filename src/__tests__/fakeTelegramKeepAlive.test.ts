/**
 * @description The fake Bot API never closes an idle connection by itself. Node's own server does, after ~6 s
 * (`keepAliveTimeout` plus its buffer), and a client that was starved of CPU for longer — the bot on a loaded host between
 * two requests — then writes its next request onto a pooled connection that is already closed: «socket hang up». A send is
 * not retried, so the notice it carried is lost; `limitRecoveryE2e` waited for such a notice in vain in a full e2e run.
 *
 * The client is a child process that stalls its event loop synchronously (the starvation, made exact) between two requests
 * and then reuses its connection at once. Against a plain Node server the same client fails — the test's stall is long
 * enough on this Node; against the fake it does not.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeTelegram } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** Longer than a default Node server keeps an idle connection (5 s + a 1 s buffer on Node 22). */
const clientStallMs = 7000;
const testTimeoutMs = 30 * 1000;

/**
 * The client: one request, a synchronous stall, one more request on the same pooled connection. It reports on stdout whether
 * the second one went through; the exit code says so too.
 */
const clientSource = `
const http = require('node:http');
const [apiRoot, stallMs] = [process.argv[1], Number(process.argv[2])];
const agent = new http.Agent({ keepAlive: true });
const post = () => new Promise((resolve, reject) => {
  const request = http.request(apiRoot + '/getMe', { method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (response) => { response.resume(); response.on('end', () => resolve(request.reusedSocket)); });
  request.on('error', reject);
  request.end('{}');
});
(async () => {
  await post();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
  try { console.log('reused=' + await post()); process.exit(0); }
  catch (error) { console.log('failed=' + error.message); process.exit(1); }
})();
`;

/** Run the stalling client against `apiRoot`; resolves what it printed and its exit code. */
function runStallingClient(apiRoot: string): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', clientSource, apiRoot, clientStallMs.toString()], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ output: output.trim(), exitCode }));
  });
}

test('a client stalled past a default Node server\'s keep-alive time loses its pooled connection (the control: the stall is long enough)', { timeout: testTimeoutMs }, async () => {
  const plainServer = http.createServer((_request, response) => { response.end('{"ok":true,"result":true}'); });
  await new Promise<void>((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = plainServer.address() as AddressInfo;
    const outcome = await runStallingClient(`http://127.0.0.1:${port}/bot${fakeBotToken}`);
    assert.equal(outcome.exitCode, 1, outcome.output);
    assert.match(outcome.output, /failed=socket hang up/);
  } finally {
    plainServer.closeAllConnections();
    await new Promise<void>((resolve) => plainServer.close(() => resolve()));
  }
});

test('the same client against the fake Bot API reuses its connection: the fake never closes an idle one by itself', { timeout: testTimeoutMs }, async () => {
  const fakeTelegram = new FakeTelegram({ botUser, operator, group });
  const apiRoot = await fakeTelegram.start();
  try {
    const outcome = await runStallingClient(`${apiRoot}/bot${fakeBotToken}`);
    assert.equal(outcome.exitCode, 0, outcome.output);
    assert.equal(outcome.output, 'reused=true');
    assert.equal(fakeTelegram.listCalls('getMe').length, 2, 'both requests reached the fake');
  } finally {
    await fakeTelegram.stop();
  }
});
