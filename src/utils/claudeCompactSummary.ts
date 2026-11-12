/**
 * @description Reads the summary a Claude compaction left in the conversation's on-disk transcript. Read by the
 * json-stream adapter's `getLatestCompactionSummary` (the idle-compaction notice) and by both Claude adapters'
 * `getSessionCompactionSummary` (the context bridge), so it lives apart from the adapters, one of which imports the other.
 */

import * as fs from 'fs';
import { checkIsRecord } from './checkIsRecord';

/**
 * The key a line must carry to be a compaction summary. Checked on the raw line BEFORE `JSON.parse`: a transcript can be
 * a hundred megabytes, almost none of it a summary, and parsing every line blocks the bot's event loop for seconds.
 */
const compactSummaryKey = '"isCompactSummary"';

/**
 * @description Extract the newest compaction summary from a Claude on-disk
 * transcript: the last JSONL line with `isCompactSummary === true`, whose
 * `message.content` (a string, or `{type:'text'}` blocks) holds the summary the
 * `/compact` turn produced. Returns `null` for an unreadable file or when no
 * summary line is present. Reads the whole file, but parses only the lines that
 * carry the summary flag's key.
 */
export function readLatestCompactSummaryFromTranscript(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let summary: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes(compactSummaryKey)) continue;
    let obj: unknown;
    try { obj = JSON.parse(line.trim()); } catch { continue; }
    if (!checkIsRecord(obj) || obj.isCompactSummary !== true) continue;
    const message = checkIsRecord(obj.message) ? obj.message : null;
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) {
      summary = content;
    } else if (Array.isArray(content)) {
      const chunks: string[] = [];
      for (const block of content) {
        if (checkIsRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          chunks.push(block.text);
        }
      }
      if (chunks.join('').trim()) summary = chunks.join('');
    }
  }
  return summary;
}
