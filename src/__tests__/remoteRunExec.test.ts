/**
 * @description `exec` and the exit code of the command. ssh reports 255 for ITS OWN failures, so a command that really exits 255 (ssh and
 * adb do) used to be taken for a lost connection and turned into 125 — against the plan, which says `exec` passes the command's code
 * through. The runner now ends the command's stderr with a marker carrying the code; `runExec` takes it out of what the user sees and
 * treats 255 as a lost connection only when the marker is missing (the session died before the command ended).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { describeKillResult } from '../remoteRun/commands';
import { describeEnd, runExec } from '../remoteRun/foreground';
import { createExitMarkerFilter } from '../remoteRun/output';
import type { CliIo } from '../remoteRun/output';
import type { RunnerClient } from '../remoteRun/runnerClient';

const marker = (code: number): string => `\u001eremote-run-exit:${code}\n`;

function runFilter(chunks: readonly string[]): { forwarded: string; exitCode: number | null } {
  let forwarded = '';
  const filter = createExitMarkerFilter((text) => { forwarded += text; });
  for (const chunk of chunks) filter.write(chunk);
  filter.flush();
  return { forwarded, exitCode: filter.getExitCode() };
}

describe('createExitMarkerFilter', () => {
  it('takes the marker out and hands on everything else, in order', () => {
    assert.deepEqual(runFilter([`some stderr\nmore\n${marker(255)}`]), { forwarded: 'some stderr\nmore\n', exitCode: 255 });
    assert.deepEqual(runFilter([marker(0)]), { forwarded: '', exitCode: 0 });
  });

  it('however the stream is cut, even inside the marker, the same text and code come out', () => {
    const whole = `before\nerror: x\n${marker(137)}`;
    for (let cut = 1; cut < whole.length; cut += 1) {
      assert.deepEqual(runFilter([whole.slice(0, cut), whole.slice(cut)]), { forwarded: 'before\nerror: x\n', exitCode: 137 }, `cut at ${cut}`);
    }
    assert.deepEqual(runFilter([...whole]), { forwarded: 'before\nerror: x\n', exitCode: 137 }, 'one character at a time');
  });

  it('no marker: nothing is taken out and there is no code — the session died before the command ended', () => {
    assert.deepEqual(runFilter(['just stderr\n', 'and more']), { forwarded: 'just stderr\nand more', exitCode: null });
  });

  it('a stray RS character in the output is handed on (at the latest when the stream ends), not swallowed', () => {
    assert.deepEqual(runFilter(['a\u001eb\n']), { forwarded: 'a\u001eb\n', exitCode: null });
    assert.deepEqual(runFilter(['tail\u001e']), { forwarded: 'tail\u001e', exitCode: null });
  });

  it('a command that printed something marker-like earlier does not hide the real marker: the LAST one is the code', () => {
    const result = runFilter([`${marker(1)}output after\n${marker(7)}`]);
    assert.equal(result.exitCode, 7);
    assert.equal(result.forwarded, 'output after\n');
  });

  it('output flows at once, it is not held until the end: only a begun marker waits', () => {
    const seen: string[] = [];
    const filter = createExitMarkerFilter((text) => seen.push(text));
    filter.write('progress 1\n');
    assert.deepEqual(seen, ['progress 1\n']);
    filter.write('progress 2\u001eremote-');
    assert.deepEqual(seen, ['progress 1\n', 'progress 2'], 'the begun marker is held back, what is before it is not');
    filter.write('run-exit:3\n');
    assert.equal(filter.getExitCode(), 3);
    assert.deepEqual(seen, ['progress 1\n', 'progress 2']);
  });
});

/** A client whose `exec` ssh session is `script` run by bash. */
function createClientWhoseExecRuns(script: string): RunnerClient {
  const refuse = (): never => {
    throw new Error('not used by exec');
  };
  return {
    runner: { name: 'box1', ssh: 'u@box1.example', workDir: '/w' },
    cacheDir: '/unused',
    rsyncSshCommand: 'ssh',
    ensureScript: async () => {},
    getAbsoluteWorkDir: refuse,
    call: refuse,
    callOrThrow: refuse,
    stream: () => spawn('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] }),
  };
}

async function execWith(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, cwd: '/', env: {}, homeDir: '/' };
  const code = await runExec({ client: createClientWhoseExecRuns(script), slug: 'app-1', subfolder: '', command: 'ignored', io, leaseMs: 60_000 });
  return { code, stdout, stderr };
}

