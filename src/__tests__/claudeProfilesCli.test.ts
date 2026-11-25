/**
 * `cli/claudeProfiles.ts` run in-process: `state.json` is read ONCE per call (the registry and the fallback chain are
 * both picked from that one read), whatever the flags. The built binary's behaviour is `cli.test.ts`.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handOverExitCode, openCodeRoleBestExitCode, parseClaudeProfilesCliArgs, runClaudeProfilesCli } from '../cli/claudeProfiles';
import { resetInstanceSettingsCache } from '../instanceSettings';
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
    const run = async (argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runClaudeProfilesCli(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
      return { stdout: out.join(''), stderr: err.join(''), code };
    };
    assert.equal(handOverExitCode, 3, 'its own code: not 0 (resumed), 1 (nothing usable) or 2 (a refused flag)');
    const handedOver = await run(['--best', '--current', 'default', '--last-run-ended-at', new Date().toISOString()]);
    assert.equal(handedOver.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`, 'the NEW worker\'s account');
    assert.match(handedOver.stderr, /^hand over: default can no longer run this worker → start a NEW worker on work \(CLAUDE_CONFIG_DIR=/);
    assert.equal(handedOver.code, handOverExitCode, 'a script that would resume the old session is stopped');
    const handedOverJson = await run(['--best', '--json', '--current', 'default', '--last-run-ended-at', new Date().toISOString()]);
    assert.equal(handedOverJson.code, handOverExitCode);
    assert.equal((JSON.parse(handedOverJson.stdout) as { resume: { verdict: string } }).resume.verdict, 'handOver');
    assert.equal((await run(['--current', 'default', '--last-run-ended-at', new Date().toISOString()])).code, 0, 'the human output is advice');
    // Without the list «default» resets first (12 h against 24 h): a worker that ran on «work» and went cold is handed over to it.
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    delete persisted.fallbackChain;
    for (const bucket of persisted.claudeProfiles.default.usage.buckets) bucket.resetsAt = new Date(Date.now() + 12 * hourMs).toISOString();
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(persisted));
    const cold = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date(Date.now() - 3 * hourMs).toISOString()]);
    assert.equal(cold.stdout, '\n', 'cold: the NEW worker\'s account is «default» (the default profile, set nothing) — not the old worker\'s «work», which stays `recommended`');
    assert.match(cold.stderr, /^hand over: work is cold /m);
    assert.equal(cold.code, handOverExitCode);
    // The human output of the same answer: the hand-over IS the verdict — no `recommended` line naming the old worker's own account.
    const human = await run(['--current', 'work', '--last-run-ended-at', new Date(Date.now() - 3 * hourMs).toISOString()]);
    assert.doesNotMatch(human.stdout, /recommended for/);
    assert.match(human.stdout, /^✓ default /m, 'the mark is where the NEXT process goes');
    assert.match(human.stdout, /^• work /m);
    assert.match(human.stdout, /\nhand over: work is cold /);
    assert.equal(human.code, 0, 'advice, not a script\'s verdict');
    const warmAgain = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date(Date.now() - 10 * 60_000).toISOString()]);
    assert.equal(warmAgain.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`, 'the same worker, warm: it stays');
    assert.equal(warmAgain.code, 0);
    const resumed = await run(['--best', '--current', 'work', '--last-run-ended-at', new Date().toISOString()]);
    assert.equal(resumed.stdout, `${path.join(dataDir, 'claude-profiles', 'work')}\n`);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.stderr.split('\n').filter((line) => line.startsWith('hand over')).length, 0);
  });

  it('--role: the line and `worker` of the operator\'s default from settings.json (a Fable role counts the Fable window), --best on an OpenCode role exits 4, and --role with --model or an unknown role is refused', async () => {
    assert.deepEqual(parseClaudeProfilesCliArgs(['--role', 'planner']), { ok: true, args: { isBest: false, isJson: false, model: null, role: 'planner', currentProfile: null, isStoppedByLimit: false, lastRunEndedAtMs: null } });
    assert.deepEqual(parseClaudeProfilesCliArgs(['--role', 'coder']), { ok: false, error: '--role needs one of: builder, storageBuilder, investigator, reviewer, miniReviewer, planner' });
    assert.deepEqual(parseClaudeProfilesCliArgs(['--role=planner', '--model', 'opus']), { ok: false, error: '--model or --role, not both: --model when the user or a general delegate skill names the worker\'s model, --role when nothing does' });
    // settings.json lives beside the env file the CLI loads: a throwaway one in the test's own folder.
    const previousEnvFile = process.env.ENV_FILE;
    const envFile = path.join(dataDir, '.env');
    fs.writeFileSync(envFile, '');
    process.env.ENV_FILE = envFile;
    resetInstanceSettingsCache();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ workerRoles: {
      builder: { cli: 'claude', model: 'fable', effort: 'high' },
      reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' },
    } }));
    const run = async (argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runClaudeProfilesCli(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
      return { stdout: out.join(''), stderr: err.join(''), code };
    };
    try {
      const planner = await run(['--role', 'planner']);
      assert.equal(planner.code, 0);
      assert.match(planner.stdout, /\nplanner: claude -p --model opus --effort xhigh — the bot's default for this role; a model the user or your general delegate skill names wins \| account: recommended for opus: work \(soonest weekly reset\)\n$/);
      const plannerJson = JSON.parse((await run(['--role', 'planner', '--json'])).stdout) as { worker: unknown; model: string | null };
      assert.deepEqual(plannerJson.worker, { role: 'planner', cli: 'claude', model: 'opus', effort: 'xhigh', isBuiltIn: true, unavailable: null });
      const builderJson = JSON.parse((await run(['--role', 'builder', '--json'])).stdout) as { worker: { isBuiltIn: boolean }; model: string | null; relevantBuckets: string[] };
      assert.equal(builderJson.worker.isBuiltIn, false);
      assert.equal(builderJson.model, 'fable', 'a Fable role is picked as a Fable process');
      assert.ok(builderJson.relevantBuckets.includes('weekly_scoped'), 'the Fable weekly window counts');
      const reviewer = await run(['--role', 'reviewer']);
      assert.match(reviewer.stdout, /\nreviewer: opencode run --model openai\/gpt-6-astra --variant medium — the bot's default for this role; [^\n]*; no Claude account needed\n$/);
      const reviewerJson = JSON.parse((await run(['--role', 'reviewer', '--json'])).stdout) as { worker: { unavailable: string | null } };
      assert.equal(reviewerJson.worker.unavailable, null, 'the CLI reads no catalog, so it never calls an OpenCode role unavailable');
      const best = await run(['--best', '--role', 'reviewer']);
      assert.equal(best.code, openCodeRoleBestExitCode);
      assert.equal(best.stdout, '');
      assert.match(best.stderr, /^reviewer: opencode run --model openai\/gpt-6-astra --variant medium — .* — no Claude account to pick\n$/);
      const bestClaude = await run(['--best', '--role', 'planner']);
      assert.deepEqual([bestClaude.code, bestClaude.stdout], [0, `${path.join(dataDir, 'claude-profiles', 'work')}\n`]);
      // A broken file: the built-in values apply and stderr says why.
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ workerRoles: { builder: { cli: 'claude', model: 'opus', effort: 'auto' } } }));
      resetInstanceSettingsCache();
      const broken = await run(['--role', 'builder', '--json']);
      assert.equal((JSON.parse(broken.stdout) as { worker: { model: string; effort: string } }).worker.effort, 'medium');
      assert.match(broken.stderr, /workerRoles\.builder\.effort/);
    } finally {
      if (previousEnvFile === undefined) delete process.env.ENV_FILE;
      else process.env.ENV_FILE = previousEnvFile;
      resetInstanceSettingsCache();
    }
  });
});
