/**
 * @description `answer_request` and the boot gate over the REAL bot MCP server
 * (HTTP + the SDK client, the way an agent calls it): the tool is listed, a
 * `thread:` token answers only its own conversation's requests, a `dir:` token
 * those of every thread bound to its folder, and `compact_conversation` waits for
 * the boot to restore sessions instead of answering in that window.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StateStore } from '../state';
import { keyToString } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { answerRequest } from '../requests/answerRequest';
import type { AnswerSinks, RequestAnswerDelivery } from '../platform/answerSink';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import {
  buildSchedulerMcpToken,
  createSchedulerMcpServer,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const secret = 'c'.repeat(64);
const topicKey = makeTelegramKey(-1001234567890, 42);
const sharedFolderTopicKey = makeTelegramKey(-1001234567890, 43);
const otherTopicKey = makeTelegramKey(-1001234567890, 99);
const sharedFolder = '/home/user/projects/shared';

let fakeHome: string;
let originalHome: string | undefined;
let handle: SchedulerMcpHandle;
let ledger: RequestLedger;
let deliveries: RequestAnswerDelivery[];
let compactCalls: string[];
let openSessionsGate: () => void;
let clients: Client[];

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-answer-mcp-'));
  process.env.HOME = fakeHome;
  const dataDir = path.join(fakeHome, 'data');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  ledger = new RequestLedger({
    store,
    history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes),
  });
  await ledger.load();
  deliveries = [];
  compactCalls = [];
  clients = [];
  const answerSinks: AnswerSinks = new Map([
    ['telegram', { deliverAnswer: async (_key, delivery) => { deliveries.push(delivery); return { ok: true }; } }],
  ]);
  const sessionsRestored = new Promise<void>((resolve) => { openSessionsGate = resolve; });
  handle = createSchedulerMcpServer({
    store,
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: (directory) =>
      directory === sharedFolder ? [keyToString(topicKey), keyToString(sharedFolderTopicKey)] : [],
    getThreadAdapterName: () => 'claude',
    sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0 }),
    compactConversation: (threadKey) => {
      compactCalls.push(threadKey);
      return { ok: true, message: 'compaction armed' };
    },
    answerRequest: (args) => answerRequest({ ledger, answerSinks }, args),
    whenSessionsRestored: () => sessionsRestored,
    getSecret: async () => secret,
    port: 0,
  });
  await handle.start();
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await handle.stop();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function connectAgent(scope: SchedulerScope): Promise<Client> {
  const client = new Client({ name: 'answer-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${buildSchedulerMcpToken(secret, scope)}` };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers } }),
  );
  clients.push(client);
  return client;
}

async function callAnswer(client: Client, requestId: string): Promise<{ isError: boolean; text: string }> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: 'answer_request', arguments: { requestId, kind: 'final', body: 'done' } }),
  );
  const block = result.content.find((content) => content.type === 'text');
  return { isError: result.isError === true, text: block?.type === 'text' ? block.text : '' };
}

describe('answer_request over the bot MCP server', () => {
  it('is listed, and a thread token answers only its own conversation', async () => {
    const own = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const foreign = await ledger.createRequest(otherTopicKey, { kind: 'message', attributes: {} });
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });

    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'answer_request'));

    const refused = await callAnswer(client, foreign.id);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Unknown request id/);
    assert.equal(ledger.getOpenRequest(otherTopicKey)?.id, foreign.id);

    const answered = await callAnswer(client, own.id);
    assert.equal(answered.isError, false);
    assert.deepEqual(deliveries.map((delivery) => delivery.requestId), [own.id]);
    assert.equal(ledger.getOpenRequest(topicKey), undefined);
  });

  it('a dir token answers the requests of every thread bound to its folder, and no other', async () => {
    const sharedFolderRequest = await ledger.createRequest(sharedFolderTopicKey, { kind: 'message', attributes: {} });
    const outside = await ledger.createRequest(otherTopicKey, { kind: 'message', attributes: {} });
    const client = await connectAgent({ kind: 'dir', directory: sharedFolder });

    assert.equal((await callAnswer(client, sharedFolderRequest.id)).isError, false);
    assert.equal((await callAnswer(client, outside.id)).isError, true);
    assert.deepEqual(deliveries.map((delivery) => delivery.requestId), [sharedFolderRequest.id]);
  });
});

describe('the boot gate', () => {
  it('compact_conversation waits until the sessions are restored', async () => {
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });

    const pending = client.callTool({ name: 'compact_conversation', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(compactCalls, [], 'no session lookup before the boot restored the sessions');

    openSessionsGate();
    const result = CallToolResultSchema.parse(await pending);
    assert.equal(result.isError === true, false);
    assert.deepEqual(compactCalls, [keyToString(topicKey)]);
  });
});
