import type { SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';

/**
 * @description Claude Code flags a session needs because of its conversation's
 * platform (Jira connector plan J2b, R1). Outside Telegram the native
 * `AskUserQuestion` is disallowed: a tracker has no surface to show it, and a
 * pending native question holds every wake-up, so the request would hang with
 * no alert. The agent asks through `answer_request` kind `question` instead.
 *
 * `--disallowedTools` takes SEVERAL values, so a caller must place these flags
 * right before another option — a positional argument after them would be read
 * as a second tool name.
 */
export function getClaudePlatformToolFlags(key: SessionKey): string[] {
  return checkIsTelegramKey(key) ? [] : ['--disallowedTools', 'AskUserQuestion'];
}
