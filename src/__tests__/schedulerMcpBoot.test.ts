/**
 * @description Boot-order contract of the bot MCP server (`scheduler/mcpBoot.ts`).
 *
 *   - A session (re)spawned in the boot window — while sessions are re-attached —
 *     is born WITH the bot's `telegramBot` server: the `--mcp-config` the Claude
 *     backends build at spawn (`prepareMcpFlags`) names the bound port, and an MCP
 *     client using exactly that entry reaches the live server and lists its tools.
 *   - The heals run only after reattach and only when the server is up; the
 *     schedule re-arm runs after reattach either way.
 *   - A bind failure boots on with injection inert (no bot server in the spawn
 *     config) instead of throwing.
 *   - The bound port is persisted for the next boot, unless the env pins it.
 *
 * Load-bearing: the first test fails if the server start is moved after the
 * reattach step (the spawn config then has no bot server).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SessionKey } from '../sessionKey';
import { prepareMcpFlags } from '../mcpConfig';
import { resetSchedulerMcpInjection, schedulerMcpServerName } from '../scheduler/injection';
import {
  createSchedulerMcpServer,
  type SchedulerMcpDeps,
  type SchedulerMcpHandle,
} from '../scheduler/mcpSurface';
import {
  runSessionBootPhase,
  startSchedulerMcpForBoot,
  type SchedulerMcpBootDeps,
} from '../scheduler/mcpBoot';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const secret = 'b'.repeat(64);
const reattachedKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const pinnedEnvPort = 4107;
const unpinnedEnvPort = 0;

interface SpawnedMcpEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

let dataDir: string;
let startedHandles: SchedulerMcpHandle[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-mcpboot-'));
  startedHandles = [];
});

afterEach(async () => {
  resetSchedulerMcpInjection();
  for (const handle of startedHandles) await handle.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A real bot MCP server (ephemeral port unless one is requested), with inert tool deps. */
function createBotMcpHandle(port = 0): SchedulerMcpHandle {
  const deps: SchedulerMcpDeps = {
    store: {} as SchedulerMcpDeps['store'],
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: () => [],
    getThreadAdapterName: () => 'claude',
    sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused' }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    getSecret: async () => secret,
    port,
  };
  const handle = createSchedulerMcpServer(deps);
  startedHandles.push(handle);
  return handle;
}

function createBootDeps(handle: SchedulerMcpHandle, overrides: Partial<SchedulerMcpBootDeps> = {}): SchedulerMcpBootDeps {
  return {
    handle,
    envPort: unpinnedEnvPort,
    getPersistedPort: () => undefined,
    persistPort: async () => {},
    getSecret: async () => secret,
    ...overrides,
  };
}

/** The bot's entry in the `--mcp-config` files a session spawned now would get, or `null`. */
async function getSpawnedBotMcpEntry(key: SessionKey): Promise<SpawnedMcpEntry | null> {
  const flags = await prepareMcpFlags({ key, dataDir });
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== '--mcp-config') continue;
    const config = JSON.parse(fs.readFileSync(flags[i + 1], 'utf8')) as {
      mcpServers: Record<string, SpawnedMcpEntry>;
    };
    const entry = config.mcpServers[schedulerMcpServerName];
    if (entry) return entry;
  }
  return null;
}

describe('runSessionBootPhase', () => {
  it('a session spawned during reattach carries a working bot MCP server', async () => {
    const handle = createBotMcpHandle();
    let spawnedEntry: SpawnedMcpEntry | null = null;

    await runSessionBootPhase({
      startBotMcp: () => startSchedulerMcpForBoot(createBootDeps(handle)),
      reattachSessions: async () => {
        spawnedEntry = await getSpawnedBotMcpEntry(reattachedKey);
      },
      restoreAfterReattach: () => {},
      healActiveSessions: () => {},
      rearmSchedules: async () => {},
    });

    assert.ok(spawnedEntry, 'the re-attached session was spawned without the bot MCP server');
    const entry: SpawnedMcpEntry = spawnedEntry;
    assert.equal(entry.url, `http://127.0.0.1:${handle.port}/mcp`);

    // Connect exactly as the agent would, with the spawned entry's url + headers.
    const client = new Client({ name: 'boot-window-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }),
    );
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === 'schedule_create'), 'the bot tools are reachable');
    } finally {
      await client.close();
    }
  });

  it('heals after reattach when the server is up, and re-arms schedules last', async () => {
    const order: string[] = [];
    const isStarted = await runSessionBootPhase({
      startBotMcp: async () => { order.push('startBotMcp'); return true; },
      reattachSessions: async () => { order.push('reattachSessions'); },
      restoreAfterReattach: () => { order.push('restoreAfterReattach'); },
      healActiveSessions: () => { order.push('healActiveSessions'); },
      rearmSchedules: async () => { order.push('rearmSchedules'); },
    });
    assert.equal(isStarted, true);
    assert.deepEqual(order, [
      'startBotMcp',
      'reattachSessions',
      'restoreAfterReattach',
      'healActiveSessions',
      'rearmSchedules',
    ]);
  });

  it('skips the heals but still re-attaches and re-arms when the server did not start', async () => {
    const order: string[] = [];
    const isStarted = await runSessionBootPhase({
      startBotMcp: async () => { order.push('startBotMcp'); return false; },
      reattachSessions: async () => { order.push('reattachSessions'); },
      restoreAfterReattach: () => { order.push('restoreAfterReattach'); },
      healActiveSessions: () => { order.push('healActiveSessions'); },
      rearmSchedules: async () => { order.push('rearmSchedules'); },
    });
    assert.equal(isStarted, false);
    assert.deepEqual(order, ['startBotMcp', 'reattachSessions', 'restoreAfterReattach', 'rearmSchedules']);
  });
});

describe('startSchedulerMcpForBoot', () => {
  it('a bind failure resolves false and leaves injection inert', async () => {
    const failingHandle: SchedulerMcpHandle = {
      start: async () => { throw new Error('EADDRINUSE'); },
      stop: async () => {},
      port: 0,
    };
    const isStarted = await startSchedulerMcpForBoot(createBootDeps(failingHandle));
    assert.equal(isStarted, false);
    assert.equal(await getSpawnedBotMcpEntry(reattachedKey), null);
  });

  it('persists a newly bound port when the env does not pin one', async () => {
    const handle = createBotMcpHandle();
    const persisted: number[] = [];
    await startSchedulerMcpForBoot(createBootDeps(handle, { persistPort: async (port) => { persisted.push(port); } }));
    assert.deepEqual(persisted, [handle.port]);
  });

  it('does not persist when the port is unchanged or pinned by the env', async () => {
    const reusedHandle = createBotMcpHandle();
    await reusedHandle.start();
    const reusedPort = reusedHandle.port;
    await reusedHandle.stop();
    const persisted: number[] = [];
    const recordPort = async (port: number): Promise<void> => { persisted.push(port); };

    const sameHandle = createBotMcpHandle(reusedPort);
    await startSchedulerMcpForBoot(createBootDeps(sameHandle, { getPersistedPort: () => reusedPort, persistPort: recordPort }));
    assert.equal(sameHandle.port, reusedPort, 'the persisted port was reused');

    const pinnedHandle = createBotMcpHandle();
    await startSchedulerMcpForBoot(createBootDeps(pinnedHandle, { envPort: pinnedEnvPort, persistPort: recordPort }));

    assert.deepEqual(persisted, []);
  });
});
