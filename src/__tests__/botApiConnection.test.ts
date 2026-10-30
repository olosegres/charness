/**
 * @description The bot's pooled connections to the Bot API (`connectors/telegram/botApiConnection.ts`), with REAL sockets:
 * Telegraf's own client (`Telegram`) sends through the production agent and retry to a loopback server that plays a Bot API
 * which closed a pooled connection a moment before a request landed on it (it hangs up on a request that arrives on a
 * reused connection, without processing it). The server counts what it APPLIED, which is what "exactly once" means.
 *
 * The real idle close with a client stalled past it is `botApiConnectionStall.test.ts`'s.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo, Socket } from 'net';
import { Readable } from 'stream';
import { AbortController } from 'abort-controller';
import { Telegram } from 'telegraf';
import { runBotApiClientProbe } from './telegramE2e/runBotApiClientProbe';
import {
  botApiFreeSocketTimeoutMs,
  createBotApiHttpAgent,
  createBotApiHttpsAgent,
  wireBotApiClient,
  reusedConnectionRetryLogPrefix,
} from '../connectors/telegram/botApiConnection';

/** Not a Telegram token: the loopback server accepts any `/bot<token>/` path. */
const testBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const chatId = -1001111111111;
const slowAnswerMs = 600;
/** Shorter than {@link slowAnswerMs}: an idle timeout that cut a request in flight would show. */
const shortFreeSocketTimeoutMs = 150;
const freeSocketWaitMs = 3000;
const responseResetDelayMs = 100;
/** The start of a response's head, cut inside a header name: bytes of an answer that never becomes a response. */
const partialResponseHead = 'HTTP/1.1 200 OK\r\ncontent-ty';

/** What the loopback server does with a request, decided before it reads it. */
type RequestFate =
  /** Apply it and answer. */
  | 'answer'
  /** Apply it and answer after {@link slowAnswerMs}. */
  | 'answerSlowly'
  /** Close the connection without reading or applying the request: it was closed a moment before. */
  | 'hangUp'
  /** Apply it, send the status line and part of the body, then reset the connection. */
  | 'hangUpAfterHeaders'
  /** Apply it, send PART of the response head (no complete status line and headers), then close: the answer began, though the client's response never did. */
  | 'hangUpMidHead'
  /** Never answer. */
  | 'hold';

interface ReceivedRequest {
  /** 1-based, over every request the server got, whatever its fate. */
  attemptNumber: number;
  /** The request rode a connection that had already served a request. */
  isReusedConnection: boolean;
}

function getTextOfJsonBody(body: Buffer): string {
  const { text }: { text: string } = JSON.parse(body.toString('utf8'));
  return text;
}

/** A loopback Bot API for `sendMessage` / `sendDocument`; `appliedLabels` is what it APPLIED, in order. */
class LoopbackBotApi {
  readonly attempts: ReceivedRequest[] = [];
  readonly appliedLabels: string[] = [];
  private readonly servedSockets = new WeakSet<Socket>();
  private readonly openSockets = new Set<Socket>();
  private readonly server: http.Server;

