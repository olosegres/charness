/**
 * @description The bot MCP tools take CLOSED input over the REAL server (HTTP + the SDK client, the way an agent calls
 * them). An agent that writes `filePath` instead of `path` used to have the key dropped silently — the images never
 * arrived and the tool still said "Delivered 3 messages". Now an unknown key, at the top of a call or inside a nested
 * item, is a tool error that names the key, hints at the nearest allowed one and lists the allowed ones; no tool body
 * runs. Also covered: an empty item is refused.
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
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { splitMessage } from '../connectors/telegram/messageSplit';
import {
  buildSchedulerMcpToken,
  createSchedulerMcpServer,
  type SchedulerMcpDeps,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { createSendFilesToThread } from '../utils/fileSendService';
import { createSendMessagesToThread } from '../utils/messageSendService';
import { createFileSendTestRecorderGateway, type RecordedFileSendGatewayCall } from './fileSendTestRecorder';

const secret = 'c'.repeat(64);
const telegramThreadKey = keyToString(makeTelegramKey(-1001111111111, 11));
const jiraThreadKey = keyToString(makeJiraKey('PROJ-12'));
const maxMessageLength = 4096;
const unknownKeyProbe = 'definitelyNotAKey';
const recorderMessageIds = {
  singleMessageIds: { sendPhoto: 501, sendAnimation: 502, sendVideo: 503, sendDocument: 504 },
  albumMessageIds: [601, 602],
};

/** The slice of a JSON Schema this test walks: object nodes and the places a nested object can sit. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
}

interface Fixture {
  handle: SchedulerMcpHandle;
  /** Every tool body that ran (the stubs record themselves); the real send services are read through the two lists below. */
  toolBodyCalls: string[];
  sentTextChunks: string[];
  fileGatewayCalls: Array<RecordedFileSendGatewayCall<string>>;
  boundDir: string;
}

let fakeHome: string;
let store: StateStore;
let fixture: Fixture;
let clients: Client[];

