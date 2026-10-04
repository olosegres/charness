/**
 * @description A fake Telegram Bot API on loopback for the process-level
 * Telegram tests (request/answer plan S6–S9): charness is pointed at it with
 * `TELEGRAM_API_ROOT` and runs its real telegraf client against it — long
 * polling, sends, edits, pins, callback answers — while the test plays the
 * operator: it pushes messages and button taps as updates and reads back what
 * the bot posted, edited, pinned and unpinned in each topic.
 *
 * Only what the flow needs is modelled: ONE forum supergroup with the operator
 * as its creator (plus any further admins a flow names, who may write too),
 * numbered topics, message ids in one sequence (operator and
 * bot messages alike, as on Telegram), the pin state of every message, and
 * every call in order. A method the fake does not model answers `true` and is
 * recorded, so a new call the bot starts making shows up in `calls` instead of
 * failing the flow for a reason unrelated to what it tests.
 *
 * Nothing leaves the machine: the server listens on 127.0.0.1 only.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';

/** The Bot API's own shape of a successful answer. */
interface ApiOk { ok: true; result: unknown }
interface ApiError { ok: false; error_code: number; description: string }

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'supergroup';
  title: string;
  is_forum: true;
}

/** A message as the fake stores it: the fields the flow reads back. */
export interface FakeTelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  message_thread_id: number;
  is_topic_message: true;
  from: TelegramUser;
  text: string;
  entities?: Array<{ type: 'bot_command'; offset: number; length: number }>;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  /** The `disable_notification` the send carried (bot messages only). */
  isSilent?: boolean;
  isDeleted?: boolean;
}

/** One Bot API call charness made, in order. */
export interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

/** One pin or unpin, in order. `isSilent` is the pin's `disable_notification`. */
export interface FakeTelegramPinEvent {
  kind: 'pin' | 'unpin';
  messageId: number;
  isSilent: boolean;
}

export interface FakeTelegramOptions {
  botUser: TelegramUser;
  operator: TelegramUser;
  /** Further group administrators (the bot serves every admin); the operator is always one. */
  admins?: TelegramUser[];
  group: { id: number; title: string };
}

/** How long a `getUpdates` long poll is held when nothing arrives (telegraf asks for 50 s; shorter keeps the stop quick). */
const longPollHoldMs = 2_000;
/** The cap the Bot API enforces on `getUpdates` `limit`. */
const maxUpdatesPerPoll = 100;

/** `/command args` → the `bot_command` entity Telegram attaches to a typed command. */
function getCommandEntities(text: string): FakeTelegramMessage['entities'] {
  const match = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text);
  return match ? [{ type: 'bot_command', offset: 0, length: match[0].length }] : undefined;
}

export class FakeTelegram {
  /** Every call in order, the token already stripped from the path. */
  readonly calls: FakeTelegramCall[] = [];
  /** Every pin and unpin in order. */
  readonly pinEvents: FakeTelegramPinEvent[] = [];
  /** Every `answerCallbackQuery` text, in order. */
  readonly callbackAnswers: string[] = [];
  private readonly messages = new Map<number, FakeTelegramMessage>();
  private readonly pinnedMessageIds = new Set<number>();
  private readonly pendingUpdates: Array<Record<string, unknown>> = [];
  private wakePoll: (() => void) | null = null;
  private nextMessageId = 1;
  private nextUpdateId = 1;
  private nextCallbackQueryId = 1;
  private server: http.Server | null = null;
  private readonly chat: TelegramChat;

  constructor(private readonly options: FakeTelegramOptions) {
    this.chat = { id: options.group.id, type: 'supergroup', title: options.group.title, is_forum: true };
  }

  /** @description Listen on a free loopback port; resolves the API root to put in `TELEGRAM_API_ROOT`. */
  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.wakePoll?.();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ─── what the operator does ───────────────────────────────────────

  /** @description The operator writes `text` in topic `threadId`; resolves the message id. */
  pushOperatorMessage(threadId: number, text: string): number {
    return this.pushUserMessage(threadId, text, this.options.operator);
  }

  /** @description `from` writes `text` in topic `threadId` (another admin, say); resolves the message id. */
  pushUserMessage(threadId: number, text: string, from: TelegramUser): number {
    const message = this.storeMessage(threadId, text, from, { entities: getCommandEntities(text) });
    this.pushUpdate({ message });
    return message.message_id;
  }