  constructor(private readonly decideFate: (request: ReceivedRequest) => RequestFate) {
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    this.server.keepAliveTimeout = 0;
    this.server.on('connection', (socket) => {
      this.openSockets.add(socket);
      socket.on('close', () => this.openSockets.delete(socket));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** How many connections are open right now. */
  getOpenConnectionCount(): number {
    return this.openSockets.size;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const received: ReceivedRequest = { attemptNumber: this.attempts.length + 1, isReusedConnection: this.servedSockets.has(request.socket) };
    this.servedSockets.add(request.socket);
    this.attempts.push(received);
    const fate = this.decideFate(received);
    if (fate === 'hangUp') {
      request.socket.destroy();
      return;
    }
    if (fate === 'hold') return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const isJson = (request.headers['content-type'] ?? '').includes('application/json');
    const label = isJson ? getTextOfJsonBody(Buffer.concat(chunks)) : 'document';
    this.appliedLabels.push(label);
    if (fate === 'hangUpMidHead') {
      request.socket.end(partialResponseHead);
      return;
    }
    if (fate === 'answerSlowly') await new Promise<void>((resolve) => setTimeout(resolve, slowAnswerMs));
    const body = JSON.stringify({ ok: true, result: { message_id: this.appliedLabels.length, chat: { id: chatId }, text: label } });
    if (fate === 'hangUpAfterHeaders') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length * 2 });
      // A reset (not a clean close): the client then fails with ECONNRESET — the error shape of a dropped connection —
      // AFTER its response started. The pause lets it read what was sent first; a reset can discard unread data.
      response.write(body.slice(0, 10), () => { setTimeout(() => request.socket.resetAndDestroy(), responseResetDelayMs); });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  }
}

/** Telegraf's client on `agent`, wired the way `bot.ts` wires `bot.telegram`. */
function createClient(apiRoot: string, agent: http.Agent): Telegram {
  const telegram = new Telegram(testBotToken, { apiRoot });
  wireBotApiClient(telegram, agent);
  return telegram;
}

let runningApi: LoopbackBotApi | null = null;
let runningAgent: http.Agent | null = null;

async function startApi(decideFate: (request: ReceivedRequest) => RequestFate): Promise<{ api: LoopbackBotApi; apiRoot: string }> {
  const api = new LoopbackBotApi(decideFate);
  runningApi = api;
  return { api, apiRoot: await api.start() };
}

function createAgent(freeSocketTimeoutMs?: number): http.Agent {
  runningAgent = createBotApiHttpAgent(freeSocketTimeoutMs);
  return runningAgent;
}

async function waitUntil(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  mock.restoreAll();
  runningAgent?.destroy();
  runningAgent = null;
  await runningApi?.stop();
  runningApi = null;
});

describe('a request on a pooled connection the server closed before it landed', () => {
  it('is sent again once on a fresh connection, and the server applies it exactly once', async () => {
    const warnings = mock.method(console, 'warn', () => {});
    const { api, apiRoot } = await startApi(({ isReusedConnection }) => (isReusedConnection ? 'hangUp' : 'answer'));
    const telegram = createClient(apiRoot, createAgent());

    await telegram.sendMessage(chatId, 'first');
    const second = await telegram.sendMessage(chatId, 'second');

    assert.equal(second.message_id, 2, 'the retry was answered');
    assert.deepEqual(api.appliedLabels, ['first', 'second'], 'applied once each, in order');
    assert.deepEqual(api.attempts.map((attempt) => attempt.isReusedConnection), [false, true, false], 'the failed attempt rode the pooled connection, the retry a fresh one');
    assert.equal(warnings.mock.calls.length, 1);
    assert.match(String(warnings.mock.calls[0].arguments[0]), new RegExp(`${reusedConnectionRetryLogPrefix.replace(/[[\]()]/g, '\\$&')} \\(sendMessage\\)`));
  });

  it('closes every idle pooled connection first, so the retry does not meet a second stale one', async () => {
    const { api, apiRoot } = await startApi(({ isReusedConnection }) => (isReusedConnection ? 'hangUp' : 'answer'));
    const telegram = createClient(apiRoot, createAgent());

    // Two sends in flight at once open two connections; both end up pooled.
    await Promise.all([telegram.sendMessage(chatId, 'a'), telegram.sendMessage(chatId, 'b')]);
    assert.equal(api.getOpenConnectionCount(), 2);
    await telegram.sendMessage(chatId, 'c');

    assert.deepEqual(api.appliedLabels.slice().sort(), ['a', 'b', 'c']);
    assert.equal(api.attempts.length, 4, 'a, b, the dropped c and its retry — not a second drop on the other pooled connection');
  });

  it('is retried ONCE: a second drop reaches the caller', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 1 ? 'answer' : 'hangUp'));
    const telegram = createClient(apiRoot, createAgent());

    await telegram.sendMessage(chatId, 'first');
    await assert.rejects(telegram.sendMessage(chatId, 'second'), (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET');

    assert.equal(api.attempts.length, 3, 'the first send, the dropped one and ONE retry');
    assert.deepEqual(api.appliedLabels, ['first']);
  });

  it('is retried with a Buffer file, which can be read again', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 2 ? 'hangUp' : 'answer'));
    const telegram = createClient(apiRoot, createAgent());

    await telegram.sendMessage(chatId, 'first');
    await telegram.sendDocument(chatId, { source: Buffer.from('file bytes'), filename: 'a.txt' });

    assert.deepEqual(api.appliedLabels, ['first', 'document']);
    assert.equal(api.attempts.length, 3);
  });

  it('is NOT retried when its file is a stream, which a second send would upload empty', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 2 ? 'hangUp' : 'answer'));
    const telegram = createClient(apiRoot, createAgent());

    await telegram.sendMessage(chatId, 'first');
    await assert.rejects(telegram.sendDocument(chatId, { source: Readable.from(Buffer.from('file bytes')), filename: 'a.txt' }), (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET');

    assert.equal(api.attempts.length, 2, 'no second attempt');
    assert.deepEqual(api.appliedLabels, ['first']);
  });
});

