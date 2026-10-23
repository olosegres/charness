import type { GitSkipReason } from '../selfUpdate/types';
import type { UpdateOffer, UpdateStatus } from '../selfUpdate/updateEngine';
import { updateAnnouncementInstallCallbackPrefix, updateInstallCallbackPrefix, type Translate } from '../selfUpdate/updateMessages';
import type { AutoUpdateMode } from '../selfUpdate/updateModes';

/**
 * @description Pure plan of the `/update` screen (text + buttons), shared by the command and its buttons in
 * `connectors/telegram/commands/selfUpdate.ts` so the text and the ✓ can never drift between the first render and the
 * re-render after a tap. In General it carries the controls; in any other topic it is the same text without buttons and with
 * "Change it in General."
 */

export const updateModeCallbackPrefix = 'upd_mode_';
export const updateWhatsNewCallbackPrefix = 'upd_notes_';
export const updateCheckCallback = 'upd_check';
/** Matches the install tap on the screen: `upd_go_<version or commit>`. */
export const updateInstallCallbackRe = new RegExp(`^${updateInstallCallbackPrefix}(.+)$`);
/** Matches the install tap under an announcement in General: `upd_ann_<version or commit>`. */
export const updateAnnouncementInstallCallbackRe = new RegExp(`^${updateAnnouncementInstallCallbackPrefix}(.+)$`);

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export interface UpdateScreenButton {
  text: string;
  data: string;
}

export interface UpdateScreen {
  text: string;
  rows: UpdateScreenButton[][];
}

export interface UpdateScreenInput {
  status: UpdateStatus;
  /** The controls are General's; elsewhere the screen is read-only. */
  isGeneral: boolean;
  now: number;
  /** The wall-clock time of an instant, in the instance's time zone (`14:20`). */
  formatClock: (epochMs: number) => string;
}

/** @description "just now", "20 min ago", "3 h ago", "2 d ago". */
export function formatAgo(elapsedMs: number, translate: Translate): string {
  if (elapsedMs < minuteMs) return translate('update.screen.ago.justNow');
  if (elapsedMs < hourMs) return translate('update.screen.ago.minutes', { count: Math.floor(elapsedMs / minuteMs) });
  if (elapsedMs < dayMs) return translate('update.screen.ago.hours', { count: Math.floor(elapsedMs / hourMs) });
  return translate('update.screen.ago.days', { count: Math.floor(elapsedMs / dayMs) });
}

function describeInstall(status: UpdateStatus, translate: Translate): string {
  const { installKind, running, isHotMode } = status;
  const version = running.version;
  switch (installKind.kind) {
    case 'npmGlobal':
      return translate('update.screen.install.npm', { version, prefix: installKind.prefix });
    case 'checkout':
      return translate(isHotMode ? 'update.screen.install.gitHot' : 'update.screen.install.git', { version, commit: running.commit ?? '?' });
    case 'ephemeral':
      return translate('update.screen.install.ephemeral', { version });
    case 'notifyOnly':
      return translate(`update.screen.install.notifyOnly.${installKind.reason}`, { version, commit: running.commit ?? '?' });
  }
}

function describeMode(status: UpdateStatus, translate: Translate): string {
  const mode: AutoUpdateMode = status.settings.autoUpdate;
  const canInstall = status.installKind.kind === 'npmGlobal' || status.installKind.kind === 'checkout';
  if (mode === 'on' && !canInstall) return translate('update.screen.mode.onNotifyOnly');
  return translate(`update.screen.mode.${mode}`);
}

function describeSkip(reason: GitSkipReason | string | null, translate: Translate): string {
  switch (reason) {
    case 'dirty':
    case 'diverged':
    case 'noUpstream':
    case 'inProgress':
      return translate(`update.screen.skip.${reason}`);
    default:
      return translate('update.screen.skip.other');
  }
}

/** @description Why an update that exists cannot be installed now — the line the screen shows, and what a refused «update now» says. */
export function describeBlockedOffer(offer: UpdateOffer, runningNode: string, translate: Translate): string {
  if (offer.action === 'needsNode') return translate('update.screen.offer.needsNode', { version: offer.target, required: offer.required ?? '', running: runningNode });
  return translate('update.screen.skipped', { reason: describeSkip(offer.skipReason, translate) });
}

