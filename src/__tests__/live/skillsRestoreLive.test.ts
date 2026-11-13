/**
 * @description The skills restore against the REAL Claude Code CLI — the plan's S0 probe as a test (plan
 * `2026-11-12-skills-reload-after-compaction`). A throwaway project with a small skill and one past Claude Code's own
 * re-attach limit (20,000 characters); `claude -p` over stream-json with the bot's restore hooks (the BUILT
 * `dist/hooks/claudeSkillsRestoreHook.js`, 24 `SessionStart` `compact` slots) in its `--settings`:
 *
 *   1. the agent loads both skills with the Skill tool → `/compact` → asked, with no tool, for the marker on the LAST line of
 *      the big skill: it can only answer from the restore (Claude Code's own re-attach cuts that skill at 20,000 characters);
 *      then for the full path of the big skill's file, which only the restore's `Skill file:` line gives; the transcript holds
 *      the restore (`hook_additional_context`, what a resumed process sends again) with BOTH skills whole, its parts (at least
 *      three) strictly by number, and no stdout frame that carries it reaches the bot's classifier as anything;
 *   2. the RESUME case — what the per-turn backend does every turn and json-stream after every idle stop or bot restart: the
 *      skills are loaded, the process stops, a NEW process `--resume`s the conversation and compacts. MEASURED: whether
 *      Claude Code's own re-attach of that compaction (`invoked_skills`) still holds the skills the earlier process loaded
 *      (printed as a `[measure]` diagnostic, never failed on); ASSERTED: the bot's restore gives both skills whole anyway, so
 *      the agent reads the last line of each. Measured on 2026-11-13 (Claude Code 2.1.323, the default account): the resumed
 *      process's re-attach held NONE of them ([] of [live-small, live-big]) — why the restore gives every skill in full
 *      (`planClaudeSkillsRestore`). Its parts too arrive strictly by number.
 *
 * Each compaction's part order and the moments the CLI took the parts (`hook_response` frames) are printed as `[measure]`
 * diagnostics. Measured on 2026-11-13 (2.1.323) BEFORE the slots were chained: five parts reached the transcript as
 * [5, 2, 1, 3, 4] and [4, 1, 2, 3, 5].
 *
 * Skipped unless `SKILLS_RESTORE_LIVE_CLAUDE_BIN` names the `claude` binary, so `yarn test` never runs it. It spends a few
 * turns of the account the inherited `CLAUDE_CONFIG_DIR` (or `~/.claude`) is signed in to — use a subscription login, never an
 * API key. Optional: `SKILLS_RESTORE_LIVE_MODEL` (default `haiku`). Needs `yarn build`. Run it directly:
 * `SKILLS_RESTORE_LIVE_CLAUDE_BIN=$(which claude) node --import tsx --test src/__tests__/live/skillsRestoreLive.test.ts`
 * with `TMUX` / `TMUX_PANE` unset.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, test, type TestContext } from 'node:test';
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
  /** When each frame arrived (`Date.now()`), by its index in `frames`. */
  frameTimes: number[];
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
  const frameTimes: number[] = [];
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
      frameTimes.push(Date.now());
      if (frame.type === 'result' && onResult) onResult(frame);
    }
  });
  return {
    frames,
    frameTimes,
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

/** The part number a restore text opens with (`(part i of n)`), `1` for a restore in one part. */
function readRestorePartNumber(text: string): number {
  const label = new RegExp(`^${skillsRestoreHeader.replace(/[[\]]/g, '\\$&')}(?: \\(part (\\d+) of \\d+\\))?\n`).exec(text);
  assert.ok(label, `a restore part opens with its label: ${text.slice(0, 120)}`);
  return label[1] === undefined ? 1 : Number(label[1]);
}

/**
 * @description The order the restore's parts took: in the transcript (the LAST `hook_additional_context` that holds the
 * restore — what every later model request sends) and on stdout, where each hook's `hook_response` frame arrives as the CLI
 * takes its output (with the milliseconds since the first `SessionStart` hook started), printed as a `[measure]` diagnostic.
 */
function measureRestoreOrder(session: ProbeSession, records: readonly TranscriptRecord[], label: string, context: TestContext): number[] {
  const restoreRecord = records.filter((record) => record.type === 'attachment' && record.attachment?.type === 'hook_additional_context' && (record.attachment.content ?? []).some((text) => text.startsWith(skillsRestoreHeader))).at(-1);
  const transcriptOrder = (restoreRecord?.attachment?.content ?? []).filter((text) => text.startsWith(skillsRestoreHeader)).map(readRestorePartNumber);
  const startedAt = session.frames.findIndex((frame) => frame.type === 'system' && frame.subtype === 'hook_started' && String(frame.hook_name).startsWith('SessionStart'));
  const firstStartMs = startedAt < 0 ? 0 : session.frameTimes[startedAt];
  const responses = session.frames.flatMap((frame, index) => {
    if (frame.type !== 'system' || frame.subtype !== 'hook_response' || !String(frame.stdout ?? '').includes(skillsRestoreHeader)) return [];
    const additionalContext: unknown = JSON.parse(String(frame.stdout)).hookSpecificOutput?.additionalContext;
    return typeof additionalContext === 'string' ? [`part ${readRestorePartNumber(additionalContext)} @ ${session.frameTimes[index] - firstStartMs} ms`] : [];
  });
  const measurement = `[measure] ${label}: the transcript holds the parts in the order [${transcriptOrder.join(', ')}]; hook responses after the first SessionStart hook started: ${responses.join(', ')}`;
  context.diagnostic(measurement);
  console.log(measurement);
  return transcriptOrder;
}

/** Whether `order` is 1..n with at least `minimumParts` parts. */
function assertRestoreInOrder(order: readonly number[], minimumParts: number, label: string): void {
  assert.ok(order.length >= minimumParts, `${label}: at least ${minimumParts} parts (${order.length})`);
  assert.deepEqual(order, Array.from({ length: order.length }, (_value, index) => index + 1), `${label}: the parts reach the transcript strictly by number`);
}

/** How many parts the probe's restore takes at least: the big skill alone fills three. */
const probeMinimumParts = 3;

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
  writeSkill('live-big', `# live-big\n\n${Array.from({ length: 900 }, (_value, index) => `Rule ${index}: a rule of the big probe skill.`).join('\n')}\n${bigTail}\n`);
  const settingsPath = path.join(root, `${name}-settings.json`);
  fs.writeFileSync(settingsPath, JSON.stringify(buildClaudeLaunchHookSettings({
    preCompact: 'cat > /dev/null',
    postToolUse: 'cat > /dev/null',
    sessionStartCompact: buildSkillsRestoreHookCommands({ nodePath: process.execPath, hookPath: builtHookPath, slotCount: skillsRestoreSlotCount, unavailableSkillsDir: null, orderDir: path.join(root, `${name}-order`) }),
  })));
  return { workDir, settingsPath, smallTail, bigTail };
}

