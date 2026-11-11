/**
 * @description The password of the OpenCode server the bot starts, over REAL fixture servers that enforce it the way
 * `opencode serve` does (`OPENCODE_SERVER_PASSWORD` in their environment ⇒ HTTP Basic auth, user `opencode`, on every
 * route — `openCodeOwnershipFixtures.ts`). Loopback is shared by every account of the machine, and the API drives agents
 * that run as the bot's user, so a server the bot starts must refuse a caller without the password:
 *
 *   - a generation the bot starts (as a hot worker, or as a plain instance) refuses an unauthenticated request and answers
 *     the bot's header; the password is saved readable by the bot's user only, beside the hot supervisor's ownership file
 *     (or in `DATA_DIR`), so the next `ensure` adopts the server instead of starting another;
 *   - every generation gets a password of its own: after a restart the old one is refused;
 *   - the operator's `OPENCODE_PASSWORD` is used instead of a generated one, and saved as the running server's: what the bot
 *     sends is what the RUNNING server was started with, so a plain instance (its server outlives it) that restarts with the
 *     variable added still opens its server;
 *   - a hot worker whose saved password no longer opens its own server replaces it;
 *   - a port held by a server that requires a password the bot does not hold is never started over, and the holder is left alone;
 *   - a server started before the bot set passwords is still adopted, whatever an older credential says — and the boot step
 *     replaces it, read by a request without the password, owned or not, as long as it is an `opencode serve` the bot may
 *     stop: never a test's stand-in.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import {
  ensureOpenCodeServer,
  getOpenCodeServerAuthHeaders,
  getOpenCodeServerCredentialFilePath,
  readOpenCodeServerExposure,
  openCodeExternalHostEnvName,
  openCodeExternalHostEnvValue,
  openCodeOwnershipFileEnvName,
  openCodeServerCredentialFileName,
  restartOpenCodeServer,
  startExternallyParentedProcess,
  stopOpenCodeServer,
} from '../installManager';
import {
  checkIsTestProcessAlive,
  eventWaitHangGuardMs,
  fakeServerScript,
  getSpawnedPids,
  getUnusedPort,
  processExitPollMs,
  restoreTestEnvironment,
  stopTestProcess,
  waitForTestServerHealth,
} from './openCodeOwnershipFixtures';

const unauthorizedStatus = 401;
const okStatus = 200;
const ownerOnlyFileMode = 0o600;
const fileModeBits = 0o777;

interface PasswordFixture {
  testDirectory: string;
  serverUrl: string;
  port: number;
  spawnLogPath: string;
  /** Start a fixture server the way a test (or an older bot) does: with the given extra environment, not through `ensure`. */
  startForeignServer(extraEnv: Record<string, string>): ReturnType<typeof startExternallyParentedProcess>;
  /**
   * Start a server without a password, the way a bot from before passwords left one running: an `opencode … serve` process
   * (its argv[0] is named `opencode`, as `/proc` and `ps` show it) of this user, which no process record names.
   * `isNamedOpenCode: false` starts it under the interpreter's own name — what a test's stand-in looks like.
   */
  startUnprotectedServer(options: { isNamedOpenCode: boolean }): number;
  /** Run `ensureOpenCodeServer` in a separate process that then exits — what a plain instance's previous run did. */
  ensureServerInAnotherProcess(): Promise<void>;
}

/** @description What one health request with `headers` gets from the server at `serverUrl`. */
async function getHealthStatus(serverUrl: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`${serverUrl}/global/health`, { headers });
  await response.body?.cancel();
  return response.status;
}

/** @description Run `node <args>` from the checkout to its end: a child that hangs fails the test by its own deadline. */
function runNodeScript(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..', '..'), env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), eventWaitHangGuardMs);
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolve({ status, stderr });
    });
  });
}

