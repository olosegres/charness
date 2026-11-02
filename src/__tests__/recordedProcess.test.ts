/**
 * @description The helper every test cleanup kills a stand-in process through (`recordedProcess.ts`): a pid file that is empty, half written
 * or odd must never become a pid that signals a whole group (`kill(0)`) or init (`kill(1)`), and a real recorded process is killed.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { killRecordedProcess, readRecordedPid } from './recordedProcess';

let directory = '';
const children: ChildProcess[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-pid-'));
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeRecord(content: string): string {
  const pidFile = path.join(directory, 'record.pid');
  fs.writeFileSync(pidFile, content);
  return pidFile;
}

describe('a pid read from a file', () => {
  it('is a whole number above 1, with the newline the shell wrote and any padding', () => {
    assert.equal(readRecordedPid(writeRecord('4242\n')), 4242);
    assert.equal(readRecordedPid(writeRecord('  17  \n')), 17);
    assert.equal(readRecordedPid(writeRecord('2')), 2);
  });

  it('is nothing when the file is missing, empty, or the shell has only just created it — the case that would have been kill(0)', () => {
    assert.equal(readRecordedPid(path.join(directory, 'absent.pid')), null);
    assert.equal(readRecordedPid(writeRecord('')), null);
    assert.equal(readRecordedPid(writeRecord('\n')), null);
  });

  it('is nothing for 0, 1, a negative number, a fraction, a number with text after it, or one too large to be exact', () => {
    for (const content of ['0', '1', '-1', '-4242', '12.5', '12abc', 'abc', '12 34', '99999999999999999999999\n', '1e3']) {
      assert.equal(readRecordedPid(writeRecord(content)), null, JSON.stringify(content));
    }
  });
});

describe('killing a recorded process', () => {
  it('kills the process whose pid was recorded, and only it', async () => {
    const recorded = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(recorded, bystander);
    const recordedExit = new Promise<NodeJS.Signals | null>((resolve) => { recorded.once('exit', (_code, signal) => resolve(signal)); });
    killRecordedProcess(writeRecord(`${recorded.pid}\n`));
    assert.equal(await recordedExit, 'SIGKILL');
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
  });

  it('does nothing — and above all does not signal this process or its group — for an empty or malformed record, or a process that is gone', () => {
    const sentTo: number[] = [];
    const realKill = process.kill;
    process.kill = ((pid: number) => { sentTo.push(pid); return true; }) as typeof process.kill;
    try {
      for (const content of ['', '0', '1', '-1', 'x']) killRecordedProcess(writeRecord(content));
      killRecordedProcess(path.join(directory, 'absent.pid'));
    } finally {
      process.kill = realKill;
    }
    assert.deepEqual(sentTo, [], 'no signal was sent to anything');
    // Above any pid the kernel hands out (pid_max is at most 2^22): such a process is gone by definition.
    assert.doesNotThrow(() => killRecordedProcess(writeRecord('2147483646')));
  });
});
