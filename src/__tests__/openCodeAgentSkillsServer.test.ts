/**
 * @description `OpenCodeAdapter.activateAgentSkillsForServer` (bot-shipped skills, D5): an `opencode serve` the bot
 * OWNS, started the other way than the INSTANCE value of the «Bot skills» switch says — without its skills folder while
 * the switch is on, with it while the switch is off (a topic's own choice never counts: one server serves every topic) —
 * is replaced through the controlled restart — only when nothing works in it; a
 * busy session, a busy or unreadable directory status, a server the bot does not own or a listener it cannot
 * identify (both said once in the log), a server that already has the folder, a folder that cannot be prepared (its
 * replacement would lack it too: a restart at every boot) and an operator's own `OPENCODE_CONFIG_DIR` all leave it.
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
import { setBotSkillsReader } from '../utils/botSkills';
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
  setBotSkillsReader(() => true);
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
    readServerLaunch: async () => options.launch,
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
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null, isOwnedByBot: true } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, [true]);
  });

  it('replaces one started with another folder (DATA_DIR moved)', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: '/elsewhere/opencode-config', isOwnedByBot: true } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, [true]);
  });

  it('leaves a server that already has the folder', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir), isOwnedByBot: true } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, []);
  });

  it('never touches a server the bot does not own, nor a listener it cannot identify — and says so once per process', async () => {
    for (const launch of [{ kind: 'openCodeServe', configDir: null, isOwnedByBot: false }, { kind: 'unknown' }] as const) {
      const { adapter, forcedRestarts } = createAdapter({ launch });
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (line: string) => lines.push(line);
      try {
        await adapter.activateAgentSkillsForServer();
        await adapter.activateAgentSkillsForServer();
      } finally {
        console.log = originalLog;
      }
      assert.deepEqual(forcedRestarts, [], launch.kind);
      assert.equal(lines.filter((line) => line.includes('it is left as is')).length, 1, `one line: ${JSON.stringify(lines)}`);
    }
  });

  it('says nothing when no server listens at all (a Claude-only instance, OpenCode not started yet) — no line on every boot', async () => {
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'none' } });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await adapter.activateAgentSkillsForServer();
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(forcedRestarts, []);
    assert.deepEqual(lines.filter((line) => line.startsWith('[OpenCode]')), []);
  });

  it('never replaces a server when the folder it would get cannot be prepared — the new one would lack the skills too', async () => {
    fs.mkdirSync(path.join(getOpenCodeAgentConfigDir(dataDir), 'skills'), { recursive: true });
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null, isOwnedByBot: true } });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await runQuietly(adapter);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(forcedRestarts, []);
  });

  it('waits for the next boot while a session works — by the adapter\'s view or by the directory status, or when the status cannot be read', async () => {
    for (const options of [{ isSessionBusy: true }, { status: busyStatus }, { status: 'not a status map' }]) {
      const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null, isOwnedByBot: true }, ...options });
      await runQuietly(adapter);
      assert.deepEqual(forcedRestarts, [], JSON.stringify(options));
    }
  });

  it('never replaces a server for an operator who set OPENCODE_CONFIG_DIR', async () => {
    process.env[openCodeConfigDirEnvName] = '/operator/own';
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: '/operator/own-old', isOwnedByBot: true } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, []);
  });

  describe('with the instance\'s bot skills switched off', () => {
    beforeEach(() => {
      setBotSkillsReader(() => false);
    });

    it('replaces an idle server that still carries the bot\'s folder, once, forced', async () => {
      const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir), isOwnedByBot: true } });
      await runQuietly(adapter);
      assert.deepEqual(forcedRestarts, [true]);
    });

    it('leaves a server that was started without it, and one started with an operator\'s own folder', async () => {
      for (const configDir of [null, '/operator/own']) {
        const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir, isOwnedByBot: true } });
        await runQuietly(adapter);
        assert.deepEqual(forcedRestarts, [], String(configDir));
      }
    });

    it('prepares nothing for it: no folder appears in DATA_DIR', async () => {
      const { adapter } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null, isOwnedByBot: true } });
      await runQuietly(adapter);
      assert.equal(fs.existsSync(getOpenCodeAgentConfigDir(dataDir)), false);
    });

    it('waits for the next boot while a session works, and never touches a server the bot does not own', async () => {
      const busy = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir), isOwnedByBot: true }, isSessionBusy: true });
      await runQuietly(busy.adapter);
      assert.deepEqual(busy.forcedRestarts, []);
      const foreign = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir), isOwnedByBot: false } });
      await runQuietly(foreign.adapter);
      assert.deepEqual(foreign.forcedRestarts, []);
    });

    it('a topic that chose ON for itself keeps nothing: the server follows the instance value only', async () => {
      setBotSkillsReader((key) => key !== null);
      const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: getOpenCodeAgentConfigDir(dataDir), isOwnedByBot: true } });
      await runQuietly(adapter);
      assert.deepEqual(forcedRestarts, [true]);
    });
  });

  it('with the instance ON, a topic that chose OFF for itself does not stop the replacement of a server started without the folder', async () => {
    setBotSkillsReader((key) => key === null);
    const { adapter, forcedRestarts } = createAdapter({ launch: { kind: 'openCodeServe', configDir: null, isOwnedByBot: true } });
    await runQuietly(adapter);
    assert.deepEqual(forcedRestarts, [true]);
  });
});
