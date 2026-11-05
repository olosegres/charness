/**
 * @description `runnerUtility/guiAgentHeal.ts`: the link puts the login session's agent of an always-on Mac in place itself. The decision table; one look against a
 * recording `launchctl` / `pgrep` that answer in the words MEASURED on the owner's always-on Mac (2026-11-05, from the link's own System-session context) and a temp
 * home: a Mac paired before the agent existed, an older definition, a loaded agent while a job runs or is queued (and one that appears during the swap), no login
 * session — believed only when launchd's measured «Could not find domain» comes with no sign of a login —, a session `launchctl` cannot be asked about, a failing
 * bootstrap / write with the way out each leaves; and the healer's record for `runners` (kept on a failure, forgotten on anything else) and its once-per-kind log.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import {
  createGuiAgentHealer,
  formatInstallFailureReason,
  healGuiAgent,
  planGuiAgentHeal,
  readGuiAgentInstallFailure,
  writeGuiAgentInstallFailure,
  type GuiAgentFacts,
  type GuiAgentHealDeps,
} from '../runnerUtility/guiAgentHeal';
import type { PueueState } from '../runnerUtility/pueueDaemon';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { getGuiAgentFile } from '../runnerUtility/serviceCommon';
import { getServiceNames, planGuiAgentJob, renderLaunchdPlist } from '../runnerUtility/serviceUnits';

const accountName = 'runner';
const uid = 501;
const nodeDir = '/opt/node/bin';
const domain = `gui/${uid}`;

describe('planGuiAgentHeal: what to do for what is found', () => {
  const facts = (overrides: Partial<GuiAgentFacts>): GuiAgentFacts => ({ isAlwaysOnService: true, isDefinitionCurrent: false, hasSession: true, isLoaded: false, isQueueBusy: false, ...overrides });

  it('nothing for a runner that is not an always-on service, whatever else is true', () => {
    assert.equal(planGuiAgentHeal(facts({ isAlwaysOnService: false })), 'none');
  });

  it('a missing or older definition is written; loaded at once when the account has a login session, and only written when it has not', () => {
    assert.equal(planGuiAgentHeal(facts({ hasSession: false })), 'write');
    assert.equal(planGuiAgentHeal(facts({ hasSession: true, isLoaded: false })), 'write-and-load');
  });

  it('an older definition that is loaded is replaced while no job runs, and waits while one does (or its queue cannot be read)', () => {
    assert.equal(planGuiAgentHeal(facts({ isLoaded: true, isQueueBusy: false })), 'replace');
    assert.equal(planGuiAgentHeal(facts({ isLoaded: true, isQueueBusy: true })), 'wait-for-idle');
  });

  it('a current definition needs nothing when it is loaded or there is no session, and is loaded when the session is there without it', () => {
    assert.equal(planGuiAgentHeal(facts({ isDefinitionCurrent: true, isLoaded: true })), 'none');
    assert.equal(planGuiAgentHeal(facts({ isDefinitionCurrent: true, hasSession: false })), 'none');
    assert.equal(planGuiAgentHeal(facts({ isDefinitionCurrent: true, hasSession: true, isLoaded: false })), 'load');
  });

  it('a busy queue does not hold back a first install or a load of a current file: only replacing a LOADED agent cuts steps', () => {
    assert.equal(planGuiAgentHeal(facts({ isLoaded: false, isQueueBusy: true })), 'write-and-load');
    assert.equal(planGuiAgentHeal(facts({ isDefinitionCurrent: true, isLoaded: false, isQueueBusy: true })), 'load');
  });
});

interface LaunchctlWorld {
  /** `absent`: launchd's measured answer for a domain that does not exist; `denied`: its answer for a domain the caller may not look at; `elsewhere`: a text nobody measured. */
  session: 'present' | 'absent' | 'denied' | 'elsewhere';
  /** What `pgrep -u <uid> -lx 'loginwindow|Dock|Finder'` finds: the processes of a login session, none, or a failure. */
  loginProcesses: 'none' | 'present' | 'fails';
  isLoaded: boolean;
  bootstrapFails: boolean;
  /** `bootout` does not unload (launchd still tearing the job down). */
  bootoutLeavesLoaded: boolean;
}

