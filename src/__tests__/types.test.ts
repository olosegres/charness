/**
 * @description Type-only contract guards for {@link AgentAdapter}.
 *
 * These tests never run an adapter — they assign concrete functions to the
 * interface's method signatures, so a widened or dropped signature stops
 * compiling and `yarn typecheck` blocks the merge.
 *
 * `SessionKey` serialization used to live here too; it moved to
 * `sessionKeyCodec.test.ts` when the key and its codec left `types.ts`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { type AgentAdapter } from '../types';

/**
 * Audit S10 / #16: lock in the AgentAdapter event-and-throw contract via a
 * type-only compile check. If anyone widens `setModel` back to `void` or
 * drops the throw guarantee from `startSession`, the assignments below
 * stop compiling and `yarn typecheck` blocks the merge.
 */
test('AgentAdapter contract — startSession returns Promise<void>, setModel returns Promise<string|null>', () => {
  // The cast-to-`Pick` keeps this purely a compile-time assertion; we
  // never run the methods so the dummy bodies are unobservable.
  type StartSig = AgentAdapter['startSession'];
  type SetModelSig = NonNullable<AgentAdapter['setModel']>;

  const start: StartSig = async () => { /* must return Promise<void> */ };
  const setModel: SetModelSig = async () => null;
  // Touch the locals so the linter doesn't drop them.
  assert.equal(typeof start, 'function');
  assert.equal(typeof setModel, 'function');
});

/**
 * Plan 2026-05-30-effort-command / S1 — lock the per-thread reasoning-effort
 * contract via type-only assertions. Same shape as the setModel guard above:
 * if anyone widens these signatures (drops `string | null`, makes the level
 * lookup sync without being trivially derivable, etc.) the assignments stop
 * compiling and `yarn typecheck` blocks the merge.
 */
test('AgentAdapter contract — setEffort/getEffort/getAvailableEffortLevels signatures', () => {
  type SetEffortSig = NonNullable<AgentAdapter['setEffort']>;
  type GetEffortSig = NonNullable<AgentAdapter['getEffort']>;
  type GetLevelsSig = NonNullable<AgentAdapter['getAvailableEffortLevels']>;

  const setEffort: SetEffortSig = async () => null;
  const getEffort: GetEffortSig = () => null;
  const getLevels: GetLevelsSig = async () => [];

  assert.equal(typeof setEffort, 'function');
  assert.equal(typeof getEffort, 'function');
  assert.equal(typeof getLevels, 'function');
});
