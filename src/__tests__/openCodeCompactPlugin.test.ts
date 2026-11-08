/**
 * @description Coverage for the OpenCode compaction plugin the bot installs: the
 * generated module is imported and its hook run the way OpenCode calls it, the
 * install is idempotent, the `GET /config` detection that decides whether the
 * bot still sends the resume guidance itself (only an instance that loaded the
 * CURRENT text counts — the file name carries a hash of it), and the boot decision
 * on whether a directory instance may be recreated to load the plugin.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  buildOpenCodeCompactPluginSource,
  checkHasOpenCodeCompactPlugin,
  getCompactPluginActivation,
  getOpenCodeCompactPluginContext,
  getOpenCodeCompactPluginFileName,
  installOpenCodeCompactPlugin,
  legacyOpenCodeCompactPluginFileName,
  legacyOpenCodeCompactPluginId,
  openCodeCompactPluginFileName,
  openCodeCompactPluginId,
  resolveOpenCodeGlobalPluginDir,
} from '../utils/openCodeCompactPlugin';
import { resetLegacyNameState } from '../legacyNames';
import { compactionChecklistGuidance, compactionGapsGuidance, compactionResumeGuidance } from '../utils/compactOnIdle';

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

test('getOpenCodeCompactPluginContext: carries the resume guidance (skills + the checklist that ends the summary) and keeps it inside the summary', () => {
  const context = getOpenCodeCompactPluginContext();
  assert.ok(context.endsWith(compactionResumeGuidance));
  assert.ok(context.endsWith(compactionChecklistGuidance));
  assert.match(context, /inside the summary, never after a closing section/);
});

test('getOpenCodeCompactPluginContext: the OpenCode server\'s own overflow compaction is asked for the agent-mistakes section too, ahead of the checklist', () => {
  const context = getOpenCodeCompactPluginContext();
  assert.ok(context.includes(compactionGapsGuidance));
  assert.ok(context.indexOf(compactionGapsGuidance) < context.indexOf(compactionChecklistGuidance));
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
    assert.ok(output.context[1].endsWith(compactionChecklistGuidance), 'the installed plugin asks for the checklist that ends the summary');
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

test('installOpenCodeCompactPlugin: the older copies of the bot\'s plugin go, so a new instance loads one; files that are not the bot\'s stay', async () => {
  await withTempDir((dir) => {
    const ownSource = (id: string): string => `export default { id: ${JSON.stringify(id)}, server: async () => ({}) };\n`;
    const unhashedPath = path.join(dir, 'charness-compaction.js');
    const otherHashPath = path.join(dir, 'charness-compaction-00000000.js');
    const usersPath = path.join(dir, 'charness-compaction-11111111.js');
    const unrelatedPath = path.join(dir, 'charness-compaction-notes.js');
    fs.writeFileSync(unhashedPath, ownSource(openCodeCompactPluginId));
    fs.writeFileSync(otherHashPath, ownSource(openCodeCompactPluginId));
    fs.writeFileSync(usersPath, '// the user\'s own plugin that happens to fit the name\n');
    fs.writeFileSync(unrelatedPath, ownSource(openCodeCompactPluginId));

    assert.equal(installOpenCodeCompactPlugin(dir), 'written');

    assert.deepEqual(fs.readdirSync(dir).sort(), [openCodeCompactPluginFileName, 'charness-compaction-11111111.js', 'charness-compaction-notes.js'].sort());

    // An older copy that turns up later (a second bot of an older release) goes on the next install, whether or not the current file is there.
    fs.writeFileSync(otherHashPath, ownSource(openCodeCompactPluginId));
    assert.equal(installOpenCodeCompactPlugin(dir), 'unchanged');
    assert.equal(fs.existsSync(otherHashPath), false);
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

/** The plugin folder URL `GET /config` reports a loaded plugin under. */
const pluginUrlBase = 'file:///home/user/.config/opencode/plugins';
/** What an instance that loaded an OLDER text reports: the first release's unhashed name, another content hash. */
const outdatedPluginUrls = [
  `${pluginUrlBase}/charness-compaction.js`,
  `${pluginUrlBase}/charness-compaction-00000000.js`,
];

