import * as fs from 'fs';
import * as path from 'path';

/**
 * @description Home folders and what a runner must not depend on or be able to read in them. Builtins only: the admin line's root step runs from a
 * root-owned copy of the package that has no `node_modules`.
 *
 * A runner account runs the agents' code, and macOS gives every user's home `750` with the group `staff` — a standard account is in `staff`, so by
 * default that code can read the homes of the people who use the machine (their source code, tokens, backups). Two things follow:
 *
 *   - the runner (and what root runs for it) must not use a program that lives in a home folder: it is the other user's to change, and the day that
 *     user closes the folder (`chmod 700`) the runner stops working. {@link findHomeContaining}, {@link findForeignHome};
 *   - both pairing lines SAY when the runner account can read other users' homes and give the one-line fix. {@link findReadableHomes},
 *     {@link formatReadableHomesWarning}.
 */

/** The folders whose subfolders are people's homes (`/Users/<name>`, `/home/<name>`) and the homes of root themselves. `/Users/Shared` is one too: everyone can write it. */
const homeParentFolders: readonly string[] = ['/Users', '/home'];
const rootHomeFolders: readonly string[] = ['/root', '/var/root'];
/** Entries of a home parent that are no person's home. */
const nonHomeEntries: ReadonlySet<string> = new Set(['Shared', 'Guest', '.localized', 'lost+found']);
/** How many homes a warning names before it counts the rest. */
const maxNamedHomes = 8;
const plainShellWordPattern = /^[A-Za-z0-9._/@+-]+$/;

function isInside(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * @description The home folder that `programPath` is inside, or `null` when it is outside every home: `/Users/<name>`, `/home/<name>`, `/root`,
 * `/var/root` (and `/Users/Shared`). The path is judged as given — pass the real path (symlinks followed), as `process.execPath` is.
 */
export function findHomeContaining(programPath: string): string | null {
  const target = path.resolve(programPath);
  for (const root of rootHomeFolders) {
    if (target === root || isInside(root, target)) return root;
  }
  for (const parent of homeParentFolders) {
    if (!isInside(parent, target)) continue;
    const [name] = path.relative(parent, target).split(path.sep);
    return path.join(parent, name);
  }
  return null;
}

/** @description The home of ANOTHER user that `programPath` is inside — `null` when it is outside every home or inside `ownHome`. */
export function findForeignHome(programPath: string, ownHome: string): string | null {
  const home = findHomeContaining(programPath);
  return home === null || path.resolve(ownHome) === home ? null : home;
}

/** What a scan needs from the machine; a test's own. */
export interface HomeScanDeps {
  /** The names inside `parent`, or `[]` when it is not a folder. */
  listFolders: (parent: string) => string[];
  /** Can the account whose homes are judged list and enter `folder`? */
  checkCanRead: (folder: string) => Promise<boolean>;
}

/** @description The real folder listing: the sub-folders of `parent` (no files, no links to elsewhere). */
export function listSubfolders(parent: string): string[] {
  try {
    return fs.readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** @description Can the CURRENT user list and enter `folder`? */
export async function checkCanReadAsSelf(folder: string): Promise<boolean> {
  try {
    fs.accessSync(folder, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @description The homes of other users that the account can read, sorted: every folder under `/Users` and `/home` except the account's own
 * (`accountName`, or `ownHome`) and the entries that are no person's home. A folder that cannot be judged counts as closed.
 */
export async function findReadableHomes(accountName: string, ownHome: string | null, deps: HomeScanDeps): Promise<string[]> {
  const readable: string[] = [];
  for (const parent of homeParentFolders) {
    for (const name of deps.listFolders(parent)) {
      const folder = path.join(parent, name);
      if (nonHomeEntries.has(name) || name === accountName || (ownHome !== null && path.resolve(ownHome) === folder)) continue;
      if (await deps.checkCanRead(folder)) readable.push(folder);
    }
  }
  return readable.sort();
}

/** A word for a shell: left as it is when it holds nothing special, else single-quoted. */
function quoteShellWord(word: string): string {
  return plainShellWordPattern.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * @description The warning for a runner account that can read `homes` of other users — what it means, the folders by name, and the one-line fix for
 * each (`sudo chmod 700 <home>`) — as lines to print; `[]` when it can read none.
 */
export function formatReadableHomesWarning(accountName: string, homes: readonly string[]): string[] {
  if (homes.length === 0) return [];
  const named = homes.slice(0, maxNamedHomes);
  const more = homes.length - named.length;
  return [
    `Warning: the account ${accountName} can read the home folders of other users on this machine: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
    'The agents\' jobs, and the packages they install, run as this account and can read what is in them (source code, keys, tokens). Close each with:',
    ...named.map((home) => `  sudo chmod 700 ${quoteShellWord(home)}`),
    ...(more > 0 ? [`  (and the same for the ${more} more)`] : []),
  ];
}

/** What is wrong with a runner that uses the Node.js at `nodePath`, which lives in `home` (another user's), and the way out. */
export function describeForeignNode(nodePath: string, home: string): string {
  return `the Node.js at ${nodePath}, which lives in the home folder of another user (${home}). It stops working when that folder is closed or the other user upgrades Node, and it is theirs to change. Install Node.js system-wide (macOS: brew install node) and use that one`;
}

/** @description The warning for a runner that uses a Node.js in another user's home; `[]` when it is outside every home or in `ownHome`. */
export function formatForeignNodeWarning(nodePath: string, ownHome: string): string[] {
  const home = findForeignHome(nodePath, ownHome);
  return home === null ? [] : [`Warning: this runner uses ${describeForeignNode(nodePath, home)} (then run \`charness-runner service install\` again).`];
}
