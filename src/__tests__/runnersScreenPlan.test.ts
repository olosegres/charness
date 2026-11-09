/**
 * @description The `/runners` render plan (`utils/runnersScreenPlan.ts`), pure: the list of machines (online with its hardware, jobs and
 * capabilities; offline as it was; paused), the buttons and their callback data (revisioned, within Telegram's 64 bytes, read back
 * exactly), the removal question, the address step with and without a proposal, the pairing message's parts and the two texts that
 * replace it. Texts are English (the plan takes `t`); every other locale is pinned by `i18n.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, t } from '../i18n';
import { parseProbeOutput, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner } from '../runners/hubRegistry';
import { buildAdminBootstrapLine, defaultRunnerAccount } from '../runners/bootstrapLine';
import { unconfirmedRemovalStopAfterHours } from '../runners/removalTiming';
import { TELEGRAM_HARD_LIMIT } from '../connectors/telegram/messageSplit';
import { hubHostKeySchema, hubHostSchema, hubSshUserSchema } from '../runners/hubIds';
import { createPairCodePayload } from './runnersTestKit';
import { maxJobsAtOnce } from '../remoteRun/runnersConfig';
import {
  buildRunnersPageCallback,
  buildAddressStep,
  buildClosedText,
  buildExpiredText,
  buildJobsAtOnceOutcomeToast,
  buildJobsAtOncePicker,
  buildPairedText,
  buildPairingIntro,
  buildPairingJobsAtOnceRows,
  buildPairingJobsCallback,
  buildRunnerJobsCallback,
  buildRemovalOutcomeText,
  buildServiceRemovalText,
  buildRemoveConfirmation,
  buildRunnerActionCallback,
  buildRunnersScreen,
  clipReportedText,
  getRecommendedJobsAtOnce,
  maxCallbackDataBytes,
  maxReportedTextChars,
  maxScreenTextChars,
  paginateBlocks,
  parseRunnersCallback,
  runnersAddressOtherCallback,
  runnersAddressUseCallback,
  runnersPairCallback,
  runnersPairingJobsInfoCallback,
  runnersRefreshCallback,
  type RunnerAction,
  type RunnerScreenEntry,
} from '../utils/runnersScreenPlan';

const formatTime = (epochMs: number): string => `T${epochMs}`;
const revision = 7;

function createRunner(overrides: Partial<PairedRunner> = {}): PairedRunner {
  return {
    id: '0123456789ab',
    name: 'mac',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOzzz',
    keyFingerprint: 'SHA256:abc',
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOyyy',
    workDir: '/Users/runner/.charness-runner/work',
    os: 'Darwin',
    arch: 'arm64',
    version: '3.8.0',
    serviceKind: 'system-service',
    pairedAtMs: 1_000,
    pairId: 'aaaaaaaaaaaa',
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: false,
    ...overrides,
  };
}

const probeText = [
  'os=Darwin', 'os_name=macOS', 'os_version=15.1', 'arch=arm64',
  'cpu_model=Apple M2 Pro', 'cpu_cores=12', 'cpu_threads=12', 'load=1.2',
  'ram_total_mb=32768', 'ram_free_mb=20480', 'disk_free_mb=215040',
  'pueue=4.0.4', 'jobs_running=1', 'jobs_queued=0', 'jobs_projects=1',
  'cap_android=yes', 'cap_android_detail=HVF, emulator',
  'cap_playwright=yes', 'cap_playwright_detail=chromium',
  'cap_ios=no', "cap_ios_detail=needs the runner user's login session",
  'cap_docker=no', 'cap_docker_detail=',
].join('\n');

function createEntry(overrides: Partial<RunnerScreenEntry> = {}): RunnerScreenEntry {
  return { runner: createRunner(), isOnline: true, lastSeenMs: 2_000, probe: parseProbeOutput(probeText), ...overrides };
}

describe('runnersScreenPlan: what is told after removing an always-on service', () => {
  const commands = ['sudo launchctl bootout system/com.charness.runner.0a1b2c3d', 'sudo rm /Library/LaunchDaemons/com.charness.runner.0a1b2c3d.plist'];

  it('says that the service keeps running until an admin there removes it, gives the commands one per line and says where they come from', () => {
    assert.equal(
      buildServiceRemovalText('mac', commands, t),
      `⚠️ mac runs as an always-on service on that machine, and only an admin there can stop it (nothing of charness runs as root). It keeps running until then. As an admin on that machine, run:\n${commands.join('\n')}\nThese commands come from this charness host, not from the machine itself.`,
    );
  });

  it('in every language names the machine, carries every command whole and leaves no placeholder behind', () => {
    const english = buildServiceRemovalText('mac', commands, t);
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildServiceRemovalText('mac', commands, t);
        assert.ok(text.includes('mac'), `${locale}: the machine`);
        for (const command of commands) assert.ok(text.split('\n').includes(command), `${locale}: «${command}» on a line of its own`);
        assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
        assert.ok(text.length < 1500, `${locale}: ${text.length} characters`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });
});

describe('runnersScreenPlan: where a machine\'s link comes from', () => {
  const screenOf = (entry: RunnerScreenEntry): string => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;

  it('a machine whose link came from another address says so under its block: where from now, where from before, when', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: false } }));
    assert.ok(text.endsWith('\n  ⚠️ Its link now comes from 203.0.113.9 (it came from 198.51.100.7 before, T7000).'), text);
  });

  it('a link that took the place of one still up says what to do', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: true } }));
    assert.match(text, /\n  ⚠️ A link from 203\.0\.113\.9 took over while the one from 198\.51\.100\.7 was still up \(T7000\)\. If that is not you changing networks, remove this runner and pair it again: its key may be in use elsewhere\.$/);
  });

  it('links that fight say so, with the addresses and the count', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'fighting', sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs: 7_000 } }));
    assert.match(text, /\n  ⚠️ Links from 198\.51\.100\.7, 203\.0\.113\.9 keep replacing each other \(3 switches in 10 minutes\)\. Two machines may be using this runner’s key: remove it and pair it again if that is not intended\.$/);
  });

  it('also under a machine that was never probed (a line of its own after the heading), and nothing without a concern', () => {
    assert.ok(screenOf(createEntry({ probe: null, linkConcern: { kind: 'fighting', sources: ['a', 'b'], changeCount: 3, atMs: 7_000 } })).includes('\n  ⚠️ Links from a, b keep replacing'));
    assert.ok(!screenOf(createEntry({ linkConcern: null })).includes('⚠️'));
    assert.ok(!screenOf(createEntry()).includes('⚠️'));
  });

  it('in every language the three notes name every address and time they are given, and leave no placeholder behind', () => {
    const concerns = [
      { kind: 'sourceChanged' as const, fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: false },
      { kind: 'sourceChanged' as const, fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: true },
      { kind: 'fighting' as const, sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs: 7_000 },
    ];
    const lastLineOf = (concern: (typeof concerns)[number]): string => screenOf(createEntry({ linkConcern: concern })).split('\n').at(-1) ?? '';
    const english = runWithLocale('en', () => concerns.map(lastLineOf));
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        concerns.forEach((concern, index) => {
          const line = lastLineOf(concern);
          assert.ok(line.includes('203.0.113.9') && line.includes('198.51.100.7'), `${locale}: ${line}`);
          assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
          if (concern.kind === 'fighting') assert.ok(line.includes('3'), `${locale}: the count`);
          else assert.ok(line.includes('T7000'), `${locale}: the time`);
          if (locale !== 'en') assert.notEqual(line, english[index], `${locale}: translated, not the English fallback`);
        });
      });
    }
  });
});

describe('runnersScreenPlan: the list', () => {
  it('an online machine shows its system, how it is kept running, hardware, jobs and what it can do — what it can do first, what it cannot with why', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry()], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(
      screen.text,
      [
        'Runners — machines your agents can send tests and builds to',
        [
          'mac — online · macOS 15.1 (arm64) · always on (system service)',
          '  Apple M2 Pro, 12 cores, load 1.2 · RAM 32 GB, 20 GB free · disk 210 GB free',
          '  jobs: 1 running, 0 queued · projects: 1 · 1 at once',
          "  can: android (HVF, emulator) · playwright (chromium) · ios: no — needs the runner user's login session · docker: no",
        ].join('\n'),
      ].join('\n\n'),
    );
  });

  it('the project copies a machine keeps are one line under its jobs — how many and what they take, with ~ while a figure is still being measured; nothing when it has none or did not say', () => {
    const withCopies = (lines: string[]): string[] => buildRunnersScreen({ revision, entries: [createEntry({ probe: parseProbeOutput([probeText, ...lines].join('\n')) })], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n');
    const lineOf = (lines: string[]): string | undefined => withCopies(lines).find((line) => line.includes('project copies'));
    assert.equal(lineOf(['copies_count=16', 'copies_size_mb=296960', 'copies_unmeasured=0']), '  project copies: 16 · 290 GB');
    assert.equal(lineOf(['copies_count=16', 'copies_size_mb=296960', 'copies_unmeasured=3']), '  project copies: 16 · ~290 GB');
    assert.equal(lineOf(['copies_count=0', 'copies_size_mb=0', 'copies_unmeasured=0']), undefined);
    assert.equal(lineOf(['copies_count=16', 'copies_size_mb=296960', 'copies_unmeasured=0', 'copies_cloned=5']), '  project copies: 16 · 290 GB (clones counted in full)', 'clones share disk blocks that `du` counts in full: the line says so');
    assert.equal(lineOf(['copies_count=16', 'copies_size_mb=296960', 'copies_unmeasured=3', 'copies_cloned=5']), '  project copies: 16 · ~290 GB (clones counted in full)');
    assert.equal(lineOf([]), undefined);
    const lines = withCopies(['copies_count=2', 'copies_size_mb=2048', 'copies_unmeasured=0']);
    assert.ok(lines.indexOf('  project copies: 2 · 2 GB') === lines.findIndex((line) => line.startsWith('  jobs:')) + 1, 'right under the jobs line');
  });

  it('a disk under what the runner keeps free is marked LOW on the hardware line, like the CLI\'s `runners` does — also on the «as it was then» line of a machine that is offline; a disk at its target, a target of 0 and a runner that did not say show nothing', () => {
    const entryWith = (lines: string[], overrides: Partial<RunnerScreenEntry> = {}): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...lines].join('\n')), ...overrides });
    const hardwareLineOf = (entry: RunnerScreenEntry): string => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('RAM 32 GB')) ?? '';
    assert.match(hardwareLineOf(entryWith(['disk_min_free_mb=235520'])), /disk 210 GB free — LOW — the runner wants 230 GB kept free$/);
    assert.match(hardwareLineOf(entryWith(['disk_min_free_mb=235520'], { isOnline: false })), /as it was then: .* disk 210 GB free — LOW — the runner wants 230 GB kept free$/);
    assert.doesNotMatch(hardwareLineOf(entryWith(['disk_min_free_mb=61440'])), /LOW/);
    assert.doesNotMatch(hardwareLineOf(entryWith(['disk_min_free_mb=0'])), /LOW/);
    assert.doesNotMatch(hardwareLineOf(createEntry()), /LOW/);
  });

  it('in every language the LOW mark names the amount the runner keeps free and leaves no placeholder behind', () => {
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [createEntry({ probe: parseProbeOutput(`${probeText}\ndisk_min_free_mb=235520`) })], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = text.split('\n').find((candidate) => candidate.includes('230 GB'));
        assert.ok(line !== undefined, `${locale}: ${text}`);
        assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
      });
    }
  });

  it('in every language the project copies line carries the count and the size and leaves no placeholder behind', () => {
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [createEntry({ probe: parseProbeOutput(`${probeText}\ncopies_count=16\ncopies_size_mb=296960\ncopies_unmeasured=0`) })], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = text.split('\n').find((candidate) => candidate.includes('290 GB'));
        assert.ok(line !== undefined && line.includes('16'), `${locale}: ${line}`);
        assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
      });
    }
  });

  it('in every language the project copies line of a runner with clones says they are counted in full, and leaves no placeholder behind', () => {
    const plainLines = new Set<string>();
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const screenOf = (extra: string): string => buildRunnersScreen({ revision, entries: [createEntry({ probe: parseProbeOutput(`${probeText}\ncopies_count=16\ncopies_size_mb=296960\ncopies_unmeasured=0${extra}`) })], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = screenOf('\ncopies_cloned=5').split('\n').find((candidate) => candidate.includes('290 GB'));
        const plain = screenOf('').split('\n').find((candidate) => candidate.includes('290 GB'));
        assert.ok(line !== undefined && plain !== undefined && line.includes('16'), `${locale}: ${line}`);
        assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
        if (locale !== 'en') assert.notEqual(line, plain, `${locale}: the line with clones is not the line without`);
        assert.ok(line.length > plain.length, `${locale}: the clones line says more`);
        plainLines.add(line);
      });
    }
    assert.equal(plainLines.size, localeCodes.length, 'each language has a line of its own');
  });

  it('the Node and yarn the jobs run with are one line under what it can do — a version, «none» or «gave no answer»; nothing when its script did not report them', () => {
    const withTools = (tools: string[]): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...tools].join('\n')) });
    const lineOf = (entry: RunnerScreenEntry): string | undefined => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('jobs run with'));
    assert.equal(lineOf(withTools(['job_node=v24.22.2', 'job_yarn=1.22.22'])), '  jobs run with: Node v24.22.2 · yarn 1.22.22');
    assert.equal(lineOf(withTools(['job_node=v24.22.2', 'job_yarn=none'])), '  jobs run with: Node v24.22.2 · yarn none (a job that calls it fails)');
    assert.equal(lineOf(withTools(['job_node=none', 'job_yarn=unknown'])), '  jobs run with: Node none (a job that calls it fails) · yarn there, but gave no answer');
    assert.equal(lineOf(createEntry()), undefined);
    const offline = withTools(['job_node=v24.22.2', 'job_yarn=1.22.22']);
    assert.equal(lineOf({ ...offline, isOnline: false }), undefined, 'a machine that is offline shows no live tools');
  });

  it('the Simulator runtimes older than the newest of their major are one information line under what it can do; nothing without them, and nothing for a machine that is offline', () => {
    const withSimulators = (lines: string[]): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...lines].join('\n')) });
    const lineOf = (entry: RunnerScreenEntry): string | undefined => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('older runtimes'));
    assert.equal(lineOf(withSimulators(['sim_older_runtimes=iOS 26.4:11,watchOS 11.0:2'])), '  simulators of older runtimes (devices in brackets; nothing is removed): iOS 26.4 (11), watchOS 11.0 (2)');
    assert.equal(lineOf(createEntry()), undefined);
    assert.equal(lineOf({ ...withSimulators(['sim_older_runtimes=iOS 26.4:11']), isOnline: false }), undefined, 'a machine that is offline shows no live state');
  });

  it('in every language the older-simulators line carries the runtimes and leaves no placeholder behind', () => {
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [createEntry({ probe: parseProbeOutput(`${probeText}\nsim_older_runtimes=iOS 26.4:11`) })], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = text.split('\n').find((candidate) => candidate.includes('iOS 26.4 (11)'));
        assert.ok(line !== undefined, `${locale}: the line is there`);
        assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
      });
    }
  });

  it('how the link keeps the machine awake is one line under the tools — yes with how, or NO with why; nothing when the runner did not say, and a reason it reported is clipped', () => {
    const withAwake = (lines: string[]): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...lines].join('\n')) });
    const lineOf = (entry: RunnerScreenEntry): string | undefined => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('keeps awake'));
    assert.equal(lineOf(withAwake(['awake=caffeinate'])), '  keeps awake: yes (caffeinate; a closed lid still sleeps it)');
    assert.equal(lineOf(withAwake(['awake=systemd-inhibit'])), '  keeps awake: yes (systemd-inhibit; a closed lid still sleeps it)');
    assert.equal(lineOf(withAwake(['awake=no', 'awake_detail=systemd-inhibit was not found'])), '  keeps awake: NO — systemd-inhibit was not found; it may sleep when idle');
    assert.equal(lineOf(withAwake(['awake=no'])), '  keeps awake: NO — no reason given; it may sleep when idle');
    assert.equal(lineOf(createEntry()), undefined);
    assert.ok((lineOf(withAwake(['awake=no', `awake_detail=${'x'.repeat(2000)}`])) ?? '').length < 400, 'a reason the machine reported is clipped');
    assert.equal(lineOf({ ...withAwake(['awake=caffeinate']), isOnline: false }), undefined, 'an offline machine shows no live state');
  });

  it('in every language the awake line says how and leaves no placeholder behind', () => {
    const entry = createEntry({ probe: parseProbeOutput([probeText, 'awake=no', 'awake_detail=SOMETHING-REPORTED'].join('\n')) });
    const yes = createEntry({ probe: parseProbeOutput([probeText, 'awake=caffeinate'].join('\n')) });
    const english = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        assert.ok(text.includes('SOMETHING-REPORTED'), `${locale}: the reason`);
        assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left`);
        const yesText = buildRunnersScreen({ revision, entries: [yes], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        assert.ok(yesText.includes('caffeinate'), `${locale}: the method`);
        assert.doesNotMatch(yesText, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left (yes)`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });

  it('in every language the line names both versions and leaves no placeholder behind', () => {
    const entry = createEntry({ probe: parseProbeOutput([probeText, 'job_node=v24.22.2', 'job_yarn=none'].join('\n')) });
    const english = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = text.split('\n').find((candidate) => candidate.includes('v24.22.2'));
        assert.ok(line !== undefined && line.includes('Node') && line.includes('yarn'), `${locale}: ${line}`);
        assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });

  it('a machine online with its Mac\'s lid closed says so where it says «online» and shows its last snapshot as an old one — no jobs, no capabilities, no load: it was not asked', () => {
    const entry = createEntry({ isLidClosed: true });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('mac — lid closed — takes no new jobs · macOS 15.1 (arm64) · always on (system service)\n'), text);
    assert.ok(text.includes('  as it was then: Apple M2 Pro, 12 cores · RAM 32 GB · disk 210 GB free'), text);
    assert.ok(!text.includes('jobs:') && !text.includes('can:') && !text.includes('load') && !text.includes('— online'), text);
  });

  it('a lid-closed machine keeps its Pause and Remove buttons: the lid is not a state the operator sets', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry({ isLidClosed: true })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.deepEqual(screen.rows[1].map((button) => button.text), ['mac: Pause', 'mac: Remove']);
  });

  it('in every language the lid-closed status is its own words, not the English ones and not the online word', () => {
    const english = t('runners.statusLidClosed');
    for (const code of localeCodes) {
      runWithLocale(code, () => {
        const text = t('runners.statusLidClosed');
        assert.notEqual(text, '', code);
        assert.notEqual(text, t('runners.statusOnline'), code);
        if (code !== 'en') assert.notEqual(text, english, code);
        const { text: screen } = buildRunnersScreen({ revision, entries: [createEntry({ isLidClosed: true })], openPairingExpiries: [], isChecking: false }, t, formatTime);
        assert.ok(screen.includes(`mac — ${text} · `), `${code}: ${screen}`);
      });
    }
  });

  it('an offline machine shows when it was last seen and its last snapshot, marked as old — no jobs, no capabilities, no load', () => {
    const entry = createEntry({ isOnline: false, lastSeenMs: 5_000, runner: createRunner({ name: 'box1', isPaused: true, serviceKind: 'user-service' }) });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('box1 — offline since T5000 · paused · macOS 15.1 (arm64) · user service\n'), text);
    assert.ok(text.includes('  as it was then: Apple M2 Pro, 12 cores · RAM 32 GB · disk 210 GB free'), text);
    assert.ok(!text.includes('jobs:') && !text.includes('can:') && !text.includes('load'), text);
  });

  it('how a machine is kept running is what its probe says NOW, not the registry\'s word from the day it was paired (\"run by hand\" until `service install`)', () => {
    const installedLater = createEntry({ runner: createRunner({ serviceKind: 'foreground' }), probe: parseProbeOutput(`${probeText}\nservice=user-service`) });
    const { text } = buildRunnersScreen({ revision, entries: [installedLater], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('mac — online · macOS 15.1 (arm64) · user service\n'), text);
    assert.ok(!text.includes('run by hand'), text);
    const lastSeen = createEntry({ isOnline: false, lastSeenMs: 5_000, runner: createRunner({ serviceKind: 'foreground' }), probe: parseProbeOutput(`${probeText}\nservice=system-service`) });
    assert.ok(buildRunnersScreen({ revision, entries: [lastSeen], openPairingExpiries: [], isChecking: false }, t, formatTime).text.includes('mac — offline since T5000 · macOS 15.1 (arm64) · always on (system service)\n'));
  });

  it('a probe that says nothing about it (no `service=` line: an older runner script) leaves the registry\'s word standing', () => {
    const entry = createEntry({ runner: createRunner({ serviceKind: 'user-service' }), probe: parseProbeOutput(probeText) });
    assert.ok(buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.includes('mac — online · macOS 15.1 (arm64) · user service\n'));
  });

  it('a machine never seen says so, and with no snapshot only its heading shows (its registry facts stand in for the probe)', () => {
    const entry = createEntry({ isOnline: false, lastSeenMs: null, probe: null });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.endsWith('mac — offline, never connected · Darwin (arm64) · always on (system service)'), text);
  });

  it('a missing Pueue is named beside the jobs, and a machine that reported no cores shows its threads', () => {
    const probe: RunnerProbe = { ...parseProbeOutput(probeText), pueueVersion: null, cpuCores: null, cpuThreads: 16, load: null };
    const { text } = buildRunnersScreen({ revision, entries: [createEntry({ probe })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('  Apple M2 Pro, 16 threads · RAM'), text);
    assert.ok(text.includes('projects: 1 · 1 at once · Pueue is missing on this runner'), text);
  });

  it('no machines: the empty text and only the pair and refresh buttons', () => {
    const screen = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(screen.text, 'Runners — machines your agents can send tests and builds to\n\nNo runners yet. A runner is any machine (Mac, Linux) your agents can send tests and builds to.');
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.text)), [['＋ Pair a new runner'], ['↻ Refresh']]);
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.data)), [[runnersPairCallback], [runnersRefreshCallback]]);
  });

  it('an open pairing code and a running check are said under the list; several codes are ONE line with their count and the last expiry', () => {
    const one = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [10], isChecking: true }, t, formatTime);
    assert.ok(one.text.endsWith('A pairing code is open until T10.\n\n⏳ Checking the machines…'), one.text);
    const several = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [10, 30, 20, 5, 7, 9, 11, 13], isChecking: false }, t, formatTime);
    assert.ok(several.text.endsWith('8 pairing codes are open, the last until T30.'), several.text);
    assert.equal(several.text.split('\n').filter((line) => line.includes('pairing code')).length, 1);
  });

  it('every machine gets Pause (Resume when paused) and Remove, and under them its «jobs at once» button, carrying the revision and its position', () => {
    const entries = [createEntry(), createEntry({ runner: createRunner({ id: 'ba9876543210', name: 'box1', isPaused: true, jobsAtOnce: 3 }) })];
    const screen = buildRunnersScreen({ revision, entries, openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.text)), [
      ['＋ Pair a new runner'],
      ['mac: Pause', 'mac: Remove'],
      ['mac: Jobs at once — 1'],
      ['box1: Resume', 'box1: Remove'],
      ['box1: Jobs at once — 3'],
      ['↻ Refresh'],
    ]);
    assert.deepEqual(screen.rows.slice(1, 5).map((row) => row.map((button) => button.data)), [['rnr_7_0_p', 'rnr_7_0_x'], ['rnr_7_0_j'], ['rnr_7_1_r', 'rnr_7_1_x'], ['rnr_7_1_j']]);
  });

  it('the jobs line says how many jobs the machine runs at once — 1 for an entry that never said, the registry\'s number otherwise', () => {
    const jobsLineOf = (runner: PairedRunner): string => buildRunnersScreen({ revision, entries: [createEntry({ runner })], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('jobs: '))?? '';
    assert.equal(jobsLineOf(createRunner()), '  jobs: 1 running, 0 queued · projects: 1 · 1 at once');
    assert.equal(jobsLineOf(createRunner({ jobsAtOnce: 2 })), '  jobs: 1 running, 0 queued · projects: 1 · 2 at once');
  });
});

describe('runnersScreenPlan: callback data', () => {
  const actions: RunnerAction[] = ['pause', 'resume', 'remove', 'removeYes', 'removeNo', 'jobsPick'];

  it('reads back exactly what it built, for every action', () => {
    for (const action of actions) {
      assert.deepEqual(parseRunnersCallback(buildRunnerActionCallback(revision, 3, action)), { kind: 'runner', revision, index: 3, action });
    }
    for (const page of [0, 1, 17]) assert.deepEqual(parseRunnersCallback(buildRunnersPageCallback(page)), { kind: 'page', page });
    assert.deepEqual(parseRunnersCallback(runnersPairCallback), { kind: 'pair' });
    assert.deepEqual(parseRunnersCallback(runnersRefreshCallback), { kind: 'refresh' });
    assert.deepEqual(parseRunnersCallback(runnersAddressUseCallback), { kind: 'addressUse' });
    assert.deepEqual(parseRunnersCallback(runnersAddressOtherCallback), { kind: 'addressOther' });
  });

  it('reads back a number set in the picker and a number chosen on a pairing message, for every number a runner may have', () => {
    for (let count = 1; count <= maxJobsAtOnce; count += 1) {
      assert.deepEqual(parseRunnersCallback(buildRunnerJobsCallback(revision, 3, count)), { kind: 'runnerJobs', revision, index: 3, jobsAtOnce: count });
      assert.deepEqual(parseRunnersCallback(buildPairingJobsCallback('0123456789ab', count)), { kind: 'pairingJobs', pairId: '0123456789ab', jobsAtOnce: count });
    }
    assert.deepEqual(parseRunnersCallback(runnersPairingJobsInfoCallback), { kind: 'pairingJobsInfo' });
    assert.equal(buildRunnerJobsCallback(revision, 3, 6), 'rnr_7_3_j6');
    assert.equal(buildPairingJobsCallback('0123456789ab', 3), 'rnr_pj_0123456789ab_3');
  });

  it('stays within Telegram\'s 64 bytes at the largest revision and position it could carry', () => {
    const hugeRevision = Number.MAX_SAFE_INTEGER;
    for (const action of actions) {
      assert.ok(Buffer.byteLength(buildRunnerActionCallback(hugeRevision, 99, action)) <= maxCallbackDataBytes, action);
    }
    assert.ok(Buffer.byteLength(buildRunnersPageCallback(Number.MAX_SAFE_INTEGER)) <= maxCallbackDataBytes);
    assert.ok(Buffer.byteLength(buildRunnerJobsCallback(hugeRevision, 99, maxJobsAtOnce)) <= maxCallbackDataBytes);
    assert.ok(Buffer.byteLength(buildPairingJobsCallback('0123456789ab', maxJobsAtOnce)) <= maxCallbackDataBytes);
  });

  it('refuses data that is not one of its own', () => {
    // A number past the most a runner may have (0, 9, 10) and a pairing id that is not 12 hex digits are not buttons of this screen either.
    for (const data of ['rnr_7_0_j0', 'rnr_7_0_j9', 'rnr_7_0_j10', 'rnr_pj_0123456789ab_0', 'rnr_pj_0123456789ab_9', 'rnr_pj_0123456789a_2', 'rnr_pj_0123456789AB_2', 'rnr_pj_0123456789ab_', 'rnr_pjinfo_1']) {
      assert.equal(parseRunnersCallback(data), null, data);
    }
    for (const data of ['rnr_', 'rnr_x', 'rnr_7_0', 'rnr_7_0_z', 'rnr_7_-1_p', 'rnr_a_0_p', 'rnr_7_0_p_extra', 'rnr_pg_', 'rnr_pg_x', 'rnr_pg_-1', 'rnr_pg_1_2', 'fbk_add', 'tka_5', '']) {
      assert.equal(parseRunnersCallback(data), null, data);
    }
  });

  it('every button of every screen fits the cap', () => {
    const entries = Array.from({ length: 12 }, (_value, index) => createEntry({ runner: createRunner({ id: index.toString(16).padStart(12, '0'), name: `box-${index}` }) }));
    const screens = [
      buildRunnersScreen({ revision: 1_000_000, entries, openPairingExpiries: [], isChecking: false }, t, formatTime),
      buildRemoveConfirmation('box-3', 1_000_000, 3, t),
      buildAddressStep('203.0.113.5:22', t),
      buildAddressStep(null, t),
      buildJobsAtOncePicker(entries[3], 1_000_000, 3, t),
      { text: '', rows: buildPairingJobsAtOnceRows('0123456789ab', 1, t) },
    ];
    for (const screen of screens) {
      for (const button of screen.rows.flat()) assert.ok(Buffer.byteLength(button.data) <= maxCallbackDataBytes, button.data);
    }
  });
});

describe('runnersScreenPlan: the other screens and texts', () => {
  it('the removal question names the machine and what happens, with Remove and Cancel acting on the same revision and position', () => {
    const question = buildRemoveConfirmation('mac', revision, 0, t);
    assert.equal(question.text, 'Remove mac? Its key is deleted and it stops connecting. Jobs running there are killed.');
    assert.deepEqual(question.rows.map((row) => row.map((button) => [button.text, button.data])), [[['Remove', 'rnr_7_0_xy'], ['Cancel', 'rnr_7_0_xn']]]);
  });

  it('the address step with a proposal offers it and "another"; without one only "another", and says none was found', () => {
    const withProposal = buildAddressStep('203.0.113.5:22', t);
    assert.equal(
      withProposal.text,
      'Runners connect to this machine over ssh (outbound from the runner, nothing to open there).\n\n' +
        "Address runners will dial: 203.0.113.5:22 — found on this machine, answers with this machine's ssh key ✓",
    );
    assert.deepEqual(withProposal.rows.map((row) => row.map((button) => [button.text, button.data])), [
      [['Use 203.0.113.5:22', runnersAddressUseCallback], ['Enter another address', runnersAddressOtherCallback]],
    ]);

    const without = buildAddressStep(null, t);
    assert.ok(without.text.includes('No public address of this machine was found.'), without.text);
    assert.deepEqual(without.rows.map((row) => row.map((button) => button.data)), [[runnersAddressOtherCallback]]);
  });

  it('the pairing is ONE message: its explanation says the lifetime, where to paste the line and what it does as root, which word is the account and what it must be, and how to pair without sudo', () => {
    assert.equal(
      buildPairingIntro(10, 'runner', t),
      "Pair a runner — valid 10 minutes, single use; keep the line private.\n\nPaste it in an admin account's terminal on the runner machine: it runs code from this charness host there as root. The last word, «runner», is the account that runs the agents' code: make it an existing standard (non-admin) account, not your main one. No admin rights? Run the line in that account's own terminal without «sudo»:",
    );
    assert.ok(buildPairingIntro(10, 'ci-runner', t).includes('«ci-runner»'), 'the account is named as given');
  });

  it('in every language the pairing text says what the person needs: the lifetime, the account, the trust it gives as root and the way without sudo', () => {
    const english = buildPairingIntro(10, defaultRunnerAccount, t);
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const intro = buildPairingIntro(10, defaultRunnerAccount, t);
        assert.doesNotMatch(intro, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
        if (locale !== 'en') assert.notEqual(intro, english, `${locale}: translated, not the English fallback`);
        assert.ok(intro.includes(defaultRunnerAccount), `${locale}: the account is named`);
        // The line gives the charness host root on that machine for the paste, and the person without admin rights needs the word to drop: both are said in every language.
        assert.ok(intro.includes('root') && intro.includes('charness'), `${locale}: the intro names the trust it gives`);
        assert.ok(intro.includes('sudo'), `${locale}: and the way without sudo`);
        assert.ok(intro.includes('10'), `${locale}: and the lifetime`);
      });
    }
  });

  describe('the pairing message fits one Telegram message', () => {
    /** Every host-key type `hubIds.ts` accepts, with the size in bytes of the key as ssh sends it (what a real sshd offers: 2048-, 3072-, 4096- and 8192-bit RSA). */
    const hostKeyKinds: ReadonlyArray<{ label: string; type: string; blobBytes: number }> = [
      { label: 'ed25519', type: 'ssh-ed25519', blobBytes: 51 },
      { label: 'ecdsa-nistp256', type: 'ecdsa-sha2-nistp256', blobBytes: 104 },
      { label: 'ecdsa-nistp384', type: 'ecdsa-sha2-nistp384', blobBytes: 136 },
      { label: 'ecdsa-nistp521', type: 'ecdsa-sha2-nistp521', blobBytes: 172 },
      { label: 'rsa-2048', type: 'ssh-rsa', blobBytes: 279 },
      { label: 'rsa-3072', type: 'ssh-rsa', blobBytes: 407 },
      { label: 'rsa-4096', type: 'ssh-rsa', blobBytes: 535 },
    ];
    /** The longest host name (253 characters), IPv6 address and hub account (64) the registry accepts, and the highest port: if `hubIds.ts` allows more, this test says so. */
    const longestHost = 'h'.repeat(253);
    const longestUser = 'u'.repeat(64);
    const typicalHost = 'host.example';
    const typicalUser = 'hubuser';

    function measureLongestMessage(host: string, user: string, kind: { type: string; blobBytes: number }): { length: number; locale: string } {
      const hostKey = `${kind.type} ${Buffer.alloc(kind.blobBytes, 7).toString('base64')}`;
      const line = buildAdminBootstrapLine(createPairCodePayload({ host, user, hostKey, port: 65535 }));
      const lengths = localeCodes.map((locale) => ({ locale, length: runWithLocale(locale, () => `${buildPairingIntro(10, defaultRunnerAccount, t)}\n\n${line}`.length) }));
      return lengths.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest));
    }

    it('the limits this test measures at are the registry\'s own', () => {
      assert.equal(hubHostSchema.safeParse(longestHost).success, true);
      assert.equal(hubHostSchema.safeParse(`${longestHost}h`).success, false, 'a longer host name would be accepted: measure at it');
      assert.equal(hubSshUserSchema.safeParse(longestUser).success, true);
      assert.equal(hubSshUserSchema.safeParse(`${longestUser}u`).success, false, 'a longer hub account would be accepted: measure at it');
      assert.equal(hubHostSchema.safeParse('2001:0db8:85a3:0000:0000:8a2e:0370:7334').success, true);
      for (const kind of hostKeyKinds) assert.equal(hubHostKeySchema.safeParse(`${kind.type} ${Buffer.alloc(kind.blobBytes, 7).toString('base64')}`).success, true, kind.label);
    });

    it('in every language, with every host-key type up to RSA 3072, at the LONGEST host and hub account the registry accepts', () => {
      for (const kind of hostKeyKinds.filter((candidate) => candidate.blobBytes <= 407)) {
        const { length, locale } = measureLongestMessage(longestHost, longestUser, kind);
        assert.ok(length <= TELEGRAM_HARD_LIMIT, `${kind.label}: ${length} characters in ${locale}`);
      }
    });

    it('in every language, with EVERY host-key type — RSA 4096 too — at an ordinary host and hub account', () => {
      for (const kind of hostKeyKinds) {
        const { length, locale } = measureLongestMessage(typicalHost, typicalUser, kind);
        assert.ok(length <= TELEGRAM_HARD_LIMIT, `${kind.label}: ${length} characters in ${locale}`);
      }
    });
    // What cannot fit (an RSA 4096 key with a long host name or hub account, any RSA key larger than 4096 bits) is not offered: the check is made when the line is offered, and the code closed
    // (`runnersCommand.test.ts`).
  });

  it('what the pairing message becomes: paired (with the name and the time) or expired', () => {
    assert.equal(buildPairedText('mac', 42, 1, t, formatTime), 'Runner “mac” paired T42.\nJobs at once: 1 — change it in /runners.');
    assert.equal(buildPairedText('mac', 42, 3, t, formatTime), 'Runner “mac” paired T42.\nJobs at once: 3 — change it in /runners.');
    assert.equal(buildExpiredText(t), 'Pairing code expired.');
    assert.equal(buildClosedText(t), 'This line was used on a machine that was already paired — nothing new was paired.');
  });
});

