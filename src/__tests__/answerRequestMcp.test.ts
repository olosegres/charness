/**
 * @description `answer_request` and the boot gate over the REAL bot MCP server
 * (HTTP + the SDK client, the way an agent calls it): the tool is listed, a
 * `thread:` token answers only its own conversation's requests, a `dir:` token
 * those of every thread bound to its folder, and `compact_conversation` waits for
 * the boot to restore sessions instead of answering in that window.
 */

/** Test case: N/A — Charness has no Jira tracker. */

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
import { answerStyleInstruction } from '../requests/answerStyle';
import type { AnswerSinks, RequestAnswerDelivery } from '../platform/answerSink';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import {
  buildSchedulerMcpToken,
  createSchedulerMcpServer,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

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
/** `<thread key> <attachment id>` of every `jira_get_attachment` call that reached the connector's port. */
let attachmentCalls: string[];
/** Whether the Jira connector's port is supplied (an instance without the connector has none). */
let isJiraAttachmentOffered = true;
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
  attachmentCalls = [];
  isJiraAttachmentOffered = true;
  clients = [];
  const recordingSink = { deliverAnswer: async (_key: unknown, delivery: RequestAnswerDelivery) => { deliveries.push(delivery); return { ok: true as const }; }, deliverAlert: async () => ({ ok: true as const }), releaseAlert: async () => {} };
  const answerSinks: AnswerSinks = new Map([
    ['telegram', recordingSink],
    ['jira', recordingSink],
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
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    compactConversation: (threadKey) => {
      compactCalls.push(threadKey);
      return { ok: true, message: 'compaction armed' };
    },
    answerRequest: (args) => answerRequest({ ledger, answerSinks }, args),
    get fetchJiraAttachment() {
      return isJiraAttachmentOffered
        ? async (threadKey: string, attachmentId: string) => {
          attachmentCalls.push(`${threadKey} ${attachmentId}`);
          return attachmentId === '10234'
            ? { ok: true as const, message: 'Attachment 10234 (shot.png, image/png, 3 bytes) is saved at /files/10234-shot.png.' }
            : { ok: false as const, error: `Attachment ${attachmentId} is not an attachment of PROJ-12.` };
        }
        : undefined;
    },
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
    assert.equal(ledger.getNewestOpenRequest(otherTopicKey)?.id, foreign.id);

    const answered = await callAnswer(client, own.id);
    assert.equal(answered.isError, false);
    assert.deepEqual(deliveries.map((delivery) => delivery.requestId), [own.id]);
    assert.equal(ledger.getNewestOpenRequest(topicKey), undefined);
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

describe('how the agent is told to write an answer', () => {
  const scopes = [
    { label: 'a Telegram topic', scope: { kind: 'thread' as const, threadKey: keyToString(topicKey) } },
    { label: 'an OpenCode folder session', scope: { kind: 'dir' as const, directory: sharedFolder } },
    { label: 'a Jira issue', scope: { kind: 'thread' as const, threadKey: keyToString(makeJiraKey('PROJ-12')) } },
    { label: 'a conversation on no known platform', scope: { kind: 'thread' as const, threadKey: 'a-key-no-codec-reads' } },
  ];

  for (const { label, scope } of scopes) {
    it(`${label}: the connect-time instructions, the tool description and the body field carry the shared style sentence`, async () => {
      const client = await connectAgent(scope);
      assert.ok((client.getInstructions() ?? '').includes(answerStyleInstruction), 'instructions');
      const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'answer_request');
      assert.ok(tool?.description?.includes(answerStyleInstruction), 'tool description');
      assert.ok(JSON.stringify(tool?.inputSchema.properties?.body).includes(answerStyleInstruction), 'body field description');
    });
  }

  it('a Jira session without the attachment tool gets the neutral instructions, the style sentence still in them', async () => {
    isJiraAttachmentOffered = false;
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(makeJiraKey('PROJ-12')) });
    assert.ok((client.getInstructions() ?? '').includes(answerStyleInstruction));
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

describe('the tool set per platform (Jira connector plan J2, D18)', () => {
  const neutralToolNames = ['answer_request', 'compact_conversation'];
  const telegramOnlyToolNames = ['schedule_create', 'schedule_list', 'schedule_cancel', 'send_file_to_user', 'send_messages_to_user'];

  it('a Jira session sees answer_request, compact_conversation and jira_get_attachment, with instructions naming no Telegram tool', async () => {
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(makeJiraKey('PROJ-12')) });

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [...neutralToolNames, 'jira_get_attachment'].sort());
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /answer_request/);
    assert.match(instructions, /jira_get_attachment/);
    for (const name of telegramOnlyToolNames) assert.doesNotMatch(instructions, new RegExp(name), name);
    assert.doesNotMatch(instructions, /Telegram/);
  });

  describe('replyToCommentIds — the comments an answer replies to (T11)', () => {
    const jiraScope = { kind: 'thread' as const, threadKey: keyToString(makeJiraKey('PROJ-12')) };
    const t11 = 'Ids of the issue\'s comments this answer replies to, e.g. ["10240"]. The bot mentions each comment\'s ' +
      'author at the top of your answer so they are notified. Only comments you were shown in this conversation count.';
    const getAnswerTool = async (client: Client) => (await client.listTools()).tools.find((tool) => tool.name === 'answer_request');

    it('a Jira session is offered the field, described by T11, at most 10 numeric ids — nobody else is', async () => {
      const jiraClient = await connectAgent(jiraScope);
      const jiraTool = await getAnswerTool(jiraClient);
      assert.deepEqual(Object.keys(jiraTool?.inputSchema.properties ?? {}).sort(), ['body', 'kind', 'replyToCommentIds', 'requestId']);
      const field = jiraTool?.inputSchema.properties?.replyToCommentIds as { description?: string; maxItems?: number; type?: string; items?: { pattern?: string } };
      assert.equal(field.description, t11);
      assert.equal(field.type, 'array');
      assert.equal(field.maxItems, 10);
      assert.equal(field.items?.pattern, '^\\d+$');
      assert.ok(!(jiraTool?.inputSchema.required ?? []).includes('replyToCommentIds'), 'optional');

      for (const scope of [{ kind: 'thread' as const, threadKey: keyToString(topicKey) }, { kind: 'dir' as const, directory: sharedFolder }]) {
        const otherTool = await getAnswerTool(await connectAgent(scope));
        assert.deepEqual(Object.keys(otherTool?.inputSchema.properties ?? {}).sort(), ['body', 'kind', 'requestId'], scope.kind);
      }
    });

    it('the ids reach the platform\'s sink untouched; an answer without them carries none', async () => {
      const request = await ledger.createRequest(makeJiraKey('PROJ-12'), { kind: 'trackerMention', attributes: { issueKey: 'PROJ-12', triggerId: 'mention:10240', requester: 'a' } });
      const client = await connectAgent(jiraScope);
      const withIds = CallToolResultSchema.parse(await client.callTool({
        name: 'answer_request',
        arguments: { requestId: request.id, kind: 'progress', body: 'Looking.', replyToCommentIds: ['10240', '10241'] },
      }));
      assert.equal(withIds.isError, undefined);
      assert.deepEqual(deliveries[0].replyToCommentIds, ['10240', '10241']);
      await client.callTool({ name: 'answer_request', arguments: { requestId: request.id, kind: 'final', body: 'Done.' } });
      assert.equal(deliveries[1].replyToCommentIds, undefined);
    });

    it('more than ten ids, or an id that is not a number, is refused by the schema — nothing is sent', async () => {
      const request = await ledger.createRequest(makeJiraKey('PROJ-12'), { kind: 'trackerMention', attributes: { issueKey: 'PROJ-12', triggerId: 'mention:10240', requester: 'a' } });
      const client = await connectAgent(jiraScope);
      const tooMany = Array.from({ length: 11 }, (_, index) => `${10000 + index}`);
      for (const replyToCommentIds of [tooMany, ['10240/../x'], ['abc']]) {
        const refused = await client.callTool({ name: 'answer_request', arguments: { requestId: request.id, kind: 'final', body: 'Done.', replyToCommentIds } })
          .then((result) => CallToolResultSchema.parse(result).isError === true, () => true);
        assert.equal(refused, true, JSON.stringify(replyToCommentIds));
      }
      assert.deepEqual(deliveries, []);
    });
  });

  it('C10: a Jira session without the connector\'s port is not offered the tool', async () => {
    isJiraAttachmentOffered = false;
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(makeJiraKey('PROJ-12')) });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...neutralToolNames].sort());
    assert.doesNotMatch(client.getInstructions() ?? '', /jira_get_attachment/, 'the instructions name no tool the session lacks');
  });

  it('C10: no other kind of session has the tool, a Telegram topic and a folder session included', async () => {
    for (const scope of [
      { kind: 'thread' as const, threadKey: keyToString(topicKey) },
      { kind: 'dir' as const, directory: sharedFolder },
      { kind: 'thread' as const, threadKey: 'a-key-no-codec-reads' },
    ]) {
      const client = await connectAgent(scope);
      assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'jira_get_attachment'), scope.kind);
    }
  });

  it('C10: the issue is the SESSION\'s own — the call carries nothing but an attachment id, and what the port answers is relayed', async () => {
    openSessionsGate();
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(makeJiraKey('PROJ-12')) });
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'jira_get_attachment');
    assert.deepEqual(Object.keys(tool?.inputSchema.properties ?? {}), ['attachmentId'], 'no argument can name an issue');
    const fetched = CallToolResultSchema.parse(await client.callTool({ name: 'jira_get_attachment', arguments: { attachmentId: '10234' } }));
    assert.equal(fetched.isError, undefined);
    assert.match(JSON.stringify(fetched.content), /saved at \/files\/10234-shot\.png/);
    // A planted argument naming another issue is not an argument of the tool, whatever the agent adds.
    const refused = CallToolResultSchema.parse(await client.callTool({ name: 'jira_get_attachment', arguments: { attachmentId: '99999', issueKey: 'OTHER-1', threadKey: keyToString(makeJiraKey('OTHER-1')) } }));
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /is not an attachment of PROJ-12/);
    assert.deepEqual(attachmentCalls, [`${keyToString(makeJiraKey('PROJ-12'))} 10234`, `${keyToString(makeJiraKey('PROJ-12'))} 99999`]);
  });

  it('C10: the tool changes the digest a Jira session connects to — an adopted process reconnects at idle (L4) — and no other platform\'s', () => {
    const withTool = handle.getToolDigest('jira');
    const telegram = handle.getToolDigest('telegram');
    isJiraAttachmentOffered = false;
    assert.notEqual(handle.getToolDigest('jira'), withTool);
    assert.equal(handle.getToolDigest('telegram'), telegram);
  });

  it('a Telegram session and an OpenCode folder session keep every tool', async () => {
    for (const scope of [
      { kind: 'thread' as const, threadKey: keyToString(topicKey) },
      { kind: 'dir' as const, directory: sharedFolder },
    ]) {
      const client = await connectAgent(scope);
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [...neutralToolNames, ...telegramOnlyToolNames]) assert.ok(toolNames.includes(name), `${scope.kind}: ${name}`);
      assert.match(client.getInstructions() ?? '', /schedule_create/);
    }
  });
});
