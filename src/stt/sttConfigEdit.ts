import {
  createSttEngineId,
  gigaamLanguage,
  sttEngineLimit,
  validateSttConfig,
  type SttConfigFile,
  type SttEngineSetting,
  type SttTimeout,
} from './sttSettings';

/**
 * @description The edits `/stt` makes to `stt.json`, as pure functions: each takes the current settings and
 * returns the next ones (or a named refusal), validated by the same schema a hand edit goes through — a button
 * can never write a file the loader would refuse.
 */

export const sttTimeoutBasePresets: readonly number[] = [5, 10, 20, 30];
export const sttTimeoutPercentPresets: readonly number[] = [10, 25, 50, 100];
/** Minutes the local engine may idle; `0` is "never exits". */
export const sttIdleMinutesPresets: readonly number[] = [5, 15, 30, 60, 0];
export const sttLanguagePresets: readonly string[] = [gigaamLanguage, 'en', 'uk', 'de', 'fr', 'es'];

export type SttEditFailure = 'unknownEngine' | 'full' | 'alreadyListed' | 'invalidValue';
export type SttEditResult = { ok: true; config: SttConfigFile } | { ok: false; reason: SttEditFailure };

/** What can be added from the add menu. */
export type SttNewEngine =
  | { kind: 'groq' | 'openai'; apiKey: string }
  | { kind: 'url'; url: string; apiKey?: string }
  | { kind: 'gigaam' };

const baseUrlSuffixRe = /\/v1\/?$/;
const transcriptionsPath = '/v1/audio/transcriptions';
const transcriptionsPathRe = /\/audio\/transcriptions\/?$/;

function finalize(config: SttConfigFile): SttEditResult {
  const validation = validateSttConfig(config);
  return validation.ok ? { ok: true, config: validation.config } : { ok: false, reason: 'invalidValue' };
}

function findEngineIndex(config: SttConfigFile, engineId: string): number {
  return config.engines.findIndex((engine) => engine.id === engineId);
}

function replaceEngine(config: SttConfigFile, engineId: string, change: (engine: SttEngineSetting) => SttEngineSetting): SttEditResult {
  const index = findEngineIndex(config, engineId);
  if (index < 0) return { ok: false, reason: 'unknownEngine' };
  return finalize({ ...config, engines: config.engines.map((engine, position) => (position === index ? change(engine) : engine)) });
}

/** @description Move an engine one place earlier (`-1`) or later (`1`); at the end of the list it stays. */
export function moveSttEngine(config: SttConfigFile, engineId: string, direction: -1 | 1): SttEditResult {
  const index = findEngineIndex(config, engineId);
  if (index < 0) return { ok: false, reason: 'unknownEngine' };
  const target = index + direction;
  if (target < 0 || target >= config.engines.length) return { ok: true, config };
  const engines = [...config.engines];
  [engines[index], engines[target]] = [engines[target], engines[index]];
  return finalize({ ...config, engines });
}

/** @description Switch an engine between "use" and "don't use" without removing it. */
export function toggleSttEngineDisabled(config: SttConfigFile, engineId: string): SttEditResult {
  return replaceEngine(config, engineId, (engine) => {
    const { isDisabled: _wasDisabled, ...rest } = engine;
    return engine.isDisabled ? rest : { ...rest, isDisabled: true };
  });
}

/** @description Change one half of an engine's timeout; the other half keeps its value (default `10 s + 25 %`). */
export function setSttEngineTimeout(
  config: SttConfigFile,
  engineId: string,
  change: Partial<SttTimeout>,
  currentTimeout: SttTimeout,
): SttEditResult {
  return replaceEngine(config, engineId, (engine) => ({ ...engine, timeout: { ...(engine.timeout ?? currentTimeout), ...change } }));
}

