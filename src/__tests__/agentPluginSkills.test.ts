/**
 * @description The skills Charness ships to its agents (`agent-plugin/`): the plugin manifest names the plugin
 * `charness`, every skill folder holds a `SKILL.md` whose frontmatter `name` equals the folder (OpenCode names a
 * skill by the frontmatter, Claude Code by the folder — they must agree) and carries the `charness-` prefix
 * (OpenCode has no namespaces: an unprefixed `manager` would replace a project's own), every skill has a
 * description (OpenCode hides a skill without one), and nothing in the folder holds a real-looking identifier
 * (the repository is public).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  workerWatchArmedFileName,
  workerWatchCheckCommand,
  workerWatchCheckCron,
  workerWatchStatusArguments,
  workerWatchUnreportedMinutes,
} from '../scheduler/workerWatch';

const pluginDir = path.resolve(__dirname, '..', '..', 'agent-plugin');
const skillsDir = path.join(pluginDir, 'skills');
const expectedSkillNames = ['charness-delegate-claude', 'charness-delegate-opencode', 'charness-delivery-loop', 'charness-orchestration'];
/** The Agent Skills limits OpenCode applies: lowercase words joined by single hyphens, at most 64 characters. */
const skillNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const maxSkillNameLength = 64;
const maxDescriptionLength = 1024;
const frontmatterPattern = /^---\n([\s\S]*?)\n---\n/;
/** Shapes of real instance identifiers: a home folder other than the placeholder `/home/user`, a private-chat link, a
 * supergroup id, an e-mail address. */
const realIdentifierPatterns = [/\/home\/(?!user\b)[a-z]/, /\/Users\/(?!user\b)[a-z]/, /t\.me\/c\//, /-100\d{7,}/, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i];

type SkillFrontmatter = { name: string; description: string };

function readFrontmatter(skillFile: string): SkillFrontmatter {
  const match = frontmatterPattern.exec(fs.readFileSync(skillFile, 'utf8'));
  assert.ok(match, `${skillFile} starts with a frontmatter block`);
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1'));
  }
  return { name: fields.get('name') ?? '', description: fields.get('description') ?? '' };
}

