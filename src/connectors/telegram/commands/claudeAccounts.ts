/**
 * `/accounts` — every account the bot works with, on one screen: the Claude accounts (profiles) with their usage
 * (which one a topic's Claude sessions run on, add / re-login / remove) and the OpenCode providers the server is
 * authenticated for (connect / disconnect). `/account`, `/connect` and `/disconnect` stay as hidden aliases; the
 * OpenCode flows themselves live in `modelProviders.ts` and are only entered from here through ports. See
 * README.md in this folder and `utils/claudeProfiles.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import type { ClaudeConfigDirApplyResult } from '../../../adapters/claudeConfigDir';
import type { ClaudeLoginProfile } from '../../../agentLogin/agentLogin';
import type { FallbackChainEntry } from '../../../utils/fallbackChain';
import type { OperatorSwitchOutcome } from '../../../utils/operatorSwitchPlan';
import {
  checkIsValidClaudeProfileName,
  claudeProfileNameMaxLength,
  createClaudeProfileLayout,
  defaultClaudeProfileName,
  normaliseClaudeProfileName,
  removeClaudeProfileLayout,
  signOutDefaultClaudeLogin,
  resolveClaudeProfileDir,
  type ClaudeAuthStatus,
} from '../../../utils/claudeProfiles';
import { formatClaudeProfileUsageLines } from '../../../utils/claudeProfileUsageLines';
import { claudeUsageOnDemandMaxAgeMs } from '../../../utils/claudeUsageRefresher';
import {
  accountAddCallback,
  accountAddProviderCallback,
  accountAutoSwitchOffCallback,
  accountAutoSwitchOnCallback,
  accountBackCallback,
  accountDisconnectCallbackRe,
  accountDisconnectConfirmCallbackRe,
  accountFollowDefaultCallback,
  accountLoginCallbackRe,
  accountLoginMenuCallback,
  accountReconnectCallbackRe,
  accountRemoveCallbackRe,
  accountRemoveConfirmCallbackRe,
  accountRemoveMenuCallback,
  accountUseCallbackRe,
  buildAccountLoginCallback,
  buildAccountDisconnectCallback,
  buildAccountDisconnectConfirmCallback,
  buildAccountPickerRows,
  buildAccountReconnectCallback,
  buildAccountRemoveCallback,
  buildAccountRemoveConfirmCallback,
  buildAccountUseCallback,
  countTopicsPerProfile,
  parseAccountCallbackName,
  type AccountPickerRow,
} from '../../../utils/claudeAccountPickerPlan';
import { checkIsValidProviderId } from '../../../adapters/openCodeAdapter';
import { buildMessageSnapshotKey, getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';
import { createWholeTextAnswerer } from './callbackToast';

/**
 * How a profile change reached the topic's live session: the adapter's own answer, plus `restartRequired`
 * for a backend that cannot re-spawn a working session by itself (the tmux TUI mid-turn).
 */
export type ClaudeProfileApplyOutcome = ClaudeConfigDirApplyResult | 'restartRequired';

/**
 * What the account picker needs from the bot: the shared core, where profiles live, the CLI status probe,
 * the profile sign-in driver, and the hooks that move live sessions onto a changed pick.
 */
