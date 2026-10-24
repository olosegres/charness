/**
 * @description Mid-turn delivery of the project board (shared todo registry S4, D21, D22): the `PostToolUse` inbox
 * hook command as `sh` runs it (it prints a session's inbox once and removes it, prints nothing without one, never
 * reaches outside the inbox, always exits 0), the inbox's lifecycle (written while busy, not rewritten for the same
 * changes, seen once taken, withdrawn at a turn start, cleared at boot), the OpenCode path, and the poll that drives it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString, type SessionKey } from '../sessionKey';
import { buildTodoInboxHookCommand, buildTodoInboxHookOutput, createTodoMidTurn, getTodoInboxDir, todoInboxMaxChars, todoRunningTurnNoteHeader } from '../todos/midTurn';
import type { TodoBoardChanges } from '../todos/board';
import { TodoReminderEngine } from '../todos/reminderEngine';
import { createTodoRegistry } from '../todos/registry';
import { TodoStore } from '../todos/store';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import { prepareClaudeCompactHookFlags } from '../utils/claudeCompactHook';

const topicKey = makeTelegramKey(-1001111111111, 222);
const sessionId = '5a836301-382a-444f-8076-26b744c36d01';

function runHook(command: string, input: string): { stdout: string; status: number | null } {
  const ran = spawnSync('sh', ['-c', command], { input, encoding: 'utf8' });
  return { stdout: ran.stdout, status: ran.status };
}

describe('the PostToolUse inbox hook', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-inbox-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('prints the session\'s inbox once and removes it; another session or none prints nothing; it always exits 0', () => {
    const inboxDir = getTodoInboxDir(dataDir);
    fs.mkdirSync(inboxDir, { recursive: true });
    const output = buildTodoInboxHookOutput('[Project board — changes since 12:00]\n#topic 111 (proj-a) — working now');
    fs.writeFileSync(path.join(inboxDir, `${sessionId}.json`), output);
    const command = buildTodoInboxHookCommand(inboxDir);
    const input = JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: `x`.repeat(200_000), session_id: 'not-this-one' } });
    assert.deepEqual(runHook(command, input), { stdout: output, status: 0 });
    assert.deepEqual(fs.readdirSync(inboxDir), [], 'taken: nothing left, not even the moved copy');
    assert.deepEqual(runHook(command, input), { stdout: '', status: 0 }, 'delivered once');
    fs.writeFileSync(path.join(inboxDir, `${sessionId}.json`), output);
    assert.deepEqual(runHook(command, JSON.stringify({ session_id: 'another-session' })), { stdout: '', status: 0 });
    assert.deepEqual(runHook(command, '{ "no": "session" }'), { stdout: '', status: 0 });
  });

  it('a session id that would leave the inbox matches nothing', () => {
    const inboxDir = getTodoInboxDir(dataDir);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'todos', 'secret.json'), 'never printed');
    const command = buildTodoInboxHookCommand(inboxDir);
    assert.equal(runHook(command, JSON.stringify({ session_id: '../secret' })).stdout, '');
    assert.equal(runHook(command, JSON.stringify({ session_id: '../../todos/secret' })).stdout, '');
  });

  it('the hook output is Claude\'s PostToolUse JSON, cut below its cap; the launch settings carry the hook', () => {
    assert.deepEqual(JSON.parse(buildTodoInboxHookOutput('hello')), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hello' } });
    const cut = JSON.parse(buildTodoInboxHookOutput('y'.repeat(todoInboxMaxChars + 50))).hookSpecificOutput.additionalContext;
    assert.equal([...cut].length, todoInboxMaxChars);
    const [, settingsPath] = prepareClaudeCompactHookFlags(dataDir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, buildTodoInboxHookCommand(getTodoInboxDir(dataDir)));
    assert.equal(settings.hooks.PostToolUse[0].matcher, undefined, 'every tool');
  });
});

describe('the inbox lifecycle', () => {
  let dataDir: string;
  let changes: TodoBoardChanges | null;
  let seen: Array<Record<string, number>>;
  let claudeSessionId: string | null;
  let runningTurnNotes: string[];
  let isNoteAccepted: boolean;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-midturn-'));
    changes = { text: '[Project board — changes since 12:00]\n#a — working now', revisions: { a: 3 } };
    seen = [];
    claudeSessionId = sessionId;
    runningTurnNotes = [];
    isNoteAccepted = true;
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function createMidTurn() {
    return createTodoMidTurn({
      board: { peekChanges: async () => changes, markSeenRevisions: (_key, revisions) => { seen.push({ ...revisions }); } },
      inboxDir: getTodoInboxDir(dataDir),
      getClaudeSessionId: () => claudeSessionId,
      postRunningTurnNote: async (_key, text) => { runningTurnNotes.push(text); return isNoteAccepted; },
    });
  }
  const inboxPath = (): string => path.join(getTodoInboxDir(dataDir), `${sessionId}.json`);

  it('writes the changes for a busy Claude session; the same changes are not rewritten; taken = seen', async () => {
    const midTurn = createMidTurn();
    await midTurn.deliverIfPending(topicKey);
    assert.equal(JSON.parse(fs.readFileSync(inboxPath(), 'utf8')).hookSpecificOutput.additionalContext, changes?.text);
    assert.equal(fs.statSync(inboxPath()).mode & 0o777, 0o600);
    const writtenAt = fs.statSync(inboxPath()).mtimeMs;
    await midTurn.deliverIfPending(topicKey);
    assert.equal(fs.statSync(inboxPath()).mtimeMs, writtenAt, 'not rewritten');
    midTurn.reconcile();
    assert.deepEqual(seen, [], 'not seen while the inbox waits');
    runHook(buildTodoInboxHookCommand(getTodoInboxDir(dataDir)), JSON.stringify({ session_id: sessionId }));
    midTurn.reconcile();
    assert.deepEqual(seen, [{ a: 3 }], 'seen once the hook took it');
  });

  it('newer changes replace a waiting inbox; a turn start withdraws it unseen; boot clears every inbox', async () => {
    const midTurn = createMidTurn();
    await midTurn.deliverIfPending(topicKey);
    changes = { text: 'newer', revisions: { a: 4 } };
    await midTurn.deliverIfPending(topicKey);
    assert.match(fs.readFileSync(inboxPath(), 'utf8'), /"newer"/);
    midTurn.discardInbox(topicKey);
    assert.equal(fs.existsSync(inboxPath()), false);
    assert.deepEqual(seen, [], 'withdrawn, not seen: the prompt carries it');
    await midTurn.deliverIfPending(topicKey);
    fs.writeFileSync(path.join(getTodoInboxDir(dataDir), 'left-by-an-ended-session.json'), '{}');
    midTurn.clearInboxes();
    assert.equal(fs.existsSync(getTodoInboxDir(dataDir)), false);
  });

  it('nothing changed: nothing written; an OpenCode session gets the note into its turn, seen only once accepted; an odd session id writes nothing', async () => {
    changes = null;
    const midTurn = createMidTurn();
    await midTurn.deliverIfPending(topicKey);
    assert.equal(fs.existsSync(getTodoInboxDir(dataDir)), false);
    changes = { text: 'x', revisions: { a: 1 } };
    claudeSessionId = null;
    isNoteAccepted = false;
    await midTurn.deliverIfPending(topicKey);
    assert.deepEqual(runningTurnNotes, [`${todoRunningTurnNoteHeader}\n\nx`]);
    assert.deepEqual(seen, [], 'a refused note (no running turn, a provider retry) is not seen');
    isNoteAccepted = true;
    await midTurn.deliverIfPending(topicKey);
    assert.deepEqual(seen, [{ a: 1 }]);
    claudeSessionId = '../escape';
    await midTurn.deliverIfPending(topicKey);
    assert.equal(fs.existsSync(getTodoInboxDir(dataDir)), false);
  });
});

describe('the poll drives the mid-turn delivery', () => {
  it('only busy sessions are handed changes; it runs with the reminder off; not at all with the lists off', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-midpoll-'));
    try {
      const busyKey = makeTelegramKey(-1001111111111, 1);
      const idleKey = makeTelegramKey(-1001111111111, 2);
      const delivered: string[] = [];
      let reconciled = 0;
      let isEnabled = true;
      const probes = new Map<string, SessionTurnProbe>([
        [keyToString(busyKey), { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false }],
        [keyToString(idleKey), { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false }],
      ]);
      const engine = new TodoReminderEngine({
        registry: createTodoRegistry({ store: new TodoStore(dataDir), getNowMs: Date.now }),
        listConversations: (): SessionKey[] => [busyKey, idleKey],
        probeTurn: (key) => probes.get(keyToString(key)) ?? { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false },
        getGate: () => ({ hasOpenRequest: false, isAnswerTailFollowed: false, isLimited: false, isApiBilled: false, isStoppingAfterTurn: false }),
        getIntervalMs: () => null,
        checkIsEnabled: () => isEnabled,
        postReminder: async () => true,
        midTurn: { reconcile: () => { reconciled += 1; }, deliverIfPending: async (key) => { delivered.push(keyToString(key)); } },
      });
      await engine.poll();
      assert.deepEqual(delivered, [keyToString(busyKey)]);
      assert.equal(reconciled, 1);
      isEnabled = false;
      await engine.poll();
      assert.deepEqual(delivered, [keyToString(busyKey)], 'off: nothing');
      assert.equal(reconciled, 1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
