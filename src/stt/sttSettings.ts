import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { resolveGlobalConfigEnvPath, warnLegacyNameOnce } from '../legacyNames';
import {
  createCustomEndpoint,
  createGroqEndpoint,
  createOpenAiEndpoint,
  type TranscriptionEndpoint,
} from '../utils/transcribeAudio';

/**
 * @description The voice-recognition settings: ONE JSON file, `stt.json`, next to
 * the instance's `.env`, holding the engine chain, the language, the local
 * engine's knobs AND the API keys. `/stt` writes it; an operator may hand-edit
 * it, and the next voice note sees the edit (the load is cached by file stamp).
 *
 * Validation is strict and all-or-nothing, like `jira.json`: a typo is an error
 * that NAMES the field and never echoes a value (a key may sit next to it), and
 * an invalid edit keeps the last good settings instead of silently dropping an
 * engine.
 */

/** The file in the config dir. */
export const sttConfigFileName = 'stt.json';

export const sttEngineKinds = ['gigaam', 'groq', 'openai', 'url'] as const;
export type SttEngineKind = (typeof sttEngineKinds)[number];

/** The most engines one chain holds. */
export const sttEngineLimit = 6;
/** The worker counts `/stt` offers; a hand-edited value is clamped to the nearest one. */
export const sttGigaamWorkerChoices: readonly number[] = [1, 2, 4, 8];

/** The shape of an engine's request budget: `baseSeconds + percentOfDuration % of the voice`. */
export interface SttTimeout {
  baseSeconds: number;
  percentOfDuration: number;
}

export const defaultSttTimeout: SttTimeout = { baseSeconds: 10, percentOfDuration: 25 };
export const defaultGigaamIdleMinutes = 15;
export const defaultGigaamWorkers = 4;
/** Intra-op threads per worker; `workers × threads` should not exceed the CPU count. */
export const defaultGigaamThreads = 2;

/** Voice length assumed for the timeout when Telegram did not report one. */
const unknownVoiceDurationSeconds = 60;
/** The only language the local engine knows. */
export const gigaamLanguage = 'ru';
const percentDivisor = 100;
const millisecondsPerSecond = 1000;

const engineIdRe = /^[a-z0-9]{1,8}$/;
const languageRe = /^[a-z]{2}$/;
const maxTimeoutBaseSeconds = 600;
const maxTimeoutPercent = 400;
const maxIdleMinutes = 24 * 60; // a day: longer is "never" (0)
const maxWorkers = 64;
const maxThreads = 32;
const invalidJsonErrorPrefix = 'stt.json is not valid JSON';
/** The file holds API keys: owner-only. */
const configFileMode = 0o600;
const unknownErrorCode = 'unknown';

/** @name SttEngineSetting @description One entry of the chain, as stored in `stt.json`. */
export interface SttEngineSetting {
  /** Stable short id (`g`, `q1`, `u2`): `/stt` callback data carries it, so lowercase letters and digits only. */
  id: string;
  kind: SttEngineKind;
  isDisabled?: boolean;
  /** Absent → {@link defaultSttTimeout}. */
  timeout?: SttTimeout;
  /** `url` kind: the FULL transcription endpoint URL. */
  url?: string;
  /** `url` kind: the model name sent along (default `whisper-1`). */
  model?: string;
  /** `groq` / `openai` / `url`: never logged or echoed. */
  apiKey?: string;
}

/** @name SttGigaamSettings @description The local engine's process knobs. */
export interface SttGigaamSettings {
  /** The process exits after this many idle minutes; `0` = never. */
  idleMinutes: number;
  /** Chunks recognised in parallel; one of {@link sttGigaamWorkerChoices}. */
  workers: number;
  /** Intra-op threads per worker; a hand-edit-only knob, absent → {@link defaultGigaamThreads}. */
  threads?: number;
}

/** @name SttConfigFile @description The whole of `stt.json`. */
export interface SttConfigFile {
  /** Ordered: the first available engine is tried first. */
  engines: SttEngineSetting[];
  /** ISO-639-1 (`ru`), or `null` = the engine detects the language. */
  language: string | null;
  gigaam: SttGigaamSettings;
}

const timeoutSchema = z.strictObject({
  baseSeconds: z.number().min(1).max(maxTimeoutBaseSeconds),
  percentOfDuration: z.number().min(0).max(maxTimeoutPercent),
});

