/**
 * The sectioned mid-turn inbox (`utils/midTurnInbox.ts`): one file per Claude session, the project board's section and the accounts
 * note's joined in it, each offered and withdrawn on its own rules, the FILE taken whole by the `PostToolUse` hook — which runs here
 * exactly as `sh` runs it in a launch. The todo board's own paths over it are `todoMidTurn.test.ts`'s.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { buildMidTurnInboxHookCommand, createMidTurnInbox, getMidTurnInboxDir, midTurnInboxSections, type MidTurnInbox, type MidTurnInboxSection } from '../utils/midTurnInbox';

const key = makeTelegramKey(-1001111111111, 301);
const otherKey = makeTelegramKey(-1001111111111, 302);
const sessionId = '5a836301-382a-444f-8076-26b744c36d01';
const otherSessionId = '9b1c2d3e-0000-4444-8888-aaaaaaaaaaaa';

let dataDir: string;
let inbox: MidTurnInbox;
let events: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-midturn-inbox-'));
  inbox = createMidTurnInbox({ inboxDir: getMidTurnInboxDir(dataDir) });
  events = [];
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const inboxPath = (id: string = sessionId): string => path.join(getMidTurnInboxDir(dataDir), `${id}.json`);
const readContext = (id: string = sessionId): string => JSON.parse(fs.readFileSync(inboxPath(id), 'utf8')).hookSpecificOutput.additionalContext;

function offerSection(section: MidTurnInboxSection, text: string, target = key, id: string = sessionId): boolean {
  return inbox.offer(target, id, section, { text, onTaken: () => events.push(`taken ${section}`), onWithdrawn: () => events.push(`withdrawn ${section}`) });
}

/** The hook as a launch runs it, for the session that makes a tool call. */
function runHook(id: string = sessionId): string {
  return spawnSync('sh', ['-c', buildMidTurnInboxHookCommand(getMidTurnInboxDir(dataDir))], { input: JSON.stringify({ session_id: id, hook_event_name: 'PostToolUse' }), encoding: 'utf8' }).stdout;
}

describe('sections of one file', () => {
  it('the accounts note is joined before the project board, whichever is offered first, and one hook run delivers both', () => {
    offerSection('todoBoard', 'BOARD');
    offerSection('accounts', 'NOTE');
    assert.equal(readContext(), 'NOTE\n\nBOARD');
    assert.deepEqual(midTurnInboxSections, ['accounts', 'todoBoard']);
    assert.equal(JSON.parse(runHook()).hookSpecificOutput.additionalContext, 'NOTE\n\nBOARD');
    assert.deepEqual(events, [], 'taken is told when the inbox is looked at, not by the hook');
    inbox.reconcile(key);
    assert.deepEqual(events, ['taken accounts', 'taken todoBoard'], 'each section told once, in order');
    inbox.reconcile(key);
    assert.deepEqual(events, ['taken accounts', 'taken todoBoard']);
    assert.deepEqual(fs.readdirSync(getMidTurnInboxDir(dataDir)), []);
  });

  it('withdrawing one section leaves the other waiting and rewrites the file without it; withdrawing the last removes the file', () => {
    offerSection('accounts', 'NOTE');
    offerSection('todoBoard', 'BOARD');
    inbox.withdraw(key, 'accounts');
    assert.equal(readContext(), 'BOARD');
    assert.deepEqual(events, ['withdrawn accounts']);
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), false);
    assert.equal(inbox.checkIsWaiting(key, 'todoBoard'), true);
    inbox.withdraw(key, 'todoBoard');
    assert.equal(fs.existsSync(inboxPath()), false);
    assert.deepEqual(events, ['withdrawn accounts', 'withdrawn todoBoard']);
    inbox.withdraw(key, 'todoBoard');
    assert.deepEqual(events, ['withdrawn accounts', 'withdrawn todoBoard'], 'nothing to withdraw: nothing told');
  });

  it('a newer offer of a section replaces its text and withdraws the replaced one; the other section is untouched', () => {
    offerSection('todoBoard', 'BOARD');
    offerSection('accounts', 'NOTE 1');
    offerSection('accounts', 'NOTE 2');
    assert.equal(readContext(), 'NOTE 2\n\nBOARD');
    assert.deepEqual(events, ['withdrawn accounts']);
  });

  it('a withdrawal that finds the file already taken counts the sections as taken, not withdrawn', () => {
    offerSection('accounts', 'NOTE');
    offerSection('todoBoard', 'BOARD');
    runHook();
    inbox.withdraw(key, 'accounts');
    assert.deepEqual(events, ['taken accounts', 'taken todoBoard'], 'the agent read both: neither stays due or unseen');
  });

  it('a section waits per conversation: another conversation\'s inbox is its own file and its own sections', () => {
    offerSection('accounts', 'NOTE', key, sessionId);
    offerSection('accounts', 'NOTE B', otherKey, otherSessionId);
    inbox.withdraw(key, 'accounts');
    assert.equal(fs.existsSync(inboxPath(sessionId)), false);
    assert.equal(readContext(otherSessionId), 'NOTE B');
    assert.equal(inbox.checkIsWaiting(otherKey, 'accounts'), true);
  });

  it('the hook of one session never takes another session\'s inbox', () => {
    offerSection('accounts', 'NOTE', key, sessionId);
    assert.equal(runHook(otherSessionId), '');
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), true);
    assert.deepEqual(events, []);
  });
});

