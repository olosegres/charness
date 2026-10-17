/**
 * @description The pure side of a MANUAL switch of a topic between the two agent backends, Claude and OpenCode
 * (`/claude` and `/opencode`, a Claude account picked in `/accounts` on an OpenCode topic, the natural-language
 * "start …" phrases). A switch that has a conversation to hand over asks once first — the operator is told the
 * context is handed over in compacted form — and a topic with nothing to carry switches at once.
 *
 * This module decides WHEN to ask, words the question and owns the two `callback_data` of its one-shot keyboard.
 * The question and the buttons are `connectors/telegram/commands/backendSwitch.ts`; the switch itself is `bot.ts`
 * (`executeBackendSwitch`, the same cross-backend move the usage-limit switch makes).
 */

import { t } from '../i18n';
import { checkIsClaudeBackend, openCodeAdapterName } from '../adapters/adapterNames';

/** The two agent families a topic can hand a conversation between. */
export type BackendFamily = 'claude' | 'opencode';

/**
 * Where a manual switch goes. A Claude target names an account: `isProfilePicked` is whether the operator PICKED it
 * (an account tap, `/accounts use`) — the switch then records it as the topic's own pick — or it is only the account
 * the topic already follows (`/claude`), which the switch leaves to General. An OpenCode target carries the model the
 * topic will run, for the question only (`null` when the server's default cannot be read) — the switch itself leaves
 * the model alone, so a topic that follows the server's default keeps following it.
 */
export type BackendSwitchTarget =
  | { backend: 'claude'; profile: string; isProfilePicked: boolean }
  | { backend: 'opencode'; modelLabel: string | null };

/** The family an adapter name belongs to; `null` for a shell or an unknown name (nothing to hand over from or to). */
export function getBackendFamily(adapterName: string | undefined): BackendFamily | null {
  if (adapterName === undefined) return null;
  if (checkIsClaudeBackend(adapterName)) return 'claude';
  return adapterName === openCodeAdapterName ? 'opencode' : null;
}

/**
 * @description Whether a switch to `target` must ask first: the topic runs on the OTHER backend and that backend
 * holds a conversation to hand over. Any other switch — the same family (a flip between the Claude backends, a
 * plain restart), a topic that runs nothing or only a shell, a fresh topic — goes ahead without a question.
 */
export function checkNeedsBackendSwitchConfirmation(input: {
  currentAdapterName: string | undefined;
  targetBackend: BackendFamily;
  hasConversation: boolean;
}): boolean {
  const currentFamily = getBackendFamily(input.currentAdapterName);
  return currentFamily !== null && currentFamily !== input.targetBackend && input.hasConversation;
}

/** The one-shot keyboard of the question: continue / cancel. Constant data — the question is identified by its message. */
export const backendSwitchContinueCallback = 'bsw_ok';
export const backendSwitchCancelCallback = 'bsw_no';
export const backendSwitchCallbackRe = /^bsw_(ok|no)$/;

/** A family by name: `Claude` / `OpenCode`. */
export function formatBackendFamily(family: BackendFamily): string {
  return family === 'claude' ? t('fallback.backendClaude') : t('fallback.backendOpenCode');
}

/** The target as the question names it: `Claude «work»`, `OpenCode openai/gpt-5`, or `OpenCode` when its model is unknown. */
export function formatBackendSwitchTarget(target: BackendSwitchTarget): string {
  if (target.backend === 'claude') return `${t('fallback.backendClaude')} «${target.profile}»`;
  return target.modelLabel === null ? t('fallback.backendOpenCode') : `${t('fallback.backendOpenCode')} ${target.modelLabel}`;
}

/** The target as the context bridge names it, the way a chain rung is labelled: `Claude · work`, `OpenCode · openai/gpt-5`. */
export function formatBackendSwitchBridgeLabel(target: BackendSwitchTarget): string {
  if (target.backend === 'claude') return `${t('fallback.backendClaude')} · ${target.profile}`;
  return target.modelLabel === null ? t('fallback.backendOpenCode') : `${t('fallback.backendOpenCode')} · ${target.modelLabel}`;
}

/** The question: where the topic goes from and to, then the shared line about the hand-over. */
export function buildBackendSwitchQuestion(input: { from: BackendFamily; target: BackendSwitchTarget }): string {
  const question = t('backendSwitch.question', { from: formatBackendFamily(input.from), to: formatBackendSwitchTarget(input.target) });
  return `${question}\n${t('handover.note')}`;
}