/** @description Wait until process `pid` is gone (a stopped server), bounded by the shared hang guard. */
async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (checkIsTestProcessAlive(pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
}

function createBasicAuthHeaders(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

/**
 * @description Run `body` with a fake `opencode` binary on a free port. `isHotWorker`: the process is a hot worker (its
 * generations are hosted outside its tree, the supervisor named an ownership file); else a plain instance with neither.
 */
async function runWithPasswordFixture(
  options: { isHotWorker: boolean; extraEnv?: Record<string, string> },
  body: (fixture: PasswordFixture) => Promise<void>,
): Promise<void> {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-password-'));
  const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
  const spawnLogPath = path.join(testDirectory, 'spawn.log');
  const dataDirectory = path.join(testDirectory, 'data');
  const port = await getUnusedPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const environment: Record<string, string | undefined> = {
    OPENCODE_BIN: fakeBinaryPath,
    OPENCODE_URL: serverUrl,
    DATA_DIR: dataDirectory,
    OPENCODE_PASSWORD: undefined,
    OPENCODE_USERNAME: undefined,
    FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
    FAKE_OPENCODE_PID_FILE: path.join(testDirectory, 'server.pid'),
    [openCodeExternalHostEnvName]: options.isHotWorker ? openCodeExternalHostEnvValue : undefined,
    [openCodeOwnershipFileEnvName]: options.isHotWorker ? path.join(testDirectory, 'owned-process') : undefined,
    ...options.extraEnv,
  };
  const savedEnv: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(environment)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
  try {
    await body({
      testDirectory,
      serverUrl,
      port,
      spawnLogPath,
      startForeignServer: (extraEnv) => startExternallyParentedProcess(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
        { ...process.env, ...extraEnv },
      ),
      startUnprotectedServer: ({ isNamedOpenCode }) => {
        const child = spawn(process.execPath, [fakeBinaryPath, 'serve', '--hostname', '127.0.0.1', '--port', port.toString()], {
          argv0: isNamedOpenCode ? path.join(testDirectory, 'opencode') : process.execPath,
          env: process.env,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        assert.ok(child.pid);
        return child.pid;
      },
      ensureServerInAnotherProcess: async () => {
        const installManagerPath = path.join(__dirname, '..', 'installManager.ts');
        const script = `require(${JSON.stringify(installManagerPath)}).ensureOpenCodeServer().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`;
        const { status, stderr } = await runNodeScript(['--import', 'tsx', '-e', script]);
        assert.equal(status, 0, stderr);
      },
    });
  } finally {
    stopOpenCodeServer();
    for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
    restoreTestEnvironment(savedEnv);
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
}

function readSavedCredential(): { username: string; password: string } {
  const saved: unknown = JSON.parse(fs.readFileSync(getOpenCodeServerCredentialFilePath(), 'utf8'));
  assert.ok(typeof saved === 'object' && saved !== null);
  const username: unknown = Reflect.get(saved, 'username');
  const password: unknown = Reflect.get(saved, 'password');
  assert.ok(typeof username === 'string' && typeof password === 'string');
  return { username, password };
}

function readSavedPassword(): string {
  return readSavedCredential().password;
}

test(
  'a hot worker\'s server refuses a caller without the password and answers the bot; the next ensure adopts it',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: true }, async (fixture) => {
      await ensureOpenCodeServer();

      assert.equal(await getHealthStatus(fixture.serverUrl, {}), unauthorizedStatus, 'another local account gets nothing');
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus, 'the bot gets in');

      const credentialPath = getOpenCodeServerCredentialFilePath();
      assert.equal(path.dirname(credentialPath), fixture.testDirectory, 'beside the ownership file the supervisor named');
      assert.equal(path.basename(credentialPath), openCodeServerCredentialFileName);
      assert.equal(fs.statSync(credentialPath).mode & fileModeBits, ownerOnlyFileMode);
      assert.ok(readSavedPassword().length >= 32, 'a long random password');

      await ensureOpenCodeServer();
      assert.equal(getSpawnedPids(fixture.spawnLogPath).length, 1, 'adopted with the saved password, not started over');
    });
  },
);

test(
  'every generation gets a password of its own: after a restart the old one is refused',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: true }, async (fixture) => {
      await ensureOpenCodeServer();
      const firstPassword = readSavedPassword();
      const firstHeaders = getOpenCodeServerAuthHeaders();

      await restartOpenCodeServer();

      assert.equal(getSpawnedPids(fixture.spawnLogPath).length, 2);
      assert.notEqual(readSavedPassword(), firstPassword);
      assert.equal(await getHealthStatus(fixture.serverUrl, firstHeaders), unauthorizedStatus);
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);
    });
  },
);