/** @description Set (or replace) an engine's API key. */
export function setSttEngineApiKey(config: SttConfigFile, engineId: string, apiKey: string): SttEditResult {
  return replaceEngine(config, engineId, (engine) => ({ ...engine, apiKey }));
}

export function removeSttEngine(config: SttConfigFile, engineId: string): SttEditResult {
  if (findEngineIndex(config, engineId) < 0) return { ok: false, reason: 'unknownEngine' };
  return finalize({ ...config, engines: config.engines.filter((engine) => engine.id !== engineId) });
}

/**
 * @description Add an engine with a fresh id: the local one goes FIRST (it is the point of installing it), the
 * others last. The local engine can be listed once; the list holds at most {@link sttEngineLimit}.
 */
export function addSttEngine(config: SttConfigFile, spec: SttNewEngine): SttEditResult & { engineId?: string } {
  if (config.engines.length >= sttEngineLimit) return { ok: false, reason: 'full' };
  if (spec.kind === 'gigaam' && config.engines.some((engine) => engine.kind === 'gigaam')) return { ok: false, reason: 'alreadyListed' };
  const engineId = createSttEngineId(spec.kind, new Set(config.engines.map((engine) => engine.id)));
  const engine: SttEngineSetting =
    spec.kind === 'gigaam'
      ? { id: engineId, kind: 'gigaam' }
      : spec.kind === 'url'
        ? { id: engineId, kind: 'url', url: spec.url, ...(spec.apiKey ? { apiKey: spec.apiKey } : {}) }
        : { id: engineId, kind: spec.kind, apiKey: spec.apiKey };
  const engines = spec.kind === 'gigaam' ? [engine, ...config.engines] : [...config.engines, engine];
  const result = finalize({ ...config, engines });
  return result.ok ? { ...result, engineId } : result;
}

/**
 * @description After the local engine is installed: put it first when the chain does not name it yet, else just
 * make sure it is switched on where it already stands.
 */
export function enableLocalSttEngine(config: SttConfigFile): SttEditResult {
  const existing = config.engines.find((engine) => engine.kind === 'gigaam');
  if (!existing) return addSttEngine(config, { kind: 'gigaam' });
  return existing.isDisabled ? toggleSttEngineDisabled(config, existing.id) : { ok: true, config };
}

/** @description Drop the local engine from the chain (its files are removed by the caller). */
export function dropLocalSttEngine(config: SttConfigFile): SttEditResult {
  return finalize({ ...config, engines: config.engines.filter((engine) => engine.kind !== 'gigaam') });
}

export function setSttLanguage(config: SttConfigFile, language: string | null): SttEditResult {
  return finalize({ ...config, language });
}

export function setSttIdleMinutes(config: SttConfigFile, idleMinutes: number): SttEditResult {
  return finalize({ ...config, gigaam: { ...config.gigaam, idleMinutes } });
}

export function setSttWorkers(config: SttConfigFile, workers: number): SttEditResult {
  return finalize({ ...config, gigaam: { ...config.gigaam, workers } });
}

export type SttUrlInputResult = { ok: true; url: string } | { ok: false; reason: 'invalid' | 'credentials' };

/**
 * @description Turn what the operator typed into the endpoint URL: it must be http(s) and carry no login (a key
 * has its own step). A base address (`http://host:8000`, `…/v1`) gets `/v1/audio/transcriptions` appended; an
 * address that already names `…/audio/transcriptions` is kept as typed, and so is any other path (a proxy
 * under its own prefix).
 */
export function normaliseSttUrl(input: string): SttUrlInputResult {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' };
  parsed.hash = '';
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  if (transcriptionsPathRe.test(trimmedPath)) return { ok: true, url: parsed.toString() };
  if (trimmedPath === '' || baseUrlSuffixRe.test(parsed.pathname)) {
    parsed.pathname = `${trimmedPath.replace(baseUrlSuffixRe, '')}${transcriptionsPath}`;
  }
  return { ok: true, url: parsed.toString() };
}
