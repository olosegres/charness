/**
 * @description The profile scan (`utils/claudeProfileSync.ts`) that keeps `state.claudeProfiles` in step with
 * `DATA_DIR/claude-profiles/` and the CLI's `auth status`, with no Telegram — what a `CONNECTORS=jira` instance runs at every
 * usage poll. A real `StateStore` over a temp `DATA_DIR`, real folders, a stand-in status probe that counts its calls. Pinned:
 *
 *   • a folder with a valid name and no record is adopted (`createdAt` from the folder, the probe's answer recorded), a signed-in one as
 *     such, a signed-out one as `loggedIn: false`; a probe that gives no answer leaves it `loggedIn: false` (never offered);
 *   • names the profile gate refuses (`default`, upper case, a dot, too long) and plain files are ignored;
 *   • a record is never overwritten by the adoption, and a profile removed through `/accounts` (record and folder gone) is not found
 *     again; the hidden `default` signed out (`isRemoved`) is not probed, so it is not brought back by the scan — a forced scan
 *     (the `/accounts` screen) does;
 *   • the scan is cheap: a signed-in profile with a fresh status is not probed again; a stale one, a signed-out one and one never
 *     probed are, and none of them more than once per retry window — a failed probe included; a forced scan probes everything;
 *   • a scan already under way is joined by one that is not forced.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../state';
import { createClaudeProfileLayout, removeClaudeProfileLayout, resolveClaudeProfileDir, type ClaudeAuthStatus } from '../utils/claudeProfiles';
import {
  claudeAuthStatusMaxAgeMs,
  claudeAuthStatusRetryMs,
  createClaudeProfileSync,
  listClaudeProfileFolders,
  recordClaudeProfileStatus,
} from '../utils/claudeProfileSync';

const signedIn = (email: string, overrides: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus => ({
  loggedIn: true, email, subscriptionType: 'max', orgName: null, authMethod: 'claude.ai', apiKeySource: null, billing: 'subscription', ...overrides,
});
const signedOut: ClaudeAuthStatus = { loggedIn: false, email: null, subscriptionType: null, orgName: null, authMethod: 'none', apiKeySource: null, billing: null };

let dataDir: string;
let homeClaudeDir: string;
let store: StateStore;
let clockMs: number;
/** What the stand-in probe answers per config dir (`null` key = `~/.claude`); an absent dir is a probe that gives no answer. */
let statusByDir: Map<string | null, ClaudeAuthStatus | null>;
let probedDirs: Array<string | null>;
let logLines: string[];

function makeSync() {
  return createClaudeProfileSync({
    store,
    getDataDir: () => dataDir,
    readStatus: async (configDir) => {
      probedDirs.push(configDir);
      return statusByDir.get(configDir) ?? null;
    },
    now: () => clockMs,
    log: (line) => logLines.push(line),
  });
}

/** A folder the way `createClaudeProfileLayout` makes it (the operator signs it in with `CLAUDE_CONFIG_DIR=<it> claude auth login`). */
function makeFolder(name: string): string {
  return createClaudeProfileLayout({ dataDir, name, homeClaudeDir });
}

