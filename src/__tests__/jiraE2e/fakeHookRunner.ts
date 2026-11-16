import { spawn } from 'child_process';

/**
 * @description Run one launch hook command for the fake `claude` (`fakeClaude.ts`) the way the real CLI runs a hook, without
 * blocking the fake: `command` through `/bin/sh` with `input` on stdin, resolving what it printed. A hook that runs longer than
 * `timeoutMs` is cut off WHOLE — the shell and whatever it started, a `node` the bot's hook command runs included — by killing
 * its process group (it gets a group of its own), and the promise settles right then with nothing: a child that still holds the
 * output pipe would otherwise keep the shell's `close` from ever coming, and every hook awaited with it would wait for ever. A
 * hook that cannot be started resolves nothing too.
 */
export function runHookCommand(command: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    let output = '';
    let isSettled = false;
    const settle = (result: string): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is gone already.
      }
      // What a hook cut off printed is discarded, as the real CLI discards it.
      settle('');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('close', () => settle(output));
    child.on('error', () => settle(''));
    // A hook that exits without reading its input must not crash the fake.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