test(
  'a plain instance keeps the password in DATA_DIR, where its next cold start finds it',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      await ensureOpenCodeServer();

      assert.equal(getOpenCodeServerCredentialFilePath(), path.join(fixture.testDirectory, 'data', openCodeServerCredentialFileName));
      assert.equal(fs.statSync(getOpenCodeServerCredentialFilePath()).mode & fileModeBits, ownerOnlyFileMode);
      assert.equal(await getHealthStatus(fixture.serverUrl, {}), unauthorizedStatus);
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);
    });
  },
);

test(
  'the operator\'s OPENCODE_PASSWORD protects the bot\'s server instead of a generated one, and is saved as the running server\'s',
  { skip: process.platform === 'win32' },
  async () => {
    const operatorPassword = 'operator-chosen-password';
    await runWithPasswordFixture({ isHotWorker: true, extraEnv: { OPENCODE_PASSWORD: operatorPassword, OPENCODE_USERNAME: 'operator' } }, async (fixture) => {
      await ensureOpenCodeServer();

      assert.equal(await getHealthStatus(fixture.serverUrl, {}), unauthorizedStatus);
      assert.equal(await getHealthStatus(fixture.serverUrl, createBasicAuthHeaders('operator', operatorPassword)), okStatus);
      assert.deepEqual(getOpenCodeServerAuthHeaders(), createBasicAuthHeaders('operator', operatorPassword));
      assert.deepEqual(readSavedCredential(), { username: 'operator', password: operatorPassword }, 'saved like a generated one');
    });
  },
);

test(
  'a port held by a server that requires a password the bot does not hold is never started over',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: true }, async (fixture) => {
      const foreignServer = await fixture.startForeignServer({ OPENCODE_SERVER_PASSWORD: 'someone-elses-password' });
      await waitForTestServerStatus(fixture.serverUrl, unauthorizedStatus);

      await assert.rejects(ensureOpenCodeServer(), /requires a password the bot does not hold.*will not start another/);

      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [foreignServer.pid], 'no second server on the occupied port');
      assert.equal(checkIsTestProcessAlive(foreignServer.pid), true, 'and the holder was left alone');
    });
  },
);

test(
  'a server started before the bot set passwords is still adopted, even with an older generation\'s credential saved',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: true }, async (fixture) => {
      fs.writeFileSync(
        path.join(fixture.testDirectory, openCodeServerCredentialFileName),
        JSON.stringify({ endpoint: new URL(fixture.serverUrl).origin, username: 'opencode', password: 'an-older-generations-password' }),
        { mode: ownerOnlyFileMode },
      );
      const unprotectedServer = await fixture.startForeignServer({});
      await waitForTestServerHealth(fixture.serverUrl);

      await ensureOpenCodeServer();

      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [unprotectedServer.pid], 'adopted: the boot step replaces it once nothing works');
      assert.equal(checkIsTestProcessAlive(unprotectedServer.pid), true);
    });
  },
);

test(
  'a hot worker whose saved password no longer opens its own server (the file overwritten, then deleted) replaces that server',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: true }, async (fixture) => {
      await ensureOpenCodeServer();
      const firstPassword = readSavedPassword();
      fs.writeFileSync(getOpenCodeServerCredentialFilePath(), JSON.stringify({ endpoint: new URL(fixture.serverUrl).origin, username: 'opencode', password: 'not-the-servers-password' }));

      await ensureOpenCodeServer();

      const [firstPid, secondPid] = getSpawnedPids(fixture.spawnLogPath);
      assert.ok(secondPid, 'a new generation was started');
      await waitForProcessGone(firstPid);
      assert.equal(checkIsTestProcessAlive(firstPid), false, 'the server the bot could no longer open was stopped');
      assert.notEqual(readSavedPassword(), firstPassword);
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);

      fs.rmSync(getOpenCodeServerCredentialFilePath());
      await ensureOpenCodeServer();

      assert.equal(getSpawnedPids(fixture.spawnLogPath).length, 3, 'and again once the file is gone');
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);
    });
  },
);

