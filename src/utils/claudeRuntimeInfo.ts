import * as fs from 'fs';
import type { AgentRuntimeInfo } from '../types';
import { checkIsRecord } from './checkIsRecord';
import { scanClaudeTranscriptEpochBackwards } from './claudeTranscriptEpoch';

const claude45ContextWindowTokens = 200_000;
const claude46AndLaterContextWindowTokens = 1_000_000;
export const claudeRuntimeInfoTailBytes = 128 * 1024;

function checkIsTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function getClaudeContextUsedTokens(usage: unknown): number | null {
  if (!checkIsRecord(usage) || !checkIsTokenCount(usage.input_tokens)) return null;
  const outputTokens = usage.output_tokens;
  const cacheReadTokens = usage.cache_read_input_tokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens;
  if (
    (outputTokens !== undefined && !checkIsTokenCount(outputTokens)) ||
    (cacheReadTokens !== undefined && !checkIsTokenCount(cacheReadTokens)) ||
    (cacheCreationTokens !== undefined && !checkIsTokenCount(cacheCreationTokens))
  ) {
    return null;
  }
  return usage.input_tokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) + (outputTokens ?? 0);
}

/**
 * What a model call SAW as its context: the input and both cache counters — the output is what it wrote, which only the next call
 * sees. `null` for a usage that is no valid token record.
 */
function getClaudeCallInputTokens(usage: unknown): number | null {
  if (!checkIsRecord(usage) || !checkIsTokenCount(usage.input_tokens)) return null;
  const cacheReadTokens = usage.cache_read_input_tokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens;
  if ((cacheReadTokens !== undefined && !checkIsTokenCount(cacheReadTokens)) || (cacheCreationTokens !== undefined && !checkIsTokenCount(cacheCreationTokens))) return null;
  return usage.input_tokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
}

/** The key a transcript line must carry to be an assistant record: checked on the raw bytes before the line is decoded. */
const assistantRecordKey = Buffer.from('"type":"assistant"');

/**
 * @description The context size a transcript LINE's model call saw, when the line is a main-conversation assistant record with a
 * usage — the sub-agents' sidechain, a synthetic error message and a record with no tokens are not model calls of the conversation.
 */
function getClaudeAssistantLineCallInputTokens(lineBytes: Buffer): number | null {
  if (lineBytes.indexOf(assistantRecordKey) < 0) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(lineBytes.toString('utf8'));
  } catch {
    return null; // a line half written
  }
  if (!checkIsRecord(entry) || entry.type !== 'assistant' || entry.isSidechain === true || entry.isApiErrorMessage === true || !checkIsRecord(entry.message)) return null;
  const model = entry.message.model;
  if (typeof model !== 'string' || !model.trim() || model.startsWith(syntheticModelPrefix)) return null;
  const callInputTokens = getClaudeCallInputTokens(entry.message.usage);
  return callInputTokens !== null && callInputTokens > 0 ? callInputTokens : null;
}

/** Claude Code names the model of the messages it writes itself (an interrupt notice, an API error) `<synthetic>`: no model call. */
const syntheticModelPrefix = '<synthetic>';

/**
 * @description The context size, in tokens, of the FIRST model call after the transcript's last compaction — the compacted summary,
 * the system prompt and CLAUDE.md, the skills restored, the prompt: input + cache read + cache write of the first main-conversation
 * assistant record after the last `compact_boundary` (of the whole file when it was never compacted). This is what the conversation
 * weighs with everything loaded, the figure the idle compaction measures its growth from. The walk goes backwards from the end of the
 * file and keeps the oldest record it meets, so a long first turn — which pushes that record far out of any tail — costs the epoch's
 * reading, not the file's, and memory for one record. `null` when the file cannot be read or the epoch holds no model call yet.
 */
export async function readClaudeFirstCallContextTokens(filePath: string): Promise<number | null> {
  let firstCallTokens: number | null = null;
  const isRead = await scanClaudeTranscriptEpochBackwards(filePath, (lineBytes) => {
    // Newest to oldest: every record that qualifies replaces the one before, so the oldest is left.
    const callInputTokens = getClaudeAssistantLineCallInputTokens(lineBytes);
    if (callInputTokens !== null) firstCallTokens = callInputTokens;
  });
  return isRead ? firstCallTokens : null;
}

/**
 * @description The context size after the transcript's newest main-conversation model call (its input, cache and output): what the
 * conversation weighs now. `null` when it cannot be told (a file that cannot be read, no such record in the tail).
 */
export async function readClaudeContextUsedTokens(filePath: string): Promise<number | null> {
  try {
    return (await readClaudeRuntimeInfo(filePath)).contextUsedTokens;
  } catch {
    return null;
  }
}

/**
 * @description Return the documented context window for an exact Claude model
 * family. Unknown aliases and model ids deliberately stay unknown rather than
 * inheriting a default from a neighbouring model.
 *
 * The minor group is capped at two digits so a released id whose family carries
 * no minor at all (`claude-opus-4-20250514`) can never have its 8-digit DATE
 * read as the minor — that misread reported a 1M window for a 200k model.
 * Such an id has no minor to match on, so it stays honestly unknown.
 */
export function getClaudeContextWindowTokens(model: string): number | null {
  const match = model.toLowerCase().match(/(?:^|\/)claude-(?:opus|sonnet|haiku)-(\d+)-(\d{1,2})(?:-|$)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 4 && minor === 5) return claude45ContextWindowTokens;
  if (major === 5 || (major === 4 && minor >= 6)) return claude46AndLaterContextWindowTokens;
  return null;
}

/**
 * @description Parse the latest valid main-session runtime fields from a Claude
 * transcript. Sidechain records are not part of the topic's live conversation,
 * so their version, model, and usage must never overwrite main-session data.
 */
export function parseClaudeRuntimeInfo(transcript: string): AgentRuntimeInfo {
  let version: string | null = null;
  let latestContextEntry: { model: string; contextUsedTokens: number } | null = null;

  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!checkIsRecord(entry) || entry.isSidechain === true) continue;

    if (typeof entry.version === 'string' && entry.version.trim()) {
      version = entry.version;
    }
    if (entry.type !== 'assistant' || !checkIsRecord(entry.message)) continue;

    const model = entry.message.model;
    const usedTokens = getClaudeContextUsedTokens(entry.message.usage);
    if (typeof model === 'string' && model.trim() && usedTokens !== null) {
      latestContextEntry = { model, contextUsedTokens: usedTokens };
    }
  }

  return {
    version,
    model: latestContextEntry?.model ?? null,
    contextWindowTokens: latestContextEntry === null ? null : getClaudeContextWindowTokens(latestContextEntry.model),
    contextUsedTokens: latestContextEntry?.contextUsedTokens ?? null,
  };
}

/**
 * @description Read only the transcript tail needed for the latest runtime
 * metadata. A nonzero read offset can start in a JSONL record, so that partial
 * first line is discarded before parsing.
 */
export async function readClaudeRuntimeInfo(filePath: string): Promise<AgentRuntimeInfo> {
  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const { size } = await fileHandle.stat();
    const bytesToRead = Math.min(size, claudeRuntimeInfoTailBytes);
    if (bytesToRead === 0) return parseClaudeRuntimeInfo('');

    const offset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
    const text = buffer.toString('utf8', 0, bytesRead);
    if (offset === 0) return parseClaudeRuntimeInfo(text);

    const firstLineBreak = text.indexOf('\n');
    return parseClaudeRuntimeInfo(firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1));
  } finally {
    if (fileHandle) await fileHandle.close();
  }
}
