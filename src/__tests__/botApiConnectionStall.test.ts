/**
 * @description The incident itself, with the real mechanism: the Bot API closes a connection that idled in the bot's pool,
 * and a bot starved of CPU for longer than that writes its next send onto the connection the server already closed —
 * «socket hang up», a message lost. The fake Bot API closes idle connections the way a Node server does by default
 * (`keepAliveTimeoutMs`); the client is a child process (`telegramE2e/botApiClientProbe.ts`) that stalls its event loop
 * synchronously between two sends — the starvation, made exact — and then sends on its pooled connection at once.
 *
 * The control runs the client WITHOUT the retry: it must fail with the incident's own error, so the stall is long enough
 * on this Node and the test would go red without the retry. The test runs it with the retry: the second message arrives,
 * exactly once.
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
const testTimeoutMs = 40 * 1000;

/** One fake per test, the tests run side by side (each stalls for seconds): all are stopped when the suite is done. */
const runningFakes: FakeTelegram[] = [];

async function startClosingFake(): Promise<{ fakeTelegram: FakeTelegram; apiRoot: string }> {
  const fakeTelegram = new FakeTelegram({ botUser, operator, group, keepAliveTimeoutMs: nodeDefaultKeepAliveTimeoutMs });
  runningFakes.push(fakeTelegram);
  return { fakeTelegram, apiRoot: await fakeTelegram.start() };
}

describe('a client stalled past the Bot API\'s idle limit sends on its pooled connection', { concurrency: true }, () => {
  after(async () => {
    await Promise.all(runningFakes.map((fakeTelegram) => fakeTelegram.stop()));
  });

  it('(control) without the retry the second message is lost: «socket hang up»', { timeout: testTimeoutMs }, async () => {
    const { fakeTelegram, apiRoot } = await startClosingFake();

    const probe = await runBotApiClientProbe(apiRoot, clientStallMs, 'noRetry');

    assert.equal(probe.exitCode, 1, probe.output);
    assert.match(probe.output, /^second=failed ECONNRESET .*socket hang up/);
    assert.deepEqual(fakeTelegram.listCalls('sendMessage').map((call) => call.payload.text), ['first'], 'the second never reached the fake');
  });

  it('with the retry the second message arrives, exactly once', { timeout: testTimeoutMs }, async () => {
    const { fakeTelegram, apiRoot } = await startClosingFake();

    const probe = await runBotApiClientProbe(apiRoot, clientStallMs, 'retry');

    assert.equal(probe.exitCode, 0, `${probe.output}\n${probe.errorOutput}`);
    assert.equal(probe.output, 'second=ok');
    assert.deepEqual(fakeTelegram.listCalls('sendMessage').map((call) => call.payload.text), ['first', 'second']);
    assert.ok(probe.errorOutput.includes(reusedConnectionRetryLogPrefix), 'the client logged the retry');
  });
});
