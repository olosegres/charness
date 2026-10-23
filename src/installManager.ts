import { execFileSync, exec, spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleep } from './utils';
import { installOpenCodeCompactPlugin } from './utils/openCodeCompactPlugin';
import {
  hotReloadEnvName,
  openCodeProcessFileEnvName,
  readRenamedEnv,
  resolveDefaultDataDir,
} from './legacyNames';

/**
 * The OpenCode server URL when `OPENCODE_URL` is unset — also every OTHER
 * instance's default on this host, which is why a Jira instance refuses it.
 */
export const defaultOpenCodeUrl = 'http://localhost:4096';
const defaultOpenCodePort = new URL(defaultOpenCodeUrl).port;

/** The port an OpenCode URL names; a URL without one means the default port (as `opencode serve` binds it). */
export function getOpenCodePort(serverUrl: URL): string {
  return serverUrl.port || defaultOpenCodePort;
}

// Windows rarely sets HOME: the user's profile directory, as Node reads it.
const npmPrefix = path.join(process.env.HOME || os.homedir(), '.npm-global');

/** The PATH a tool's child process gets: the npm-global prefix's shims first (`<prefix>/bin`; on Windows `<prefix>`). */
function getNpmGlobalSearchPath(): string {
  const binDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  return `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
}

/** Map of tool name → npm package name */
const toolPackages: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  opencode: 'opencode-ai',
};

/**
 * @description Get custom binary path for a tool if configured via env var.
 * E.g. OPENCODE_BIN=/path/to/opencode for custom opencode binary.
 */
function getCustomBinaryPath(toolName: string): string | null {
  const envVar = `${toolName.toUpperCase()}_BIN`;
  const customPath = process.env[envVar];
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }
  return null;
}

/**
 * @description Where {@link installTool} puts a tool's binary (`~/.npm-global/bin/<tool>`), when it is there.
 * The spawns look there too — the OpenCode server and version probe put that directory first on PATH, the
 * Claude binary falls back to it — so a binary that lives only there is installed, not missing.
 */
function getNpmGlobalBinaryPath(toolName: string): string | null {
  // npm puts a prefix's shims in `<prefix>/bin` on POSIX and in `<prefix>` itself on Windows (`opencode.cmd`).
  const binDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  return findToolOnPath(toolName, { platform: process.platform, pathValue: binDir, pathExtValue: process.env.PATHEXT });
}

/** What a PATH lookup reads of its host: the process's own by default; a test hands it another platform's. */
export interface PathLookupEnvironment {
  platform: NodeJS.Platform;
  pathValue: string;
  /** Windows' `PATHEXT` (`.COM;.EXE;.BAT;.CMD`, …); unread elsewhere. */
  pathExtValue: string | undefined;
}

/** The extensions a Windows shell tries when `PATHEXT` is unset. */
const defaultWindowsPathExt = '.COM;.EXE;.BAT;.CMD';

function getProcessPathLookupEnvironment(): PathLookupEnvironment {
  return { platform: process.platform, pathValue: process.env.PATH ?? '', pathExtValue: process.env.PATHEXT };
}

/** @description Whether `candidatePath` is a file the platform would run: on POSIX also executable. */
function checkIsRunnableFile(candidatePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidatePath).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @description The first file on PATH that runs as `toolName`, or `null` — what `which` (POSIX) and `where` (Windows)
 * find, without spawning either: Windows has no `which`, so every tool read as missing there. POSIX: the bare name, if
 * executable. Windows: the name with each `PATHEXT` extension (npm installs `opencode.cmd`), as `where` does.
 */
export function findToolOnPath(toolName: string, environment: PathLookupEnvironment = getProcessPathLookupEnvironment()): string | null {
  const isWindows = environment.platform === 'win32';
  const directories = environment.pathValue.split(isWindows ? ';' : ':').filter((directory) => directory !== '');
  const extensions = isWindows
    ? (environment.pathExtValue || defaultWindowsPathExt).split(';').filter((extension) => extension !== '')
      // Windows matches the extension case-insensitively; the lower-case spelling is how npm writes its shims.
      .flatMap((extension) => [...new Set([extension.toLowerCase(), extension])])
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidatePath = path.join(directory, `${toolName}${extension}`);
      if (checkIsRunnableFile(candidatePath, environment.platform)) return candidatePath;
    }
  }
  return null;
}

/** @description Whether the tool is on the process PATH ({@link findToolOnPath}). */
function checkIsOnPath(toolName: string): boolean {
  return findToolOnPath(toolName) !== null;
}

/**
 * @description Check if a CLI tool is installed: a custom binary (TOOL_BIN env var), the tool on PATH, or the
 * copy {@link installTool} left in `~/.npm-global/bin`. Checking PATH alone read that copy as missing, so every
 * start re-ran `npm install -g`.
 */
export function checkIsInstalled(toolName: string): boolean {
  return getCustomBinaryPath(toolName) !== null || checkIsOnPath(toolName) || getNpmGlobalBinaryPath(toolName) !== null;
}

/**
 * @description Get the command/path to run a tool: the custom binary (TOOL_BIN env var), else the bare name when
 * it is on PATH, else the `~/.npm-global/bin` copy by its full path — so a spawn that does not put that directory on
 * PATH (`opencode models`) runs the same binary {@link checkIsInstalled} found.
 */
export function getToolCommand(toolName: string): string {
  const customPath = getCustomBinaryPath(toolName);
  if (customPath) {
    return customPath;
  }
  if (process.platform === 'win32') {
    // Windows: the file itself (npm's `opencode.cmd`): `spawn` tries no PATHEXT, and a shim needs {@link getToolLaunch}.
    return findToolOnPath(toolName) ?? getNpmGlobalBinaryPath(toolName) ?? toolName;
  }
  if (checkIsOnPath(toolName)) return toolName;
  return getNpmGlobalBinaryPath(toolName) ?? toolName;
}

/**
 * @name ToolLaunch
 * @description What to spawn for a tool and its arguments. `windowsVerbatimArguments`: the arguments are a `cmd.exe`
 * command line quoted by {@link getToolLaunch}, which Node must pass as they are.
 */
export interface ToolLaunch {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** What {@link getToolLaunch} reads of its host — the process's own by default; a test hands it Windows'. */
export interface ToolLaunchHost {
  platform: NodeJS.Platform;
  /** The Node that runs an npm shim's script: the one running the bot. */
  nodePath: string;
  /** `%ComSpec%`, the shell a non-npm `.cmd` / `.bat` runs in. */
  comSpec: string;
  readFile: (filePath: string) => string;
}

function getProcessToolLaunchHost(): ToolLaunchHost {
  return {
    platform: process.platform,
    nodePath: process.execPath,
    comSpec: process.env.ComSpec || 'cmd.exe',
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  };
}

/** Windows batch files: `spawn` cannot run one without a shell (Node refuses it since the 2024 batch-file fix). */
const windowsBatchExtensionRe = /\.(?:cmd|bat)$/i;
/**
 * The target an npm `.cmd` shim runs (npm's cmd-shim: `"%dp0%\node_modules\…\bin\opencode" %*`, older ones `%~dp0`),
 * relative to the shim's folder. A shim for a Node script runs it with `"%_prog%"` (node); one for a native binary runs
 * the target itself.
 */
const npmCmdShimTargetRe = /"%(?:dp0%|~dp0)\\([^"]+)"\s*%\*/i;
const npmCmdShimNodeMarker = '%_prog%';
/** What `cmd.exe` would read as an operator or an expansion: never put into a command line it parses. */
const cmdUnsafeCharsRe = /[&|<>^%!"\r\n]/;

/**
 * @description How to launch the tool at `toolPath` with `toolArgs`. A plain executable runs as it is. A Windows `.cmd`
 * / `.bat` — what npm installs (`opencode.cmd`) — cannot be spawned without a shell: npm's own shim is read and the
 * script it wraps runs on this Node (or the native binary it names runs directly), no shell at all; any other batch
 * file runs through `cmd.exe /d /s /c` with a command line quoted here, refused when a part holds a character `cmd.exe`
 * would interpret (the bot's own arguments never do).
 */
export function getToolLaunch(toolPath: string, toolArgs: readonly string[], host: ToolLaunchHost = getProcessToolLaunchHost()): ToolLaunch {
  if (host.platform !== 'win32' || !windowsBatchExtensionRe.test(toolPath)) {
    return { command: toolPath, args: [...toolArgs], windowsVerbatimArguments: false };
  }
  let shimText = '';
  try {
    shimText = host.readFile(toolPath);
  } catch {
    // Unreadable: the shell path below still runs it.
  }
  const shimTarget = npmCmdShimTargetRe.exec(shimText)?.[1];
  if (shimTarget !== undefined) {
    const targetPath = path.win32.join(path.win32.dirname(toolPath), shimTarget);
    return shimText.includes(npmCmdShimNodeMarker)
      ? { command: host.nodePath, args: [targetPath, ...toolArgs], windowsVerbatimArguments: false }
      : { command: targetPath, args: [...toolArgs], windowsVerbatimArguments: false };
  }
  const parts = [toolPath, ...toolArgs];
  const unsafePart = parts.find((part) => cmdUnsafeCharsRe.test(part));
  if (unsafePart !== undefined) throw new Error(`cannot run ${toolPath} through cmd.exe: ${JSON.stringify(unsafePart)} holds a character cmd.exe interprets`);
  const commandLine = parts.map((part) => `"${part}"`).join(' ');
  return { command: host.comSpec, args: ['/d', '/s', '/c', `"${commandLine}"`], windowsVerbatimArguments: true };
}

/**
 * @description Install a CLI tool via npm global install.
 * Installs to ~/.npm-global/bin/ which is persisted in docker volume.
 */
export async function installTool(toolName: string): Promise<void> {
  const packageName = toolPackages[toolName];
  if (!packageName) {
    throw new Error(`Unknown tool: ${toolName}. Available: ${Object.keys(toolPackages).join(', ')}`);
  }

  console.log(`[Install] Installing ${toolName} (${packageName})...`);

  return new Promise((resolve, reject) => {
    exec(
      `npm install -g ${packageName}`,
      // The prefix rides the environment: a `NAME=value command` prefix is POSIX shell syntax, which Windows' cmd lacks.
      { timeout: 120000, encoding: 'utf-8', env: { ...process.env, NPM_CONFIG_PREFIX: npmPrefix } },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[Install] Failed to install ${toolName}:`, stderr);
          reject(new Error(`Failed to install ${toolName}: ${error.message}`));
          return;
        }
        console.log(`[Install] ${toolName} installed successfully`);
        if (stdout.trim()) console.log(stdout.trim());
        resolve();
      },
    );
  });
}

