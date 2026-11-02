/**
 * @description Process-level coverage for the OpenCode host used by hot-mode
 * workers. The one-shot host must exit before startup returns, leaving the
 * server alive but no longer parented by the replaceable worker process.
 * This file covers the external host itself and the ownership of hot-mode generations;
 * readiness, an exit during startup and the health and port-holder cases are in `openCodeServerReadiness.test.ts`
 * (one file was ~90 s of real processes against a 120 s file limit).
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  checkIsProcessIdentityCurrent,
  ensureOpenCodeServer,
  type ExternalProcessIdentity,
  installedVersionCacheTtlMs,
  openCodeExternalHostEnvName,
  openCodeExternalHostEnvValue,
  openCodeOwnershipFileEnvName,
  restartOpenCodeServer,
  signalExternallyHostedProcess,
  startExternallyParentedProcess,
  stopOpenCodeServer,
} from '../installManager';
import {
  checkIsTestProcessAlive,
  createFakeServerScript,
  eventWaitHangGuardMs,
  fakeServerScript,
  getProcessAncestorPids,
  getSpawnedPids,
  getUnusedPort,
  persistentChildScript,
  processExitPollMs,
  restoreTestEnvironment,
  stopTestProcess,
  waitForTestProcessExit,
  waitForTestServerHealth,
} from './openCodeOwnershipFixtures';

const testExternalHostTimeoutMs = 2_000;
const stallingExternalHostScript = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
const child = spawn(command, args, {
  env: process.env,
  detached: true,
  stdio: 'ignore',
});
child.once('spawn', () => {
  fs.writeFileSync(process.env.FAKE_HOSTED_PID_FILE, child.pid.toString());
  process.send?.({ pid: child.pid });
  child.unref();
  setInterval(() => {}, 1000);
});
process.on('message', (message) => {
  if (message?.action !== 'abort') return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
  process.disconnect?.();
  process.exit(1);
});
`;
const delayedChildExternalHostScript = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
let shouldAbort = false;
process.on('message', (message) => {
  if (message?.action === 'abort') shouldAbort = true;
});
setTimeout(() => {
  const child = spawn(command, args, {
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.once('spawn', () => {
    fs.writeFileSync(process.env.FAKE_HOSTED_PID_FILE, child.pid.toString());
    process.send?.({ pid: child.pid });
    if (shouldAbort) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      process.disconnect?.();
      process.exit(1);
    }
  });
}, 200);
`;

/**
 * The first pid a fixture wrote to its log. The log exists from the moment the fixture opens it for appending, a
 * moment before the pid is in it, so waiting for the file alone can read an empty log.
 */
async function waitForSpawnedPid(spawnLogPath: string): Promise<number> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (Date.now() < deadline && getSpawnedPids(spawnLogPath).length === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  const [spawnedPid] = getSpawnedPids(spawnLogPath);
  assert.ok(spawnedPid, `Expected a pid in ${spawnLogPath}`);
  return spawnedPid;
}

async function waitForTestFile(filePath: string): Promise<void> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (Date.now() < deadline && !fs.existsSync(filePath)) {
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  assert.equal(fs.existsSync(filePath), true, `Expected test file ${filePath}`);
}

async function runEnsureInFreshWorker(env: NodeJS.ProcessEnv): Promise<void> {
  const workerScript = `
import('./src/installManager.ts')
  .then((installManager) => {
    const ensure = installManager.ensureOpenCodeServer || installManager.default.ensureOpenCodeServer;
    return ensure();
  })
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write((error?.stack || error?.message || error?.toString() || 'unknown error') + '\\n');
    process.exit(1);
  });
`;
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', '--eval', workerScript],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  assert.equal(exitCode, 0, stderr);
}

test(
  'external process host returns only after the child leaves the worker process tree',
  { skip: process.platform === 'win32' },
  async () => {
    const hostedProcess = await startExternallyParentedProcess(
      process.execPath,
      ['-e', persistentChildScript],
      process.env,
    );

    try {
      process.kill(hostedProcess.pid, 0);
      const ancestorPids = getProcessAncestorPids(hostedProcess.pid);
      assert.equal(
        ancestorPids.includes(process.pid),
        false,
        'hosted process must leave the replaceable worker process tree before startup returns',
      );
    } finally {
      signalExternallyHostedProcess(hostedProcess, 'SIGTERM');
    }
  },
);

