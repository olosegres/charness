import type { FileSendKind } from './fileSendPlan';

/** What one message of a delivery was: a text, or the kind of file Telegram was asked to render. */
export type SentKind = 'text' | FileSendKind;

/** The order a summary names the kinds in, so the same delivery always reads the same. */
const sentKindOrder: readonly SentKind[] = ['text', 'photo', 'video', 'animation', 'document'];

/**
 * @description "1 text, 2 photos" — what actually went out, per kind: the wording `send_messages_to_user` and
 * `send_file_to_user` both answer with. The agent reads it to notice a file that did not go out as it meant (an
 * image that arrived as a document or as text), which a bare count hides. Empty when nothing went out.
 */
export function formatSentKinds(kinds: readonly SentKind[]): string {
  return sentKindOrder
    .map((kind) => ({ kind, count: kinds.filter((sentKind) => sentKind === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `${count} ${kind}${count === 1 ? '' : 's'}`)
    .join(', ');
}
