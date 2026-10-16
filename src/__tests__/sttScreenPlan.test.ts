/**
 * @description The `/stt` screens as data: what each state of the settings shows (text lines and buttons), the
 * callback data (at most 64 bytes, a revision baked in, a stale one refused), the key-paste decision table and
 * the reducer that turns a tap into a screen, a save, an armed input or an effect.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getRecvTracePreview, redactedConnectKeyPreview, redactedSttKeyPreview } from '../utils/recvPreviewRedaction';
import {
  buildSttCallback,
  buildSttScreen,
  computeSttRevision,
  decideSttInput,
  getSttEngineName,
  getSttLocalStatus,
  parseSttCallback,
  reduceSttAction,
  sttCallbackMaxBytes,
  sttCallbackRe,
  type ParsedSttCallback,
  type SttReducerContext,
  type SttScreen,
  type SttScreenInput,
  type SttTranslate,
} from '../stt/sttScreenPlan';
import {
  createEmptySttConfig,
  resolveSttSettings,
  type SttConfigFile,
  type SttConfigLoad,
  type SttFacts,
} from '../stt/sttSettings';
import type { SttInstallProgress } from '../stt/sttInstall';

const echo: SttTranslate = (code, vars) =>
  vars ? `${code}(${Object.entries(vars).map(([name, value]) => `${name}=${value}`).join(',')})` : code;

const sampleKey = 'gsk_sampleSecretKey1234567890';
const groq = { id: 'q1', kind: 'groq' as const, apiKey: sampleKey };
const local = { id: 'g', kind: 'gigaam' as const };

const readyFacts: SttFacts = { isGigaamInstalled: true, isGigaamInstalling: false, isGigaamUnhealthy: false, hasOwnerContext: true };

function createInput(
  config: SttConfigFile,
  overrides: Partial<SttScreenInput> & { load?: SttConfigLoad; facts?: Partial<SttFacts> } = {},
): SttScreenInput {
  const { load, facts, ...rest } = overrides;
  const resolved = resolveSttSettings(load ?? { status: 'ok', config }, { ...readyFacts, ...facts }, {
    getGigaamEndpoint: async () => ({ url: 'http://127.0.0.1:1/x', model: 'm' }),
  });
  return {
    resolved,
    configPath: '/secrets/stt.json',
    isLocalInstalled: true,
    installing: null,
    sidecar: { state: 'notRunning' },
    hasOwnerContext: true,
    ...rest,
  };
}

function configOf(...engines: SttConfigFile['engines']): SttConfigFile {
  return { ...createEmptySttConfig(), engines };
}

function allButtons(screen: SttScreen): Array<{ text: string; data: string }> {
  return screen.rows.flat();
}

function mainScreen(input: SttScreenInput): SttScreen {
  const screen = buildSttScreen({ id: 'main' }, input, echo);
  assert.ok(screen);
  return screen;
}

test('callback data: action, arguments and revision round-trip, and stay within 64 bytes even at the longest', () => {
  const revision = 'a1b2c3';
  const data = buildSttCallback('tb', ['q12345', 30], revision);
  assert.equal(data, 'stt_tb_q12345_30_a1b2c3');
  assert.deepEqual(parseSttCallback(data), { action: 'tb', args: ['q12345', '30'], revision });
  assert.deepEqual(parseSttCallback(buildSttCallback('ad', [], revision)), { action: 'ad', args: [], revision });
  assert.ok(sttCallbackRe.test(data));

  const longest = buildSttCallback('tp', ['abcdefgh', 100], revision);
  assert.ok(Buffer.byteLength(longest) <= sttCallbackMaxBytes, longest);
});

test('callback data: anything that is not a /stt callback does not parse', () => {
  for (const data of ['', 'stt', 'stt_ad', 'stt_ad_zzzzzz', 'stt_ADD_a1b2c3', 'fbk_ad_a1b2c3', 'stt_ad_a1b2c', 'stt_ad__a1b2c3', 'stt_ad_a-b_a1b2c3']) {
    assert.equal(parseSttCallback(data), null, data);
    assert.equal(sttCallbackRe.test(data), false, data);
  }
});

test('every button of every screen is a valid callback of at most 64 bytes with the file\'s revision baked in', () => {
  const config = configOf(local, groq, { id: 'u1', kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' });
  const input = createInput(config, { sidecar: { state: 'unhealthy', unhealthyUntil: 1 } });
  const revision = computeSttRevision(config);
  const screens = [
    { id: 'main' }, { id: 'card', engineId: 'q1' }, { id: 'card', engineId: 'g' }, { id: 'timeout', engineId: 'u1' }, { id: 'add' }, { id: 'language' },
    { id: 'idle' }, { id: 'workers' }, { id: 'enableConfirm' }, { id: 'removeEngineConfirm', engineId: 'q1' }, { id: 'removeFilesConfirm' }, { id: 'keyChoice' },
  ] as const;
  for (const id of screens) {
    const screen = buildSttScreen(id, input, echo);
    assert.ok(screen, id.id);
    for (const button of allButtons(screen)) {
      assert.ok(Buffer.byteLength(button.data) <= sttCallbackMaxBytes, `${id.id}: ${button.data}`);
      const parsed = parseSttCallback(button.data);
      assert.ok(parsed, `${id.id}: ${button.data}`);
      assert.equal(parsed.revision, revision, `${id.id}: ${button.data}`);
    }
  }
});

test('the revision follows the file: any change to the settings changes it, the same settings keep it', () => {
  const config = configOf(groq);
  assert.equal(computeSttRevision(config), computeSttRevision(configOf({ ...groq })));
  assert.notEqual(computeSttRevision(config), computeSttRevision({ ...config, language: 'ru' }));
  assert.notEqual(computeSttRevision(config), computeSttRevision(configOf({ ...groq, apiKey: 'gsk_anotherKey1234567' })));
  assert.match(computeSttRevision(config), /^[0-9a-f]{6}$/);
});

test('main screen, migrated Groq only: one row for Groq, the local engine not installed with the enable button', () => {
  const screen = mainScreen(createInput(configOf(groq), { isLocalInstalled: false, facts: { isGigaamInstalled: false }, load: { status: 'ok', config: configOf(groq) } }));
  assert.match(screen.text, /stt\.screen\.sourceFile\(path=\/secrets\/stt\.json\)/);
  assert.match(screen.text, /stt\.screen\.language\(language=stt\.language\.autoName\)/);
  assert.match(screen.text, /stt\.screen\.local\.notInstalled/);
  assert.match(screen.text, /stt\.screen\.chainHeading/);
  const labels = allButtons(screen).map((button) => button.text);
  assert.ok(labels.includes('1. Groq · 10s+25% · ✓'), labels.join(' | '));
  assert.ok(labels.includes('stt.btn.enableLocal'));
  assert.ok(!labels.includes('stt.btn.removeLocal'));
  assert.ok(!labels.some((label) => label.startsWith('stt.btn.idle') || label.startsWith('stt.btn.workers')), 'no local-engine knobs while it is not in the chain');
});

test('main screen, local engine first and installed: rows in order with marks, the knobs and the remove button', () => {
  const config = { ...configOf(local, groq), language: 'ru', gigaam: { idleMinutes: 15, workers: 4 } };
  const screen = mainScreen(createInput(config));
  const labels = allButtons(screen).map((button) => button.text);
  assert.deepEqual(labels.slice(0, 2), ['1. stt.engine.gigaam · 10s+25% · ✓', '2. Groq · 10s+25% · ✓']);
  assert.ok(labels.includes('stt.btn.idle(value=stt.idle.minutes(count=15))'));
  assert.ok(labels.includes('stt.btn.workers(count=4)'));
  assert.ok(labels.includes('stt.btn.language(language=ru)'));
  assert.ok(labels.includes('stt.btn.removeLocal'));
  assert.ok(!labels.includes('stt.btn.enableLocal'));
  assert.match(screen.text, /stt\.screen\.local\.ready/);
  assert.ok(!screen.text.includes('stt.screen.languageNote'));
});

test('main screen: a language other than ru marks the local engine ✗ and says why; a disabled engine is ✗ too; never exits shows "never"', () => {
  const config = { ...configOf(local, { ...groq, isDisabled: true }), language: 'en', gigaam: { idleMinutes: 0, workers: 8 } };
  const screen = mainScreen(createInput(config));
  const labels = allButtons(screen).map((button) => button.text);
  assert.deepEqual(labels.slice(0, 2), ['1. stt.engine.gigaam · 10s+25% · ✗', '2. Groq · 10s+25% · ✗']);
  assert.match(screen.text, /stt\.screen\.languageNote/);
  assert.ok(labels.includes('stt.btn.idle(value=stt.idle.never)'));
});

test('main screen, invalid file: the last good settings stay in force and the first error is shown; with none, voice is off', () => {
  const good = configOf(groq);
  const kept = mainScreen(createInput(good, { load: { status: 'invalid', config: good, errors: ['stt.json engines.1.kind: bad', 'second'] } }));
  assert.match(kept.text, /stt\.screen\.sourceLastGood\(path=\/secrets\/stt\.json,error=stt\.json engines\.1\.kind: bad\)/);
  assert.ok(allButtons(kept).some((button) => button.text.startsWith('1. Groq')));

  const none = mainScreen(createInput(createEmptySttConfig(), { load: { status: 'invalid', config: null, errors: ['stt.json is not valid JSON'] } }));
  assert.match(none.text, /stt\.screen\.sourceInvalid\(path=\/secrets\/stt\.json,error=stt\.json is not valid JSON\)/);
  assert.match(none.text, /stt\.screen\.chainEmpty/);

  const missing = mainScreen(createInput(createEmptySttConfig(), { load: { status: 'missing', config: createEmptySttConfig() } }));
  assert.match(missing.text, /stt\.screen\.sourceMissing/);
});

test('main screen, installing: the status shows the phase and the button attaches to the install instead of starting one', () => {
  const progress: SttInstallProgress = { phase: 'downloadingModel', detail: '120/216 MB', bytesDownloaded: 1 };
  const screen = mainScreen(createInput(configOf(groq), { isLocalInstalled: false, installing: progress, facts: { isGigaamInstalled: false, isGigaamInstalling: true } }));
  assert.match(screen.text, /stt\.screen\.local\.installing\(phase=stt\.install\.downloadingModel\(progress=120\/216 MB\)\)/);
  const labels = allButtons(screen).map((button) => button.text);
  assert.ok(labels.includes('stt.btn.showProgress'));
  assert.ok(!labels.includes('stt.btn.enableLocal'));
  assert.ok(!labels.includes('stt.btn.removeLocal'));
});

test('main screen, process states: ready not running, running idle, running busy, unhealthy with the retry button', () => {
  const config = configOf(local);
  const textFor = (sidecar: SttScreenInput['sidecar'], facts: Partial<SttFacts> = {}): SttScreen => mainScreen(createInput(config, { sidecar, facts }));
  assert.match(textFor({ state: 'notRunning' }).text, /stt\.screen\.local\.ready/);
  assert.match(textFor({ state: 'running', busyRequests: 0 }).text, /stt\.screen\.local\.running(?!Busy)/);
  assert.match(textFor({ state: 'running', busyRequests: 3 }).text, /stt\.screen\.local\.runningBusy\(count=3\)/);
  assert.match(textFor({ state: 'running' }).text, /stt\.screen\.local\.runningSlow/, 'alive but too busy to answer /health');

  const untilMs = new Date(2026, 9, 16, 14, 5, 0).getTime();
  const unhealthy = textFor({ state: 'unhealthy', unhealthyUntil: untilMs }, { isGigaamUnhealthy: true });
  assert.match(unhealthy.text, /stt\.screen\.local\.unhealthy\(until=14:05\)/);
  assert.ok(allButtons(unhealthy).some((button) => button.text === 'stt.btn.tryAgain'));
  assert.ok(!allButtons(textFor({ state: 'notRunning' })).some((button) => button.text === 'stt.btn.tryAgain'), 'the retry button only shows while unhealthy');

  const withoutOwner = mainScreen(createInput(config, { hasOwnerContext: false, facts: { hasOwnerContext: false } }));
  assert.match(withoutOwner.text, /stt\.screen\.local\.noOwner/);
});

test('local status precedence: installing and not installed outrank the process state', () => {
  const base = createInput(configOf(local));
  assert.deepEqual(getSttLocalStatus({ ...base, isLocalInstalled: false, sidecar: { state: 'running', busyRequests: 1 } }), { state: 'notInstalled' });
  assert.equal(getSttLocalStatus({ ...base, installing: { phase: 'checking', detail: '', bytesDownloaded: 0 } }).state, 'installing');
  assert.equal(getSttLocalStatus({ ...base, hasOwnerContext: false }).state, 'noOwner');
});

test('engine card: state, timeout, key and the buttons that fit the kind and position', () => {
  const config = configOf(local, groq, { id: 'u1', kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' });
  const input = createInput(config);
  const first = buildSttScreen({ id: 'card', engineId: 'g' }, input, echo);
  assert.ok(first);
  assert.match(first.text, /stt\.card\.title\(n=1,total=3,name=stt\.engine\.gigaam\)/);
  assert.match(first.text, /stt\.card\.ready/);
  assert.ok(!first.text.includes('stt.card.keySet'), 'the local engine has no key');
  const firstLabels = allButtons(first).map((button) => button.text);
  assert.ok(!firstLabels.includes('limits.btnUp'), 'nothing above the first');
  assert.ok(firstLabels.includes('limits.btnDown') && firstLabels.includes('limits.btnDontUse') && firstLabels.includes('stt.btn.timeout'));
  assert.ok(!firstLabels.includes('stt.btn.changeKey') && !firstLabels.includes('stt.btn.addKey'));

  const keyed = buildSttScreen({ id: 'card', engineId: 'q1' }, input, echo);
  assert.ok(keyed);
  assert.match(keyed.text, /stt\.card\.keySet/);
  assert.ok(allButtons(keyed).some((button) => button.text === 'stt.btn.changeKey'));

  const url = buildSttScreen({ id: 'card', engineId: 'u1' }, input, echo);
  assert.ok(url);
  assert.match(url.text, /stt\.card\.url\(url=http:\/\/stt\.local:8000\/v1\/audio\/transcriptions\)/);
  assert.match(url.text, /stt\.card\.keyMissing/);
  assert.ok(allButtons(url).some((button) => button.text === 'stt.btn.addKey'));
  assert.ok(!allButtons(url).some((button) => button.text === 'limits.btnDown'), 'nothing below the last');
});

test('engine card: the address is shown without its query string, which may carry a token', () => {
  const config = configOf({ id: 'u1', kind: 'url', url: 'https://stt.example/v1/audio/transcriptions?token=sekrit-value&x=1#frag' });
  const card = buildSttScreen({ id: 'card', engineId: 'u1' }, createInput(config), echo);
  assert.ok(card);
  assert.match(card.text, /stt\.card\.url\(url=https:\/\/stt\.example\/v1\/audio\/transcriptions\)/);
  assert.ok(!card.text.includes('sekrit-value'));
});

test('engine card: a skipped engine says why, a disabled one offers "use"', () => {
  const noKey = { id: 'o1', kind: 'openai' as const };
  const input = createInput(configOf(noKey, { ...groq, isDisabled: true }));
  const missing = buildSttScreen({ id: 'card', engineId: 'o1' }, input, echo);
  assert.ok(missing);
  assert.match(missing.text, /stt\.card\.problem\.missingKey/);
  const disabled = buildSttScreen({ id: 'card', engineId: 'q1' }, input, echo);
  assert.ok(disabled);
  assert.match(disabled.text, /stt\.card\.problem\.disabled/);
  assert.ok(allButtons(disabled).some((button) => button.text === 'limits.btnUse'));
  assert.equal(buildSttScreen({ id: 'card', engineId: 'gone' }, input, echo), null, 'a removed engine has no card');
});

test('timeout screen: both preset rows with a ✓ on the current values', () => {
  const config = configOf({ ...groq, timeout: { baseSeconds: 20, percentOfDuration: 50 } });
  const screen = buildSttScreen({ id: 'timeout', engineId: 'q1' }, createInput(config), echo);
  assert.ok(screen);
  const [baseRow, percentRow] = screen.rows;
  assert.deepEqual(baseRow.map((button) => button.text), ['stt.timeout.seconds(count=5)', 'stt.timeout.seconds(count=10)', 'stt.timeout.seconds(count=20) ✓', 'stt.timeout.seconds(count=30)']);
  assert.deepEqual(percentRow.map((button) => button.text), ['10 %', '25 %', '50 % ✓', '100 %']);
  assert.match(baseRow[2].data, /^stt_tb_q1_20_[0-9a-f]{6}$/);
  assert.match(percentRow[3].data, /^stt_tp_q1_100_[0-9a-f]{6}$/);
});

test('language, idle and workers screens mark the current value; the add screen offers the local engine only when installed and not listed', () => {
  const config = { ...configOf(local), language: 'ru', gigaam: { idleMinutes: 30, workers: 2 } };
  const input = createInput(config);
  const language = buildSttScreen({ id: 'language' }, input, echo);
  assert.ok(language);
  assert.ok(allButtons(language).some((button) => button.text === 'ru ✓'));
  assert.ok(allButtons(language).some((button) => button.text === 'stt.language.auto'));
  const idle = buildSttScreen({ id: 'idle' }, input, echo);
  assert.ok(idle);
  assert.deepEqual(idle.rows[0].map((button) => button.text), ['stt.idle.minutes(count=5)', 'stt.idle.minutes(count=15)', 'stt.idle.minutes(count=30) ✓', 'stt.idle.minutes(count=60)', 'stt.idle.never']);
  const workers = buildSttScreen({ id: 'workers' }, input, echo);
  assert.ok(workers);
  assert.deepEqual(workers.rows[0].map((button) => button.text), ['1', '2 ✓', '4', '8']);

  const listed = buildSttScreen({ id: 'add' }, input, echo);
  assert.ok(listed);
  assert.ok(!allButtons(listed).some((button) => button.text === 'stt.engine.gigaam'), 'already in the chain');
  const offered = buildSttScreen({ id: 'add' }, createInput(configOf(groq)), echo);
  assert.ok(offered);
  assert.ok(allButtons(offered).some((button) => button.text === 'stt.engine.gigaam'));
  const notInstalled = buildSttScreen({ id: 'add' }, createInput(configOf(groq), { isLocalInstalled: false }), echo);
  assert.ok(notInstalled);
  assert.ok(!allButtons(notInstalled).some((button) => button.text === 'stt.engine.gigaam'));
});

test('engine names: the local engine is translated, Groq / OpenAI are brands, a custom server is its host', () => {
  assert.equal(getSttEngineName(local, echo), 'stt.engine.gigaam');
  assert.equal(getSttEngineName(groq, echo), 'Groq');
  assert.equal(getSttEngineName({ id: 'o1', kind: 'openai' }, echo), 'OpenAI');
  assert.equal(getSttEngineName({ id: 'u1', kind: 'url', url: 'https://stt.example:9000/x' }, echo), 'stt.example:9000');
  assert.equal(getSttEngineName({ id: 'u2', kind: 'url' }, echo), 'stt.engine.url');
});

test('a notice is put in front of the screen it belongs to', () => {
  const screen = buildSttScreen({ id: 'main' }, createInput(configOf(groq)), echo, 'saved!');
  assert.ok(screen?.text.startsWith('saved!\n\n'));
});

// ── the key-paste decision table ──

test('key input: a plausible key is accepted trimmed; an empty, spaced, non-Latin or too short/long one stays visible and re-arms', () => {
  assert.deepEqual(decideSttInput('key', `  ${sampleKey}\n`), { outcome: 'accept', value: sampleKey });
  for (const text of ['', '   ', 'short', 'two words in a message', 'я перезагрузил сервис', 'x'.repeat(4097), 'tab\tseparated12345']) {
    assert.deepEqual(decideSttInput('key', text), { outcome: 'retry', hint: 'invalidKey' }, JSON.stringify(text.slice(0, 20)));
  }
});

test('url input: a base address is completed, a bad one re-arms, one with a login is deleted and re-arms', () => {
  assert.deepEqual(decideSttInput('url', 'http://stt.local:8000'), { outcome: 'accept', value: 'http://stt.local:8000/v1/audio/transcriptions' });
  assert.deepEqual(decideSttInput('url', 'not an address'), { outcome: 'retry', hint: 'invalidUrl' });
  assert.deepEqual(decideSttInput('url', 'http://me:pw@stt.local/v1'), { outcome: 'retryAndDelete', hint: 'urlHasCredentials' });
});

test('the recv trace never records a pasted speech-engine key — only while that step is armed', () => {
  assert.equal(getRecvTracePreview(sampleKey, false, true), redactedSttKeyPreview);
  assert.equal(redactedSttKeyPreview, '[redacted: speech engine key]');
  assert.equal(getRecvTracePreview(sampleKey, false, false), sampleKey, 'unarmed text is recorded as before');
  assert.equal(getRecvTracePreview('/stt', false, true), '/stt', 'a command cancels the paste, so it is not a secret');
  assert.equal(getRecvTracePreview(sampleKey, true, false), redactedConnectKeyPreview, 'the /connect redaction is unchanged');
  assert.equal(getRecvTracePreview('/connect sk-inline-secret-1234', false, true), '/connect <redacted>');
});

// ── the reducer ──

function tap(config: SttConfigFile, action: Parameters<typeof buildSttCallback>[0], args: Array<string | number> = [], overrides: Partial<SttReducerContext> = {}, revision?: string) {
  const parsed: ParsedSttCallback = parseSttCallback(buildSttCallback(action, args, revision ?? computeSttRevision(config)))!;
  return reduceSttAction(parsed, { config, isLocalInstalled: true, isLocalInstalling: false, pendingUrl: null, ...overrides });
}

test('reducer: navigation shows screens, and a stale revision is refused for every edit but not for back / close / cancel', () => {
  const config = configOf(local, groq);
  assert.deepEqual(tap(config, 'oe', ['q1']), { kind: 'show', screen: { id: 'card', engineId: 'q1' } });
  assert.deepEqual(tap(config, 'tm', ['q1']), { kind: 'show', screen: { id: 'timeout', engineId: 'q1' } });
  assert.deepEqual(tap(config, 'ad'), { kind: 'show', screen: { id: 'add' } });
  assert.deepEqual(tap(config, 'lg'), { kind: 'show', screen: { id: 'language' } });
  assert.deepEqual(tap(config, 'im'), { kind: 'show', screen: { id: 'idle' } });
  assert.deepEqual(tap(config, 'wm'), { kind: 'show', screen: { id: 'workers' } });
  assert.deepEqual(tap(config, 'ra', ['q1']), { kind: 'show', screen: { id: 'removeEngineConfirm', engineId: 'q1' } });

  for (const action of ['oe', 'up', 'us', 'ad', 'lg', 'ls', 'rt', 'ec', 'ky'] as const) {
    assert.deepEqual(tap(config, action, action === 'ls' ? ['ru'] : ['q1'], {}, 'ffffff'), { kind: 'stale' }, action);
  }
  assert.deepEqual(tap(config, 'bk', [], {}, 'ffffff'), { kind: 'show', screen: { id: 'main' } });
  assert.deepEqual(tap(config, 'cl', [], {}, 'ffffff'), { kind: 'effect', effect: 'close' });
  assert.deepEqual(tap(config, 'cn', [], {}, 'ffffff'), { kind: 'cancelInput' });
});

test('reducer: an engine that is gone makes the tap stale', () => {
  const config = configOf(groq);
  for (const action of ['oe', 'up', 'dn', 'us', 'tm', 'ky', 'ra', 'rd'] as const) {
    assert.deepEqual(tap(config, action, ['zz']), { kind: 'stale' }, action);
  }
  assert.deepEqual(tap(config, 'tb', ['zz', 10]), { kind: 'stale' });
});

test('reducer: edits save the next config and say which screen to show', () => {
  const config = configOf(local, groq);
  const moved = tap(config, 'dn', ['g']);
  assert.ok(moved.kind === 'save');
  assert.deepEqual(moved.config.engines.map((engine) => engine.id), ['q1', 'g']);
  assert.deepEqual(moved.screen, { id: 'card', engineId: 'g' });

  const toggled = tap(config, 'us', ['q1']);
  assert.ok(toggled.kind === 'save' && toggled.config.engines[1].isDisabled === true);

  const timeout = tap(config, 'tb', ['q1', 30]);
  assert.ok(timeout.kind === 'save');
  assert.deepEqual(timeout.config.engines[1].timeout, { baseSeconds: 30, percentOfDuration: 25 });
  assert.deepEqual(timeout.screen, { id: 'timeout', engineId: 'q1' });
  const percent = tap(config, 'tp', ['q1', 100]);
  assert.ok(percent.kind === 'save');
  assert.deepEqual(percent.config.engines[1].timeout, { baseSeconds: 10, percentOfDuration: 100 });
  assert.deepEqual(tap(config, 'tb', ['q1', 'abc']), { kind: 'stale' });
  assert.deepEqual(tap(config, 'tb', ['q1', 0]), { kind: 'stale' }, 'a value the schema refuses never reaches the file');

  const removed = tap(config, 'rd', ['q1']);
  assert.ok(removed.kind === 'save');
  assert.deepEqual(removed.config.engines.map((engine) => engine.id), ['g']);
  assert.deepEqual(removed.screen, { id: 'main' });
});

test('reducer: language, idle and workers accept only the offered values', () => {
  const config = configOf(local);
  const ru = tap(config, 'ls', ['ru']);
  assert.ok(ru.kind === 'save' && ru.config.language === 'ru');
  const auto = tap({ ...config, language: 'ru' }, 'ls', ['auto']);
  assert.ok(auto.kind === 'save' && auto.config.language === null);
  assert.deepEqual(tap(config, 'ls', ['xx']), { kind: 'stale' });
  const never = tap(config, 'is', [0]);
  assert.ok(never.kind === 'save' && never.config.gigaam.idleMinutes === 0);
  assert.deepEqual(tap(config, 'is', [7]), { kind: 'stale' });
  const eight = tap(config, 'ws', [8]);
  assert.ok(eight.kind === 'save' && eight.config.gigaam.workers === 8);
  assert.deepEqual(tap(config, 'ws', [3]), { kind: 'stale' });
});

test('reducer: adding — a hosted engine arms the key paste, a custom one the address, the local one is saved when installed', () => {
  const config = configOf(groq);
  assert.deepEqual(tap(config, 'an', ['gq']), { kind: 'armKey', target: { kind: 'newKeyed', engineKind: 'groq' } });
  assert.deepEqual(tap(config, 'an', ['oa']), { kind: 'armKey', target: { kind: 'newKeyed', engineKind: 'openai' } });
  assert.deepEqual(tap(config, 'an', ['ur']), { kind: 'armUrl' });
  const addedLocal = tap(config, 'an', ['gg']);
  assert.ok(addedLocal.kind === 'save');
  assert.deepEqual(addedLocal.config.engines.map((engine) => engine.id), ['g', 'q1']);
  assert.deepEqual(tap(config, 'an', ['gg'], { isLocalInstalled: false }), { kind: 'stale' });
  assert.deepEqual(tap(configOf(local), 'an', ['gg']), { kind: 'stale' }, 'already listed');
  assert.deepEqual(tap(config, 'an', ['zz']), { kind: 'stale' });
  assert.deepEqual(tap(config, 'ky', ['q1']), { kind: 'armKey', target: { kind: 'engine', engineId: 'q1' } });
  assert.deepEqual(tap(configOf(local), 'ky', ['g']), { kind: 'stale' }, 'the local engine has no key');
});

test('reducer: after the address, "needs a key?" — yes arms the paste for the new engine, no saves it as it is', () => {
  const config = configOf(groq);
  const url = 'http://stt.local:8000/v1/audio/transcriptions';
  assert.deepEqual(tap(config, 'ku', ['y'], { pendingUrl: url }), { kind: 'armKey', target: { kind: 'newUrl', url } });
  const saved = tap(config, 'ku', ['n'], { pendingUrl: url });
  assert.ok(saved.kind === 'save');
  assert.deepEqual(saved.config.engines.at(-1), { id: 'u1', kind: 'url', url });
  assert.deepEqual(tap(config, 'ku', ['y']), { kind: 'stale' }, 'no address was typed');
});

test('reducer: install taps run only when the local engine is neither installed nor installing', () => {
  const config = configOf(groq);
  const notInstalled = { isLocalInstalled: false, isLocalInstalling: false };
  assert.deepEqual(tap(config, 'ec', [], notInstalled), { kind: 'show', screen: { id: 'enableConfirm' } });
  assert.deepEqual(tap(config, 'ei', [], notInstalled), { kind: 'effect', effect: 'install' });
  assert.deepEqual(tap(config, 'er', [], notInstalled), { kind: 'effect', effect: 'install' });
  assert.deepEqual(tap(config, 'ip', [], notInstalled), { kind: 'stale' });
  assert.deepEqual(tap(config, 'ec'), { kind: 'stale' }, 'already installed');
  assert.deepEqual(tap(config, 'ei', [], { isLocalInstalled: false, isLocalInstalling: true }), { kind: 'stale' });
  assert.deepEqual(tap(config, 'ip', [], { isLocalInstalled: false, isLocalInstalling: true }), { kind: 'effect', effect: 'attachInstall' });
});

test('reducer: removing the files runs only for an installed, idle engine; "try again" resets the guard', () => {
  const config = configOf(local);
  assert.deepEqual(tap(config, 'fa'), { kind: 'show', screen: { id: 'removeFilesConfirm' } });
  assert.deepEqual(tap(config, 'fd'), { kind: 'effect', effect: 'removeFiles' });
  assert.deepEqual(tap(config, 'fd', [], { isLocalInstalled: false }), { kind: 'stale' });
  assert.deepEqual(tap(config, 'fa', [], { isLocalInstalling: true }), { kind: 'stale' });
  assert.deepEqual(tap(config, 'rt'), { kind: 'effect', effect: 'resetGuard' });
});
