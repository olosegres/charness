import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
  checkIsOpenCodeExternalHost,
  checkIsProcessIdentityCurrent,
  getOpenCodeChildEnv,
  getProcessIdentity,
  signalExternallyHostedProcess,
  startExternallyParentedProcess,
  type ExternalProcessIdentity,
} from '../installManager';
import { getSidecarScriptPath, getSttPaths, gigaamScriptVersion, type SttPaths } from './sttInstall';
import { formatSttClockTime } from './sttScreenPlan';
import {
  defaultGigaamThreads,
  type SttConfigFile,
  type SttGigaamSettings,
} from './sttSettings';
import type { TranscriptionEndpoint } from '../utils/transcribeAudio';

/**
 * @description The lifecycle of the local engine's process (`stt/gigaam_sidecar.py`), owned by the bot and
 * started ON DEMAND: a voice whose chain reaches the local engine calls {@link SttSidecarOwner.ensure}, which
 * adopts the recorded live process or spawns a new one and waits until it is ready. Nothing starts at boot.
 *
 * - **Hosted outside the bot's process tree** (`startExternallyParentedProcess`, the OpenCode generations'
 *   host), so a hot reload never kills it and the next worker adopts it from the record.
 * - **Dies with its owner**: the sidecar polls its owner (`--owner-pid` + start token), so even a SIGKILLed bot
 *   or supervisor leaves none behind within ~2 s. The owner is the `charness hot` supervisor in hot mode (it
 *   exports {@link sttOwnerPidEnvName} + {@link sttOwnerStartTokenEnvName} before it starts nodemon) or the bot
 *   process itself in plain mode. Without a context the engine is unavailable.
 * - **No watchdog, no restart backoff.** A crash, a refusal or a timeout makes the CURRENT voice fall back to
 *   the next engine; the NEXT voice's ensure finds the dead process and spawns a new one. Only a spawn-storm
 *   guard exists: three spawn failures within ten minutes mark the engine unhealthy for five.
 * - Every signal is guarded by the recorded process start token.
 */

/** Exported by the hot supervisor to its worker: the supervisor's pid and `/proc` start token. */
export const sttOwnerPidEnvName = 'CHARNESS_STT_OWNER_PID';
export const sttOwnerStartTokenEnvName = 'CHARNESS_STT_OWNER_START_TOKEN';
/** The env variable the sidecar reads its bearer token from (never an argument: `ps` shows arguments). */
export const sttSidecarTokenEnvName = 'CHARNESS_STT_SIDECAR_TOKEN';

const recordFileName = 'sidecar.json';
const logFileName = 'sidecar.log';
const readyFilePrefix = 'ready-';
const readyFileSuffix = '.json';
const readyTimeoutMs = 15_000;
const readyPollMs = 100;
const adoptHealthTimeoutMs = 1_000;
const statusHealthTimeoutMs = 1_000;
const stopBudgetMs = 3_000;
const killGraceMs = 500;
const exitPollMs = 50;
const spawnFailureLimit = 3;
const spawnFailureWindowMs = 10 * 60 * 1000;
const unhealthyDurationMs = 5 * 60 * 1000;
const tokenBytes = 32;
const readyFileRandomBytes = 6;
const recordFileMode = 0o600;
const gigaamModelName = 'gigaam';
const transcriptionsPath = '/v1/audio/transcriptions';
const loopbackHost = '127.0.0.1';
const configHashLength = 16;

/** @name SttOwnerContext @description The long-lived process the sidecar dies with. */
export interface SttOwnerContext {
  pid: number;
  startToken: string;
}

/**
 * @description The owner context of THIS bot process. A hot worker takes its supervisor's from the env the
 * supervisor exported (none, or malformed → `null`: an older supervisor that cannot own a sidecar); a plain bot
 * is its own owner.
 */