describe('runnersScreenPlan: a bounded, paged list', () => {
  /** A machine whose report is as bulky as a machine can make it: every string a machine reports is 500 characters long. */
  function createBulkyEntry(index: number, overrides: Partial<RunnerScreenEntry> = {}): RunnerScreenEntry {
    const long = 'x'.repeat(500);
    const probe = parseProbeOutput(`${probeText}\ncpu_model=${long}\ncap_android_detail=${long}\ncap_ios_detail=${long}\ncap_docker=yes\ncap_docker_detail=${long}\ncap_playwright_detail=${long}\nos_name=${long}`);
    return createEntry({ runner: createRunner({ id: index.toString(16).padStart(12, '0'), name: `box-${index}` }), probe, ...overrides });
  }

  it('clips what a machine reported to a fixed length, with an ellipsis, and leaves a short text alone', () => {
    assert.equal(clipReportedText('short'), 'short');
    assert.equal(clipReportedText('y'.repeat(maxReportedTextChars)), 'y'.repeat(maxReportedTextChars));
    const clipped = clipReportedText('y'.repeat(maxReportedTextChars + 1));
    assert.equal(clipped.length, maxReportedTextChars);
    assert.ok(clipped.endsWith('…'));
  });

  it('paginateBlocks fills a page while the text fits, always gives a block a page of its own at least, and covers every block once', () => {
    const blocks = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)];
    assert.deepEqual(paginateBlocks(blocks, 1000), [{ start: 0, end: 4 }]);
    // Two blocks and their blank-line separator are 202 characters.
    assert.deepEqual(paginateBlocks(blocks, 202), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    assert.deepEqual(paginateBlocks(blocks, 201), [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]);
    assert.deepEqual(paginateBlocks(blocks, 5), [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }], 'a block over the budget still has a page');
    assert.deepEqual(paginateBlocks([], 100), []);
  });

  it('a list that fits is one page with no navigation and no page line', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry(), createEntry({ runner: createRunner({ id: 'ba9876543210', name: 'box1' }) })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(screen.pageCount, 1);
    assert.equal(screen.page, 0);
    assert.ok(!screen.text.includes('Page '), screen.text);
    assert.ok(!screen.rows.flat().some((button) => button.data.startsWith('rnr_pg_')));
  });

  it('thirty machines with the bulkiest reports fit pages that each stay within the screen budget AND Telegram\'s 4096, and every machine is on exactly one page, in order', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision, entries, openPairingExpiries: [1, 2, 3, 4, 5, 6, 7, 8], isChecking: true };
    const first = buildRunnersScreen(model, t, formatTime);
    assert.ok(first.pageCount > 4, `${first.pageCount} pages`);
    const seen: string[] = [];
    for (let page = 0; page < first.pageCount; page += 1) {
      const screen = buildRunnersScreen(model, t, formatTime, page);
      assert.equal(screen.page, page);
      assert.ok(screen.text.length <= maxScreenTextChars, `page ${page + 1}: ${screen.text.length} characters`);
      assert.ok(screen.text.length <= 4096);
      assert.ok(screen.text.includes(`Page ${page + 1} of ${first.pageCount}`));
      seen.push(...[...screen.text.matchAll(/^(box-\d+) — /gm)].map((match) => match[1]));
      for (const button of screen.rows.flat()) assert.ok(Buffer.byteLength(button.data) <= maxCallbackDataBytes, button.data);
      assert.ok(screen.rows.length <= 100, 'within the keyboard limit');
    }
    assert.deepEqual(seen, entries.map((entry) => entry.runner.name));
  });

  it('a machine\'s buttons keep its place in the WHOLE list and the revision, whichever page it is on', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision: 42, entries, openPairingExpiries: [], isChecking: false };
    const pageCount = buildRunnersScreen(model, t, formatTime).pageCount;
    const buttonData: string[] = [];
    for (let page = 0; page < pageCount; page += 1) {
      const screen = buildRunnersScreen(model, t, formatTime, page);
      buttonData.push(...screen.rows.flat().map((button) => button.data).filter((data) => data.endsWith('_p')));
    }
    assert.deepEqual(buttonData, entries.map((_entry, index) => `rnr_42_${index}_p`));
  });

  it('Previous and Next appear only where there is a page to go to, and a page past either end is clamped', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision, entries, openPairingExpiries: [], isChecking: false };
    const { pageCount } = buildRunnersScreen(model, t, formatTime);
    const labelsOf = (page: number): string[] => buildRunnersScreen(model, t, formatTime, page).rows.flat().map((button) => button.text);
    assert.ok(labelsOf(0).includes('Next ›') && !labelsOf(0).includes('‹ Previous'));
    assert.ok(labelsOf(1).includes('Next ›') && labelsOf(1).includes('‹ Previous'));
    assert.ok(!labelsOf(pageCount - 1).includes('Next ›') && labelsOf(pageCount - 1).includes('‹ Previous'));
    assert.equal(buildRunnersScreen(model, t, formatTime, pageCount + 7).page, pageCount - 1);
    assert.equal(buildRunnersScreen(model, t, formatTime, -3).page, 0);
    const middle = buildRunnersScreen(model, t, formatTime, 1);
    assert.deepEqual(middle.rows.flat().filter((button) => button.data.startsWith('rnr_pg_')).map((button) => button.data), [buildRunnersPageCallback(0), buildRunnersPageCallback(2)]);
  });

  it('a single machine with the bulkiest report is bounded by itself, and an empty list is one page', () => {
    const screen = buildRunnersScreen({ revision, entries: [createBulkyEntry(0)], openPairingExpiries: [], isChecking: true }, t, formatTime);
    assert.equal(screen.pageCount, 1);
    assert.ok(screen.text.length < 1500, `${screen.text.length} characters`);
    const empty = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [], isChecking: false }, t, formatTime, 5);
    assert.deepEqual([empty.page, empty.pageCount], [0, 1]);
  });
});

