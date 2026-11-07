/**
 * @description `charness claude-profiles credit <profile> <remainingUsd> [--of <grantUsd>] [--expires YYYY-MM-DD]` and
 * `charness claude-profiles credit <profile> --clear` — give the bot the bonus API credit figure the operator reads on
 * the Console's Billing page (`utils/claudeApiCredit.ts`), so `/accounts` and `/limits` show how much is left.
 *
 *   <profile>        an account billed to API credits (`charness claude-profiles` lists them)
 *   <remainingUsd>   what the Console shows as left, in dollars (`61.20`)
 *   --of <grantUsd>  the size of the grant it comes from (`200`), shown as «of $200.00»
 *   --expires <day>  the last day the credit is usable, `YYYY-MM-DD` (UTC); after it the line says «expired»
 *   --clear          forget the figure
 *
 * It writes `DATA_DIR/claudeApiCredit.json`, never `state.json` (a live bot rewrites that from its memory, so a figure
 * written there would be lost); the bot reads the file as it changes, no restart. Like its sibling it takes `DATA_DIR`
 * from the environment the bot itself reads.
 */

import { loadEnvFiles } from './envLoader';
import { readFlagValue } from './flagValue';
import { resolveDataDir } from '../state';
import { readStateFileObject } from '../stateFile';
import { getClaudeProfileRecordsFromState } from '../utils/claudeUsage';
import { formatUsd } from '../utils/claudeApiSpend';
import {
  checkIsClaudeApiCreditExpired,
  parseClaudeApiCreditDay,
  readClaudeApiCreditAnchors,
  writeClaudeApiCreditAnchor,
  type ClaudeApiCreditAnchor,
} from '../utils/claudeApiCredit';

/** What the command was asked to do with the profile's figure. */
export type ClaudeProfilesCreditChange =
  | { kind: 'clear' }
  | { kind: 'set'; remainingUsd: number; grantUsd: number | null; expiresOn: string | null };

export interface ClaudeProfilesCreditArgs {
  profile: string;
  change: ClaudeProfilesCreditChange;
}

const usageLine = 'Usage: charness claude-profiles credit <profile> <remainingUsd> [--of <grantUsd>] [--expires YYYY-MM-DD]\n'
  + '       charness claude-profiles credit <profile> --clear';

/** Dollars as typed: `61`, `61.2`, `$61.20`. */
const dollarsPattern = /^\$?(\d+(?:\.\d+)?)$/;

