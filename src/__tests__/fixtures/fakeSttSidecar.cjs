'use strict';
/**
 * A stand-in for stt/gigaam_sidecar.py that follows the same CONTRACT, so the lifecycle code can be tested with
 * real processes and no model: --ready-file / --record-file / --log-file, a bearer token from
 * CHARNESS_STT_SIDECAR_TOKEN, port 0, GET /health, POST /v1/audio/transcriptions, an owner-PID watchdog, an
 * idle exit that deletes ITS OWN record, SIGTERM -> exit 0.
 *
 * Test knobs (not part of the contract): --ready-delay-ms N, --never-ready, --crash-after-ms N (hard exit 1
 * after it is ready, record left behind), --idle-seconds N (overrides --idle-minutes), --ignore-sigterm.
 */
const fs = require('node:fs');
const http = require('node:http');

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const readyFile = readArg('--ready-file');
const recordFile = readArg('--record-file');
const workers = Number(readArg('--workers', '4'));
const ownerPid = Number(readArg('--owner-pid', '0'));
const ownerStartToken = readArg('--owner-start-token');
const readyDelayMs = Number(readArg('--ready-delay-ms', '0'));
const crashAfterMs = Number(readArg('--crash-after-ms', '0'));
const idleSeconds = readArg('--idle-seconds') !== undefined
  ? Number(readArg('--idle-seconds'))
  : Number(readArg('--idle-minutes', '15')) * 60;
const token = process.env.CHARNESS_STT_SIDECAR_TOKEN;
const ownerCheckMs = 100;
const idleCheckMs = 100;

if (!token) process.exit(2);
if (hasFlag('--never-ready')) {
  setInterval(() => {}, 1000);
  return;
}

let lastActivityMs = Date.now();

function readStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[0] === 'Z' ? null : fields[19];
  } catch {
    return null;
  }
}

function removeOwnRecord() {
  try {
    if (JSON.parse(fs.readFileSync(recordFile, 'utf8')).pid === process.pid) fs.rmSync(recordFile, { force: true });
  } catch {
    // no record, or not ours
  }
}

const server = http.createServer((req, res) => {
  const authorised = req.headers.authorization === `Bearer ${token}`;
  const reply = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(payload));
  };
  if (!authorised) return reply(401, { error: { message: 'missing or wrong token' } });
  if (req.method === 'GET' && req.url === '/health') {
    return reply(200, { status: 'ok', busyRequests: 0, workers, pid: process.pid });
  }
  if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
    lastActivityMs = Date.now();
    req.resume();
    req.on('end', () => {
      lastActivityMs = Date.now();
      reply(200, { text: 'fake transcript' });
    });
    return undefined;
  }
  return reply(404, { error: { message: 'not found' } });
});

setTimeout(() => {
  server.listen(0, '127.0.0.1', () => {
    const temporaryPath = `${readyFile}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ pid: process.pid, port: server.address().port, version: 'fake' }));
    fs.renameSync(temporaryPath, readyFile);
    if (crashAfterMs > 0) setTimeout(() => process.exit(1), crashAfterMs);
  });
}, readyDelayMs);

setInterval(() => {
  let isOwnerAlive = true;
  try {
    process.kill(ownerPid, 0);
    isOwnerAlive = !ownerStartToken || readStartToken(ownerPid) === ownerStartToken;
  } catch (error) {
    isOwnerAlive = error.code === 'EPERM';
  }
  if (!isOwnerAlive) {
    removeOwnRecord();
    process.exit(0);
  }
}, ownerCheckMs).unref();

if (idleSeconds > 0) {
  setInterval(() => {
    if (Date.now() - lastActivityMs >= idleSeconds * 1000) {
      removeOwnRecord();
      process.exit(0);
    }
  }, idleCheckMs).unref();
}

if (hasFlag('--ignore-sigterm')) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));
