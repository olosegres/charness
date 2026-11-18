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
 * to load again, the self-review section the bot posts to the topic, then that checklist). Claude Code runs `PreCompact` hooks before
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
 * The self-review section is the part `/compact_self_review` switches: the hook runs inside the agent's process, long after
 * the bot started it, so it looks for the flag the bot keeps for the session (`utils/compactSelfReviewFlags.ts`, named by the
 * `session_id` of its stdin) and prints the instruction without the section request while the flag exists.
 *
 * The same launch settings carry the shared todo lists' `PostToolUse` hook
 * (`todos/midTurn.ts`): it prints the session's inbox — the project board's
 * changes — after a tool call, and nothing when there is none.
 *
 * A json-stream / per-turn launch also carries the skills restore: {@link skillsRestoreSlotCount} `SessionStart` hooks with
 * the matcher `compact`, each printing one part of the skills the session had loaded (`hooks/claudeSkillsRestoreHook.ts`),
 * chained so the parts land by number.
 * Measured on Claude Code 2.1.322 (`-p`, stream-json): a `SessionStart` `compact` hook runs after EVERY compaction — the
 * CLI's own mid-turn ones and a `/compact` turn — and what it gives as `additionalContext` is in the very next model request,
 * the same turn's when the agent goes on alone; the CLI stores it in the transcript (`hook_additional_context`), so a
 * resumed session (a stopped process, a restarted bot) still sends it. The tmux backend is frozen and gets none: a
 * compaction there keeps asking the agent to load its skills again.
 */

import fs from 'fs';
import path from 'path';
import {
  buildCompactionInstruction,
  compactionResumeGuidanceWithoutGaps,
  compactionSummaryGuidance,
  getCompactionResumeGuidance,
} from './compactOnIdle';
import { getClaudeCompactSelfReviewOffDir } from './compactSelfReviewFlags';
import { shellSingleQuote } from './tmuxExec';
import { checkHasClaudeProfileApiKey, claudeProfileLaunchSettingsFileName, claudeProfileSkillsRestoreSettingsFileNames } from './claudeProfiles';
import { buildClaudeApiKeyHelperSettings } from './claudeApiKeyHelper';
import { buildTodoInboxHookCommand, getTodoInboxDir } from '../todos/midTurn';
import { skillsRestoreSlotCount } from './skillsRestore';

/**
 * Names of the hook settings files inside `DATA_DIR`, one per kind of launch: ONE file shared by every session of that kind
 * (its content is the same for all of them, and a session that outlives the bot must never find it deleted under it), and a
 * file per kind, so two sessions starting at once never read each other's hooks. The tmux backend's file keeps its name and
 * content (no skills restore); a json-stream launch takes the one that matches whether it loads the bot's skills.
 */
export const claudeCompactHookSettingsFileName = 'claude-compact-hook.json';
export const claudeSkillsRestoreHookSettingsFileNames = {
  withBotSkills: 'claude-launch-hooks.json',
  withoutBotSkills: 'claude-launch-hooks-without-bot-skills.json',
} as const;

/**
 * Where the restore hook is: `dist/hooks/claudeSkillsRestoreHook.js`, beside this module's `dist/utils/`. Run by the bot's own
 * `node` (written at every launch, as the todo hook's); the hook command checks the file first, so a launch from the sources
 * (the test runner, where it is `.ts`) simply has no restore.
 */
export const claudeSkillsRestoreHookPath = path.join(__dirname, '..', 'hooks', 'claudeSkillsRestoreHook.js');

/**
 * @description The folder inside `DATA_DIR` where the restore's slots of one compaction leave their done-markers, so the parts
 * land strictly by number (`hooks/claudeSkillsRestoreHook.ts`). Shared by every session: a marker is named after its
 * compaction, and old ones are swept by the slots themselves.
 */
export function getSkillsRestoreOrderDir(dataDir: string): string {
  return path.join(dataDir, 'skills-restore-order');
}

/**
 * @description The instruction the hook adds to a compaction the bot did not
 * issue: D3 + the resume guidance, with the self-review section while `/compact_self_review` is on for the session's topic
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
 * exists in `offFlagDir` (the topic's `/compact_self_review` is off, `utils/compactSelfReviewFlags.ts`) and `instruction` when it
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

/**
 * @description The shell commands of the restore's `SessionStart` hook slots: slot `i` (1-based) runs `nodePath hookPath i
 * slotCount <unavailableSkillsDir or ''> orderDir` and prints part `i` of the restore, or nothing, in turn after slot `i - 1`
 * (the chain's markers go to `orderDir`). The folders come after the numbers, an empty argument for none, so a hook of either
 * age reads a command line of either age (an older one ignores the chain's folder; a newer one without it runs no chain). A
 * missing hook file (a launch from the sources) prints nothing; every command reads its input whole (the CLI must never
 * write into a closed pipe) and exits 0 — a hook failure must never stop the agent.
 */
export function buildSkillsRestoreHookCommands(input: { nodePath: string; hookPath: string; slotCount: number; unavailableSkillsDir: string | null; orderDir: string }): string[] {
  const hook = shellSingleQuote(input.hookPath);
  const folderArguments = `${shellSingleQuote(input.unavailableSkillsDir ?? '')} ${shellSingleQuote(input.orderDir)}`;
  return Array.from({ length: input.slotCount }, (_unused, index) => [
    `[ -f ${hook} ] || { cat > /dev/null; exit 0; }`,
    `${shellSingleQuote(input.nodePath)} ${hook} ${index + 1} ${input.slotCount} ${folderArguments}`,
    'exit 0',
  ].join('; '));
}

