'use strict';
/**
 * A stand-in for the detached install job (dist/stt/sttInstallEntry.js): takes the same lock directory, writes
 * scripted progress lines to install-progress.json, then releases the lock.
 *   node fakeSttInstallEntry.cjs <dataDir> <outcome: done|failed|vanish> [--step-ms N] [--ack-dir <dir>]
 * `vanish` exits holding no terminal line (a crashed job).
 * With `--ack-dir`, a line that is not the last is followed by a wait for a file named after its phase in that folder: the next line is
 * written only when the test has seen this one reported, so a slow poller on a busy machine cannot skip a phase.
 */
const fs = require('node:fs');
const path = require('node:path');

const [dataDir, outcome] = process.argv.slice(2);
const stepIndex = process.argv.indexOf('--step-ms');
const stepMs = stepIndex >= 0 ? Number(process.argv[stepIndex + 1]) : 100;
const ackIndex = process.argv.indexOf('--ack-dir');
const ackDir = ackIndex >= 0 ? process.argv[ackIndex + 1] : null;
/** A hang guard, not a speed: the wait ends the moment the file is there; without it a test that never acks would leave this process for ever. */
const ackWaitLimitMs = 30000;
const ackPollMs = 10;
const ackTimeoutExitCode = 3;
const root = path.join(dataDir, 'stt');
const lockDir = path.join(root, 'install.lock');
const progressFile = path.join(root, 'install-progress.json');

fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(lockDir);
fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n`);
fs.writeFileSync(progressFile, '');
const write = (line) => fs.appendFileSync(progressFile, `${JSON.stringify(line)}\n`);

/** Each step writes its line and says the phase it wrote (`null`: the last step, which may write nothing — `vanish`). */
const steps = [
  () => { write({ phase: 'creatingEnvironment', detail: '', bytesDownloaded: 0 }); return 'creatingEnvironment'; },
  () => { write({ phase: 'installingPackages', detail: '', bytesDownloaded: 0 }); return 'installingPackages'; },
  () => { write({ phase: 'downloadingModel', detail: '100/216 MB', bytesDownloaded: 100 * 1024 * 1024 }); return 'downloadingModel'; },
  () => {
    if (outcome === 'done') write({ phase: 'done', detail: '', bytesDownloaded: 216 * 1024 * 1024 });
    if (outcome === 'failed') write({ phase: 'failed', detail: '', bytesDownloaded: 0, error: 'the model check failed', logTail: ['line one', 'line two'] });
    return null;
  },
];

async function waitForAck(phase) {
  if (ackDir === null || phase === null) return;
  const deadlineMs = Date.now() + ackWaitLimitMs;
  while (!fs.existsSync(path.join(ackDir, phase))) {
    if (Date.now() > deadlineMs) process.exit(ackTimeoutExitCode);
    await new Promise((resolve) => setTimeout(resolve, ackPollMs));
  }
}

(async () => {
  for (const step of steps) {
    await waitForAck(step());
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
})();
