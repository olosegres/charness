import type { SttInstallProgress } from './sttInstall';

/**
 * @description What the voice-settings messages say, as pure functions over data — the Telegram side
 * (`connectors/telegram/commands/stt.ts`) only renders and sends them. `translate` is the topic's `t(...)`, so
 * tests pass a stand-in that echoes the key and variables.
 */

export type SttTranslate = (code: string, vars?: Record<string, string | number>) => string;

const secondsPerMinute = 60;
/** The install log's last lines shown under a failure; the rest is in `install.log`. */
const failureTailLineCount = 5;
const failureTailLineMaxLength = 160;

/** @description `1:05` — minutes and zero-padded seconds. */
export function formatSttElapsed(elapsedSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(wholeSeconds / secondsPerMinute);
  return `${minutes}:${(wholeSeconds % secondsPerMinute).toString().padStart(2, '0')}`;
}

/**
 * @description The text of the install message for one progress report: while it runs, a header with the elapsed
 * time over the phase line (`downloading the model 120/216 MB…`); at the end only the outcome — ready, or the
 * error with the last log lines.
 */
export function buildSttInstallProgressText(progress: SttInstallProgress, elapsedSeconds: number, translate: SttTranslate): string {
  switch (progress.phase) {
    case 'done':
      return translate('stt.install.done');
    case 'failed': {
      const tail = (progress.logTail ?? []).slice(-failureTailLineCount).map((line) => `  ${line.slice(0, failureTailLineMaxLength)}`);
      return [translate('stt.install.failed', { error: progress.error ?? '' }), ...tail].join('\n');
    }
    case 'downloadingModel':
      return `${translate('stt.install.header', { elapsed: formatSttElapsed(elapsedSeconds) })}\n${translate('stt.install.downloadingModel', { progress: progress.detail })}`;
    case 'creatingEnvironment':
    case 'installingPackages':
    case 'checking':
      return `${translate('stt.install.header', { elapsed: formatSttElapsed(elapsedSeconds) })}\n${translate(`stt.install.${progress.phase}`)}`;
  }
}

/** @description One log line per phase change of an install nobody watches in a chat (`[STT] install: …`). */
export function formatSttInstallLogLine(progress: SttInstallProgress): string {
  const base = `[STT] install: ${progress.phase}`;
  if (progress.phase === 'failed') return `${base} — ${progress.error ?? 'unknown error'}`;
  return progress.detail ? `${base} ${progress.detail}` : base;
}
