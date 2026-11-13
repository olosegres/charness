/**
 * @description The skills restore against the REAL Claude Code CLI — the plan's S0 probe as a test (plan
 * `2026-11-12-skills-reload-after-compaction`). A throwaway project with a small skill and one past Claude Code's own
 * re-attach limit (20,000 characters); `claude -p` over stream-json with the bot's restore hooks (the BUILT
 * `dist/hooks/claudeSkillsRestoreHook.js`, 24 `SessionStart` `compact` slots) in its `--settings`:
 *
 *   the agent loads both skills with the Skill tool → `/compact` → asked, with no tool, for the marker on the LAST line of the
 *   big skill: it can only answer from the restore (Claude Code's own re-attach cuts that skill at 20,000 characters)
 *
 * and the transcript holds the restore (`hook_additional_context`, what a resumed process sends again), the small skill only
 * named, and no stdout frame that carries it reaches the bot's classifier as anything.
 *
 * Skipped unless `SKILLS_RESTORE_LIVE_CLAUDE_BIN` names the `claude` binary, so `yarn test` never runs it. It spends a few
 * turns of the account the inherited `CLAUDE_CONFIG_DIR` (or `~/.claude`) is signed in to — use a subscription login, never an
 * API key. Optional: `SKILLS_RESTORE_LIVE_MODEL` (default `haiku`). Needs `yarn build`. Run it directly:
 * `SKILLS_RESTORE_LIVE_CLAUDE_BIN=$(which claude) node --import tsx --test src/__tests__/live/skillsRestoreLive.test.ts`
 * with `TMUX` / `TMUX_PANE` unset.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildClaudeLaunchHookSettings, buildSkillsRestoreHookCommands } from '../../utils/claudeCompactHook';
import { classifyClaudeStreamMessage } from '../../utils/claudeStreamJson';
import { skillsRestoreHeader } from '../../utils/compactOnIdle';
import { skillsRestoreSlotCount } from '../../utils/skillsRestore';

const claudeBinary = process.env.SKILLS_RESTORE_LIVE_CLAUDE_BIN;
const model = process.env.SKILLS_RESTORE_LIVE_MODEL || 'haiku';
const skipReason = claudeBinary ? undefined : 'set SKILLS_RESTORE_LIVE_CLAUDE_BIN to run';
const builtHookPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'hooks', 'claudeSkillsRestoreHook.js');
/** One turn of a real model, a compaction included. */
const turnTimeoutMs = 5 * 60 * 1000;

/**
 * The variables a Claude Code session sets for its own children: a test started from inside one would hand them on and make
 * the probe a child of that session. Its account (`CLAUDE_CONFIG_DIR`) is kept; an API key never goes in.
 */
function buildProbeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const isParentSessionVariable = name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_') || ['CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'TMUX', 'TMUX_PANE'].includes(name);
    if (!isParentSessionVariable) environment[name] = value;
  }
  return environment;
}

/** A `claude -p` stream-json session: user turns in, every stdout frame kept, each turn awaited to its `result`. */
interface ProbeSession {
  frames: Array<Record<string, unknown>>;
  sendTurn(text: string): Promise<Record<string, unknown>>;
  stop(): void;
}

function startProbeSession(workDir: string, settingsPath: string): ProbeSession {
  const child = spawn(claudeBinary ?? 'claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--settings', settingsPath, '--model', model,
  ], { cwd: workDir, env: buildProbeEnvironment(), stdio: ['pipe', 'pipe', 'inherit'] });
  const frames: Array<Record<string, unknown>> = [];
  let pending = '';
  let onResult: ((frame: Record<string, unknown>) => void) | null = null;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    let newlineAt = pending.indexOf('\n');
    while (newlineAt >= 0) {
      const line = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      newlineAt = pending.indexOf('\n');
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      frames.push(frame);
      if (frame.type === 'result' && onResult) onResult(frame);
    }
  });
  return {
    frames,
    sendTurn(text: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no result within ${turnTimeoutMs} ms for: ${text.slice(0, 60)}`)), turnTimeoutMs);
        onResult = (frame) => {
          clearTimeout(timer);
          onResult = null;
          resolve(frame);
        };
        child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      });
    },
    stop(): void {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

/** The session's transcript: `<config dir>/projects/<project>/<session id>.jsonl`, found by its name. */
function findTranscript(sessionId: string): string {
  const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  for (const project of fs.readdirSync(projectsRoot)) {
    const candidate = path.join(projectsRoot, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no transcript of ${sessionId} under ${projectsRoot}`);
}

