import * as fs from 'fs';
import { getParkedErrorWrittenAtMs, limitEpisodeTailMaxBytes } from './limitEpisodeRecovery';
import { readFileByteRange } from './jsonStreamHost';

/**
 * @description When `errorText` was written, from the API-error entry of a Claude transcript ({@link getParkedErrorWrittenAtMs}):
 * only the tail of the file is read. `null` when the transcript cannot be read or holds no such entry. The boot recovery and
 * the adopt's replay both read an error that ended a turn BEFORE they look at it, and a reset named by its clock
 * ("resets 10:20am") is the next occurrence after the moment the error was written — not after the moment it is read.
 */
export function readTranscriptErrorWrittenAtMs(transcriptPath: string, errorText: string): number | null {
  try {
    const sizeBytes = fs.statSync(transcriptPath).size;
    const tail = readFileByteRange(transcriptPath, Math.max(0, sizeBytes - limitEpisodeTailMaxBytes), sizeBytes);
    return getParkedErrorWrittenAtMs(tail.toString('utf8'), errorText);
  } catch {
    return null; // no transcript on disk
  }
}
