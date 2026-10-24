/**
 * @description The todo list's staleness reminder (shared todo registry S2, D10–D14): the pure decisions and every
 * gate of the standalone form, the registry's bookkeeping (work counted only after the first turn end following an
 * update, a reminder resets the count, two ignored → silence until an update or a person), the poll that finds turn
 * ends, the `settings.json` `todo` keys, the idle-only post and the General settings screen.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import {
  buildTodoReminderText,
  createTodoNagState,
  decidePromptTodoReminder,
  decideStandaloneTodoReminder,
  getTodoReminderIntervalMs,
  todoReminderMaxIgnored,
  type TodoStandaloneGate,
} from '../todos/nag';
import { TodoStore } from '../todos/store';
import { createTodoRegistry } from '../todos/registry';
import { TodoReminderEngine } from '../todos/reminderEngine';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import {
  createInstanceDefaultEffortReader,
  createTodoSettingsReader,
  loadInstanceSettings,
  resetInstanceSettingsCache,
  saveInstanceSettings,
  saveInstanceSettingsChange,
  createEmptyInstanceSettings,
} from '../instanceSettings';
import { postToIdleSession } from '../postToSession';
import { renderTodoGeneralScreen, renderTodoSettingsScreen } from '../connectors/telegram/commands/todo';

const topicKey = makeTelegramKey(-1001111111111, 42);
const intervalMs = 60 * 60 * 1000;
const minuteMs = 60 * 1000;
const nowMs = new Date(2026, 9, 24, 12, 0, 0).getTime();

const openGate: TodoStandaloneGate = {
  isActive: true,
  isBusy: false,
  isTurnEndBlocked: false,
  hasUnconsumedInput: false,
  hasOpenRequest: false,
  isAnswerTailFollowed: false,
  isLimited: false,
  isApiBilled: false,
};
const staleNag = { clockStartedAt: nowMs - 2 * intervalMs, workedMs: intervalMs, ignoredCount: 0 };

describe('the reminder decisions (D10–D13)', () => {
  it('due only once the clock started and the agent worked the whole interval', () => {
    assert.deepEqual(decidePromptTodoReminder(staleNag, intervalMs), { shouldRemind: true });
    assert.deepEqual(decidePromptTodoReminder({ ...staleNag, clockStartedAt: undefined }, intervalMs), { shouldRemind: false, skipReasons: ['no turn ended since the last update'] });
    assert.deepEqual(decidePromptTodoReminder({ ...staleNag, workedMs: intervalMs - 1000 }, intervalMs), { shouldRemind: false, skipReasons: ['worked 3599 s of 3600 s'] });
    assert.deepEqual(decidePromptTodoReminder(staleNag, null), { shouldRemind: false, skipReasons: ['the reminder is off'] });
    assert.deepEqual(decidePromptTodoReminder({ ...staleNag, ignoredCount: todoReminderMaxIgnored }, intervalMs), { shouldRemind: false, skipReasons: ['silent after 2 ignored reminders'] });
  });

  it('the standalone form holds back for every gate of D12, each named', () => {
    assert.deepEqual(decideStandaloneTodoReminder(staleNag, intervalMs, openGate), { shouldRemind: true });
    const gates: Array<[Partial<TodoStandaloneGate>, string]> = [
      [{ isActive: false }, 'no live session (never woken for it)'],
      [{ isBusy: true }, 'busy'],
      [{ isTurnEndBlocked: true }, 'something holds the turn open'],
      [{ hasUnconsumedInput: true }, 'input not taken in yet'],
      [{ hasOpenRequest: true }, 'an open request'],
      [{ isAnswerTailFollowed: true }, 'the text after a final answer is followed'],
      [{ isLimited: true }, 'the account or model is limited'],
      [{ isApiBilled: true }, 'billed to API credits'],
    ];
    for (const [change, reason] of gates) {
      assert.deepEqual(decideStandaloneTodoReminder(staleNag, intervalMs, { ...openGate, ...change }), { shouldRemind: false, skipReasons: [reason] }, reason);
    }
    // A backend that cannot tell whether its input was read does not hold the reminder back.
    assert.deepEqual(decideStandaloneTodoReminder(staleNag, intervalMs, { ...openGate, hasUnconsumedInput: null }), { shouldRemind: true });
  });

  it('the interval: off with the feature or the reminder off, the test seam in place of the settings', () => {
    assert.equal(getTodoReminderIntervalMs({ isEnabled: true, reminderMinutes: 30 }, undefined), 30 * minuteMs);
    assert.equal(getTodoReminderIntervalMs({ isEnabled: true, reminderMinutes: 30 }, 4000), 4000);
    assert.equal(getTodoReminderIntervalMs({ isEnabled: false, reminderMinutes: 30 }, 4000), null);
    assert.equal(getTodoReminderIntervalMs({ isEnabled: true, reminderMinutes: 0 }, 4000), null);
  });

  it('the text is factual and asks for no reply (D14)', () => {
    assert.equal(
      buildTodoReminderText(nowMs - 72 * minuteMs, nowMs),
      '[Todo] Your published todo list was last updated 72 min ago and you have worked since. todo_update records in-work / queued / done; with no items it confirms the list is still accurate. No text reply is needed.',
    );
    assert.match(buildTodoReminderText(undefined, nowMs), /^\[Todo\] You have not published a todo list yet and you have been working\. todo_update/);
  });
});

describe('the registry\'s reminder bookkeeping', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-nag-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function createRegistry() {
    return createTodoRegistry({ store: new TodoStore(dataDir, () => nowMs), getNowMs: () => nowMs });
  }

  it('work before the first turn end after an update never counts; after it, it does — and survives a new registry', () => {
    const registry = createRegistry();
    registry.updateTodos(topicKey, { items: [{ title: 'A', status: 'inWork' }] });
    registry.addTurnWork(topicKey, 2 * intervalMs);
    registry.noteTurnEnd(topicKey, nowMs);
    assert.equal(registry.takePromptReminder(topicKey, intervalMs, nowMs), null, 'the update turn\'s own work is not counted');
    registry.addTurnWork(topicKey, intervalMs / 2);
    registry.addTurnWork(topicKey, intervalMs / 2);
    assert.match(registry.takePromptReminder(topicKey, intervalMs, nowMs) ?? '', /^\[Todo\]/, 'unsaved work counts toward form a');
    assert.equal(registry.takePromptReminder(topicKey, intervalMs, nowMs), null, 'a reminder starts the count afresh');
    registry.addTurnWork(topicKey, intervalMs);
    registry.noteTurnEnd(topicKey, nowMs);
    assert.equal(createRegistry().getTopic(topicKey).nag?.workedMs, intervalMs, 'the work is stored at the turn end');
  });

  it('two ignored reminders silence it; a person writing or an update lifts the silence', () => {
    const registry = createRegistry();
    registry.noteTurnEnd(topicKey, nowMs);
    const remindAfterWork = (): boolean => {
      registry.addTurnWork(topicKey, intervalMs);
      const decision = registry.decideStandaloneReminder(topicKey, intervalMs, openGate, nowMs);
      if (decision.shouldRemind) registry.noteReminderDelivered(topicKey, nowMs);
      return decision.shouldRemind;
    };
    assert.deepEqual([remindAfterWork(), remindAfterWork(), remindAfterWork()], [true, true, false]);
    const silenced = registry.decideStandaloneReminder(topicKey, intervalMs, openGate, nowMs);
    assert.deepEqual({ isStale: silenced.isStale, shouldRemind: silenced.shouldRemind }, { isStale: true, shouldRemind: false });
    registry.notePersonActivity(topicKey);
    assert.equal(remindAfterWork(), true, 'a person writing ends the silence');
    remindAfterWork();
    registry.updateTodos(topicKey, {});
    assert.deepEqual(registry.getTopic(topicKey).nag, createTodoNagState(), 'an update resets everything');
  });

  it('a person writing in a conversation that never ignored a reminder writes nothing', () => {
    const registry = createRegistry();
    registry.notePersonActivity(topicKey);
    assert.equal(fs.existsSync(path.join(dataDir, 'todos')), false);
  });
});

describe('the reminder poll', () => {
  let dataDir: string;
  let clockMs: number;
  let probe: SessionTurnProbe;
  let posted: string[];
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-engine-'));
    clockMs = nowMs;
    probe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
    posted = [];
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function createEngine(options: { gate?: Partial<TodoStandaloneGate>; isPosted?: boolean } = {}) {
    const registry = createTodoRegistry({ store: new TodoStore(dataDir, () => clockMs), getNowMs: () => clockMs });
    const engine = new TodoReminderEngine({
      registry,
      listConversations: () => [topicKey],
      probeTurn: () => probe,
      getGate: () => ({ hasOpenRequest: false, isAnswerTailFollowed: false, isLimited: false, isApiBilled: false, ...options.gate }),
      getIntervalMs: () => intervalMs,
      checkIsEnabled: () => true,
      postReminder: async (_key, text) => {
        posted.push(text);
        return options.isPosted ?? true;
      },
      now: () => clockMs,
      pollIntervalMs: minuteMs,
    });
    return { engine, registry };
  }

  /** Busy polls a minute apart for a whole interval: the agent worked it. */
  async function workOneInterval(engine: TodoReminderEngine): Promise<void> {
    for (let minute = 0; minute < intervalMs / minuteMs; minute += 1) await pollAt(engine, minuteMs, true);
  }

  /** One poll `elapsedMs` after the last, with the session `isBusy`. */
  async function pollAt(engine: TodoReminderEngine, elapsedMs: number, isBusy: boolean): Promise<void> {
    clockMs += elapsedMs;
    probe = { ...probe, isBusy };
    await engine.poll();
  }

  it('a busy → idle edge is a turn end: the clock starts, busy polls count, a stale end posts ONE reminder', async () => {
    const { engine, registry } = createEngine();
    await engine.poll();
    await pollAt(engine, minuteMs, true);
    await pollAt(engine, minuteMs, false);
    assert.equal(registry.getTopic(topicKey).nag?.clockStartedAt, clockMs, 'the first turn end starts the clock');
    await workOneInterval(engine);
    assert.deepEqual(posted, [], 'nothing while the turn runs');
    await pollAt(engine, minuteMs, false);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /^\[Todo\] You have not published a todo list yet/);
    assert.equal(registry.getTopic(topicKey).nag?.ignoredCount, 1);
    await pollAt(engine, minuteMs, false);
    assert.equal(posted.length, 1, 'an idle poll is no turn end');
  });

  it('a turn shorter than a poll is still seen ending once its output was noted', async () => {
    const { engine, registry } = createEngine();
    await engine.poll();
    engine.noteAgentOutput(topicKey);
    await pollAt(engine, minuteMs, false);
    assert.notEqual(registry.getTopic(topicKey).nag?.clockStartedAt, undefined);
  });

  it('a held turn end (unread input, a question) ends at a later poll; a late poll counts at most three intervals', async () => {
    const { engine, registry } = createEngine();
    await engine.poll();
    await pollAt(engine, minuteMs, true);
    probe = { ...probe, hasUnconsumedInput: true };
    await pollAt(engine, minuteMs, false);
    assert.equal(registry.getTopic(topicKey).nag, undefined, 'not an end yet');
    probe = { ...probe, hasUnconsumedInput: false };
    await pollAt(engine, minuteMs, false);
    assert.notEqual(registry.getTopic(topicKey).nag?.clockStartedAt, undefined, 'the end, once nothing holds it');
    await pollAt(engine, minuteMs, true);
    await pollAt(engine, 10 * intervalMs, true);
    await pollAt(engine, minuteMs, false);
    assert.equal(registry.getTopic(topicKey).nag?.workedMs, 4 * minuteMs, 'a suspended host\'s gap is not work');
  });

  it('a gate holds a stale reminder back with one log line; a post that did not land counts nothing', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => { logs.push(line); };
    try {
      const { engine, registry } = createEngine({ gate: { isLimited: true } });
      await engine.poll();
      await pollAt(engine, minuteMs, true);
      await pollAt(engine, minuteMs, false);
      await workOneInterval(engine);
      await pollAt(engine, minuteMs, false);
      assert.deepEqual(posted, []);
      assert.ok(logs.some((line) => line.includes('stale list, no reminder: the account or model is limited')), logs.join('\n'));
      assert.equal(registry.getTopic(topicKey).nag?.ignoredCount, 0);
    } finally {
      console.log = originalLog;
    }
    const failed = createEngine({ isPosted: false });
    fs.rmSync(path.join(dataDir, 'todos'), { recursive: true, force: true });
    await failed.engine.poll();
    await pollAt(failed.engine, minuteMs, true);
    await pollAt(failed.engine, minuteMs, false);
    await workOneInterval(failed.engine);
    await pollAt(failed.engine, minuteMs, false);
    assert.equal(posted.length, 1, 'it tried');
    assert.equal(failed.registry.getTopic(topicKey).nag?.ignoredCount, 0, 'not counted as delivered');
  });
});

