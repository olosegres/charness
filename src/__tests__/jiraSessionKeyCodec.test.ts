/**
 * @description The Jira session key (Jira connector plan J1, D5): the
 * `jira:<PROJECT>:<ISSUE-KEY>` spelling, and the codec-owned slug inverse that
 * reads a Jira key back from a tmux session name and a json-stream directory
 * name — a key with two `:` that the old last-separator split could not
 * round-trip. Telegram's names must stay byte-identical.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyFromString,
  keyToSlug,
  keyToString,
  registerSessionKeyCodec,
  tryKeyFromSlug,
  tryKeyFromString,
  unregisterSessionKeyCodec,
  type SessionKey,
} from '../sessionKey';
import { jiraSessionKeyCodec, makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { makeTelegramKey, telegramSessionKeyCodec } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';
import { buildTmuxSessionName, parseTmuxSessionName } from '../utils/tmuxSessionName';
import {
  buildJsonStreamTmuxSessionName,
  parseJsonStreamDirName,
  parseJsonStreamTmuxSessionName,
  resolveJsonStreamSessionDir,
} from '../utils/jsonStreamHost';

const issueKey: SessionKey = makeJiraKey('PROJ-12');
/** A project key with `_`: the slug separator of directory names. */
const underscoreKey: SessionKey = makeJiraKey('MY_PROJ-345');

describe('the Jira key', () => {
  it('is spelled jira:<PROJECT>:<ISSUE-KEY> and round-trips through the registry', () => {
    assert.deepEqual(issueKey, { platform: 'jira', space: 'PROJ', thread: 'PROJ-12' });
    assert.equal(keyToString(issueKey), 'jira:PROJ:PROJ-12');
    assert.deepEqual(keyFromString('jira:PROJ:PROJ-12'), issueKey);
    assert.deepEqual(keyFromString(keyToString(underscoreKey)), underscoreKey);
  });

  it('refuses a string that is not one issue of its project', () => {
    for (const foreign of [
      'jira:PROJ:OTHER-12', // the issue belongs to another project
      'jira:proj:proj-12', // lower case
      'jira:PROJ:PROJ-', // no number
      'jira:PROJ:PROJ-12:extra',
      'jira:1PROJ:1PROJ-2', // a project key starts with a letter
      'jira:PROJ-12',
      'jira:PROJ:PROJ-012', // a second spelling of PROJ-12
      'jira:PROJ:PROJ-0', // Jira numbers issues from 1
    ]) {
      assert.equal(jiraSessionKeyCodec.matches(foreign), false, foreign);
      assert.equal(tryKeyFromString(foreign), null, foreign);
    }
  });

  it('is only built for a real issue key, and the error names what the caller passed', () => {
    for (const notAnIssue of ['not an issue', 'PROJ12', 'PROJ-012', 'proj-12', 'PROJ-12-3']) {
      assert.throws(
        () => makeJiraKey(notAnIssue),
        (error: Error) => error.message === `Invalid Jira issue key: "${notAnIssue}"`,
        notAnIssue,
      );
    }
  });

  it('refuses to serialize a key it could not read back', () => {
    // An issue of another project: encoding it would write a state.json field
    // that the next load drops, and a tmux name nothing re-adopts or reaps.
    const undecodable: SessionKey = { platform: 'jira', space: 'PROJ', thread: 'OTHER-1' };
    assert.throws(() => keyToString(undecodable), /Invalid Jira SessionKey: "jira:PROJ:OTHER-1"/);
  });

  it('and a Telegram key never claim each other\'s strings', () => {
    assert.equal(telegramSessionKeyCodec.matches('jira:PROJ:PROJ-12'), false);
    assert.equal(jiraSessionKeyCodec.matches('-1001234567890:42'), false);
  });
});

describe('the slug inverse', () => {
  it('reads a Jira key back from a tmux session name', () => {
    const name = buildTmuxSessionName('claude', issueKey);
    assert.equal(name, 'claude-jira-PROJ-PROJ-12');
    assert.deepEqual(parseTmuxSessionName('claude', name), issueKey);
    assert.deepEqual(parseTmuxSessionName('term', buildTmuxSessionName('term', underscoreKey)), underscoreKey);
  });

  it('reads a Jira key back from the json-stream host dir and its tmux name', () => {
    const dir = resolveJsonStreamSessionDir('/data/dir', underscoreKey);
    assert.equal(dir, '/data/dir/jsonstream/jira_MY_PROJ_MY_PROJ-345');
    // Several `_` are split candidates; only the split where both halves name one project matches.
    assert.deepEqual(parseJsonStreamDirName('jira_MY_PROJ_MY_PROJ-345'), underscoreKey);
    assert.deepEqual(parseJsonStreamTmuxSessionName(buildJsonStreamTmuxSessionName(issueKey)), issueKey);
  });

  it('keeps the Telegram names byte-identical and still parses them', () => {
    const telegramKey = makeTelegramKey(-1001111111111, 4242);
    assert.equal(buildTmuxSessionName('claude', telegramKey), 'claude--1001111111111-4242');
    assert.deepEqual(parseTmuxSessionName('claude', 'claude--1001111111111-4242'), telegramKey);
    assert.equal(resolveJsonStreamSessionDir('/data/dir', telegramKey), '/data/dir/jsonstream/-1001111111111_4242');
    assert.deepEqual(parseJsonStreamDirName('-1001111111111_4242'), telegramKey);
  });

  it('claims nothing that no codec owns', () => {
    // `12345` has no separator: no split may invent one (it would read as `1234:12345`).
    for (const foreign of ['jira-PROJ-OTHER-1', 'jira_PROJ', 'my-dev-shell', 'jira-proj-proj-1', '12345']) {
      assert.equal(tryKeyFromSlug(foreign, '-'), null, foreign);
    }
    assert.equal(parseJsonStreamDirName('jira_PROJ_OTHER-1'), null);
    assert.equal(tryKeyFromSlug('jira-PROJ-PROJ-012', '-'), null);
  });

  it('skips a registered codec that cannot read slugs, instead of stopping at it', () => {
    // Put the test double (no decodeSlug) FIRST, so every other codec is asked after it.
    unregisterSessionKeyCodec('telegram');
    unregisterSessionKeyCodec('jira');
    registerTestSessionKeyCodec();
    registerSessionKeyCodec(telegramSessionKeyCodec);
    registerSessionKeyCodec(jiraSessionKeyCodec);
    try {
      assert.deepEqual(tryKeyFromSlug('-1001111111111-4242', '-'), makeTelegramKey(-1001111111111, 4242));
      assert.deepEqual(tryKeyFromSlug('jira-PROJ-PROJ-12', '-'), issueKey);
      assert.equal(tryKeyFromSlug(keyToSlug(makeTestKey('space', 'thread'), '-'), '-'), null);
    } finally {
      unregisterSessionKeyCodec('test');
    }
  });
});
