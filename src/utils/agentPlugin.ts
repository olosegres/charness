/**
 * @description The skills Charness gives every agent session it starts (`agent-plugin/` at the package root, a
 * Claude Code plugin named `charness`): `charness-manager` and the two worker-delegation skills, which name the
 * bot's own tools. The operator's own sessions outside the bot never get them.
 *
 *  - Claude Code loads the folder through `--plugin-dir` on every bot launch of an agent session — also under
 *    `--setting-sources project,local` (a Jira session), probed on 2.1.310 — and lists the skills as
 *    `charness:<folder>` beside the user's and the project's own.
 */

import fs from 'fs';
import path from 'path';

const agentPluginDirName = 'agent-plugin';
export const agentPluginSkillsDirName = 'skills';

/**
 * @description The plugin folder that ships in the package, two levels above this module (`src/utils` under tsx,
 * `dist/utils` once built), or null when it is missing (a broken install): a launch then goes without it rather than
 * failing on a folder Claude Code cannot load.
 */
export function resolveAgentPluginDir(): string | null {
  const pluginDir = path.join(fs.realpathSync(__dirname), '..', '..', agentPluginDirName);
  return fs.existsSync(path.join(pluginDir, agentPluginSkillsDirName)) ? pluginDir : null;
}

/** @description The Claude Code flags that load the bot's skills into an agent session: `--plugin-dir <folder>`. */
export function getClaudeAgentPluginFlags(pluginDir: string | null = resolveAgentPluginDir()): string[] {
  return pluginDir === null ? [] : ['--plugin-dir', pluginDir];
}
