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
`repos` (per project, optional: the repository folder names its issues work on — the shared todo boards group the
conversations by them, `../../todos/README.md`; the connector also keeps, in memory, the summary each issue's prompt
last showed the agent — `null` when the trusted group withholds it — for the boards' labels), `pollIntervalSeconds` (10–600, default 30), `runBudgetPer24h` (default 5), `trustedGroup` (the NAME of one Jira
group, see "The trusted group" under Isolation; absent → none, with one boot line `[jira] no trustedGroup: …`; the
AI account needs the *Browse users and groups* global permission to read it), `wakeOnMention` (boolean: whether an
@-mention of the AI account in a comment wakes it, see "An @-mention wakes the AI"; absent → on exactly when a
`trustedGroup` is set; `true` without a group is refused at boot, because without one anyone who can comment could
start the AI; `false` turns it off, with one boot line), `mentionMode` (`"answer"` — absent — or `"act"`: what a mention asks
of the agent, see "An @-mention wakes the AI"; `"act"` without a group is refused at boot; the boot line says which),
`wakeOnComment` (boolean: whether a trusted person's comment on an issue handed to the AI reaches its agent, see "A comment
on an issue handed to the AI reaches it"; absent → on exactly when a `trustedGroup` is set — it fixes a delivery bug, it
widens nobody's rights; `true` without a group is refused at boot; `false` keeps the old behaviour; one boot line says
which), `model`, `effort` (the sessions',
since user settings do not apply; absent → `opus` / `high`, either key overrides only its own default),
`agentBinaries` (tool name → absolute path of an executable, e.g. `ffmpeg`: checked at boot — missing or not
executable stops it, naming the key — and linked into `DATA_DIR/agent-bin`, which leads the PATH of the Jira agents;
host runtime), `operatorIssue` (an issue key: the bot's own channel to its operator, see «The operator issue» below; read at boot —
one the AI account cannot see refuses the start), `operatorAccountIds` (1–5 account ids mentioned on each operator alert that asks
them to act; needs `operatorIssue`), `baseUrl` (loopback only, for the fakes). `adapter` is `claude-json-stream`
(the default: the process is stopped at the idle mark) or `claude-per-turn` (stopped after every answer; when the
issue's last known Claude Code is below 2.1.287 the pick is kept but that session runs without the per-turn stop —
an old process is never auto-stopped — until a newer CLI reports in, L-D10); nothing else (R14). An issue's conversation sleeps between requests and the next request
resumes it. The instance's env file carries `CONNECTORS=jira`, `DATA_DIR`, `WORK_ROOT`, `TMUX_SOCKET_NAME`, an
`OPENCODE_URL` off the default port (R9) and the token variable; `REQUEST_BACKSTOP_MINUTES` shortens the wake-up
backstop and `AGENT_IDLE_MINUTES` the idle mark (tests).
Operator-facing setup steps: the public `SETUP.md` § "Jira setup".

## Request flow (`inbound.ts`)

1. Poll: `buildJiraTriggerJql` = project allowlist AND `assignee = currentUser()` AND trigger status ids — and,
   with mention wakes on, OR `comment ~ currentUser() AND updated >= -<n>m` (see "An @-mention wakes the AI").
   Polls never overlap (the next is scheduled when one ends). A rejected token (`JiraAuthError`), or a trusted group
   deleted from the site, stops polling for good with one loud line; any other failure backs off
   (`getJiraRetryDelayMs`).
2. Per issue: allowlist re-checked on what Jira returned → still assigned to the AI account and in a trigger
   status → trigger detected (`trigger.ts`: the NEWEST changelog entry that assigned the issue or moved it into
   a trigger status, else the creation; changelog pages are read newest first, only as far as needed) →
   already seen? (`triggerLog.ts`) → self-authored? → with `trustedGroup`: is the HAND-OVER backed by the group?
   (see below; if not, `untrusted`: a fixed notice, the issue handed back, no request) → run budget (over it the
   issue is `parked` with a notice and handed back) → a task-agent slot (see "The cap on task agents" below; an issue
   with no free slot is `queued`, told so once, and decided again by every poll until it is first in the list and a slot is
   free) → fetch the issue's context (`issueContext.ts`: the issue with
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
   a trigger status), or, for an issue created already matching, its creator (else its reporter). A member, or an
   app or an automation `trustedApps` allows (see «The trusted group») → go on; any other person, an app that
   `trustedApps` does not list, a service-desk customer or an account without `accountType` → `untrusted`. When
   Jira names no one for the change, the requester stands in (fail closed: no account at all is untrusted). The
   requester — who gets the answer and the hand-back — keeps its own rule (step 4), so a trusted automation's
   hand-over answers to the person whose action came before it, who may be outside the group: the gate trusted the
   automation, and the requester is not a second gate (the operator's project rule — no automation that acts on
   outside text or actions in a listed project — keeps such a person inside the team). An untrusted app's
   hand-over is refused like an outsider's — the same notice, the issue goes back to the requester that step 4
   names (an app is never the requester) — and the app is logged once (its name and id). `untrusted`
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

### The cap on task agents (`inbound.ts`, `trackers/taskAgentSlots.ts`)

The bot runs at most `taskAgents.maxConcurrent` (`settings.json`, default 5, `0` = no limit) tracker conversations at once — ONE
cap for every project and every tracker connector (`trackers/README.md`). A hand-over takes a slot (an open request of origin
`trackerEvent`), and so does the request a comment on a handed issue opens and — with `mentionMode: "act"` — a mention request (it
may start a build: its origin carries `mayAct`); a mention that answers only bypasses the cap and joins no list. The gate stands after
the trust check and the run budget (an untrusted or over-budget hand-over never waits for a slot) and before the issue is fetched:

- `checkIn` → `granted`: the request opens (the slot is reserved until it does) and `noteStarted` drops the issue's place;
  a failure while opening it (`noteStartFailed`) gives the reservation back and keeps the place — which no longer holds up the issues
  behind it, so the free slot goes to the next in line even in the same poll; the third failure in a row moves the place to the end.
- `queued`: the issue joins the bot's ONE persisted FIFO list (`state.json` `taskAgentWaitList`) and gets ONE short comment
  (`answerSink.ts` `postQueuedNotice` — no hand-back, the issue stays the AI's). Its trigger is NOT recorded: every poll decides
  it again (`waiting`, silent) and it starts when it is within the free slots counted from the head of the list. A newer
  hand-over of a waiting issue keeps its place.
- An issue that left the results of a complete poll, or no longer matches, leaves the list at once (`pruneWaiting`, `dropWaiting`). One
  conversation has one place, held by the trigger that waits: a hand-over's decision drops only a hand-over's place (and a comment's
  once the issue is no longer handed); a comment's or a mention's place is decided by its own scan, which reads its comment at every
  poll while it waits. An acting mention that waits outlives the mention window: its comment is decided again outside it, and its
  issue — which the search's `updated >= -<n>m` no longer returns — is read by its key (`getIssue`; an issue Jira no longer has gives
  the place up).