describe('a failure that is not "a pooled connection dropped before any answer" is not retried', () => {
  it('a drop on a FRESH connection: the server may have processed it', async () => {
    const { api, apiRoot } = await startApi(() => 'hangUp');
    const telegram = createClient(apiRoot, createAgent());

    await assert.rejects(telegram.sendMessage(chatId, 'first'), (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET');

    assert.equal(api.attempts.length, 1);
  });

  it('a drop after the response started: the server did process it, a retry would post it twice', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 2 ? 'hangUpAfterHeaders' : 'answer'));

    // In a child: node-fetch leaves a 500 s timer behind a response body that failed, which would hold this process open.
    const probe = await runBotApiClientProbe(apiRoot, 0, 'retry');

    // The error has the shape of a dropped connection (the classifier alone would retry it): only the response having
    // started keeps the retry away.
    assert.match(probe.output, /^second=failed ECONNRESET Invalid response body/);
    assert.equal(api.attempts.length, 2, 'no second attempt');
    assert.deepEqual(api.appliedLabels, ['first', 'second'], 'the server applied the second once');
  });

  it('a drop after PART of the response head arrived: the server had started to answer, so it did process the request', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 2 ? 'hangUpMidHead' : 'answer'));
    const telegram = createClient(apiRoot, createAgent());

    await telegram.sendMessage(chatId, 'first');
    // No 'response' event ever fires for it, and the error is the one of a connection closed before any answer: only the
    // bytes the socket read since the reuse tell it from a pooled connection the server had closed.
    await assert.rejects(telegram.sendMessage(chatId, 'second'), (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET' && /socket hang up/.test(error.message));

    assert.equal(api.attempts.length, 2, 'no second attempt');
    assert.deepEqual(api.appliedLabels, ['first', 'second'], 'the server applied the second once');
  });

  it('an aborted call', async () => {
    const { api, apiRoot } = await startApi(({ attemptNumber }) => (attemptNumber === 1 ? 'answer' : 'hold'));
    const telegram = createClient(apiRoot, createAgent());
    const abortController = new AbortController();

    await telegram.sendMessage(chatId, 'first');
    const aborted = telegram.callApi('sendMessage', { chat_id: chatId, text: 'second' }, { signal: abortController.signal });
    await waitUntil('the server to get the second request', freeSocketWaitMs, () => api.attempts.length === 2);
    abortController.abort();

    await assert.rejects(aborted, (error: Error) => error.name === 'AbortError');
    assert.equal(api.attempts.length, 2, 'no second attempt');
  });
});

