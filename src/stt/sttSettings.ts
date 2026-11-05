import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import {
  createConfigFileLoader,
  getConfigDirFilePath,
  getCaughtErrnoCode,
  writeJsonFileAtomically,
  type ConfigFileLoad,
  type ConfigValidation,
} from '../configDirFile';
import { warnLegacyNameOnce } from '../legacyNames';
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
/**
 * How long the local engine stays loaded after its last voice. An hour holds a working session's gaps between voice notes
 * (a cold start under load is the slowest thing a voice can meet); the cost is its memory (~0.5 GB, up to ~0.9 GB after a
 * long voice) for that hour, and `/stt` lets a small box pick less.
 */
export const defaultGigaamIdleMinutes = 60;
export const defaultGigaamWorkers = 4;
/** Intra-op threads per worker; `workers × threads` should not exceed the CPU count. */
export const defaultGigaamThreads = 2;
/**
 * The old default, which the bot itself wrote into every `stt.json` it saved (it wrote the whole `gigaam` block). A stored
 * value equal to it is not a choice: the migration {@link migrateSttStoredDefaults} drops it.
 */
export const previousGigaamIdleMinutes = 15;
/**
 * A file BESIDE `stt.json` that says the migration has been through this directory. It is not in `stt.json`: every released
 * build reads that file with a strict schema, so a new key would turn voice off on any older build — after a rollback, or a
 * downgrade. Older builds never read this one.
 */
export const sttDefaultsMigratedMarkerName = 'stt.defaults-migrated';
const sttDefaultsMigratedMarkerText = 'stt.json beside this file stores only the settings that differ from the defaults. Older charness builds ignore this file.\n';

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
/** The file holds API keys: owner-only. */
const configFileMode = 0o600;

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

export type SttConfigResult = ConfigValidation<SttConfigFile>;

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
 * @description Where `stt.json` lives: beside the instance's REAL env file (see {@link getConfigDirFilePath} for
 * the rules — a symlinked `.env` is resolved, so the file that holds API keys lands beside the real one).
 */
export function getSttConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return getConfigDirFilePath(sttConfigFileName, env, homeDir);
}

/**
 * @description What the file holds right now. `invalid` keeps the LAST GOOD
 * settings (`null` when the file was never valid in this process), so a bad hand
 * edit never takes voice down.
 */
export type SttConfigLoad = ConfigFileLoad<SttConfigFile>;

const sttConfigLoader = createConfigFileLoader<SttConfigFile>({
  fileName: sttConfigFileName,
  createEmpty: createEmptySttConfig,
  validate: validateSttConfig,
});

/**
 * @description Read and validate `stt.json`, cached by the file's stamp
 * (mtime, size, inode) so a per-voice call costs one `stat`. A missing file is
 * the empty settings; an unreadable or invalid one keeps the last good settings.
 */
export const loadSttConfig = sttConfigLoader.load;

/** @description Forget every cached load — for tests, which swap files under one path. */
export const resetSttConfigCache = sttConfigLoader.resetCache;

/**
 * @description `config` as it is STORED: the `gigaam` block holds only what differs from the defaults (a default written to
 * the file looks like a choice, and a later change of the default would never reach the setups that "chose" it) and is left
 * out when empty. Nothing is added to the file's keys: every released build reads it with a strict schema.
 */
function createStoredConfig(config: SttConfigFile): RawSttConfig {
  const { idleMinutes, workers, threads } = config.gigaam;
  const gigaam: Partial<SttGigaamSettings> = {
    ...(idleMinutes !== defaultGigaamIdleMinutes ? { idleMinutes } : {}),
    ...(workers !== defaultGigaamWorkers ? { workers } : {}),
    ...(threads !== undefined ? { threads } : {}),
  };
  return {
    engines: config.engines,
    language: config.language,
    ...(Object.keys(gigaam).length > 0 ? { gigaam } : {}),
  };
}

function getMigratedMarkerPath(filePath: string): string {
  return path.join(path.dirname(filePath), sttDefaultsMigratedMarkerName);
}

/** The marker is written once and never rewritten: its presence is the whole message. */
function writeMigratedMarker(filePath: string): void {
  const markerPath = getMigratedMarkerPath(filePath);
  if (fs.existsSync(markerPath)) return;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, sttDefaultsMigratedMarkerText, { mode: configFileMode });
}

/**
 * @description Write `config` to `filePath`: validated first (a caller that builds
 * an invalid file has a bug), then written mode 0600 through a temp file and a
 * rename, so a reader never sees half a file. Only the values that differ from the
 * defaults are stored ({@link createStoredConfig}). The marker beside the file is written
 * first: a file saved by this layout is never one that {@link migrateSttStoredDefaults}
 * should take for an earlier build's.
 */
export function saveSttConfig(filePath: string, config: SttConfigFile): void {
  const normalised = normaliseSttConfig(config);
  const validation = validateSttConfig(normalised);
  if (!validation.ok) throw new Error(`refusing to write an invalid stt.json: ${validation.errors.join('; ')}`);
  writeMigratedMarker(filePath);
  writeJsonFileAtomically(filePath, createStoredConfig(normalised), configFileMode);
}

