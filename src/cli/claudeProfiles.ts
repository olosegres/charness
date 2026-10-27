/**
 * @description `charness claude-profiles [--best] [--model <name>] [--current <name> [--stopped-by-limit]] [--json]` — the
 * command-line twin of the `claude_profiles` MCP tool, for a worker that has no MCP (a shell script, a child started by
 * hand): which Claude account profile a process should run on — a new one goes to the account whose weekly limit resets
 * soonest. It reads the bot's cache off `DATA_DIR/state.json` (`utils/claudeUsage.ts`; the bot polls every profile's usage
 * on a timer, so the figures are at most a poll old) and never opens the `StateStore` (that would migrate and lock a live
 * bot's file) nor the network — so `--stopped-by-limit` can only leave the account out, not re-read its usage.
 *
 *   --best         print ONLY the recommended profile's config directory — an EMPTY line for the default
 *                  profile (set nothing) — so `CLAUDE_CONFIG_DIR="$(charness claude-profiles --best)"`
 *                  works as is; exit 1 when no profile is usable (stderr then says which frees up first)
 *   --model <name> the model the child will run (`fable` → the Fable weekly window counts besides the shared ones)
 *   --current <name>  the profile the session being RESUMED last ran on: it stays there while it can
 *   --stopped-by-limit  that session broke off on a usage limit: leave `--current` out of the answer
 *   --json         the full report as JSON (the MCP tool's shape)
 *
 * Without a flag: one human line per profile. `DATA_DIR` comes from the environment the bot itself reads
 * (`~/.config/charness/.env`, `$PWD/.env`, or `ENV_FILE`).
 */

import { loadEnvFiles } from './envLoader';
import { resolveDataDir } from '../state';
import { getDisabledClaudeProfileNames, normaliseFallbackChain } from '../utils/fallbackChain';
import {
  buildClaudeProfileUsageViews,
  buildClaudeProfilesReport,
  describeClaudeLaunchOutcome,
  formatClaudeUsageBucket,
  readClaudeProfileRecordsFromStateFile,
  readStateFileObject,
  type ClaudeProfileReportEntry,
  type ClaudeUsageBucketKind,
} from '../utils/claudeUsage';

export interface ClaudeProfilesCliArgs {
  isBest: boolean;
  isJson: boolean;
  model: string | null;
  currentProfile: string | null;
  isStoppedByLimit: boolean;
}

const usageLine = 'Usage: charness claude-profiles [--best] [--model <name>] [--current <name> [--stopped-by-limit]] [--json]';

/** The value of a flag spelled `--name value` or `--name=value`; `null` when argument `index` is not that flag, `undefined` when it has no value. */
function readFlagValue(argv: readonly string[], index: number, name: string): { value: string | undefined; consumed: number } | null {
  const arg = argv[index];
  if (arg === name) {
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? { value: undefined, consumed: 0 } : { value, consumed: 1 };
  }
  return arg.startsWith(`${name}=`) ? { value: arg.slice(name.length + 1), consumed: 0 } : null;
}

/** Parse the subcommand's flags; `null` with a message for anything unknown. */
export function parseClaudeProfilesCliArgs(argv: readonly string[]): { ok: true; args: ClaudeProfilesCliArgs } | { ok: false; error: string } {
  const args: ClaudeProfilesCliArgs = { isBest: false, isJson: false, model: null, currentProfile: null, isStoppedByLimit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const model = readFlagValue(argv, i, '--model');
    const current = readFlagValue(argv, i, '--current');
    if (arg === '--best') args.isBest = true;
    else if (arg === '--json') args.isJson = true;
    else if (arg === '--stopped-by-limit') args.isStoppedByLimit = true;
    else if (model !== null) {
      if (model.value === undefined || model.value.trim() === '') return { ok: false, error: '--model needs a value' };
      args.model = model.value;
      i += model.consumed;
    } else if (current !== null) {
      if (current.value === undefined || current.value.trim() === '') return { ok: false, error: '--current needs a profile name' };
      args.currentProfile = current.value;
      i += current.consumed;
    } else return { ok: false, error: `unknown option: ${arg}` };
  }
  if (args.isStoppedByLimit && args.currentProfile === null) return { ok: false, error: '--stopped-by-limit needs --current <name>' };
  return { ok: true, args };
}

/** One human line: `✓ work  /data/…/work  mail@example.com personal max  5h 12% 🔄 in 2h · week 40% 🔄 in 2d 1h · Fable 3% 🔄 in 2d 1h` (no Fable part for an account without that window; an account billed to API credits says so and has no windows). */
export function formatClaudeProfileCliLine(entry: ClaudeProfileReportEntry, nowMs: number): string {
  const find = (kind: ClaudeUsageBucketKind) => entry.buckets.find((bucket) => bucket.kind === kind) ?? null;
  const weeklyReset = find('weekly_all')?.resetsAt ?? null;
  const read = (kind: ClaudeUsageBucketKind) => formatClaudeUsageBucket(find(kind), nowMs, { fallbackResetsAt: kind === 'session' ? weeklyReset : null });
  const marker = entry.isRecommended ? '✓' : entry.isEligible ? '•' : '✗';
  const isApi = entry.billing === 'api';
  const account = entry.loggedIn === false
    ? 'not signed in'
    : isApi
      ? `${entry.email ?? 'API key'} API billing (pay per use, never picked for a new agent)`
      : entry.loggedIn === null && entry.email === null
        ? 'not probed yet (open /account once)'
        : `${entry.email ?? '?'} ${entry.kind} ${entry.subscriptionType ?? '?'}`;
  const formatWindows = (): string => (entry.buckets.length === 0
    ? 'usage not read yet'
    : `${[
      `5h ${read('session')}`,
      `week ${read('weekly_all')}`,
      ...(find('weekly_scoped') === null ? [] : [`Fable ${read('weekly_scoped')}`]),
    ].join(' · ')}${entry.isUsageStale ? ' (stale)' : ''}`);
  // An account billed to API credits has no windows; its limit is the balance.
  const usage = isApi ? `no windows${entry.creditExhaustedAt === null ? '' : '  CREDITS USED UP'}` : formatWindows();
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
    stderr(`${parsed.error}\n${usageLine}\n`);
    return 2;
  }
  const { args } = parsed;
  loadEnvFiles();
  const dataDir = resolveDataDir();
  const nowMs = (io.now ?? Date.now)();
  const records = readClaudeProfileRecordsFromStateFile(dataDir);
  const report = buildClaudeProfilesReport(buildClaudeProfileUsageViews({ dataDir, records }), args.model, nowMs, {
    currentProfile: args.currentProfile,
    isStoppedByLimit: args.isStoppedByLimit,
    excludedNames: getDisabledClaudeProfileNames(normaliseFallbackChain(readStateFileObject(dataDir).fallbackChain)),
  });
  const outcome = describeClaudeLaunchOutcome(report, args.currentProfile);
  if (args.isJson) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.recommended === null && args.isBest ? 1 : 0;
  }
  if (args.isBest) {
    if (report.recommended === null) {
      stderr(`no usable Claude profile: ${outcome}\n`);
      return 1;
    }
    const entry = report.profiles.find((profile) => profile.name === report.recommended);
    stdout(`${entry?.configDir ?? ''}\n`);
    return 0;
  }
  stdout(`${report.profiles.map((entry) => formatClaudeProfileCliLine(entry, nowMs)).join('\n')}\n`);
  stdout(`recommended for ${args.model ?? 'any model'}: ${report.recommended ?? 'none'} (${outcome})\n`);
  return 0;
}
