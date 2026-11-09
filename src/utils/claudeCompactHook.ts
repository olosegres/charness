/**
 * @description The `PreCompact` hook the bot hands every Claude session it starts,
 * so the compaction Claude runs ON ITS OWN when the context overflows gets the
 * same summary guidance as a bot-issued one.
 *
 * WHY this exists: a bot-issued compaction carries its instruction as
 * `/compact <instruction>`, but the overflow-triggered (auto) compaction is started
 * by the CLI itself and has no argument the bot could fill. It summarised with the
 * default prompt: the loaded skills were not named and no next-steps checklist
 * closed the summary, so the continuing session silently stopped following those
 * skills. The hook adds the resume guidance (`compactionResumeGuidance`: the skills
 * to load again, the agent-mistakes section the bot posts to the topic, then that checklist). Claude Code runs `PreCompact` hooks before
 * EVERY compaction (`trigger` `auto` and `manual`) and appends a hook's stdout to
 * that compaction's custom instructions — measured on v2.1.289: an
 * overflow-triggered compaction's summary opened with the line the hook printed.
 * The hook rides `--settings <file>`, which is merged with the user's own settings
 * and never writes to them.
 *
 * A bot-issued compaction already carries the same text, so the hook prints
 * nothing when the compaction's `custom_instructions` (part of the JSON the hook
 * reads on stdin) already contain the resume guidance both variants share (the
 * loaded skills and the next-steps checklist) — otherwise the model would get the
 * instruction twice.
 *
 * The agent-mistakes section is the part `/compact_mistakes` switches: the hook runs inside the agent's process, long after
 * the bot started it, so it looks for the flag the bot keeps for the session (`utils/compactMistakesFlags.ts`, named by the
 * `session_id` of its stdin) and prints the instruction without the section request while the flag exists.
 *
 * The same launch settings carry the shared todo lists' `PostToolUse` hook
 * (`todos/midTurn.ts`): it prints the session's inbox — the project board's
 * changes — after a tool call, and nothing when there is none.
 */

import fs from 'fs';
import path from 'path';
import {
  buildCompactionInstruction,
  compactionResumeGuidanceWithoutGaps,
  compactionSummaryGuidance,
  getCompactionResumeGuidance,
} from './compactOnIdle';
import { getClaudeCompactMistakesOffDir } from './compactMistakesFlags';
import { shellSingleQuote } from './tmuxExec';
import { checkHasClaudeProfileApiKey, claudeProfileLaunchSettingsFileName } from './claudeProfiles';
import { buildClaudeApiKeyHelperSettings } from './claudeApiKeyHelper';
import { buildTodoInboxHookCommand, getTodoInboxDir } from '../todos/midTurn';

/**
 * Name of the hook settings file inside `DATA_DIR`. ONE file shared by every
 * session: its content is the same for all of them, and a session that outlives
 * the bot (json-stream) must never find it deleted under it.
 */
export const claudeCompactHookSettingsFileName = 'claude-compact-hook.json';

/**
 * @description The instruction the hook adds to a compaction the bot did not
 * issue: D3 + the resume guidance, with the agent-mistakes section while `/compact_mistakes` is on for the session's topic
 * and without it while off. No closing section — that one exists for the
 * bot's own idle-compaction report, which an overflow compaction never feeds; the
 * checklist then ends the summary itself.
 */
export function getHookCompactionInstruction(isWithInstructionGaps: boolean): string {
  return buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: getCompactionResumeGuidance(isWithInstructionGaps),
  }) ?? '';
}

/**
 * The shell that reads the session id out of the hook's stdin JSON (`session_id`, which is what the bot named the flag
 * after) and empties it unless it is made of the characters a flag name may hold: the text comes from outside the bot and
 * must never take the path out of the flag folder.
 */
const readSessionIdFromHookInputShell = `sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p'`;

/**
 * @description Build the hook's shell command: print nothing when the hook's stdin (the `PreCompact` input JSON) already
 * contains `alreadySentMarker`; otherwise print `instructionWithoutGaps` when a flag named after the input's `session_id`
 * exists in `offFlagDir` (the topic's `/compact_mistakes` is off, `utils/compactMistakesFlags.ts`) and `instruction` when it
 * does not. The marker is matched as a fixed string against the raw JSON, so it must be text JSON leaves unescaped — the
 * caller passes the resume guidance both variants share, and a test pins that it qualifies.
 */
export function buildPreCompactHookCommand(input: {
  instruction: string;
  instructionWithoutGaps: string;
  alreadySentMarker: string;
  offFlagDir: string;
}): string {
  return [
    'input=$(cat)',
    `if printf '%s' "$input" | grep -qF -e ${shellSingleQuote(input.alreadySentMarker)}; then exit 0; fi`,
    `session=$(printf '%s' "$input" | ${readSessionIdFromHookInputShell})`,
    `case "$session" in ''|*[!A-Za-z0-9_-]*) session= ;; esac`,
    `if [ -n "$session" ] && [ -e ${shellSingleQuote(input.offFlagDir)}/"$session" ]; then printf '%s\\n' ${shellSingleQuote(input.instructionWithoutGaps)}; else printf '%s\\n' ${shellSingleQuote(input.instruction)}; fi`,
  ].join('; ');
}

/** One command hook with no matcher (every compaction, every tool). */
type CommandHookGroups = Array<{ hooks: Array<{ type: 'command'; command: string }> }>;

/**
 * @description The `--settings` payload: the `PreCompact` command hook (auto AND manual compactions) and the shared
 * todo lists' `PostToolUse` inbox hook (every tool: the project board's changes reach a working agent with its next
 * tool result, `todos/midTurn.ts`).
 */
export function buildClaudeLaunchHookSettings(commands: { preCompact: string; postToolUse: string }): {
  hooks: { PreCompact: CommandHookGroups; PostToolUse: CommandHookGroups };
} {
  return {
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: commands.preCompact }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: commands.postToolUse }] }],
    },
  };
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
  const hookSettings = buildClaudeLaunchHookSettings({
    preCompact: buildPreCompactHookCommand({
      instruction: getHookCompactionInstruction(true),
      instructionWithoutGaps: getHookCompactionInstruction(false),
      alreadySentMarker: compactionResumeGuidanceWithoutGaps,
      offFlagDir: getClaudeCompactMistakesOffDir(dataDir),
    }),
    postToolUse: buildTodoInboxHookCommand(getTodoInboxDir(dataDir)),
  });
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
