import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getErrnoCode } from './sttSettings';

/**
 * @description The install of the local speech engine: a private Python venv
 * under `<DATA_DIR>/stt` holding the pinned `onnx-asr` + `soundfile`, and the
 * GigaAM model fetched into a private Hugging Face cache — nothing is shared
 * with, or written into, the operator's Python. There is NO user-facing command:
 * the bot runs this from `/stt` ("Enable local recognition") or, when `stt.json`
 * names the local engine, at boot; both launch the detached `sttInstallEntry`.
 */

/** Must equal `SCRIPT_VERSION` in `stt/gigaam_sidecar.py` (a unit test holds them together). */
export const gigaamScriptVersion = '1';

/** The one place the pinned packages are named. */
export const gigaamPinnedRequirements: readonly string[] = ['onnx-asr[cpu,hub]==0.12.0', 'soundfile==0.14.0'];

/** The Python the packages need. */
const minimumPythonMajor = 3;
const minimumPythonMinor = 10;
const pythonRequest = `>=${minimumPythonMajor}.${minimumPythonMinor}`;

const mebibyte = 1024 * 1024;
/** The int8 e2e-rnnt files as fetched (216 MiB: the 215 MB encoder, decoder, joint, vocab), the progress denominator. */
export const gigaamModelApproxBytes = 216 * mebibyte;

const installLockStaleMs = 30 * 60 * 1000;
const downloadPollIntervalMs = 2_000;
const pythonProbeTimeoutMs = 10_000;
const logTailLineCount = 20;
const logTailLineMaxLength = 300;
const installStepTimeoutMs = 20 * 60 * 1000;
const rootDirName = 'stt';
const venvDirName = 'venv';
const hfDirName = 'hf';
const uvCacheDirName = 'uv-cache';
const markerFileName = 'installed.json';
const lockDirName = 'install.lock';
const lockOwnerFileName = 'owner';
const installLogFileName = 'install.log';
const progressFileName = 'install-progress.json';
const sidecarScriptName = 'gigaam_sidecar.py';

/** Where everything of the local engine lives under a data dir. */
export interface SttPaths {
  root: string;
  venvDir: string;
  venvPython: string;
  /** `HF_HOME` of the sidecar and of the install's model fetch. */
  hfHome: string;
  uvCacheDir: string;
  markerFile: string;
  lockDir: string;
  installLog: string;
  progressFile: string;
}

export function getSttPaths(dataDir: string): SttPaths {
  const root = path.join(dataDir, rootDirName);
  const venvDir = path.join(root, venvDirName);
  return {
    root,
    venvDir,
    venvPython: path.join(venvDir, 'bin', 'python'),
    hfHome: path.join(root, hfDirName),
    uvCacheDir: path.join(root, uvCacheDirName),
    markerFile: path.join(root, markerFileName),
    lockDir: path.join(root, lockDirName),
    installLog: path.join(root, installLogFileName),
    progressFile: path.join(root, progressFileName),
  };
}

/**
 * @description The sidecar script that ships in the package's `stt/` dir, two
 * levels above this module (`src/stt` under tsx, `dist/stt` once built).
 */
export function getSidecarScriptPath(): string {
  return path.join(fs.realpathSync(__dirname), '..', '..', 'stt', sidecarScriptName);
}

// ─────────────────────────── plan ───────────────────────────

/** What the host offers: `uv`, and/or a `python3` with the venv module. */
export interface SttInstallFacts {
  uvPath: string | null;
  python3: { path: string; major: number; minor: number; hasVenvSupport: boolean } | null;
  paths: SttPaths;
}

export interface SttInstallCommand {
  command: string;
  args: string[];
  /** Shown to the operator while it runs. */
  phase: 'creatingEnvironment' | 'installingPackages';
}

export type SttInstallPlan =
  | { ok: true; tool: 'uv' | 'pip'; commands: SttInstallCommand[] }
  | { ok: false; error: string };

