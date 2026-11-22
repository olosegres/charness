/**
 * @description The `schedule_*` tools of a Jira issue's conversation over the REAL bot MCP server (HTTP + the SDK client, the
 * way an agent calls them): the Jira shape (no `threadKey`, no `isPinSilent`), the wording that says nothing of a topic, a
 * Telegram pin or a status line, the request a job is armed under (`requestId`) in a tracker conversation and in a Telegram
 * topic, and what stays out: the `test` platform and a key no codec reads keep the neutral set. The Telegram wording and shape
 * are pinned beside them so a Jira edit cannot move them.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import { RequestLedger, requestHistoryMaxBytes } from '../requests/requestLedger';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import {
  buildSchedulerMcpToken,
  checkIsSchedulingPlatform,
  createSchedulerMcpServer,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { pickRequestToArmUnder } from '../requests/scheduleWait';
import { workerWatchCheckCommand, workerWatchCheckCron, workerWatchStatusArguments } from '../scheduler/workerWatch';

const secret = 'd'.repeat(64);
const topicKey = makeTelegramKey(-1001234567890, 42);
const issueKey = makeJiraKey('PROJ-12');
const otherIssueKey = makeJiraKey('PROJ-13');
const handOver = (issue: string) => ({ kind: 'trackerEvent' as const, attributes: { issueKey: issue, triggerId: '100', requester: 'ann' } });

let fakeHome: string;
let originalHome: string | undefined;
let handle: SchedulerMcpHandle;
let store: StateStore;
let ledger: RequestLedger;
let clients: Client[];
/** Whether the port that tells `schedule_create` which request is open is wired (an older wiring has none). */
let isRequestPortWired: boolean;
/** The requests whose turns the engine is watching (`getWatchedRequestIdsOf`): the ones the agent is working on. */
let watchedRequestIds: string[];
/** The conversations of every worker watch noted (`noteLimitWorkerWatch`). */
let workerWatchNotes: string[];
let armedJobIds: string[];
let disarmedJobIds: string[];

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-jira-schedule-mcp-'));
  process.env.HOME = fakeHome;
  const dataDir = path.join(fakeHome, 'data');
  store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  ledger = new RequestLedger({ store, history: new RotatingJsonlFile(path.join(dataDir, 'requests.jsonl'), requestHistoryMaxBytes) });
  await ledger.load();
  clients = [];
  isRequestPortWired = true;
  watchedRequestIds = [];
  workerWatchNotes = [];
  armedJobIds = [];
  disarmedJobIds = [];
  handle = createSchedulerMcpServer({
    store,
    armJob: (record) => { armedJobIds.push(record.id); },
    disarmJob: (jobId) => { disarmedJobIds.push(jobId); },
    getThreadsForDirectory: () => [],
    getThreadAdapterName: () => 'claude',
    unpinMessages: async () => [],
    deleteMessage: async () => {},
    sendFilesToThread: async () => ({ ok: true, summary: 'unused', sentKinds: [] }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    answerRequest: async () => ({ ok: false, error: 'unused' }),
    noteLimitWorkerWatch: (threadKey) => { workerWatchNotes.push(threadKey); },
    // The real pick the bot wires over the real ledger: the request the agent works on, from the engine's watched turns.
    get getArmingRequestId() {
      return isRequestPortWired
        ? (threadKey: string) => pickRequestToArmUnder(ledger.listOpenRequestsOf(keyFromSerialized(threadKey)), watchedRequestIds)
        : undefined;
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
  await store.flush();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The conversation key of a serialized `threadKey`, from the two keys this file uses. */
function keyFromSerialized(threadKey: string): SessionKey {
  const known = [topicKey, issueKey, otherIssueKey].find((key) => keyToString(key) === threadKey);
  if (!known) throw new Error(`unexpected thread key ${threadKey}`);
  return known;
}

async function connectAgent(key: SessionKey | string): Promise<Client> {
  const scope: SchedulerScope = { kind: 'thread', threadKey: typeof key === 'string' ? key : keyToString(key) };
  const client = new Client({ name: 'schedule-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${buildSchedulerMcpToken(secret, scope)}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

function getFirstText(result: unknown): string {
  const block = CallToolResultSchema.parse(result).content.find((content) => content.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args }).catch((error: Error) => ({ content: [{ type: 'text', text: error.message }], isError: true }));
  return { isError: CallToolResultSchema.parse(result).isError === true, text: getFirstText(result) };
}

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} is listed`);
  return tool;
}

/** A tool's own text and every argument's description — everything an agent reads of it. */
function getAllToolTexts(tool: Tool): string[] {
  const propertyTexts = Object.values(tool.inputSchema.properties ?? {}).map((property) => (typeof property === 'object' && property !== null && 'description' in property ? String(property.description) : ''));
  return [tool.title ?? '', tool.description ?? '', ...propertyTexts];
}

const scheduleToolNames = ['schedule_create', 'schedule_list', 'schedule_cancel'];

describe('the schedule tools of a Jira issue: their shape and their words', () => {
  it('schedule_create, schedule_list and schedule_cancel are listed — without `threadKey` (the token names the issue) and without `isPinSilent` (nothing is pinned)', async () => {
    const tools = (await (await connectAgent(issueKey)).listTools()).tools;
    assert.deepEqual(Object.keys(findTool(tools, 'schedule_create').inputSchema.properties ?? {}), [
      'name', 'cron', 'onceAt', 'repeatCount', 'prompt', 'checkCommand', 'checkTimeoutSeconds', 'statusWorkerRunDir', 'statusCommand', 'statusEveryMinutes',
    ]);
    assert.deepEqual(Object.keys(findTool(tools, 'schedule_list').inputSchema.properties ?? {}), []);
    assert.deepEqual(Object.keys(findTool(tools, 'schedule_cancel').inputSchema.properties ?? {}), ['id']);
  });

  it('a call that names `threadKey` or `isPinSilent` is refused with the allowed keys — a Jira session cannot name another conversation', async () => {
    const client = await connectAgent(issueKey);
    const named = await callTool(client, 'schedule_create', { name: 'x', cron: '0 9 * * *', prompt: 'p', threadKey: keyToString(otherIssueKey) });
    assert.equal(named.isError, true);
    assert.match(named.text, /unknown key `threadKey`/);
    const pinned = await callTool(client, 'schedule_create', { name: 'x', cron: '0 9 * * *', prompt: 'p', isPinSilent: true });
    assert.equal(pinned.isError, true);
    assert.match(pinned.text, /unknown key `isPinSilent`/);
    assert.deepEqual(Object.keys(store.getSchedules()), [], 'nothing was created');
  });

  it('nothing an agent reads of the three tools — description, every argument — speaks of a topic, Telegram, a pin or a posted status line; the issue\'s conversation is named', async () => {
    const tools = (await (await connectAgent(issueKey)).listTools()).tools;
    for (const name of scheduleToolNames) {
      for (const text of getAllToolTexts(findTool(tools, name))) {
        assert.doesNotMatch(text, /Telegram|topic|\bpin|isPinSilent/i, `${name}: ${text.slice(0, 80)}`);
      }
    }
    assert.match(findTool(tools, 'schedule_create').description ?? '', /this issue's conversation/);
    assert.match(findTool(tools, 'schedule_create').description ?? '', /posts NOTHING on the issue/);
    assert.match(findTool(tools, 'schedule_list').description ?? '', /this issue's conversation/);
    assert.match(findTool(tools, 'schedule_cancel').description ?? '', /this issue's conversation/);
  });

  it('the status arguments stay accepted — one recipe for both platforms — and say that no line is posted on a tracker issue', async () => {
    const tools = (await (await connectAgent(issueKey)).listTools()).tools;
    const properties = findTool(tools, 'schedule_create').inputSchema.properties ?? {};
    for (const name of ['statusWorkerRunDir', 'statusCommand', 'statusEveryMinutes']) {
      const property = properties[name];
      assert.ok(property && typeof property === 'object' && 'description' in property, name);
      assert.match(String(property.description), /no status line is ever posted on a tracker issue/, name);
    }
  });

  it('the description carries the worker-watch recipe and the end-the-turn advice; its checkCommand text speaks of the issue\'s folder', async () => {
    const tools = (await (await connectAgent(issueKey)).listTools()).tools;
    const create = findTool(tools, 'schedule_create');
    const description = create.description ?? '';
    assert.ok(description.includes(`checkCommand \`${workerWatchCheckCommand}\``), 'the same recipe as Telegram\'s');
    assert.ok(description.includes(`cron \`${workerWatchCheckCron}\``));
    assert.ok(description.includes(`\`${workerWatchStatusArguments}\``));
    assert.match(description, /Never `kill -0` alone/);
    assert.match(description, /answer_request "progress" and END your turn/);
    assert.match(description, /2 h 30 min without a report/);
    assert.match(description, /A watchdog meant to OUTLIVE the work \(a health check, a daily job\) is armed, and then the request is answered `final`: the job keeps running and its fires say «no request is open»\./);
    assert.match(description, /task-agent slot held for as long as the job lives/);
    const checkCommand = (create.inputSchema.properties ?? {}).checkCommand;
    assert.match(String(checkCommand && typeof checkCommand === 'object' && 'description' in checkCommand ? checkCommand.description : ''), /it runs in the issue's folder, so a relative path or `~` points elsewhere/);
  });

  it('a Telegram topic keeps its wording and shape: its own threadKey and isPinSilent, «this topic», the status line it posts', async () => {
    const tools = (await (await connectAgent(topicKey)).listTools()).tools;
    const create = findTool(tools, 'schedule_create');
    assert.deepEqual(Object.keys(create.inputSchema.properties ?? {}).slice(-3), ['statusEveryMinutes', 'isPinSilent', 'threadKey']);
    assert.match(create.description ?? '', /^Schedule a prompt to be delivered to this topic later\./);
    assert.match(create.description ?? '', /the BOT post a silent status line into the topic every 15 min/);
    assert.deepEqual(Object.keys(findTool(tools, 'schedule_list').inputSchema.properties ?? {}), ['threadKey']);
    assert.equal(findTool(tools, 'schedule_list').description, 'List the scheduled prompts for this topic (id, name, schedule, next run, paused flag).');
    assert.deepEqual(Object.keys(findTool(tools, 'schedule_cancel').inputSchema.properties ?? {}), ['id', 'threadKey']);
    assert.match(findTool(tools, 'schedule_cancel').description ?? '', /Only schedules owned by this topic can be cancelled\./);
  });

  it('only a Telegram topic and a Jira issue are scheduling platforms: the test platform and an unknown key keep the neutral set', () => {
    assert.equal(checkIsSchedulingPlatform('telegram'), true);
    assert.equal(checkIsSchedulingPlatform('jira'), true);
    assert.equal(checkIsSchedulingPlatform('test'), false);
    assert.equal(checkIsSchedulingPlatform(null), false);
  });
});

