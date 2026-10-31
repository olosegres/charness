/**
 * @description What the «Bot skills» switch (`/bot_skills`) does to the bot MCP's instructions — the hint to load
 * `charness-manager` — per scope, over the REAL server (HTTP + the SDK client, the way an agent connects): a Telegram
 * topic with the skills off loses the hint but keeps the worker-watch recipe (a tool fact); a tracker conversation, whose
 * bullet is the hint alone, loses the bullet; a `dir:` scope (the OpenCode registration of a folder) counts the folder's
 * OpenCode topics alone — a Claude topic bound to the same folder has its own scope — and keeps the hint while any of
 * them has the skills on. The digest an adopted process is compared by moves with it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keyToString, type SessionKey } from '../sessionKey';
import {
  buildMcpServerInstructions,
  buildSchedulerMcpToken,
  createSchedulerMcpServer,
  getBotMcpToolDigest,
  type OptionalBotTools,
  type SchedulerMcpDeps,
  type SchedulerMcpHandle,
  type SchedulerScope,
} from '../scheduler/mcpSurface';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { setBotSkillsReader } from '../utils/botSkills';
import { workerWatchPinArgument } from '../scheduler/workerWatch';
import { claudeJsonStreamAdapterName, openCodeAdapterName } from '../adapters/adapterNames';

const secret = 'e'.repeat(64);
const skillsOnTopic = makeTelegramKey(-1001111111111, 41);
const skillsOffTopic = makeTelegramKey(-1001111111111, 42);
const sharedFolderTopic = makeTelegramKey(-1001111111111, 43);
const claudeSharedFolderTopic = makeTelegramKey(-1001111111111, 44);
const jiraConversation = makeJiraKey('PROJ-12');
const sharedFolder = '/home/user/projects/shared';
const lonelyFolder = '/home/user/projects/lonely';
const offered: OptionalBotTools = { isJiraAttachmentToolOffered: true, isTodoToolOffered: true, isRemoteRunOffered: false };
/** The sentence the hint is made of; the bullet is gone with it on a tracker. */
const managerSkillHint = '`charness-manager`';
const orchestrationBullet = 'You orchestrate detached workers';
const workerWatchRecipe = 'EACH worker';

let handle: SchedulerMcpHandle;
let clients: Client[];
/** The conversations whose skills are off, and the instance value (key null) the readers fall back to. */
let skillsOffKeys: Set<string>;
let isInstanceValueOn: boolean;
/** The topics bound to each folder, as `getThreadsForDirectory` reports them, and the backend each one last ran on. */
let topicsByFolder: Map<string, SessionKey[]>;
let adapterNameByTopic: Map<string, string>;

function buildDeps(): SchedulerMcpDeps {
  return {
    store: {} as SchedulerMcpDeps['store'],
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: (directory) => (topicsByFolder.get(directory) ?? []).map(keyToString),
    getThreadAdapterName: (threadKey) => adapterNameByTopic.get(threadKey),
    unpinMessages: async () => {},
    sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    answerRequest: async () => ({ ok: false, error: 'unused' }),
    whenSessionsRestored: async () => {},
    getSecret: async () => secret,
    port: 0,
  };
}

beforeEach(async () => {
  skillsOffKeys = new Set([keyToString(skillsOffTopic)]);
  isInstanceValueOn = true;
  topicsByFolder = new Map();
  adapterNameByTopic = new Map();
  clients = [];
  setBotSkillsReader((key) => (key === null ? isInstanceValueOn : !skillsOffKeys.has(keyToString(key))));
  handle = createSchedulerMcpServer(buildDeps());
  await handle.start();
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await handle.stop();
  setBotSkillsReader(() => true);
});

