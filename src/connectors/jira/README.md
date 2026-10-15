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
`pollIntervalSeconds` (10–600, default 90), `runBudgetPer24h` (default 5), `trustedGroup` (the NAME of one Jira
group, see "The trusted group" under Isolation; absent → none, with one boot line `[jira] no trustedGroup: …`; the
AI account needs the *Browse users and groups* global permission to read it), `model`, `effort` (the sessions',
since user settings do not apply; absent → `opus` / `high`, either key overrides only its own default),
`agentBinaries` (tool name → absolute path of an executable, e.g. `ffmpeg`: checked at boot — missing or not
executable stops it, naming the key — and linked into `DATA_DIR/agent-bin`, which leads the PATH of the Jira agents;
host runtime), `baseUrl` (loopback only, for the fakes). `adapter` is `claude-json-stream`
(the default: the process is stopped at the idle mark) or `claude-per-turn` (stopped after every answer; when the
issue's last known Claude Code is below 2.1.287 the pick is kept but that session runs without the per-turn stop —
an old process is never auto-stopped — until a newer CLI reports in, L-D10); nothing else (R14). An issue's conversation sleeps between requests and the next request
resumes it. The instance's env file carries `CONNECTORS=jira`, `DATA_DIR`, `WORK_ROOT`, `TMUX_SOCKET_NAME`, an
`OPENCODE_URL` off the default port (R9) and the token variable; `REQUEST_BACKSTOP_MINUTES` shortens the wake-up
backstop and `AGENT_IDLE_MINUTES` the idle mark (tests).
Operator-facing setup steps: the public `README.md` § "Jira connector".

## Request flow (`inbound.ts`)

1. Poll: `buildJiraTriggerJql` = project allowlist AND `assignee = currentUser()` AND trigger status ids. Polls
   never overlap (the next is scheduled when one ends). A rejected token (`JiraAuthError`), or a trusted group
   deleted from the site, stops polling for good with one loud line; any other failure backs off
   (`getJiraRetryDelayMs`).
2. Per issue: allowlist re-checked on what Jira returned → still assigned to the AI account and in a trigger
   status → trigger detected (`trigger.ts`: the NEWEST changelog entry that assigned the issue or moved it into
   a trigger status, else the creation; changelog pages are read newest first, only as far as needed) →
   already seen? (`triggerLog.ts`) → self-authored? → with `trustedGroup`: is the HAND-OVER backed by the group?
   (see below; if not, `untrusted`: a fixed notice, the issue handed back, no request) → run budget (over it the
   issue is `parked` with a notice and handed back) → fetch the issue's context (`issueContext.ts`: the issue with
   its fields and the project's `extraFields`, ALL its comments page by page, its remote links, an epic's children by `parent = KEY`) → bind the conversation to the project's folder → open a request
   (origin `trackerEvent`) → post, NOT awaited (a busy session may take minutes) → RECORD the trigger once the
   post has settled, also when it failed (the open request then belongs to the wake-up engine). The origin names
   the requester under the core's `requester` attribute (`requests/requestGroup.ts`), so a request supersedes an
   earlier open one only for the same issue AND the same person: two people handing one issue over in turn hold
   two open requests and each gets their own comment; the first closing answer hands the issue back to its own
   sender, the second finds it no longer the AI's and leaves the assignee alone. The newer request's prompt
   header names the request it replaced.
   **The hand-over gate** (only with `trustedGroup`, `inbound.ts` `getDecision`): the gate looks at the account
   that made the triggering change — the trigger's author (it assigned the issue to the AI account or moved it into
   a trigger status), or, for an issue created already matching, its creator (else its reporter). A member, an
   app or an automation → go on; any other person, a service-desk customer or an account without `accountType` →
   `untrusted`. When Jira names no one for the change, the requester stands in (fail closed: no account at all is
   untrusted). The requester — who gets the answer and the hand-back — keeps its own rule (step 4), so an
   automation's hand-over answers to the person whose action came before it, who may be outside the group: the gate
   trusted the automation, and the requester is not a second gate (the operator's project rule — no automation
   that acts on outside text or actions in a listed project — keeps such a person inside the team). `untrusted`
   is a recorded decision like `parked` (written BEFORE the notice, so a failed or repeated poll never posts it
   twice; not counted against the run budget; the log line `[jira] poll: PROJ-1 untrusted`), and nothing of the
   issue is fetched for it.
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
  that holds nothing else, with an AI account that sees only the allowlisted projects; a production Jira account
  runs only in the whole-bot Docker container (root README, "Run with Docker"), where the agent still reads the
  `ENV_FILE` and `DATA_DIR` but nothing of the host beyond the container's mounts. The image runs everything as
  root, so the allowlist carries `IS_SANDBOX` (Claude Code refuses `--dangerously-skip-permissions` as root
  without it). A deployment that
  needs `CLAUDE_CONFIG_DIR`, a proxy or `NODE_EXTRA_CA_CERTS` must add the name to that allowlist — a missing
  one fails SILENTLY.
