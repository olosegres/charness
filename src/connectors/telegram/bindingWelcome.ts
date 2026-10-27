/**
 * The pure parts of a binding's welcome that name OTHER topics: how a topic that shares the folder is written in the
 * welcome's «also used by» row. A leaf module (no `bot.ts`, no environment), so a test can reach it.
 */

/**
 * A topic bound to the same folder. `name`: what the bot saw the topic made with (or renamed to by an admin), when it
 * saw it. `link`: the link that opens the topic, which a person can always follow.
 */
export interface SharedTopic {
  name: string | undefined;
  link: string;
}

/**
 * @description The row's list, comma-separated: a topic with a name is that name as inline code, one without is its bare
 * link (Telegram makes it tappable; it is digits and slashes only, so Markdown has nothing to mangle). `moreLabel` —
 * the count of the topics that are only counted, already worded (`+2 more`) — is the last item: those of OTHER chats, and any
 * of this chat that has neither a name nor a link to show; a
 * member of one chat is not told the names, the links or the ids of another's. The welcome is sent as Markdown, where
 * nothing inside a code span can be escaped, so a backtick in a name (a name is free text) would end the span early — it
 * becomes an apostrophe instead.
 */
export function formatSharedTopicList(topics: readonly SharedTopic[], moreLabel: string | null = null): string {
  const items = topics.map(({ name, link }) => {
    const label = name?.trim();
    return label ? `\`${label.replaceAll('`', "'")}\`` : link;
  });
  if (moreLabel !== null) items.push(moreLabel);
  return items.join(', ');
}
