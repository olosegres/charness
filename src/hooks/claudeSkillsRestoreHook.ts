/**
 * @description The Claude skills restore's `SessionStart` hook (matcher `compact`), run by the CLI right after every
 * compaction — one process per slot (`utils/claudeCompactHook.ts` writes `node <this file> <slot> <slot count>
 * <unavailable skills dir or ''> <order dir>` into the launch settings). Each reads the hook input on stdin, works out the
 * WHOLE restore — the skills the transcript shows were loaded since the previous compaction, their current text — and prints
 * its own part as `hookSpecificOutput.additionalContext` (`utils/skillsRestore.ts`). All slots compute the same restore from
 * the same transcript and files, so the parts fit together; a slot past the last part prints nothing.
 *
 * The parts reach the agent strictly by number: the CLI runs the hooks of one event in parallel and takes each one's output
 * when its process ends, so unchained slots land in any order (measured on Claude Code 2.1.323: five parts reached the
 * transcript as [5, 2, 1, 3, 4]). The slots therefore form a chain ({@link waitForPreviousSlot}): slot i prints only once slot
 * i-1 has printed and its process is gone, with a bound so a broken slot never holds the rest back. The part labels stay as
 * the backstop. A launch written before the chain passes no order folder and gets none.
 *
 * Runs inside the agent's process, long after the bot started it, and must never disturb it: it imports only pure modules
 * (no `bot.ts`, no environment), and on ANY doubt — input that is not a compaction's, a sub-agent's (`agent_id`), a missing
 * transcript, no skill — it prints nothing and exits 0.
 *
 * Measured on Claude Code 2.1.322 for this design (plan S0): the hooks of one `SessionStart` all run, in parallel; the
 * transcript does not yet hold the compaction's own boundary and summary while they run (`PostCompact` comes after), so the
 * last epoch read back here is exactly what the compaction summarised.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { readClaudeTranscriptEpochLines } from '../utils/claudeTranscriptEpoch';
import { checkIsRecord } from '../utils/checkIsRecord';
import {
  buildClaudeSkillsRestoreParts,
  claudeSkillRecordKeys,
  collectClaudeEpochSkills,
  planClaudeSkillsRestore,
  skillsRestorePartMaxChars,
  skillsRestoreTexts,
} from '../utils/skillsRestore';

/** The `SessionStart` source of a compaction. */
const compactSource = 'compact';

/** The hook's command line: its slot (1-based), the slot count of the launch, the folder of skills it cannot load, the chain's folder. */
export interface SkillsRestoreHookArguments {
  slot: number;
  slotCount: number;
  unavailableSkillsDir: string | null;
  /** Where the slots of a compaction leave their done-markers; `null` (a launch written before the chain): no chain. */
  orderDir: string | null;
}

/** @description Read the command line, `null` when it is not the one the launch settings write. An empty argument is none. */
function readHookArguments(argv: readonly string[]): SkillsRestoreHookArguments | null {
  const [slotText, slotCountText, unavailableSkillsDir, orderDir] = argv;
  const slot = Number(slotText);
  const slotCount = Number(slotCountText);
  if (!Number.isInteger(slot) || !Number.isInteger(slotCount) || slot < 1 || slot > slotCount) return null;
  const getPathArgument = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);
  return { slot, slotCount, unavailableSkillsDir: getPathArgument(unavailableSkillsDir), orderDir: getPathArgument(orderDir) };
}

/** @description The text of a skill file (its full path), `null` when it is gone or unreadable. */
function readSkillFile(skillFile: string): string | null {
  try {
    return fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
}

/** What one slot does for a compaction. */
export interface SkillsRestoreSlotPlan {
  /** The hook JSON it prints, `null` for nothing. */
  output: string | null;
  /**
   * The compaction it belongs to: a hash of the transcript and of the epoch lines the restore is built from — the same for
   * every slot of one compaction, another for every later one (each epoch holds records of its own, a uuid in each). `null`
   * when there is nothing to restore, or no compaction: then there is no chain.
   */
  eventId: string | null;
  /** How many parts the whole restore has (0 for none): the slot with the last one ends the chain. */
  partCount: number;
}

/** How many hex characters of the hash name a compaction in the marker files. */
const eventIdLength = 24;

/** @description What slot `hookArguments.slot` does for `inputText` (the hook input JSON). */
export function planSkillsRestoreSlot(inputText: string, hookArguments: SkillsRestoreHookArguments): SkillsRestoreSlotPlan {
  const nothing: SkillsRestoreSlotPlan = { output: null, eventId: null, partCount: 0 };
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return nothing;
  }
  if (!checkIsRecord(input) || 'agent_id' in input || input.source !== compactSource || typeof input.transcript_path !== 'string') return nothing;
  const epochLines = readClaudeTranscriptEpochLines(input.transcript_path, claudeSkillRecordKeys);
  const entries = planClaudeSkillsRestore(collectClaudeEpochSkills(epochLines), { readSkillFile }, hookArguments.unavailableSkillsDir);
  const parts = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, hookArguments.slotCount, skillsRestorePartMaxChars);
  if (parts.length === 0) return nothing;
  const eventId = createHash('sha256').update(input.transcript_path).update('\n').update(epochLines.join('\n')).digest('hex').slice(0, eventIdLength);
  const part = parts[hookArguments.slot - 1];
  if (part === undefined) return { output: null, eventId, partCount: parts.length };
  return { output: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: part } }), eventId, partCount: parts.length };
}

