'use strict';
/**
 * A stand-in for stt/gigaam_sidecar.py that follows the same CONTRACT, so the lifecycle code can be tested with
 * real processes and no model: --ready-file / --record-file / --log-file, a bearer token from
 * CHARNESS_STT_SIDECAR_TOKEN, port 0, GET /health, POST /v1/audio/transcriptions, an owner-PID watchdog, an
 * idle exit that deletes ITS OWN record, SIGTERM -> exit 0.
 *
 * Like the Python sidecar it records ITSELF (`--record-file`): it CLAIMS the record at once (an exclusive create,
 * port 0, before the "model" loads) and completes it with its port once it listens, before the ready file. The bot
 * adopts a process from that record, so one a replaced worker never saw ready is still found, and a second start
 * that finds the record held by another live sidecar exits with code 4 instead of becoming an orphan.
 *
 * Test knobs (not part of the contract): --claim-delay-ms N (start slowly: the window before the claim),
 * --ready-delay-ms N (the "model load": between the claim and the listening port), --never-ready (claims, then
 * hangs without ever listening), --crash-after-ms N (hard exit 1 after it is ready, record left behind),
 * --idle-seconds N (overrides --idle-minutes), --ignore-sigterm, --health-delay-ms N (answer /health late, like a
 * sidecar busy with a long voice), --health-hang (never answer /health), --fail-to-record (exit 1 where the record
 * cannot be written, before any ready file), --skip-record (write the ready file WITHOUT recording).
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
const configHash = readArg('--config-hash');
const healthDelayMs = Number(readArg('--health-delay-ms', '0'));
const readyDelayMs = Number(readArg('--ready-delay-ms', '0'));
const claimDelayMs = Number(readArg('--claim-delay-ms', '0'));
const duplicateExitCode = 4;
const crashAfterMs = Number(readArg('--crash-after-ms', '0'));
const idleSeconds = readArg('--idle-seconds') !== undefined
  ? Number(readArg('--idle-seconds'))
  : Number(readArg('--idle-minutes', '15')) * 60;
const token = process.env.CHARNESS_STT_SIDECAR_TOKEN;
const ownerCheckMs = 100;
const idleCheckMs = 100;

if (!token) process.exit(2);

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

function readRecordFile() {
  try {
    return JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  } catch {
    return null;
  }
}

function buildRecord(port) {
  return {
    pid: process.pid,
    startToken: readStartToken(process.pid),
    port,
    token,
    configHash,
    ownerPid,
    ownerStartToken: ownerStartToken ?? '',
    startedAt: new Date().toISOString(),
  };
}

/** The exclusive create: a hard link of a finished file, so a reader never sees half a record. False: another live sidecar holds it. */
function claimRecord() {
  const temporaryPath = `${recordFile}.${process.pid}.claim`;
  fs.writeFileSync(temporaryPath, JSON.stringify(buildRecord(0)), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(temporaryPath, recordFile);
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readRecordFile();
        if (existing && existing.pid !== process.pid && readStartToken(existing.pid) === existing.startToken) return false;
        fs.rmSync(recordFile, { force: true });
      }
    }
    throw new Error('could not claim the record');
  } finally {
    fs.rmSync(temporaryPath, { force: true });
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
    if (hasFlag('--health-hang')) return undefined;
    setTimeout(() => reply(200, { status: 'ok', busyRequests: 0, workers, pid: process.pid }), healthDelayMs);
    return undefined;
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

function writeJsonAtomic(filePath, payload) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function listenAndReport(isRecorded) {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    if (isRecorded) {
      const current = readRecordFile();
      if (!current || current.pid !== process.pid) process.exit(1); // the record was taken away while "loading"
      writeJsonAtomic(recordFile, buildRecord(port));
    }
    const temporaryPath = `${readyFile}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ pid: process.pid, port, version: 'fake' }));
    fs.renameSync(temporaryPath, readyFile);
    if (crashAfterMs > 0) setTimeout(() => process.exit(1), crashAfterMs);
  });
}

setTimeout(() => {
  if (hasFlag('--fail-to-record')) process.exit(1);
  const isRecorded = !hasFlag('--skip-record');
  if (isRecorded && !claimRecord()) process.exit(duplicateExitCode);
  if (hasFlag('--never-ready')) {
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => listenAndReport(isRecorded), readyDelayMs);
}, claimDelayMs);

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
