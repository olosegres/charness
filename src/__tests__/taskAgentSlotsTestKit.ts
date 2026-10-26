/**
 * @description What the tests of the task-agent slots share (`trackers/taskAgentSlots.ts`): a real `TaskAgentSlots` over an
 * in-memory wait list and a scripted set of open requests, so a test states the situation (who holds a slot, who waits) and
 * reads what the slots decided. Matches neither runner glob.
 */

import { TaskAgentSlots } from '../trackers/taskAgentSlots';
import type { TaskAgentWaitEntry } from '../trackers/types';
import type { OpenRequestState, RequestOriginKind } from '../requests/types';
import { emptyRequester } from '../requests/requestGroup';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

/** An open request as the slots read it off the ledger. */
export interface TestOpenRequest {
  key: SessionKey;
  kind: RequestOriginKind;
  isWakeStopped?: boolean;
}

export interface TestSlots {
  slots: TaskAgentSlots;
  /** The cap in force; change it between calls like an operator would. */
  setMaxConcurrent: (maxConcurrent: number) => void;
  /** The requests the ledger holds open; replace it to open or close requests. */
  setOpenRequests: (requests: readonly TestOpenRequest[]) => void;
  /** The persisted wait list (what `state.json` would hold). */
  getWaitList: () => TaskAgentWaitEntry[];
  /** How many times the wait list was flushed to disk. */
  getFlushCount: () => number;
}

/** A tracker conversation of the Jira connector, as the tests name them. */
export function createJiraConversationKey(issueKey: string): SessionKey {
  return makeJiraKey(issueKey);
}

function createOpenRequestState(kind: RequestOriginKind, isWakeStopped: boolean): OpenRequestState {
  return { id: 'req_test', origin: { kind, attributes: {} }, createdAt: 0, progressAnswerCount: 0, silentTurnCount: 0, wakeCount: 0, isWakeStopped };
}

export function createTestSlots(options: { maxConcurrent?: number; waitList?: TaskAgentWaitEntry[]; now?: () => number } = {}): TestSlots {
  let maxConcurrent = options.maxConcurrent ?? 0;
  let openRequests: readonly TestOpenRequest[] = [];
  let waitList: TaskAgentWaitEntry[] = options.waitList ?? [];
  let flushCount = 0;
  const slots = new TaskAgentSlots({
    getMaxConcurrent: () => maxConcurrent,
    ledger: {
      listOpenRequests: () => openRequests.map(({ key, kind, isWakeStopped }) => ({
        key,
        group: { conversation: key, requester: emptyRequester },
        request: createOpenRequestState(kind, isWakeStopped === true),
      })),
    },
    store: {
      getTaskAgentWaitList: () => waitList.map((entry) => ({ ...entry })),
      setTaskAgentWaitList: (list) => {
        waitList = list.map((entry) => ({ ...entry }));
      },
      flush: async () => {
        flushCount += 1;
      },
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    slots,
    setMaxConcurrent: (next) => {
      maxConcurrent = next;
    },
    setOpenRequests: (requests) => {
      openRequests = requests;
    },
    getWaitList: () => waitList.map((entry) => ({ ...entry })),
    getFlushCount: () => flushCount,
  };
}

/** The slots of an instance without a cap: every check-in is granted. */
export function createUnlimitedSlots(): TaskAgentSlots {
  return createTestSlots({ maxConcurrent: 0 }).slots;
}

/** A wait-list entry of a Jira issue, for tests that start from a list. */
export function createWaitEntry(issueKey: string, queuedAt: number, triggerId = 'trigger'): TaskAgentWaitEntry {
  return { conversationKey: keyToString(createJiraConversationKey(issueKey)), triggerId, queuedAt };
}
