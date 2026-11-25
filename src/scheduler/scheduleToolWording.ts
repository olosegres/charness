import { defaultCheckTimeoutSec } from './checkRun';
import {
  checkStatusCommandTimeoutSec,
  defaultCheckStatusEveryMinutes,
  maxCheckStatusEveryMinutes,
  minCheckStatusEveryMinutes,
} from './checkStatus';
import {
  workerWatchArmedFileName,
  workerWatchCheckCommand,
  workerWatchCheckCron,
  workerWatchSilenceMinutes,
  workerWatchStatusArguments,
  workerWatchStatusEveryMinutes,
  workerWatchUnreportedMinutes,
  workerWatchUnreportedWindowText,
} from './workerWatch';

/**
 * @description What the three `schedule_*` tools say, per platform. A Telegram topic's wording is the original and stays
 * byte-identical (a moved word changes the tool digest and would reconnect every adopted Telegram process for nothing); a
 * tracker conversation (a Jira issue) gets its own: it speaks of «this issue's conversation», never of a topic or a pin,
 * and tells the agent that the bot posts NOTHING on the issue for a scheduled run, a check or a status — a Jira comment
 * always notifies the requester and the issue's watchers, there is no silent one. The sentences both platforms share are
 * constants below, so the two sets cannot drift apart on the recipes.
 */

/** The platforms that have the schedule tools, as the wording distinguishes them. */
export type ScheduleToolPlatform = 'telegram' | 'jira';

/** @name ScheduleToolWording @description The texts of the schedule tools of one platform. */
export interface ScheduleToolWording {
  createDescription: string;
  nameDescription: string;
  checkCommandDescription: string;
  statusWorkerRunDirDescription: string;
  statusCommandDescription: string;
  statusEveryMinutesDescription: string;
  listDescription: string;
  listEmptyText: string;
  cancelDescription: string;
  /** The error for an id that is not the conversation's: `scheduleId` is what the agent passed. */
  getCancelNotFoundText: (scheduleId: string) => string;
}

/** The three modes of a schedule and when to pick which — one text for every platform. */
const scheduleModesText =
  'Pick exactly ONE mode:\n' +
  '• one-shot (run once at a time): pass onceAt (ISO 8601); omit cron and repeatCount.\n' +
  '• recurring: pass cron (5-field); omit onceAt.\n' +
  '• recurring N times: pass cron AND repeatCount; omit onceAt.\n' +
  'For a single future run ALWAYS use onceAt — never a cron with repeatCount:1 ' +
  '(a cron has no year, so it would fire on that date every year). repeatCount counts CRON ' +
  'fires only and is ignored for a one-shot.\n\n' +
  'USE THIS whenever the user asks to schedule execution of a plan or task for later ' +
  "(e.g. \"schedule finishing plan X in 2h\", \"run this plan tomorrow morning\"). " +
  'Schedule IMMEDIATELY: write the request straight into `prompt` and create the job FIRST — ' +
  'do NOT read code, explore the repo, or deliberate before scheduling. Plan now, figure out the ' +
  'details at fire time. The future run does the investigation, not this call.\n\n' +
  'WATCHDOG: to monitor something (a service, process, build, deploy, disk, URL), pass checkCommand ' +
  'with a cron — the bot runs it in this folder and wakes you only when it starts failing. This is ' +
  'the ONLY reliable watcher: it survives bot restarts and crashes. Never build your own (a ' +
  'background loop, nohup, a sleep loop, a tmux pane, a shell crontab) — it dies with your session ' +
  'or a restart and then fails silently.\n\n';

/** The recipe for watching a detached worker, up to the point where the platforms differ. */
const workerWatchRecipeHead =
  `A DETACHED WORKER you launched (a \`claude -p\` / \`opencode run\` process): cron \`${workerWatchCheckCron}\`, ` +
  `\`${workerWatchStatusArguments}\`, checkCommand \`${workerWatchCheckCommand}\` with its PID and run dir (an absolute path) — it fails when ` +
  `the worker exits, OR nothing in its run dir changed for ${workerWatchSilenceMinutes} min, OR the watch was armed ${workerWatchUnreportedMinutes} min ago (\`touch <run-dir>/${workerWatchArmedFileName}\` ` +
  'right before you arm it — a resumed worker\'s reused run dir too — and again when you looked and found the worker fine: the same check then passes and watches on, ' +
  'so do not arm a second one; a run dir without the file fails at once with exit 4), so the first failure is also the "worker finished" ' +
  'signal ';