export interface ClaudeAccountsPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'
  > {
  getDataDir: () => string;
  /** The instance zone (`/timezone`) the reset instants are shown in. */
  getInstanceTimezone: () => string;
  /** Bring the per-profile usage snapshots up to date (`utils/claudeUsageRefresher.ts`); never throws. */
  refreshClaudeUsage: (options: { maxAgeMs?: number }) => Promise<void>;
  /** `claude auth status --json` under `configDir` (`null` = `~/.claude`); `null` when the probe fails. */
  readClaudeAuthStatus: (configDir: string | null) => Promise<ClaudeAuthStatus | null>;
  /** Start the out-of-band sign-in of `profile`; the relay posts the link and the outcome into the topic. */
  startClaudeProfileLogin: (key: SessionKey, profile: ClaudeLoginProfile) => Promise<void>;
  /** Bring ONE topic's live Claude session onto the profile it now resolves to. */
  applyClaudeProfile: (key: SessionKey) => Promise<ClaudeProfileApplyOutcome>;
  /** Bring every served topic's live Claude session onto its resolved profile (after a General change / a removal). */
  applyClaudeProfileEverywhere: () => Promise<void>;
  /**
   * The operator's own pick of a rung on a topic (`bot.ts`, `utils/operatorSwitchPlan.ts`): an account of the backend
   * the topic runs changes the account, an account picked on the other backend asks first when a conversation is to
   * be handed over (`asked`: the question is already in the topic, nothing more to say), a pick while a limit wait is
   * armed is the limit move. The outcome carries the line to show.
   */
  switchTopicByOperator: (key: SessionKey, to: FallbackChainEntry) => Promise<OperatorSwitchOutcome>;
  /** The OpenCode providers the server is authenticated for (its live catalog); `[]` when it cannot be read. */
  detectOpenCodeProviders: () => Promise<string[]>;
  /** Drop a provider's stored credentials and post the outcome — the `/disconnect <provider>` flow, unchanged. */
  disconnectOpenCodeProvider: (key: SessionKey, providerId: string) => Promise<void>;
  /** Start the `/connect <provider>` flow (the method picker: OAuth or API key), unchanged. */
  startOpenCodeConnect: (key: SessionKey, providerId: string) => Promise<void>;
  /**
   * The «auto switch to a fallback model» setting (`fallbackChain.ts` owns it and its confirmation): the legacy
   * `autoswitch on|off` verb and the old `acct_autosw_*` buttons write it through here.
   */
  applyAutoSwitch: (key: SessionKey, isGeneral: boolean, enabled: boolean) => Promise<string>;
  /** `~/.claude`, where the default login lives; injectable so a test signs out a temp directory, never the real one. */
  getHomeClaudeDir?: () => string;
}

/** Screens whose provider snapshot is kept (the newest); an older keyboard is refused as expired. */
const providerSnapshotLimit = 50;

/**
 * @description Build the `/account` feature over its ports: the command, its buttons, the name capture the
 * «Add» button arms (the text handler asks `checkIsAwaitingProfileName` / `submitProfileName`), and the
 * auth-status sink the sign-in driver reports to.
 */
