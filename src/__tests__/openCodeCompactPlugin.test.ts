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
  openCodeAncestryLookupTimeoutMs,
  openCodeCompactPluginId,
  resolveOpenCodeGlobalPluginDir,
} from '../utils/openCodeCompactPlugin';
import { resetLegacyNameState } from '../legacyNames';
import { compactionChecklistGuidance, compactionGapsGuidance, compactionResumeGuidance, compactionResumeGuidanceWithoutGaps } from '../utils/compactOnIdle';
import { getOpenCodeCompactSelfReviewOffDir, applyCompactSelfReviewOffFlag } from '../utils/compactSelfReviewFlags';

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
  const context = getOpenCodeCompactPluginContext(true);
  assert.ok(context.endsWith(compactionResumeGuidance));
  assert.ok(context.endsWith(compactionChecklistGuidance));
  assert.match(context, /inside the summary, never after a closing section/);
});

test('getOpenCodeCompactPluginContext: the OpenCode server\'s own overflow compaction is asked for the self-review section too, ahead of the checklist', () => {
  const context = getOpenCodeCompactPluginContext(true);
  assert.ok(context.includes(compactionGapsGuidance));
  assert.ok(context.indexOf(compactionGapsGuidance) < context.indexOf(compactionChecklistGuidance));
});

test('getOpenCodeCompactPluginContext: with the section off (`/compact_self_review`) it is the skills and the checklist alone, still kept inside the summary', () => {
  const context = getOpenCodeCompactPluginContext(false);
  assert.ok(context.endsWith(compactionResumeGuidanceWithoutGaps));
  assert.ok(!context.includes(compactionGapsGuidance), 'no request for the section');
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
    assert.deepEqual(output, { context: ['EARLIER', getOpenCodeCompactPluginContext(true)], prompt: undefined });
    assert.ok(output.context[1].endsWith(compactionChecklistGuidance), 'the installed plugin asks for the checklist that ends the summary');
  });
});

/** The slice of the SDK client the plugin uses: the session lookup that tells a session's parent. */
type SessionLookupClient = { session: { get: (request: { path: { id: string } }) => Promise<{ data?: { parentID?: string } }> } };

/** Install the plugin under `<dir>/opencode/plugins`, import it the way OpenCode does (its context carries `client`) and return its compaction hook. */
async function loadInstalledPluginHook(dir: string, client?: SessionLookupClient): Promise<CompactingHook> {
  const pluginDir = path.join(dir, 'opencode', 'plugins');
  assert.notEqual(installOpenCodeCompactPlugin(pluginDir), 'failed');
  const mod = await import(pathToFileURL(path.join(pluginDir, openCodeCompactPluginFileName)).href);
  const hooks = await mod.default.server(client ? { client } : {}, undefined);
  return hooks['experimental.session.compacting'] as CompactingHook;
}

/** What the plugin pushes into the compaction prompt of `sessionID`. */
async function getPushedContext(hook: CompactingHook, sessionID: unknown): Promise<string[]> {
  const output = { context: [] as string[] };
  await hook({ sessionID } as { sessionID: string }, output);
  return output.context;
}

test('installed plugin: the flag of the compacting session (`/compact_self_review` off) drops the self-review request — and only that session\'s', async () => {
  await withTempDir(async (dir) => {
    const hook = await loadInstalledPluginHook(dir);
    const flagDir = getOpenCodeCompactSelfReviewOffDir(path.join(dir, 'opencode', 'plugins'));
    assert.deepEqual(await getPushedContext(hook, 'ses_off'), [getOpenCodeCompactPluginContext(true)], 'no flag yet: asked, as before the switch');

    applyCompactSelfReviewOffFlag(flagDir, 'ses_off', false);
    assert.deepEqual(await getPushedContext(hook, 'ses_off'), [getOpenCodeCompactPluginContext(false)], 'flagged: no section request');
    assert.deepEqual(await getPushedContext(hook, 'ses_other'), [getOpenCodeCompactPluginContext(true)], 'another session is still asked');

    applyCompactSelfReviewOffFlag(flagDir, 'ses_off', true);
    assert.deepEqual(await getPushedContext(hook, 'ses_off'), [getOpenCodeCompactPluginContext(true)], 'switched back on: asked again, with no reload of the plugin');
  });
});