const engineSchema = z.strictObject({
  id: z.string().regex(engineIdRe, 'must be 1-8 lowercase letters or digits'),
  kind: z.enum(sttEngineKinds),
  isDisabled: z.boolean().optional(),
  timeout: timeoutSchema.optional(),
  url: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

const gigaamSchema = z.strictObject({
  idleMinutes: z.number().int().min(0).max(maxIdleMinutes).optional(),
  workers: z.number().int().min(1).max(maxWorkers).optional(),
  threads: z.number().int().min(1).max(maxThreads).optional(),
});

const rawConfigSchema = z.strictObject({
  engines: z.array(engineSchema).max(sttEngineLimit).optional(),
  language: z.string().regex(languageRe, 'must be a two-letter ISO-639-1 code like ru').nullable().optional(),
  gigaam: gigaamSchema.optional(),
});

type RawSttConfig = z.infer<typeof rawConfigSchema>;

type SttJsonValue = string | number | boolean | null | SttJsonValue[] | { [key: string]: SttJsonValue };

export type SttConfigResult = { ok: true; config: SttConfigFile } | { ok: false; errors: string[] };

/** @description The settings of an instance that has no `stt.json`: no engines, auto language. */
export function createEmptySttConfig(): SttConfigFile {
  return {
    engines: [],
    language: null,
    gigaam: { idleMinutes: defaultGigaamIdleMinutes, workers: defaultGigaamWorkers },
  };
}

/** @description The worker count nearest to `workers` among {@link sttGigaamWorkerChoices} (a tie goes to the smaller). */
export function clampSttWorkers(workers: number): number {
  return sttGigaamWorkerChoices.reduce((nearest, choice) =>
    Math.abs(choice - workers) < Math.abs(nearest - workers) ? choice : nearest,
  );
}

/** @description `config` with the worker count clamped to a choice `/stt` offers. */
export function normaliseSttConfig(config: SttConfigFile): SttConfigFile {
  return { ...config, gigaam: { ...config.gigaam, workers: clampSttWorkers(config.gigaam.workers) } };
}

function getUrlError(url: string): string | null {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? null : 'must be an http(s) URL';
  } catch {
    return 'must be an http(s) URL';
  }
}

function createConfigFromRaw(raw: RawSttConfig): SttConfigFile {
  const empty = createEmptySttConfig();
  const gigaam: SttGigaamSettings = {
    idleMinutes: raw.gigaam?.idleMinutes ?? empty.gigaam.idleMinutes,
    workers: raw.gigaam?.workers ?? empty.gigaam.workers,
    ...(raw.gigaam?.threads !== undefined ? { threads: raw.gigaam.threads } : {}),
  };
  return normaliseSttConfig({ engines: raw.engines ?? [], language: raw.language ?? null, gigaam });
}

/**
 * @description Validate a parsed `stt.json` object. Every error names its field
 * (`stt.json engines.1.timeout.baseSeconds: …`) and never carries a value.
 */
export function validateSttConfig(parsedJson: object): SttConfigResult {
  const parsed = rawConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `stt.json ${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const errors: string[] = [];
  const seenIds = new Set<string>();
  let isGigaamSeen = false;
  (parsed.data.engines ?? []).forEach((engine, index) => {
    if (seenIds.has(engine.id)) errors.push(`stt.json engines.${index}.id: duplicate id`);
    seenIds.add(engine.id);
    if (engine.kind === 'gigaam') {
      if (isGigaamSeen) errors.push(`stt.json engines.${index}.kind: the local engine can be listed only once`);
      isGigaamSeen = true;
    }
    const urlError = engine.url === undefined ? null : getUrlError(engine.url);
    if (urlError) errors.push(`stt.json engines.${index}.url: ${urlError}`);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: createConfigFromRaw(parsed.data) };
}

/**
 * @description The directory `envFile` really lives in: a symlinked `.env` (the keys kept on an encrypted
 * volume, the config dir holding only a link) resolves to its TARGET's directory, so `stt.json` — which holds
 * keys too — lands beside the real file. A plain file, or a link that cannot be resolved (dangling), keeps
 * the directory it was named in.
 */
function getRealEnvFileDir(envFile: string): string {
  try {
    return path.dirname(fs.realpathSync(envFile));
  } catch {
    return path.dirname(envFile);
  }
}

/**
 * @description Where `stt.json` lives: beside the instance's REAL env file (`ENV_FILE` for an isolated
 * instance, else the charness config dir's `.env` — a pre-rename config dir included), after resolving the
 * env file's symlink. With no env file at all, the canonical `~/.config/charness/`.
 */
export function getSttConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const envFile = env.ENV_FILE || resolveGlobalConfigEnvPath(homeDir);
  return path.join(getRealEnvFileDir(envFile), sttConfigFileName);
}

/**
 * @description What the file holds right now. `invalid` keeps the LAST GOOD
 * settings (`null` when the file was never valid in this process), so a bad hand
 * edit never takes voice down.
 */
export type SttConfigLoad =
  | { status: 'missing'; config: SttConfigFile }
  | { status: 'ok'; config: SttConfigFile }
  | { status: 'invalid'; config: SttConfigFile | null; errors: string[] };

interface SttConfigCacheEntry {
  stamp: string;
  load: SttConfigLoad;
  lastGood: SttConfigFile | null;
}

const configCacheByPath = new Map<string, SttConfigCacheEntry>();

/** The OS error code (`ENOENT`, `EACCES`) of a failed fs call — a code names the problem, a message may quote a path. */
export function getErrnoCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : unknownErrorCode;
}

/** Position of a JSON syntax error, without the quoted source text Node puts in its message. */
function getJsonErrorPosition(error: Error): string {
  const position = /position (\d+)/.exec(error.message);
  return position ? ` (at position ${position[1]})` : '';
}

function parseSttConfigText(text: string): SttConfigResult {
  let parsed: SttJsonValue;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Node quotes a slice of the text in the message, and the text holds keys: name only the position.
    return { ok: false, errors: [`${invalidJsonErrorPrefix}${e instanceof Error ? getJsonErrorPosition(e) : ''}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['stt.json must hold a JSON object'] };
  }
  return validateSttConfig(parsed);
}

