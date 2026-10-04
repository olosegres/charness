/**
 * @description The out-of-band sign-in drivers (`agentLogin/agentLogin.ts`) against
 * their ports, with a real pty and stand-in `claude` / `opencode` CLIs: the sign-in
 * link goes out once the "paste the code" prompt is up, the pasted code reaches the
 * CLI and its message is deleted, the outcome is read from the CLI's own status, and
 * a cancel ends the pty without a report.
 *
 * The stand-ins are tiny node scripts behind `sh` launchers (the bot resolves the
 * binaries through `CLAUDE_BIN` / `OPENCODE_BIN`); each records its pid and the code
 * it was given, so a test can see the process end and what reached it.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgentLogin, type AgentLoginPorts } from '../agentLogin/agentLogin';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const key: SessionKey = makeTelegramKey(-1001111111111, 4242);
const pastedCode = 'fake-oauth-code-4711';
const claudeLoginUrl = 'https://claude.example.test/oauth/authorize?code=true';
const openCodeLoginUrl = 'https://auth.example.test/authorize?client=opencode';
const loopbackState = 'st4t3-9d2f';
const secretMessageId = 901;
const stepMs = 50;
const waitTimeoutMs = 15_000;

/** `claude auth login` prints the link and the paste prompt, then takes the code and exits 0. */
const fakeClaudeSource = `
const fs = require('fs');
const dir = process.env.FAKE_LOGIN_DIR;
fs.writeFileSync(dir + '/claude.pid', String(process.pid));
process.stdout.write('If the browser did not open, visit: ${claudeLoginUrl}\\n\\nPaste code here if prompted > ');
process.stdin.setEncoding('utf8');
process.stdin.once('data', (line) => { fs.writeFileSync(dir + '/claude.code', line.trim()); process.exit(0); });
`;

/**
 * `opencode auth login` FAILS (exit 1) after it got its code, whichever way. Paste mode prints the link and a paste
 * prompt and takes the code on its terminal; loopback mode prints a link whose redirect is a local callback server
 * and takes the code as a request on that server (what a remote browser could not deliver).
 */
const fakeOpenCodeSource = `
const fs = require('fs');
const http = require('http');
const dir = process.env.FAKE_LOGIN_DIR;
fs.writeFileSync(dir + '/opencode.pid', String(process.pid));
if (process.env.FAKE_OPENCODE_MODE === 'loopback') {
  const server = http.createServer((request, response) => {
    fs.writeFileSync(dir + '/opencode.callback', request.url);
    response.end('ok', () => process.exit(1));
  });
  server.listen(0, '127.0.0.1', () => {
    const redirect = encodeURIComponent('http://localhost:' + server.address().port + '/auth/callback');
    process.stdout.write('Go to: https://auth.example.test/authorize?redirect_uri=' + redirect + '&state=${loopbackState}\\n\\nWaiting for authorization...');
  });
} else {
  process.stdout.write('Go to: ${openCodeLoginUrl}\\n\\nPaste the code here: ');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (line) => { fs.writeFileSync(dir + '/opencode.code', line.trim()); process.exit(1); });
}
`;

interface RecordedPorts {
  ports: AgentLoginPorts;
  replies: string[];
  deletedMessageIds: number[];
  clearedAuthNoticeKeys: SessionKey[];
}

let workDir = '';
const savedEnv: Record<string, string | undefined> = {};

