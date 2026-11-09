/**
 * @description Coverage for the `PreCompact` hook the bot passes to every Claude
 * session: the hook command is run through a real `sh`, the way Claude Code runs
 * it, with the JSON a compaction feeds it on stdin — so the "print unless the
 * bot already sent it" rule is checked end to end, not by string inspection.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildClaudeLaunchHookSettings,
  buildPreCompactHookCommand,
  claudeCompactHookSettingsFileName,
  getHookCompactionInstruction,
  prepareClaudeCompactHookFlags,
} from '../utils/claudeCompactHook';
import {
  buildCompactionInstruction,
  compactionChecklistGuidance,
  compactionGapsGuidance,
  compactionResumeGuidance,
  compactionResumeGuidanceWithoutGaps,
  compactionSkillsGuidance,
  compactionSummaryGuidance,
} from '../utils/compactOnIdle';
import { getClaudeCompactMistakesOffDir } from '../utils/compactMistakesFlags';
import { resolveDataDir } from '../state';

function runHook(command: string, hookInput: unknown): string {
  return execFileSync('sh', ['-c', command], {
    input: JSON.stringify(hookInput),
    encoding: 'utf-8',
  });
}

/** The flag folder of the hook under test: nothing in it unless a test puts a flag there. */
const offFlagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-flags-'));
process.on('exit', () => fs.rmSync(offFlagDir, { recursive: true, force: true }));

const hookCommand = buildPreCompactHookCommand({
  instruction: getHookCompactionInstruction(true),
  instructionWithoutGaps: getHookCompactionInstruction(false),
  alreadySentMarker: compactionResumeGuidanceWithoutGaps,
  offFlagDir,
});

test('getHookCompactionInstruction: D3 then the resume guidance, no closing section — the checklist ends the summary', () => {
  assert.equal(
    getHookCompactionInstruction(true),
    `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}`,
  );
  assert.ok(getHookCompactionInstruction(true).endsWith(compactionChecklistGuidance));
});

test('getHookCompactionInstruction: with the agent-mistakes section off it is D3 and the skills + checklist, no section request', () => {
  assert.equal(
    getHookCompactionInstruction(false),
    `${compactionSummaryGuidance}\n\n${compactionResumeGuidanceWithoutGaps}`,
  );
  assert.ok(!getHookCompactionInstruction(false).includes(compactionGapsGuidance));
  assert.ok(getHookCompactionInstruction(false).endsWith(compactionChecklistGuidance));
});

test('PreCompact hook: an overflow compaction gets the instruction', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
  });
  assert.equal(output, `${getHookCompactionInstruction(true)}\n`);
  assert.ok(output.trimEnd().endsWith(compactionChecklistGuidance), 'the hook asks for the checklist that ends the summary');
});

test('PreCompact hook: a manual /compact with its own focus still gets the instruction, checklist included', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: 'focus on the test failures',
  });
  assert.equal(output, `${getHookCompactionInstruction(true)}\n`);
  assert.ok(output.trimEnd().endsWith(compactionChecklistGuidance), 'the owner\'s own focus does not drop the checklist');
});

test('PreCompact hook: an instruction that carries only the skills sentence still gets the checklist', () => {
  // The marker is the skills sentence AND the checklist, not the skills sentence alone: a compaction whose instruction
  // names the skills but asks for no checklist must not be taken for one that already has everything.
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: compactionSkillsGuidance,
  });
  assert.equal(output, `${getHookCompactionInstruction(true)}\n`);
});

