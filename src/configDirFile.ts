import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveGlobalConfigEnvPath } from './legacyNames';

/**
 * @description The mechanics every JSON file in the charness config directory shares (`stt.json`, `settings.json`):
 * where it lives, a load cached by the file's stamp, an atomic save, and the two checks that say why a save cannot
 * be kept. A file's own module adds its schema and its meaning; none of it is written twice.
 *
 * Location rules (owner decisions): the file sits beside the instance's REAL env file — a symlinked `.env` is
 * resolved, so a file next to secrets never lands in a directory that only holds the link; under Docker the
 * config DIRECTORY is mounted writable; there is no fallback location when it cannot be written.
 */

const unknownErrorCode = 'unknown';

/** The OS error code (`ENOENT`, `EACCES`) of a failed fs call — a code names the problem, a message may quote a path. */
export function getErrnoCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : unknownErrorCode;
}

/** @description The OS error code of whatever a `catch` caught (`unknown` when it is not an `Error`). */
export function getCaughtErrnoCode(caught: unknown): string {
  return caught instanceof Error ? getErrnoCode(caught) : unknownErrorCode;
}

/**
 * @description The directory `envFile` really lives in: a symlinked `.env` (the keys kept on an encrypted
 * volume, the config dir holding only a link) resolves to its TARGET's directory. A plain file, or a link that
 * cannot be resolved (dangling), keeps the directory it was named in.
 */
function getRealEnvFileDir(envFile: string): string {
  try {
    return path.dirname(fs.realpathSync(envFile));
  } catch {
    return path.dirname(envFile);
  }
}

/**
 * @description Where the config-directory file `fileName` lives: beside the instance's REAL env file (`ENV_FILE`
 * for an isolated instance, else the charness config dir's `.env` — a pre-rename config dir included), after
 * resolving the env file's symlink. With no env file at all, the canonical `~/.config/charness/`.
 */
export function getConfigDirFilePath(fileName: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const envFile = env.ENV_FILE || resolveGlobalConfigEnvPath(homeDir);
  return path.join(getRealEnvFileDir(envFile), fileName);
}

/** @name ConfigValidation @description What a file's validator says about a parsed JSON object. */
export type ConfigValidation<TConfig> = { ok: true; config: TConfig } | { ok: false; errors: string[] };

/**
 * @name ConfigFileLoad
 * @description What the file holds right now. `invalid` carries the LAST GOOD config (`null` when the file was never
 * valid in this process); whether to keep serving it or to fall back to defaults is the file's own policy.
 */
export type ConfigFileLoad<TConfig> =
  | { status: 'missing'; config: TConfig }
  | { status: 'ok'; config: TConfig }
  | { status: 'invalid'; config: TConfig | null; errors: string[] };

export interface ConfigFileLoaderOptions<TConfig> {
  /** The file's name as errors write it (`stt.json`). */
  fileName: string;
  /** The config of a file that does not exist. */
  createEmpty: () => TConfig;
  /** Validates a parsed JSON object; every error names its field and carries no value (the file may hold keys). */
  validate: (parsedJson: object) => ConfigValidation<TConfig>;
}

