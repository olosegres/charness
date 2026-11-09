/**
 * @description `remoteRun/runner.sh`, the other half of the stash cases (the first is `remoteRunRunnerScriptStash.test.ts`; the two share `remoteRunRunnerScriptStashKit.ts`, split because one file ran past 70 s alone and a loaded box cut it at
 * the 2-minute cap of a unit file): a kill never acts on a Pueue number that was not
 * confirmed to be the job's own; the lease watcher's kill of a queued job that Pueue cannot answer about is tried again until Pueue answers; waiting for a job. Driven against a stand-in for Pueue that keeps its task list in files.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { scriptPath, writeFile } from './remoteRunRunnerScriptKit';
import { slug, root, workDir, pueueDir, getEnvironment, runScript, jobFolder, createJobFolder, submit, waitUntil, isStashed, readTaskId, readCalls, readTaskState, markRunning, useStashHarness } from './remoteRunRunnerScriptStashKit';

useStashHarness();

describe('a kill never acts on a Pueue number that was not confirmed to be the job\'s own', () => {
  const readExit = (jobId: string): string | null => {
    const file = path.join(jobFolder(jobId), 'exit');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  };
  const callsOn = (verb: string, task: string): string[] => readCalls().filter((call) => call === `${verb} ${task}`);
  /** Job A has no process; Pueue lost its task (a reset) and handed the number to another project's job, in `strangerState`. */
  function stageLostJobWithNumberTaken(strangerState: string): string {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), `rr-box1-zzzzzz\n${strangerState}\n`);
    return number;
  }

  it('a lost job whose number now carries ANOTHER job\'s running task: `kill` ends the lost job (137) and neither kills nor removes the stranger\'s task', () => {
    const number = stageLostJobWithNumberTaken('Running');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.deepEqual(callsOn('kill', number), [], 'no pueue kill on a number that is not ours');
    assert.deepEqual(callsOn('remove', number), [], 'no pueue remove either');
    assert.equal(readTaskState(number), 'Running', 'the stranger\'s task is as it was');
  });

  it('the same for a stranger\'s queued task: it is not removed from under its owner', () => {
    const number = stageLostJobWithNumberTaken('Queued');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.deepEqual(callsOn('remove', number), []);
    assert.equal(readTaskState(number), 'Queued');
  });

  it('a kill for a time limit (`timeout`) of a lost job is recorded as 124', () => {
    stageLostJobWithNumberTaken('Running');
    runScript(['kill', workDir, slug, 'box1-aaaaaa', 'timeout']);
    assert.equal(readExit('box1-aaaaaa'), '124');
  });

  it('a lost job that a stashed one waits behind: the kill lets that one go', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a Pueue that does not answer: the kill fails and says why, kills nothing, and marks nothing - an unconfirmed number is never acted on', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa'], { FAKE_PQ_DOWN: '1' });
    assert.notEqual(killed.status, 0);
    assert.match(killed.stderr, /Pueue did not answer/);
    assert.deepEqual(callsOn('remove', number), []);
    assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'killed')), false);
    assert.equal(readExit('box1-aaaaaa'), null);
  });

  it('a job whose process is gone (SIGKILLed, no result) and whose number is another job\'s now: `kill` does not `pueue kill` the number', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), 'rr-box1-zzzzzz\nRunning\n');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.deepEqual(callsOn('kill', number), []);
    assert.equal(readTaskState(number), 'Running');
  });

  it('...and does when the task under the number IS the job\'s own (the check does not just switch the kill off)', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), 'rr-box1-aaaaaa\nRunning\n');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.ok(callsOn('kill', number).length >= 1, 'its own task is killed');
  });
});

describe('killing', () => {
  it('a stashed job is removed from Pueue like a queued one: its task is gone, it ends with 137, its mark is gone - and the job under way is left alone', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    const task = readTaskId('box1-bbbbbb');
    const killed = runScript(['kill', workDir, slug, 'box1-bbbbbb']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readTaskState(task), null);
    assert.equal(fs.readFileSync(path.join(jobFolder('box1-bbbbbb'), 'exit'), 'utf8').trim(), '137');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.ok(fs.existsSync(path.join(jobFolder('box1-bbbbbb'), 'task-removed')));
    assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), false);
  });

  it('killing a job that is only queued, with a stashed one behind it, lets that one go (nothing else of the project is under way)', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('killing a stashed job behind a live one does not let the one behind IT go', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    submit('box1-cccccc');
    runScript(['kill', workDir, slug, 'box1-bbbbbb']);
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
  });
});

describe('waiting for a job', () => {
  it('a job that is stashed still has its task number, so `result` shows it as submitted and not started (the hub reads Pueue\'s `Stashed` as queued)', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    const facts = runScript(['result', workDir, slug, 'box1-bbbbbb']);
    assert.match(facts.stdout, new RegExp(`^task=${readTaskId('box1-bbbbbb')}$`, 'm'));
    assert.match(facts.stdout, /^has_pid=0$/m);
    assert.match(facts.stdout, /^exit=$/m);
  });

  it('two jobs added at the same moment behind a running one are both stashed, and each is enqueued in its turn', async () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    createJobFolder('box1-bbbbbb');
    createJobFolder('box1-cccccc');
    await Promise.all(['box1-bbbbbb', 'box1-cccccc'].map((jobId) => new Promise<void>((resolve) => {
      const child = spawn('bash', [scriptPath, 'submit', workDir, slug, jobId, 'default'], { env: getEnvironment(), stdio: 'ignore' });
      child.on('close', () => resolve());
    })));
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(isStashed('box1-cccccc'), true);
    assert.notEqual(readTaskId('box1-bbbbbb'), readTaskId('box1-cccccc'));
  });
});


describe('the lease watcher\'s kill of a queued job that Pueue cannot answer about', () => {
  // A foreground run is interrupted (or its caller dies) while pueued does not answer: the hub's `kill` call is refused («Pueue did not answer»), and the lease's watcher is the only one left to stop the job.
  it('is tried again until Pueue answers: the queued job ends as killed (137), its task is removed - it never starts - and the lease ends with it', async () => {
    const downFile = path.join(root, 'pueue-down');
    createJobFolder('box1-aaaaaa');
    const lease = spawn('bash', [scriptPath, 'lease', workDir, slug, 'box1-aaaaaa', 'default', '2000'], { env: getEnvironment({ FAKE_PQ_WAIT_BLOCKS: '1', FAKE_PQ_DOWN_FILE: downFile }), stdio: ['pipe', 'ignore', 'ignore'] });
    const leaseEnded = new Promise<void>((resolve) => { lease.on('close', () => resolve()); });
    try {
      lease.stdin.write('h');
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'task-id')), 'the job to be queued');
      writeFile(root, 'pueue-down', '');
      lease.stdin.end();
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'kill-pending')), 'the watcher to meet the refusal and keep its kill pending');
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), false, 'nothing is ended while Pueue does not answer');
      const task = readTaskId('box1-aaaaaa');
      assert.equal(readTaskState(task), 'Queued');
      fs.rmSync(downFile);
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), 'the retry to end the job', 30_000);
      assert.equal(fs.readFileSync(path.join(jobFolder('box1-aaaaaa'), 'exit'), 'utf8').trim(), '137');
      assert.equal(readTaskState(task), null, 'its task was removed: it never starts');
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'pid')), false);
      await Promise.race([leaseEnded, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the lease did not end')), 30_000))]);
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'kill-pending')), false, 'the marker goes with the retry');
    } finally {
      lease.kill('SIGKILL');
    }
  });
});
