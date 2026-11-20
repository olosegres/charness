import type { Translate } from '../../i18n';

export interface GroupWelcomeFacts {
  /** The folder the topics' project folders live in. */
  workRoot: string;
}

/**
 * @description What the bot posts into General when it is added to the served group (`onboarding.welcome`): who it is, the
 * steps that make it ready, where the project folders are. Sent as Markdown (the title is bold, the folder is code). The title
 * is the product name alone — a greeting carries no version.
 */
export function formatGroupWelcome(translate: Translate, facts: GroupWelcomeFacts): string {
  return translate('onboarding.welcome', { workRoot: facts.workRoot });
}
