import type { SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { addAgentBinDirToPath, getAgentEnvironment } from '../utils/agentEnvironment';

/**
 * @description Claude Code flags a session needs because of its conversation's
 * platform. Outside Telegram (Jira connector plan J2b R1, J3b R7):
 *
 *  - `--setting-sources project,local` — the session does not load the
 *    operator's personal Claude setup as USER config: no user-level `CLAUDE.md`
 *    (personal instructions, which may point at the operator's own
 *    credentials), no user settings, no user hooks, no user skills. Probed on
 *    Claude Code 2.1.287: the user memory, the user `model` setting and the user
 *    skills are gone while the subscription login still works. Project memory
 *    still loads from the working folder AND every parent folder, and for a
 *    folder under HOME that walk reads `~/.claude/CLAUDE.md` back in (probed:
 *    present under HOME, absent in /tmp). The flag alone is therefore enough
 *    only for a working folder outside HOME whose parents hold no Claude memory.
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

/**
 * @description The environment a session starts with because of its platform:
 * outside Telegram only the agent allowlist (R32 — never the instance's own
 * variables, its tracker token among them), with the tool folder of the connector's `agentBinaries` first on
 * its PATH; `null` — a Telegram topic's wrapper
 * keeps `env -u ANTHROPIC_API_KEY` and inherits the tmux session environment:
 * the bot's own on the default server, the minimal server environment of
 * `getTmuxExecEnv` on a private one (every instance that serves Jira).
 */
export function getClaudePlatformEnvironment(key: SessionKey): Record<string, string> | null {
  return checkIsTelegramKey(key) ? null : addAgentBinDirToPath(getAgentEnvironment());
}