  /** @description The operator taps the button carrying `callbackData` on the bot's message `messageId`. */
  pushCallback(messageId: number, callbackData: string): void {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`no message ${messageId} to tap a button on`);
    this.pushUpdate({
      callback_query: {
        id: (this.nextCallbackQueryId++).toString(),
        from: this.options.operator,
        message,
        chat_instance: 'fake-chat-instance',
        data: callbackData,
      },
    });
  }

  // ─── what the test reads back ─────────────────────────────────────

  /** @description The bot's messages in topic `threadId` that are not deleted, oldest first, with their CURRENT text. */
  listBotMessages(threadId: number): FakeTelegramMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.message_thread_id === threadId && message.from.id === this.options.botUser.id && !message.isDeleted)
      .sort((a, b) => a.message_id - b.message_id);
  }

  getMessage(messageId: number): FakeTelegramMessage | undefined {
    return this.messages.get(messageId);
  }

  /** @description The ids currently pinned, oldest pin first. */
  listPinnedMessageIds(): number[] {
    return [...this.pinnedMessageIds];
  }

  /** @description The calls of one method, in order. */
  listCalls(method: string): FakeTelegramCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  // ─── the Bot API ──────────────────────────────────────────────────

  private pushUpdate(body: Record<string, unknown>): void {
    this.pendingUpdates.push({ update_id: this.nextUpdateId++, ...body });
    this.wakePoll?.();
  }

  private storeMessage(
    threadId: number,
    text: string,
    from: TelegramUser,
    extra: Pick<FakeTelegramMessage, 'entities' | 'reply_markup' | 'isSilent'> = {},
  ): FakeTelegramMessage {
    const message: FakeTelegramMessage = {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: this.chat,
      message_thread_id: threadId,
      is_topic_message: true,
      from,
      text,
      ...(extra.entities ? { entities: extra.entities } : {}),
      ...(extra.reply_markup ? { reply_markup: extra.reply_markup } : {}),
      ...(extra.isSilent !== undefined ? { isSilent: extra.isSilent } : {}),
    };
    this.messages.set(message.message_id, message);
    return message;
  }

  /** The message a request names, or the Bot API's own "message not found" error. */
  private getMessageOrError(payload: Record<string, unknown>): FakeTelegramMessage | ApiError {
    const messageId = Number(payload.message_id);
    const message = this.messages.get(messageId);
    return message && !message.isDeleted ? message : { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' };
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`the fake Telegram API reads JSON bodies only; got content-type "${contentType}"`);
    }
    return JSON.parse(raw);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const match = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(request.url ?? '');
    if (!match) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
      return;
    }
    const method = match[1];
    let payload: Record<string, unknown>;
    try {
      payload = await this.readJsonBody(request);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 400, description: error instanceof Error ? error.message : String(error) }));
      return;
    }
    this.calls.push({ method, payload });
    const answer = await this.dispatch(method, payload);
    response.writeHead(answer.ok ? 200 : answer.error_code, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  }

  private async dispatch(method: string, payload: Record<string, unknown>): Promise<ApiOk | ApiError> {
    switch (method) {
      case 'getMe':
        return { ok: true, result: { ...this.options.botUser, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } };
      case 'getUpdates':
        return { ok: true, result: await this.takeUpdates(Number(payload.limit ?? maxUpdatesPerPoll)) };
      case 'getChatAdministrators':
        return {
          ok: true,
          result: [
            { status: 'creator', user: this.options.operator, is_anonymous: false },
            ...(this.options.admins ?? []).map((admin) => ({ status: 'administrator', user: admin, is_anonymous: false })),
          ],
        };
      case 'getChat':
        return { ok: true, result: this.chat };
      case 'sendMessage': {
        const message = this.storeMessage(Number(payload.message_thread_id), String(payload.text), this.options.botUser, {
          reply_markup: payload.reply_markup as FakeTelegramMessage['reply_markup'],
          isSilent: payload.disable_notification === true,
        });
        return { ok: true, result: message };
      }
      case 'editMessageText': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        message.text = String(payload.text);
        if (payload.reply_markup !== undefined) message.reply_markup = payload.reply_markup as FakeTelegramMessage['reply_markup'];
        return { ok: true, result: message };
      }
      case 'editMessageReplyMarkup': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        message.reply_markup = payload.reply_markup as FakeTelegramMessage['reply_markup'];
        return { ok: true, result: message };
      }
      case 'deleteMessage': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        message.isDeleted = true;
        this.pinnedMessageIds.delete(message.message_id);
        return { ok: true, result: true };
      }
      case 'pinChatMessage': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        this.pinnedMessageIds.add(message.message_id);
        this.pinEvents.push({ kind: 'pin', messageId: message.message_id, isSilent: payload.disable_notification === true });
        return { ok: true, result: true };
      }
      case 'unpinChatMessage': {
        const messageId = Number(payload.message_id);
        this.pinnedMessageIds.delete(messageId);
        this.pinEvents.push({ kind: 'unpin', messageId, isSilent: true });
        return { ok: true, result: true };
      }
      case 'answerCallbackQuery':
        this.callbackAnswers.push(String(payload.text ?? ''));
        return { ok: true, result: true };
      default:
        // deleteWebhook, setMyCommands, sendChatAction, … — accepted and recorded.
        return { ok: true, result: true };
    }
  }

  /** The long poll: the pending updates at once, else held until one arrives or the hold passes. */
  private async takeUpdates(limit: number): Promise<Array<Record<string, unknown>>> {
    if (this.pendingUpdates.length === 0 && this.server) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, longPollHoldMs);
        this.wakePoll = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakePoll = null;
    }
    return this.pendingUpdates.splice(0, Math.min(limit, maxUpdatesPerPoll));
  }
}