/**
 * @description Read and validate `stt.json`, cached by the file's stamp
 * (mtime, size, inode) so a per-voice call costs one `stat`. A missing file is
 * the empty settings; an unreadable or invalid one keeps the last good settings.
 */
export function loadSttConfig(filePath: string): SttConfigLoad {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    configCacheByPath.delete(filePath);
    return { status: 'missing', config: createEmptySttConfig() };
  }
  const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const cached = configCacheByPath.get(filePath);
  if (cached?.stamp === stamp) return cached.load;

  const lastGood = cached?.lastGood ?? null;
  let result: SttConfigResult;
  try {
    result = parseSttConfigText(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    result = { ok: false, errors: [`stt.json could not be read (${e instanceof Error ? getErrnoCode(e) : unknownErrorCode})`] };
  }
  const load: SttConfigLoad = result.ok
    ? { status: 'ok', config: result.config }
    : { status: 'invalid', config: lastGood, errors: result.errors };
  configCacheByPath.set(filePath, { stamp, load, lastGood: result.ok ? result.config : lastGood });
  return load;
}

/** @description Forget every cached load — for tests, which swap files under one path. */
export function resetSttConfigCache(): void {
  configCacheByPath.clear();
}

/**
 * @description Write `config` to `filePath`: validated first (a caller that builds
 * an invalid file has a bug), then written mode 0600 through a temp file and a
 * rename, so a reader never sees half a file.
 */
export function saveSttConfig(filePath: string, config: SttConfigFile): void {
  const normalised = normaliseSttConfig(config);
  const validation = validateSttConfig(normalised);
  if (!validation.ok) throw new Error(`refusing to write an invalid stt.json: ${validation.errors.join('; ')}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(normalised, null, 2)}\n`, { mode: configFileMode });
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    fs.rmSync(tempPath, { force: true });
    throw e;
  }
}

/** The env variables the one-time migration reads: the only place that does. */
const legacyGroqKeyName = 'GROQ_API_KEY';
const legacyOpenAiKeyName = 'OPENAI_API_KEY';
const legacyKeysDeprecationKey = 'stt-env-keys';
const legacyKeysDeprecationMessage =
  'GROQ_API_KEY/OPENAI_API_KEY in .env is deprecated, voice settings now live in stt.json';

/** @name SttMigrationResult @description What {@link migrateLegacySttKeys} did. */
export type SttMigrationResult =
  | { status: 'noKeys' }
  | { status: 'fileExists' }
  | { status: 'migrated'; engineNames: string[] }
  | { status: 'writeFailed'; error: string };

/**
 * @description The ONE-TIME migration of the pre-`stt.json` setup: with no file
 * yet and `GROQ_API_KEY` / `OPENAI_API_KEY` set, write `stt.json` with those
 * engines (Groq first) and their keys. From then on the env keys are ignored;
 * a process that still sees one says so once. Never overwrites an existing file.
 */
