import * as fs from 'fs';
import * as path from 'path';

/**
 * @description Tools the Jira agents find on their PATH (prompt context C11):
 * `jira.json` `agentBinaries` maps a name to the program's absolute path, and
 * each is linked into `DATA_DIR/agent-bin/`, a folder the agents' PATH starts
 * with. A link rather than a copy keeps the tool current; a link that went stale
 * is replaced at the next boot, and a name dropped from the config is removed.
 */

export const agentBinDirName = 'agent-bin';
const dirMode = 0o700;

/** Make `linkPath` a symlink to `target`, atomically: a process running the tool never finds a gap. */
function replaceSymlink(target: string, linkPath: string): void {
  const tmpPath = `${linkPath}.${process.pid}.tmp`;
  fs.rmSync(tmpPath, { force: true });
  fs.symlinkSync(target, tmpPath);
  fs.renameSync(tmpPath, linkPath);
}

/**
 * @description Rebuild `DATA_DIR/agent-bin` to hold exactly `binaries` as links. Resolves the folder
 * when there is something in it, else `null` (nothing is added to any PATH).
 */
export function linkAgentBinaries(dataDir: string, binaries: ReadonlyMap<string, string>): string | null {
  const dir = path.join(dataDir, agentBinDirName);
  if (binaries.size === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  for (const entry of fs.readdirSync(dir)) {
    if (!binaries.has(entry)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  for (const [name, binaryPath] of binaries) replaceSymlink(binaryPath, path.join(dir, name));
  return dir;
}
