import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * @description What each issue's conversation was already told (prompt context
 * C4, C6): per issue, the hash of every block its agent has taken in (the
 * sent-set), and per request the sent-set its prompt WOULD make once taken in.
 *
 *   build  → `recordBuild`: pending[request] = {generation, buildSeq, sent}
 *   taken in (the ledger's flag, or a close by its own answer) → `commit`
 *   superseded / cancelled → `drop`
 *   fresh session / completed compaction → `reset` (S5): generation + 1, nothing sent, nothing pending
 *
 * A commit is dropped whole when its build belongs to an older generation (the
 * agent lost that context since) or was built before the last committed one
 * (the newer prompt already carried everything the older one did). When in
 * doubt a block is sent twice, never lost. Persisted per issue in
 * `DATA_DIR/jira-context/<ISSUE-KEY>.json`, written atomically, so a restart or
 * a hot reload keeps it.
 */

export const jiraContextDirName = 'jira-context';
/** Builds kept waiting for their take-in; older ones are forgotten (their request closed without a word to the ledger). */
export const jiraPendingBuildsMaxCount = 20;
const fileMode = 0o600;
const dirMode = 0o700;

const sentBlockSchema = z.object({
  hash: z.string(),
  /** A comment's `comment <id> by <name> from <date>`, for the line that says it was deleted. */
  label: z.string().optional(),
});
const sentBlocksSchema = z.record(z.string(), sentBlockSchema);
const pendingBuildSchema = z.object({
  generation: z.number().int(),
  buildSeq: z.number().int(),
  sent: sentBlocksSchema,
});
const contextStateSchema = z.object({
  generation: z.number().int(),
  lastBuildSeq: z.number().int(),
  committedBuildSeq: z.number().int(),
  sent: sentBlocksSchema,
  pending: z.record(z.string(), pendingBuildSchema),
});

export type JiraSentBlock = z.infer<typeof sentBlockSchema>;
/** Block key → what was sent of it. */
export type JiraSentBlocks = Record<string, JiraSentBlock>;
type ContextState = z.infer<typeof contextStateSchema>;

/** What a build reads: the sent-set and the generation it belongs to. */
export interface JiraContextSnapshot {
  generation: number;
  sent: Readonly<JiraSentBlocks>;
}

function createEmptyState(): ContextState {
  return { generation: 0, lastBuildSeq: 0, committedBuildSeq: 0, sent: {}, pending: {} };
}

/** An issue key as a file name: Jira's keys are letters, digits, `_` and one `-`; anything else is replaced. */
function getStateFileName(issueKey: string): string {
  return `${issueKey.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

export class JiraContextLedger {
  private readonly states = new Map<string, ContextState>();

  constructor(private readonly dir: string) {}

  static createForDataDir(dataDir: string): JiraContextLedger {
    return new JiraContextLedger(path.join(dataDir, jiraContextDirName));
  }

  /** @description The issue's sent-set and generation, as a build reads them. */
  getSnapshot(issueKey: string): JiraContextSnapshot {
    const state = this.getState(issueKey);
    return { generation: state.generation, sent: state.sent };
  }

  /** @description A request's prompt was built from the snapshot of `generation`; `sent` is what it makes the sent-set once taken in. */
  recordBuild(issueKey: string, requestId: string, generation: number, sent: JiraSentBlocks): void {
    const state = this.getState(issueKey);
    state.lastBuildSeq += 1;
    state.pending[requestId] = { generation, buildSeq: state.lastBuildSeq, sent };
    const overflow = Object.entries(state.pending)
      .sort(([, left], [, right]) => left.buildSeq - right.buildSeq)
      .slice(0, Math.max(0, Object.keys(state.pending).length - jiraPendingBuildsMaxCount));
    for (const [staleRequestId] of overflow) delete state.pending[staleRequestId];
    this.save(issueKey, state);
  }

  /** @description The agent took the request's prompt in: what it carried counts as sent — unless it is stale. */
  commit(issueKey: string, requestId: string): void {
    const state = this.getState(issueKey);
    const build = state.pending[requestId];
    if (!build) return;
    delete state.pending[requestId];
    if (build.generation === state.generation && build.buildSeq > state.committedBuildSeq) {
      state.sent = build.sent;
      state.committedBuildSeq = build.buildSeq;
    }
    this.save(issueKey, state);
  }

  /** @description The request closed before its prompt was taken in: what it carried was never seen. */
  drop(issueKey: string, requestId: string): void {
    const state = this.getState(issueKey);
    if (!state.pending[requestId]) return;
    delete state.pending[requestId];
    this.save(issueKey, state);
  }

  /**
   * @description The conversation's agent lost its context (a fresh session, a completed compaction, C6): nothing
   * counts as sent any more, and a build made before is dropped at its commit — its generation is gone.
   */
  reset(issueKey: string): void {
    const state = this.getState(issueKey);
    state.generation += 1;
    state.sent = {};
    state.pending = {};
    this.save(issueKey, state);
  }

  private getState(issueKey: string): ContextState {
    const cached = this.states.get(issueKey);
    if (cached) return cached;
    const loaded = this.load(issueKey);
    this.states.set(issueKey, loaded);
    return loaded;
  }

  /** A missing file is a conversation told nothing yet; an unreadable one is treated the same — the next prompt is whole. */
  private load(issueKey: string): ContextState {
    const filePath = path.join(this.dir, getStateFileName(issueKey));
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      if (!isMissing) console.warn(`[jira] ${issueKey}: cannot read its sent-state, the next prompt is whole: ${error instanceof Error ? error.message : String(error)}`);
      return createEmptyState();
    }
    try {
      const parsed = contextStateSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: same as a wrong shape.
    }
    console.warn(`[jira] ${issueKey}: its sent-state file is unreadable, the next prompt is whole`);
    return createEmptyState();
  }

  /** Atomic (a temp file renamed into place). A failed write is logged: at worst a block is sent again after a restart. */
  private save(issueKey: string, state: ContextState): void {
    const filePath = path.join(this.dir, getStateFileName(issueKey));
    const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: dirMode });
      fs.writeFileSync(tmpPath, JSON.stringify(state), { mode: fileMode, flag: 'wx' });
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      console.warn(`[jira] ${issueKey}: its sent-state could not be saved (kept in memory): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
