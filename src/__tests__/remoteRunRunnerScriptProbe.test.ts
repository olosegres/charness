/**
 * @description `remoteRun/runner.sh` — the script that runs on a runner — as far as `probe` goes (the rest of the script is `remoteRunRunnerScript.test.ts`; a file runs
 * under one time limit, and this half is the slow one: every probe asks the machine its questions): `probe` prints what `probe.ts` parses, fits its 20 s however many of
 * its questions hang, says what a paired runner adds (service, boot check, how the link keeps the machine awake, the tools a job runs with), and what a Mac says with fake
 * Xcode and caffeinate.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { iosBootFailureReasonPrefix } from '../runnerUtility/iosCheck';
import { scriptPath, slug, startRunnerStandIn, startStrangerProcess, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

const systemToolFolders = ['/usr/bin', '/bin'];

let workRoot = '';
let workDir = '';

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue', ...env }, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A folder holding a link to every program of the system folders except `hidden`: the probe still finds the system's tools (`df`, `awk`, `sed`…), but not
 * the machine's own `node` or `yarn` — a distro package in `/usr/bin` would otherwise answer «present» for a tool the case expects to be absent.
 */
function linkSystemToolsExcept(folder: string, hidden: readonly string[]): string {
  fs.mkdirSync(folder);
  const linkedNames = new Set<string>(hidden);
  for (const systemFolder of systemToolFolders) {
    for (const name of fs.readdirSync(systemFolder)) {
      if (linkedNames.has(name)) continue;
      linkedNames.add(name);
      fs.symlinkSync(path.join(systemFolder, name), path.join(folder, name));
    }
  }
  return folder;
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-probe-')));
  workDir = path.join(workRoot, 'work');
  fs.mkdirSync(workDir);
});
afterEach(() => {
  stopRunnerStandIns();
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('probe', () => {
  it('prints what the probe parser reads: this machine, its resources, no Pueue here', () => {
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    const probe = parseProbeOutput(result.stdout);
    assert.notEqual(probe.os, '');
    assert.ok((probe.cpuThreads ?? 0) > 0, 'threads');
    assert.ok((probe.ramTotalMb ?? 0) > 0, 'RAM');
    assert.ok((probe.diskFreeMb ?? 0) > 0, 'disk');
    assert.equal(probe.pueueVersion, null, 'Pueue is not at the (nonexistent) PUEUE_BIN');
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [0, 0, 0]);
    for (const name of ['android', 'ios', 'docker', 'playwright'] as const) {
      assert.ok(['yes', 'no'].includes(result.stdout.match(new RegExp(`^cap_${name}=(.*)$`, 'm'))?.[1] ?? ''), `cap_${name} is reported`);
    }
    assert.ok(fs.existsSync(workDir));
  });

  it('counts a started job, a queued job and the projects they belong to, from the job folders', () => {
    const runningDir = path.join(workDir, 'p', 'app-aaaaaaaaaa', 'jobs', 'box1-running');
    const queuedDir = path.join(workDir, 'p', 'app-bbbbbbbbbb', 'jobs', 'box1-queued');
    const finishedDir = path.join(workDir, 'p', 'app-aaaaaaaaaa', 'jobs', 'box1-finished');
    for (const directory of [runningDir, queuedDir, finishedDir]) {
      writeFile(directory, 'task-id', '1\n');
    }
    writeFile(runningDir, 'pid', `${startRunnerStandIn()}\n`);
    writeFile(finishedDir, 'exit', '0\n');
    const probe = parseProbeOutput(runScript(['probe', workDir]).stdout);
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [1, 1, 2]);
  });

  it('a job whose recorded pid went to a stranger (a daemon after a reboot) is not counted as running, and its project is not active', () => {
    const strangerDir = path.join(workDir, 'p', 'app-cccccccccc', 'jobs', 'box1-strange');
    writeFile(strangerDir, 'task-id', '1\n');
    writeFile(strangerDir, 'pid', `${startStrangerProcess()}\n`);
    const probe = parseProbeOutput(runScript(['probe', workDir]).stdout);
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [0, 0, 0]);
  });
});

