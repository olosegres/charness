/**
 * @description The client side of the Bot API connection tests, run as a CHILD process (`node --import tsx <this file>
 * <apiRoot> <stallMs> <retry|noRetry>`): Telegraf's own client on the production agent, with the production retry
 * installed or not. It sends `first`, stalls its event loop synchronously for `stallMs` — a client starved of CPU between
 * two requests, made exact: neither its timers nor its socket events run —, then sends `second` on the connection `first`
 * left pooled, and prints `second=ok` or `second=failed <code> <message>`. Exit code 0 when `second` went through.
 *
 * It exits by itself: node-fetch leaves a 500 s timer behind a response body that failed, which would keep a test's own
 * process alive. Matches neither runner glob.
 */

import { Telegram } from 'telegraf';
import { createBotApiHttpAgent, wireBotApiClient } from '../../connectors/telegram/botApiConnection';

/** Not a Telegram token: the loopback Bot API accepts any `/bot<token>/` path. */
const probeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const probeChatId = -1001111111111;

async function run(): Promise<number> {
  const [apiRoot, stallMs, retryMode] = process.argv.slice(2);
  const agent = createBotApiHttpAgent();
  const telegram = new Telegram(probeBotToken, { apiRoot });
  if (retryMode === 'retry') wireBotApiClient(telegram, agent);
  // Telegraf drops its agent for an `http://` root; the control gets it too, so only the retry differs.
  else telegram.options.agent = agent;
  await telegram.sendMessage(probeChatId, 'first');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
  try {
    await telegram.sendMessage(probeChatId, 'second');
    console.log('second=ok');
    return 0;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    console.log(`second=failed ${code} ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

run().then((exitCode) => process.exit(exitCode), (error) => {
  console.log(`first=failed ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