test('PreCompact hook: an overflow compaction is asked for the agent-mistakes section, ahead of the checklist that ends the summary', () => {
  const output = runHook(hookCommand, { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
  assert.ok(output.includes(compactionGapsGuidance), 'the hook asks for the section the bot posts even when the summary is hidden');
  assert.ok(output.indexOf(compactionGapsGuidance) < output.indexOf(compactionChecklistGuidance), 'the checklist is still the last part');
});

test('PreCompact hook: a process started BEFORE the agent-mistakes section keeps its old hook, which still skips a bot-issued instruction', () => {
  // A json-stream process is adopted across a hot deploy and keeps the hook command it was started with — its marker is the
  // OLD resume guidance (skills + checklist). The new text carries that as a contiguous substring, so the old hook finds it
  // and prints nothing; otherwise the model would read the skills and the checklist instructions twice.
  const oldHookCommand = buildPreCompactHookCommand({
    instruction: 'the instruction the old hook would print',
    instructionWithoutGaps: 'the instruction the old hook would print',
    alreadySentMarker: `${compactionSkillsGuidance} ${compactionChecklistGuidance}`,
    offFlagDir,
  });
  const botIssuedInstruction = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: compactionResumeGuidance,
    closingSectionInstruction: 'CLOSING',
  });
  assert.ok(botIssuedInstruction);
  for (const trigger of ['manual', 'auto']) {
    assert.equal(runHook(oldHookCommand, { hook_event_name: 'PreCompact', trigger, custom_instructions: botIssuedInstruction }), '', `trigger ${trigger}`);
  }
});

test('PreCompact hook: a bot-issued instruction WITHOUT the agent-mistakes section (`/compact_mistakes` off) is left alone — the skills and the checklist are not asked for twice', () => {
  // The marker is what both variants of the bot's instruction share: the skills sentence and the checklist. Matching the
  // section as well would make the hook add the whole text on top of the bot's own while the section is off.
  for (const trigger of ['manual', 'auto']) {
    const output = runHook(hookCommand, {
      hook_event_name: 'PreCompact',
      trigger,
      custom_instructions: `${compactionSummaryGuidance}\n\n${compactionResumeGuidanceWithoutGaps}\n\nCLOSING`,
    });
    assert.equal(output, '', `trigger ${trigger}`);
  }
});

function writeOffFlag(sessionId: string): void {
  fs.mkdirSync(offFlagDir, { recursive: true });
  fs.writeFileSync(path.join(offFlagDir, sessionId), '');
}