- A slot freeing — the ledger's `onRequestClosed`, or `onRequestWakeStopped` when the wake-up engine gives up on a request — and a raised
  cap wake the poll at once (`pollSoon`: a poll under way is not interrupted, the next one follows it immediately; a failing Jira keeps
  its backoff).

### A comment on an issue handed to the AI reaches it (`inbound.ts` `getCommentDecisions`)

With a `trustedGroup` (and `wakeOnComment` not `false`) every poll reads the new comments of an issue HANDED to the AI
account — assigned to it in a trigger status, its hand-over's trigger seen — once its `updated` moved, and a trusted
person's comment reaches the agent; a mention there is a comment like any other (the mention scan does not run on a
handed issue). Before, a comment on a handed issue never reached the agent at all — and a mention by the hand-over's
requester was recorded `covered` with nothing posted — so people unassigned and re-assigned an issue to get a word through.

- **Which comments.** A person's (`accountType` `atlassian`, or none) — not the AI account's, and not an app's or an
  automation's: a pipeline notice or a rule wakes nothing, it rides the next prompt. Newer than every comment a recorded
  prompt of the issue was built from: each request, mention and update records, with its decision, the newest comment id
  of the issue it fetched (`newestCommentId` in the trigger log, `getNewestShownCommentId`; comment ids grow site-wide,
  `compareJiraCommentIds`). That bound is persisted and needs no window, so a comment made while the bot was down — or Jira
  was — is still delivered once, and a compaction or a fresh session that made the agent forget what it was shown never
  makes an old comment new. Decisions recorded before the bound existed fall back to what the conversation was shown
  (`contextLedger.getShownBlock`) and, failing that, to comments written after the issue's last decision. Not decided yet
  (`comment:<id>`, nor `mention:<id>` from the mention scan).
- **Who may wake it.** The comment's author AND last editor trusted (`checkIsCommentTrusted`); otherwise it is
  `untrusted`: recorded, one log line, nothing posted — and its text stays withheld in every prompt.