describe('the skills restore against the real Claude Code CLI (live)', { skip: skipReason }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-restore-live-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('after /compact the agent reads the LAST line of a skill Claude Code itself would cut — from the restore, which the transcript keeps', { timeout: 4 * turnTimeoutMs }, async () => {
    assert.ok(fs.existsSync(builtHookPath), `the built hook is missing (${builtHookPath}): run \`yarn build\``);
    const workDir = path.join(root, 'project');
    const tailMarker = `LIVE-BIG-TAIL-${randomUUID().slice(0, 8)}`;
    const writeSkill = (name: string, body: string): void => {
      fs.mkdirSync(path.join(workDir, '.claude', 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(workDir, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: A probe skill. Load it when asked to load ${name}.\n---\n\n${body}`);
    };
    writeSkill('live-small', '# live-small\n\nKeep the counter 4242.\n');
    writeSkill('live-big', `# live-big\n\n${Array.from({ length: 800 }, (_value, index) => `Rule ${index}: a rule of the big probe skill.`).join('\n')}\n${tailMarker}\n`);
    const settingsPath = path.join(root, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(buildClaudeLaunchHookSettings({
      preCompact: 'cat > /dev/null',
      postToolUse: 'cat > /dev/null',
      sessionStartCompact: buildSkillsRestoreHookCommands({ nodePath: process.execPath, hookPath: builtHookPath, slotCount: skillsRestoreSlotCount, unavailableSkillsDir: null }),
    })));

    const session = startProbeSession(workDir, settingsPath);
    try {
      await session.sendTurn('Use the Skill tool twice: load the skill live-small, then live-big. Then reply only LOADED.');
      await session.sendTurn('/compact');
      const answer = await session.sendTurn('Without using any tool: what is the exact marker on the very last line of the live-big skill (it starts with LIVE-BIG-TAIL)? Reply with the marker only.');
      assert.ok(String(answer.result ?? '').includes(tailMarker), `the agent reads the end of the big skill after the compaction: ${String(answer.result)}`);

      const sessionId = session.frames.find((frame) => frame.type === 'system' && frame.subtype === 'init')?.session_id;
      assert.equal(typeof sessionId, 'string');
      const records: Array<{ type?: string; attachment?: { type?: string; content?: string[] } }> = fs.readFileSync(findTranscript(String(sessionId)), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const restore = records
        .filter((record) => record.type === 'attachment' && record.attachment?.type === 'hook_additional_context')
        .flatMap((record) => record.attachment?.content ?? [])
        .filter((text) => text.startsWith(skillsRestoreHeader));
      const joined = restore.join('\n');
      assert.ok(joined.includes(tailMarker), 'the transcript keeps the restore — a resumed process sends it again');
      assert.ok(joined.includes('- live-small: its full text is already in your context'), 'the small skill Claude Code re-attaches whole is only named');

      const carryingFrames = session.frames.filter((frame) => JSON.stringify(frame).includes(skillsRestoreHeader));
      assert.ok(carryingFrames.length > 0, 'the CLI streams the hooks\' output (hook_response frames)');
      for (const frame of carryingFrames) assert.deepEqual(classifyClaudeStreamMessage(frame), [], `a frame carrying the restore is nothing to the bot: ${String(frame.type)}/${String(frame.subtype)}`);
    } finally {
      session.stop();
    }
  });
});
