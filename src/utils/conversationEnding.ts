/**
 * @name ConversationEnding
 * @description A command's hold on a conversation it is about to END or REPLACE — a release, `/new`, a `/resume` pick, a move or a start
 * onto another backend —, taken the moment the bot knows the command ends it, ahead of anything the command awaits after that moment (the
 * toast of its tap, a paced send, a move's bridge). While it is held, a transition queued ahead of the command drops the prompts it would
 * write into the conversation instead of resuming it for them (`requests/README.md` § Turn starts). It ends when the command's own
 * transition begins — what that transition starts is the conversation that comes next, never dropped — or by `release` when the command
 * stops short of it.
 */
export interface ConversationEnding {
  /**
   * Queue the command's transition as the conversation's one transition: the hold ends as it begins, and at the latest once it settled.
   * Called once.
   */
  run<TResult>(transition: () => Promise<TResult>): Promise<TResult>;
  /** End the hold of a command that stops short of its transition; nothing once it has ended. */
  release(): void;
}

/** What {@link ConversationEndings} needs from the bot: a conversation's key as a string, and its transition queue. */
export interface ConversationEndingsPorts<TKey> {
  toConversationKey: (key: TKey) => string;
  runTransition: <TResult>(key: TKey, transition: () => Promise<TResult>) => Promise<TResult>;
}

/**
 * @description The conversations commands hold as ending ({@link ConversationEnding}), by how many holds each has: two overlapping commands
 * keep it held until both let go.
 */
export class ConversationEndings<TKey> {
  private readonly holdCounts = new Map<string, number>();

  constructor(private readonly ports: ConversationEndingsPorts<TKey>) {}

  /** Whether a command holds the conversation as ending. */
  checkIsEnding(conversationKey: string): boolean {
    return (this.holdCounts.get(conversationKey) ?? 0) > 0;
  }

  /** Hold `key`'s conversation as ending from now on. */
  hold(key: TKey): ConversationEnding {
    const conversationKey = this.ports.toConversationKey(key);
    this.holdCounts.set(conversationKey, (this.holdCounts.get(conversationKey) ?? 0) + 1);
    let isHeld = true;
    const release = (): void => {
      if (!isHeld) return;
      isHeld = false;
      const count = (this.holdCounts.get(conversationKey) ?? 1) - 1;
      if (count > 0) this.holdCounts.set(conversationKey, count);
      else this.holdCounts.delete(conversationKey);
    };
    const run = async <TResult>(transition: () => Promise<TResult>): Promise<TResult> => {
      try {
        return await this.ports.runTransition(key, () => {
          release();
          return transition();
        });
      } finally {
        release();
      }
    };
    return { run, release };
  }
}
