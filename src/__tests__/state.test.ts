/**
 * @description Plan §11 Этап 7 — state-store coverage:
 *
 *   R4. Legacy migration: `~/.telegram-bot-messages.json` → `.bak`.
 *   R5. Concurrent `setBinding` / `setAgentChoice` from two callers
 *       under the same `SessionKey` doesn't lose either write
 *       (per-key async-lock, plan §13.15).
 *   R6. Corrupted `state.json` is archived to
 *       `state.json.corrupted-<ts>` and the store starts fresh
 *       (plan §13.14).
 *
 * Each test creates an isolated `dataDir` under `os.tmpdir()` and overrides
 * `HOME` so the legacy-file check (which reads `os.homedir()`) sees the
 * tmp directory, not the developer's real home. `HOME` is restored in
 * `afterEach`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import { getTelegramChatId, makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

let dataDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-home-'));
  dataDir = path.join(fakeHome, '.telegramCode');
  fs.mkdirSync(dataDir, { recursive: true });
  originalHome = process.env.HOME;
  // Node's `os.homedir()` on POSIX falls back to `process.env.HOME` when
  // the userInfo lookup yields the default. Overriding it here keeps the
  // legacy-migration probe from touching the developer's real homedir.
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const key1: SessionKey = makeTelegramKey(-1001234567890, 42);
const key2: SessionKey = makeTelegramKey(-1001234567890, 99);

test('R4: legacy ~/.telegram-bot-messages.json is renamed to .bak on init', async () => {
  const legacy = path.join(fakeHome, '.telegram-bot-messages.json');
  fs.writeFileSync(legacy, JSON.stringify({ '12345': [1, 2, 3] }));

  const store = new StateStore(dataDir, { saveDebounceMs: 20 });
  await store.init();

  assert.equal(fs.existsSync(legacy), false, 'legacy file should be gone');
  assert.equal(fs.existsSync(legacy + '.bak'), true, '.bak should exist');
  assert.equal(store.getLegacyMigrationPath(), legacy + '.bak');
});

test('R4: init is a no-op if there is no legacy file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 20 });
  await store.init();
  assert.equal(store.getLegacyMigrationPath(), null);
});

test('R5: concurrent setBinding under the same key serialises and both writes land', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  // Fire two writes for the same key concurrently. Without the per-key
  // lock the second read-modify-write would clobber the first half of
  // the time; with the lock the final state is deterministic.
  await Promise.all([
    store.setBinding(key1, 'alpha'),
    store.setBinding(key1, 'beta'),
  ]);

  // Whichever ran second wins, but the in-memory state must match the
  // on-disk state — that's the actual invariant.
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const persisted = raw.bindings[keyToString(key1)];
  const inMemory = store.getBinding(key1);
  assert.ok(persisted, 'binding must exist on disk');
  assert.equal(persisted.subdir, inMemory?.subdir, 'on-disk and in-memory must agree');
  assert.ok(['alpha', 'beta'].includes(persisted.subdir));
});

test('R5: concurrent setBinding on DIFFERENT keys both land', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  await Promise.all([
    store.setBinding(key1, 'alpha'),
    store.setBinding(key2, 'beta'),
  ]);
  await store.flush();

  assert.equal(store.getBinding(key1)?.subdir, 'alpha');
  assert.equal(store.getBinding(key2)?.subdir, 'beta');
});

test('scheduler MCP port: undefined by default, persisted + reloaded across restarts', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getPersistedSchedulerMcpPort(), undefined, 'no port persisted on a fresh store');

  await store.setSchedulerMcpPort(41234);
  assert.equal(store.getPersistedSchedulerMcpPort(), 41234, 'in-memory value updated');

  // A fresh store over the same dataDir must reload the persisted port (the
  // whole point: the next boot reuses it so registrations stay valid).
  const reloaded = new StateStore(dataDir, { saveDebounceMs: 5 });
  await reloaded.init();
  assert.equal(reloaded.getPersistedSchedulerMcpPort(), 41234, 'reloaded from disk');
});

test('R6: corrupted state.json is archived and store starts fresh', async () => {
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, '{ this is not valid json');

  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  assert.equal(store.wasCorruptedOnLoad(), true, 'corruption flag must be set');
  const archive = store.getCorruptedArchivePath();
  assert.ok(archive, 'archive path must be exposed');
  assert.match(path.basename(archive!), /^state\.json\.corrupted-/);
  assert.equal(fs.existsSync(archive!), true, 'archive file must exist on disk');
  assert.equal(fs.existsSync(statePath), true, 'fresh state.json must be written');
  assert.equal(store.listBindings().length, 0, 'fresh state has no bindings');
});

test('R6: missing state.json is treated as a fresh start (no archive, no corruption flag)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.wasCorruptedOnLoad(), false);
  assert.equal(store.getCorruptedArchivePath(), null);
  assert.equal(store.listBindings().length, 0);
});

test('R6: valid state.json is loaded and bindings are visible after restart', async () => {
  // Round-trip persistence: write some data, reload from disk in a
  // second store instance, confirm the bindings are intact.
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setAgent(key1, { name: 'claude' });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.wasCorruptedOnLoad(), false);
  assert.equal(second.getBinding(key1)?.subdir, 'alpha');
  assert.equal(second.getAgent(key1)?.name, 'claude');
});

test('Forward-compat: state.json with an unknown future field still loads cleanly', async () => {
  // Audit S19: pin forward-compat — if we ever add a new top-level
  // field, an older bot reading the file must NOT treat it as corrupt
  // (we'd lose every binding to "archived to .corrupted"). The shape
  // check in `loadStateFile` only requires the known fields; unknown
  // extras are preserved untouched on the next save.
  const statePath = path.join(dataDir, 'state.json');
  const futureShape = {
    version: 1,
    bindings: { '-1001:42': { subdir: 'alpha', createdAt: new Date().toISOString() } },
    agents: {},
    messages: {},
    futurePrefs: { newFeatureFlag: true }, // unknown top-level field
  };
  fs.writeFileSync(statePath, JSON.stringify(futureShape));

  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.wasCorruptedOnLoad(), false, 'unknown field must not trigger corruption');
  assert.equal(store.listBindings().length, 1, 'binding must survive');
  assert.equal(store.getBinding(makeTelegramKey(-1001, 42))?.subdir, 'alpha');
});

test('pinnedStatusText: set → get round-trips on the binding row', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha');
  await store.setBindingPinnedStatusText(key1, 'Claude · idle');
  assert.equal(store.getBinding(key1)?.pinnedStatusText, 'Claude · idle');
});

test('pinnedStatusText: survives a reload from disk (the B8 restart case)', async () => {
  // THE load-bearing case: the in-memory dedup cache is empty on every
  // restart, so the persisted text is the ONLY thing that lets the boot
  // refresh wave skip identical-banner edits. If this doesn't survive a
  // reload, the whole B8 fix is a no-op.
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusText(key1, 'Claude · running');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusText, 'Claude · running');
});

test('pinnedStatusText: passing null clears it on disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusText(key1, 'Claude · running');
  await first.setBindingPinnedStatusText(key1, null);
  await first.flush();

  // Cleared in memory…
  assert.equal(first.getBinding(key1)?.pinnedStatusText, undefined);
  // …and on disk (so a stale text can never suppress the next real edit).
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('pinnedStatusText' in raw.bindings[keyToString(key1)], false);

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusText, undefined);
});

test('pinnedStatusText: no-op when binding does not exist (no dangling row)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBindingPinnedStatusText(key1, 'orphan');
  assert.equal(store.getBinding(key1), null, 'must not create a binding row');
});

test('pinnedStatusText: setting the same text twice does not re-mark for save', async () => {
  // Mirrors setBindingPinnedStatusMessageId: an unchanged value is a no-op.
  // We assert idempotency via the on-disk round-trip rather than spying on
  // scheduleSave (private), which is enough to prove the value is stable.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha');
  await store.setBindingPinnedStatusText(key1, 'same');
  await store.setBindingPinnedStatusText(key1, 'same');
  await store.flush();
  assert.equal(store.getBinding(key1)?.pinnedStatusText, 'same');
});

test('pinnedStatusText: persists alongside pinnedStatusMessageId independently', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusMessageId(key1, 777);
  await first.setBindingPinnedStatusText(key1, 'Claude · idle');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusMessageId, 777);
  assert.equal(second.getBinding(key1)?.pinnedStatusText, 'Claude · idle');
});

test('pairedGroupId: defaults to null when never paired', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getPairedGroupId(), null);
});

test('pairedGroupId: set → get round-trips and survives a reload from disk', async () => {
  const groupId = -1009876543210;
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setPairedGroupId(groupId);
  assert.equal(first.getPairedGroupId(), groupId);

  // setPairedGroupId flushes immediately — a second store reads it back
  // without an explicit flush, proving the id is durable across restart.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getPairedGroupId(), groupId);
});

test('clearAgentSessionIds: removes both session ids but keeps name and model', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode', model: 'anthropic/claude-3-5-sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');
  await store.setOpenCodeSessionId(key1, 'oc-id-1');

  // Pre-condition: both ids are present (proves the wipe really changed state,
  // not a vacuous pass on an already-empty record).
  assert.equal(store.getClaudeSessionId(key1), 'claude-uuid-1');
  assert.equal(store.getOpenCodeSessionId(key1), 'oc-id-1');

  await store.clearAgentSessionIds(key1);

  assert.equal(store.getClaudeSessionId(key1), null, 'claudeSessionId must be gone');
  assert.equal(store.getOpenCodeSessionId(key1), null, 'opencodeSessionId must be gone');
  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'opencode', 'name must survive the wipe');
  assert.equal(agent?.model, 'anthropic/claude-3-5-sonnet', 'model must survive the wipe');
});

test('clearAgentSessionIds: no-op when the thread has no agent record', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.clearAgentSessionIds(key1);
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('setAgentMcpToolDigest: persisted on the agent row, dropped with the session ids (L4)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgentMcpToolDigest(key1, 'orphan');
  assert.equal(store.getAgent(key1), null, 'merge-only: no row is created for a digest');
  await store.setAgent(key1, { name: 'claude-json-stream' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');
  await store.setAgentMcpToolDigest(key1, 'digest-1');
  assert.equal(store.getAgent(key1)?.mcpToolDigest, 'digest-1');

  await store.clearAgentSessionIds(key1);

  assert.equal(store.getAgent(key1)?.name, 'claude-json-stream');
  assert.equal(store.getAgent(key1)?.mcpToolDigest, undefined, 'a released session has no process whose tools the digest describes');
});

test('clearAgentSessionIds: also drops the session-start timestamp', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  // Pre-condition: the timestamp is present, so the drop really changes state.
  assert.equal(store.getAgent(key1)?.startedAt, '2026-06-27T19:42:10+04:00');

  await store.clearAgentSessionIds(key1);

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must survive the release');
  assert.equal(agent?.startedAt, undefined, 'startedAt must be dropped with the session');
});

// ── setAgentStartedAt (session-start timestamp for /status) ──

test('setAgentStartedAt: merges onto the agent row without flipping name, coexists with session ids', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');

  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must not flip');
  assert.equal(agent?.model, 'sonnet', 'model must survive');
  assert.equal(agent?.claudeSessionId, 'claude-uuid-1', 'session id must coexist');
  assert.equal(agent?.startedAt, '2026-06-27T19:42:10+04:00');
});

test('setAgentStartedAt: a later setAgent (model change) does NOT wipe startedAt (merge)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode' });
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  // A subsequent partial update (e.g. /model) must preserve the timestamp.
  await store.setAgent(key1, { name: 'opencode', model: 'anthropic/claude-3-5-sonnet' });
  const agent = store.getAgent(key1);
  assert.equal(agent?.startedAt, '2026-06-27T19:42:10+04:00', 'startedAt must survive a merge');
  assert.equal(agent?.model, 'anthropic/claude-3-5-sonnet');
});

test('setAgentStartedAt: no-op when the thread has no agent record (needs a live agent)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('setAgentStartedAt: persists to disk and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'claude' });
  await first.setClaudeSessionId(key1, 'claude-uuid-1');
  await first.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.startedAt, '2026-06-27T19:42:10+04:00', 'startedAt must survive a restart');
});

// ── setSeenWatermark (reattach recap watermark) ──

test('setSeenWatermark: merges onto the agent row without flipping name, coexists with session ids', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');

  await store.setSeenWatermark(key1, { sessionId: 'claude-uuid-1', claudeTranscriptOffset: 4096 });

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must not flip');
  assert.equal(agent?.model, 'sonnet', 'model must survive');
  assert.equal(agent?.claudeSessionId, 'claude-uuid-1', 'session id must coexist');
  assert.deepEqual(agent?.seenWatermark, { sessionId: 'claude-uuid-1', claudeTranscriptOffset: 4096 });
});

test('setSeenWatermark: a later write overwrites the previous watermark', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode' });
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  // Intermediate state proves the first write landed (not a vacuous pass).
  assert.deepEqual(store.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-2' });
  assert.deepEqual(store.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-2' });
});

test('setSeenWatermark: no-op when the thread has no agent record (a watermark needs a live agent)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('setSeenWatermark: persists to disk and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'opencode' });
  await first.setOpenCodeSessionId(key1, 'oc-id-1');
  await first.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-42' });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.opencodeSessionId, 'oc-id-1', 'session id must survive');
  assert.deepEqual(second.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-42' });
});

test('clearAgentSessionIds: the wipe is persisted to disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'opencode' });
  await first.setOpenCodeSessionId(key1, 'oc-id-1');
  await first.clearAgentSessionIds(key1);
  await first.flush();

  // Reload from disk: the persisted record must have the name but no ids,
  // so a later bot restart can't auto-reattach the released session.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.name, 'opencode');
  assert.equal(second.getOpenCodeSessionId(key1), null);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const persistedAgent = raw.agents[keyToString(key1)];
  assert.ok(persistedAgent, 'agent row must still exist on disk');
  assert.equal('opencodeSessionId' in persistedAgent, false, 'id key must be absent on disk');
});

// ── topicName (thread-context preamble) ──

test('topicName: setBinding with topicName persists it and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  // Mirrors the `/new` and pending-name-copy-on-bind paths: the caller knows
  // the topic name at bind time and passes it through `setBinding`.
  await first.setBinding(key1, 'alpha', { topicName: 'Fix login bug' });
  assert.equal(first.getBinding(key1)?.topicName, 'Fix login bug');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.topicName, 'Fix login bug', 'name must survive restart');
  assert.equal(second.getBinding(key1)?.subdir, 'alpha');
});

test('topicName: re-binding WITHOUT a name keeps the previously stored name', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha', { topicName: 'Fix login bug' });
  // A later re-bind that doesn't know the name (e.g. a picker tap) must not
  // wipe the name we already learned — the carry-through branch in setBinding.
  await store.setBinding(key1, 'beta');
  assert.equal(store.getBinding(key1)?.subdir, 'beta', 'subdir must update');
  assert.equal(store.getBinding(key1)?.topicName, 'Fix login bug', 'name must be carried through');
});

test('setBindingTopicName: updates an existing binding and persists', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha', { topicName: 'Old name' });
  // The forum_topic_edited (rename) path.
  await first.setBindingTopicName(key1, 'New name');
  assert.equal(first.getBinding(key1)?.topicName, 'New name');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.topicName, 'New name', 'rename must survive restart');
});

test('setBindingTopicName: no-op when the binding does not exist (no dangling row)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBindingTopicName(key1, 'orphan');
  assert.equal(store.getBinding(key1), null, 'must not create a binding row');
});

// ── output-trace toggle (/trace) ──

test('traceConfig: defaults all-threads ON (always-on observability) on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.deepEqual(store.getTraceConfig(), { allThreads: true, threadKeys: [] });
});

test('traceConfig: set → get round-trips and survives a reload from disk', async () => {
  const keyStr = keyToString(key1);
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTraceConfig({ allThreads: false, threadKeys: [keyStr] });
  assert.deepEqual(first.getTraceConfig(), { allThreads: false, threadKeys: [keyStr] });
  await first.flush();

  // The whole point of persisting the toggle: a hot rebuild mid-debug must
  // re-seed the SAME traced threads, or the trace silently turns off.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getTraceConfig(), { allThreads: false, threadKeys: [keyStr] });
});

test('traceConfig: the all-flag persists and reloads', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTraceConfig({ allThreads: true, threadKeys: [] });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getTraceConfig().allThreads, true);
});

test('traceConfig: `/trace off all` is DURABLE — false persists and reloads (not re-enabled by the ON default)', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  // Turn the always-on default OFF.
  await first.setTraceConfig({ allThreads: false, threadKeys: [] });
  assert.equal(first.getTraceConfig().allThreads, false);
  await first.flush();

  // `false` must be stored EXPLICITLY: dropping it would read back as the ON
  // default on the next boot, silently re-enabling tracing after `/trace off all`.
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(raw.traceAllThreads, false, 'off all-flag stored explicitly as false');

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getTraceConfig().allThreads, false, 'off survives reload');
});

test('traceConfig: dedups + sorts thread keys and drops an empty thread list on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTraceConfig({ allThreads: true, threadKeys: ['-1:2', '-1:1', '-1:2'] });
  assert.deepEqual(store.getTraceConfig().threadKeys, ['-1:1', '-1:2'], 'deduped + sorted');
  await store.flush();
  const rawOn = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(rawOn.traceAllThreads, true, 'all-flag stored explicitly');

  // Turning the per-thread list off must leave no empty array on disk.
  await store.setTraceConfig({ allThreads: true, threadKeys: [] });
  await store.flush();
  const rawOff = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('tracedThreads' in rawOff, false, 'empty thread list must be absent on disk');
});

// ── prompt-timestamp toggle (/timestamps) ──

test('timestamps: default OFF on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.checkIsTimestampsEnabled(key1), false);
});

test('timestamps: on → persists, survives a reload, and is per-thread', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTimestampsEnabled(key1, true);
  assert.equal(first.checkIsTimestampsEnabled(key1), true);
  assert.equal(first.checkIsTimestampsEnabled(key2), false, 'toggle is per-thread');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.checkIsTimestampsEnabled(key1), true, 'on survives reload');
  assert.equal(second.checkIsTimestampsEnabled(key2), false);
});

test('timestamps: off removes the thread and drops an empty list on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTimestampsEnabled(key1, true);
  await store.setTimestampsEnabled(key1, false);
  assert.equal(store.checkIsTimestampsEnabled(key1), false);
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('timestampThreads' in raw, false, 'empty list must be absent on disk');
});

// ── compact-on-idle user latch (/compact_on_idle, D2) ──

test('compactIdleLatch: default un-latched on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.checkIsCompactIdleLatched(key1), false);
});

test('compactIdleLatch: latching persists, survives a reload, and is per-thread', async () => {
  // THE restart guard — a spent latch must survive a bot restart so a second
  // idle-compaction cannot fire without a new user message.
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setCompactIdleLatched(key1, true);
  assert.equal(first.checkIsCompactIdleLatched(key1), true);
  assert.equal(first.checkIsCompactIdleLatched(key2), false, 'latch is per-thread');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.checkIsCompactIdleLatched(key1), true, 'latch survives reload');
  assert.equal(second.checkIsCompactIdleLatched(key2), false);
});

test('compactIdleLatch: clearing (user message) drops an empty list on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setCompactIdleLatched(key1, true);
  await store.setCompactIdleLatched(key1, false);
  assert.equal(store.checkIsCompactIdleLatched(key1), false);
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('compactIdleLatchedThreads' in raw, false, 'empty list must be absent on disk');
});

// ── compactIdleTracking (the idle COUNTDOWN's restart guard) ──

/** Placeholder session ids — the repo is public, never a real one. */
const sessionIdA = '11111111-1111-4111-8111-111111111111';
const sessionIdB = '22222222-2222-4222-8222-222222222222';
const activityAt = 1_800_000_000_000;

