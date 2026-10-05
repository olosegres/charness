/**
 * @description What each issue's conversation was already told (Jira prompt
 * context C4): a request's blocks count as sent only once its prompt is taken
 * in; a superseded or cancelled request's never do; a build older than the last
 * committed one, or of an older generation, never rolls the sent-set back. Kept
 * on disk, so a restart or a hot reload keeps it — proven by a SECOND ledger
 * over the same folder.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JiraContextLedger, jiraContextDirName, jiraPendingBuildsMaxCount } from '../connectors/jira/contextLedger';

const issueKey = 'PROJ-12';
const sentA = { fields: { hash: 'a1' }, 'comment:1': { hash: 'c1', label: 'comment 1 by Ann from 2026-10-05' } };
const sentB = { fields: { hash: 'a2' }, 'comment:1': { hash: 'c1', label: 'comment 1 by Ann from 2026-10-05' }, 'comment:2': { hash: 'c2', label: 'comment 2 by Bob from 2026-10-06' } };

describe('JiraContextLedger', () => {
  let dataDir = '';
  let ledger: JiraContextLedger;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-context-'));
    ledger = JiraContextLedger.createForDataDir(dataDir);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('an issue never prompted: nothing sent, generation 0', () => {
    assert.deepEqual(ledger.getSnapshot(issueKey), { generation: 0, sent: {} });
  });

  it('a build counts as sent only once committed — never when it is built', () => {
    ledger.recordBuild(issueKey, 'req_1', 0, sentA);
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, {}, 'built and even forwarded is not taken in');
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, sentA);
  });

  it('a dropped build (superseded, cancelled) never counts; a later commit of it finds nothing', () => {
    ledger.recordBuild(issueKey, 'req_1', 0, sentA);
    ledger.drop(issueKey, 'req_1');
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, {});
  });

  it('an older build taken in after a newer one does not roll the sent-set back', () => {
    ledger.recordBuild(issueKey, 'req_old', 0, sentA);
    ledger.recordBuild(issueKey, 'req_new', 0, sentB);
    ledger.commit(issueKey, 'req_new');
    ledger.commit(issueKey, 'req_old');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, sentB);
  });

  it('a build of an older generation is dropped at commit: the agent lost that context since', () => {
    ledger.recordBuild(issueKey, 'req_1', -1, sentA);
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, {});
  });

  it('each commit is once: a second one of the same request changes nothing', () => {
    ledger.recordBuild(issueKey, 'req_1', 0, sentA);
    ledger.commit(issueKey, 'req_1');
    ledger.recordBuild(issueKey, 'req_2', 0, sentB);
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, sentA);
  });

  it('kept on disk: a new ledger over the same folder (a restart) knows the sent-set and the waiting builds', () => {
    ledger.recordBuild(issueKey, 'req_1', 0, sentA);
    ledger.commit(issueKey, 'req_1');
    ledger.recordBuild(issueKey, 'req_2', 0, sentB);
    const restarted = JiraContextLedger.createForDataDir(dataDir);
    assert.deepEqual(restarted.getSnapshot(issueKey).sent, sentA);
    restarted.commit(issueKey, 'req_2');
    assert.deepEqual(restarted.getSnapshot(issueKey).sent, sentB, 'a take-in after the restart commits the build made before it');
    const filePath = path.join(dataDir, jiraContextDirName, `${issueKey}.json`);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp')), []);
  });

  it('one issue\'s state is its own', () => {
    ledger.recordBuild(issueKey, 'req_1', 0, sentA);
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot('PROJ-13').sent, {});
  });

  it('an unreadable state file is a conversation told nothing: the next prompt is whole, never a guess', () => {
    fs.mkdirSync(path.join(dataDir, jiraContextDirName));
    fs.writeFileSync(path.join(dataDir, jiraContextDirName, `${issueKey}.json`), '{ not json');
    assert.deepEqual(JiraContextLedger.createForDataDir(dataDir).getSnapshot(issueKey), { generation: 0, sent: {} });
    fs.writeFileSync(path.join(dataDir, jiraContextDirName, `${issueKey}.json`), JSON.stringify({ generation: 'x' }));
    assert.deepEqual(JiraContextLedger.createForDataDir(dataDir).getSnapshot(issueKey), { generation: 0, sent: {} });
  });

  it('builds that never hear back are bounded: the oldest are forgotten, the newest still commit', () => {
    for (let index = 1; index <= jiraPendingBuildsMaxCount + 5; index += 1) ledger.recordBuild(issueKey, `req_${index}`, 0, { fields: { hash: `h${index}` } });
    ledger.commit(issueKey, 'req_1');
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, {}, 'the oldest was forgotten');
    ledger.commit(issueKey, `req_${jiraPendingBuildsMaxCount + 5}`);
    assert.deepEqual(ledger.getSnapshot(issueKey).sent, { fields: { hash: `h${jiraPendingBuildsMaxCount + 5}` } });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, jiraContextDirName, `${issueKey}.json`), 'utf8'));
    assert.ok(Object.keys(stored.pending).length <= jiraPendingBuildsMaxCount);
  });

  it('a key that is not a plain issue key still names a file inside the folder', () => {
    ledger.recordBuild('../../escape', 'req_1', 0, sentA);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, jiraContextDirName)), ['______escape.json']);
  });
});
