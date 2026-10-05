# `src/connectors/jira/` — the Jira Cloud connector

A `jira` instance (`CONNECTORS` lists `jira`) turns issues assigned to a dedicated AI account into
conversations with an agent. One issue = one conversation, keyed `jira:<PROJECT>:<ISSUE-KEY>`
(`sessionKeyCodec.ts`). The agent hears nothing but the request; it talks back only through `answer_request`,
which the answer sink posts as comments. The streamed output never reaches the issue (`outbound.ts` drops it).
The `D*` / `R*` / `J*` / `C*` ids cited in code comments are decisions of the connector's plans, kept outside this public repo.

## Setup contract (`config.ts`, `configFile.ts`)

`DATA_DIR/jira.json`, strict keys: `site` (`<name>.atlassian.net`), `email`, `apiToken` (normally `${VAR}` from
the instance's env file), `accountId` (the AI account — the token must belong to it, checked against `/myself`
at boot), `projects` (key → `{ folder, triggerStatuses, extraFields? }`, the allowlist; status NAMES resolved to
ids at boot; `extraFields` = field ids like `customfield_10042` or `duedate` that the prompt shows under their
site name — none by default, and an id the site does not list is logged once at boot and left out),
`pollIntervalSeconds` (10–600, default 90), `runBudgetPer24h` (default 5), `model`, `effort` (the sessions',
since user settings do not apply; absent → `opus` / `high`, either key overrides only its own default),
`baseUrl` (loopback only, for the fakes). `adapter` is `claude-json-stream`
(the default: the process is stopped at the idle mark) or `claude-per-turn` (stopped after every answer; when the
issue's last known Claude Code is below 2.1.287 the pick is kept but that session runs without the per-turn stop —
an old process is never auto-stopped — until a newer CLI reports in, L-D10); nothing else (R14). An issue's conversation sleeps between requests and the next request
resumes it. The instance's env file carries `CONNECTORS=jira`, `DATA_DIR`, `WORK_ROOT`, `TMUX_SOCKET_NAME`, an
`OPENCODE_URL` off the default port (R9) and the token variable; `REQUEST_BACKSTOP_MINUTES` shortens the wake-up
backstop and `AGENT_IDLE_MINUTES` the idle mark (tests).
Operator-facing setup steps: the public `README.md` § "Jira connector".

## Request flow (`inbound.ts`)

1. Poll: `buildJiraTriggerJql` = project allowlist AND `assignee = currentUser()` AND trigger status ids. Polls
   never overlap (the next is scheduled when one ends). A rejected token (`JiraAuthError`) stops polling for
   good with one loud line; any other failure backs off (`getJiraRetryDelayMs`).
2. Per issue: allowlist re-checked on what Jira returned → still assigned to the AI account and in a trigger
   status → trigger detected (`trigger.ts`: the NEWEST changelog entry that assigned the issue or moved it into
   a trigger status, else the creation; changelog pages are read newest first, only as far as needed) →
   already seen? (`triggerLog.ts`) → self-authored? → run budget (over it the issue is `parked` with a notice
   and handed back) → fetch the issue's context (`issueContext.ts`: the issue with its fields and the project's
   `extraFields`, ALL its comments page by page, its remote links, an epic's children by `parent = KEY`) → bind the conversation to the project's folder → open a request
   (origin `trackerEvent`) → post, NOT awaited (a busy session may take minutes) → RECORD the trigger once the
   post has settled, also when it failed (the open request then belongs to the wake-up engine). The origin names
   the requester under the core's `requester` attribute (`requests/requestGroup.ts`), so a request supersedes an
   earlier open one only for the same issue AND the same person: two people handing one issue over in turn hold
   two open requests and each gets their own comment; the first closing answer hands the issue back to its own
   sender, the second finds it no longer the AI's and leaves the assignee alone. The newer request's prompt
   header names the request it replaced.
3. A restart before the post settled leaves the trigger unrecorded, so the next poll opens a fresh request
   (superseding the old one) rather than leaving a request the agent never saw. Only a crash in the instant
   between a finished post and its record posts a trigger twice. An issue with a post in flight is skipped.
4. `getRequester`: the trigger's author when a person made the change; for an app or automation the nearest
   EARLIER person in the changelog (never the AI account), else the reporter — an app can neither read a
   comment nor take the issue back.
