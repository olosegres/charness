import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';

/**
 * @description Which conversations share a project board (D15, D16, D57) — automatic by repository:
 *
 *   a Telegram topic   → its bound folder's git repository, by ROOT COMMIT (remote names differ between checkouts,
 *                        worktrees share it); a folder that is not a git checkout is a project of its own folder —
 *                        so two topics on one folder are always together
 *   a Jira conversation → the repository NAMES its `jira.json` project lists (`repos`); conversations of projects
 *                        that share a name are one board, and a topic whose repository folder has that name joins
 *                        it; projects without `repos` all share one board per instance
 *   a topic's override  → "join the project of topic X" or "own project" (`state.json` `todoProjectOverrides`)
 *
 * The grouping is a union-find over keys each conversation holds; a topic's repository NAME joins the union only
 * when some Jira conversation names it, so two unrelated repositories that happen to share a folder name never meet.
 */

/** How long a folder's repository is trusted before git is asked again (a folder may become a checkout, or move). */
export const repositoryIdentityTtlMs = 10 * 60 * 1000;
/** A read that failed (git missing, slow, the folder gone) is tried again this soon — a project must not split for long. */
export const failedRepositoryReadRetryMs = 30 * 1000;
/** `git rev-parse` answers at once; a longer one is abandoned. */
const gitQuickQueryTimeoutMs = 5000;
/** `git rev-list --max-parents=0` walks the whole history: a large repository needs longer, once per process. */
const gitHistoryQueryTimeoutMs = 30 * 1000;
const gitDirName = '.git';
const gitDirSuffix = '.git';
/** The board every Jira conversation of a project without `repos` shares. */
const sharedJiraBoardKey = 'jira:shared';
/** The name of a project none of whose members has a folder name (only such Jira conversations). */
const unnamedJiraProjectName = 'jira';

/** @name RepositoryIdentity @description What makes two folders one repository, and what it is called. */
export interface RepositoryIdentity {
  /** The first (sorted) root commit — the same in every clone and worktree. */
  rootCommit: string;
  /** The main repository's folder name (a worktree's or a submodule's repository, not the worktree's own folder). */
  repositoryName: string;
}

/** @name TodoProjectOverride @description A topic's choice in the project picker; absent = automatic. */
export type TodoProjectOverride = { kind: 'own' } | { kind: 'join'; conversationKey: string };

/**
 * @name TodoProjectMember
 * @description A conversation as the grouping sees it. `workDir` = a topic's bound folder (absolute); a Jira
 * conversation carries `jiraRepositoryNames` instead (`null` = its project lists no `repos`).
 */
export interface TodoProjectMember {
  conversationKey: string;
  workDir: string | null;
  identity: RepositoryIdentity | null;
  jiraRepositoryNames?: readonly string[] | null;
}

/** @name TodoProject @description One board: its name, its members in binding order, and how it was formed. */
export interface TodoProject {
  name: string;
  memberKeys: string[];
}

/** @description Run git in `workDir` within `timeoutMs`; its trimmed stdout, or `null` when it failed or ran too long. */
export type RunGit = (workDir: string, args: readonly string[], timeoutMs: number) => Promise<string | null>;

const execFileAsync = promisify(execFile);

/** @description The real git. */
export const runGitInFolder: RunGit = async (workDir, args, timeoutMs) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workDir, ...args], { timeout: timeoutMs, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
};

/** @description The repository's own folder name from git's common dir (`…/repo/.git`, a submodule's `…/modules/repo`, a bare `repo.git`). */
export function getRepositoryNameFromCommonDir(commonDir: string): string {
  const baseName = path.basename(commonDir);
  if (baseName === gitDirName) return path.basename(path.dirname(commonDir));
  return baseName.endsWith(gitDirSuffix) ? baseName.slice(0, -gitDirSuffix.length) : baseName;
}

/** A cached read: its value (`null` = it failed) and when it was made. */
interface CachedRead<TValue> {
  value: TValue | null;
  readAt: number;
}

/** @description Whether a cached read still stands: a success for `ttlMs`, a failure only for the short retry window. */
function checkIsReadFresh<TValue>(cached: CachedRead<TValue> | undefined, nowMs: number, ttlMs: number): cached is CachedRead<TValue> {
  return cached !== undefined && nowMs - cached.readAt < (cached.value === null ? failedRepositoryReadRetryMs : ttlMs);
}

/**
 * @name TodoProjectReadMode
 * @description How a caller learns the projects: `wait` for git (a tool call, `/todo`), or `knownOnly` — what is
 * known now, never waiting (a prompt, the mid-turn poll); a folder never read yet makes the grouping unknown.
 */
export type TodoProjectReadMode = 'wait' | 'knownOnly';

/**
 * @name RepositoryRootCommitStore
 * @description Where the root commits outlive the process, by git common dir — a root commit never changes, and its
 * history walk is the one slow read.
 */
export interface RepositoryRootCommitStore {
  load(): Record<string, string>;
  save(rootCommits: Readonly<Record<string, string>>): void;
}