const telegramWording: ScheduleToolWording = {
  createDescription:
    'Schedule a prompt to be delivered to this topic later. At fire time the bot posts a short silent line ' +
    '(name and schedule, the prompt folded under it) and forwards the prompt to the agent. The line is never pinned.\n\n' +
    scheduleModesText +
    workerWatchRecipeHead +
    '(the topic then reads «worker finished», «worker silent» or «running without a report», never the command). Never `kill -0` alone: it stays green ' +
    'while a worker hangs. The status arguments make the BOT post a silent status line into the topic every ' +
    `${workerWatchStatusEveryMinutes} min while the worker lives (works N min, its last action), so the topic never looks frozen — ` +
    'without waking you or spending tokens: never arm a schedule of your own for status lines. One check per worker run; ' +
    'schedule_cancel it once its wake is handled (that also deletes its status line).',
  nameDescription: 'Short human name for the job (shown in announcements/lists).',
  checkCommandDescription:
    'Makes the job a WATCHDOG CHECK: a shell command (run with /bin/sh -c in the bound folder) the bot ' +
    'executes at every fire instead of waking you. Exit 0 = healthy, nothing is posted. The first ' +
    'non-zero exit or timeout tells the topic in one line (never the command) and wakes you with `prompt` plus the exit ' +
    'code and output tail; later failures stay silent until a run passes again (the topic is told). ' +
    'Keep it a quick probe, e.g. `systemctl --user is-active myapp`, `curl -fsS -m 10 http://127.0.0.1:8080/health`, ' +
    '`test $(df --output=pcent / | tail -1 | tr -dc 0-9) -lt 90`; a detached worker: the recipe in the tool description. ' +
    'Use ABSOLUTE paths only: it runs in the topic\'s folder, so a relative path or `~` points elsewhere.',
  statusWorkerRunDirDescription:
    'A check\'s STATUS SOURCE for a detached worker: its run directory (absolute, or relative to the bound folder). While the ' +
    'check passes, the BOT itself posts a short silent status line into the topic every statusEveryMinutes — how long the ' +
    'worker has run and what it did last (its last text or tool call, read from the newest events*.jsonl there) — and ' +
    'deletes the previous one. No agent wake, no tokens. Only with checkCommand; not together with statusCommand. ' +
    'A topic on the answers-only view, and a tracker issue, get no line.',
  statusCommandDescription:
    'A check\'s STATUS SOURCE for anything else: a shell command (run in the bound folder, at most ' +
    `${checkStatusCommandTimeoutSec} s) whose first output line is the «now» of the same bot-posted status line ` +
    '(e.g. `tail -n 1 build.log`). Only with checkCommand; not together with statusWorkerRunDir.',
  statusEveryMinutesDescription:
    `Minutes between two status lines (${minCheckStatusEveryMinutes}-${maxCheckStatusEveryMinutes}, default ${defaultCheckStatusEveryMinutes}). ` +
    'Only with a status source.',
  listDescription: 'List the scheduled prompts for this topic (id, name, schedule, next run, paused flag).',
  listEmptyText: 'No schedules for this topic.',
  cancelDescription:
    'Cancel (delete) a scheduled prompt by its id. Only schedules owned by this topic can be cancelled. Cancelling a ' +
    'watchdog check also deletes its status line — cancel a worker watch once its wake is handled, so a finished worker ' +
    'leaves no status line behind.',
  getCancelNotFoundText: (scheduleId) => `no schedule with id "${scheduleId}" in this topic`,
};

/** Said where a status argument is described: they are accepted so the one recipe works on both platforms, and do nothing here. */
const trackerNoStatusLineText = 'no status line is ever posted on a tracker issue';