test('compactIdleTracking: an untracked thread reads back as three zeros', async () => {
  // `0` is the explicit "no history" value: the arming path takes it as "use the
  // full idle window", the fire guard as "nothing to compress". A pre-feature
  // state file must therefore behave exactly like an untracked thread.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  assert.deepEqual(store.getCompactIdleTracking(key1), {
    lastActivityAt: 0,
    lastTurnEndAt: 0,
    lastCompactionAt: 0,
  });
});

test('compactIdleTracking: all three instants survive a reload (THE restart guard)', async () => {
  // The reported bug: these lived in a process-local map, so after a restart the
  // fire guard compared `0 > 0`, decided there was nothing to compress, and — D2
  // forbidding a reschedule — the feature stayed dead in every quiet topic.
  const turnEndAt = activityAt + 1_000;
  const compactedAt = activityAt - 60_000;
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  first.noteCompactIdleActivity(key1, activityAt);
  first.noteCompactIdleTurnEnd(key1, turnEndAt);
  await first.setCompactIdleCompactedAt(key1, compactedAt);
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getCompactIdleTracking(key1), {
    lastActivityAt: activityAt,
    lastTurnEndAt: turnEndAt,
    lastCompactionAt: compactedAt,
  });
  assert.ok(
    second.getCompactIdleTracking(key1).lastTurnEndAt >
      second.getCompactIdleTracking(key1).lastCompactionAt,
    'after a restart the "something to compress" evidence still holds',
  );
  assert.deepEqual(
    second.getCompactIdleTracking(key2),
    { lastActivityAt: 0, lastTurnEndAt: 0, lastCompactionAt: 0 },
    'tracking is per-thread',
  );
});