/** The amount in dollars, `null` when `text` is not one. */
function parseDollars(text: string): number | null {
  const match = dollarsPattern.exec(text.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * @description Parse the arguments after `credit`; an error names the argument and says what is expected. `nowMs` only
 * decides whether `--expires` names a day that is already over.
 */
export function parseClaudeProfilesCreditArgs(argv: readonly string[], nowMs: number): { ok: true; args: ClaudeProfilesCreditArgs } | { ok: false; error: string } {
  const positionals: string[] = [];
  let isClear = false;
  let grantText: string | null = null;
  let expiresText: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const grant = readFlagValue(argv, i, '--of');
    const expires = readFlagValue(argv, i, '--expires');
    if (arg === '--clear') isClear = true;
    else if (grant !== null) {
      if (grant.value === undefined) return { ok: false, error: '--of needs the size of the grant in dollars' };
      grantText = grant.value;
      i += grant.consumed;
    } else if (expires !== null) {
      if (expires.value === undefined) return { ok: false, error: '--expires needs a day, YYYY-MM-DD' };
      expiresText = expires.value;
      i += expires.consumed;
    } else if (arg.startsWith('--')) return { ok: false, error: `unknown option: ${arg}` };
    else positionals.push(arg);
  }

  const [profile, remainingText, ...extra] = positionals;
  if (profile === undefined) return { ok: false, error: 'the profile name is missing' };
  if (isClear) {
    if (remainingText !== undefined || grantText !== null || expiresText !== null) return { ok: false, error: '--clear takes no figure, --of or --expires' };
    return { ok: true, args: { profile, change: { kind: 'clear' } } };
  }
  if (remainingText === undefined) return { ok: false, error: 'the remaining amount in dollars is missing' };
  if (extra.length > 0) return { ok: false, error: `unexpected argument: ${extra[0]}` };

  const remainingUsd = parseDollars(remainingText);
  if (remainingUsd === null) return { ok: false, error: `the remaining amount must be dollars like 61.20, got "${remainingText}"` };
  let grantUsd: number | null = null;
  if (grantText !== null) {
    grantUsd = parseDollars(grantText);
    if (grantUsd === null || grantUsd <= 0) return { ok: false, error: `--of must be the grant in dollars, more than 0, got "${grantText}"` };
    if (remainingUsd > grantUsd) return { ok: false, error: `the remaining amount (${formatUsd(remainingUsd)}) is more than the grant (${formatUsd(grantUsd)})` };
  }
  let expiresOn: string | null = null;
  if (expiresText !== null) {
    expiresOn = parseClaudeApiCreditDay(expiresText);
    if (expiresOn === null) return { ok: false, error: `--expires must be a calendar day, YYYY-MM-DD, got "${expiresText}"` };
    if (checkIsClaudeApiCreditExpired(expiresOn, nowMs)) return { ok: false, error: `--expires ${expiresOn} is already over` };
  }
  return { ok: true, args: { profile, change: { kind: 'set', remainingUsd, grantUsd, expiresOn } } };
}

/** The line that confirms a stored figure: what was left, of how much, until when. */
function formatCreditConfirmation(profile: string, anchor: ClaudeApiCreditAnchor): string {
  const grant = anchor.grantUsd === undefined ? '' : ` of ${formatUsd(anchor.grantUsd)}`;
  const expires = anchor.expiresOn === undefined ? '' : `, usable through ${anchor.expiresOn}`;
  return `API credit of "${profile}": ${formatUsd(anchor.remainingUsd)} left${grant}${expires}. `
    + 'The bot counts what the account spends from now on and shows the estimate in /accounts and /limits.';
}

/**
 * @description Run the subcommand (the arguments after `credit`); returns the exit code: 0 done, 1 refused or not
 * writable, 2 a malformed command line. `now` is injectable for the unit test.
 */
export async function runClaudeProfilesCreditCli(
  argv: readonly string[],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void; now?: () => number } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const nowMs = (io.now ?? Date.now)();
  const parsed = parseClaudeProfilesCreditArgs(argv, nowMs);
  if (!parsed.ok) {
    stderr(`${parsed.error}\n${usageLine}\n`);
    return 2;
  }
  const { profile, change } = parsed.args;
  loadEnvFiles();
  const dataDir = resolveDataDir();

  if (change.kind === 'clear') {
    if (readClaudeApiCreditAnchors(dataDir)[profile] === undefined) {
      stdout(`"${profile}" has no API credit figure.\n`);
      return 0;
    }
    const clearFailure = writeAnchor(dataDir, profile, null, stderr);
    if (clearFailure !== null) return clearFailure;
    stdout(`The API credit figure of "${profile}" is cleared.\n`);
    return 0;
  }

  // Only an account billed to API credits has a bonus credit: refuse any other, and say which ones qualify.
  const records = getClaudeProfileRecordsFromState(readStateFileObject(dataDir));
  if (records[profile]?.billing !== 'api') {
    const apiProfiles = Object.entries(records).filter(([, record]) => record.billing === 'api').map(([name]) => name);
    stderr(`"${profile}" is not an account billed to API credits; the credit figure is kept for those only (${apiProfiles.length === 0 ? 'there is none yet' : apiProfiles.join(', ')}).\n`);
    return 1;
  }
  const anchor: ClaudeApiCreditAnchor = {
    remainingUsd: change.remainingUsd,
    ...(change.grantUsd === null ? {} : { grantUsd: change.grantUsd }),
    anchoredAt: new Date(nowMs).toISOString(),
    ...(change.expiresOn === null ? {} : { expiresOn: change.expiresOn }),
  };
  const setFailure = writeAnchor(dataDir, profile, anchor, stderr);
  if (setFailure !== null) return setFailure;
  stdout(`${formatCreditConfirmation(profile, anchor)}\n`);
  return 0;
}

/** Write (or, with `null`, remove) the profile's figure; `null` on success, else the exit code after the reason went to `stderr`. */
function writeAnchor(dataDir: string, profile: string, anchor: ClaudeApiCreditAnchor | null, stderr: (text: string) => void): number | null {
  try {
    writeClaudeApiCreditAnchor(dataDir, profile, anchor);
    return null;
  } catch (e) {
    stderr(`could not save the API credit figure: ${e instanceof Error ? e.message : 'unknown error'}\n`);
    return 1;
  }
}
