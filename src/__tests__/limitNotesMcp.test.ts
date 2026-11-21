/**
 * The accounts note on the bot MCP server, over the REAL server (HTTP + the SDK client, the way an agent calls it): the result of
 * `send_messages_to_user`, `send_file_to_user` (a topic's and a Jira issue's) and `answer_request` carries the note as its LAST block
 * when the bot has one due for the conversation, and nothing otherwise; `claude_profiles` and a worker watch
 * (`schedule_create` with `statusWorkerRunDir`) tell the bot the conversation orchestrates workers, resolved like the send tools.
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
import { keyToString } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { answerRequest } from '../requests/answerRequest';
import type { AnswerSinks } from '../platform/answerSink';
import type { SendFilesToThreadResult } from '../utils/fileSendService';
import type { SendMessagesToThreadResult } from '../utils/messageSendService';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { buildSchedulerMcpToken, createSchedulerMcpServer, type SchedulerMcpHandle, type SchedulerScope } from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { appendLimitNote, stripLimitNote } from '../limitNotes/noteText';
import type { ClaudeProfilesReport } from '../utils/claudeUsage';

const secret = 'd'.repeat(64);
const topicKey = makeTelegramKey(-1001111111111, 42);
const secondTopicKey = makeTelegramKey(-1001111111111, 43);
const jiraKey = makeJiraKey('PROJ-12');
const sharedFolder = '/home/user/projects/shared';
const soloFolder = '/home/user/projects/solo';
const note = '[Accounts · 14:05 · changed] work 71 % (resets in 1 d 16 h) → next new worker; default 20 % (5 d).';
const sendSummary = 'Delivered 2 messages to the topic.';

const emptyReport: ClaudeProfilesReport = { model: null, relevantBuckets: [], recommended: null, pickReason: 'none', nextAvailable: null, launchOrder: [], profiles: [] };

let fakeHome: string;
let originalHome: string | undefined;
let handle: SchedulerMcpHandle;
let ledger: RequestLedger;
let clients: Client[];
/** The notes the fake bot has due, by conversation: taking one empties it, like the real notes do. */
let dueNotes: Map<string, string>;
let noteTakes: string[];
let profilesCalls: Array<{ threadKey: string; report: ClaudeProfilesReport }>;
let workerWatchCalls: string[];
let sendResult: SendMessagesToThreadResult;
let fileResult: SendFilesToThreadResult;
/** Whether the three note ports are supplied (an instance built without the feature has none). */
let isNotesPortSupplied: boolean;

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-limit-mcp-'));
  process.env.HOME = fakeHome;
  const dataDir = path.join(fakeHome, 'data');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  ledger = new RequestLedger({ store, history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes) });
  await ledger.load();
  clients = [];
  dueNotes = new Map();
  noteTakes = [];
  profilesCalls = [];
  workerWatchCalls = [];
  sendResult = { ok: true, summary: sendSummary, undeliveredCount: 0, sentMessageIds: [] };
  fileResult = { ok: true, summary: 'Sent 1 file to the topic.', sentKinds: ['document'] };
  isNotesPortSupplied = true;
  const recordingSink = { deliverAnswer: async () => ({ ok: true as const }), deliverAlert: async () => ({ ok: true as const }), releaseAlert: async () => {} };
  const answerSinks: AnswerSinks = new Map([['telegram', recordingSink], ['jira', recordingSink]]);
  handle = createSchedulerMcpServer({
    store,
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: (directory) => (directory === sharedFolder ? [keyToString(topicKey), keyToString(secondTopicKey)] : directory === soloFolder ? [keyToString(topicKey)] : []),
    getThreadAdapterName: () => 'claude-json-stream',
    unpinMessages: async () => [],
    deleteMessage: async () => {},
    sendFilesToThread: async () => fileResult,
    sendMessagesToThread: async () => sendResult,
    sendJiraFiles: async () => fileResult,
    compactConversation: () => ({ ok: true, message: 'unused' }),
    answerRequest: (args) => answerRequest({ ledger, answerSinks }, args),
    listClaudeProfiles: async () => emptyReport,
    get takeLimitNoteForSend() {
      return isNotesPortSupplied
        ? (threadKey: string) => {
          noteTakes.push(threadKey);
          const due = dueNotes.get(threadKey) ?? null;
          dueNotes.delete(threadKey);
          return due;
        }
        : undefined;
    },
    get noteLimitProfilesCall() {
      return isNotesPortSupplied ? (threadKey: string, report: ClaudeProfilesReport) => { profilesCalls.push({ threadKey, report }); } : undefined;
    },
    get noteLimitWorkerWatch() {
      return isNotesPortSupplied ? (threadKey: string) => { workerWatchCalls.push(threadKey); } : undefined;
    },
    whenSessionsRestored: async () => {},
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
  const client = new Client({ name: 'limit-note-agent', version: '1.0.0' });
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

const topicScope: SchedulerScope = { kind: 'thread', threadKey: keyToString(topicKey) };

describe('the send tools\' results carry the note as their last block', () => {
  it('send_messages_to_user: the summary, a blank line, the note — and the bot can cut it off again exactly', async () => {
    dueNotes.set(keyToString(topicKey), note);
    const result = await callTool(await connectAgent(topicScope), 'send_messages_to_user', { messages: ['one', 'two'] });
    assert.equal(result.isError, false);
    assert.equal(result.text, appendLimitNote(sendSummary, note));
    assert.equal(stripLimitNote(result.text), sendSummary);
    assert.deepEqual(noteTakes, [keyToString(topicKey)], 'asked once, for the conversation the scope resolved');
  });

  it('send_file_to_user, in a topic and in a Jira issue, carries it too', async () => {
    dueNotes.set(keyToString(topicKey), note);
    const topic = await callTool(await connectAgent(topicScope), 'send_file_to_user', { paths: ['report.pdf'] });
    assert.equal(topic.text, appendLimitNote(fileResult.ok ? fileResult.summary : '', note));
    dueNotes.set(keyToString(jiraKey), note);
    const issue = await callTool(await connectAgent({ kind: 'thread', threadKey: keyToString(jiraKey) }), 'send_file_to_user', { paths: ['report.pdf'] });
    assert.equal(issue.text, appendLimitNote(fileResult.ok ? fileResult.summary : '', note));
    assert.deepEqual(noteTakes, [keyToString(topicKey), keyToString(jiraKey)]);
  });

  it('answer_request carries it for the conversation the REQUEST belongs to — also through a folder token naming several topics', async () => {
    const request = await ledger.createRequest(secondTopicKey, { kind: 'message', attributes: {} });
    dueNotes.set(keyToString(secondTopicKey), note);
    const result = await callTool(await connectAgent({ kind: 'dir', directory: sharedFolder }), 'answer_request', { requestId: request.id, kind: 'final', body: 'done' });
    assert.equal(result.isError, false);
    assert.equal(result.text.endsWith(`\n\n${note}`), true, result.text);
    assert.match(result.text, /^Delivered\. Request \S+ is now closed \(final\)\./);
    assert.deepEqual(noteTakes, [keyToString(secondTopicKey)]);
  });

  it('nothing due, or no note port at all: the result is exactly what it was before', async () => {
    const client = await connectAgent(topicScope);
    assert.equal((await callTool(client, 'send_messages_to_user', { messages: ['one'] })).text, sendSummary);
    isNotesPortSupplied = false;
    dueNotes.set(keyToString(topicKey), note);
    const withoutPort = await callTool(await connectAgent(topicScope), 'send_messages_to_user', { messages: ['one'] });
    assert.equal(withoutPort.text, sendSummary);
  });

  it('a send that FAILED gets no note and does not even ask for one — the note is for a delivered message', async () => {
    sendResult = { ok: false, error: 'Telegram refused the message' };
    dueNotes.set(keyToString(topicKey), note);
    const result = await callTool(await connectAgent(topicScope), 'send_messages_to_user', { messages: ['one'] });
    assert.equal(result.isError, true);
    assert.equal(result.text.includes('[Accounts'), false);
    assert.deepEqual(noteTakes, []);
    const unknown = await callTool(await connectAgent({ kind: 'thread', threadKey: keyToString(topicKey) }), 'answer_request', { requestId: 'req_nope', kind: 'final', body: 'x' });
    assert.equal(unknown.isError, true);
    assert.deepEqual(noteTakes, [], 'an unknown request asks for nothing either');
  });

  it('a folder token naming several topics: a send that cannot say which topic is refused as before, with no note', async () => {
    dueNotes.set(keyToString(topicKey), note);
    const result = await callTool(await connectAgent({ kind: 'dir', directory: sharedFolder }), 'send_messages_to_user', { messages: ['one'] });
    assert.equal(result.isError, true);
    assert.match(result.text, /pass threadKey/);
    assert.deepEqual(noteTakes, []);
  });
});

describe('the two calls that make a conversation count as orchestrating workers', () => {
  it('claude_profiles: the bot is told, for the conversation the scope names, with the report the agent got — and the answer is unchanged', async () => {
    const result = await callTool(await connectAgent(topicScope), 'claude_profiles', {});
    assert.equal(result.isError, false);
    assert.equal(result.text.includes('[Accounts'), false, 'no note rides this answer: the agent just looked');
    assert.deepEqual(profilesCalls, [{ threadKey: keyToString(topicKey), report: emptyReport }]);
  });

  it('a folder token with ONE bound topic names it; with several it names none and nothing is recorded (the call itself still works)', async () => {
    const solo = await callTool(await connectAgent({ kind: 'dir', directory: soloFolder }), 'claude_profiles', {});
    assert.equal(solo.isError, false);
    assert.deepEqual(profilesCalls.map((call) => call.threadKey), [keyToString(topicKey)]);
    const shared = await callTool(await connectAgent({ kind: 'dir', directory: sharedFolder }), 'claude_profiles', {});
    assert.equal(shared.isError, false);
    assert.equal(profilesCalls.length, 1, 'an ambiguous folder scope records nothing');
  });

  it('a worker watch (schedule_create with checkCommand and statusWorkerRunDir) is recorded; a plain schedule, a watch with a status COMMAND and a status source that is ignored are not', async () => {
    const client = await connectAgent(topicScope);
    const watch = await callTool(client, 'schedule_create', { name: 'watch builder', cron: '*/5 * * * *', prompt: 'Read the result.', checkCommand: 'kill -0 4242', statusWorkerRunDir: '/runs/builder' });
    assert.equal(watch.isError, false, watch.text);
    assert.deepEqual(workerWatchCalls, [keyToString(topicKey)]);
    const plain = await callTool(client, 'schedule_create', { name: 'daily', cron: '0 9 * * *', prompt: 'Look around.' });
    assert.equal(plain.isError, false, plain.text);
    const commandStatus = await callTool(client, 'schedule_create', { name: 'service watch', cron: '*/5 * * * *', prompt: 'Look.', checkCommand: 'true', statusCommand: 'echo ok' });
    assert.equal(commandStatus.isError, false, commandStatus.text);
    const ignored = await callTool(client, 'schedule_create', { name: 'no check', cron: '0 10 * * *', prompt: 'p', statusWorkerRunDir: '/runs/x' });
    assert.equal(ignored.isError, false, ignored.text);
    assert.deepEqual(workerWatchCalls, [keyToString(topicKey)], 'only the worker watch');
  });

  it('a schedule that was refused arms no watch and records nothing', async () => {
    const client = await connectAgent(topicScope);
    const refused = await callTool(client, 'schedule_create', { name: 'both', cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusWorkerRunDir: '/runs/a', statusCommand: 'echo x' });
    assert.equal(refused.isError, true);
    assert.deepEqual(workerWatchCalls, []);
  });
});
