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
import http from 'http';
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
  openCodeHistoryLookupTimeoutMs,
  openCodeCompactPluginId,
  resolveOpenCodeGlobalPluginDir,
} from '../utils/openCodeCompactPlugin';
import { resetLegacyNameState } from '../legacyNames';
import { compactionChecklistGuidance, compactionGapsGuidance, compactionResumeGuidance, compactionResumeGuidanceWithoutGaps, compactionSkillsBlockEndMarker, compactionSkillsBlockStartMarker } from '../utils/compactOnIdle';
import { skillsRestoreHeader } from '../utils/skillsRestore';
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

// ── the skills restore (`experimental.chat.messages.transform`) ──

/** A message as OpenCode hands the transform hook its list, as far as the restore reads it. */
interface PluginMessage {
  info: { id: string; sessionID: string; role: 'user' | 'assistant'; parentID?: string; summary?: boolean; finish?: string };
  parts: Array<{ id?: string; type: string; text?: string; synthetic?: boolean; tool?: string; state?: { status: string; input?: { name: string }; metadata?: { name: string; dir: string } } }>;
}

type TransformHook = (input: object, output: { messages: PluginMessage[] }) => Promise<void>;

/** What the fake server answers: a value, a refusal, or no answer at all. */
type FakeAnswer<T> = T | 'fail' | 'hang';

/**
 * The slice of the SDK client the restore uses, with a count of its calls. `answers` is read at every call, so a test can
 * change what the server answers between two requests; `isInnerClientGone` drops the SDK's inner client (an SDK change).
 */
function createRestoreClient(answers: { history: FakeAnswer<PluginMessage[]>; skills: FakeAnswer<Array<{ name: string; location: string; content: string }>> }, isInnerClientGone = false): {
  calls: { history: number; skills: number; logs: string[] };
  client: object;
} {
  const calls = { history: 0, skills: 0, logs: [] as string[] };
  const answer = async <T>(value: FakeAnswer<T>): Promise<{ data: T }> => {
    if (value === 'hang') return new Promise<never>(() => {});
    if (value === 'fail') throw new Error('the server refused');
    return { data: value };
  };
  return {
    calls,
    client: {
      session: {
        messages: async () => { calls.history += 1; return answer(answers.history); },
        get: async () => ({ data: {} }),
      },
      ...(isInnerClientGone ? {} : { _client: { get: async (request: { url: string }) => { calls.skills += 1; assert.equal(request.url, '/skill'); return answer(answers.skills); } } }),
      app: { log: async (request: { body: { message: string } }) => { calls.logs.push(request.body.message); } },
    },
  };
}

async function loadInstalledTransformHook(dir: string, client: object, serverContext: { serverUrl?: URL; directory?: string } = {}): Promise<TransformHook> {
  const pluginDir = path.join(dir, 'opencode', 'plugins');
  assert.notEqual(installOpenCodeCompactPlugin(pluginDir), 'failed');
  const mod = await import(pathToFileURL(path.join(pluginDir, openCodeCompactPluginFileName)).href);
  const hooks = await mod.default.server({ client, ...serverContext }, undefined);
  return hooks['experimental.chat.messages.transform'] as TransformHook;
}

const sessionId = 'ses_restore';
const reviewSkill = { name: 'review', location: '/x/skills/review/SKILL.md', content: '# review\n\nREVIEW-BODY-MARK: read the diff.\n' };
const commitSkill = { name: 'commit', location: '/x/skills/commit/SKILL.md', content: '# commit\n\nCOMMIT-BODY-MARK\n' };
const blockSkill = { name: 'from-block', location: '/x/skills/from-block/SKILL.md', content: 'BLOCK-ONLY-BODY-MARK\n' };

function buildSkillCall(id: string, name: string): PluginMessage {
  return { info: { id, sessionID: sessionId, role: 'assistant', finish: 'tool-calls' }, parts: [{ type: 'tool', tool: 'skill', state: { status: 'completed', input: { name }, metadata: { name, dir: `/x/skills/${name}` } } }] };
}

