/**
 * @description What a topic's status mark is built from, reduced to pure rules over facts the bot reads live: which schedules are a
 * watched worker that still runs, and how the agent's facts (a process up or not, a turn at work, an open question, a stuck agent, a
 * conversation to resume) become the inputs `resolveTopicStatus` chooses from. The reading itself (adapters, maps, the schedule store)
 * stays in `bot.ts`; the rules live here, where a test can reach them.
 */
import type { ScheduleRecord } from '../scheduler/types';
import { checkIsCheckSchedule } from '../scheduler/deliveryKind';
import type { TopicStatusInputs } from './topicIndicatorPlan';

/**
 * @description Whether `record` is a watched worker that still runs: a check with a worker's run directory (the recipe of
 * `scheduler/workerWatch.ts`) that is not parked, not ended and not failing — a failing check IS the worker's end.
 */
export function checkIsWatchedWorkerRunning(record: ScheduleRecord): boolean {
  return checkIsCheckSchedule(record) && record.statusWorkerRunDir !== undefined && record.isPaused !== true && record.nextRunAt !== null && record.isCheckFailing !== true;
}

/** What the bot knows of a topic's agent right now. */
export interface TopicAgentFacts {
  /** The topic has an agent backend that has agent states: no terminal topic, no topic that never started one. */
  hasAgent: boolean;
  /** The agent's process is up. */
  isActive: boolean;
  /** Its turn runs (background tasks and a compaction included). */
  isTurnRunning: boolean;
  /** The workers the agent watches that still run. */
  watchedWorkerCount: number;
  /** A question of the agent is open: waiting or set aside. */
  hasOpenQuestion: boolean;
  /** The agent cannot go on by itself. */
  isStuck: boolean;
  /** The conversation has a session to resume (its process is stopped, the conversation is kept). */
  hasResumableSession: boolean;
}

/**
 * @description The facts a status is chosen from. A topic with no agent has none of them. Working is the agent's own turn OR a watched
 * worker (the agent may rest while its builder runs); finished is a process that is up and not working; asleep is a stopped process whose
 * conversation is kept.
 */
export function getTopicStatusInputs(facts: TopicAgentFacts): TopicStatusInputs {
  if (!facts.hasAgent) return { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false };
  const isAgentWorking = facts.isActive && facts.isTurnRunning;
  return {
    hasOpenQuestion: facts.hasOpenQuestion,
    isStuck: facts.isStuck,
    isWorking: isAgentWorking || facts.watchedWorkerCount > 0,
    isFinished: facts.isActive && !isAgentWorking,
    isAsleep: !facts.isActive && facts.hasResumableSession,
  };
}
