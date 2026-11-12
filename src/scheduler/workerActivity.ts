import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatCheckStatusActivity } from './checkStatus';
import { checkIsRecord } from '../utils/checkIsRecord';

/**
 * @description The «now» of a worker's status line: what a detached worker (a `claude -p --output-format stream-json` or an
 * `opencode run --format json` process an agent launched) did LAST — its latest text or its latest tool call, whichever came
 * later in its event log. It is a port of what the delegate skills' `summarize-events.py` extracts, with no Python: the bot
 * reads the log itself, because the whole point of the status line is that no agent runs.
 *
 * The delegate skills write the log as `events.jsonl` in the worker's run directory and a resumed run as `events-2.jsonl`,
 * `events-3.jsonl`, …; the newest of them (by modification time) is the live one.
 */

/** How much of the log's end is read: the longest gap between two assistant events in a real 8.6 MB log was 430 KB. */
export const workerActivityTailBytes = 1024 * 1024;

/** `events.jsonl`, `events-2.jsonl`, …; the capture is the run's number. */
const eventLogNamePattern = /^events(?:-(\d+))?\.jsonl$/;

/** The number of the first run's `events.jsonl`, which carries no suffix. */
const firstRunNumber = 1;

/** A text field that reads as absent when it is not a string: one oddly typed field must not hide the whole call. */
const optionalTextSchema = z.string().optional().catch(undefined);

/** Claude's tool input keys that say what a call does, most descriptive first. */
const claudeToolInputSchema = z.looseObject({
  description: optionalTextSchema,
  command: optionalTextSchema,
  file_path: optionalTextSchema,
  pattern: optionalTextSchema,
  prompt: optionalTextSchema,
});

/** One content block of a Claude `assistant` event; a block of any other type (thinking, …) fails the parse and is skipped. */
const claudeBlockSchema = z.union([
  z.looseObject({ type: z.literal('tool_use'), name: z.string(), input: claudeToolInputSchema.optional() }),
  z.looseObject({ type: z.literal('text'), text: z.string() }),
]);

const claudeAssistantEventSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ content: z.array(z.looseObject({})) }),
});

const openCodeToolEventSchema = z.looseObject({
  type: z.literal('tool_use'),
  part: z.looseObject({
    tool: z.string(),
    state: z
      .looseObject({
        title: optionalTextSchema,
        input: z.looseObject({ description: optionalTextSchema }).optional().catch(undefined),
      })
      .optional(),
  }),
});

const openCodeTextEventSchema = z.looseObject({
  type: z.literal('text'),
  part: z.looseObject({ text: z.string() }),
});

/** @description «<tool>: <what it does>», or the bare tool name when the call says nothing about itself. */
function describeToolCall(toolName: string, detail: string | undefined): string {
  const readableDetail = detail === undefined ? '' : detail.trim();
  return readableDetail === '' ? toolName : `${toolName}: ${readableDetail}`;
}

/** @description The first non-blank of the given texts. */
function getFirstReadable(candidates: readonly (string | undefined)[]): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && candidate.trim() !== '');
}

/** @description The last readable thing a Claude `assistant` event says (its last tool call or non-blank text), or `null`. */
function getClaudeEventActivity(eventValue: object): string | null {
  const event = claudeAssistantEventSchema.safeParse(eventValue);
  if (!event.success) return null;
  for (const rawBlock of [...event.data.message.content].reverse()) {
    const block = claudeBlockSchema.safeParse(rawBlock);
    if (!block.success) continue;
    if (block.data.type === 'text') {
      if (block.data.text.trim() !== '') return block.data.text;
      continue;
    }
    const input = block.data.input;
    return describeToolCall(
      block.data.name,
      input === undefined ? undefined : getFirstReadable([input.description, input.command, input.file_path, input.pattern, input.prompt]),
    );
  }
  return null;
}

