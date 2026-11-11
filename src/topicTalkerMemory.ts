/**
 * @description What the bot remembers, in memory only, to make adding a talker a tap or a name: the people who wrote in a
 * topic and were ignored (the «add» screen offers them), and the @usernames it has seen write anywhere in the served group
 * (so `/access add @alice` can name a person the Bot API cannot look up by username).
 *
 * A convenience, not state: nothing here is persisted. After a restart an admin falls back to the reply form, or to a
 * waiting invitation that the person's first message resolves (`topicTalkers.ts`). Platform-neutral like the rest of the
 * access code: a topic is its serialised `SessionKey`, a person a string id.
 */

import { normaliseUsername } from './topicTalkers';

/** How many ignored writers each topic keeps: the add screen has room for a few buttons, not a roster. */
export const recentWritersPerTopicMax = 6;

/** How many @usernames the bot remembers having seen; the oldest are forgotten first. */
export const seenSendersMax = 500;

/** A person as the bot last saw them write. */
export interface SeenPerson {
  userId: string;
  /** Without a leading `@`, as Telegram shows it. */
  username?: string;
  name: string;
}

export interface RecentWriters {
  /** `user` wrote in `topicKey` and the bot ignored them: they become the most recent of that topic. */
  noteIgnoredWriter(topicKey: string, user: SeenPerson): void;
  /** The ignored writers of `topicKey`, the most recent first. */
  getRecentWriters(topicKey: string): SeenPerson[];
  /** `userId` is no longer a stranger in `topicKey` (an admin added them): drop them from its list. */
  forgetWriter(topicKey: string, userId: string): void;
}

export interface SeenSenders {
  /** `user` wrote in the served group; a person with no @username is not kept (there is nothing to look them up by). */
  noteSender(user: SeenPerson): void;
  /** The person last seen with this @username (any case, with or without `@`), or `undefined`. */
  findSenderByUsername(username: string): SeenPerson | undefined;
}

export function createRecentWriters(): RecentWriters {
  const writersByTopic = new Map<string, SeenPerson[]>();

  return {
    noteIgnoredWriter(topicKey, user) {
      const others = (writersByTopic.get(topicKey) ?? []).filter((writer) => writer.userId !== user.userId);
      writersByTopic.set(topicKey, [{ ...user }, ...others].slice(0, recentWritersPerTopicMax));
    },
    getRecentWriters(topicKey) {
      return (writersByTopic.get(topicKey) ?? []).map((writer) => ({ ...writer }));
    },
    forgetWriter(topicKey, userId) {
      const remaining = (writersByTopic.get(topicKey) ?? []).filter((writer) => writer.userId !== userId);
      if (remaining.length === 0) writersByTopic.delete(topicKey);
      else writersByTopic.set(topicKey, remaining);
    },
  };
}

export function createSeenSenders(maxEntries: number = seenSendersMax): SeenSenders {
  // A Map keeps insertion order: re-inserting on every sighting makes the first key the least recently seen.
  const sendersByUsername = new Map<string, SeenPerson>();

  return {
    noteSender(user) {
      if (!user.username) return;
      const lowercase = normaliseUsername(user.username);
      sendersByUsername.delete(lowercase);
      sendersByUsername.set(lowercase, { ...user });
      if (sendersByUsername.size > maxEntries) {
        const [oldest] = sendersByUsername.keys();
        if (oldest !== undefined) sendersByUsername.delete(oldest);
      }
    },
    findSenderByUsername(username) {
      const found = sendersByUsername.get(normaliseUsername(username));
      return found ? { ...found } : undefined;
    },
  };
}