let home = '';
let paths: RunnerHomePaths = getRunnerHomePaths('/nonexistent');
let names = getServiceNames(paths.root);
let calls: string[] = [];
let world: LaunchctlWorld = { session: 'present', loginProcesses: 'none', isLoaded: false, bootstrapFails: false, bootoutLeavesLoaded: false };
let queue: PueueState = { kind: 'idle' };
/** Answers of the queue, one per look, before `queue` takes over: a job that turns up between the looks of one swap. */
let queueAnswers: PueueState[] = [];
let serviceKind: string | null = 'system-service';
let logLines: string[] = [];

function result(overrides: Partial<CommandResult>): CommandResult {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides };
}

/** A `launchctl` (and the `pgrep` that confirms a login) that keeps the state of one account's domain, answers in launchd's measured words, and records every call. */
const launchctl: CommandRunner = async (file, args) => {
  calls.push([file, ...args].join(' '));
  if (file === 'pgrep') {
    assert.deepEqual(args, ['-u', `${uid}`, '-lx', 'loginwindow|Dock|Finder'], 'the processes a login session consists of, the account\'s own');
    if (world.loginProcesses === 'present') return result({ stdout: '412 loginwindow\n519 Dock\n523 Finder\n' });
    if (world.loginProcesses === 'fails') return result({ ok: false, exitCode: 2, stderr: 'pgrep: illegal option\n' });
    return result({ ok: false, exitCode: 1 });
  }
  assert.equal(file, 'launchctl', 'only launchctl and pgrep are run by a look');
  const [verb, target, plist] = args;
  if (verb === 'print' && target === domain) {
    if (world.session === 'present') return result({});
    if (world.session === 'absent') return result({ ok: false, exitCode: 112, stderr: `Bad request.\nCould not find domain for user gui: ${uid}\n` });
    if (world.session === 'denied') return result({ ok: false, exitCode: 1, stderr: 'Could not print domain: 1: Operation not permitted\n' });
    return result({ ok: false, exitCode: 64, stderr: 'launchctl: something nobody measured\n' });
  }
  if (verb === 'print' && target === `${domain}/${names.launchdGui}`) return world.isLoaded ? result({}) : result({ ok: false, exitCode: 113, stderr: `Bad request.\nCould not find service "${names.launchdGui}" in domain for user gui: ${uid}\n` });
  if (verb === 'bootout') {
    if (!world.bootoutLeavesLoaded) world.isLoaded = false;
    return result({});
  }
  if (verb === 'bootstrap' && target === domain && plist === getGuiAgentFile(paths.homeDir, names)) {
    if (world.bootstrapFails) return result({ ok: false, exitCode: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' });
    world.isLoaded = true;
    return result({});
  }
  throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
};

function createDeps(): GuiAgentHealDeps {
  return { runner: launchctl, uid, accountName, nodeDir, getServiceKind: () => serviceKind, readQueue: async () => queueAnswers.shift() ?? queue };
}

function expectedDefinition(): string {
  return renderLaunchdPlist(planGuiAgentJob(paths, names, accountName, nodeDir));
}

function readDefinition(): string | null {
  try {
    return fs.readFileSync(getGuiAgentFile(paths.homeDir, names), 'utf8');
  } catch {
    return null;
  }
}

function writeOldDefinition(): void {
  const file = getGuiAgentFile(paths.homeDir, names);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expectedDefinition().replace('<key>ThrottleInterval</key><integer>10</integer>', '<key>ThrottleInterval</key><integer>30</integer>'));
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gui-heal-')));
  paths = getRunnerHomePaths(home);
  names = getServiceNames(paths.root);
  calls = [];
  world = { session: 'present', loginProcesses: 'none', isLoaded: false, bootstrapFails: false, bootoutLeavesLoaded: false };
  queue = { kind: 'idle' };
  queueAnswers = [];
  serviceKind = 'system-service';
  logLines = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('healGuiAgent: a Mac paired before the agent existed gets it', () => {
  it('writes the missing definition into the account\'s own LaunchAgents folder and loads it into the account\'s login session — nothing else is touched', async () => {
    const outcome = await healGuiAgent(paths, createDeps());
    assert.deepEqual(outcome, { kind: 'loaded', wasReplaced: false });
    assert.equal(readDefinition(), expectedDefinition());
    assert.equal(getGuiAgentFile(paths.homeDir, names), path.join(home, 'Library', 'LaunchAgents', `${names.launchdGui}.plist`));
    assert.deepEqual(calls, [`launchctl print ${domain}`, `launchctl print ${domain}/${names.launchdGui}`, `launchctl bootstrap ${domain} ${getGuiAgentFile(paths.homeDir, names)}`]);
    assert.equal(fs.statSync(getGuiAgentFile(paths.homeDir, names)).mode & 0o777, 0o644);
    assert.ok(fs.existsSync(paths.logsDir), 'the log folder the agent writes into exists');
  });

  it('the definition is the agent\'s job exactly as the admin step writes it: a LaunchAgent for the Aqua session, run through the launcher\'s gui-agent command', async () => {
    await healGuiAgent(paths, createDeps());
    const text = readDefinition() ?? '';
    assert.ok(text.includes(`<key>Label</key><string>${names.launchdGui}</string>`));
    assert.ok(text.includes(`<string>${paths.launcher}</string>`) && text.includes('<string>gui-agent</string>'));
    assert.ok(text.includes('<key>LimitLoadToSessionType</key><string>Aqua</string>'));
    assert.ok(!text.includes('<key>UserName</key>'), 'a LaunchAgent runs as the account it is loaded for, not as a named user');
  });

  it('with no login session the file is written and left: launchd loads it at the account\'s next login, and nothing is bootstrapped', async () => {
    world.session = 'absent';
    const outcome = await healGuiAgent(paths, createDeps());
    assert.deepEqual(outcome, { kind: 'written-without-session' });
    assert.equal(readDefinition(), expectedDefinition());
    assert.deepEqual(calls, [`launchctl print ${domain}`, `pgrep -u ${uid} -lx loginwindow|Dock|Finder`], 'launchd\'s word is checked against the account\'s own processes, and nothing is bootstrapped');
  });

  it('a current definition in a session that does not have the agent loaded is loaded, and the file is not rewritten', async () => {
    fs.mkdirSync(path.dirname(getGuiAgentFile(paths.homeDir, names)), { recursive: true });
    fs.writeFileSync(getGuiAgentFile(paths.homeDir, names), expectedDefinition());
    const before = fs.statSync(getGuiAgentFile(paths.homeDir, names)).mtimeMs;
    const outcome = await healGuiAgent(paths, createDeps());
    assert.deepEqual(outcome, { kind: 'loaded', wasReplaced: false });
    assert.equal(fs.statSync(getGuiAgentFile(paths.homeDir, names)).mtimeMs, before);
    assert.ok(calls.some((call) => call.startsWith(`launchctl bootstrap ${domain} `)));
  });

  it('a current definition that is loaded (or has no session to load into) is left alone: no write, no bootstrap, no bootout', async () => {
    fs.mkdirSync(path.dirname(getGuiAgentFile(paths.homeDir, names)), { recursive: true });
    fs.writeFileSync(getGuiAgentFile(paths.homeDir, names), expectedDefinition());
    world.isLoaded = true;
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'in-place' });
    world.session = 'absent';
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'in-place' });
    assert.ok(!calls.some((call) => /bootstrap|bootout/.test(call)));
  });
});