/** @description What an OpenCode `tool_use` or `text` event says, or `null`. */
function getOpenCodeEventActivity(eventValue: object): string | null {
  const toolEvent = openCodeToolEventSchema.safeParse(eventValue);
  if (toolEvent.success) {
    const { tool, state } = toolEvent.data.part;
    return describeToolCall(tool, getFirstReadable([state?.input?.description, state?.title]));
  }
  const textEvent = openCodeTextEventSchema.safeParse(eventValue);
  if (textEvent.success && textEvent.data.part.text.trim() !== '') return textEvent.data.part.text;
  return null;
}

/** @description Parse one log line to a JSON object, or `null` for a blank, torn or non-object line. */
function parseEventLine(line: string): object | null {
  if (line.trim() === '') return null;
  try {
    const parsed: object | null = JSON.parse(line);
    return checkIsRecord(parsed) ? parsed : null;
  } catch {
    return null; // a line the worker is still writing
  }
}

/**
 * @description The worker's last readable activity from log lines (oldest first): scanning from the end, the newest line that
 * is a Claude `assistant` event with a text or tool call, or an OpenCode `text` / `tool_use` event. Everything else —
 * `stream_event`, `user`, `system`, `tool_progress`, `step_finish`, a torn line — is noise and is skipped. One line,
 * whitespace collapsed, at most `checkStatusActivityMaxChars` characters; `null` when nothing is readable.
 */
export function getWorkerActivityFromLines(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseEventLine(lines[index]);
    if (event === null) continue;
    const activity = getClaudeEventActivity(event) ?? getOpenCodeEventActivity(event);
    if (activity !== null) return formatCheckStatusActivity(activity);
  }
  return null;
}

/** @description The run number an event log's name carries (`events.jsonl` → 1, `events-3.jsonl` → 3), or `null` for any other name. */
function getEventLogRunNumber(fileName: string): number | null {
  const match = eventLogNamePattern.exec(fileName);
  if (match === null) return null;
  return match[1] === undefined ? firstRunNumber : Number.parseInt(match[1], 10);
}

/** @description The newest event log directly in `runDir` (modification time, the higher run number on a tie), or `null`. */
async function getNewestEventLogPath(runDir: string): Promise<string | null> {
  const fileNames = await readdir(runDir);
  let newest: { filePath: string; modifiedMs: number; runNumber: number } | null = null;
  for (const fileName of fileNames) {
    const runNumber = getEventLogRunNumber(fileName);
    if (runNumber === null) continue;
    const filePath = path.join(runDir, fileName);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;
    const isNewer =
      newest === null ||
      fileStat.mtimeMs > newest.modifiedMs ||
      (fileStat.mtimeMs === newest.modifiedMs && runNumber > newest.runNumber);
    if (isNewer) newest = { filePath, modifiedMs: fileStat.mtimeMs, runNumber };
  }
  return newest === null ? null : newest.filePath;
}

/** @description The complete lines of the last {@link workerActivityTailBytes} of a file (a cut first line is dropped). */
async function readLogTailLines(filePath: string): Promise<string[]> {
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    const startPosition = Math.max(0, size - workerActivityTailBytes);
    const buffer = Buffer.alloc(size - startPosition);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, startPosition);
    const lines = buffer.subarray(0, bytesRead).toString('utf-8').split('\n');
    return startPosition > 0 ? lines.slice(1) : lines;
  } finally {
    await file.close();
  }
}

/** @description Whether a failed read only means the run has no log (yet): no such directory, or no directory at all. */
function checkIsMissingPathError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/**
 * @description What the worker whose run directory is `runDir` did last, read from its newest event log. Never rejects: a
 * missing directory or log, or a log with nothing readable, is `null` — the status line is then posted without its «now». A
 * failure that is NOT «no such path» (permissions, an I/O error) is logged, then `null` too.
 */
export async function readWorkerActivity(runDir: string): Promise<string | null> {
  try {
    const logPath = await getNewestEventLogPath(runDir);
    return logPath === null ? null : getWorkerActivityFromLines(await readLogTailLines(logPath));
  } catch (error) {
    if (error instanceof Error && !checkIsMissingPathError(error)) {
      console.warn(`[scheduler] reading the worker's event log in "${runDir}" failed:`, error.message);
    }
    return null;
  }
}
