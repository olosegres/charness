/**
 * @description Coverage for the OpenCode compaction plugin the bot installs: the
 * generated module is imported and its hook run the way OpenCode calls it, the
 * install is idempotent, the `GET /config` detection that decides whether the
 * bot still sends the skills guidance itself, and the boot decision on whether a
 * directory instance may be recreated to load the plugin.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  checkHasOpenCodeCompactPlugin,
  getCompactPluginActivation,
  getOpenCodeCompactPluginContext,
  installOpenCodeCompactPlugin,
  openCodeCompactPluginFileName,
  openCodeCompactPluginId,
  resolveOpenCodeGlobalPluginDir,
} from '../utils/openCodeCompactPlugin';
import { compactionSkillsGuidance } from '../utils/compactOnIdle';

type CompactingHook = (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>;

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-plugin-'));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function silenceWarnings(run: () => void): void {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
}

test('getOpenCodeCompactPluginContext: carries the skills guidance and keeps it inside the summary', () => {
  const context = getOpenCodeCompactPluginContext();
  assert.ok(context.endsWith(compactionSkillsGuidance));
  assert.match(context, /inside the summary, never after a closing section/);
});

test('resolveOpenCodeGlobalPluginDir: follows XDG_CONFIG_HOME like OpenCode', () => {
  assert.equal(resolveOpenCodeGlobalPluginDir({ XDG_CONFIG_HOME: '/x/cfg' }), '/x/cfg/opencode/plugins');
  assert.equal(
    resolveOpenCodeGlobalPluginDir({}),
    path.join(os.homedir(), '.config', 'opencode', 'plugins'),
  );
});

test('installOpenCodeCompactPlugin: the installed plugin pushes the guidance on every compaction', async () => {
  await withTempDir(async (dir) => {
    const pluginDir = path.join(dir, 'opencode', 'plugins');
    assert.equal(installOpenCodeCompactPlugin(pluginDir), 'written');
    assert.deepEqual(fs.readdirSync(pluginDir), [openCodeCompactPluginFileName], 'no temp file is left behind');

    const mod = await import(pathToFileURL(path.join(pluginDir, openCodeCompactPluginFileName)).href);
    assert.equal(mod.default.id, openCodeCompactPluginId);
    assert.deepEqual(Object.keys(mod), ['default'], 'no named export the legacy loader would call as a plugin');
    const hooks = await mod.default.server({}, undefined);
    const output = { context: ['EARLIER'], prompt: undefined };
    await (hooks['experimental.session.compacting'] as CompactingHook)({ sessionID: 'ses_1' }, output);
    assert.deepEqual(output, { context: ['EARLIER', getOpenCodeCompactPluginContext()], prompt: undefined });
  });
});

test('installOpenCodeCompactPlugin: idempotent — an identical file is left alone, a stale one replaced', async () => {
  await withTempDir((dir) => {
    const pluginPath = path.join(dir, openCodeCompactPluginFileName);
    assert.equal(installOpenCodeCompactPlugin(dir), 'written');
    const mtimeMs = fs.statSync(pluginPath).mtimeMs;
    assert.equal(installOpenCodeCompactPlugin(dir), 'unchanged');
    assert.equal(fs.statSync(pluginPath).mtimeMs, mtimeMs, 'not rewritten');

    fs.writeFileSync(pluginPath, '// an older version');
    assert.equal(installOpenCodeCompactPlugin(dir), 'written');
    assert.match(fs.readFileSync(pluginPath, 'utf-8'), /experimental\.session\.compacting/);
  });
});

test('installOpenCodeCompactPlugin: an unwritable folder reports failure instead of throwing', async () => {
  await withTempDir((dir) => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    silenceWarnings(() => {
      assert.equal(installOpenCodeCompactPlugin(path.join(blocker, 'plugins')), 'failed');
    });
  });
});

test('checkHasOpenCodeCompactPlugin: finds the plugin in a GET /config plugin list', () => {
  const url = `file:///home/user/.config/opencode/plugins/${openCodeCompactPluginFileName}`;
  assert.equal(checkHasOpenCodeCompactPlugin(['opencode-pty', url]), true);
  assert.equal(checkHasOpenCodeCompactPlugin([[url, { option: 1 }]]), true, 'a [spec, options] tuple');
  assert.equal(checkHasOpenCodeCompactPlugin(['opencode-pty', 'file:///home/user/src/opencode-claude-bridge']), false);
  assert.equal(checkHasOpenCodeCompactPlugin([`file:///x/not-${openCodeCompactPluginFileName}`]), false);
  assert.equal(checkHasOpenCodeCompactPlugin(undefined), false);
});

test('getCompactPluginActivation: loaded wins, an idle folder is recreated, anything running blocks it', () => {
  const withPlugin = [`file:///home/user/.config/opencode/plugins/${openCodeCompactPluginFileName}`];
  assert.equal(getCompactPluginActivation({ pluginSpecs: withPlugin, sessionStatus: { s: { type: 'busy' } } }), 'loaded');
  assert.equal(getCompactPluginActivation({ pluginSpecs: [], sessionStatus: {} }), 'recreate');
  assert.equal(getCompactPluginActivation({ pluginSpecs: [], sessionStatus: { s: { type: 'idle' } } }), 'recreate');
  assert.equal(getCompactPluginActivation({ pluginSpecs: [], sessionStatus: { s: { type: 'busy' } } }), 'busy');
  assert.equal(
    getCompactPluginActivation({ pluginSpecs: [], sessionStatus: { s: { type: 'retry', attempt: 1 } } }),
    'busy',
  );
  assert.equal(getCompactPluginActivation({ pluginSpecs: [], sessionStatus: null }), 'busy', 'unreadable status');
});
