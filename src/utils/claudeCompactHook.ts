/**
 * @description The `PreCompact` hook the bot hands every Claude session it starts,
 * so the compaction Claude runs ON ITS OWN when the context overflows gets the
 * same summary guidance as a bot-issued one.
 *
 * WHY this exists: a bot-issued compaction carries its instruction as
 * `/compact <instruction>`, but the overflow-triggered (auto) compaction is started
 * by the CLI itself and has no argument the bot could fill. It summarised with the
 * default prompt: the loaded skills were not named, and the continuing session
 * silently stopped following them. Claude Code runs `PreCompact` hooks before
 * EVERY compaction (`trigger` `auto` and `manual`) and appends a hook's stdout to
 * that compaction's custom instructions — measured on v2.1.289: an
 * overflow-triggered compaction's summary opened with the line the hook printed.
 * The hook rides `--settings <file>`, which is merged with the user's own settings
 * and never writes to them.
 *
 * A bot-issued compaction already carries the same text, so the hook prints
 * nothing when the compaction's `custom_instructions` (part of the JSON the hook
 * reads on stdin) already contain the skills guidance — otherwise the model would
 * get the instruction twice.
 */

import fs from 'fs';
import path from 'path';
import {
  buildCompactionInstruction,
  compactionSkillsGuidance,
  compactionSummaryGuidance,
} from './compactOnIdle';
import { shellSingleQuote } from './tmuxExec';
import { checkHasClaudeProfileApiKey, claudeProfileLaunchSettingsFileName } from './claudeProfiles';
import { buildClaudeApiKeyHelperSettings } from './claudeApiKeyHelper';

/**
 * Name of the hook settings file inside `DATA_DIR`. ONE file shared by every
 * session: its content is the same for all of them, and a session that outlives
 * the bot (json-stream) must never find it deleted under it.
 */
export const claudeCompactHookSettingsFileName = 'claude-compact-hook.json';

/**
 * @description The instruction the hook adds to a compaction the bot did not
 * issue: D3 + the loaded-skills guidance. No closing section — that one exists for
 * the bot's own idle-compaction report, which an overflow compaction never feeds.
 */
export function getHookCompactionInstruction(): string {
  return buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: false,
    skillsGuidance: compactionSkillsGuidance,
  }) ?? '';
}

/**
 * @description Build the hook's shell command: print `instruction` unless the
 * hook's stdin (the `PreCompact` input JSON) already contains `alreadySentMarker`.
 * The marker is matched as a fixed string against the raw JSON, so it must be text
 * JSON leaves unescaped — the caller passes the skills guidance, and a test pins
 * that it qualifies.
 */
export function buildPreCompactHookCommand(input: {
  instruction: string;
  alreadySentMarker: string;
}): string {
  return `grep -qF -e ${shellSingleQuote(input.alreadySentMarker)} || printf '%s\\n' ${shellSingleQuote(input.instruction)}`;
}

/** The `--settings` payload: one `PreCompact` command hook, no matcher (auto AND manual). */
export function buildClaudeCompactHookSettings(command: string): {
  hooks: { PreCompact: Array<{ hooks: Array<{ type: 'command'; command: string }> }> };
} {
  return { hooks: { PreCompact: [{ hooks: [{ type: 'command', command }] }] } };
}

/**
 * @description Write the launch settings file and return the `--settings <path>` argument pair for a Claude
 * launch under `configDir` (the account profile's directory, `null` = `~/.claude`). Rewritten on every launch
 * (atomic rename, so a concurrently starting session never reads a half-written file) so a changed guidance
 * reaches the next session.
 *
 * Only the LAST `--settings` a launch carries counts (probed on 2.1.304), so a profile that holds a pasted API key
 * (`utils/claudeProfiles.ts`) gets ONE file of its own, in its directory: the hook plus the `apiKeyHelper` that
 * reads the key. Every other launch shares the hook file in `dataDir`. A write failure of the shared file returns
 * `[]` and only logs (the hook improves a summary, it must never stop an agent from starting); for a key profile
 * the same settings go inline instead, so the account never loses its key to a full disk.
 */
export function prepareClaudeCompactHookFlags(dataDir: string, configDir: string | null = null): string[] {
  const command = buildPreCompactHookCommand({
    instruction: getHookCompactionInstruction(),
    alreadySentMarker: compactionSkillsGuidance,
  });
  const hookSettings = buildClaudeCompactHookSettings(command);
  if (configDir !== null && checkHasClaudeProfileApiKey(configDir)) {
    const settings = { ...hookSettings, ...buildClaudeApiKeyHelperSettings(configDir) };
    const written = writeLaunchSettingsFile(configDir, path.join(configDir, claudeProfileLaunchSettingsFileName), settings);
    return ['--settings', written ?? JSON.stringify(settings)];
  }
  const written = writeLaunchSettingsFile(dataDir, path.join(dataDir, claudeCompactHookSettingsFileName), hookSettings);
  return written === null ? [] : ['--settings', written];
}

/** Write `settings` to `settingsPath` atomically (`0600`); the path, or `null` when the write failed (logged). */
function writeLaunchSettingsFile(dir: string, settingsPath: string, settings: object): string | null {
  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings), { mode: 0o600 });
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    console.warn(`[compact-hook] cannot write ${settingsPath}:`, e);
    try { fs.unlinkSync(tmpPath); } catch { /* never written */ }
    return null;
  }
  return settingsPath;
}
