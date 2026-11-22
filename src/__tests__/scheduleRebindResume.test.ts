/**
 * @description Resuming the jobs a conversation's unbound pause parked (`scheduler/rebindResume.ts`): the one unit a Telegram
 * topic's `/bind` and a Jira issue's next usable bind both run — next run counted from now (no catch-up), a passed one-shot
 * dropped, one announcement with the count. The bot's wiring of it (a notice in a topic, a log line on an issue, the Jira bind step)
 * is proven by `jiraScheduleE2e`'s paused-folder case.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resumeSchedulesPausedForUnbound, type RebindResumePorts } from '../scheduler/rebindResume';
import type { ScheduleRecord } from '../scheduler/types';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
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
