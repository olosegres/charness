/**
 * @description Fixtures shared by the OpenCode server tests that run real fixture processes (`openCodeProcessOwnership.test.ts`,
 * `openCodeServerReadiness.test.ts`, `openCodeServerPassword.test.ts`): the fake server script — which, like `opencode serve`,
 * requires HTTP Basic auth when started with `OPENCODE_SERVER_PASSWORD` — and the process, port, pid and health helpers around it.
 * Imported by those, run by none.
 */

import * as fs from 'fs';
import { createServer } from 'net';
import { execFileSync } from 'child_process';
import { getOpenCodeServerAuthHeaders } from '../installManager';

export const persistentChildScript = 'setInterval(() => {}, 1000)';
export const processExitPollMs = 25;
/**
 * How long a wait for a process event (a server answering, a pid in a log, a file, an exit) may take before the test calls it a
 * hang. Every such wait returns the moment its state is reached, so the bound is only a hang guard: far above any honest run, on
 * a host that is starved of CPU too (starting a Node fixture takes seconds there) — never a claim about how fast something is.
 */
export const eventWaitHangGuardMs = 30_000;
const fixtureOwnerPollMs = 100;
/**
 * Fixture servers are hosted outside the test process tree on purpose (that is what the code under test
 * does), so a test process that dies before its `finally` runs (killed run, timeout) strands them, and the
 * variants that ignore SIGTERM then live forever. This guard makes a fixture process exit once its owner is gone.
 */
const createOwnerGuardScript = (ownerPid: number): string => `setInterval(() => {
  try {
    process.kill(${ownerPid}, 0);
  } catch (error) {
    if (error.code === 'ESRCH') process.exit(0);
  }
}, ${fixtureOwnerPollMs}).unref();`;
export const createFakeServerScript = (ownerPid: number): string => `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const { spawn: spawnChild } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  if (process.env.FAKE_OPENCODE_ENV_FILE) {
    fs.appendFileSync(process.env.FAKE_OPENCODE_ENV_FILE, 'version:' + [
      process.env.CHARNESS_HOT_RELOAD || '',
      process.env.CHARNESS_OPENCODE_PROCESS_FILE || '',
      process.env.TELEGRAMCODE_HOT_RELOAD || '',
      process.env.TELEGRAMCODE_OPENCODE_PROCESS_FILE || '',
    ].join('|') + '\\n');
  }
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const portIndex = args.indexOf('--port');
const port = Number.parseInt(args[portIndex + 1], 10);
const hostnameIndex = args.indexOf('--hostname');
const hostname = hostnameIndex >= 0 ? args[hostnameIndex + 1] : '127.0.0.1';
const checkIsTerminationTarget = () => {
  const targetFile = process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE;
  if (!targetFile || !fs.existsSync(targetFile)) return false;
  return fs.readFileSync(targetFile, 'utf8').trim() === process.pid.toString();
};
// A server that takes the health request and never answers it (hung, or starved past any probe time): the pid listed in the file.
const checkIsHangTarget = () => {
  const targetFile = process.env.FAKE_OPENCODE_HANG_TARGET_FILE;
  if (!targetFile || !fs.existsSync(targetFile)) return false;
  return fs.readFileSync(targetFile, 'utf8').trim() === process.pid.toString();
};
let healthRequestCount = 0;
const checkIsNeverReady = () => process.env.FAKE_OPENCODE_NEVER_READY === '1';
const checkShouldExitBeforeReady = () => process.env.FAKE_OPENCODE_EXIT_BEFORE_READY === '1';
const checkShouldExitAfterHealth = () => process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH === '1';
fs.appendFileSync(process.env.FAKE_OPENCODE_SPAWN_LOG, process.pid + '\\n');
fs.writeFileSync(process.env.FAKE_OPENCODE_PID_FILE, process.pid.toString());
${createOwnerGuardScript(ownerPid)}
if (process.env.FAKE_OPENCODE_DESCENDANT_LOG) {
  const descendant = spawnChild(process.execPath, ['-e', ${JSON.stringify(
    `${persistentChildScript};${createOwnerGuardScript(ownerPid)}`,
  )}], {
    stdio: 'ignore',
  });
  fs.appendFileSync(process.env.FAKE_OPENCODE_DESCENDANT_LOG, descendant.pid + '\\n');
}
if (process.env.FAKE_OPENCODE_ENV_FILE) {
  fs.appendFileSync(process.env.FAKE_OPENCODE_ENV_FILE, 'serve:' + [
    process.env.CHARNESS_HOT_RELOAD || '',
    process.env.CHARNESS_OPENCODE_PROCESS_FILE || '',
    process.env.TELEGRAMCODE_HOT_RELOAD || '',
    process.env.TELEGRAMCODE_OPENCODE_PROCESS_FILE || '',
  ].join('|') + '\\n');
}
// Like \`opencode serve\` (its server/auth.ts): a password in the environment makes every route require HTTP Basic auth.
const checkIsAuthorized = (request) => {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return true;
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return request.headers.authorization === 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
};
const server = http.createServer((request, response) => {
  if (!checkIsAuthorized(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
    response.end();
    return;
  }
  if (request.url === '/global/health') {
    healthRequestCount += 1;
    if (process.env.FAKE_OPENCODE_HEALTH_LOG) {
      fs.appendFileSync(process.env.FAKE_OPENCODE_HEALTH_LOG, process.pid + ' ' + healthRequestCount + '\\n');
    }
    if (checkIsHangTarget()) return;
    const answerHealth = () => {
      if (checkIsTerminationTarget() || checkIsNeverReady()) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true, version: '1.0.0' }), () => {
        if (checkShouldExitAfterHealth()) process.exit(0);
      });
    };
    // The N-th health request is answered late: a server that is busy or starved of CPU, not one that is down.
    if (Number(process.env.FAKE_OPENCODE_LATE_HEALTH_REQUEST || 0) === healthRequestCount) {
      setTimeout(answerHealth, Number(process.env.FAKE_OPENCODE_LATE_HEALTH_MS || 0));
    } else {
      answerHealth();
    }
    return;
  }
  response.writeHead(404);
  response.end();
});
if (checkShouldExitBeforeReady()) setTimeout(() => process.exit(1), 25);
else if (checkIsNeverReady()) setInterval(() => {}, 1000);
else server.listen(port, hostname);
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', () => {
  if (checkIsTerminationTarget() || checkIsNeverReady()) {
    if (process.env.FAKE_OPENCODE_SIGTERM_FILE) {
      fs.writeFileSync(process.env.FAKE_OPENCODE_SIGTERM_FILE, Date.now().toString());
    }
    return;
  }
  // A hung server holds its open health requests, so a graceful close would wait for them: it ends at once.
  if (checkIsHangTarget()) process.exit(0);
  stop();
});
process.on('SIGINT', stop);
process.on('SIGUSR1', () => {
  server.close(() => {
    if (process.env.FAKE_OPENCODE_RELINQUISHED_FILE) {
      fs.writeFileSync(process.env.FAKE_OPENCODE_RELINQUISHED_FILE, process.pid.toString());
    }
    setInterval(() => {}, 1000);
  });
});
`;
export const fakeServerScript = createFakeServerScript(process.pid);