const jiraWording: ScheduleToolWording = {
  createDescription:
    'Schedule a prompt to be delivered to this issue\'s conversation later. At fire time the bot resumes your session here and ' +
    'forwards the prompt to you under a header that names the request it rides. It posts NOTHING on the issue — a comment would ' +
    'notify the requester and the issue\'s watchers — so answer through answer_request only when you have a result the requester needs ' +
    '(or when the header says the request still owes the requester an answer).\n\n' +
    scheduleModesText +
    workerWatchRecipeHead +
    '(nothing is posted on the issue for it). Never `kill -0` alone: it stays green ' +
    `while a worker hangs. The status arguments are accepted so the one recipe works everywhere, but ${trackerNoStatusLineText}: ` +
    'arm no schedule of your own for status. One check per worker run; schedule_cancel it once its wake is handled. ' +
    'Once the watch is armed, answer_request "progress" and END your turn — do not poll the worker: the bot stops your idle process and the ' +
    `failure wakes you in this issue when the worker finished, went silent, or ran ${workerWatchUnreportedWindowText} without a report. ` +
    'A new comment on the issue reaches you at the bot\'s next poll of the issue, asleep or not; while a turn runs it waits up to 10 minutes for it to end, then joins it. ' +
    'A watchdog meant to OUTLIVE the work (a health check, a daily job) is armed, and then the request is answered `final`: the job keeps ' +
    'running and its fires say «no request is open», or ride the request open at the time (a later hand-over, a mention: answer that ' +
    'request only with what its requester must know, not about the job). Left armed under a request that stays open, it would keep that request waiting ' +
    '(not reminded between turns while it owes nobody an answer; a requester\'s comment you leave unanswered still is) and its task-agent slot ' +
    'held for as long as the job lives.',
  nameDescription: 'Short human name for the job (shown in lists and in the header of its fires).',
  checkCommandDescription:
    'Makes the job a WATCHDOG CHECK: a shell command (run with /bin/sh -c in the bound folder) the bot ' +
    'executes at every fire instead of waking you. Exit 0 = healthy, nothing happens. The first ' +
    'non-zero exit or timeout wakes you with `prompt` plus the exit code and output tail (nothing is posted on the issue); ' +
    'later failures stay silent until a run passes again. ' +
    'Keep it a quick probe, e.g. `systemctl --user is-active myapp`, `curl -fsS -m 10 http://127.0.0.1:8080/health`, ' +
    '`test $(df --output=pcent / | tail -1 | tr -dc 0-9) -lt 90`; a detached worker: the recipe in the tool description. ' +
    'Use ABSOLUTE paths only: it runs in the issue\'s folder, so a relative path or `~` points elsewhere.',
  statusWorkerRunDirDescription:
    'A check\'s STATUS SOURCE for a detached worker: its run directory (absolute, or relative to the bound folder). Part of the ' +
    `worker-watch recipe, accepted so the one recipe works everywhere — but ${trackerNoStatusLineText}; it only marks the check ` +
    'as a worker watch. Only with checkCommand; not together with statusCommand.',
  statusCommandDescription:
    'A check\'s STATUS SOURCE for anything else: a shell command (run in the bound folder, at most ' +
    `${checkStatusCommandTimeoutSec} s). Accepted so the one recipe works everywhere, but ${trackerNoStatusLineText}. ` +
    'Only with checkCommand; not together with statusWorkerRunDir.',
  statusEveryMinutesDescription:
    `Minutes between two status lines (${minCheckStatusEveryMinutes}-${maxCheckStatusEveryMinutes}, default ${defaultCheckStatusEveryMinutes}). ` +
    `Accepted so the one recipe works everywhere, but ${trackerNoStatusLineText}. Only with a status source.`,
  listDescription: 'List the scheduled prompts of this issue\'s conversation (id, name, schedule, next run, paused flag).',
  listEmptyText: 'No schedules for this issue.',
  cancelDescription:
    'Cancel (delete) a scheduled prompt by its id. Only schedules owned by this issue\'s conversation can be cancelled. ' +
    'Cancel a worker watch once its wake is handled, and a job that served only a request that is finished.',
  getCancelNotFoundText: (scheduleId) => `no schedule with id "${scheduleId}" in this issue`,
};

/** @description The texts of the schedule tools of `platform`. */
export function getScheduleToolWording(platform: ScheduleToolPlatform): ScheduleToolWording {
  return platform === 'jira' ? jiraWording : telegramWording;
}

/** The `checkTimeoutSeconds` text: one for every platform. */
export const checkTimeoutSecondsDescription =
  `Seconds a check run may take before it is stopped and counted as a failure (default ${defaultCheckTimeoutSec}). ` +
  'Only with checkCommand.';
