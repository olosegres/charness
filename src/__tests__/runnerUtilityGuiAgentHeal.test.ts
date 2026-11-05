/**
 * @description `runnerUtility/guiAgentHeal.ts`: the link puts the login session's agent of an always-on Mac in place itself. The decision table; one look against a
 * recording `launchctl` and a temp home (a Mac paired before the agent existed, an older definition, a loaded agent while a job runs, no login session, a
 * session `launchctl` cannot be asked about, a failing bootstrap / write); and the healer's record for `runners` (kept on a failure, forgotten on anything else)
 * and its once-per-kind log.
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
  session: 'present' | 'absent' | 'denied';
  isLoaded: boolean;
  bootstrapFails: boolean;
  /** `bootout` does not unload (launchd still tearing the job down). */
  bootoutLeavesLoaded: boolean;
}

let home = '';
let paths: RunnerHomePaths = getRunnerHomePaths('/nonexistent');
let names = getServiceNames(paths.root);
let calls: string[] = [];
let world: LaunchctlWorld = { session: 'present', isLoaded: false, bootstrapFails: false, bootoutLeavesLoaded: false };
let queue: PueueState = { kind: 'idle' };
let serviceKind: string | null = 'system-service';
let logLines: string[] = [];

function result(overrides: Partial<CommandResult>): CommandResult {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides };
}

/** A `launchctl` that keeps the state of one account's domain and records every call. */
const launchctl: CommandRunner = async (file, args) => {
  calls.push([file, ...args].join(' '));
  assert.equal(file, 'launchctl', 'only launchctl is run by a look');
  const [verb, target, plist] = args;
  if (verb === 'print' && target === domain) {
    if (world.session === 'present') return result({});
    return result({ ok: false, exitCode: 113, stderr: world.session === 'absent' ? `Could not find domain for user gui: ${uid}\n` : 'Operation not permitted\n' });
  }
  if (verb === 'print' && target === `${domain}/${names.launchdGui}`) return world.isLoaded ? result({}) : result({ ok: false, exitCode: 113, stderr: 'Could not find service in domain\n' });
  if (verb === 'bootout') {
    if (!world.bootoutLeavesLoaded) world.isLoaded = false;
    return result({});
  }
  if (verb === 'bootstrap' && target === domain && plist === getGuiAgentFile(paths.homeDir, names)) {
    if (world.bootstrapFails) return result({ ok: false, exitCode: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' });
    world.isLoaded = true;
    return result({});
  }
  throw new Error(`unexpected launchctl call: ${args.join(' ')}`);
};

function createDeps(): GuiAgentHealDeps {
  return { runner: launchctl, uid, accountName, nodeDir, getServiceKind: () => serviceKind, readQueue: async () => queue };
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
  world = { session: 'present', isLoaded: false, bootstrapFails: false, bootoutLeavesLoaded: false };
  queue = { kind: 'idle' };
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
    assert.deepEqual(calls, [`launchctl print ${domain}`]);
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

describe('healGuiAgent: failures say why', () => {
  it('a bootstrap that fails is a failure with launchctl\'s own words — and the written file stays, so the next login loads it', async () => {
    world.bootstrapFails = true;
    const outcome = await healGuiAgent(paths, createDeps());
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', new RegExp(`launchctl bootstrap ${domain} failed \\(Bootstrap failed: 5: Input/output error\\)`));
    assert.equal(readDefinition(), expectedDefinition());
  });

  it('a session that launchctl cannot be asked about (not «no such domain») is a failure, never read as «no login session»', async () => {
    world.session = 'denied';
    const outcome = await healGuiAgent(paths, createDeps());
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /launchctl cannot be asked about gui\/501 \(Operation not permitted\)/);
    assert.equal(readDefinition(), null, 'and nothing was written on a guess');
  });

  it('a definition that cannot be written is a failure naming the file and the error code, and nothing is loaded', async () => {
    fs.writeFileSync(path.join(home, 'Library'), 'a file where the folder should be');
    const outcome = await healGuiAgent(paths, createDeps());
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /could not be written \(ENOTDIR\)/);
    assert.ok(!calls.some((call) => call.startsWith('launchctl bootstrap')));
  });

  it('an old agent that stays loaded after bootout is a failure: the new one is not bootstrapped over it', async () => {
    writeOldDefinition();
    world.isLoaded = true;
    world.bootoutLeavesLoaded = true;
    const outcome = await healGuiAgent(paths, createDeps());
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /still loaded in gui\/501/);
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

  it('is written for a reason and removed for null; a missing one reads as nothing wrong', () => {
    assert.equal(readGuiAgentInstallFailure(paths), null);
    writeGuiAgentInstallFailure(paths, 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)');
    assert.equal(readGuiAgentInstallFailure(paths), 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)');
    assert.equal(fs.readFileSync(paths.guiInstallFailure, 'utf8').split('\n').length, 2, 'one line and its newline');
    writeGuiAgentInstallFailure(paths, null);
    assert.equal(readGuiAgentInstallFailure(paths), null);
    assert.doesNotThrow(() => writeGuiAgentInstallFailure(paths, null), 'forgetting what is not there is no error');
  });
});

describe('the healer: record and log of each look', () => {
  it('a failure is kept for `runners`; the next look that succeeds forgets it', async () => {
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    world.bootstrapFails = true;
    assert.equal((await healer.look()).kind, 'failed');
    assert.match(readGuiAgentInstallFailure(paths) ?? '', /launchctl bootstrap gui\/501 failed/);
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
    assert.equal((await healer.look()).kind, 'written-without-session');
    assert.equal(readGuiAgentInstallFailure(paths), null);
  });

  it('a runner that is not an always-on service never gets a record, and an existing one is not its business', async () => {
    serviceKind = 'user-service';
    writeGuiAgentInstallFailure(paths, 'left by an earlier kind');
    const healer = createGuiAgentHealer(paths, createDeps(), (line) => logLines.push(line));
    assert.equal((await healer.look()).kind, 'not-applicable');
    assert.equal(readGuiAgentInstallFailure(paths), 'left by an earlier kind');
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
    assert.deepEqual(outcome, { kind: 'failed', reason: 'spawn exploded' });
    assert.match(readGuiAgentInstallFailure(paths) ?? '', /spawn exploded/);
  });
});