/** The root commits' file under the store's directory (`DATA_DIR/todos`). */
const rootCommitFileName = 'repositories.json';
const rootCommitFileMode = 0o600;
const rootCommitFileSchema = z.object({ version: z.literal(1), rootCommits: z.record(z.string(), z.string()) });

/**
 * @description The root commits kept in `<todosDir>/repositories.json`. It is a cache: an unreadable file is logged
 * and read as empty (the next walk rewrites it).
 */
export function createRepositoryRootCommitFile(todosDir: string, logWarning: (line: string) => void = (line) => console.warn(line)): RepositoryRootCommitStore {
  const filePath = path.join(todosDir, rootCommitFileName);
  return {
    load() {
      let text: string;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return {};
        logWarning(`[todos] ${filePath} could not be read (${e instanceof Error ? e.message : String(e)}); the repositories' first commits are read from git again`);
        return {};
      }
      try {
        return rootCommitFileSchema.parse(JSON.parse(text)).rootCommits;
      } catch {
        logWarning(`[todos] ${filePath} is unreadable; the repositories' first commits are read from git again`);
        return {};
      }
    },
    save(rootCommits) {
      fs.mkdirSync(todosDir, { recursive: true, mode: 0o700 });
      writeJsonFileAtomically(filePath, { version: 1, rootCommits }, rootCommitFileMode);
    },
  };
}

/** @name RepositoryIdentityReaderDeps @description Git, the clock, where a warning goes and where root commits persist. */
export interface RepositoryIdentityReaderDeps {
  runGit: RunGit;
  getNowMs?: () => number;
  logWarning?: (line: string) => void;
  rootCommitStore?: RepositoryRootCommitStore;
}

/** @name RepositoryIdentityReader @description A folder's repository: waited for, or only what is known now. */
export interface RepositoryIdentityReader {
  /** The folder's repository (`null` = none, or git failed), asking git when the cached read is stale; a read in progress is shared. */
  read(workDir: string): Promise<RepositoryIdentity | null>;
  /**
   * What is known NOW, never waiting for git: the last read's answer — kept past its TTL while a refresh runs in the
   * background — or `undefined` when the folder was never read (a read starts).
   */
  peek(workDir: string): RepositoryIdentity | null | undefined;
}

/**
 * @description A reader of folders' repository identities. Two cheap-to-expensive steps, cached apart: a folder's
 * git common dir (`git rev-parse --git-common-dir`, resolved against the folder — no `--path-format`, which needs git
 * 2.31) for {@link repositoryIdentityTtlMs}, and the repository's root commit by its common dir (the history walk runs
 * once per repository — and, with a {@link RepositoryRootCommitStore}, once per data dir: a root commit never
 * changes). Two reads of one folder at once share one git run. A failed read is tried again after
 * {@link failedRepositoryReadRetryMs}, and a failure on a folder that IS a checkout (it has `.git`) is logged once.
 */
