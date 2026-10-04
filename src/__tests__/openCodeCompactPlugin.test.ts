/**
 * @description Coverage for the OpenCode compaction plugin the bot generates: the
 * generated module is imported and its hook run the way OpenCode calls it, the
 * `OPENCODE_CONFIG_CONTENT` merge keeps the operator's own config, and the
 * `GET /config` detection that decides whether the bot still sends the skills
 * guidance itself.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  buildOpenCodeConfigContentWithPlugin,
  checkHasOpenCodeCompactPlugin,
  getOpenCodeCompactPluginContext,
  openCodeCompactPluginFileName,
  openCodeCompactPluginId,
  prepareOpenCodeCompactPluginEnv,
} from '../utils/openCodeCompactPlugin';
import { compactionSkillsGuidance } from '../utils/compactOnIdle';

type CompactingHook = (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>;

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-plugin-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('getOpenCodeCompactPluginContext: carries the skills guidance and keeps it inside the summary', () => {
  const context = getOpenCodeCompactPluginContext();
  assert.ok(context.endsWith(compactionSkillsGuidance));
  assert.match(context, /inside the summary, never after a closing section/);
});

test('prepareOpenCodeCompactPluginEnv: the generated plugin pushes the guidance on every compaction', async () => {
  await withTempDir(async (dataDir) => {
    const env = prepareOpenCodeCompactPluginEnv(dataDir, {});
    const pluginPath = path.join(dataDir, openCodeCompactPluginFileName);
    assert.deepEqual(env, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(pluginPath).href] }),
    });
    assert.deepEqual(fs.readdirSync(dataDir), [openCodeCompactPluginFileName], 'no temp file is left behind');

    const mod = await import(pathToFileURL(pluginPath).href);
    assert.equal(mod.default.id, openCodeCompactPluginId);
    assert.deepEqual(Object.keys(mod), ['default'], 'no named export the legacy loader would call as a plugin');
    const hooks = await mod.default.server({}, undefined);
    const output = { context: ['EARLIER'], prompt: undefined };
    await (hooks['experimental.session.compacting'] as CompactingHook)({ sessionID: 'ses_1' }, output);
    assert.deepEqual(output, { context: ['EARLIER', getOpenCodeCompactPluginContext()], prompt: undefined });
  });
});

test('buildOpenCodeConfigContentWithPlugin: keeps the existing config and its plugins', () => {
  assert.equal(
    buildOpenCodeConfigContentWithPlugin(
      JSON.stringify({ model: 'a/b', plugin: ['user-plugin'] }),
      'file:///data/p.mjs',
    ),
    JSON.stringify({ model: 'a/b', plugin: ['user-plugin', 'file:///data/p.mjs'] }),
  );
  assert.equal(
    buildOpenCodeConfigContentWithPlugin('  ', 'file:///data/p.mjs'),
    JSON.stringify({ plugin: ['file:///data/p.mjs'] }),
  );
});

test('buildOpenCodeConfigContentWithPlugin: a value it cannot parse is left alone', () => {
  assert.equal(buildOpenCodeConfigContentWithPlugin('{ model: "a/b", }', 'file:///p.mjs'), null);
  assert.equal(buildOpenCodeConfigContentWithPlugin('["x"]', 'file:///p.mjs'), null);
});

test('prepareOpenCodeCompactPluginEnv: an unparseable OPENCODE_CONFIG_CONTENT loads no plugin', async () => {
  await withTempDir((dataDir) => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(prepareOpenCodeCompactPluginEnv(dataDir, { OPENCODE_CONFIG_CONTENT: 'not json' }), {});
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('prepareOpenCodeCompactPluginEnv: an unwritable DATA_DIR yields no env instead of throwing', async () => {
  await withTempDir((dir) => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(prepareOpenCodeCompactPluginEnv(path.join(blocker, 'data'), {}), {});
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('checkHasOpenCodeCompactPlugin: finds the plugin in a GET /config plugin list', () => {
  const url = `file:///home/user/.telegramCode/${openCodeCompactPluginFileName}`;
  assert.equal(checkHasOpenCodeCompactPlugin(['opencode-pty', url]), true);
  assert.equal(checkHasOpenCodeCompactPlugin([[url, { option: 1 }]]), true, 'a [spec, options] tuple');
  assert.equal(checkHasOpenCodeCompactPlugin(['opencode-pty', 'file:///home/user/src/opencode-claude-bridge']), false);
  assert.equal(checkHasOpenCodeCompactPlugin([`file:///x/not-${openCodeCompactPluginFileName}`]), false);
  assert.equal(checkHasOpenCodeCompactPlugin(undefined), false);
});