- **The requests an update belongs to** (`listUpdateTargetRequests`): the conversation's open hand-overs and its open
  mentions that may act (`mayAct`: that is the work it does on the issue), none the wake-up engine gave up on; on an
  issue the AI account handed to itself (its seen hand-over is self-authored: an acting mention's «take up the work»),
  any open request — the one that took it up is still working on it, so a comment never opens a second agent there. When
  its own conversation has none, a request holding a task-agent slot in the conversation of an issue LINKED to it (its
  parent, a sub-task or child, either end of an issue link — `findLinkedWorkingRequest`; the agent created the issue and
  builds it in that run, say) gets the comments: an update of that request in that conversation whose header names the
  commented issue ("New on PROJ-2 (an issue linked to PROJ-1, which that request is on) …") and carries only its new
  comments (that conversation's context ledger is its own issue's) — recorded on the commented issue, its watermark the
  newest comment DELIVERED (one written between the scan and the read of the issue stays new). The agent's answer is a
  comment on PROJ-1: the header says so, and tells it to answer a person on PROJ-2 with a comment of its own there,
  @-mentioning them — it offers no `replyToCommentIds`, which resolves only comments shown in the request's own
  conversation. Linked issues are tried in the order parent, issue links, sub-tasks, children; only allowlisted projects
  count. When several hold a working request, the one the AI account tied the issue to wins: an issue link the AI account
  made (a `Link` entry of the commented issue's changelog, which the context already read), or the parent when the AI
  account created the issue or last changed its parent (`listIssueKeysTiedByAi`); with no such tie the first wins and one
  log line names the choice — a person who links the issue to another issue at work can then route its comments there.
  Only when nothing linked works on it does a comment open the issue's own request. On an issue NOT handed to the AI the
  comment scan does not run: there, only an @-mention reaches it, and a follow-up mention by the requester of an open
  acting mention goes into that work as an update (`isCovered` counts every slot-holding request with comment wakes on).
- **Such a request is open**: ONE **issue update** carries every new
  trusted comment of the poll (`buildJiraUpdatePrompt`: `[Issue update · request req_… is open]`, then the issue's delta —
  the whole issue for a session that does not know it). It is NOT a request: no request is opened, because a new one would
  supersede the hand-over (same requester) and strip its hand-back, or hand the issue to the commenter on its first final
  answer. It goes through the session post like a request's prompt: it waits for the running turn to end (a comment never
  interrupts a turn; after 10 minutes it is written in anyway), and the wake-up engine watches the turn it starts as that
  request's. Which request is settled right before the forward: the commenter's own open hand-over, else one with no
  requester, else the newest; the note names every hand-over open. When every hand-over finished meanwhile (the agent's
  final answer came first and handed the issue back), the update still reaches the agent, naming that request as
  finished: its answer to it becomes a comment and hands nothing back — waiting for the next poll instead would lose the
  comment whenever the hand-back left the issue no longer handed. The comments are recorded `update` once the post
  settled; an update that did not reach the session is decided again after a backoff (the poll interval doubled per
  failure, up to 15 minutes), so a session that cannot be started is not started at every poll.
- **The cap.** An issue gets at most `jiraIssueUpdatesPer24hMax` (20) updates in a rolling 24 h (one per post, counted
  off the trigger log's `update` lines). An account of the trusted group that comments as the agent's own tooling would
  otherwise loop — each comment the next poll's update, each answer another comment —; past the cap the comments stay
  undecided (`waiting`) and the issue is not scanned until the oldest counted update leaves the window
  (`getUpdateWindowEnd`); then they are delivered in one update. Each pause gets one log line saying until when, recorded
  under `updates-paused:<end>` so a restart does not repeat it. The issue gets ONE comment by the AI account about it at
  most once per rolling 24 h (`buildJiraUpdatesPausedText`: until when, nothing lost, a pause within a day is not told
  again; the record's `isNoticePosted`) — a steady stream of comments fills the window again at every end and pauses it
  again, silently. The AI account's own comments are never delivered, so the notice starts no loop. A mention held back
  by the cap — on an issue not handed to the AI, a follow-up mention is an update too — is marked `held-mention:<id>` in the
  trigger log, so the mention scan keeps it outside the mention window, across a restart, and reads its issue by its key
  once the search no longer returns it (not during the pause), until it is delivered — two days at most, and one that a
  later prompt of the issue carried (the watermark passed it) is let go; a mention update whose post failed is held the
  same way, as its backoff may outlast the window. The agent must comment only as the AI account.
- **An issue that leaves the handed state gets one last scan** (`scanIssuesThatLeftHanded`): the poller remembers the
  handed issues whose hand-over it saw, with the request an update would go to. One that a later poll finds no longer
  handed (its final answer handed it back, someone took it) — read by its key when the search no longer returns it — has
  its comments read once more: those written before the changelog entry that ended the hand-over (`findLeftHandedAt`)
  and not delivered yet reach that request as the "finished" update (or a request still open; on an issue the AI account
  took up in another issue's run with no request of its own known, the linked run's request as above). The gap between a
  hand-back and the next poll no longer loses a comment. In memory: a restart forgets what was handed, and a request that
  opens and is answered between two polls is never seen handed, so a comment inside that short window gets no last scan
  (it still rides the issue's next prompt).
- **No request is open but the issue is still handed** (a hand-back that failed, a hand-over with no
  requester): the comments open ONE request of their own — origin `trackerEvent`, trigger
  `comment:<newest id>` (`commented`; `from: KEY: <name> commented (comment <id>)`), the newest comment's author its
  requester — through the run budget (over it: parked with the hand-over's notice and hand-back) and a task-agent slot (a
  place in the list, told once, decided again at every poll); its note says the comment starts work like a hand-over. The
  older comments of the poll are recorded `update` with it.
- One post per issue at a time (`postingIssueKeys`), as for requests: a comment that comes while one is in flight is
  taken by the next poll. `wakeOnComment: false` keeps the old decisions: no comment scan, `covered` for the requester's mention.

### An @-mention wakes the AI (`inbound.ts` `getMentionDecisions`)

With a `trustedGroup` (and `wakeOnMention` not `false`) a comment that @-mentions the AI account starts a request
on an issue of an allowlisted project that is not handed to it (with `wakeOnComment` off: on any issue) — any assignee,
any status. What it asks of the agent is `mentionMode`:

- **`"answer"`** (absent): the agent may read the issue and the code and run read-only checks; it changes nothing, and
  asked to do work it answers that the issue has to be assigned to it in one of the project's trigger statuses, which the
  note lists — or, when the issue is already assigned to the AI account in another status, that only the status is missing.
- **`"act"`**: a trusted person's explicit ask in the comment is carried out, whatever the issue's status and assignee —
  «If the comment explicitly asks you to do something — create or split issues, take a transition, change the assignee,
  take up the work — do it as your rules allow; if it only asks a question, answer it and change nothing. Your answer
  becomes a comment on the issue; it hands nothing back.» The note still names the issue as it stands (not handed /
  assigned in a status the agent does or does not work in) and every hand-over request that was open, which goes on: acting
  on the comment never stops or ends that work. The request may act, so it takes a task-agent slot (its origin carries
  `mayAct`, see "The cap on task agents"); its origin stays `trackerMention`, so nothing is handed back — nothing was
  handed over. Giving a group member this power adds nothing: a member can already assign the AI any issue.

Either way it is an instruction in the prompt, like the agent's other rules, not a technical lock: the agent still runs
with the instance's rights, and what it may do is its rules' call.

- **The answer-mode note has four cases** (`prompt.ts` `getMentionNote`; with comment wakes on, cases 3 and 4 are reached only
  by a mention on an issue not returned as handed, so in practice no longer by a trusted commenter), chosen from the issue as it stands when the prompt is
  built — `assignee` is one of `jiraPromptIssueFields`, the status is matched by id against the project's
  `triggerStatusIds` — and from the conversation's OPEN hand-over requests (`trackerEvent`, read through
  `listOpenRequests` right before the request opens; the requester is named from the issue's own data, left out
  when nothing names them): (1) not assigned to the AI account — «not handed to you (assignee: …, status: …)»,
  answer only; (2) assigned to it in a status it does not work in — «not handed to you», only the status is
  missing, answer only; (3) assigned to it AND in a trigger status, with NO hand-over request open — answer only,
  and a request for work is told that a hand-over starts work, not a comment; (4) assigned to it AND in a trigger
  status, WITH a hand-over request open — «handed to you»: the read-only limit applies to this one answer (given
  between steps of the work, not in the middle of one), the open request is named and goes on unchanged, and a
  request for work in the comment is not taken on — a change to that work comes from its hand-over's requester or
  a new hand-over. Whenever a hand-over request is open, the notes of cases 1 and 2 say too that the limit is
  about this answer only and the request is not affected: a mention by someone other than that request's
  requester lands in the same session, mid-build, and must never stop the work. The note is the agent's only
  account of who holds the issue, so the prompt's issue read must carry the assignee.
- **Hand-overs that finished are dropped from the note when the prompt is delivered.** The prompt may wait behind a
  running turn or a usage-limit wait for hours, and the hand-over it names may get its final answer meanwhile. Right
  before the forward (`buildText`, whole and delta prompts) and whenever a stored copy is read for a resend or for
  the resume of a limit wait (`JiraInbound.refreshPromptText`, the connector's `StoredPromptRefresher` of
  `requests/storedPromptRefresh.ts`, registered while the poller runs), the note is rebuilt from the hand-overs it
  named WITHOUT those no longer in `listOpenRequests` — never with a newer one, so «was open when this comment came
  in» stays true and the rest of the note (who holds the issue, in which status) is not mixed with a later state.
  The rebuilders are held in memory for at most 32 open mention requests; after a restart the stored text is
  delivered as it is. Wherever no rebuild happens the wording holds on its own: the requests «were open when this
  comment came in», and one whose final answer the agent has already given is finished — it is not resumed.
- **Finding it.** Jira's `comment ~ currentUser()`, run as the AI account, matches a comment that holds a
  mention node of it — not a typed `@name`, not the account's display name written as text. Measured against a
  live site: a fresh mention is returned by the search within about two seconds, and a comment edit moves the
  issue's `updated`. The window is `max(5 min, 2 × pollIntervalSeconds)`; the JQL's `updated >= -<n>m` and the
  comment scan share it. A mention made while Jira was unreachable for longer than the window is not seen, and
  Jira promises no bound on its search index's lag (`getJiraMentionWindowMs`).
- **The scan.** For each returned issue (allowlisted projects only) whose `updated` differs from what this process
  last read — in memory, so a restart reads once more — the newest 100 comments are read. A comment counts when it
  was created or edited inside the window, is not the AI account's own, holds a `mention` node with the AI
  account's id (`getMentionedAccountIds`: the node's `id` attribute, never its text), and its trigger id
  `mention:<commentId>` is not in the trigger log. Oldest first, one decision each.
- **One wake per comment.** The decision is recorded under `mention:<commentId>` (`untrusted`, `covered`, `update`,
  `parked` or `request`), so a later edit of the comment, the next poll and a restart wake nothing. An edit that
  ADDS a mention to an older comment is the first decision on it. A comment decided by the comment scan
  (`comment:<id>`) is never decided again by the mention scan, nor the other way round.
- **Who may wake it.** The comment's author AND its last editor must be trusted (`checkIsCommentTrusted`, the same
  rule that decides whether the comment's text reaches the agent). Otherwise it is `untrusted`: recorded, one log
  line (`[jira] PROJ-1: the mention in comment 10240 is ignored: …`), nothing posted — an outsider gets no
  request and no notice. An app's or automation's mention is trusted only as `trustedApps` allows.
- **The requester of an open hand-over** who mentions the AI (on an issue no longer returned as handed — the agent
  moved it on, someone unassigned it) gets no request of their own: it would supersede the hand-over request — same
  requester — and strip its hand-back. With comment wakes on the comment reaches that request as an issue update (see
  "A comment on an issue handed to the AI reaches it"), recorded `update`. With them off it is `covered`: recorded, and
  nothing is posted — no prompt ever carried it, which is the bug comment wakes fix. An open hand-over request with NO
  requester takes every mention the same way: the ledger lets any next request of the conversation supersede such a request.
- **Budget.** A mention request counts in `runBudgetPer24h` with the hand-overs. Over it the mention is `parked`;
  its notice (nothing is handed back — nothing was handed over) is posted at most once per issue per rolling
  24 hours, later ones are recorded silently.
- **The request.** Origin `trackerMention` (with `mayAct: 'true'` in act mode), requester = the comment's author; one
  request is posted at a time per issue, so a second mention waits for the next poll. The prompt is the issue — whole, or what the conversation
  has not seen yet — with the mention note after the requester line. A different person's mention opens a request
  of its own; a second mention by the same person supersedes their earlier open one; a hand-over by that person
  while their mention request is open supersedes the mention request. The answer is a comment and the issue stays
  where it is (`answerSink.ts` keys on the origin kind).

## Claude accounts and usage limits (`utils/claudeProfileSync.ts`, `utils/limitSwitchPlan.ts`)

A Jira-only instance has no `/accounts`, so its accounts are found on disk. Every folder under `DATA_DIR/claude-profiles/` whose name is
a valid profile name (a lowercase slug, never `default`) and that has no record in `state.json` is ADOPTED — at the boot and at each usage
poll (every 10 minutes, and whenever an agent asks `claude_profiles`): the bot records it and asks the CLI who is signed in
(`claude auth status --json` under that folder, as `/accounts` does). An operator makes the folder
(`createClaudeProfileLayout` does it with its links back into `~/.claude`; a bare folder is given the links it lacks — `projects/`
above all, or a conversation could not resume under the account — when it is adopted) and signs it in with
`CLAUDE_CONFIG_DIR=<folder> claude auth login`; a folder that is not signed in is recorded as such and is never picked. Every folder is
put back in line before each launch under it (`repairClaudeProfileLayout`): the entries Claude Code loads as user-level configuration
are links into `~/.claude` again, and an agent's planted replacement is moved aside as `<entry>.moved-<time>` — see
`docs/commands.md` («Several accounts»). A signed-in
account's status is read again after an hour, a signed-out one at most every five minutes (a sign-in by hand shows up), and no profile
more than once per five minutes whatever the answer — a poll that finds nothing to do spawns no process. `default` (`~/.claude`) is
probed the same way, so it can take a limited session over; the one the operator signed out through Telegram's `/accounts` (`isRemoved`)
is not probed by the scan. A removed profile's folder is deleted with its record, so it is not found again.

When a Jira conversation's agent hits a usage limit the bot moves it to the next signed-in Claude account by itself — the conversation
resumed (`--resume`) under that account's `CLAUDE_CONFIG_DIR`, answered as before — by the rules a Telegram topic follows: the fallback
list's Claude entries when it has any (an OpenCode entry is skipped: a hand-over to another backend has no surface here; a list with no
Claude entry restricts nothing), else the ranking by the soonest weekly reset (`pickClaudeLimitSwitchCandidates`). The requester hears
nothing — the work simply goes on; the bot's log has the `[fallback]` line. Everything that is a topic's stays out: the «Switch to …»
offer (with auto switch OFF the conversation waits), the notice, the wait aimed at the account that resets first (the retry kick moves only a
topic there) — and with no account free, or on OpenCode, the conversation waits for the reset exactly as before, announced to the open
request. The account-switch settings are ONE set for the whole bot, whatever the connector, and a Jira conversation has no setting of its
own (an automatic move pins it to the account it moved to, as it does a topic): it starts on the instance's default account (`claudeProfileDefault`, General's `/accounts` pick) and follows the instance's fallback
list and General's «Auto switch» (`claudeAutoSwitchOnLimitEnabled`, ON unless turned OFF) and «Wait for reset»
(`autoContinueOnLimitEnabled`, ON unless turned OFF) of `/limits_autoswitch`. Telegram's General topic is where they are set (an instance that serves
Jira and Telegram together uses the same values for both); a Jira-only one keeps them in `state.json`. A launch under an account's directory carries
`CLAUDE_CONFIG_DIR` — a path, the one variable beyond the agent allowlist (R32). Flow: `jiraFallbackSwitchE2e.test.ts`.

