/**
 * @description `runnerUtility/lidState.ts`: what `ioreg -r -k AppleClamshellState -d 4` says (sample outputs: a lid open, a lid shut with nothing keeping the Mac awake,
 * a lid shut in clamshell mode, a Mac without a lid, damaged output), how it is asked for, and the watcher that tells the hub on a change — retrying a report the hub
 * could not be reached with at the next look, backing off after a refusal, saying a failure once, treating an unreadable registry as an open lid, and keeping a report that
 * is still on its way when a link ends from touching the next link.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { lidPollMinMs, readLidPollMs } from '../runnerUtility/lidPollTiming';
import { checkCanReadLid, createIoregReader, createLidWatcher, lidPollMs, lidRefusalFirstBackoffMs, lidRefusalMaxBackoffMs, parseLidReading, type LidReportResult } from '../runnerUtility/lidState';

/** The block `ioreg -r -k AppleClamshellState -d 4` prints for the power-management root of a MacBook, with the two properties set as given. */
function createRegistrySample(shutValue: string, causesSleepValue: string | null): string {
  return [
    '+-o Root  <class IORegistryEntry, id 0x100000100, retain 25>',
    '  +-o J314sAP  <class IOPlatformExpertDevice, id 0x10000020f, registered, matched, active, busy 0 (279 ms), retain 40>',
    '    | {',
    '    |   "IOPlatformSerialNumber" = "XXXXXXXXXX"',
    ...(causesSleepValue === null ? [] : [`    |   "AppleClamshellCausesSleep" = ${causesSleepValue}`]),
    `    |   "AppleClamshellState" = ${shutValue}`,
    '    |   "IOBusyInterest" = "IOCommand is not serializable"',
    '    | }',
    '    |',
  ].join('\n');
}

describe('parseLidReading: sample outputs of ioreg', () => {
  it('a lid shut with nothing keeping the Mac awake: closed — both keys Yes', () => {
    assert.equal(parseLidReading(createRegistrySample('Yes', 'Yes')), 'closed');
  });

  it('a lid that is open: open, whatever the sleep key says', () => {
    assert.equal(parseLidReading(createRegistrySample('No', 'Yes')), 'open');
    assert.equal(parseLidReading(createRegistrySample('No', 'No')), 'open');
  });

  it('a lid shut with an external display keeping the Mac awake (clamshell mode: closing it does not sleep the Mac): open — the Mac takes jobs', () => {
    assert.equal(parseLidReading(createRegistrySample('Yes', 'No')), 'open');
  });

  it('a lid shut and no word on whether it sleeps the Mac: open — never out of use on a guess', () => {
    assert.equal(parseLidReading(createRegistrySample('Yes', null)), 'open');
  });

  it('a Mac without a lid (a mini, a Studio: the key is not there), an empty answer and noise are all «no lid», which the watcher treats as open', () => {
    assert.equal(parseLidReading(''), 'no-lid');
    assert.equal(parseLidReading('+-o Root  <class IORegistryEntry, id 0x100000100, retain 25>\n'), 'no-lid');
    assert.equal(parseLidReading('"SomeOtherKey" = Yes'), 'no-lid');
    assert.equal(parseLidReading('ioreg: error'), 'no-lid');
  });

  it('is not fooled by a key that only contains the name, or a value that is not Yes / No', () => {
    assert.equal(parseLidReading('"NotAppleClamshellState" = Yes\n"AppleClamshellCausesSleep" = Yes'), 'no-lid');
    assert.equal(parseLidReading('"AppleClamshellState" = Maybe\n"AppleClamshellCausesSleep" = Yes'), 'no-lid');
    assert.equal(parseLidReading('"AppleClamshellState" = Yes\n"AppleClamshellCausesSleep" = Maybe'), 'open');
  });

  it('reads the answer in whatever case ioreg prints the booleans and however it indents the lines', () => {
    assert.equal(parseLidReading('      "AppleClamshellCausesSleep"=yes\n  "AppleClamshellState"  =  YES\n'), 'closed');
  });
});