/** A session that loaded `review`, was compacted (summary `summaryId`) and goes on; the history and the list the model sees. */
function buildCompactedSession(summaryId: string, summaryText: string, tail: PluginMessage[] = []): { history: PluginMessage[]; list: () => PluginMessage[] } {
  const compactionUser: PluginMessage = { info: { id: `${summaryId}_user`, sessionID: sessionId, role: 'user' }, parts: [{ type: 'compaction' }] };
  const summary: PluginMessage = { info: { id: summaryId, sessionID: sessionId, role: 'assistant', summary: true, finish: 'stop', parentID: `${summaryId}_user` }, parts: [{ type: 'text', text: summaryText }] };
  const continueUser: PluginMessage = { info: { id: `${summaryId}_continue`, sessionID: sessionId, role: 'user' }, parts: [{ type: 'text', text: 'Continue if you have next steps', synthetic: true }] };
  const history = [{ info: { id: 'msg_first', sessionID: sessionId, role: 'user' as const }, parts: [{ type: 'text', text: 'load review' }] }, buildSkillCall('msg_call', 'review'), compactionUser, summary, ...tail, continueUser];
  // The list is built anew for every request, as the fork rebuilds it from storage (`filterCompacted`).
  return { history, list: () => structuredClone([compactionUser, summary, ...tail, continueUser]) };
}

function getRestorePart(messages: PluginMessage[]): string | null {
  const parts = messages.flatMap((message) => message.parts.filter((part) => part.id === 'prt_charness_skills_restore'));
  assert.ok(parts.length <= 1, 'one restore part at most');
  return parts[0]?.text ?? null;
}

test('installed plugin, no summary in the list: nothing is added — and the compaction\'s own request (no finished summary) is left as it is', async () => {
  await withTempDir(async (dir) => {
    const { calls, client } = createRestoreClient({ history: [], skills: [reviewSkill] });
    const hook = await loadInstalledTransformHook(dir, client);
    const plain: PluginMessage[] = [{ info: { id: 'msg_1', sessionID: sessionId, role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }, buildSkillCall('msg_2', 'review')];
    const before = structuredClone(plain);
    await hook({}, { messages: plain });
    assert.deepEqual(plain, before);
    // A summary still being written (no `finish`) is no summary yet.
    const writing: PluginMessage[] = [...plain, { info: { id: 'msg_s', sessionID: sessionId, role: 'assistant', summary: true, parentID: 'msg_1' }, parts: [{ type: 'text', text: 'half' }] }];
    await hook({}, { messages: writing });
    assert.equal(getRestorePart(writing), null);
    assert.deepEqual(calls, { history: 0, skills: 0, logs: [] }, 'no lookup without a summary');
  });
});

test('installed plugin, after a compaction: ONE synthetic part on the compaction\'s own message — every skill of the history with the server\'s CURRENT text, a name only the block holds with a load line', async () => {
  await withTempDir(async (dir) => {
    const summaryText = `Summary.\n${compactionSkillsBlockStartMarker}\nreview\nfrom-block\n${compactionSkillsBlockEndMarker}\n1. skills restored by Charness: review, from-block`;
    const session = buildCompactedSession('msg_sum1', summaryText);
    const { client } = createRestoreClient({ history: session.history, skills: [reviewSkill, commitSkill, blockSkill] });
    const hook = await loadInstalledTransformHook(dir, client);
    const list = session.list();
    await hook({}, { messages: list });
    const text = getRestorePart(list);
    assert.ok(text, 'the restore is added');
    assert.ok(list[0].parts.some((part) => part.id === 'prt_charness_skills_restore' && part.synthetic === true), 'on the compaction\'s own user message, right before the summary');
    assert.ok(text.startsWith(skillsRestoreHeader));
    assert.ok(text.includes('- review: its current full text is below (base directory: /x/skills/review)'));
    assert.ok(text.includes('REVIEW-BODY-MARK'), 'the history\'s skill, whole');
    assert.ok(text.includes('- from-block: not restored here: load it with the skill tool'), 'the history answered: a name only the block holds is no proof of a load');
    assert.ok(!text.includes('BLOCK-ONLY-BODY-MARK') && !text.includes('COMMIT-BODY-MARK'), 'no text for a skill the history does not show');
  });
});

test('installed plugin: a skill whose call is already after the summary (the retained tail) is only named, not given twice', async () => {
  await withTempDir(async (dir) => {
    const session = buildCompactedSession('msg_sum2', 'Summary.', [buildSkillCall('msg_tail', 'commit')]);
    const { client } = createRestoreClient({ history: session.history, skills: [reviewSkill, commitSkill] });
    const hook = await loadInstalledTransformHook(dir, client);
    const list = session.list();
    await hook({}, { messages: list });
    const text = getRestorePart(list) ?? '';
    assert.ok(text.includes('- commit: its full text is already in your context'));
    assert.ok(!text.includes('COMMIT-BODY-MARK'));
    assert.ok(text.includes('REVIEW-BODY-MARK'));
  });
});

test('installed plugin: built once per summary — every later request gets the same text with no lookup; the next summary builds anew', async () => {
  await withTempDir(async (dir) => {
    const first = buildCompactedSession('msg_sum3', 'Summary.');
    const answers = { history: first.history, skills: [reviewSkill] };
    const { calls, client } = createRestoreClient(answers);
    const hook = await loadInstalledTransformHook(dir, client);
    const lists = [first.list(), first.list()];
    for (const list of lists) await hook({}, { messages: list });
    assert.equal(getRestorePart(lists[0]), getRestorePart(lists[1]), 'the same text for every request of the summary (the prompt cache holds)');
    assert.deepEqual([calls.history, calls.skills], [1, 1]);
    // The same list objects handed over twice get one part.
    await hook({}, { messages: lists[0] });
    assert.ok(getRestorePart(lists[0]));
    const second = buildCompactedSession('msg_sum4', 'Summary.');
    await hook({}, { messages: second.list() });
    assert.deepEqual([calls.history, calls.skills], [2, 2], 'a new compaction looks again');
  });
});

test('installed plugin: lookups that never answer cost at most the history\'s deadline — the calls in the list stand in, the skills get load lines — and the next request asks again', async () => {
  await withTempDir(async (dir) => {
    const session = buildCompactedSession('msg_sum5', `${compactionSkillsBlockStartMarker}\nfrom-block\n${compactionSkillsBlockEndMarker}`, [buildSkillCall('msg_tail', 'commit')]);
    const answers: Parameters<typeof createRestoreClient>[0] = { history: 'hang', skills: 'hang' };
    const { calls, client } = createRestoreClient(answers);
    const hook = await loadInstalledTransformHook(dir, client);
    const list = session.list();
    const startedAt = Date.now();
    await hook({}, { messages: list });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= openCodeHistoryLookupTimeoutMs - 100 && elapsedMs < openCodeHistoryLookupTimeoutMs + 1500, `the request waited ${elapsedMs} ms`);
    const text = getRestorePart(list) ?? '';
    assert.ok(text.includes('- commit: its full text is already in your context'), 'the call in the list is still known');
    assert.ok(text.includes('- from-block: not restored here: load it with the skill tool'), 'the block\'s name, with no text to give: the load line');
    assert.ok(!text.includes('review'), 'what only the history held is unknown while it does not answer');
    assert.equal(calls.logs.filter((line) => line.includes('the history and the skill list did not answer')).length, 1, 'the fallback is logged');

    // The server answers again: the restore that was not whole was not kept, so the next request gets the whole one.
    answers.history = session.history;
    answers.skills = [reviewSkill, commitSkill];
    const nextList = session.list();
    await hook({}, { messages: nextList });
    const nextText = getRestorePart(nextList) ?? '';
    assert.ok(nextText.includes('REVIEW-BODY-MARK'), `the next request gets the whole restore: ${nextText}`);
    assert.deepEqual([calls.history, calls.skills], [2, 2], 'asked again');
    const thirdList = session.list();
    await hook({}, { messages: thirdList });
    assert.equal(getRestorePart(thirdList), nextText, 'a whole restore is kept');
    assert.deepEqual([calls.history, calls.skills], [2, 2], 'and asks nothing more');
  });
});