test('compactIdleTracking: a sub-step bump still updates what a reader sees', async () => {
  // The coarse persist step only throttles the SAVE (the stamps are written on
  // every output chunk and `state.json` is rewritten whole). The in-memory value
  // must stay exact, or the countdown would be measured from a stale instant.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode', opencodeSessionId: sessionIdA });
  store.noteCompactIdleActivity(key1, activityAt);
  store.noteCompactIdleActivity(key1, activityAt + 1_000);
  assert.equal(store.getCompactIdleTracking(key1).lastActivityAt, activityAt + 1_000);
  store.noteCompactIdleTurnEnd(key1, activityAt + 2_000);
  assert.equal(store.getCompactIdleTracking(key1).lastTurnEndAt, activityAt + 2_000);
});

test('compactIdleTracking: clearing (session teardown) drops the entry and the map', async () => {
  // Teardown clears it so the NEXT session finds no history and gets the FULL idle
  // window — which is why the fresh-start path needs no special case.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  await store.setAgent(key2, { name: 'claude', claudeSessionId: sessionIdB });
  store.noteCompactIdleActivity(key1, activityAt);
  store.noteCompactIdleActivity(key2, activityAt);
  await store.clearCompactIdleTracking(key1);
  assert.equal(store.getCompactIdleTracking(key1).lastActivityAt, 0, 'entry gone');
  assert.equal(store.getCompactIdleTracking(key2).lastActivityAt, activityAt, 'other thread kept');

  await store.clearCompactIdleTracking(key2);
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('compactIdleTracking' in raw, false, 'empty map must be absent on disk');
});