describe('what the Jira schedule tools do', () => {
  it('create, list and cancel work on the session\'s own issue, and say «issue», never «topic»', async () => {
    const client = await connectAgent(issueKey);
    assert.equal((await callTool(client, 'schedule_list', {})).text, 'No schedules for this issue.');
    const created = await callTool(client, 'schedule_create', { name: 'Nightly check', cron: '0 2 * * *', prompt: 'Look at the nightly build.' });
    assert.equal(created.isError, false, created.text);
    const [record] = Object.values(store.getSchedules());
    assert.equal(record.threadKey, keyToString(issueKey), 'stored under the issue\'s key');
    assert.deepEqual(armedJobIds, [record.id]);
    assert.match((await callTool(client, 'schedule_list', {})).text, /Nightly check/);
    const cancelled = await callTool(client, 'schedule_cancel', { id: record.id });
    assert.equal(cancelled.text, `Cancelled "Nightly check" (id: ${record.id}).`);
    assert.deepEqual(disarmedJobIds, [record.id]);
  });

  it('a job of another conversation cannot be cancelled and reads as unknown — in the words of an issue', async () => {
    const other = await connectAgent(otherIssueKey);
    await callTool(other, 'schedule_create', { name: 'Theirs', cron: '0 2 * * *', prompt: 'p' });
    const [theirs] = Object.values(store.getSchedules());
    const refused = await callTool(await connectAgent(issueKey), 'schedule_cancel', { id: theirs.id });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, `no schedule with id "${theirs.id}" in this issue`);
    assert.deepEqual(disarmedJobIds, [], 'the job stays armed');
  });

  it('a worker watch is accepted with its status arguments, marks the conversation as orchestrating, and is a check job under the issue\'s key', async () => {
    const client = await connectAgent(issueKey);
    const created = await callTool(client, 'schedule_create', {
      name: 'watch worker',
      cron: workerWatchCheckCron,
      prompt: 'The worker is done: look at its result.',
      checkCommand: 'kill -0 1',
      statusWorkerRunDir: '/work/run',
      statusEveryMinutes: 15,
    });
    assert.equal(created.isError, false, created.text);
    const [record] = Object.values(store.getSchedules());
    assert.equal(record.deliveryKind, 'check');
    assert.equal(record.statusWorkerRunDir, '/work/run', 'still recorded: it marks the job as a worker watch');
    assert.deepEqual(workerWatchNotes, [keyToString(issueKey)]);
  });
});

