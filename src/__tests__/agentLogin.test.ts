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

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgentLogin, type AgentLoginPorts, type ClaudeLoginProfile } from '../agentLogin/agentLogin';
import type { ClaudeAuthStatus } from '../utils/claudeProfiles';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const key: SessionKey = makeTelegramKey(-1001111111111, 4242);
const pastedCode = 'fake-oauth-code-4711';
const claudeLoginUrl = 'https://claude.example.test/oauth/authorize?code=true';
const openCodeLoginUrl = 'https://auth.example.test/authorize?client=opencode';
const loopbackState = 'st4t3-9d2f';
const secretMessageId = 901;
const strayMessageId = 902;
/** The localized shortcut line under every "paste the code" prompt. */
const escToCancelHint = '/esc to cancel';
const stepMs = 50;
const waitTimeoutMs = 15_000;

/** `claude auth login` prints the link and the paste prompt, then takes the code and exits 0. */
const fakeClaudeSource = `
const fs = require('fs');
const dir = process.env.FAKE_LOGIN_DIR;
fs.writeFileSync(dir + '/claude.pid', String(process.pid));
fs.writeFileSync(dir + '/claude.configdir', process.env.CLAUDE_CONFIG_DIR || '');
fs.writeFileSync(dir + '/claude.argv', JSON.stringify(process.argv.slice(2)));
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
  /** The `CLAUDE_CONFIG_DIR` each `claude auth status` probe ran with (`undefined` = not set). */
  statusProbeConfigDirs: Array<string | undefined>;
  /** What a profile sign-in reported at its end. */
  profileReports: Array<{ profile: ClaudeLoginProfile; status: ClaudeAuthStatus | null }>;
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
    statusProbeConfigDirs: [],
    profileReports: [],
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
      execFileAsync: async (_file, _args, options) => {
        recorded.statusProbeConfigDirs.push(options.env?.CLAUDE_CONFIG_DIR);
        return { stdout: statusStdout };
      },
      onClaudeProfileAuthStatus: async (_key, profile, status) => {
        recorded.profileReports.push({ profile, status });
      },
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
    assert.ok(recorded.replies[0].endsWith(escToCancelHint), 'the link message offers /esc as the way out');

    assert.equal(await login.submitClaudeAuthLoginCode(key, ` ${pastedCode} `, secretMessageId), true);
    assert.deepEqual(recorded.deletedMessageIds, [secretMessageId], 'the code message is a single-use secret');
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('Signed in to Claude')));

    assert.equal(readFakeFile('claude.code'), pastedCode, 'the code reached the CLI, trimmed');
    assert.equal(recorded.clearedAuthNoticeKeys.length, 1, 'the pinned logged-out notice is retired on success');
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false, 'the finished flow is forgotten');
  });

  it('checkIsAnyLoginInProgress: true from the start of a sign-in to its end, however it ends — the updater never restarts under one', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);
    assert.equal(login.checkIsAnyLoginInProgress(), false);

    await login.startClaudeAuthLogin(key);
    assert.equal(login.checkIsAnyLoginInProgress(), true, 'before the link is even relayed');
    login.cancelClaudeAuthLogin(key);
    assert.equal(login.checkIsAnyLoginInProgress(), false, 'cancelled');

    await login.startClaudeAuthLogin(key);
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.equal(login.checkIsAnyLoginInProgress(), true);
    await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId);
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('Signed in to Claude')));
    assert.equal(login.checkIsAnyLoginInProgress(), false, 'finished');
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

  it('a profile sign-in runs the CLI and the status probe under the profile\'s CLAUDE_CONFIG_DIR, names the account and reports it to the bot', async () => {
    const profileDir = path.join(workDir, 'claude-profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    const recorded = createRecordedPorts('{"loggedIn":true,"email":"work@example.com","subscriptionType":"team","orgName":"Example Org"}');
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key, { name: 'work', configDir: profileDir });
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.match(recorded.replies[0], /profile work/, 'the link message names the profile');
    assert.match(recorded.replies[0], /incognito/, 'and tells the operator to open it as the other account');
    assert.equal(readFakeFile('claude.configdir'), profileDir, 'the CLI signs THAT directory in');

    await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId);
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('work@example.com')));
    assert.match(recorded.replies.at(-1) ?? '', /Profile work signed in: work@example\.com \(team\)/);
    assert.deepEqual(recorded.statusProbeConfigDirs, [profileDir], 'the status probe reads the same directory');
    assert.deepEqual(recorded.profileReports, [{
      profile: { name: 'work', configDir: profileDir },
      status: { loggedIn: true, email: 'work@example.com', subscriptionType: 'team', orgName: 'Example Org', authMethod: null, apiKeySource: null, billing: null },
    }]);
    assert.equal(recorded.clearedAuthNoticeKeys.length, 0, 'a profile sign-in is not the ~/.claude login: the logged-out notice stays');
  });

  it('a subscription sign-in runs `claude auth login --claudeai`', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);
    await login.startClaudeAuthLogin(key, { name: 'work', configDir: path.join(workDir, 'claude-profiles', 'work') });
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.deepEqual(JSON.parse(readFakeFile('claude.argv')), ['auth', 'login', '--claudeai']);
    login.cancelClaudeAuthLogin(key);
  });

  it('an API account signs in to the Claude Console (`--console`), offers a pasted key in its link message and names the organization', async () => {
    const profileDir = path.join(workDir, 'claude-profiles', 'console');
    fs.mkdirSync(profileDir, { recursive: true });
    const recorded = createRecordedPorts(JSON.stringify({
      loggedIn: true, authMethod: 'api_key', apiKeySource: '/login managed key', email: 'ops@example.com', orgName: 'Example Org',
    }));
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key, { name: 'console', configDir: profileDir, billing: 'api' });
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.deepEqual(JSON.parse(readFakeFile('claude.argv')), ['auth', 'login', '--console'], 'the Console login, never the subscription');
    assert.equal(readFakeFile('claude.configdir'), profileDir, 'into the account\'s own directory');
    assert.match(recorded.replies[0], /Claude Console for API account console/);
    assert.match(recorded.replies[0], /sk-ant-api/, 'the link message offers pasting a key instead');

    await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId);
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('ops@example.com')));
    assert.match(recorded.replies.at(-1) ?? '', /API account console signed in: ops@example\.com — Claude Console organization Example Org/);
    assert.equal(recorded.profileReports[0]?.status?.billing, 'api');
  });

  it('a key pasted into an API account\'s sign-in is deleted, never typed into the CLI, stops the Console login and goes to the bot', async () => {
    const profileDir = path.join(workDir, 'claude-profiles', 'keyed');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.rmSync(path.join(workDir, 'claude.code'), { force: true });
    const recorded = createRecordedPorts('{"loggedIn":false}');
    const handedKeys: Array<{ profile: string; apiKey: string }> = [];
    const login = createAgentLogin({
      ...recorded.ports,
      onClaudeProfileApiKey: async (_key, profile, apiKey) => {
        handedKeys.push({ profile: profile.name, apiKey });
        return 'stored by the bot';
      },
    });
    await login.startClaudeAuthLogin(key, { name: 'keyed', configDir: profileDir, billing: 'api' });
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    const pid = Number(readFakeFile('claude.pid'));

    // An admin key is a secret too, but it cannot run Claude Code: deleted, refused, the flow stays armed.
    assert.equal(await login.submitClaudeAuthLoginCode(key, 'sk-ant-admin01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', strayMessageId), true);
    assert.deepEqual(recorded.deletedMessageIds, [strayMessageId]);
    assert.match(recorded.replies.at(-1) ?? '', /not a Claude API key/);
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), true);
    assert.deepEqual(handedKeys, []);

    const apiKey = `sk-ant-api03-${'k'.repeat(40)}`;
    assert.equal(await login.submitClaudeAuthLoginCode(key, ` ${apiKey} `, secretMessageId), true);
    assert.deepEqual(recorded.deletedMessageIds, [strayMessageId, secretMessageId], 'the key message is deleted');
    assert.deepEqual(handedKeys, [{ profile: 'keyed', apiKey }], 'the trimmed key goes to the bot');
    assert.equal(recorded.replies.at(-1), 'stored by the bot');
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false, 'the flow is over');
    await waitUntil('the Console login to end', () => !checkIsProcessAlive(pid));
    assert.equal(fs.existsSync(path.join(workDir, 'claude.code')), false, 'the key never reached the CLI');
    assert.ok(recorded.replies.every((reply) => !reply.includes(apiKey)), 'the key is never echoed');
    assert.deepEqual(recorded.profileReports, [], 'the stopped login reports nothing');
  });

  it('a key pasted into a SUBSCRIPTION sign-in is deleted and refused — the flow keeps waiting for its code', async () => {
    fs.rmSync(path.join(workDir, 'claude.code'), { force: true });
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const handedKeys: string[] = [];
    const login = createAgentLogin({ ...recorded.ports, onClaudeProfileApiKey: async (_key, _profile, apiKey) => { handedKeys.push(apiKey); return ''; } });
    await login.startClaudeAuthLogin(key, { name: 'work', configDir: path.join(workDir, 'claude-profiles', 'work') });
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));

    assert.equal(await login.submitClaudeAuthLoginCode(key, `sk-ant-api03-${'k'.repeat(40)}`, secretMessageId), true);
    assert.deepEqual(recorded.deletedMessageIds, [secretMessageId]);
    assert.match(recorded.replies.at(-1) ?? '', /add an API account/);
    assert.deepEqual(handedKeys, []);
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), true, 'still waiting for the code');
    assert.equal(fs.existsSync(path.join(workDir, 'claude.code')), false);
    login.cancelClaudeAuthLogin(key);
  });

  it('the default login still runs with no CLAUDE_CONFIG_DIR of its own', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);
    await login.startClaudeAuthLogin(key);
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    assert.equal(readFakeFile('claude.configdir'), process.env.CLAUDE_CONFIG_DIR ?? '');
    await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId);
    await waitUntil('the sign-in outcome', () => recorded.replies.some((reply) => reply.includes('Signed in to Claude')));
    assert.deepEqual(recorded.statusProbeConfigDirs, [process.env.CLAUDE_CONFIG_DIR]);
    assert.deepEqual(recorded.profileReports, []);
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
    assert.equal(login.cancelPendingLogin(key), false, 'nothing was pending, so /esc keeps its ordinary meaning');
    assert.deepEqual(recorded.replies, []);
  });

  it('a pending /login does not swallow a stray message: it is answered with the waiting hint, kept and never typed; /esc cancels the flow', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startClaudeAuthLogin(key);
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(claudeLoginUrl)));
    const loginPid = Number(readFakeFile('claude.pid'));

    assert.equal(await login.submitClaudeAuthLoginCode(key, 'are you still there? this is not a code', strayMessageId), false);
    const hint = recorded.replies[recorded.replies.length - 1];
    assert.match(hint, /Waiting for the login code/);
    assert.ok(hint.endsWith(escToCancelHint), 'the hint offers /esc');
    assert.deepEqual(recorded.deletedMessageIds, [], 'a stray message is not a secret and stays');
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), true, 'the flow stays armed');
    assert.ok(checkIsProcessAlive(loginPid), 'nothing was typed into the CLI');

    assert.equal(login.cancelPendingLogin(key), true, 'a pending login was cancelled');
    await waitUntil('the sign-in CLI to end', () => !checkIsProcessAlive(loginPid));
    assert.equal(login.checkIsAuthLoginAwaitingCode(key), false);
    assert.equal(await login.submitClaudeAuthLoginCode(key, pastedCode, secretMessageId), false, 'a cancelled flow takes no code');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(recorded.replies.length, 2, 'the link and the hint: a cancelled flow never reports');
  });

  it('OpenCode OAuth: the link goes out, a stray message is not taken for the code, the code is deleted and typed, a failed exit is reported', async () => {
    const recorded = createRecordedPorts('{"loggedIn":true}');
    const login = createAgentLogin(recorded.ports);

    await login.startOpenCodeOAuthLogin(key, 'openai', 'ChatGPT Pro/Plus (browser)');
    await waitUntil('the sign-in link', () => recorded.replies.some((reply) => reply.includes(openCodeLoginUrl)));
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), true, 'a paste flow awaits the code');
    await waitUntil('the paste prompt', () => recorded.replies.some((reply) => reply.includes('paste the code here')));
    assert.ok(recorded.replies[recorded.replies.length - 1].endsWith(escToCancelHint), 'the paste prompt offers /esc');

    const isStrayConsumed = await login.submitOpenCodeOAuthReply(key, 'not a code, just a sentence', secretMessageId);
    assert.equal(isStrayConsumed, false, 'a message that is neither a link nor a plausible code is never taken for a credential');
    assert.ok(recorded.replies[recorded.replies.length - 1].endsWith(escToCancelHint), 'the rejection offers /esc');
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

    assert.equal(login.cancelPendingLogin(key), true, 'the shared /esc cancel covers the /connect OAuth flow too');
    await waitUntil('the sign-in CLI to end', () => !checkIsProcessAlive(loginPid));
    assert.equal(login.checkIsOpenCodeOAuthAwaitingReply(key), false);
  });
});
