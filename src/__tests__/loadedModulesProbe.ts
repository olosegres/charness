import { execFileSync } from 'child_process';
import * as path from 'path';

const srcDir = path.join(__dirname, '..');

/**
 * @description Every module a fresh process loads when it requires `entry`
 * (relative to `src/`): project files relative to `src/` with `/` separators,
 * packages by their name. A fresh process, because a test file's own imports
 * would already sit in its module cache and hide what the entry pulls in.
 */
export function getModulesLoadedBy(entry: string): { projectModules: string[]; packages: string[] } {
  const script = [
    'const before = new Set(Object.keys(require.cache));',
    `require(${JSON.stringify(path.join(srcDir, entry))});`,
    'process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((name) => !before.has(name))));',
  ].join('\n');
  const loaded: string[] = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8' }));
  const nodeModulesMarker = `${path.sep}node_modules${path.sep}`;
  const projectModules = loaded
    .filter((name) => name.startsWith(`${srcDir}${path.sep}`))
    .map((name) => path.relative(srcDir, name).split(path.sep).join('/'));
  const packages = [...new Set(loaded.flatMap((name) => {
    const index = name.lastIndexOf(nodeModulesMarker);
    if (index < 0) return [];
    const parts = name.slice(index + nodeModulesMarker.length).split(path.sep);
    return [parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]];
  }))];
  return { projectModules, packages };
}
