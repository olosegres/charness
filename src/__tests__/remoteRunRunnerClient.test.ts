/**
 * @description `remoteRun/runnerClient.ts` and `output.ts`: how an ssh failure is worded (never the whole stderr — it may quote the
 * destination — and the two failures an operator can fix by hand named plainly), the runner script's name that carries a hash of its
 * text (so two versions of charness never clash on one runner), and how a job's output is routed: its own lines to stdout, remote-run's
 * `remote-run: …` lines to stderr, whatever the chunking.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createJobOutputRouter, ownLinePrefix, sayOwn } from '../remoteRun/output';
import { describeSshFailure, getRunnerScriptPath, readRunnerScript } from '../remoteRun/runnerClient';

const failure = (stderr: string, overrides: { exitCode?: number | null; isTimedOut?: boolean } = {}) => ({ exitCode: 255, stdout: '', stderr, isTimedOut: false, ...overrides });

describe('describeSshFailure', () => {
  it('a deadline that passed', () => {
    assert.equal(describeSshFailure(failure('', { exitCode: null, isTimedOut: true })), 'ssh: the command ran past its deadline');
  });

  it('an unknown host key says to connect once by hand', () => {
    assert.match(describeSshFailure(failure('Host key verification failed.\n')), /the host key is not trusted yet — connect once by hand/);
  });

  it('a rejected key is named', () => {
    assert.equal(describeSshFailure(failure('runner@host: Permission denied (publickey).\n')), 'ssh: the key was rejected (permission denied)');
  });

  it('otherwise the last line of stderr, cut when long; with no stderr, the exit status', () => {
    assert.equal(describeSshFailure(failure('warning: first\nssh: connect to host x port 22: Connection refused\n')), 'ssh: connect to host x port 22: Connection refused');
    assert.equal(describeSshFailure(failure(`ssh: ${'x'.repeat(300)}`)).length, 201);
    assert.equal(describeSshFailure(failure('', { exitCode: 3 })), 'ssh exited with 3');
    assert.equal(describeSshFailure(failure('', { exitCode: null })), 'ssh exited with a signal');
  });
});

describe('the runner script', () => {
  it('is remoteRun/runner.sh at the package root, named by a hash of its text', () => {
    assert.equal(path.basename(getRunnerScriptPath()), 'runner.sh');
    assert.ok(fs.existsSync(getRunnerScriptPath()));
    const script = readRunnerScript();
    assert.match(script.name, /^runner-[0-9a-f]{8}\.sh$/);
    assert.equal(script.text, fs.readFileSync(getRunnerScriptPath(), 'utf8'));
  });

  it('another text is another name, the same text the same name', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-name-'));
    try {
      const first = path.join(directory, 'a.sh');
      const second = path.join(directory, 'b.sh');
      fs.writeFileSync(first, '#!/bin/sh\necho one\n');
      fs.writeFileSync(second, '#!/bin/sh\necho two\n');
      assert.notEqual(readRunnerScript(first).name, readRunnerScript(second).name);
      assert.equal(readRunnerScript(first).name, readRunnerScript(first).name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the job output router', () => {
  function route(chunks: string[]): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const router = createJobOutputRouter({ stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    for (const chunk of chunks) router.write(chunk);
    router.flush();
    return { out, err };
  }

  it('the job\'s lines go to stdout, remote-run\'s own to stderr, in whole lines', () => {
    const { out, err } = route([`first\n${ownLinePrefix}waiting for job x\nsecond\n`]);
    assert.deepEqual(out, ['first\n', 'second\n']);
    assert.deepEqual(err, [`${ownLinePrefix}waiting for job x\n`]);
  });

  it('a line split across chunks is joined before it is routed, even inside the prefix', () => {
    const { out, err } = route(['par', 'tial li', 'ne\nremote-', 'run: own', ' line\n']);
    assert.deepEqual(out, ['partial line\n']);
    assert.deepEqual(err, ['remote-run: own line\n']);
  });

  it('flush gives out a last line that had no newline, to the stream it belongs to', () => {
    assert.deepEqual(route(['tail without newline']).out, ['tail without newline']);
    assert.deepEqual(route([`${ownLinePrefix}last words`]).err, [`${ownLinePrefix}last words`]);
    assert.deepEqual(route([]), { out: [], err: [] });
  });

  it('sayOwn writes one prefixed line to stderr', () => {
    const err: string[] = [];
    sayOwn({ stderr: (text) => err.push(text) }, 'hello');
    assert.deepEqual(err, ['remote-run: hello\n']);
  });
});