describe('healGuiAgent: an older definition', () => {
  beforeEach(() => {
    writeOldDefinition();
    world.isLoaded = true;
  });

  it('replaces the loaded agent while no job runs: the new definition is written, the old agent booted out and the new one bootstrapped, in that order', async () => {
    const outcome = await healGuiAgent(paths, createDeps());
    assert.deepEqual(outcome, { kind: 'loaded', wasReplaced: true });
    assert.equal(readDefinition(), expectedDefinition());
    const order = ['bootout', 'bootstrap'].map((verb) => calls.findIndex((call) => call.startsWith(`launchctl ${verb} `)));
    assert.ok(order[0] > -1 && order[1] > order[0], calls.join('\n'));
  });

  it('leaves the loaded agent AND its file alone while a job runs — replacing it would cut the steps the job runs through it — and says it waits', async () => {
    queue = { kind: 'busy', activeJobs: 1 };
    const outcome = await healGuiAgent(paths, createDeps());
    assert.deepEqual(outcome, { kind: 'waiting-for-idle' });
    assert.notEqual(readDefinition(), expectedDefinition());
    assert.ok(!calls.some((call) => /bootstrap|bootout/.test(call)));
  });

  it('a job that turns up AFTER the first look but before the old agent is stopped stops the swap: the old definition is put back and nothing is booted out', async () => {
    const oldText = readDefinition();
    queueAnswers = [{ kind: 'idle' }, { kind: 'busy', activeJobs: 1 }];
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'waiting-for-idle' });
    assert.equal(readDefinition(), oldText, 'the next look sees the difference again and tries again');
    assert.ok(!calls.some((call) => /bootstrap|bootout/.test(call)), calls.join('\n'));
    // The next look finds the queue idle and finishes the swap.
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'loaded', wasReplaced: true });
    assert.equal(readDefinition(), expectedDefinition());
  });

  it('the queue is looked at twice for a swap — to decide, and right before the old agent is stopped — and the second look comes after the new file is written and before the bootout', async () => {
    const order: string[] = [];
    const deps = { ...createDeps(), runner: async (file: string, args: readonly string[], options: Parameters<CommandRunner>[2]) => { order.push(`${file} ${args[0]}`); return launchctl(file, args, options); }, readQueue: async () => { order.push('queue'); return queue; } };
    await healGuiAgent(paths, deps);
    const queueLooks = order.flatMap((entry, index) => (entry === 'queue' ? [index] : []));
    assert.equal(queueLooks.length, 2);
    assert.ok(queueLooks[1] < order.indexOf('launchctl bootout') && queueLooks[0] < queueLooks[1], order.join(' > '));
  });

  it('a queue whose state cannot be read counts as busy: it cannot be told apart from one with a running job', async () => {
    queue = { kind: 'unreadable' };
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'waiting-for-idle' });
  });

  it('a queue with no daemon answering runs nothing: the agent is replaced', async () => {
    queue = { kind: 'absent' };
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'loaded', wasReplaced: true });
  });

  it('an agent that is not loaded (the old file only) is written over and loaded without a look at the queue', async () => {
    world.isLoaded = false;
    queue = { kind: 'busy', activeJobs: 2 };
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'loaded', wasReplaced: false });
    assert.equal(readDefinition(), expectedDefinition());
  });
});

