/**
 * @description Prompts held during an armed usage-limit wait (Jira plan R23):
 * the queue's bound, what the resume forwards in place of the "continue" nudge,
 * and the bot's wiring — held on the armed record (persisted, restored, dropped
 * with the wait), delivered once at the resume, shared by the scheduler and Jira.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getHeldPromptsWith, getLimitResumeMessage, limitHeldPromptsMax } from '../utils/limitHeldPrompts';

describe('getHeldPromptsWith', () => {
  it('appends in order and drops the oldest past the bound', () => {
    assert.deepEqual(getHeldPromptsWith(['a'], 'b'), { held: ['a', 'b'], droppedCount: 0 });
    const full = Array.from({ length: limitHeldPromptsMax }, (_, index) => `p${index}`);
    assert.deepEqual(getHeldPromptsWith(full, 'newest'), { held: [...full.slice(1), 'newest'], droppedCount: 1 });
  });
});

describe('getLimitResumeMessage', () => {
  it('nothing held: the "continue" nudge, not a request prompt', () => {
    assert.deepEqual(getLimitResumeMessage({ heldPrompts: [], continueNudge: 'continue', openRequestPrompt: 'req' }), { text: 'continue', isRequestPrompt: false });
  });

  it('held prompts replace the nudge as one message; carrying the open request\'s prompt marks the turn as its (R21)', () => {
    assert.deepEqual(
      getLimitResumeMessage({ heldPrompts: ['[Scheduled run "x"]\nrun', 'req'], continueNudge: 'continue', openRequestPrompt: 'req' }),
      { text: '[Scheduled run "x"]\nrun\n\nreq', isRequestPrompt: true },
    );
    assert.equal(getLimitResumeMessage({ heldPrompts: ['other'], continueNudge: 'c', openRequestPrompt: 'req' }).isRequestPrompt, false);
    assert.equal(getLimitResumeMessage({ heldPrompts: ['other'], continueNudge: 'c', openRequestPrompt: undefined }).isRequestPrompt, false);
  });
});

describe('the bot holds and resumes them (R23)', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const getFunction = (header: string): string => {
    const start = botSource.indexOf(header);
    assert.ok(start >= 0, header);
    return botSource.slice(start, botSource.indexOf('\n}\n', start));
  };

  it('only an ARMED usage-limit wait holds, on its own persisted record', () => {
    const hold = getFunction('function holdPromptForLimitResume(');
    assert.match(hold, /const entry = getArmedApiRetry\(key\);\n\s*if \(entry\?\.kind !== 'usageLimit'\) return false;/);
    assert.match(hold, /state\s*\.setApiRetry\(key, \{ kind: entry\.kind, attempt: entry\.attempt, fireAt: entry\.fireAt, heldPrompts: held \}\)/);
  });

  it('the scheduler and the Jira connector post through the same hold', () => {
    assert.match(getFunction('function createSessionPostDeps('), /holdForLimitResume: \(conversationKey, text\) => holdPromptForLimitResume\(keyFromString\(conversationKey\), text\),/);
    assert.match(getFunction('function wireScheduler('), /\.\.\.createSessionPostDeps\(\),/);
  });

  it('the resume forwards the held prompts once, in place of the nudge; a boot restores them', () => {
    const fire = getFunction('async function fireApiRetryWithLocale(');
    const take = fire.indexOf('entry.heldPrompts = [];');
    const forward = fire.indexOf('await forwardPromptToAgent(key, getThreadAdapter(key), resume.text);');
    assert.ok(take > 0 && forward > take, 'taken before the forward, so a second fire cannot repeat them');
    assert.match(fire, /getLimitResumeMessage\(\{\n\s*heldPrompts,/);
    assert.match(fire, /isRequestPrompt: resume\.isRequestPrompt,/);
    assert.match(getFunction('function restoreApiRetries('), /heldPrompts: record\.heldPrompts \?\? \[\],/);
  });
});