describe('the probe fits its 20 s however many of its questions hang', () => {
  const stepLimitSec = 4;
  let fakeBin = '';

  function writeFake(name: string, body: string): void {
    const target = path.join(fakeBin, name);
    fs.writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /**
   * `probe_slow` of a Mac whose tools are the fakes in `fakeBin`, run as a sourced function; returns its lines and how long it took. It runs on a PATH built by the
   * case (`fakeBin` first, then `basePath`), and the bash that asks must add nothing to that PATH: a non-interactive `bash -c` still reads `~/.bashrc` — which puts
   * the user's own `node` and `yarn` first — when its stdin is a socket (Node's pipe) and `SHLVL` is 0 or unset (a run started by a service, a cron job,
   * `nohup … &`), and the `BASH_ENV` file always. So: no rc file, no `BASH_ENV`, no stdin.
   */
  function probeSlowOfAMac(basePath: string = process.env.PATH ?? ''): { lines: Record<string, string>; elapsedSec: number } {
    const { BASH_ENV: ignoredBashEnv, ...inheritedEnv } = process.env;
    void ignoredBashEnv;
    const result = spawnSync('bash', ['--norc', '-c', `source ${scriptPath}; uname() { echo Darwin; }; work=${workDir}; read_runner_state; start=$SECONDS; probe_slow; echo "elapsed=$((SECONDS - start))"`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inheritedEnv, PATH: `${fakeBin}:${basePath}`, PUEUE_BIN: path.join(fakeBin, 'pueue') },
      timeout: 60_000,
    });
    const lines: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) lines[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { lines, elapsedSec: Number(lines.elapsed) };
  }

  beforeEach(() => {
    fakeBin = path.join(workRoot, 'fake-bin');
    fs.mkdirSync(fakeBin);
  });

  it('Xcode, the simulators, Docker and Pueue all hanging cost one step limit in all — not one each — and say so, instead of "not found"', () => {
    for (const hanging of ['xcodebuild', 'xcrun', 'docker', 'pueue']) writeFake(hanging, 'exec sleep 120');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= stepLimitSec + 3, `${elapsedSec} s: the questions were asked one after the other (four of them would take ${4 * stepLimitSec} s)`);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'Xcode did not answer in time');
    assert.equal(lines.cap_docker, 'no');
    assert.equal(lines.pueue, 'missing');
    assert.ok(Number(lines.disk_free_mb) > 0, 'the answers that did come are reported');
  });

  it('a slow simctl does not turn a working Xcode into "no Xcode", nor invent a simulator count', () => {
    writeFake('xcodebuild', 'echo "Xcode 16.2"; echo "Build version 16C5032a"');
    writeFake('xcrun', 'exec sleep 120');
    writeFake('pueue', 'echo "pueue 4.0.4"');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= stepLimitSec + 3, `${elapsedSec} s`);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2');
    assert.equal(lines.pueue, '4.0.4');
  });

  it('everything answering: the Xcode version with the simulators it lists, Docker up, Pueue\'s version', () => {
    writeFake('xcodebuild', 'echo "Xcode 16.2"');
    writeFake('xcrun', 'printf "    iPhone 16 (AAAA) (Shutdown)\\n    iPhone 16 Pro (BBBB) (Booted)\\n"');
    writeFake('docker', 'echo ok');
    writeFake('pueue', 'echo "pueue 4.0.4"');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= 3, `${elapsedSec} s`);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2, 2 simulators');
    assert.equal(lines.cap_docker, 'yes');
  });

  it('the tools a job runs with: the versions `node` and `yarn` print, `none` for one that is not on the PATH, `unknown` for one that does not answer in time — within the step limit', () => {
    writeFake('node', 'echo v24.22.2');
    writeFake('yarn', 'echo 1.22.22; echo "a second line"');
    let { lines } = probeSlowOfAMac();
    assert.equal(lines.job_node, 'v24.22.2');
    assert.equal(lines.job_yarn, '1.22.22');
    writeFake('yarn', 'exec sleep 120');
    let elapsedSec: number;
    ({ lines, elapsedSec } = probeSlowOfAMac());
    assert.equal(lines.job_yarn, 'unknown');
    assert.ok(elapsedSec <= stepLimitSec + 3, `${elapsedSec} s: a yarn that hangs costs one step limit`);
    // This machine's own yarn (a Corepack shim that would run the fake node) must not answer for the absent one, nor its own node: the system's tools only,
    // without any `node` or `yarn` the machine keeps in its system folders.
    const systemTools = linkSystemToolsExcept(path.join(workRoot, 'system-tools'), ['node', 'yarn']);
    fs.rmSync(path.join(fakeBin, 'yarn'));
    ({ lines } = probeSlowOfAMac(systemTools));
    assert.equal(lines.job_yarn, 'none');
    fs.rmSync(path.join(fakeBin, 'node'));
    ({ lines } = probeSlowOfAMac(systemTools));
    assert.equal(lines.job_node, 'none');
  });

  it('yarn is never asked to prompt: Corepack\'s download question is off for the version call', () => {
    writeFake('node', 'echo v24.22.2');
    writeFake('yarn', 'echo "prompt=$COREPACK_ENABLE_DOWNLOAD_PROMPT"');
    assert.equal(probeSlowOfAMac().lines.job_yarn, 'prompt=0');
  });

  it('an Xcode that is not there is "not found" (not "did not answer"), and the probe leaves no scratch state behind', () => {
    writeFake('xcodebuild', 'exit 127');
    const { lines } = probeSlowOfAMac();
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'Xcode not found');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), [], 'the probe\'s scratch folder is removed');
  });
});