test(
  'external process signals require the original PID identity',
  { skip: process.platform === 'win32' },
  async () => {
    const hostedProcess = await startExternallyParentedProcess(
      process.execPath,
      ['-e', persistentChildScript],
      process.env,
    );
    const reusedPidIdentity = {
      ...hostedProcess,
      startToken: `${hostedProcess.startToken}-reused`,
    };

    try {
      assert.equal(checkIsProcessIdentityCurrent(hostedProcess), true);
      assert.equal(checkIsProcessIdentityCurrent(reusedPidIdentity), false);
      assert.equal(signalExternallyHostedProcess(reusedPidIdentity, 'SIGTERM'), false);
      process.kill(hostedProcess.pid, 0);
    } finally {
      signalExternallyHostedProcess(hostedProcess, 'SIGTERM');
    }
  },
);

/** How long the test waits, synchronously, for a SIGKILLed child to be gone. */
const childGoneBudgetMs = 5_000;

test(
  'a child that started and exited before its host did is STARTED — its identity is returned, and reads as gone',
  { skip: process.platform === 'win32' },
  async () => {
    // A child may leave at once by design: a sidecar start that finds another start already holding the record. Its
    // host had identified and released it, yet under load the host's own exit came later and rejected the start
    // ("host exited before starting its child"), which the speech-engine owner reported as a failed start. Whether a
    // started child is still alive is its caller's question.
    // Deterministic: the child is identified, then killed — and seen gone — before its host is released and exits.
    const hostedProcess = await startExternallyParentedProcess(process.execPath, ['-e', persistentChildScript], process.env, {
      prepareProcessIdentity: (identity) => {
        process.kill(identity.pid, 'SIGKILL');
        const deadline = Date.now() + childGoneBudgetMs;
        while (checkIsProcessIdentityCurrent(identity) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      },
    });
    assert.equal(checkIsProcessIdentityCurrent(hostedProcess), false, 'the caller sees it gone');
  },
);

test(
  'external process host timeout removes a child that was already started',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-host-timeout-'));
    const pidFilePath = path.join(testDirectory, 'hosted.pid');

    try {
      await assert.rejects(
        startExternallyParentedProcess(
          process.execPath,
          ['-e', persistentChildScript],
          { ...process.env, FAKE_HOSTED_PID_FILE: pidFilePath },
          { hostScript: stallingExternalHostScript, timeoutMs: testExternalHostTimeoutMs },
        ),
        /did not exit after starting its child/,
      );

      const hostedPid = Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10);
      await waitForTestProcessExit(hostedPid);
      assert.equal(checkIsTestProcessAlive(hostedPid), false);
    } finally {
      if (fs.existsSync(pidFilePath)) {
        stopTestProcess(Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10));
      }
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'external process host aborts its child when identity capture fails',
  { skip: process.platform === 'win32' },
  async () => {
    const reportedPids: number[] = [];

    await assert.rejects(
      startExternallyParentedProcess(
        process.execPath,
        ['-e', persistentChildScript],
        process.env,
        {
          resolveProcessIdentity: (pid) => {
            reportedPids.push(pid);
            return null;
          },
        },
      ),
      /could not identify child process/,
    );

    assert.equal(reportedPids.length, 1);
    await waitForTestProcessExit(reportedPids[0]);
    assert.equal(checkIsTestProcessAlive(reportedPids[0]), false);
  },
);

test(
  'external process host aborts before release when ownership preparation fails',
  { skip: process.platform === 'win32' },
  async () => {
    const preparedPids: number[] = [];

    await assert.rejects(
      startExternallyParentedProcess(
        process.execPath,
        ['-e', persistentChildScript],
        process.env,
        {
          prepareProcessIdentity: (processIdentity) => {
            preparedPids.push(processIdentity.pid);
            throw new Error('ownership write failed');
          },
        },
      ),
      /ownership write failed/,
    );

    assert.equal(preparedPids.length, 1);
    await waitForTestProcessExit(preparedPids[0]);
    assert.equal(checkIsTestProcessAlive(preparedPids[0]), false);
  },
);

