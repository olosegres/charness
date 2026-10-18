/**
 * What a Claude transcript file (`<projects>/<slug>/<sessionId>.jsonl`) holds, as far as launching the CLI on its
 * session id is concerned. A file's EXISTENCE says nothing: the CLI leaves metadata-only stubs of its own (a process that
 * is stopped while its transcript was removed under it — Claude Code's own cleanup of old transcripts — writes its
 * `last-prompt`, `cost-state`, … entries back into a fresh file at exit), and measured against CLI 2.1.302 such a stub
 * is refused by BOTH launch flags: `--resume` answers «No conversation found with session ID», `--session-id` answers
 * «Session ID … is already in use».
 */
import * as fs from 'fs';
import * as readline from 'readline';

/**
 * The entry types that make a transcript a conversation. Measured against CLI 2.1.302: `--resume` runs on a transcript
 * holding any one of them (even alone) and refuses one holding only metadata — `last-prompt`, `cost-state`,
 * `atis-latch`, `ai-title`, `mode`, `queue-operation`, `api-request*`.
 */
const conversationEntryTypes: readonly string[] = ['user', 'assistant', 'attachment'];

/** `absent`: no file; `metadataOnly`: a file with no conversation entry (the CLI's stub); `conversation`: a resumable one. */
export type ClaudeTranscriptContent = 'absent' | 'metadataOnly' | 'conversation';

function readEntryType(line: string): string | null {
  try {
    const entry: { type?: unknown } | null = JSON.parse(line);
    return typeof entry?.type === 'string' ? entry.type : null;
  } catch {
    return null; // a torn or foreign line holds no conversation
  }
}

/**
 * @description What the transcript at `transcriptPath` holds. Streams the file from its start and stops at the first
 * conversation entry — a real conversation answers within its first lines, a stub is a few hundred bytes — so a
 * transcript of any size costs next to nothing. A file that cannot be read for another reason than being absent
 * counts as a conversation: it is never taken for a stub, which the caller may remove.
 */
export async function readClaudeTranscriptContent(transcriptPath: string): Promise<ClaudeTranscriptContent> {
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entryType = readEntryType(line);
      if (entryType !== null && conversationEntryTypes.includes(entryType)) return 'conversation';
    }
    return 'metadataOnly';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    return 'conversation';
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * @description How the CLI can be launched on a session id: `isResumable` — a resume was asked for AND the transcript
 * holds a conversation; `isConversationLost` — a resume was asked for and the transcript is the metadata-only STUB, which
 * is proof the conversation had turns and is gone. A missing transcript loses nothing (a session that never took a turn
 * has none): it is neither resumable nor lost, and the id is simply started. What a launch that cannot resume does is the
 * caller's to decide. A metadata-only stub is removed first — no launch flag accepts it («already in use»), and it holds
 * nothing a conversation could be rebuilt from.
 */
export async function prepareClaudeSessionLaunch(
  transcriptPath: string,
  isResumeRequested: boolean,
): Promise<{ isResumable: boolean; isConversationLost: boolean }> {
  const content = await readClaudeTranscriptContent(transcriptPath);
  if (content === 'metadataOnly') await fs.promises.rm(transcriptPath, { force: true });
  return { isResumable: isResumeRequested && content === 'conversation', isConversationLost: isResumeRequested && content === 'metadataOnly' };
}