export function migrateLegacySttKeys(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  writeLine?: (text: string) => void,
): SttMigrationResult {
  const groqKey = env[legacyGroqKeyName];
  const openAiKey = env[legacyOpenAiKeyName];
  if (!groqKey && !openAiKey) return { status: 'noKeys' };
  warnLegacyNameOnce(legacyKeysDeprecationKey, legacyKeysDeprecationMessage, writeLine);
  if (fs.existsSync(filePath)) return { status: 'fileExists' };

  const config = createEmptySttConfig();
  if (groqKey) config.engines.push({ id: createSttEngineId('groq', new Set()), kind: 'groq', apiKey: groqKey });
  if (openAiKey) config.engines.push({ id: createSttEngineId('openai', new Set()), kind: 'openai', apiKey: openAiKey });
  try {
    saveSttConfig(filePath, config);
  } catch (e) {
    return { status: 'writeFailed', error: e instanceof Error ? getErrnoCode(e) : unknownErrorCode };
  }
  return { status: 'migrated', engineNames: config.engines.map((engine) => engine.kind) };
}

/**
 * @description `/stt`'s engine id for a new engine of `kind`: `g` for the local
 * one, else the kind's letter plus the smallest number not taken (`q1`, `o2`, `u1`).
 */
export function createSttEngineId(kind: SttEngineKind, takenIds: ReadonlySet<string>): string {
  if (kind === 'gigaam') return 'g';
  const letter = kind === 'groq' ? 'q' : kind === 'openai' ? 'o' : 'u';
  let number = 1;
  while (takenIds.has(`${letter}${number}`)) number++;
  return `${letter}${number}`;
}

/** @description What the resolver needs to know about the host (the local engine's lifecycle). */
export interface SttFacts {
  isGigaamInstalled: boolean;
  isGigaamInstalling: boolean;
  /** The spawn-storm guard marked the local engine unhealthy. */
  isGigaamUnhealthy: boolean;
  /** The sidecar has a long-lived process to die with (supervisor or bot); without one it is never started. */
  hasOwnerContext: boolean;
}

/** @description Hooks the resolver cannot know: how the local engine's endpoint is produced at call time. */
export interface SttResolveOptions {
  /** Starts the sidecar if needed and returns its endpoint; absent → the local engine is unavailable. */
  getGigaamEndpoint?: () => Promise<TranscriptionEndpoint>;
}

export type SttUnavailableReason =
  | 'disabled'
  | 'notInstalled'
  | 'installing'
  | 'unhealthy'
  | 'languageNotSupported'
  | 'noOwnerContext'
  | 'missingKey'
  | 'missingUrl';

/** An engine that will be tried, with its endpoint produced lazily. */
export interface ResolvedSttEngine {
  id: string;
  kind: SttEngineKind;
  /** What logs call it: the kind, or `url:<host>` for a custom server. */
  name: string;
  timeout: SttTimeout;
  /** Static engines answer at once; the local engine starts its process here and may reject. */
  getEndpoint: () => Promise<TranscriptionEndpoint>;
}

export interface UnavailableSttEngine {
  id: string;
  kind: SttEngineKind;
  reason: SttUnavailableReason;
}

/**
 * Where the effective settings came from: the valid file, none (no file),
 * the last good settings kept after an invalid edit, or nothing usable (an
 * invalid file that was never valid).
 */
export type SttSettingsSource = 'ok' | 'missing' | 'lastGood' | 'invalid';

export interface ResolvedSttSettings {
  /** The effective settings: the file's, the last good ones after a bad edit, or the empty ones. */
  settings: SttConfigFile;
  source: SttSettingsSource;
  /** Available engines in chain order. */
  engines: ResolvedSttEngine[];
  unavailable: UnavailableSttEngine[];
  /** The file names an enabled local engine that is neither installed nor being installed. */
  needsAutoInstall: boolean;
  errors: string[];
}

function getUnavailableReason(
  engine: SttEngineSetting,
  config: SttConfigFile,
  facts: SttFacts,
): SttUnavailableReason | null {
  if (engine.isDisabled) return 'disabled';
  switch (engine.kind) {
    case 'gigaam':
      if (!facts.hasOwnerContext) return 'noOwnerContext';
      if (config.language !== null && config.language !== gigaamLanguage) return 'languageNotSupported';
      if (facts.isGigaamInstalling) return 'installing';
      if (!facts.isGigaamInstalled) return 'notInstalled';
      return facts.isGigaamUnhealthy ? 'unhealthy' : null;
    case 'groq':
    case 'openai':
      return engine.apiKey ? null : 'missingKey';
    case 'url':
      return engine.url ? null : 'missingUrl';
  }
}

