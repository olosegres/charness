/**
 * @description The worker roles (`utils/workerRoles.ts`): the built-in table, what a role resolves to under the operator's
 * setting, how a change is stored (only what differs from the built-in value) and the words an agent is told.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  builtInWorkerRoles,
  buildWorkerRoleReport,
  checkHasChangedWorkerRole,
  checkIsWorkerRoleId,
  describeWorkerLaunchFlags,
  describeWorkerRole,
  resolveWorkerRole,
  updateWorkerRolesSetting,
  workerRoleIds,
} from '../utils/workerRoles';

test('the built-in table: Opus for every role — builder medium, mini-review high, the rest xhigh', () => {
  assert.deepEqual(workerRoleIds, ['builder', 'storageBuilder', 'investigator', 'reviewer', 'miniReviewer', 'planner']);
  assert.deepEqual(Object.fromEntries(workerRoleIds.map((role) => [role, `${builtInWorkerRoles[role].cli} ${builtInWorkerRoles[role].model} ${builtInWorkerRoles[role].effort}`])), {
    builder: 'claude opus medium',
    storageBuilder: 'claude opus xhigh',
    investigator: 'claude opus xhigh',
    reviewer: 'claude opus xhigh',
    miniReviewer: 'claude opus high',
    planner: 'claude opus xhigh',
  });
  assert.equal(checkIsWorkerRoleId('reviewer'), true);
  assert.equal(checkIsWorkerRoleId('coder'), false);
});

test('a role resolves to the operator\'s value when it changed it, else the built-in one; a value equal to the built-in one counts as built-in', () => {
  assert.deepEqual(resolveWorkerRole({}, 'builder'), { value: builtInWorkerRoles.builder, isBuiltIn: true });
  const sonnet = { cli: 'claude', model: 'sonnet', effort: 'high' } as const;
  assert.deepEqual(resolveWorkerRole({ builder: sonnet }, 'builder'), { value: sonnet, isBuiltIn: false });
  assert.deepEqual(resolveWorkerRole({ builder: sonnet }, 'reviewer'), { value: builtInWorkerRoles.reviewer, isBuiltIn: true });
  assert.equal(resolveWorkerRole({ builder: { cli: 'claude', model: 'opus', effort: 'medium' } }, 'builder').isBuiltIn, true);
});

test('a change is stored only when it differs from the built-in value; null and the built-in value both take the role out', () => {
  const changed = updateWorkerRolesSetting({}, 'builder', { cli: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(changed, { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } });
  assert.equal(checkHasChangedWorkerRole(changed), true);
  assert.deepEqual(updateWorkerRolesSetting(changed, 'builder', { cli: 'claude', model: 'opus', effort: 'medium' }), {});
  assert.deepEqual(updateWorkerRolesSetting(changed, 'builder', null), {});
  assert.equal(checkHasChangedWorkerRole({}), false);
  assert.deepEqual(changed, { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } }, 'the input is not mutated');
});

test('the launch flags: claude -p --model --effort; opencode run --model provider/model [--variant]', () => {
  assert.equal(describeWorkerLaunchFlags({ cli: 'claude', model: 'sonnet', effort: 'high' }), 'claude -p --model sonnet --effort high');
  assert.equal(describeWorkerLaunchFlags({ cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' }), 'opencode run --model openai/gpt-6-astra --variant medium');
  assert.equal(describeWorkerLaunchFlags({ cli: 'opencode', model: 'openai/gpt-6-astra', effort: null }), 'opencode run --model openai/gpt-6-astra');
});

test('the role line: the launch and «the bot\'s default — your own instructions win»; a role that cannot run here points at the conversation\'s own CLI and model', () => {
  const builder = buildWorkerRoleReport({ builder: { cli: 'claude', model: 'sonnet', effort: 'high' } }, 'builder', null);
  assert.deepEqual(builder, { role: 'builder', cli: 'claude', model: 'sonnet', effort: 'high', isBuiltIn: false, unavailable: null });
  assert.equal(describeWorkerRole(builder), 'builder: claude -p --model sonnet --effort high — the bot\'s default for this role; a model the user or your general delegate skill names wins');
  const missing = buildWorkerRoleReport({ reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' } }, 'reviewer', 'openCodeModelMissing');
  assert.match(describeWorkerRole(missing), /^reviewer: the bot's default is opencode run --model openai\/gpt-6-astra --variant medium, but its OpenCode model is not in the catalog .* → launch it on the CLI, model and effort this conversation runs on$/);
  const noAccount = buildWorkerRoleReport({}, 'planner', 'noClaudeAccount');
  assert.equal(noAccount.isBuiltIn, true);
  assert.match(describeWorkerRole(noAccount), /but no Claude account is signed in on this host → launch it on the CLI, model and effort this conversation runs on$/);
});
