/**
 * The pure parts of a binding's welcome that name OTHER topics: how a topic that shares the folder is called in the
 * welcome's «also used by» row. A leaf module (no `bot.ts`, no environment), so a test can reach it.
 */

/**
 * @description What stands for a topic in the shared-folder row: the name stored on its binding (what the person sees in the
 * group's topic list), else its session key — a topic bound before its name was known, or by a command that does not carry it.
 */
export function getSharedTopicLabel(topicName: string | undefined, sessionKey: string): string {
  return topicName !== undefined && topicName.trim() !== '' ? topicName.trim() : sessionKey;
}

/**
 * @description The row's list: every label as inline code, comma-separated. The welcome is sent as Markdown, where nothing
 * inside a code span can be escaped, so a backtick in a topic name (a name is free text) would end the span early — it
 * becomes an apostrophe instead.
 */
export function formatSharedTopicList(labels: readonly string[]): string {
  return labels.map((label) => `\`${label.replaceAll('`', "'")}\``).join(', ');
}