describe('healGuiAgent: what it does not do', () => {
  it('a runner that is not an always-on service is not touched: no file, no launchctl', async () => {
    for (const kind of [null, 'user-service']) {
      serviceKind = kind;
      assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'not-applicable' });
    }
    assert.deepEqual(calls, []);
    assert.equal(readDefinition(), null);
  });

  it('writes nothing outside the account\'s home', async () => {
    await healGuiAgent(paths, createDeps());
    const written: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(directory, entry.name));
        else written.push(path.relative(home, path.join(directory, entry.name)));
      }
    };
    walk(home);
    assert.deepEqual(written, [path.join('Library', 'LaunchAgents', `${names.launchdGui}.plist`)]);
  });
});

describe('healGuiAgent: failures say why — and which way out', () => {
  function failure(outcome: Awaited<ReturnType<typeof healGuiAgent>>): { reason: string; cure: string } {
    assert.equal(outcome.kind, 'failed');
    return outcome.kind === 'failed' ? { reason: outcome.reason, cure: outcome.cure } : { reason: '', cure: '' };
  }

  it('a bootstrap that fails is a failure with launchctl\'s own words; the written file stays, so LOGGING OUT AND IN loads it — the cure is the login, not only the admin line', async () => {
    world.bootstrapFails = true;
    const { reason, cure } = failure(await healGuiAgent(paths, createDeps()));
    assert.match(reason, new RegExp(`launchctl bootstrap ${domain} failed \\(Bootstrap failed: 5: Input/output error\\)`));
    assert.equal(cure, 'login');
    assert.equal(readDefinition(), expectedDefinition());
  });

  it('a session that launchctl cannot be asked about (a refusal, or a text nobody measured) is a failure, never read as «no login session»; nothing is written on a guess', async () => {
    world.session = 'denied';
    const refused = failure(await healGuiAgent(paths, createDeps()));
    assert.match(refused.reason, /launchctl cannot be asked about gui\/501 \(Could not print domain: 1: Operation not permitted\)/);
    world.session = 'elsewhere';
    assert.match(failure(await healGuiAgent(paths, createDeps())).reason, /launchctl cannot be asked about gui\/501 \(launchctl: something nobody measured\)/);
    assert.equal(readDefinition(), null);
    assert.ok(!calls.some((call) => call.startsWith('pgrep')), 'only launchd\'s measured «no such domain» is checked against the processes');
  });

  it('with nothing in place, an unreadable session leaves only the admin line; with the current definition in place, the login loads it', async () => {
    world.session = 'denied';
    assert.equal(failure(await healGuiAgent(paths, createDeps())).cure, 'admin');
    fs.mkdirSync(path.dirname(getGuiAgentFile(paths.homeDir, names)), { recursive: true });
    fs.writeFileSync(getGuiAgentFile(paths.homeDir, names), expectedDefinition());
    assert.equal(failure(await healGuiAgent(paths, createDeps())).cure, 'login');
  });

  it('a domain launchd calls unknown for an account that RUNS a login session (loginwindow, Dock, Finder) is a failure naming them — not «no login session»', async () => {
    world.session = 'absent';
    world.loginProcesses = 'present';
    const { reason } = failure(await healGuiAgent(paths, createDeps()));
    assert.match(reason, /launchd says gui\/501 does not exist \(Could not find domain for user gui: 501\), yet the account runs loginwindow, Dock, Finder: its login session cannot be reached from here/);
    assert.equal(readDefinition(), null);
  });

  it('a domain launchd calls unknown, with no way to confirm the account is logged out (pgrep fails), is a failure too', async () => {
    world.session = 'absent';
    world.loginProcesses = 'fails';
    const { reason } = failure(await healGuiAgent(paths, createDeps()));
    assert.match(reason, /whether the account is logged in could not be confirmed \(pgrep: pgrep: illegal option\)/);
  });

  it('the measured answer for a domain that does not exist, with no sign of a login, IS «no login session»; launchd\'s word for ANOTHER uid\'s domain is not that answer', async () => {
    world.session = 'absent';
    assert.deepEqual(await healGuiAgent(paths, createDeps()), { kind: 'written-without-session' });
    const otherUid = { ...createDeps(), uid: uid + 1 };
    const wrongDomain: CommandRunner = async (file, args, options) => (file === 'launchctl' && args[0] === 'print' && args[1] === `gui/${uid + 1}`
      ? result({ ok: false, exitCode: 112, stderr: `Bad request.\nCould not find domain for user gui: ${uid}\n` })
      : launchctl(file, args, options));
    assert.equal((await healGuiAgent(paths, { ...otherUid, runner: wrongDomain })).kind, 'failed', 'a text about a different domain proves nothing about this one');
  });

  it('a definition that cannot be written is a failure naming the file and the error code, and nothing is loaded — only the admin line puts it there', async () => {
    fs.writeFileSync(path.join(home, 'Library'), 'a file where the folder should be');
    const { reason, cure } = failure(await healGuiAgent(paths, createDeps()));
    assert.match(reason, /could not be written \(ENOTDIR\)/);
    assert.equal(cure, 'admin');
    assert.ok(!calls.some((call) => call.startsWith('launchctl bootstrap')));
  });

  it('an old agent that stays loaded after bootout is a failure: the new one is not bootstrapped over it, and the new file waits for the login', async () => {
    writeOldDefinition();
    world.isLoaded = true;
    world.bootoutLeavesLoaded = true;
    const { reason, cure } = failure(await healGuiAgent(paths, createDeps()));
    assert.match(reason, /still loaded in gui\/501/);
    assert.equal(cure, 'login');
    assert.ok(!calls.some((call) => call.startsWith('launchctl bootstrap')));
  });
});

