/**
 * @description `runnerUtility/progress.ts`, the «what is happening now» lines of a pairing: on a terminal each step is ONE line redrawn with
 * dots that cycle while it runs and closed with «— done» / «— failed»; anywhere else (a pipe, a file, a flow) it is one plain line when the
 * step starts. The step's result — or its failure — is the work's own.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsTerminal, createStepRunner, stepLinePrefix } from '../runnerUtility/progress';

const dotIntervalMs = 15;
const longEnoughForSeveralFramesMs = 140;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createOutput(isTerminal: boolean): { written: string[]; write: (text: string) => void; isTerminal: boolean } {
  const written: string[] = [];
  return { written, write: (text) => { written.push(text); }, isTerminal };
}

describe('a step on a pipe or a file', () => {
  it('is one plain line when it starts, and the work\'s result is returned', async () => {
    const output = createOutput(false);
    const result = await createStepRunner(output, dotIntervalMs)('installing the thing', async () => {
      await wait(longEnoughForSeveralFramesMs);
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(output.written, [`${stepLinePrefix}installing the thing\n`], 'one line, no redrawing, nothing at the end');
  });

  it('passes the work\'s failure on, adding nothing to the output', async () => {
    const output = createOutput(false);
    await assert.rejects(createStepRunner(output, dotIntervalMs)('pairing', async () => { throw new Error('refused'); }), /refused/);
    assert.deepEqual(output.written, [`${stepLinePrefix}pairing\n`]);
  });
});

describe('a step on a terminal', () => {
  it('redraws its one line with dots that cycle one, two, three while it runs, then closes it with «— done»', async () => {
    const output = createOutput(true);
    await createStepRunner(output, dotIntervalMs)('installing the thing', () => wait(longEnoughForSeveralFramesMs));
    const head = `${stepLinePrefix}installing the thing`;
    const frames = output.written.slice(0, -1);
    assert.ok(frames.length >= 4, `the dots moved: ${JSON.stringify(output.written)}`);
    const expectedCycle = [`\r${head}.  `, `\r${head}.. `, `\r${head}...`];
    frames.forEach((frame, index) => assert.equal(frame, expectedCycle[index % expectedCycle.length], `frame ${index}`));
    assert.equal(output.written.at(-1), `\r${head} — done\n`, 'the line ends on a result that covers the dots');
    assert.ok(!output.written.slice(0, -1).some((frame) => frame.includes('\n')), 'one line: no frame ends it');
  });

  it('closes the line with «— failed» when the work fails, passes the failure on, and stops the dots', async () => {
    const output = createOutput(true);
    await assert.rejects(createStepRunner(output, dotIntervalMs)('pairing', async () => {
      await wait(longEnoughForSeveralFramesMs / 2);
      throw new Error('refused');
    }), /refused/);
    assert.equal(output.written.at(-1), `\r${stepLinePrefix}pairing — failed\n`);
    const writtenAtEnd = output.written.length;
    await wait(dotIntervalMs * 4);
    assert.equal(output.written.length, writtenAtEnd, 'nothing is drawn after the step ended');
  });

  it('does not keep the process alive on its own: the dots timer is unref\'d and cleared with the step', async () => {
    const before = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    await createStepRunner(createOutput(true), dotIntervalMs)('a quick one', () => wait(5));
    assert.equal(process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length, before);
  });
});

describe('what counts as a terminal', () => {
  it('a TTY stream is one, unless the terminal is «dumb»; a pipe or a file is not', () => {
    assert.equal(checkIsTerminal({ isTTY: true }, { TERM: 'xterm-256color' }), true);
    assert.equal(checkIsTerminal({ isTTY: true }, {}), true);
    assert.equal(checkIsTerminal({ isTTY: true }, { TERM: 'dumb' }), false);
    assert.equal(checkIsTerminal({ isTTY: false }, { TERM: 'xterm' }), false);
    assert.equal(checkIsTerminal({}, { TERM: 'xterm' }), false);
  });
});
