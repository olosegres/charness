# agent-plugin — the skills Charness gives its agents

A Claude Code plugin (`charness`) whose skills every bot-started agent session gets: Telegram topics and Jira
conversations, Claude Code and OpenCode. The operator's own sessions outside the bot do not get them.

| Skill | What it is for |
|-------|----------------|
| `charness-manager` | Orchestrating detached workers in a bot session: the delivery loop, the one-worker queue, the watch check that fires when a worker exits OR stalls (`schedule_create` + `checkCommand`), accounts through `claude_profiles`, talking to the user through the bot's tools |
| `charness-delegate-claude` | Launching, watching and resuming a detached `claude -p` worker (`summarize-events.py` reads its event log) |
| `charness-delegate-opencode` | The same for `opencode run` |

## How a session gets them

- **Claude Code:** every bot launch of an agent session (json-stream and tmux, start and resume) carries
  `--plugin-dir <package>/agent-plugin`. Claude Code namespaces plugin skills by the plugin name and the skill's
  FOLDER: `charness:charness-manager`. `--setting-sources project,local` (a Jira session) does not drop them.
- **OpenCode:** the `opencode serve` the bot starts gets `OPENCODE_CONFIG_DIR=<DATA_DIR>/opencode-config`, a
  bot-owned folder whose `skills` is a symlink to this folder's `skills/`. OpenCode adds those skills to the
  project's and the user's own; it writes files (`.gitignore`) into that folder, which is why it is not this
  folder. An operator who set `OPENCODE_CONFIG_DIR` keeps it, and OpenCode topics then go without these skills.
- **Switched off:** the «Bot skills» switch (`/bot_skills`, `botSkills` in `settings.json`; `src/utils/botSkills.ts`) drops
  the `--plugin-dir` of a Claude conversation at its next start or resume, and the hint to load `charness-manager` from the
  bot MCP's instructions; the OpenCode server follows the instance value only (replaced at the bot's next start).

## Rules for a skill here

- Folder name = frontmatter `name` = `charness-<role>`. OpenCode has no namespaces: a skill named like a
  project's or user's own one (`manager`) would replace it there.
- The watch recipe in `charness-manager` is the `workerWatchCheckCommand` constant of
  `src/scheduler/workerWatch.ts` verbatim, with its cron, its silent pin and its status arguments (the bot posts the
  topic's status line; a unit test holds them equal), and every bot tool a skill names must exist on the bot's MCP surface.
- Written for this public repository: no real ids, paths or names. The shared rules repository keeps its own
  `manager`; a change wanted in both is ported by hand.
- Shipped in the npm package (`files`); a commit that touches only this folder still counts as a release change.
  A Claude session reads a new version at its next start, OpenCode when it next creates the folder's instance.
