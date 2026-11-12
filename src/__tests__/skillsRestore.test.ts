/**
 * @description The skills restore's pure core (`utils/skillsRestore.ts`): which skills a Claude transcript shows were
 * loaded since the previous compaction, which of them Claude's own re-attach carries whole, what each comes back as, and
 * the text the agent gets — whole for OpenCode, cut into labelled hook parts for Claude. The records are shaped like the
 * ones Claude Code 2.1.322 writes (measured for the plan's S0).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildClaudeSkillsRestoreParts,
  buildSkillsRestoreText,
  claudeReattachBudgetChars,
  claudeReattachSkillMaxChars,
  claudeSkillBaseDirPrefix,
  collectClaudeEpochSkills,
  getClaudeReattachedWholeSkills,
  getOpenCodeLoadedSkills,
  parseSkillsRestoreList,
  planClaudeSkillsRestore,
  planOpenCodeSkillsRestore,
  renderSkillsRestoreList,
  renderSkillsRestoreSection,
  skillsRestorePartMaxChars,
  skillsRestoreSlotCount,
  skillsRestoreTexts,
  stripSkillFrontmatter,
  type ClaudeEpochSkills,
  type OpenCodeRestoreMessage,
  type SkillFolderReader,
  type SkillsRestoreEntry,
} from '../utils/skillsRestore';
import { skillsRestoreHeader } from '../utils/compactOnIdle';

const skillsRoot = '/home/user/project/.claude/skills';
const pluginSkillsRoot = '/home/user/charness/agent-plugin/skills';

function getSkillDir(name: string): string {
  return `${skillsRoot}/${name}`;
}

/** Claude's skill message: the `Base directory…` line, a blank line, the body. */
function buildSkillMessage(dir: string, body: string): string {
  return `${claudeSkillBaseDirPrefix}${dir}\n\n${body}`;
}

function toLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

