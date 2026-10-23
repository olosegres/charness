/**
 * @description Coverage for `src/selfUpdate/updatePending.ts` — the marker written before a switch and the boot-time check
 * that counts unconfirmed boots, rolls a version that cannot start back to the previous one (before the bot module is even
 * imported), and keeps the outcome for the restored version to report.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { maxUnconfirmedBoots } from '../selfUpdate/constants';
import {
  clearUpdatePending,
  createPendingMarker,
  decideBootAction,
  getUpdatePendingPath,
  readUpdatePending,
  runBootUpdateCheck,
  writeUpdatePending,
  type UpdatePendingMarker,
} from '../selfUpdate/updatePending';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-pending-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createMarker(overrides: Partial<UpdatePendingMarker> = {}): UpdatePendingMarker {
  return { ...createPendingMarker({ kind: 'npm', from: { version: '3.4.0', commit: null }, to: { version: '3.5.0', commit: null }, isUserRequested: false }), ...overrides };
}

describe('the marker', () => {
  test('a new one has had no boot yet; it round-trips and is private to the owner', () => {
    const marker = createMarker();
    assert.deepEqual([marker.status, marker.attempts], ['pending', 0]);
    writeUpdatePending(dataDir, marker);
    assert.deepEqual(readUpdatePending(dataDir), marker);
    assert.equal(fs.statSync(getUpdatePendingPath(dataDir)).mode & 0o777, 0o600);
    clearUpdatePending(dataDir);
    assert.equal(readUpdatePending(dataDir), null);
    clearUpdatePending(dataDir);
  });

  test('a missing, garbled or misshapen file reads as no marker — never a reason to refuse to boot', () => {
    assert.equal(readUpdatePending(dataDir), null);
    fs.writeFileSync(getUpdatePendingPath(dataDir), '{"kind":"npm"');
    assert.equal(readUpdatePending(dataDir), null);
    fs.writeFileSync(getUpdatePendingPath(dataDir), JSON.stringify({ kind: 'npm', status: 'maybe' }));
    assert.equal(readUpdatePending(dataDir), null);
  });
});

describe('what a boot does about it', () => {
  test('no marker, or a settled one: just boot, change nothing', () => {
    assert.deepEqual(decideBootAction(null), { action: 'proceed', marker: null });
    const rolledBack = createMarker({ status: 'rolledBack' });
    assert.deepEqual(decideBootAction(rolledBack), { action: 'proceed', marker: rolledBack });
    const failed = createMarker({ status: 'rollbackFailed', attempts: 9 });
    assert.deepEqual(decideBootAction(failed), { action: 'proceed', marker: failed });
  });

  test('each boot of an unconfirmed version counts itself in; at the limit the next boot rolls back', () => {
    assert.deepEqual(maxUnconfirmedBoots, 2, 'the plan locks two unconfirmed boots');
    assert.deepEqual(decideBootAction(createMarker({ attempts: 0 })), { action: 'proceed', marker: createMarker({ attempts: 1 }) });
    assert.deepEqual(decideBootAction(createMarker({ attempts: 1 })), { action: 'proceed', marker: createMarker({ attempts: 2 }) });
    assert.deepEqual(decideBootAction(createMarker({ attempts: 2 })), { action: 'rollback', marker: createMarker({ attempts: 2 }) });
  });
});

describe('the boot-time check', () => {
  function createDeps(rollback: (marker: UpdatePendingMarker) => Promise<void> = async () => {}): { deps: Parameters<typeof runBootUpdateCheck>[0]; rollbacks: UpdatePendingMarker[]; logs: string[] } {
    const rollbacks: UpdatePendingMarker[] = [];
    const logs: string[] = [];
    return {
      deps: {
        dataDir,
        rollback: async (marker) => {
          rollbacks.push(marker);
          await rollback(marker);
        },
        log: (line) => logs.push(line),
      },
      rollbacks,
      logs,
    };
  }

  test('without a marker nothing is written and nothing is rolled back', async () => {
    const { deps, rollbacks } = createDeps();
    assert.equal(await runBootUpdateCheck(deps), 'proceed');
    assert.equal(fs.existsSync(getUpdatePendingPath(dataDir)), false);
    assert.equal(rollbacks.length, 0);
  });

  test('a version that does not start: two boots are counted, the third rolls back and leaves the outcome for the restored version', async () => {
    writeUpdatePending(dataDir, createMarker());
    const { deps, rollbacks, logs } = createDeps();
    assert.equal(await runBootUpdateCheck(deps), 'proceed');
    assert.equal(readUpdatePending(dataDir)?.attempts, 1);
    assert.equal(await runBootUpdateCheck(deps), 'proceed');
    assert.equal(readUpdatePending(dataDir)?.attempts, 2);
    assert.equal(rollbacks.length, 0);

    assert.equal(await runBootUpdateCheck(deps), 'rolledBack');
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0].to.version, '3.5.0');
    const settled = readUpdatePending(dataDir);
    assert.equal(settled?.status, 'rolledBack');
    assert.equal(settled?.from.version, '3.4.0');
    assert.match(settled?.failureReason ?? '', /did not start \(2 boots without confirmation\)/);
    assert.match(logs.join('\n'), /3\.5\.0 did not start 2 times — going back to 3\.4\.0/);

    // The restored version boots next: the settled marker is neither counted nor rolled back again.
    assert.equal(await runBootUpdateCheck(deps), 'proceed');
    assert.equal(rollbacks.length, 1);
  });

  test('a rollback that fails is kept as such, with its reason, and the boot goes on', async () => {
    writeUpdatePending(dataDir, createMarker({ attempts: 2 }));
    const { deps, logs } = createDeps(async () => {
      throw new Error('npm install 3.4.0 failed: ENOSPC');
    });
    assert.equal(await runBootUpdateCheck(deps), 'rollbackFailed');
    const settled = readUpdatePending(dataDir);
    assert.equal(settled?.status, 'rollbackFailed');
    assert.match(settled?.failureReason ?? '', /going back failed: npm install 3\.4\.0 failed: ENOSPC/);
    assert.match(logs.join('\n'), /going back failed: npm install 3\.4\.0 failed: ENOSPC/);
  });
});