describe('checkCanReadLid: who reports a lid', () => {
  function createToolFolder(executable: boolean): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-path-'));
    fs.writeFileSync(path.join(folder, 'ioreg'), '#!/bin/sh\n', { mode: executable ? 0o755 : 0o644 });
    return folder;
  }

  it('a Mac does, whatever its PATH; any other system does not, unless it has an executable ioreg on its PATH (how a flow plays a Mac)', () => {
    assert.equal(checkCanReadLid('darwin', { PATH: '/nonexistent' }), true);
    assert.equal(checkCanReadLid('darwin', {}), true);
    assert.equal(checkCanReadLid('linux', { PATH: '/usr/bin:/bin' }), false, 'no ioreg on a Linux box');
    assert.equal(checkCanReadLid('linux', {}), false);
    const withIoreg = createToolFolder(true);
    const notExecutable = createToolFolder(false);
    try {
      assert.equal(checkCanReadLid('linux', { PATH: `/usr/bin${path.delimiter}${withIoreg}` }), true);
      assert.equal(checkCanReadLid('win32', { PATH: withIoreg }), true);
      assert.equal(checkCanReadLid('linux', { PATH: notExecutable }), false, 'a file that cannot be run is no tool');
      assert.equal(checkCanReadLid('linux', { PATH: `${path.delimiter}` }), false, 'an empty PATH entry is not the current folder');
    } finally {
      fs.rmSync(withIoreg, { recursive: true, force: true });
      fs.rmSync(notExecutable, { recursive: true, force: true });
    }
  });
});

describe('createIoregReader', () => {
  function result(overrides: Partial<CommandResult>): CommandResult {
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides };
  }

  it('asks ioreg for the clamshell key of the power-management root, with a deadline, and returns what it printed', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const runner: CommandRunner = async (file, args, options) => {
      calls.push({ file, args, timeoutMs: options.timeoutMs });
      return result({ stdout: createRegistrySample('Yes', 'Yes') });
    };
    assert.equal(parseLidReading((await createIoregReader(runner)()) ?? ''), 'closed');
    assert.deepEqual(calls, [{ file: 'ioreg', args: ['-r', '-k', 'AppleClamshellState', '-d', '4'], timeoutMs: 5000 }]);
  });

  it('answers null when ioreg fails, is missing or does not end in time', async () => {
    assert.equal(await createIoregReader(async () => result({ ok: false, exitCode: 1, stderr: 'ioreg: failed' }))(), null);
    assert.equal(await createIoregReader(async () => result({ ok: false, exitCode: null, isTimedOut: true }))(), null);
    assert.equal(await createIoregReader(async () => result({ ok: false, exitCode: null, stderr: 'spawn ioreg ENOENT' }))(), null);
  });
});

