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
 * Everything Claude Code loads as USER-level configuration from that directory (instructions, rules, skills, subagents, commands,
 * output styles, workflows, mods, plugins, the settings with their hooks) is therefore kept a link into `~/.claude`: a profile folder is
 * writable by the user the bot and every agent run as, so an agent on the account could otherwise plant files there that every later
 * session on it would follow. {@link repairClaudeProfileLayout} restores the links right before a launch under the folder and moves
 * whatever stood in their place aside; the account's own state (login, `.claude.json`, history, caches) is never touched.
 *
 * The profile `default` IS `~/.claude` itself: nothing is set for it and nothing is migrated. A process is
 * never switched by swapping files under `~/.claude` (the CLI re-reads its credentials live and EVERY running
 * session would change account at once); the variable is per process, set at spawn.
 *
 * Pure helpers (layout, name gate, resolution, parsers) — the registry and the selection live in
 * `state.json` (`StateStore`), kept in step with the disk and the CLI by `utils/claudeProfileSync.ts` (a folder signed in by hand is
 * adopted without Telegram), the spawn-side use in the adapters, the UI in
 * `connectors/telegram/commands/claudeAccounts.ts`. Shaped for the later phases: a record carries room for a
 * `limitedUntil` mark and a cached usage snapshot, and the resolver takes the known names so a selection that
 * names a removed profile falls back instead of launching a dead directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getChildProcessEnvironment } from './agentEnvironment';

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

/**
 * The other user-level entries Claude Code loads from its config directory (code.claude.com/docs, «Explore the .claude directory»,
 * «Create a mod»): `CLAUDE.md` and `rules/` (instructions, loaded at session start), `agents/` (subagent prompts, with their hooks and
 * MCP servers in the frontmatter), `commands/` and `output-styles/` (prompts and instruction sets), `workflows/` (scripts the runtime
 * runs), and `dev-mods/<session id>/` (mods Claude wrote — loaded again when that session is RESUMED, which is what the bot does).
 * They mirror `~/.claude` the way the four above do, but only while `~/.claude` HAS the entry (a link to nothing would be read at every
 * start for nothing): where it has none, a profile must hold none either, so anything found there is moved aside.
 * Not in the list, on purpose: `keybindings.json` and `themes/` (the docs give them no instruction or executable role),
 * `settings.local.json` (the docs scope it to a project's `.claude/`, not the user directory) and `agent-memory/` (subagent memory —
 * the account's own state, loaded only by a subagent that opts in).
 */
export const claudeProfileOptionalSharedEntries = ['CLAUDE.md', 'rules', 'agents', 'commands', 'output-styles', 'workflows', 'dev-mods'] as const;

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

/** Whether this process may chmod a folder `stat` describes: root, the folder's owner, or a platform with no owner to ask. */
function checkCanChmod(stat: fs.Stats, uid: number | null): boolean {
  return uid === null || uid === 0 || stat.uid === uid;
}

/**
 * Whether this process may write into the folder `dir` (`stat` describes it): its owner or root may, and so may anyone the folder's
 * group or ACL lets write — a locked folder the CLI must still save its own files in is one an agent can add entries to, so it is not
 * left alone for being another user's. With a `uid` other than the process's own (a test standing in for another owner) only the
 * permission check speaks.
 */
