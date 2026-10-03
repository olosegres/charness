/**
 * @description The Jira trigger log (plan J5, D12): a decided trigger stays
 * decided after a restart, the run budget counts requests in a rolling 24 h,
 * and a line that cannot be written is reported, never indexed.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JiraTriggerLog, jiraTriggerLogFileName } from '../connectors/jira/triggerLog';

const hourMs = 60 * 60 * 1000;
const nowMs = Date.parse('2026-10-03T12:00:00Z');

describe('JiraTriggerLog', () => {
  let dataDir = '';
  let logPath = '';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-trigger-log-'));
    logPath = path.join(dataDir, jiraTriggerLogFileName);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createLoadedLog(): Promise<JiraTriggerLog> {
    const log = JiraTriggerLog.createForDataDir(logPath);
    await log.load();
    return log;
  }

  it('a recorded trigger is seen — by a fresh instance after a restart too', async () => {
    const log = await createLoadedLog();
    assert.equal(log.record({ issueKey: 'PROJ-12', triggerId: '100', outcome: 'request', at: nowMs, requestId: 'req_1' }), true);
    assert.equal(log.checkIsSeen('PROJ-12', '100'), true);
    const reloaded = await createLoadedLog();
    assert.equal(reloaded.checkIsSeen('PROJ-12', '100'), true);
    assert.equal(reloaded.checkIsSeen('PROJ-12', '101'), false, 'another trigger of the same issue is new');
    assert.equal(reloaded.checkIsSeen('PROJ-13', '100'), false, 'trigger ids are per issue');
  });

  it('the budget counts only requests of the last 24 h, per issue', async () => {
    const log = await createLoadedLog();
    log.record({ issueKey: 'PROJ-12', triggerId: '1', outcome: 'request', at: nowMs - 25 * hourMs });
    log.record({ issueKey: 'PROJ-12', triggerId: '2', outcome: 'request', at: nowMs - 23 * hourMs });
    log.record({ issueKey: 'PROJ-12', triggerId: '3', outcome: 'parked', at: nowMs - hourMs });
    log.record({ issueKey: 'PROJ-12', triggerId: '4', outcome: 'selfAuthored', at: nowMs - hourMs });
    log.record({ issueKey: 'PROJ-13', triggerId: '5', outcome: 'request', at: nowMs - hourMs });
    assert.equal(log.getRequestCountLastDay('PROJ-12', nowMs), 1);
    assert.equal((await createLoadedLog()).getRequestCountLastDay('PROJ-12', nowMs), 1, 'the same after a reload');
  });

  it('unreadable lines are skipped; the rest still load', async () => {
    fs.writeFileSync(logPath, [
      '{not json',
      JSON.stringify({ issueKey: 'PROJ-12', triggerId: '100', outcome: 'mystery', at: nowMs }),
      JSON.stringify({ issueKey: 'PROJ-12', triggerId: '101', outcome: 'request', at: nowMs }),
    ].join('\n'));
    const log = await createLoadedLog();
    assert.equal(log.checkIsSeen('PROJ-12', '100'), false);
    assert.equal(log.checkIsSeen('PROJ-12', '101'), true);
  });

  it('a line that cannot be written is reported and not indexed', async () => {
    const log = await createLoadedLog();
    // The log's own path taken by a folder: every append fails.
    fs.mkdirSync(logPath);
    assert.equal(log.record({ issueKey: 'PROJ-12', triggerId: '100', outcome: 'request', at: nowMs }), false);
    assert.equal(log.checkIsSeen('PROJ-12', '100'), false);
    assert.equal(log.getRequestCountLastDay('PROJ-12', nowMs), 0);
  });

  it('a log that cannot be read fails the load (the start stops) instead of forgetting every trigger', async () => {
    const blocked = path.join(dataDir, 'a-file');
    fs.writeFileSync(blocked, '');
    await assert.rejects(JiraTriggerLog.createForDataDir(path.join(blocked, jiraTriggerLogFileName)).load(), /ENOTDIR/);
  });
});
