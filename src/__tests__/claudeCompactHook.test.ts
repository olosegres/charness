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
  buildClaudeCompactHookSettings,
  buildPreCompactHookCommand,
  claudeCompactHookSettingsFileName,
  getHookCompactionInstruction,
  prepareClaudeCompactHookFlags,
} from '../utils/claudeCompactHook';
import {
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
  alreadySentMarker: compactionSkillsGuidance,
});

test('getHookCompactionInstruction: D3 then the skills guidance, no closing section', () => {
  assert.equal(
    getHookCompactionInstruction(),
    `${compactionSummaryGuidance}\n\n${compactionSkillsGuidance}`,
  );
});

test('PreCompact hook: an overflow compaction gets the instruction', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
});

test('PreCompact hook: a manual /compact with its own focus still gets the instruction', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: 'focus on the test failures',
  });
  assert.equal(output, `${getHookCompactionInstruction()}\n`);
});

test('PreCompact hook: prints nothing when the bot-issued instruction already carries it', () => {
  const output = runHook(hookCommand, {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    custom_instructions: `${compactionSummaryGuidance}\n\n${compactionSkillsGuidance}\n\nCLOSING`,
  });
  assert.equal(output, '');
});

test('compactionSkillsGuidance: JSON leaves it unescaped, so the hook can match it in raw stdin', () => {
  assert.equal(JSON.stringify(compactionSkillsGuidance), `"${compactionSkillsGuidance}"`);
  assert.match(compactionSkillsGuidance, /^[\x20-\x7e]+$/);
});

test('buildClaudeCompactHookSettings: one PreCompact command hook with no matcher', () => {
  assert.deepEqual(buildClaudeCompactHookSettings('echo hi'), {
    hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
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
