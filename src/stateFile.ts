/**
 * @description `state.json` read as a plain object, for the code that must NOT open the `StateStore` (which migrates the
 * file and takes its lock — a live bot's file): the `charness claude-profiles` command reads the profile registry and the
 * fallback chain off it. Read-only, no I/O beyond the one file read; the caller reads once and picks its fields.
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkIsRecord } from './utils/checkIsRecord';

export const stateFileName = 'state.json';

/** The parsed `state.json` of `dataDir`; `{}` when it is missing, unreadable, not JSON or not an object. */
export function readStateFileObject(dataDir: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dataDir, stateFileName), 'utf8'));
  } catch {
    return {};
  }
  return checkIsRecord(parsed) ? parsed : {};
}
