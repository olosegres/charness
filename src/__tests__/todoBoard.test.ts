/**
 * @description The shared todo registry's projects and boards (plan S3, D15–D21, D55, D57): which conversations share
 * a board (one repository by root commit across clones and worktrees, a non-git folder alone, Jira by `repos` name, the
 * overrides), the board's lines and caps, what each agent has seen (the whole board on a fresh context, then only what
 * changed, nothing when nothing did), the `todo_*` results with the delta, and the Telegram picker and General screens.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import {
  createRepositoryIdentityReader,
  createRepositoryRootCommitFile,
  getRepositoryNameFromCommonDir,
  groupTodoProjects,
  failedRepositoryReadRetryMs,
  repositoryIdentityTtlMs,
  runGitInFolder,
  type RunGit,
  type TodoProject,
  type TodoProjectMember,
} from '../todos/projects';
import { boardMaxChars, createTodoBoard, formatTodoAge, formatTodoBoardBlocks, formatTodoBoardPeerBlock, type TodoSessionActivity } from '../todos/board';
import { TodoStore, createEmptyTodoTopicFile } from '../todos/store';
import { createTodoRegistry } from '../todos/registry';
import { createTodoTools } from '../todos/tools';
import { applyTodoUpdate } from '../todos/merge';
import type { TodoTopicFile } from '../todos/types';
import { formatTodoProjectLine, renderTodoGeneralScreen, renderTodoProjectPicker } from '../connectors/telegram/commands/todo';

const nowMs = new Date(2026, 9, 24, 12, 0, 0).getTime();
const minuteMs = 60 * 1000;
const topicA = makeTelegramKey(-1001111111111, 111);
const topicB = makeTelegramKey(-1001111111111, 222);
const topicC = makeTelegramKey(-1001111111111, 333);
const issue1 = makeJiraKey('PROJ-1');
const issue2 = makeJiraKey('PROJ-2');
const rootX = { rootCommit: 'aaa', repositoryName: 'example-repo' };
const rootY = { rootCommit: 'bbb', repositoryName: 'example-repo' };

function getMemberKeysOf(projects: readonly TodoProject[], key: string): string[] | undefined {
  return projects.find((project) => project.memberKeys.includes(key))?.memberKeys;
}

describe('projects (D15, D16, D57)', () => {
  const a = keyToString(topicA);
  const b = keyToString(topicB);
  const c = keyToString(topicC);
  const j1 = keyToString(issue1);
  const j2 = keyToString(issue2);

  it('one repository by root commit is one project, named after its first member; another root is another project', () => {
    const projects = groupTodoProjects([
      { conversationKey: a, workDir: '/w/example-repo', identity: rootX },
      { conversationKey: b, workDir: '/w/example-repo-2', identity: rootX },
      { conversationKey: c, workDir: '/w/other', identity: rootY },
    ], {});
    assert.deepEqual(getMemberKeysOf(projects, a), [a, b]);
    assert.deepEqual(getMemberKeysOf(projects, c), [c], 'the same folder name is not the same repository');
    assert.equal(projects.find((project) => project.memberKeys.includes(a))?.name, 'example-repo');
  });

  it('a folder that is no checkout is a project of its own, shared by the topics on that folder', () => {
    const projects = groupTodoProjects([
      { conversationKey: a, workDir: '/w/notes', identity: null },
      { conversationKey: b, workDir: '/w/notes', identity: null },
      { conversationKey: c, workDir: '/w/misc', identity: null },
    ], {});
    assert.deepEqual(getMemberKeysOf(projects, a), [a, b]);
    assert.equal(projects.find((project) => project.memberKeys.includes(a))?.name, 'notes');
    assert.deepEqual(getMemberKeysOf(projects, c), [c]);
  });

  it('Jira conversations join by their projects\' repos names, and a topic whose repository has that name joins them', () => {
    const members: TodoProjectMember[] = [
      { conversationKey: j1, workDir: null, identity: null, jiraRepositoryNames: ['example-repo'] },
      { conversationKey: j2, workDir: null, identity: null, jiraRepositoryNames: ['example-repo', 'example-lib'] },
      { conversationKey: a, workDir: '/w/example-repo', identity: rootX },
      { conversationKey: c, workDir: '/w/api', identity: { rootCommit: 'ccc', repositoryName: 'api' } },
    ];
    const projects = groupTodoProjects(members, {});
    assert.deepEqual(getMemberKeysOf(projects, j1), [j1, j2, a]);
    assert.equal(projects.find((project) => project.memberKeys.includes(j1))?.name, 'example-repo');
    assert.deepEqual(getMemberKeysOf(projects, c), [c]);
  });

  it('Jira projects that list no repos all share one board', () => {
    const projects = groupTodoProjects([
      { conversationKey: j1, workDir: null, identity: null, jiraRepositoryNames: null },
      { conversationKey: j2, workDir: null, identity: null, jiraRepositoryNames: null },
    ], {});
    assert.deepEqual(projects, [{ name: 'jira', memberKeys: [j1, j2] }]);
  });

  it('overrides: own leaves the repository\'s project, join takes another topic\'s, a join of a stranger stays automatic', () => {
    const members: TodoProjectMember[] = [
      { conversationKey: a, workDir: '/w/example-repo', identity: rootX },
      { conversationKey: b, workDir: '/w/example-repo-2', identity: rootX },
      { conversationKey: c, workDir: '/w/notes', identity: null },
    ];
    assert.deepEqual(getMemberKeysOf(groupTodoProjects(members, { [b]: { kind: 'own' } }), b), [b]);
    assert.deepEqual(getMemberKeysOf(groupTodoProjects(members, { [c]: { kind: 'join', conversationKey: a } }), c), [a, b, c]);
    assert.deepEqual(getMemberKeysOf(groupTodoProjects(members, { [c]: { kind: 'join', conversationKey: 'gone:1' } }), c), [c]);
  });
});

describe('repository identity', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-git-'))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
  };

  it('a clone and a worktree share the root commit and the repository name; a plain folder has none', async () => {
    const main = path.join(root, 'example-repo');
    fs.mkdirSync(main);
    git(main, 'init');
    fs.writeFileSync(path.join(main, 'README.md'), 'x');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'first');
    git(root, 'clone', '-q', main, path.join(root, 'example-repo-clone'));
    git(main, 'worktree', 'add', '-q', path.join(root, 'feature-x'));
    fs.mkdirSync(path.join(root, 'plain'));
    const { read } = createRepositoryIdentityReader({ runGit: runGitInFolder });
    const [mainIdentity, cloneIdentity, worktreeIdentity, plainIdentity] = await Promise.all(
      ['example-repo', 'example-repo-clone', 'feature-x', 'plain'].map((folder) => read(path.join(root, folder))),
    );
    assert.ok(mainIdentity && /^[0-9a-f]{40}$/.test(mainIdentity.rootCommit));
    assert.equal(cloneIdentity?.rootCommit, mainIdentity.rootCommit);
    assert.deepEqual(worktreeIdentity, mainIdentity, 'a worktree is its main repository');
    assert.equal(cloneIdentity?.repositoryName, 'example-repo-clone', 'a clone is called by its own folder');
    assert.equal(plainIdentity, null);
  });

  it('the name from git\'s common dir: a repository, a submodule, a bare one; the reader caches for its TTL', async () => {
    assert.equal(getRepositoryNameFromCommonDir('/w/example-repo/.git'), 'example-repo');
    assert.equal(getRepositoryNameFromCommonDir('/w/meta/.git/modules/charness'), 'charness');
    assert.equal(getRepositoryNameFromCommonDir('/srv/example-repo.git'), 'example-repo');
    let calls = 0;
    let clockMs = nowMs;
    const runGit: RunGit = async (_dir, args) => {
      calls += 1;
      return args[0] === 'rev-list' ? 'bbb\naaa' : '/w/example-repo/.git';
    };
    const { read } = createRepositoryIdentityReader({ runGit, getNowMs: () => clockMs });
    assert.deepEqual(await read('/w/example-repo'), { rootCommit: 'aaa', repositoryName: 'example-repo' }, 'the first root, sorted');
    await read('/w/example-repo');
    assert.equal(calls, 2, 'cached');
    clockMs += repositoryIdentityTtlMs;
    await read('/w/example-repo');
    assert.equal(calls, 3, 'the folder\'s repository asked again after the TTL; its root commit, kept by repository, not');
  });

  it('a worktree\'s relative common dir is resolved; another folder of one repository walks no history again', async () => {
    const asked: string[] = [];
    const runGit: RunGit = async (dir, args) => {
      asked.push(`${dir} ${args[0]}`);
      if (args[0] === 'rev-list') return 'aaa';
      return dir === '/w/example-repo' ? '.git' : '/w/example-repo/.git/worktrees/feature';
    };
    const { read } = createRepositoryIdentityReader({ runGit, getNowMs: () => nowMs });
    assert.deepEqual(await read('/w/example-repo'), { rootCommit: 'aaa', repositoryName: 'example-repo' }, 'a relative `.git` is the folder\'s own');
    // A real worktree's common dir is the main repository's `.git`; this one names a worktree dir: still one history read per dir.
    await read('/w/feature');
    assert.deepEqual(asked, ['/w/example-repo rev-parse', '/w/example-repo rev-list', '/w/feature rev-parse', '/w/feature rev-list']);
    const sameRepository: RunGit = async (_dir, args) => (args[0] === 'rev-list' ? 'aaa' : '/w/example-repo/.git');
    let historyReads = 0;
    const counting: RunGit = async (dir, args, timeoutMs) => {
      if (args[0] === 'rev-list') historyReads += 1;
      return sameRepository(dir, args, timeoutMs);
    };
    const shared = createRepositoryIdentityReader({ runGit: counting, getNowMs: () => nowMs }).read;
    await shared('/w/example-repo');
    await shared('/w/example-repo-wt');
    assert.equal(historyReads, 1, 'one repository, one history walk');
  });

  it('a failed read is tried again soon, not kept for the TTL; a failure on a checkout is logged once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-gitfail-'));
    try {
      fs.mkdirSync(path.join(root, '.git'));
      let isGitWorking = false;
      let clockMs = nowMs;
      const warnings: string[] = [];
      const runGit: RunGit = async (_dir, args) => {
        if (!isGitWorking) return null;
        return args[0] === 'rev-list' ? 'aaa' : path.join(root, '.git');
      };
      const { read } = createRepositoryIdentityReader({ runGit, getNowMs: () => clockMs, logWarning: (line) => warnings.push(line) });
      assert.equal(await read(root), null);
      assert.equal(await read(root), null);
      assert.equal(warnings.length, 1, 'logged once, not per read');
      isGitWorking = true;
      assert.equal(await read(root), null, 'within the retry window the failure stands');
      clockMs += failedRepositoryReadRetryMs;
      assert.equal((await read(root))?.rootCommit, 'aaa', 'tried again soon after');
      const plainWarnings: string[] = [];
      const plain = createRepositoryIdentityReader({ runGit: async () => null, getNowMs: () => nowMs, logWarning: (line) => plainWarnings.push(line) }).read;
      await plain(path.join(root, 'no-checkout-here'));
      assert.deepEqual(plainWarnings, [], 'a folder that is no checkout is no failure');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repository identity off the prompt path (no prompt waits for git)', () => {
  /** A git that answers only when released: what a slow history walk looks like. */
  function createHeldGit(answer: (args: readonly string[]) => string) {
    const asked: string[] = [];
    let releases: Array<() => void> = [];
    const runGit: RunGit = (_dir, args) => {
      asked.push(args[0]);
      return new Promise((resolve) => { releases.push(() => resolve(answer(args))); });
    };
    /** Answer every waiting call, and the calls those answers start, until git is quiet. */
    async function releaseAll(): Promise<void> {
      for (let round = 0; round < 10; round += 1) {
        const waiting = releases;
        releases = [];
        waiting.forEach((release) => release());
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return { runGit, asked, releaseAll };
  }
  const answerExampleRepo = (args: readonly string[]): string => (args[0] === 'rev-list' ? 'aaa' : '/w/example-repo/.git');

  it('two reads of one folder at once share one git run', async () => {
    const git = createHeldGit(answerExampleRepo);
    const { read } = createRepositoryIdentityReader({ runGit: git.runGit, getNowMs: () => nowMs });
    const both = Promise.all([read('/w/example-repo'), read('/w/example-repo')]);
    await git.releaseAll();
    const [first, second] = await both;
    assert.deepEqual(first, rootX);
    assert.deepEqual(second, rootX);
    assert.deepEqual(git.asked, ['rev-parse', 'rev-list'], 'one git run, not one per reader');
  });

  it('peek never waits: a folder never read is unknown (its read starts), then known; past the TTL the last answer stays while git is asked again', async () => {
    let clockMs = nowMs;
    const git = createHeldGit(answerExampleRepo);
    const reader = createRepositoryIdentityReader({ runGit: git.runGit, getNowMs: () => clockMs });
    assert.equal(reader.peek('/w/example-repo'), undefined, 'unknown, and no wait');
    assert.deepEqual(git.asked, ['rev-parse'], 'the read started');
    assert.equal(reader.peek('/w/example-repo'), undefined);
    await git.releaseAll();
    assert.deepEqual(git.asked, ['rev-parse', 'rev-list'], 'one read, shared by both looks');
    assert.deepEqual(reader.peek('/w/example-repo'), rootX);
    clockMs += repositoryIdentityTtlMs;
    assert.deepEqual(reader.peek('/w/example-repo'), rootX, 'the last answer while the folder is read again');
    assert.deepEqual(git.asked, ['rev-parse', 'rev-list', 'rev-parse'], 'the refresh asks the quick step only');
    await git.releaseAll();
  });

  it('two folders of one new repository at once walk its history once', async () => {
    const git = createHeldGit(answerExampleRepo);
    const { read } = createRepositoryIdentityReader({ runGit: git.runGit, getNowMs: () => nowMs });
    const both = Promise.all([read('/w/example-repo'), read('/w/example-repo-wt')]);
    await git.releaseAll();
    assert.deepEqual(await both, [rootX, rootX]);
    assert.deepEqual(git.asked.filter((command) => command === 'rev-list'), ['rev-list'], 'one walk per repository, not per folder');
  });

  it('a stored root commit answers at once, and this process still walks once: a rewritten history is corrected and logged', async () => {
    const todosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-roots-'));
    try {
      const filePath = path.join(todosDir, 'repositories.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, rootCommits: { '/w/example-repo/.git': 'old' } }));
      const warnings: string[] = [];
      let releaseWalk = (): void => {};
      const asked: string[] = [];
      const runGit: RunGit = async (_dir, args) => {
        asked.push(args[0]);
        if (args[0] !== 'rev-list') return '/w/example-repo/.git';
        await new Promise<void>((resolve) => { releaseWalk = resolve; });
        return 'new';
      };
      const reader = createRepositoryIdentityReader({ runGit, getNowMs: () => nowMs, logWarning: (line) => warnings.push(line), rootCommitStore: createRepositoryRootCommitFile(todosDir) });
      const stored = { rootCommit: 'old', repositoryName: 'example-repo' };
      assert.deepEqual(await reader.read('/w/example-repo'), stored, 'the stored answer, without waiting for the walk');
      assert.deepEqual(reader.peek('/w/example-repo'), stored);
      assert.deepEqual(await reader.read('/w/example-repo-wt'), stored, 'another folder of the repository');
      assert.deepEqual(asked.filter((command) => command === 'rev-list'), ['rev-list'], 'the walk runs once, in the background');
      releaseWalk();
      await new Promise((resolve) => setImmediate(resolve));
      const walked = { rootCommit: 'new', repositoryName: 'example-repo' };
      assert.deepEqual(reader.peek('/w/example-repo'), walked, 'what git says now');
      assert.equal(warnings.length, 1, 'the changed first commit is logged once');
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).rootCommits, { '/w/example-repo/.git': 'new' });
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      await reader.read('/w/example-repo');
      assert.deepEqual(asked.filter((command) => command === 'rev-list'), ['rev-list'], 'walked once per process');
      const brokenWarnings: string[] = [];
      fs.writeFileSync(filePath, '{"version":1,"rootCommits":');
      assert.deepEqual(createRepositoryRootCommitFile(todosDir, (line) => brokenWarnings.push(line)).load(), {});
      assert.equal(brokenWarnings.length, 1, 'one warning for the broken file');
    } finally {
      fs.rmSync(todosDir, { recursive: true, force: true });
    }
  });

  it('a walk that fails keeps the stored root commit: a slow git never splits a known repository', async () => {
    const todosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-roots-'));
    try {
      fs.writeFileSync(path.join(todosDir, 'repositories.json'), JSON.stringify({ version: 1, rootCommits: { '/w/example-repo/.git': 'aaa' } }));
      const runGit: RunGit = async (_dir, args) => (args[0] === 'rev-list' ? null : '/w/example-repo/.git');
      const reader = createRepositoryIdentityReader({ runGit, getNowMs: () => nowMs, logWarning: () => {}, rootCommitStore: createRepositoryRootCommitFile(todosDir) });
      assert.deepEqual(await reader.read('/w/example-repo'), rootX);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(reader.peek('/w/example-repo'), rootX);
    } finally {
      fs.rmSync(todosDir, { recursive: true, force: true });
    }
  });
});

