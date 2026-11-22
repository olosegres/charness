/**
 * @description Resuming the jobs a conversation's unbound pause parked (`scheduler/rebindResume.ts`): the one unit a Telegram
 * topic's `/bind` and a Jira issue's next usable bind both run — next run counted from now (no catch-up), a passed one-shot
 * dropped, one announcement with the count — and the bot's own wiring of it (a notice in a topic, a log line on an issue).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { resumeSchedulesPausedForUnbound, type RebindResumePorts } from '../scheduler/rebindResume';
import type { ScheduleRecord } from '../scheduler/types';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';

const nowMs = Date.parse('2026-06-07T10:00:00.000Z');
const issueKey = makeJiraKey('PROJ-12');

function makeJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'watch-abc123',
    threadKey: keyToString(issueKey),
    name: 'watch',
    spec: { kind: 'cron', cronExpr: '0 * * * *' },
    prompt: 'p',
    createdBy: 'agent',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    nextRunAt: null,
    isPaused: true,
    pauseReason: 'unbound',
    ...overrides,
  };
}

function createPorts(records: ScheduleRecord[]) {
  const log: string[] = [];
  const upserted: ScheduleRecord[] = [];
  const ports: RebindResumePorts = {
    listThreadSchedules: () => records,
    removeSchedule: async (jobId) => { log.push(`remove ${jobId}`); },
    upsertSchedule: async (record) => { upserted.push(record); log.push(`upsert ${record.id}`); },
    armJob: (record) => { log.push(`arm ${record.id}`); },
    disarmJob: (jobId) => { log.push(`disarm ${jobId}`); },
    announceResumed: async (count) => { log.push(`announce ${count}`); },
    now: () => nowMs,
  };
  return { ports, log, upserted };
}

describe('resumeSchedulesPausedForUnbound', () => {
  it('a paused cron job is un-paused with its next run counted from now, re-armed, and announced once with the count', async () => {
    const { ports, log, upserted } = createPorts([makeJob(), makeJob({ id: 'second-def456' })]);
    assert.equal(await resumeSchedulesPausedForUnbound(ports, issueKey), 2);
    assert.deepEqual(log, ['upsert watch-abc123', 'arm watch-abc123', 'upsert second-def456', 'arm second-def456', 'announce 2']);
    for (const record of upserted) {
      assert.equal(record.nextRunAt, Date.parse('2026-06-07T11:00:00.000Z'), 'the next hour from NOW — a missed window is not replayed');
      assert.equal(record.isPaused, undefined);
      assert.equal(record.pauseReason, undefined);
      assert.equal(record.updatedAt, new Date(nowMs).toISOString());
    }
  });

  it('a one-shot whose instant passed while paused is dropped and disarmed, not counted; with nothing resumed there is no announcement', async () => {
    const { ports, log } = createPorts([makeJob({ id: 'once-abc123', spec: { kind: 'once', onceAtIso: '2026-06-07T09:00:00.000Z' } })]);
    assert.equal(await resumeSchedulesPausedForUnbound(ports, issueKey), 0);
    assert.deepEqual(log, ['remove once-abc123', 'disarm once-abc123']);
  });

  it('a future one-shot is resumed at its own instant', async () => {
    const { ports, upserted } = createPorts([makeJob({ id: 'later-abc123', spec: { kind: 'once', onceAtIso: '2026-06-07T12:30:00.000Z' } })]);
    assert.equal(await resumeSchedulesPausedForUnbound(ports, issueKey), 1);
    assert.equal(upserted[0].nextRunAt, Date.parse('2026-06-07T12:30:00.000Z'));
  });

  it('jobs that are not paused for the folder are left alone: running ones, and a conversation with none paused', async () => {
    const { ports, log } = createPorts([makeJob({ id: 'running-abc123', isPaused: undefined, pauseReason: undefined, nextRunAt: nowMs + 1000 })]);
    assert.equal(await resumeSchedulesPausedForUnbound(ports, issueKey), 0);
    assert.deepEqual(log, []);
  });
});

describe('the bot wires the resume for both platforms', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

  it('a topic\'s /bind announces with its notice; an issue\'s resume is a log line, and nothing is posted on it', () => {
    assert.match(botSource, /async function resumeThreadSchedulesOnRebind\(key: SessionKey\): Promise<void> \{\s*await resumeSchedulesPausedForUnbound\(\s*createRebindResumePorts\(\(count\) => replyToThread\(key, t\('schedule\.resumedRebind', \{ count \}\)\)/);
    const tracker = botSource.slice(botSource.indexOf('async function resumeTrackerSchedulesOnRebind('));
    const body = tracker.slice(0, tracker.indexOf('\n}\n'));
    assert.ok(body.includes('console.log('), body);
    assert.ok(!body.includes('replyToThread'), 'no notice on an issue');
  });

  it('the Jira connector\'s bind step resumes the parked jobs once the folder resolves — after the binding is written, never before', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    const bind = deps.slice(deps.indexOf('bindConversation: async (key, folder) => {'), deps.indexOf('createRequest:'));
    const setBinding = bind.indexOf('await state.setBinding(key, folder);');
    const usable = bind.indexOf("resolveBoundWorkDir(ENV.workRoot, state.getBinding(key)).kind === 'proceed'");
    const resume = bind.indexOf('await resumeTrackerSchedulesOnRebind(key)');
    assert.ok(setBinding > 0 && usable > setBinding && resume > usable, bind);
  });

  it('a fire that finds no usable folder pauses the job: a Telegram topic is told, an issue gets a log line', () => {
    const deliver = botSource.slice(botSource.indexOf('const deliver = async (job: ScheduleRecord, fireContext: FireContext)'), botSource.indexOf('schedulerEngine = createSchedulerEngine({'));
    assert.match(deliver, /if \(checkIsTelegramKey\(key\)\) await withThreadLocale\(key, \(\) => replyToThread\(key, t\('schedule\.pausedUnbound', \{ count: 1 \}\)\)\)\.catch\(\(\) => \{\}\);\s*else console\.log\(/);
  });

  it('the topic key is a Telegram key and the issue key is not (the premise of the split)', () => {
    assert.equal(makeTelegramKey(-1001234567890, 42).platform, 'telegram');
    assert.equal(issueKey.platform, 'jira');
  });
});
