import * as crypto from 'crypto';
import { formatLocalClock } from '../utils/localClock';
import { checkIsPlausibleProviderApiKey } from '../utils/openCodeAuthLogin';
import type { SttInstallProgress } from './sttInstall';
import {
  addSttEngine,
  moveSttEngine,
  normaliseSttUrl,
  removeSttEngine,
  setSttEngineTimeout,
  setSttIdleMinutes,
  setSttLanguage,
  setSttWorkers,
  sttIdleMinutesPresets,
  sttLanguagePresets,
  sttTimeoutBasePresets,
  sttTimeoutPercentPresets,
  toggleSttEngineDisabled,
  type SttEditResult,
} from './sttConfigEdit';
import {
  defaultSttTimeout,
  sttGigaamWorkerChoices,
  type ResolvedSttSettings,
  type SttConfigFile,
  type SttEngineSetting,
  type SttTimeout,
  type SttUnavailableReason,
} from './sttSettings';
import type { SttSidecarStatus } from './sttSidecarOwner';

/**
 * @description What the voice-settings messages say, as pure functions over data — the Telegram side
 * (`connectors/telegram/commands/stt.ts`) only renders and sends them. `translate` is the topic's `t(...)`, so
 * tests pass a stand-in that echoes the key and variables.
 */

export type SttTranslate = (code: string, vars?: Record<string, string | number>) => string;

const secondsPerMinute = 60;
/** The install log's last lines shown under a failure; the rest is in `install.log`. */
const failureTailLineCount = 5;
const failureTailLineMaxLength = 160;

/** @description `1:05` — minutes and zero-padded seconds. */
export function formatSttElapsed(elapsedSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(wholeSeconds / secondsPerMinute);
  return `${minutes}:${(wholeSeconds % secondsPerMinute).toString().padStart(2, '0')}`;
}

/** @description The phase line of a RUNNING install (`downloading the model 120/216 MB…`). */
export function getSttInstallPhaseLine(progress: SttInstallProgress, translate: SttTranslate): string {
  switch (progress.phase) {
    case 'downloadingModel': return translate('stt.install.downloadingModel', { progress: progress.detail });
    case 'creatingEnvironment': return translate('stt.install.creatingEnvironment');
    case 'installingPackages': return translate('stt.install.installingPackages');
    default: return translate('stt.install.checking');
  }
}

/**
 * @description The text of the install message for one progress report: while it runs, a header with the elapsed
 * time over the phase line (`downloading the model 120/216 MB…`); at the end only the outcome — ready, or the
 * error with the last log lines.
 */
export function buildSttInstallProgressText(progress: SttInstallProgress, elapsedSeconds: number, translate: SttTranslate): string {
  switch (progress.phase) {
    case 'done':
      return translate('stt.install.done');
    case 'failed': {
      const tail = (progress.logTail ?? []).slice(-failureTailLineCount).map((line) => `  ${line.slice(0, failureTailLineMaxLength)}`);
      return [translate('stt.install.failed', { error: progress.error ?? '' }), ...tail].join('\n');
    }
    default:
      return `${translate('stt.install.header', { elapsed: formatSttElapsed(elapsedSeconds) })}\n${getSttInstallPhaseLine(progress, translate)}`;
  }
}

/** @description One log line per phase change of an install nobody watches in a chat (`[STT] install: …`). */
export function formatSttInstallLogLine(progress: SttInstallProgress): string {
  const base = `[STT] install: ${progress.phase}`;
  if (progress.phase === 'failed') return `${base} — ${progress.error ?? 'unknown error'}`;
  return progress.detail ? `${base} ${progress.detail}` : base;
}

// ───────────────────────────── the `/stt` screens ─────────────────────────────

/** @name SttScreenInput @description Everything a `/stt` screen shows, gathered by the command module. */
export interface SttScreenInput {
  resolved: ResolvedSttSettings;
  configPath: string;
  isLocalInstalled: boolean;
  /** The install job's last report while one runs (or null when not installing). */
  installing: SttInstallProgress | null;
  sidecar: SttSidecarStatus;
  hasOwnerContext: boolean;
}

