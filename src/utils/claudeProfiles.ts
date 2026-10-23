/**
 * @description Claude ACCOUNT PROFILES — several Claude logins kept side by side, one picked per topic
 * (`/account`): subscriptions, and accounts billed to a Claude Console organization's API credits (`billing: 'api'` —
 * a console login's key in the profile's own `.claude.json`, or a pasted key the profile's `apiKeyHelper` reads; see
 * the «pasted API key» helpers below). Nothing of an API account ever goes through `ANTHROPIC_API_KEY`. A profile is a Claude Code config directory of its own under
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

/**
 * @description Sign `~/.claude` (the `default` account) out by deleting ONLY its subscription login: the
 * `claudeAiOauth` entry of `<homeClaudeDir>/.credentials.json`. The file's other entries (`mcpOAuth` tokens
 * of MCP servers) stay; a file left with nothing else is deleted. `projects/`, settings, skills, plugins, the
 * user memory and `~/.claude.json` are never touched. Returns whether a login was found and removed.
 */
export function signOutDefaultClaudeLogin(homeClaudeDir: string = resolveHomeClaudeDir()): boolean {
  const file = path.join(homeClaudeDir, '.credentials.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('claudeAiOauth' in parsed)) return false;
  const rest = { ...(parsed as Record<string, unknown>) };
  delete rest.claudeAiOauth;
  if (Object.keys(rest).length === 0) {
    fs.rmSync(file, { force: true });
    return true;
  }
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rest), { mode });
  fs.renameSync(tmp, file);
  return true;
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

/**
 * How an account pays for its requests: a Claude `subscription` (claude.ai login: usage windows, no bill per request)
 * or the `api` balance of a Claude Console organization (a console login's API key, or a pasted key: billed per token,
 * no windows — the limit is the balance).
 */
export type ClaudeProfileBilling = 'subscription' | 'api';

/** What the account picker shows per profile, as the CLI reports it (`claude auth status --json`). */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  /** `pro` / `max` (personal), `team` / `enterprise` (corporate), or whatever newer CLIs add. */
  subscriptionType: string | null;
  orgName: string | null;
  /** The CLI's `authMethod`: `claude.ai`, `api_key`, `api_key_helper`, `oauth_token`, `third_party`, `none`; `null` on an older CLI. */
  authMethod: string | null;
  /** Where an API key comes from: `/login managed key` (a console login), `apiKeyHelper`, `ANTHROPIC_API_KEY`. */
  apiKeySource: string | null;
  /** {@link getClaudeAuthBilling} of the two above; `null` when the method says nothing about it (signed out, unknown). */
  billing: ClaudeProfileBilling | null;
}

/**
 * @description The billing an auth method means: an API key in any form (`api_key` — a console login or the
 * variable — and `api_key_helper`) bills the Console balance; `claude.ai` is the subscription. Anything else (signed
 * out, a cloud provider, a long-lived OAuth token) is `null`: the caller keeps what it knew.
 */
export function getClaudeAuthBilling(authMethod: string | null): ClaudeProfileBilling | null {
  if (authMethod === 'api_key' || authMethod === 'api_key_helper') return 'api';
  if (authMethod === 'claude.ai') return 'subscription';
  return null;
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
  const authMethod = readString(record.authMethod);
  return {
    loggedIn: record.loggedIn,
    email: readString(record.email),
    subscriptionType: readString(record.subscriptionType),
    orgName: readString(record.orgName),
    authMethod,
    apiKeySource: readString(record.apiKeySource),
    billing: record.loggedIn ? getClaudeAuthBilling(authMethod) : null,
  };
}

/** The `apiKeySource` of a key a `claude auth login --console` created and stored in the profile's own `.claude.json`. */
export const claudeConsoleLoginKeySource = '/login managed key';

// ── a pasted API key (`apiKeyHelper`) ──

/**
 * The file a pasted Anthropic API key is kept in, inside the profile's own directory (`0600`): never in `state.json`,
 * never in the environment. The CLI reads it through `apiKeyHelper` (`utils/claudeApiKeyHelper.ts`), which rides
 * the profile's `--settings` only.
 */
export const claudeProfileApiKeyFileName = 'charness-api-key';

/** The launch settings of a profile that holds a pasted key: the PreCompact hook AND the `apiKeyHelper` (one file — only the last `--settings` counts). */
export const claudeProfileLaunchSettingsFileName = 'charness-settings.json';

/** An Anthropic API key: `sk-ant-api03-…` (an admin key `sk-ant-admin…` or an OAuth token `sk-ant-oat…` cannot run Claude Code). */
const anthropicApiKeyRe = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,250}$/;
/** Anything that starts like an Anthropic credential — deleted from the topic as a secret even when it is not a usable key. */
const anthropicSecretPrefixRe = /^sk-ant-/;
/** An Anthropic credential anywhere in a text (the trace preview redacts it). */
export const anthropicSecretInTextRe = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/** Whether `text` (trimmed) is an Anthropic API key that can run Claude Code. */
export function checkIsPlausibleAnthropicApiKey(text: string): boolean {
  return anthropicApiKeyRe.test(text.trim());
}

/**
 * Whether `text` carries an Anthropic credential of any kind — it starts like one, or holds one anywhere
 * (`ANTHROPIC_API_KEY=sk-ant-…` copied from an env file, a key inside a sentence): it is a secret, whatever else it is.
 */
export function checkIsAnthropicSecretLike(text: string): boolean {
  return anthropicSecretPrefixRe.test(text.trim()) || (text.match(anthropicSecretInTextRe)?.length ?? 0) > 0;
}

/**
 * The one API key a pasted text carries — the bare key, or the key inside `ANTHROPIC_API_KEY=…`, quotes or a
 * sentence; `null` when it carries no API key (an admin key, an OAuth token) or more than one credential.
 */
export function extractAnthropicApiKey(text: string): string | null {
  const credentials = text.match(anthropicSecretInTextRe) ?? [];
  return credentials.length === 1 && checkIsPlausibleAnthropicApiKey(credentials[0]) ? credentials[0] : null;
}

/** The key file of a profile directory. */
export function resolveClaudeProfileApiKeyFile(configDir: string): string {
  return path.join(configDir, claudeProfileApiKeyFileName);
}

/** Whether the profile directory holds a pasted key (`null` = `~/.claude`, which never does: the bot writes none there). */
export function checkHasClaudeProfileApiKey(configDir: string | null): boolean {
  if (configDir === null) return false;
  try {
    return fs.statSync(resolveClaudeProfileApiKeyFile(configDir)).isFile();
  } catch {
    return false;
  }
}

/**
 * @description Store a pasted key in the profile's directory: `0600`, written through a temp file and renamed, so a
 * process reading it through the helper never sees half a key. The key is never logged.
 */
export function writeClaudeProfileApiKey(configDir: string, apiKey: string): void {
  const file = resolveClaudeProfileApiKeyFile(configDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${apiKey.trim()}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Drop a profile's pasted key (and the launch settings that point at it); a missing file is fine. */
export function removeClaudeProfileApiKey(configDir: string): void {
  fs.rmSync(resolveClaudeProfileApiKeyFile(configDir), { force: true });
  fs.rmSync(path.join(configDir, claudeProfileLaunchSettingsFileName), { force: true });
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
 * @description Whether two `CLAUDE_CONFIG_DIR` values name the same directory: equal strings, or paths that
 * resolve to the same real directory. A process adopted after the data dir was moved to its new name keeps
 * the old path in its command line (the old path is now a symlink), and must not look like a different
 * account — that would re-spawn it for nothing.
 */
export function checkIsSameClaudeConfigDir(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

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
