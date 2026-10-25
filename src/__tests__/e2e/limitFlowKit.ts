/**
 * @description What the process-level flows that put a usage limit on the fake agent share: how Claude words a clock
 * reset, and moving the transcript's API-error entry back in time (the moment the error happened, which the stdout log's
 * mtime no longer tells once later frames were appended). Matches neither runner glob.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'fs';

const hoursPerHalfDay = 12;
const minutesPadLength = 2;

/** A UTC clock the way Claude words a session-limit reset: `10:20am (UTC)`. */
export function formatUtcResetClock(atMs: number): string {
  const at = new Date(atMs);
  const hour = at.getUTCHours();
  const hour12 = hour % hoursPerHalfDay === 0 ? hoursPerHalfDay : hour % hoursPerHalfDay;
  const minutes = at.getUTCMinutes().toString().padStart(minutesPadLength, '0');
  return `${hour12}:${minutes}${hour < hoursPerHalfDay ? 'am' : 'pm'} (UTC)`;
}

/**
 * Move the transcript's API-error entry back to `writtenAt`: the moment the error happened, which the stdout log's
 * mtime no longer tells once later frames were appended.
 */
export function backdateTranscriptApiError(transcriptPath: string, writtenAt: Date): void {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').map((line) => {
    if (!line.includes('"isApiErrorMessage":true')) return line;
    return JSON.stringify({ ...JSON.parse(line), timestamp: writtenAt.toISOString() });
  });
  assert.ok(lines.some((line) => line.includes('"isApiErrorMessage":true')), 'the fake recorded the API error in the transcript');
  fs.writeFileSync(transcriptPath, lines.join('\n'));
}