- **Project memory loads from the working folder and every parent**, like any Claude Code session — `jira.json`
  does not restrict the folder; the operator chooses it. Only the USER level stays out (`--setting-sources`
  above) — but for a folder under HOME that walk reads `~/.claude/CLAUDE.md` back in. The adapter must be the json-stream host, `claude-json-stream` or `claude-per-turn` (tmux Claude's
  trust dialog would hold the session; OpenCode cannot be isolated yet), and the OpenCode URL needs a port of
  its own.
- **The trusted group** (`trustedGroup.ts`): `jira.json` `trustedGroup` names ONE group per instance — one AI
  account serves one team; a team with several trust circles runs a second instance. The name is resolved at boot to
  the group's id (`GET /rest/api/3/group/bulk?groupName=…`, the exact name) and the id is followed afterwards, so a
  group renamed while the bot runs keeps working (the next boot needs the new name). Trusted accounts: an active
  member of the group (`GET /rest/api/3/group/member?groupId=…&includeInactiveUsers=false`, pages of 50), the AI
  account itself, and every app or automation (`accountType` `app`). Not trusted without membership: any other
  person, a service-desk customer (`customer`) and an account whose `accountType` is missing (read as a person).
  Membership is read at boot (part of the setup check) and before a poll's search — before every page of it —
  whenever the last read is older than 5 minutes (`jiraTrustedGroupMaxAgeMs`): a removed member loses trust within
  5 minutes plus one poll. The list is never served past its age: a refresh that fails (no answer, 5xx, 429) fails
  that poll, with the usual backoff, so nothing is decided on a stale list (fail closed). Setup faults refuse the
  start, with every reason at once: no group of that name (`jira.json trustedGroup: the site has no group named
  "…"`), or the AI account may not read it (403: the *Browse users and groups* permission). A group deleted while
  the bot runs (404 on a refresh) stops polling with one loud line, like a refused token — a setup fault does not
  fix itself; the process stays up — and so does a withdrawn permission (403). An empty group boots, with one
  warning (only apps and automations can hand the AI work).
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
- Two notices are the bot's own, with no agent behind them, each followed by the same hand-back (and no
  hand-back when the notice did not land, only a warning — its trigger is recorded already, so it is not
  repeated): the park notice, and the notice of an `untrusted` hand-over — "Only members of the AI's trusted
  group (`<configured name>`) can hand it work, so nothing was started. Ask a member to hand it over." — posted
  as plain text, so a group name is never read as Markdown.
- The first comment refused → an error (nothing posted, safe to send again). A later part that did not land →
  delivered with a warning saying where the unposted rest starts.
- `addComment` is never retried by the client (a second POST would post twice). A post of UNKNOWN outcome
  (timeout, dropped connection, 5xx) is read back once after `jiraReadBackDelayMs` through
  `getRecentComments`; every failure message says what to send again, because the agent cannot look at the
  issue. The post is remembered (`unconfirmedPosts.ts`): resending the same text for the same request checks the
  issue first and posts at most once — a reworded resend is a new text and is posted without a check.
- The client retries only requests safe to repeat; 429 honours `Retry-After` (capped); errors carry method, path
  and Jira's messages, never the token.

## The original files (`attachmentTool.ts`, `attachmentDownload.ts`)