// ── The chain: the parts land by number ──

/** How the slots of one compaction wait for each other. */
export interface SlotChainTimings {
  /**
   * How long a slot waits for EACH predecessor that has not finished, counted from the chain's last step: a slot two links
   * behind a broken one waits twice as long, so the broken one's successor gives up first and the order holds after it.
   */
  slotWaitMs: number;
  /** No slot waits longer than this from its own start, whatever happens: well inside the CLI's timeout of a hook. */
  chainCapMs: number;
  /** An extra pause after the previous slot's process is gone, before this slot prints. */
  settleMs: number;
  pollMs: number;
}

/**
 * The chain's timings, from the live probe (`live/skillsRestoreLive.test.ts`, Claude Code 2.1.323, a shared machine at a load
 * of about 10, four compactions of five parts each): every restore landed as [1, 2, 3, 4, 5]; the CLI took consecutive parts
 * 16 to 236 ms apart (median 46), once 784 ms where a slot itself started late, and the last part 1.1–1.3 s after the first
 * hook started. So no settle pause: once the previous slot's process is gone the CLI already holds its output, and this
 * slot's own print and exit come later still. Three seconds per missing step leave room for a slot that starts slowly, and
 * twenty in all stay inside the 30-second hook timeout (`skillsRestoreHookTimeoutSeconds`).
 */
export const skillsRestoreSlotChainTimings: SlotChainTimings = { slotWaitMs: 3_000, chainCapMs: 20_000, settleMs: 0, pollMs: 20 };

/** How old a marker must be before the first slot of a later compaction deletes it: far past any chain. */
export const skillsRestoreMarkerMaxAgeMs = 10 * 60 * 1000;

/** What a slot leaves when it is done: its pid, and its parent's — the shell the CLI ran its command in. */
export interface SlotMarker {
  pid: number;
  parentPid: number;
}

/** A marker's file name (`<event id>-<slot>`), and the temporary one it is written under first. */
const markerNamePattern = /^[0-9a-f]+-\d+(\.\d+\.tmp)?$/;

function getSlotMarkerPath(orderDir: string, eventId: string, slot: number): string {
  return path.join(orderDir, `${eventId}-${slot}`);
}

/**
 * @description Leave slot `slot`'s done-marker for compaction `eventId` (written whole: a temporary file renamed). A marker
 * that cannot be written costs the next slot its wait bound, nothing else: never an error.
 */
export function writeSlotMarker(orderDir: string, eventId: string, slot: number, marker: SlotMarker = { pid: process.pid, parentPid: process.ppid }): void {
  const markerPath = getSlotMarkerPath(orderDir, eventId, slot);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(orderDir, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(marker));
    fs.renameSync(temporaryPath, markerPath);
  } catch {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** @description The marker a slot left, `null` when there is none or it cannot be read. */
function readSlotMarker(markerPath: string): SlotMarker | null {
  try {
    const marker: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return checkIsRecord(marker) && typeof marker.pid === 'number' && typeof marker.parentPid === 'number' ? { pid: marker.pid, parentPid: marker.parentPid } : null;
  } catch {
    return null;
  }
}

/** @description Whether process `pid` is gone — ended AND collected by its parent (a zombie is not gone: its end is not yet taken). */
function checkIsProcessGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return !(e instanceof Error && 'code' in e && e.code === 'EPERM');
  }
}

/** How a slot's wait ended: it is slot 1, the previous slot is done, or the bound ran out. */
export type SlotWaitOutcome = 'first' | 'afterPrevious' | 'timedOut';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * @description Wait until slot `slot - 1` of compaction `eventId` is done: its marker is there AND its process is gone — the
 * CLI takes a hook's output when the hook's process ends, so only then can this slot's output come after it. The process
 * waited for is the predecessor's shell (the CLI's own child) when the slots run in shells of their own, else the
 * predecessor itself. Gives up after {@link SlotChainTimings.slotWaitMs} per missing predecessor since the chain's last step,
 * and at {@link SlotChainTimings.chainCapMs} in any case. A marker of another compaction is never taken: its event id differs.
 */