const loadBothSkillsPrompt = 'Use the Skill tool twice: load the skill live-small, then live-big. Then reply only LOADED.';
const askTailsPrompt = 'Without using any tool: what are the exact markers on the very last line of the live-small skill (it starts with LIVE-SMALL-TAIL) and of the live-big skill (it starts with LIVE-BIG-TAIL)? Reply with the two markers only.';

const askSkillFilePrompt = 'Without using any tool: what is the full path of the skill file of the live-big skill, as the restored skills in your context state it? Reply with the path only.';

function getSessionId(session: ProbeSession): string {
  const sessionId = session.frames.find((frame) => frame.type === 'system' && frame.subtype === 'init')?.session_id;
  assert.equal(typeof sessionId, 'string');
  return String(sessionId);
}

describe('the skills restore against the real Claude Code CLI (live)', { skip: skipReason }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-restore-live-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('after /compact the agent reads the LAST line of both skills — from the restore, which the transcript keeps, its parts strictly by number', { timeout: 4 * turnTimeoutMs }, async (context) => {
    assert.ok(fs.existsSync(builtHookPath), `the built hook is missing (${builtHookPath}): run \`yarn build\``);
    const project = createProbeProject(root, 'one-process');
    const session = startProbeSession(project.workDir, project.settingsPath);
    try {
      await session.sendTurn(loadBothSkillsPrompt);
      await session.sendTurn('/compact');
      const answer = String((await session.sendTurn(askTailsPrompt)).result ?? '');
      assert.ok(answer.includes(project.smallTail) && answer.includes(project.bigTail), `the agent reads the end of both skills after the compaction: ${answer}`);
      const bigSkillFile = path.join(project.workDir, '.claude', 'skills', 'live-big', 'SKILL.md');
      const fileAnswer = String((await session.sendTurn(askSkillFilePrompt)).result ?? '');
      assert.ok(fileAnswer.includes(bigSkillFile), `the agent reads the skill file's full path from the restore: ${fileAnswer}`);

      const records = readTranscriptRecords(getSessionId(session));
      const restore = readRestoreTexts(records);
      assert.ok(restore.includes(project.bigTail) && restore.includes(project.smallTail), 'the transcript keeps the restore with both skills whole — a resumed process sends it again');
      assertRestoreInOrder(measureRestoreOrder(session, records, 'one process, /compact', context), probeMinimumParts, 'one process');
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
      assertRestoreInOrder(measureRestoreOrder(resumed, lastEpoch, 'resumed process, /compact', context), probeMinimumParts, 'resumed process');
      const answer = String((await resumed.sendTurn(askTailsPrompt)).result ?? '');
      assert.ok(answer.includes(project.smallTail) && answer.includes(project.bigTail), `the resumed agent reads the end of both skills: ${answer}`);
    } finally {
      await resumed.stop();
    }
  });
});
