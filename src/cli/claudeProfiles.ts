/**
 * @description `telegramcode claude-profiles [--best] [--model <name>] [--json]` — the command-line twin of the
 * `claude_profiles` MCP tool, for a worker that has no MCP (a shell script, a child started by hand): which
 * Claude account profile a new process should run on. It reads the bot's cache off `DATA_DIR/state.json`
 * (`utils/claudeUsage.ts`; the bot polls every profile's usage on a timer, so the figures are at most a poll
 * old) and never opens the `StateStore` (that would migrate and lock a live bot's file) nor the network.
 *
 *   --best         print ONLY the recommended profile's config directory — an EMPTY line for the default
 *                  profile (set nothing) — so `CLAUDE_CONFIG_DIR="$(telegramcode claude-profiles --best)"`
 *                  works as is; exit 1 when no profile is eligible
 *   --model <name> the model the child will run (`fable` → the Fable weekly window counts)
 *   --json         the full report as JSON (the MCP tool's shape)
 *
 * Without a flag: one human line per profile. `DATA_DIR` comes from the environment the bot itself reads
 * (`~/.config/telegramcode/.env`, `$PWD/.env`, or `ENV_FILE`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadEnvFiles } from './envLoader';
import { resolveDataDir } from '../state';
import {
  buildClaudeProfileUsageViews,
  buildClaudeProfilesReport,
  formatClaudeUsageBucket,
  readClaudeProfileRecordsFromStateFile,
  type ClaudeProfileReportEntry,
  type ClaudeUsageBucketKind,
} from '../utils/claudeUsage';
import { getEffectiveTimezone } from '../utils/timezone';

export interface ClaudeProfilesCliArgs {
  isBest: boolean;
  isJson: boolean;
  model: string | null;
}

/** Parse the subcommand's flags; `null` with a message for anything unknown. */
export function parseClaudeProfilesCliArgs(argv: readonly string[]): { ok: true; args: ClaudeProfilesCliArgs } | { ok: false; error: string } {
  const args: ClaudeProfilesCliArgs = { isBest: false, isJson: false, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--best') args.isBest = true;
    else if (arg === '--json') args.isJson = true;
    else if (arg === '--model') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: '--model needs a value' };
      args.model = value;
      i += 1;
    } else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else return { ok: false, error: `unknown option: ${arg}` };
  }
  if (args.model !== null && args.model.trim() === '') return { ok: false, error: '--model needs a value' };
  return { ok: true, args };
}

/** One human line: `✓ work  /data/…/work  mail@example.com personal max  5h 12% → 16:00 · week 40% → Sat 00:00 · Fable 3% → Sat 00:00`. */
export function formatClaudeProfileCliLine(entry: ClaudeProfileReportEntry, timezone: string, nowMs: number): string {
  const read = (kind: ClaudeUsageBucketKind) => formatClaudeUsageBucket(entry.buckets.find((bucket) => bucket.kind === kind) ?? null, timezone, nowMs);
  const marker = entry.isRecommended ? '✓' : entry.isEligible ? '•' : '✗';
  const account = entry.loggedIn === false
    ? 'not signed in'
    : entry.loggedIn === null && entry.email === null
      ? 'not probed yet (open /account once)'
      : `${entry.email ?? '?'} ${entry.kind} ${entry.subscriptionType ?? '?'}`;
  const usage = entry.buckets.length === 0
    ? 'usage not read yet'
    : `5h ${read('session')} · week ${read('weekly_all')} · Fable ${read('weekly_scoped')}${entry.isUsageStale ? ' (stale)' : ''}`;
  const limited = entry.limitedUntil && Date.parse(entry.limitedUntil) > nowMs ? `  LIMITED until ${entry.limitedUntil}` : '';
  return `${marker} ${entry.name}  ${entry.configDir ?? '(default: no CLAUDE_CONFIG_DIR)'}  ${account}  ${usage}${limited}`;
}

/**
 * @description Run the subcommand; returns the exit code. Output goes to stdout, a refusal to stderr.
 * `readRecords` / `now` are injectable for the unit test; the CLI test drives the built binary instead.
 */
export async function runClaudeProfilesCli(
  argv: readonly string[],
  io: {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    now?: () => number;
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseClaudeProfilesCliArgs(argv);
  if (!parsed.ok) {
    stderr(`${parsed.error}\nUsage: telegramcode claude-profiles [--best] [--model <name>] [--json]\n`);
    return 2;
  }
  const { args } = parsed;
  loadEnvFiles();
  const dataDir = resolveDataDir();
  const nowMs = (io.now ?? Date.now)();
  const records = readClaudeProfileRecordsFromStateFile(dataDir);
  const report = buildClaudeProfilesReport(buildClaudeProfileUsageViews({ dataDir, records }), args.model, nowMs);
  if (args.isJson) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.recommended === null && args.isBest ? 1 : 0;
  }
  if (args.isBest) {
    if (report.recommended === null) {
      stderr('no eligible Claude profile: every signed-in account is limited or at 100 % on a relevant window\n');
      return 1;
    }
    const entry = report.profiles.find((profile) => profile.name === report.recommended);
    stdout(`${entry?.configDir ?? ''}\n`);
    return 0;
  }
  const timezone = getEffectiveTimezone(readStoredTimezone(dataDir));
  stdout(`${report.profiles.map((entry) => formatClaudeProfileCliLine(entry, timezone, nowMs)).join('\n')}\n`);
  stdout(`recommended for ${args.model ?? 'any model'}: ${report.recommended ?? 'none'}\n`);
  return 0;
}

/** The instance `/timezone` pick off `state.json` (the bot's own store is not opened here); `null` = host zone. */
function readStoredTimezone(dataDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as { timezone?: unknown };
    return typeof raw.timezone === 'string' ? raw.timezone : null;
  } catch {
    return null;
  }
}
