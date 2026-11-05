/**
 * @description `runnerUtility/lidState.ts`: what `ioreg -r -k AppleClamshellState -d 4` says (sample outputs: a lid open, a lid shut with nothing keeping the Mac awake,
 * a lid shut in clamshell mode, a Mac without a lid, damaged output), how it is asked for, and the watcher that tells the hub on a change — retrying a report the hub
 * did not take, saying a failure once, treating an unreadable registry as an open lid, never looking twice at once.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { createIoregReader, createLidWatcher, lidPollMs, parseLidReading } from '../runnerUtility/lidState';

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
    const hub = { takes: true, throws: false };
    const watcher = createLidWatcher({
      readRegistry: async () => {
        if (registry.throws) throw new Error('spawn failed');
        return registry.text;
      },
      log: (line) => logs.push(line),
    });
    const report = async (isClosed: boolean): Promise<boolean> => {
      if (hub.throws) throw new Error('no connection');
      if (hub.takes) told.push(isClosed);
      return hub.takes;
    };
    return { registry, told, logs, hub, watcher, report };
  }

  it('tells the hub at the first look — whatever the lid is — and then only when it changes', async () => {
    const { registry, told, watcher, report } = createFixture();
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [false], 'open, once');
    registry.text = createRegistrySample('Yes', 'Yes');
    await watcher.beat(report);
    await watcher.beat(report);
    assert.deepEqual(told, [false, true]);
    registry.text = createRegistrySample('Yes', 'No');
    await watcher.beat(report);
    assert.deepEqual(told, [false, true, false], 'an external display keeps it awake: open again');
  });

  it('a report the hub did not take is made again at the next look, and said once however many times it fails', async () => {
    const { told, logs, hub, watcher, report } = createFixture();
    hub.takes = false;
    for (let look = 0; look < 4; look += 1) await watcher.beat(report);
    assert.deepEqual(told, []);
    assert.equal(logs.filter((line) => /did not take the report of the lid/.test(line)).length, 1);
    hub.takes = true;
    await watcher.beat(report);
    assert.deepEqual(told, [false]);
    hub.takes = false;
    await watcher.beat(report);
    await watcher.beat(report);
    assert.equal(logs.length, 1, 'the lid is the same and the hub already has it: no new try, no new line');
  });

  it('a report that throws (the connection went) is a failed report, never an exception out of the watcher', async () => {
    const { told, hub, watcher, report, logs } = createFixture();
    hub.throws = true;
    await assert.doesNotReject(watcher.beat(report));
    assert.equal(logs.length, 1);
    hub.throws = false;
    await watcher.beat(report);
    assert.deepEqual(told, [false]);
  });

  it('an unreadable registry (null, or a reader that throws) is an open lid, said once per run of failures; the next good read speaks again', async () => {
    const { registry, told, logs, watcher, report } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
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

  it('a new link (reset) says the state again at the first look, even when it is the one the last link said', async () => {
    const { registry, told, watcher, report } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
    await watcher.beat(report);
    await watcher.beat(report);
    watcher.reset();
    await watcher.beat(report);
    assert.deepEqual(told, [true, true]);
  });

  it('a look that begins while another is still under way does nothing — the hub is not asked twice for one change', async () => {
    const { registry, watcher } = createFixture();
    registry.text = createRegistrySample('Yes', 'Yes');
    let reports = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slowReport = async (): Promise<boolean> => {
      reports += 1;
      await held;
      return true;
    };
    const first = watcher.beat(slowReport);
    await watcher.beat(slowReport);
    release();
    await first;
    assert.equal(reports, 1);
  });

  it('looks every ten seconds, as often as the hub\'s own gate beats', () => {
    assert.equal(lidPollMs, 10_000);
  });
});
