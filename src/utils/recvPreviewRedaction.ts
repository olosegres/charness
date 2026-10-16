import { stripCommandBotMention } from '../utils';

/** Recorded instead of a pasted provider API key while `/connect` is pending. */
export const redactedConnectKeyPreview = '[redacted: provider API key]';

/** Recorded instead of a pasted speech-engine key while `/stt` waits for one. */
export const redactedSttKeyPreview = '[redacted: speech engine key]';

/**
 * Recorded instead of a custom speech-engine address while `/stt` waits for one: an address may carry a login
 * (`http://user:pass@host`), and the message is deleted from the topic for that reason.
 */
export const redactedSttAddressPreview = '[redacted: speech engine address]';

/** What `/stt` waits for as plain text: the next non-command message of the topic IS that secret-bearing input. */
export type SttAwaitedInputStep = 'url' | 'key';

/** Recorded instead of a `/connect …` invocation — its arguments may carry the key inline. */
export const redactedConnectCommandPreview = '/connect <redacted>';

/**
 * @description Is `rawText` a `/connect` command invocation (any argument
 * shape, `@botmention` tolerated)? Shared by the command wrapper (a re-issued
 * `/connect` keeps the pending state without a "cancelled" notice) and the
 * recv-trace redaction below.
 */
export function checkIsConnectCommandText(rawText: string): boolean {
  const [commandName = ''] = stripCommandBotMention(rawText.trim()).split(/\s+/, 1);
  return commandName === '/connect';
}

/**
 * @description Decide what the output-trace `recv` preview may show for an
 * incoming text message. Security: a provider API key must never land in the
 * on-disk trace log. Mirrors the text handler's own routing: while the thread
 * is in the pending `/connect` state, the next non-command text IS the pasted
 * key → the preview is fully redacted (a command text cancels the flow instead,
 * so it is not a secret). The same holds while `/stt` waits for a speech-engine
 * key or for a custom server's address (it may carry a login). Independently of the pending state, an inline `/connect <key>` carries
 * the key in its arguments → only a fixed command marker is recorded.
 * Everything else records unchanged.
 */
export function getRecvTracePreview(
  messageText: string,
  isThreadPendingProviderConnect: boolean,
  awaitedSttStep: SttAwaitedInputStep | null = null,
): string {
  if (checkIsConnectCommandText(messageText)) return redactedConnectCommandPreview;
  const isPlainText = !messageText.trim().startsWith('/');
  if (isThreadPendingProviderConnect && isPlainText) return redactedConnectKeyPreview;
  if (awaitedSttStep === 'key' && isPlainText) return redactedSttKeyPreview;
  if (awaitedSttStep === 'url' && isPlainText) return redactedSttAddressPreview;
  return messageText;
}
