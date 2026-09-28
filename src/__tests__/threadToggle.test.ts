/**
 * @description The resolution rule shared by every default-ON per-thread toggle
 * (`utils/threadToggle`), plus each of its three named wrappers.
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
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { resolveDefaultOnThreadToggle } from '../utils/threadToggle';
import { resolveCompactOnIdleEnabled, resolveCompactSummaryEnabled } from '../utils/compactOnIdle';
import { resolveAutoContinueOnLimitEnabled } from '../utils/autoContinueOnLimit';

/** Every wrapper over the shared rule, by the setting it resolves. */
const wrappers = {
  '/compact_on_idle': resolveCompactOnIdleEnabled,
  '/auto_continue_limits': resolveAutoContinueOnLimitEnabled,
  '/compact_summary': resolveCompactSummaryEnabled,
};

/** `[globalDefault, threadOverride, expected]` — the whole decision table. */
const cases: Array<[boolean | undefined, boolean | undefined, boolean]> = [
  // Nothing set anywhere ⇒ ON: every one of these features ships enabled.
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

test('all three named wrappers resolve identically to the shared rule', () => {
  for (const [name, resolve] of Object.entries(wrappers)) {
    for (const [globalDefault, threadOverride, expected] of cases) {
      assert.equal(
        resolve(globalDefault, threadOverride),
        expected,
        `${name}: global=${globalDefault} override=${threadOverride}`,
      );
    }
  }
});