export type SttLocalStatus =
  | { state: 'notInstalled' }
  | { state: 'installing'; progress: SttInstallProgress }
  | { state: 'noOwner' }
  | { state: 'unhealthy'; until: number }
  /** `busyRequests` unknown: the process is alive but was too busy to answer /health. */
  | { state: 'running'; busyRequests?: number }
  | { state: 'ready' };

/** @description The one line the local engine's state boils down to; installing and not installed outrank the process state. */
export function getSttLocalStatus(input: SttScreenInput): SttLocalStatus {
  if (input.installing) return { state: 'installing', progress: input.installing };
  if (!input.isLocalInstalled) return { state: 'notInstalled' };
  if (!input.hasOwnerContext) return { state: 'noOwner' };
  if (input.sidecar.state === 'unhealthy') return { state: 'unhealthy', until: input.sidecar.unhealthyUntil };
  if (input.sidecar.state === 'running') return { state: 'running', busyRequests: input.sidecar.busyRequests };
  return { state: 'ready' };
}

/** @description The content hash `/stt` bakes into every callback: a hand edit of the file makes old keyboards stale. */
export function computeSttRevision(config: SttConfigFile): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, revisionLength);
}

// ── callback data: stt_<action>[_<arg>…]_<revision>, at most 64 bytes ──

const callbackPrefix = 'stt';
const callbackSeparator = '_';
const revisionLength = 6;
export const sttCallbackMaxBytes = 64;
/** Every `/stt` button; registered once with `bot.action`. */
export const sttCallbackRe = /^stt_[a-z]{2}(?:_[A-Za-z0-9]+)*_[0-9a-f]{6}$/;

export type SttAction =
  | 'oe' | 'up' | 'dn' | 'us' | 'tm' | 'tb' | 'tp' | 'ky' | 'ra' | 'rd'
  | 'ad' | 'an' | 'lg' | 'ls' | 'im' | 'is' | 'wm' | 'ws' | 'rt'
  | 'ec' | 'ei' | 'er' | 'ip' | 'fa' | 'fd' | 'ku' | 'bk' | 'cl' | 'cn';

export interface ParsedSttCallback {
  action: SttAction;
  args: string[];
  revision: string;
}

export function buildSttCallback(action: SttAction, args: ReadonlyArray<string | number>, revision: string): string {
  return [callbackPrefix, action, ...args.map((arg) => arg.toString()), revision].join(callbackSeparator);
}

/** @description The parts of a `/stt` callback, or `null` for anything that is not one. */
export function parseSttCallback(data: string): ParsedSttCallback | null {
  if (!sttCallbackRe.test(data)) return null;
  const parts = data.split(callbackSeparator);
  return { action: parts[1] as SttAction, args: parts.slice(2, -1), revision: parts[parts.length - 1] };
}

/** Navigation and cancel taps never change anything, so an old keyboard may still use them. */
const revisionFreeActions: ReadonlySet<SttAction> = new Set<SttAction>(['bk', 'cl', 'cn']);

// ── screens ──

export interface SttButton {
  text: string;
  data: string;
}

export interface SttScreen {
  text: string;
  rows: SttButton[][];
}

export type SttScreenId =
  | { id: 'main' }
  | { id: 'card'; engineId: string }
  | { id: 'timeout'; engineId: string }
  | { id: 'add' }
  | { id: 'language' }
  | { id: 'idle'; engineId: string }
  | { id: 'workers'; engineId: string }
  | { id: 'enableConfirm' }
  | { id: 'removeEngineConfirm'; engineId: string }
  | { id: 'removeFilesConfirm'; engineId: string }
  | { id: 'keyChoice' };

const percentSign = '%';

/** @description An engine's name as the screens say it: translated for the local one, the host for a custom server. */
export function getSttEngineName(engine: SttEngineSetting, translate: SttTranslate): string {
  switch (engine.kind) {
    case 'gigaam': return translate('stt.engine.gigaam');
    case 'groq': return 'Groq';
    case 'openai': return 'OpenAI';
    case 'url':
      try {
        return new URL(engine.url ?? '').host;
      } catch {
        return translate('stt.engine.url');
      }
  }
}