async function startFixture(): Promise<Fixture> {
  const dataDir = path.join(fakeHome, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  const boundDir = path.join(fakeHome, 'bound-project');
  fs.mkdirSync(boundDir);
  const toolBodyCalls: string[] = [];
  const sentTextChunks: string[] = [];
  const fileGatewayCalls: Array<RecordedFileSendGatewayCall<string>> = [];
  const sendFilesToThread = createSendFilesToThread<string>({
    resolveTargetAndWorkDir: (threadKey) => ({ ok: true, target: threadKey, workDir: boundDir }),
    gateway: createFileSendTestRecorderGateway(fileGatewayCalls, recorderMessageIds),
    recordMessageIds: async () => {},
  });
  const sendMessagesToThread = createSendMessagesToThread<string>({
    resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
    sendChunk: async (_target, chunk) => {
      sentTextChunks.push(chunk);
      return 700 + sentTextChunks.length;
    },
    sendFiles: sendFilesToThread,
    splitMessage,
    maxMessageLength,
    measureRendered: (chunk) => chunk.length,
  });
  const deps: SchedulerMcpDeps = {
    store,
    armJob: () => {
      toolBodyCalls.push('armJob');
    },
    disarmJob: () => {
      toolBodyCalls.push('disarmJob');
    },
    getThreadsForDirectory: () => [],
    getThreadAdapterName: () => 'claude',
    unpinMessages: async () => {},
    sendFilesToThread: (threadKey, options) => {
      toolBodyCalls.push('sendFilesToThread');
      return sendFilesToThread(threadKey, options);
    },
    sendMessagesToThread: (threadKey, options) => {
      toolBodyCalls.push('sendMessagesToThread');
      return sendMessagesToThread(threadKey, options);
    },
    compactConversation: () => {
      toolBodyCalls.push('compactConversation');
      return { ok: true, message: 'armed' };
    },
    fetchJiraAttachment: async () => {
      toolBodyCalls.push('fetchJiraAttachment');
      return { ok: true, message: 'saved' };
    },
    listClaudeProfiles: async () => {
      toolBodyCalls.push('listClaudeProfiles');
      throw new Error('unused');
    },
    todos: {
      update: async () => {
        toolBodyCalls.push('todoUpdate');
        return { ok: true, message: 'updated' };
      },
      read: async () => {
        toolBodyCalls.push('todoRead');
        return { ok: true, message: 'list' };
      },
    },
    answerRequest: async () => {
      toolBodyCalls.push('answerRequest');
      return { ok: false, error: 'unused' };
    },
    whenSessionsRestored: async () => {},
    getSecret: async () => secret,
    port: 0,
  };
  const handle = createSchedulerMcpServer(deps);
  await handle.start();
  return { handle, toolBodyCalls, sentTextChunks, fileGatewayCalls, boundDir };
}

async function connect(scope: SchedulerScope): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const token = buildSchedulerMcpToken(secret, scope);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${fixture.handle.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const connectTelegram = (): Promise<Client> => connect({ kind: 'thread', threadKey: telegramThreadKey });
const connectJira = (): Promise<Client> => connect({ kind: 'thread', threadKey: jiraThreadKey });

/** The text of a tool result, as the agent reads it. */
function getText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const parsed = CallToolResultSchema.parse(result);
  return parsed.content.find((block) => block.type === 'text')?.text ?? '';
}

/** One entry of the issue list the SDK puts in a validation error; only what this test reads. */
interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

/** The issue list inside a tool's validation error, as the agent reads it: `... for tool X: [ {issue}, ... ]`. */
function getValidationIssues(text: string): ValidationIssue[] {
  const listStart = text.indexOf('[\n');
  assert.ok(listStart >= 0, `no issue list in: ${text}`);
  return JSON.parse(text.slice(listStart));
}

function writeBoundFile(name: string, contents = 'bytes'): void {
  fs.writeFileSync(path.join(fixture.boundDir, name), contents);
}

/** Every object node (with `properties`) under a JSON Schema node, the node itself included. */
function collectObjectNodes(node: JsonSchemaNode): JsonSchemaNode[] {
  const nested = [
    ...Object.values(node.properties ?? {}),
    ...(node.items ? [node.items] : []),
    ...(node.anyOf ?? []),
  ].flatMap(collectObjectNodes);
  return node.properties ? [node, ...nested] : nested;
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-strict-mcp-'));
  clients = [];
  fixture = await startFixture();
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await fixture.handle.stop();
  await store.flush();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('every bot tool advertises a closed input', () => {
  for (const [label, connectSession] of [['Telegram', connectTelegram], ['Jira', connectJira]] as const) {
    it(`${label} session: no object in any tool's input schema, nested ones included, accepts extra keys`, async () => {
      const client = await connectSession();
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 3, `a ${label} session should get several tools, got ${tools.map((tool) => tool.name).join(', ')}`);
      for (const tool of tools) {
        const objectNodes = collectObjectNodes(tool.inputSchema);
        assert.ok(objectNodes.length > 0, `${tool.name} should take an object`);
        for (const node of objectNodes) {
          assert.equal(node.additionalProperties, false, `${tool.name}: an object node of its input schema accepts unknown keys`);
        }
      }
    });
  }
});

describe('every bot tool refuses an unknown key', () => {
  for (const [label, connectSession] of [['Telegram', connectTelegram], ['Jira', connectJira]] as const) {
    it(`${label} session: the error names the key, lists exactly the keys the tool takes, and no tool body runs`, async () => {
      const client = await connectSession();
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const result = await client.callTool({ name: tool.name, arguments: { [unknownKeyProbe]: true } });
        const text = getText(result);
        const allowed = Object.keys(tool.inputSchema.properties ?? {});
        assert.equal(result.isError, true, `${tool.name}: an unknown key must be a tool error, got: ${text}`);
        assert.ok(text.includes(`unknown key \`${unknownKeyProbe}\``), `${tool.name}: the error should name the key, got: ${text}`);
        assert.ok(text.includes(`Allowed: ${allowed.join(', ')}`), `${tool.name}: the error should list ${allowed.join(', ')}, got: ${text}`);
      }
      assert.deepEqual(fixture.toolBodyCalls, [], 'no tool body may run on a refused call');
    });
  }
});