test('installed plugin: with no inner client in the SDK it asks the server itself — its folder and its password — and says so once in the log', async () => {
  await withTempDir(async (dir) => {
    const password = 'example-server-password';
    const seen: Array<{ authorization: string | undefined; directory: string | null }> = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      seen.push({ authorization: request.headers.authorization, directory: url.searchParams.get('directory') });
      if (url.pathname !== '/skill' || request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([reviewSkill]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_PASSWORD = password;
    try {
      const session = buildCompactedSession('msg_sum10', 'Summary.');
      const { calls, client } = createRestoreClient({ history: session.history, skills: 'fail' }, true);
      const hook = await loadInstalledTransformHook(dir, client, { serverUrl: new URL(`http://127.0.0.1:${port}`), directory: '/x/project' });
      for (const list of [session.list(), session.list()]) {
        await hook({}, { messages: list });
        assert.ok((getRestorePart(list) ?? '').includes('REVIEW-BODY-MARK'), 'the skill list came from the server itself');
      }
      assert.deepEqual(seen, [{ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, directory: '/x/project' }], 'once: the whole restore is kept');
      assert.equal(calls.logs.filter((line) => line.includes('no inner client for GET /skill')).length, 1);
    } finally {
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
      server.close();
    }
  });
});

test('installed plugin: a refused skill list gives load lines; a skill the server no longer offers is not available now; nothing loaded adds nothing', async () => {
  await withTempDir(async (dir) => {
    const refused = buildCompactedSession('msg_sum6', 'Summary.');
    const refusing = createRestoreClient({ history: refused.history, skills: 'fail' });
    const refusedList = refused.list();
    await (await loadInstalledTransformHook(path.join(dir, 'a'), refusing.client))({}, { messages: refusedList });
    assert.ok((getRestorePart(refusedList) ?? '').includes('- review: not restored here: load it with the skill tool'));

    const gone = buildCompactedSession('msg_sum7', 'Summary.');
    const goneList = gone.list();
    await (await loadInstalledTransformHook(path.join(dir, 'b'), createRestoreClient({ history: gone.history, skills: [commitSkill] }).client))({}, { messages: goneList });
    assert.ok((getRestorePart(goneList) ?? '').includes('- review: was loaded before but is not available now'));

    const none = buildCompactedSession('msg_sum8', 'Summary.');
    const noneList = none.list();
    const noSkillsHistory = none.history.filter((message) => message.info.id !== 'msg_call');
    await (await loadInstalledTransformHook(path.join(dir, 'c'), createRestoreClient({ history: noSkillsHistory, skills: [reviewSkill] }).client))({}, { messages: noneList });
    assert.equal(getRestorePart(noneList), null, 'no skill was ever loaded: zero tokens');
  });
});

test('installed plugin: a block that disagrees with the history is written to the server log once per summary', async () => {
  await withTempDir(async (dir) => {
    const session = buildCompactedSession('msg_sum9', `${compactionSkillsBlockStartMarker}\nfrom-block\n${compactionSkillsBlockEndMarker}`);
    const { calls, client } = createRestoreClient({ history: session.history, skills: [reviewSkill, blockSkill] });
    const hook = await loadInstalledTransformHook(dir, client);
    await hook({}, { messages: session.list() });
    await hook({}, { messages: session.list() });
    assert.equal(calls.logs.length, 1);
    assert.match(calls.logs[0], /names \[from-block\] the history does not show, the history shows \[review\] the block leaves out/);
  });
});

test('installed plugin: the compaction\'s message is replaced by a copy whose id carries the restore\'s revision — the same restore, the same id; a rebuilt one, a new id', async () => {
  await withTempDir(async (dir) => {
    const session = buildCompactedSession('msg_sum11', 'Summary.');
    const answers: Parameters<typeof createRestoreClient>[0] = { history: session.history, skills: 'fail' };
    const hook = await loadInstalledTransformHook(dir, createRestoreClient(answers).client);
    const getTaggedId = async (): Promise<{ id: string; isOriginalUntouched: boolean }> => {
      const list = session.list();
      const original = list[0];
      await hook({}, { messages: list });
      return { id: list[0].info.id, isOriginalUntouched: original.info.id === 'msg_sum11_user' && !original.parts.some((part) => part.id === 'prt_charness_skills_restore') };
    };
    const partial = await getTaggedId();
    assert.match(partial.id, /^msg_sum11_user_charness_skills_[0-9a-f]{8}$/);
    assert.ok(partial.isOriginalUntouched, 'the stored message object keeps its id and parts');
    assert.equal((await getTaggedId()).id, partial.id, 'the same partial restore: the same id (the fork keeps reusing its conversion)');
    answers.skills = [reviewSkill];
    const whole = await getTaggedId();
    assert.notEqual(whole.id, partial.id, 'the restore rebuilt whole: a new id, so the fork converts the list again');
    assert.equal((await getTaggedId()).id, whole.id, 'and it stays');
  });
});

test('installed plugin: the marks that keep a fallback logged once per summary are bounded like the cache — the oldest goes first', async () => {
  await withTempDir(async (dir) => {
    const { calls, client } = createRestoreClient({ history: 'fail', skills: 'fail' });
    const hook = await loadInstalledTransformHook(dir, client);
    const failOnce = async (summaryId: string): Promise<void> => {
      await hook({}, { messages: buildCompactedSession(summaryId, 'Summary.').list() });
    };
    const countFallbackLogs = (): number => calls.logs.filter((line) => line.includes('did not answer')).length;
    await failOnce('msg_bound_0');
    await failOnce('msg_bound_0');
    assert.equal(countFallbackLogs(), 1, 'one line per summary while its mark is kept');
    // 64 more summaries fail: the first one's mark is the oldest and goes.
    for (let index = 1; index <= 64; index += 1) await failOnce(`msg_bound_${index}`);
    assert.equal(countFallbackLogs(), 65);
    await failOnce('msg_bound_0');
    assert.equal(countFallbackLogs(), 66, 'the evicted mark: the first summary is logged again');
    await failOnce('msg_bound_64');
    assert.equal(countFallbackLogs(), 66, 'a kept mark: no second line');
  });
});