describe('claudeProfileSync: the scan', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-sync-'));
    homeClaudeDir = path.join(dataDir, 'fake-home', '.claude');
    fs.mkdirSync(homeClaudeDir, { recursive: true });
    store = new StateStore(dataDir);
    await store.init();
    clockMs = Date.parse('2026-11-18T10:00:00.000Z');
    statusByDir = new Map([[null, signedIn('me@example.com')]]);
    probedDirs = [];
    logLines = [];
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('adopts a folder signed in by hand: a record, the probe\'s answer on it, the account offered', async () => {
    const dir = makeFolder('second');
    statusByDir.set(dir, signedIn('second@example.com', { subscriptionType: 'pro' }));

    const result = await makeSync().sync();

    assert.deepEqual(result.adopted, ['second']);
    const record = store.getClaudeProfileRecord('second');
    assert.equal(record?.loggedIn, true);
    assert.equal(record?.email, 'second@example.com');
    assert.equal(record?.subscriptionType, 'pro');
    assert.equal(record?.billing, 'subscription');
    assert.equal(record?.statusCheckedAt, new Date(clockMs).toISOString());
    assert.match(record?.createdAt ?? '', /^\d{4}-\d\d-\d\dT/);
    assert.equal(store.getClaudeProfileInfo('default')?.loggedIn, true, 'the default account is probed too, so it can take a limited session over');
    assert.ok(logLines.some((line) => line.includes('second') && line.includes('adopted')));
    assert.ok(logLines.every((line) => !line.includes('@example.com')), 'no e-mail in the log');
    // The record is on disk right away (the registry entry of a directory that already holds a login).
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).claudeProfiles.second.loggedIn, true);
  });

  it('records a folder that is not signed in as loggedIn: false', async () => {
    const dir = makeFolder('blank');
    statusByDir.set(dir, signedOut);

    await makeSync().sync();

    assert.equal(store.getClaudeProfileRecord('blank')?.loggedIn, false);
    assert.equal(store.getClaudeProfileRecord('blank')?.email, undefined);
  });

  it('a folder whose probe gives no answer is recorded not signed in, and asked again once the retry window has passed', async () => {
    makeFolder('silent');
    const sync = makeSync();

    await sync.sync();
    assert.equal(store.getClaudeProfileRecord('silent')?.loggedIn, false, 'unknown is never offered');
    assert.equal(store.getClaudeProfileRecord('silent')?.statusCheckedAt, undefined);

    probedDirs.length = 0;
    clockMs += claudeAuthStatusRetryMs - 1;
    await sync.sync();
    assert.deepEqual(probedDirs, [], 'a CLI that did not answer is not asked again at every poll');

    clockMs += 1;
    statusByDir.set(resolveClaudeProfileDir(dataDir, 'silent'), signedIn('late@example.com'));
    await sync.sync();
    assert.equal(store.getClaudeProfileRecord('silent')?.loggedIn, true, 'a sign-in by hand shows up at a later poll');
  });

  it('gives an adopted folder the links a profile needs before it is recorded — a folder already known is left alone, a failing layout does not stop the adoption', async () => {
    const root = path.join(dataDir, 'claude-profiles');
    fs.mkdirSync(path.join(root, 'bare'), { recursive: true });
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    makeFolder('known');
    await store.upsertClaudeProfileRecord('known', { createdAt: '2026-01-02T03:04:05.000Z' });
    const laidOut: string[] = [];
    const sync = createClaudeProfileSync({
      store,
      getDataDir: () => dataDir,
      readStatus: async () => null,
      ensureLayout: (name) => {
        laidOut.push(name);
        if (name === 'broken') throw new Error('EACCES');
        createClaudeProfileLayout({ dataDir, name, homeClaudeDir });
      },
      now: () => clockMs,
      log: (line) => logLines.push(line),
    });

    const result = await sync.sync();

    assert.deepEqual(result.adopted, ['bare', 'broken']);
    assert.deepEqual(laidOut, ['bare', 'broken'], 'only the folders about to be adopted');
    assert.ok(fs.lstatSync(path.join(root, 'bare', 'projects')).isSymbolicLink(), 'the transcripts are shared, so a conversation resumes under the account');
    assert.ok(logLines.some((line) => line.includes('broken') && line.includes('EACCES')));
    assert.ok(store.getClaudeProfileRecord('broken'), 'adopted all the same');
  });

  it('ignores a folder the profile gate refuses, and a plain file', async () => {
    const root = path.join(dataDir, 'claude-profiles');
    fs.mkdirSync(path.join(root, 'default'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Upper'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(root, 'a'.repeat(40)), { recursive: true });
    fs.mkdirSync(path.join(root, 'has space'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes'), 'not a profile');
    makeFolder('ok-name_1');

    const result = await makeSync().sync();

    assert.deepEqual(result.adopted, ['ok-name_1']);
    assert.deepEqual(Object.keys(store.getClaudeProfileRecords()), ['ok-name_1']);
    assert.deepEqual(listClaudeProfileFolders(dataDir).map((folder) => folder.name), ['ok-name_1']);
  });

  it('does not touch the record of a profile it already knows, and adopts in name order', async () => {
    makeFolder('zeta');
    makeFolder('alpha');
    makeFolder('known');
    await store.upsertClaudeProfileRecord('known', { createdAt: '2026-01-02T03:04:05.000Z', loggedIn: true, email: 'kept@example.com', statusCheckedAt: new Date(clockMs).toISOString() });

    const result = await makeSync().sync();

    assert.deepEqual(result.adopted, ['alpha', 'zeta']);
    assert.equal(store.getClaudeProfileRecord('known')?.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(store.getClaudeProfileRecord('known')?.email, 'kept@example.com');
    assert.ok(!probedDirs.includes(resolveClaudeProfileDir(dataDir, 'known')), 'a fresh signed-in profile is not even probed');
  });

  it('never brings back a profile the operator removed: its record and folder are gone, so there is nothing to adopt', async () => {
    const dir = makeFolder('gone');
    statusByDir.set(dir, signedIn('gone@example.com'));
    const sync = makeSync();
    await sync.sync();
    assert.ok(store.getClaudeProfileRecord('gone'));

    // `/accounts` remove: the folder first, then the record.
    removeClaudeProfileLayout(dataDir, 'gone');
    await store.removeClaudeProfileRecord('gone');
    probedDirs.length = 0;
    clockMs += claudeAuthStatusRetryMs;
    const result = await sync.sync({ isForced: true });

    assert.deepEqual(result.adopted, []);
    assert.equal(store.getClaudeProfileRecord('gone'), undefined);
    assert.ok(!probedDirs.includes(dir), 'its directory is not probed again');
  });

  it('a folder deleted between the listing and its adoption is not recorded', async () => {
    makeFolder('first');
    makeFolder('second');
    const sync = createClaudeProfileSync({
      store: {
        getClaudeProfileRecords: () => store.getClaudeProfileRecords(),
        getClaudeProfileRecord: (name) => store.getClaudeProfileRecord(name),
        getClaudeProfileInfo: (name) => store.getClaudeProfileInfo(name),
        // The operator removes the second profile while the first is being written.
        upsertClaudeProfileRecord: async (name, patch) => {
          await store.upsertClaudeProfileRecord(name, patch);
          if (name === 'first') removeClaudeProfileLayout(dataDir, 'second');
        },
      },
      getDataDir: () => dataDir,
      readStatus: async () => null,
      now: () => clockMs,
      log: () => {},
    });

    const result = await sync.sync();

    assert.deepEqual(result.adopted, ['first']);
    assert.equal(store.getClaudeProfileRecord('second'), undefined, 'no record for a folder that is gone');
  });

  it('does not probe a `default` the operator signed out — only a forced scan (the /accounts screen) reads it again', async () => {
    await store.upsertClaudeProfileRecord('default', { isRemoved: true, loggedIn: false, statusCheckedAt: new Date(clockMs - claudeAuthStatusMaxAgeMs * 2).toISOString() });
    // Whatever the CLI would say now (an `apiKeyHelper` in the home settings, say), the scan does not resurrect it.
    statusByDir.set(null, signedIn('me@example.com'));
    const sync = makeSync();

    const scan = await sync.sync();

    assert.deepEqual(scan.probed, []);
    assert.equal(store.getClaudeProfileInfo('default')?.isRemoved, true);
    assert.equal(store.getClaudeProfileInfo('default')?.loggedIn, false);

    const forced = await sync.sync({ isForced: true });
    assert.deepEqual(forced.probed, ['default']);
    assert.equal(store.getClaudeProfileInfo('default')?.isRemoved, undefined, 'signed in again, it is back — the screen\'s existing rule');
    assert.equal(store.getClaudeProfileInfo('default')?.loggedIn, true);
  });

  it('does not re-probe a fresh signed-in profile; a stale one, a signed-out one and one never probed are, once per retry window', async () => {
    const fresh = makeFolder('fresh');
    const out = makeFolder('out');
    statusByDir.set(fresh, signedIn('fresh@example.com'));
    statusByDir.set(out, signedOut);
    const sync = makeSync();
    await sync.sync();
    assert.equal(probedDirs.length, 3, 'default, fresh and out are probed on their first scan');

    // Soon after: the signed-in ones are fresh; the signed-out one waits out the retry window.
    probedDirs.length = 0;
    clockMs += 60_000;
    assert.deepEqual((await sync.sync()).probed, [], 'a poll a minute later spawns nothing');
    assert.deepEqual(probedDirs, []);

    // Past the retry window: only the signed-out profile is asked again (a sign-in by hand must show up).
    clockMs += claudeAuthStatusRetryMs;
    statusByDir.set(out, signedIn('out@example.com'));
    assert.deepEqual((await sync.sync()).probed, ['out']);
    assert.equal(store.getClaudeProfileRecord('out')?.loggedIn, true);

    // Past the status' age: the signed-in profiles are read again.
    probedDirs.length = 0;
    clockMs += claudeAuthStatusMaxAgeMs;
    assert.deepEqual((await sync.sync()).probed.sort(), ['default', 'fresh', 'out']);
    assert.equal(probedDirs.length, 3);
  });

  it('a forced scan probes every profile whatever its status says', async () => {
    const dir = makeFolder('second');
    statusByDir.set(dir, signedIn('second@example.com'));
    const sync = makeSync();
    await sync.sync();
    probedDirs.length = 0;

    const forced = await sync.sync({ isForced: true });

    assert.deepEqual(forced.probed.sort(), ['default', 'second']);
    assert.equal(forced.defaultStatus?.email, 'me@example.com');
    assert.equal(probedDirs.length, 2);
  });

  it('a scan under way is joined by one that is not forced (one probe per profile, not two)', async () => {
    makeFolder('second');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let probes = 0;
    const sync = createClaudeProfileSync({
      store,
      getDataDir: () => dataDir,
      readStatus: async () => {
        probes += 1;
        await held;
        return signedIn('x@example.com');
      },
      now: () => clockMs,
      log: () => {},
    });

    const first = sync.sync();
    const second = sync.sync();
    // Let the adoption's writes finish and both probes start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult, secondResult, 'the same scan');
    assert.equal(probes, 2, 'default and second, once each');
  });

  it('a probe that throws is a probe with no answer: logged, the folder still adopted, never offered', async () => {
    makeFolder('second');
    const sync = createClaudeProfileSync({
      store,
      getDataDir: () => dataDir,
      readStatus: async () => { throw new Error('spawn claude ENOENT'); },
      now: () => clockMs,
      log: (line) => logLines.push(line),
    });

    const result = await sync.sync();

    assert.deepEqual(result.adopted, ['second']);
    assert.equal(store.getClaudeProfileRecord('second')?.loggedIn, false);
    assert.ok(logLines.some((line) => line.includes('probe threw') && line.includes('ENOENT')));
  });
});

describe('recordClaudeProfileStatus', () => {
  it('records nothing for a failed probe and nothing for an added profile removed meanwhile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-record-'));
    try {
      const localStore = new StateStore(dir);
      await localStore.init();
      await recordClaudeProfileStatus(localStore, 'default', null);
      await recordClaudeProfileStatus(localStore, 'ghost', signedIn('ghost@example.com'));
      assert.deepEqual(localStore.getAllClaudeProfileInfos(), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the CLI\'s word on billing and the console key, and lifts the removed mark of a default that is signed in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-record-'));
    try {
      const localStore = new StateStore(dir);
      await localStore.init();
      await localStore.upsertClaudeProfileRecord('default', { isRemoved: true, loggedIn: false });
      await recordClaudeProfileStatus(localStore, 'default', signedIn('', { email: null, authMethod: 'api_key', apiKeySource: '/login managed key', billing: 'api' }), 1_800_000_000_000);
      const record = localStore.getClaudeProfileInfo('default');
      assert.equal(record?.isRemoved, undefined);
      assert.equal(record?.billing, 'api');
      assert.equal(record?.isConsoleLoginKey, true);
      assert.equal(record?.statusCheckedAt, new Date(1_800_000_000_000).toISOString());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