An account that cannot work because of its SIGN-IN is never started or resumed on (`utils/claudeAuthRefusal.ts`): one its last status check
found signed out, or one the CLI refused on a turn — the stream's `authentication_failed` / `oauth_org_not_allowed` code, or its words (signed
out, a login expired or revoked, «Your organization has disabled Claude subscription access for Claude Code», a bare 401 / 403 — which a status
check that finds the account signed in may end once; the same login refused that way again within six hours is held until a new login,
`claudeRejectedRepeatWindowMs`). The issue's
conversation goes to the account `claude_profiles` recommends and keeps it. A turn refused that way is moved at once and goes on, and the issue
hears it from the bot in plain words, as a `progress` answer to its open requests (`requests.account.movedAnswer`, through the same sink as a
limit notice): «The AI's Claude account «default» is signed out: its sign-in expired or was revoked. I moved this issue to «second» and will
continue.» With no account left that can work the conversation WAITS (`claudeAccountWaits` in `state.json`): its requests are no longer woken —
so no reminder meets the same refusal and no give-up alert reads as the agent's silence — and they hear «No Claude account of the AI can work
right now (…). The operator has been told; the work continues once one is signed in again.» once per request; the first account that can work
again takes the conversation on with the continue prompt. The operator hears it on the operator issue (below). The give-up alert
(`buildJiraAlertText`) is left for a real silence: it says in plain words what happened and that a person has to look, without the
request's id (the log names it).