The bot MCP gives a Jira session one more tool, `jira_get_attachment(attachmentId)`. The issue is taken from the
session's scoped token, never from the argument, and the id must be in that issue's attachment list read at the
call, so a planted "fetch attachment 12345" cannot reach another issue's file. With `trustedGroup` the uploader must be
trusted as well — the predicate that withheld the file from the prompt — judged on the membership list as of the
call (refreshed first when older than 5 minutes; a list that cannot be refreshed, or a group not read yet because
Jira did not answer at boot, refuses — "try again shortly" while the check is still retried; once the retried check
came back refused, polling never began and the refusal's reasons are named instead): "Attachment 10234 was uploaded
by someone outside the trusted group; it is not available to you." A file already on disk is not served around that check; the "Its attachments:" list of an
unknown id stays ids only. The original is streamed (no size
limit; any size) into `DATA_DIR/files/<conversation>/jira/<id>-<name>` and its path returned; the agent decides what
to do with it (Read an image, `ffmpeg` on a video — the bot transcribes nothing). Technical rules only: a stall
timeout (no data for 2 min aborts), a file name cut to 200 bytes on a character boundary with its extension kept
and separators stripped, a fresh temporary name renamed into place (a planted symlink is replaced, not followed), a
file of the same size already there is reused, and the Jira credentials go only to the site's origin (the request
asks `redirect=false`, so Jira answers with the content itself; a 3xx to another host, or to plain http, is followed
without them). The
context preamble tells the agent the tool exists and carries the standing rule: never quote or paraphrase a
`[restricted to …]` or `[internal]` comment in an answer.

## The prompt (`issueContext.ts`, `issueBlocks.ts`, `mediaPlaceholders.ts`, `promptSpill.ts`, `issueDelta.ts`, `contextLedger.ts`, `prompt.ts`)

