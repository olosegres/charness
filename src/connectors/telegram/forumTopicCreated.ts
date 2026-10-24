/**
 * @name ForumTopicCreatedAction
 * @description What the bot does with a `forum_topic_created` service message:
 * - `ignoreOwn` — the bot created the topic itself (`/topic`), which binds and greets the topic on its own;
 * - `cacheNameOnly` — the creator is unknown or not an authorised user: the name is kept for a later fuzzy
 *   auto-bind, nothing is bound now (a member could otherwise name a topic after a sensitive folder);
 * - `bindOrPick` — an authorised user created it: auto-bind a matching folder, else offer the picker.
 */
export type ForumTopicCreatedAction = 'ignoreOwn' | 'cacheNameOnly' | 'bindOrPick';

/**
 * @description Decide what a `forum_topic_created` service message leads to. The creator is checked against the
 * bot's own id FIRST: the bot is never an authorised user, and its own topic is no foreign creation to warn about.
 * `checkIsCreatorAllowed` runs only for a creator that is someone else.
 */
export async function getForumTopicCreatedAction(input: {
  creatorId: number | undefined;
  botUserId: number | undefined;
  checkIsCreatorAllowed: () => Promise<boolean>;
}): Promise<ForumTopicCreatedAction> {
  if (input.creatorId === undefined) return 'cacheNameOnly';
  if (input.botUserId !== undefined && input.creatorId === input.botUserId) return 'ignoreOwn';
  return (await input.checkIsCreatorAllowed()) ? 'bindOrPick' : 'cacheNameOnly';
}