async function readInstructions(scope: SchedulerScope): Promise<string> {
  const client = new Client({ name: 'skills-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${buildSchedulerMcpToken(secret, scope)}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client.getInstructions() ?? '';
}

const threadScope = (key: SessionKey): SchedulerScope => ({ kind: 'thread', threadKey: keyToString(key) });

describe('the instructions built for a platform', () => {
  it('a Telegram session with the skills on is told to load charness-manager and to watch its workers', () => {
    const instructions = buildMcpServerInstructions('telegram', offered, true);
    assert.ok(instructions.includes(managerSkillHint));
    assert.ok(instructions.includes('Watch EACH worker with schedule_create'));
    assert.ok(instructions.includes(`\`${workerWatchPinArgument}\``));
  });

  it('with the skills off the hint goes and the worker-watch recipe stays — in the same bullet', () => {
    const instructions = buildMcpServerInstructions('telegram', offered, false);
    assert.ok(!instructions.includes(managerSkillHint));
    assert.ok(!instructions.includes('charness:charness-manager'));
    const bullet = instructions.split('\n').find((line) => line.includes(orchestrationBullet)) ?? '';
    assert.ok(bullet.includes(workerWatchRecipe), bullet);
    assert.ok(bullet.includes(`\`${workerWatchPinArgument}\``), 'the pin argument of the recipe is kept');
    assert.match(bullet, /never `kill -0` alone/);
    assert.match(bullet, /→ schedule_create to watch EACH worker — /, 'the arrow leads to a tool, like every other bullet');
  });

  it('a tracker conversation (Jira, or any other platform) has no scheduling tools: its bullet is the hint alone, so the bullet goes', () => {
    for (const platform of ['jira', null] as const) {
      const withSkills = buildMcpServerInstructions(platform, offered, true);
      assert.ok(withSkills.includes(orchestrationBullet) && withSkills.includes(managerSkillHint), `${platform ?? 'neutral'}`);
      const withoutSkills = buildMcpServerInstructions(platform, offered, false);
      assert.ok(!withoutSkills.includes(orchestrationBullet), `${platform ?? 'neutral'}`);
      assert.ok(!withoutSkills.includes('charness-manager'), `${platform ?? 'neutral'}`);
      assert.match(withoutSkills, /answer_request/, 'the rest of the instructions is untouched');
      assert.match(withoutSkills, /claude_profiles/);
    }
  });

  it('only the hint differs: everything else is the same text with the skills on and off', () => {
    const withSkills = buildMcpServerInstructions('telegram', offered, true).split('\n');
    const withoutSkills = buildMcpServerInstructions('telegram', offered, false).split('\n');
    assert.deepEqual(withSkills.filter((line) => !line.includes(orchestrationBullet)), withoutSkills.filter((line) => !line.includes(orchestrationBullet)));
  });
});

describe('the digest an adopted process is compared by', () => {
  it('moves with the switch for every platform, so a process started with the hint reads as stale once it is off', () => {
    const deps = buildDeps();
    for (const platform of ['telegram', 'jira', null] as const) {
      assert.notEqual(getBotMcpToolDigest(deps, platform, true), getBotMcpToolDigest(deps, platform, false), `${platform ?? 'neutral'}`);
      assert.equal(getBotMcpToolDigest(deps, platform, false), getBotMcpToolDigest(deps, platform, false), 'stable');
    }
    assert.equal(handle.getToolDigest('telegram', false), getBotMcpToolDigest(deps, 'telegram', false), 'the handle reports the same');
  });
});

describe('the instructions a connecting agent gets, per scope', () => {
  it('a topic with the skills off loses the hint, the topic beside it keeps it', async () => {
    assert.ok(!(await readInstructions(threadScope(skillsOffTopic))).includes(managerSkillHint));
    assert.ok((await readInstructions(threadScope(skillsOnTopic))).includes(managerSkillHint));
  });

  it('the topic\'s recipe survives its hint', async () => {
    assert.ok((await readInstructions(threadScope(skillsOffTopic))).includes(workerWatchRecipe));
  });

  it('a Jira conversation follows the instance value', async () => {
    isInstanceValueOn = false;
    skillsOffKeys.add(keyToString(jiraConversation));
    assert.ok(!(await readInstructions(threadScope(jiraConversation))).includes(orchestrationBullet));
    skillsOffKeys.delete(keyToString(jiraConversation));
    assert.ok((await readInstructions(threadScope(jiraConversation))).includes(orchestrationBullet));
  });

  it('a dir scope keeps the hint while any OpenCode topic of the folder has the skills on, and drops it when every one is off', async () => {
    topicsByFolder.set(sharedFolder, [skillsOffTopic, sharedFolderTopic]);
    for (const topic of topicsByFolder.get(sharedFolder) ?? []) adapterNameByTopic.set(keyToString(topic), openCodeAdapterName);
    assert.ok((await readInstructions({ kind: 'dir', directory: sharedFolder })).includes(managerSkillHint), 'one of the two still wants it');
    skillsOffKeys.add(keyToString(sharedFolderTopic));
    assert.ok(!(await readInstructions({ kind: 'dir', directory: sharedFolder })).includes(managerSkillHint), 'both are off');
  });

  it('a Claude topic bound to the same folder does not hold the OpenCode hint on — its skills have a scope of their own', async () => {
    topicsByFolder.set(sharedFolder, [skillsOffTopic, claudeSharedFolderTopic]);
    adapterNameByTopic.set(keyToString(skillsOffTopic), openCodeAdapterName);
    adapterNameByTopic.set(keyToString(claudeSharedFolderTopic), claudeJsonStreamAdapterName);
    assert.ok(!(await readInstructions({ kind: 'dir', directory: sharedFolder })).includes(managerSkillHint), 'the Claude topic has the skills on, the folder\'s only OpenCode topic does not');
    assert.ok((await readInstructions(threadScope(claudeSharedFolderTopic))).includes(managerSkillHint), 'and the Claude topic still gets its own hint');
  });

  it('a dir scope with no OpenCode topic bound — no topic at all, or only Claude ones — follows the instance value', async () => {
    topicsByFolder.set(lonelyFolder, []);
    topicsByFolder.set(sharedFolder, [skillsOffTopic]);
    adapterNameByTopic.set(keyToString(skillsOffTopic), claudeJsonStreamAdapterName);
    for (const directory of [lonelyFolder, sharedFolder]) {
      isInstanceValueOn = true;
      assert.ok((await readInstructions({ kind: 'dir', directory })).includes(managerSkillHint), directory);
      isInstanceValueOn = false;
      assert.ok(!(await readInstructions({ kind: 'dir', directory })).includes(managerSkillHint), directory);
    }
  });
});