function writeLauncher(name: string, source: string): string {
  const scriptPath = path.join(workDir, `${name}.js`);
  fs.writeFileSync(scriptPath, source);
  const launcherPath = path.join(workDir, name);
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec '${process.execPath}' '${scriptPath}' "$@"\n`, { mode: 0o755 });
  return launcherPath;
}

/** Ports that record what the drivers did; `statusStdout` is what the `claude auth status` probe prints. */
function createRecordedPorts(statusStdout: string): RecordedPorts {
  const recorded: RecordedPorts = {
    replies: [],
    deletedMessageIds: [],
    clearedAuthNoticeKeys: [],
    ports: {
      replyToThread: async (_key, text) => {
        recorded.replies.push(text);
        return recorded.replies.length;
      },
      deleteThreadMessage: async (_key, messageId) => {
        recorded.deletedMessageIds.push(messageId);
      },
      clearAuthNotice: (clearedKey) => {
        recorded.clearedAuthNoticeKeys.push(clearedKey);
      },
      execFileAsync: async () => ({ stdout: statusStdout }),
    },
  };
  return recorded;
}

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFakeFile(name: string): string {
  return fs.readFileSync(path.join(workDir, name), 'utf8');
}

describe('agentLogin: the sign-in drivers', () => {
  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-login-'));
    for (const name of ['CLAUDE_BIN', 'OPENCODE_BIN', 'FAKE_LOGIN_DIR', 'HOME', 'XDG_DATA_HOME']) savedEnv[name] = process.env[name];
    process.env.CLAUDE_BIN = writeLauncher('claude', fakeClaudeSource);
    process.env.OPENCODE_BIN = writeLauncher('opencode', fakeOpenCodeSource);
    process.env.FAKE_LOGIN_DIR = workDir;
    // `readOpenCodeProviderAuthed` reads `<HOME>/.local/share/opencode/auth.json`: an empty home has none.
    process.env.HOME = path.join(workDir, 'home');
    delete process.env.XDG_DATA_HOME;
  });

  after(() => {
    // A failed assertion must not leave a stand-in CLI behind: its pty would keep the test process alive.
    for (const pidFile of ['claude.pid', 'opencode.pid']) {
      const pidPath = path.join(workDir, pidFile);
      if (fs.existsSync(pidPath) && checkIsProcessAlive(Number(fs.readFileSync(pidPath, 'utf8')))) process.kill(Number(fs.readFileSync(pidPath, 'utf8')));
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('relays the link once the paste prompt is up; the code reaches the CLI, its message is deleted and the confirmed sign-in clears the logged-out notice', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key);
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false, 'nothing is awaited before the CLI printed its prompt');
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), true, 'the next plain message is the code');

    await login.submitClaudeAuthLoginCode(key, ` ${pastedCode} `, secretMessageId);
    assert.deepEqual(recorded.deletedMessageIds, [secretMessageId], 'the code message is a single-use secret');
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('Signed in to Claude')));

    assert.equal(readFakeFile('claude.code'), pastedCode, 'the code reached the CLI, trimmed');
    assert.equal(recorded.clearedAuthNoticeKeys.length, 1, 'the pinned logged-out notice is retired on success');
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false, 'the finished flow is forgotten');
  });

  it('reports a failed sign-in when the CLI says it is not logged in', async () => {
    const recorded = createRecordedPorts('{"loggedIn":false}');
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key);
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId);
    await waitUntil('the failure notice', () => recorded.replies.some((reply) => reply.includes('sign-in failed')));

    assert.equal(recorded.clearedAuthNoticeKeys.length, 0, 'a failed sign-in leaves the logged-out notice alone');
  });

  it('a cancel ends the pty, forgets the flow and the cancelled flow never reports', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key);
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    const loginPid = Number(readFakeFile('claude.pid'));
    assert.ok(checkIsProcessAlive(loginPid));

    login.cancelClaudeAuthLogin(key);
    await waitUntil('the sign-in CLI to end', () => !checkIsProcessAlive(loginPid));
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false);
    // Give the pty's exit handler its chance to (wrongly) report.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(recorded.replies.length, 1, 'only the link was ever posted: no success, no failure');
  });

  it('a cancel with no flow in progress is a no-op', () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);
    login.cancelClaudeAuthLogin(key);
    login.cancelOpenCodeOAuthLogin(key);
    assert.deepEqual(recorded.replies, []);
  });

  it('OpenCode OAuth: the link goes out, a stray message is not taken for the code, the code is deleted and typed, a failed exit is reported', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startOpenCodeOAuthLogin(key, 'openai', 'ChatGPT Pro/Plus (browser)');
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(openCodeLoginUrl)));
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), true, 'a paste flow awaits the code');

    const isStrayConsumed = await login.submitOpenCodeOAuthReply(key, 'not a code, just a sentence', secretMessageId);
    assert.equal(isStrayConsumed, false, 'a message that is neither a link nor a plausible code is never taken for a credential');
    assert.deepEqual(recorded.deletedMessageIds, [], 'the stray message stays');
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), true, 'the flow stays armed');

    const isCodeConsumed = await login.submitOpenCodeOAuthReply(key, pastedCode, secretMessageId);
    assert.equal(isCodeConsumed, true);
    assert.deepEqual(recorded.deletedMessageIds, [secretMessageId], 'the code message is a single-use secret');
    await waitUntil('the failure notice', () => recorded.replies.some((reply) => reply.includes('`openai`') && reply.includes("didn't complete")));

    assert.equal(readFakeFile('opencode.code'), pastedCode, 'the code reached the CLI');
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), false, 'the finished flow is forgotten');
  });

  it('OpenCode OAuth, loopback flow: the bare code is replayed on the host\'s callback server with the CLI\'s own state', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);
    process.env.FAKE_OPENCODE_MODE = 'loopback';
    try {
      await login.startOpenCodeOAuthLogin(key, 'openai', 'ChatGPT Pro/Plus (browser)');
      await waitUntil('the loopback hint', () => recorded.replies.some((reply) => reply.includes('open https://auth.example.test/authorize')));
      assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), true, 'a loopback flow awaits the code or the callback link');

      const isCodeConsumed = await login.submitOpenCodeOAuthReply(key, pastedCode, secretMessageId);
      assert.equal(isCodeConsumed, true);
      assert.deepEqual(recorded.deletedMessageIds, [secretMessageId], 'the code message is a single-use secret');
      await waitUntil('the callback to reach the CLI', () => fs.existsSync(path.join(workDir, 'opencode.callback')));
      assert.equal(readFakeFile('opencode.callback'), `/auth/callback?code=${pastedCode}&state=${loopbackState}`);
      await waitUntil('the failure notice', () => recorded.replies.some((reply) => reply.includes("didn't complete")));
    } finally {
      delete process.env.FAKE_OPENCODE_MODE;
    }
  });

  it('OpenCode OAuth: a cancel ends the pty', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startOpenCodeOAuthLogin(key, 'openai', 'ChatGPT Pro/Plus (browser)');
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(openCodeLoginUrl)));
    const loginPid = Number(readFakeFile('opencode.pid'));

    login.cancelOpenCodeOAuthLogin(key);
    await waitUntil('the sign-in CLI to end', () => !checkIsProcessAlive(loginPid));
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), false);
  });
});