describe('the client Telegraf builds for one update (ctx.telegram)', () => {
  /** What `Telegraf.handleUpdate` does for every update: a new client from the options of `bot.telegram`. */
  function createUpdateClient(apiRoot: string, agent: http.Agent): { botClient: Telegram; updateClient: Telegram } {
    const botClient = createClient(apiRoot, agent);
    return { botClient, updateClient: new Telegram(testBotToken, botClient.options) };
  }

  it('(control) built from the options of the wired bot client it has neither the agent nor the retry: a dropped request is lost', async () => {
    const { api, apiRoot } = await startApi(({ isReusedConnection }) => (isReusedConnection ? 'hangUp' : 'answer'));
    const { updateClient } = createUpdateClient(apiRoot, createAgent());

    assert.equal(updateClient.options.agent, undefined, 'an http:// root drops the agent of a new client');
    await updateClient.sendMessage(chatId, 'first');
    await assert.rejects(updateClient.sendMessage(chatId, 'second'), (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET');

    assert.deepEqual(api.appliedLabels, ['first']);
  });

  it('wired with wireBotApiClient it rides the bot\'s agent and a dropped request is sent again once', async () => {
    const warnings = mock.method(console, 'warn', () => {});
    const agent = createAgent();
    const { api, apiRoot } = await startApi(({ isReusedConnection }) => (isReusedConnection ? 'hangUp' : 'answer'));
    const { updateClient } = createUpdateClient(apiRoot, agent);
    wireBotApiClient(updateClient, agent);

    await updateClient.sendMessage(chatId, 'first');
    await updateClient.sendMessage(chatId, 'second');

    assert.equal(updateClient.options.agent, agent);
    assert.deepEqual(api.appliedLabels, ['first', 'second']);
    assert.deepEqual(api.attempts.map((attempt) => attempt.isReusedConnection), [false, true, false]);
    assert.equal(warnings.mock.calls.length, 1);
  });
});

describe('the pool\'s idle timeout', () => {
  it('closes a connection that idled in the pool, so the next request opens a fresh one', async () => {
    const { api, apiRoot } = await startApi(() => 'answer');
    const agent = createAgent(shortFreeSocketTimeoutMs);
    const telegram = createClient(apiRoot, agent);

    await telegram.sendMessage(chatId, 'first');
    assert.equal(Object.keys(agent.freeSockets).length, 1, 'the connection is pooled');
    await waitUntil('the idle connection to be closed by the agent', freeSocketWaitMs, () => Object.keys(agent.freeSockets).length === 0);
    await telegram.sendMessage(chatId, 'second');

    assert.deepEqual(api.attempts.map((attempt) => attempt.isReusedConnection), [false, false]);
  });

  it('keeps a connection that is used before the timeout', async () => {
    const { api, apiRoot } = await startApi(() => 'answer');
    const telegram = createClient(apiRoot, createAgent(botApiFreeSocketTimeoutMs));

    await telegram.sendMessage(chatId, 'first');
    await telegram.sendMessage(chatId, 'second');

    assert.deepEqual(api.attempts.map((attempt) => attempt.isReusedConnection), [false, true]);
  });

  it('does not cut a request in flight: a long poll waits for its answer for longer than the timeout', async () => {
    const { api, apiRoot } = await startApi(() => 'answerSlowly');
    const telegram = createClient(apiRoot, createAgent(shortFreeSocketTimeoutMs));

    const sent = await telegram.sendMessage(chatId, 'slow');

    assert.equal(sent.text, 'slow');
    assert.equal(api.attempts.length, 1);
  });
});

describe('the agents', () => {
  it('the https agent for the real Bot API tracks reused connections too (its reuse hook is the instrumented one)', () => {
    const agent = createBotApiHttpsAgent();
    try {
      assert.ok(agent instanceof https.Agent);
      assert.notEqual(agent.reuseSocket, https.Agent.prototype.reuseSocket);
    } finally {
      agent.destroy();
    }
  });
});