describe('what the probe says of a paired runner (its state folder is the parent of the work dir)', () => {
  /** Make `workRoot` look like the state folder of a charness-runner: `config.json` and `keys/` beside `work/`. */
  function makeStateFolder(): void {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
  }

  function probe(): { text: string; parsed: ReturnType<typeof parseProbeOutput> } {
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    return { text: result.stdout, parsed: parseProbeOutput(result.stdout) };
  }

  /**
   * What the probe says OF A PAIRED RUNNER — `read_runner_state; probe_runner_state` alone, as the sourced script's functions, parsed as the main box parses a probe.
   * A whole probe asks the machine its questions (twenty processes, seconds on a loaded box) and most of these tests want one line of it; the whole probe is run
   * where it is the point (`probe()`).
   */
  function probeState(): { text: string; parsed: ReturnType<typeof parseProbeOutput> } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; work=${workDir}; read_runner_state; probe_runner_state`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { text: result.stdout, parsed: parseProbeOutput(result.stdout) };
  }

  it('a hand-made runner (no state folder around its work dir) prints none of it', () => {
    const { text } = probe();
    assert.ok(!/^(paused|service|runner_version|ios_boot|awake)/m.test(text), text);
  });

  describe('how the link keeps the machine awake (`<state>/awake`)', () => {
    /** `probe_awake` alone, as a sourced function, parsed as the main box parses a probe: the whole probe takes seconds, and this is only its `awake=` part. */
    function probeAwake(): { text: string; parsed: ReturnType<typeof parseProbeOutput> } {
      const result = spawnSync('bash', ['-c', `source ${scriptPath}; work=${workDir}; read_runner_state; probe_awake`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return { text: result.stdout, parsed: parseProbeOutput(result.stdout) };
    }

    it('no file (a link of an older version, none ever started) says nothing — never a guess', () => {
      makeStateFolder();
      const { text, parsed } = probeAwake();
      assert.equal(text, '');
      assert.equal(parsed.keepsAwake, null);
    });

    it('`<method> <pid>` of a holder that is alive is that method; a holder that is gone is «no», whatever the file says', () => {
      makeStateFolder();
      for (const method of ['caffeinate', 'systemd-inhibit'] as const) {
        writeFile(workRoot, 'awake', `${method} ${process.pid}\n`);
        assert.deepEqual(probeAwake().parsed.keepsAwake, { method }, method);
      }
      const dead = spawnSync('true');
      writeFile(workRoot, 'awake', `caffeinate ${dead.pid}\n`);
      assert.deepEqual(probeAwake().parsed.keepsAwake, { method: null, reason: 'the caffeinate process of the link is gone' });
    });

    it('`none <reason>` is «no» with the reason; a damaged pid is «no» too; a word nobody knows says nothing', () => {
      makeStateFolder();
      writeFile(workRoot, 'awake', 'none systemd-inhibit was not found (no systemd here)\n');
      assert.deepEqual(probeAwake().parsed.keepsAwake, { method: null, reason: 'systemd-inhibit was not found (no systemd here)' });
      writeFile(workRoot, 'awake', 'caffeinate not-a-pid\n');
      assert.deepEqual(probeAwake().parsed.keepsAwake, { method: null, reason: 'the state of the sleep assertion is unreadable' });
      writeFile(workRoot, 'awake', 'whatever 12\n');
      assert.equal(probeAwake().parsed.keepsAwake, null);
    });

    it('a hand-made runner (no state folder) and the whole probe: `awake` is part of a paired runner\'s probe only', () => {
      assert.ok(!/^awake/m.test(probe().text));
      makeStateFolder();
      writeFile(workRoot, 'awake', `caffeinate ${process.pid}\n`);
      assert.match(probe().text, /^awake=caffeinate$/m);
    });
  });

  it('a work dir that is merely called work, beside a config.json but no keys/, is not a runner state folder', () => {
    writeFile(workRoot, 'config.json', '{}');
    assert.ok(!/^paused=/m.test(probeState().text));
    fs.rmSync(path.join(workRoot, 'config.json'));
    fs.mkdirSync(path.join(workRoot, 'keys'));
    assert.ok(!/^paused=/m.test(probeState().text));
  });

  it('a runner nobody paused and nobody installed as a service is running by hand', () => {
    makeStateFolder();
    const { parsed } = probeState();
    assert.deepEqual([parsed.isPaused, parsed.serviceKind, parsed.iosBoot, parsed.runnerVersion], [false, 'foreground', null, null]);
  });

  it('the paused flag is a file: present = paused', () => {
    makeStateFolder();
    writeFile(workRoot, 'paused', '');
    assert.equal(probeState().parsed.isPaused, true);
    fs.rmSync(path.join(workRoot, 'paused'));
    assert.equal(probeState().parsed.isPaused, false);
  });

  it('the service file names how it is kept running: user or system service; a word nobody knows is "unknown", not "run by hand"', () => {
    makeStateFolder();
    for (const [word, expected] of [['user-service', 'user-service'], ['system-service\n', 'system-service'], ['launchd-magic', 'unknown']] as const) {
      writeFile(workRoot, 'service', word);
      assert.equal(probeState().text.match(/^service=(.*)$/m)?.[1], expected, word);
    }
  });

  it('the charness version is the one in the installed package (`current/package.json`)', () => {
    makeStateFolder();
    writeFile(path.join(workRoot, 'current'), 'package.json', '{\n  "name": "charness",\n  "version": "3.8.0",\n  "scripts": {}\n}\n');
    assert.equal(probeState().parsed.runnerVersion, '3.8.0');
  });

  it('the iOS boot check file: bootable, not bootable (with its detail), or unreadable', () => {
    makeStateFolder();
    // The exact line `writeIosCheck` writes (iosCheck.ts), so the two sides of the file cannot drift apart again.
    writeFile(workRoot, 'ios-check.json', '{"status":"pass","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":null}\n');
    assert.deepEqual(probeState().parsed.iosBoot, { status: 'ok', detail: '' });
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"the Simulator did not boot: no login session"}\n');
    assert.deepEqual(probeState().parsed.iosBoot, { status: 'failed', detail: 'the Simulator did not boot: no login session' });
    writeFile(workRoot, 'ios-check.json', '{"status":"skipped","checkedAtMs":1,"xcode":null,"reason":null}\n');
    assert.deepEqual(probeState().parsed.iosBoot, { status: 'unchecked', detail: '' });
    writeFile(workRoot, 'ios-check.json', 'garbage');
    assert.deepEqual(probeState().parsed.iosBoot, { status: 'unchecked', detail: '' });
  });
});

describe('a Mac (the platform is faked, with fake Xcode and caffeinate)', () => {
  let fakeBin = '';
  let caffeinateLog = '';

  function writeFake(name: string, body: string): void {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /** Bash sourcing the script with `uname` saying Darwin, running `commands`; the fakes are first on the PATH. */
  function runAsAMac(commands: string): { stdout: string; stderr: string } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; uname() { echo Darwin; }; work=${workDir}; ${commands}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PUEUE_BIN: path.join(fakeBin, 'pueue'), CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  function readLines(text: string): Record<string, string> {
    const lines: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) lines[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return lines;
  }

  beforeEach(() => {
    fakeBin = path.join(workRoot, 'fake-bin');
    fs.mkdirSync(fakeBin);
    caffeinateLog = path.join(workRoot, 'caffeinate.log');
    writeFake('caffeinate', 'echo "$@" >> "$CAFFEINATE_LOG"');
    writeFake('xcodebuild', 'echo "Xcode 16.2"');
    writeFake('xcrun', 'printf "    iPhone 16 (AAAA) (Shutdown)\\n"');
    writeFake('pueue', 'echo "pueue 4.0.4"');
  });

  it('iOS: Xcode is there and the runner\'s service booted a Simulator — yes, with the Xcode version and the simulators', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', '{"status":"pass","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":null}\n');
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2, 1 simulators');
  });

  it('iOS: Xcode is there but the service could not boot a Simulator — no, and the reason is the login session (the plan\'s owner choice A)', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', `{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"${iosBootFailureReasonPrefix} boot: CoreSimulator is not available to a daemon"}\n`);
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, "needs the runner user's login session");
  });

  it('iOS: a PAIRED runner with no record yet is still being checked — no, not yes: the answer of an earlier start must not be offered meanwhile', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    const lines = readLines(runAsAMac('read_runner_state; probe_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'the iOS Simulator is being checked');
    assert.equal(lines.paused, 'no', 'the runner state IS read, so this probe reaches probe_runner_state\'s output');
    assert.equal(lines.ios_boot, undefined, 'and no answer is reported as the check\'s');
  });

  it('iOS: a check that failed for another reason shows THAT reason — a login session would be the wrong cure for a missing runtime', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"no iOS simulator runtime and iPhone device type are installed"}\n');
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'the iOS Simulator check failed: no iOS simulator runtime and iPhone device type are installed');
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":null,"reason":null}\n');
    assert.equal(readLines(runAsAMac('read_runner_state; probe_slow').stdout).cap_ios_detail, 'the iOS Simulator check failed');
  });

  it('the script and the utility agree on which failures are the boot refusal: the script carries the very prefix the check writes', () => {
    assert.ok(fs.readFileSync(scriptPath, 'utf8').includes(`"${iosBootFailureReasonPrefix}"*)`));
  });

  it('iOS: a runner with no boot check (a hand-made one, or one run in a terminal) keeps the answer Xcode gives', () => {
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'yes');
  });

  /** What the fake caffeinate was asked, once it has written it (it is started in the background and may outlive the script by a moment). */
  async function readCaffeinateLog(): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(caffeinateLog) && fs.readFileSync(caffeinateLog, 'utf8').endsWith('\n')) return fs.readFileSync(caffeinateLog, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the fake caffeinate was never called');
  }

  it('a job\'s command runs with caffeinate holding the Mac awake for its process — and keeps its own exit code', async () => {
    fs.mkdirSync(path.join(workRoot, 'jd'));
    const { stdout } = runAsAMac(`jd=${workRoot}/jd; run_step ${workRoot} 'exit 3'; wait; echo "code=$step_code"`);
    assert.equal(readLines(stdout).code, '3');
    assert.match(await readCaffeinateLog(), /^-i -w \d+\n$/);
  });

  it('`exec` holds the Mac awake the same way', async () => {
    fs.mkdirSync(path.join(workDir, 'p', slug, 'tree'), { recursive: true });
    writeFake('uname', 'echo Darwin');
    spawnSync('bash', [scriptPath, 'exec', workDir, slug, '', '3000', 'true'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    assert.match(await readCaffeinateLog(), /^-i -w \d+\n$/);
  });

  // On a real Mac the system's own caffeinate would be found (and hold the test shell): the case is for the machines CI and the dev box are.
  it('nothing on a system that is not a Mac, and nothing breaks where caffeinate is missing', { skip: process.platform === 'darwin' ? 'this Mac has a real caffeinate' : false }, () => {
    const notAMac = spawnSync('bash', ['-c', `source ${scriptPath}; fake_pid=$$; keep_awake_while "$fake_pid"; wait; echo done`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    assert.equal(notAMac.stdout.trim(), 'done');
    assert.equal(fs.existsSync(caffeinateLog), false, 'caffeinate was not started off a Mac');
    fs.rmSync(path.join(fakeBin, 'caffeinate'));
    const missing = runAsAMac('keep_awake_while $$; wait; echo done');
    assert.equal(missing.stdout.trim().endsWith('done'), true, missing.stderr);
  });
});
