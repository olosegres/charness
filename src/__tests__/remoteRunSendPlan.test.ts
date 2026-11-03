/**
 * @description `remoteRun/sendPlan.ts`: which files go to the runner and what is held back — secret-looking files (`.env`, `.env.*`
 * but not their templates, `*.pem`, `*.p12`, `*.key`, `.npmrc`) unless `send:` names them (also when git ignores them), `exclude:`
 * beating `send:`, a name with a newline refused — and the rsync argument lists.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRsyncFetchArgs,
  buildRsyncGitArgs,
  buildRsyncMetaArgs,
  buildRsyncSendArgs,
  checkIsSecretLookingFile,
  formatHeldBackNotice,
  formatManifest,
  formatNulSeparatedList,
  formatSentOnRequestNotice,
  planSendList,
  rsyncNanosecondWindowArg,
} from '../remoteRun/sendPlan';

describe('checkIsSecretLookingFile', () => {
  it('names what looks like a secret, in any folder', () => {
    for (const name of ['.env', '.env.local', '.env.production', 'sub/dir/.env', 'cert.pem', 'a/b/id.key', 'store.p12', '.npmrc', 'packages/x/.npmrc']) {
      assert.equal(checkIsSecretLookingFile(name), true, name);
    }
  });

  it('lets templates and ordinary files through', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.local.example', 'environment.ts', 'key.ts', 'keyboard.md', 'pem.md', '.key', 'notes.pemx', 'src/.envrc']) {
      assert.equal(checkIsSecretLookingFile(name), false, name);
    }
  });
});

describe('planSendList', () => {
  const base = { files: ['src/a.ts', 'src/b.ts', '.env', 'cfg/.env.test', 'cfg/.env.example', 'fixtures/huge/x.bin', 'keys/deploy.pem'], ignoredFiles: [], exclude: [], send: [] };

  it('sends the ordinary files sorted and holds the secret-looking ones back', () => {
    const plan = planSendList(base);
    assert.deepEqual(plan.files, ['cfg/.env.example', 'fixtures/huge/x.bin', 'src/a.ts', 'src/b.ts']);
    assert.deepEqual(plan.heldBack, ['.env', 'cfg/.env.test', 'keys/deploy.pem']);
    assert.deepEqual(plan.refused, []);
  });

  it('`send:` opts a held-back file in; others stay held back', () => {
    const plan = planSendList({ ...base, send: ['cfg/.env.test'] });
    assert.ok(plan.files.includes('cfg/.env.test'));
    assert.deepEqual(plan.heldBack, ['.env', 'keys/deploy.pem']);
  });

  it('`--send` (callSend) opts a file in for the call: sent, listed as sent on request, not held back; `send:` files are not «on request»', () => {
    const plan = planSendList({ ...base, callSend: ['.env', 'keys/*.pem'], send: ['cfg/.env.test'] });
    assert.ok(['.env', 'keys/deploy.pem', 'cfg/.env.test'].every((file) => plan.files.includes(file)));
    assert.deepEqual(plan.heldBack, []);
    assert.deepEqual(plan.sentOnRequest, ['.env', 'keys/deploy.pem']);
    const without = planSendList(base);
    assert.deepEqual(without.sentOnRequest, []);
    assert.ok(!without.files.includes('.env'));
  });

  it('`--send` also reaches a file git ignores, and `exclude:` still wins over it', () => {
    const plan = planSendList({ ...base, ignoredFiles: ['.env.local', 'build/out.js'], callSend: ['.env.local', 'build/out.js'], exclude: ['build'] });
    assert.ok(plan.files.includes('.env.local'));
    assert.deepEqual(plan.sentOnRequest, ['.env.local']);
    assert.ok(!plan.files.includes('build/out.js'));
  });

  it('`send:` also brings in a file git ignores (the usual state of an .env), but only what it names', () => {
    const plan = planSendList({ ...base, ignoredFiles: ['.env.test', 'node_modules/x/index.js', 'build/out.js'], send: ['.env.test'] });
    assert.ok(plan.files.includes('.env.test'));
    assert.ok(!plan.files.includes('node_modules/x/index.js'));
    assert.ok(!plan.files.includes('build/out.js'));
  });

  it('without `send:` an ignored file is never sent', () => {
    const plan = planSendList({ ...base, ignoredFiles: ['.env.test'] });
    assert.ok(!plan.files.includes('.env.test'));
    assert.ok(!plan.heldBack.includes('.env.test'));
  });

  it('`exclude:` drops paths and wins over `send:`', () => {
    const plan = planSendList({ ...base, exclude: ['fixtures/huge', 'cfg'], send: ['cfg/.env.test'] });
    assert.ok(!plan.files.includes('fixtures/huge/x.bin'));
    assert.ok(!plan.files.includes('cfg/.env.test'));
    assert.ok(!plan.files.includes('cfg/.env.example'));
    assert.ok(!plan.heldBack.includes('cfg/.env.test'), 'an excluded file is not even reported as held back');
  });

  it('a name with a newline is refused — unless `exclude:` drops it (a `?` matches the newline), which is the way out the message names', () => {
    const plan = planSendList({ ...base, files: ['ok.ts', 'bad\nname.ts', '.env'], exclude: [] });
    assert.deepEqual(plan.refused, ['bad\nname.ts']);
    assert.ok(!plan.files.includes('bad\nname.ts'));
    const excluded = planSendList({ ...base, files: ['ok.ts', 'bad\nname.ts'], exclude: ['bad?name.ts'] });
    assert.deepEqual(excluded.refused, []);
    assert.deepEqual(excluded.files, ['ok.ts']);
  });
});

describe('the notices about secret-looking files', () => {
  it('held back: the count, the names (five, then «and N more») and both ways to send them', () => {
    assert.equal(
      formatHeldBackNotice(['.env']),
      'held back 1 secret-looking file: .env — send them for this call with --send <path>, or for every call with "send: <path>" in .remote-run (this line is said again only when the list changes)',
    );
    const many = Array.from({ length: 16 }, (_, index) => `fixtures/key${index}.pem`);
    const notice = formatHeldBackNotice(many);
    assert.match(notice, /^held back 16 secret-looking files: fixtures\/key0\.pem, fixtures\/key1\.pem, fixtures\/key2\.pem, fixtures\/key3\.pem, fixtures\/key4\.pem and 11 more — /);
    assert.ok(!notice.includes('key5.pem'));
  });

  it('sent on request: said as it is', () => {
    assert.equal(formatSentOnRequestNotice(['.env.test', 'keys/a.pem']), 'sending 2 secret-looking files named by --send: .env.test, keys/a.pem');
  });
});

describe('lists and rsync arguments', () => {
  it('the file list is NUL-terminated per name, the manifest newline-terminated', () => {
    assert.equal(formatNulSeparatedList(['a', 'b c']), 'a\0b c\0');
    assert.equal(formatManifest(['a', 'b c']), 'a\nb c\n');
    assert.equal(formatNulSeparatedList([]), '');
  });

  it('send: files-from stdin, NUL separated, copy-dest (never link-dest: a job that rewrites a file in place must not change a queued job\'s stage)', () => {
    const args = buildRsyncSendArgs({ sshCommand: 'ssh -o BatchMode=yes', sourceRoot: '/home/user/proj', destination: 'runner@host:/w/p/s/stage/j/', copyDestination: '/w/p/s/tree' });
    assert.deepEqual(args, ['-a', '--modify-window=-1', '--from0', '--files-from=-', '--copy-dest=/w/p/s/tree', '-e', 'ssh -o BatchMode=yes', '/home/user/proj/', 'runner@host:/w/p/s/stage/j/']);
    assert.ok(!args.some((argument) => argument.includes('link-dest')));
    assert.ok(!args.includes('--delete'), 'deletions are the job\'s step (the manifest diff), never rsync\'s --delete over the copy');
  });

  it('every quick-check transfer compares nanoseconds: a same-length edit within one second must not be taken for "unchanged"', () => {
    const send = buildRsyncSendArgs({ sshCommand: 'ssh', sourceRoot: '/p', destination: 'h:/s/', copyDestination: '/t' });
    const git = buildRsyncGitArgs({ sshCommand: 'ssh', sourceRoot: '/p', destination: 'h:/s/', copyDestination: '/t' });
    assert.ok(send.includes(rsyncNanosecondWindowArg) && git.includes(rsyncNanosecondWindowArg));
  });

  it('send without a copy to compare against has no --copy-dest', () => {
    assert.ok(!buildRsyncSendArgs({ sshCommand: 'ssh', sourceRoot: '/p', destination: 'h:/s/', copyDestination: null }).some((argument) => argument.startsWith('--copy-dest')));
  });

  it('.git goes as its own transfer into the stage dir\'s .git', () => {
    const args = buildRsyncGitArgs({ sshCommand: 'ssh', sourceRoot: '/p', destination: 'h:/s/j/', copyDestination: '/w/tree/.git/' });
    assert.deepEqual(args, ['-a', '--modify-window=-1', '--copy-dest=/w/tree/.git/', '-e', 'ssh', '/p/.git/', 'h:/s/j/.git/']);
  });

  it('meta files and the fetch of result files', () => {
    assert.deepEqual(buildRsyncMetaArgs({ sshCommand: 'ssh', sourceDirectory: '/tmp/m', destination: 'h:/j/' }), ['-rt', '-e', 'ssh', '/tmp/m/', 'h:/j/']);
    const fetchArgs = buildRsyncFetchArgs({ sshCommand: 'ssh', source: 'h:/w/jobs/j/artifacts', destinationDirectory: '/tmp/f' });
    assert.deepEqual(fetchArgs, ['-rt', '--no-links', '-e', 'ssh', 'h:/w/jobs/j/artifacts/', '/tmp/f/']);
    assert.ok(fetchArgs.includes('--no-links'), 'the runner is not trusted to write a symlink into the main box');
  });
});