describe('what a removal came to', () => {
  it('has a text of its own for each outcome — stopped, offline, could not be stopped — and each names the machine', () => {
    const texts = (['stopped', 'offline', 'failed'] as const).map((jobs) => buildRemovalOutcomeText('mac', jobs, t));
    assert.equal(new Set(texts).size, 3, texts.join('\n'));
    assert.ok(texts.every((text) => text.startsWith('✅ mac removed.')));
    assert.match(texts[0], /jobs it was running are stopped/);
    assert.match(texts[1], /machine is offline/);
    assert.doesNotMatch(texts[2], /offline/, '«could not be stopped» does not claim the machine is offline: it may well be online');
    assert.match(texts[2], /could not be stopped from here/);
  });

  it('says how long the machine waits before it stops its jobs itself — the link loop\'s own delay, in every language — and only where the hub could not stop them', () => {
    const hours = unconfirmedRemovalStopAfterHours.toString();
    const wordsOfHours = new RegExp(`(^|[^0-9])${hours}([^0-9]|$)`);
    for (const locale of localeCodes) {
      for (const jobs of ['offline', 'failed'] as const) {
        const text = runWithLocale(locale, () => buildRemovalOutcomeText('mac', jobs, t));
        assert.match(text, wordsOfHours, `${locale} ${jobs}: the delay is named`);
        assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale} ${jobs}: no placeholder is left unfilled`);
        assert.doesNotMatch(text, /once it finds out|finds out it was removed/, `${locale} ${jobs}: no promise of an immediate stop`);
      }
      const stopped = runWithLocale(locale, () => buildRemovalOutcomeText('mac', 'stopped', t));
      assert.doesNotMatch(stopped, wordsOfHours, `${locale}: jobs stopped from the hub name no delay`);
    }
    assert.match(buildRemovalOutcomeText('mac', 'offline', t), /refused for 12 h\./);
  });
});

describe('runnersScreenPlan: how many jobs a runner runs at once', () => {
  const probeOf = (cores: number | null, ramMb: number | null): RunnerProbe => parseProbeOutput([
    probeText,
    ...(cores === null ? ['cpu_cores='] : [`cpu_cores=${cores}`]),
    ...(ramMb === null ? ['ram_total_mb='] : [`ram_total_mb=${ramMb}`]),
  ].join('\n'));

  it('recommends the smaller of memory/12 GB and cores/4, at least 1 and at most 4: the 10-core 32 GB Mac gets 2, a 8-core 16 GB machine 1, a big server 4', () => {
    assert.equal(getRecommendedJobsAtOnce(probeOf(10, 32 * 1024)), 2);
    assert.equal(getRecommendedJobsAtOnce(probeOf(8, 16 * 1024)), 1);
    assert.equal(getRecommendedJobsAtOnce(probeOf(2, 4 * 1024)), 1, 'a small machine is never recommended 0');
    assert.equal(getRecommendedJobsAtOnce(probeOf(64, 512 * 1024)), 4, 'capped');
    assert.equal(getRecommendedJobsAtOnce(probeOf(32, 24 * 1024)), 2, 'memory is the limit');
    assert.equal(getRecommendedJobsAtOnce(probeOf(8, 128 * 1024)), 2, 'cores are the limit');
  });

  it('recommends nothing when the runner did not report its cores or its memory', () => {
    assert.equal(getRecommendedJobsAtOnce(probeOf(null, 32 * 1024)), null);
    assert.equal(getRecommendedJobsAtOnce(probeOf(10, null)), null);
  });

  it('the picker names the machine, its number now and the recommendation for its hardware, and offers 1 2 3 4 6 8 with the current one marked, then Back', () => {
    const picker = buildJobsAtOncePicker(createEntry({ runner: createRunner({ jobsAtOnce: 2 }), probe: probeOf(10, 32 * 1024) }), revision, 4, t);
    assert.equal(
      picker.text,
      'How many jobs may mac run at once? Now 2.\n\nA job that is running is never stopped: a lower number only keeps the next ones waiting. Jobs side by side must use the ports and the simulator the runner gives them (docs/remote-run.md, «Jobs beside each other»).\n\nSuggested for 10 cores and 32 GB: 2.',
    );
    assert.deepEqual(picker.rows.map((row) => row.map((button) => button.text)), [['1', '2 ✓', '3', '4', '6', '8'], ['‹ Back']]);
    assert.deepEqual(picker.rows[0].map((button) => button.data), ['rnr_7_4_j1', 'rnr_7_4_j2', 'rnr_7_4_j3', 'rnr_7_4_j4', 'rnr_7_4_j6', 'rnr_7_4_j8']);
    assert.equal(picker.rows[1][0].data, runnersRefreshCallback, 'Back is the list again');
  });

  it('an entry that never said has 1 marked; a number the picker does not offer (an entry edited by hand) is added so the current one is always on a button', () => {
    const fresh = buildJobsAtOncePicker(createEntry(), revision, 0, t);
    assert.ok(fresh.text.startsWith('How many jobs may mac run at once? Now 1.'));
    assert.deepEqual(fresh.rows[0].map((button) => button.text), ['1 ✓', '2', '3', '4', '6', '8']);
    const odd = buildJobsAtOncePicker(createEntry({ runner: createRunner({ jobsAtOnce: 5 }) }), revision, 0, t);
    assert.deepEqual(odd.rows[0].map((button) => button.text), ['1', '2', '3', '4', '5 ✓', '6', '8']);
  });

  it('a runner that was never probed, or did not report its size, has no recommendation line', () => {
    assert.ok(!buildJobsAtOncePicker(createEntry({ probe: null }), revision, 0, t).text.includes('Suggested'));
    assert.ok(!buildJobsAtOncePicker(createEntry({ probe: probeOf(null, 32 * 1024) }), revision, 0, t).text.includes('Suggested'));
    assert.ok(buildJobsAtOncePicker(createEntry({ probe: probeOf(12, 32 * 1024) }), revision, 0, t).text.includes('Suggested for 12 cores and 32 GB: 2.'));
  });

  it('the pairing message keyboard is a label button, and under it 1 2 3 4 with the chosen one marked, each carrying the pairing code', () => {
    const rows = buildPairingJobsAtOnceRows('0123456789ab', 3, t);
    assert.deepEqual(rows.map((row) => row.map((button) => button.text)), [['Jobs at once:'], ['1', '2', '3 ✓', '4']]);
    assert.deepEqual(rows.map((row) => row.map((button) => button.data)), [[runnersPairingJobsInfoCallback], ['rnr_pj_0123456789ab_1', 'rnr_pj_0123456789ab_2', 'rnr_pj_0123456789ab_3', 'rnr_pj_0123456789ab_4']]);
  });

  it('what a tap says: told to the runner, or saved for its next job — and the three outcomes read differently', () => {
    assert.equal(buildJobsAtOnceOutcomeToast('mac', 2, 'applied', t), 'mac: 2 at once');
    assert.equal(buildJobsAtOnceOutcomeToast('mac', 2, 'offline', t), 'mac: 2 at once — it is offline and takes this at its next job');
    assert.equal(buildJobsAtOnceOutcomeToast('mac', 2, 'failed', t), 'mac: 2 at once is saved, but the machine did not take it now — it does at its next job');
  });

  it('in every language the picker, the toasts, the row label and the paired note carry their numbers and names, are translated, and leave no placeholder behind', () => {
    const entry = createEntry({ runner: createRunner({ jobsAtOnce: 2 }), probe: probeOf(10, 32 * 1024) });
    const english = {
      picker: buildJobsAtOncePicker(entry, revision, 0, t).text,
      row: buildPairingJobsAtOnceRows('0123456789ab', 2, t)[0][0].text,
      paired: buildPairedText('mac', 42, 2, t, formatTime),
      toasts: (['applied', 'offline', 'failed'] as const).map((outcome) => buildJobsAtOnceOutcomeToast('mac', 2, outcome, t)),
      help: t('runners.pairingJobsAtOnceHelpToast'),
      chosen: t('runners.pairingJobsAtOnceChosenToast', { count: 2 }),
      closed: t('runners.pairingJobsAtOnceClosedToast'),
      back: t('runners.jobsAtOnceBackButton'),
      button: t('runners.jobsAtOnceButton', { name: 'mac', count: 2 }),
      note: t('runners.jobsAtOnceNote', { count: 2 }),
    };
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const picker = buildJobsAtOncePicker(entry, revision, 0, t);
        const texts = {
          picker: picker.text,
          row: buildPairingJobsAtOnceRows('0123456789ab', 2, t)[0][0].text,
          paired: buildPairedText('mac', 42, 2, t, formatTime),
          help: t('runners.pairingJobsAtOnceHelpToast'),
          chosen: t('runners.pairingJobsAtOnceChosenToast', { count: 2 }),
          closed: t('runners.pairingJobsAtOnceClosedToast'),
          back: t('runners.jobsAtOnceBackButton'),
          button: t('runners.jobsAtOnceButton', { name: 'mac', count: 2 }),
          note: t('runners.jobsAtOnceNote', { count: 2 }),
        };
        const toasts = (['applied', 'offline', 'failed'] as const).map((outcome) => buildJobsAtOnceOutcomeToast('mac', 2, outcome, t));
        for (const [what, text] of [...Object.entries(texts), ...toasts.map((toast, index) => [`toast ${index}`, toast] as const)]) {
          assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale} ${what}: no placeholder is left unfilled`);
        }
        assert.ok(texts.picker.includes('mac') && texts.picker.includes('2') && texts.picker.includes('10') && texts.picker.includes('32'), `${locale}: the picker names the machine and the figures`);
        assert.ok(toasts.every((toast) => toast.includes('mac') && toast.includes('2')), `${locale}: every toast names the machine and the number`);
        assert.ok(texts.button.includes('mac') && texts.button.includes('2'), `${locale}: the button`);
        assert.ok(texts.note.includes('2') && texts.chosen.includes('2') && texts.paired.includes('mac') && texts.paired.includes('2'), `${locale}: the numbers`);
        // The picker text carries a docs reference the person is sent to, and the callback answers stay inside Telegram's 200 characters.
        assert.ok(texts.picker.includes('docs/remote-run.md'), `${locale}: the docs`);
        assert.ok([...toasts, texts.help, texts.chosen, texts.closed].every((toast) => toast.length <= 200), `${locale}: a callback answer holds 200 characters`);
        assert.ok(texts.closed.includes('/runners'), `${locale}: the closed-line answer says where the number is set`);
        assert.ok(texts.row.length <= 40, `${locale}: the label fits a full-width button`);
        if (locale !== 'en') {
          assert.notEqual(texts.picker, english.picker, `${locale}: picker translated`);
          assert.notEqual(texts.row, english.row, `${locale}: row label translated`);
          assert.notEqual(texts.paired, english.paired, `${locale}: paired note translated`);
          assert.notEqual(texts.help, english.help, `${locale}: help translated`);
          assert.notEqual(texts.chosen, english.chosen, `${locale}: chosen translated`);
          assert.notEqual(texts.closed, english.closed, `${locale}: closed translated`);
          assert.notEqual(texts.back, english.back, `${locale}: back translated`);
          assert.notEqual(texts.button, english.button, `${locale}: button translated`);
          assert.notEqual(texts.note, english.note, `${locale}: note translated`);
          toasts.forEach((toast, index) => assert.notEqual(toast, english.toasts[index], `${locale}: toast ${index} translated`));
        }
      });
    }
  });
});
