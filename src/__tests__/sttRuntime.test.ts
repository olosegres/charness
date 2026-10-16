/**
 * @description The voice settings as the bot runs them: the chain is resolved per call against the local
 * engine's CURRENT lifecycle facts, a start is asked of the owner only when a voice reaches the local engine,
 * what is wrong is logged once per change, and a hand edit that names an uninstalled local engine triggers the
 * install exactly once per edit.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetLegacyNameState } from '../legacyNames';
import { createSttRuntime, type SttRuntimeDeps } from '../stt/sttRuntime';
import { createEmptySttConfig, resetSttConfigCache, saveSttConfig, type SttConfigFile } from '../stt/sttSettings';
import type { SttGigaamSettings } from '../stt/sttSettings';
import type { SttSidecarEndpoint } from '../stt/sttSidecarOwner';

let dataDir = '';
let configPath = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-runtime-'));
  configPath = path.join(dataDir, 'stt.json');
  resetSttConfigCache();
  resetLegacyNameState();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const localEngine = { id: 'g', kind: 'gigaam' as const };
const groqEngine = { id: 'q1', kind: 'groq' as const, apiKey: 'gsk_sampleSecretKey1234567890' };

function writeConfig(overrides: Partial<SttConfigFile>): void {
  saveSttConfig(configPath, { ...createEmptySttConfig(), ...overrides });
}

interface Harness {
  deps: SttRuntimeDeps;
  info: string[];
  problems: string[];
  ensured: SttGigaamSettings[];
  autoInstalls: { count: number };
  facts: { isInstalled: boolean; isInstalling: boolean; isUnhealthy: boolean; owner: boolean };
}

function createHarness(): Harness {
  const harness: Harness = {
    info: [],
    problems: [],
    ensured: [],
    autoInstalls: { count: 0 },
    facts: { isInstalled: true, isInstalling: false, isUnhealthy: false, owner: true },
    deps: undefined as never,
  };
  harness.deps = {
    getDataDir: () => dataDir,
    getConfigPath: () => configPath,
    // Hermetic: whether the test box is itself a container must not change what a test sees.
    checkIsConfigOnContainerDisk: () => false,
    owner: {
      ensure: async (settings): Promise<SttSidecarEndpoint> => {
        harness.ensured.push(settings);
        return { port: 40123, token: 'sidecar-token' };
      },
      checkIsUnhealthy: () => harness.facts.isUnhealthy,
    },
    getOwnerContext: () => (harness.facts.owner ? { pid: 1, startToken: 't' } : null),
    logInfo: (line) => harness.info.push(line),
    logProblem: (line) => harness.problems.push(line),
    checkIsInstalled: () => harness.facts.isInstalled,
    checkIsInstalling: () => harness.facts.isInstalling,
    onNeedsAutoInstall: () => { harness.autoInstalls.count++; },
  };
  return harness;
}

test('a ready local engine is in the chain, but resolving the chain starts nothing — only a voice that reaches it does', async () => {
  const harness = createHarness();
  writeConfig({ engines: [localEngine, groqEngine], gigaam: { idleMinutes: 5, workers: 2 } });
  const runtime = createSttRuntime(harness.deps);

  const resolved = runtime.getResolved();
  assert.deepEqual(resolved.engines.map((engine) => engine.name), ['gigaam', 'groq']);
  assert.deepEqual(harness.ensured, [], 'resolve is cheap and side-effect free');

  const endpoint = await resolved.engines[0].getEndpoint();
  assert.deepEqual(endpoint, { url: 'http://127.0.0.1:40123/v1/audio/transcriptions', apiKey: 'sidecar-token', model: 'gigaam' });
  assert.deepEqual(harness.ensured, [{ idleMinutes: 5, workers: 2 }], 'the process is asked for with THIS file\'s knobs');
});

test('the local engine is skipped while not installed, installing, unhealthy or without an owner — each reason is logged', () => {
  const harness = createHarness();
  writeConfig({ engines: [localEngine, groqEngine] });
  const runtime = createSttRuntime(harness.deps);
  const namesOf = (): string[] => runtime.getResolved().engines.map((engine) => engine.name);

  assert.deepEqual(namesOf(), ['gigaam', 'groq']);
  harness.facts.isInstalled = false;
  assert.deepEqual(namesOf(), ['groq']);
  harness.facts.isInstalled = true;
  harness.facts.isInstalling = true;
  assert.deepEqual(namesOf(), ['groq']);
  harness.facts.isInstalling = false;
  harness.facts.isUnhealthy = true;
  assert.deepEqual(namesOf(), ['groq']);
  harness.facts.isUnhealthy = false;
  harness.facts.owner = false;
  assert.deepEqual(namesOf(), ['groq']);
  assert.ok(harness.problems.some((line) => line.includes('engine g (gigaam) is skipped: not installed')));
  assert.ok(harness.problems.some((line) => line.includes('marked unhealthy')));
  assert.ok(harness.problems.some((line) => line.includes('restart it')));
});

test('an unchanged problem is logged once, not once per voice note; a changed one is logged again', () => {
  const harness = createHarness();
  writeConfig({ engines: [{ id: 'o1', kind: 'openai' }] });
  const runtime = createSttRuntime(harness.deps);
  runtime.getResolved();
  runtime.getResolved();
  runtime.getResolved();
  assert.equal(harness.problems.length, 1);
  assert.match(harness.problems[0], /engine o1 \(openai\) is skipped: no API key/);

  writeConfig({ engines: [{ id: 'u1', kind: 'url' }] });
  runtime.getResolved();
  assert.equal(harness.problems.length, 2);
  assert.match(harness.problems[1], /engine u1 \(url\) is skipped: no URL/);
});

test('a hand edit that names an uninstalled local engine triggers the install once per edit — never per voice, never at init', () => {
  const harness = createHarness();
  harness.facts.isInstalled = false;
  writeConfig({ engines: [groqEngine] });
  const runtime = createSttRuntime(harness.deps);
  runtime.init();
  runtime.getResolved();
  assert.equal(harness.autoInstalls.count, 0);

  writeConfig({ engines: [localEngine, groqEngine] });
  runtime.getResolved();
  assert.equal(harness.autoInstalls.count, 1, 'the edit names the engine');
  runtime.getResolved();
  runtime.getResolved();
  assert.equal(harness.autoInstalls.count, 1, 'the same edit is not acted on again by every voice note');

  writeConfig({ engines: [groqEngine, localEngine] });
  runtime.getResolved();
  assert.equal(harness.autoInstalls.count, 2, 'another edit that still names it asks again');

  harness.facts.isInstalled = true;
  writeConfig({ engines: [localEngine] });
  runtime.getResolved();
  assert.equal(harness.autoInstalls.count, 2, 'nothing to install once it is installed');
});

test('init moves the old env keys into stt.json once and reports the first state', () => {
  const harness = createHarness();
  const previousGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_fromTheEnvironment1234';
  try {
    const runtime = createSttRuntime(harness.deps);
    runtime.init();
    assert.deepEqual(harness.info, [`[STT] moved groq from the environment into ${configPath}`]);
    assert.deepEqual(runtime.getResolved().engines.map((engine) => engine.name), ['groq']);
  } finally {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
  }
});

test('init says so when stt.json cannot be written, and the chain stays empty', () => {
  const harness = createHarness();
  harness.deps = { ...harness.deps, getConfigPath: () => path.join(dataDir, 'blocker', 'stt.json') };
  fs.writeFileSync(path.join(dataDir, 'blocker'), '');
  const previousGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_fromTheEnvironment1234';
  try {
    const runtime = createSttRuntime(harness.deps);
    runtime.init();
    assert.ok(harness.problems.some((line) => /could not write .*stt\.json \(\w+\): voice input stays off/.test(line)), harness.problems.join('\n'));
    assert.deepEqual(runtime.getResolved().engines, []);
  } finally {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
  }
});

/** Run `fn` with the old env keys unset, so the one-time migration has nothing to move (the host may export them). */
function withoutLegacyKeys(fn: () => void): void {
  const saved = { groq: process.env.GROQ_API_KEY, openai: process.env.OPENAI_API_KEY };
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    fn();
  } finally {
    if (saved.groq !== undefined) process.env.GROQ_API_KEY = saved.groq;
    if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
  }
}