describe('settings.json todo, the idle-only post and the settings screen', () => {
  let configDir: string;
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-settings-'));
    resetInstanceSettingsCache();
  });
  afterEach(() => fs.rmSync(configDir, { recursive: true, force: true }));

  it('the reader fills in on and an hour; the file\'s keys win; a broken file reads as the defaults with one error line', () => {
    const filePath = path.join(configDir, 'settings.json');
    const errors: string[] = [];
    const read = createTodoSettingsReader(() => filePath, (line) => errors.push(line));
    assert.deepEqual(read(), { isEnabled: true, reminderMinutes: 60 });
    assert.equal(saveInstanceSettingsChange(filePath, { todo: { isEnabled: false, reminderMinutes: null } }), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { todo: { isEnabled: false } }, 'only what was set is written');
    assert.deepEqual(read(), { isEnabled: false, reminderMinutes: 60 });
    fs.writeFileSync(filePath, JSON.stringify({ todo: { reminderMinutes: -5 } }));
    assert.deepEqual(read(), { isEnabled: true, reminderMinutes: 60 });
    read();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /settings\.json todo\.reminderMinutes/);
  });

  it('two readers of one broken file log ONE line between them: the todo reader adds no second error', () => {
    const filePath = path.join(configDir, 'settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ defaultEffort: 'enormous' }));
    const errors: string[] = [];
    const readEffort = createInstanceDefaultEffortReader(() => filePath, (line) => errors.push(line));
    const readTodo = createTodoSettingsReader(() => filePath, (line) => errors.push(line));
    assert.equal(readEffort(), null);
    assert.deepEqual(readTodo(), { isEnabled: true, reminderMinutes: 60 });
    readEffort();
    assert.equal(errors.length, 1, errors.join('\n'));
  });

  it('an unknown key under todo is refused by name; the settings round-trip through save', () => {
    const filePath = path.join(configDir, 'settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ todo: { isEnabeld: true } }));
    const load = loadInstanceSettings(filePath);
    assert.equal(load.status, 'invalid');
    saveInstanceSettings(filePath, { ...createEmptyInstanceSettings(), todo: { isEnabled: true, reminderMinutes: 30 } });
    resetInstanceSettingsCache();
    const reloaded = loadInstanceSettings(filePath);
    assert.ok(reloaded.status !== 'invalid' && reloaded.config.todo.reminderMinutes === 30);
  });

  it('the idle-only post never forwards into a session that is not idle, and reports a forward that threw', async () => {
    let forwarded = 0;
    assert.equal(await postToIdleSession({ checkIsIdle: () => false, forward: async () => { forwarded += 1; } }), false);
    assert.equal(forwarded, 0);
    assert.equal(await postToIdleSession({ checkIsIdle: () => true, forward: async () => { forwarded += 1; } }), true);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await postToIdleSession({ checkIsIdle: () => true, forward: async () => { throw new Error('gone'); } }), false);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(forwarded, 1);
  });

  it('the settings screen: on with its intervals and ✓, off with only the switch; General points to the settings', () => {
    const on = renderTodoSettingsScreen({ isEnabled: true, reminderMinutes: 120 });
    assert.equal(on.text, 'Todo settings\n\nShared todo lists: on\nReminder when a list is stale: 2 h');
    assert.deepEqual(on.rows.map((row) => row.map((button) => `${button.label}|${button.data}`)), [
      ['Turn off|todo_off'],
      ['off|todo_rem_0', '30 min|todo_rem_30', '1 h|todo_rem_60', '✓ 2 h|todo_rem_120', '4 h|todo_rem_240'],
      ['‹ Back|todo_general'],
    ]);
    const off = renderTodoSettingsScreen({ isEnabled: false, reminderMinutes: 0 });
    assert.equal(off.text, 'Todo settings\n\nShared todo lists: off');
    assert.deepEqual(off.rows.map((row) => row.map((button) => button.data)), [['todo_on'], ['todo_general']]);
    assert.equal(renderTodoSettingsScreen({ isEnabled: true, reminderMinutes: 45 }).text.split('\n')[3], 'Reminder when a list is stale: 45 min');
    assert.match(renderTodoGeneralScreen({ isEnabled: false, reminderMinutes: 60 }, []).text, /^📋 Todo — all projects\n\nShared todo lists are off/);
  });
});
