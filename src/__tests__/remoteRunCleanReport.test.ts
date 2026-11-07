/**
 * @description `remoteRun/cleanReport.ts`: what a runner\'s `clean` answer means (`removed` · `absent` · `busy` with its kind and job · `stuck`; anything else is a failure), which outcomes fail the command, and the
 * line printed for every outcome — what was freed, or why nothing was removed and what to do.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsCleanFailure, formatCleanLine, parseCleanAnswer, type CleanOutcome } from '../remoteRun/cleanReport';

const slug = 'myapp-0a1b2c3d4e';

describe('parseCleanAnswer', () => {
  it('a removed copy: what the disk\'s free space grew by, in megabytes', () => {
    assert.deepEqual(parseCleanAnswer(`removed=${slug} freed_kb=41943040 why=clean\n`, slug), { kind: 'removed', freedMb: 40960 });
    assert.deepEqual(parseCleanAnswer(`removed=${slug} freed_kb= why=clean\n`, slug), { kind: 'removed', freedMb: null }, 'df said nothing');
  });

  it('absent, stuck, and busy with its kind and job (`-` = no job)', () => {
    assert.deepEqual(parseCleanAnswer(`absent=${slug}\n`, slug), { kind: 'absent' });
    assert.deepEqual(parseCleanAnswer(`stuck=${slug}\n`, slug), { kind: 'stuck' });
    assert.deepEqual(parseCleanAnswer(`busy=${slug} kind=running job=box1-abc234\n`, slug), { kind: 'busy', reason: 'running', jobId: 'box1-abc234' });
    assert.deepEqual(parseCleanAnswer(`busy=${slug} kind=exec job=-\n`, slug), { kind: 'busy', reason: 'exec', jobId: null });
  });

  it('only an answer about THIS copy counts, and only a kind the runner script has: anything else is a failure naming nothing it was not told', () => {
    for (const text of ['', 'work=/w\n', `removed=other-0000000000 freed_kb=1 why=clean\n`, `absent=other-0000000000\n`, `busy=${slug} kind=teapot job=-\n`, `removed=${slug} freed_kb=1 why=idle junk\n`]) {
      assert.deepEqual(parseCleanAnswer(text, slug), { kind: 'failed', message: 'the runner did not say what it did with the copy' }, JSON.stringify(text));
    }
  });
});

describe('which outcomes fail the command', () => {
  const outcomes: Array<[CleanOutcome, boolean]> = [
    [{ kind: 'removed', freedMb: 1 }, false],
    [{ kind: 'absent' }, false],
    [{ kind: 'unreachable', reason: 'the runner is not connected' }, false],
    [{ kind: 'busy', reason: 'running', jobId: 'box1-abc234' }, true],
    [{ kind: 'stuck' }, true],
    [{ kind: 'timedOut', timeoutMinutes: 15 }, true],
    [{ kind: 'failed', message: 'x' }, true],
  ];
  for (const [outcome, isFailure] of outcomes) {
    it(`${outcome.kind}: ${isFailure ? 'the copy is still there although it was asked to go' : 'nothing the caller must act on'}`, () => {
      assert.equal(checkIsCleanFailure(outcome), isFailure);
    });
  }
});

describe('formatCleanLine', () => {
  it('says what was freed, or that there was nothing', () => {
    assert.equal(formatCleanLine('mac', slug, { kind: 'removed', freedMb: 41 * 1024 }), `mac: removed the project copy ${slug} (freed 41 GB)`);
    assert.equal(formatCleanLine('mac', slug, { kind: 'removed', freedMb: null }), `mac: removed the project copy ${slug}`);
    assert.equal(formatCleanLine('mac', slug, { kind: 'absent' }), `mac: no copy of ${slug} (nothing to clean)`);
  });

  it('for every reason a copy is in use says it, names the job and what to do', () => {
    const busy = (reason: Extract<CleanOutcome, { kind: 'busy' }>['reason'], jobId: string | null): string => formatCleanLine('mac', slug, { kind: 'busy', reason, jobId });
    assert.equal(busy('running', 'box1-abc234'), 'mac: NOT cleaned — box1-abc234 is running in it — `charness remote-run wait box1-abc234` (or `kill box1-abc234`), then clean again');
    assert.equal(busy('queued', 'box1-abc234'), 'mac: NOT cleaned — box1-abc234 waits in the queue for it — `charness remote-run kill box1-abc234` (or wait for it), then clean again');
    assert.equal(busy('submitting', 'box1-abc234'), 'mac: NOT cleaned — box1-abc234 is still being submitted — clean again in a minute');
    assert.equal(busy('exec', null), 'mac: NOT cleaned — an `exec` is running in it — clean again when it ends');
    assert.equal(busy('lock', 'box1-abc234'), 'mac: NOT cleaned — its project lock is held by box1-abc234 — clean again when that job ends');
    assert.equal(busy('lock', null), 'mac: NOT cleaned — its project lock is held — clean again when that job ends');
    assert.match(busy('results', 'box1-abc234'), /^mac: NOT cleaned — box1-abc234 ended a moment ago/);
    assert.match(busy('name', null), /not the name of a copy/);
  });

  it('a copy that would not go, a runner that could not be reached, one that ran out of time and one that failed each say so and what stays', () => {
    assert.equal(formatCleanLine('mac', slug, { kind: 'stuck' }), `mac: NOT cleaned completely — the copy ${slug} would not go (read-only or in use); clean again later`);
    assert.equal(formatCleanLine('mac', slug, { kind: 'unreachable', reason: 'the runner is not connected' }), `mac: not reached (the runner is not connected) — its copy of ${slug}, if any, stays; clean again when it is back`);
    assert.equal(formatCleanLine('mac', slug, { kind: 'timedOut', timeoutMinutes: 15 }), 'mac: still cleaning after 15 minutes (a big copy) — the runner carries on as far as it can; clean again to finish');
    assert.equal(formatCleanLine('mac', slug, { kind: 'failed', message: 'ssh: the key was rejected' }), 'mac: NOT cleaned — ssh: the key was rejected');
  });
});
