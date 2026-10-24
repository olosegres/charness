/**
 * @description `utils/agentPlugin.ts`: where the bot finds the skills it gives its agents, and the Claude Code flags that
 * load them — none when the folder is missing, so a broken install starts its sessions without them instead of failing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getClaudeAgentPluginFlags, resolveAgentPluginDir } from '../utils/agentPlugin';

const repoAgentPluginDir = path.join(fs.realpathSync(path.resolve(__dirname, '..', '..')), 'agent-plugin');

describe('agentPlugin', () => {
  test('the plugin folder is the package\'s own agent-plugin/', () => {
    assert.equal(resolveAgentPluginDir(), repoAgentPluginDir);
  });

  test('Claude Code gets --plugin-dir with that folder, and nothing when it is missing', () => {
    assert.deepEqual(getClaudeAgentPluginFlags(), ['--plugin-dir', repoAgentPluginDir]);
    assert.deepEqual(getClaudeAgentPluginFlags(null), []);
  });
});