test(
  'external process host abort request covers a child whose PID arrives after timeout',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-host-delayed-'));
    const pidFilePath = path.join(testDirectory, 'hosted.pid');

    try {
      await assert.rejects(
        startExternallyParentedProcess(
          process.execPath,
          ['-e', persistentChildScript],
          { ...process.env, FAKE_HOSTED_PID_FILE: pidFilePath },
          { hostScript: delayedChildExternalHostScript, timeoutMs: 50 },
        ),
        /did not exit after starting its child/,
      );

      const hostedPid = Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10);
      await waitForTestProcessExit(hostedPid);
      assert.equal(checkIsTestProcessAlive(hostedPid), false);
    } finally {
      if (fs.existsSync(pidFilePath)) {
        stopTestProcess(Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10));
      }
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a fixture server exits by itself once the test process that owns it is killed',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-orphan-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const port = await getUnusedPort();
    const descendantLogPath = path.join(testDirectory, 'descendants.log');
    const owner = spawn(process.execPath, ['-e', persistentChildScript], { stdio: 'ignore' });
    let server: ExternalProcessIdentity | undefined;
    let descendantPid: number | undefined;

    try {
      assert.ok(owner.pid);
      fs.writeFileSync(fakeBinaryPath, createFakeServerScript(owner.pid), { mode: 0o755 });
      // The never-ready variant ignores SIGTERM, so only its own guard can end it.
      server = await startExternallyParentedProcess(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
        {
          ...process.env,
          FAKE_OPENCODE_NEVER_READY: '1',
          FAKE_OPENCODE_SPAWN_LOG: path.join(testDirectory, 'spawn.log'),
          FAKE_OPENCODE_PID_FILE: path.join(testDirectory, 'server.pid'),
          FAKE_OPENCODE_DESCENDANT_LOG: descendantLogPath,
        },
      );
      assert.equal(checkIsTestProcessAlive(server.pid), true);
      descendantPid = await waitForSpawnedPid(descendantLogPath);
      assert.equal(checkIsTestProcessAlive(descendantPid), true);

      const ownerExit = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
      owner.kill('SIGKILL');
      await ownerExit;

      await waitForTestProcessExit(server.pid);
      assert.equal(
        checkIsTestProcessAlive(server.pid),
        false,
        'a fixture server must not outlive the test process that owns it',
      );
      await waitForTestProcessExit(descendantPid);
      assert.equal(
        checkIsTestProcessAlive(descendantPid),
        false,
        'a fixture server descendant must not outlive the test process that owns it',
      );
    } finally {
      if (server) stopTestProcess(server.pid);
      if (descendantPid) stopTestProcess(descendantPid);
      owner.kill('SIGKILL');
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a fresh worker recovers a persisted bot-started generation before it binds its socket',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-prebind-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const startingServerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_OPENCODE_NEVER_READY: '1',
      FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
      FAKE_OPENCODE_PID_FILE: pidFilePath,
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    const startingProcess = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      startingServerEnv,
      {
        prepareProcessIdentity: (processIdentity) => {
          fs.writeFileSync(
            ownershipFilePath,
            `${processIdentity.pid}\n${processIdentity.startToken}\n${serverUrl}\ngroup\nstarting\n`,
          );
        },
      },
    );
    const freshWorkerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_BIN: fakeBinaryPath,
      OPENCODE_URL: serverUrl,
      FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
      FAKE_OPENCODE_PID_FILE: pidFilePath,
      [openCodeExternalHostEnvName]: openCodeExternalHostEnvValue,
      [openCodeOwnershipFileEnvName]: ownershipFilePath,
    };
    delete freshWorkerEnv.FAKE_OPENCODE_NEVER_READY;

    try {
      await runEnsureInFreshWorker(freshWorkerEnv);

      await waitForTestProcessExit(startingProcess.pid);
      assert.equal(checkIsTestProcessAlive(startingProcess.pid), false);
      const spawnedPids = getSpawnedPids(spawnLogPath);
      assert.equal(spawnedPids.length, 2);
      assert.notEqual(spawnedPids[1], startingProcess.pid);
      assert.equal(checkIsTestProcessAlive(spawnedPids[1]), true);
      assert.match(fs.readFileSync(ownershipFilePath, 'utf8'), /\nready\n$/);
    } finally {
      signalExternallyHostedProcess(startingProcess, 'SIGKILL');
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'hot ensure serializes concurrent callers and externally hosts every replacement generation',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-host-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const serverEnvFilePath = path.join(testDirectory, 'server-env');
    const descendantLogPath = path.join(testDirectory, 'descendants.log');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      FAKE_OPENCODE_ENV_FILE: process.env.FAKE_OPENCODE_ENV_FILE,
      FAKE_OPENCODE_DESCENDANT_LOG: process.env.FAKE_OPENCODE_DESCENDANT_LOG,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env.FAKE_OPENCODE_ENV_FILE = serverEnvFilePath;
    process.env.FAKE_OPENCODE_DESCENDANT_LOG = descendantLogPath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      const ensureStartedAt = Date.now();
      await Promise.all([
        ensureOpenCodeServer(),
        ensureOpenCodeServer(),
        ensureOpenCodeServer(),
      ]);

      const initialPids = getSpawnedPids(spawnLogPath);
      const initialDescendantPids = getSpawnedPids(descendantLogPath);
      assert.equal(initialPids.length, 1, 'concurrent ensure calls must start one server generation');
      assert.equal(initialDescendantPids.length, 1);
      assert.equal(
        getProcessAncestorPids(initialPids[0]).includes(process.pid),
        false,
        'the initial hot-worker generation must leave the worker tree',
      );

      await Promise.all([
        ensureOpenCodeServer(),
        restartOpenCodeServer(),
        ensureOpenCodeServer(),
      ]);

      const allPids = getSpawnedPids(spawnLogPath);
      assert.equal(allPids.length, 2, 'forced restart must create exactly one replacement generation');
      assert.notEqual(allPids[1], allPids[0]);
      const allDescendantPids = getSpawnedPids(descendantLogPath);
      assert.equal(allDescendantPids.length, 2);
      await waitForTestProcessExit(initialDescendantPids[0]);
      assert.equal(
        checkIsTestProcessAlive(initialDescendantPids[0]),
        false,
        'bot-created generations must signal their whole process group',
      );
      assert.equal(checkIsTestProcessAlive(allDescendantPids[1]), true);
      const serverEnvLines = fs.readFileSync(serverEnvFilePath, 'utf8').trim().split('\n').sort();
      const versionProbeLines = serverEnvLines.filter((line) => line.startsWith('version:'));
      assert.deepEqual(
        serverEnvLines.filter((line) => line.startsWith('serve:')),
        ['serve:|||', 'serve:|||'],
        'process-host controls must not leak into OpenCode servers or descendants',
      );
      assert.ok(versionProbeLines.length > 0, 'the installed version was probed, so the probe below was checked');
      assert.ok(
        versionProbeLines.every((line) => line === 'version:|||'),
        'process-host controls must not leak into OpenCode probes',
      );
      // The probe is cached for installedVersionCacheTtlMs, so a burst of ensure calls asks once. Measured in cache windows,
      // not assumed: a host that is starved of CPU takes longer than one window to run this test and then asks again.
      const elapsedMs = Date.now() - ensureStartedAt;
      assert.ok(
        versionProbeLines.length <= Math.floor(elapsedMs / installedVersionCacheTtlMs) + 1,
        `${versionProbeLines.length} version probes in ${elapsedMs} ms: more than one per ${installedVersionCacheTtlMs} ms cache window`,
      );
      assert.equal(
        getProcessAncestorPids(allPids[1]).includes(process.pid),
        false,
        'the replacement generation must also leave the worker tree',
      );
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      for (const pid of getSpawnedPids(descendantLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a fresh hot worker replaces a persisted unresponsive server before starting its generation',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-adopted-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const terminationTargetPath = path.join(testDirectory, 'termination-target.pid');
    const sigtermFilePath = path.join(testDirectory, 'sigterm-at');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      FAKE_OPENCODE_TERMINATION_TARGET_FILE: process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE,
      FAKE_OPENCODE_SIGTERM_FILE: process.env.FAKE_OPENCODE_SIGTERM_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = serverUrl;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE = terminationTargetPath;
    process.env.FAKE_OPENCODE_SIGTERM_FILE = sigtermFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const initialProcess = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      process.env,
    );
    try {
      await waitForTestServerHealth(serverUrl);
      await ensureOpenCodeServer();
      assert.equal(getSpawnedPids(spawnLogPath).length, 1);
      fs.writeFileSync(terminationTargetPath, initialProcess.pid.toString());

      // The signals production sends to the server, with the moment each one is SENT (production runs in this process): the fake
      // can only say when it handled SIGTERM, which a starved host delays, and it is never told of the SIGKILL.
      const realKill = process.kill.bind(process);
      const signalsSent: Array<{ signal: string | number | undefined; sentAt: number }> = [];
      mock.method(process, 'kill', (pid: number, signal?: string | number) => {
        if (Math.abs(pid) === initialProcess.pid) signalsSent.push({ signal, sentAt: Date.now() });
        return realKill(pid, signal);
      });
      const recovery = ensureOpenCodeServer();
      await waitForTestFile(sigtermFilePath);
      process.kill(initialProcess.pid, 0);
      await recovery;
      mock.restoreAll();
      const sigtermSentAt = signalsSent.find((sent) => sent.signal === 'SIGTERM')?.sentAt;
      const sigkillSentAt = signalsSent.find((sent) => sent.signal === 'SIGKILL')?.sentAt;
      assert.ok(sigtermSentAt !== undefined && sigkillSentAt !== undefined, `SIGTERM and then SIGKILL were sent: ${JSON.stringify(signalsSent)}`);
      assert.ok(
        sigkillSentAt - sigtermSentAt >= 3_000,
        `SIGKILL escalation must remain delayed after SIGTERM (${sigkillSentAt - sigtermSentAt} ms)`,
      );

      const spawnedPids = getSpawnedPids(spawnLogPath);
      assert.equal(spawnedPids.length, 2);
      assert.equal(spawnedPids[0], initialProcess.pid);
      assert.notEqual(spawnedPids[1], initialProcess.pid);
      await waitForTestProcessExit(initialProcess.pid);
      assert.equal(checkIsTestProcessAlive(initialProcess.pid), false);
    } finally {
      mock.restoreAll();
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'ownership follows the configured endpoint and signals an adopted non-group listener by PID',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-endpoint-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const oldPort = await getUnusedPort();
    let newPort = await getUnusedPort();
    while (newPort === oldPort) newPort = await getUnusedPort();
    const oldServerUrl = `http://127.0.0.1:${oldPort}`;
    const newServerUrl = `http://127.0.0.1:${newPort}`;
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
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const oldServer = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', oldPort.toString()],
      process.env,
    );
    const newServerChild = spawn(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', newPort.toString()],
      { env: process.env, stdio: 'ignore' },
    );

    try {
      await Promise.all([
        waitForTestServerHealth(oldServerUrl),
        waitForTestServerHealth(newServerUrl),
      ]);
      process.env.OPENCODE_URL = oldServerUrl;
      await ensureOpenCodeServer();
      process.env.OPENCODE_URL = newServerUrl;
      await ensureOpenCodeServer();

      await restartOpenCodeServer();

      process.kill(oldServer.pid, 0);
      assert.ok(newServerChild.pid);
      await waitForTestProcessExit(newServerChild.pid);
      assert.equal(checkIsTestProcessAlive(newServerChild.pid), false);
      assert.equal(getSpawnedPids(spawnLogPath).length, 3);
    } finally {
      stopOpenCodeServer();
      signalExternallyHostedProcess(oldServer, 'SIGTERM');
      if (newServerChild.pid) stopTestProcess(newServerChild.pid);
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'stale adopted ownership cannot signal a former listener or a same-port different-address listener',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-opencode-listener-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const relinquishedFilePath = path.join(testDirectory, 'relinquished');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const decoyUrl = `http://127.0.0.2:${port}`;
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_RELINQUISHED_FILE: process.env.FAKE_OPENCODE_RELINQUISHED_FILE,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = serverUrl;
    process.env.FAKE_OPENCODE_RELINQUISHED_FILE = relinquishedFilePath;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const formerListener = spawn(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      { env: process.env, stdio: 'ignore' },
    );
    let decoyListenerPid: number | undefined;
    let replacementListenerPid: number | undefined;

    try {
      await waitForTestServerHealth(serverUrl);
      await ensureOpenCodeServer();
      assert.ok(formerListener.pid);
      process.kill(formerListener.pid, 'SIGUSR1');
      await waitForTestFile(relinquishedFilePath);

      const decoyListener = spawn(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.2', '--port', port.toString()],
        { env: process.env, stdio: 'ignore' },
      );
      const replacementListener = spawn(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
        { env: process.env, stdio: 'ignore' },
      );
      decoyListenerPid = decoyListener.pid;
      replacementListenerPid = replacementListener.pid;
      await Promise.all([
        waitForTestServerHealth(decoyUrl),
        waitForTestServerHealth(serverUrl),
      ]);

      await restartOpenCodeServer();

      process.kill(formerListener.pid, 0);
      assert.ok(decoyListenerPid);
      process.kill(decoyListenerPid, 0);
      assert.ok(replacementListenerPid);
      await waitForTestProcessExit(replacementListenerPid);
      assert.equal(checkIsTestProcessAlive(replacementListenerPid), false);
      assert.equal(getSpawnedPids(spawnLogPath).length, 4);
    } finally {
      stopOpenCodeServer();
      if (formerListener.pid) stopTestProcess(formerListener.pid);
      if (decoyListenerPid) stopTestProcess(decoyListenerPid);
      if (replacementListenerPid) stopTestProcess(replacementListenerPid);
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);
