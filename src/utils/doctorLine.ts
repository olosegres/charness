import type { Translate } from '../selfUpdate/updateMessages';

/** One line of the `/doctor` report. */
export interface DoctorLine {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  hint?: string;
}

/**
 * @description Word one `/doctor` line. A warning with no hint is the label alone — the `label — hint` template would
 * leave a dangling dash after it.
 */
export function formatDoctorLine(line: DoctorLine, translate: Translate): string {
  if (line.status === 'ok') return translate('doctor.ok', { label: line.label });
  if (line.status === 'warn') {
    return line.hint
      ? translate('doctor.warn', { label: line.label, hint: line.hint })
      : translate('doctor.warnWithoutHint', { label: line.label });
  }
  return translate('doctor.fail', { label: line.label, hint: line.hint ?? '' });
}