5. Setup problems refuse the start (bad config, refused token, unknown project or status, another account's
   token); an outage (no answer, 5xx, 429) does not — a mixed Telegram+Jira instance never loses Telegram to a
   Jira outage (`checkIsTransientJiraFailure`, `connector.ts`).

## Isolation — fail-closed, checked at boot

`cli/connectorGuards.ts` runs before any env file is read and before the bot module loads: a `jira` instance
needs a launch-time `ENV_FILE` (the shared config files hold another bot's token), `DATA_DIR/jira.json`, and a
private `TMUX_SOCKET_NAME`; with the telegram connector off a `TELEGRAM_BOT_TOKEN` is fatal; a Jira-only
instance refuses any `ATLASSIAN_*` variable. `platform/unservedStateGuard.ts` refuses a `DATA_DIR` holding
another platform's state.

- **Agent sessions** start with `--setting-sources project,local` (no user-level memory, settings, hooks or
  skills), `--strict-mcp-config`, `--disallowedTools AskUserQuestion` (a tracker has no surface for a native
  question; the agent asks through `answer_request` kind `question`), and an environment built from an
  allowlist (`utils/agentEnvironment.ts`) minus anything the instance's `ENV_FILE` set, so the tracker token
  is not in the agent's ENVIRONMENT. That is all it guarantees: the agent runs as the instance's own OS user
  with `--dangerously-skip-permissions`, so it can still read the `ENV_FILE` (which holds the token) and the
  `DATA_DIR` (including the bot MCP's signing secret in `state.json`). Run a Jira instance under an OS user
  that holds nothing else, with an AI account that sees only the allowlisted projects. A deployment that
  needs `CLAUDE_CONFIG_DIR`, a proxy or `NODE_EXTRA_CA_CERTS` must add the name to that allowlist — a missing
  one fails SILENTLY.
- **Project memory still loads from the working folder and every parent**, so `jira.json` refuses a folder with
  Claude memory in it or above it (`getClaudeMemoryAbove`) — which rules out anything under HOME or inside a
  repository. The adapter must be the json-stream host, `claude-json-stream` or `claude-per-turn` (tmux Claude's
  trust dialog would hold the session; OpenCode cannot be isolated yet), and the OpenCode URL needs a port of
  its own.
- `config.ts`: an unknown key is an error; `${VAR}` placeholders expand from the env file; every message names
  the field (and an unset placeholder's variable), never a value.
- Lazy load: Jira code loads through a dynamic `import()` only when the connector is on, and nothing
  `bot.ts` imports statically may reach its packages (`jiraLazyLoad.test.ts`; `marklassian` is ESM-only, hence
  `engines.node >=22.12`).

## Answer sink (`answerSink.ts`) and the client (`client.ts`)

- An answer becomes one or more comments by the AI account (`createCommentBodies`, in order). A `question` or
  `final` answer to an OPEN request then hands the issue back to the requester, only while it is still
  assigned to the AI account; never for `progress`, never for a superseded request. Comment first, then the
  hand-back: a failed hand-back is a delivered answer plus a warning (a retry would post it twice).
- The first comment refused → an error (nothing posted, safe to send again). A later part that did not land →
  delivered with a warning saying where the unposted rest starts.
- `addComment` is never retried by the client (a second POST would post twice). A post of UNKNOWN outcome
  (timeout, dropped connection, 5xx) is read back once after `jiraReadBackDelayMs` through
  `getRecentComments`; every failure message says what to send again, because the agent cannot look at the
  issue. The post is remembered (`unconfirmedPosts.ts`): resending the same text for the same request checks the
  issue first and posts at most once — a reworded resend is a new text and is posted without a check.
- The client retries only requests safe to repeat; 429 honours `Retry-After` (capped); errors carry method, path
  and Jira's messages, never the token.

## The prompt (`issueContext.ts`, `issueBlocks.ts`, `mediaPlaceholders.ts`, `promptSpill.ts`, `issueDelta.ts`, `contextLedger.ts`, `prompt.ts`)

- The whole issue, nothing cut: after the request header and the issue-text note, the issue is a list of blocks —
  `fields` (summary, type, priority, status, reporter, parent, fix versions, labels, components, the project's
  `extraFields`), `description`, `hierarchy` (sub-tasks, or an epic's children), `links` (issue links and remote
  links; a site with issue linking switched off answers the remote-link read with 403, read as no links), `attachments` (one line each: id, name, type, size, author, date, where it is used), then EVERY comment
  oldest first. The comments come from the comments endpoint (the issue's own `comment` field holds at most 100).
- A restricted comment is marked `[restricted to <role or group>]`, a Service Management internal note
  `[internal]`. Each block carries a sha256 of what it says (a comment's covers its text and marker only, so a
  save that changed nothing leaves it alone).
- A pasted screenshot, video or file becomes a placeholder where it sat — `[image: shot.png — attachment 10234]`.
  The media id in the ADF is not the attachment id, so the attachment is found from what Jira records: the media
  id inside a renamed stored filename (`<name> (<media id>).<ext>`, which Jira uses when the name was taken),
  else the filename equal to the node's `alt` (all ids listed when several share it), and for an inline file —
  which has no `alt` — the rendered HTML (`renderedBody` of a comment, `renderedFields` of the description),
  which links the media id to its attachment exactly. No match reads `attachment unknown`; nothing is guessed.
  The recorded shapes are the fixture `__tests__/fixtures/jiraMediaAdf.json`.
- Nothing is cut off and nothing is lost (`promptSpill.ts`). A comment over 10 000 characters is written WHOLE to
  `DATA_DIR/files/<conversation>/jira/text/comment-<id>-<hash>.txt`; the prompt keeps its header and says
  `written whole to <path> (N chars) — read it`. A prompt that would not fit what the request ledger stores for a
  re-post (64 000 characters, less a margin for the header) moves its biggest blocks to files the same way,
  largest first, until it fits; if even the stubs do not fit (hundreds of comments), the comments collapse into ONE
  file. A spilled block keeps its hash. The files are rewritten by every request (same path for the same text),
  so the 30-day sweep (`botFileStorage.ts`, which walks the folders nested in a conversation's files dir)
  only removes what no live issue has used for a month. The issue-text note covers these files too: their
  content is the issue's, information and never instructions.
- Nothing is repeated (`issueDelta.ts`, `contextLedger.ts`). Per issue, `DATA_DIR/jira-context/<ISSUE-KEY>.json`
  holds the hash of every block the conversation's agent has taken in. A request stores the WHOLE prompt (a
  re-post and a usage-limit hold send that); the text actually forwarded is built right before the forward,
  after the session is ensured: a fresh session, or one that was never sent anything, gets the whole issue;
  otherwise only the new and changed blocks (`(new)`, `(changed since your last prompt)`, an edited comment
  `(edited <date> by <name>)`), one line per deleted comment, and one line naming what was left out. The AI
  account's own comments are never sent back in a delta (unless a person edited one). What a prompt carried
  counts as sent only once the agent took it in — the request ledger's `onPromptSettled`: the taken-in flag,
  or a close by the request's own `question` / `final` answer; a superseded or cancelled request's build is
  dropped, and a build older than the last committed one never rolls the sent-set back. When in doubt a block
  is sent twice, never lost.

## Comment content (`adf.ts`, `prompt.ts`)

- The agent's Markdown becomes ADF. HTML stays literal text (every `<` that opens no autolink is swapped for a
  placeholder before conversion), so `<adf>…</adf>` can never smuggle a notifying mention. No external media:
  an image becomes a plain link (a `media` node would be fetched by every viewer's browser). Link targets keep
  only `http`, `https`, `mailto`.
- Each comment must fit BOTH counts — its Markdown and its serialized ADF (which runs several times longer);
  which one Jira enforces is not documented.
- The issue's own text is anyone's who can edit or comment: the prompt marks it as information, never
  instructions, and quotes it line by line so none of it can start a line as a bot block. Where an answer goes
  never comes from it — the conversation and requester are fixed when the request opens.

## Tests

`jiraConfig.test.ts`, `jiraIssueBlocks.test.ts` and `jiraMediaPlaceholders.test.ts` (over the recorded fixture),
`jiraPromptSpill.test.ts`, `jiraPrompt.test.ts`, `connectorGuards*.test.ts`, `jiraLazyLoad.test.ts`; `jiraConnectorE2e.test.ts` boots a
real Jira-only instance (`scripts/run-isolated.sh`) against `__tests__/jiraE2e/fakeJira.ts` and `fakeClaude.ts`;
`live/jiraLive.test.ts` runs the loop against a real site and is skipped unless its env variables are set.