export function resolveSttOwnerContext(
  env: NodeJS.ProcessEnv = process.env,
  ownPid: number = process.pid,
  readStartToken: (pid: number) => string | null = (pid) => getProcessIdentity(pid)?.startToken ?? null,
): SttOwnerContext | null {
  if (checkIsOpenCodeExternalHost(env)) {
    const pid = Number(env[sttOwnerPidEnvName]);
    const startToken = env[sttOwnerStartTokenEnvName];
    return Number.isInteger(pid) && pid > 0 && startToken ? { pid, startToken } : null;
  }
  const startToken = readStartToken(ownPid);
  return startToken ? { pid: ownPid, startToken } : null;
}

/** @name SttSidecarEndpoint @description Where a running sidecar listens and the token it wants. */
export interface SttSidecarEndpoint {
  port: number;
  token: string;
}

/** What `GET /health` of the sidecar answers (the fields the bot reads). */
export interface SttSidecarHealth {
  status: string;
  busyRequests: number;
}

/** @name SttSidecarStatus @description What `/stt` shows about the local engine's process. */
export type SttSidecarStatus =
  | { state: 'notRunning' }
  | { state: 'running'; busyRequests: number }
  | { state: 'unhealthy'; unhealthyUntil: number };

/** @name SttSidecarRecord @description `<DATA_DIR>/stt/sidecar.json`: the live process the bot may adopt. */
interface SttSidecarRecord extends ExternalProcessIdentity {
  port: number;
  token: string;
  configHash: string;
  ownerPid: number;
  ownerStartToken: string;
  startedAt: string;
}

/** The ready file the sidecar writes once it listens. */
interface SttReadyFile {
  pid: number;
  port: number;
}

export interface SttSidecarOwnerDeps {
  getDataDir: () => string;
  getOwnerContext: () => SttOwnerContext | null;
  /** What to run: the venv interpreter with the script, or (tests) any program that follows the same contract. */
  getLaunch: (paths: SttPaths) => { command: string; args: string[] };
  getBaseEnv: () => NodeJS.ProcessEnv;
  startProcess: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ExternalProcessIdentity>;
  checkIsIdentityCurrent: (identity: ExternalProcessIdentity) => boolean;
  signalProcess: (identity: ExternalProcessIdentity, signal: NodeJS.Signals) => boolean;
  fetchHealth: (port: number, token: string, timeoutMs: number) => Promise<SttSidecarHealth | null>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long a spawn may take to become ready; tests shorten it. */
  readyTimeoutMs: number;
  log: (line: string) => void;
}

/** @description The production dependencies over the real process host. */
export function createDefaultSttSidecarOwnerDeps(getDataDir: () => string): SttSidecarOwnerDeps {
  return {
    getDataDir,
    getOwnerContext: () => resolveSttOwnerContext(),
    getLaunch: (paths) => ({ command: paths.venvPython, args: ['-I', getSidecarScriptPath()] }),
    getBaseEnv: () => getOpenCodeChildEnv(),
    startProcess: (command, args, env) => startExternallyParentedProcess(command, args, env),
    checkIsIdentityCurrent: checkIsProcessIdentityCurrent,
    signalProcess: signalExternallyHostedProcess,
    fetchHealth: fetchSttSidecarHealth,
    nowMs: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readyTimeoutMs,
    log: (line) => console.log(line),
  };
}

