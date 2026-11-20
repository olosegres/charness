import type { Translate } from '../../i18n';
import { unknownRunningVersion } from '../../selfUpdate/updateRuntime';

/** The product name the greeting's title opens with: a name, never translated. */
const productName = 'Charness';

export interface GroupWelcomeFacts {
  /** The version this process STARTED as (`UpdateStatus.running.version`); absent while the update engine is not up. */
  runningVersion: string | undefined;
  /** The folder the topics' project folders live in. */
  workRoot: string;
}

/**
 * @description The title line of the greeting: the product and the version that really runs — never a number written into
 * a text. A version that could not be read is left out rather than shown as «unknown».
 */
export function getGroupWelcomeTitle(runningVersion: string | undefined): string {
  return runningVersion && runningVersion !== unknownRunningVersion ? `${productName} ${runningVersion}` : productName;
}

/**
 * @description What the bot posts into General when it is added to the served group (`onboarding.welcome`): who it is, the
 * steps that make it ready, where the project folders are. Sent as Markdown (the title is bold, the folder is code).
 */
export function formatGroupWelcome(translate: Translate, facts: GroupWelcomeFacts): string {
  return translate('onboarding.welcome', { title: getGroupWelcomeTitle(facts.runningVersion), workRoot: facts.workRoot });
}
