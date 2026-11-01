/**
 * @description `todo_update` / `todo_read` over the REAL bot MCP server (HTTP + the SDK client, the way an agent
 * calls them; shared todo registry plan S1, D3–D8, D54): offered to a Telegram topic and a Jira issue, never to a
 * session no platform reads; a token reaches only its own conversation's list; the instructions name the tools only
 * where they are offered and stay inside Claude Code's 4,096 characters; a `final` answer to a request the list was
 * not touched in carries the reminder line.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StateStore } from '../state';
import { keyFromString, keyToString } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { answerRequest } from '../requests/answerRequest';
import type { AnswerSinks } from '../platform/answerSink';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import {
  buildMcpServerInstructions,
  buildSchedulerMcpToken,
  createSchedulerMcpServer,
  type SchedulerMcpDeps,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { TodoStore } from '../todos/store';
import { createTodoRegistry, type TodoRegistry } from '../todos/registry';

const secret = 'd'.repeat(64);
const topicKey = makeTelegramKey(-1001111111111, 42);
const sharedFolderTopicKey = makeTelegramKey(-1001111111111, 43);
const jiraKey = makeJiraKey('PROJ-12');
const sharedFolder = '/home/user/projects/shared';
/** Claude Code cuts a server's instructions longer than this. */
const claudeCodeInstructionsMaxLength = 4096;

let fakeHome: string;
let handle: SchedulerMcpHandle;
let stateStore: StateStore;
let ledger: RequestLedger;
let registry: TodoRegistry;
let isTodoOffered: boolean;
let clients: Client[];