/** Command hooks under one matcher (none: every compaction, every tool); `timeout` in seconds (none: the CLI's default). */
type CommandHookGroups = Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>;

/** The `SessionStart` source of a compaction, auto or manual: the matcher of the restore's hooks. */
const sessionStartCompactMatcher = 'compact';

/**
 * How long the CLI lets one restore slot run, in seconds. The CLI holds the compaction — and so the agent — until its hooks
 * end, and its default is far longer than this work needs (read one transcript epoch and a few files, then wait for the
 * slots before it — the chain gives up by itself well inside this, `skillsRestoreSlotChainTimings`); a slot cut off prints
 * nothing, which every slot already does on any failure.
 */
export const skillsRestoreHookTimeoutSeconds = 30;

/**
 * @description The `--settings` payload: the `PreCompact` command hook (auto AND manual compactions), the shared
 * todo lists' `PostToolUse` inbox hook (every tool: the project board's changes reach a working agent with its next
 * tool result, `todos/midTurn.ts`) and, when there are any, the restore's `SessionStart` hooks for the `compact` source.
 */
export function buildClaudeLaunchHookSettings(commands: { preCompact: string; postToolUse: string; sessionStartCompact: readonly string[] }): {
  hooks: { PreCompact: CommandHookGroups; PostToolUse: CommandHookGroups; SessionStart?: CommandHookGroups };
} {
  const hooks: { PreCompact: CommandHookGroups; PostToolUse: CommandHookGroups; SessionStart?: CommandHookGroups } = {
    PreCompact: [{ hooks: [{ type: 'command', command: commands.preCompact }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: commands.postToolUse }] }],
  };
  if (commands.sessionStartCompact.length > 0) {
    hooks.SessionStart = [{
      matcher: sessionStartCompactMatcher,
      hooks: commands.sessionStartCompact.map((command) => ({ type: 'command' as const, command, timeout: skillsRestoreHookTimeoutSeconds })),
    }];
  }
  return { hooks };
}

/** What a launch's hooks include besides the compaction guidance and the todo inbox. */
export interface ClaudeLaunchHookOptions {
  /**
   * The skills restore (json-stream and per-turn launches) — `null` for none (the tmux backend, frozen). `unavailableSkillsDir`:
   * the folder of the bot's own skills when this launch does NOT load them (switched off, or a CLI too old for `--plugin-dir`),
   * so the restore calls them "not available now" instead of handing their text to a session that cannot load them.
   */
  skillsRestore: { unavailableSkillsDir: string | null } | null;
}

/**
 * @description Write the launch settings file and return the `--settings <path>` argument pair for a Claude
 * launch under `configDir` (the account profile's directory, `null` = `~/.claude`). Rewritten on every launch
 * (atomic rename, so a concurrently starting session never reads a half-written file) so a changed guidance
 * reaches the next session — and a file an agent rewrote between launches (`DATA_DIR` is writable by the agents' user) never does:
 * Claude Code reads the file once at its start and keeps that content (2.1.304). Each kind of launch
 * ({@link ClaudeLaunchHookOptions}) has a file of its own.
 *
 * Only the LAST `--settings` a launch carries counts (probed on 2.1.304), so a profile that holds a pasted API key
 * (`utils/claudeProfiles.ts`) gets ONE file of its own per kind, in its directory: the hooks plus the `apiKeyHelper` that
 * reads the key. Every other launch shares the hook file in `dataDir`. A write failure of the shared file returns
 * `[]` and only logs (the hooks improve a summary, they must never stop an agent from starting); for a key profile
 * the same settings go inline instead, so the account never loses its key to a full disk.
 */
export function prepareClaudeCompactHookFlags(dataDir: string, configDir: string | null, options: ClaudeLaunchHookOptions): string[] {
  const { skillsRestore } = options;
  const hookSettings = buildClaudeLaunchHookSettings({
    preCompact: buildPreCompactHookCommand({
      instruction: getHookCompactionInstruction(true),
      instructionWithoutGaps: getHookCompactionInstruction(false),
      alreadySentMarker: compactionResumeGuidanceWithoutGaps,
      offFlagDir: getClaudeCompactSelfReviewOffDir(dataDir),
    }),
    postToolUse: buildTodoInboxHookCommand(getTodoInboxDir(dataDir)),
    sessionStartCompact: skillsRestore === null
      ? []
      : buildSkillsRestoreHookCommands({
        nodePath: process.execPath,
        hookPath: claudeSkillsRestoreHookPath,
        slotCount: skillsRestoreSlotCount,
        unavailableSkillsDir: skillsRestore.unavailableSkillsDir,
        orderDir: getSkillsRestoreOrderDir(dataDir),
      }),
  });
  const isWithBotSkills = skillsRestore?.unavailableSkillsDir === null;
  if (configDir !== null && checkHasClaudeProfileApiKey(configDir)) {
    const settings = { ...hookSettings, ...buildClaudeApiKeyHelperSettings(configDir) };
    const fileName = skillsRestore === null
      ? claudeProfileLaunchSettingsFileName
      : claudeProfileSkillsRestoreSettingsFileNames[isWithBotSkills ? 'withBotSkills' : 'withoutBotSkills'];
    const written = writeLaunchSettingsFile(configDir, path.join(configDir, fileName), settings);
    return ['--settings', written ?? JSON.stringify(settings)];
  }
  const fileName = skillsRestore === null
    ? claudeCompactHookSettingsFileName
    : claudeSkillsRestoreHookSettingsFileNames[isWithBotSkills ? 'withBotSkills' : 'withoutBotSkills'];
  const written = writeLaunchSettingsFile(dataDir, path.join(dataDir, fileName), hookSettings);
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