describe('createLidWatcher', () => {
  function createFixture() {
    const registry = { text: createRegistrySample('No', 'Yes') as string | null, throws: false };
    const told: boolean[] = [];
    const logs: string[] = [];
    const hub = { answer: 'taken' as LidReportResult, throws: false };
    const clock = { nowMs: 1_000_000 };
    const watcher = createLidWatcher({
      readRegistry: async () => {
        if (registry.throws) throw new Error('spawn failed');
        return registry.text;
      },
      log: (line) => logs.push(line),
      now: () => clock.nowMs,
    });
    const report = async (isClosed: boolean): Promise<LidReportResult> => {
      if (hub.throws) throw new Error('no connection');
      if (hub.answer === 'taken') told.push(isClosed);
      return hub.answer;
    };
    return { registry, told, logs, hub, clock, watcher, report };
  }

  it('a link that told the hub its lid in its own request reports only a change: nothing at the first look, whatever the lid is', async () => {
    const { registry, told, watcher, report } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
    watcher.startLink(true);
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [], 'the request already said closed');
    registry.text = createRegistrySample('No', 'Yes');
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [false]);
    registry.text = createRegistrySample('Yes', 'Yes');
    await watcher.beat(report);
    assert.deepEqual(told, [false, true]);
    registry.text = createRegistrySample('Yes', 'No');
    await watcher.beat(report);
    assert.deepEqual(told, [false, true, false], 'an external display keeps it awake: open again');
  });

  it('a link whose request could not carry the lid (told nothing) says it at the first look — whatever it is', async () => {
    const { told, watcher, report } = createFixture();
    watcher.startLink(null);
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [false]);
  });

  it('look() is the one read of the lid — what a link puts in its request — and an unreadable registry is an open lid there too', async () => {
    const { registry, logs, watcher } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
    assert.equal(await watcher.look(), true);
    registry.text = createRegistrySample('Yes', 'No');
    assert.equal(await watcher.look(), false);
    registry.text = null;
    assert.equal(await watcher.look(), false);
    assert.equal(await watcher.look(), false);
    assert.equal(logs.filter((line) => /the lid state cannot be read/.test(line)).length, 1, 'said once per run of failures');
    registry.text = createRegistrySample('No', 'Yes');
    await watcher.look();
    registry.throws = true;
    assert.equal(await watcher.look(), false, 'a reader that throws is a failed read, not an exception');
    assert.equal(logs.filter((line) => /the lid state cannot be read/.test(line)).length, 2, 'a new run of failures is told again');
  });

  it('a report the hub could not be reached with is made again at the next look, and said once however many times it fails; it can throw, too', async () => {
    const { told, logs, hub, watcher, report } = createFixture();
    watcher.startLink(true);
    hub.answer = 'failed';
    for (let look = 0; look < 4; look += 1) await watcher.beat(report);
    assert.deepEqual(told, []);
    assert.equal(logs.filter((line) => /could not be reached with the report/.test(line)).length, 1);
    hub.throws = true;
    await assert.doesNotReject(watcher.beat(report));
    assert.equal(logs.length, 1, 'a throw is a failed report, in the same run of failures');
    hub.throws = false;
    hub.answer = 'taken';
    await watcher.beat(report);
    assert.deepEqual(told, [false]);
    hub.answer = 'failed';
    await watcher.beat(report);
    assert.equal(logs.length, 1, 'the hub has the lid already: no new try, no new line');
  });

  it('a report the hub REFUSED is not made again at every look: 30 s, then 60, doubling to five minutes — and said once', async () => {
    const { told, logs, hub, clock, watcher, report } = createFixture();
    watcher.startLink(true);
    let tries = 0;
    const countingReport = async (isClosed: boolean): Promise<LidReportResult> => { tries += 1; return report(isClosed); };
    hub.answer = 'refused';
    await watcher.beat(countingReport);
    assert.equal(tries, 1);
    for (let look = 0; look < 5; look += 1) {
      clock.nowMs += 5_000;
      await watcher.beat(countingReport);
    }
    assert.equal(tries, 1, 'the looks inside the wait send nothing');
    clock.nowMs += lidRefusalFirstBackoffMs;
    await watcher.beat(countingReport);
    assert.equal(tries, 2, 'after the first wait, one more try');
    clock.nowMs += lidRefusalFirstBackoffMs;
    await watcher.beat(countingReport);
    assert.equal(tries, 2, 'the second wait is twice as long');
    clock.nowMs += lidRefusalFirstBackoffMs;
    await watcher.beat(countingReport);
    assert.equal(tries, 3);
    for (let refusal = 0; refusal < 8; refusal += 1) {
      clock.nowMs += lidRefusalMaxBackoffMs;
      await watcher.beat(countingReport);
    }
    clock.nowMs += lidRefusalMaxBackoffMs - 1;
    const before = tries;
    await watcher.beat(countingReport);
    assert.equal(tries, before, 'never longer than the cap, never shorter than it once reached');
    clock.nowMs += 1;
    await watcher.beat(countingReport);
    assert.equal(tries, before + 1);
    assert.equal(logs.filter((line) => /it refused it/.test(line)).length, 1, 'said once for the whole run of refusals');
    hub.answer = 'taken';
    clock.nowMs += lidRefusalMaxBackoffMs;
    await watcher.beat(countingReport);
    assert.deepEqual(told, [false], 'and when the hub takes it, that is that');
  });

  it('an unreadable registry is an open lid, said once per run of failures; the next good read speaks again', async () => {
    const { registry, told, logs, watcher, report } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
    watcher.startLink(null);
    await watcher.beat(report);
    assert.deepEqual(told, [true]);
    registry.text = null;
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [true, false], 'a Mac that cannot be read is not held back: it is told as open');
    assert.equal(logs.filter((line) => /the lid state cannot be read/.test(line)).length, 1);
    registry.text = createRegistrySample('Yes', 'Yes');
    await watcher.beat(report);
    registry.throws = true;
    await watcher.beat(report);
    assert.equal(logs.filter((line) => /the lid state cannot be read/.test(line)).length, 2, 'a new run of failures is told again');
    assert.deepEqual(told, [true, false, true, false]);
  });

  it('a new link starts over: it tells the hub in its own request, so its first look says nothing — and the refusals of the link before do not carry over', async () => {
    const { told, hub, watcher, report } = createFixture();
    watcher.startLink(false);
    hub.answer = 'refused';
    const registryClosed = createRegistrySample('Yes', 'Yes');
    let lid = createRegistrySample('No', 'Yes');
    const closing = createLidWatcher({ readRegistry: async () => lid, log: () => undefined, now: () => 0 });
    closing.startLink(false);
    lid = registryClosed;
    await closing.beat(report);
    await closing.beat(report);
    closing.startLink(true);
    hub.answer = 'taken';
    await closing.beat(report);
    assert.deepEqual(told, [], 'the new link\'s request said closed: nothing to add');
    lid = createRegistrySample('No', 'Yes');
    await closing.beat(report);
    assert.deepEqual(told, [false], 'no wait is left from the refusals of the old link');
  });

  describe('a report still on its way when the link ends', () => {
    function createHeldReport(): { report: (isClosed: boolean) => Promise<LidReportResult>; release: (result: LidReportResult) => void; getCalls: () => boolean[] } {
      const calls: boolean[] = [];
      let release: (result: LidReportResult) => void = () => undefined;
      const held = new Promise<LidReportResult>((resolve) => { release = resolve; });
      return { report: async (isClosed) => { calls.push(isClosed); return held; }, release: (result) => release(result), getCalls: () => calls };
    }

    it('does not hold back the new link\'s own first look: the guard against two looks at once is per link', async () => {
      const { registry, told, watcher, report } = createFixture();
      const old = createHeldReport();
      watcher.startLink(false);
      registry.text = createRegistrySample('Yes', 'Yes');
      const oldBeat = watcher.beat(old.report);
      await waitForCalls(old.getCalls, 1);
      watcher.startLink(false);
      await watcher.beat(report);
      assert.deepEqual(told, [true], 'the new link looked at once, with the old link\'s report still on its way');
      old.release('taken');
      await oldBeat;
    });

    it('does not count for the new link, whatever it turns out to be: it neither marks the hub as told nor starts a run of refusals', async () => {
      const { registry, told, logs, watcher, report } = createFixture();
      const old = createHeldReport();
      watcher.startLink(false);
      registry.text = createRegistrySample('Yes', 'Yes');
      const oldBeat = watcher.beat(old.report);
      await waitForCalls(old.getCalls, 1);
      watcher.startLink(true);
      old.release('refused');
      await oldBeat;
      registry.text = createRegistrySample('No', 'Yes');
      await watcher.beat(report);
      assert.deepEqual(told, [false], 'the new link reports its own change at once: the old refusal set no wait');
      assert.equal(logs.filter((line) => /refused/.test(line)).length, 0, 'and said nothing');
    });

    it('a look of the old link that is still reading the registry when the new link begins reports nothing: it would speak for a connection that is gone', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      const watcher = createLidWatcher({
        readRegistry: async () => {
          reads += 1;
          if (reads === 1) {
            await held;
            return createRegistrySample('Yes', 'Yes');
          }
          return createRegistrySample('No', 'Yes');
        },
        log: () => undefined,
        now: () => 0,
      });
      const reported: Array<{ link: string; isClosed: boolean }> = [];
      watcher.startLink(false);
      const oldBeat = watcher.beat(async (isClosed) => { reported.push({ link: 'old', isClosed }); return 'taken'; });
      await waitForCalls(() => (reads >= 1 ? [true] : []), 1);
      // The new link told the hub its lid is open, and it is: nothing to say. The old look, still reading, found it closed a moment before.
      watcher.startLink(false);
      await watcher.beat(async (isClosed) => { reported.push({ link: 'new', isClosed }); return 'taken'; });
      release();
      await oldBeat;
      assert.deepEqual(reported, [], 'the old link\'s look came back after its link had ended, and its word is not the new link\'s');
    });

    it('an old link\'s report that was TAKEN does not tell the new link the hub has what it was never told', async () => {
      const { registry, told, watcher, report } = createFixture();
      const old = createHeldReport();
      watcher.startLink(false);
      registry.text = createRegistrySample('Yes', 'Yes');
      const oldBeat = watcher.beat(old.report);
      await waitForCalls(old.getCalls, 1);
      watcher.startLink(false);
      old.release('taken');
      await oldBeat;
      await watcher.beat(report);
      assert.deepEqual(told, [true], 'the new link\'s hub was told open in its request; the lid is closed: that is to be said');
    });
  });
});

async function waitForCalls(getCalls: () => boolean[], count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (getCalls().length < count && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(getCalls().length >= count, 'the report was started');
}

describe('the lid poll', () => {
  it('looks every ten seconds, as often as the hub\'s own gate beats', () => {
    assert.equal(lidPollMs, 10_000);
    assert.equal(readLidPollMs({}), lidPollMs);
  });

  it('a test seam may only SHORTEN it, within bounds; anything else leaves the production window', () => {
    assert.equal(readLidPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerLidPollMs: 1000 }) }), 1000);
    assert.equal(readLidPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerLidPollMs: lidPollMinMs }) }), lidPollMinMs);
    for (const bad of [lidPollMinMs - 1, lidPollMs + 1, 1.5, 'soon']) {
      assert.equal(readLidPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerLidPollMs: bad }) }), lidPollMs, String(bad));
    }
    assert.equal(readLidPollMs({ CHARNESS_TEST_TIMINGS: 'not json' }), lidPollMs);
    assert.equal(readLidPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ other: 1 }) }), lidPollMs);
  });
});