export interface ConfigFileLoader<TConfig> {
  /**
   * Read and validate the file, cached by its stamp (mtime, size, inode) so a repeated call costs one `stat`.
   * A missing file is the empty config; an unreadable or invalid one reports its errors.
   */
  load: (filePath: string) => ConfigFileLoad<TConfig>;
  /** Forget every cached load — for tests, which swap files under one path. */
  resetCache: () => void;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface CacheEntry<TConfig> {
  stamp: string;
  load: ConfigFileLoad<TConfig>;
  lastGood: TConfig | null;
}

/** Position of a JSON syntax error, without the quoted source text Node puts in its message. */
function getJsonErrorPosition(error: Error): string {
  const position = /position (\d+)/.exec(error.message);
  return position ? ` (at position ${position[1]})` : '';
}

/** @description A loader for one config-directory file: its own cache, the shared parse and error wording. */
export function createConfigFileLoader<TConfig>(options: ConfigFileLoaderOptions<TConfig>): ConfigFileLoader<TConfig> {
  const { fileName, createEmpty, validate } = options;
  const cacheByPath = new Map<string, CacheEntry<TConfig>>();

  function parseText(text: string): ConfigValidation<TConfig> {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Node quotes a slice of the text in the message, and the text may hold keys: name only the position.
      return { ok: false, errors: [`${fileName} is not valid JSON${e instanceof Error ? getJsonErrorPosition(e) : ''}`] };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, errors: [`${fileName} must hold a JSON object`] };
    }
    return validate(parsed);
  }

  return {
    load(filePath) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        cacheByPath.delete(filePath);
        return { status: 'missing', config: createEmpty() };
      }
      const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      const cached = cacheByPath.get(filePath);
      if (cached?.stamp === stamp) return cached.load;

      const lastGood = cached?.lastGood ?? null;
      let result: ConfigValidation<TConfig>;
      try {
        result = parseText(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        result = { ok: false, errors: [`${fileName} could not be read (${getCaughtErrnoCode(e)})`] };
      }
      const load: ConfigFileLoad<TConfig> = result.ok
        ? { status: 'ok', config: result.config }
        : { status: 'invalid', config: lastGood, errors: result.errors };
      cacheByPath.set(filePath, { stamp, load, lastGood: result.ok ? result.config : lastGood });
      return load;
    },
    resetCache() {
      cacheByPath.clear();
    },
  };
}

/**
 * @description Write `value` as JSON to `filePath` with `fileMode`, creating missing directories, through a temp
 * file and a rename so a reader never sees half a file. The caller validates first: a caller that builds an
 * invalid file has a bug.
 */
export function writeJsonFileAtomically(filePath: string, value: object, fileMode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: fileMode });
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    fs.rmSync(tempPath, { force: true });
    throw e;
  }
}

/** The nearest directory of `filePath`'s ancestors that exists (the save creates the rest), or the errno code that stops the walk. */
function findNearestExistingDirectory(filePath: string): { directory: string } | { errorCode: string } {
  let directory = path.dirname(filePath);
  for (;;) {
    try {
      fs.statSync(directory);
      return { directory };
    } catch (e) {
      const code = getCaughtErrnoCode(e);
      const parent = path.dirname(directory);
      if (code !== 'ENOENT' || parent === directory) return { errorCode: code };
      directory = parent;
    }
  }
}

/**
 * @description Why {@link writeJsonFileAtomically} could not write beside `filePath` — an errno code (`EACCES`,
 * `EROFS`, `ENOTDIR`, …) — or `null` when it can. The directory may not exist yet (the save creates it): the
 * nearest existing ancestor must be a directory that accepts a new file.
 */
export function getConfigFileWriteBlock(filePath: string): string | null {
  const nearest = findNearestExistingDirectory(filePath);
  if ('errorCode' in nearest) return nearest.errorCode;
  try {
    fs.accessSync(nearest.directory, fs.constants.W_OK);
    return fs.statSync(nearest.directory).isDirectory() ? null : 'ENOTDIR';
  } catch (e) {
    return getCaughtErrnoCode(e);
  }
}

/** Files a container runtime creates inside every container it starts (Docker, Podman). */
const containerMarkerFiles: readonly string[] = ['/.dockerenv', '/run/.containerenv'];
const rootDirectory = '/';

/**
 * @description Is the config file kept on a container's OWN disk — the bot runs in a container and the directory
 * that holds the file is not a mount (it shares the device of `/`)? Then every change the bot saves is lost when
 * the container is re-created. The write check cannot see it: the container's disk is writable. Typical cause:
 * only the env FILE was mounted, not its directory. A host, or a path that cannot be read, is never reported.
 */
export function checkIsConfigFileOnContainerDisk(
  filePath: string,
  checkIsPresent: (candidate: string) => boolean = fs.existsSync,
  readDeviceId: (directory: string) => number = (directory) => fs.statSync(directory).dev,
): boolean {
  if (!containerMarkerFiles.some(checkIsPresent)) return false;
  const nearest = findNearestExistingDirectory(filePath);
  if ('errorCode' in nearest) return false;
  try {
    return readDeviceId(nearest.directory) === readDeviceId(rootDirectory);
  } catch {
    return false;
  }
}
