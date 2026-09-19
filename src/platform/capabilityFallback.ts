/**
 * @description How outbound content degrades when the surface cannot express
 * all of it.
 *
 * The core writes what it MEANS — "here are three choices, keep this visible" —
 * without knowing whether the far side has tappable buttons or a pin. This
 * module is the single place that reconciles the two, so every connector
 * degrades identically and no connector has to remember to check.
 *
 * The contract that makes degradation lossless: {@link OutboundContent.text}
 * ALWAYS enumerates the options itself, and {@link OutboundContent.options} is
 * purely the "offer these as tappable controls too" request. Dropping the
 * options therefore costs the user the tap, never the information — they answer
 * by typing the index instead, which is exactly the tracker case.
 */

import type { ConnectorCapabilities, OutboundContent } from './outbound';

/**
 * @description Reduce `content` to what `capabilities` can actually express.
 *
 * Returns the SAME object when nothing has to change, so the all-capable
 * surface (Telegram) pays nothing and a test asserting identity can prove the
 * rich path was taken untouched.
 *
 * - no `tappableOptions` → the options are dropped; the enumerated list in
 *   `text` is what the user reads and answers by index.
 * - no `pinMessages` → `keepVisible` is cleared; the message is still sent, it
 *   just does not stay prominent.
 */
export function getDegradedContent(
  content: OutboundContent,
  capabilities: ConnectorCapabilities,
): OutboundContent {
  const shouldDropOptions = !capabilities.tappableOptions && content.options !== undefined;
  const shouldDropKeepVisible = !capabilities.pinMessages && content.keepVisible === true;
  if (!shouldDropOptions && !shouldDropKeepVisible) return content;

  const degraded: OutboundContent = { ...content };
  if (shouldDropOptions) delete degraded.options;
  if (shouldDropKeepVisible) degraded.keepVisible = false;
  return degraded;
}

/**
 * @description Does this content still need a message of its own after
 * degradation?
 *
 * A surface that can neither pin nor offer controls turns a "prominent" message
 * back into ordinary content — there is nothing left that distinguishes it, so
 * forcing a separate message would only fragment the conversation.
 */
export function checkNeedsOwnMessage(content: OutboundContent): boolean {
  return content.keepVisible === true || (content.options?.length ?? 0) > 0;
}