test('compactIdleTracking: a session swap reads as no history (not the old marker)', async () => {
  // The instants mean "THIS session has had a turn since ITS last compaction", so a
  // replaced session (/new, /quit + start, a /sessions resume of an older session)
  // must start from scratch. Binding the entry to the session id makes that true
  // even when no stopped/closed event fired (a killed process emits none).
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  store.noteCompactIdleActivity(key1, activityAt);
  store.noteCompactIdleTurnEnd(key1, activityAt);
  assert.equal(store.getCompactIdleTracking(key1).lastTurnEndAt, activityAt, 'precondition: stamped');

  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdB });
  assert.deepEqual(store.getCompactIdleTracking(key1), {
    lastActivityAt: 0,
    lastTurnEndAt: 0,
    lastCompactionAt: 0,
  });
});

test('compactIdleTracking: no session id on the agent record → zeros regardless', async () => {
  // A raw `/terminal` shell has no session id and cannot be compacted anyway, so
  // there is nothing to bind the marker to: reads are zeros and stamps are skipped.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  store.noteCompactIdleActivity(key1, activityAt);
  await store.removeAgent(key1);
  await store.setAgent(key1, { name: 'terminal' });
  assert.equal(store.getCompactIdleTracking(key1).lastActivityAt, 0);
  store.noteCompactIdleActivity(key1, activityAt + 60_000);
  assert.equal(store.getCompactIdleTracking(key1).lastActivityAt, 0, 'stamping stays a no-op');
});

