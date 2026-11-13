/**
 * @description The skills restore against the REAL Claude Code CLI — the plan's S0 probe as a test (plan
 * `2026-11-12-skills-reload-after-compaction`). A throwaway project with a small skill and one past Claude Code's own
 * re-attach limit (20,000 characters); `claude -p` over stream-json with the bot's restore hooks (the BUILT
 * `dist/hooks/claudeSkillsRestoreHook.js`, 24 `SessionStart` `compact` slots) in its `--settings`:
 *
 *   1. the agent loads both skills with the Skill tool → `/compact` → asked, with no tool, for the marker on the LAST line of
 *      the big skill: it can only answer from the restore (Claude Code's own re-attach cuts that skill at 20,000 characters);
 *      the transcript holds the restore (`hook_additional_context`, what a resumed process sends again) with BOTH skills
 *      whole, and no stdout frame that carries it reaches the bot's classifier as anything;
 *   2. the RESUME case — what the per-turn backend does every turn and json-stream after every idle stop or bot restart: the
 *      skills are loaded, the process stops, a NEW process `--resume`s the conversation and compacts. MEASURED: whether
 *      Claude Code's own re-attach of that compaction (`invoked_skills`) still holds the skills the earlier process loaded
 *      (printed as a `[measure]` diagnostic, never failed on); ASSERTED: the bot's restore gives both skills whole anyway, so
 *      the agent reads the last line of each. Measured on 2026-11-13 (Claude Code 2.1.323, the default account): the resumed
 *      process's re-attach held NONE of them ([] of [live-small, live-big]) — why the restore gives every skill in full
 *      (`planClaudeSkillsRestore`).
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
import { skillsRestoreHeader, skillsRestoreSlotCount } from '../../utils/skillsRestore';

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
  /** Stop the process and wait for it to end (what the bot's idle stop or per-turn lifecycle does). */
  stop(): Promise<void>;
}

/** How long a stopped probe process may take to exit before it is killed. */
const stopGraceMs = 15_000;

function startProbeSession(workDir: string, settingsPath: string, extraArgs: readonly string[] = []): ProbeSession {
  const child = spawn(claudeBinary ?? 'claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--settings', settingsPath, '--model', model, ...extraArgs,
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
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const killTimer = setTimeout(() => child.kill('SIGKILL'), stopGraceMs);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.stdin.end();
        child.kill('SIGTERM');
      });
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

/** One record of a Claude transcript, as far as the probe reads it. */
interface TranscriptRecord {
  type?: string;
  subtype?: string;
  attachment?: { type?: string; content?: string[]; skills?: Array<{ name?: string }> };
}

function readTranscriptRecords(sessionId: string): TranscriptRecord[] {
  return fs.readFileSync(findTranscript(sessionId), 'utf8').split('\n').filter(Boolean).map((line): TranscriptRecord => JSON.parse(line));
}

/** The records after the transcript's last compaction boundary: what the session holds now. */
function readLastEpoch(records: readonly TranscriptRecord[]): TranscriptRecord[] {
  const boundaryIndex = records.map((record) => record.type === 'system' && record.subtype === 'compact_boundary').lastIndexOf(true);
  return records.slice(boundaryIndex + 1);
}

/** The bot's restore texts in `records` (the `hook_additional_context` the CLI stored). */
function readRestoreTexts(records: readonly TranscriptRecord[]): string {
  return records
    .filter((record) => record.type === 'attachment' && record.attachment?.type === 'hook_additional_context')
    .flatMap((record) => record.attachment?.content ?? [])
    .filter((text) => text.startsWith(skillsRestoreHeader))
    .join('\n');
}

