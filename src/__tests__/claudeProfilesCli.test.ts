/**
 * `cli/claudeProfiles.ts` run in-process: `state.json` is read ONCE per call (the registry and the fallback chain are
 * both picked from that one read), whatever the flags. The built binary's behaviour is `cli.test.ts`.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runClaudeProfilesCli } from '../cli/claudeProfiles';
import { writeClaudeApiCreditAnchor } from '../utils/claudeApiCredit';

const hourMs = 3_600_000;

describe('runClaudeProfilesCli', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-cli-'));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    const resetsAt = new Date(Date.now() + 24 * hourMs).toISOString();
    const record = (percent: number) => ({
      createdAt: '2026-10-01T00:00:00.000Z', loggedIn: true,
      usage: { fetchedAt: new Date().toISOString(), source: 'api', buckets: [{ kind: 'session', percent: 10, resetsAt, scopeModel: null }, { kind: 'weekly_all', percent, resetsAt, scopeModel: null }] },
    });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      claudeProfiles: { default: record(20), work: record(40) },
      fallbackChain: [{ backend: 'claude', profile: 'default', model: null, disabled: true }, { backend: 'claude', profile: 'work', model: null }],
    }));
  });

  afterEach(() => {
    mock.restoreAll();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads state.json once — the registry and the switched-off accounts come from the same read — for every flag combination', async () => {
    const stateFile = path.join(dataDir, 'state.json');
    const readFileSync = fs.readFileSync;
    const reads: string[] = [];
    mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === stateFile) reads.push(String(args[0]));
      return readFileSync(...args);
    });
    for (const argv of [[], ['--best'], ['--json'], ['--best', '--current', 'default', '--stopped-by-limit']]) {
      reads.length = 0;
      const out: string[] = [];
      await runClaudeProfilesCli(argv, { stdout: (text) => out.push(text), stderr: (text) => out.push(text) });
      assert.equal(reads.length, 1, `${argv.join(' ') || '(no flags)'}: ${out.join('')}`);
    }
    // And the one read feeds both: «default» is switched off in the chain and «work» is listed (so «work» is the pick) and both profiles are listed.
    const out: string[] = [];
    await runClaudeProfilesCli(['--json'], { stdout: (text) => out.push(text) });
    const report = JSON.parse(out.join('')) as { recommended: string; profiles: Array<{ name: string }> };
    assert.equal(report.recommended, 'work');
    assert.deepEqual(report.profiles.map((profile) => profile.name), ['default', 'work']);
  });
  it('--json carries the credit estimate of an API account — the very report the claude_profiles tool answers (the bot calls the same composer)', async () => {
    const stateFile = path.join(dataDir, 'state.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    persisted.claudeProfiles.console = {
      createdAt: '2026-10-02T00:00:00.000Z', loggedIn: true, billing: 'api',
      creditSpend: { since: '2026-11-07T08:00:00.000Z', usd: 6.51 },
    };
    fs.writeFileSync(stateFile, JSON.stringify(persisted));
    writeClaudeApiCreditAnchor(dataDir, 'console', { remainingUsd: 67.71, grantUsd: 200, anchoredAt: '2026-11-07T08:00:00.000Z', expiresOn: '2099-12-31' });
    const out: string[] = [];
    await runClaudeProfilesCli(['--json'], { stdout: (text) => out.push(text) });
    const report: { profiles: Array<{ name: string; spentUsd: number | null; remainingEstimateUsd: number | null; expiresOn: string | null; probablyUsedUp: boolean }> } = JSON.parse(out.join(''));
    const entry = report.profiles.find((profile) => profile.name === 'console');
    assert.deepEqual([entry?.spentUsd, entry?.remainingEstimateUsd, entry?.expiresOn, entry?.probablyUsedUp], [6.51, 61.2, '2099-12-31', false]);
    const subscription = report.profiles.find((profile) => profile.name === 'work');
    assert.deepEqual([subscription?.spentUsd, subscription?.remainingEstimateUsd], [null, null], 'a subscription account has none');
  });
});