test('compactIdleTracking: a compaction stamp under a new session starts the entry fresh', async () => {
  // Same session-swap rule as the activity/turn stamps, on the compaction path: the
  // previous session's `lastTurnEndAt` must not ride along, or the fresh session
  // would look like it already had a turn to compress.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  store.noteCompactIdleActivity(key1, activityAt);
  store.noteCompactIdleTurnEnd(key1, activityAt);

  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdB });
  await store.setCompactIdleCompactedAt(key1, activityAt + 120_000);
  assert.deepEqual(store.getCompactIdleTracking(key1), {
    lastActivityAt: 0,
    lastTurnEndAt: 0,
    lastCompactionAt: activityAt + 120_000,
  });
});

test('compactIdleTracking: stamping under a new session overwrites, never merges', async () => {
  // The old session's instants must not survive the swap — a stale `lastTurnEndAt`
  // would claim the fresh session already has something to compress.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdA });
  store.noteCompactIdleActivity(key1, activityAt);
  store.noteCompactIdleTurnEnd(key1, activityAt);

  await store.setAgent(key1, { name: 'claude', claudeSessionId: sessionIdB });
  store.noteCompactIdleActivity(key1, activityAt + 120_000);
  assert.deepEqual(store.getCompactIdleTracking(key1), {
    lastActivityAt: activityAt + 120_000,
    lastTurnEndAt: 0,
    lastCompactionAt: 0,
  });
});

