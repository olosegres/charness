/**
 * @description Process-level coverage for how the OpenCode server starts and is judged: a never-ready server is killed, an exit before
 * or at the health boundary, direct-process ownership, and the health and port-holder cases (a slow server is not replaced on its first
 * slow answer; a port whose holder does not answer is never started over). The external host and the ownership of hot-mode generations
 * are in `openCodeProcessOwnership.test.ts`.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFullBacklogListener } from './fullBacklogListener';
import {
  ensureOpenCodeServer,
  openCodeHealthTimeoutRetries,
  type ExternalProcessIdentity,
  onOpenCodeServerExit,
  openCodeExternalHostEnvName,
  openCodeExternalHostEnvValue,
  openCodeOwnershipFileEnvName,
  startExternallyParentedProcess,
  stopOpenCodeServer,
} from '../installManager';
import {
  checkIsTestProcessAlive,
  eventWaitHangGuardMs,
  fakeServerScript,
  getProcessAncestorPids,
  getSpawnedPids,
  getUnusedPort,
  processExitPollMs,
  restoreTestEnvironment,
  stopTestProcess,
  waitForTestProcessExit,
  waitForTestServerHealth,
} from './openCodeOwnershipFixtures';

test(
  'a newly spawned never-ready server is killed and its ownership file is removed',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-not-ready-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_NEVER_READY: process.env.FAKE_OPENCODE_NEVER_READY,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_NEVER_READY = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      await assert.rejects(
        ensureOpenCodeServer(),
        /did not become ready within 15 seconds/,
      );

      const [serverPid] = getSpawnedPids(spawnLogPath);
      assert.ok(serverPid);
      await waitForTestProcessExit(serverPid);
      assert.equal(checkIsTestProcessAlive(serverPid), false);
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a direct process exit before readiness does not report a post-start crash',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-start-exit-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_EXIT_BEFORE_READY: process.env.FAKE_OPENCODE_EXIT_BEFORE_READY,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };
    let unexpectedExitCalls = 0;

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_EXIT_BEFORE_READY = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;
    onOpenCodeServerExit(() => {
      unexpectedExitCalls += 1;
    });

    try {
      await assert.rejects(ensureOpenCodeServer(), /failed to start/);
      assert.equal(unexpectedExitCalls, 0);
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a direct process exit at the health boundary is rejected or reported after readiness',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-health-exit-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_EXIT_AFTER_HEALTH: process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };
    let unexpectedExitCalls = 0;

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;
    onOpenCodeServerExit(() => {
      unexpectedExitCalls += 1;
    });

    try {
      let didStartupResolve = false;
      try {
        await ensureOpenCodeServer();
        didStartupResolve = true;
      } catch (error) {
        assert.match(
          error instanceof Error ? error.message : error?.toString() ?? '',
          /failed during readiness|failed to start/,
        );
      }
      const [serverPid] = getSpawnedPids(spawnLogPath);
      await waitForTestProcessExit(serverPid);
      // OS process disappearance precedes Node's ChildProcess `exit` event — by
      // one event-loop turn on an idle box, by far more under load. A started
      // server's exit must be reported: wait for that report, bounded. A start
      // that failed must report nothing: give a late report its turn to show.
      const exitReportDeadline = Date.now() + eventWaitHangGuardMs;
      while (didStartupResolve && unexpectedExitCalls === 0 && Date.now() < exitReportDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
      assert.equal(
        unexpectedExitCalls,
        didStartupResolve ? 1 : 0,
        'a health-boundary exit must never be silently suppressed after startup resolves',
      );
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'non-hot ensure keeps direct process ownership and reports an unexpected exit',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-owned-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      const exitResult = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        onOpenCodeServerExit((code, signal) => resolve({ code, signal }));
      });
      await ensureOpenCodeServer();
      const [serverPid] = getSpawnedPids(spawnLogPath);
      assert.equal(getProcessAncestorPids(serverPid).includes(process.pid), true);

      process.kill(-serverPid, 'SIGKILL');
      const result = await exitResult;
      assert.equal(result.signal, 'SIGKILL');
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

// ─── a health probe that gets no answer in time is not "no server" ───

/** What a health-probe test works with: one fixture server on a port the bot is pointed at, and its logs. */
interface HealthFixture {
  testDirectory: string;
  port: number;
  serverUrl: string;
  spawnLogPath: string;
  hangTargetPath: string;
  /** Start the fixture server as a bot-independent process on the port (hosted outside this process tree, as the bot's own are). */
  startServer(): Promise<ExternalProcessIdentity>;
  /** How many health requests the server with this pid has received. */
  countHealthRequests(serverPid: number): number;
}

/**
 * Run `body` with the environment of a health-probe test: the fake `opencode` binary, `OPENCODE_URL` on a free port, the hot-worker
 * host and an ownership file of its own — and put every variable back, stop every server the test started and remove its folder.
 */
