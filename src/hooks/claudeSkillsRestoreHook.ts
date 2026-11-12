/**
 * @description The Claude skills restore's `SessionStart` hook (matcher `compact`), run by the CLI right after every
 * compaction — one process per slot (`utils/claudeCompactHook.ts` writes `node <this file> <slot> <slot count>
 * [<unavailable skills dir>]` into the launch settings). Each reads the hook input on stdin, works out the WHOLE restore —
 * the skills the transcript shows were loaded since the previous compaction, their current text — and prints its own part
 * as `hookSpecificOutput.additionalContext` (`utils/skillsRestore.ts`). All slots compute the same restore from the same
 * transcript and files, so the parts fit together; a slot past the last part prints nothing.
 *
 * Runs inside the agent's process, long after the bot started it, and must never disturb it: it imports only pure modules
 * (no `bot.ts`, no environment), and on ANY doubt — input that is not a compaction's, a sub-agent's (`agent_id`), a missing
 * transcript, no skill — it prints nothing and exits 0.
 *
 * Measured on Claude Code 2.1.322 for this design (plan S0): the hooks of one `SessionStart` all run, in parallel; the
 * transcript does not yet hold the compaction's own boundary and summary while they run (`PostCompact` comes after), so the
 * last epoch read back here is exactly what the compaction summarised.
 */

import fs from 'fs';
import path from 'path';
import { readClaudeTranscriptEpochLines } from '../utils/claudeTranscriptEpoch';
import { checkIsRecord } from '../utils/checkIsRecord';
import {
  buildClaudeSkillsRestoreParts,
  checkIsClaudeSkillRecordLine,
  collectClaudeEpochSkills,
  planClaudeSkillsRestore,
  skillsRestorePartMaxChars,
  skillsRestoreTexts,
} from '../utils/skillsRestore';

/** The `SessionStart` source of a compaction. */
const compactSource = 'compact';
const skillFileName = 'SKILL.md';

/** The hook's command line: its slot (1-based), the slot count of the launch, and the folder of skills it cannot load. */
interface SkillsRestoreHookArguments {
  slot: number;
  slotCount: number;
  unavailableSkillsDir: string | null;
}

/** @description Read the command line, `null` when it is not the one the launch settings write. */
function readHookArguments(argv: readonly string[]): SkillsRestoreHookArguments | null {
  const [slotText, slotCountText, unavailableSkillsDir] = argv;
  const slot = Number(slotText);
  const slotCount = Number(slotCountText);
  if (!Number.isInteger(slot) || !Number.isInteger(slotCount) || slot < 1 || slot > slotCount) return null;
  return { slot, slotCount, unavailableSkillsDir: unavailableSkillsDir === undefined || unavailableSkillsDir === '' ? null : unavailableSkillsDir };
}

/** @description The `SKILL.md` of a folder, `null` when it is gone or unreadable. */
function readSkillFile(baseDir: string): string | null {
  try {
    return fs.readFileSync(path.join(baseDir, skillFileName), 'utf8');
  } catch {
    return null;
  }
}

/**
 * @description What the hook prints for `inputText` (the hook input JSON) — the hook output JSON with this slot's part of the
 * restore, or `null` for nothing.
 */
export function getSkillsRestoreHookOutput(inputText: string, hookArguments: SkillsRestoreHookArguments): string | null {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return null;
  }
  if (!checkIsRecord(input) || 'agent_id' in input || input.source !== compactSource || typeof input.transcript_path !== 'string') return null;
  const epoch = collectClaudeEpochSkills(readClaudeTranscriptEpochLines(input.transcript_path, checkIsClaudeSkillRecordLine));
  const entries = planClaudeSkillsRestore(epoch, { readSkillFile }, hookArguments.unavailableSkillsDir);
  const part = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, hookArguments.slotCount, skillsRestorePartMaxChars)[hookArguments.slot - 1];
  if (part === undefined) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: part } });
}

function main(): void {
  const hookArguments = readHookArguments(process.argv.slice(2));
  let inputText = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    inputText += chunk;
  });
  process.stdin.on('end', () => {
    if (hookArguments === null) return;
    try {
      const output = getSkillsRestoreHookOutput(inputText, hookArguments);
      if (output !== null) process.stdout.write(output);
    } catch (e) {
      // Nothing on stdout: a restore that cannot be worked out must not put half of one, or an error, in the agent's context.
      // Stderr of a hook that exits 0 stays out of it too; the CLI's debug log keeps it.
      process.stderr.write(`[charness skills restore] ${e instanceof Error ? e.message : String(e)}\n`);
    }
  });
}

if (require.main === module) main();