/** The address as a screen shows it: without a query string or fragment, which may carry a token. */
function formatUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function formatTimeoutSummary(timeout: SttTimeout): string {
  return `${timeout.baseSeconds}s+${timeout.percentOfDuration}${percentSign}`;
}

function getEngineProblem(input: SttScreenInput, engine: SttEngineSetting): SttUnavailableReason | null {
  if (engine.isDisabled) return 'disabled';
  return input.resolved.unavailable.find((skipped) => skipped.id === engine.id)?.reason ?? null;
}

function withNotice(notice: string | undefined, text: string): string {
  return notice ? `${notice}\n\n${text}` : text;
}

function formatIdleMinutes(minutes: number, translate: SttTranslate): string {
  return minutes === 0 ? translate('stt.idle.never') : translate('stt.idle.minutes', { count: minutes });
}

/** The short word the local engine's state boils down to, as it rides on its row label (`stt.engineState.<word>`). */
function getLocalStateWord(local: SttLocalStatus): string {
  switch (local.state) {
    case 'running': return 'running';
    case 'ready': return 'stopped';
    case 'installing': return 'installing';
    case 'unhealthy': return 'paused';
    case 'noOwner': return 'noOwner';
    case 'notInstalled': return 'notInstalled';
  }
}

/** The full status line of the local engine's card (`Status: ready · running`). */
function formatLocalStatusLine(local: SttLocalStatus, translate: SttTranslate): string {
  switch (local.state) {
    case 'notInstalled': return translate('stt.card.local.status.notInstalled');
    case 'installing': return translate('stt.card.local.status.installing', { phase: getSttInstallPhaseLine(local.progress, translate) });
    case 'noOwner': return translate('stt.card.local.status.noOwner');
    case 'unhealthy': return translate('stt.card.local.status.paused', { until: formatLocalClock(local.until) });
    case 'running':
      if (local.busyRequests === undefined) return translate('stt.card.local.status.runningSlow');
      return local.busyRequests > 0 ? translate('stt.card.local.status.runningBusy', { count: local.busyRequests }) : translate('stt.card.local.status.running');
    case 'ready': return translate('stt.card.local.status.stopped');
  }
}

/**
 * The main screen holds only what applies to recognition as a whole: the engine list, Add engine, Language, Close.
 * What belongs to one engine — the local one's status, idle exit, workers, files — is on that engine's card; the
 * local engine's short state only rides on its row label.
 */
function buildMainScreen(input: SttScreenInput, translate: SttTranslate, notice?: string): SttScreen {
  const { resolved } = input;
  const { settings } = resolved;
  const revision = computeSttRevision(settings);
  const lines = [translate('stt.screen.title')];

  if (resolved.source === 'missing') lines.push(translate('stt.screen.sourceMissing', { path: input.configPath }));
  else if (resolved.source === 'ok') lines.push(translate('stt.screen.sourceFile', { path: input.configPath }));
  else {
    const firstError = resolved.errors[0] ?? '';
    lines.push(translate(resolved.source === 'lastGood' ? 'stt.screen.sourceLastGood' : 'stt.screen.sourceInvalid', { path: input.configPath, error: firstError }));
  }
  lines.push(translate('stt.screen.language', { language: settings.language ?? translate('stt.language.autoName') }));
  lines.push(settings.engines.length === 0 ? translate('stt.screen.chainEmpty') : translate('stt.screen.chainHeading'));

  const localStateWord = getLocalStateWord(getSttLocalStatus(input));
  const rows: SttButton[][] = settings.engines.map((engine, index) => {
    const mark = getEngineProblem(input, engine) === null ? '✓' : '✗';
    const name = getSttEngineName(engine, translate);
    const parts = [`${index + 1}. ${name}`];
    if (engine.kind === 'gigaam') parts.push(translate(`stt.engineState.${localStateWord}`));
    parts.push(formatTimeoutSummary(engine.timeout ?? defaultSttTimeout), mark);
    return [{ text: parts.join(' · '), data: buildSttCallback('oe', [engine.id], revision) }];
  });
  rows.push([{ text: translate('stt.btn.addEngine'), data: buildSttCallback('ad', [], revision) }]);
  rows.push([{ text: translate('stt.btn.language', { language: settings.language ?? translate('stt.language.autoShort') }), data: buildSttCallback('lg', [], revision) }]);
  rows.push([{ text: translate('stt.btn.close'), data: buildSttCallback('cl', [], revision) }]);
  return { text: withNotice(notice, lines.join('\n')), rows };
}