describe('the board lines (D17, D18)', () => {
  function createFile(key = topicA, items: Array<{ title: string; status?: 'queued' | 'inWork' | 'done' }> = []): TodoTopicFile {
    const result = applyTodoUpdate(createEmptyTodoTopicFile(key), { items }, nowMs - 2 * 60 * minuteMs);
    if (!result.ok) throw new Error(result.errors.join());
    return result.file;
  }

  it('a peer\'s block: its session, an old list\'s age, in work, the queue in order with the overflow, done by day', () => {
    const file = { ...createFile(topicA, [
      { title: 'Speed up limits flow tests', status: 'inWork' },
      ...Array.from({ length: 7 }, (_unused, index) => ({ title: `Queued ${index + 1}` })),
      { title: 'Fix leak', status: 'done' },
    ]), lastTurnEndAt: nowMs - 2 * minuteMs };
    assert.equal(
      formatTodoBoardPeerBlock('#flows (charness)', file, 'idle', nowMs),
      '#flows (charness) — active 2 min ago, list 2 h old\n' +
        '  ▶ Speed up limits flow tests — since 10:00\n' +
        '  ▷ queue: 1. Queued 1 · 2. Queued 2 · 3. Queued 3 · 4. Queued 4 · 5. Queued 5 (+2 more)\n' +
        '  ✓ 2026-10-24: Fix leak (10:00)',
    );
    assert.match(formatTodoBoardPeerBlock('PROJ-1 «Export»', { ...file, lastTurnEndAt: nowMs - 60 * minuteMs }, 'asleep', nowMs), /^PROJ-1 «Export» — asleep since 11:00, list 2 h old/);
    assert.match(formatTodoBoardPeerBlock('x', { ...createFile(), lastUpdateAt: nowMs }, 'working', nowMs), /^x — working now\n {2}nothing in work, nothing queued$/);
  });

  it('the block stays within the cap: the most recently active first, the rest named for todo_read', () => {
    const blocks = Array.from({ length: 10 }, (_unused, index) => ({ text: `peer ${index} ${'x'.repeat(400)}`, lastActivityAt: index }));
    const text = formatTodoBoardBlocks('[Project board · p · 10 other topics]', blocks, boardMaxChars);
    assert.ok(text.length <= boardMaxChars, `${text.length}`);
    assert.match(text, /^\[Project board · p · 10 other topics\]\npeer 9 /);
    assert.match(text, /\n… \d+ more topics: todo_read$/);
    assert.equal(formatTodoAge(30 * 1000), 'just now');
    assert.equal(formatTodoAge(3 * 24 * 60 * minuteMs), '3 d ago');
  });
});

