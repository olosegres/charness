/**
 * @description The closed set of buttons a talker may tap, and how a person is labelled in a topic message.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsTalkerCallback } from '../utils/talkerAccess';
import { formatPersonLabel } from '../utils/personLabel';

test('a talker may tap the agent\'s own question buttons — a question and the same question asked again', () => {
  for (const data of ['qa_0_0', 'qa_2_11', 'reask_0', 'reask_7']) assert.equal(checkIsTalkerCallback(data), true, data);
});

test('`opt_<n>` — a Claude TUI selector\'s button, which no code builds any more and whose handler types a digit into whatever the TUI shows — is the admins\' alone', () => {
  for (const data of ['opt_1', 'opt_12']) assert.equal(checkIsTalkerCallback(data), false, data);
});

test('every other button is the admins\': pickers, wizards, settings and the unknown — and a near miss is not a match', () => {
  const adminButtons = ['bind_docs', 'bind_page_2', 'lang_ru', 'agent_claude', 'resume_3', 'mdlp_1_0', 'fbk_x', 'coi_on', 'csum_off', 'skip_retry_5', 'tlk_a_3', 'acl_skip_1'];
  for (const data of adminButtons) assert.equal(checkIsTalkerCallback(data), false, data);
  for (const data of ['qa_0', 'qa_a_b', 'qa_0_0_0', 'xqa_0_0', 'reask_', 'reask_1x', '']) assert.equal(checkIsTalkerCallback(data), false, JSON.stringify(data));
  assert.equal(checkIsTalkerCallback(undefined), false, 'a tap with no data (a game or a url button) is never a talker\'s');
});

test('formatPersonLabel: the @username with the name, the name alone, or the @username alone', () => {
  assert.equal(formatPersonLabel({ username: 'alice', name: 'Alice Smith' }), '@alice (Alice Smith)');
  assert.equal(formatPersonLabel({ name: 'Bob Stone' }), 'Bob Stone');
  assert.equal(formatPersonLabel({ username: 'carol', name: '  ' }), '@carol');
});
