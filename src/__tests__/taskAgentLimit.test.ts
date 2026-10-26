/**
 * @description The cap on tracker task agents as a setting (`trackers/taskAgentLimit.ts`): the order of its sources — General's
 * value, then `settings.json`, then the built-in default — and what a typed number may be.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsTaskAgentsMaxConcurrent,
  defaultTaskAgentsMaxConcurrent,
  parseTaskAgentLimitArgument,
  readTaskAgentLimit,
  taskAgentsMaxConcurrentUpperBound,
  taskAgentsNoLimit,
  taskAgentsPickerValues,
} from '../trackers/taskAgentLimit';

describe('readTaskAgentLimit: General → settings.json → the built-in default', () => {
  it('nothing set: the default, 5', () => {
    assert.equal(defaultTaskAgentsMaxConcurrent, 5);
    assert.deepEqual(readTaskAgentLimit({ getGeneralValue: () => undefined, getSettingsValue: () => null }), { maxConcurrent: 5, source: 'builtInDefault' });
  });

  it('settings.json seeds an instance whose General never chose', () => {
    assert.deepEqual(readTaskAgentLimit({ getGeneralValue: () => undefined, getSettingsValue: () => 3 }), { maxConcurrent: 3, source: 'settingsFile' });
  });

  it('General\'s value beats the file once set — also «no limit» (0), which is a choice and not «never chose»', () => {
    assert.deepEqual(readTaskAgentLimit({ getGeneralValue: () => 12, getSettingsValue: () => 3 }), { maxConcurrent: 12, source: 'general' });
    assert.deepEqual(readTaskAgentLimit({ getGeneralValue: () => taskAgentsNoLimit, getSettingsValue: () => 3 }), { maxConcurrent: 0, source: 'general' });
  });

  it('the file\'s own 0 is «no limit» too, and beats the default', () => {
    assert.deepEqual(readTaskAgentLimit({ getGeneralValue: () => undefined, getSettingsValue: () => 0 }), { maxConcurrent: 0, source: 'settingsFile' });
  });

  it('the file is read only when General never chose', () => {
    let fileReads = 0;
    readTaskAgentLimit({ getGeneralValue: () => 7, getSettingsValue: () => { fileReads += 1; return 1; } });
    assert.equal(fileReads, 0);
  });
});

describe('what a number may be', () => {
  it('a whole number from 0 up to the bound', () => {
    for (const value of [0, 1, 12, taskAgentsMaxConcurrentUpperBound]) assert.equal(checkIsTaskAgentsMaxConcurrent(value), true, `${value}`);
    for (const value of [-1, 1.5, taskAgentsMaxConcurrentUpperBound + 1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(checkIsTaskAgentsMaxConcurrent(value), false, `${value}`);
  });

  it('every picker number is valid, in order, and none is the default twice', () => {
    assert.deepEqual([...taskAgentsPickerValues], [5, 10, 15, 20, 30]);
    assert.ok(taskAgentsPickerValues.every(checkIsTaskAgentsMaxConcurrent));
    assert.ok(taskAgentsPickerValues.includes(defaultTaskAgentsMaxConcurrent), 'the default is one of the picker\'s numbers');
  });
});

describe('parseTaskAgentLimitArgument', () => {
  it('nothing typed opens the screen', () => {
    assert.deepEqual(parseTaskAgentLimitArgument(''), { kind: 'none' });
    assert.deepEqual(parseTaskAgentLimitArgument('   '), { kind: 'none' });
  });

  it('digits in range are a number; surrounding blanks and case do not matter', () => {
    assert.deepEqual(parseTaskAgentLimitArgument('12'), { kind: 'number', value: 12 });
    assert.deepEqual(parseTaskAgentLimitArgument(' 7 '), { kind: 'number', value: 7 });
    assert.deepEqual(parseTaskAgentLimitArgument(`${taskAgentsMaxConcurrentUpperBound}`), { kind: 'number', value: taskAgentsMaxConcurrentUpperBound });
  });

  it('0 and «off» mean no limit', () => {
    assert.deepEqual(parseTaskAgentLimitArgument('0'), { kind: 'number', value: 0 });
    assert.deepEqual(parseTaskAgentLimitArgument('off'), { kind: 'number', value: 0 });
    assert.deepEqual(parseTaskAgentLimitArgument('OFF'), { kind: 'number', value: 0 });
  });

  it('anything else is invalid: over the bound, signed, decimal, spelled out, two words', () => {
    for (const text of [`${taskAgentsMaxConcurrentUpperBound + 1}`, '-3', '+3', '2.5', '1e2', 'twelve', 'on', '5 10', '0x10']) {
      assert.deepEqual(parseTaskAgentLimitArgument(text), { kind: 'invalid' }, text);
    }
  });
});