describe('what each agent has seen (D19, D20) and the todo_* results (D4)', () => {
  let dataDir: string;
  let clockMs: number;
  let project: TodoProject | null;
  const activities = new Map<string, TodoSessionActivity>();
  let boardShownKeys: string[] = [];
  let isGroupingKnown: boolean;
  /** Which reads the board made: `knownOnly` (a peek, never waiting for git) or `wait`. */
  let readModes: Array<'knownOnly' | 'wait'> = [];
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-todo-board-'));
    clockMs = nowMs;
    project = { name: 'charness', memberKeys: [keyToString(topicA), keyToString(topicB), keyToString(issue1)] };
    boardShownKeys = [];
    isGroupingKnown = true;
    readModes = [];
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function createServices() {
    const store = new TodoStore(dataDir, () => clockMs);
    const registry = createTodoRegistry({ store, getNowMs: () => clockMs });
    const board = createTodoBoard({
      store,
      getProjectOf: async () => {
        readModes.push('wait');
        return project;
      },
      peekProjectOf: () => {
        readModes.push('knownOnly');
        return isGroupingKnown ? project : undefined;
      },
      getPeerLabel: (conversationKey) => (conversationKey === keyToString(issue1) ? 'PROJ-1 «Export to PDF»' : `#${conversationKey.split(':')[1]}`),
      getSessionActivity: (conversationKey) => activities.get(conversationKey) ?? 'idle',
      getNowMs: () => clockMs,
    });
    return { registry, board, tools: createTodoTools({ registry, board, onBoardShown: (key) => boardShownKeys.push(keyToString(key)) }) };
  }

  it('a fresh context gets the whole board and its own list; then only what changed; nothing when nothing did', async () => {
    const { registry, board } = createServices();
    registry.updateTodos(topicB, { items: [{ title: 'Fix the footer', status: 'inWork' }] });
    registry.updateTodos(topicA, { items: [{ title: 'Speed up flows' }] });
    const first = await board.takePromptBoard(topicA);
    assert.match(first ?? '', /^\[Project board · charness · 1 other topic\]\n#222 — active recently\n {2}▶ Fix the footer — since 12:00\n\nYour published todo list:\n▷ queue/);
    assert.doesNotMatch(first ?? '', /PROJ-1/, 'a peer that never published is left out');
    assert.equal(await board.takePromptBoard(topicA), null, 'nothing changed since');
    clockMs += 5 * minuteMs;
    registry.updateTodos(issue1, { items: [{ title: 'Export to PDF', status: 'inWork' }] });
    registry.updateTodos(topicB, {});
    const delta = await board.takePromptBoard(topicA);
    assert.match(delta ?? '', /^\[Project board — changes since 12:00\]\nPROJ-1 «Export to PDF» — active recently\n {2}▶ Export to PDF — since 12:05$/);
    assert.doesNotMatch(delta ?? '', /#222/, 'a "still accurate" update is no change');
  });

  it('a fresh context (and only that) brings the whole board again; what was seen survives a new store', async () => {
    const services = createServices();
    services.registry.updateTodos(topicB, { items: [{ title: 'Fix the footer' }] });
    await services.board.takePromptBoard(topicA);
    assert.equal(await createServices().board.takePromptBoard(topicA), null, 'a restart keeps what was seen');
    services.board.noteFreshContext(topicA);
    assert.match(await createServices().board.takePromptBoard(topicA) ?? '', /^\[Project board · charness · 1 other topic\]/);
  });

  it('a topic alone in its project gets no board; on a fresh context its own list only', async () => {
    project = { name: 'notes', memberKeys: [keyToString(topicA)] };
    const { registry, board } = createServices();
    assert.equal(await board.takePromptBoard(topicA), null);
    registry.updateTodos(topicA, { items: [{ title: 'Write notes' }] });
    board.noteFreshContext(topicA);
    assert.match(await board.takePromptBoard(topicA) ?? '', /^Your published todo list:/);
    project = null;
    assert.equal(await board.takePromptBoard(topicA), null, 'an unbound topic is in no project');
  });

  it('a prompt and the mid-turn poll never wait for git: while the grouping is unknown no board, nothing seen; the tools wait', async () => {
    const { registry, board, tools } = createServices();
    registry.updateTodos(topicB, { items: [{ title: 'Fix the footer' }] });
    isGroupingKnown = false;
    assert.equal(await board.takePromptBoard(topicA), null, 'no board while the grouping is unknown, and no own list to show');
    registry.updateTodos(topicA, { items: [{ title: 'Speed up flows', status: 'inWork' }] });
    assert.match(await board.takePromptBoard(topicA) ?? '', /^Your published todo list:\n▶ in work:\n {2}t1 Speed up flows/, 'a fresh context still gets its own list');
    isGroupingKnown = true;
    assert.match(await board.takePromptBoard(topicA) ?? '', /^\[Project board · charness · 1 other topic\][\s\S]*\n\nYour published todo list:/, 'still the whole board: nothing was marked seen');
    registry.updateTodos(topicB, { items: [{ title: 'Fix the header' }] });
    isGroupingKnown = false;
    assert.equal(await board.peekChanges(topicA), null);
    isGroupingKnown = true;
    assert.match((await board.peekChanges(topicA))?.text ?? '', /Fix the header/);
    await tools.read(topicA, {});
    await tools.read(topicA, { scope: 'project' });
    assert.deepEqual(readModes, ['knownOnly', 'knownOnly', 'knownOnly', 'knownOnly', 'knownOnly', 'wait', 'wait']);
  });

  it('a prompt\'s board and a mid-turn peek are taken without yielding: nothing awaited between the forward\'s decision and its write', () => {
    // An await there lets a stop queued in the same tick (the per-turn stop at a turn's end) begin first and take the prompt with it.
    const { registry, board } = createServices();
    registry.updateTodos(topicB, { items: [{ title: 'Fix the footer', status: 'inWork' }] });
    const peeked = board.peekChanges(topicA);
    assert.notEqual(Promise.resolve(peeked), peeked, 'the peek is not a promise');
    const taken = board.takePromptBoard(topicA);
    assert.notEqual(Promise.resolve(taken), taken, 'the prompt board is not a promise');
    assert.match(taken ?? '', /^\[Project board · charness · 1 other topic\]/);
  });

  it('todo_update and todo_read answer the own list and the delta; the project scope the whole board', async () => {
    const { registry, tools } = createServices();
    registry.updateTodos(topicB, { items: [{ title: 'Fix the footer' }] });
    const first = await tools.update(topicA, { items: [{ title: 'Speed up flows', status: 'inWork' }] });
    assert.match(first.ok ? first.message : '', /^Saved\. New item: t1\.\n\nYour published todo list:[\s\S]*\n\n\[Project board · charness · 1 other topic\]\n#222/);
    const again = await tools.read(topicA, {});
    assert.match(again.ok ? again.message : '', /\n\nNo changes in the project's other topics since 12:00\.$/);
    const whole = await tools.read(topicA, { scope: 'project' });
    assert.match(whole.ok ? whole.message : '', /^\[Project board · charness · 1 other topic\]\n#222/);
    const refused = await tools.update(topicA, { items: [{ id: 't9' }] });
    assert.equal(refused.ok, false, 'a refusal carries no board');
    assert.deepEqual(boardShownKeys, [keyToString(topicA), keyToString(topicA), keyToString(topicA)], 'every result that showed the board withdraws a waiting inbox; a refusal none');
  });
});

describe('the Telegram picker and General screens', () => {
  const candidates = Array.from({ length: 8 }, (_unused, index) => ({ conversationKey: `-1001111111111:${index}`, label: `#t${index}` }));

  it('the picker: ✓ on the current choice, one page of joins with arrows, back to the list', () => {
    const page0 = renderTodoProjectPicker('flows', { name: 'charness', memberCount: 3, override: null, candidates }, 0);
    assert.equal(page0.text, 'Project for flows\n\nNow: charness — automatic · topics: 3');
    assert.deepEqual(page0.rows.map((row) => row.map((button) => `${button.label}|${button.data}`)), [
      ['✓ Automatic|todo_prj_auto'],
      ...candidates.slice(0, 6).map((candidate, index) => [`Join the project of ${candidate.label}|todo_prj_join_${index}`]),
      ['Own project|todo_prj_own'],
      ['›|todo_prj_page_1'],
      ['‹ Back|todo_list'],
    ]);
    const joined = renderTodoProjectPicker('flows', { name: 'charness', memberCount: 3, override: { kind: 'join', conversationKey: candidates[7].conversationKey }, candidates }, 1);
    assert.deepEqual(joined.rows.map((row) => row.map((button) => button.label)), [['Automatic'], ['Join the project of #t6'], ['✓ Join the project of #t7'], ['Own project'], ['‹'], ['‹ Back']]);
    assert.equal(formatTodoProjectLine({ name: 'notes', memberCount: 1, override: { kind: 'own' }, candidates: [] }), 'Project: notes · topics: 1 (own project)');
  });

  it('General: every project with its topics — asleep, in work, the queue', () => {
    const screen = renderTodoGeneralScreen({ isEnabled: true, reminderMinutes: 60 }, [{
      name: 'charness',
      members: [
        { label: '#flows', isAsleep: false, inWorkTitles: ['Speed up limits flow tests'], queueCount: 2 },
        { label: '#docs', isAsleep: true, inWorkTitles: ['README', 'Changelog'], queueCount: 0 },
        { label: '#release', isAsleep: false, inWorkTitles: [], queueCount: 1 },
      ],
    }]);
    assert.equal(screen.text, '📋 Todo — all projects\n\ncharness · topics: 3\n   #flows   ▶ Speed up limits flow tests · queue 2\n   #docs   asleep · ▶ README (+1)\n   #release   nothing in work · queue 1');
    assert.match(renderTodoGeneralScreen({ isEnabled: true, reminderMinutes: 60 }, []).text, /No topic is bound to a folder yet\.$/);
  });
});