function readSkill(folder: string): string {
  return fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

describe('agent-plugin', () => {
  test('the manifest names the plugin charness — the namespace Claude Code lists the skills under', () => {
    const manifest: { name?: string } = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'charness');
  });

  test('it ships exactly the orchestration add-on, the fallback delivery loop and the two delegate skills — no skill that is itself a manager', () => {
    const folders = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.deepEqual(folders.sort(), expectedSkillNames);
  });

  for (const folder of expectedSkillNames) {
    test(`${folder}: frontmatter name = folder, charness- prefix, a description within the limits`, () => {
      const { name, description } = readFrontmatter(path.join(skillsDir, folder, 'SKILL.md'));
      assert.equal(name, folder);
      assert.ok(name.startsWith('charness-'), 'prefixed: OpenCode has no namespaces');
      assert.match(name, skillNamePattern);
      assert.ok(name.length <= maxSkillNameLength);
      assert.ok(description.length > 0, 'OpenCode never lists a skill without a description');
      assert.ok(description.length <= maxDescriptionLength, `${description.length} characters`);
    });
  }

  test('charness-orchestration carries the bot\'s worker watch recipe verbatim — the one the bot\'s own tool texts teach', () => {
    const text = readSkill('charness-orchestration');
    assert.ok(text.includes(workerWatchCheckCommand), 'the checkCommand');
    assert.ok(text.includes(`cron \`${workerWatchCheckCron}\``), 'the cron');
    assert.doesNotMatch(text, /isPinSilent/, 'the pin argument is gone: nothing a check posts is pinned');
    assert.ok(text.includes(`\`${workerWatchStatusArguments}\``), 'the status arguments: the bot posts the topic\'s status line itself');
    assert.match(text, /Never arm a schedule of your own for status lines/);
  });

  test('charness-orchestration teaches the third watch signal: touch the marker right before arming and when re-arming, 2 h 30 min without a report, and what to do on that wake', () => {
    const flat = readSkill('charness-orchestration').replace(/\s+/g, ' ');
    assert.equal(workerWatchUnreportedMinutes, 150, 'the «2 h 30 min» the skill and the topic sentence say');
    assert.ok(flat.includes(`\`touch "<run-dir>/${workerWatchArmedFileName}"\``), 'the touch before the check is armed');
    assert.match(flat, /It fails on ANY of three signals: the worker's process is gone, nothing in its run directory changed for 45 minutes, or the watch was armed 2 h 30 min ago/);
    assert.match(flat, /The third signal counts from the age of `<run-dir>\/watch-armed`: `touch` it right before you arm the check, and again whenever you re-arm one/);
    assert.match(flat, /A run directory without that file fails the third test at the first run — a forgotten `touch` wakes you at once\./);
    assert.match(flat, /«… running 2 h 30 min without a report»/, 'the sentence the topic reads');
    assert.match(flat, /One check may cover several runs of one step .* The `watch-armed` marker of the third test goes in the first of them\./, 'a watch over several runs keeps one marker');
    assert.match(flat, /running 2 h 30 min without a report → look at what it is doing now and step in, or, when it is fine, `touch` the marker and arm a new check/);
    assert.doesNotMatch(flat, /etimes/, 'a macOS ps may lack it: the clock is the marker');
  });

  test('charness-orchestration cleans the runner copy when the LAST open task of a project folder is done — in that folder, before the folder goes, before the report — and leaves the copies of other tasks alone', () => {
    const text = readSkill('charness-orchestration').replace(/\s+/g, ' ');
    assert.match(text, /the LAST open task of its project folder \(the tasks of one folder share ONE copy on a runner\)/);
    assert.match(text, /Run `charness remote-run clean` in that folder BEFORE you remove the folder or worktree/);
    assert.match(text, /never delete other tasks' copies by hand\. Report one line of outcome\./);
    assert.ok(text.indexOf('charness remote-run clean') < text.indexOf('Report one line of outcome'), 'the closing step comes before the report');
    assert.equal(text.split('charness remote-run clean').length - 1, 1, 'said once: the skill is loaded text too');
  });

  test('charness-orchestration is an add-on: it holds no delivery loop, follows the session\'s own manager skill, names the fallback, and never says «instead of» another manager', () => {
    const text = readSkill('charness-orchestration');
    const flat = text.replace(/\s+/g, ' ');
    const { description } = readFrontmatter(path.join(skillsDir, 'charness-orchestration', 'SKILL.md'));
    assert.match(description, /^Adds the bot's tools to a manager skill; it holds no delivery loop\./);
    assert.match(description, /together with this session's general manager skill/);
    assert.match(description, /No general manager skill listed → load `charness-delivery-loop` as well\./);
    assert.match(flat, /Follow the session's general manager skill .* for modes, the loop, review, parallel work, the queue, briefing and finishing\. None listed → load `charness-delivery-loop` too\./);
    assert.match(flat, /this skill wins only on the mechanics below: launching, detaching, watching, waking, accounts and reaching the user/);
    assert.doesNotMatch(text, /\bINSTEAD\b/, 'the root of the clash: the bot skill switched the general manager off');
    for (const loopHeading of [/^## Modes/m, /^## Rules that never bend/m, /^## Delivery loop/m, /^## No plan yet/m, /^## Finally/m]) {
      assert.doesNotMatch(text, loopHeading, 'the loop lives in the general manager skill, else in the fallback');
    }
    assert.doesNotMatch(flat, /same checkout/i, 'the parallel rule that mixed two released tasks\' commits is not here');
    assert.doesNotMatch(flat, /a commit YOU make yourself/, 'bookkeeping commits are the general skill\'s policy');
  });

  test('charness-delivery-loop is the fallback: loaded only when no other manager skill is listed; separately released tasks get their own worktree; the finish merges, rebases, and keeps a reviewer\'s report outside the worktree', () => {
    const text = readSkill('charness-delivery-loop');
    const flat = text.replace(/\s+/g, ' ');
    const { description } = readFrontmatter(path.join(skillsDir, 'charness-delivery-loop', 'SKILL.md'));
    assert.match(description, /^Only when this session lists NO other manager skill/);
    assert.match(description, /A general manager skill is listed → follow that one and do not load this\./);
    assert.match(flat, /each separately released task gets its own git worktree and branch, named in its brief; the builder commits only there\. A lone task, or the tasks of one release, works on the current checkout\./);
    assert.doesNotMatch(flat, /no worktree needed/i, 'the old same-checkout rule is gone');
    assert.match(flat, /A long run never holds the queue: .*start the next independent task — in its own worktree when it is released separately\./);
    assert.match(flat, /the absolute path of its report file outside the worktree \(e\.g\. its run directory\) — it writes nothing inside the worktree/);
    assert.match(flat, /merge the task's branch into the base by fast-forward and remove its worktree/);
    assert.match(flat, /A builder fetches; if the branch or its base moved on the remote, it pulls and rebases; then it runs ALL test suites in full/);
    assert.match(flat, /Your own bookkeeping commits .* need no approval, in either mode/);
    assert.doesNotMatch(flat, /schedule_create|claude_profiles|answer_request/, 'the bot\'s tools are the add-on\'s');
  });

  test('both delegate skills are add-ons of the orchestration skill: they load it first, leave the role policy to a general delegate skill and win only on the launch, the detaching and the watch', () => {
    for (const folder of ['charness-delegate-claude', 'charness-delegate-opencode']) {
      const text = readSkill(folder);
      const flat = text.replace(/\s+/g, ' ');
      assert.match(flat, /Load charness-orchestration first/, `${folder}: the description`);
      assert.match(flat, /Load `charness-orchestration` first — it holds the watch check this skill arms \(the delivery loop is in the session's general manager skill, else in `charness-delivery-loop`\)\. A general delegate skill keeps the role policy/, folder);
      assert.match(flat, /this one wins on the launch, (the account, )?detaching and the watch/, folder);
      assert.match(flat, /arm the watch check from `charness-orchestration`/, folder);
    }
  });

  test('charness-delegate-claude keeps its role defaults under «only when no general delegate skill is listed»; charness-delegate-opencode picks the user\'s model, else a general delegate skill\'s role defaults, else the conversation\'s own', () => {
    const claude = readSkill('charness-delegate-claude');
    const defaultsAt = claude.indexOf('### Role defaults — only when no general delegate skill is listed');
    assert.ok(defaultsAt > 0, 'the heading');
    for (const roleDefault of ['`--model sonnet --effort xhigh`', 'Never Sonnet for work on data persistence', 'Never Fable for a worker']) {
      assert.ok(claude.indexOf(roleDefault) > defaultsAt, `${roleDefault} sits under that heading`);
    }
    assert.ok(claude.indexOf('The first `system`/`init` event must name the requested model') < defaultsAt, 'the model check is not a role default');
    assert.match(readSkill('charness-delegate-opencode').replace(/\s+/g, ' '), /The model and variant the user named; otherwise the role defaults of a general delegate skill, when the session lists one; otherwise the ones this conversation runs on\./);
  });

  test('charness-delegate-claude records the session id in <run-dir>/session at launch and resumes only from it or the first run\'s init event — never from memory or a shortened prefix', () => {
    const flat = readSkill('charness-delegate-claude').replace(/\s+/g, ' ');
    assert.match(flat, /echo \$! > "<run-dir>\/pid" printf '%s\\n' "<uuid>" > "<run-dir>\/session"/, 'written beside the pid, in the launch block');
    assert.match(flat, /Record the UUID \(it is in `<run-dir>\/session`\)/);
    assert.match(flat, /`<uuid>` comes only from `<run-dir>\/session` or the `session_id` of the first \(`system`\/`init`\) event of the first run's log — never from memory or a shortened prefix\./);
  });

  test('no skill names the old charness-manager: the rename left no dangling pointer', () => {
    for (const folder of expectedSkillNames) assert.doesNotMatch(readSkill(folder), /charness-manager/, folder);
  });

  test('both delegate skills name the resume log files events-2.jsonl, … — the bot reads the newest events*.jsonl for its status line, and no other name', () => {
    for (const folder of ['charness-delegate-claude', 'charness-delegate-opencode']) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      assert.match(text, /new\s+log\s+files\s+\(`events-2\.jsonl`, …\)/, folder);
    }
  });

  test('both delegate skills check the recorded PID is the worker before the watch is armed on it', () => {
    // A launcher that hands over to another process leaves `$!` on a process that exits at once: the watch would fire
    // "worker exited" right after the launch.
    for (const folder of ['charness-delegate-claude', 'charness-delegate-opencode']) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      // The run dir quoted inside `$(…)` too: a path with a space would otherwise fail the check.
      assert.match(text, /Check the PID: `ps -o args= -p "\$\(cat "<run-dir>\/pid"\)"`/, folder);
      assert.match(text, /`pgrep (-n )?-f "/, `${folder}: the fallback that finds the worker`);
    }
    // OpenCode's launcher may run the binary as a child: the fallback takes the newest match, one PID.
    assert.match(fs.readFileSync(path.join(skillsDir, 'charness-delegate-opencode', 'SKILL.md'), 'utf8'), /`pgrep -n -f "opencode/);
  });

  test('no file holds a real-looking identifier', () => {
    for (const file of listFiles(pluginDir)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of realIdentifierPatterns) {
        assert.doesNotMatch(text, pattern, `${path.relative(pluginDir, file)} matches ${pattern}`);
      }
    }
  });
});