test('installed plugin: a session id that is not a plain id never leaves the flag folder, and an unreadable input means ON', async () => {
  await withTempDir(async (dir) => {
    const hook = await loadInstalledPluginHook(dir);
    // A decoy ONE LEVEL UP from the flag folder: were `../decoy` joined into the path, the flag would "exist".
    const opencodeDir = path.join(dir, 'opencode');
    fs.writeFileSync(path.join(opencodeDir, 'decoy'), '');
    for (const hostileId of ['../decoy', 'a/../../opencode/decoy', '', undefined, 42, null]) {
      assert.deepEqual(await getPushedContext(hook, hostileId), [getOpenCodeCompactPluginContext(true)], `session id ${JSON.stringify(hostileId)}`);
    }
    const output = { context: [] as string[] };
    await (hook as unknown as (input: undefined, output: { context: string[] }) => Promise<void>)(undefined, output);
    assert.deepEqual(output.context, [getOpenCodeCompactPluginContext(true)], 'no input at all');
  });
});

/** A session lookup over `parents` (child → parent), counting its calls. */
function createSessionLookup(parents: Record<string, string>): { client: SessionLookupClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: { session: { get: async ({ path: { id } }) => { calls.push(id); return { data: parents[id] ? { parentID: parents[id] } : {} }; } } },
  };
}

test('installed plugin: a sub-agent\'s session follows its topic — the flag of an ancestor (parentID, as the server tells it) drops the section request', async () => {
  await withTempDir(async (dir) => {
    const lookup = createSessionLookup({ ses_child: 'ses_topic', ses_grandchild: 'ses_child' });
    const hook = await loadInstalledPluginHook(dir, lookup.client);
    const flagDir = getOpenCodeCompactSelfReviewOffDir(path.join(dir, 'opencode', 'plugins'));
    assert.deepEqual(await getPushedContext(hook, 'ses_child'), [getOpenCodeCompactPluginContext(true)], 'no flag anywhere: asked, and no request made to find out');
    assert.deepEqual(lookup.calls, [], 'an empty flag folder costs no lookup');

    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', false);
    assert.deepEqual(await getPushedContext(hook, 'ses_child'), [getOpenCodeCompactPluginContext(false)], 'a child of the OFF topic\'s session is not asked');
    assert.deepEqual(await getPushedContext(hook, 'ses_grandchild'), [getOpenCodeCompactPluginContext(false)], 'nor is a grandchild');
    assert.deepEqual(await getPushedContext(hook, 'ses_stranger'), [getOpenCodeCompactPluginContext(true)], 'a session under no flagged one is asked');

    lookup.calls.length = 0;
    assert.deepEqual(await getPushedContext(hook, 'ses_topic'), [getOpenCodeCompactPluginContext(false)]);
    assert.deepEqual(lookup.calls, [], 'the flagged session itself needs no lookup');

    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', true);
    assert.deepEqual(await getPushedContext(hook, 'ses_child'), [getOpenCodeCompactPluginContext(true)], 'switched back on: the child is asked again');
  });
});

test('installed plugin: an ancestor search that fails, loops or never ends means ON — and is bounded', async () => {
  await withTempDir(async (dir) => {
    const flagDir = getOpenCodeCompactSelfReviewOffDir(path.join(dir, 'opencode', 'plugins'));
    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', false);
    const asked = [getOpenCodeCompactPluginContext(true)];

    // No client at all (a host that hands the plugin none), and a server that does not answer.
    assert.deepEqual(await getPushedContext(await loadInstalledPluginHook(dir), 'ses_child'), asked, 'no client');
    const failingClient: SessionLookupClient = { session: { get: async () => { throw new Error('server unreachable'); } } };
    assert.deepEqual(await getPushedContext(await loadInstalledPluginHook(dir, failingClient), 'ses_child'), asked, 'a failing lookup');

    // A loop that never reaches the flagged session ends after the bound instead of being followed for ever.
    const loop = createSessionLookup({ ses_a: 'ses_b', ses_b: 'ses_a' });
    assert.deepEqual(await getPushedContext(await loadInstalledPluginHook(dir, loop.client), 'ses_a'), asked, 'a loop');
    assert.ok(loop.calls.length <= 8, `the loop was followed ${loop.calls.length} times`);

    // The bound: the flagged session may be up to 8 sessions from the compacting one (itself included), not further.
    const chain: Record<string, string> = {};
    for (let level = 0; level < 12; level += 1) chain[`ses_level${level}`] = `ses_level${level + 1}`;
    const bounded = createSessionLookup(chain);
    const boundedHook = await loadInstalledPluginHook(dir, bounded.client);
    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', true);
    applyCompactSelfReviewOffFlag(flagDir, 'ses_level7', false);
    assert.deepEqual(await getPushedContext(boundedHook, 'ses_level0'), [getOpenCodeCompactPluginContext(false)], 'the 8th session up is still followed');
    applyCompactSelfReviewOffFlag(flagDir, 'ses_level7', true);
    applyCompactSelfReviewOffFlag(flagDir, 'ses_level8', false);
    assert.deepEqual(await getPushedContext(boundedHook, 'ses_level0'), asked, 'the 9th is not');
  });
});

