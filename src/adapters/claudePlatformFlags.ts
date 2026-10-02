import type { SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';

/**
 * @description Claude Code flags a session needs because of its conversation's
 * platform. Outside Telegram (Jira connector plan J2b R1, J3b R7):
 *
 *  - `--setting-sources project,local` — the session never sees the operator's
 *    personal Claude setup: no user-level `CLAUDE.md` (it names where the
 *    operator's own tracker credentials live), no user settings, no user hooks,
 *    no user skills. Probed on Claude Code 2.1.287: the user memory, the user
 *    `model` setting and the user skills are gone while the subscription login
 *    still works.
 *  - `--disallowedTools AskUserQuestion` — a tracker has no surface for a native
 *    question, and a pending one holds every wake-up, so the request would hang
 *    with no alert; the agent asks through `answer_request` kind `question`.
 *
 * `--disallowedTools` takes SEVERAL values, so it comes last and a caller must
 * place these flags right before another option — a positional argument after
 * them would be read as a second tool name.
 */
export function getClaudePlatformFlags(key: SessionKey): string[] {
  if (checkIsTelegramKey(key)) return [];
  return ['--setting-sources', 'project,local', '--disallowedTools', 'AskUserQuestion'];
}