export async function waitForPreviousSlot(input: { orderDir: string; eventId: string; slot: number; timings: SlotChainTimings }): Promise<SlotWaitOutcome> {
  const { orderDir, eventId, slot, timings } = input;
  if (slot <= 1) return 'first';
  const startedAt = Date.now();
  const capAt = startedAt + timings.chainCapMs;
  let lastStepAt = startedAt;
  let highestDone = 0;
  while (highestDone < slot - 1) {
    for (let candidate = slot - 1; candidate > highestDone; candidate -= 1) {
      if (!fs.existsSync(getSlotMarkerPath(orderDir, eventId, candidate))) continue;
      highestDone = candidate;
      lastStepAt = Date.now();
      break;
    }
    if (highestDone === slot - 1) break;
    if (Date.now() >= Math.min(lastStepAt + timings.slotWaitMs * (slot - 1 - highestDone), capAt)) return 'timedOut';
    await sleep(timings.pollMs);
  }
  const marker = readSlotMarker(getSlotMarkerPath(orderDir, eventId, slot - 1));
  if (marker !== null) {
    const waitedPid = marker.parentPid === process.ppid ? marker.pid : marker.parentPid;
    const goneBy = Math.min(lastStepAt + timings.slotWaitMs, capAt);
    while (!checkIsProcessGone(waitedPid)) {
      if (Date.now() >= goneBy) return 'timedOut';
      await sleep(timings.pollMs);
    }
  }
  if (timings.settleMs > 0) await sleep(timings.settleMs);
  return 'afterPrevious';
}

/** @description Delete every marker of compaction `eventId` in `orderDir`, and nothing else. */
function removeEventMarkers(orderDir: string, eventId: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(orderDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${eventId}-`) && markerNamePattern.test(name)) fs.rmSync(path.join(orderDir, name), { force: true });
  }
}

/** @description Delete the markers in `orderDir` last changed before `olderThanMs` (and their temporary files); nothing else. */
export function sweepStaleSlotMarkers(orderDir: string, olderThanMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(orderDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!markerNamePattern.test(name)) continue;
    const markerPath = path.join(orderDir, name);
    try {
      if (fs.statSync(markerPath).mtimeMs < olderThanMs) fs.rmSync(markerPath, { force: true });
    } catch {
      // Gone meanwhile: another slot swept it.
    }
  }
}

/**
 * @description One slot's whole run: work out its part; in a chain, wait for the previous slot, print, leave its own marker and
 * delete the one it waited for (only this slot ever reads it). A slot with no part leaves its marker at once, so nothing waits
 * on it. The slot with the LAST part ends the chain: it leaves no marker and deletes every one of its compaction (the empty
 * slots' too — they started with it and are long done). Slot 1 also sweeps markers older compactions left behind (a slot that
 * ended after the chain did, one cut off by the CLI).
 */
export async function runSkillsRestoreSlot(
  inputText: string,
  hookArguments: SkillsRestoreHookArguments,
  writeOutput: (output: string) => Promise<void>,
  timings: SlotChainTimings = skillsRestoreSlotChainTimings,
): Promise<void> {
  const plan = planSkillsRestoreSlot(inputText, hookArguments);
  const { orderDir, slot } = hookArguments;
  const chain = orderDir !== null && plan.eventId !== null ? { orderDir, eventId: plan.eventId } : null;
  if (plan.output !== null) {
    if (chain !== null) await waitForPreviousSlot({ ...chain, slot, timings });
    await writeOutput(plan.output);
  }
  if (chain !== null) {
    if (plan.output !== null && slot === plan.partCount) {
      removeEventMarkers(chain.orderDir, chain.eventId);
    } else {
      writeSlotMarker(chain.orderDir, chain.eventId, slot);
      if (plan.output !== null && slot > 1) fs.rmSync(getSlotMarkerPath(chain.orderDir, chain.eventId, slot - 1), { force: true });
    }
  }
  if (orderDir !== null && slot === 1) sweepStaleSlotMarkers(orderDir, Date.now() - skillsRestoreMarkerMaxAgeMs);
}

/** @description Write `output` to stdout and resolve once it is handed to the pipe (a pipe is asynchronous on macOS). */
function writeToStdout(output: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(output, () => resolve());
  });
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
    runSkillsRestoreSlot(inputText, hookArguments, writeToStdout).catch((e: unknown) => {
      // Nothing more on stdout: a restore that cannot be worked out must not put half of one, or an error, in the agent's
      // context. Stderr of a hook that exits 0 stays out of it too; the CLI's debug log keeps it.
      process.stderr.write(`[charness skills restore] ${e instanceof Error ? e.message : String(e)}\n`);
    });
  });
}

if (require.main === module) main();