/** The rows only the local engine's card has: idle exit, workers, and whichever of try again / install / progress its state asks for. */
function buildLocalCardRows(input: SttScreenInput, engine: SttEngineSetting, translate: SttTranslate, revision: string): SttButton[][] {
  const { gigaam } = input.resolved.settings;
  const local = getSttLocalStatus(input);
  const rows: SttButton[][] = [
    [{ text: translate('stt.btn.idle', { value: formatIdleMinutes(gigaam.idleMinutes, translate) }), data: buildSttCallback('im', [engine.id], revision) }],
    [{ text: translate('stt.btn.workers', { count: gigaam.workers }), data: buildSttCallback('wm', [engine.id], revision) }],
  ];
  if (local.state === 'unhealthy') rows.push([{ text: translate('stt.btn.tryAgain'), data: buildSttCallback('rt', [engine.id], revision) }]);
  if (local.state === 'installing') rows.push([{ text: translate('stt.btn.showProgress'), data: buildSttCallback('ip', [engine.id], revision) }]);
  else if (!input.isLocalInstalled) rows.push([{ text: translate('stt.btn.install'), data: buildSttCallback('ec', [engine.id], revision) }]);
  return rows;
}

/**
 * One card for every engine: the common controls (order, use / don't use, timeout, remove) plus what the kind adds —
 * a key (Groq, OpenAI, a custom server), or the local engine's status, memory, idle exit, workers and files.
 */
function buildEngineCard(input: SttScreenInput, engineId: string, translate: SttTranslate, notice?: string): SttScreen | null {
  const { settings } = input.resolved;
  const index = settings.engines.findIndex((engine) => engine.id === engineId);
  const engine = settings.engines[index];
  if (!engine) return null;
  const revision = computeSttRevision(settings);
  const timeout = engine.timeout ?? defaultSttTimeout;
  const problem = getEngineProblem(input, engine);
  const isLocal = engine.kind === 'gigaam';
  const lines: string[] = [];
  if (isLocal) {
    lines.push(translate('stt.card.local.title'), formatLocalStatusLine(getSttLocalStatus(input), translate));
    // The other reasons are the status line's; these two are about the settings.
    if (problem === 'disabled' || problem === 'languageNotSupported') lines.push(translate(`stt.card.problem.${problem}`));
    lines.push(translate('stt.card.local.ram'));
  } else {
    lines.push(translate('stt.card.title', { n: index + 1, total: settings.engines.length, name: getSttEngineName(engine, translate) }));
    lines.push(problem === null ? translate('stt.card.ready') : translate(`stt.card.problem.${problem}`));
  }
  lines.push(translate('stt.card.timeout', { base: timeout.baseSeconds, percent: timeout.percentOfDuration }));
  if (engine.kind === 'url') lines.push(translate('stt.card.url', { url: formatUrlForDisplay(engine.url ?? '') }));
  if (!isLocal) lines.push(translate(engine.apiKey ? 'stt.card.keySet' : 'stt.card.keyMissing'));

  const commonRow: SttButton[] = [];
  if (index > 0) commonRow.push({ text: translate('limits.btnUp'), data: buildSttCallback('up', [engine.id], revision) });
  if (index < settings.engines.length - 1) commonRow.push({ text: translate('limits.btnDown'), data: buildSttCallback('dn', [engine.id], revision) });
  commonRow.push({ text: translate(engine.isDisabled ? 'limits.btnUse' : 'limits.btnDontUse'), data: buildSttCallback('us', [engine.id], revision) });
  const rows: SttButton[][] = [
    commonRow,
    [{ text: translate('stt.btn.timeoutValue', { value: formatTimeoutSummary(timeout) }), data: buildSttCallback('tm', [engine.id], revision) }],
  ];
  if (isLocal) {
    rows.push(...buildLocalCardRows(input, engine, translate, revision));
    const removal: SttButton[] = [{ text: translate('stt.btn.removeFromList'), data: buildSttCallback('ra', [engine.id], revision) }];
    if (input.isLocalInstalled && !input.installing) removal.push({ text: translate('stt.btn.removeLocal'), data: buildSttCallback('fa', [engine.id], revision) });
    rows.push(removal);
  } else {
    rows.push([{ text: translate(engine.apiKey ? 'stt.btn.changeKey' : 'stt.btn.addKey'), data: buildSttCallback('ky', [engine.id], revision) }]);
    rows.push([{ text: translate('account.removeButton'), data: buildSttCallback('ra', [engine.id], revision) }]);
  }
  rows.push([{ text: translate('fallback.backButton'), data: buildSttCallback('bk', [], revision) }]);
  return { text: withNotice(notice, lines.join('\n')), rows };
}

