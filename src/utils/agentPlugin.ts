/**
 * @description The skills Charness gives every agent session it starts (`agent-plugin/` at the package root, a
 * Claude Code plugin named `charness`): `charness-manager` and the two worker-delegation skills, which name the
 * bot's own tools. The operator's own sessions outside the bot never get them.
 *
 *  - Claude Code loads the folder through `--plugin-dir` on every bot launch of an agent session — also under
 *    `--setting-sources project,local` (a Jira session), probed on 2.1.310 — and lists the skills as
 *    `charness:<folder>` beside the user's and the project's own. A CLI older than the flag
 *    (`minPluginDirClaudeCodeVersion`) refuses to start with it, so such a CLI starts without the skills.
 *  - OpenCode reads `OPENCODE_CONFIG_DIR` once, when its server starts, and adds the `skills/` of that folder to the
 *    project's and the user's own (probed on the installed build; `OPENCODE_CONFIG_CONTENT` was no option: its
 *    `skills` list REPLACES the project's). The folder is a bot-owned one in `DATA_DIR` whose `skills` links to the
 *    package's, because OpenCode writes files (`.gitignore`) into it — inside the package they would dirty a checkout
 *    the bot runs from.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { checkIsClaudePluginDirSupported, minPluginDirClaudeCodeVersion } from './claudeCodeVersion';

const execFileAsync = promisify(execFile);
/** A `claude --version` that takes longer is treated as an unknown version (the launch then goes without the flag). */
const claudeVersionReadTimeoutMs = 10_000;

const agentPluginDirName = 'agent-plugin';
export const agentPluginSkillsDirName = 'skills';

/**
 * @description The plugin folder that ships in the package, two levels above this module (`src/utils` under tsx,
 * `dist/utils` once built), or null when it is missing (a broken install): a launch then goes without it rather than
 * failing on a folder Claude Code cannot load.
 */
export function resolveAgentPluginDir(): string | null {
  const pluginDir = path.join(fs.realpathSync(__dirname), '..', '..', agentPluginDirName);
  return fs.existsSync(path.join(pluginDir, agentPluginSkillsDirName)) ? pluginDir : null;
}

/** The version each Claude binary reported, read once per bot process (a hot reload or a restart reads again). */
const claudeVersionByBinary = new Map<string, string>();

/** @description `claude --version` of `claudeBinary` (`2.1.310 (Claude Code)`), cached; null when it cannot be read (not cached). */
export async function readClaudeCodeVersion(claudeBinary: string): Promise<string | null> {
  const cached = claudeVersionByBinary.get(claudeBinary);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync(claudeBinary, ['--version'], { timeout: claudeVersionReadTimeoutMs, encoding: 'utf8' });
    const version = stdout.split('\n')[0].trim();
    if (!version) return null;
    claudeVersionByBinary.set(claudeBinary, version);
    return version;
  } catch {
    return null;
  }
}

let isOldClaudeAnnounced = false;

/**
 * @description The Claude Code flags that load the bot's skills into an agent session: `--plugin-dir <folder>` — none
 * when the folder is missing, or when the CLI is older than the flag or its version cannot be read (announced once):
 * an unknown option would stop the launch itself.
 */
export async function getClaudeAgentPluginFlags(
  claudeBinary: string,
  pluginDir: string | null = resolveAgentPluginDir(),
  readVersion: (binary: string) => Promise<string | null> = readClaudeCodeVersion,
): Promise<string[]> {
  if (pluginDir === null) return [];
  const version = await readVersion(claudeBinary);
  if (!checkIsClaudePluginDirSupported(version)) {
    if (!isOldClaudeAnnounced) {
      isOldClaudeAnnounced = true;
      console.log(`[agentPlugin] Claude Code ${version ?? '(version unreadable)'} predates --plugin-dir (${minPluginDirClaudeCodeVersion}); its sessions start without the bot's skills`);
    }
    return [];
  }
  return ['--plugin-dir', pluginDir];
}

/** OpenCode's variable naming an extra config folder, searched like a project's `.opencode` (its `skills/` included). */
export const openCodeConfigDirEnvName = 'OPENCODE_CONFIG_DIR';
const openCodeAgentConfigDirName = 'opencode-config';

/** @description The bot-owned OpenCode config folder in `DATA_DIR`. */
export function getOpenCodeAgentConfigDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), openCodeAgentConfigDirName);
}

/**
 * @description Make the bot's OpenCode config folder hold a `skills` link to the package's skills (created, or
 * re-pointed when a move of the package left it stale) and return the folder; null when there is nothing to link or a
 * `skills` there is not the bot's link (left alone) or the folder cannot be written — the server then starts without
 * the bot's skills.
 */
export function prepareOpenCodeAgentConfigDir(dataDir: string, pluginDir: string | null = resolveAgentPluginDir()): string | null {
  if (pluginDir === null) return null;
  const configDir = getOpenCodeAgentConfigDir(dataDir);
  const skillsLink = path.join(configDir, agentPluginSkillsDirName);
  const skillsTarget = path.join(pluginDir, agentPluginSkillsDirName);
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const existing = fs.lstatSync(skillsLink, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      console.warn(`[agentPlugin] ${skillsLink} is not the bot's link; OpenCode starts without the bot's skills`);
      return null;
    }
    if (existing && fs.readlinkSync(skillsLink) === skillsTarget) return configDir;
    if (existing) fs.unlinkSync(skillsLink);
    fs.symlinkSync(skillsTarget, skillsLink, 'dir');
    return configDir;
  } catch (e) {
    console.warn(`[agentPlugin] cannot prepare ${configDir}; OpenCode starts without the bot's skills:`, e instanceof Error ? e.message : e);
    return null;
  }
}

