/**
 * @description Coverage for `src/selfUpdate/commandRunner.ts` — the real runner the sources use: it never throws, tells
 * a failed exit from a deadline kill from a command that cannot start, and `getOutputTail` keeps the last lines for a message.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getOutputTail, runCommand } from '../selfUpdate/commandRunner';

test('a command that succeeds: its stdout, exit 0', async () => {
  const result = await runCommand(process.execPath, ['-e', 'console.log("hello")'], { timeoutMs: 20_000 });
  assert.deepEqual(result, { ok: true, exitCode: 0, stdout: 'hello\n', stderr: '', isTimedOut: false });
});

test('a failing exit keeps its code and both streams', async () => {
  const result = await runCommand(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { timeoutMs: 20_000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.isTimedOut, false);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
});

test('a command that outlives its deadline is killed and reported as timed out', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.isTimedOut, true);
  assert.equal(result.exitCode, null);
});

test('a command that cannot start is a result, not a throw', async () => {
  const result = await runCommand('/no/such/binary-charness', [], { timeoutMs: 5_000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.isTimedOut, false);
  assert.match(result.stderr, /ENOENT/);
});

test('the env and cwd reach the child', async () => {
  const result = await runCommand(process.execPath, ['-e', 'console.log(process.env.CHARNESS_PROBE, process.cwd())'], {
    timeoutMs: 20_000,
    env: { PATH: process.env.PATH, CHARNESS_PROBE: 'yes' },
    cwd: '/tmp',
  });
  assert.equal(result.stdout, 'yes /tmp\n');
});

test('the output tail is the last non-empty lines, stderr first then stdout', () => {
  const tail = getOutputTail({ ok: false, exitCode: 1, stdout: 'a\nb\n\nc\n', stderr: 'x\ny\n', isTimedOut: false }, 3);
  assert.equal(tail, 'a\nb\nc');
  assert.equal(getOutputTail({ ok: false, exitCode: 1, stdout: '', stderr: 'only\n', isTimedOut: false }), 'only');
});
