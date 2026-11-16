/**
 * @description Reads the part of a Claude transcript written since its previous compaction — what the skills restore
 * (`utils/skillsRestore.ts`) needs at a compaction — BACKWARDS from the end, so a transcript of a hundred megabytes costs
 * only its last epoch. Older epochs are not needed: what they loaded is carried by the records right after the previous
 * boundary (Claude's own `invoked_skills` re-attach, the bot's previous restore).
 */

import * as fs from 'fs';
import { checkIsRecord } from './checkIsRecord';

/** How much of the file one read takes. */
const readChunkBytes = 1024 * 1024;
const newlineByte = 0x0a;
/** The key a line must carry to be a compaction boundary: checked on the raw bytes before anything is decoded. */
const compactBoundaryKey = Buffer.from('"compact_boundary"');

/** @description Whether the bytes of a transcript line are a compaction boundary record. */
function checkIsCompactBoundaryLine(lineBytes: Buffer): boolean {
  if (lineBytes.indexOf(compactBoundaryKey) < 0) return false;
  try {
    const record: unknown = JSON.parse(lineBytes.toString('utf8'));
    return checkIsRecord(record) && record.type === 'system' && record.subtype === 'compact_boundary';
  } catch {
    return false;
  }
}

/**
 * @description The lines of `transcriptPath` after its LAST `compact_boundary` record (the whole file when there is none),
 * oldest first, keeping only those that hold one of `wantedKeys` — matched on the RAW bytes, so a line that holds none is never
 * decoded and the reader holds the lines that matter, not the epoch (every slot of the Claude restore runs this at once). A
 * line is split only at newline bytes (never inside a UTF-8 character); a last line without a newline is kept as it is (a
 * reader that parses it skips it if it is half written). `[]` for a file that cannot be read.
 */
export function readClaudeTranscriptEpochLines(transcriptPath: string, wantedKeys: readonly string[]): string[] {
  const wantedKeyBytes = wantedKeys.map((key) => Buffer.from(key));
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return [];
  }
  const newestFirst: string[] = [];
  try {
    let position = fs.fstatSync(fd).size;
    /** The bytes of a line whose start is in a chunk not read yet. */
    let carry = Buffer.alloc(0);
    const takeLine = (lineBytes: Buffer): boolean => {
      if (checkIsCompactBoundaryLine(lineBytes)) return true;
      if (lineBytes.length > 0 && wantedKeyBytes.some((key) => lineBytes.indexOf(key) >= 0)) newestFirst.push(lineBytes.toString('utf8'));
      return false;
    };
    while (position > 0) {
      const length = Math.min(readChunkBytes, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      let bytes = Buffer.concat([chunk, carry]);
      let lineEnd = bytes.length;
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== newlineByte) continue;
        if (takeLine(bytes.subarray(index + 1, lineEnd))) return newestFirst.reverse();
        lineEnd = index;
      }
      bytes = bytes.subarray(0, lineEnd);
      carry = Buffer.from(bytes);
    }
    if (carry.length > 0 && takeLine(carry)) return newestFirst.reverse();
    return newestFirst.reverse();
  } catch {
    // A read that fails midway (the file truncated under the reader) keeps the newer lines it got: a restore of the skills
    // those name beats none.
    return newestFirst.reverse();
  } finally {
    fs.closeSync(fd);
  }
}
