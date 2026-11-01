import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import { quoteShellWord } from '../remoteRun/ssh';

/**
 * @description The part of the account's `authorized_keys` that charness owns: ONE marked block, replaced as a whole and derived from
 * the registry (`hubRegistry.ts` renders it), so the file and the registry never drift apart. Every line outside the markers is the
 * operator's and is kept byte for byte. A file with a damaged block (a marker without its twin, two blocks) is NOT edited — guessing
 * which lines are ours could delete a key of the operator.
 *
 * A runner's key is a forced-command key with NO forwarding of any kind: `restrict` turns off port, unix-socket, agent and X11
 * forwarding, ptys and `~/.ssh/rc`; OpenSSH cannot limit forwarding of unix sockets in any finer way, and a key that could forward
 * one could open the bot's tmux sockets.
 */

export const authorizedKeysBlockStart = '# charness runners: managed block, do not edit between the markers';
export const authorizedKeysBlockEnd = '# charness runners: end of the managed block';
const sshDirectoryMode = 0o700;
const authorizedKeysMode = 0o600;
/** What may not appear in the folder path inside `command="…"`: sshd cannot escape a backslash, and a quote ends the option. */
const unsafeCommandCharacters = /["'\\\n\r]/;
const msPerSecond = 1000;

export class AuthorizedKeysBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizedKeysBlockError';
  }
}

interface BlockLocation {
  startIndex: number;
  endIndex: number;
}

function findBlock(lines: readonly string[]): BlockLocation | null {
  const starts = lines.flatMap((line, index) => (line.trimEnd() === authorizedKeysBlockStart ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trimEnd() === authorizedKeysBlockEnd ? [index] : []));
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new AuthorizedKeysBlockError('authorized_keys holds a damaged charness block (the two marker lines do not pair up); fix it by hand — nothing was changed');
  }
  return { startIndex: starts[0], endIndex: ends[0] };
}

/** @description The lines between the markers (none when there is no block). */
export function extractManagedBlock(text: string): string[] {
  const lines = text.split('\n');
  const block = findBlock(lines);
  return block === null ? [] : lines.slice(block.startIndex + 1, block.endIndex);
}

/**
 * @description `text` with the managed block holding exactly `blockLines`: an existing block is replaced in place, a new one is
 * appended, and no lines remove the block (the file is returned as it was when there is none). Nothing outside the block changes.
 */
export function replaceManagedBlock(text: string, blockLines: readonly string[]): string {
  const lines = text.split('\n');
  const block = findBlock(lines);
  if (block === null) {
    if (blockLines.length === 0) return text;
    const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${[authorizedKeysBlockStart, ...blockLines, authorizedKeysBlockEnd].join('\n')}\n`;
  }
  const replacement = blockLines.length === 0 ? [] : [authorizedKeysBlockStart, ...blockLines, authorizedKeysBlockEnd];
  return [...lines.slice(0, block.startIndex), ...replacement, ...lines.slice(block.endIndex + 1)].join('\n');
}

/** @description `YYYYMMDDHHMMSSZ` (UTC), the form of sshd's `expiry-time` option. */
export function formatExpiryTime(epochMs: number): string {
  const iso = new Date(Math.floor(epochMs / msPerSecond) * msPerSecond).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function buildGateCommand(gatePath: string, keysPath: string, dir: string, kind: 'redeem' | 'runner', id: string): string {
  for (const value of [gatePath, keysPath, dir]) {
    if (unsafeCommandCharacters.test(value)) throw new AuthorizedKeysBlockError('the charness folder path holds a quote, a backslash or a line break, which an authorized_keys command cannot carry');
  }
  const command = [quoteShellWord(gatePath), '--dir', quoteShellWord(dir), '--keys', quoteShellWord(keysPath), kind, id].join(' ');
  return `command="${command}"`;
}

export interface TempKeyLineParams {
  publicKey: string;
  expiresAtMs: number;
  gatePath: string;
  keysPath: string;
  dir: string;
  pairId: string;
}

/** @description The line of a pairing's temporary key: it may log in until `expiresAtMs` and only to be handed to the gate's `redeem` mode. */
export function buildTempKeyLine(params: TempKeyLineParams): string {
  return `restrict,expiry-time="${formatExpiryTime(params.expiresAtMs)}",${buildGateCommand(params.gatePath, params.keysPath, params.dir, 'redeem', params.pairId)} ${params.publicKey} charness-pairing:${params.pairId}`;
}

export interface RunnerKeyLineParams {
  publicKey: string;
  gatePath: string;
  keysPath: string;
  dir: string;
  runnerId: string;
}

/** @description The line of a paired runner's key: no expiry, the gate's `runner` mode. */
export function buildRunnerKeyLine(params: RunnerKeyLineParams): string {
  return `restrict,${buildGateCommand(params.gatePath, params.keysPath, params.dir, 'runner', params.runnerId)} ${params.publicKey} charness-runner:${params.runnerId}`;
}

function readTextIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * @description Make the managed block of `authorizedKeysPath` hold exactly `blockLines`. The folder is created 0700 when missing
 * (sshd's StrictModes refuses a writable one), the file is written 0600 through a temp file and a rename — into the file a symlink
 * points to, never over the link (a dotfile manager keeps the real file elsewhere). Nothing is written when nothing changes.
 */
export function writeManagedBlock(authorizedKeysPath: string, blockLines: readonly string[]): void {
  fs.mkdirSync(path.dirname(authorizedKeysPath), { recursive: true, mode: sshDirectoryMode });
  const targetPath = fs.existsSync(authorizedKeysPath) ? fs.realpathSync(authorizedKeysPath) : authorizedKeysPath;
  const current = readTextIfPresent(targetPath);
  const next = replaceManagedBlock(current, blockLines);
  if (next === current) return;
  writeTextFileAtomically(targetPath, next, authorizedKeysMode);
}
