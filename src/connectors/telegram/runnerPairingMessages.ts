import * as fs from 'fs';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../../configDirFile';
import { hubIdSchema } from '../../runners/hubIds';

/**
 * @description The pairing messages this INSTANCE has sent and not yet settled — the one record of "which message offers which code"
 * (`DATA_DIR/runner-pairing-messages.json`). It is the instance's own: the hub registry is shared by every charness of the OS user and
 * holds the credentials only, so a message of this bot is never adopted by another bot, and a credential swept or spent (while this bot
 * was down, or by another instance) does not take the way back to its message with it. An entry stays until the message was edited to
 * what became of its code (paired / expired) and Telegram accepted the edit, or until it is a day old.
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

/** @description Add `message` (an older entry for the same code is replaced). */
export function addPairingMessage(filePath: string, message: PairingMessage): void {
  const { messages } = readPairingMessages(filePath);
  writePairingMessages(filePath, [...messages.filter((candidate) => candidate.pairId !== message.pairId), message]);
}

/** @description Take the entries for `pairIds` out. */
export function removePairingMessages(filePath: string, pairIds: ReadonlySet<string>): void {
  const { messages } = readPairingMessages(filePath);
  writePairingMessages(filePath, messages.filter((candidate) => !pairIds.has(candidate.pairId)));
}
