/**
 * @description Coverage for what leaving a folder does to a topic's schedules (`scheduler/unbindPause.ts`), driven over a REAL
 * `StateStore` and the real status-line clearing (`delivery.ts` `clearCheckStatusLine`, `store.ts` `recordCheckStatusLine`):
 * a paused watch never runs again, so the pause itself must take its status line out of the topic and out of its record.
 * Also the record helper: it clears only the line, keeps the time of the last one, and says when the job is gone.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createScheduleForThread, recordCheckStatusLine } from '../scheduler/store';
import { pauseSchedulesOnUnbind, type UnbindPauseDeps } from '../scheduler/unbindPause';
import type { CheckStatusLine, ScheduleRecord } from '../scheduler/types';

const topic: SessionKey = makeTelegramKey(-1001234567890, 11);
const otherTopic: SessionKey = makeTelegramKey(-1001234567890, 22);
const cronSpec = { kind: 'cron', cronExpr: '*/5 * * * *' } as const;
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
const statusLine: CheckStatusLine = { messageId: 88, postedAtMs: nowMs + 15 * 60_000 };

describe('pausing a topic\'s schedules on /unbind', () => {
  let fakeHome = '';
  let originalHome: string | undefined;
  let store: StateStore;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'unbind-pause-'));
    const dataDir = path.join(fakeHome, '.charness');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    store = new StateStore(dataDir, { saveDebounceMs: 20 });
    await store.init();
  });

  afterEach(async () => {
    await store.flush();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function seed(name: string, extra: Partial<ScheduleRecord> = {}, key: SessionKey = topic): Promise<ScheduleRecord> {
    const created = await createScheduleForThread(store, {
      threadKey: key,
      name,
      spec: cronSpec,
      prompt: `${name} body`,
      createdBy: 'agent',
      nowMs,
      ...(extra.deliveryKind !== undefined ? { deliveryKind: extra.deliveryKind } : {}),
    });
    assert.ok(created.ok);
    const record: ScheduleRecord = { ...created.record, ...extra };
    await store.upsertSchedule(record);
    return record;
  }

  /** The pause over the real store, with what it asked of the topic recorded. */
  function createPause(options: { isDeleteFailing?: boolean } = {}) {
    const events: string[] = [];
    const deletedMessageIds: number[] = [];
    const deps: UnbindPauseDeps = {
      store,
      disarmJob: (jobId) => events.push(`disarm ${jobId}`),
      statusLinePorts: {
        recordStatusLine: async (jobId, line) => {
          events.push(`record ${jobId} ${line === null ? 'cleared' : 'set'}`);
          return recordCheckStatusLine(store, jobId, line);
        },
        deleteMessage: async (_threadKey, messageId) => {
          events.push(`delete ${messageId}`);
          if (options.isDeleteFailing) throw new Error('delete boom');
          deletedMessageIds.push(messageId);
        },
      },
      announcePaused: async (count) => {
        events.push(`announce ${count}`);
      },
    };
    return { deps, events, deletedMessageIds };
  }

  it('a watch with a status line is parked and its line is deleted — from the topic and from its record', async () => {
    const watch = await seed('watch builder S2', { deliveryKind: 'check', checkCommand: 'kill -0 1', statusWorkerRunDir: '/runs/a', statusMessageId: statusLine.messageId, lastStatusAt: statusLine.postedAtMs });
    const { deps, events, deletedMessageIds } = createPause();

    assert.equal(await pauseSchedulesOnUnbind(deps, topic), 1);

    const parked = store.getSchedules()[watch.id];
    assert.equal(parked.isPaused, true);
    assert.equal(parked.pauseReason, 'unbound');
    assert.deepEqual(deletedMessageIds, [statusLine.messageId], 'the «works …» line is gone from the topic');
    assert.equal(parked.statusMessageId, undefined, 'and nothing points at it any more');
    assert.equal(parked.lastStatusAt, statusLine.postedAtMs, 'the time of the last line stays: it times the next one after a /bind');
    assert.deepEqual(events, [`disarm ${watch.id}`, `record ${watch.id} cleared`, `delete ${statusLine.messageId}`, 'announce 1'], 'record first, then the delete, then the one notice');
  });

  it('every pausable job is parked with ONE notice; a reminder and another topic\'s watch are left alone', async () => {
    const watch = await seed('watch builder S2', { deliveryKind: 'check', checkCommand: 'kill -0 1', statusMessageId: statusLine.messageId });
    const promptJob = await seed('Nightly build');
    const reminder = await seed('Take the pills', { deliveryKind: 'reminder' });
    const otherWatch = await seed('watch other', { deliveryKind: 'check', checkCommand: 'kill -0 2', statusMessageId: 99 }, otherTopic);
    const { deps, events, deletedMessageIds } = createPause();

    assert.equal(await pauseSchedulesOnUnbind(deps, topic), 2);

    assert.equal(store.getSchedules()[watch.id].isPaused, true);
    assert.equal(store.getSchedules()[promptJob.id].isPaused, true);
    assert.equal(store.getSchedules()[reminder.id].isPaused, undefined, 'a reminder needs no folder or agent');
    assert.equal(store.getSchedules()[otherWatch.id].isPaused, undefined);
    assert.equal(store.getSchedules()[otherWatch.id].statusMessageId, 99, 'the other topic\'s line is not touched');
    assert.deepEqual(deletedMessageIds, [statusLine.messageId], 'only the parked watch had a line here');
    assert.equal(events.filter((event) => event.startsWith('announce')).length, 1);
    assert.ok(events.includes('announce 2'));
  });

  it('a failing delete never stops the unbind: the job is still parked and the notice still posted', async () => {
    const watch = await seed('watch builder S2', { deliveryKind: 'check', checkCommand: 'kill -0 1', statusMessageId: statusLine.messageId });
    const { deps, events } = createPause({ isDeleteFailing: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await pauseSchedulesOnUnbind(deps, topic), 1);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(store.getSchedules()[watch.id].isPaused, true);
    assert.ok(events.includes('announce 1'));
  });

  it('a watch with no status line touches no status port; a thread of only reminders pauses nothing and posts no notice', async () => {
    const plainWatch = await seed('API health', { deliveryKind: 'check', checkCommand: 'true' });
    const first = createPause();
    assert.equal(await pauseSchedulesOnUnbind(first.deps, topic), 1);
    assert.equal(store.getSchedules()[plainWatch.id].isPaused, true);
    assert.deepEqual(first.events, [`disarm ${plainWatch.id}`, 'announce 1']);

    await seed('Take the pills', { deliveryKind: 'reminder' }, otherTopic);
    const second = createPause();
    assert.equal(await pauseSchedulesOnUnbind(second.deps, otherTopic), 0);
    assert.deepEqual(second.events, []);
  });
});

describe('recordCheckStatusLine', () => {
  let fakeHome = '';
  let originalHome: string | undefined;
  let store: StateStore;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'record-status-'));
    const dataDir = path.join(fakeHome, '.charness');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    store = new StateStore(dataDir, { saveDebounceMs: 20 });
    await store.init();
  });

  afterEach(async () => {
    await store.flush();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('sets the line and the time of the last one; clearing drops only the line; a job that is gone answers false', async () => {
    const created = await createScheduleForThread(store, { threadKey: topic, name: 'Watch', spec: cronSpec, prompt: 'p', createdBy: 'agent', nowMs });
    assert.ok(created.ok);
    const jobId = created.record.id;

    assert.equal(await recordCheckStatusLine(store, jobId, statusLine), true);
    assert.equal(store.getSchedules()[jobId].statusMessageId, statusLine.messageId);
    assert.equal(store.getSchedules()[jobId].lastStatusAt, statusLine.postedAtMs);

    assert.equal(await recordCheckStatusLine(store, jobId, null), true);
    assert.equal(store.getSchedules()[jobId].statusMessageId, undefined);
    assert.equal(store.getSchedules()[jobId].lastStatusAt, statusLine.postedAtMs, 'the next line is still timed from the last one');

    await store.removeSchedule(jobId);
    assert.equal(await recordCheckStatusLine(store, jobId, statusLine), false);
  });
});

describe('the composition root wires the pause over the one clearing', () => {
  // `bot.ts` cannot be imported by a test (its module scope parses the environment), so the seam is read from its source: the
  // unbind pause and the scheduler's delivery take the SAME status-line ports, and the pause is the tested one.
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

  it('pauseThreadSchedulesOnUnbind is pauseSchedulesOnUnbind over the shared status-line ports', () => {
    const pauseFunction = /async function pauseThreadSchedulesOnUnbind\([\s\S]*?\n}\n/.exec(botSource)?.[0] ?? '';
    assert.match(pauseFunction, /return pauseSchedulesOnUnbind\(/);
    assert.match(pauseFunction, /statusLinePorts: checkStatusLinePorts/);
    assert.doesNotMatch(pauseFunction, /setSchedulePaused/, 'no second, inline copy of the pause that would skip the status line');
  });

  it('the scheduler\'s delivery and the cancel tool delete through the same ports', () => {
    assert.match(botSource, /createScheduleDelivery\(\{\s*\.\.\.createSessionPostDeps\(\),\s*\.\.\.checkStatusLinePorts,/);
    assert.match(botSource, /deleteMessage: checkStatusLinePorts\.deleteMessage,/);
  });
});