/**
 * @description Ensure a tool is installed. Install if missing.
 * Returns true if tool was already installed, false if it had to be installed.
 */
export async function ensureInstalled(toolName: string): Promise<boolean> {
  if (checkIsInstalled(toolName)) {
    return true;
  }
  await installTool(toolName);
  return false;
}

// ═══════════════════════════════════════════
//  OpenCode server process management
// ═══════════════════════════════════════════

let openCodeProcess: ChildProcess | null = null;

export interface ExternalProcessIdentity {
  pid: number;
  startToken: string;
}

interface ExternalProcessHostOptions {
  hostScript?: string;
  prepareProcessIdentity?: (processIdentity: ExternalProcessIdentity) => void;
  resolveProcessIdentity?: (pid: number) => ExternalProcessIdentity | null;
  timeoutMs?: number;
}

interface OpenCodeProcessOwnership extends ExternalProcessIdentity {
  endpoint: string;
  signalProcessGroup: boolean;
  state: 'starting' | 'ready';
}

let ownedOpenCodeProcess: OpenCodeProcessOwnership | null = null;
let openCodeServerLifecycleTail = Promise.resolve();

/**
 * The hot-mode handshake between the supervisor and its worker. The supervisor
 * may be a process started before the rename, which sets only the legacy names
 * (`TELEGRAMCODE_*`), so every read goes through {@link checkIsOpenCodeExternalHost}
 * / {@link readOpenCodeOwnershipFilePath}, and every write sets both names.
 */
