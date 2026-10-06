/**
 * @description The resolution rule shared by every per-thread toggle
 * (`utils/threadToggle`), plus each of its three named wrappers — two fall back to
 * ON when nothing is set, `/compact_summary` to OFF.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): the three wrappers are thin
 * by design, and a thin wrapper is exactly what silently stops matching its
 * siblings when someone edits one. So each is asserted to produce the SAME verdict
 * as the shared rule on the same inputs — not merely to be callable.
 *
 * The `false` vs `undefined` distinction is the part that bites in production: a
 * General «Disable» is persisted as an explicit `false`, and treating that as
 * "never set" would silently re-enable the setting on the next boot.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { resolveDefaultOnThreadToggle, resolveThreadToggle } from '../utils/threadToggle';
import { resolveCompactOnIdleEnabled, resolveCompactSummaryEnabled } from '../utils/compactOnIdle';
import { resolveAutoContinueOnLimitEnabled } from '../utils/autoContinueOnLimit';

/** Every wrapper over the shared rule, by the setting it resolves, with the value it falls back to. */
const wrappers = {
  '/compact_on_idle': { resolve: resolveCompactOnIdleEnabled, unsetValue: true },
  '/auto_continue_limits': { resolve: resolveAutoContinueOnLimitEnabled, unsetValue: true },
  // A compaction ends in one short line unless the summary is turned on.
  '/compact_summary': { resolve: resolveCompactSummaryEnabled, unsetValue: false },
};

/** `[globalDefault, threadOverride, expected]` — the decision table of a default-ON toggle. */
const cases: Array<[boolean | undefined, boolean | undefined, boolean]> = [
  // Nothing set anywhere ⇒ ON for a default-ON toggle.
  [undefined, undefined, true],
  // An explicit global `false` must NOT be confused with "never set".
  [false, undefined, false],
  [true, undefined, true],
  // A per-thread override beats the instance default in BOTH directions.
  [true, false, false],
  [false, true, true],
  // An override that merely AGREES with the default is still honoured.
  [true, true, true],
  [false, false, false],
  [undefined, false, false],
  [undefined, true, true],
];

test('resolveDefaultOnThreadToggle: override wins, else the default, ON when unset', () => {
  for (const [globalDefault, threadOverride, expected] of cases) {
    assert.equal(
      resolveDefaultOnThreadToggle(globalDefault, threadOverride),
      expected,
      `global=${globalDefault} override=${threadOverride}`,
    );
  }
});

test('resolveThreadToggle: only the all-unset case reads the fallback', () => {
  for (const [globalDefault, threadOverride, expected] of cases) {
    const isUnset = globalDefault === undefined && threadOverride === undefined;
    assert.equal(
      resolveThreadToggle(globalDefault, threadOverride, false),
      isUnset ? false : expected,
      `global=${globalDefault} override=${threadOverride}`,
    );
  }
});

test('all three named wrappers resolve identically to the shared rule with their own fallback', () => {
  for (const [name, { resolve, unsetValue }] of Object.entries(wrappers)) {
    for (const [globalDefault, threadOverride] of cases) {
      assert.equal(
        resolve(globalDefault, threadOverride),
        resolveThreadToggle(globalDefault, threadOverride, unsetValue),
        `${name}: global=${globalDefault} override=${threadOverride}`,
      );
    }
    assert.equal(resolve(undefined, undefined), unsetValue, `${name}: nothing set`);
  }
});