function buildPresetRow(
  values: readonly number[],
  current: number,
  action: SttAction,
  engineId: string | null,
  revision: string,
  format: (value: number) => string,
): SttButton[] {
  return values.map((value) => ({
    text: `${format(value)}${value === current ? ' ✓' : ''}`,
    data: buildSttCallback(action, engineId === null ? [value] : [engineId, value], revision),
  }));
}

function buildBackRow(translate: SttTranslate, revision: string, engineId?: string): SttButton[] {
  return [{ text: translate('fallback.backButton'), data: engineId ? buildSttCallback('oe', [engineId], revision) : buildSttCallback('bk', [], revision) }];
}

/**
 * @description The screen for `screen`, or `null` when it names something that is gone (an engine removed by a
 * hand edit): the caller falls back to the main screen. `notice` is a one-line result of the tap that led here.
 */
export function buildSttScreen(screen: SttScreenId, input: SttScreenInput, translate: SttTranslate, notice?: string): SttScreen | null {
  const { settings } = input.resolved;
  const revision = computeSttRevision(settings);
  switch (screen.id) {
    case 'main':
      return buildMainScreen(input, translate, notice);
    case 'card':
      return buildEngineCard(input, screen.engineId, translate, notice);
    case 'timeout': {
      const engine = settings.engines.find((candidate) => candidate.id === screen.engineId);
      if (!engine) return null;
      const timeout = engine.timeout ?? defaultSttTimeout;
      return {
        text: withNotice(notice, translate('stt.timeout.title', { name: getSttEngineName(engine, translate) })),
        rows: [
          buildPresetRow(sttTimeoutBasePresets, timeout.baseSeconds, 'tb', engine.id, revision, (value) => translate('stt.timeout.seconds', { count: value })),
          buildPresetRow(sttTimeoutPercentPresets, timeout.percentOfDuration, 'tp', engine.id, revision, (value) => `${value} ${percentSign}`),
          buildBackRow(translate, revision, engine.id),
        ],
      };
    }
    case 'add': {
      const rows: SttButton[][] = [
        [{ text: 'Groq', data: buildSttCallback('an', ['gq'], revision) }, { text: 'OpenAI', data: buildSttCallback('an', ['oa'], revision) }],
        [{ text: translate('stt.btn.customUrl'), data: buildSttCallback('an', ['ur'], revision) }],
      ];
      // Always offered while it is not in the list: installed it joins at once, else the install is offered first.
      if (!settings.engines.some((engine) => engine.kind === 'gigaam')) {
        rows.push([{ text: translate('stt.engine.gigaam'), data: buildSttCallback('an', ['gg'], revision) }]);
      }
      rows.push(buildBackRow(translate, revision));
      return { text: withNotice(notice, translate('stt.add.title')), rows };
    }
    case 'language': {
      const current = settings.language;
      const rows: SttButton[][] = [
        [{ text: `${translate('stt.language.auto')}${current === null ? ' ✓' : ''}`, data: buildSttCallback('ls', ['auto'], revision) }],
        sttLanguagePresets.map((code) => ({ text: `${code}${code === current ? ' ✓' : ''}`, data: buildSttCallback('ls', [code], revision) })),
        buildBackRow(translate, revision),
      ];
      return { text: withNotice(notice, translate('stt.language.title')), rows };
    }
    case 'idle':
      return {
        text: withNotice(notice, translate('stt.idle.title')),
        rows: [
          buildPresetRow(sttIdleMinutesPresets, settings.gigaam.idleMinutes, 'is', screen.engineId, revision, (value) => formatIdleMinutes(value, translate)),
          buildBackRow(translate, revision, screen.engineId),
        ],
      };
    case 'workers':
      return {
        text: withNotice(notice, translate('stt.workers.title')),
        rows: [
          buildPresetRow(sttGigaamWorkerChoices, settings.gigaam.workers, 'ws', screen.engineId, revision, (value) => value.toString()),
          buildBackRow(translate, revision, screen.engineId),
        ],
      };
    case 'enableConfirm':
      return {
        text: withNotice(notice, translate('stt.enable.confirm', { idle: formatIdleMinutes(settings.gigaam.idleMinutes, translate) })),
        rows: [[
          { text: translate('stt.btn.install'), data: buildSttCallback('ei', [], revision) },
          { text: translate('stt.btn.cancel'), data: buildSttCallback('bk', [], revision) },
        ]],
      };
    case 'removeEngineConfirm': {
      const engine = settings.engines.find((candidate) => candidate.id === screen.engineId);
      if (!engine) return null;
      return {
        text: withNotice(notice, engine.kind === 'gigaam' ? translate('stt.removeEngine.confirmLocal') : translate('stt.removeEngine.confirm', { name: getSttEngineName(engine, translate) })),
        rows: [[
          { text: translate('stt.btn.removeConfirm'), data: buildSttCallback('rd', [engine.id], revision) },
          { text: translate('stt.btn.cancel'), data: buildSttCallback('oe', [engine.id], revision) },
        ]],
      };
    }
    case 'removeFilesConfirm':
      return {
        text: withNotice(notice, translate('stt.removeFiles.confirm')),
        rows: [[
          { text: translate('stt.btn.removeConfirm'), data: buildSttCallback('fd', [screen.engineId], revision) },
          { text: translate('stt.btn.cancel'), data: buildSttCallback('oe', [screen.engineId], revision) },
        ]],
      };
    case 'keyChoice':
      return {
        text: withNotice(notice, translate('stt.prompt.needsKey')),
        rows: [[
          { text: translate('stt.btn.keyYes'), data: buildSttCallback('ku', ['y'], revision) },
          { text: translate('stt.btn.keyNo'), data: buildSttCallback('ku', ['n'], revision) },
        ], [{ text: translate('stt.btn.cancel'), data: buildSttCallback('cn', [], revision) }]],
      };
  }
}