function getEngineName(engine: SttEngineSetting): string {
  if (engine.kind !== 'url') return engine.kind;
  try {
    return `url:${new URL(engine.url ?? '').host}`;
  } catch {
    return 'url';
  }
}

/** The endpoint of an engine that needs no process: its key and URL are in the file. */
function createStaticEndpoint(engine: SttEngineSetting): TranscriptionEndpoint {
  if (engine.kind === 'groq') return createGroqEndpoint(engine.apiKey ?? '');
  if (engine.kind === 'openai') return createOpenAiEndpoint(engine.apiKey ?? '');
  return createCustomEndpoint({ url: engine.url ?? '', apiKey: engine.apiKey, model: engine.model });
}

/**
 * @description Turn the loaded settings into the chain a voice note walks:
 * the available engines in order, the skipped ones with their reason, and
 * whether the local engine has to be installed first.
 */
export function resolveSttSettings(
  load: SttConfigLoad,
  facts: SttFacts,
  options: SttResolveOptions = {},
): ResolvedSttSettings {
  const settings = load.config ?? createEmptySttConfig();
  const engines: ResolvedSttEngine[] = [];
  const unavailable: UnavailableSttEngine[] = [];
  for (const engine of settings.engines) {
    const getEndpoint =
      engine.kind === 'gigaam' ? options.getGigaamEndpoint : () => Promise.resolve(createStaticEndpoint(engine));
    // No hook to start the process means no owner to start it for.
    const reason = getUnavailableReason(engine, settings, facts) ?? (getEndpoint ? null : 'noOwnerContext');
    if (reason || !getEndpoint) {
      unavailable.push({ id: engine.id, kind: engine.kind, reason: reason ?? 'noOwnerContext' });
      continue;
    }
    engines.push({
      id: engine.id,
      kind: engine.kind,
      name: getEngineName(engine),
      timeout: engine.timeout ?? defaultSttTimeout,
      getEndpoint,
    });
  }
  const needsAutoInstall = settings.engines.some(
    (engine) => engine.kind === 'gigaam' && !engine.isDisabled && !facts.isGigaamInstalled && !facts.isGigaamInstalling,
  );
  return {
    settings,
    source: load.status === 'invalid' ? (load.config ? 'lastGood' : 'invalid') : load.status,
    engines,
    unavailable,
    needsAutoInstall,
    errors: load.status === 'invalid' ? load.errors : [],
  };
}

const unavailableReasonTexts: Record<SttUnavailableReason, string> = {
  disabled: 'disabled',
  notInstalled: 'not installed',
  installing: 'still installing',
  unhealthy: 'marked unhealthy after repeated start failures',
  languageNotSupported: 'the local engine only knows Russian',
  noOwnerContext: 'there is no owner process to start it with',
  missingKey: 'no API key',
  missingUrl: 'no URL',
};

/**
 * @description The `[STT]` log lines for what is wrong with the settings:
 * file errors (with what the bot does instead), skipped engines (a disabled one
 * is the operator's choice, not a problem) and an empty chain (unless the file itself
 * is unusable, which its own error already says). Empty → all well.
 */
export function getSttReportLines(resolved: ResolvedSttSettings): string[] {
  const errorSuffix = resolved.source === 'lastGood' ? 'keeping the last good settings' : 'no voice settings loaded';
  const lines = resolved.errors.map((error) => `[STT] ${error} (${errorSuffix})`);
  for (const skipped of resolved.unavailable) {
    if (skipped.reason === 'disabled') continue;
    lines.push(`[STT] engine ${skipped.id} (${skipped.kind}) is skipped: ${unavailableReasonTexts[skipped.reason]}`);
  }
  if (resolved.engines.length === 0 && resolved.source !== 'invalid') {
    lines.push('[STT] no speech engine is available: voice notes are refused until one is set up');
  }
  return lines;
}

/**
 * @description The request budget for one voice: `baseSeconds` plus
 * `percentOfDuration` % of the voice's length (Telegram's `voice.duration`;
 * {@link unknownVoiceDurationSeconds} when it is missing). Long voices stay on
 * their engine, they just get more time.
 */
export function getEngineTimeoutMs(timeout: SttTimeout, durationSeconds: number | undefined): number {
  const voiceSeconds = durationSeconds ?? unknownVoiceDurationSeconds;
  return (timeout.baseSeconds + (timeout.percentOfDuration / percentDivisor) * voiceSeconds) * millisecondsPerSecond;
}
