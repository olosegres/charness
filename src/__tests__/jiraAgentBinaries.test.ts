/**
 * @description Tools on the Jira agents' PATH (prompt context C11): `agentBinaries`
 * links a name to a program inside `DATA_DIR/agent-bin`, rebuilt at every boot,
 * and that folder comes FIRST on the PATH of a tracker conversation's agent —
 * never on a Telegram topic's, whose wrapper keeps the tmux environment.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentBinDirName, linkAgentBinaries } from '../connectors/jira/agentBinaries';
import { getClaudePlatformEnvironment } from '../adapters/claudePlatformFlags';
import { addAgentBinDirToPath, agentEnvironmentNames, registerAgentBinDir } from '../utils/agentEnvironment';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

describe('linkAgentBinaries (C11)', () => {
  let dataDir = '';
  let toolsDir = '';

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-agent-bin-'));
    dataDir = path.join(root, 'data');
    toolsDir = path.join(root, 'tools');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(toolsDir);
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  });

  const createTool = (name: string): string => {
    const toolPath = path.join(toolsDir, name);
    fs.writeFileSync(toolPath, `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
    return toolPath;
  };

  it('links each tool by its name into DATA_DIR/agent-bin and returns the folder', () => {
    const ffmpeg = createTool('ffmpeg-real');
    const dir = linkAgentBinaries(dataDir, new Map([['ffmpeg', ffmpeg]]));
    assert.equal(dir, path.join(dataDir, agentBinDirName));
    assert.equal(fs.readlinkSync(path.join(dir ?? '', 'ffmpeg')), ffmpeg);
    assert.equal(fs.statSync(dir ?? '').mode & 0o777, 0o700);
  });

  it('a boot rebuilds the folder: a link that points elsewhere now is repointed, one whose name left the config is removed', () => {
    const first = createTool('first');
    const second = createTool('second');
    linkAgentBinaries(dataDir, new Map([['tool-a', first], ['tool-b', first]]));
    const dir = linkAgentBinaries(dataDir, new Map([['tool-a', second]])) ?? '';
    assert.deepEqual(fs.readdirSync(dir), ['tool-a']);
    assert.equal(fs.readlinkSync(path.join(dir, 'tool-a')), second);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });

  it('a folder of an earlier boot is cleared when the config names no tool, and no folder is put on any PATH', () => {
    linkAgentBinaries(dataDir, new Map([['tool-a', createTool('first')]]));
    assert.equal(linkAgentBinaries(dataDir, new Map()), null);
    assert.equal(fs.existsSync(path.join(dataDir, agentBinDirName)), false);
  });

  it('the linked tool runs by its name from the folder', () => {
    const dir = linkAgentBinaries(dataDir, new Map([['e2e-tool', createTool('real-e2e-tool')]])) ?? '';
    assert.ok(fs.accessSync(path.join(dir, 'e2e-tool'), fs.constants.X_OK) === undefined);
  });
});

describe('the PATH of a tracker conversation\'s agent (C11)', () => {
  afterEach(() => registerAgentBinDir(null));

  it('starts with the registered folder, ahead of the allowlisted PATH', () => {
    registerAgentBinDir('/data/agent-bin');
    assert.equal(addAgentBinDirToPath({ HOME: '/home/x', PATH: '/usr/bin:/bin' }).PATH, '/data/agent-bin:/usr/bin:/bin');
    assert.equal(addAgentBinDirToPath({ HOME: '/home/x' }).PATH, '/data/agent-bin:/usr/local/bin:/usr/bin:/bin', 'a shell\'s default search path follows when there is none');
  });

  it('nothing registered, nothing changed', () => {
    const environment = { HOME: '/home/x', PATH: '/usr/bin' };
    assert.equal(addAgentBinDirToPath(environment), environment);
  });

  it('a Jira conversation\'s agent environment carries it; a Telegram topic\'s wrapper keeps the tmux environment (null)', () => {
    registerAgentBinDir('/data/agent-bin');
    const jira = getClaudePlatformEnvironment(makeJiraKey('PROJ-1'));
    assert.ok(jira?.PATH?.startsWith('/data/agent-bin:'), jira?.PATH);
    assert.equal(getClaudePlatformEnvironment(makeTelegramKey(-1001234567890, 42)), null);
  });

  it('it adds no variable: the agent still holds only the allowlisted names', () => {
    registerAgentBinDir('/data/agent-bin');
    const names = Object.keys(getClaudePlatformEnvironment(makeJiraKey('PROJ-1')) ?? {});
    const allowedNames: readonly string[] = agentEnvironmentNames;
    assert.deepEqual(names.filter((name) => !allowedNames.includes(name)), []);
  });
});
