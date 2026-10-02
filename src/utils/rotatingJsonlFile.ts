import { appendFileSync, existsSync, mkdirSync, promises as fsp, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * @description An append-only JSONL file with ONE size-bounded backup: once the
 * live file passes `maxBytes` it rolls to `<file>.1` (overwriting the previous
 * backup), so the on-disk total never exceeds roughly `2 × maxBytes`. Shared by
 * the durable histories under `DATA_DIR` (the scheduler run ledger, the request
 * history).
 *
 * Appends are synchronous (`appendFileSync`): the callers write at low cadence and
 * rely on "the line is on disk before I continue" (the request ledger writes the
 * history line BEFORE it drops the open entry). An append never throws — it
 * reports `false` and the caller decides whether that is worth a log line.
 * Files are created owner-only: the records quote prompts and conversation keys.
 */
export class RotatingJsonlFile<TRecord> {
  private readonly path: string;
  private readonly maxBytes: number;
  private isDirEnsured = false;

  constructor(filePath: string, maxBytes: number) {
    this.path = filePath;
    this.maxBytes = maxBytes;
  }

  /** Path of the live file (for logging / tests). */
  get filePath(): string {
    return this.path;
  }

  private rotateIfOversized(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size <= this.maxBytes) return;
    renameSync(this.path, `${this.path}.1`);
  }

  /** @description Append one record as a JSONL line. Resolves `false` when the write failed. */
  append(record: TRecord): boolean {
    try {
      if (!this.isDirEnsured) {
        mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
        this.isDirEnsured = true;
      }
      this.rotateIfOversized();
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @description Every non-empty line, oldest first: the `.1` backup, then the
   * live file. A missing file contributes nothing; any other read error rejects.
   */
  async readLines(): Promise<string[]> {
    const lines: string[] = [];
    for (const filePath of [`${this.path}.1`, this.path]) {
      let content: string;
      try {
        content = await fsp.readFile(filePath, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      for (const line of content.split('\n')) {
        if (line.trim() !== '') lines.push(line);
      }
    }
    return lines;
  }
}