async function runWithHealthFixture(extraEnv: Record<string, string>, body: (fixture: HealthFixture) => Promise<void>): Promise<void> {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-health-'));
  const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
  const spawnLogPath = path.join(testDirectory, 'spawn.log');
  const healthLogPath = path.join(testDirectory, 'health.log');
  const hangTargetPath = path.join(testDirectory, 'hang-target.pid');
  const port = await getUnusedPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const environment: Record<string, string> = {
    OPENCODE_BIN: fakeBinaryPath,
    OPENCODE_URL: serverUrl,
    FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
    FAKE_OPENCODE_PID_FILE: path.join(testDirectory, 'server.pid'),
    FAKE_OPENCODE_HEALTH_LOG: healthLogPath,
    FAKE_OPENCODE_HANG_TARGET_FILE: hangTargetPath,
    [openCodeExternalHostEnvName]: openCodeExternalHostEnvValue,
    [openCodeOwnershipFileEnvName]: path.join(testDirectory, 'owned-process'),
    ...extraEnv,
  };
  const savedEnv: Record<string, string | undefined> = {};
  for (const name of Object.keys(environment)) savedEnv[name] = process.env[name];
  fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
  Object.assign(process.env, environment);
  try {
    await body({
      testDirectory,
      port,
      serverUrl,
      spawnLogPath,
      hangTargetPath,
      startServer: () => startExternallyParentedProcess(fakeBinaryPath, ['serve', '--hostname', '127.0.0.1', '--port', port.toString()], process.env),
      countHealthRequests: (serverPid) => (fs.existsSync(healthLogPath) ? fs.readFileSync(healthLogPath, 'utf8') : '')
        .split('\n')
        .filter((line) => line.startsWith(`${serverPid} `)).length,
    });
  } finally {
    stopOpenCodeServer();
    for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
    restoreTestEnvironment(savedEnv);
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
}

/** Longer than the 2 s a health probe waits for one answer. */
const lateHealthAnswerMs = 2_600;

test(
  'a health answer that comes late does not make ensure start a duplicate server on a port that is served',
  { skip: process.platform === 'win32' },
  async () => {
    // The server answers the 2nd health request (the first is this test's own wait) after 2.6 s: busy, or starved of CPU, not down.
    await runWithHealthFixture({ FAKE_OPENCODE_LATE_HEALTH_REQUEST: '2', FAKE_OPENCODE_LATE_HEALTH_MS: lateHealthAnswerMs.toString() }, async (fixture) => {
      const server = await fixture.startServer();
      await waitForTestServerHealth(fixture.serverUrl);

      await ensureOpenCodeServer();

      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [server.pid], 'the server was adopted, not started over');
      assert.ok(fixture.countHealthRequests(server.pid) >= 3, 'the late answer was really met: the probe asked again');
      assert.equal(checkIsTestProcessAlive(server.pid), true);
    });
  },
);

test(
  'a server the bot owns that stops answering is replaced after the bounded retries, not on its first slow answer',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithHealthFixture({}, async (fixture) => {
      const server = await fixture.startServer();
      await waitForTestServerHealth(fixture.serverUrl);
      await ensureOpenCodeServer();
      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [server.pid], 'adopted: the bot owns it now');

      fs.writeFileSync(fixture.hangTargetPath, server.pid.toString());
      const requestsBefore = fixture.countHealthRequests(server.pid);
      await ensureOpenCodeServer();

      assert.equal(
        fixture.countHealthRequests(server.pid) - requestsBefore,
        1 + openCodeHealthTimeoutRetries,
        'the silent server was asked once and then once more for each retry, and not more',
      );
      const spawnedPids = getSpawnedPids(fixture.spawnLogPath);
      assert.equal(spawnedPids.length, 2, 'then it was replaced');
      assert.notEqual(spawnedPids[1], server.pid);
      await waitForTestProcessExit(server.pid);
      assert.equal(checkIsTestProcessAlive(server.pid), false);
      await waitForTestServerHealth(fixture.serverUrl);
    });
  },
);

test(
  'a port held by a server the bot does not own that does not answer is never started over',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithHealthFixture({}, async (fixture) => {
      const server = await fixture.startServer();
      await waitForTestServerHealth(fixture.serverUrl);
      fs.writeFileSync(fixture.hangTargetPath, server.pid.toString());

      await assert.rejects(
        ensureOpenCodeServer(),
        /port \d+ is in use .*will not start another/,
      );

      assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [server.pid], 'no second server was started on the occupied port');
      assert.equal(checkIsTestProcessAlive(server.pid), true, 'and the one that holds it was left alone');
    });
  },
);

test(
  'a port whose holder takes no connection at all (a full accept queue) is never started over: no answer proves nothing about the port',
  { skip: process.platform === 'win32' },
  async () => {
    await runWithHealthFixture({}, async (fixture) => {
      // The holder never accepts, so the health probes get no answer AND the plain connect check of the port hangs too: a hung
      // or overloaded listener, not a free port. Only a refused connection proves a port free.
      const holder = await startFullBacklogListener({ port: fixture.port });
      try {
        await assert.rejects(
          ensureOpenCodeServer(),
          /port \d+ is not known to be free .*will not start another/,
        );
        assert.deepEqual(getSpawnedPids(fixture.spawnLogPath), [], 'no server was started onto the port');
      } finally {
        holder.stop();
      }
    });
  },
);
