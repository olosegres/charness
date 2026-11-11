/**
 * @description How a topic is named to people when the bot knows no better: the name of its forum topic, else the folder it
 * is bound to. Callers add their own last resort (a thread id reads differently in a list than in a title).
 */

/** What a binding tells of a topic's name. */
export interface TopicLabelSource {
  topicName?: string;
  subdir: string;
}

/** @description The topic's own name, else its bound folder; `null` when the bot knows neither (an unbound topic never named). */
export function getTopicNameOrFolder(binding: TopicLabelSource | null | undefined): string | null {
  return binding?.topicName || binding?.subdir || null;
}
