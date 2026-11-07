/**
 * @description `charness claude-profiles credit` (`cli/claudeProfilesCredit.ts`) run in-process: the arguments are
 * validated (a malformed command line is exit 2 with the usage, a refusal exit 1), only an account billed to API credits
 * takes a figure, the figure goes to `DATA_DIR/claudeApiCredit.json` and NEVER to `state.json` (a live bot rewrites that
 * from its memory), `--clear` forgets it. The built binary through a running bot is `apiCreditE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseClaudeProfilesCreditArgs, runClaudeProfilesCreditCli } from '../cli/claudeProfilesCredit';
import { runClaudeProfilesCli } from '../cli/claudeProfiles';
import { claudeApiCreditFileName, readClaudeApiCreditAnchors, resetClaudeApiCreditCache } from '../utils/claudeApiCredit';

const nowMs = Date.parse('2026-11-07T10:00:00Z');

describe('parseClaudeProfilesCreditArgs', () => {
  const parse = (...argv: string[]) => parseClaudeProfilesCreditArgs(argv, nowMs);
  const error = (...argv: string[]): string => {
    const parsed = parse(...argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    return parsed.ok ? '' : parsed.error;
  };

  it('reads a figure with its grant and expiry, in either flag spelling, with or without a dollar sign', () => {
    assert.deepEqual(parse('api', '61.2', '--of', '200', '--expires', '2026-11-15'), {
      ok: true, args: { profile: 'api', change: { kind: 'set', remainingUsd: 61.2, grantUsd: 200, expiresOn: '2026-11-15' } },
    });
    assert.deepEqual(parse('api', '$61.20', '--of=200', '--expires=2026-11-15'), {
      ok: true, args: { profile: 'api', change: { kind: 'set', remainingUsd: 61.2, grantUsd: 200, expiresOn: '2026-11-15' } },
    });
    assert.deepEqual(parse('--of', '200', 'api', '0'), { ok: true, args: { profile: 'api', change: { kind: 'set', remainingUsd: 0, grantUsd: 200, expiresOn: null } } }, 'flags may come first; zero is a figure');
    assert.deepEqual(parse('api', '5'), { ok: true, args: { profile: 'api', change: { kind: 'set', remainingUsd: 5, grantUsd: null, expiresOn: null } } });
  });

  it('reads --clear for a profile', () => {
    assert.deepEqual(parse('api', '--clear'), { ok: true, args: { profile: 'api', change: { kind: 'clear' } } });
  });

  it('names what is wrong', () => {
    assert.match(error(), /profile name is missing/);
    assert.match(error('api'), /remaining amount in dollars is missing/);
    assert.match(error('api', 'lots'), /must be dollars like 61\.20, got "lots"/);
    assert.match(error('api', '-3'), /must be dollars/);
    assert.match(error('api', '1e3'), /must be dollars/);
    assert.match(error('api', '5', '6'), /unexpected argument: 6/);
    assert.match(error('api', '5', '--of'), /--of needs the size of the grant/);
    assert.match(error('api', '5', '--of', 'x'), /--of must be the grant in dollars, more than 0, got "x"/);
    assert.match(error('api', '5', '--of', '0'), /more than 0/);
    assert.match(error('api', '300', '--of', '200'), /remaining amount \(\$300\.00\) is more than the grant \(\$200\.00\)/);
    assert.match(error('api', '5', '--expires'), /--expires needs a day/);
    assert.match(error('api', '5', '--expires', '15.11.2026'), /--expires must be a calendar day, YYYY-MM-DD, got "15\.11\.2026"/);
    assert.match(error('api', '5', '--expires', '2026-02-30'), /calendar day/);
    assert.match(error('api', '5', '--expires', '2026-11-06'), /--expires 2026-11-06 is already over/);
    assert.match(error('api', '5', '--bogus'), /unknown option: --bogus/);
    assert.match(error('api', '5', '--clear'), /--clear takes no figure/);
    assert.match(error('api', '--clear', '--of', '200'), /--clear takes no figure/);
  });

  it('accepts today as the expiry: the credit lasts through that day', () => {
    assert.equal(parse('api', '5', '--expires', '2026-11-07').ok, true);
  });
});

describe('runClaudeProfilesCreditCli', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text), now: () => nowMs };
  const stateFilePath = () => path.join(dataDir, 'state.json');
  const creditFilePath = () => path.join(dataDir, claudeApiCreditFileName);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-credit-'));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    out.length = 0;
    err.length = 0;
    resetClaudeApiCreditCache();
    fs.writeFileSync(stateFilePath(), JSON.stringify({
      claudeProfiles: {
        default: { createdAt: '2026-10-01T00:00:00.000Z', loggedIn: true, billing: 'subscription' },
        api: { createdAt: '2026-10-02T00:00:00.000Z', loggedIn: true, billing: 'api' },
        other: { createdAt: '2026-10-03T00:00:00.000Z', loggedIn: true, billing: 'api' },
        legacy: { createdAt: '2026-10-04T00:00:00.000Z', loggedIn: true },
      },
    }));
  });

  afterEach(() => {
    mock.restoreAll();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores the figure for an API account in claudeApiCredit.json — and leaves state.json byte for byte as it was', async () => {
    const stateBefore = fs.readFileSync(stateFilePath(), 'utf8');
    const code = await runClaudeProfilesCreditCli(['api', '61.20', '--of', '200', '--expires', '2026-11-15'], io);
    assert.equal(code, 0, err.join(''));
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), {
      api: { remainingUsd: 61.2, grantUsd: 200, anchoredAt: '2026-11-07T10:00:00.000Z', expiresOn: '2026-11-15' },
    });
    assert.equal(fs.readFileSync(stateFilePath(), 'utf8'), stateBefore);
    assert.match(out.join(''), /API credit of "api": \$61\.20 left of \$200\.00, usable through 2026-11-15\./);
  });

  it('keeps only what was given: no grant, no expiry', async () => {
    assert.equal(await runClaudeProfilesCreditCli(['api', '5'], io), 0);
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), { api: { remainingUsd: 5, anchoredAt: '2026-11-07T10:00:00.000Z' } });
    assert.match(out.join(''), /^API credit of "api": \$5\.00 left\. /);
  });

  it('a new figure replaces the old one and leaves other accounts\' figures', async () => {
    await runClaudeProfilesCreditCli(['other', '9'], io);
    await runClaudeProfilesCreditCli(['api', '5'], io);
    await runClaudeProfilesCreditCli(['api', '4'], { ...io, now: () => nowMs + 3_600_000 });
    const anchors = readClaudeApiCreditAnchors(dataDir);
    assert.equal(anchors.api.remainingUsd, 4);
    assert.equal(anchors.api.anchoredAt, '2026-11-07T11:00:00.000Z', 'the new anchor is a new instant: spend counts from it');
    assert.equal(anchors.other.remainingUsd, 9);
  });

  it('refuses an account that is not billed to API credits, a legacy record, and an unknown name — naming the accounts that qualify', async () => {
    for (const profile of ['default', 'legacy', 'nobody']) {
      err.length = 0;
      assert.equal(await runClaudeProfilesCreditCli([profile, '5'], io), 1, profile);
      assert.match(err.join(''), new RegExp(`"${profile}" is not an account billed to API credits.*\\(api, other\\)`), profile);
    }
    assert.equal(fs.existsSync(creditFilePath()), false, 'nothing was written');
  });

  it('says so when there is no API account at all', async () => {
    fs.writeFileSync(stateFilePath(), JSON.stringify({ claudeProfiles: { default: { createdAt: '2026-10-01T00:00:00.000Z' } } }));
    assert.equal(await runClaudeProfilesCreditCli(['api', '5'], io), 1);
    assert.match(err.join(''), /there is none yet/);
  });

  it('a malformed command line is exit 2 with the usage, and writes nothing', async () => {
    assert.equal(await runClaudeProfilesCreditCli(['api', '300', '--of', '200'], io), 2);
    assert.match(err.join(''), /more than the grant[\s\S]*Usage: charness claude-profiles credit <profile> <remainingUsd>/);
    assert.equal(fs.existsSync(creditFilePath()), false);
  });

  it('--clear forgets the figure; clearing a profile without one is not an error; the figure of an account that left the registry can still be cleared', async () => {
    await runClaudeProfilesCreditCli(['api', '5'], io);
    await runClaudeProfilesCreditCli(['other', '6'], io);
    out.length = 0;
    assert.equal(await runClaudeProfilesCreditCli(['api', '--clear'], io), 0);
    assert.match(out.join(''), /figure of "api" is cleared/);
    assert.deepEqual(Object.keys(readClaudeApiCreditAnchors(dataDir)), ['other']);

    out.length = 0;
    assert.equal(await runClaudeProfilesCreditCli(['api', '--clear'], io), 0);
    assert.match(out.join(''), /"api" has no API credit figure/);

    fs.writeFileSync(stateFilePath(), JSON.stringify({ claudeProfiles: {} }));
    assert.equal(await runClaudeProfilesCreditCli(['other', '--clear'], io), 0);
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), {});
  });

  it('does not overwrite a broken file and says what to do', async () => {
    mock.method(console, 'warn', () => undefined);
    fs.writeFileSync(creditFilePath(), '{ not json');
    assert.equal(await runClaudeProfilesCreditCli(['api', '5'], io), 1);
    assert.match(err.join(''), /could not save the API credit figure: .*fix or delete/);
    assert.equal(fs.readFileSync(creditFilePath(), 'utf8'), '{ not json');
  });

  it('is what `charness claude-profiles credit …` runs', async () => {
    const stdout: string[] = [];
    assert.equal(await runClaudeProfilesCli(['credit', 'api', '7.5'], { stdout: (text) => stdout.push(text) }), 0);
    assert.equal(readClaudeApiCreditAnchors(dataDir).api.remainingUsd, 7.5);
    assert.match(stdout.join(''), /API credit of "api": \$7\.50 left/);
  });
});