/** @description `GET /health` with the token; `null` for anything but a clean 200 `ok` within the timeout. */
export function fetchSttSidecarHealth(port: number, token: string, timeoutMs: number): Promise<SttSidecarHealth | null> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: loopbackHost, port, path: '/health', headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('error', () => resolve(null));
        response.on('end', () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            const health: Partial<SttSidecarHealth> = JSON.parse(body);
            resolve(health.status === 'ok' ? { status: health.status, busyRequests: health.busyRequests ?? 0 } : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/** @description The sidecar's endpoint as the chain's HTTP client wants it. */
export function getSttSidecarTranscriptionEndpoint(endpoint: SttSidecarEndpoint): TranscriptionEndpoint {
  return {
    url: `http://${loopbackHost}:${endpoint.port}${transcriptionsPath}`,
    apiKey: endpoint.token,
    model: gigaamModelName,
  };
}

/** @description The identity of a process plus the config it was started with — what adoption compares. */
export function getSttSidecarConfigHash(settings: SttGigaamSettings): string {
  const canonical = JSON.stringify({
    idleMinutes: settings.idleMinutes,
    workers: settings.workers,
    threads: settings.threads ?? defaultGigaamThreads,
    scriptVersion: gigaamScriptVersion,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, configHashLength);
}

function hasEnabledLocalEngine(config: SttConfigFile): boolean {
  return config.engines.some((engine) => engine.kind === 'gigaam' && !engine.isDisabled);
}

/**
 * @description Does moving from `previous` to `next` invalidate a running sidecar? The local engine was
 * disabled or removed, or a knob the process was started with changed (the config hash would catch these at
 * the next ensure; stopping now returns the memory at once).
 */
export function checkIsSidecarRestartNeeded(previous: SttConfigFile, next: SttConfigFile): boolean {
  if (hasEnabledLocalEngine(previous) && !hasEnabledLocalEngine(next)) return true;
  return getSttSidecarConfigHash(previous.gigaam) !== getSttSidecarConfigHash(next.gigaam);
}

function isSttSidecarRecord(value: Partial<SttSidecarRecord>): value is SttSidecarRecord {
  return (
    Number.isInteger(value.pid) &&
    typeof value.startToken === 'string' &&
    Number.isInteger(value.port) &&
    typeof value.token === 'string' &&
    typeof value.configHash === 'string' &&
    Number.isInteger(value.ownerPid) &&
    typeof value.ownerStartToken === 'string' &&
    typeof value.startedAt === 'string'
  );
}

export interface SttSidecarOwner {
  /** Adopt the recorded live process or start one; resolves when it is ready. Concurrent calls share ONE attempt. */
  ensure: (settings: SttGigaamSettings) => Promise<SttSidecarEndpoint>;
  /** Stop the recorded process (guarded, bounded at ~3 s) and drop the record. Idempotent. */
  stop: () => Promise<void>;
  getStatus: () => Promise<SttSidecarStatus>;
  /** The spawn-storm guard has marked the engine unhealthy (sync: it feeds the per-voice chain resolve). */
  checkIsUnhealthy: () => boolean;
  resetSpawnGuard: () => void;
  /** After a settings save: stop a running process the change invalidates. Never spawns. */
  applySettingsChange: (previous: SttConfigFile, next: SttConfigFile) => Promise<void>;
  /** At boot: drop a dead process's record, stop one whose owner is not the current one, leave a matching live one. */
  cleanupAtBoot: () => Promise<void>;
}

/** @description The local engine's lifecycle over its injected dependencies. */
export function createSttSidecarOwner(deps: SttSidecarOwnerDeps): SttSidecarOwner {
  let inFlightEnsure: Promise<SttSidecarEndpoint> | null = null;
  let spawnFailureTimes: number[] = [];
  let unhealthyUntilMs = 0;

  const getPaths = (): SttPaths => getSttPaths(deps.getDataDir());
  const getRecordPath = (): string => path.join(getPaths().root, recordFileName);

  function readRecord(): SttSidecarRecord | null {
    try {
      const parsed: Partial<SttSidecarRecord> = JSON.parse(fs.readFileSync(getRecordPath(), 'utf8'));
      return isSttSidecarRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeRecord(record: SttSidecarRecord): void {
    const recordPath = getRecordPath();
    const temporaryPath = `${recordPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(record), { mode: recordFileMode });
    fs.renameSync(temporaryPath, recordPath);
  }

  function removeRecord(): void {
    fs.rmSync(getRecordPath(), { force: true });
  }

  async function waitUntilGone(identity: ExternalProcessIdentity, budgetMs: number): Promise<boolean> {
    const deadlineMs = deps.nowMs() + budgetMs;
    while (deps.checkIsIdentityCurrent(identity)) {
      if (deps.nowMs() >= deadlineMs) return false;
      await deps.sleep(exitPollMs);
    }
    return true;
  }

  /** SIGTERM, wait up to `graceMs`, then SIGKILL — both guarded by the start token. */
  async function terminate(identity: ExternalProcessIdentity, graceMs: number): Promise<void> {
    if (!deps.checkIsIdentityCurrent(identity)) return;
    deps.signalProcess(identity, 'SIGTERM');
    if (await waitUntilGone(identity, graceMs)) return;
    deps.signalProcess(identity, 'SIGKILL');
    await waitUntilGone(identity, killGraceMs);
  }

  function noteSpawnFailure(): void {
    const nowMs = deps.nowMs();
    spawnFailureTimes = [...spawnFailureTimes.filter((failedAt) => nowMs - failedAt < spawnFailureWindowMs), nowMs];
    if (spawnFailureTimes.length < spawnFailureLimit) return;
    unhealthyUntilMs = nowMs + unhealthyDurationMs;
    spawnFailureTimes = [];
    deps.log(`[STT] gigaam marked unhealthy until ${formatSttClockTime(unhealthyUntilMs)} after ${spawnFailureLimit} failed starts`);
  }

  function readReadyFile(readyFile: string): SttReadyFile | null {
    try {
      const { pid, port }: Partial<SttReadyFile> = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      return typeof pid === 'number' && Number.isInteger(pid) && typeof port === 'number' && Number.isInteger(port) ? { pid, port } : null;
    } catch {
      return null;
    }
  }

  async function adoptRecorded(settings: SttGigaamSettings, owner: SttOwnerContext): Promise<SttSidecarEndpoint | null> {
    const record = readRecord();
    if (!record) {
      removeRecord();
      return null;
    }
    const isAlive = deps.checkIsIdentityCurrent(record);
    const isSameOwner = record.ownerPid === owner.pid && record.ownerStartToken === owner.startToken;
    if (isAlive && isSameOwner && record.configHash === getSttSidecarConfigHash(settings)) {
      if (await deps.fetchHealth(record.port, record.token, adoptHealthTimeoutMs)) {
        return { port: record.port, token: record.token };
      }
    }
    // Live but not adoptable (another owner, another config, not answering) or dead: it must go before a new one starts.
    if (isAlive) await terminate(record, stopBudgetMs);
    removeRecord();
    return null;
  }

  async function spawnSidecar(settings: SttGigaamSettings, owner: SttOwnerContext): Promise<SttSidecarEndpoint> {
    if (deps.nowMs() < unhealthyUntilMs) {
      throw new Error(`gigaam is unhealthy until ${formatSttClockTime(unhealthyUntilMs)}`);
    }
    const paths = getPaths();
    fs.mkdirSync(paths.root, { recursive: true });
    const token = crypto.randomBytes(tokenBytes).toString('hex');
    const readyFile = path.join(paths.root, `${readyFilePrefix}${crypto.randomBytes(readyFileRandomBytes).toString('hex')}${readyFileSuffix}`);
    const launch = deps.getLaunch(paths);
    const args = [
      ...launch.args,
      '--ready-file', readyFile,
      '--record-file', getRecordPath(),
      '--log-file', path.join(paths.root, logFileName),
      '--idle-minutes', settings.idleMinutes.toString(),
      '--workers', settings.workers.toString(),
      '--threads', (settings.threads ?? defaultGigaamThreads).toString(),
      '--owner-pid', owner.pid.toString(),
      '--owner-start-token', owner.startToken,
    ];
    // The token and the offline cache reach the process through its env, never its arguments.
    const env: NodeJS.ProcessEnv = {
      ...deps.getBaseEnv(),
      [sttSidecarTokenEnvName]: token,
      HF_HOME: paths.hfHome,
      HF_HUB_OFFLINE: '1',
    };

    const startedAtMs = deps.nowMs();
    let identity: ExternalProcessIdentity;
    try {
      identity = await deps.startProcess(launch.command, args, env);
    } catch (error) {
      noteSpawnFailure();
      throw new Error(`the local engine could not be started: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    const fail = async (reason: string): Promise<never> => {
      await terminate(identity, 0);
      fs.rmSync(readyFile, { force: true });
      noteSpawnFailure();
      throw new Error(reason);
    };
    for (;;) {
      const ready = readReadyFile(readyFile);
      if (ready && ready.pid === identity.pid) {
        try {
          writeRecord({
            ...identity,
            port: ready.port,
            token,
            configHash: getSttSidecarConfigHash(settings),
            ownerPid: owner.pid,
            ownerStartToken: owner.startToken,
            startedAt: new Date(deps.nowMs()).toISOString(),
          });
        } catch (error) {
          // A process nobody can find again would idle until its owner dies: stop it now.
          return fail(`the local engine started but its record could not be written (${error instanceof Error ? error.message : 'unknown error'})`);
        }
        fs.rmSync(readyFile, { force: true });
        deps.log(`[STT] sidecar started pid ${identity.pid} port ${ready.port} in ${deps.nowMs() - startedAtMs}ms (workers ${settings.workers})`);
        spawnFailureTimes = [];
        return { port: ready.port, token };
      }
      if (!deps.checkIsIdentityCurrent(identity)) {
        return fail('the local engine exited before it was ready (see sidecar.log)');
      }
      if (deps.nowMs() - startedAtMs >= deps.readyTimeoutMs) {
        return fail(`the local engine was not ready in ${Math.round(deps.readyTimeoutMs / 1000)} s`);
      }
      await deps.sleep(readyPollMs);
    }
  }

  async function ensureOnce(settings: SttGigaamSettings): Promise<SttSidecarEndpoint> {
    const owner = deps.getOwnerContext();
    if (!owner) throw new Error('the local engine has no owner process to start it with (restart the bot supervisor)');
    return (await adoptRecorded(settings, owner)) ?? (await spawnSidecar(settings, owner));
  }

  async function stop(): Promise<void> {
    const record = readRecord();
    if (record) await terminate(record, stopBudgetMs - killGraceMs);
    removeRecord();
  }

  return {
    ensure: (settings) => {
      if (!inFlightEnsure) {
        inFlightEnsure = ensureOnce(settings).finally(() => { inFlightEnsure = null; });
      }
      return inFlightEnsure;
    },
    stop,
    async getStatus() {
      if (deps.nowMs() < unhealthyUntilMs) return { state: 'unhealthy', unhealthyUntil: unhealthyUntilMs };
      const record = readRecord();
      if (!record || !deps.checkIsIdentityCurrent(record)) return { state: 'notRunning' };
      const health = await deps.fetchHealth(record.port, record.token, statusHealthTimeoutMs);
      return health ? { state: 'running', busyRequests: health.busyRequests } : { state: 'notRunning' };
    },
    checkIsUnhealthy: () => deps.nowMs() < unhealthyUntilMs,
    resetSpawnGuard: () => {
      spawnFailureTimes = [];
      unhealthyUntilMs = 0;
    },
    async applySettingsChange(previous, next) {
      if (checkIsSidecarRestartNeeded(previous, next)) await stop();
    },
    async cleanupAtBoot() {
      const paths = getPaths();
      try {
        for (const name of fs.readdirSync(paths.root)) {
          if (name.startsWith(readyFilePrefix) && name.endsWith(readyFileSuffix)) fs.rmSync(path.join(paths.root, name), { force: true });
        }
      } catch {
        return; // no stt dir: nothing was ever started
      }
      const record = readRecord();
      if (!record) {
        removeRecord(); // an unreadable record is as good as none
        return;
      }
      if (!deps.checkIsIdentityCurrent(record)) {
        removeRecord();
        deps.log(`[STT] removed the record of a sidecar that is gone (pid ${record.pid})`);
        return;
      }
      const owner = deps.getOwnerContext();
      if (owner && record.ownerPid === owner.pid && record.ownerStartToken === owner.startToken) {
        deps.log(`[STT] sidecar pid ${record.pid} is still running; it will be adopted by the next voice`);
        return;
      }
      await terminate(record, stopBudgetMs - killGraceMs);
      removeRecord();
      deps.log(`[STT] stopped sidecar pid ${record.pid}: it belonged to another owner`);
    },
  };
}

/**
 * @description Stop whatever sidecar the record names — for the hot supervisor's own shutdown, which holds no
 * owner object. Guarded and bounded at ~3 s like {@link SttSidecarOwner.stop}.
 */
export function stopRecordedSttSidecar(deps: SttSidecarOwnerDeps): Promise<void> {
  return createSttSidecarOwner(deps).stop();
}