test(
  'a plain instance that restarts with OPENCODE_PASSWORD added still opens the server its last run left: the saved one is sent first',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      await fixture.ensureServerInAnotherProcess();
      const [serverPid] = getSpawnedPids(fixture.spawnLogPath);
      const generated = readSavedCredential();
      process.env.OPENCODE_PASSWORD = 'added-to-env-since';

      await ensureOpenCodeServer();

      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [serverPid], 'adopted, not refused as a stranger\'s server');
      assert.deepEqual(getOpenCodeServerAuthHeaders(), createBasicAuthHeaders(generated.username, generated.password));
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);
    });
  },
);

test(
  'the exposure of the server is read with a request that sends no password: protected, open and stoppable, or open but not the bot\'s to stop',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: false }, async () => {
      assert.equal(await readOpenCodeServerExposure(), 'none', 'no server');
      await ensureOpenCodeServer();
      assert.equal(await readOpenCodeServerExposure(), 'protected', 'the bot\'s own, although the bot holds its password');
    });
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      fixture.startUnprotectedServer({ isNamedOpenCode: true });
      await waitForTestServerHealth(fixture.serverUrl);
      assert.equal(await readOpenCodeServerExposure(), 'openStoppable');
    });
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      fixture.startUnprotectedServer({ isNamedOpenCode: false });
      await waitForTestServerHealth(fixture.serverUrl);
      assert.equal(await readOpenCodeServerExposure(), 'openUnstoppable', 'not an opencode serve: a stand-in');
    });
  },
);

test(
  'the boot step of a plain instance replaces a server an older bot left without a password — and never a stand-in',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      const oldServerPid = fixture.startUnprotectedServer({ isNamedOpenCode: true });
      await waitForTestServerHealth(fixture.serverUrl);
      await ensureOpenCodeServer();
      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [oldServerPid], 'adopted first');

      await runQuietly(() => new OpenCodeAdapter().replaceMislaunchedServer());

      await waitForProcessGone(oldServerPid);
      assert.equal(checkIsTestProcessAlive(oldServerPid), false, 'the server without a password was stopped');
      assert.equal(getSpawnedPids(fixture.spawnLogPath).length, 2, 'and the bot started its own');
      assert.equal(await getHealthStatus(fixture.serverUrl, {}), unauthorizedStatus);
      assert.equal(await getHealthStatus(fixture.serverUrl, getOpenCodeServerAuthHeaders()), okStatus);
    });
    await runWithPasswordFixture({ isHotWorker: false }, async (fixture) => {
      const standInPid = fixture.startUnprotectedServer({ isNamedOpenCode: false });
      await waitForTestServerHealth(fixture.serverUrl);
      await ensureOpenCodeServer();

      await runQuietly(() => new OpenCodeAdapter().replaceMislaunchedServer());

      assert.equal(checkIsTestProcessAlive(standInPid), true, 'a stand-in is never stopped');
      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [standInPid]);
    });
  },
);

/** @description Run `step` with the bot's log lines held back (the boot step narrates what it does). */
async function runQuietly(step: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await step();
  } finally {
    console.log = originalLog;
  }
}

/** @description Wait until the server at `serverUrl` answers a request without credentials with `status`. */
async function waitForTestServerStatus(serverUrl: string, status: number): Promise<void> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (Date.now() < deadline) {
    try {
      if (await getHealthStatus(serverUrl, {}) === status) return;
    } catch {
      // The server has not started listening yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  throw new Error(`The server at ${serverUrl} did not answer ${status}`);
}
