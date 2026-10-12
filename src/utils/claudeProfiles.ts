/**
 * @description Claude ACCOUNT PROFILES — several Claude subscription logins kept side by side, one picked per
 * topic (`/account`). A profile is a Claude Code config directory of its own under
 * `DATA_DIR/claude-profiles/<name>/`, handed to the CLI through `CLAUDE_CONFIG_DIR`: the CLI keeps its
 * login (`.credentials.json`, `.claude.json`) there, while the entries that must stay ONE across accounts —
 * the transcripts (`projects/`), settings, skills, plugins and the user memory — are symlinks back into
 * `~/.claude`, so a conversation started under one account resumes under another and every account sees
 * the same hooks and skills.
 *
 * The profile `default` IS `~/.claude` itself: nothing is set for it and nothing is migrated. A process is
 * never switched by swapping files under `~/.claude` (the CLI re-reads its credentials live and EVERY running
 * session would change account at once); the variable is per process, set at spawn.
 *
 * Pure helpers (layout, name gate, resolution, parsers) — the registry and the selection live in
 * `state.json` (`StateStore`), the spawn-side use in the adapters, the UI in
 * `connectors/telegram/commands/claudeAccounts.ts`. Shaped for the later phases: a record carries room for a
 * `limitedUntil` mark and a cached usage snapshot, and the resolver takes the known names so a selection that
 * names a removed profile falls back instead of launching a dead directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The profile that is `~/.claude` itself (no `CLAUDE_CONFIG_DIR`). */
export const defaultClaudeProfileName = 'default';

/** Subdirectory of `DATA_DIR` that holds every profile's config directory. */
export const claudeProfilesDirName = 'claude-profiles';

/**
 * The entries a profile shares with `~/.claude` through symlinks. `projects/` is load-bearing: the bot reads
 * transcripts from `~/.claude/projects` (`getClaudeProjectsRoot`) and `--resume` must find a conversation whatever
 * account started it. The user memory (`CLAUDE.md`) is linked only when it exists (a dangling link would be a
 * file the CLI tries to read on every start).
 */
export const claudeProfileSharedEntries = ['projects', 'settings.json', 'skills', 'plugins'] as const;
export const claudeProfileOptionalSharedEntries = ['CLAUDE.md'] as const;

/** Profile names are safe slugs: they become a directory name and a button's `callback_data`. */
export const claudeProfileNameMaxLength = 32;
const claudeProfileNameRe = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Longest `callback_data` prefix the account picker uses; with the name cap it stays far under Telegram's 64 bytes. */
export const claudeAccountCallbackPrefix = 'acct_';

/**
 * @description Whether `name` may name a NEW profile: a lowercase slug of at most {@link claudeProfileNameMaxLength}
 * characters that is not the reserved `default`.
 */
export function checkIsValidClaudeProfileName(name: string): boolean {
  return name !== defaultClaudeProfileName && claudeProfileNameRe.test(name);
}

/** Lowercase + trim the operator's typed name before the gate (a `/account add MyWork` means `mywork`). */
export function normaliseClaudeProfileName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function resolveClaudeProfilesRoot(dataDir: string): string {
  return path.join(dataDir, claudeProfilesDirName);
}

/**
 * @description The config directory a profile hands the CLI, or `null` for `default` (nothing is set and the CLI
 * uses `~/.claude`, or whatever `CLAUDE_CONFIG_DIR` the bot itself inherited).
 */
export function resolveClaudeProfileDir(dataDir: string, name: string): string | null {
  if (name === defaultClaudeProfileName) return null;
  return path.join(resolveClaudeProfilesRoot(dataDir), name);
}

/** `~/.claude` — the directory the shared entries link back into. */
export function resolveHomeClaudeDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude');
}

/**
 * @description Create a profile's config directory: `0700`, with the shared entries symlinked into `~/.claude`.
 * Idempotent — an existing directory keeps its login and only gains a missing link, so a re-run after a crash is
 * safe. Refuses `default` and an invalid name (defence in depth: the command gate already rejected them).
 * `~/.claude/projects` is created when absent so the link never dangles into the one entry the bot reads.
 */
