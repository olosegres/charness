/**
 * @description What the bonus-credit flows (`apiCreditE2e.test.ts`, `apiCreditRenewalE2e.test.ts`) share: the operator's
 * command line against the BUILT charness of an isolated instance, the anchors file, and the lines `/accounts` hangs
 * under an API account's row. Matches neither runner glob.
 */

import { spawnSync } from 'child_process';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { claudeApiCreditFileName } from '../../utils/claudeApiCredit';
import type { TopicDriver } from '../telegramE2e/topicDriver';
import { builtCliPath, getIsolatedPath, type IsolatedInstanceLayout } from './isolatedCharness';

const commandTimeoutMs = 30 * 1000;

/** What a finished command line printed. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The built `charness claude-profiles …` of this instance (its env file names the data dir), as the operator runs it. */
export function runClaudeProfilesCommand(layout: IsolatedInstanceLayout, ...args: string[]): CommandResult {
  const result = spawnSync(process.execPath, [builtCliPath, 'claude-profiles', ...args], {
    env: { ENV_FILE: layout.envFile, PATH: getIsolatedPath(layout), HOME: layout.instanceHome },
    encoding: 'utf8',
    timeout: commandTimeoutMs,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `charness claude-profiles credit …` of the instance. */
export function runCreditCommand(layout: IsolatedInstanceLayout, ...args: string[]): CommandResult {
  return runClaudeProfilesCommand(layout, 'credit', ...args);
}

/** The anchors file as the command line wrote it, by profile. */
export function readCreditFile(layout: IsolatedInstanceLayout): Record<string, { remainingUsd: number; grantUsd?: number; anchoredAt: string; expiresOn?: string }> {
  return JSON.parse(fs.readFileSync(path.join(layout.dataDir, claudeApiCreditFileName), 'utf8'));
}

/** The lines `/accounts` writes under `accountName`'s row, in the order they hang there (the row's own line excluded). */
export async function readAccountRowLines(topic: TopicDriver, accountName: string): Promise<string[]> {
  const screen = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
  const lines = screen.text.split('\n');
  const rowIndex = lines.findIndex((line) => line.includes(`• ${accountName} —`) || line.includes(`✓ ${accountName} —`));
  assert.ok(rowIndex >= 0, `${accountName}'s row is on the screen: ${screen.text}`);
  // The usage lines hang under the row, each indented by four spaces; the next row or the footer is not indented.
  const hanging: string[] = [];
  for (const line of lines.slice(rowIndex + 1)) {
    if (!line.startsWith('    ')) break;
    hanging.push(line);
  }
  return hanging;
}

/** The credit line among an account's hanging lines. */
export function findCreditLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.includes('🎁'));
}