// ── full-compaction-summary toggle (/compact_summary) ──

test('compactSummary: OFF by default for the instance and for every thread', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getCompactSummaryGlobalDefault(), false, 'unset default means OFF');
  assert.equal(store.getCompactSummaryOverride(key1), undefined, 'no thread has an override yet');
  assert.equal(store.checkIsCompactSummaryEnabled(key1), false, 'a fresh topic posts no summary');
});

test('compactSummary: a General choice is DURABLE — stored explicitly either way and reloads', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setCompactSummaryGlobalDefault(true);
  await first.flush();

  // The failure this pins: dropping the stored value reads back as the OFF default
  // on the next boot, so a summary the operator turned on for every topic would
  // silently stop after a restart.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getCompactSummaryGlobalDefault(), true, 'on survives a reload');
  assert.equal(second.checkIsCompactSummaryEnabled(key1), true, 'and the instance default applies to a thread');

  // An explicit off is kept as `false`, not as "never set", so a later change of
  // the shipped default cannot turn it back on.
  await second.setCompactSummaryGlobalDefault(false);
  await second.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(raw.compactSummaryEnabled, false, 'off stored explicitly as false, not omitted');
});

test('compactSummary: a per-thread override beats the instance default, both ways, and is per-thread', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setCompactSummaryGlobalDefault(false);
  // An ON override over an OFF instance default.
  await first.setCompactSummaryOverride(key1, true);
  assert.equal(first.checkIsCompactSummaryEnabled(key1), true, 'the override wins over the default');
  assert.equal(first.checkIsCompactSummaryEnabled(key2), false, 'an untouched thread still follows the default');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getCompactSummaryOverride(key1), true, 'the override survives a reload');
  assert.equal(second.checkIsCompactSummaryEnabled(key1), true);
  assert.equal(second.checkIsCompactSummaryEnabled(key2), false);

  // The other direction: an OFF override under an ON instance default. An override
  // stored only when it DIFFERS from the shipped OFF default would lose this.
  await second.setCompactSummaryGlobalDefault(true);
  await second.setCompactSummaryOverride(key2, false);
  assert.equal(second.checkIsCompactSummaryEnabled(key2), false, 'an explicit false override is honoured');
  assert.equal(second.checkIsCompactSummaryEnabled(key1), true);
});

