/**
 * @description How the `/compact_mistakes` switch reaches the compactions the bot does not issue: the CLI's own overflow
 * compaction (Claude's `PreCompact` hook, `claudeCompactHook.ts`) and OpenCode's (the bot's compaction plugin,
 * `openCodeCompactPlugin.ts`). Both run inside the agent's process and add the agent-mistakes request to the compaction
 * prompt there, long after the bot started that process, so a setting changed in between must reach them at compaction time:
 * the bot keeps ONE EMPTY FILE per agent session whose topic has the section OFF — named by the session id the hook and the
 * plugin are handed — and both look for it right before they add the request. No file ⇒ ON, today's behaviour, so a process
 * the bot did not start (or started before this switch) keeps asking for the section.
 *
 * The files are the bot's copy of the setting, never its source: `state.json` stays the one place the setting lives, and
 * {@link applyCompactMistakesOffFlag} is only ever called with what the bot resolved from it.
 */
import fs from 'fs';
import path from 'path';

/** Folder of the Claude hook's flags, inside `DATA_DIR`. */
const claudeCompactMistakesOffDirName = 'compact-mistakes-off';

/**
 * Folder of the OpenCode plugin's flags: next to OpenCode's global plugin folder, because the plugin is shared by every
 * OpenCode of the account, knows its own file only (`import.meta.url`) and so cannot know a `DATA_DIR`.
 */
export const openCodeCompactMistakesOffDirName = 'charness-compact-mistakes-off';

/** What a session id may hold to name a flag: the ids of both backends (a UUID, `ses_…`) fit; anything else never reaches a path. */
export const flagSessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** @description Whether `sessionId` can name a flag file. */
export function checkIsFlagSessionId(sessionId: string): boolean {
  return flagSessionIdPattern.test(sessionId);
}

/** @description The folder of the Claude sessions' flags under `dataDir`. */
export function getClaudeCompactMistakesOffDir(dataDir: string): string {
  return path.join(dataDir, claudeCompactMistakesOffDirName);
}

/** @description The folder of the OpenCode sessions' flags, beside the plugin folder `pluginDir` (the plugin finds it the same way). */
export function getOpenCodeCompactMistakesOffDir(pluginDir: string): string {
  return path.join(path.dirname(pluginDir), openCodeCompactMistakesOffDirName);
}

/**
 * @description Make the flag of `sessionId` in `flagDir` say what the setting says: present while the section is OFF,
 * absent while it is ON. Idempotent. Best-effort: a failure is logged and the compaction is then asked for the section as
 * before, which the bot's own posting gate still keeps out of the topic.
 */
export function applyCompactMistakesOffFlag(flagDir: string, sessionId: string, isEnabled: boolean): void {
  if (!checkIsFlagSessionId(sessionId)) return;
  const flagPath = path.join(flagDir, sessionId);
  try {
    if (isEnabled) {
      fs.rmSync(flagPath, { force: true });
      return;
    }
    fs.mkdirSync(flagDir, { recursive: true });
    fs.writeFileSync(flagPath, '');
  } catch (e) {
    console.warn(`[compact-mistakes] cannot ${isEnabled ? 'remove' : 'write'} the flag ${flagPath}:`, e instanceof Error ? e.message : e);
  }
}

/** The two folders of flags a bot instance keeps: the Claude hook's (in `DATA_DIR`) and the OpenCode plugin's (beside the plugin folder). */
export interface CompactMistakesFlagDirs {
  claudeOffDir: string;
  openCodeOffDir: string;
}

/**
 * @description Where an instance keeps its flags: the Claude ones in `dataDir`, the OpenCode ones beside OpenCode's global
 * plugin folder `pluginDir` (`resolveOpenCodeGlobalPluginDir`).
 */
export function getCompactMistakesFlagDirs(dataDir: string, pluginDir: string): CompactMistakesFlagDirs {
  return { claudeOffDir: getClaudeCompactMistakesOffDir(dataDir), openCodeOffDir: getOpenCodeCompactMistakesOffDir(pluginDir) };
}

/** A thread's agent sessions with the setting its topic resolves to. */
export interface CompactMistakesFlagSession {
  claudeSessionId: string | null;
  opencodeSessionId: string | null;
  isEnabled: boolean;
}

/**
 * @description Bring the flags of `sessions` in step with their topics' settings — each backend's id into its own folder.
 * Only these sessions' flags are touched: the plugin's folder is shared by every instance of the account, and a flag of a
 * session this instance does not know is somebody else's.
 */
export function syncCompactMistakesFlags(sessions: readonly CompactMistakesFlagSession[], dirs: CompactMistakesFlagDirs): void {
  for (const session of sessions) {
    if (session.claudeSessionId) applyCompactMistakesOffFlag(dirs.claudeOffDir, session.claudeSessionId, session.isEnabled);
    if (session.opencodeSessionId) applyCompactMistakesOffFlag(dirs.openCodeOffDir, session.opencodeSessionId, session.isEnabled);
  }
}
