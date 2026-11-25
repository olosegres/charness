/**
 * @description The worker roles (`utils/workerRoles.ts`): the built-in table, what a role resolves to under the operator's
 * setting, how a change is stored (only what differs from the built-in value) and the words an agent is told.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  builtInWorkerRoles,
  buildWorkerRoleReport,
  buildWorkerRoleReportForQuery,
  checkHasChangedWorkerRole,
  checkIsWorkerRoleId,
  describeWorkerLaunchFlags,
  describeWorkerRole,
  describeWorkerRoleVerdict,
  getClaudeWorkerUnavailability,
  getOpenCodeWorkerUnavailability,
  getWorkerRolePickModel,
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

test('the role line: the launch and «the bot\'s default — your own instructions win»; a role that cannot run here points at the conversation\'s own CLI and model and, on Claude, at a second call for its account', () => {
  const builder = buildWorkerRoleReport({ builder: { cli: 'claude', model: 'sonnet', effort: 'high' } }, 'builder', null);
  assert.deepEqual(builder, { role: 'builder', cli: 'claude', model: 'sonnet', effort: 'high', isBuiltIn: false, unavailable: null });
  assert.equal(describeWorkerRole(builder), 'builder: claude -p --model sonnet --effort high — the bot\'s default for this role; a model the user or your general delegate skill names wins');
  const missing = buildWorkerRoleReport({ reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' } }, 'reviewer', 'openCodeModelMissing');
  assert.match(describeWorkerRole(missing), /^reviewer: the bot's default is opencode run --model openai\/gpt-6-astra --variant medium, but its OpenCode model is not in the catalog .* → launch it on the CLI, model and effort this conversation runs on — on Claude, call claude_profiles again with that model and take the account of that answer, not this one's$/);
  const noAccount = buildWorkerRoleReport({}, 'planner', 'noClaudeAccount');
  assert.equal(noAccount.isBuiltIn, true);
  assert.match(describeWorkerRole(noAccount), /but no Claude account is signed in on this host → launch it on the CLI, model and effort this conversation runs on — on Claude, call claude_profiles again with that model and take the account of that answer, not this one's$/);
});

test('the first line of a role answer: Claude → the account verdict follows; OpenCode → «no Claude account needed»; unavailable → the role line with its own account step, never this answer\'s account verdict (picked for another model)', () => {
  const claude = buildWorkerRoleReport({}, 'reviewer', null);
  assert.equal(describeWorkerRoleVerdict(claude, 'recommended: work → CLAUDE_CONFIG_DIR=/p/work (soonest weekly reset)'), 'reviewer: claude -p --model opus --effort xhigh — the bot\'s default for this role; a model the user or your general delegate skill names wins | account: recommended: work → CLAUDE_CONFIG_DIR=/p/work (soonest weekly reset)');
  const openCode = buildWorkerRoleReport({ reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: null } }, 'reviewer', null);
  assert.match(describeWorkerRoleVerdict(openCode, 'ignored'), /names wins; no Claude account needed$/);
  const unavailable = buildWorkerRoleReport({}, 'reviewer', 'noClaudeAccount');
  const unavailableLine = describeWorkerRoleVerdict(unavailable, 'recommended: work → CLAUDE_CONFIG_DIR=/p/work (soonest weekly reset)');
  assert.equal(unavailableLine, describeWorkerRole(unavailable));
  assert.match(unavailableLine, /— on Claude, call claude_profiles again with that model and take the account of that answer, not this one's$/);
  assert.doesNotMatch(unavailableLine, /recommended: work/, 'the account verdict of this answer is not offered for it');
});

test('a Claude role cannot run only when no account is signed in; an OpenCode role only when a READ catalog lacks its model', () => {
  assert.equal(getClaudeWorkerUnavailability([]), 'noClaudeAccount');
  assert.equal(getClaudeWorkerUnavailability([{ loggedIn: false }, { loggedIn: false }]), 'noClaudeAccount');
  assert.equal(getClaudeWorkerUnavailability([{ loggedIn: false }, { loggedIn: null }]), null, 'an account not probed yet may be signed in');
  assert.equal(getClaudeWorkerUnavailability([{ loggedIn: true }]), null);
  assert.equal(getOpenCodeWorkerUnavailability('openai/gpt-5', null), null, 'an unread catalog says nothing');
  assert.equal(getOpenCodeWorkerUnavailability('openai/gpt-5', []), null, 'an empty answer says nothing');
  assert.equal(getOpenCodeWorkerUnavailability('openai/gpt-5', ['openai/gpt-5', 'anthropic/x']), null);
  assert.equal(getOpenCodeWorkerUnavailability('openai/gpt-5', ['anthropic/x']), 'openCodeModelMissing');
});

test('a query by role: the account pick runs with a Claude role\'s own model (a Fable role counts the Fable window), with none for an OpenCode role, with the caller\'s model without a role', () => {
  const setting = { builder: { cli: 'claude', model: 'fable', effort: 'high' }, reviewer: { cli: 'opencode', model: 'openai/gpt-5', effort: null } } as const;
  assert.equal(getWorkerRolePickModel(setting, 'builder', null), 'fable');
  assert.equal(getWorkerRolePickModel(setting, 'planner', null), 'opus', 'a built-in role');
  assert.equal(getWorkerRolePickModel(setting, 'reviewer', null), null, 'an OpenCode role runs on no Claude account');
  assert.equal(getWorkerRolePickModel(setting, null, 'sonnet'), 'sonnet');
  assert.equal(getWorkerRolePickModel(setting, null, null), null);
});

test('a query by role: the worker report judges a Claude role by the accounts, an OpenCode role by a READ catalog (none read → never unavailable); no role → no report', () => {
  const setting = { reviewer: { cli: 'opencode', model: 'openai/gpt-5', effort: null } } as const;
  const signedIn = [{ loggedIn: true }];
  assert.equal(buildWorkerRoleReportForQuery(setting, null, signedIn, null), null);
  assert.equal(buildWorkerRoleReportForQuery(setting, 'builder', signedIn, null)?.unavailable, null);
  assert.equal(buildWorkerRoleReportForQuery(setting, 'builder', [{ loggedIn: false }], null)?.unavailable, 'noClaudeAccount');
  assert.equal(buildWorkerRoleReportForQuery(setting, 'reviewer', [], ['anthropic/x'])?.unavailable, 'openCodeModelMissing', 'no Claude account does not matter to an OpenCode role');
  assert.equal(buildWorkerRoleReportForQuery(setting, 'reviewer', [], null)?.unavailable, null);
  assert.deepEqual(buildWorkerRoleReportForQuery(setting, 'reviewer', [], ['openai/gpt-5']), { role: 'reviewer', cli: 'opencode', model: 'openai/gpt-5', effort: null, isBuiltIn: false, unavailable: null });
});
