/**
 * @description What the unit tests of `remoteRun/runner.sh` share (`remoteRunRunnerScript.test.ts`, `remoteRunRunnerScriptProbe.test.ts`, `remoteRunRunnerLock.test.ts`, `remoteRunGuiSession.test.ts`): where the
 * script is, the project and job names the tests use, and a file writer.
 */

import fs from 'fs';
import path from 'path';

export const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'runner.sh');
export const slug = 'app-abc1234567';
export const jobId = 'box1-aaaaaa';

export function writeFile(root: string, relativePath: string, content = 'x'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
