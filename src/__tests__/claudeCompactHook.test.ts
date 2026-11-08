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
  compactionSkillsGuidance,
  compactionSummaryGuidance,
} from '../utils/compactOnIdle';

function runHook(command: string, hookInput: unknown): string {
  return execFileSync('sh', ['-c', command], {
    input: JSON.stringify(hookInput),
    encoding: 'utf-8',
  });
}

const hookCommand = buildPreCompactHookCommand({
  instruction: getHookCompactionInstruction(),
  alreadySentMarker: compactionResumeGuidance,
});

test('getHookCompactionInstruction: D3 then the resume guidance, no closing section — the checklist ends the summary', () => {
  assert.equal(
    getHookCompactionInstruction(),
    `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}`,
  );
  assert.ok(getHookCompactionInstruction().endsWith(compactionChecklistGuidance));
});

test('PreCompact hook: an overflow compaction gets the instruction', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
  assert.ok(output.trimEnd().endsWith(compactionChecklistGuidance), 'the hook asks for the checklist that ends the summary');
});

test('PreCompact hook: a manual /compact with its own focus still gets the instruction, checklist included', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: 'focus on the test failures',
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
  assert.ok(output.trimEnd().endsWith(compactionChecklistGuidance), 'the owner\'s own focus does not drop the checklist');
});

test('PreCompact hook: an instruction that carries only the skills sentence still gets the checklist', () => {
  // The marker is the whole resume guidance, not the skills sentence alone: a compaction whose instruction names
  // the skills but asks for no checklist must not be taken for one that already has everything.
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: compactionSkillsGuidance,
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
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
    alreadySentMarker: `${compactionSkillsGuidance} ${compactionChecklistGuidance}`,
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

test('PreCompact hook: an instruction from before the agent-mistakes section (skills + checklist only) still gets the whole text', () => {
  // The marker is the whole current resume guidance: a compaction carrying the older text lacks the section.
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: `${compactionSkillsGuidance} ${compactionChecklistGuidance}`,
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
});

test('PreCompact hook: prints nothing when the bot-issued instruction already carries it', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}\n\nCLOSING`,
  });
  assert.equal(output, '');
});

test('compactionResumeGuidance: JSON leaves it unescaped, so the hook can match it in raw stdin', () => {
  assert.equal(JSON.stringify(compactionResumeGuidance), `"${compactionResumeGuidance}"`);
  assert.match(compactionResumeGuidance, /^[\x20-\x7e]+$/);
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
      `${getHookCompactionInstruction()}\n`,
    );
    assert.deepEqual(
      fs.readdirSync(dataDir),
      [claudeCompactHookSettingsFileName],
      'no temp file is left behind',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
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
