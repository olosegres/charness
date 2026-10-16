'use strict';
/**
 * A stand-in for the detached install job (dist/stt/sttInstallEntry.js): takes the same lock directory, writes
 * scripted progress lines to install-progress.json, then releases the lock.
 *   node fakeSttInstallEntry.cjs <dataDir> <outcome: done|failed|vanish> [--step-ms N]
 * `vanish` exits holding no terminal line (a crashed job).
 */
const fs = require('node:fs');
const path = require('node:path');

const [dataDir, outcome] = process.argv.slice(2);
const stepIndex = process.argv.indexOf('--step-ms');
const stepMs = stepIndex >= 0 ? Number(process.argv[stepIndex + 1]) : 100;
const root = path.join(dataDir, 'stt');
const lockDir = path.join(root, 'install.lock');
const progressFile = path.join(root, 'install-progress.json');

fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(lockDir);
fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n`);
fs.writeFileSync(progressFile, '');
const write = (line) => fs.appendFileSync(progressFile, `${JSON.stringify(line)}\n`);

const steps = [
  () => write({ phase: 'creatingEnvironment', detail: '', bytesDownloaded: 0 }),
  () => write({ phase: 'installingPackages', detail: '', bytesDownloaded: 0 }),
  () => write({ phase: 'downloadingModel', detail: '100/216 MB', bytesDownloaded: 100 * 1024 * 1024 }),
  () => {
    if (outcome === 'done') write({ phase: 'done', detail: '', bytesDownloaded: 216 * 1024 * 1024 });
    if (outcome === 'failed') write({ phase: 'failed', detail: '', bytesDownloaded: 0, error: 'the model check failed', logTail: ['line one', 'line two'] });
  },
];

(async () => {
  for (const step of steps) {
    step();
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
})();
