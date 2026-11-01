/**
 * @description The incident itself: the Bot API closes a connection that idled in the bot's pool, and the bot's next send is
 * written onto the connection the server already closed — «socket hang up», a message lost. The client is a child process
 * (`telegramE2e/botApiClientProbe.ts`): Telegraf's own client on the production agent, with the production retry installed
 * or not.
 *
 * Two mechanisms, because the first is no longer the same on every Node:
 *
 *  1. THE DROP (every Node). The fake hangs up on the second request that rides a pooled connection, without processing it
 *     (`dropNextReusedConnectionRequest`): what a client sees when the server closes the connection a moment before the
 *     request lands. This is the close that no client can see coming, so it exists on every Node. The control runs the client
 *     WITHOUT the retry: it must fail with the incident's own error, so the test would go red without the retry. The test runs
 *     it with the retry: the second message arrives, exactly once, and the client says it retried.
 *  2. THE STALL (the real idle close). The fake closes idle connections the way a Node server does by default
 *     (`keepAliveTimeoutMs`) and the client stalls its event loop synchronously between two sends — a bot starved of CPU, made
 *     exact. Whether the second send then meets the closed connection is up to the Node the client runs on: since 22.23.4 its
 *     http agent looks for what the server already sent on an idle socket before it hands the socket to a request («http:
 *     ensure agent data guard works without I/O», CVE-2026-105481), finds the close and opens a fresh connection; an older Node
 *     writes onto the closed one. The test measures which it is with the control (no retry) and then holds the product to the
 *     matching outcome: the message arrives exactly once either way, and the retry engages exactly when the agent let the
 *     stale connection through.
 *
 * The deterministic version through the whole bot is `staleConnectionRetryE2e.test.ts`; the retry's rules (what it never
 * retries) are `botApiConnection.test.ts`'s.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { runBotApiClientProbe } from './telegramE2e/runBotApiClientProbe';
import { reusedConnectionRetryLogPrefix } from '../connectors/telegram/botApiConnection';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Node's own default for a server (5 s, plus a 1 s buffer before it closes the connection). */
const nodeDefaultKeepAliveTimeoutMs = 5000;
/** Longer than the fake keeps an idle connection (5 s + 1 s on Node 22). */
const clientStallMs = 7000;
/** No stall: the second send follows the first at once, on the connection the first left pooled. */
const noStallMs = 0;
const testTimeoutMs = 40 * 1000;

/** One fake per probe, the tests run side by side: all are stopped when the suite is done. */
const runningFakes: FakeTelegram[] = [];

/** A fake that closes an idle connection by itself after Node's default time, or (without the option) never. */
async function startFake(isClosingIdleConnections: boolean): Promise<{ fakeTelegram: FakeTelegram; apiRoot: string }> {
  const fakeTelegram = new FakeTelegram({
    botUser,
    operator,
    group,
    ...(isClosingIdleConnections ? { keepAliveTimeoutMs: nodeDefaultKeepAliveTimeoutMs } : {}),
  });
  runningFakes.push(fakeTelegram);
  return { fakeTelegram, apiRoot: await fakeTelegram.start() };
}

function listSentTexts(fakeTelegram: FakeTelegram): unknown[] {
  return fakeTelegram.listCalls('sendMessage').map((call) => call.payload.text);
}

after(async () => {
  await Promise.all(runningFakes.map((fakeTelegram) => fakeTelegram.stop()));
});

describe('a send on a pooled connection that the Bot API drops under the client', { concurrency: true }, () => {
  it('(control) without the retry the second message is lost: «socket hang up»', { timeout: testTimeoutMs }, async () => {
    const { fakeTelegram, apiRoot } = await startFake(false);
    fakeTelegram.dropNextReusedConnectionRequest('sendMessage');

    const probe = await runBotApiClientProbe(apiRoot, noStallMs, 'noRetry');

    assert.deepEqual(fakeTelegram.droppedRequests, ['sendMessage'], `the fake hung up on the pooled connection, or this proves nothing: ${probe.output}`);
    assert.equal(probe.exitCode, 1, probe.output);
    assert.match(probe.output, /^second=failed ECONNRESET .*socket hang up/);
    assert.deepEqual(listSentTexts(fakeTelegram), ['first'], 'the second never reached the fake');
  });

  it('with the retry the second message arrives, exactly once', { timeout: testTimeoutMs }, async () => {
    const { fakeTelegram, apiRoot } = await startFake(false);
    fakeTelegram.dropNextReusedConnectionRequest('sendMessage');

    const probe = await runBotApiClientProbe(apiRoot, noStallMs, 'retry');

    assert.deepEqual(fakeTelegram.droppedRequests, ['sendMessage'], `the fake hung up on the pooled connection, or this proves nothing: ${probe.output}`);
    assert.equal(probe.exitCode, 0, `${probe.output}\n${probe.errorOutput}`);
    assert.equal(probe.output, 'second=ok');
    assert.deepEqual(listSentTexts(fakeTelegram), ['first', 'second']);
    assert.ok(probe.errorOutput.includes(reusedConnectionRetryLogPrefix), 'the client logged the retry');
  });
});

describe('a client stalled past the Bot API\'s idle limit sends on its pooled connection', { concurrency: true }, () => {
  it('the second message arrives exactly once; the retry engages exactly when the agent let the closed connection through', { timeout: testTimeoutMs }, async () => {
    const control = await startFake(true);
    const withRetry = await startFake(true);

    const [controlProbe, retryProbe] = await Promise.all([
      runBotApiClientProbe(control.apiRoot, clientStallMs, 'noRetry'),
      runBotApiClientProbe(withRetry.apiRoot, clientStallMs, 'retry'),
    ]);

    // The control, no retry: the stall was long enough for the fake to close the idle connection, and the client either
    // wrote onto it (the incident) or was spared by its own agent, which then used a fresh connection. Never the old one.
    const isStaleConnectionWrittenOn = controlProbe.exitCode === 1;
    if (isStaleConnectionWrittenOn) {
      assert.match(controlProbe.output, /^second=failed ECONNRESET .*socket hang up/);
      assert.deepEqual(listSentTexts(control.fakeTelegram), ['first'], 'the second never reached the fake');
      assert.equal(control.fakeTelegram.acceptedConnectionCount, 1, 'the one connection the fake closed');
    } else {
      assert.equal(controlProbe.output, 'second=ok', `${controlProbe.output}\n${controlProbe.errorOutput}`);
      assert.deepEqual(listSentTexts(control.fakeTelegram), ['first', 'second']);
      assert.equal(control.fakeTelegram.acceptedConnectionCount, 2, 'the second went out on a fresh connection: the stall was long enough for the fake to close the idle one');
    }

    // The same stall with the production retry: the message arrives, once, and the retry engaged only if it was needed.
    assert.equal(retryProbe.exitCode, 0, `${retryProbe.output}\n${retryProbe.errorOutput}`);
    assert.equal(retryProbe.output, 'second=ok');
    assert.deepEqual(listSentTexts(withRetry.fakeTelegram), ['first', 'second']);
    assert.equal(
      retryProbe.errorOutput.includes(reusedConnectionRetryLogPrefix),
      isStaleConnectionWrittenOn,
      isStaleConnectionWrittenOn ? 'the agent let the closed connection through, so the client must have logged the retry' : 'the agent spared the client, so there was nothing to retry',
    );
  });
});