export function createClaudeAccounts(ports: ClaudeAccountsPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getDataDir, getInstanceTimezone, refreshClaudeUsage, readClaudeAuthStatus, startClaudeProfileLogin, applyClaudeProfile,
    applyClaudeProfileEverywhere, switchTopicByOperator, detectOpenCodeProviders, disconnectOpenCodeProvider, startOpenCodeConnect, applyAutoSwitch, getHomeClaudeDir,
  } = ports;
  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  /**
   * Topics whose next plain message is an answer to «➕»: the name of a new Claude profile, or the id of the
   * OpenCode provider to connect. One capture per topic; armed by the buttons / `add`, disarmed by a slash
   * command or `/esc`.
   */
  const awaitingProfileName = new Map<string, 'claudeName' | 'providerId'>();
  /** The OpenCode providers each screen MESSAGE listed — its disconnect buttons carry an index into this. */
  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat. */
  const providerSnapshots = new Map<string, string[]>();

  function rememberProviders(key: SessionKey, messageId: number, providers: string[]): void {
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    providerSnapshots.delete(snapshotKey);
    providerSnapshots.set(snapshotKey, providers);
    while (providerSnapshots.size > providerSnapshotLimit) {
      const oldest = providerSnapshots.keys().next().value;
      if (oldest === undefined) break;
      providerSnapshots.delete(oldest);
    }
  }

  async function readOpenCodeProviders(): Promise<string[]> {
    try {
      return await detectOpenCodeProviders();
    } catch (e) {
      console.warn('[accounts] the OpenCode providers are unavailable:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  function resolveActiveName(key: SessionKey, isGeneral: boolean): string {
    return isGeneral ? getState().getClaudeProfileGlobalDefault() : getState().resolveClaudeProfileName(key);
  }

  /** The config directory of a profile; `null` for `default`. */
  function resolveDir(name: string): string | null {
    return resolveClaudeProfileDir(getDataDir(), name);
  }

  function checkIsKnownProfile(name: string): boolean {
    return name === defaultClaudeProfileName || getState().getClaudeProfileRecord(name) !== undefined;
  }

  /**
   * @description Re-read every added profile's auth status (and the default's) and persist what changed, so the
   * picker shows the CLI's truth, not the state of the last sign-in. One short `claude auth status` per profile,
   * in parallel; a failed probe leaves the record as it was.
   */
  async function refreshProfileStatuses(): Promise<ClaudeAuthStatus | null> {
    const names = Object.keys(getState().getClaudeProfileRecords());
    const [defaultStatus, ...statuses] = await Promise.all([
      readClaudeAuthStatus(null),
      ...names.map((name) => readClaudeAuthStatus(resolveDir(name))),
    ]);
    await Promise.all([
      recordProfileStatus(defaultClaudeProfileName, defaultStatus),
      ...names.map((name, index) => recordProfileStatus(name, statuses[index])),
    ]);
    return defaultStatus;
  }

  /**
   * Persist a probe's answer on the profile's record (nothing for a failed probe). `default` gets its hidden
   * record, so the usage ranking and the CLI twin know whether it is signed in and as whom.
   */
  async function recordProfileStatus(name: string, status: ClaudeAuthStatus | null): Promise<void> {
    if (status === null) return;
    if (name !== defaultClaudeProfileName && getState().getClaudeProfileRecord(name) === undefined) return; // removed meanwhile
    await getState().upsertClaudeProfileRecord(name, {
      // A removed `default` comes back by itself the moment it is signed in again.
      ...(name === defaultClaudeProfileName && status.loggedIn ? { isRemoved: undefined } : {}),
      loggedIn: status.loggedIn,
      email: status.email ?? undefined,
      subscriptionType: status.subscriptionType ?? undefined,
      orgName: status.orgName ?? undefined,
      statusCheckedAt: new Date().toISOString(),
    });
  }

  /** The sign-in driver's report at the end of a profile sign-in: record it, then move live sessions onto it. */
  async function onClaudeProfileAuthStatus(_key: SessionKey, profile: ClaudeLoginProfile, status: ClaudeAuthStatus | null): Promise<void> {
    await recordProfileStatus(profile.name, status);
    // A topic may already have picked the profile before its sign-in: its sleeping session resumes under it by
    // itself, and a live one is re-spawned now that the account exists.
    if (status?.loggedIn) await applyClaudeProfileEverywhere();
  }

  function formatRow(row: AccountPickerRow): string {
    const marker = row.isActive ? '✓ ' : '• ';
    const account = row.loggedIn === false || (row.loggedIn === undefined && row.email === null)
      ? t('account.row.loggedOut')
      : `${row.email ?? '?'}, ${t(`account.kind.${row.kind}`, { plan: row.subscriptionType ?? '?' })}`;
    const users = row.topicCount > 0 ? t('account.row.topics', { count: row.topicCount }) : '';
    return `${marker}${row.name} — ${account}${users}${formatUsageLines(row.name)}`;
  }

  /**
   * The profile's usage under its row (`utils/claudeProfileUsageLines.ts`, the renderer `/limits` shares), each
   * line on its own row. Nothing for a profile never polled.
   */
  function formatUsageLines(name: string): string {
    const lines = formatClaudeProfileUsageLines(getState().getClaudeProfileInfo(name), getInstanceTimezone(), Date.now());
    return lines.map((line) => `\n${line}`).join('');
  }

  function formatRowButton(row: AccountPickerRow): string {
    const marker = row.isActive ? '✓ ' : '';
    const detail = row.loggedIn === false || (row.loggedIn === undefined && row.email === null)
      ? t('account.row.loggedOut')
      : row.email ?? row.name;
    return `${marker}${row.name} · ${detail}`;
  }

  async function buildPickerRows(key: SessionKey, isGeneral: boolean): Promise<AccountPickerRow[]> {
    // The usage poll runs beside the status probes; a snapshot younger than a minute is kept.
    const [defaultStatus] = await Promise.all([refreshProfileStatuses(), refreshClaudeUsage({ maxAgeMs: claudeUsageOnDemandMaxAgeMs })]);
    const state = getState();
    const topicCounts = countTopicsPerProfile(state.listBindings().map(({ key: boundKey }) => state.resolveClaudeProfileName(boundKey)));
    return buildAccountPickerRows({
      isDefaultRemoved: state.getClaudeProfileInfo(defaultClaudeProfileName)?.isRemoved === true,
      records: state.getClaudeProfileRecords(),
      defaultStatus: {
        loggedIn: defaultStatus?.loggedIn,
        email: defaultStatus?.email ?? null,
        subscriptionType: defaultStatus?.subscriptionType ?? null,
      },
      activeName: resolveActiveName(key, isGeneral),
      topicCounts,
    });
  }

  /** The main screen: text + keyboard, for the topic (or General), and the provider list the keyboard indexes. */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard>; providers: string[] }> {
    const [rows, providers] = await Promise.all([buildPickerRows(key, isGeneral), readOpenCodeProviders()]);
    const list = rows.map(formatRow).join('\n');
    const activeName = resolveActiveName(key, isGeneral);
    const title = isGeneral
      ? t('account.titleGeneral', { name: activeName, list })
      : t('account.title', { name: activeName, list });
    const openCodeSection = providers.length === 0
      ? t('accounts.openCodeNone')
      : t('accounts.openCodeSection', { list: providers.map((provider) => `• ${provider}`).join('\n') });
    const isDefaultRemoved = getState().getClaudeProfileInfo(defaultClaudeProfileName)?.isRemoved === true;
    const removedNote = isDefaultRemoved ? `\n\n${t('accounts.defaultRemovedNote')}` : '';
    // The usage hint (which says the percentages are USED) follows the account list it explains.
    const text = `${title}${removedNote}\n\n${t('account.usageHint')}\n\n${openCodeSection}\n\n${t('accounts.buttonsHint')}\n\n${t('account.autoSwitchHint')}`;
    // One row per Claude account: pick it (✓ = the current one), sign it in again, remove it (`default` too: signs it out).
    const keyboardRows = rows.map((row) => [
      Markup.button.callback(formatRowButton(row), buildAccountUseCallback(row.name)),
      Markup.button.callback('🔑', buildAccountLoginCallback(row.name)),
      Markup.button.callback('🗑', buildAccountRemoveCallback(row.name)),
    ]);
    // A provider row mirrors it: what the button does is in its caption, 🔑 connects it again.
    providers.forEach((provider, index) => {
      keyboardRows.push([
        Markup.button.callback(t('accounts.disconnectButton', { provider }), buildAccountDisconnectCallback(index)),
        Markup.button.callback('🔑', buildAccountReconnectCallback(index)),
      ]);
    });
    keyboardRows.push([
      Markup.button.callback(t('accounts.addClaudeButton'), accountAddCallback),
      Markup.button.callback(t('accounts.addProviderButton'), accountAddProviderCallback),
    ]);
    if (!isGeneral && getState().getClaudeProfileOverride(key) !== undefined) {
      keyboardRows.push([
        Markup.button.callback(t('account.followButton', { name: getState().getClaudeProfileGlobalDefault() }), accountFollowDefaultCallback),
      ]);
    }
    return { text, keyboard: Markup.inlineKeyboard(keyboardRows), providers };
  }

  /** Post the screen as a new message and remember the provider list its buttons index. */
  async function postPicker(key: SessionKey, isGeneral: boolean): Promise<void> {
    const picker = await buildPicker(key, isGeneral);
    const messageId = await replyToThread(key, picker.text, picker.keyboard);
    if (messageId !== null) rememberProviders(key, messageId, picker.providers);
  }

  /** A sub-picker: one button per profile (`default` included only when `includeDefault`), plus «Back». */
  function buildProfileChoiceKeyboard(buildCallback: (name: string) => string, includeDefault: boolean) {
    const names = [...(includeDefault ? [defaultClaudeProfileName] : []), ...Object.keys(getState().getClaudeProfileRecords())];
    const rows = names.map((name) => [Markup.button.callback(name, buildCallback(name))]);
    rows.push([Markup.button.callback(t('account.backButton'), accountBackCallback)]);
    return Markup.inlineKeyboard(rows);
  }

  /** Re-render the picker IN PLACE (it is meant for repeated use, like `/model`); best-effort. */
  async function rerenderPicker(key: SessionKey, messageId: number | null, isGeneral: boolean): Promise<void> {
    if (messageId === null) return;
    const picker = await buildPicker(key, isGeneral);
    rememberProviders(key, messageId, picker.providers);
    await editThreadMessage(key, messageId, picker.text, picker.keyboard);
  }

  function describeApplyOutcome(outcome: ClaudeProfileApplyOutcome): string {
    return t(`account.applied.${outcome}`);
  }

  /**
   * @description Apply a pick and RETURN the confirmation — the one write path behind the command and the
   * button. A regular topic sets its own pick and its live session follows at once (idle: re-spawned, same
   * conversation; working: at turn end; sleeping: at the next resume). General sets the instance default and
   * every topic that follows the default is moved the same way. A profile that is not signed in is refused:
   * a session started under it would only fail with a logged-out error. On a topic that runs OpenCode the pick is
   * a switch to Claude (`takeClaudeAccountPickOnOpenCodeTopic`): the answer is then the question already posted
   * (`null`: nothing to say) or the line that the topic switched.
   */
  async function applyPick(key: SessionKey, isGeneral: boolean, name: string): Promise<string | null> {
    if (!checkIsKnownProfile(name)) return t('account.unknown', { name });
    if (name !== defaultClaudeProfileName) {
      const status = await readClaudeAuthStatus(resolveDir(name));
      await recordProfileStatus(name, status);
      if (status !== null && !status.loggedIn) return t('account.notLoggedIn', { name });
    }
    if (isGeneral) {
      await getState().setClaudeProfileGlobalDefault(name);
      await applyClaudeProfileEverywhere();
      return t('account.setGlobal', { name });
    }
    const outcome = await switchTopicByOperator(key, { backend: 'claude', profile: name, model: null });
    return outcome.kind === 'asked' ? null : outcome.text;
  }

  /** A topic drops its own pick; its session follows the instance default from now on. */
  async function applyFollowDefault(key: SessionKey): Promise<string> {
    await getState().setClaudeProfileOverride(key, null);
    const name = getState().getClaudeProfileGlobalDefault();
    const outcome = await applyClaudeProfile(key);
    return t('account.followSet', { name, apply: describeApplyOutcome(outcome) });
  }

  /**
   * @description Create a profile and start its sign-in: the directory with its shared links, the registry
   * record (flushed before the sign-in, so a crash never leaves a signed-in directory the picker cannot see),
   * then the relay posts the link. Returns the message to post BEFORE the link, or the refusal.
   */
  async function addProfile(key: SessionKey, rawName: string): Promise<string> {
    const name = normaliseClaudeProfileName(rawName);
    if (!checkIsValidClaudeProfileName(name)) return t('account.invalidName', { max: claudeProfileNameMaxLength });
    if (getState().getClaudeProfileRecord(name) !== undefined) return t('account.exists', { name });
    let configDir: string;
    try {
      configDir = createClaudeProfileLayout({ dataDir: getDataDir(), name });
    } catch (e) {
      console.error(`[account] profile layout for ${name} failed:`, e instanceof Error ? e.message : e);
      return t('account.createFailed', { name });
    }
    await getState().upsertClaudeProfileRecord(name, { createdAt: new Date().toISOString(), loggedIn: false });
    await replyToThread(key, t('account.created', { name }));
    await startClaudeProfileLogin(key, { name, configDir });
    return '';
  }

  /** Sign a known profile in (again); `default` is the plain `~/.claude` login. */
  async function loginProfile(key: SessionKey, name: string): Promise<string> {
    if (!checkIsKnownProfile(name)) return t('account.unknown', { name });
    if (name !== defaultClaudeProfileName) {
      // The directory may be gone (a hand-cleaned DATA_DIR): recreate the layout so the login has a home.
      createClaudeProfileLayout({ dataDir: getDataDir(), name });
    }
    await startClaudeProfileLogin(key, { name, configDir: resolveDir(name) });
    return '';
  }

  /**
   * @description Remove a profile — the SAFE way: `default` is `~/.claude` and is never removed; the instance
   * default is refused until General picks another (otherwise every following topic would silently change
   * account); topics that picked the profile explicitly return to the instance default and are moved at once,
   * and the confirmation says how many. The directory (its login with it) goes last, after the registry.
   */
  async function removeProfile(name: string): Promise<string> {
    if (name === defaultClaudeProfileName) return signOutDefault();
    if (!checkIsKnownProfile(name)) return t('account.unknown', { name });
    if (getState().getClaudeProfileGlobalDefault() === name) return t('account.removeInstanceDefaultRefused', { name });
    const dropped = await getState().removeClaudeProfileRecord(name);
    try {
      removeClaudeProfileLayout(getDataDir(), name);
    } catch (e) {
      console.error(`[account] removing the directory of ${name} failed:`, e instanceof Error ? e.message : e);
    }
    await applyClaudeProfileEverywhere();
    return t('account.removed', { name, count: dropped.length });
  }

  /**
   * @description «Remove» for `default`: sign `~/.claude` out (delete just its stored subscription login, see
   * `signOutDefaultClaudeLogin`) and hide it from the list and the rankings until it is signed in again. The
   * transcripts, settings, skills and memory stay. Running sessions on it stop working at their next request.
   */
  async function signOutDefault(): Promise<string> {
    let isSignedOut = false;
    try {
      isSignedOut = signOutDefaultClaudeLogin(getHomeClaudeDir?.());
    } catch (e) {
      console.error('[account] signing the default account out failed:', e instanceof Error ? e.message : e);
      return t('account.removeDefaultFailed');
    }
    await getState().upsertClaudeProfileRecord(defaultClaudeProfileName, { isRemoved: true, loggedIn: false });
    console.log(`[account] the default account was signed out (${isSignedOut ? 'login deleted' : 'no stored login found'})`);
    return t('account.removedDefault');
  }

  /** The text of a removal confirmation and its Yes / Back keyboard. */
  function buildRemoveConfirmation(name: string): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
    const record = getState().getClaudeProfileRecord(name);
    const count = getState().listClaudeProfileOverrideKeys(name).length;
    if (name === defaultClaudeProfileName) {
      const email = getState().getClaudeProfileInfo(name)?.email ?? t('account.row.loggedOut');
      return {
        text: t('account.confirmRemoveDefault', { email }),
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback(t('account.confirmRemoveButton', { name }), buildAccountRemoveConfirmCallback(name))],
          [Markup.button.callback(t('account.backButton'), accountBackCallback)],
        ]),
      };
    }
    return {
      text: t('account.confirmRemove', { name, email: record?.email ?? t('account.row.loggedOut'), count }),
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback(t('account.confirmRemoveButton', { name }), buildAccountRemoveConfirmCallback(name))],
        [Markup.button.callback(t('account.backButton'), accountBackCallback)],
      ]),
    };
  }

  // ── the «Add» name capture ──

  /** Whether the topic's next plain message is a new profile's name (the text handler asks before forwarding). */
  function checkIsAwaitingProfileName(key: SessionKey): boolean {
    return awaitingProfileName.has(keyToString(key));
  }

  /** Disarm the capture (a slash command, `/esc`, a teardown). Returns whether one was armed. */
  function cancelProfileNameCapture(key: SessionKey): boolean {
    return awaitingProfileName.delete(keyToString(key));
  }

  /** The captured provider id: start the `/connect` flow for it; a bad id keeps the capture armed. */
  async function submitProviderId(key: SessionKey, text: string): Promise<void> {
    const providerId = text.trim().toLowerCase();
    if (!checkIsValidProviderId(providerId)) {
      await replyToThread(key, `${t('connect.invalid_provider', { provider: providerId })}\n${t('login.esc_hint')}`);
      return;
    }
    awaitingProfileName.delete(keyToString(key));
    await startOpenCodeConnect(key, providerId);
  }

  /** The captured answer of «➕»: a Claude profile name, or an OpenCode provider id, by what was asked. */
  async function submitProfileName(key: SessionKey, text: string): Promise<void> {
    if (awaitingProfileName.get(keyToString(key)) === 'providerId') {
      await submitProviderId(key, text);
      return;
    }
    const name = normaliseClaudeProfileName(text);
    if (!checkIsValidClaudeProfileName(name)) {
      await replyToThread(key, `${t('account.invalidName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
      return;
    }
    awaitingProfileName.delete(keyToString(key));
    const message = await addProfile(key, name);
    if (message) await replyToThread(key, message);
  }

  // ── the command ──

  function registerClaudeAccountCommands(): void {
    // `/accounts` (hidden alias `/account`) — bare: the screen. `add <name>` creates a profile and signs it in; `use <name>` switches
    // this topic (General: the instance default); `login <name>` signs a profile in again; `remove <name>`
    // deletes one. Not gated on a session: the pick is read at the next spawn, so it must be settable first.
    command(['account', 'accounts'], async (_ctx, key, parsed: InboundCommand) => {
      const isGeneral = checkIsGeneral(key);
      const [verb = '', ...rest] = parsed.args;
      const name = normaliseClaudeProfileName(rest.join(' '));
      switch (verb.toLowerCase()) {
        case '': {
          await postPicker(key, isGeneral);
          return;
        }
        case 'add': {
          if (!name) {
            awaitingProfileName.set(keyToString(key), 'claudeName');
            await replyToThread(key, `${t('account.askName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
            return;
          }
          const message = await addProfile(key, name);
          if (message) await replyToThread(key, message);
          return;
        }
        case 'use': {
          if (!name) { await replyToThread(key, t('account.usage')); return; }
          const confirmation = await applyPick(key, isGeneral, name);
          if (confirmation !== null) await replyToThread(key, confirmation);
          return;
        }
        case 'login': {
          const message = await loginProfile(key, name || defaultClaudeProfileName);
          if (message) await replyToThread(key, message);
          return;
        }
        case 'remove':
        case 'rm': {
          if (!name) { await replyToThread(key, t('account.usage')); return; }
          await replyToThread(key, await removeProfile(name));
          return;
        }
        case 'autoswitch': {
          if (name !== 'on' && name !== 'off') { await replyToThread(key, t('account.usage')); return; }
          await replyToThread(key, await applyAutoSwitch(key, isGeneral, name === 'on'));
          return;
        }
        default:
          await replyToThread(key, t('account.usage'));
      }
    });
  }

  /** The shared tap prologue: authorise, resolve the topic, run under its locale. */
  async function handleTap(ctx: Context, run: (key: SessionKey, isGeneral: boolean, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, checkIsGeneral(key), getCallbackMessageId(ctx)));
  }

  function registerClaudeAccountCallbacks(): void {
    bot.action(accountUseCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountUseCallbackRe, { allowDefault: true });
      if (name === null) { await ctx.answerCbQuery(); return; }
      const confirmation = await applyPick(key, isGeneral, name);
      if (confirmation === null) await ctx.answerCbQuery();
      else await answerWithWholeText(ctx, key, confirmation);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountFollowDefaultCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (isGeneral) { await ctx.answerCbQuery(); return; }
      await answerWithWholeText(ctx, key, await applyFollowDefault(key));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountAddCallback, (ctx) => handleTap(ctx, async (key) => {
      awaitingProfileName.set(keyToString(key), 'claudeName');
      await ctx.answerCbQuery();
      await replyToThread(key, `${t('account.askName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
    }));

    bot.action(accountAddProviderCallback, (ctx) => handleTap(ctx, async (key) => {
      awaitingProfileName.set(keyToString(key), 'providerId');
      await ctx.answerCbQuery();
      await replyToThread(key, `${t('accounts.askProvider')}\n${t('login.esc_hint')}`);
    }));

    // A provider's «🔌» row → ask first (a disconnect drops stored credentials), against the snapshot of the
    // message the button sits on: an older screen can never map its index onto a newer list.
    bot.action(accountDisconnectCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await ctx.answerCbQuery(t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await editThreadMessage(key, messageId, t('accounts.confirmDisconnect', { provider }), Markup.inlineKeyboard([
        [Markup.button.callback(t('accounts.confirmDisconnectButton', { provider }), buildAccountDisconnectConfirmCallback(Number(ctx.match[1])))],
        [Markup.button.callback(t('account.backButton'), accountBackCallback)],
      ]));
    }));

    bot.action(accountDisconnectConfirmCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await ctx.answerCbQuery(t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await disconnectOpenCodeProvider(key, provider);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    // A provider's «🔑» → connect it again (the method picker); the screen is re-rendered first.
    bot.action(accountReconnectCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await ctx.answerCbQuery(t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await startOpenCodeConnect(key, provider);
    }));

    bot.action(accountLoginMenuCallback, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await ctx.answerCbQuery();
      if (messageId !== null) await editThreadMessage(key, messageId, t('account.pickLogin'), buildProfileChoiceKeyboard(buildAccountLoginCallback, true));
    }));

    bot.action(accountRemoveMenuCallback, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await ctx.answerCbQuery();
      if (Object.keys(getState().getClaudeProfileRecords()).length === 0) {
        await replyToThread(key, t('account.nothingToRemove'));
        return;
      }
      if (messageId !== null) await editThreadMessage(key, messageId, t('account.pickRemove'), buildProfileChoiceKeyboard(buildAccountRemoveCallback, false));
    }));

    bot.action(accountBackCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await ctx.answerCbQuery();
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountLoginCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountLoginCallbackRe, { allowDefault: true });
      if (name === null) { await ctx.answerCbQuery(); return; }
      await ctx.answerCbQuery();
      await rerenderPicker(key, messageId, isGeneral); // the sub-picker is consumed back into the main picker
      const message = await loginProfile(key, name);
      if (message) await replyToThread(key, message);
    }));

    bot.action(accountRemoveCallbackRe, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountRemoveCallbackRe, { allowDefault: true });
      if (name === null || !checkIsKnownProfile(name)) { await ctx.answerCbQuery(t('account.unknown', { name: name ?? '?' })); return; }
      await ctx.answerCbQuery();
      const confirmation = buildRemoveConfirmation(name);
      if (messageId !== null) await editThreadMessage(key, messageId, confirmation.text, confirmation.keyboard);
    }));

    bot.action(accountRemoveConfirmCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountRemoveConfirmCallbackRe, { allowDefault: true });
      if (name === null) { await ctx.answerCbQuery(); return; }
      const result = await removeProfile(name);
      await answerWithWholeText(ctx, key, result);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    for (const [callback, enabled] of [[accountAutoSwitchOnCallback, true], [accountAutoSwitchOffCallback, false]] as const) {
      bot.action(callback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
        await answerWithWholeText(ctx, key, await applyAutoSwitch(key, isGeneral, enabled));
        await rerenderPicker(key, messageId, isGeneral);
      }));
    }
  }

  return {
    registerClaudeAccountCommands,
    registerClaudeAccountCallbacks,
    checkIsAwaitingProfileName,
    cancelProfileNameCapture,
    submitProfileName,
    onClaudeProfileAuthStatus,
  };
}