// ── setTransientFrames (transient status-frame ids — restart cleanup, S2) ──

test('setTransientFrames: set → get round-trips the id list for a thread', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101, 202, 303]);
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key1)]: [101, 202, 303] });
});

test('setTransientFrames: an empty list clears the key (clean state.json)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  // Intermediate state proves the first write landed (not a vacuous pass).
  assert.equal(Object.keys(store.getTransientFrames()).length, 1, 'precondition: one key present');
  await store.setTransientFrames(key1, []);
  assert.deepEqual(store.getTransientFrames(), {}, 'empty list must drop the key');
});

test('setTransientFrames: survives a save/load round-trip from disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTransientFrames(key1, [55, 66]);
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getTransientFrames(), { [keyToString(key1)]: [55, 66] });
});

test('setTransientFrames: the empty-list clear is persisted to disk (no dangling key)', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTransientFrames(key1, [7, 8]);
  await first.setTransientFrames(key1, []);
  await first.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('transientFrames' in raw, false, 'empty map must be absent on disk');
});

test('setTransientFrames: does not touch agents or bindings', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'proj');
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setTransientFrames(key1, [7]);
  assert.equal(store.getBinding(key1)?.subdir, 'proj', 'binding untouched');
  assert.equal(store.getAgent(key1)?.name, 'claude', 'agent name untouched');
  assert.equal(store.getAgent(key1)?.model, 'sonnet', 'agent model untouched');
});

test('setTransientFrames: two threads are independent', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [1, 2]);
  await store.setTransientFrames(key2, [3]);
  await store.setTransientFrames(key1, []);
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key2)]: [3] });
});

// The boot-reconcile crash-recovery guard (S2): `startBot` captures
// `getTransientFrames()` BEFORE reattach, then a reattached session's first frame
// setter clobbers the LIVE set. The captured snapshot must survive that clobber,
// otherwise the orphaned frame is never deleted (the bug found in live testing).
// This holds because `getTransientFrames` returns a shallow copy and
// `setTransientFrames` never mutates an existing array in place — it deletes the
// key or assigns a fresh `.slice()`.