export function createClaudeProfileLayout(input: { dataDir: string; name: string; homeClaudeDir?: string }): string {
  const { dataDir, name } = input;
  if (!checkIsValidClaudeProfileName(name)) throw new Error(`invalid Claude profile name: ${JSON.stringify(name)}`);
  const homeClaudeDir = input.homeClaudeDir ?? resolveHomeClaudeDir();
  const dir = resolveClaudeProfileDir(dataDir, name);
  if (dir === null) throw new Error('the default profile has no directory of its own');
  fs.mkdirSync(resolveClaudeProfilesRoot(dataDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(homeClaudeDir, 'projects'), { recursive: true });
  const linked: string[] = [...claudeProfileSharedEntries];
  for (const entry of claudeProfileOptionalSharedEntries) {
    if (fs.existsSync(path.join(homeClaudeDir, entry))) linked.push(entry);
  }
  for (const entry of linked) {
    const linkPath = path.join(dir, entry);
    const target = path.join(homeClaudeDir, entry);
    try {
      const existing = fs.lstatSync(linkPath);
      // A real file or dir of the profile's own (the CLI wrote one before the link existed) is left alone.
      if (!existing.isSymbolicLink()) continue;
      if (fs.readlinkSync(linkPath) === target) continue;
      fs.unlinkSync(linkPath);
    } catch {
      /* absent → create below */
    }
    fs.symlinkSync(target, linkPath);
  }
  return dir;
}

/**
 * @description Remove a profile's directory — its login with it. `fs.rmSync` removes the symlinks AS LINKS, so
 * the shared `~/.claude` entries behind them are never touched. Refuses `default`.
 */
export function removeClaudeProfileLayout(dataDir: string, name: string): void {
  const dir = resolveClaudeProfileDir(dataDir, name);
  if (dir === null || !checkIsValidClaudeProfileName(name)) throw new Error(`cannot remove the Claude profile ${JSON.stringify(name)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Whether a profile's directory exists on disk (the login may still be missing — see the auth status). */
export function checkClaudeProfileDirExists(dataDir: string, name: string): boolean {
  const dir = resolveClaudeProfileDir(dataDir, name);
  return dir === null ? true : fs.existsSync(dir);
}

/**
 * @description Which profile a conversation uses: its own override when it names a known profile, else the
 * instance default when THAT is known, else `default`. A selection that names a removed profile is not an
 * error — the conversation silently runs on `default` (the removal already told the operator).
 */
export function resolveClaudeProfileName(input: {
  globalDefault: string | undefined;
  threadOverride: string | undefined;
  knownNames: ReadonlySet<string>;
}): string {
  const checkIsKnown = (name: string | undefined): name is string =>
    name !== undefined && (name === defaultClaudeProfileName || input.knownNames.has(name));
  if (checkIsKnown(input.threadOverride)) return input.threadOverride;
  if (checkIsKnown(input.globalDefault)) return input.globalDefault;
  return defaultClaudeProfileName;
}

// ── `claude auth status --json` ──

/** What the account picker shows per profile, as the CLI reports it (`claude auth status --json`). */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  /** `pro` / `max` (personal), `team` / `enterprise` (corporate), or whatever newer CLIs add. */
  subscriptionType: string | null;
  orgName: string | null;
}

/**
 * @description Parse the CLI's auth status. `null` for anything that is not the JSON object the CLI prints
 * (the probe failed, an older CLI) — the caller treats it as "unknown", never as "logged out".
 */
export function parseClaudeAuthStatus(statusJson: string): ClaudeAuthStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== 'boolean') return null;
  const readString = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
  return {
    loggedIn: record.loggedIn,
    email: readString(record.email),
    subscriptionType: readString(record.subscriptionType),
    orgName: readString(record.orgName),
  };
}

/**
 * @description The stdout a failed `execFile` carries, `''` for anything else. `claude auth status --json`
 * exits NON-ZERO for a logged-out directory while printing its JSON (probed on 2.1.296), so the probe's
 * rejection IS the answer — fed to {@link parseClaudeAuthStatus}, which yields `null` for an empty string.
 */
export function readProcessErrorStdout(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string') return stdout;
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
  return '';
}

export type ClaudeAccountKind = 'personal' | 'corporate' | 'unknown';

/** Personal (`pro`, `max`) versus corporate (`team`, `enterprise`) subscription, from the CLI's `subscriptionType`. */
export function getClaudeAccountKind(subscriptionType: string | null): ClaudeAccountKind {
  if (subscriptionType === null) return 'unknown';
  const normalised = subscriptionType.toLowerCase();
  if (normalised === 'pro' || normalised === 'max') return 'personal';
  if (normalised === 'team' || normalised === 'enterprise') return 'corporate';
  return 'unknown';
}

// ── the spawn-side variable ──

export const claudeConfigDirVariableName = 'CLAUDE_CONFIG_DIR';

/**
 * @description Recover the `CLAUDE_CONFIG_DIR` a running process was started with from its command line —
 * the json-stream wrapper script or a tmux pane's `#{pane_start_command}` — so an adopted process after a bot
 * restart is compared against the profile its topic has NOW (a mismatch is corrected at the next idle point).
 * The value is single-quoted by the bot's own quoting (`shellSingleQuote`), bare in older shapes; `null` when the
 * command carries none (the default profile).
 */
export function parseClaudeConfigDirFromCommand(command: string): string | null {
  // `shellSingleQuote` wraps the WHOLE assignment (`'CLAUDE_CONFIG_DIR=/dir'`), an embedded quote becoming `'\''`.
  const match = command.match(/(?:^|\s)(?:'CLAUDE_CONFIG_DIR=((?:[^']|'\\'')*)'|"CLAUDE_CONFIG_DIR=([^"]*)"|CLAUDE_CONFIG_DIR=(\S+))/);
  if (!match) return null;
  if (match[1] !== undefined) return match[1].replace(/'\\''/g, "'");
  return match[2] ?? match[3] ?? null;
}