## The operator issue (`operatorIssue.ts`)

A Jira-only instance has no Telegram General, where the bot tells its operator what only they can fix. `jira.json` `operatorIssue`
names an issue that plays that part: each operator alert (`utils/claudeAccountAlert.ts` — a Claude account signed out or refused by its
organization, which conversations it moved where or that they wait, what to run to sign it in again; one line when it is signed in again)
is a comment by the AI account there, in English, posted once per change (the record is in `state.json`, so a restart tells nothing
again). An alert that asks the operator to act opens with a mention paragraph of `operatorAccountIds` (`createMentionParagraph`: Jira
notifies them); a recovery line mentions nobody. A post is made once and never retried — its outcome may be unknown, and an alert told
twice is worse than one the log names as not posted. The issue is read at boot (`checkJiraSetup`: 404 → `jiraOperatorIssueUnseenError`,
the start refused; an outage only delays polling, as for the rest of the setup). It need not be in the allowlist; when it is, it is still
never a request source: the poller's client never sees it (`hideJiraOperatorIssue`, one log line the first time) — it is left out of every
search page, and a read of it by its key (the poller's re-read of a mention waiting for a slot, a mention held back from its update, an issue
that left the handed state — one may date from before `operatorIssue` was set) answers 404, so the poller drops what it kept for it as for an
issue gone. A hand-over, a comment or a mention on it reaches no agent. Without `operatorIssue` the alerts reach only the bot's log (`[accounts] …`;
the boot says so once).

## Scheduled runs and watches in an issue's conversation (`../../scheduler/`, `../../requests/scheduleWait.ts`)