- The whole issue, nothing cut: after the request header and the issue-text note, the issue is a list of blocks —
  `fields` (summary, type, priority, status, reporter, parent, fix versions, labels, components, the project's
  `extraFields`), `description`, `hierarchy` (sub-tasks, or an epic's children), `links` (issue links and remote
  links; a site with issue linking switched off answers the remote-link read with 403, read as no links), `attachments` (one line each: id, name, type, size, author, date, where it is used), then EVERY comment
  oldest first. The comments come from the comments endpoint (the issue's own `comment` field holds at most 100).
- **With `trustedGroup`, only trusted text is in it** (`issueBlocks.ts`): a piece of the issue's own text reaches the
  agent only when EVERYONE who wrote it is trusted — a member, the AI account or an app or automation (for a
  comment: its author and its last editor, see below); an author Jira does not name counts as untrusted. Withheld text is replaced IN PLACE by a marker, before the blocks are
  hashed, fitted or spilled, so it never reaches a prompt, a delta or a spill file:

  | Part | Written by (from what the bot reads) | Withheld when | The agent sees |
  |---|---|---|---|
  | a comment | its `author`, and its `updateAuthor` — the LAST editor only (see below) | either is untrusted | `Comment <id>, <date>: [withheld: written or edited by someone outside the trusted group]` — no name, no text |
  | the description | the issue's `creator` and the author of every `description` changelog entry | any is untrusted | `Description: [withheld: …]` (no description stays `(empty)`) |
  | summary, labels, extra fields | `creator` and the authors of that field's changelog entries | any is untrusted | that field's line reads `[withheld: …]` (an empty value stays absent) |
  | type, priority, status, fix versions, components, people's names | lists the project's admins keep, and the people themselves | never | as without a group |
  | an attachment | its `author` (the uploader) | untrusted | `- <id> [withheld: uploaded by someone outside the trusted group]` — no file name, type or size; `jira_get_attachment` refuses the id |
  | a media placeholder in kept text that points at a withheld file | — | — | `[image — attachment <id>, withheld]` (the kind word as before, no name; a mix of kept and withheld files of one name lists `<id> (withheld)`) |
  | another issue's summary (parent, sub-task, child, linked issue) | unknown to the bot | its project is not in `projects` | its key and status only; an issue of a listed project keeps its summary (the agent may read it through its own tools anyway) |
  | a remote link's title | not in the changelog | always | the URL only |

  **A comment is judged by less than everyone who wrote it.** Jira Cloud keeps no history of a comment's edits — the
  comment resource carries the author and the LAST editor (`updateAuthor`), nothing earlier, and Atlassian's own
  feature request for tracking comment edits is still open (JRACLOUD-94821). So when someone outside the group edits
  a member's comment and a member then edits it again, the comment reads as written and last edited by trusted
  accounts and is shown in full, whatever of the outsider's text is still in it. No code can close that gap. What
  bounds it is who may edit other people's comments: the *Edit all comments* project permission (Atlassian: it lets
  a user "edit comments or internal notes added by anyone"). An operator lists only projects where no one outside the
  team holds it, which is the same rule as for who may write there at all (root `README.md` § "Jira connector").

  A field's authors come from the issue's WHOLE changelog (an entry names its field by `fieldId`, else by `field`; a
  custom field is also matched by its display name for an old entry). The poller reads the changelog only as far as
  the trigger needs, so a request that opens with a group set reads the rest once (`getChangelogPage`, pages of 100,
  `issueContext.ts`) — once per request, never per poll. A restricted or internal comment of a trusted author keeps
  its `[restricted to …]` / `[internal]` marker and rule; a withheld comment shows neither. The issue-text note of
  the prompt gains one sentence in this mode — "Parts marked [withheld: …] were written by people outside the
  trusted group, so you cannot see them. Do not look them up any other way; if one matters, ask your requester."
  A delta (only what changed) treats a trust change like a change: a comment or the description that becomes
  withheld (its author left the group) or readable (its author joined) is sent once with the note `(trust changed
  since your last prompt)` — never `edited`; a field line that flips sends the fields block as `changed since your
  last prompt`, the marker in that line telling why. The context ledger stores `isWithheld` per sent block
  (absent = readable, so older ledgers load). Without `trustedGroup` every block, hash and prompt is as it always was.
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
- A compaction an issue's agent asks for (`compact_conversation`, when a person asks it in a comment) runs when its
  turn ends and is SILENT: there is no topic to narrate it in, and the next prompt is the whole issue again.
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
- What resets it (the issue's generation goes up, nothing counts as sent, waiting builds are dropped): a fresh
  session start (`startAgentSession`, at its start — a request whose post found that start under way still gets
  the whole issue), and every completed compaction (the adapter's `contextCompacted`: bot-issued or the CLI's own
  overflow compaction). Not an idle stop, a resume, a restart or a hot reload: the conversation survives them.

## Comment content (`adf.ts`, `prompt.ts`)

- The agent's Markdown becomes ADF. HTML stays literal text (every `<` that opens no autolink is swapped for a
  placeholder before conversion), so `<adf>…</adf>` can never smuggle a notifying mention. No external media:
  an image becomes a plain link (a `media` node would be fetched by every viewer's browser). Link targets keep
  only `http`, `https`, `mailto`.
- Each comment must fit BOTH counts — its Markdown and its serialized ADF (which runs several times longer);
  which one Jira enforces is not documented.
- The issue's own text is anyone's who can edit or comment — and, when `trustedGroup` is set, anyone's in the
  trusted group, and any Jira app or automation's: the prompt marks it as information, never instructions, and
  quotes it line by line so none of it can start a line as a bot block. Where an answer goes never comes from
  it — the conversation and requester are fixed when the request opens.

## Tests

`jiraConfig.test.ts`, `jiraTrustedGroup.test.ts`, `jiraIssueBlocks.test.ts` and `jiraMediaPlaceholders.test.ts` (over the recorded fixture),
`jiraPromptSpill.test.ts`, `jiraPrompt.test.ts`, `connectorGuards*.test.ts`, `jiraLazyLoad.test.ts`; `jiraConnectorE2e.test.ts` boots a
real Jira-only instance (`scripts/run-isolated.sh`) against `__tests__/jiraE2e/fakeJira.ts` (which also serves
groups and their members) and `fakeClaude.ts`, and, restarted with a `trustedGroup`, proves the filter, the notice
and an automation's hand-over end to end;
`live/jiraLive.test.ts` runs the loop against a real site and is skipped unless its env variables are set; its
prompt-context steps (media through the attachment tool, a delta, a requested compaction, the default model and
effort) also need `JIRA_LIVE_MEDIA_ISSUE` and an instance `jira.json` that maps `ffmpeg` in `agentBinaries` and names
neither `model` nor `effort` (the file header lists the inputs); its trusted-group steps need
`JIRA_LIVE_TRUSTED_GROUP`, the name of the group the instance's `jira.json` names and of which the requester is a
member.