describe('a conversation whose session changed, a session id that is no file name, a file that cannot be written', () => {
  it('an offer for another session of the conversation withdraws the old session\'s sections first — a new process never reads an old one\'s file', () => {
    offerSection('accounts', 'NOTE', key, sessionId);
    offerSection('todoBoard', 'BOARD', key, sessionId);
    offerSection('accounts', 'NOTE 2', key, otherSessionId);
    assert.deepEqual(events, ['withdrawn accounts', 'withdrawn todoBoard']);
    assert.equal(fs.existsSync(inboxPath(sessionId)), false);
    assert.equal(readContext(otherSessionId), 'NOTE 2');
  });

  it('an id that would leave the inbox writes nothing and offers nothing', () => {
    assert.equal(offerSection('accounts', 'NOTE', key, '../escape'), false);
    assert.equal(offerSection('accounts', 'NOTE', key, 'a/b'), false);
    assert.equal(fs.existsSync(getMidTurnInboxDir(dataDir)), false);
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), false);
  });

  it('a write that fails throws and leaves nothing waiting for the new text — the previous offer, if any, stays the one the agent reads', () => {
    offerSection('todoBoard', 'BOARD');
    // A directory where the file goes: the atomic rename onto it fails.
    fs.rmSync(inboxPath());
    fs.mkdirSync(inboxPath());
    fs.writeFileSync(path.join(inboxPath(), 'keep'), 'x');
    assert.throws(() => offerSection('accounts', 'NOTE'));
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), false, 'the failed offer is not registered');
    assert.equal(inbox.checkIsWaiting(key, 'todoBoard'), true, 'the earlier one is');
    assert.deepEqual(events, []);
  });
});

describe('a withdrawal whose rewrite of the file fails', () => {
  it('removes the file whole and gives EVERY section back — the withdrawn text must never be left for a later turn\'s hook; the failure is thrown for the caller to log', () => {
    offerSection('accounts', 'NOTE');
    offerSection('todoBoard', 'BOARD');
    // A directory where the bot\'s temp file goes: the rewrite of the file without the withdrawn section throws.
    fs.mkdirSync(`${inboxPath()}.${process.pid}.tmp`);
    assert.throws(() => inbox.withdraw(key, 'accounts'));
    assert.equal(fs.existsSync(inboxPath()), false, 'no stale text is left for the hook');
    assert.equal(runHook(), '');
    assert.deepEqual([...events].sort(), ['withdrawn accounts', 'withdrawn todoBoard'], 'both are told: neither stays «in flight» nor «offered»');
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), false);
    assert.equal(inbox.checkIsWaiting(key, 'todoBoard'), false);
  });

  it('a later offer starts clean after it', () => {
    offerSection('accounts', 'NOTE');
    offerSection('todoBoard', 'BOARD');
    fs.mkdirSync(`${inboxPath()}.${process.pid}.tmp`);
    assert.throws(() => inbox.withdraw(key, 'accounts'));
    fs.rmdirSync(`${inboxPath()}.${process.pid}.tmp`);
    events.length = 0;
    offerSection('accounts', 'NOTE 2');
    assert.equal(readContext(), 'NOTE 2');
    assert.deepEqual(events, []);
  });
});

describe('boot and leftovers', () => {
  it('clearAll removes every inbox, a session that ended and left one included, and tells each waiting section it was withdrawn', () => {
    offerSection('accounts', 'NOTE');
    fs.writeFileSync(inboxPath('left-by-an-ended-session'), '{}');
    inbox.clearAll();
    assert.equal(fs.existsSync(getMidTurnInboxDir(dataDir)), false);
    assert.deepEqual(events, ['withdrawn accounts']);
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), false);
  });

  it('a copy a hook moved aside and never removed goes at the next withdrawal — once that hook is gone, never while it may still read it', () => {
    const dead = spawnSync('true').pid;
    const dir = getMidTurnInboxDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.json.${dead}`), 'x');
    fs.writeFileSync(path.join(dir, `${sessionId}.json.${process.pid}`), 'x');
    inbox.withdraw(key, 'accounts');
    assert.deepEqual(fs.readdirSync(dir), [`${sessionId}.json.${process.pid}`]);
  });

  it('a reconcile of every conversation finds each taken file once', () => {
    offerSection('accounts', 'NOTE', key, sessionId);
    offerSection('accounts', 'NOTE B', otherKey, otherSessionId);
    runHook(otherSessionId);
    inbox.reconcile();
    assert.deepEqual(events, ['taken accounts']);
    assert.equal(inbox.checkIsWaiting(key, 'accounts'), true);
  });
});
