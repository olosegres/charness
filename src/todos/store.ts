import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';
import { keyToSlug, keyToString, tryKeyFromSlug, type SessionKey } from '../sessionKey';
import { checkIsOpenTodoItem } from './order';
import { todoSources, todoStatuses, type TodoItem, type TodoTopicFile } from './types';

/**
 * @description The file store of the todo registry — the truth and the full history (D26). One JSON file per
 * conversation, `DATA_DIR/todos/<conversation slug>.json`, written atomically (a temp file and a rename) and cached in
 * memory: the bot is the only writer and every call is synchronous, so two writes can never interleave. A closed
 * item older than {@link todoArchiveAfterMs} moves to `todos/archive/<slug>.jsonl` at the next save, one line per
 * item, so the live file stays small and nothing is ever deleted.
 *
 * A file that cannot be read is set aside (`<name>.corrupt-<time>`) with one error line and the conversation starts
 * from an empty list — a broken file must neither stop the bot nor be overwritten unseen.
 */

/** The store's directory under `DATA_DIR`. */
export const todosDirName = 'todos';
/** Where archived items go, under the store's directory. */
const archiveDirName = 'archive';
/** `:` is illegal in a file name on some filesystems; the slug uses this instead. */
const conversationSlugSeparator = '_';
const todoFileExtension = '.json';
const archiveFileExtension = '.jsonl';
/** A closed item older than this leaves the live file for the archive. */
export const todoArchiveAfterMs = 30 * 24 * 60 * 60 * 1000;
/** Private content of the operator's work: readable by the bot's user only. */
const todoFileMode = 0o600;

const todoItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(todoStatuses),
  note: z.string().optional(),
  source: z.enum(todoSources),
  ref: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  closedAt: z.number().optional(),
});

const todoTopicFileSchema = z.object({
  version: z.literal(1),
  conversationKey: z.string(),
  nextItemNumber: z.number().int().positive(),
  items: z.array(todoItemSchema),
  revision: z.number().int().nonnegative(),
  changedAt: z.number().optional(),
  lastUpdateAt: z.number().optional(),
  nag: z.object({
    clockStartedAt: z.number().optional(),
    workedMs: z.number().nonnegative(),
    ignoredCount: z.number().int().nonnegative(),
    lastRemindedAt: z.number().optional(),
  }).optional(),
  lastTurnEndAt: z.number().optional(),
  boardSeen: z.object({ revisions: z.record(z.string(), z.number()), at: z.number() }).optional(),
});

/** @description The empty record of a conversation that never published anything. */
export function createEmptyTodoTopicFile(key: SessionKey): TodoTopicFile {
  return { version: 1, conversationKey: keyToString(key), nextItemNumber: 1, items: [], revision: 0 };
}

/**
 * @description Split `file` into what stays live and the closed items old enough for the archive (closed before
 * `nowMs - todoArchiveAfterMs`).
 */
export function getTodoArchiveSplit(file: TodoTopicFile, nowMs: number): { file: TodoTopicFile; archived: TodoItem[] } {
  const archiveBefore = nowMs - todoArchiveAfterMs;
  const isArchived = (item: TodoItem): boolean => !checkIsOpenTodoItem(item) && (item.closedAt ?? item.updatedAt) < archiveBefore;
  const archived = file.items.filter(isArchived);
  if (archived.length === 0) return { file, archived };
  return { file: { ...file, items: file.items.filter((item) => !isArchived(item)) }, archived };
}

/** @name TodoStore @description The file store over one data dir. */
export class TodoStore {
  private readonly files = new Map<string, TodoTopicFile>();

  constructor(private readonly dataDir: string, private readonly getNowMs: () => number = Date.now) {}

  private getDir(): string {
    return path.join(this.dataDir, todosDirName);
  }

  private getFilePath(key: SessionKey): string {
    return path.join(this.getDir(), `${keyToSlug(key, conversationSlugSeparator)}${todoFileExtension}`);
  }

  private getArchivePath(key: SessionKey): string {
    return path.join(this.getDir(), archiveDirName, `${keyToSlug(key, conversationSlugSeparator)}${archiveFileExtension}`);
  }

  /** @description The conversation's record; the empty one when it never published (nothing is written for that). */
  getTopic(key: SessionKey): TodoTopicFile {
    const conversationKey = keyToString(key);
    const cached = this.files.get(conversationKey);
    if (cached) return cached;
    const loaded = this.readTopicFile(key);
    this.files.set(conversationKey, loaded);
    return loaded;
  }

  private readTopicFile(key: SessionKey): TodoTopicFile {
    const filePath = this.getFilePath(key);
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return createEmptyTodoTopicFile(key);
      throw e;
    }
    try {
      const parsed = todoTopicFileSchema.parse(JSON.parse(text));
      if (parsed.conversationKey !== keyToString(key)) throw new Error(`it belongs to ${parsed.conversationKey}`);
      return parsed;
    } catch (e) {
      const asidePath = `${filePath}.corrupt-${this.getNowMs()}`;
      fs.renameSync(filePath, asidePath);
      console.error(`[todos] ${filePath} is unreadable (${e instanceof Error ? e.message : String(e)}); set aside as ${asidePath}, the list starts empty`);
      return createEmptyTodoTopicFile(key);
    }
  }

  /** @description Store the conversation's record: old closed items go to the archive first. */
  saveTopic(key: SessionKey, file: TodoTopicFile): TodoTopicFile {
    const split = getTodoArchiveSplit(file, this.getNowMs());
    if (split.archived.length > 0) {
      const archivePath = this.getArchivePath(key);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(archivePath, split.archived.map((item) => `${JSON.stringify(item)}\n`).join(''), { mode: todoFileMode });
    }
    fs.mkdirSync(this.getDir(), { recursive: true, mode: 0o700 });
    writeJsonFileAtomically(this.getFilePath(key), split.file, todoFileMode);
    this.files.set(keyToString(key), split.file);
    return split.file;
  }

  /** @description The newest `limit` archived items of the conversation, the most recently closed first. */
  readArchivedItems(key: SessionKey, limit: number): TodoItem[] {
    let text: string;
    try {
      text = fs.readFileSync(this.getArchivePath(key), 'utf8');
    } catch {
      return [];
    }
    const items = text.split('\n').flatMap((line) => {
      if (line.trim() === '') return [];
      try {
        const parsed = todoItemSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        // A torn last line (a crash mid-append) is skipped; the lines before it are whole.
        return [];
      }
    });
    return items.sort((left, right) => (right.closedAt ?? 0) - (left.closedAt ?? 0)).slice(0, limit);
  }

  /** @description Every conversation that has a stored list. */
  listTopicKeys(): SessionKey[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.getDir());
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!name.endsWith(todoFileExtension)) return [];
      const key = tryKeyFromSlug(name.slice(0, -todoFileExtension.length), conversationSlugSeparator);
      return key ? [key] : [];
    });
  }
}