function describeOffer(offer: UpdateOffer, status: UpdateStatus, input: UpdateScreenInput, translate: Translate): string {
  const params = { version: offer.target, required: offer.required ?? '', running: status.runningNode };
  switch (offer.action) {
    case 'waitHold': {
      const key = status.settings.autoUpdate === 'on' && offer.canInstallNow ? 'update.screen.offer.waitHoldAuto' : 'update.screen.offer.waitHoldNotice';
      return translate(key, { ...params, time: input.formatClock(offer.until ?? input.now) });
    }
    case 'installWhenIdle':
      return translate('update.screen.offer.installWhenIdle', params);
    case 'notify':
      return translate(offer.canInstallNow ? 'update.screen.offer.notify' : 'update.screen.offer.notifyManual', params);
    case 'offerMajor':
      return translate('update.screen.offer.major', params);
    case 'offerBreaking':
      return translate('update.screen.offer.breaking', params);
    case 'needsNode':
    case 'skipped':
      return describeBlockedOffer(offer, status.runningNode, translate);
  }
}

/** The "Checked … · …" line: what the last check saw, or what is going on right now. */
function describeProgress(status: UpdateStatus, input: UpdateScreenInput, translate: Translate): string {
  const target = status.inProgressTarget ?? '';
  if (status.phase === 'installing') return translate('update.screen.phase.installing', { version: target });
  if (status.phase === 'restartPending') return translate('update.screen.phase.restartPending', { version: target });
  if (status.phase === 'waitingForIdle' && target !== '') return translate('update.screen.phase.waitingForIdle', { version: target });
  if (status.lastCheckAt === null || status.observation === null) return translate('update.screen.neverChecked');
  const ago = formatAgo(input.now - status.lastCheckAt, translate);
  if (status.observation.kind === 'error') return translate('update.screen.checkFailed', { ago, reason: status.observation.reason });
  const detail = status.offer === null ? translate('update.screen.upToDate') : describeOffer(status.offer, status, input, translate);
  return translate('update.screen.checked', { ago, detail });
}

function buildButtons(status: UpdateStatus, translate: Translate): UpdateScreenButton[][] {
  const mode = status.settings.autoUpdate;
  const modeLabels: [AutoUpdateMode, string][] = [
    ['on', translate('update.screen.button.modeOn')],
    ['notify', translate('update.screen.button.modeNotify')],
    ['off', translate('update.screen.button.modeOff')],
  ];
  const rows: UpdateScreenButton[][] = [
    modeLabels.map(([candidate, label]) => ({ text: candidate === mode ? `✓ ${label}` : label, data: `${updateModeCallbackPrefix}${candidate}` })),
    [
      {
        text: translate(status.settings.whatsNew ? 'update.screen.button.whatsNewOn' : 'update.screen.button.whatsNewOff'),
        data: `${updateWhatsNewCallbackPrefix}${status.settings.whatsNew ? 'off' : 'on'}`,
      },
    ],
    [{ text: translate('update.screen.button.check'), data: updateCheckCallback }],
  ];
  const isBusy = status.phase === 'installing' || status.phase === 'restartPending';
  if (status.offer?.canInstallNow && !isBusy) {
    rows.push([{ text: translate('update.screen.button.updateNow', { version: status.offer.target }), data: `${updateInstallCallbackPrefix}${status.offer.target}` }]);
  }
  return rows;
}

/** @description The whole `/update` screen. */
export function buildUpdateScreen(input: UpdateScreenInput, translate: Translate): UpdateScreen {
  const { status } = input;
  const lines = [describeInstall(status, translate), '', describeMode(status, translate), translate(status.settings.whatsNew ? 'update.screen.whatsNew.on' : 'update.screen.whatsNew.off'), '', describeProgress(status, input, translate)];
  const manualCommand = status.installKind.kind === 'notifyOnly' ? status.installKind.manualCommand : null;
  if (manualCommand !== null) lines.push(translate('update.screen.manual', { command: manualCommand }));
  if (!input.isGeneral) lines.push('', translate('update.screen.changeInGeneral'));
  return { text: lines.join('\n'), rows: input.isGeneral ? buildButtons(status, translate) : [] };
}
