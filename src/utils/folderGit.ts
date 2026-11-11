import { execFile } from 'child_process';
import { promisify } from 'util';
import { getChildProcessEnvironment } from './agentEnvironment';

const execFileAsync = promisify(execFile);

/**
 * `core.fsmonitor` names a command `git status` runs, and a repository's own `.git/config` — which the agent working in
 * the folder can write — may set it: the bot never runs it just to show a status.
 */
const gitConfigOverrides = ['-c', 'core.fsmonitor=false'];

/**
 * @description Run git in a folder an agent works in (a topic's bound folder) for the bot's own reading — the branch and
 * whether the tree is clean on a bind, a repository's root for the todo boards — within `timeoutMs`; its trimmed stdout,
 * or `null` when it failed or ran too long. The repository's configuration is the agent's to write, so git, and whatever
 * that configuration makes it run, gets the bot's environment without the bot's own secrets
 * ({@link getChildProcessEnvironment}) and no file-system monitor ({@link gitConfigOverrides}).
 */
export async function runGitInAgentFolder(workDir: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...gitConfigOverrides, '-C', workDir, ...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: getChildProcessEnvironment(),
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
