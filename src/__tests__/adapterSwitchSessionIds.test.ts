/**
 * @description Which session ids a thread keeps when its adapter changes (`utils/adapterSwitchSessionIds.ts`): the
 * family it leaves is PARKED and the family it enters is RESTORED from the parked slot, in the same step — so a round
 * trip Claude → OpenCode → Claude (a fallback switch followed by a /claude, or a plain /opencode and /claude) comes
 * back to the Claude conversation it left instead of a fresh one.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapterSwitchSessionIds } from '../utils/adapterSwitchSessionIds';
import { claudeJsonStreamAdapterName, openCodeAdapterName } from '../adapters/adapterNames';
import type { ParkedSession } from '../state';

const parkedAt = '2026-10-18T10:00:00.000Z';
const claudeId = '11111111-1111-4111-8111-111111111111';
const otherClaudeId = '22222222-2222-4222-8222-222222222222';
const openCodeId = 'ses_open1';

const switchAdapter = (input: { previousName: string | undefined; nextName: string; agent: { claudeSessionId?: string; opencodeSessionId?: string }; parked?: ParkedSession | null }) =>
  getAdapterSwitchSessionIds({ ...input, parked: input.parked ?? null, parkedAt });

describe('getAdapterSwitchSessionIds', () => {
  it('leaving Claude for OpenCode parks the Claude id and brings no OpenCode id', () => {
    assert.deepEqual(
      switchAdapter({ previousName: claudeJsonStreamAdapterName, nextName: openCodeAdapterName, agent: { claudeSessionId: claudeId } }),
      { ids: {}, parked: { adapterName: claudeJsonStreamAdapterName, claudeSessionId: claudeId, parkedAt } },
    );
  });

  it('the way back — leaving OpenCode for Claude — restores the PARKED Claude id and parks the OpenCode one in its place', () => {
    const parked: ParkedSession = { adapterName: claudeJsonStreamAdapterName, claudeSessionId: claudeId, parkedAt: '2026-10-18T09:00:00.000Z' };
    assert.deepEqual(
      switchAdapter({ previousName: openCodeAdapterName, nextName: claudeJsonStreamAdapterName, agent: { opencodeSessionId: openCodeId }, parked }),
      { ids: { claudeSessionId: claudeId }, parked: { adapterName: openCodeAdapterName, opencodeSessionId: openCodeId, parkedAt } },
      'the Claude conversation comes back AND the OpenCode session waits for the next switch',
    );
  });

  it('and again — Claude for OpenCode — restores the OpenCode session the last switch parked', () => {
    const parked: ParkedSession = { adapterName: openCodeAdapterName, opencodeSessionId: openCodeId, parkedAt: '2026-10-18T09:00:00.000Z' };
    assert.deepEqual(
      switchAdapter({ previousName: claudeJsonStreamAdapterName, nextName: openCodeAdapterName, agent: { claudeSessionId: claudeId }, parked }),
      { ids: { opencodeSessionId: openCodeId }, parked: { adapterName: claudeJsonStreamAdapterName, claudeSessionId: claudeId, parkedAt } },
    );
  });

  it('a switch with nothing to park restores and empties the slot; one with nothing to restore leaves it alone', () => {
    const parked: ParkedSession = { adapterName: openCodeAdapterName, opencodeSessionId: openCodeId, parkedAt };
    assert.deepEqual(
      switchAdapter({ previousName: 'terminal', nextName: openCodeAdapterName, agent: {}, parked }),
      { ids: { opencodeSessionId: openCodeId }, parked: null },
    );
    assert.deepEqual(
      switchAdapter({ previousName: 'terminal', nextName: claudeJsonStreamAdapterName, agent: {}, parked }),
      { ids: {}, parked: undefined },
      'the parked OpenCode id is not the Claude family\'s',
    );
  });

  it('a flip between the two Claude backends keeps the one conversation and parks nothing', () => {
    assert.deepEqual(
      switchAdapter({ previousName: 'claude', nextName: claudeJsonStreamAdapterName, agent: { claudeSessionId: claudeId } }),
      { ids: { claudeSessionId: claudeId }, parked: undefined },
    );
  });

  it('the live id of the family being entered wins over a parked one; an agent with no id for the family it leaves parks nothing', () => {
    const parked: ParkedSession = { adapterName: claudeJsonStreamAdapterName, claudeSessionId: otherClaudeId, parkedAt };
    assert.deepEqual(
      switchAdapter({ previousName: 'claude', nextName: claudeJsonStreamAdapterName, agent: { claudeSessionId: claudeId }, parked }).ids,
      { claudeSessionId: claudeId },
    );
    assert.deepEqual(
      switchAdapter({ previousName: openCodeAdapterName, nextName: claudeJsonStreamAdapterName, agent: {} }),
      { ids: {}, parked: undefined },
    );
  });
});
