/**
 * @description The Claude skills restore's `SessionStart` hook (`hooks/claudeSkillsRestoreHook.ts`): what each slot prints
 * for a compaction of a transcript shaped like Claude Code 2.1.322's, and that it prints NOTHING and exits 0 on any doubt —
 * input that is not a compaction's, a sub-agent's, a transcript that is gone, a command line it does not know.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getSkillsRestoreHookOutput } from '../hooks/claudeSkillsRestoreHook';
import { claudeSkillBaseDirPrefix, skillsRestorePartMaxChars } from '../utils/skillsRestore';
import { skillsRestoreHeader } from '../utils/compactOnIdle';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-restore-hook-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const hookEntryPath = path.join(__dirname, '..', 'hooks', 'claudeSkillsRestoreHook.ts');

/** A project with skills on disk, and a transcript that loaded them with the Skill tool (as the CLI records it). */
function createSession(skills: Record<string, string>): { transcriptPath: string; skillDir: (name: string) => string } {
  const sessionDir = fs.mkdtempSync(path.join(root, 'session-'));
  const skillDir = (name: string): string => path.join(sessionDir, '.claude', 'skills', name);
  const lines: string[] = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'an old epoch' } }), JSON.stringify({ type: 'system', subtype: 'compact_boundary' })];
  for (const [index, [name, body]] of Object.entries(skills).entries()) {
    fs.mkdirSync(skillDir(name), { recursive: true });
    fs.writeFileSync(path.join(skillDir(name), 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}`);
    const toolUseId = `toolu_${index}`;
    lines.push(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Skill', input: { skill: name } }] } }),
      JSON.stringify({ type: 'user', isMeta: true, sourceToolUseID: toolUseId, message: { role: 'user', content: [{ type: 'text', text: `${claudeSkillBaseDirPrefix}${skillDir(name)}\n\n${body}` }] } }),
    );
  }
  const transcriptPath = path.join(sessionDir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  return { transcriptPath, skillDir };
}

function buildInput(transcriptPath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 's-1', transcript_path: transcriptPath, cwd: root, hook_event_name: 'SessionStart', source: 'compact', ...extra });
}

function readContext(output: string | null): string {
  assert.ok(output !== null, 'the slot prints');
  const parsed: { hookSpecificOutput: { hookEventName: string; additionalContext: string } } = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  return parsed.hookSpecificOutput.additionalContext;
}

/** Longer than Claude's own re-attach keeps whole (20,000 characters): the bot must give it back. */
const bigBody = Array.from({ length: 800 }, (_value, index) => `Rule ${index}: a rule of the big skill.`).join('\n');

test('a compaction: slot 1 prints the header and the list; a skill Claude cuts comes back WHOLE over the next slots; one past the parts prints nothing', () => {
  const { transcriptPath, skillDir } = createSession({ small: '# small\n', big: bigBody });
  const outputs = Array.from({ length: 24 }, (_value, index) => getSkillsRestoreHookOutput(buildInput(transcriptPath), { slot: index + 1, slotCount: 24, unavailableSkillsDir: null }));
  const printed = outputs.filter((output): output is string => output !== null).map(readContext);
  assert.ok(printed.length > 1 && printed.length < 24, `the restore takes a few parts: ${printed.length}`);
  assert.ok(outputs.slice(printed.length).every((output) => output === null), 'every slot past the last part prints nothing');
  assert.ok(printed.every((part) => part.startsWith(skillsRestoreHeader) && part.length <= skillsRestorePartMaxChars));
  const list = printed[0];
  assert.ok(list.includes(`- big: its current full text is below (base directory: ${skillDir('big')})`));
  assert.ok(list.includes(`- small: its full text is already in your context (base directory: ${skillDir('small')})`), 'Claude re-attaches the small one whole');
  const joined = printed.join('\n');
  for (const rule of ['Rule 0: a rule of the big skill.', 'Rule 799: a rule of the big skill.']) assert.ok(joined.includes(rule), rule);
  assert.ok(!joined.includes('## Skill: small'), 'the small one is only named');
});

test('the bot\'s skills of a process started without them are not available now', () => {
  const { transcriptPath, skillDir } = createSession({ 'charness-orchestration': '# orchestration\n' });
  const context = readContext(getSkillsRestoreHookOutput(buildInput(transcriptPath), { slot: 1, slotCount: 24, unavailableSkillsDir: path.dirname(skillDir('x')) }));
  assert.ok(context.includes('- charness-orchestration: was loaded before but is not available now'));
});

test('NOTHING on any doubt: not a compaction, a sub-agent, no transcript, not JSON, no skill loaded', () => {
  const { transcriptPath } = createSession({ big: bigBody });
  const slot = { slot: 1, slotCount: 24, unavailableSkillsDir: null };
  assert.equal(getSkillsRestoreHookOutput(buildInput(transcriptPath, { source: 'startup' }), slot), null);
  assert.equal(getSkillsRestoreHookOutput(buildInput(transcriptPath, { source: 'resume' }), slot), null);
  assert.equal(getSkillsRestoreHookOutput(buildInput(transcriptPath, { agent_id: 'agent-1' }), slot), null);
  assert.equal(getSkillsRestoreHookOutput(buildInput(path.join(root, 'missing.jsonl')), slot), null);
  assert.equal(getSkillsRestoreHookOutput('not json', slot), null);
  assert.equal(getSkillsRestoreHookOutput(buildInput(createSession({}).transcriptPath), slot), null, 'no skill → nothing at all');
});

test('the hook process: prints its part as hook JSON, and nothing with exit 0 on a bad command line or bad input', () => {
  const { transcriptPath } = createSession({ big: bigBody });
  const run = (args: readonly string[], input: string): { status: number | null; stdout: string } => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', hookEntryPath, ...args], { input, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout };
  };
  const printed = run(['1', '24'], buildInput(transcriptPath));
  assert.equal(printed.status, 0);
  assert.ok(readContext(printed.stdout).startsWith(skillsRestoreHeader));
  for (const [args, input] of [[['1', '24'], 'garbage'], [['0', '24'], buildInput(transcriptPath)], [['25', '24'], buildInput(transcriptPath)], [[], buildInput(transcriptPath)]] as const) {
    assert.deepEqual(run(args, input), { status: 0, stdout: '' }, `args ${JSON.stringify(args)}`);
  }
});
