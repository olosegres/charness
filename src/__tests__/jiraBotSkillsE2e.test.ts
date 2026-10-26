/**
 * @description The «Bot skills» switch on an instance without General, at PROCESS level: the BUILT charness serving Jira
 * only, whose `settings.json` seeds `botSkills`, against the fake Jira and the fake `claude`
 * (`jiraE2e/jiraFlowKit.ts`). A Jira conversation has no choice of its own — it follows the instance value. One flow, in
 * order:
 *
 *   isolation checked before the boot; the seed `"botSkills": "off"` written; the boot
 *   → a conversation started with the seed off launches without `--plugin-dir` (the Jira flags unchanged), and the
 *     instructions its bot MCP gave it carry no hint to load `charness-manager` — nor the orchestration bullet that held it
 *   → the seed turned on by hand: the NEXT conversation launches with `--plugin-dir` and gets the hint, no running
 *     process is restarted by the change, and the first conversation, stopped at its idle mark and resumed, now loads them
 *   → the seed back to off: the next conversation is without again; a file the bot cannot read means ON (the built-in default)
 *     and one named log error
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { checkHasFlag, fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, requiredJiraSessionFlags } from './jiraE2e/fakeClaudeContract';
import { builtAgentPluginDir, isolatedBaselineSettings, isolatedSettingsFileName } from './e2e/isolatedCharness';
import { readBotMcpInstructions } from './e2e/botMcpInstructions';
import {
  bootJiraOnly,
  checkIsProcessAlive,
  createIssue,
  getCharness,
  getLayout,
  getSessionLaunchOf,
  getTurns,
  handOverAndAwaitAnswer,
  idleStopTimeoutMs,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  readFakeLog,
  registerJiraFlowHooks,
  waitFor,
} from './jiraE2e/jiraFlowKit';

/** The hint of the manager skill, and the bullet that carries it on a tracker. */
const managerSkillHint = '`charness-manager`';
const orchestrationBullet = 'You orchestrate detached workers';

function getSettingsFilePath(): string {
  return path.join(path.dirname(getLayout().envFile), isolatedSettingsFileName);
}

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp moves. */
function writeSettingsFileByHand(settings: object | string): void {
  const tempPath = `${getSettingsFilePath()}.by-hand`;
  fs.writeFileSync(tempPath, typeof settings === 'string' ? settings : `${JSON.stringify(settings)}\n`);
  fs.renameSync(tempPath, getSettingsFilePath());
}

function countSessionLaunches(): number {
  return readFakeLog<{ isSessionLaunch: boolean }>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch).length;
}

/** How the process that answered `issueKey`'s latest hand-over was launched, and what its bot MCP tells it. */
async function readLatestLaunch(issueKey: string): Promise<{ argv: string[]; instructions: string }> {
  const turn = getTurns(issueKey).at(-1);
  assert.ok(turn, `${issueKey}: answered`);
  const launch = getSessionLaunchOf(turn.pid);
  assert.ok(launch, `${issueKey}: a launch recorded for the process that answered`);
  for (const flag of requiredJiraSessionFlags) assert.ok(checkHasFlag(launch.argv, flag), `${issueKey}: ${flag.join(' ')} in ${launch.argv.join(' ')}`);
  return { argv: launch.argv, instructions: await readBotMcpInstructions(launch.argv) };
}

/** Start a conversation on a new issue, wait for its answer and read its launch. */
async function startConversation(issueKey: string): Promise<{ argv: string[]; instructions: string }> {
  createIssue(issueKey, 'answer');
  await handOverAndAwaitAnswer(issueKey);
  return readLatestLaunch(issueKey);
}

describe('The bot-skills switch on a Jira-only instance: built charness, fake Jira, fake claude', () => {
  registerJiraFlowHooks({ layoutPrefix: 'charness-j-skills-', config: { adapter: 'claude-json-stream' } });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only with settings.json seeding botSkills OFF', async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, botSkills: 'off' });
    await bootJiraOnly();
  });

  it('a conversation started with the seed off launches without --plugin-dir, and its MCP instructions carry no manager hint nor orchestration bullet', async () => {
    const { argv, instructions } = await startConversation('PROJ-31');
    assert.deepEqual(getFlagValues(argv, '--plugin-dir'), [], `no skills folder in ${argv.join(' ')}`);
    assert.ok(!instructions.includes(managerSkillHint), instructions);
    assert.ok(!instructions.includes(orchestrationBullet), instructions);
    assert.match(instructions, /answer_request/, 'the rest of the instructions is there');
  });

  it('the seed turned on by hand applies to the NEXT conversation with no restart and restarts no running process — it launches with the skills and gets the hint', async () => {
    const pollLine = '[jira] polling PROJ every';
    const bootsBefore = getCharness().output.split(pollLine).length;
    const launchesBefore = countSessionLaunches();
    writeSettingsFileByHand({ ...isolatedBaselineSettings, botSkills: 'on' });
    const { argv, instructions } = await startConversation('PROJ-32');
    assert.deepEqual(getFlagValues(argv, '--plugin-dir'), [builtAgentPluginDir]);
    assert.ok(instructions.includes(managerSkillHint), instructions);
    assert.ok(instructions.includes(orchestrationBullet), instructions);
    assert.equal(getCharness().output.split(pollLine).length, bootsBefore, 'the bot was not restarted');
    assert.equal(countSessionLaunches(), launchesBefore + 1, 'the new conversation is the only launch: the running one was not restarted for the change');
  });

  it('the first conversation, stopped at its idle mark and resumed, now loads the skills — a resume reads the switch', async () => {
    const [firstTurn] = getTurns('PROJ-31');
    await waitFor('PROJ-31\'s process stopped at the idle mark', idleStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    await handOverAndAwaitAnswer('PROJ-31');
    const { argv, instructions } = await readLatestLaunch('PROJ-31');
    assert.deepEqual(getFlagValues(argv, '--resume'), [getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? [])], 'the same conversation, resumed');
    assert.deepEqual(getFlagValues(argv, '--plugin-dir'), [builtAgentPluginDir]);
    assert.ok(instructions.includes(managerSkillHint), instructions);
  });

  it('the seed back to off: the next conversation is without the skills again', async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, botSkills: 'off' });
    const { argv, instructions } = await startConversation('PROJ-33');
    assert.deepEqual(getFlagValues(argv, '--plugin-dir'), []);
    assert.ok(!instructions.includes(managerSkillHint));
  });

  it('a broken seed is ONE named log error and the built-in ON applies', async () => {
    const reportMarker = '[Settings] settings.json botSkills';
    const reportsBefore = getCharness().output.split(reportMarker).length - 1;
    writeSettingsFileByHand('{ "botSkills": "maybe" }\n');
    const { argv, instructions } = await startConversation('PROJ-34');
    assert.deepEqual(getFlagValues(argv, '--plugin-dir'), [builtAgentPluginDir]);
    assert.ok(instructions.includes(managerSkillHint));
    assert.equal(getCharness().output.split(reportMarker).length - 1, reportsBefore + 1, 'one named error for the broken file, not one per read');
  });

  itHoldsTheInstanceInvariants();
});
