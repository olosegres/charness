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
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsClaudeAutoStopSupported, checkIsClaudePluginDirSupported, compareClaudeCodeVersions, getPerTurnRefusedVersion, minAutoStopClaudeCodeVersion, minPluginDirClaudeCodeVersion } from '../utils/claudeCodeVersion';

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

describe('checkIsClaudePluginDirSupported (the bot\'s skills)', () => {
  it('from 2.0.25 on, the --version line included; never for 2.0.24 and older, an unknown or an unparseable version', () => {
    assert.equal(minPluginDirClaudeCodeVersion, '2.0.25');
    assert.equal(checkIsClaudePluginDirSupported('2.0.25 (Claude Code)'), true);
    assert.equal(checkIsClaudePluginDirSupported('2.1.310 (Claude Code)'), true);
    assert.equal(checkIsClaudePluginDirSupported('2.0.24 (Claude Code)'), false);
    assert.equal(checkIsClaudePluginDirSupported('1.0.128'), false);
    assert.equal(checkIsClaudePluginDirSupported(null), false);
    assert.equal(checkIsClaudePluginDirSupported('dev'), false);
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

describe('getPerTurnRefusedVersion (L-D10, narrowed)', () => {
  it('refuses the per-turn lifecycle for a conversation whose last known CLI is below the gate — and names that version', () => {
    assert.equal(getPerTurnRefusedVersion('2.1.286'), '2.1.286');
    assert.equal(getPerTurnRefusedVersion('2.1.201'), '2.1.201');
  });

  it('allows it when the version is unknown — the refusal is only decidable once a version is known', () => {
    assert.equal(getPerTurnRefusedVersion(null), null);
  });

  it('allows it from the gate version on', () => {
    assert.equal(getPerTurnRefusedVersion(minAutoStopClaudeCodeVersion), null);
    assert.equal(getPerTurnRefusedVersion('2.2.0'), null);
  });
});
