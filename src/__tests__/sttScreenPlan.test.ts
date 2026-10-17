/**
 * @description The `/stt` screens as data: what each state of the settings shows (text lines and buttons), the
 * callback data (at most 64 bytes, a revision baked in, a stale one refused), the key-paste decision table and
 * the reducer that turns a tap into a screen, a save, an armed input or an effect.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getRecvTracePreview, redactedConnectKeyPreview, redactedSttAddressPreview, redactedSttKeyPreview } from '../utils/recvPreviewRedaction';
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
    { id: 'idle', engineId: 'g' }, { id: 'workers', engineId: 'g' }, { id: 'enableConfirm' }, { id: 'removeEngineConfirm', engineId: 'q1' },
    { id: 'removeEngineConfirm', engineId: 'g' }, { id: 'removeFilesConfirm', engineId: 'g' }, { id: 'keyChoice' },
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

test('main screen, Groq only: just the engine list, Add engine, Language and Close — nothing of the local engine', () => {
  const screen = mainScreen(createInput(configOf(groq), { isLocalInstalled: false, facts: { isGigaamInstalled: false }, load: { status: 'ok', config: configOf(groq) } }));
  assert.match(screen.text, /stt\.screen\.sourceFile\(path=\/secrets\/stt\.json\)/);
  assert.match(screen.text, /stt\.screen\.language\(language=stt\.language\.autoName\)/);
  assert.match(screen.text, /stt\.screen\.chainHeading/);
  assert.ok(!screen.text.includes('stt.screen.local'), 'the local engine has no line on the main screen');
  assert.deepEqual(allButtons(screen).map((button) => button.text), [
    '1. Groq · 10s+25% · ✓', 'stt.btn.addEngine', 'stt.btn.language(language=stt.language.autoShort)', 'stt.btn.close',
  ]);
  assert.deepEqual(screen.rows.map((row) => row.length), [1, 1, 1, 1], 'one control per row, as the screen is sketched');
});

test('main screen, local engine first: its row carries the short state; idle, workers and its files are NOT on this screen', () => {
  const config = { ...configOf(local, groq), language: 'ru', gigaam: { idleMinutes: 15, workers: 4 } };
  const screen = mainScreen(createInput(config));
  const labels = allButtons(screen).map((button) => button.text);
  assert.deepEqual(labels, [
    '1. stt.engine.gigaam · stt.engineState.stopped · 10s+25% · ✓',
    '2. Groq · 10s+25% · ✓',
    'stt.btn.addEngine',
    'stt.btn.language(language=ru)',
    'stt.btn.close',
  ]);
  assert.ok(!screen.text.includes('stt.screen.local') && !screen.text.includes('stt.screen.languageNote'));
});

test('main screen: a language other than ru marks the local engine ✗ on its row (the card says why); a disabled engine is ✗ too', () => {
  const config = { ...configOf(local, { ...groq, isDisabled: true }), language: 'en' };
  const labels = allButtons(mainScreen(createInput(config))).map((button) => button.text);
  assert.deepEqual(labels.slice(0, 2), ['1. stt.engine.gigaam · stt.engineState.stopped · 10s+25% · ✗', '2. Groq · 10s+25% · ✗']);
});

test('main screen, local engine installed but not in the list: nothing local-specific shows; Add engine brings it back', () => {
  const input = createInput(configOf(groq));
  assert.ok(input.isLocalInstalled);
  const labels = allButtons(mainScreen(input)).map((button) => button.text);
  assert.ok(!labels.some((label) => /gigaam|idle|workers|removeLocal|tryAgain|enableLocal/.test(label)), labels.join(' | '));
  const add = buildSttScreen({ id: 'add' }, input, echo);
  assert.ok(add && allButtons(add).some((button) => button.text === 'stt.engine.gigaam'));
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

test('main screen: the local row names its state — installing, stopped, running, paused, unavailable, not installed', () => {
  const rowLabel = (input: SttScreenInput): string => allButtons(mainScreen(input))[0].text;
  const config = configOf(local);
  assert.equal(rowLabel(createInput(config)), '1. stt.engine.gigaam · stt.engineState.stopped · 10s+25% · ✓');
  assert.equal(rowLabel(createInput(config, { sidecar: { state: 'running', busyRequests: 0 } })), '1. stt.engine.gigaam · stt.engineState.running · 10s+25% · ✓');
  assert.equal(rowLabel(createInput(config, { sidecar: { state: 'running' } })), '1. stt.engine.gigaam · stt.engineState.running · 10s+25% · ✓', 'alive but too busy to answer /health is still running');
  const unhealthy = createInput(config, { sidecar: { state: 'unhealthy', unhealthyUntil: 1 }, facts: { isGigaamUnhealthy: true } });
  assert.equal(rowLabel(unhealthy), '1. stt.engine.gigaam · stt.engineState.paused · 10s+25% · ✗');
  assert.equal(rowLabel(createInput(config, { hasOwnerContext: false, facts: { hasOwnerContext: false } })), '1. stt.engine.gigaam · stt.engineState.noOwner · 10s+25% · ✗');
  assert.equal(rowLabel(createInput(config, { isLocalInstalled: false, facts: { isGigaamInstalled: false } })), '1. stt.engine.gigaam · stt.engineState.notInstalled · 10s+25% · ✗');
  const progress: SttInstallProgress = { phase: 'downloadingModel', detail: '120/216 MB', bytesDownloaded: 1 };
  assert.equal(
    rowLabel(createInput(config, { isLocalInstalled: false, installing: progress, facts: { isGigaamInstalled: false, isGigaamInstalling: true } })),
    '1. stt.engine.gigaam · stt.engineState.installing · 10s+25% · ✗',
  );
});

test('local card, status line: ready · running (idle, busy, too busy to answer), stopped, paused until, unavailable, installing, not installed', () => {
  const statusOf = (input: SttScreenInput): string => {
    const card = buildSttScreen({ id: 'card', engineId: 'g' }, input, echo);
    assert.ok(card);
    return card.text.split('\n')[1];
  };
  const config = configOf(local);
  assert.equal(statusOf(createInput(config)), 'stt.card.local.status.stopped');
  assert.equal(statusOf(createInput(config, { sidecar: { state: 'running', busyRequests: 0 } })), 'stt.card.local.status.running');
  assert.equal(statusOf(createInput(config, { sidecar: { state: 'running', busyRequests: 3 } })), 'stt.card.local.status.runningBusy(count=3)');
  assert.equal(statusOf(createInput(config, { sidecar: { state: 'running' } })), 'stt.card.local.status.runningSlow', 'alive but too busy to answer /health');
  const untilMs = new Date(2026, 9, 16, 14, 5, 0).getTime();
  assert.equal(statusOf(createInput(config, { sidecar: { state: 'unhealthy', unhealthyUntil: untilMs }, facts: { isGigaamUnhealthy: true } })), 'stt.card.local.status.paused(until=14:05)');
  assert.equal(statusOf(createInput(config, { hasOwnerContext: false, facts: { hasOwnerContext: false } })), 'stt.card.local.status.noOwner');
  assert.equal(statusOf(createInput(config, { isLocalInstalled: false, facts: { isGigaamInstalled: false } })), 'stt.card.local.status.notInstalled');
  const progress: SttInstallProgress = { phase: 'downloadingModel', detail: '120/216 MB', bytesDownloaded: 1 };
  assert.equal(
    statusOf(createInput(config, { isLocalInstalled: false, installing: progress, facts: { isGigaamInstalled: false, isGigaamInstalling: true } })),
    'stt.card.local.status.installing(phase=stt.install.downloadingModel(progress=120/216 MB))',
  );
});

test('local card: title, RAM line, the common controls plus idle, workers and the removal row — and only while the state asks for them, try again / install / progress', () => {
  const config = { ...configOf(local, groq), gigaam: { idleMinutes: 15, workers: 4 } };
  const labelsOf = (input: SttScreenInput): string[] => {
    const card = buildSttScreen({ id: 'card', engineId: 'g' }, input, echo);
    assert.ok(card);
    return allButtons(card).map((button) => button.text);
  };
  const ready = buildSttScreen({ id: 'card', engineId: 'g' }, createInput(config), echo);
  assert.ok(ready);
  assert.match(ready.text, /^stt\.card\.local\.title\nstt\.card\.local\.status\.stopped\nstt\.card\.local\.ram\nstt\.card\.timeout\(base=10,percent=25\)$/);
  assert.deepEqual(ready.rows.map((row) => row.map((button) => button.text)), [
    ['limits.btnDown', 'limits.btnDontUse'],
    ['stt.btn.timeoutValue(value=10s+25%)'],
    ['stt.btn.idle(value=stt.idle.minutes(count=15))'],
    ['stt.btn.workers(count=4)'],
    ['stt.btn.removeFromList', 'stt.btn.removeLocal'],
    ['fallback.backButton'],
  ]);
  assert.ok(!labelsOf(createInput(config)).includes('stt.btn.tryAgain'), 'try again only while paused');

  const paused = labelsOf(createInput(config, { sidecar: { state: 'unhealthy', unhealthyUntil: 1 }, facts: { isGigaamUnhealthy: true } }));
  assert.ok(paused.includes('stt.btn.tryAgain'));

  const missingFiles = labelsOf(createInput(config, { isLocalInstalled: false, facts: { isGigaamInstalled: false } }));
  assert.ok(missingFiles.includes('stt.btn.install'), 'listed but not installed: install from the card');
  assert.ok(!missingFiles.includes('stt.btn.removeLocal'), 'nothing to delete');
  assert.ok(missingFiles.includes('stt.btn.removeFromList'));

  const progress: SttInstallProgress = { phase: 'checking', detail: '', bytesDownloaded: 0 };
  const installing = labelsOf(createInput(config, { isLocalInstalled: false, installing: progress, facts: { isGigaamInstalled: false, isGigaamInstalling: true } }));
  assert.ok(installing.includes('stt.btn.showProgress'));
  assert.ok(!installing.includes('stt.btn.install') && !installing.includes('stt.btn.removeLocal'));

  const idleNever = labelsOf(createInput({ ...config, gigaam: { idleMinutes: 0, workers: 8 } }));
  assert.ok(idleNever.includes('stt.btn.idle(value=stt.idle.never)') && idleNever.includes('stt.btn.workers(count=8)'));
});

test('local card: a language other than ru and a disabled engine each say why they are skipped', () => {
  const english = buildSttScreen({ id: 'card', engineId: 'g' }, createInput({ ...configOf(local), language: 'en' }), echo);
  assert.ok(english);
  assert.match(english.text, /stt\.card\.problem\.languageNotSupported/);
  const off = buildSttScreen({ id: 'card', engineId: 'g' }, createInput(configOf({ ...local, isDisabled: true })), echo);
  assert.ok(off);
  assert.match(off.text, /stt\.card\.problem\.disabled/);
  assert.ok(allButtons(off).some((button) => button.text === 'limits.btnUse'));
});

test('local status precedence: installing and not installed outrank the process state', () => {
  const base = createInput(configOf(local));
  assert.deepEqual(getSttLocalStatus({ ...base, isLocalInstalled: false, sidecar: { state: 'running', busyRequests: 1 } }), { state: 'notInstalled' });
  assert.equal(getSttLocalStatus({ ...base, installing: { phase: 'checking', detail: '', bytesDownloaded: 0 } }).state, 'installing');
  assert.equal(getSttLocalStatus({ ...base, hasOwnerContext: false }).state, 'noOwner');
});

test('engine card (cloud): state, timeout, key — and no idle, workers or file controls, which exist only on the local engine\'s card', () => {
  const config = configOf(local, groq, { id: 'u1', kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' });
  const input = createInput(config);
  const keyed = buildSttScreen({ id: 'card', engineId: 'q1' }, input, echo);
  assert.ok(keyed);
  assert.match(keyed.text, /stt\.card\.title\(n=2,total=3,name=Groq\)/);
  assert.match(keyed.text, /stt\.card\.ready/);
  assert.match(keyed.text, /stt\.card\.keySet/);
  assert.deepEqual(keyed.rows.map((row) => row.map((button) => button.text)), [
    ['limits.btnUp', 'limits.btnDown', 'limits.btnDontUse'],
    ['stt.btn.timeoutValue(value=10s+25%)'],
    ['stt.btn.changeKey'],
    ['account.removeButton'],
    ['fallback.backButton'],
  ]);

  const url = buildSttScreen({ id: 'card', engineId: 'u1' }, input, echo);
  assert.ok(url);
  assert.match(url.text, /stt\.card\.url\(url=http:\/\/stt\.local:8000\/v1\/audio\/transcriptions\)/);
  assert.match(url.text, /stt\.card\.keyMissing/);
  assert.ok(allButtons(url).some((button) => button.text === 'stt.btn.addKey'));
  assert.ok(!allButtons(url).some((button) => button.text === 'limits.btnDown'), 'nothing below the last');

  for (const card of [keyed, url]) {
    const labels = allButtons(card).map((button) => button.text);
    assert.ok(!labels.some((label) => /stt\.btn\.(idle|workers|tryAgain|removeLocal|removeFromList|install|showProgress)/.test(label)), labels.join(' | '));
    assert.ok(!card.text.includes('stt.card.local'));
  }
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

test('language, idle and workers screens mark the current value; idle and workers go back to the local card', () => {
  const config = { ...configOf(local), language: 'ru', gigaam: { idleMinutes: 30, workers: 2 } };
  const input = createInput(config);
  const language = buildSttScreen({ id: 'language' }, input, echo);
  assert.ok(language);
  assert.ok(allButtons(language).some((button) => button.text === 'ru ✓'));
  assert.ok(allButtons(language).some((button) => button.text === 'stt.language.auto'));
  const idle = buildSttScreen({ id: 'idle', engineId: 'g' }, input, echo);
  assert.ok(idle);
  assert.deepEqual(idle.rows[0].map((button) => button.text), ['stt.idle.minutes(count=5)', 'stt.idle.minutes(count=15)', 'stt.idle.minutes(count=30) ✓', 'stt.idle.minutes(count=60)', 'stt.idle.never']);
  assert.match(idle.rows[0][0].data, /^stt_is_g_5_[0-9a-f]{6}$/);
  const workers = buildSttScreen({ id: 'workers', engineId: 'g' }, input, echo);
  assert.ok(workers);
  assert.deepEqual(workers.rows[0].map((button) => button.text), ['1', '2 ✓', '4', '8']);
  assert.match(workers.rows[0][3].data, /^stt_ws_g_8_[0-9a-f]{6}$/);
  for (const screen of [idle, workers]) assert.match(screen.rows[1][0].data, /^stt_oe_g_[0-9a-f]{6}$/, 'Back returns to the local engine\'s card');
  assert.equal(buildSttScreen({ id: 'idle', engineId: 'gone' }, input, echo)?.rows.length, 2, 'the screen itself needs no lookup');
});

test('the add screen offers the local engine whenever it is not in the list — installed or not — and never when it is', () => {
  const listed = buildSttScreen({ id: 'add' }, createInput(configOf(local)), echo);
  assert.ok(listed);
  assert.ok(!allButtons(listed).some((button) => button.text === 'stt.engine.gigaam'), 'already in the chain');
  for (const installed of [true, false]) {
    const offered = buildSttScreen({ id: 'add' }, createInput(configOf(groq), { isLocalInstalled: installed }), echo);
    assert.ok(offered);
    assert.deepEqual(allButtons(offered).map((button) => button.text), ['Groq', 'OpenAI', 'stt.btn.customUrl', 'stt.engine.gigaam', 'fallback.backButton'], `installed: ${installed}`);
  }
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

test('the recv trace never records a pasted speech-engine key or a custom address (it may carry a login) — only while that step is armed', () => {
  assert.equal(getRecvTracePreview(sampleKey, false, 'key'), redactedSttKeyPreview);
  assert.equal(redactedSttKeyPreview, '[redacted: speech engine key]');
  assert.equal(getRecvTracePreview('http://me:pw@stt.local/v1', false, 'url'), redactedSttAddressPreview);
  assert.equal(redactedSttAddressPreview, '[redacted: speech engine address]');
  assert.equal(getRecvTracePreview(sampleKey, false, null), sampleKey, 'unarmed text is recorded as before');
  assert.equal(getRecvTracePreview('http://stt.local:8000', false), 'http://stt.local:8000');
  assert.equal(getRecvTracePreview('/stt', false, 'key'), '/stt', 'a command cancels the paste, so it is not a secret');
  assert.equal(getRecvTracePreview('/stt', false, 'url'), '/stt');
  assert.equal(getRecvTracePreview(sampleKey, true, null), redactedConnectKeyPreview, 'the /connect redaction is unchanged');
  assert.equal(getRecvTracePreview('/connect sk-inline-secret-1234', false, 'key'), '/connect <redacted>');
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
  assert.deepEqual(tap(config, 'im', ['g']), { kind: 'show', screen: { id: 'idle', engineId: 'g' } });
  assert.deepEqual(tap(config, 'wm', ['g']), { kind: 'show', screen: { id: 'workers', engineId: 'g' } });
  assert.deepEqual(tap(config, 'ra', ['q1']), { kind: 'show', screen: { id: 'removeEngineConfirm', engineId: 'q1' } });

  for (const action of ['oe', 'up', 'us', 'ad', 'lg', 'ls', 'rt', 'ec', 'ky', 'im', 'wm', 'is', 'ws', 'fa', 'fd'] as const) {
    assert.deepEqual(tap(config, action, action === 'ls' ? ['ru'] : ['g', 5], {}, 'ffffff'), { kind: 'stale' }, action);
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

test('reducer: language, idle and workers accept only the offered values; idle and workers belong to the local engine and lead back to its card', () => {
  const config = configOf(local, groq);
  const ru = tap(config, 'ls', ['ru']);
  assert.ok(ru.kind === 'save' && ru.config.language === 'ru');
  const auto = tap({ ...config, language: 'ru' }, 'ls', ['auto']);
  assert.ok(auto.kind === 'save' && auto.config.language === null);
  assert.deepEqual(tap(config, 'ls', ['xx']), { kind: 'stale' });
  const never = tap(config, 'is', ['g', 0]);
  assert.ok(never.kind === 'save' && never.config.gigaam.idleMinutes === 0);
  assert.deepEqual(never.screen, { id: 'card', engineId: 'g' });
  assert.deepEqual(tap(config, 'is', ['g', 7]), { kind: 'stale' });
  const eight = tap(config, 'ws', ['g', 8]);
  assert.ok(eight.kind === 'save' && eight.config.gigaam.workers === 8);
  assert.deepEqual(eight.screen, { id: 'card', engineId: 'g' });
  assert.deepEqual(tap(config, 'ws', ['g', 3]), { kind: 'stale' });
  for (const action of ['im', 'wm'] as const) assert.deepEqual(tap(config, action, ['q1']), { kind: 'stale' }, `${action}: a hosted engine has no such setting`);
  assert.deepEqual(tap(config, 'is', ['q1', 15]), { kind: 'stale' });
  assert.deepEqual(tap(config, 'ws', ['q1', 4]), { kind: 'stale' });
  assert.deepEqual(tap(config, 'is', ['zz', 15]), { kind: 'stale' });
});

test('reducer: adding — a hosted engine arms the key paste, a custom one the address', () => {
  const config = configOf(groq);
  assert.deepEqual(tap(config, 'an', ['gq']), { kind: 'armKey', target: { kind: 'newKeyed', engineKind: 'groq' } });
  assert.deepEqual(tap(config, 'an', ['oa']), { kind: 'armKey', target: { kind: 'newKeyed', engineKind: 'openai' } });
  assert.deepEqual(tap(config, 'an', ['ur']), { kind: 'armUrl' });
  assert.deepEqual(tap(config, 'an', ['zz']), { kind: 'stale' });
  assert.deepEqual(tap(config, 'ky', ['q1']), { kind: 'armKey', target: { kind: 'engine', engineId: 'q1' } });
  assert.deepEqual(tap(configOf(local), 'ky', ['g']), { kind: 'stale' }, 'the local engine has no key');
});

test('reducer: adding the local engine — installed: it joins first and its card opens; installing: attach; not installed: the install confirmation', () => {
  const config = configOf(groq);
  const installed = tap(config, 'an', ['gg']);
  assert.ok(installed.kind === 'save');
  assert.deepEqual(installed.config.engines.map((engine) => engine.id), ['g', 'q1']);
  assert.deepEqual(installed.screen, { id: 'card', engineId: 'g' }, 'the card of the engine just added');
  assert.deepEqual(installed.notice, { code: 'stt.notice.localAdded' });

  assert.deepEqual(tap(config, 'an', ['gg'], { isLocalInstalled: false }), { kind: 'show', screen: { id: 'enableConfirm' } });
  assert.deepEqual(tap(config, 'an', ['gg'], { isLocalInstalled: false, isLocalInstalling: true }), { kind: 'effect', effect: 'attachInstall' });
  assert.deepEqual(tap(configOf(local), 'an', ['gg']), { kind: 'stale' }, 'already listed');
  assert.deepEqual(tap(configOf(...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, kind: 'groq' as const, apiKey: sampleKey }))), 'an', ['gg']), { kind: 'stale' }, 'a full list has no room');
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

test('reducer: removing the files is the local engine\'s, for an installed, idle one; "try again" resets the guard and returns to its card', () => {
  const config = configOf(local, groq);
  assert.deepEqual(tap(config, 'fa', ['g']), { kind: 'show', screen: { id: 'removeFilesConfirm', engineId: 'g' } });
  assert.deepEqual(tap(config, 'fd', ['g']), { kind: 'effect', effect: 'removeFiles' });
  assert.deepEqual(tap(config, 'fd', ['g'], { isLocalInstalled: false }), { kind: 'stale' });
  assert.deepEqual(tap(config, 'fa', ['g'], { isLocalInstalling: true }), { kind: 'stale' });
  assert.deepEqual(tap(config, 'fa', ['q1']), { kind: 'stale' }, 'a hosted engine has no files');
  assert.deepEqual(tap(config, 'rt', ['g']), { kind: 'effect', effect: 'resetGuard', screen: { id: 'card', engineId: 'g' } });
  assert.deepEqual(tap(config, 'rt', ['q1']), { kind: 'stale' });
});
