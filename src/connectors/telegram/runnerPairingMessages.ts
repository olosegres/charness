import * as fs from 'fs';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../../configDirFile';
import { hubIdSchema } from '../../runners/hubIds';

/**
 * @description The pairing messages this INSTANCE has sent and not yet settled — the one record of "which message offers which code"
 * (`DATA_DIR/runner-pairing-messages.json`). A code is offered in ONE message; an entry is one MESSAGE, found by {@link getPairingMessageId} (a record written
 * by a version that offered a code in two messages has two entries for it, and both are edited to the result like any other). It is the instance's own: the hub registry is shared by every charness of the OS user and
 * holds the credentials only, so a message of this bot is never adopted by another bot, and a credential swept or spent (while this bot
 * was down, or by another instance) does not take the way back to its message with it. An entry stays until the message was edited to
 * what became of its code (paired / expired) and Telegram accepted the edit — or until edits of it have been FAILING for a day: the
 * clock of that cutoff starts at the first failed attempt, not at the message's age, so a bot restarted after a long stop still tries.
 */

/** `<chat id>:<topic id>` — the Telegram spelling of a conversation key. */
const telegramKeyPattern = /^-?\d+:\d+$/;
const fileMode = 0o600;
/** The most entries kept: a pairing is rare and its entry short-lived, so more means a loop somewhere — the oldest go. */
const maxEntries = 50;

const pairingMessageSchema = z.strictObject({
  pairId: hubIdSchema,
  key: z.string().regex(telegramKeyPattern),
  messageId: z.number().int().positive(),
  offeredAtMs: z.number().int().nonnegative(),
  /** Retired: written by the versions that offered a code in two messages (the `second` was deleted at settle). No longer written or read; kept so that such a record still validates. */
  role: z.enum(['first', 'second']).optional(),
  /** When an edit of this message first failed; absent while none has. */
  firstFailedAtMs: z.number().int().nonnegative().optional(),
});

const pairingMessagesFileSchema = z.strictObject({ messages: z.array(pairingMessageSchema) });

/** @name PairingMessage @description One message that offers a code. */
export type PairingMessage = z.infer<typeof pairingMessageSchema>;

export interface PairingMessagesRead {
  messages: PairingMessage[];
  /** Why the file could not be used (it reads as empty and the next write replaces it); `null` when it was fine or missing. */
  problem: string | null;
}

/** @description The entries in `filePath`. A missing file is none; one that is not valid reads as none and says why (the next write replaces it). */
export function readPairingMessages(filePath: string): PairingMessagesRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { messages: [], problem: getCaughtErrnoCode(error) === 'ENOENT' ? null : `${filePath} could not be read` };
  }
  try {
    const parsed = pairingMessagesFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? { messages: parsed.data.messages, problem: null } : { messages: [], problem: `${filePath} is invalid` };
  } catch {
    return { messages: [], problem: `${filePath} is not valid JSON` };
  }
}

/** @description Write the entries (the newest {@link maxEntries}), through a temp file and a rename. */
export function writePairingMessages(filePath: string, messages: readonly PairingMessage[]): void {
  writeJsonFileAtomically(filePath, { messages: messages.slice(-maxEntries) }, fileMode);
}

/** @description What names one message of the record: its code and its Telegram message id. */
export function getPairingMessageId(message: Pick<PairingMessage, 'pairId' | 'messageId'>): string {
  return `${message.pairId}:${message.messageId}`;
}

/** @description Add `message` (an older entry for the same message is replaced). */
export function addPairingMessage(filePath: string, message: PairingMessage): void {
  const { messages } = readPairingMessages(filePath);
  writePairingMessages(filePath, [...messages.filter((candidate) => getPairingMessageId(candidate) !== getPairingMessageId(message)), message]);
}

/** @description Take the entries named by `messageIds` ({@link getPairingMessageId}) out. */
export function removePairingMessages(filePath: string, messageIds: ReadonlySet<string>): void {
  const { messages } = readPairingMessages(filePath);
  writePairingMessages(filePath, messages.filter((candidate) => !messageIds.has(getPairingMessageId(candidate))));
}

/** @description Note that an edit of `message` failed at `nowMs`: the first failure is kept, later ones change nothing. */
export function markPairingMessageFailed(filePath: string, message: Pick<PairingMessage, 'pairId' | 'messageId'>, nowMs: number): void {
  const { messages } = readPairingMessages(filePath);
  const messageId = getPairingMessageId(message);
  if (!messages.some((candidate) => getPairingMessageId(candidate) === messageId && candidate.firstFailedAtMs === undefined)) return;
  writePairingMessages(filePath, messages.map((candidate) => (getPairingMessageId(candidate) === messageId && candidate.firstFailedAtMs === undefined ? { ...candidate, firstFailedAtMs: nowMs } : candidate)));
}