test('PreCompact hook: the flag of the compacting session (`/compact_mistakes` off) drops the agent-mistakes request — and only that session\'s', () => {
  writeOffFlag('11111111-2222-3333-4444-555555555555');
  const withFlag = runHook(hookCommand, { session_id: '11111111-2222-3333-4444-555555555555', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
  assert.equal(withFlag, `${getHookCompactionInstruction(false)}\n`);
  assert.ok(!withFlag.includes(compactionGapsGuidance), 'no section request');
  assert.ok(withFlag.trimEnd().endsWith(compactionChecklistGuidance), 'the skills and the checklist stay');

  const otherSession = runHook(hookCommand, { session_id: 'aaaaaaaa-2222-3333-4444-555555555555', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
  assert.equal(otherSession, `${getHookCompactionInstruction(true)}\n`, 'a session without a flag is still asked');
  const noSessionId = runHook(hookCommand, { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
  assert.equal(noSessionId, `${getHookCompactionInstruction(true)}\n`, 'input without a session id is asked, as before the switch');
});

test('PreCompact hook: the session id is read from pretty-printed JSON too, and a flag never beats an instruction the bot already sent', () => {
  writeOffFlag('prettySession');
  const prettyInput = `{\n  "hook_event_name": "PreCompact",\n  "session_id": "prettySession",\n  "trigger": "auto"\n}`;
  assert.equal(execFileSync('sh', ['-c', hookCommand], { input: prettyInput, encoding: 'utf-8' }), `${getHookCompactionInstruction(false)}\n`);
  assert.equal(
    runHook(hookCommand, { session_id: 'prettySession', trigger: 'manual', custom_instructions: `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}` }),
    '',
    'the bot-issued instruction wins: nothing is printed whatever the flag says',
  );
});

test('PreCompact hook: a session id that is not a plain id never leaves the flag folder', () => {
  // A decoy ONE LEVEL UP from the flag folder: were `../decoy` joined into the path, the flag would "exist".
  const decoyName = 'compact-hook-decoy';
  fs.writeFileSync(path.join(path.dirname(offFlagDir), decoyName), '');
  try {
    for (const hostileId of [`../${decoyName}`, `a/../../${decoyName}`, '', ' ', 'bad id', '$(touch /tmp/never)']) {
      const output = runHook(hookCommand, { session_id: hostileId, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
      assert.equal(output, `${getHookCompactionInstruction(true)}\n`, `session id ${JSON.stringify(hostileId)}`);
    }
  } finally {
    fs.rmSync(path.join(path.dirname(offFlagDir), decoyName), { force: true });
  }
});

test('PreCompact hook: prints nothing when the bot-issued instruction already carries it', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}\n\nCLOSING`,
  });
  assert.equal(output, '');
});

test('the resume guidance, with the section and without: JSON leaves each unescaped, so the hook can match the shared part in raw stdin', () => {
  for (const guidance of [compactionResumeGuidance, compactionResumeGuidanceWithoutGaps]) {
    assert.equal(JSON.stringify(guidance), `"${guidance}"`);
    assert.match(guidance, /^[\x20-\x7e]+$/);
  }
  assert.ok(compactionResumeGuidance.endsWith(compactionResumeGuidanceWithoutGaps), 'the marker is a contiguous part of the full text');
});

test('buildClaudeLaunchHookSettings: one PreCompact and one PostToolUse command hook, neither with a matcher', () => {
  assert.deepEqual(buildClaudeLaunchHookSettings({ preCompact: 'echo hi', postToolUse: 'echo tool' }), {
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'echo tool' }] }],
    },
  });
});

test('prepareClaudeCompactHookFlags: writes the settings file and returns the --settings pair', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-'));
  try {
    const flags = prepareClaudeCompactHookFlags(dataDir);
    const settingsPath = path.join(dataDir, claudeCompactHookSettingsFileName);
    assert.deepEqual(flags, ['--settings', settingsPath]);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const command = settings.hooks.PreCompact[0].hooks[0].command;
    assert.equal(
      runHook(command, { trigger: 'auto', custom_instructions: null }),
      `${getHookCompactionInstruction(true)}\n`,
    );
    assert.deepEqual(
      fs.readdirSync(dataDir),
      [claudeCompactHookSettingsFileName],
      'no temp file is left behind',
    );
    // The command reads the flags from the folder under DATA_DIR the bot keeps them in.
    const flagDir = getClaudeCompactMistakesOffDir(dataDir);
    fs.mkdirSync(flagDir, { recursive: true });
    fs.writeFileSync(path.join(flagDir, 'sessionUnderTest'), '');
    assert.equal(
      runHook(command, { session_id: 'sessionUnderTest', trigger: 'auto', custom_instructions: null }),
      `${getHookCompactionInstruction(false)}\n`,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('prepareClaudeCompactHookFlags with a relative DATA_DIR: the settings path and the flag folder the hook reads are absolute, so the hook finds the flag from the agent\'s own folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-relative-'));
  const botFolder = path.join(root, 'bot');
  const agentFolder = path.join(root, 'project');
  fs.mkdirSync(botFolder);
  fs.mkdirSync(agentFolder);
  const originalCwd = process.cwd();
  const originalDataDir = process.env.DATA_DIR;
  try {
    process.chdir(botFolder);
    process.env.DATA_DIR = 'data';
    const flags = prepareClaudeCompactHookFlags(resolveDataDir());
    assert.ok(path.isAbsolute(flags[1]), `the --settings path is absolute: ${flags[1]}`);
    const command: string = JSON.parse(fs.readFileSync(flags[1], 'utf-8')).hooks.PreCompact[0].hooks[0].command;
    const flagDir = getClaudeCompactMistakesOffDir(resolveDataDir());
    fs.mkdirSync(flagDir, { recursive: true });
    fs.writeFileSync(path.join(flagDir, 'sessionRelative'), '');

    // The hook runs in the agent's project folder, not the bot's.
    const output = execFileSync('sh', ['-c', command], {
      cwd: agentFolder,
      input: JSON.stringify({ session_id: 'sessionRelative', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }),
      encoding: 'utf-8',
    });
    assert.equal(output, `${getHookCompactionInstruction(false)}\n`, 'the flag of the session is found from the agent\'s folder');
  } finally {
    process.chdir(originalCwd);
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareClaudeCompactHookFlags: an unwritable DATA_DIR yields no flags instead of throwing', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-')), 'file');
  fs.writeFileSync(blocker, '');
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(prepareClaudeCompactHookFlags(path.join(blocker, 'data')), []);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  }
});