/** @description The one-button keyboard under a pasted-input prompt. */
export function buildSttCancelRow(translate: SttTranslate, revision: string): SttButton[][] {
  return [[{ text: translate('stt.btn.cancel'), data: buildSttCallback('cn', [], revision) }]];
}

// ── typed input: the URL and the key ──

export type SttInputStep = 'url' | 'key';

export type SttInputDecision =
  | { outcome: 'accept'; value: string }
  | { outcome: 'retry'; hint: 'invalidUrl' | 'invalidKey' }
  /** The message may carry a secret (a login inside the address): it is deleted, then the step re-arms. */
  | { outcome: 'retryAndDelete'; hint: 'urlHasCredentials' };

/**
 * @description What to do with the text typed at an armed `/stt` step. A key that cannot be one (spaces,
 * non-Latin-1, too short or long) stays VISIBLE — it is not a secret — and the step re-arms; a plausible key is
 * accepted and the caller deletes the message at once.
 */
export function decideSttInput(step: SttInputStep, text: string): SttInputDecision {
  if (step === 'key') {
    const key = text.trim();
    return checkIsPlausibleProviderApiKey(key) ? { outcome: 'accept', value: key } : { outcome: 'retry', hint: 'invalidKey' };
  }
  const normalised = normaliseSttUrl(text);
  if (normalised.ok) return { outcome: 'accept', value: normalised.url };
  return normalised.reason === 'credentials' ? { outcome: 'retryAndDelete', hint: 'urlHasCredentials' } : { outcome: 'retry', hint: 'invalidUrl' };
}

// ── the tap reducer ──

/** A one-line result shown on the screen the tap leads to (or as the callback toast). */
export interface SttNotice {
  code: string;
  vars?: Record<string, string | number>;
}

