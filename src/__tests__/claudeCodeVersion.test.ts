/**
 * @description The Claude Code version gate for auto-stop (plan
 * 2026-10-04-claude-process-lifecycle, L-D10): only a CLI that reports the
 * background-task list (≥ 2.1.287) may be stopped automatically; an unknown or
 * older version must read as unsupported, since a stop there could kill
 * background work the bot cannot see.
 *
 * Load-bearing: the compare is NUMERIC per component (a string compare would
 * rank `2.1.300` below `2.1.287`), and `null` is never "supported".
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsClaudeAutoStopSupported, compareClaudeCodeVersions, minAutoStopClaudeCodeVersion } from '../utils/claudeCodeVersion';

describe('compareClaudeCodeVersions', () => {
  it('compares numerically per component', () => {
    assert.ok(compareClaudeCodeVersions('2.1.300', '2.1.287')! > 0);
    assert.ok(compareClaudeCodeVersions('2.1.287', '2.1.300')! < 0);
    assert.ok(compareClaudeCodeVersions('2.2.0', '2.1.999')! > 0);
    assert.ok(compareClaudeCodeVersions('3.0.0', '2.9.9')! > 0);
    assert.equal(compareClaudeCodeVersions('2.1.287', '2.1.287'), 0);
  });

  it('ignores a pre-release / build suffix and rejects a non-version', () => {
    assert.equal(compareClaudeCodeVersions('2.1.287-beta.1', '2.1.287'), 0);
    assert.equal(compareClaudeCodeVersions('unknown', '2.1.287'), null);
    assert.equal(compareClaudeCodeVersions('2.1', '2.1.287'), null);
  });
});

describe('checkIsClaudeAutoStopSupported (L-D10)', () => {
  it('the minimum version and anything newer is supported', () => {
    assert.equal(checkIsClaudeAutoStopSupported(minAutoStopClaudeCodeVersion), true);
    assert.equal(checkIsClaudeAutoStopSupported('2.1.300'), true);
    assert.equal(checkIsClaudeAutoStopSupported('2.2.0'), true);
  });

  it('an older, unknown or unparseable version is never supported', () => {
    assert.equal(checkIsClaudeAutoStopSupported('2.1.286'), false);
    assert.equal(checkIsClaudeAutoStopSupported('2.1.201'), false);
    assert.equal(checkIsClaudeAutoStopSupported(null), false);
    assert.equal(checkIsClaudeAutoStopSupported('dev'), false);
  });
});
