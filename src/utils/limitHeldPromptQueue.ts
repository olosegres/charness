import { keyToString, type SessionKey } from '../sessionKey';
import { getHeldPromptsText, getHeldPromptsWith, getTextWithHeldPrompts, limitHeldPromptsMax } from './limitHeldPrompts';

/**
 * @name LimitHeldPromptStore
 * @description Where held prompts live — `state.json`, per conversation, apart
 * from the retry record: the wait can end without its resume (the operator
 * writes, skips or disables it, the session ends) and the prompts must outlive it.
 * Both calls are synchronous, so a take is atomic within one turn of the loop.
 */
export interface LimitHeldPromptStore {
  getLimitHeldPrompts: (key: SessionKey) => string[];
  setLimitHeldPrompts: (key: SessionKey, prompts: readonly string[]) => void;
}

/**
 * @name LimitHeldPromptQueueDeps
 * @description `checkIsLimitWaitArmed` — whether `key` waits out an ARMED usage
 * limit right now (a fired record is history, not a wait).
 */
export interface LimitHeldPromptQueueDeps {
  store: LimitHeldPromptStore;
  checkIsLimitWaitArmed: (key: SessionKey) => boolean;
}

/**
 * @description The held prompts of usage-limit waits (Jira plan R23): held
 * while a wait is armed, released — never dropped — once none is: after the
 * next prompt forwarded to the conversation's session (the resume's, the
 * operator's next message, a later post), or on their own when a session starts.
 */
export class LimitHeldPromptQueue {
  constructor(private readonly deps: LimitHeldPromptQueueDeps) {}

  /** @description Hold `text` while a usage-limit wait is armed; `false` — none is, post as usual. */
  holdPrompt(key: SessionKey, text: string): boolean {
    if (!this.deps.checkIsLimitWaitArmed(key)) return false;
    const { held, droppedCount } = getHeldPromptsWith(this.deps.store.getLimitHeldPrompts(key), text);
    if (droppedCount > 0) {
      console.warn(`[limitHeld] ${keyToString(key)}: ${droppedCount} oldest held prompt(s) dropped (at most ${limitHeldPromptsMax})`);
    }
    this.deps.store.setLimitHeldPrompts(key, held);
    console.log(`[limitHeld] ${keyToString(key)}: prompt held until the usage-limit wait ends (${held.length} held)`);
    return true;
  }

  /**
   * @description `text` about to be forwarded to the session, with the held
   * prompts after it — and they are no longer held. Unchanged while a wait is
   * still armed or nothing is held.
   */
  releaseWithForward(key: SessionKey, text: string): string {
    const held = this.takeHeldPrompts(key);
    return held.length > 0 ? getTextWithHeldPrompts(text, held) : text;
  }

  /** @description The held prompts as one message for a session that has nothing else to forward; `null` — none, or still held. */
  releaseAll(key: SessionKey): string | null {
    return getHeldPromptsText(this.takeHeldPrompts(key));
  }

  private takeHeldPrompts(key: SessionKey): string[] {
    if (this.deps.checkIsLimitWaitArmed(key)) return [];
    const held = this.deps.store.getLimitHeldPrompts(key);
    if (held.length === 0) return [];
    this.deps.store.setLimitHeldPrompts(key, []);
    console.log(`[limitHeld] ${keyToString(key)}: ${held.length} held prompt(s) released`);
    return held;
  }
}