/** Which kind of key paste a tap arms. */
export type SttKeyTarget = { kind: 'engine'; engineId: string } | { kind: 'newKeyed'; engineKind: 'groq' | 'openai' } | { kind: 'newUrl'; url: string };

export type SttEffect = 'install' | 'attachInstall' | 'removeFiles' | 'resetGuard' | 'close';

export type SttActionOutcome =
  /** The keyboard is out of date (the file changed, or the engine is gone): say so and re-render the main screen. */
  | { kind: 'stale' }
  | { kind: 'show'; screen: SttScreenId }
  | { kind: 'save'; config: SttConfigFile; screen: SttScreenId; notice?: SttNotice }
  | { kind: 'armKey'; target: SttKeyTarget }
  | { kind: 'armUrl' }
  | { kind: 'cancelInput' }
  /** `screen`: what to show once the effect is done (default: the main screen). */
  | { kind: 'effect'; effect: SttEffect; screen?: SttScreenId };

export interface SttReducerContext {
  config: SttConfigFile;
  isLocalInstalled: boolean;
  isLocalInstalling: boolean;
  /** The address typed at the custom-URL step, waiting for "does it need a key?". */
  pendingUrl: string | null;
}

function fromEdit(result: SttEditResult, screen: SttScreenId, notice?: SttNotice): SttActionOutcome {
  return result.ok ? { kind: 'save', config: result.config, screen, notice } : { kind: 'stale' };
}