export const missingPythonToolError =
  'Local recognition needs either uv (https://docs.astral.sh/uv/) or Python 3.10+ with the venv module ' +
  '(on Debian/Ubuntu: apt install python3-venv). Neither was found.';

/**
 * @description Decide how to build the venv: `uv` first (it needs no `ensurepip`
 * and can fetch a Python), else a `python3` >= 3.10 that can create a venv with
 * pip, else an error naming what is missing.
 */
export function planSttInstall(facts: SttInstallFacts): SttInstallPlan {
  const { venvDir, venvPython } = facts.paths;
  if (facts.uvPath) {
    return {
      ok: true,
      tool: 'uv',
      commands: [
        { command: facts.uvPath, args: ['venv', '--python', pythonRequest, venvDir], phase: 'creatingEnvironment' },
        {
          command: facts.uvPath,
          args: ['pip', 'install', '--python', venvPython, ...gigaamPinnedRequirements],
          phase: 'installingPackages',
        },
      ],
    };
  }
  const python3 = facts.python3;
  const isNewEnough =
    python3 !== null &&
    (python3.major > minimumPythonMajor || (python3.major === minimumPythonMajor && python3.minor >= minimumPythonMinor));
  if (python3 && isNewEnough && python3.hasVenvSupport) {
    return {
      ok: true,
      tool: 'pip',
      commands: [
        { command: python3.path, args: ['-m', 'venv', venvDir], phase: 'creatingEnvironment' },
        {
          command: venvPython,
          args: ['-m', 'pip', 'install', '--no-cache-dir', ...gigaamPinnedRequirements],
          phase: 'installingPackages',
        },
      ],
    };
  }
  return { ok: false, error: missingPythonToolError };
}

function findOnPath(binaryName: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = (env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, binaryName));
  candidates.push(path.join(os.homedir(), '.local', 'bin', binaryName));
  return candidates.find((candidate) => path.isAbsolute(candidate) && checkIsExecutableFile(candidate)) ?? null;
}

function checkIsExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** @description Look at the host: where `uv` and a usable `python3` are. */
export function detectSttInstallFacts(paths: SttPaths, env: NodeJS.ProcessEnv = process.env): SttInstallFacts {
  const uvPath = findOnPath('uv', env);
  const python3Path = findOnPath('python3', env);
  let python3: SttInstallFacts['python3'] = null;
  if (python3Path) {
    try {
      const probe = execFileSync(
        python3Path,
        ['-c', 'import sys, importlib.util; print(sys.version_info.major, sys.version_info.minor, importlib.util.find_spec("ensurepip") is not None and importlib.util.find_spec("venv") is not None)'],
        { encoding: 'utf8', timeout: pythonProbeTimeoutMs },
      ).trim().split(' ');
      python3 = { path: python3Path, major: Number(probe[0]), minor: Number(probe[1]), hasVenvSupport: probe[2] === 'True' };
    } catch {
      python3 = null;
    }
  }
  return { uvPath, python3, paths };
}

// ─────────────────────────── marker, lock ───────────────────────────

/** @name SttInstallMarker @description `installed.json`: what the venv was built from. */
export interface SttInstallMarker {
  scriptVersion: string;
  pins: string[];
  installedAt: string;
}

function readMarker(paths: SttPaths): SttInstallMarker | null {
  try {
    const parsed: Partial<SttInstallMarker> = JSON.parse(fs.readFileSync(paths.markerFile, 'utf8'));
    if (typeof parsed.scriptVersion !== 'string' || !Array.isArray(parsed.pins) || typeof parsed.installedAt !== 'string') return null;
    return { scriptVersion: parsed.scriptVersion, pins: parsed.pins, installedAt: parsed.installedAt };
  } catch {
    return null;
  }
}

/**
 * @description Whether the local engine is ready to start: the marker names the
 * script version and pins this build ships, and the venv's interpreter is still
 * there. Cheap and synchronous — it runs for every voice note.
 */
