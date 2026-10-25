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
import { workerWatchCheckCommand, workerWatchCheckCron, workerWatchPinArgument } from '../scheduler/workerWatch';

const pluginDir = path.resolve(__dirname, '..', '..', 'agent-plugin');
const skillsDir = path.join(pluginDir, 'skills');
const expectedSkillNames = ['charness-delegate-claude', 'charness-delegate-opencode', 'charness-manager'];
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

  test('it ships exactly the manager and the two delegate skills', () => {
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

  test('charness-manager carries the bot\'s worker watch recipe verbatim — the one the bot\'s own tool texts teach', () => {
    const text = fs.readFileSync(path.join(skillsDir, 'charness-manager', 'SKILL.md'), 'utf8');
    assert.ok(text.includes(workerWatchCheckCommand), 'the checkCommand');
    assert.ok(text.includes(`cron \`${workerWatchCheckCron}\``), 'the cron');
    assert.ok(text.includes(`\`${workerWatchPinArgument}\``), 'the silent pin: a normal finish fires the check');
  });

  test('both delegate skills check the recorded PID is the worker before the watch is armed on it', () => {
    // A launcher that hands over to another process leaves `$!` on a process that exits at once: the watch would fire
    // "worker exited" right after the launch.
    for (const folder of ['charness-delegate-claude', 'charness-delegate-opencode']) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      assert.match(text, /Check the PID: `ps -o args= -p "\$\(cat <run-dir>\/pid\)"`/, folder);
      assert.match(text, /`pgrep -f "/, `${folder}: the fallback that finds the worker`);
    }
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