An agent in an issue has the same `schedule_create` / `schedule_list` / `schedule_cancel` as a Telegram topic (the bot MCP offers them
to a Jira conversation: no `threadKey` — its token names the issue — no `isPinSilent`), including the worker-watch recipe, so after
launching a worker and arming its watch it answers `progress` and ENDS its turn instead of polling for hours. The bot stops the idle
process; the watch (bot-side, restart-safe, in `state.json` `schedules` under the issue's key) resumes the issue's own session when the
worker finishes, goes silent or runs 2 h 30 min without a report. A new comment on the issue still reaches the agent at the connector's next poll of the issue, asleep or not, as an issue
update into the resumed session; while a turn runs it waits up to 10 minutes for it to end (`postToSession`), then joins it.

- **Nothing of it is shown on the issue.** A Jira comment always notifies the requester and the issue's watchers — there is no silent
  one — so a fire posts no announcement, a check no alert and no «back to normal» line, a status argument no status line: the
  scheduler's delivery has no feed for a tracker conversation (`ScheduleDeliveryDeps.trackerRun`). The agent writes in the issue only
  through `answer_request`, and a woken agent with nothing to report stays silent — the bot never prods it for that, unless the request still owes
  the requester an answer (a comment left unanswered is reminded and given up on even by a fire's turn: `../../requests/README.md` row 13).
- **A fire rides the open request, opens none.** Its prompt starts with a header naming the request it rides (the one the job was armed
  under — `ScheduleRecord.requestId`, recorded by `schedule_create`: the request the agent was working on, not a newer mention of another person — or the open one that replaced it, else the newest open one) or
  saying «no request is open» and naming the finished request (a request that still owes the requester an answer says so, and asks for it
  in this turn): an `answer_request` to that one still becomes a comment but hands
  nothing back, so the agent answers only what the requester must know and cancels a job that served only that request. The issue key
  and link (`JiraConnector.describeConversation`) are in the header, so a session that started fresh knows where it is. The turn the
  fire starts is watched as that request's scheduled run. No job is cancelled when its request closes (as in a topic): «check the
  deploy tomorrow» must survive the final answer.
- **The request waits for its watch.** An open request with an armed watch that owes nobody an answer is not reminded every 15 minutes,
  not woken at a bot restart and not given up on after ten wake-ups; a requester's comment left unanswered still is — also after a restart,
  and also when it was held over a usage-limit wait or an alarm fires meanwhile. The task-agent slot stays held, because the issue IS being
  worked on (`../../requests/README.md` § Wake-ups, the rule table). A passing recurring job armed under a request keeps it waiting for as long as it lives, and the issue's slot held:
  guidance, not code — an agent that arms a watchdog meant to outlive the work (a health check, a daily job) answers `final` afterwards;
  the job keeps running and its fires say «no request is open», or ride the request open at the time (a later hand-over, a mention: the
  header names it, and the agent answers it only with what its requester must know). The tool description and the orchestration skill say so.
- **Fires and the task-agent cap.** A scheduled fire resumes the issue's agent whether or not the issue holds a slot (after the hand-over's
  final answer, during a mention-only request) and is never held by `taskAgents.maxConcurrent`: the cap bounds hand-overs, as a Telegram
  topic's fires have no concurrency cap either (`../../trackers/README.md`). The slot of an issue whose request waits for its watch stays held.
- **Paused jobs.** A fire that finds no usable folder pauses the job with a log line (nothing is posted); the next request of the issue
  whose `bindConversation` finds the folder usable resumes it — next run from now, a passed one-shot dropped — as `/bind` does in a topic.
- `send_messages_to_user` stays Telegram-only: several comments are `answer_request` progress notes, and a second path to the issue would
  bypass the answer rules (hand-back, reply threads, the accounts note).

## Possible next steps

**Operator commands on the operator issue** (not implemented — a design note). The operator issue could take a few commands typed as a
comment, so a Jira-only instance can be looked after without a shell:

- `/accounts` — the bot answers with the Claude accounts as `charness claude-profiles` shows them (signed in or refused, usage, which one
  new conversations go to).
- `/login <profile>` — the bot starts the sign-in of that account out of band, as Telegram's `/accounts login` does through
  `agentLogin/` (a pty running `claude auth login` under the profile's `CLAUDE_CONFIG_DIR`), posts the sign-in link as its comment, and
  takes the code from the NEXT comment of the same operator on that issue; the code is never echoed, logged or quoted back, and a sign-in
  left open expires like Telegram's.
- `/status` — what runs: the open requests and their issues, the waits (a usage limit, an account to sign in), the task-agent slots.

Who: only a comment whose author is one of `operatorAccountIds` (a plain id check — no group, no app, never the AI account itself, and
never an edited comment whose last editor is someone else); anything else on the issue stays ignored, as now. A command is decided by
the poller's scan of the issue's new comments (its `updated` moving), answered once (a seen-log, like `triggerLog.ts`), and never reaches an
agent.

Risks: a sign-in code in a Jira comment is readable by everyone who can browse the issue, kept in its history and sent in its
notification e-mails. So the bot deletes the code's comment as soon as it has read it (the AI account needs the *Delete all comments*
permission in that project; without it the command is refused up front), the code is single-use and short-lived, and the issue should live
in a project only the operators can browse. The answers must never carry a token, a key or a path beyond the profile's folder; a mistyped
command gets a short usage line, not an echo of what was typed.

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
  runs only in the whole-bot Docker container (root `SETUP.md`, "Run with Docker"), where the agent still reads the
  `ENV_FILE` and `DATA_DIR` but nothing of the host beyond the container's mounts. The image runs everything as
  root, so the allowlist carries `IS_SANDBOX` (Claude Code refuses `--dangerously-skip-permissions` as root
  without it). `XDG_CACHE_HOME` (a path) is on it too — even when the `ENV_FILE` set it, as the bot then follows that value — so the agent and the bot share one `charness remote-run` cache. A deployment that
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
  member of the group (`GET /rest/api/3/group/member?groupId=…&includeInactiveUsers=false`, pages of 50) and the AI
  account itself. An app or automation (`accountType` `app`) is judged by the OPTIONAL `jira.json` `trustedApps`
  instead of by membership, because the product-access group of a site holds the app users of its chat, mail,
  error-tracking and help-desk integrations, which can relay text written by outsiders: with the key ABSENT every
  app is trusted (as before the key existed; the boot warns once, naming the key, and only when a group is set); with
  it set — even `[]` — an app is trusted only when its Jira account id is listed, and one that is not, a member of
  the group or not, is treated exactly like a person outside it (text withheld, hand-over refused, mention ignored).
  The list names app accounts: a listed person's id adds no trust (membership stays their rule). Each untrusted
  app is logged ONCE per process (`[jira] app "<name>" (account id "<id>") is not in trustedApps: …`; the name is
  flattened to one line and cut at 80 characters — the one place a display name is logged) so an operator can find
  the id to list. The key needs a `trustedGroup`: without one everyone is trusted anyway, so the config is refused
  (`jira.json trustedApps needs trustedGroup: …`), like `wakeOnMention: true` without a group. Not trusted without
  membership: any other person, a service-desk customer (`customer`) and an account whose `accountType` is missing
  (read as a person).
  Membership is read at boot (part of the setup check) and before a poll's search — before every page of it —
  whenever the last read is older than 5 minutes (`jiraTrustedGroupMaxAgeMs`): a removed member loses trust within
  5 minutes plus one poll. The list is never served past its age: a refresh that fails (no answer, 5xx, 429) fails
  that poll, with the usual backoff, so nothing is decided on a stale list (fail closed). Setup faults refuse the
  start, with every reason at once: no group of that name (`jira.json trustedGroup: the site has no group named
  "…"`), or the AI account may not read it (403: the *Browse users and groups* permission). A group deleted while
  the bot runs (404 on a refresh) stops polling with one loud line, like a refused token — a setup fault does not
  fix itself; the process stays up — and so does a withdrawn permission (403). An empty group boots, with one
  warning (only apps and automations — with `trustedApps` set, only the listed apps — can hand the AI work).
- `config.ts`: an unknown key is an error; `${VAR}` placeholders expand from the env file; every message names
  the field (and an unset placeholder's variable), never a value.
- Lazy load: Jira code loads through a dynamic `import()` only when the connector is on, and nothing
  `bot.ts` imports statically may reach its packages (`jiraLazyLoad.test.ts`; `marklassian` is ESM-only, hence
  `engines.node >=22.12`).

## Answer sink (`answerSink.ts`) and the client (`client.ts`)

- An answer becomes one or more comments by the AI account (`createCommentBodies`, in order). A `question` or
  `final` answer to an OPEN hand-over request (origin `trackerEvent`) then hands the issue back to the
  requester, only while it is still assigned to the AI account; never for `progress`, never for a superseded
  request. Comment first, then the hand-back: a failed hand-back is a delivered answer plus a warning (a retry
  would post it twice). A mention request (origin `trackerMention`) hands nothing back — not its `final`, not its
  `question`, not its alert: the issue was never handed over.
- **Who an answer notifies** (`resolveReplyTargets`). The first comment of an answer may open with ONE paragraph
  of real mention nodes (`createMentionParagraph`: one per person, one space between, nothing else — Jira shows
  `@Name` and notifies them): the requester of a mention request on every answer, unless it is an app (read from
  the request's own comment, `GET …/comment/{id}`; a comment that is gone means no mention, never a failed answer),
  then the authors of the comments the answer names in `replyToCommentIds`. A hand-over's requester is not
  mentioned: the hand-back already tells them. Only the bot writes mention nodes — an agent's own ADF never reaches a
  comment — so an agent can notify only whom this rule lets through. A replied-to comment qualifies when the
  conversation was SHOWN it (`getShownBlock`: in a prompt taken in, or built and not taken in yet — an agent may
  answer a prompt before the bot saw it consumed) and not as a `[withheld: …]` marker, its author is a person other
  than the AI account, and — with a trusted group — its author and last editor are trusted. Ids that do not
  qualify are left out and named in the tool result's warning (the answer itself is delivered, never resent). The
  paragraph counts toward the comment size split (`createCommentBodiesWithLeadingNode`: its size comes off the
  limit of every part). `replyToCommentIds` (at most 10 numeric ids) is offered to Jira sessions only.
- **Where an answer goes: comment threads.** Jira Cloud has threaded replies (one level, see "Comment threads in the
  API" below), and an answer follows them: it goes into the thread of the first comment it replies to
  (`replyToCommentIds` — a top-level comment's own thread, or the thread a reply is in), else into the thread the
  request's latest issue update came from, else into the thread its request was opened in, else it is a top-level
  comment. **An update's thread** (`answerThreads.ts`, `DATA_DIR/jira-answer-threads.jsonl`): an update is no request —
  its comments belong to a request already open, whose origin is fixed — so when the newest comment an update brought
  is a reply, the request's NEXT answer goes into that thread by itself (the update says so: «Your next answer to request
  … is posted in the thread of comment …»), and when it is a top-level comment the next answer goes where the request's
  answers go by default; the entry is noted once the update reached the session, used up by the AGENT's answer delivered
  (an answer that was not delivered leaves it for the resend; a notice the bot writes itself — a usage limit, a refused
  sign-in, `RequestAnswerDelivery.isBotNotice` — goes into the thread but uses nothing up, so the agent's answer after
  the resume still lands there), and survives a restart. A request is opened in a thread when the comment that
  opened it — a mention, or a comment on a handed issue — is a reply: `inbound.ts` puts the thread's top-level comment
  id in the origin as `threadCommentId` (`jiraReplyThreadAttribute`), fixed when the request opens like its requester,
  so where an answer goes never comes from the issue's text later. A request opened by a top-level comment, or by a
  hand-over, answers top-level. Every part of a long answer, the request's progress notes, its usage-limit notice
  (`limitWaitAnswer.ts` goes through the same sink) and its alert go into the same thread; so do the notices about a
  trigger that is a reply (the park notices, the queued notice). The untrusted notice (a hand-over has no comment) and
  the updates-paused notice (the issue's, no trigger's) stay top-level. A replied-to id that does not qualify (the rule
  above) moves nothing; ids in several threads put the answer in the first one's and the result names the others
  (`buildJiraOtherThreadsWarning`), whose authors are still mentioned. A reply Jira refuses with 400 — its thread is
  gone — is posted top-level instead, with the rest of the answer, and the result says so
  (`buildJiraThreadRefusedWarning`); any other refusal stays the answer's error.
- A hand-over's `question` to an OPEN request (the one that hands the issue back) ends with one more paragraph,
  plain text on the last comment: "To let me go on, answer in a comment and assign the issue back to me." A reply
  that only mentions the AI wakes it for an answer (with `mentionMode: "act"`, an explicit ask in it is carried out); a
  hand-over is still how the hand-over's work continues.
- Three notices are the bot's own, with no agent behind them: the park notice of a hand-over (it names
  hand-overs and mentions together, as both fill the budget) and the notice of an `untrusted` hand-over —
  "Only members of the AI's trusted group (`<configured name>`) can hand it work, so nothing was started. Ask a
  member to hand it over." — posted as plain text, so a group name is never read as Markdown — each followed by
  the same hand-back (and no hand-back when the notice did not land, only a warning — its trigger is recorded
  already, so it is not repeated); and the mention's park notice, which hands nothing back.
- The first comment refused → an error (nothing posted, safe to send again). A later part that did not land →
  delivered with a warning saying where the unposted rest starts.
- `addComment` is never retried by the client (a second POST would post twice). A post of UNKNOWN outcome
  (timeout, dropped connection, 5xx) is read back once after `jiraReadBackDelayMs` through
  `getRecentComments`; every failure message says what to send again, because the agent cannot look at the
  issue. The post is remembered (`unconfirmedPosts.ts`): resending the same text for the same request checks the
  issue first and posts at most once — a reworded resend is a new text and is posted without a check.
- The client retries only requests safe to repeat; 429 honours `Retry-After` (capped); errors carry method, path
  and Jira's messages, never the token.

## Files the agent shows on an issue (`outgoingFiles.ts`, `outgoingFileCheck.ts`)

The agent's answer can carry files: `answer_request`'s `files` (1–10 paths relative to the issue's project folder) are
attached to the issue BEFORE the answer's comment is posted and shown in it after its text — an image (`.png`, `.jpg` /
`.jpeg`, `.gif`, `.webp`) shown and an `.mp4` playing in the comment (an ADF `mediaSingle` holding a `media` node of
`type: "file"` whose `id` is the attachment's MEDIA file id, not its attachment id), any other file listed as a link to
its attachment (`/rest/api/3/attachment/content/<id>`, which a signed-in browser opens). The same goes for
`send_file_to_user` — the tool a Telegram session sends files with, offered to a Jira session under the same name and
arguments (no `threadKey`) so one instruction («send the run's video with send_file_to_user», the orchestration skill's)
works on both: its files go into a comment of their own, the caption as its text, in the thread the conversation's newest
open request answers in (top-level when none is open); `as_file: true` links every file. On Jira Cloud a plain
attachment, or a link to one, shows only in the attachments list — only the media node shows it in the comment.

- **Checked before anything is uploaded.** The paths go through the file send's own rule (`openFilesWithinWorkDir`,
  `utils/fileSendService.ts`): inside the folder, no component swapped after validation, the descriptor kept. The site's
  `GET /attachment/meta` must have attachments on, and no file may be over its `uploadLimit`. An image must be what its
  name says and WHOLE — a PNG ending in its IEND chunk, a JPEG in its end marker (zero padding allowed), a GIF in its
  trailer, a WebP whose RIFF size is the file's — and an `.mp4` a complete MP4 (its top-level boxes tile the file, its
  `moov` is there) whose first video track is H.264 (`avc1` / `avc3`), read from the boxes by position, so no ffprobe is
  needed and a file of any size costs a few reads; another codec is refused with the `ffmpeg` line that converts it. A
  video in another container (`.mov`, `.webm`, …) is attached and linked, with a note. A refusal names the file and the
  fix, and nothing is attached or posted. The size a picture or video states is put on its media node (without one Jira
  shows it at a default size).
- **One file, one attachment.** One file named twice — the same path, another spelling of it, a link to it (one
  device and inode) — is attached and shown once. Its name is made safe for the multipart header once
  (`getJiraUploadFileName`: a quote, a backslash or a control character becomes `_`), and that name is the upload's and
  every comparison's.
- **Uploaded once, reused only as the very same file.** `POST /issue/{key}/attachments` (multipart,
  `X-Atlassian-Token: no-check`, streamed from the descriptor with its exact length, a time budget that grows with the
  size) is never repeated: an answer Jira did not confirm is looked for among the attachments that appeared during it,
  once, else it is an error. Every upload is recorded by CONTENT (`uploadedFiles.ts`, `DATA_DIR/jira-uploaded-files.jsonl`:
  the issue, the attachment, the name, size and sha256; read back after a restart, 30 days kept), and a file the agent
  sends again reuses an attachment only when it is still on the issue, the AI account's, and recorded with the file's
  name, size AND hash — so the agent may send the same answer again without attaching anything twice, while a file
  regenerated under the same name and length (a new screenshot, a new recording) is uploaded anew and never shows the
  old content. An attachment nobody recorded — attached by hand, by someone else — is never reused. A failure after some
  files were attached names them.
- **The media id** is read from where `GET /attachment/content/{id}` redirects (303 to the media API,
  `…/file/<uuid>/binary?…`); the redirect is NEVER followed, so the credentials stay with the site. No such redirect, or
  no answer, and the file is linked instead, the agent told.
- An answer whose files cannot be attached is NOT delivered (nothing posted; the request unchanged, safe to send again);
  the files sit after the answer's text in its last comment (a comment of their own when that one is full), before the
  hand-over question's closing line. Measured on a live site (2026-11-20): an upload's answer lists the attachment with
  its id, name, type, size and `content` address; the content of an image, a video and a text file each redirected to
  `api.media.atlassian.com/file/<uuid>/…`; a comment of `mediaSingle` nodes naming those ids — a reply in a thread too —
  is taken, its `renderedBody` shows the image as an `<img>` and the video as a player of
  `/rest/api/3/attachment/content/<id>?stream=true`, and a `media` node without `width` / `height` is taken as well.

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
  agent only when EVERYONE who wrote it is trusted — a member, the AI account or an app or automation `trustedApps` allows (for a
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
  team holds it, which is the same rule as for who may write there at all (root `SETUP.md` § "Jira setup").

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
- **A reply says which thread it is in.** A comment with a `parentId` gets one line under its heading, before its quoted
  text: `A reply in the thread of comment 10240 by Ann, which says: "…"` — the thread's top-level comment, its author,
  its visibility marker and its text on one line as a JSON string (a quote or a backslash in it escaped, so nothing in
  the text can end the excerpt early), cut to 200 characters (`jiraReplyParentExcerptMaxChars`), so the agent
  knows what is answered even in a delta that does not carry that comment. A top-level comment that is withheld is
  named, never quoted (`… comment 10240 [withheld: …].`); one that was deleted (its replies keep their `parentId`) reads
  `…, which was deleted.`; a withheld reply has no such line. The line is not part of the reply's hash. A request a
  reply opened says `Thread: comment <id> is a reply in the thread of comment <id>, so your answers to this request are
  posted in that thread.` after the requester line, and an issue update names a reply's thread next to its id.
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
  the whole issue), every completed compaction (the adapter's `contextCompacted`: bot-issued or the CLI's own
  overflow compaction), and a live re-spawn that began a new conversation where one was lost (`conversationLost`). Not an idle stop, a resume, a restart or a hot reload: the conversation survives them.

## Comment threads in the API (measured on a live Jira Cloud site, 2026-11-20)

What the connector relies on, probed with a throw-away issue (REST v3 unless noted):

- `POST /rest/api/3/issue/{key}/comment` with `{ body, parentId }` posts a reply in that comment's thread (201); v2
  takes `parentId` the same way. `parentId` may be sent as a number or a numeric string; the answer carries it as a
  NUMBER (`client.ts` keeps ids as text: `getCommentParentId`).
- Threads are ONE level deep: `parentId` must be a top-level comment. A reply to a reply — or to an id the issue never
  had — is refused with 400, `errors.comment` "Parent comment not found, and no child comments exist. Cannot create new
  child comments." So an answer to a reply names the reply's own `parentId` (`getCommentThreadRootId`).
- `GET …/comment` (v3 and v2) lists replies with the rest, flat, in `created` order (`orderBy=created` / `-created`),
  counted in `total`; only a reply has `parentId`; `expand=renderedBody` works for replies. `GET …/comment/{id}` of a
  reply carries `parentId`. The issue's own `comment` field (`GET /issue/{key}?fields=comment`) does NOT — the
  connector reads comments through the comments endpoint only.
- A reply moves the issue's `updated` like any comment, and `comment ~ currentUser()` finds a mention made in a reply:
  the poll, the mention scan and the comment scan see replies as they see comments. The changelog records no comments.
- Editing (`PUT …/comment/{id}`) keeps a reply's `parentId`; a `parentId` in the edit's body is ignored (a reply cannot
  move). Deleting works on a reply and on a top-level comment alike; a deleted top-level comment's replies stay, with a
  `parentId` that answers 404 — and a POST with that `parentId` is still taken while the thread holds replies.

## Comment content (`adf.ts`, `prompt.ts`)

- The agent's Markdown becomes ADF. HTML stays literal text (every `<` that opens no autolink is swapped for a
  placeholder before conversion), so `<adf>…</adf>` can never smuggle a notifying mention. No external media:
  an image in the agent's Markdown becomes a plain link (a `media` node would be fetched by every viewer's browser);
  the only media nodes in a comment are the bot's own, for files it attached to the issue (see «Files the agent shows
  on an issue»). Link targets keep
  only `http`, `https`, `mailto`.
