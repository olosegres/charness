import type { Translate } from '../i18n';

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

/**
 * @description The privacy-mode line of `/doctor`, or none. Telegram sends a group ADMIN every message whatever the privacy
 * mode says (core.telegram.org/bots/features#privacy-mode), so for an admin bot the flag decides nothing and the greeting does
 * not ask for it — a line that failed on it would contradict the greeting. A bot that is not (known to be) an admin needs the
 * mode off to read free text, so the flag `getMe` reports (`can_read_all_group_messages`, true = privacy mode off) is checked.
 */
export function getPrivacyDoctorLine(
  facts: { isBotAdmin: boolean; canReadAllGroupMessages: boolean | undefined },
  translate: Translate,
): DoctorLine | null {
  if (facts.isBotAdmin) return null;
  return {
    status: facts.canReadAllGroupMessages ? 'ok' : 'fail',
    label: translate('doctor.privacy_off'),
    hint: translate('doctor.privacy_hint'),
  };
}