export const openCodeExternalHostEnvName = hotReloadEnvName.current;
export const openCodeExternalHostEnvValue = '1';
export const openCodeOwnershipFileEnvName = openCodeProcessFileEnvName.current;

/** @description Is this process a hot worker, whose OpenCode generations are hosted outside its tree? */
export function checkIsOpenCodeExternalHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, hotReloadEnvName) === openCodeExternalHostEnvValue;
}

/** @description The persisted OpenCode ownership file the supervisor named, if any. */
export function readOpenCodeOwnershipFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readRenamedEnv(env, openCodeProcessFileEnvName);
}

/** @description Unmark the process as a hot worker (the supervisor owns its OpenCode server directly). */
export function clearOpenCodeExternalHostEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[hotReloadEnvName.current];
  delete env[hotReloadEnvName.legacy];
}

/** @description Name the ownership file for this process and the workers it starts, under both names. */
export function setOpenCodeOwnershipFileEnv(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  env[openCodeProcessFileEnvName.current] = filePath;
  env[openCodeProcessFileEnvName.legacy] = filePath;
}

export function getOpenCodeChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv = { ...baseEnv };
  for (const name of [hotReloadEnvName, openCodeProcessFileEnvName]) {
    delete childEnv[name.current];
    delete childEnv[name.legacy];
  }
  return childEnv;
}

const externalProcessHostStartTimeoutMs = 5_000;
const externalProcessHostAbortTimeoutMs = 2_000;
const externalProcessHostScript = `
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
let isReleased = false;
let shouldAbort = false;
let isAborting = false;
const child = spawn(command, args, {
  env: process.env,
  detached: true,
  windowsHide: true,
  stdio: 'inherit',
});
const finishAbort = () => {
  process.disconnect?.();
  process.exitCode = 1;
};
const abortChild = () => {
  shouldAbort = true;
  if (isAborting || !child.pid) return;
  isAborting = true;
  child.once('exit', finishAbort);
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      finishAbort();
    }
  }
};
process.on('message', (message) => {
  if (message?.action === 'release' && !shouldAbort) {
    isReleased = true;
    child.unref();
    process.disconnect?.();
    return;
  }
  if (message?.action === 'abort') abortChild();
});
process.on('disconnect', () => {
  if (!isReleased) abortChild();
});
child.once('error', (error) => {
  process.send?.({ error: error.message });
  process.disconnect?.();
  process.exitCode = 1;
});
child.once('spawn', () => {
  process.send?.({ pid: child.pid });
  if (shouldAbort) abortChild();
});
`;

/** Callback invoked when the OpenCode server process exits unexpectedly (not via stopOpenCodeServer) */
let onServerExitCallback: ((code: number | null, signal: string | null) => void) | null = null;
const intentionallyStoppedProcesses = new WeakSet<ChildProcess>();
const relinquishedProcesses = new WeakSet<ChildProcess>();

/**
 * @description Start a process through a one-shot Node host. The host exits
 * before this promise resolves, so the long-lived process is reparented outside
 * the caller's process tree. Hot-mode workers use this because nodemon kills a
 * snapshot of every descendant on reload, including ordinary detached children.
 */