test('the plugin file name carries a hash of its content: the same text, the same name; another text, another name', () => {
  assert.match(openCodeCompactPluginFileName, /^charness-compaction-[0-9a-f]{8}\.js$/);
  const source = buildOpenCodeCompactPluginSource(getOpenCodeCompactPluginContext());
  assert.equal(getOpenCodeCompactPluginFileName(source), openCodeCompactPluginFileName);
  const olderSource = buildOpenCodeCompactPluginSource('the skills-only text an earlier release carried');
  assert.notEqual(getOpenCodeCompactPluginFileName(olderSource), openCodeCompactPluginFileName);
});

test('checkHasOpenCodeCompactPlugin: an instance that loaded an OLDER text does not count — it lacks the current guidance', () => {
  for (const outdatedUrl of outdatedPluginUrls) {
    assert.equal(checkHasOpenCodeCompactPlugin([outdatedUrl]), false, outdatedUrl);
  }
  assert.equal(
    checkHasOpenCodeCompactPlugin([...outdatedPluginUrls, `${pluginUrlBase}/${openCodeCompactPluginFileName}`]),
    true,
    'the current file among older ones is enough',
  );
});

test('getCompactPluginActivation: an idle instance that loaded an OLDER text is recreated, a busy one is left alone', () => {
  for (const outdatedUrl of outdatedPluginUrls) {
    assert.equal(
      getCompactPluginActivation({ pluginSpecs: [outdatedUrl], sessionStatus: { s: { type: 'idle' } } }),
      'recreate',
      outdatedUrl,
    );
    assert.equal(
      getCompactPluginActivation({ pluginSpecs: [outdatedUrl], sessionStatus: { s: { type: 'busy' } } }),
      'busy',
      outdatedUrl,
    );
  }
});

/** The file a pre-rename release wrote: same module shape, the old id and file name. */
function writeLegacyPluginFile(dir: string): string {
  const legacyPath = path.join(dir, legacyOpenCodeCompactPluginFileName);
  fs.writeFileSync(
    legacyPath,
    `export default { id: ${JSON.stringify(legacyOpenCodeCompactPluginId)}, server: async () => ({}) };\n`,
  );
  return legacyPath;
}

function captureStderr(run: () => void): string[] {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks;
}

test('the plugin is named charness-compaction, not the pre-rename id', () => {
  assert.match(openCodeCompactPluginFileName, /^charness-compaction-[0-9a-f]{8}\.js$/);
  assert.equal(openCodeCompactPluginId, 'charness-compaction');
});

test('installOpenCodeCompactPlugin: removes the pre-rename file once, so a folder never loads both', async () => {
  await withTempDir((dir) => {
    resetLegacyNameState();
    const legacyPath = writeLegacyPluginFile(dir);

    const written: string[] = [];
    const firstWarnings = captureStderr(() => written.push(installOpenCodeCompactPlugin(dir)));
    const secondWarnings = captureStderr(() => {
      writeLegacyPluginFile(dir);
      written.push(installOpenCodeCompactPlugin(dir));
    });

    assert.deepEqual(written, ['written', 'unchanged']);
    assert.equal(fs.existsSync(legacyPath), false);
    assert.deepEqual(fs.readdirSync(dir), [openCodeCompactPluginFileName]);
    assert.equal(firstWarnings.length, 1, 'announced once');
    assert.match(firstWarnings[0], /telegramcode-compaction\.js is deprecated, rename it to .*charness-compaction-[0-9a-f]{8}\.js/);
    assert.match(firstWarnings[0], /MIGRATION_RENAME_TO_CHARNESS\.md/);
    assert.deepEqual(secondWarnings, [], 'a second removal in the same process is not announced again');
  });
});

test('installOpenCodeCompactPlugin: a file under the old name that is not the bot\'s is left alone', async () => {
  await withTempDir((dir) => {
    const legacyPath = path.join(dir, legacyOpenCodeCompactPluginFileName);
    fs.writeFileSync(legacyPath, '// the user\'s own plugin\n');

    assert.equal(installOpenCodeCompactPlugin(dir), 'written');

    assert.equal(fs.readFileSync(legacyPath, 'utf-8'), '// the user\'s own plugin\n');
  });
});

test('checkHasOpenCodeCompactPlugin: an instance that loaded the pre-rename file does not count — its text is older than the current one', () => {
  const legacyUrl = `file:///home/user/.config/opencode/plugins/${legacyOpenCodeCompactPluginFileName}`;
  assert.equal(checkHasOpenCodeCompactPlugin([legacyUrl]), false);
  assert.equal(
    getCompactPluginActivation({ pluginSpecs: [legacyUrl], sessionStatus: { s: { type: 'idle' } } }),
    'recreate',
    'recreated so that it loads the current plugin',
  );
});