/** A throwaway project with a small skill and one past Claude Code's own 20,000-character re-attach, and the bot's restore hooks. */
function createProbeProject(root: string, name: string): { workDir: string; settingsPath: string; smallTail: string; bigTail: string } {
  const workDir = path.join(root, name);
  const smallTail = `LIVE-SMALL-TAIL-${randomUUID().slice(0, 8)}`;
  const bigTail = `LIVE-BIG-TAIL-${randomUUID().slice(0, 8)}`;
  const writeSkill = (skillName: string, body: string): void => {
    fs.mkdirSync(path.join(workDir, '.claude', 'skills', skillName), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.claude', 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: A probe skill. Load it when asked to load ${skillName}.\n---\n\n${body}`);
  };
  writeSkill('live-small', `# live-small\n\nKeep the counter 4242.\n${smallTail}\n`);
  writeSkill('live-big', `# live-big\n\n${Array.from({ length: 800 }, (_value, index) => `Rule ${index}: a rule of the big probe skill.`).join('\n')}\n${bigTail}\n`);
  const settingsPath = path.join(root, `${name}-settings.json`);
  fs.writeFileSync(settingsPath, JSON.stringify(buildClaudeLaunchHookSettings({
    preCompact: 'cat > /dev/null',
    postToolUse: 'cat > /dev/null',
    sessionStartCompact: buildSkillsRestoreHookCommands({ nodePath: process.execPath, hookPath: builtHookPath, slotCount: skillsRestoreSlotCount, unavailableSkillsDir: null }),
  })));
  return { workDir, settingsPath, smallTail, bigTail };
}

const loadBothSkillsPrompt = 'Use the Skill tool twice: load the skill live-small, then live-big. Then reply only LOADED.';
const askTailsPrompt = 'Without using any tool: what are the exact markers on the very last line of the live-small skill (it starts with LIVE-SMALL-TAIL) and of the live-big skill (it starts with LIVE-BIG-TAIL)? Reply with the two markers only.';

function getSessionId(session: ProbeSession): string {
  const sessionId = session.frames.find((frame) => frame.type === 'system' && frame.subtype === 'init')?.session_id;
  assert.equal(typeof sessionId, 'string');
  return String(sessionId);
}

describe('the skills restore against the real Claude Code CLI (live)', { skip: skipReason }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-restore-live-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('after /compact the agent reads the LAST line of both skills — from the restore, which the transcript keeps', { timeout: 4 * turnTimeoutMs }, async () => {
    assert.ok(fs.existsSync(builtHookPath), `the built hook is missing (${builtHookPath}): run \`yarn build\``);
    const project = createProbeProject(root, 'one-process');
    const session = startProbeSession(project.workDir, project.settingsPath);
    try {
      await session.sendTurn(loadBothSkillsPrompt);
      await session.sendTurn('/compact');
      const answer = String((await session.sendTurn(askTailsPrompt)).result ?? '');
      assert.ok(answer.includes(project.smallTail) && answer.includes(project.bigTail), `the agent reads the end of both skills after the compaction: ${answer}`);

      const restore = readRestoreTexts(readTranscriptRecords(getSessionId(session)));
      assert.ok(restore.includes(project.bigTail) && restore.includes(project.smallTail), 'the transcript keeps the restore with both skills whole — a resumed process sends it again');
      for (const skillName of ['live-small', 'live-big']) {
        const skillFile = path.join(project.workDir, '.claude', 'skills', skillName, 'SKILL.md');
        assert.ok(restore.includes(`Skill file: ${skillFile}\n`), `${skillName}: the restore names the full path of its skill file`);
      }

      const carryingFrames = session.frames.filter((frame) => JSON.stringify(frame).includes(skillsRestoreHeader));
      assert.ok(carryingFrames.length > 0, 'the CLI streams the hooks\' output (hook_response frames)');
      for (const frame of carryingFrames) assert.deepEqual(classifyClaudeStreamMessage(frame), [], `a frame carrying the restore is nothing to the bot: ${String(frame.type)}/${String(frame.subtype)}`);
    } finally {
      await session.stop();
    }
  });

  test('a RESUMED process compacts: measures whether Claude Code still re-attaches what the earlier process loaded; the restore gives both whole either way', { timeout: 5 * turnTimeoutMs }, async (context) => {
    assert.ok(fs.existsSync(builtHookPath), `the built hook is missing (${builtHookPath}): run \`yarn build\``);
    const project = createProbeProject(root, 'resumed');
    const first = startProbeSession(project.workDir, project.settingsPath);
    let sessionId: string;
    try {
      await first.sendTurn(loadBothSkillsPrompt);
      sessionId = getSessionId(first);
    } finally {
      await first.stop();
    }

    const resumed = startProbeSession(project.workDir, project.settingsPath, ['--resume', sessionId]);
    try {
      await resumed.sendTurn('/compact');
      const lastEpoch = readLastEpoch(readTranscriptRecords(sessionId));
      const reattached = lastEpoch
        .filter((record) => record.type === 'attachment' && record.attachment?.type === 'invoked_skills')
        .flatMap((record) => (record.attachment?.skills ?? []).map((skill) => skill.name ?? '?'));
      const measurement = `[measure] Claude Code ${claudeBinary ?? 'claude'} (${model}): after --resume and /compact, its own re-attach (invoked_skills) holds [${reattached.join(', ')}] of [live-small, live-big] loaded by the earlier process`;
      context.diagnostic(measurement);
      console.log(measurement);

      const restore = readRestoreTexts(lastEpoch);
      assert.ok(restore.includes(project.smallTail) && restore.includes(project.bigTail), 'the bot\'s restore gives both skills whole after a resume');
      const answer = String((await resumed.sendTurn(askTailsPrompt)).result ?? '');
      assert.ok(answer.includes(project.smallTail) && answer.includes(project.bigTail), `the resumed agent reads the end of both skills: ${answer}`);
    } finally {
      await resumed.stop();
    }
  });
});