export async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP address for the test server');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

export function getSpawnedPids(spawnLogPath: string): number[] {
  if (!fs.existsSync(spawnLogPath)) return [];
  return fs.readFileSync(spawnLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

export function stopTestProcess(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The test process already exited.
    }
  }
}

export function checkIsTestProcessAlive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', pid.toString()], {
      encoding: 'utf8',
    }).trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch {
    return false;
  }
}

export async function waitForTestProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (Date.now() < deadline && checkIsTestProcessAlive(pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
}

/** A server the bot started requires its password; one a test started itself takes the header and ignores it. */
export async function waitForTestServerHealth(url: string): Promise<void> {
  const deadline = Date.now() + eventWaitHangGuardMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`, { headers: getOpenCodeServerAuthHeaders() });
      if (response.ok) return;
    } catch {
      // The test server has not started listening yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  throw new Error(`Test server did not become healthy at ${url}`);
}

export function restoreTestEnvironment(savedEnv: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function getProcessAncestorPids(pid: number): number[] {
  const ancestorPids: number[] = [];
  const seenPids = new Set([pid]);
  let currentPid = pid;

  while (currentPid > 1) {
    const output = execFileSync('ps', ['-o', 'ppid=', '-p', currentPid.toString()], {
      encoding: 'utf8',
    }).trim();
    const parentPid = Number.parseInt(output, 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0 || seenPids.has(parentPid)) break;
    ancestorPids.push(parentPid);
    seenPids.add(parentPid);
    currentPid = parentPid;
  }

  return ancestorPids;
}
