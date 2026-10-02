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
 *     config) instead of throwing; a throwing heal never aborts the boot.
 *   - The bound port is persisted for the next boot, unless the env pins it or
 *     it is unchanged; a failed write still serves the bound server.
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
import { StateStore } from '../state';
import { resetSchedulerMcpInjection, schedulerMcpServerName } from '../scheduler/injection';
import {
  createSchedulerMcpServer,
  defaultSchedulerMcpPort,
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
const previouslyBoundPort = 4108;
const newlyBoundPort = 4109;
const unpinnedEnvPort = defaultSchedulerMcpPort;

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

/**
 * A real bot MCP server on an ephemeral port, with inert tool deps. The store is
 * never initialised (no HOME side effects) — listing tools does not touch it.
 */
function createBotMcpHandle(): SchedulerMcpHandle {
  const deps: SchedulerMcpDeps = {
    store: new StateStore(dataDir),
    armJob: () => {},
    disarmJob: () => {},
    getThreadsForDirectory: () => [],
    getThreadAdapterName: () => 'claude',
    sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
    sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0 }),
    compactConversation: () => ({ ok: true, message: 'unused' }),
    answerRequest: async () => ({ ok: false, error: 'unused' }),
    whenSessionsRestored: async () => {},
    getSecret: async () => secret,
    port: defaultSchedulerMcpPort,
  };
  const handle = createSchedulerMcpServer(deps);
  startedHandles.push(handle);
  return handle;
}

/** A handle that "binds" `port` without listening — for the decisions around the bind. */
function createStubHandle(port: number): SchedulerMcpHandle {
  return { start: async () => {}, stop: async () => {}, port };
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
      onSessionsRestored: () => {},
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
      onSessionsRestored: () => { order.push('onSessionsRestored'); },
      healActiveSessions: () => { order.push('healActiveSessions'); },
      rearmSchedules: async () => { order.push('rearmSchedules'); },
    });
    assert.equal(isStarted, true);
    assert.deepEqual(order, [
      'startBotMcp',
      'reattachSessions',
      'restoreAfterReattach',
      'onSessionsRestored',
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
      onSessionsRestored: () => { order.push('onSessionsRestored'); },
      healActiveSessions: () => { order.push('healActiveSessions'); },
      rearmSchedules: async () => { order.push('rearmSchedules'); },
    });
    assert.equal(isStarted, false);
    assert.deepEqual(order, ['startBotMcp', 'reattachSessions', 'restoreAfterReattach', 'onSessionsRestored', 'rearmSchedules']);
  });

  it('a throwing heal does not abort the boot: schedules are still re-armed', async () => {
    const order: string[] = [];
    const isStarted = await runSessionBootPhase({
      startBotMcp: async () => true,
      reattachSessions: async () => {},
      restoreAfterReattach: () => {},
      onSessionsRestored: () => {},
      healActiveSessions: () => { throw new Error('bindings unreadable'); },
      rearmSchedules: async () => { order.push('rearmSchedules'); },
    });
    assert.equal(isStarted, true);
    assert.deepEqual(order, ['rearmSchedules']);
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

  it('does not persist a port that is unchanged since the last boot', async () => {
    const persisted: number[] = [];
    await startSchedulerMcpForBoot(createBootDeps(createStubHandle(previouslyBoundPort), {
      getPersistedPort: () => previouslyBoundPort,
      persistPort: async (port) => { persisted.push(port); },
    }));
    assert.deepEqual(persisted, []);
  });

  it('does not persist a port the env pins', async () => {
    const persisted: number[] = [];
    await startSchedulerMcpForBoot(createBootDeps(createStubHandle(pinnedEnvPort), {
      envPort: pinnedEnvPort,
      persistPort: async (port) => { persisted.push(port); },
    }));
    assert.deepEqual(persisted, []);
  });

  it('a failed port write still serves the bound server with injection configured', async () => {
    const isStarted = await startSchedulerMcpForBoot(createBootDeps(createStubHandle(newlyBoundPort), {
      persistPort: async () => { throw new Error('EACCES'); },
    }));
    assert.equal(isStarted, true);
    const entry = await getSpawnedBotMcpEntry(reattachedKey);
    assert.equal(entry?.url, `http://127.0.0.1:${newlyBoundPort}/mcp`);
  });
});