export function createRepositoryIdentityReader(deps: RepositoryIdentityReaderDeps): RepositoryIdentityReader {
  const { runGit, getNowMs = Date.now, logWarning = (line: string) => console.warn(line), rootCommitStore } = deps;
  const commonDirs = new Map<string, CachedRead<string>>();
  const rootCommits = new Map<string, CachedRead<string>>();
  const lastIdentities = new Map<string, RepositoryIdentity | null>();
  const readsInProgress = new Map<string, Promise<RepositoryIdentity | null>>();
  const warnedFolders = new Set<string>();
  let isStoreLoaded = false;

  function loadStoredRootCommits(): void {
    if (isStoreLoaded || !rootCommitStore) return;
    isStoreLoaded = true;
    for (const [commonDir, rootCommit] of Object.entries(rootCommitStore.load())) {
      rootCommits.set(commonDir, { value: rootCommit, readAt: getNowMs() });
    }
  }

  function storeRootCommits(): void {
    if (!rootCommitStore) return;
    const known = Object.fromEntries([...rootCommits].flatMap(([commonDir, cached]) => (cached.value === null ? [] : [[commonDir, cached.value]])));
    try {
      rootCommitStore.save(known);
    } catch (e) {
      logWarning(`[todos] the repositories' first commits could not be stored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function warnOnceIfCheckout(workDir: string, what: string): void {
    if (warnedFolders.has(workDir) || !fs.existsSync(path.join(workDir, gitDirName))) return;
    warnedFolders.add(workDir);
    logWarning(`[todos] git could not read ${what} of ${workDir}: its topic is a project of its own until it can`);
  }

  /** The folder's identity from the cache alone; `undefined` when a step must ask git. */
  function getCachedIdentity(workDir: string): RepositoryIdentity | null | undefined {
    const nowMs = getNowMs();
    const commonDir = commonDirs.get(workDir);
    if (!checkIsReadFresh(commonDir, nowMs, repositoryIdentityTtlMs)) return undefined;
    if (commonDir.value === null) return null;
    const rootCommit = rootCommits.get(commonDir.value);
    if (!checkIsReadFresh(rootCommit, nowMs, Number.POSITIVE_INFINITY)) return undefined;
    return rootCommit.value === null ? null : { rootCommit: rootCommit.value, repositoryName: getRepositoryNameFromCommonDir(commonDir.value) };
  }

  async function readFromGit(workDir: string): Promise<RepositoryIdentity | null> {
    const nowMs = getNowMs();
    let commonDir = commonDirs.get(workDir);
    if (!checkIsReadFresh(commonDir, nowMs, repositoryIdentityTtlMs)) {
      const output = await runGit(workDir, ['rev-parse', '--git-common-dir'], gitQuickQueryTimeoutMs);
      commonDir = { value: output ? path.resolve(workDir, output) : null, readAt: getNowMs() };
      commonDirs.set(workDir, commonDir);
      if (commonDir.value === null) warnOnceIfCheckout(workDir, 'the repository');
    }
    if (commonDir.value !== null && !checkIsReadFresh(rootCommits.get(commonDir.value), nowMs, Number.POSITIVE_INFINITY)) {
      const roots = await runGit(workDir, ['rev-list', '--max-parents=0', 'HEAD'], gitHistoryQueryTimeoutMs);
      const firstRoot = roots?.split('\n').map((line) => line.trim()).filter((line) => line !== '').sort()[0] ?? null;
      rootCommits.set(commonDir.value, { value: firstRoot, readAt: getNowMs() });
      if (firstRoot === null) warnOnceIfCheckout(workDir, 'the first commit');
      else storeRootCommits();
    }
    const identity = getCachedIdentity(workDir) ?? null;
    lastIdentities.set(workDir, identity);
    return identity;
  }

  function read(workDir: string): Promise<RepositoryIdentity | null> {
    loadStoredRootCommits();
    const cached = getCachedIdentity(workDir);
    if (cached !== undefined) {
      lastIdentities.set(workDir, cached);
      return Promise.resolve(cached);
    }
    const inProgress = readsInProgress.get(workDir);
    if (inProgress) return inProgress;
    const started = readFromGit(workDir).finally(() => readsInProgress.delete(workDir));
    readsInProgress.set(workDir, started);
    return started;
  }

  return {
    read,
    peek(workDir) {
      loadStoredRootCommits();
      const cached = getCachedIdentity(workDir);
      if (cached !== undefined) return cached;
      void read(workDir).catch((e: unknown) => logWarning(`[todos] the repository of ${workDir} could not be read: ${e instanceof Error ? e.message : String(e)}`));
      return lastIdentities.get(workDir);
    },
  };
}

/** @description The keys that put a conversation into a union, before overrides. */
function getAutomaticKeys(member: TodoProjectMember, jiraNames: ReadonlySet<string>): string[] {
  if (member.jiraRepositoryNames !== undefined) {
    return member.jiraRepositoryNames === null || member.jiraRepositoryNames.length === 0
      ? [sharedJiraBoardKey]
      : member.jiraRepositoryNames.map((name) => `name:${name}`);
  }
  if (member.identity) {
    const nameKey = `name:${member.identity.repositoryName}`;
    return [`root:${member.identity.rootCommit}`, ...(jiraNames.has(nameKey) ? [nameKey] : [])];
  }
  return member.workDir === null ? [] : [`folder:${member.workDir}`];
}

/** @description What a project is called: its first member's repository folder name (D16). */
function getProjectName(members: readonly TodoProjectMember[]): string {
  for (const member of members) {
    if (member.identity) return member.identity.repositoryName;
    if (member.workDir !== null) return path.basename(member.workDir);
    const [firstName] = member.jiraRepositoryNames ?? [];
    if (firstName !== undefined) return firstName;
  }
  return unnamedJiraProjectName;
}

/**
 * @description Group `members` (in binding order) into projects. `overrides` by conversation key; an override that
 * names a conversation not among the members falls back to automatic.
 */
export function groupTodoProjects(members: readonly TodoProjectMember[], overrides: Readonly<Record<string, TodoProjectOverride>>): TodoProject[] {
  const memberKeys = new Set(members.map((member) => member.conversationKey));
  const jiraNames = new Set(members.flatMap((member) => (member.jiraRepositoryNames ?? []).map((name) => `name:${name}`)));
  const parents = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parents.get(root) !== undefined && parents.get(root) !== root) root = parents.get(root) ?? root;
    parents.set(node, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };
  for (const member of members) {
    const selfNode = `self:${member.conversationKey}`;
    parents.set(selfNode, parents.get(selfNode) ?? selfNode);
    const override = overrides[member.conversationKey];
    if (override?.kind === 'own') continue;
    if (override?.kind === 'join' && memberKeys.has(override.conversationKey) && override.conversationKey !== member.conversationKey) {
      union(`self:${override.conversationKey}`, selfNode);
      continue;
    }
    for (const key of getAutomaticKeys(member, jiraNames)) {
      if (!parents.has(key)) parents.set(key, key);
      union(key, selfNode);
    }
  }
  const projects = new Map<string, TodoProjectMember[]>();
  for (const member of members) {
    const root = find(`self:${member.conversationKey}`);
    projects.set(root, [...(projects.get(root) ?? []), member]);
  }
  return [...projects.values()].map((projectMembers) => ({
    name: getProjectName(projectMembers),
    memberKeys: projectMembers.map((member) => member.conversationKey),
  }));
}