- Each comment must fit BOTH counts — its Markdown and its serialized ADF (which runs several times longer);
  which one Jira enforces is not documented.
- The issue's own text is anyone's who can edit or comment — and, when `trustedGroup` is set, anyone's in the
  trusted group, and the apps' and automations' that `trustedApps` allows (every one without the key): the prompt marks it as information, never instructions, and
  quotes it line by line so none of it can start a line as a bot block. Where an answer goes never comes from
  it — the conversation and requester are fixed when the request opens.

## Tests

`jiraConfig.test.ts`, `jiraTrustedGroup.test.ts`, `jiraIssueBlocks.test.ts` and `jiraMediaPlaceholders.test.ts` (over the recorded fixture),
`jiraOutgoingFileCheck.test.ts` and `jiraOutgoingFiles.test.ts` (the files an answer shows, over files built by `mediaFileFixtures.ts`),
`jiraOperatorIssue.test.ts` (the operator issue: its keys, the boot read, the alert comment with its mention, the poller that never sees it),
`jiraPromptSpill.test.ts`, `jiraPrompt.test.ts`, `connectorGuards*.test.ts`, `jiraLazyLoad.test.ts`; flows boot a
real Jira-only instance each (`scripts/run-isolated.sh`) against `__tests__/jiraE2e/fakeJira.ts` (which also serves
groups and their members) and `fakeClaude.ts`: `jiraConnectorE2e.test.ts` (requests and the session lifecycle, an answer that shows files and `send_file_to_user`; the fake Jira takes
uploads and redirects an attachment's content to its media file as Jira Cloud does),
`jiraPromptE2e.test.ts` (what the prompts carry), `jiraTrustE2e.test.ts` (with a `trustedGroup` and no `trustedApps`: the
filter, the notice, an automation's hand-over and mentions, a mention in a comment thread answered in it), `jiraTrustedAppsE2e.test.ts` (with a `trustedApps`: a listed
app starts the agent, an unlisted one — a group member — is refused and its text withheld) and `jiraCommentWakeE2e.test.ts`
(with a group, `mentionMode: "act"` and the backstop an hour away: a comment mid-turn reaches the same request, a comment
after the final answer opens one, an acting mention, a kill-and-restart mid-turn answered within a minute) and
`jiraFallbackSwitchE2e.test.ts` (an account signed in by hand is adopted with no Telegram; a conversation at its usage limit continues
on it, and waits when auto switch is OFF), sharing
`__tests__/jiraE2e/jiraFlowKit.ts`;
`live/jiraLive.test.ts` runs the loop against a real site and is skipped unless its env variables are set; its
prompt-context steps (media through the attachment tool, a delta, a requested compaction, the default model and
effort) also need `JIRA_LIVE_MEDIA_ISSUE` and an instance `jira.json` that maps `ffmpeg` in `agentBinaries` and names
neither `model` nor `effort` (the file header lists the inputs); its trusted-group steps need
`JIRA_LIVE_TRUSTED_GROUP`, the name of the group the instance's `jira.json` names and of which the requester is a
member.