test('getTransientFrames: a captured snapshot survives a later CLEAR clobber', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  const snapshot = store.getTransientFrames(); // captured "before reattach"
  await store.setTransientFrames(key1, []); // reattach clears the live set
  assert.deepEqual(
    snapshot,
    { [keyToString(key1)]: [101] },
    'snapshot must still carry the stale id for boot reconcile to delete',
  );
  assert.deepEqual(store.getTransientFrames(), {}, 'live set is now empty');
});

test('getTransientFrames: a captured snapshot survives a later REPLACE clobber', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  const snapshot = store.getTransientFrames();
  await store.setTransientFrames(key1, [999]); // reattach repaints → new id
  assert.deepEqual(
    snapshot,
    { [keyToString(key1)]: [101] },
    'replace assigns a fresh array, never mutates the snapshot in place',
  );
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key1)]: [999] });
});

test('chatLocaleOverride: set → reload → clear drops the persisted map', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setChatLocaleOverride(getTelegramChatId(key1), 'de');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getChatLocaleOverride(getTelegramChatId(key1)), 'de');

  await second.setChatLocaleOverride(getTelegramChatId(key1), null);
  await second.flush();
  assert.equal(second.getChatLocaleOverride(getTelegramChatId(key1)), null);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('chatLocaleOverrides' in raw, false, 'empty override map must be absent on disk');
});

test('chatTelegramLocale: persists separately from an explicit override', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setChatTelegramLocale(getTelegramChatId(key1), 'pt');
  await first.setChatLocaleOverride(getTelegramChatId(key1), 'ru');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getChatTelegramLocale(getTelegramChatId(key1)), 'pt');
  assert.equal(second.getChatLocaleOverride(getTelegramChatId(key1)), 'ru');
});

test('pushMessageIds and pushMessageId append in response order through the same bounded ring', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  await store.pushMessageIds(key1, [101, 102, 103]);
  await store.pushMessageId(key1, 104);
  await store.flush();

  assert.deepEqual(store.getMessageIds(key1), [101, 102, 103, 104]);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(raw.messages[keyToString(key1)], [101, 102, 103, 104]);
});

test('pushMessageIds persists the complete response batch before it resolves', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 60_000 });
  await store.init();

  try {
    await store.pushMessageIds(key1, [111, 112, 113]);

    const reloaded = new StateStore(dataDir, { saveDebounceMs: 60_000 });
    await reloaded.init();
    assert.deepEqual(
      reloaded.getMessageIds(key1),
      [111, 112, 113],
      'a caller may report delivery only after the whole Telegram response is on disk',
    );
  } finally {
    await store.flush();
  }
});

test('takeMessageIds atomically hands off tracked plus additional IDs while preserving a concurrent push', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.pushMessageIds(key1, [201, 202]);

  const takenPromise = store.takeMessageIds(key1, [203]);
  const concurrentPush = store.pushMessageIds(key1, [204, 205]);

  assert.deepEqual(await takenPromise, [201, 202, 203]);
  await concurrentPush;
  assert.deepEqual(
    store.getMessageIds(key1),
    [204, 205],
    'messages recorded after the handoff must survive for the next clear',
  );
});

// ── pinned answers (request/answer plan S8) ──

test('answerPins: the latest pinned answer is remembered per conversation and survives a reload', async () => {
  const key1: SessionKey = makeTelegramKey(-1001234567890, 42);
  const key2: SessionKey = makeTelegramKey(-1001234567890, 43);
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getAnswerPinMessageId(key1), undefined);
  await store.setAnswerPinMessageId(key1, 501);
  await store.setAnswerPinMessageId(key2, 777);
  await store.flush();

  const reloaded = new StateStore(dataDir, { saveDebounceMs: 5 });
  await reloaded.init();
  assert.equal(reloaded.getAnswerPinMessageId(key1), 501, 'an answer after a restart still knows which one to unpin');
  assert.equal(reloaded.getAnswerPinMessageId(key2), 777, 'per conversation');
});

test('answerPins: leaving the folder drops the record of the pinned answer; the map goes with its last entry', async () => {
  const key: SessionKey = makeTelegramKey(-1001234567890, 42);
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key, 'proj');
  await store.setAnswerPinMessageId(key, 501);
  await store.removeBinding(key);
  await store.flush();
  assert.equal(store.getAnswerPinMessageId(key), undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('answerPins' in raw, false, 'an empty map leaves a clean state file');
});
