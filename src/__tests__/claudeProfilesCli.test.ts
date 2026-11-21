/**
 * `cli/claudeProfiles.ts` run in-process: `state.json` is read ONCE per call (the registry and the fallback chain are
 * both picked from that one read), whatever the flags. The built binary's behaviour is `cli.test.ts`.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseClaudeProfilesCliArgs, runClaudeProfilesCli } from '../cli/claudeProfiles';
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

  it('--last-run-ended-at: an ISO instant, only with --current; --best prints the NEW worker\'s account on a hand-over and says why on stderr, the resume prints its own and says nothing', async () => {
    const parsed = parseClaudeProfilesCliArgs(['--current', 'work', '--last-run-ended-at', '2026-11-21T12:30:00Z']);
    assert.deepEqual(parsed.ok && parsed.args.lastRunEndedAtMs, Date.parse('2026-11-21T12:30:00Z'));
    assert.deepEqual(parseClaudeProfilesCliArgs(['--last-run-ended-at=2026-11-21T12:30:00Z']), { ok: false, error: '--last-run-ended-at needs --current <name>' });
    for (const argv of [['--current', 'work', '--last-run-ended-at'], ['--current', 'work', '--last-run-ended-at', 'soon']]) {
      assert.deepEqual(parseClaudeProfilesCliArgs(argv), { ok: false, error: '--last-run-ended-at needs an ISO 8601 instant, e.g. 2026-11-21T12:30:00Z' }, argv.join(' '));
    }
    // «default» is switched off in the chain, so only «work» is offered: a worker that ran on «default» can no longer run there.
    const run = async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
      const out: string[] = [];
      const err: string[] = [];
      await runClaudeProfilesCli(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
      return { stdout: out.join(''), stderr: err.join('') };
    };
    const handedOver = await run(['--best', '--current', 'default', '--last-run-ended-at', new Date().toISOString()]);
    assert.equal(handedOver.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`, 'the NEW worker\'s account');
    assert.match(handedOver.stderr, /^hand over: default can no longer run this worker → start a NEW worker on work \(CLAUDE_CONFIG_DIR=/);
    // Without the list «default» resets first (12 h against 24 h): a worker that ran on «work» and went cold is handed over to it.
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    delete persisted.fallbackChain;
    for (const bucket of persisted.claudeProfiles.default.usage.buckets) bucket.resetsAt = new Date(Date.now() + 12 * hourMs).toISOString();
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(persisted));
    const cold = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date(Date.now() - 3 * hourMs).toISOString()]);
    assert.equal(cold.stdout, '\n', 'cold: the NEW worker\'s account is «default» (the default profile, set nothing) — not the old worker\'s «work», which stays `recommended`');
    assert.match(cold.stderr, /^hand over: work is cold /m);
    const warmAgain = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date(Date.now() - 10 * 60_000).toISOString()]);
    assert.equal(warmAgain.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`, 'the same worker, warm: it stays');
    const resumed = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date().toISOString()]);
    assert.equal(resumed.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`);
    assert.equal(resumed.stderr.split('\n').filter((line) => line.startsWith('hand over')).length, 0);
  });
});