function checkCanWriteInto(dir: string, stat: fs.Stats, uid: number | null): boolean {
  if (checkCanChmod(stat, uid) && uid === readCurrentUid()) return true;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The uid of this process; `null` where there is none (Windows). */
function readCurrentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * @description Create a profile's config directory: `0700`, with the entries it mirrors from `~/.claude` linked
 * ({@link repairClaudeProfileLayout}). Idempotent — an existing directory keeps its login and its state, gains a missing link, and has
 * anything that stands in a link's place moved aside; so a re-run after a crash is safe. Refuses `default` and an invalid name
 * (defence in depth: the command gate already rejected them). `~/.claude/projects` is created when absent so the link never dangles
 * into the one entry the bot reads. A folder another user owns (an operator locked it) is not chmod'ed, and one this user cannot write is not written to.
 */
export function createClaudeProfileLayout(input: { dataDir: string; name: string; homeClaudeDir?: string; uid?: number | null }): string {
  const { dataDir, name } = input;
  if (!checkIsValidClaudeProfileName(name)) throw new Error(`invalid Claude profile name: ${JSON.stringify(name)}`);
  const homeClaudeDir = input.homeClaudeDir ?? resolveHomeClaudeDir();
  const dir = resolveClaudeProfileDir(dataDir, name);
  if (dir === null) throw new Error('the default profile has no directory of its own');
  fs.mkdirSync(resolveClaudeProfilesRoot(dataDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.statSync(dir);
  // Only the owner may chmod (anyone else gets EPERM), and nothing is written when the mode is already right.
  if (checkCanChmod(dirStat, input.uid === undefined ? readCurrentUid() : input.uid) && (dirStat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(homeClaudeDir, 'projects'), { recursive: true });
  repairClaudeProfileLayout({ dataDir, name, homeClaudeDir, uid: input.uid, isStrict: true });
  return dir;
}

/** What stood where a link into `~/.claude` belongs. */
export type ClaudeProfileEntryFinding = 'missing' | 'wrongLink' | 'file' | 'directory' | 'other';

/** One entry the repair found wrong and what it did (or would have done) about it. */
export interface ClaudeProfileRepairAction {
  entry: string;
  found: ClaudeProfileEntryFinding;
  /** Where what stood there was moved aside to; `null` when nothing stood there. */
  movedTo: string | null;
  /** The target the link was restored to; `null` when `~/.claude` has no such entry and none belongs there. */
  linkedTo: string | null;
}

export interface ClaudeProfileRepairResult {
  /** The folder; `null` for `default`, an invalid name or an absent folder (nothing was looked at). */
  dir: string | null;
  /** `ok`: right already, or repaired; `notOwned`: wrong, in another user's folder this user cannot write — nothing was written; `failed`: a write failed. */
  status: 'ok' | 'skipped' | 'notOwned' | 'failed';
  /** What was repaired. */
  actions: ClaudeProfileRepairAction[];
  /** The entries still wrong afterwards (`notOwned`, `failed`). */
  pending: string[];
}

/** Profiles whose unrepairable layout was already warned about by this process: one warning each, not one per launch. */
const unrepairedWarnedDirs = new Set<string>();

/** For tests only: forget which profiles were warned about. */
export function resetClaudeProfileRepairWarningsForTests(): void {
  unrepairedWarnedDirs.clear();
  configRiskSeen.clear();
}

/** Whether the link at `linkPath` points at `target`: the same path, or paths that resolve to one real entry (an old spelling of it). */
function checkIsLinkTo(linkPath: string, target: string): boolean {
  let raw: string;
  try {
    raw = fs.readlinkSync(linkPath);
  } catch {
    return false;
  }
  if (path.resolve(path.dirname(linkPath), raw) === path.resolve(target)) return true;
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

/** `YYYYMMDDTHHMMSSZ` of an instant — the suffix of a moved-aside entry. */
function formatMovedAsideStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** A free `<entry>.moved-<UTC time>` name in `dir` (`-2`, `-3`… when two moves land in one second). */
function pickMovedAsideName(dir: string, entry: string, nowMs: number): string {
  const base = `${entry}.moved-${formatMovedAsideStamp(nowMs)}`;
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)) || isDanglingLink(path.join(dir, candidate)); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

function isDanglingLink(linkPath: string): boolean {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * @description Put a profile's folder back the way {@link createClaudeProfileLayout} made it, as far as the entries Claude Code loads
 * as user-level configuration go ({@link claudeProfileSharedEntries} always, {@link claudeProfileOptionalSharedEntries} where
 * `~/.claude` has them): each is a link to `~/.claude/<entry>`. Run right before every launch under the folder, so it is cheap — a few
 * `lstat`s, and NOT ONE write when the layout is right (a link into `~/.claude` that dangles is right: it is the one the bot made).
 * What stands in a link's place — a real file or directory, a link elsewhere, an entry `~/.claude` has no counterpart of — is MOVED
 * ASIDE as `<entry>.moved-<UTC time>`, never deleted (it may hold the operator's data), one log line each, and the right link restored.
 *
 * Everything else in the folder is the account's own state — `.credentials.json`, `.claude.json`, backups, history, caches, the
 * contents behind the `projects` link — and is never touched.
 *
 * A folder another user owns that this user cannot write (an operator locked it) is not written to: a wrong layout there is warned
 * about ONCE per profile per process, and the launch goes ahead — the agent runs as the same user as the bot, so a folder the bot
 * cannot write is one the agent could not plant in either. A locked folder this user CAN still write (its group or ACL lets the CLI
 * save its own files there) is repaired like any other — an agent could add entries to it — as far as the operator's entries allow
 * (with the sticky bit their links cannot be moved). A write that fails is warned about once the same way, unless `isStrict` (the
 * creation path), which throws it.
 */
export function repairClaudeProfileLayout(input: {
  dataDir: string;
  name: string;
  homeClaudeDir?: string;
  isStrict?: boolean;
  /** The uid that decides ownership; the process's own unless a test says otherwise. `null`: no owner to ask. */
  uid?: number | null;
  now?: () => number;
  log?: (line: string) => void;
}): ClaudeProfileRepairResult {
  const { dataDir, name } = input;
  const log = input.log ?? ((line: string) => console.warn(line));
  const dir = resolveClaudeProfileDir(dataDir, name);
  const skipped: ClaudeProfileRepairResult = { dir: null, status: 'skipped', actions: [], pending: [] };
  if (dir === null || !checkIsValidClaudeProfileName(name)) return skipped;
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    return skipped;
  }
  if (!dirStat.isDirectory()) return skipped;
  const homeClaudeDir = input.homeClaudeDir ?? resolveHomeClaudeDir();
  const specs = [
    ...claudeProfileSharedEntries.map((entry) => ({ entry, isAlwaysLinked: true })),
    ...claudeProfileOptionalSharedEntries.map((entry) => ({ entry, isAlwaysLinked: false })),
  ];
  const plan: Array<{ entry: string; found: ClaudeProfileEntryFinding; isMoveNeeded: boolean; target: string | null }> = [];
  for (const { entry, isAlwaysLinked } of specs) {
    const target = path.join(homeClaudeDir, entry);
    const isLinkWanted = isAlwaysLinked || fs.existsSync(target);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(path.join(dir, entry));
    } catch {
      stat = null;
    }
    if (stat === null) {
      if (isLinkWanted) plan.push({ entry, found: 'missing', isMoveNeeded: false, target });
    } else if (stat.isSymbolicLink()) {
      if (!checkIsLinkTo(path.join(dir, entry), target)) plan.push({ entry, found: 'wrongLink', isMoveNeeded: true, target: isLinkWanted ? target : null });
    } else {
      plan.push({ entry, found: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', isMoveNeeded: true, target: isLinkWanted ? target : null });
    }
  }
  if (plan.length === 0) return { dir, status: 'ok', actions: [], pending: [] };

  const warnOnce = (line: string): void => {
    if (unrepairedWarnedDirs.has(dir)) return;
    unrepairedWarnedDirs.add(dir);
    log(line);
  };
  const uid = input.uid === undefined ? readCurrentUid() : input.uid;
  if (!checkCanWriteInto(dir, dirStat, uid)) {
    const pending = plan.map((step) => step.entry);
    warnOnce(`[accounts] profile ${name}: ${pending.join(', ')} ${pending.length === 1 ? 'is' : 'are'} not what the layout expects, but this user cannot write the folder (another user locked it), so nothing was changed; launching anyway`);
    return { dir, status: 'notOwned', actions: [], pending };
  }

  const nowMs = (input.now ?? Date.now)();
  const actions: ClaudeProfileRepairAction[] = [];
  const pending: string[] = [];
  let firstError: unknown = null;
  for (const step of plan) {
    const entryPath = path.join(dir, step.entry);
    try {
      let movedTo: string | null = null;
      if (step.isMoveNeeded) {
        movedTo = pickMovedAsideName(dir, step.entry, nowMs);
        fs.renameSync(entryPath, path.join(dir, movedTo));
        log(`[accounts] profile ${name}: ${step.entry} was ${step.found === 'wrongLink' ? 'a link to somewhere else' : `a ${step.found} of its own`}, not the link into ~/.claude — moved aside to ${movedTo}${step.target === null ? ' (~/.claude has no such entry)' : ''}`);
      }
      if (step.target !== null) {
        if (step.entry === 'projects') fs.mkdirSync(step.target, { recursive: true });
        try {
          fs.symlinkSync(step.target, entryPath);
        } catch (linkError) {
          // Another process — the bot's watch of the profiles folder adopting this very folder, a CLI call — made the same link between the plan
          // and this write: the layout is what this step wanted, so it is done. Anything else at that path is a failure as before.
          const isLinkMadeMeanwhile = linkError instanceof Error && 'code' in linkError && linkError.code === 'EEXIST' && checkIsLinkTo(entryPath, step.target);
          if (!isLinkMadeMeanwhile) throw linkError;
        }
      }
      actions.push({ entry: step.entry, found: step.found, movedTo, linkedTo: step.target });
    } catch (e) {
      pending.push(step.entry);
      firstError ??= e;
    }
  }
  if (pending.length === 0) return { dir, status: 'ok', actions, pending };
  if (input.isStrict === true) throw firstError;
  warnOnce(`[accounts] profile ${name}: ${pending.join(', ')} could not be put right (${firstError instanceof Error ? firstError.message : String(firstError)}); launching anyway`);
  return { dir, status: 'failed', actions, pending };
}

/**
 * @description What a profile's `.claude.json` — the account's own state, which the repair never edits — holds that Claude Code treats
 * as configuration with an effect: MCP servers (the docs keep them in `~/.claude.json`, per project under `projects.<path>.mcpServers`,
 * and a profile's file carries them at the top level too), and, defensively, the settings-style keys `hooks`, `env`, `apiKeyHelper`
 * and `statusLine` (the docs place those in `settings.json`; whether the CLI honours them in `.claude.json` is not documented, so a
 * mention is a pointer, not a verdict). Names only — never a command, argument or value. `[]` for a file that is absent, too big or
 * not JSON.
 */
export function listClaudeProfileConfigRisks(configDir: string): string[] {
  const file = path.join(configDir, '.claude.json');
  let parsed: unknown;
  try {
    if (fs.statSync(file).size > claudeJsonMaxReadBytes) return [];
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const risks: string[] = [];
  const nameServers = (servers: unknown): string[] => (servers && typeof servers === 'object' && !Array.isArray(servers)
    ? Object.keys(servers).slice(0, configRiskNameLimit).map((serverName) => serverName.replace(/[^\w.@ -]/g, '?').slice(0, 40))
    : []);
  const topServers = nameServers(record.mcpServers);
  if (topServers.length > 0) risks.push(`mcpServers: ${topServers.join(', ')}`);
  const projects = record.projects && typeof record.projects === 'object' && !Array.isArray(record.projects) ? Object.values(record.projects) : [];
  const projectServerCount = projects.filter((project) => project && typeof project === 'object' && nameServers((project as Record<string, unknown>).mcpServers).length > 0).length;
  if (projectServerCount > 0) risks.push(`projects.*.mcpServers: ${projectServerCount} project(s)`);
  for (const key of claudeJsonSettingsLikeKeys) {
    if (key in record) risks.push(`${key} (a settings key, not documented for this file)`);
  }
  return risks;
}

/** A `.claude.json` bigger than this is not read for the warning (the real ones are ~100 kB). */
const claudeJsonMaxReadBytes = 8 * 1024 * 1024;
const configRiskNameLimit = 10;
const claudeJsonSettingsLikeKeys = ['hooks', 'env', 'apiKeyHelper', 'statusLine'] as const;

/** What `.claude.json` held the last time the warning looked, per folder: `size:mtime` (skip the read while it is the same) and the risks said. */
const configRiskSeen = new Map<string, { stamp: string; said: string }>();

/**
 * @description THE call every launch under a profile folder makes first (a bot session, a sign-in or status probe, a worker the bot or
 * the CLI points at an account): repair the folder's layout ({@link repairClaudeProfileLayout}), then say — once per distinct finding,
 * not per launch — what its `.claude.json` configures ({@link listClaudeProfileConfigRisks}); the file is read only when its size or
 * time moved. `configDir` is the directory a process is about to get as `CLAUDE_CONFIG_DIR`: `null` (the default account) and any
 * directory that is not `<dataDir>/claude-profiles/<valid name>` are left alone. Never throws — a launch must not fail on a repair.
 */
export function repairClaudeProfileFolderForLaunch(input: {
  dataDir: string;
  configDir: string | null;
  homeClaudeDir?: string;
  uid?: number | null;
  now?: () => number;
  log?: (line: string) => void;
}): ClaudeProfileRepairResult {
  const skipped: ClaudeProfileRepairResult = { dir: null, status: 'skipped', actions: [], pending: [] };
  if (input.configDir === null) return skipped;
  const log = input.log ?? ((line: string) => console.warn(line));
  const resolved = path.resolve(input.configDir);
  const name = path.basename(resolved);
  if (path.dirname(resolved) !== path.resolve(resolveClaudeProfilesRoot(input.dataDir)) || !checkIsValidClaudeProfileName(name)) return skipped;
  try {
    const result = repairClaudeProfileLayout({ dataDir: input.dataDir, name, homeClaudeDir: input.homeClaudeDir, uid: input.uid, now: input.now, log });
    if (result.dir === null) return result;
    const stat = fs.statSync(path.join(result.dir, '.claude.json'), { throwIfNoEntry: false });
    const stamp = stat === undefined ? 'none' : `${stat.size}:${stat.mtimeMs}`;
    const seen = configRiskSeen.get(result.dir);
    if (seen?.stamp !== stamp) {
      const said = listClaudeProfileConfigRisks(result.dir).join('; ');
      configRiskSeen.set(result.dir, { stamp, said });
      if (said !== '' && said !== seen?.said) {
        log(`[accounts] profile ${name}: its .claude.json (the account's own state — not checked or edited by the bot) configures ${said}. These run as this account's user-level config; make sure they are yours`);
      }
    }
    return result;
  } catch (e) {
    log(`[accounts] profile ${name}: the pre-launch repair of its folder failed: ${e instanceof Error ? e.message : String(e)}`);
    return skipped;
  }
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

/**
 * The same, for a launch that carries the skills restore (json-stream, per-turn; `utils/claudeCompactHook.ts`): a file per
 * kind, so a tmux launch and a json-stream one of the same profile starting together never read each other's hooks.
 */
export const claudeProfileSkillsRestoreSettingsFileNames = {
  withBotSkills: 'charness-settings-skills-restore.json',
  withoutBotSkills: 'charness-settings-skills-restore-without-bot-skills.json',
} as const;

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

/** The profile's own `.claude.json`: where `claude auth login --console` keeps the key it created (`primaryApiKey`). */
const claudeProfileStateFileName = '.claude.json';

/** The text of a file, `null` when it cannot be read. */
function readTextFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The `primaryApiKey` of a Claude Code state file (`.claude.json`), `null` when there is none or it is no API key. */
function readPrimaryApiKey(stateFile: string): string | null {
  const stateText = readTextFileOrNull(stateFile);
  if (stateText === null) return null;
  // The file is the CLI's, not ours: whatever it holds is narrowed step by step before it is trusted (no schema library —
  // this module is loaded by the connector guards before any env file is read).
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const key = 'primaryApiKey' in parsed ? parsed.primaryApiKey : undefined;
  return typeof key === 'string' && checkIsPlausibleAnthropicApiKey(key) ? key.trim() : null;
}

/**
 * @description The API key an ADDED profile's own sessions use, read to make ONE direct request on its behalf (the daily
 * credit recheck): the pasted key file, else the key a Console login stored in the profile's `.claude.json`. `null` when the
 * directory holds neither, or what it holds does not look like an API key. The caller puts it in a request header and
 * nowhere else — it is never logged, echoed or stored.
 */
export function readClaudeProfileApiKey(configDir: string): string | null {
  const pastedKey = readTextFileOrNull(resolveClaudeProfileApiKeyFile(configDir));
  if (pastedKey !== null && checkIsPlausibleAnthropicApiKey(pastedKey)) return pastedKey.trim();
  return readPrimaryApiKey(path.join(configDir, claudeProfileStateFileName));
}

/**
 * @description The API key of the `default` profile (`~/.claude`, when it is billed to API credits), `null` unless its sessions
 * run on the key a Console login left in the home `.claude.json` (`primaryApiKey`; `isConsoleLoginKey`, from the auth probe):
 * the CLI prefers an `apiKeyHelper` or a variable over that key, and a stale `primaryApiKey` left by an earlier login would be
 * asked on a key the sessions do not use. The bot never writes a pasted key for the default. Same rules as
 * {@link readClaudeProfileApiKey}.
 */
export function readDefaultClaudeProfileApiKey(isConsoleLoginKey: boolean, homeDir: string = os.homedir()): string | null {
  return isConsoleLoginKey ? readPrimaryApiKey(path.join(homeDir, claudeProfileStateFileName)) : null;
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
  for (const fileName of [claudeProfileLaunchSettingsFileName, ...Object.values(claudeProfileSkillsRestoreSettingsFileNames)]) {
    fs.rmSync(path.join(configDir, fileName), { force: true });
  }
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

/**
 * @description Why a child process (the CLI's `auth status` probe) gave no answer, for one log line: killed by the
 * caller's timeout, the exit code, or the spawn error's code — never its output, which may name the account.
 */
export function getProcessFailureReason(error: unknown, timeoutMs: number): string {
  if (!error || typeof error !== 'object') return 'unknown failure';
  if ('killed' in error && error.killed === true) return `timed out after ${timeoutMs} ms`;
  if ('code' in error && (typeof error.code === 'number' || typeof error.code === 'string')) return `exit ${error.code}`;
  return 'unknown failure';
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
 * @description The environment a `claude auth …` process runs with (a sign-in, an auth-status probe): the bot's own
 * without its secrets and without `ANTHROPIC_API_KEY` (the subscription login, never the metered console path), plus
 * `CLAUDE_CONFIG_DIR` for a profile's directory (`null` = `~/.claude`) — the login must land in THAT directory, and the
 * status probe must read the same one.
 */
export function getClaudeAuthCommandEnvironment(configDir: string | null): NodeJS.ProcessEnv {
  const environment = getChildProcessEnvironment();
  delete environment.ANTHROPIC_API_KEY;
  if (configDir !== null) environment[claudeConfigDirVariableName] = configDir;
  return environment;
}

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