export function isGigaamInstalled(dataDir: string): boolean {
  const paths = getSttPaths(dataDir);
  const marker = readMarker(paths);
  if (!marker || marker.scriptVersion !== gigaamScriptVersion) return false;
  if (marker.pins.join(' ') !== gigaamPinnedRequirements.join(' ')) return false;
  return checkIsExecutableFile(paths.venvPython);
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && getErrnoCode(error) === 'EPERM';
  }
}

/** The install lock is held by a live process that started less than {@link installLockStaleMs} ago. */
function checkIsLockHeld(paths: SttPaths, nowMs: number): boolean {
  try {
    const lockAgeMs = nowMs - fs.statSync(paths.lockDir).mtimeMs;
    if (lockAgeMs > installLockStaleMs) return false;
    const ownerPid = Number(fs.readFileSync(path.join(paths.lockDir, lockOwnerFileName), 'utf8').trim());
    return Number.isInteger(ownerPid) && ownerPid > 0 ? checkIsProcessAlive(ownerPid) : true;
  } catch (error) {
    // No owner file yet (between the mkdir and the write) still counts as a fresh, held lock.
    return error instanceof Error && getErrnoCode(error) === 'ENOENT' && fs.existsSync(paths.lockDir);
  }
}

/** @description An install job is running right now (its lock is held by a live process, not stale). */
export function isGigaamInstalling(dataDir: string, nowMs: number = Date.now()): boolean {
  return checkIsLockHeld(getSttPaths(dataDir), nowMs);
}

/** Take the lock; a stale or dead-owner one is replaced. False when a live install holds it. */
function acquireInstallLock(paths: SttPaths, nowMs: number): boolean {
  fs.mkdirSync(paths.root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(paths.lockDir);
      fs.writeFileSync(path.join(paths.lockDir, lockOwnerFileName), `${process.pid}\n`);
      return true;
    } catch (error) {
      if (!(error instanceof Error && getErrnoCode(error) === 'EEXIST')) throw error;
      if (checkIsLockHeld(paths, nowMs)) return false;
      fs.rmSync(paths.lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseInstallLock(paths: SttPaths): void {
  fs.rmSync(paths.lockDir, { recursive: true, force: true });
}

// ─────────────────────────── progress ───────────────────────────

export type SttInstallPhase =
  | 'creatingEnvironment'
  | 'installingPackages'
  | 'downloadingModel'
  | 'checking'
  | 'done'
  | 'failed';

/** @name SttInstallProgress @description One progress report; `failed` carries the error and the log tail. */
export interface SttInstallProgress {
  phase: SttInstallPhase;
  detail: string;
  /** Bytes of the model cache so far (during `downloadingModel` / `checking`). */
  bytesDownloaded: number;
  error?: string;
  logTail?: string[];
}

/**
 * @description The last complete progress report in the text of the progress
 * file (one JSON object per line); a torn last line from a crash is skipped.
 */
export function getLastSttInstallProgress(text: string): SttInstallProgress | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed: Partial<SttInstallProgress> = JSON.parse(line);
      if (typeof parsed.phase === 'string' && typeof parsed.bytesDownloaded === 'number') {
        return { phase: parsed.phase, detail: parsed.detail ?? '', bytesDownloaded: parsed.bytesDownloaded, error: parsed.error, logTail: parsed.logTail };
      }
    } catch {
      // a half-written line: try the one before
    }
  }
  return null;
}

export function readSttInstallProgress(dataDir: string): SttInstallProgress | null {
  try {
    return getLastSttInstallProgress(fs.readFileSync(getSttPaths(dataDir).progressFile, 'utf8'));
  } catch {
    return null;
  }
}

/** @description "120/217 MB" — the download line of the progress report. */
export function formatDownloadDetail(bytesDownloaded: number): string {
  const doneMegabytes = Math.min(Math.floor(bytesDownloaded / mebibyte), Math.round(gigaamModelApproxBytes / mebibyte));
  return `${doneMegabytes}/${Math.round(gigaamModelApproxBytes / mebibyte)} MB`;
}

