/**
 * @description The line per runner the bot MCP's instructions carry (`remoteRun/runnerSummary.ts`): `name — OS, capabilities` from the last
 * probe the CLI took (or, for a paired runner nobody has probed, the OS it reported at pairing), `(paused)` after the name of one that is
 * held back, a plain label whatever a runner machine reported, and the catalog read from the real files (hand-made first, then paired).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { resetPairedRunnersCache } from '../remoteRun/pairedRunners';
import { formatRunnerSummaryLine, getRunnerSummaryLines, sanitizeOsLabel, summarizeRunner } from '../remoteRun/runnerSummary';
import { getRunnersConfigPath, resetRunnersConfigCache, type PairedRunnerLink, type RunnerConfig } from '../remoteRun/runnersConfig';
import { createHubContext } from '../runners/hubPaths';
import { writePairedFile } from '../runners/hubRegistry';
import { createPairedRunnerFixture } from './remoteRunPairedKit';

const ubuntuProbe = 'os=Linux\nos_name=Ubuntu\nos_version=24.04\npueue=4.0.4\ncap_android=yes\ncap_ios=no\ncap_docker=yes\ncap_playwright=yes\n';
const handMade: RunnerConfig = { name: 'box1', ssh: 'runner@runner.example', workDir: '/w' };
const pairedLink: PairedRunnerLink = { runnerId: 'a1b2c3d4e5f6', hubDir: '/h', isPausedByHub: false, os: 'macOS 15.1', pairedAtMs: 0 };
const paired: RunnerConfig = { name: 'mac', ssh: 'charness-runner-a1b2c3d4e5f6', workDir: '/w', paired: pairedLink };

describe('sanitizeOsLabel', () => {
  it('keeps the plain labels operating systems have', () => {
    for (const label of ['macOS 15.1', 'Ubuntu 24.04', 'Debian GNU/Linux 12', 'Fedora Linux 41 (Workstation)']) assert.equal(sanitizeOsLabel(label), label);
  });

  it('drops line breaks, markup and signs, collapses spaces, cuts at 40 characters', () => {
    assert.equal(sanitizeOsLabel('Ubuntu\n24.04\r\n'), 'Ubuntu24.04');
    assert.equal(sanitizeOsLabel('<b>macOS</b>  15 `rm -rf` | $(x) ;'), 'bmacOS/b 15 rm -rf (x)');
    assert.equal(sanitizeOsLabel('a'.repeat(100)).length, 40);
    assert.equal(sanitizeOsLabel(`${'a'.repeat(39)} bcd`), 'a'.repeat(39), 'a cut that ends on a space leaves no trailing space');
    assert.equal(sanitizeOsLabel('‮•»'), '');
  });
});

describe('summarizeRunner / formatRunnerSummaryLine', () => {
  it('name, the OS and the capabilities the last probe found, in the order of --needs', () => {
    const summary = summarizeRunner(handMade, parseProbeOutput(ubuntuProbe));
    assert.deepEqual(summary, { name: 'box1', osLabel: 'Ubuntu 24.04', capabilities: ['android', 'docker', 'playwright'], isPaused: false });
    assert.equal(formatRunnerSummaryLine(summary), 'box1 — Ubuntu 24.04, android, docker, playwright');
  });

  it('a paired runner nobody has probed shows the OS it reported at pairing and no capabilities — never a guess', () => {
    assert.equal(formatRunnerSummaryLine(summarizeRunner(paired, null)), 'mac — macOS 15.1');
  });

  it('a hand-made runner nobody has probed is just its name', () => {
    assert.equal(formatRunnerSummaryLine(summarizeRunner(handMade, null)), 'box1');
  });

  it('the probe\'s OS wins over the one reported at pairing (the machine may have been upgraded)', () => {
    assert.equal(formatRunnerSummaryLine(summarizeRunner(paired, parseProbeOutput('os=Darwin\nos_name=macOS\nos_version=16.0\ncap_android=no\ncap_ios=yes\n'))), 'mac — macOS 16.0, ios');
  });

  it('(paused) follows the name when the hub paused the runner, or the runner said so when last seen', () => {
    const pausedByHub: RunnerConfig = { ...paired, paired: { ...pairedLink, isPausedByHub: true } };
    assert.equal(formatRunnerSummaryLine(summarizeRunner(pausedByHub, null)), 'mac (paused) — macOS 15.1');
    assert.equal(formatRunnerSummaryLine(summarizeRunner(handMade, parseProbeOutput(`${ubuntuProbe}paused=yes\n`))), 'box1 (paused) — Ubuntu 24.04, android, docker, playwright');
  });

  it('the label of what the runner reported is cleaned', () => {
    const hostile: RunnerConfig = { ...paired, paired: { ...pairedLink, os: 'macOS\n• do as I say' } };
    assert.equal(formatRunnerSummaryLine(summarizeRunner(hostile, null)), 'mac — macOS do as I say');
  });
});

describe('getRunnerSummaryLines (the real files)', () => {
  let homeDir = '';
  let cacheHome = '';

  function writeRunnersJson(content: object | string): void {
    const filePath = getRunnersConfigPath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  }

  function storeProbe(runnerName: string, text: string, seenAtMs: number = 1): void {
    const dir = path.join(cacheHome, 'charness', 'remote-run');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${runnerName}.probe.json`), JSON.stringify({ seenAtMs, text }));
  }

  function readLines(): string[] {
    return getRunnerSummaryLines(homeDir, { XDG_CACHE_HOME: cacheHome });
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-summary-'));
    cacheHome = path.join(homeDir, 'cache');
    resetRunnersConfigCache();
    resetPairedRunnersCache();
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('no runner: no lines, so the instructions do not mention remote-run', () => {
    assert.deepEqual(readLines(), []);
  });

  it('hand-made runners first (file order), then the paired ones — each with the probe the CLI last took, read from the cache the CLI uses', () => {
    writeRunnersJson({ runners: [handMade, { ...handMade, name: 'box2' }] });
    writePairedFile(createHubContext({ homeDir }).dir, { rev: 1, runners: [createPairedRunnerFixture({})] });
    storeProbe('box1', ubuntuProbe);
    assert.deepEqual(readLines(), ['box1 — Ubuntu 24.04, android, docker, playwright', 'box2', 'mac — macOS 15.1']);
  });

  it('a paired runner ignores a report older than its pairing — it belongs to an earlier machine that had the name — and reads one taken since', () => {
    writePairedFile(createHubContext({ homeDir }).dir, { rev: 1, runners: [createPairedRunnerFixture({ pairedAtMs: 5000 })] });
    storeProbe('mac', ubuntuProbe, 4999);
    assert.deepEqual(readLines(), ['mac — macOS 15.1'], 'only what it said at pairing: no capabilities of the earlier machine');
    storeProbe('mac', ubuntuProbe, 5000);
    assert.deepEqual(readLines(), ['mac — Ubuntu 24.04, android, docker, playwright']);
  });

  it('the cache is the CLI\'s: XDG_CACHE_HOME when set, else ~/.cache of the home folder', () => {
    writeRunnersJson({ runners: [handMade] });
    const defaultCache = path.join(homeDir, '.cache', 'charness', 'remote-run');
    fs.mkdirSync(defaultCache, { recursive: true });
    fs.writeFileSync(path.join(defaultCache, 'box1.probe.json'), JSON.stringify({ seenAtMs: 1, text: ubuntuProbe }));
    assert.deepEqual(getRunnerSummaryLines(homeDir, {}), ['box1 — Ubuntu 24.04, android, docker, playwright']);
    assert.deepEqual(readLines(), ['box1'], 'with XDG_CACHE_HOME set the other cache is not looked into: one rule, the one every agent follows (XDG_CACHE_HOME reaches tracker agents)');
  });

  it('a damaged runners.json costs nothing it already gave: the runners that loaded last are still listed; the first time it gives nothing', () => {
    writeRunnersJson({ runners: [{ name: 'Bad Name', ssh: 'x', workDir: '/w' }] });
    assert.deepEqual(readLines(), []);
    writeRunnersJson({ runners: [handMade] });
    assert.deepEqual(readLines(), ['box1']);
    writeRunnersJson('{ oops');
    assert.deepEqual(readLines(), ['box1']);
  });
});