describe('the request a job is armed under (requestId)', () => {
  it('a Jira job records the newest open request of its issue when none is being worked on', async () => {
    await ledger.createRequest(issueKey, handOver('PROJ-12'));
    const open = await ledger.createRequest(issueKey, { ...handOver('PROJ-12'), attributes: { ...handOver('PROJ-12').attributes, requester: 'bob' } });
    await callTool(await connectAgent(issueKey), 'schedule_create', { name: 'Armed', cron: '0 9 * * *', prompt: 'p' });
    const [record] = Object.values(store.getSchedules());
    assert.equal(record.requestId, open.id, 'the newest of the two requesters\' open requests');
  });

  it('a Jira job is armed under the request the agent is working on — a newer mention request of another person never takes it', async () => {
    const handedOver = await ledger.createRequest(issueKey, handOver('PROJ-12'));
    const mention = await ledger.createRequest(issueKey, { kind: 'trackerMention', attributes: { issueKey: 'PROJ-12', triggerId: 'mention:1', requester: 'bob' } });
    assert.ok(mention.createdAt >= handedOver.createdAt, 'the mention is the newer request');
    watchedRequestIds = [handedOver.id];
    await callTool(await connectAgent(issueKey), 'schedule_create', { name: 'Armed', cron: '0 9 * * *', prompt: 'p' });
    const [record] = Object.values(store.getSchedules());
    assert.equal(record.requestId, handedOver.id, 'the hand-over the agent works on, not the newest request');
  });

  it('another issue\'s open request is never recorded', async () => {
    await ledger.createRequest(otherIssueKey, handOver('PROJ-13'));
    await callTool(await connectAgent(issueKey), 'schedule_create', { name: 'Armed', cron: '0 9 * * *', prompt: 'p' });
    const [record] = Object.values(store.getSchedules());
    assert.equal('requestId' in record, false);
  });

  it('with no request open — or no port wired — the job carries none', async () => {
    const client = await connectAgent(issueKey);
    await callTool(client, 'schedule_create', { name: 'No request', cron: '0 9 * * *', prompt: 'p' });
    await ledger.createRequest(issueKey, handOver('PROJ-12'));
    isRequestPortWired = false;
    await callTool(client, 'schedule_create', { name: 'No port', cron: '0 10 * * *', prompt: 'p' });
    for (const record of Object.values(store.getSchedules())) assert.equal('requestId' in record, false, record.name);
  });

  it('a Telegram topic with an open request (a view that has requests) records it too — the platform-neutral wake-up rule reads it; one with none does not', async () => {
    const client = await connectAgent(topicKey);
    await callTool(client, 'schedule_create', { name: 'Stream view', cron: '0 9 * * *', prompt: 'p' });
    const request = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    await callTool(client, 'schedule_create', { name: 'Answers view', cron: '0 10 * * *', prompt: 'p' });
    const records = Object.values(store.getSchedules());
    assert.equal('requestId' in records.find((record) => record.name === 'Stream view')!, false);
    assert.equal(records.find((record) => record.name === 'Answers view')?.requestId, request.id);
  });

  it('a Telegram agent that re-arms in the turn of a scheduler fire arms under the OPERATOR\'s request, not under the request the fire opened', async () => {
    const operatorRequest = await ledger.createRequest(topicKey, { kind: 'message', attributes: { requester: '424242' } });
    const fireRequest = await ledger.createRequest(topicKey, { kind: 'scheduledRun', attributes: { requester: 'scheduler' } });
    assert.ok(fireRequest.createdAt >= operatorRequest.createdAt, 'the fire\'s request is the newest, and its turn is the one being watched');
    watchedRequestIds = [fireRequest.id];
    await callTool(await connectAgent(topicKey), 'schedule_create', { name: 'Next worker', cron: '0 9 * * *', prompt: 'p' });
    const [record] = Object.values(store.getSchedules());
    assert.equal(record.requestId, operatorRequest.id);
  });
});