function getDirectorySizeBytes(directory: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    try {
      total += entry.isDirectory() ? getDirectorySizeBytes(entryPath) : fs.lstatSync(entryPath).size;
    } catch {
      // vanished between readdir and stat: a temp file renamed into place
    }
  }
  return total;
}

// ─────────────────────────── run ───────────────────────────

export interface SttCommandResult {
  exitCode: number | null;
  /** Everything the command printed to stdout. */
  stdout: string;
}

/** Runs one install command with its output appended to the log; replaceable in tests. */
export type SttCommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; logFile: string; timeoutMs: number },
) => Promise<SttCommandResult>;

export const runSttCommand: SttCommandRunner = (command, args, { env, logFile, timeoutMs }) =>
  new Promise((resolve) => {
    const logFd = fs.openSync(logFile, 'a');
    fs.writeSync(logFd, `\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', logFd] });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      fs.writeSync(logFd, chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let isFinished = false;
    const finish = (exitCode: number | null): void => {
      if (isFinished) return; // 'error' and 'close' can both fire for one failed spawn
      isFinished = true;
      clearTimeout(timer);
      fs.closeSync(logFd);
      resolve({ exitCode, stdout });
    };
    child.once('error', (error) => {
      fs.writeSync(logFd, `spawn failed: ${error.message}\n`);
      finish(null);
    });
    child.once('close', finish);
  });

export interface SttInstallOptions {
  onProgress?: (progress: SttInstallProgress) => void;
  /** Rebuild the venv even when the marker says it is current. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Seams for tests. */
  runCommand?: SttCommandRunner;
  detectFacts?: (paths: SttPaths, env: NodeJS.ProcessEnv) => SttInstallFacts;
  downloadPollIntervalMs?: number;
  nowMs?: () => number;
}

export type SttInstallResult =
  | { ok: true; wasAlreadyInstalled: boolean }
  | { ok: false; reason: 'locked' | 'failed'; error: string; logTail: string[] };

function appendProgressLine(paths: SttPaths, progress: SttInstallProgress): void {
  try {
    fs.appendFileSync(paths.progressFile, `${JSON.stringify(progress)}\n`);
  } catch {
    // The file only feeds a status message; a full disk must not fail the install itself.
  }
}

function readLogTail(logFile: string): string[] {
  try {
    // Progress bars redraw one line with carriage returns: split on those too, and cap what one line can carry.
    return fs
      .readFileSync(logFile, 'utf8')
      .split(/[\r\n]+/)
      .filter((line) => line.trim())
      .map((line) => line.slice(0, logTailLineMaxLength))
      .slice(-logTailLineCount);
  } catch {
    return [];
  }
}

/**
 * @description Build the venv, install the pinned packages and fetch the model
 * (`--check` loads it and recognises a second of silence, so a broken download
 * is caught here, not by the first voice). Idempotent: a current marker means
 * nothing to do unless `force`. One install at a time per data dir (a lock
 * directory; a stale one or a dead owner's is replaced). Child output goes to
 * `install.log`; a failure returns its last lines.
 */
export async function runSttInstall(dataDir: string, options: SttInstallOptions = {}): Promise<SttInstallResult> {
  const paths = getSttPaths(dataDir);
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now;
  const runCommand = options.runCommand ?? runSttCommand;
  const report = (progress: SttInstallProgress): void => {
    appendProgressLine(paths, progress);
    options.onProgress?.(progress);
  };

  if (!acquireInstallLock(paths, nowMs())) {
    return { ok: false, reason: 'locked', error: 'another install is already running', logTail: [] };
  }
  // This run's progress starts from an empty file, so a reader never mistakes an earlier run's `done` for it.
  fs.writeFileSync(paths.progressFile, '');
  const fail = (error: string): SttInstallResult => {
    const logTail = readLogTail(paths.installLog);
    report({ phase: 'failed', detail: '', bytesDownloaded: 0, error, logTail });
    return { ok: false, reason: 'failed', error, logTail };
  };
  try {
    if (!options.force && isGigaamInstalled(dataDir)) {
      report({ phase: 'done', detail: '', bytesDownloaded: getDirectorySizeBytes(paths.hfHome) });
      return { ok: true, wasAlreadyInstalled: true };
    }
    fs.mkdirSync(paths.hfHome, { recursive: true });
    fs.rmSync(paths.installLog, { force: true });
    fs.rmSync(paths.markerFile, { force: true });
    fs.rmSync(paths.venvDir, { recursive: true, force: true });

    const plan = planSttInstall((options.detectFacts ?? detectSttInstallFacts)(paths, env));
    if (!plan.ok) return fail(plan.error);

    // The model has to come from the network here (the running sidecar is offline), whatever the parent env says.
    const { HF_HUB_OFFLINE: _hubOffline, ...inheritedEnv } = env;
    const installEnv: NodeJS.ProcessEnv = {
      ...inheritedEnv,
      HF_HOME: paths.hfHome,
      UV_CACHE_DIR: paths.uvCacheDir,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
    for (const step of plan.commands) {
      report({ phase: step.phase, detail: '', bytesDownloaded: 0 });
      const result = await runCommand(step.command, step.args, { env: installEnv, logFile: paths.installLog, timeoutMs: installStepTimeoutMs });
      if (result.exitCode !== 0) return fail(`${path.basename(step.command)} ${step.args[0]} failed (exit ${result.exitCode ?? 'none'})`);
    }

    const pollMs = options.downloadPollIntervalMs ?? downloadPollIntervalMs;
    const reportDownload = (): void => {
      const bytesDownloaded = getDirectorySizeBytes(paths.hfHome);
      const isDownloaded = bytesDownloaded >= gigaamModelApproxBytes;
      report({
        phase: isDownloaded ? 'checking' : 'downloadingModel',
        detail: isDownloaded ? '' : formatDownloadDetail(bytesDownloaded),
        bytesDownloaded,
      });
    };
    reportDownload();
    const poller = setInterval(reportDownload, pollMs);
    let check: SttCommandResult;
    try {
      check = await runCommand(paths.venvPython, ['-I', getSidecarScriptPath(), '--check'], {
        env: installEnv,
        logFile: paths.installLog,
        timeoutMs: installStepTimeoutMs,
      });
    } finally {
      clearInterval(poller);
    }
    const checkReport = getLastJsonLine(check.stdout);
    if (check.exitCode !== 0 || checkReport?.ok !== true) {
      return fail(`the model check failed${checkReport?.error ? `: ${checkReport.error}` : ` (exit ${check.exitCode ?? 'none'})`}`);
    }

    const marker: SttInstallMarker = {
      scriptVersion: gigaamScriptVersion,
      pins: [...gigaamPinnedRequirements],
      installedAt: new Date(nowMs()).toISOString(),
    };
    fs.writeFileSync(paths.markerFile, `${JSON.stringify(marker, null, 2)}\n`);
    report({ phase: 'done', detail: '', bytesDownloaded: getDirectorySizeBytes(paths.hfHome) });
    return { ok: true, wasAlreadyInstalled: false };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'the install crashed');
  } finally {
    releaseInstallLock(paths);
  }
}

interface SttCheckReport {
  ok?: boolean;
  error?: string;
}

function getLastJsonLine(stdout: string): SttCheckReport | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) return null;
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

/**
 * @description Delete the local engine's files (venv, model cache, uv cache,
 * marker, install log). Refuses while an install runs. The caller stops the
 * sidecar first.
 */
export function removeSttInstall(dataDir: string): boolean {
  const paths = getSttPaths(dataDir);
  if (checkIsLockHeld(paths, Date.now())) return false;
  for (const target of [paths.venvDir, paths.hfHome, paths.uvCacheDir, paths.markerFile, paths.installLog, paths.progressFile, paths.lockDir]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  return true;
}