test('installed plugin: a parent lookup that never answers is given up after its deadline and means ON — the compaction is not held for ever', async () => {
  await withTempDir(async (dir) => {
    const flagDir = getOpenCodeCompactSelfReviewOffDir(path.join(dir, 'opencode', 'plugins'));
    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', false);
    const lookedUp: string[] = [];
    // A server that takes the request and never settles it (going down mid-compaction, a proxy that holds the connection).
    const silentClient: SessionLookupClient = { session: { get: ({ path: { id } }) => { lookedUp.push(id); return new Promise(() => {}); } } };
    const hook = await loadInstalledPluginHook(dir, silentClient);

    // Beaten to it by the test's own, later deadline, the plugin has hung: the red outcome fails in seconds, not at the file's limit.
    const hungMarker = ['HUNG'];
    const startedAt = Date.now();
    const outcome = await Promise.race([
      getPushedContext(hook, 'ses_child'),
      new Promise<string[]>((resolve) => setTimeout(() => resolve(hungMarker), openCodeAncestryLookupTimeoutMs + 3000)),
    ]);

    assert.notEqual(outcome, hungMarker, 'the hook returned although the server never answered');
    assert.deepEqual(outcome, [getOpenCodeCompactPluginContext(true)], 'no answer in time: asked, as before the switch');
    assert.ok(Date.now() - startedAt >= openCodeAncestryLookupTimeoutMs - 100, 'it waited for the deadline, not less');
    assert.deepEqual(lookedUp, ['ses_child'], 'and gave the walk up there: one request, not one per level');
    // A lookup that answers in time is unaffected by the deadline.
    const lookup = createSessionLookup({ ses_child: 'ses_topic' });
    assert.deepEqual(await getPushedContext(await loadInstalledPluginHook(dir, lookup.client), 'ses_child'), [getOpenCodeCompactPluginContext(false)]);
  });
});

test('installed plugin: an ancestor id that is not a plain id never leaves the flag folder', async () => {
  await withTempDir(async (dir) => {
    const lookup = createSessionLookup({ ses_child: '../decoy' });
    const hook = await loadInstalledPluginHook(dir, lookup.client);
    const flagDir = getOpenCodeCompactSelfReviewOffDir(path.join(dir, 'opencode', 'plugins'));
    applyCompactSelfReviewOffFlag(flagDir, 'ses_topic', false);
    // A decoy ONE LEVEL UP from the flag folder: were `../decoy` joined into the path, the flag would "exist".
    fs.writeFileSync(path.join(dir, 'opencode', 'decoy'), '');
    assert.deepEqual(await getPushedContext(hook, 'ses_child'), [getOpenCodeCompactPluginContext(true)]);
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
  const source = buildOpenCodeCompactPluginSource({
    context: getOpenCodeCompactPluginContext(true),
    contextWithoutInstructionGaps: getOpenCodeCompactPluginContext(false),
  });
  assert.equal(getOpenCodeCompactPluginFileName(source), openCodeCompactPluginFileName);
  const olderSource = buildOpenCodeCompactPluginSource({
    context: 'the skills-only text an earlier release carried',
    contextWithoutInstructionGaps: 'the skills-only text an earlier release carried',
  });
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
