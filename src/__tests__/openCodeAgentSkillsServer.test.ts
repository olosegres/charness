/**
 * @description `OpenCodeAdapter.activateAgentSkillsForServer` (bot-shipped skills, D5): an `opencode serve` started
 * without the bot's skills folder is replaced through the controlled restart — only when nothing works in it; a
 * busy session, a busy or unreadable directory status, a listener the bot cannot identify, a server that already has
 * the folder, and an operator's own `OPENCODE_CONFIG_DIR` all leave it alone.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeAdapter, type OpenCodeServerRestartOps } from '../adapters/openCodeAdapter';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { getOpenCodeAgentConfigDir, openCodeConfigDirEnvName, type OpenCodeServerLaunchReading } from '../utils/agentPlugin';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';
import { useStubbedOpenCodeServer, type JsonValue } from './openCodeServerStub';

const server = useStubbedOpenCodeServer();
const workDir = '/tmp/opencode-agent-skills-work';
const busyStatus = { ses_1: { type: 'busy' } };

let dataDir = '';
let originalDataDir: string | undefined;
let originalConfigDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-agent-skills-'));
  originalDataDir = process.env.DATA_DIR;
  originalConfigDir = process.env[openCodeConfigDirEnvName];
  process.env.DATA_DIR = dataDir;
  delete process.env[openCodeConfigDirEnvName];
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalConfigDir === undefined) delete process.env[openCodeConfigDirEnvName];
  else process.env[openCodeConfigDirEnvName] = originalConfigDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** @description An adapter with one active session, the given server launch, and a recorder of forced restarts. */
function createAdapter(options: { launch: OpenCodeServerLaunchReading; isSessionBusy?: boolean; status?: JsonValue }): { adapter: OpenCodeAdapter; forcedRestarts: boolean[] } {
  const adapter = new OpenCodeAdapter();
  const key = makeTelegramKey(-100777, 7);
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: 'ses_1', workDir, isBusy: options.isSessionBusy ?? false }));
  const unexpected = async (): Promise<void> => {
    throw new Error('not part of this test');
  };
  const ops: OpenCodeServerRestartOps = {
    checkIsInstalled: () => true,
    installTool: unexpected,
    checkIsServerRunning: async () => true,
    ensureServer: unexpected,
    restartServer: unexpected,
    readServerLaunch: () => options.launch,
  };
  adapter['serverRestartOps'] = ops;
  const forcedRestarts: boolean[] = [];
  adapter['restartServer'] = async (force = false) => {
    forcedRestarts.push(force);
    return true;
  };
  server.answerApiWith(({ method, urlPath }) => {
    if (method === 'GET' && urlPath.startsWith('/session/status?')) return options.status ?? {};
    throw new Error(`unexpected request ${method} ${urlPath}`);
  });
  return { adapter, forcedRestarts };
}

async function runQuietly(adapter: OpenCodeAdapter): Promise<void> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await adapter.activateAgentSkillsForServer();
  } finally {
    console.log = originalLog;
  }
}

describe('activateAgentSkillsForServer', () => {
  it('replaces an idle opencode serve started without the folder (an older bot started it), once, forced', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, [true]);
  });

  it('replaces one started with another folder (DATA_DIR moved)', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: '/elsewhere/opencode-config' } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, [true]);
  });

  it('leaves a server that already has the folder', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir) } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, []);
  });

  it('never touches a listener it cannot identify as opencode serve', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'unknown' } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, []);
  });

  it('waits for the next boot while a session works — by the adapter\'s view or by the directory status, or when the status cannot be read', async () => {
    for (const options of [{ isSessionBusy: true }, { status: busyStatus }, { status: 'not a status map' }]) {
      const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null }, ...options });
      await runQuietly(adapter);
      assert.deepEqual(forcedRestarts, [], JSON.stringify(options));
    }
  });

  it('never replaces a server for an operator who set OPENCODE_CONFIG_DIR', async () => {
    process.env[openCodeConfigDirEnvName] = '/operator/own';
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: '/operator/own-old' } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, []);
  });
});
