/**
 * @description `checkIsInstalled` / `getToolCommand` look where the spawns look: a tool `installTool` left in
 * `~/.npm-global/bin` (the directory the OpenCode server spawn puts first on PATH) is installed, even when the
 * process PATH does not name that directory. Checking PATH alone read that copy as missing, so every attempt to
 * bring the OpenCode server up re-ran `npm install -g`.
 */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { lookupTestHome, npmGlobalOnlyToolName, npmGlobalOnlyToolPath } from './installToolLookup.testSetup';
import { checkIsInstalled, getToolCommand } from '../installManager';

after(() => {
  fs.rmSync(lookupTestHome, { recursive: true, force: true });
});

test('a tool only in ~/.npm-global/bin is installed, and runs by its full path', () => {
  assert.equal(checkIsInstalled(npmGlobalOnlyToolName), true, 'the copy installTool left behind counts');
  assert.equal(getToolCommand(npmGlobalOnlyToolName), npmGlobalOnlyToolPath, 'a spawn without that directory on PATH still finds it');
});

test('a tool found nowhere is missing and keeps its bare name', () => {
  fs.rmSync(npmGlobalOnlyToolPath);
  assert.equal(checkIsInstalled(npmGlobalOnlyToolName), false);
  assert.equal(getToolCommand(npmGlobalOnlyToolName), npmGlobalOnlyToolName);
});
