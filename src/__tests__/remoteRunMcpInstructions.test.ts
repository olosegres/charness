/**
 * @description The bot MCP's connect-time instructions and `charness remote-run`: ONE bullet that says what remote-run is for (the
 * `runners` view first, `--bg` + `wait` in the background for anything longer than the tool timeout), present while `runners.json`
 * lists a runner — for a Telegram topic AND for a tracker conversation (Jira, or any other platform) — and absent otherwise, so nothing
 * changes for anyone without runners. Proven over the REAL server with the real file: the first runner added shows in the next
 * session's instructions without a restart, and the digest an adopted process is compared by moves with it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keyToString } from '../sessionKey';
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
import { checkIsRemoteRunOffered, getRunnersConfigPath, resetRunnersConfigCache } from '../remoteRun/runnersConfig';

const secret = 'f'.repeat(64);
const offeredWithout: OptionalBotTools = { isJiraAttachmentToolOffered: true, isTodoToolOffered: true, isRemoteRunOffered: false };
const offeredWith: OptionalBotTools = { ...offeredWithout, isRemoteRunOffered: true };
/** Words only the bullet has. */
const bulletMarkers = ['charness remote-run runners', 'charness remote-run --bg', 'charness remote-run wait <id>'];
const telegramTopic = makeTelegramKey(-1001111111111, 51);
const jiraConversation = makeJiraKey('PROJ-34');

let homeDir = '';
let handle: SchedulerMcpHandle;
let clients: Client[];

function writeRunnersFile(content: object): void {
  const filePath = getRunnersConfigPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content));
}

function buildDeps(): SchedulerMcpDeps {
  return {
    store: {} as SchedulerMcpDeps['store'],
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: () => [],
    getThreadAdapterName: () => undefined,
    unpinMessages: async () => {},
    sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    answerRequest: async () => ({ ok: false, error: 'unused' }),
    whenSessionsRestored: async () => {},
    getSecret: async () => secret,
    isRemoteRunOffered: () => checkIsRemoteRunOffered(homeDir),
    port: 0,
  };
}

async function readInstructions(scope: SchedulerScope): Promise<string> {
  const client = new Client({ name: 'remote-run-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${buildSchedulerMcpToken(secret, scope)}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client.getInstructions() ?? '';
}

function countBulletMarkers(instructions: string): number {
  return bulletMarkers.filter((marker) => instructions.includes(marker)).length;
}

describe('the instructions built for a platform', () => {
  it('with a runner listed, Telegram and tracker instructions each carry the bullet once; without one, neither does', () => {
    for (const platform of ['telegram', 'jira', null] as const) {
      const without = buildMcpServerInstructions(platform, offeredWithout, true);
      const withBullet = buildMcpServerInstructions(platform, offeredWith, true);
      assert.equal(countBulletMarkers(without), 0, `${platform ?? 'neutral'} without runners`);
      assert.equal(countBulletMarkers(withBullet), bulletMarkers.length, `${platform ?? 'neutral'} with runners`);
      assert.equal(withBullet.split('charness remote-run runners').length - 1, 1, `${platform ?? 'neutral'}: once`);
    }
  });

  it('the bullet tells what remote-run is for, to look at `runners` first, and to run `wait` in the background for long jobs', () => {
    const bullet = buildMcpServerInstructions('telegram', offeredWith, true).split('\n').find((line) => line.includes('charness remote-run runners')) ?? '';
    assert.match(bullet, /test suite, a build, an e2e run/);
    assert.match(bullet, /`charness remote-run runners` shows which runners are online/);
    assert.match(bullet, /edit files only here/);
    assert.match(bullet, /Longer than your tool timeout: `charness remote-run --bg <command>`.*`charness remote-run wait <id>` in the background/);
  });

  it('nothing else moves: with the bullet taken out, the text is the one without runners', () => {
    for (const platform of ['telegram', 'jira', null] as const) {
      const without = buildMcpServerInstructions(platform, offeredWithout, true).split('\n');
      const withBullet = buildMcpServerInstructions(platform, offeredWith, true).split('\n').filter((line) => !line.includes('charness remote-run runners'));
      assert.deepEqual(withBullet, without, `${platform ?? 'neutral'}`);
    }
  });

  it('the bundled manager skill stays unchanged in phase 1: it does not mention remote-run', () => {
    const skill = fs.readFileSync(path.resolve(__dirname, '..', '..', 'agent-plugin', 'skills', 'charness-manager', 'SKILL.md'), 'utf8');
    assert.ok(!skill.includes('remote-run'));
  });
});

describe('over the real server, with the real runners.json', () => {
  beforeEach(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-mcp-'));
    resetRunnersConfigCache();
    clients = [];
    handle = createSchedulerMcpServer(buildDeps());
    await handle.start();
  });
  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await handle.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const telegramScope: SchedulerScope = { kind: 'thread', threadKey: keyToString(telegramTopic) };
  const jiraScope: SchedulerScope = { kind: 'thread', threadKey: keyToString(jiraConversation) };

  it('no runners.json: neither a Telegram nor a Jira session hears of remote-run', async () => {
    assert.equal(countBulletMarkers(await readInstructions(telegramScope)), 0);
    assert.equal(countBulletMarkers(await readInstructions(jiraScope)), 0);
  });

  it('the first runner added shows in the NEXT connect, for both platforms, with no restart; removing it takes the bullet away again', async () => {
    writeRunnersFile({ runners: [{ name: 'box1', ssh: 'runner@runner.example', workDir: '/home/runner/charness-runner' }] });
    assert.equal(countBulletMarkers(await readInstructions(telegramScope)), bulletMarkers.length);
    assert.equal(countBulletMarkers(await readInstructions(jiraScope)), bulletMarkers.length);
    writeRunnersFile({ runners: [] });
    assert.equal(countBulletMarkers(await readInstructions(telegramScope)), 0);
  });

  it('a runners.json with an error offers nothing the first time (no last good config) — the file is the operator\'s to fix', async () => {
    writeRunnersFile({ runners: [{ name: 'Bad Name', ssh: 'x', workDir: '/w' }] });
    assert.equal(countBulletMarkers(await readInstructions(telegramScope)), 0);
  });

  it('the digest an adopted process is compared by moves with the first runner, so one started without the bullet reads as stale', () => {
    const deps = buildDeps();
    for (const platform of ['telegram', 'jira', null] as const) {
      resetRunnersConfigCache();
      fs.rmSync(getRunnersConfigPath(homeDir), { force: true });
      const before = getBotMcpToolDigest(deps, platform, true);
      writeRunnersFile({ runners: [{ name: 'box1', ssh: 'runner@runner.example', workDir: '/w' }] });
      const after = getBotMcpToolDigest(deps, platform, true);
      assert.notEqual(before, after, `${platform ?? 'neutral'}`);
    }
  });
});