describe('send_messages_to_user', () => {
  it('an item with `filePath` instead of `path` is refused with the nearest allowed key named, and nothing is sent', async () => {
    writeBoundFile('a.png');
    const client = await connectTelegram();
    const result = await client.callTool({
      name: 'send_messages_to_user',
      arguments: { messages: [{ text: 'chart one', filePath: 'a.png' }, 'tail'] },
    });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `filePath` — did you mean `path`? Allowed: text, path, as_file'), text);
    // The hint is the message of the issue AT the offending item, not only buried in a union branch's detail.
    const [issue] = getValidationIssues(text);
    assert.deepEqual(issue.path, ['messages', 0]);
    assert.equal(issue.message, 'unknown key `filePath` — did you mean `path`? Allowed: text, path, as_file.');
    assert.deepEqual(fixture.toolBodyCalls, []);
    assert.deepEqual(fixture.sentTextChunks, []);
    assert.deepEqual(fixture.fileGatewayCalls, []);
  });

  it('the same refusal when the bridge hands the array over as a JSON string', async () => {
    const client = await connectTelegram();
    const result = await client.callTool({
      name: 'send_messages_to_user',
      arguments: { messages: JSON.stringify([{ text: 'chart one', filePath: 'a.png' }]) },
    });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `filePath` — did you mean `path`?'), text);
    assert.deepEqual(fixture.toolBodyCalls, []);
  });

  it('a misspelled top-level key is refused with its hint (`message` → `messages`)', async () => {
    const client = await connectTelegram();
    const result = await client.callTool({ name: 'send_messages_to_user', arguments: { message: ['hello'] } });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `message` — did you mean `messages`? Allowed: messages, threadKey'), text);
    assert.deepEqual(fixture.toolBodyCalls, []);
  });

  it('every unknown key of an item is reported, the ones with no near match without a hint', async () => {
    const client = await connectTelegram();
    const result = await client.callTool({
      name: 'send_messages_to_user',
      arguments: { messages: [{ text: 'x', filePath: 'a.png', caption: 'c' }] },
    });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `filePath` — did you mean `path`?'), text);
    assert.ok(text.includes('unknown key `caption`.'), text);
    assert.ok(!text.includes('did you mean `text`'), text);
  });

  for (const [label, item] of [
    ['an empty object', {}],
    ['a blank text', { text: '   ' }],
    ['a blank path', { path: '' }],
    ['an as_file flag alone', { as_file: true }],
  ] as const) {
    it(`${label} is refused as an item with neither text nor path, and nothing is sent`, async () => {
      const client = await connectTelegram();
      const result = await client.callTool({ name: 'send_messages_to_user', arguments: { messages: ['fine', item] } });
      const text = getText(result);
      assert.equal(result.isError, true, text);
      assert.ok(text.includes('text or path'), text);
      assert.deepEqual(fixture.toolBodyCalls, []);
      assert.deepEqual(fixture.sentTextChunks, []);
    });
  }

  it('a valid call with every key an item takes still goes through', async () => {
    writeBoundFile('a.png');
    const client = await connectTelegram();
    const result = await client.callTool({
      name: 'send_messages_to_user',
      arguments: { messages: ['hello', { text: 'caption', path: 'a.png', as_file: true }] },
    });
    assert.notEqual(result.isError, true, getText(result));
    assert.deepEqual(fixture.sentTextChunks, ['hello']);
    assert.equal(fixture.fileGatewayCalls.length, 1);
  });
});

describe('send_file_to_user', () => {
  it('`path` instead of `paths` is refused with the right key named, and nothing is sent', async () => {
    writeBoundFile('a.png');
    const client = await connectTelegram();
    const result = await client.callTool({ name: 'send_file_to_user', arguments: { path: 'a.png' } });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `path` — did you mean `paths`? Allowed: paths, caption, as_file, threadKey'), text);
    assert.deepEqual(fixture.toolBodyCalls, []);
    assert.deepEqual(fixture.fileGatewayCalls, []);
  });
});

describe('todo_update', () => {
  it('a misspelled key inside an item is refused with its hint (`stauts` → `status`)', async () => {
    const client = await connectTelegram();
    const result = await client.callTool({
      name: 'todo_update',
      arguments: { items: [{ title: 'fix the leak', stauts: 'done' }] },
    });
    const text = getText(result);
    assert.equal(result.isError, true, text);
    assert.ok(text.includes('unknown key `stauts` — did you mean `status`?'), text);
    assert.deepEqual(fixture.toolBodyCalls, []);
  });
});
