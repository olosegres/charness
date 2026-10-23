/**
 * @description How a Claude process reads the API key pasted for an API account (`utils/claudeProfiles.ts`: the key
 * file in the profile's own directory): an `apiKeyHelper` that prints the file, riding that profile's `--settings`
 * only — the launch settings file (`claudeCompactHook.ts`) and the inline settings of a `claude auth status` probe.
 * The helper names the file, never the key. Apart from `claudeProfiles.ts` so the connector guards, which load that
 * module before any env file is read, never load the shell-quoting one.
 */

import { checkHasClaudeProfileApiKey, resolveClaudeProfileApiKeyFile } from './claudeProfiles';
import { shellSingleQuote } from './tmuxExec';

/** The `apiKeyHelper` command: print the key file (the CLI runs it through `/bin/sh` and trims the output). */
export function buildClaudeApiKeyHelperCommand(configDir: string): string {
  return `cat ${shellSingleQuote(resolveClaudeProfileApiKeyFile(configDir))}`;
}

/** The settings fragment that makes the CLI read the profile's pasted key: `{ apiKeyHelper }`. */
export function buildClaudeApiKeyHelperSettings(configDir: string): { apiKeyHelper: string } {
  return { apiKeyHelper: buildClaudeApiKeyHelperCommand(configDir) };
}

/**
 * @description The `--settings` argument pair a `claude auth status` probe of `configDir` needs: the inline helper
 * settings when the directory holds a pasted key (the probe must see the key the sessions use), else nothing.
 */
export function buildClaudeAuthProbeSettingsArgs(configDir: string | null): string[] {
  if (configDir === null || !checkHasClaudeProfileApiKey(configDir)) return [];
  return ['--settings', JSON.stringify(buildClaudeApiKeyHelperSettings(configDir))];
}