describe('runExec', () => {
  it('a command that exits 255 returns 255 — its own code, not a lost connection', async () => {
    const result = await execWith(`echo out; echo err >&2; printf '\\036remote-run-exit:255\\n' >&2; exit 255`);
    assert.equal(result.code, 255);
    assert.equal(result.stdout, 'out\n');
    assert.equal(result.stderr, 'err\n', 'the marker is not shown to the user');
  });

  it('a session that ends with 255 and NO marker is a lost connection: 125, with the message', async () => {
    const result = await execWith('echo partial; exit 255');
    assert.equal(result.code, 125);
    assert.match(result.stderr, /remote-run: the connection to box1 failed while the command ran/);
  });

  it('a session killed before the command ended is a lost connection too', async () => {
    const result = await execWith('kill -9 $$');
    assert.equal(result.code, 125);
  });

  it('every other code passes through, with or without the marker', async () => {
    assert.equal((await execWith(`printf '\\036remote-run-exit:9\\n' >&2; exit 9`)).code, 9);
    assert.equal((await execWith(`printf '\\036remote-run-exit:0\\n' >&2; exit 0`)).code, 0);
    assert.equal((await execWith('exit 3')).code, 3, 'a script that predates the marker');
  });
});

describe('describeEnd', () => {
  function describeWith(runnerStderr: string | undefined): { lines: string; exitCode: number } {
    let lines = '';
    const io = { stderr: (text: string) => { lines += text; } };
    const exitCode = runnerStderr === undefined
      ? describeEnd({ state: 'unknown' }, 'box1-aaaaa1', io)
      : describeEnd({ state: 'unknown' }, 'box1-aaaaa1', io, runnerStderr);
    return { lines, exitCode };
  }

  it('a job the runner refused at once says what the runner said — its last line, without the script\'s prefix', () => {
    const { lines, exitCode } = describeWith('Warning: something\nremote-run-runner: pueue add failed (does the group "x" exist on this runner?)\n');
    assert.equal(exitCode, 125);
    assert.match(lines, /the runner said: pueue add failed \(does the group "x" exist on this runner\?\)\n/);
    assert.match(lines, /the state of job box1-aaaaa1 is unknown \(unknown\)/);
  });

  it('with nothing from the runner (or only blank lines) it keeps to the state line', () => {
    assert.ok(!describeWith(undefined).lines.includes('the runner said'));
    assert.ok(!describeWith('\n  \n').lines.includes('the runner said'));
  });

  it('a job that ended (done) never repeats the runner\'s stderr — its own reason is the whole story', () => {
    let lines = '';
    const exitCode = describeEnd({ state: 'done', code: 4, reason: 'exit' }, 'box1-aaaaa1', { stderr: (text) => { lines += text; } }, 'remote-run-runner: stale warning\n');
    assert.equal(exitCode, 4);
    assert.equal(lines, '');
  });
});

describe('describeKillResult', () => {
  it('a kill that happened says killed', () => {
    assert.equal(describeKillResult('box1-aaaaa2', 'killed\n'), 'job box1-aaaaa2 killed');
  });

  it('a job that had finished first is not reported as killed: it says it had already ended, with its code', () => {
    assert.equal(describeKillResult('box1-aaaaa2', 'already-ended 4\n'), 'job box1-aaaaa2 had already ended (exit 4) — nothing to kill');
    assert.equal(describeKillResult('box1-aaaaa2', 'already-ended 0\n'), 'job box1-aaaaa2 had already ended (exit 0) — nothing to kill');
  });
});
