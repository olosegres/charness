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
      fallbackChain: [{ backend: 'claude', profile: 'default', model: null, disabled: true }],
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
    // And the one read feeds both: «default» is switched off in the chain (so «work» is the pick) and both profiles are listed.
    const out: string[] = [];
    await runClaudeProfilesCli(['--json'], { stdout: (text) => out.push(text) });
    const report = JSON.parse(out.join('')) as { recommended: string; profiles: Array<{ name: string }> };
    assert.equal(report.recommended, 'work');
    assert.deepEqual(report.profiles.map((profile) => profile.name), ['default', 'work']);
  });
});
