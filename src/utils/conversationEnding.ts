/**
 * @name ConversationEnding
 * @description A command's hold on a conversation it is about to END or REPLACE — a release, `/new`, a `/resume` pick, a move or a start
 * onto another backend —, taken the moment the bot knows the command ends it, ahead of anything the command awaits after that moment (the
 * toast of its tap, a paced send, a move's bridge). While it is held, a transition queued ahead of the command drops the prompts it would
 * write into the conversation instead of resuming it for them (`requests/README.md` § Turn starts). It ends when the command's own
 * transition begins — what that transition starts is the conversation that comes next, never dropped — or by `release` when the command
 * stops short of it. From the hold until that transition has SETTLED, a person's message is refused
 * ({@link ConversationEndings.checkIsRefusingMessages}): it is meant for a conversation that is going away, or for one not there yet.
 */
export interface ConversationEnding {
  /**
   * Queue the command's transition as the conversation's one transition: the hold ends as it begins, and at the latest once it settled;
   * the refusal of a person's message once it settled. Called once.
   */
  run<TResult>(transition: () => Promise<TResult>): Promise<TResult>;
  /** End the hold and the refusal of a command that stops short of its transition; nothing once they have ended. */
  release(): void;
}

/** What {@link ConversationEndings} needs from the bot: a conversation's key as a string, and its transition queue. */
export interface ConversationEndingsPorts<TKey> {
  toConversationKey: (key: TKey) => string;
  runTransition: <TResult>(key: TKey, transition: () => Promise<TResult>) => Promise<TResult>;
}

/**
 * @description The conversations commands hold as ending ({@link ConversationEnding}), by how many holds each has: two overlapping commands
 * keep it held until both let go. And the conversations that refuse a person's message, by how many commands refuse it: every hold until
 * its transition settled, and a move of its own from its top until its first prompt reached the other backend ({@link refuseMessages}).
 */
export class ConversationEndings<TKey> {
  private readonly holdCounts = new Map<string, number>();
  private readonly refusalCounts = new Map<string, number>();
  /** The posts waiting for a conversation to take messages again ({@link waitForMessagesAccepted}), woken when its last refusal ends. */
  private readonly acceptedWaiters = new Map<string, Array<() => void>>();

  constructor(private readonly ports: ConversationEndingsPorts<TKey>) {}

  /** Whether a command holds the conversation as ending: what a transition queued ahead of it would write into it is dropped. */
  checkIsEnding(conversationKey: string): boolean {
    return (this.holdCounts.get(conversationKey) ?? 0) > 0;
  }

  /**
   * Whether a person's message to the conversation is refused now — not written, buffered, woken or started for, its request closed and the
   * person told: a command ends or replaces the conversation, from its hold until its transition settled, or a move has not yet handed its
   * first prompt to the other backend (`requests/README.md` § Turn starts, review 25 #1, #2).
   */
  checkIsRefusingMessages(conversationKey: string): boolean {
    return (this.refusalCounts.get(conversationKey) ?? 0) > 0;
  }

  /**
   * Resolves once nothing refuses messages to the conversation — at once when nothing does —, `true` when it waited. A bot-made post (a
   * fire, a check's wake, a tracker post) waits here while a command ends or replaces the conversation, and then goes to what follows: in
   * a move, after the move's bridge, which the post's own ensure would otherwise overtake (review 26 #5). A refusal taken again before the
   * waiter runs keeps it waiting. A scheduled run that waited reads again whether the request its header names is still open (mini-review
   * of round 28, #3).
   */
  async waitForMessagesAccepted(conversationKey: string): Promise<boolean> {
    let hasWaited = false;
    while (this.checkIsRefusingMessages(conversationKey)) {
      hasWaited = true;
      await new Promise<void>((resolve) => {
        const waiters = this.acceptedWaiters.get(conversationKey) ?? [];
        waiters.push(resolve);
        this.acceptedWaiters.set(conversationKey, waiters);
      });
    }
    return hasWaited;
  }

  /** Hold `key`'s conversation as ending from now on, refusing a person's message until the command's transition settled. */
  hold(key: TKey): ConversationEnding {
    const conversationKey = this.ports.toConversationKey(key);
    const endHold = this.takeCount(this.holdCounts, conversationKey);
    const endRefusal = this.takeRefusal(conversationKey);
    const release = (): void => {
      endHold();
      endRefusal();
    };
    const run = async <TResult>(transition: () => Promise<TResult>): Promise<TResult> => {
      try {
        return await this.ports.runTransition(key, () => {
          endHold();
          return transition();
        });
      } finally {
        release();
      }
    };
    return { run, release };
  }

  /**
   * Refuse a person's message to `key`'s conversation until the returned end is called (idempotent): a move across backends, whose hold's
   * transition is only the old backend's stop, refuses from its top until its first prompt has reached the other backend — written there
   * first, a message would reach the new agent ahead of the move's bridge, or meet no agent at all while the new one starts.
   */
  refuseMessages(key: TKey): () => void {
    return this.takeRefusal(this.ports.toConversationKey(key));
  }

  /** One more refusal of `conversationKey`'s messages; its end wakes the posts waiting for the conversation once none is left. */
  private takeRefusal(conversationKey: string): () => void {
    return this.takeCount(this.refusalCounts, conversationKey, () => {
      const waiters = this.acceptedWaiters.get(conversationKey) ?? [];
      this.acceptedWaiters.delete(conversationKey);
      for (const wake of waiters) wake();
    });
  }

  /**
   * Count one more in `counts` for `conversationKey`; the returned end counts it off once, and does nothing after that. `onCleared` runs
   * when the end leaves none.
   */
  private takeCount(counts: Map<string, number>, conversationKey: string, onCleared?: () => void): () => void {
    counts.set(conversationKey, (counts.get(conversationKey) ?? 0) + 1);
    let isTaken = true;
    return () => {
      if (!isTaken) return;
      isTaken = false;
      const count = (counts.get(conversationKey) ?? 1) - 1;
      if (count > 0) {
        counts.set(conversationKey, count);
        return;
      }
      counts.delete(conversationKey);
      onCleared?.();
    };
  }
}