/** The three records of a successful Skill tool call, as the CLI writes them. */
function buildSkillToolLoad(toolUseId: string, skillName: string, dir: string, body: string): string[] {
  return [
    toLine({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Skill', input: { skill: skillName } }] } }),
    toLine({ type: 'user', isSidechain: false, toolUseResult: { success: true, commandName: skillName }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Launching skill: ${skillName}` }] } }),
    toLine({ type: 'user', isSidechain: false, isMeta: true, sourceToolUseID: toolUseId, message: { role: 'user', content: [{ type: 'text', text: buildSkillMessage(dir, body) }] } }),
  ];
}

/** A skill the person invoked with a slash command: the command record, then the skill message (no tool call) under it. */
function buildSlashLoad(skillName: string, dir: string, body: string): string[] {
  const commandUuid = `uuid-command-${skillName}`;
  return [
    toLine({ type: 'user', uuid: commandUuid, isSidechain: false, message: { role: 'user', content: `<command-message>${skillName}</command-message>\n<command-name>/${skillName}</command-name>` } }),
    toLine({ type: 'user', uuid: `uuid-skill-${skillName}`, parentUuid: commandUuid, isSidechain: false, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: buildSkillMessage(dir, body) }] } }),
  ];
}

function buildInvokedSkills(skills: ReadonlyArray<{ name: string; content: string }>): string {
  return toLine({ type: 'attachment', attachment: { type: 'invoked_skills', skills: skills.map((skill) => ({ ...skill, path: `projectSettings:${skill.name}` })) } });
}

function buildHookContext(contents: readonly string[]): string {
  return toLine({ type: 'attachment', attachment: { type: 'hook_additional_context', content: contents, hookName: 'SessionStart', hookEvent: 'SessionStart' } });
}

const reviewBody = '# review\n\nRead the diff line by line.\n';
const commitBody = '# commit\n\nCommit per scope.\n';

// ── collectClaudeEpochSkills ──

test('collectClaudeEpochSkills: a Skill tool load is named by the call, newest first, one per skill', () => {
  const lines = [
    ...buildSkillToolLoad('toolu_1', 'review', getSkillDir('review'), reviewBody),
    ...buildSkillToolLoad('toolu_2', 'charness:charness-orchestration', `${pluginSkillsRoot}/charness-orchestration`, '# orchestration\n'),
    ...buildSkillToolLoad('toolu_3', 'review', getSkillDir('review'), `${reviewBody}v2\n`),
  ];
  const epoch = collectClaudeEpochSkills(lines);
  assert.deepEqual(epoch.loads.map((load) => load.name), ['review', 'charness:charness-orchestration'], 'the namespaced name stays whole; review once, as its newest load');
  assert.equal(epoch.loads[0].heldContent, buildSkillMessage(getSkillDir('review'), `${reviewBody}v2\n`));
  assert.equal(epoch.loads[1].baseDir, `${pluginSkillsRoot}/charness-orchestration`);
});

test('collectClaudeEpochSkills: a FAILED Skill call counts for nothing — no skill message followed it', () => {
  const lines = [
    toLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Skill', input: { skill: 'missing-skill' } }] } }),
    toLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'Unknown skill: missing-skill' }] } }),
  ];
  assert.deepEqual(collectClaudeEpochSkills(lines).loads, []);
});

test('collectClaudeEpochSkills: a slash-invoked skill is named by its command; with no command, by its folder', () => {
  const lines = [
    ...buildSlashLoad('commit', getSkillDir('commit'), commitBody),
    // A slash command that is no skill (no skill message follows) names nothing.
    toLine({ type: 'user', uuid: 'uuid-compact', message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
    toLine({ type: 'user', uuid: 'uuid-plain', parentUuid: 'uuid-compact', message: { role: 'user', content: 'plain words with Skill in them' } }),
    toLine({ type: 'user', isMeta: true, parentUuid: 'uuid-plain', message: { role: 'user', content: [{ type: 'text', text: buildSkillMessage(getSkillDir('folder-named'), 'x') }] } }),
  ];
  assert.deepEqual(collectClaudeEpochSkills(lines).loads.map((load) => load.name), ['folder-named', 'commit']);
});

test('collectClaudeEpochSkills: a sub-agent\'s records, the CLI\'s request copies and garbage lines are not loads', () => {
  const lines = [
    ...buildSkillToolLoad('toolu_s', 'sub-skill', getSkillDir('sub-skill'), 'x').map((line) => line.replace('"isSidechain":false', '"isSidechain":true')),
    toLine({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: buildSkillMessage(getSkillDir('copy'), 'x') }] } }),
    '{"type":"user","isMeta":true,"message":{"content":"Base directory for this skill: /half',
    'not json Skill',
    // A skill message that is not `isMeta` is something the person typed.
    toLine({ type: 'user', message: { role: 'user', content: buildSkillMessage(getSkillDir('typed'), 'x') } }),
  ];
  assert.deepEqual(collectClaudeEpochSkills(lines).loads, []);
});

test('collectClaudeEpochSkills: Claude\'s re-attach of the previous compaction carries the older skills, newest first', () => {
  const reattached = buildInvokedSkills([
    { name: 'commit', content: buildSkillMessage(getSkillDir('commit'), commitBody) },
    { name: 'review', content: buildSkillMessage(getSkillDir('review'), reviewBody) },
  ]);
  const epoch = collectClaudeEpochSkills([reattached]);
  assert.deepEqual(epoch.reattached.map((load) => [load.name, load.baseDir]), [['commit', getSkillDir('commit')], ['review', getSkillDir('review')]]);
});

test('collectClaudeEpochSkills: the bot\'s previous restore is counted — its list, not the lines of the skill texts after it', () => {
  const entries: SkillsRestoreEntry[] = [
    { name: 'test-guru', status: 'text', baseDir: getSkillDir('test-guru'), body: '# test-guru\n\n- not-a-skill: a list line inside a skill\n' },
    { name: 'commit', status: 'inContext', baseDir: getSkillDir('commit'), body: null },
    { name: 'gone', status: 'unavailable', baseDir: getSkillDir('gone'), body: null },
    { name: 'no-dir', status: 'loadWithTool', baseDir: null, body: null },
  ];
  const parts = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars);
  // The hook's texts reach the transcript in the order the hooks finished, so the list's part need not come first.
  const epoch = collectClaudeEpochSkills([buildHookContext([...parts].reverse()), buildHookContext(['someone else\'s hook text'])]);
  assert.deepEqual(epoch.previousRestore, [
    { name: 'test-guru', baseDir: getSkillDir('test-guru') },
    { name: 'commit', baseDir: getSkillDir('commit') },
    { name: 'gone', baseDir: getSkillDir('gone') },
    { name: 'no-dir', baseDir: null },
  ], 'a later hook text that holds no restore does not wipe the restore before it');
});

// ── getClaudeReattachedWholeSkills (the measured rule of Claude's own re-attach) ──

/** A skill message of exactly `size` characters. */
function buildSizedMessage(name: string, size: number): string {
  const head = buildSkillMessage(getSkillDir(name), '');
  return `${head}${'r'.repeat(size - head.length)}`;
}

test('getClaudeReattachedWholeSkills: whole up to 20,000 characters; a longer one, or one already cut, is not', () => {
  const epoch: ClaudeEpochSkills = {
    loads: [
      { name: 'small', baseDir: getSkillDir('small'), heldContent: buildSizedMessage('small', 13_838) },
      { name: 'edge', baseDir: getSkillDir('edge'), heldContent: buildSizedMessage('edge', claudeReattachSkillMaxChars) },
      { name: 'big', baseDir: getSkillDir('big'), heldContent: buildSizedMessage('big', 23_890) },
    ],
    reattached: [{ name: 'cut', baseDir: getSkillDir('cut'), heldContent: `${buildSizedMessage('cut', 19_000)}\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]` }],
    previousRestore: [],
  };
  assert.deepEqual([...getClaudeReattachedWholeSkills(epoch).keys()], ['small', 'edge']);
});

test('getClaudeReattachedWholeSkills: newest first within the 100,000-character budget — of six 18,798-character skills the oldest drops (measured)', () => {
  const names = ['s6', 's5', 's4', 's3', 's2', 's1'];
  const epoch: ClaudeEpochSkills = {
    loads: names.map((name) => ({ name, baseDir: getSkillDir(name), heldContent: buildSizedMessage(name, 18_798) })),
    reattached: [],
    previousRestore: [],
  };
  assert.ok(5 * 18_798 <= claudeReattachBudgetChars && 6 * 18_798 > claudeReattachBudgetChars);
  assert.deepEqual([...getClaudeReattachedWholeSkills(epoch).keys()], ['s6', 's5', 's4', 's3', 's2']);
});

test('getClaudeReattachedWholeSkills: this epoch\'s load of a skill wins over the previous re-attach of it', () => {
  const epoch: ClaudeEpochSkills = {
    loads: [{ name: 'review', baseDir: getSkillDir('review'), heldContent: buildSkillMessage(getSkillDir('review'), 'new') }],
    reattached: [{ name: 'review', baseDir: getSkillDir('review'), heldContent: buildSkillMessage(getSkillDir('review'), 'old') }],
    previousRestore: [],
  };
  assert.equal(getClaudeReattachedWholeSkills(epoch).get('review'), buildSkillMessage(getSkillDir('review'), 'new'));
});

// ── planClaudeSkillsRestore (the resolver) ──

function createFolders(files: Record<string, string>): SkillFolderReader {
  return { readSkillFile: (baseDir) => files[`${baseDir}/SKILL.md`] ?? null };
}

const frontmatter = '---\nname: x\ndescription: y\n---\n\n';

test('planClaudeSkillsRestore: Claude carries it whole and current → only named; changed on disk → its CURRENT text; gone → not available now', () => {
  const epoch: ClaudeEpochSkills = {
    loads: [
      { name: 'review', baseDir: getSkillDir('review'), heldContent: buildSkillMessage(getSkillDir('review'), reviewBody) },
      { name: 'commit', baseDir: getSkillDir('commit'), heldContent: buildSkillMessage(getSkillDir('commit'), 'the old text\n') },
      { name: 'gone', baseDir: getSkillDir('gone'), heldContent: buildSkillMessage(getSkillDir('gone'), 'x') },
    ],
    reattached: [],
    previousRestore: [],
  };
  const folders = createFolders({
    [`${getSkillDir('review')}/SKILL.md`]: `${frontmatter}${reviewBody}`,
    [`${getSkillDir('commit')}/SKILL.md`]: `${frontmatter}${commitBody}`,
  });
  assert.deepEqual(planClaudeSkillsRestore(epoch, folders, null), [
    { name: 'review', status: 'inContext', baseDir: getSkillDir('review'), body: null },
    { name: 'commit', status: 'text', baseDir: getSkillDir('commit'), body: commitBody },
    { name: 'gone', status: 'unavailable', baseDir: getSkillDir('gone'), body: null },
  ]);
});

test('planClaudeSkillsRestore: a skill Claude cuts comes back whole; the bot\'s own skills of a process started without them are not available now', () => {
  const bigBody = 'b'.repeat(30_000);
  const epoch: ClaudeEpochSkills = {
    loads: [
      { name: 'big', baseDir: getSkillDir('big'), heldContent: buildSkillMessage(getSkillDir('big'), bigBody) },
      { name: 'charness:charness-orchestration', baseDir: `${pluginSkillsRoot}/charness-orchestration`, heldContent: buildSkillMessage(`${pluginSkillsRoot}/charness-orchestration`, 'o') },
    ],
    reattached: [],
    previousRestore: [],
  };
  const folders = createFolders({ [`${getSkillDir('big')}/SKILL.md`]: bigBody, [`${pluginSkillsRoot}/charness-orchestration/SKILL.md`]: 'o' });
  assert.deepEqual(planClaudeSkillsRestore(epoch, folders, pluginSkillsRoot).map((entry) => [entry.name, entry.status, entry.body?.length ?? null]), [
    ['big', 'text', 30_000],
    ['charness:charness-orchestration', 'unavailable', null],
  ]);
  // The same process WITH the bot's skills: available — and small and current, so Claude's own re-attach carries it.
  assert.equal(planClaudeSkillsRestore(epoch, folders, null)[1].status, 'inContext');
});

test('planClaudeSkillsRestore: skills the previous restore carried come back again; a name with no known folder gets the load line', () => {
  const epoch: ClaudeEpochSkills = {
    loads: [],
    reattached: [],
    previousRestore: [{ name: 'test-guru', baseDir: getSkillDir('test-guru') }, { name: 'mystery', baseDir: null }],
  };
  const folders = createFolders({ [`${getSkillDir('test-guru')}/SKILL.md`]: `${frontmatter}# test-guru\n` });
  assert.deepEqual(planClaudeSkillsRestore(epoch, folders, null), [
    { name: 'test-guru', status: 'text', baseDir: getSkillDir('test-guru'), body: '# test-guru\n' },
    { name: 'mystery', status: 'loadWithTool', baseDir: null, body: null },
  ]);
});

test('planClaudeSkillsRestore: no skill was ever loaded → nothing at all', () => {
  assert.deepEqual(planClaudeSkillsRestore({ loads: [], reattached: [], previousRestore: [] }, createFolders({}), null), []);
  assert.deepEqual(buildClaudeSkillsRestoreParts([], skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars), []);
  assert.equal(buildSkillsRestoreText([], skillsRestoreTexts, 'skill'), '');
});

test('stripSkillFrontmatter: the body as the CLI loads it — no frontmatter, no blank lines before it', () => {
  assert.equal(stripSkillFrontmatter(`${frontmatter}# x\n\nbody\n`), '# x\n\nbody\n');
  assert.equal(stripSkillFrontmatter('---\r\nname: x\r\n---\r\n\r\n# x\r\n'), '# x\n');
  assert.equal(stripSkillFrontmatter('# no frontmatter\n'), '# no frontmatter\n');
  assert.equal(stripSkillFrontmatter('---\nname: x\nnever closed'), '---\nname: x\nnever closed');
});

// ── the payload ──

test('buildSkillsRestoreText (OpenCode, one text): the header, every skill with where its text is, then each restored skill whole', () => {
  const entries: SkillsRestoreEntry[] = [
    { name: 'review', status: 'text', baseDir: getSkillDir('review'), body: reviewBody },
    { name: 'commit', status: 'inContext', baseDir: getSkillDir('commit'), body: null },
    { name: 'gone', status: 'unavailable', baseDir: null, body: null },
    { name: 'later', status: 'loadWithTool', baseDir: null, body: null },
  ];
  const text = buildSkillsRestoreText(entries, skillsRestoreTexts, 'skill');
  assert.ok(text.startsWith(`${skillsRestoreHeader}\n`));
  assert.ok(text.includes(`- review: its current full text is below (base directory: ${getSkillDir('review')})`));
  assert.ok(text.includes(`- commit: its full text is already in your context (base directory: ${getSkillDir('commit')})`));
  assert.ok(text.includes('- gone: was loaded before but is not available now'));
  assert.ok(text.includes('- later: not restored here: load it with the skill tool'));
  assert.ok(text.includes(`## Skill: review\n${claudeSkillBaseDirPrefix}${getSkillDir('review')}\n\n${reviewBody}`), 'the skill whole, with its base directory');
  assert.ok(!text.includes('## Skill: commit'), 'a skill already in the context is only named');
  assert.ok(!text.includes('(part'), 'one text has no part labels');
});

/** The bodies a set of parts carries, reassembled by part number whatever the order they arrive in. */
function reassembleParts(parts: readonly string[]): string {
  return parts.map((part) => part.split('\n').slice(1).join('\n')).join('\n');
}

test('buildClaudeSkillsRestoreParts: every part fits a hook\'s cap, carries its label, and every skill comes back WHOLE — one too long for a part goes on over several', () => {
  const longLines = Array.from({ length: 600 }, (_value, index) => `Rule ${index}: a line of the long skill that keeps the counter ${index}.`);
  const entries: SkillsRestoreEntry[] = [
    { name: 'test-guru', status: 'text', baseDir: getSkillDir('test-guru'), body: longLines.join('\n') },
    { name: 'review', status: 'text', baseDir: getSkillDir('review'), body: reviewBody },
  ];
  const parts = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars);
  assert.ok(parts.length > 3, `the long skill needs several parts: ${parts.length}`);
  for (const [index, part] of parts.entries()) {
    assert.ok(part.length <= skillsRestorePartMaxChars, `part ${index + 1} is ${part.length} characters`);
    assert.ok(part.startsWith(`${skillsRestoreHeader} (part ${index + 1} of ${parts.length})\n`), `part ${index + 1} label`);
  }
  assert.ok(parts[0].includes(skillsRestoreTexts.multiPartNote), 'the list says the parts may come in any order');
  const joined = reassembleParts(parts);
  // Every line of the long skill is there, in order, each whole — only the "continued" headings come between parts.
  const withoutContinued = joined.split('\n').filter((line) => !line.startsWith('## Skill: test-guru (continued from part ')).join('\n');
  assert.ok(withoutContinued.includes(longLines.join('\n')), 'the long skill is whole across its parts');
  assert.ok(joined.includes(`## Skill: review\n${claudeSkillBaseDirPrefix}${getSkillDir('review')}\n\n${reviewBody}`));
  assert.ok(parts.slice(1).every((part) => part.split('\n')[1].startsWith('## Skill: ')), 'a part after the first opens with a skill heading');
});

test('buildClaudeSkillsRestoreParts: one part needs no label and no note', () => {
  const parts = buildClaudeSkillsRestoreParts([{ name: 'review', status: 'text', baseDir: getSkillDir('review'), body: reviewBody }], skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], buildSkillsRestoreText([{ name: 'review', status: 'text', baseDir: getSkillDir('review'), body: reviewBody }], skillsRestoreTexts, 'Skill'));
});

test('buildClaudeSkillsRestoreParts: a line too long for a part of its own is cut where the part ends, and nothing of it is lost', () => {
  const hugeLine = 'x'.repeat(skillsRestorePartMaxChars * 2);
  const parts = buildClaudeSkillsRestoreParts([{ name: 'minified', status: 'text', baseDir: getSkillDir('minified'), body: hugeLine }], skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars);
  assert.ok(parts.every((part) => part.length <= skillsRestorePartMaxChars));
  const joined = reassembleParts(parts);
  const section = joined.slice(joined.indexOf(`${claudeSkillBaseDirPrefix}${getSkillDir('minified')}\n\n`)).split('\n\n')[1];
  assert.equal(section.replace(/\n## Skill: minified \(continued from part \d+\)\n/g, ''), hugeLine);
});

test('buildClaudeSkillsRestoreParts: a skill that no longer fits the slots gets the load line — the newer skills keep their text', () => {
  const partBody = (seed: string): string => Array.from({ length: 120 }, (_value, index) => `${seed} line ${index} of a skill that fills about a part.`).join('\n');
  const entries: SkillsRestoreEntry[] = ['newest', 'middle', 'oldest'].map((name) => ({ name, status: 'text', baseDir: getSkillDir(name), body: partBody(name) }));
  const slotCount = 2;
  const parts = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, slotCount, skillsRestorePartMaxChars);
  assert.ok(parts.length <= slotCount);
  const joined = reassembleParts(parts);
  assert.ok(joined.includes(partBody('newest')), 'the newest skill keeps its text');
  assert.ok(joined.includes('- oldest: not restored here: load it with the Skill tool'), `the oldest gets the load line: ${joined.slice(0, 900)}`);
  assert.ok(!joined.includes('## Skill: oldest'));
});

test('parseSkillsRestoreList: reads the names back from the parts in any order, never from a skill\'s own text', () => {
  const entries: SkillsRestoreEntry[] = [
    { name: 'a', status: 'text', baseDir: '/x/a', body: '- b: looks like a list line\n' },
    { name: 'c', status: 'inContext', baseDir: '/x/c', body: null },
  ];
  const parts = buildClaudeSkillsRestoreParts(entries, skillsRestoreTexts, skillsRestoreSlotCount, skillsRestorePartMaxChars);
  assert.deepEqual(parseSkillsRestoreList([...parts].reverse()), [{ name: 'a', baseDir: '/x/a' }, { name: 'c', baseDir: '/x/c' }]);
  assert.deepEqual(parseSkillsRestoreList(['some other hook text\n- z: no']), []);
});

// ── OpenCode: the history, the block and the server ──

function buildSkillCall(name: string, status: 'completed' | 'error', dir: string | null): OpenCodeRestoreMessage {
  return {
    info: { role: 'assistant' },
    parts: [
      { type: 'step-start' },
      { type: 'tool', tool: 'skill', state: { status, input: { name }, metadata: status === 'completed' ? { name, ...(dir === null ? {} : { dir }) } : undefined } },
    ],
  };
}

test('getOpenCodeLoadedSkills: every COMPLETED skill call, newest first, one per name, with the folder it recorded', () => {
  const history: OpenCodeRestoreMessage[] = [
    { info: { role: 'user' }, parts: [{ type: 'text' }] },
    buildSkillCall('review', 'completed', '/x/review'),
    buildSkillCall('missing', 'error', null),
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed' } }] },
    buildSkillCall('commit', 'completed', '/x/commit'),
    buildSkillCall('review', 'completed', '/x/review'),
  ];
  assert.deepEqual(getOpenCodeLoadedSkills(history), [{ name: 'review', baseDir: '/x/review' }, { name: 'commit', baseDir: '/x/commit' }]);
});

const offeredSkills = [
  { name: 'review', location: '/x/review/SKILL.md', content: reviewBody },
  { name: 'commit', location: '/x/commit/SKILL.md', content: commitBody },
  { name: 'from-block', location: '/x/from-block/SKILL.md', content: '# from block\n' },
];

test('planOpenCodeSkillsRestore: the server\'s CURRENT text; a skill already after the summary only named; the block adds what the history misses; gone → not available now', () => {
  const entries = planOpenCodeSkillsRestore({
    loaded: [{ name: 'review', baseDir: '/old/review' }, { name: 'commit', baseDir: '/x/commit' }, { name: 'gone', baseDir: '/x/gone' }],
    blockNames: ['commit', 'from-block'],
    inContextNames: ['commit'],
    available: offeredSkills,
  });
  assert.deepEqual(entries, [
    { name: 'review', status: 'text', baseDir: '/x/review', body: reviewBody },
    { name: 'commit', status: 'inContext', baseDir: '/x/commit', body: null },
    { name: 'gone', status: 'unavailable', baseDir: '/x/gone', body: null },
    { name: 'from-block', status: 'text', baseDir: '/x/from-block', body: '# from block\n' },
  ]);
});

test('planOpenCodeSkillsRestore: no answer from the server — every skill not in the context gets the load line; nothing loaded → nothing', () => {
  assert.deepEqual(
    planOpenCodeSkillsRestore({ loaded: [{ name: 'review', baseDir: '/x/review' }], blockNames: ['commit'], inContextNames: [], available: null }).map((entry) => [entry.name, entry.status]),
    [['review', 'loadWithTool'], ['commit', 'loadWithTool']],
  );
  assert.deepEqual(planOpenCodeSkillsRestore({ loaded: [], blockNames: [], inContextNames: [], available: offeredSkills }), []);
});

test('the OpenCode functions are self-contained — they work from their own source alone, as the plugin embeds them', () => {
  const sources = [getOpenCodeLoadedSkills, planOpenCodeSkillsRestore, renderSkillsRestoreList, renderSkillsRestoreSection, buildSkillsRestoreText].map((fn) => fn.toString()).join(';\n');
  // `__name`: the helper the test runner's transform injects into function bodies (the built `dist/` has none).
  const embedded: { build: typeof buildSkillsRestoreText; plan: typeof planOpenCodeSkillsRestore; loaded: typeof getOpenCodeLoadedSkills } = new Function(`const __name = (target) => target; ${sources}; return { build: buildSkillsRestoreText, plan: planOpenCodeSkillsRestore, loaded: getOpenCodeLoadedSkills };`)();
  const history = [buildSkillCall('review', 'completed', '/x/review')];
  const input = { loaded: embedded.loaded(history), blockNames: ['from-block'], inContextNames: [], available: offeredSkills };
  assert.equal(
    embedded.build(embedded.plan(input), skillsRestoreTexts, 'skill'),
    buildSkillsRestoreText(planOpenCodeSkillsRestore({ ...input, loaded: getOpenCodeLoadedSkills(history) }), skillsRestoreTexts, 'skill'),
  );
});