describe('the record for `runners` (gui/install-failure)', () => {
  it('is one bounded line without control characters', () => {
    const noisy = `\u001b[31mbootstrap failed\u001b[0m\n${'x'.repeat(400)}\u0007`;
    const reason = formatInstallFailureReason(noisy);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(reason));
    assert.ok(reason.includes('bootstrap failed'), reason.slice(0, 40));
    assert.ok(reason.length <= 160 && reason.endsWith('…'));
  });

  it('is written as «<cure> <reason>» and removed for null; a missing one reads as nothing wrong', () => {
    assert.equal(readGuiAgentInstallFailure(paths), null);
    writeGuiAgentInstallFailure(paths, { cure: 'login', reason: 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)' });
    assert.deepEqual(readGuiAgentInstallFailure(paths), { cure: 'login', reason: 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)' });
    assert.equal(fs.readFileSync(paths.guiInstallFailure, 'utf8'), 'login launchctl bootstrap gui/501 failed (Bootstrap failed: 5)\n', 'one line');
    writeGuiAgentInstallFailure(paths, null);
    assert.equal(readGuiAgentInstallFailure(paths), null);
    assert.doesNotThrow(() => writeGuiAgentInstallFailure(paths, null), 'forgetting what is not there is no error');
  });

  it('a record without a cure word (any other text) reads as one that needs the admin line', () => {
    fs.mkdirSync(path.dirname(paths.guiInstallFailure), { recursive: true });
    fs.writeFileSync(paths.guiInstallFailure, 'something an older link wrote\n');
    assert.deepEqual(readGuiAgentInstallFailure(paths), { cure: 'admin', reason: 'something an older link wrote' });
  });
});

describe('the healer: record and log of each look', () => {
  it('a failure is kept for `runners`; the next look that succeeds forgets it', async () => {
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    world.bootstrapFails = true;
    assert.equal((await healer.look()).kind, 'failed');
    assert.match(readGuiAgentInstallFailure(paths)?.reason ?? '', /launchctl bootstrap gui\/501 failed/);
    assert.equal(readGuiAgentInstallFailure(paths)?.cure, 'login');
    world.bootstrapFails = false;
    assert.equal((await healer.look()).kind, 'loaded');
    assert.equal(readGuiAgentInstallFailure(paths), null);
  });

  it('a login that is still missing is «needs a login» again, not a stale failure: the record goes when the look finds no session', async () => {
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    world.bootstrapFails = true;
    await healer.look();
    assert.notEqual(readGuiAgentInstallFailure(paths), null);
    world.session = 'absent';
    // The first look wrote the definition (the bootstrap was what failed), so a look with nobody logged in has nothing left to do.
    assert.equal((await healer.look()).kind, 'in-place');
    assert.equal(readGuiAgentInstallFailure(paths), null);
  });

  it('with nothing written yet, a look with nobody logged in writes the file for the next login and leaves no failure', async () => {
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    world.session = 'absent';
    assert.equal((await healer.look()).kind, 'written-without-session');
    assert.equal(readGuiAgentInstallFailure(paths), null);
  });

  it('a runner that is not an always-on service never gets a record, and an existing one is not its business', async () => {
    serviceKind = 'user-service';
    writeGuiAgentInstallFailure(paths, { cure: 'admin', reason: 'left by an earlier kind' });
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    assert.equal((await healer.look()).kind, 'not-applicable');
    assert.deepEqual(readGuiAgentInstallFailure(paths), { cure: 'admin', reason: 'left by an earlier kind' });
    assert.deepEqual(logLines, []);
  });

  it('logs an outcome once, not at every hourly look that finds the same; a quiet outcome logs nothing', async () => {
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    world.session = 'absent';
    await healer.look();
    await healer.look();
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /no login session, so launchd loads it at the next login/);
    world.session = 'present';
    await healer.look();
    assert.equal(logLines.length, 2);
    assert.match(logLines[1], /installed and loaded into the account's login session/);
    await healer.look();
    assert.equal(logLines.length, 2, 'in place: nothing to say');
  });

  it('a look that throws is a failure with its message, never an exception into the link', async () => {
    const healer = createGuiAgentHealer(paths, { ...createDeps(), runner: async () => { throw new Error('spawn exploded'); } }, (line) => logLines.push(line));
    const outcome = await healer.look();
    assert.deepEqual(outcome, { kind: 'failed', reason: 'spawn exploded', cure: 'admin' });
    assert.match(readGuiAgentInstallFailure(paths)?.reason ?? '', /spawn exploded/);
  });
});
