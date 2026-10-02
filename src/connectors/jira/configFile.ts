import * as path from 'path';

/**
 * @description Where the Jira connector's configuration lives (plan J4, D10).
 * Kept apart from `config.ts` because the CLI preflight checks the file exists
 * before any env file is loaded, and must not pull in the modules validation
 * needs (adapters, the OpenCode manager, the MCP layer).
 */

/** The file under `DATA_DIR`. */
export const jiraConfigFileName = 'jira.json';

export function getJiraConfigPath(dataDir: string): string {
  return path.join(dataDir, jiraConfigFileName);
}