export function startExternallyParentedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: ExternalProcessHostOptions = {},
): Promise<ExternalProcessIdentity> {
  return new Promise((resolve, reject) => {
    const host = spawn(
      process.execPath,
      ['-e', options.hostScript ?? externalProcessHostScript, command, JSON.stringify(args)],
      {
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    let hostedProcess: ExternalProcessIdentity | null = null;
    let hostError: string | null = null;
    let pendingError: Error | null = null;
    let isSettled = false;
    let abortTimeout: NodeJS.Timeout | null = null;

    const settleWithError = (error: Error): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      if (abortTimeout) clearTimeout(abortTimeout);
      if (hostedProcess) {
        signalExternallyHostedProcess(hostedProcess, 'SIGKILL');
      }
      reject(error);
    };
    const requestAbort = (error: Error): void => {
      if (isSettled || pendingError) return;
      pendingError = error;
      clearTimeout(timeout);
      if (hostedProcess) {
        signalExternallyHostedProcess(hostedProcess, 'SIGKILL');
      }
      if (host.connected) host.send({ action: 'abort' });
      abortTimeout = setTimeout(() => {
        host.kill('SIGKILL');
        settleWithError(error);
      }, externalProcessHostAbortTimeoutMs);
    };
    const timeout = setTimeout(() => {
      requestAbort(new Error('External process host did not exit after starting its child'));
    }, options.timeoutMs ?? externalProcessHostStartTimeoutMs);

    host.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if ('pid' in message && typeof message.pid === 'number') {
        const processIdentity = (options.resolveProcessIdentity ?? getProcessIdentity)(message.pid);
        if (processIdentity) {
          hostedProcess = processIdentity;
          if (!pendingError) {
            try {
              options.prepareProcessIdentity?.(processIdentity);
              host.send({ action: 'release' }, (error) => {
                if (error) requestAbort(error);
              });
            } catch (error) {
              requestAbort(error instanceof Error ? error : new Error(error?.toString() ?? 'unknown error'));
            }
          }
        } else {
          hostError = `could not identify child process ${message.pid}`;
          requestAbort(new Error(`External process host failed: ${hostError}`));
        }
      }
      if ('error' in message && typeof message.error === 'string') {
        hostError = message.error;
        requestAbort(new Error(`External process host failed: ${hostError}`));
      }
    });
    host.once('error', settleWithError);
    host.once('exit', (code, signal) => {
      if (isSettled) return;
      clearTimeout(timeout);
      if (abortTimeout) clearTimeout(abortTimeout);
      if (pendingError) {
        settleWithError(pendingError);
        return;
      }
      if (hostError) {
        settleWithError(new Error(`External process host failed: ${hostError}`));
        return;
      }
      // A child the host identified and released has STARTED, even if it has already exited again (a sidecar start
      // that found another start holding the record leaves at once): whether it still runs is the caller's question —
      // each one checks it. Under load the host's exit could come after the child's, and the start read as failed.
      if (code !== 0 || !hostedProcess) {
        settleWithError(
          new Error(
            `External process host exited before starting its child ` +
              `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        );
        return;
      }
      isSettled = true;
      resolve(hostedProcess);
    });
  });
}

export function getProcessIdentity(pid: number): ExternalProcessIdentity | null {
  const startToken = getProcessStartToken(pid);
  return startToken ? { pid, startToken } : null;
}

export function getDefaultOpenCodeOwnershipFilePath(baseDirectory = process.cwd()): string {
  const dataDirectory = process.env.DATA_DIR || resolveDefaultDataDir();
  return path.join(path.resolve(baseDirectory, dataDirectory), '.opencode-server-process');
}

function saveOpenCodeServerProcessOwnership(processOwnership: OpenCodeProcessOwnership): void {
  const ownershipFilePath = readOpenCodeOwnershipFilePath();
  if (!ownershipFilePath) return;
  const ownershipDirectory = path.dirname(ownershipFilePath);
  const temporaryPath = `${ownershipFilePath}.tmp-${process.pid}`;
  fs.mkdirSync(ownershipDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    temporaryPath,
    `${processOwnership.pid}\n${processOwnership.startToken}\n` +
      `${processOwnership.endpoint}\n${processOwnership.signalProcessGroup ? 'group' : 'process'}\n` +
      `${processOwnership.state}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPath, ownershipFilePath);
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function saveHealthyOpenCodeServerOwnership(endpoint: string, hostname: string, port: string): void {
  if (!readOpenCodeOwnershipFilePath() || !loopbackHostnames.has(hostname)) return;
  const processOwnership = getOwnedOpenCodeProcessOwnership(endpoint);
  if (processOwnership) {
    const readyProcessOwnership: OpenCodeProcessOwnership = {
      ...processOwnership,
      state: 'ready',
    };
    ownedOpenCodeProcess = readyProcessOwnership;
    saveOpenCodeServerProcessOwnership(readyProcessOwnership);
    return;
  }
  const listenerPid = getPidListeningOnEndpoint(hostname, port);
  const listenerIdentity = listenerPid ? getProcessIdentity(listenerPid) : null;
  if (!listenerIdentity) return;
  ownedOpenCodeProcess = {
    ...listenerIdentity,
    endpoint,
    signalProcessGroup: false,
    state: 'ready',
  };
  saveOpenCodeServerProcessOwnership(ownedOpenCodeProcess);
}

function getPersistedOpenCodeProcessOwnership(
  expectedEndpoint?: string,
): OpenCodeProcessOwnership | null {
  const ownershipFilePath = readOpenCodeOwnershipFilePath();
  if (!ownershipFilePath || !fs.existsSync(ownershipFilePath)) return null;
  try {
    const [pidText, startToken, endpoint, signalScope, persistedState = 'ready'] = fs
      .readFileSync(ownershipFilePath, 'utf8')
      .trim()
      .split('\n');
    const pid = Number.parseInt(pidText, 10);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !startToken ||
      !endpoint ||
      (signalScope !== 'group' && signalScope !== 'process') ||
      (persistedState !== 'starting' && persistedState !== 'ready')
    ) {
      fs.rmSync(ownershipFilePath, { force: true });
      return null;
    }
    if (expectedEndpoint && endpoint !== expectedEndpoint) return null;
    const processOwnership: OpenCodeProcessOwnership = {
      pid,
      startToken,
      endpoint,
      signalProcessGroup: signalScope === 'group',
      state: persistedState,
    };
    if (
      checkIsProcessIdentityCurrent(processOwnership) &&
      (!expectedEndpoint || checkIsOpenCodeProcessOwnershipCurrent(processOwnership))
    ) {
      return processOwnership;
    }
    fs.rmSync(ownershipFilePath, { force: true });
    return null;
  } catch (error) {
    console.warn(
      `[OpenCode] Failed to read process ownership file ${ownershipFilePath}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function clearPersistedOpenCodeProcessOwnership(processOwnership: OpenCodeProcessOwnership): void {
  const ownershipFilePath = readOpenCodeOwnershipFilePath();
  if (!ownershipFilePath || !fs.existsSync(ownershipFilePath)) return;
  try {
    const persistedOwnership = getPersistedOpenCodeProcessOwnership();
    if (
      persistedOwnership?.pid === processOwnership.pid &&
      persistedOwnership.startToken === processOwnership.startToken &&
      persistedOwnership.endpoint === processOwnership.endpoint
    ) {
      fs.rmSync(ownershipFilePath, { force: true });
    }
  } catch (error) {
    console.warn(
      `[OpenCode] Failed to clear process ownership file ${ownershipFilePath}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** @description `Threads:` of `/proc/<pid>/status` (Linux); `0` when it cannot be read — the process is gone. */
function readProcessThreadCount(pid: number): number {
  try {
    const threadsLine = fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((line) => line.startsWith('Threads:'));
    return Number.parseInt(threadsLine?.split(/\s+/)[1] ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

function getProcessStartToken(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEndIndex = stat.lastIndexOf(')');
      if (commandEndIndex < 0) return null;
      // Fields after the command start at #3 (state); process start time is #22.
      const processFields = stat.slice(commandEndIndex + 1).trim().split(/\s+/);
      // A zombie is gone only once its whole thread group is: the leader of a multi-threaded process (Node's libuv
      // pool) reads `Z` while other threads still exit and still hold its sockets — a listening port then accepts
      // connections and resets them. Measured under load: 35 of 40 Node exits passed through that window.
      if (processFields[0] === 'Z' && readProcessThreadCount(pid) <= 1) return null;
      return processFields[19] ?? null;
    }
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', timeout: 3000 },
      );
      return output.trim() || null;
    }
    const output = execFileSync('ps', ['-o', 'lstart=', '-o', 'command=', '-p', pid.toString()], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

export function checkIsProcessIdentityCurrent(processIdentity: ExternalProcessIdentity): boolean {
  return getProcessStartToken(processIdentity.pid) === processIdentity.startToken;
}

function checkIsOpenCodeProcessOwnershipCurrent(
  processOwnership: OpenCodeProcessOwnership,
): boolean {
  if (!checkIsProcessIdentityCurrent(processOwnership)) return false;
  if (processOwnership.state === 'starting' && processOwnership.signalProcessGroup) {
    return true;
  }
  const serverUrl = new URL(processOwnership.endpoint);
  const port = getOpenCodePort(serverUrl);
  return getPidListeningOnEndpoint(serverUrl.hostname, port) === processOwnership.pid;
}

export function signalExternallyHostedProcess(
  processIdentity: ExternalProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  return signalProcessIdentity(processIdentity, signal, true);
}

function signalProcessIdentity(
  processIdentity: ExternalProcessIdentity,
  signal: NodeJS.Signals,
  signalProcessGroup: boolean,
): boolean {
  if (!checkIsProcessIdentityCurrent(processIdentity)) return false;
  try {
    const targetPid = signalProcessGroup && process.platform !== 'win32'
      ? -processIdentity.pid
      : processIdentity.pid;
    process.kill(targetPid, signal);
    return true;
  } catch (error) {
    if (checkIsProcessIdentityCurrent(processIdentity)) {
      console.warn(
        `[OpenCode] Failed to signal process ${processIdentity.pid}:`,
        error instanceof Error ? error.message : error,
      );
    }
    return false;
  }
}

function getOwnedOpenCodeProcessOwnership(endpoint: string): OpenCodeProcessOwnership | null {
  if (ownedOpenCodeProcess) {
    if (ownedOpenCodeProcess.endpoint !== endpoint) {
      if (openCodeProcess?.pid === ownedOpenCodeProcess.pid) {
        relinquishedProcesses.add(openCodeProcess);
        openCodeProcess = null;
      }
      ownedOpenCodeProcess = null;
    } else if (checkIsOpenCodeProcessOwnershipCurrent(ownedOpenCodeProcess)) {
      return ownedOpenCodeProcess;
    } else {
      clearPersistedOpenCodeProcessOwnership(ownedOpenCodeProcess);
      ownedOpenCodeProcess = null;
    }
  }
  const persistedOwnership = getPersistedOpenCodeProcessOwnership(endpoint);
  if (persistedOwnership) {
    ownedOpenCodeProcess = persistedOwnership;
  }
  return persistedOwnership;
}

function checkHasOwnedOpenCodeProcess(endpoint: string): boolean {
  return getOwnedOpenCodeProcessOwnership(endpoint) !== null;
}

function clearOwnedOpenCodeProcessOwnership(processOwnership: OpenCodeProcessOwnership): void {
  if (openCodeProcess?.pid === processOwnership.pid) {
    openCodeProcess = null;
  }
  if (
    ownedOpenCodeProcess?.pid === processOwnership.pid &&
    ownedOpenCodeProcess.startToken === processOwnership.startToken &&
    ownedOpenCodeProcess.endpoint === processOwnership.endpoint
  ) {
    ownedOpenCodeProcess = null;
  }
  clearPersistedOpenCodeProcessOwnership(processOwnership);
}

function runOpenCodeServerLifecycle(operation: () => Promise<void>): Promise<void> {
  const currentOperation = openCodeServerLifecycleTail.then(operation, operation);
  openCodeServerLifecycleTail = currentOperation.catch(() => undefined);
  return currentOperation;
}

/**
 * @description Register a callback for unexpected server process exits.
 * Called when the server crashes or is OOM-killed (e.g. exit code 137).
 * NOT called when stopOpenCodeServer() is used.
 */
export function onOpenCodeServerExit(callback: (code: number | null, signal: string | null) => void): void {
  onServerExitCallback = callback;
}

export async function checkIsOpenCodeServerRunning(): Promise<boolean> {
  return (await getOpenCodeServerHealth()).healthy;
}

export interface OpenCodeServerHealth {
  healthy: boolean;
  /** Version the running server reports, or null if unreachable / field absent. */
  version: string | null;
}

/**
 * @description Extract a bare semver (`1.17.11`; drops a leading `v`) from a
 * version string — used for BOTH `opencode --version` output AND the
 * `/global/health` `version` field, so the two comparison sides are normalized
 * through the SAME rule. Without this, a future `v1.17.11` from one source vs
 * `1.17.11` from the other would read as a false mismatch and churn the server
 * once per boot. Returns null if no semver is present.
 */
export function extractOpenCodeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+\.\d+\S*/);
  return match ? match[0] : null;
}

/**
 * @description Probe /global/health for liveness AND the version the running
 * server is actually executing. Detects a server still running an OLD binary
 * after opencode was updated on disk: replacing the binary file does not change
 * a live process (it keeps the old code in memory), and a newer opencode run
 * can migrate the shared opencode.db underneath the old server — which then
 * dies on every prompt (e.g. `no such column: replacement_seq`).
 */
export async function getOpenCodeServerHealth(): Promise<OpenCodeServerHealth> {
  const url = process.env.OPENCODE_URL || defaultOpenCodeUrl;
  try {
    const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { healthy: false, version: null };
    const body = (await response.json().catch(() => null)) as { version?: string } | null;
    return { healthy: true, version: extractOpenCodeVersion(body?.version) };
  } catch {
    return { healthy: false, version: null };
  }
}

/** Cache so a boot-time reattach burst doesn't spawn `opencode --version` per call. */
let installedOpenCodeVersionCache: { value: string | null; at: number } | null = null;
const installedVersionCacheTtlMs = 10_000;

/**
 * @description Version of the opencode binary currently on disk
 * (`opencode --version`). Short-TTL cached to coalesce bursts. Returns null if
 * it can't be determined — an unknown version never forces a restart.
 */
function getInstalledOpenCodeVersion(): string | null {
  const now = Date.now();
  if (installedOpenCodeVersionCache && now - installedOpenCodeVersionCache.at < installedVersionCacheTtlMs) {
    return installedOpenCodeVersionCache.value;
  }
  let value: string | null = null;
  try {
    const versionLaunch = getToolLaunch(getToolCommand('opencode'), ['--version']);
    const probe = spawnSync(versionLaunch.command, versionLaunch.args, {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...getOpenCodeChildEnv(), PATH: getNpmGlobalSearchPath() },
      windowsVerbatimArguments: versionLaunch.windowsVerbatimArguments,
    });
    value = probe.status === 0 ? extractOpenCodeVersion(probe.stdout) : null;
  } catch {
    value = null;
  }
  installedOpenCodeVersionCache = { value, at: now };
  return value;
}

/**
 * @description Stale IFF BOTH versions are known AND differ. An unknown running
 * or installed version is treated as "not stale" (adopt the server) so a
 * transient probe failure never churns a working server.
 */
export function checkIsOpenCodeServerStale(runningVersion: string | null, installedVersion: string | null): boolean {
  return !!runningVersion && !!installedVersion && runningVersion !== installedVersion;
}

/** Find the PID LISTENING on one endpoint (lsof, with an ss fallback). */
function getPidListeningOnEndpoint(hostname: string, port: string): number | null {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
  const listenerAddresses = normalizedHostname === 'localhost'
    ? ['127.0.0.1', '::1']
    : [normalizedHostname];
  for (const listenerAddress of listenerAddresses) {
    // lsof wants IPv6 bracketed (`-iTCP@[::1]:4096`); unbracketed it rejects the
    // address and prints its usage into the bot's log.
    const lsofAddress = listenerAddress.includes(':') ? `[${listenerAddress}]` : listenerAddress;
    try {
      const output = execFileSync(
        'lsof',
        ['-nP', `-iTCP@${lsofAddress}:${port}`, '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const pid = Number.parseInt(output.split('\n')[0], 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      // lsof missing / no match — try the next address, then ss
    }
  }
  try {
    const output = execFileSync('ss', ['-ltnpH', `sport = :${port}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    for (const line of output.split('\n')) {
      const isExpectedAddress = listenerAddresses.some((listenerAddress) =>
        line.includes(`${listenerAddress}:${port}`) ||
        line.includes(`[${listenerAddress}]:${port}`));
      if (!isExpectedAddress) continue;
      const match = line.match(/pid=(\d+)/);
      if (match) return Number.parseInt(match[1], 10);
    }
  } catch {
    // Caller refuses to replace a server it cannot identify safely.
  }
  return null;
}

/** Server stop: poll process identity every {@link staleServerKillPollMs};
 * escalate to SIGKILL halfway and refuse replacement if it remains alive. */
const staleServerKillPollMs = 500;
const staleServerKillPollIterations = 16;
const staleServerSigkillAfterIterations = 8;

async function stopOpenCodeProcessOwnership(
  processOwnership: OpenCodeProcessOwnership,
  checkIsStillOwned: () => boolean,
): Promise<void> {
  if (
    !checkIsStillOwned() ||
    !signalProcessIdentity(processOwnership, 'SIGTERM', processOwnership.signalProcessGroup)
  ) {
    if (!checkIsProcessIdentityCurrent(processOwnership)) {
      clearOwnedOpenCodeProcessOwnership(processOwnership);
      return;
    }
    throw new Error(`OpenCode server process ${processOwnership.pid} could not be stopped`);
  }

  for (let i = 0; i < staleServerKillPollIterations; i++) {
    await sleep(staleServerKillPollMs);
    if (!checkIsProcessIdentityCurrent(processOwnership)) {
      clearOwnedOpenCodeProcessOwnership(processOwnership);
      return;
    }
    if (i === staleServerSigkillAfterIterations && checkIsStillOwned()) {
      signalProcessIdentity(processOwnership, 'SIGKILL', processOwnership.signalProcessGroup);
    }
  }
  throw new Error(
    `OpenCode server process ${processOwnership.pid} did not exit after SIGTERM and SIGKILL`,
  );
}

/**
 * @description Stop an OpenCode server that may have been ADOPTED at boot (so the
 * bot holds no child handle for it). Every signal is guarded by the process
 * start token captured for that PID, so PID reuse cannot target another process.
 * Waits for the exact process to exit, escalating SIGTERM → SIGKILL.
 */
async function stopAdoptedOpenCodeServer(serverUrl: URL): Promise<void> {
  const endpoint = serverUrl.origin;
  const port = getOpenCodePort(serverUrl);
  const ownedProcessOwnership = getOwnedOpenCodeProcessOwnership(endpoint);
  const listenerPid = ownedProcessOwnership
    ? null
    : getPidListeningOnEndpoint(serverUrl.hostname, port);
  const listenerIdentity = listenerPid ? getProcessIdentity(listenerPid) : null;
  const processOwnership = ownedProcessOwnership ?? (listenerIdentity
    ? { ...listenerIdentity, endpoint, signalProcessGroup: false, state: 'ready' }
    : null);
  if (!processOwnership) {
    if (await checkIsOpenCodeServerRunning()) {
      throw new Error(`OpenCode server on port ${port} is healthy but its process could not be identified`);
    }
    return;
  }

  if (openCodeProcess?.pid === processOwnership.pid) {
    intentionallyStoppedProcesses.add(openCodeProcess);
  }
  await stopOpenCodeProcessOwnership(
    processOwnership,
    () => checkIsOpenCodeProcessOwnershipCurrent(processOwnership),
  );
}

/**
 * @description Start opencode serve as a background process. A normal bot owns
 * the child directly; a replaceable hot worker uses a one-shot host so every
 * replacement generation is reparented outside nodemon's kill tree.
 * Waits until server responds to health check (up to 15s).
 *
 * If a server is already up but running an OUTDATED binary (version reported by
 * /global/health differs from the on-disk `opencode --version`), it is restarted
 * onto the current binary instead of being adopted — otherwise a stale server
 * lingers across bot restarts (boot would adopt it on a bare liveness check) and
 * keeps failing prompts after an opencode update.
 */
async function ensureOpenCodeServerUnlocked(): Promise<void> {
  const serverUrl = new URL(process.env.OPENCODE_URL || defaultOpenCodeUrl);
  const port = getOpenCodePort(serverUrl);
  const endpoint = serverUrl.origin;

  const health = await getOpenCodeServerHealth();
  if (health.healthy) {
    const installedVersion = getInstalledOpenCodeVersion();
    if (checkIsOpenCodeServerStale(health.version, installedVersion)) {
      console.log(
        `[OpenCode] Adopted server is stale (running v${health.version}, on-disk v${installedVersion}) — restarting onto current binary`,
      );
      await stopAdoptedOpenCodeServer(serverUrl);
      // fall through to spawn a fresh server on the current binary
    } else {
      saveHealthyOpenCodeServerOwnership(endpoint, serverUrl.hostname, port);
      return; // healthy and current (or version unknown) → adopt as-is
    }
  } else if (checkHasOwnedOpenCodeProcess(endpoint)) {
    // A persisted identity lets a fresh hot worker recover the supervisor's
    // initial server or a replacement started by an earlier worker generation.
    await stopAdoptedOpenCodeServer(serverUrl);
  }

  const opencodeCmd = getToolCommand('opencode');
  console.log(`[OpenCode] Starting server on port ${port}... (${opencodeCmd})`);

  const serverLaunch = getToolLaunch(opencodeCmd, ['serve', '--hostname', '127.0.0.1', '--port', port]);
  const serverEnv: NodeJS.ProcessEnv = {
    ...getOpenCodeChildEnv(),
    PATH: getNpmGlobalSearchPath(),
    // Enable OpenCode's background-subagents (experimental in 1.17.11): lets the
    // bot detach a synchronous sub-agent that is blocking a session via
    // `POST /experimental/session/:id/background` so a new message can be
    // answered while the sub-agent keeps running (its result is auto-injected
    // back when it finishes). Without this the whole session is locked for the
    // entire sub-agent run and the topic looks hung.
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
  };
  // The bot's compaction plugin, so an overflow compaction (which never gets the
  // bot's per-invocation instruction) still names the loaded skills. Installed
  // before the spawn so the new server's first folder instance already loads it.
  installOpenCodeCompactPlugin();
  let startupChild: ChildProcess | null = null;
  let startupHostedProcess: OpenCodeProcessOwnership | null = null;
  let startupDirectProcessOwnership: OpenCodeProcessOwnership | null = null;
  let startupError: Error | null = null;
  let hasServerBecomeReady = false;
  const checkIsStartupProcessRunning = (): boolean => {
    if (startupChild && (startupError !== null || startupChild.exitCode !== null)) {
      return false;
    }
    const startupProcessOwnership = startupDirectProcessOwnership ?? startupHostedProcess;
    return !startupProcessOwnership || checkIsProcessIdentityCurrent(startupProcessOwnership);
  };

  if (checkIsOpenCodeExternalHost()) {
    const hostedProcessIdentity = await startExternallyParentedProcess(
      serverLaunch.command,
      serverLaunch.args,
      serverEnv,
      {
        prepareProcessIdentity: (processIdentity) => {
          saveOpenCodeServerProcessOwnership({
            ...processIdentity,
            endpoint,
            signalProcessGroup: true,
            state: 'starting',
          });
        },
      },
    );
    startupHostedProcess = {
      ...hostedProcessIdentity,
      endpoint,
      signalProcessGroup: true,
      state: 'starting',
    };
    ownedOpenCodeProcess = startupHostedProcess;
    openCodeProcess = null;
    console.log(
      `[OpenCode] Server process ${startupHostedProcess.pid} is hosted outside the hot worker tree`,
    );
  } else {
    const child = spawn(serverLaunch.command, serverLaunch.args, {
      env: serverEnv,
      windowsVerbatimArguments: serverLaunch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startupChild = child;
    const directProcessIdentity = child.pid ? getProcessIdentity(child.pid) : null;
    startupDirectProcessOwnership = directProcessIdentity
      ? { ...directProcessIdentity, endpoint, signalProcessGroup: true, state: 'starting' }
      : null;
    openCodeProcess = child;
    ownedOpenCodeProcess = startupDirectProcessOwnership;

    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[OpenCode Server] ${data.toString().trim()}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[OpenCode Server] ${data.toString().trim()}`);
    });
    child.once('error', (error) => {
      startupError = error;
    });
    child.on('exit', (code, signal) => {
      console.log(`[OpenCode Server] Process exited with code ${code}, signal ${signal}`);
      if (openCodeProcess === child) {
        openCodeProcess = null;
      }
      if (
        !intentionallyStoppedProcesses.has(child) &&
        !relinquishedProcesses.has(child) &&
        hasServerBecomeReady &&
        onServerExitCallback
      ) {
        onServerExitCallback(code, signal);
      }
      if (startupDirectProcessOwnership) {
        clearOwnedOpenCodeProcessOwnership(startupDirectProcessOwnership);
      }
    });
    if (readOpenCodeOwnershipFilePath()) {
      if (!startupDirectProcessOwnership) {
        intentionallyStoppedProcesses.add(child);
        child.kill('SIGKILL');
        throw new Error('OpenCode server process identity could not be captured');
      }
      const directProcessOwnership = startupDirectProcessOwnership;
      try {
        saveOpenCodeServerProcessOwnership(directProcessOwnership);
      } catch (error) {
        intentionallyStoppedProcesses.add(child);
        await stopOpenCodeProcessOwnership(
          directProcessOwnership,
          () => checkIsProcessIdentityCurrent(directProcessOwnership),
        );
        throw error;
      }
    }
  }

  try {
    // Wait for server to become ready
    const healthUrl = `${process.env.OPENCODE_URL || defaultOpenCodeUrl}/global/health`;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          if (!checkIsStartupProcessRunning()) {
            throw startupError ?? new Error('OpenCode server failed during readiness');
          }
          const startupProcessOwnership = startupDirectProcessOwnership ?? startupHostedProcess;
          if (startupProcessOwnership) {
            const readyProcessOwnership: OpenCodeProcessOwnership = {
              ...startupProcessOwnership,
              state: 'ready',
            };
            saveOpenCodeServerProcessOwnership(readyProcessOwnership);
            if (!checkIsStartupProcessRunning()) {
              throw startupError ?? new Error('OpenCode server failed during readiness');
            }
            ownedOpenCodeProcess = readyProcessOwnership;
          }
          hasServerBecomeReady = true;
          console.log(`[OpenCode] Server ready`);
          return;
        }
      } catch {
        // not ready yet
      }
      if (!checkIsStartupProcessRunning()) {
        throw startupError ?? new Error('OpenCode server failed to start');
      }
    }

    throw new Error('OpenCode server did not become ready within 15 seconds');
  } catch (error) {
    const doesOwnFailedStartup = startupChild
      ? openCodeProcess === startupChild
      : ownedOpenCodeProcess === startupHostedProcess;
    const failedStartupOwnership = startupDirectProcessOwnership ?? startupHostedProcess;
    if (doesOwnFailedStartup && failedStartupOwnership) {
      await stopOpenCodeProcessOwnership(
        failedStartupOwnership,
        () => checkIsProcessIdentityCurrent(failedStartupOwnership),
      );
    }
    throw error;
  }
}

export function ensureOpenCodeServer(): Promise<void> {
  return runOpenCodeServerLifecycle(ensureOpenCodeServerUnlocked);
}

/**
 * @description Force the current OpenCode server generation to stop and start
 * again. Unlike {@link ensureOpenCodeServer}, this NEVER adopts a healthy
 * process: provider OAuth performed by `opencode auth login` writes auth.json
 * out-of-band, while a live server keeps the old credential in memory. The
 * caller owns restoring active sessions after this controlled restart.
 */
export function restartOpenCodeServer(): Promise<void> {
  return runOpenCodeServerLifecycle(async () => {
    const serverUrl = new URL(process.env.OPENCODE_URL || defaultOpenCodeUrl);
    await stopAdoptedOpenCodeServer(serverUrl);
    await ensureOpenCodeServerUnlocked();
  });
}

export function stopOpenCodeServer(): void {
  const child = openCodeProcess;
  const endpoint = new URL(process.env.OPENCODE_URL || defaultOpenCodeUrl).origin;
  const inMemoryOwnership = ownedOpenCodeProcess;
  const directlyOwnedProcess = child && inMemoryOwnership &&
    inMemoryOwnership.pid === child.pid &&
    inMemoryOwnership.endpoint === endpoint &&
    checkIsProcessIdentityCurrent(inMemoryOwnership)
    ? inMemoryOwnership
    : null;
  const processOwnership = directlyOwnedProcess ?? getOwnedOpenCodeProcessOwnership(endpoint);
  if (child) {
    intentionallyStoppedProcesses.add(child);
  }
  if (processOwnership) {
    console.log(`[OpenCode] Stopping server process ${processOwnership.pid}...`);
    if (
      directlyOwnedProcess ||
      checkIsOpenCodeProcessOwnershipCurrent(processOwnership)
    ) {
      signalProcessIdentity(
        processOwnership,
        'SIGTERM',
        processOwnership.signalProcessGroup,
      );
    }
    if (!checkIsProcessIdentityCurrent(processOwnership)) {
      clearOwnedOpenCodeProcessOwnership(processOwnership);
    }
  } else if (child && !child.killed) {
    child.kill('SIGTERM');
  }
}
