import type { Translate } from '../selfUpdate/updateMessages';
import type { DoctorLine } from './doctorLine';

/**
 * Charness on native Windows (not inside WSL2) starts and serves, but part of it cannot work there: the Claude backends need
 * tmux, a self-update cannot restart the process in place (no `process.execve`), hot mode refuses to start and the local
 * speech engine's installer is POSIX-only. The bot says so instead of failing one feature at a time; WSL2 is the supported way.
 */

/** Where the WSL2 recipe lives, shown in the notice. */
export const nativeWindowsSetupUrl = 'https://github.com/olosegres/charness/blob/main/SETUP.md#windows-wsl2';

const windowsPlatform = 'win32';
const generalNoticePrefix = '⚠️ ';
const consoleLinePrefix = '[platform] ';

/** @description Whether this process runs on native Windows. The platform is a parameter so tests need no Windows. */
export function checkIsNativeWindows(platform: typeof process.platform): boolean {
  return platform === windowsPlatform;
}

/**
 * @description The "native Windows is limited" sentence in the active language, or `null` off Windows. One text serves the
 * console, the General notice and `/doctor`.
 */
export function getNativeWindowsNotice(platform: typeof process.platform, translate: Translate): string | null {
  return checkIsNativeWindows(platform) ? translate('nativeWindows.limitedNotice', { setupUrl: nativeWindowsSetupUrl }) : null;
}

/** @description The startup console line, or `null` off Windows. */
export function getNativeWindowsConsoleLine(platform: typeof process.platform, translate: Translate): string | null {
  const notice = getNativeWindowsNotice(platform, translate);
  return notice === null ? null : `${consoleLinePrefix}${notice}`;
}

/**
 * @description The notice to post in General at boot, or `null`: once per cold start — a hot reload (the hot supervisor never
 * runs on Windows, but a quick restart classifies the same way) stays silent.
 */
export function getNativeWindowsGeneralNotice(
  input: { platform: typeof process.platform; isHotReload: boolean },
  translate: Translate,
): string | null {
  if (input.isHotReload) return null;
  const notice = getNativeWindowsNotice(input.platform, translate);
  return notice === null ? null : `${generalNoticePrefix}${notice}`;
}

/** @description The `/doctor` line, or `null` off Windows. */
export function getNativeWindowsDoctorLine(platform: typeof process.platform, translate: Translate): DoctorLine | null {
  const notice = getNativeWindowsNotice(platform, translate);
  return notice === null ? null : { status: 'warn', label: notice };
}