test('init says ONCE that stt.json cannot be written, naming the file; a writable one says nothing', () => withoutLegacyKeys(() => {
  const blocked = createHarness();
  blocked.deps = { ...blocked.deps, getConfigPath: () => path.join(dataDir, 'blocker', 'stt.json') };
  fs.writeFileSync(path.join(dataDir, 'blocker'), '');
  const blockedRuntime = createSttRuntime(blocked.deps);
  blockedRuntime.init();
  blockedRuntime.getResolved();
  blockedRuntime.getResolved();
  const lines = blocked.problems.filter((line) => line.includes('cannot be written'));
  assert.equal(lines.length, 1, blocked.problems.join('\n'));
  assert.ok(lines[0].includes(path.join(dataDir, 'blocker', 'stt.json')), 'the line names the file');
  assert.ok(lines[0].includes('ENOTDIR'));

  const writable = createHarness();
  createSttRuntime(writable.deps).init();
  assert.ok(!writable.problems.some((line) => line.includes('cannot be written')), writable.problems.join('\n'));
}));

test('init does not repeat itself when the old-key migration already reported the write failure', () => {
  const harness = createHarness();
  harness.deps = { ...harness.deps, getConfigPath: () => path.join(dataDir, 'blocker', 'stt.json') };
  fs.writeFileSync(path.join(dataDir, 'blocker'), '');
  const previousGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_fromTheEnvironment1234';
  try {
    createSttRuntime(harness.deps).init();
    assert.equal(harness.problems.filter((line) => /could not write|cannot be written/.test(line)).length, 1, harness.problems.join('\n'));
  } finally {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
  }
});

test('init warns ONCE when stt.json is on the container\'s own disk — also in the fresh container that migrates the old env keys again', () => withoutLegacyKeys(() => {
  const harness = createHarness();
  harness.deps = { ...harness.deps, checkIsConfigOnContainerDisk: (checkedPath) => checkedPath === configPath };
  const runtime = createSttRuntime(harness.deps);
  runtime.init();
  runtime.getResolved();
  const lines = harness.problems.filter((line) => line.includes("container's own disk"));
  assert.equal(lines.length, 1, harness.problems.join('\n'));
  assert.ok(lines[0].includes(configPath) && lines[0].includes('mount its directory'), lines[0]);

  const freshContainer = createHarness();
  freshContainer.deps = { ...freshContainer.deps, checkIsConfigOnContainerDisk: () => true };
  process.env.GROQ_API_KEY = 'gsk_fromTheEnvironment1234';
  try {
    createSttRuntime(freshContainer.deps).init();
  } finally {
    delete process.env.GROQ_API_KEY;
  }
  assert.ok(freshContainer.info.some((line) => line.includes('moved groq from the environment')), 'the old key was migrated');
  assert.ok(freshContainer.problems.some((line) => line.includes("container's own disk")), 'and the operator is told the file will not survive');

  const mountedConfig = createHarness();
  createSttRuntime(mountedConfig.deps).init();
  assert.ok(!mountedConfig.problems.some((line) => line.includes("container's own disk")), 'a mounted directory says nothing');
}));