let isOperatorConfigDirAnnounced = false;

/**
 * @description What the `opencode serve` the bot starts gets on top of its environment: `OPENCODE_CONFIG_DIR` naming the
 * bot's folder — nothing when the operator set the variable (theirs is kept; announced once) or the folder cannot be
 * prepared.
 */
export function getOpenCodeAgentConfigEnv(env: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {
  if (env[openCodeConfigDirEnvName]) {
    if (!isOperatorConfigDirAnnounced) {
      isOperatorConfigDirAnnounced = true;
      console.log(`[agentPlugin] ${openCodeConfigDirEnvName} is set by the operator and kept; OpenCode topics go without the bot's skills`);
    }
    return {};
  }
  const configDir = prepareOpenCodeAgentConfigDir(dataDir);
  return configDir === null ? {} : { [openCodeConfigDirEnvName]: configDir };
}

/**
 * @name OpenCodeServerLaunchReading
 * @description What the bot can read about the running OpenCode server's launch: `none` — no server answers on its
 * endpoint (a Claude-only instance, OpenCode not started yet); `unknown` — a server answers but is not a process it
 * can identify as `opencode … serve` (a server elsewhere, a test's stand-in, no `/proc`, a listener whose PID it
 * cannot read — another user's, or no `lsof` / `ss`); otherwise the
 * `OPENCODE_CONFIG_DIR` it was started with (null: none) and whether the bot owns it (its process record).
 */
export type OpenCodeServerLaunchReading =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'openCodeServe'; configDir: string | null; isOwnedByBot: boolean };

/**
 * @description The reading when no listener PID could be found: `none` only if no server answers its health check —
 * a PID that cannot be read (another user's process, no `lsof` / `ss`) does not prove there is no server.
 */
export function getPidlessServerLaunchReading(isServerAnswering: boolean): OpenCodeServerLaunchReading {
  return isServerAnswering ? { kind: 'unknown' } : { kind: 'none' };
}

/** @description What the `/proc` entries of a server's process say, before the bot's own record of who started it. */
export type OpenCodeServeProcessReading = { kind: 'unknown' } | { kind: 'openCodeServe'; configDir: string | null };

const openCodeServeCommand = 'serve';
const openCodeExecutableNamePrefix = 'opencode';
const procEntrySeparator = '\0';

/** @description Read a server's launch from its `/proc/<pid>/cmdline` and `/proc/<pid>/environ` contents. */
export function parseOpenCodeServerLaunch(cmdline: string, environ: string): OpenCodeServeProcessReading {
  const argv = cmdline.split(procEntrySeparator).filter(Boolean);
  const isOpenCodeServe = path.basename(argv[0] ?? '').startsWith(openCodeExecutableNamePrefix) && argv.includes(openCodeServeCommand);
  if (!isOpenCodeServe) return { kind: 'unknown' };
  const prefix = `${openCodeConfigDirEnvName}=`;
  const entry = environ.split(procEntrySeparator).find((variable) => variable.startsWith(prefix));
  return { kind: 'openCodeServe', configDir: entry === undefined ? null : entry.slice(prefix.length) };
}

/**
 * @description The folder a server must have been started with to offer the bot's skills — prepared here, so it is
 * the folder a new server WOULD get — or null when the bot offers none: the operator's own `OPENCODE_CONFIG_DIR`, no
 * plugin folder, or a folder that cannot be prepared. Then no server is ever replaced for the skills: its replacement
 * would come up without them too, and the next boot would replace it again.
 */
export function getExpectedOpenCodeAgentConfigDir(env: NodeJS.ProcessEnv, dataDir: string): string | null {
  if (env[openCodeConfigDirEnvName]) return null;
  return prepareOpenCodeAgentConfigDir(dataDir);
}

/**
 * @name OpenCodeAgentSkillsServerAction
 * @description What the boot step does about the running server: nothing (no server runs, it offers the skills, or
 * the bot offers none); replace it (an `opencode serve` the bot owns, started without the folder); or leave it and say why — a server
 * the bot does not own (locked decision D5: never touched), or a listener it cannot identify.
 */
export type OpenCodeAgentSkillsServerAction = 'none' | 'replace' | 'skipNotOwned' | 'skipUnidentified';

/** @description Decide the boot step's action from the server's launch and the folder the bot now offers. */
export function getOpenCodeAgentSkillsServerAction(reading: OpenCodeServerLaunchReading, expectedConfigDir: string | null): OpenCodeAgentSkillsServerAction {
  if (expectedConfigDir === null || reading.kind === 'none') return 'none';
  if (reading.kind === 'unknown') return 'skipUnidentified';
  if (reading.configDir === expectedConfigDir) return 'none';
  return reading.isOwnedByBot ? 'replace' : 'skipNotOwned';
}
