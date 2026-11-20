import type { Translate } from '../../i18n';

export interface GroupWelcomeFacts {
  /** The folder the topics' project folders live in. */
  workRoot: string;
}

/**
 * @description What the bot posts into General when it is added to the served group (`onboarding.welcome`): who it is, the
 * steps that make it ready, where the project folders are. Sent as Markdown (the folder is code). It opens with
 * one sentence that greets and names the bot — no title line, no version.
 */
export function formatGroupWelcome(translate: Translate, facts: GroupWelcomeFacts): string {
  return translate('onboarding.welcome', { workRoot: facts.workRoot });
}
