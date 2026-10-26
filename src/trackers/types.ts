/**
 * @name TaskAgentWaitEntry
 * @description One tracker conversation waiting for a slot (`taskAgentSlots.ts`), as persisted in `state.json`
 * `taskAgentWaitList`: oldest first, one entry per conversation.
 */
export interface TaskAgentWaitEntry {
  /** The conversation's serialized `SessionKey`. */
  conversationKey: string;
  /** The tracker's id of the hand-over that is waiting (the connector's trigger id), for the logs. */
  triggerId: string;
  /** Epoch ms the conversation joined the list. */
  queuedAt: number;
}