function buildDeps(store: StateStore, answerSinks: AnswerSinks): SchedulerMcpDeps {
  return {
    store,
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: (directory) => (directory === sharedFolder ? [keyToString(topicKey), keyToString(sharedFolderTopicKey)] : []),
    getThreadAdapterName: () => 'claude',
    sendFilesToThread: async () => ({ ok: true, summary: 'unused', sentKinds: [] }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    unpinMessages: async () => {},
    get todos() {
      return isTodoOffered
        ? {
          update: async (threadKey: string, args: Parameters<TodoRegistry['updateTodos']>[1]) => registry.updateTodos(keyFromString(threadKey), args),
          read: async (threadKey: string, args: Parameters<TodoRegistry['readTodos']>[1]) => registry.readTodos(keyFromString(threadKey), args),
        }
        : undefined;
    },
    answerRequest: (args) => answerRequest({
      ledger,
      answerSinks,
      getFinalAnswerNote: (key, requestCreatedAt) => registry.getFinalAnswerNote(key, requestCreatedAt),
    }, args),
    whenSessionsRestored: async () => {},
    getSecret: async () => secret,
    port: 0,
  };
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-mcp-'));
  const dataDir = path.join(fakeHome, 'data');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  stateStore = store;
  ledger = new RequestLedger({ store, history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes) });
  await ledger.load();
  registry = createTodoRegistry({ store: new TodoStore(dataDir), getNowMs: Date.now });
  isTodoOffered = true;
  clients = [];
  const recordingSink = { deliverAnswer: async () => ({ ok: true as const }), deliverAlert: async () => ({ ok: true as const }), releaseAlert: async () => {} };
  handle = createSchedulerMcpServer(buildDeps(store, new Map([['telegram', recordingSink], ['jira', recordingSink]])));
  await handle.start();
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await handle.stop();
  await stateStore.flush();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function connectAgent(scope: SchedulerScope): Promise<Client> {
  const client = new Client({ name: 'todo-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${buildSchedulerMcpToken(secret, scope)}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const block = result.content.find((content) => content.type === 'text');
  return { isError: result.isError === true, text: block?.type === 'text' ? block.text : '' };
}

describe('todo_update / todo_read over the bot MCP server', () => {
  it('a Telegram topic and a Jira issue are offered both tools and the bullet; a session no platform reads gets neither', async () => {
    for (const scope of [{ kind: 'thread', threadKey: keyToString(topicKey) }, { kind: 'thread', threadKey: keyToString(jiraKey) }] as const) {
      const client = await connectAgent(scope);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes('todo_update') && names.includes('todo_read'), scope.threadKey);
      assert.match(client.getInstructions() ?? '', /BEFORE you start any task .* → todo_update adds it as inWork/, scope.threadKey);
    }
    const unknown = await connectAgent({ kind: 'thread', threadKey: 'nobody-reads-this' });
    assert.ok(!(await unknown.listTools()).tools.some((tool) => tool.name.startsWith('todo_')));
    assert.doesNotMatch(unknown.getInstructions() ?? '', /todo_update/);
  });

  it('without the registry port neither tool nor the bullet is offered', async () => {
    isTodoOffered = false;
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });
    assert.ok(!(await client.listTools()).tools.some((tool) => tool.name.startsWith('todo_')));
    assert.doesNotMatch(client.getInstructions() ?? '', /todo_update/);
  });

  it('every platform\'s instructions stay inside Claude Code\'s 4,096 characters with everything offered', () => {
    for (const platform of ['telegram', 'jira', null] as const) {
      const length = buildMcpServerInstructions(platform, { isJiraAttachmentToolOffered: true, isTodoToolOffered: true, isRemoteRunOffered: false }, true).length;
      assert.ok(length < claudeCodeInstructionsMaxLength, `${platform}: ${length}`);
    }
  });

  it('todo_update upserts through the wire (items as a JSON string too) and todo_read reads the same list', async () => {
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(jiraKey) });
    const added = await callTool(client, 'todo_update', { items: JSON.stringify([{ title: 'Export to PDF', status: 'inWork' }, { title: 'Fix the footer' }]) });
    assert.equal(added.isError, false);
    assert.match(added.text, /^Saved\. New items: t1, t2\./);
    const patched = await callTool(client, 'todo_update', { items: [{ id: 't2', position: 'top', ref: 'PROJ-99' }] });
    assert.match(patched.text, /1\. t2 Fix the footer \[PROJ-99\]/);
    const read = await callTool(client, 'todo_read', {});
    assert.match(read.text, /▶ in work:\n {2}t1 Export to PDF/);
    assert.equal(registry.getTopic(jiraKey).items.length, 2, 'the issue\'s own list');
    assert.equal(registry.getTopic(topicKey).items.length, 0, 'no other conversation touched');
  });

  it('a refused update is a tool error; a bad field value is refused by the schema', async () => {
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });
    const refused = await callTool(client, 'todo_update', { items: [{ id: 't5', status: 'done' }] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Nothing was saved/);
    const badStatus = await callTool(client, 'todo_update', { items: [{ title: 'x', status: 'finished' }] });
    assert.equal(badStatus.isError, true);
    assert.equal(registry.getTopic(topicKey).items.length, 0);
  });

  it('a thread token reaches only its own topic; a dir token with two bound topics must name one of them', async () => {
    const own = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });
    const foreign = await callTool(own, 'todo_update', { items: [{ title: 'x' }], threadKey: keyToString(sharedFolderTopicKey) });
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /does not match this session's thread/);

    const shared = await connectAgent({ kind: 'dir', directory: sharedFolder });
    const ambiguous = await callTool(shared, 'todo_read', {});
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /pass threadKey/);
    const named = await callTool(shared, 'todo_update', { items: [{ title: 'Shared folder work' }], threadKey: keyToString(sharedFolderTopicKey) });
    assert.equal(named.isError, false);
    assert.equal(registry.getTopic(sharedFolderTopicKey).items[0]?.title, 'Shared folder work');
  });

  it('a final answer to a request the list was not touched in carries the reminder line; one after an update does not', async () => {
    const client = await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) });
    await callTool(client, 'todo_update', { items: [{ title: 'Speed up flows', status: 'inWork' }] });
    // The request must be younger than the update by at least a millisecond to be "not touched".
    await new Promise((resolve) => setTimeout(resolve, 5));
    const untouched = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    const reminded = await callTool(client, 'answer_request', { requestId: untouched.id, kind: 'final', body: 'done' });
    assert.match(reminded.text, /closed \(final\)\. Your published todo list still shows in work: t1 «Speed up flows»\./);

    const touched = await ledger.createRequest(topicKey, { kind: 'message', attributes: {} });
    await callTool(client, 'todo_update', {});
    const quiet = await callTool(client, 'answer_request', { requestId: touched.id, kind: 'final', body: 'done' });
    assert.doesNotMatch(quiet.text, /todo list/);
  });
});