/** @name SttStoredDefaultsMigrationResult @description What {@link migrateSttStoredDefaults} did. */
export type SttStoredDefaultsMigrationResult =
  | { status: 'notNeeded' }
  | { status: 'migrated'; isIdleMinutesDropped: boolean }
  | { status: 'writeFailed'; error: string };

/**
 * @description The migration of the values the bot itself used to write. An earlier build saved the whole `gigaam` block,
 * `idleMinutes: 15` included — then the default, so not anyone's choice, and it would hold the local engine to 15 minutes
 * for good. The stored 15 is dropped (the engine then follows the current default) when
 *
 * - the marker beside the file is absent: this directory has not been migrated; or
 * - the file stores a value equal to a default (`workers: 4`, `idleMinutes: 60`): this layout never does, so an earlier
 *   build wrote it — the marker is there but a rollback, an old `/stt` save and a new update came after.
 *
 * A 15 picked on this layout is stored without such a default next to it and stays. The one case no content can tell apart
 * is an earlier build's `15` beside a workers count that was changed on purpose; once the marker is there it stays.
 * A missing, unreadable or invalid file is left alone. Idempotent: a file that needs nothing is not touched.
 */
export function migrateSttStoredDefaults(filePath: string): SttStoredDefaultsMigrationResult {
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { status: 'notNeeded' };
  }
  const parsed = rawConfigSchema.safeParse(parsedJson);
  if (!parsed.success) return { status: 'notNeeded' };
  const validation = validateSttConfig(parsedJson);
  if (!validation.ok) return { status: 'notNeeded' };

  const isMarked = fs.existsSync(getMigratedMarkerPath(filePath));
  const stored = parsed.data.gigaam;
  const isEarlierBuildFile = stored?.workers === defaultGigaamWorkers || stored?.idleMinutes === defaultGigaamIdleMinutes;
  if (isMarked && !isEarlierBuildFile) return { status: 'notNeeded' };

  const isIdleMinutesDropped = validation.config.gigaam.idleMinutes === previousGigaamIdleMinutes;
  if (!isIdleMinutesDropped && isMarked) return { status: 'notNeeded' };
  try {
    if (isIdleMinutesDropped) {
      saveSttConfig(filePath, { ...validation.config, gigaam: { ...validation.config.gigaam, idleMinutes: defaultGigaamIdleMinutes } });
    } else {
      writeMigratedMarker(filePath);
    }
  } catch (e) {
    return { status: 'writeFailed', error: getCaughtErrnoCode(e) };
  }
  return { status: 'migrated', isIdleMinutesDropped };
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
    return { status: 'writeFailed', error: getCaughtErrnoCode(e) };
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

/** @name SttEndpointRequest @description What the caller says when it asks an engine for its endpoint. */
export interface SttEndpointRequest {
  /**
   * The ask is a warm-up made when a voice note ARRIVED — the engine may still be busy with the topic's earlier voice —
   * not a voice about to be recognised. It is only meant to get a cold or loading engine going, so it never acts on a
   * silent one (no health verdict, no replacement).
   */
  isWarmUp?: boolean;
}

/** @description Hooks the resolver cannot know: how the local engine's endpoint is produced at call time. */
export interface SttResolveOptions {
  /** Starts the sidecar if needed and returns its endpoint; absent → the local engine is unavailable. */
  getGigaamEndpoint?: (request?: SttEndpointRequest) => Promise<TranscriptionEndpoint>;
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
  getEndpoint: (request?: SttEndpointRequest) => Promise<TranscriptionEndpoint>;
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
  noOwnerContext: 'it has no owner process to be tied to (a hot supervisor that predates local recognition: restart it)',
  missingKey: 'no API key',
  missingUrl: 'no URL',
};

/**
 * @description The i18n key of the notice a voice note gets when NO engine can take it, from the most specific
 * cause down: a broken `stt.json`; the local engine still installing (the voice is not refused for good — send it
 * again); engines that are listed but unusable right now; and none set up (or all switched off by the operator).
 */
export function getNoEngineNoticeCode(
  resolved: Pick<ResolvedSttSettings, 'errors' | 'unavailable'>,
): 'voice.config_invalid' | 'voice.local_installing' | 'voice.engines_unavailable' | 'voice.no_api_key' {
  if (resolved.errors.length > 0) return 'voice.config_invalid';
  if (resolved.unavailable.some((engine) => engine.reason === 'installing')) return 'voice.local_installing';
  if (resolved.unavailable.some((engine) => engine.reason !== 'disabled')) return 'voice.engines_unavailable';
  return 'voice.no_api_key';
}

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
 * `percentOfDuration` % of the voice's length (Telegram's `voice.duration`). A missing length — or a `0`, which
 * Telegram reports for a note whose length it could not read — is "unknown", not a 0-second voice: it is
 * budgeted as {@link unknownVoiceDurationSeconds}, so a long voice without a length is not cut at the bare base.
 * Long voices stay on their engine, they just get more time.
 * `queuedAudioSeconds` — the audio the local engine reports in line before this voice — is budgeted at the same rate.
 */
export function getEngineTimeoutMs(timeout: SttTimeout, durationSeconds: number | undefined, queuedAudioSeconds = 0): number {
  const voiceSeconds = durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds : unknownVoiceDurationSeconds;
  return (timeout.baseSeconds + (timeout.percentOfDuration / percentDivisor) * (voiceSeconds + queuedAudioSeconds)) * millisecondsPerSecond;
}
