/**
 * @description Which session ids a thread keeps when its adapter changes (`bot.ts` `switchThreadAdapter`). The live
 * row holds the ids of the backend FAMILY the thread runs on (both Claude backends share one id; OpenCode has its
 * own), and one PARKED slot (`state.parkedSessions`) holds the id of the family the thread last LEFT, so a switch
 * back — a plain `/claude` ↔ `/opencode`, a fallback switch and its «back» button — resumes the conversation it
 * left instead of starting a new one.
 *
 * Both halves happen in the same step: the family being left is parked AND the family being entered is restored from
 * the slot. (Doing one or the other loses a conversation: a round trip Claude → OpenCode → Claude parks the
 * OpenCode id over the parked Claude one, and the thread comes back to a fresh Claude conversation.)
 *
 * Pure: the caller reads the thread's row and slot and writes the result.
 */

import { checkIsClaudeBackend, openCodeAdapterName } from '../adapters/adapterNames';
import type { ParkedSession } from '../state';

/** The ids the thread's row holds, per family. */
export interface SessionIds {
  claudeSessionId?: string;
  opencodeSessionId?: string;
}

/** What the thread's row and the parked slot become: `parked` is `undefined` to leave the slot as it is. */
export interface AdapterSwitchSessionIds {
  ids: SessionIds;
  parked: ParkedSession | null | undefined;
}

export function getAdapterSwitchSessionIds(input: {
  previousName: string | undefined;
  nextName: string;
  agent: SessionIds;
  parked: ParkedSession | null;
  parkedAt: string;
}): AdapterSwitchSessionIds {
  const { previousName, nextName, agent, parked, parkedAt } = input;
  const ids: SessionIds = {};
  // Both Claude backends share the on-disk transcript, so the id stays across tmux-scrape ↔ json-stream.
  if (checkIsClaudeBackend(nextName) && agent.claudeSessionId) ids.claudeSessionId = agent.claudeSessionId;
  if (nextName === openCodeAdapterName && agent.opencodeSessionId) ids.opencodeSessionId = agent.opencodeSessionId;

  let leftBehind: ParkedSession | null = null;
  if (previousName && checkIsClaudeBackend(previousName) && !checkIsClaudeBackend(nextName) && agent.claudeSessionId) {
    leftBehind = { adapterName: previousName, claudeSessionId: agent.claudeSessionId, parkedAt };
  } else if (previousName === openCodeAdapterName && nextName !== openCodeAdapterName && agent.opencodeSessionId) {
    leftBehind = { adapterName: previousName, opencodeSessionId: agent.opencodeSessionId, parkedAt };
  }

  let isRestored = false;
  if (parked && checkIsClaudeBackend(nextName) && !ids.claudeSessionId && parked.claudeSessionId) {
    ids.claudeSessionId = parked.claudeSessionId;
    isRestored = true;
  } else if (parked && nextName === openCodeAdapterName && !ids.opencodeSessionId && parked.opencodeSessionId) {
    ids.opencodeSessionId = parked.opencodeSessionId;
    isRestored = true;
  }

  return { ids, parked: leftBehind ?? (isRestored ? null : undefined) };
}