function parseNumberArg(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

/**
 * @description «GigaAM (local)» in the add menu: already installed → it joins the list first and its card opens;
 * an install running → attach to its progress; not installed → the install confirmation (the engine joins the list,
 * and its card opens, when the install ends).
 */
function addLocalEngine(config: SttConfigFile, context: SttReducerContext): SttActionOutcome {
  if (config.engines.some((engine) => engine.kind === 'gigaam')) return { kind: 'stale' };
  if (context.isLocalInstalling) return { kind: 'effect', effect: 'attachInstall' };
  if (!context.isLocalInstalled) return { kind: 'show', screen: { id: 'enableConfirm' } };
  const added = addSttEngine(config, { kind: 'gigaam' });
  if (!added.ok || added.engineId === undefined) return { kind: 'stale' };
  return { kind: 'save', config: added.config, screen: { id: 'card', engineId: added.engineId }, notice: { code: 'stt.notice.localAdded' } };
}

/**
 * @description What a `/stt` tap does, decided from the callback and the current settings alone — no Telegram, no
 * disk: a screen to show, a config to save, an input to arm, or an effect to run. A revision that is not the
 * file's current one is `stale` for every tap that could change something.
 */
export function reduceSttAction(parsed: ParsedSttCallback, context: SttReducerContext): SttActionOutcome {
  const { config } = context;
  if (!revisionFreeActions.has(parsed.action) && parsed.revision !== computeSttRevision(config)) return { kind: 'stale' };
  const [first, second] = parsed.args;
  const engine = config.engines.find((candidate) => candidate.id === first);
  const needsEngine = (run: (known: SttEngineSetting) => SttActionOutcome): SttActionOutcome => (engine ? run(engine) : { kind: 'stale' });
  const needsLocalEngine = (run: (known: SttEngineSetting) => SttActionOutcome): SttActionOutcome => (engine?.kind === 'gigaam' ? run(engine) : { kind: 'stale' });
  const canTouchFiles = context.isLocalInstalled && !context.isLocalInstalling;

  switch (parsed.action) {
    case 'bk': return { kind: 'show', screen: { id: 'main' } };
    case 'cl': return { kind: 'effect', effect: 'close' };
    case 'cn': return { kind: 'cancelInput' };
    case 'oe': return needsEngine((known) => ({ kind: 'show', screen: { id: 'card', engineId: known.id } }));
    case 'up': return needsEngine((known) => fromEdit(moveSttEngine(config, known.id, -1), { id: 'card', engineId: known.id }));
    case 'dn': return needsEngine((known) => fromEdit(moveSttEngine(config, known.id, 1), { id: 'card', engineId: known.id }));
    case 'us': return needsEngine((known) => fromEdit(toggleSttEngineDisabled(config, known.id), { id: 'card', engineId: known.id }));
    case 'tm': return needsEngine((known) => ({ kind: 'show', screen: { id: 'timeout', engineId: known.id } }));
    case 'tb':
    case 'tp': {
      const value = parseNumberArg(second);
      if (!engine || value === null) return { kind: 'stale' };
      const change = parsed.action === 'tb' ? { baseSeconds: value } : { percentOfDuration: value };
      return fromEdit(setSttEngineTimeout(config, engine.id, change, defaultSttTimeout), { id: 'timeout', engineId: engine.id });
    }
    case 'ky': return needsEngine((known) => (known.kind === 'gigaam' ? { kind: 'stale' } : { kind: 'armKey', target: { kind: 'engine', engineId: known.id } }));
    case 'ra': return needsEngine((known) => ({ kind: 'show', screen: { id: 'removeEngineConfirm', engineId: known.id } }));
    case 'rd': return needsEngine((known) => fromEdit(removeSttEngine(config, known.id), { id: 'main' }, { code: 'stt.notice.removed' }));
    case 'ad': return { kind: 'show', screen: { id: 'add' } };
    case 'an':
      if (first === 'gq' || first === 'oa') return { kind: 'armKey', target: { kind: 'newKeyed', engineKind: first === 'gq' ? 'groq' : 'openai' } };
      if (first === 'ur') return { kind: 'armUrl' };
      if (first === 'gg') return addLocalEngine(config, context);
      return { kind: 'stale' };
    case 'ku':
      if (context.pendingUrl === null) return { kind: 'stale' };
      if (first === 'y') return { kind: 'armKey', target: { kind: 'newUrl', url: context.pendingUrl } };
      if (first === 'n') return fromEdit(addSttEngine(config, { kind: 'url', url: context.pendingUrl }), { id: 'main' }, { code: 'stt.notice.urlAdded' });
      return { kind: 'stale' };
    case 'lg': return { kind: 'show', screen: { id: 'language' } };
    case 'ls': {
      if (first === 'auto') return fromEdit(setSttLanguage(config, null), { id: 'main' });
      if (first !== undefined && sttLanguagePresets.includes(first)) return fromEdit(setSttLanguage(config, first), { id: 'main' });
      return { kind: 'stale' };
    }
    case 'im': return needsLocalEngine((known) => ({ kind: 'show', screen: { id: 'idle', engineId: known.id } }));
    case 'is': {
      const minutes = parseNumberArg(second);
      return engine?.kind === 'gigaam' && minutes !== null && sttIdleMinutesPresets.includes(minutes)
        ? fromEdit(setSttIdleMinutes(config, minutes), { id: 'card', engineId: engine.id })
        : { kind: 'stale' };
    }
    case 'wm': return needsLocalEngine((known) => ({ kind: 'show', screen: { id: 'workers', engineId: known.id } }));
    case 'ws': {
      const workers = parseNumberArg(second);
      return engine?.kind === 'gigaam' && workers !== null && sttGigaamWorkerChoices.includes(workers)
        ? fromEdit(setSttWorkers(config, workers), { id: 'card', engineId: engine.id })
        : { kind: 'stale' };
    }
    case 'rt': return needsLocalEngine((known) => ({ kind: 'effect', effect: 'resetGuard', screen: { id: 'card', engineId: known.id } }));
    case 'ec': return context.isLocalInstalled || context.isLocalInstalling ? { kind: 'stale' } : { kind: 'show', screen: { id: 'enableConfirm' } };
    case 'ei':
    case 'er': return context.isLocalInstalled || context.isLocalInstalling ? { kind: 'stale' } : { kind: 'effect', effect: 'install' };
    case 'ip': return context.isLocalInstalling ? { kind: 'effect', effect: 'attachInstall' } : { kind: 'stale' };
    case 'fa': return needsLocalEngine((known) => (canTouchFiles ? { kind: 'show', screen: { id: 'removeFilesConfirm', engineId: known.id } } : { kind: 'stale' }));
    case 'fd': return needsLocalEngine(() => (canTouchFiles ? { kind: 'effect', effect: 'removeFiles' } : { kind: 'stale' }));
  }
}
