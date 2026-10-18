/**
 * @description How the CLI is launched on a session id (`prepareClaudeSessionLaunch`): resumed only when the transcript
 * holds a conversation and a resume was asked for; started under the id otherwise; a metadata-only stub — which no
 * launch flag accepts — is removed before the start and, when a resume was asked for, tells that the conversation is LOST
 * (it had turns), while a missing file loses nothing (a session that never took a turn has none); a transcript with a
 * conversation is never touched.
 *
 * Live incident: the CLI's cleanup removed an old conversation's transcript under a running agent; stopping that agent
 * left a metadata-only stub, the next launch saw "a file" and resumed it, and the CLI refused («No conversation found»).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareClaudeSessionLaunch } from '../utils/claudeTranscriptContent';

const sessionId = '11111111-2222-4333-8444-555555555555';
const stub = `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'a prompt', sessionId })}\n${JSON.stringify({ type: 'cost-state', sessionId })}\n`;
const conversation = `${stub}${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, sessionId })}\n`;

describe('prepareClaudeSessionLaunch', () => {
  let directory: string;
  let transcriptPath: string;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-launch-'));
  });

  after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function setTranscript(content: string | null): void {
    transcriptPath = path.join(directory, `${sessionId}.jsonl`);
    fs.rmSync(transcriptPath, { force: true });
    if (content !== null) fs.writeFileSync(transcriptPath, content);
  }

  it('a conversation is resumed when a resume was asked for, and its transcript is left exactly as it was', async () => {
    setTranscript(conversation);
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, true), { isResumable: true, isConversationLost: false });
    assert.equal(fs.readFileSync(transcriptPath, 'utf8'), conversation);
  });

  it('a start under an id (no resume asked) never resumes, and never touches a transcript that holds a conversation', async () => {
    setTranscript(conversation);
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, false), { isResumable: false, isConversationLost: false });
    assert.equal(fs.readFileSync(transcriptPath, 'utf8'), conversation);
  });

  it('no transcript: nothing to resume and NOTHING LOST — a session that never took a turn has none; it starts under its id', async () => {
    setTranscript(null);
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, true), { isResumable: false, isConversationLost: false });
    assert.equal(fs.existsSync(transcriptPath), false);
  });

  it('the metadata-only stub is proof there was a conversation and it is gone: nothing to resume, lost, and the stub is removed so the id can be started', async () => {
    setTranscript(stub);
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, true), { isResumable: false, isConversationLost: true });
    assert.equal(fs.existsSync(transcriptPath), false, 'the stub is gone');
    setTranscript('');
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, true), { isResumable: false, isConversationLost: true }, 'an empty file is the same');
    assert.equal(fs.existsSync(transcriptPath), false);
  });

  it('a start under an id over a stub removes the stub and loses nothing: no resume was asked for', async () => {
    setTranscript(stub);
    assert.deepEqual(await prepareClaudeSessionLaunch(transcriptPath, false), { isResumable: false, isConversationLost: false });
    assert.equal(fs.existsSync(transcriptPath), false, 'the stub is gone');
  });

  it('a path that is not a readable transcript is left alone and is not taken for a stub', async () => {
    const asDirectory = path.join(directory, 'a-directory.jsonl');
    fs.mkdirSync(asDirectory);
    assert.deepEqual(await prepareClaudeSessionLaunch(asDirectory, true), { isResumable: true, isConversationLost: false }, 'unreadable counts as a conversation: the CLI decides');
    assert.ok(fs.existsSync(asDirectory), 'never removed');
  });
});
