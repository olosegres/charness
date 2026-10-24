import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

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

/** How long a folder's repository identity is trusted before git is asked again (a folder may become a checkout). */
export const repositoryIdentityTtlMs = 10 * 60 * 1000;
/** A git query that takes longer is abandoned: the folder then counts as no checkout. */
const gitQueryTimeoutMs = 5000;
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

/** @description Run git in `workDir`; its trimmed stdout, or `null` when it failed or ran too long. */
export type RunGit = (workDir: string, args: readonly string[]) => Promise<string | null>;

const execFileAsync = promisify(execFile);

/** @description The real git, bounded by {@link gitQueryTimeoutMs}. */
export const runGitInFolder: RunGit = async (workDir, args) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workDir, ...args], { timeout: gitQueryTimeoutMs, encoding: 'utf8' });
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

/** @description A reader of folders' repository identities, cached for {@link repositoryIdentityTtlMs}. */
export function createRepositoryIdentityReader(runGit: RunGit, getNowMs: () => number = Date.now): (workDir: string) => Promise<RepositoryIdentity | null> {
  const cache = new Map<string, { identity: RepositoryIdentity | null; readAt: number }>();
  return async (workDir) => {
    const cached = cache.get(workDir);
    if (cached && getNowMs() - cached.readAt < repositoryIdentityTtlMs) return cached.identity;
    const [roots, commonDir] = await Promise.all([
      runGit(workDir, ['rev-list', '--max-parents=0', 'HEAD']),
      runGit(workDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    const rootCommit = roots?.split('\n').map((line) => line.trim()).filter((line) => line !== '').sort()[0];
    const identity = rootCommit && commonDir ? { rootCommit, repositoryName: getRepositoryNameFromCommonDir(commonDir) } : null;
    cache.set(workDir, { identity, readAt: getNowMs() });
    return identity;
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
