import type { RecordedMessage, WalkthroughRecording, WalkthroughShot } from './walkthroughTypes';

/** How many messages of the topic before the matching one a screenshot shows when its spec does not say. */
const defaultMessagesBefore = 2;

/**
 * @description The messages a screenshot shows: the first state of the chat, oldest first, in which a message of the shot's topic matches the
 * shot's text (and keyboard), with the messages before it, cut at the match. `null` when no state of the recording has such a message.
 * A picker the bot later edits into its confirmation is found as the picker, because the first state that matches wins.
 */
export function selectShotView(recording: WalkthroughRecording, shot: WalkthroughShot): RecordedMessage[] | null {
  const textPattern = new RegExp(shot.match, 's');
  const keyboardPattern = shot.keyboardMatch === undefined ? null : new RegExp(shot.keyboardMatch);
  const isBotMessage = shot.isOperatorMessage !== true;
  const checkIsMatch = (message: RecordedMessage): boolean =>
    message.isBot === isBotMessage && textPattern.test(message.text) && (keyboardPattern === null || keyboardPattern.test(JSON.stringify(message.keyboard)));
  for (const event of recording.events) {
    if (event.kind !== 'chat') continue;
    const topicMessages = event.messages.filter((message) => message.thread === shot.thread);
    const matchIndex = topicMessages.findIndex(checkIsMatch);
    if (matchIndex >= 0) return topicMessages.slice(Math.max(0, matchIndex - (shot.before ?? defaultMessagesBefore)), matchIndex + 1);
  }
  return null;
}
