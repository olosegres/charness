import type { Translate } from '../i18n';
import type { WhatsNewSummary } from './releaseNotes';
import type { AutoUpdateMode } from './updateModes';

/**
 * What the update engine says in General, as data; {@link renderUpdateMessage} words it in the chat's language. The entries
 * of a what's-new list stay English (they are the CHANGELOG's own words, never translated at run time); everything around
 * them is localised.
 */

/** Where the full CHANGELOG lives, for "…and N more". */
export const changelogUrl = 'https://github.com/olosegres/charness/blob/main/CHANGELOG.md';
const releaseUrlPrefix = 'https://github.com/olosegres/charness/releases/tag/v';
const migrationGuideUrlPrefix = 'https://github.com/olosegres/charness/blob/main/';
/** The tap that installs the version printed on the button — its identity is baked in, so an old keyboard never installs another. */
export const updateInstallCallbackPrefix = 'upd_go_';
/**
 * The same tap under an ANNOUNCEMENT in General (a new version is out, a major or a migration guide is offered). A separate prefix on
 * purpose: a tap on the `/update` screen re-renders the screen, a tap on an announcement must leave the announcement as it is — it
 * would otherwise be overwritten with the generic screen, the major's «read the notes first» included.
 */
export const updateAnnouncementInstallCallbackPrefix = 'upd_ann_';

/** Why an automatic update did not finish, worded by the renderer. */
export type UpdateFailureReason = 'install' | 'start' | 'build' | 'boot';

export type UpdateMessage =
  | { kind: 'updated'; from: string; to: string; commitCount: number | null; summary: WhatsNewSummary | null }
  | { kind: 'nowRunning'; from: string; to: string; summary: WhatsNewSummary | null }
  | { kind: 'notify'; version: string; running: string; canInstall: boolean; manualCommand: string }
  | { kind: 'offerMajor'; version: string; running: string }
  | { kind: 'offerBreaking'; from: string; to: string; migrationGuides: string[] }
  | { kind: 'needsNode'; version: string; required: string; runningNode: string }
  | { kind: 'installFailed'; target: string; reason: UpdateFailureReason; stillRunning: string; manualCommand: string }
  | { kind: 'rollbackFailed'; target: string; reason: UpdateFailureReason; manualCommand: string }
  | { kind: 'checkFailing'; reason: string }
  | { kind: 'featureAnnounced'; mode: AutoUpdateMode }
  | { kind: 'restartSupervisor' };

export interface UpdateMessageButton {
  label: string;
  callbackData: string;
}

export interface RenderedUpdateMessage {
  text: string;
  /** Pinned in General: the operator must act, or a restart would boot a broken install. */
  pin: boolean;
  buttons: UpdateMessageButton[];
}

const bullet = '•';

/** The what's-new block: the to-do list first, then the headlines by version, then how many did not fit. */
function renderSummary(summary: WhatsNewSummary, translate: Translate): string {
  const lines: string[] = [];
  if (summary.todo.length > 0) {
    lines.push(translate('update.notes.todoLabel'));
    lines.push(...summary.todo.map((entry) => `${bullet} ${entry}`));
  }
  for (const group of summary.groups) {
    if (group.version !== null) lines.push(group.version);
    lines.push(...group.headlines.map((headline) => `${bullet} ${headline}`));
  }
  if (summary.moreCount > 0) lines.push(translate('update.notes.moreLine', { count: summary.moreCount, url: changelogUrl }));
  return lines.join('\n');
}

function withSummary(heading: string, summary: WhatsNewSummary | null, translate: Translate): string {
  return summary === null ? heading : `${heading}\n${renderSummary(summary, translate)}`;
}

function getUpdateButton(version: string, translate: Translate): UpdateMessageButton {
  return { label: translate('update.updateButton', { version }), callbackData: `${updateAnnouncementInstallCallbackPrefix}${version}` };
}

/** @description Word an update message: its text, whether to pin it, and its buttons. */
export function renderUpdateMessage(message: UpdateMessage, translate: Translate): RenderedUpdateMessage {
  switch (message.kind) {
    case 'updated': {
      const heading =
        message.commitCount === null
          ? translate('update.updated.heading', { from: message.from, to: message.to })
          : translate('update.updatedCommits.heading', { from: message.from, to: message.to, count: message.commitCount });
      return { text: withSummary(heading, message.summary, translate), pin: (message.summary?.todo.length ?? 0) > 0, buttons: [] };
    }
    case 'nowRunning':
      return {
        text: withSummary(translate('update.nowRunning.heading', { from: message.from, to: message.to }), message.summary, translate),
        pin: (message.summary?.todo.length ?? 0) > 0,
        buttons: [],
      };
    case 'notify':
      return message.canInstall
        ? { text: translate('update.notify', { version: message.version, running: message.running }), pin: false, buttons: [getUpdateButton(message.version, translate)] }
        : { text: translate('update.notifyManual', { version: message.version, running: message.running, command: message.manualCommand }), pin: false, buttons: [] };
    case 'offerMajor':
      return {
        text: translate('update.offerMajor', { version: message.version, running: message.running, url: `${releaseUrlPrefix}${message.version}` }),
        pin: false,
        buttons: [getUpdateButton(message.version, translate)],
      };
    case 'offerBreaking':
      return {
        text: translate('update.offerBreaking', {
          from: message.from,
          to: message.to,
          guides: message.migrationGuides.map((guide) => `${migrationGuideUrlPrefix}${guide}`).join(' '),
        }),
        pin: false,
        buttons: [getUpdateButton(message.to, translate)],
      };
    case 'needsNode':
      return {
        text: translate('update.needsNode', { version: message.version, required: message.required, running: message.runningNode }),
        pin: false,
        buttons: [],
      };
    case 'installFailed':
      return {
        text: translate('update.installFailed', {
          target: message.target,
          reason: translate(`update.failed.${message.reason}`),
          running: message.stillRunning,
          command: message.manualCommand,
        }),
        pin: false,
        buttons: [],
      };
    case 'rollbackFailed':
      return {
        text: translate('update.rollbackFailed', {
          target: message.target,
          reason: translate(`update.failed.${message.reason}`),
          command: message.manualCommand,
        }),
        pin: true,
        buttons: [],
      };
    case 'checkFailing':
      return { text: translate('update.checkFailing', { reason: message.reason }), pin: false, buttons: [] };
    case 'featureAnnounced':
      return { text: translate(message.mode === 'on' ? 'update.featureAnnounced.on' : 'update.featureAnnounced.notify'), pin: false, buttons: [] };
    case 'restartSupervisor':
      return { text: translate('update.restartSupervisor'), pin: false, buttons: [] };
  }
}
