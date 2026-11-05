/**
 * @description `testTimingsSeam.ts`: the one tolerant reader of the `CHARNESS_TEST_TIMINGS` seam for the processes that cannot import `testTimings.ts`. It only SHORTENS: the
 * production window comes back for an unset or blank variable, text that is not JSON, JSON that is not an object, a key that is absent or not a whole number of ms, or one outside
 * [min, production]; and each of the five readers built on it reads ITS key with ITS bounds.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRemoteRunLeaseMs, remoteRunLeaseMinMs, remoteRunLeaseMs } from '../remoteRun/leaseTiming';
import { readRunnerWaitPollMs, runnerWaitPollMinMs, runnerWaitPollMs } from '../remoteRun/runnerWaitTiming';
import { lidPollMinMs, lidPollMs, readLidPollMs } from '../runnerUtility/lidPollTiming';
import { readRunnerVersionPollMs, runnerVersionPollMinMs, runnerVersionPollMs } from '../runnerUtility/versionPollTiming';
import { pairingLifetimeMinMs, pairingLifetimeMs, readPairingLifetimeMs } from '../runners/pairingTiming';
import { readShorterTestWindowMs } from '../testTimingsSeam';

const productionMs = 10_000;
const minMs = 500;
const read = (raw: string | undefined, key = 'someWindowMs'): number => readShorterTestWindowMs(raw === undefined ? {} : { CHARNESS_TEST_TIMINGS: raw }, key, productionMs, minMs);

describe('readShorterTestWindowMs', () => {
  it('gives the seam\'s value for a whole number of ms within [min, production] — the bounds included', () => {
    assert.equal(read(JSON.stringify({ someWindowMs: 2000 })), 2000);
    assert.equal(read(JSON.stringify({ someWindowMs: minMs })), minMs);
    assert.equal(read(JSON.stringify({ someWindowMs: productionMs })), productionMs);
  });

  it('gives the production window for anything it does not understand: nothing set, blank, not JSON, not an object, no such key, a value that is not a whole number, too long or too short', () => {
    for (const raw of [undefined, '', '   ', 'not json', '5', 'null', '[1000]', '"2000"', JSON.stringify({ other: 2000 }), JSON.stringify({ someWindowMs: 1.5 }), JSON.stringify({ someWindowMs: '2000' }), JSON.stringify({ someWindowMs: minMs - 1 }), JSON.stringify({ someWindowMs: productionMs + 1 }), JSON.stringify({ someWindowMs: null })]) {
      assert.equal(read(raw), productionMs, String(raw));
    }
  });

  it('reads only its own key: another key of the same seam shortens nothing', () => {
    const raw = JSON.stringify({ someWindowMs: 1000, anotherWindowMs: 3000 });
    assert.equal(read(raw, 'anotherWindowMs'), 3000);
    assert.equal(read(raw, 'someWindowMs'), 1000);
    assert.equal(read(raw, 'aThirdWindowMs'), productionMs);
  });
});

describe('the five readers built on it', () => {
  const readers: Array<{ key: string; read: (env: NodeJS.ProcessEnv) => number; productionMs: number; minMs: number }> = [
    { key: 'remoteRunLeaseMs', read: readRemoteRunLeaseMs, productionMs: remoteRunLeaseMs, minMs: remoteRunLeaseMinMs },
    { key: 'remoteRunRunnerPollMs', read: readRunnerWaitPollMs, productionMs: runnerWaitPollMs, minMs: runnerWaitPollMinMs },
    { key: 'pairingLifetimeMs', read: readPairingLifetimeMs, productionMs: pairingLifetimeMs, minMs: pairingLifetimeMinMs },
    { key: 'runnerVersionPollMs', read: readRunnerVersionPollMs, productionMs: runnerVersionPollMs, minMs: runnerVersionPollMinMs },
    { key: 'runnerLidPollMs', read: readLidPollMs, productionMs: lidPollMs, minMs: lidPollMinMs },
  ];

  for (const reader of readers) {
    it(`${reader.key}: its own key, its own bounds (${reader.minMs}…${reader.productionMs} ms)`, () => {
      const envWith = (value: number): NodeJS.ProcessEnv => ({ CHARNESS_TEST_TIMINGS: JSON.stringify({ [reader.key]: value }) });
      assert.equal(reader.read({}), reader.productionMs);
      assert.equal(reader.read(envWith(reader.minMs)), reader.minMs);
      assert.equal(reader.read(envWith(reader.productionMs)), reader.productionMs);
      assert.equal(reader.read(envWith(reader.minMs - 1)), reader.productionMs);
      assert.equal(reader.read(envWith(reader.productionMs + 1)), reader.productionMs);
      for (const other of readers.filter((candidate) => candidate.key !== reader.key)) {
        assert.equal(reader.read({ CHARNESS_TEST_TIMINGS: JSON.stringify({ [other.key]: other.minMs }) }), reader.productionMs, `${other.key} does not shorten ${reader.key}`);
      }
    });
  }
});
