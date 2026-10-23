/**
 * `/accounts` — every account the bot works with, on one screen: the Claude accounts (profiles) with their usage
 * (which one a topic's Claude sessions run on, add / re-login / remove) and the OpenCode providers the server is
 * authenticated for (switch the topic to one through the shared model page / connect / disconnect; a ChatGPT
 * subscription shows its usage like a Claude account). The title and the ✓ say where the topic REALLY runs, OpenCode
 * included. `/account`, `/connect` and `/disconnect` stay as hidden aliases; the OpenCode flows themselves live in
 * `modelProviders.ts` and are only entered from here through ports. See README.md in this folder and
 * `utils/claudeProfiles.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import type { ClaudeConfigDirApplyResult } from '../../../adapters/claudeConfigDir';
import type { ClaudeLoginProfile } from '../../../agentLogin/agentLogin';
import { getRunningModelOfProvider, listOpenCodeModelsOfProvider, parseOpenCodeModelLabel, type FallbackChainEntry } from '../../../utils/fallbackChain';
import type { BackendFamily } from '../../../utils/backendSwitchPlan';
import { chatGptProviderId } from '../../../utils/openCodeUsage';
import { modelPickerNoopCallback } from '../../../utils/modelPickerPlan';
import type { OperatorSwitchOutcome } from '../../../utils/operatorSwitchPlan';
import {
  checkIsAnthropicSecretLike,
  checkIsValidClaudeProfileName,
  claudeConsoleLoginKeySource,
  claudeProfileNameMaxLength,
  createClaudeProfileLayout,
  defaultClaudeProfileName,
  normaliseClaudeProfileName,
  removeClaudeProfileApiKey,
  removeClaudeProfileLayout,
  signOutDefaultClaudeLogin,
  resolveClaudeProfileDir,
  writeClaudeProfileApiKey,
  type ClaudeAuthStatus,
  type ClaudeProfileBilling,
} from '../../../utils/claudeProfiles';
import type { AnthropicApiKeyCheck } from '../../../utils/anthropicApiKeyCheck';
import { formatClaudeProfileUsageLines } from '../../../utils/claudeProfileUsageLines';
import { claudeUsageOnDemandMaxAgeMs } from '../../../utils/claudeUsageRefresher';
import {
  accountAddApiCallback,
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
  accountOpenCodeModelCallbackRe,
  accountOpenCodePageCallbackRe,
  accountOpenCodeUseCallbackRe,
  accountReconnectCallbackRe,
  accountRemoveCallbackRe,
  accountRemoveConfirmCallbackRe,
  accountRemoveMenuCallback,
  accountUseCallbackRe,
  buildAccountLoginCallback,
  buildAccountDisconnectCallback,
  buildAccountDisconnectConfirmCallback,
  buildAccountOpenCodeModelCallback,
  buildAccountOpenCodePageCallback,
  buildAccountOpenCodeUseCallback,
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
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';
import type { BotCore } from './botCore';
import { answerCallbackQuerySafely, createWholeTextAnswerer } from './callbackToast';
import { buildOpenCodeProviderPage, handleModelPick, handleProviderTap } from './modelPage';

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
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'deleteThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'
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
  /** The OpenCode catalog as `provider/model` labels (what a provider's model page lists); `[]` when it cannot be read. */
  listOpenCodeModels: () => Promise<string[]>;
  /** Where the topic runs: the backend family of its agent (`null`: no agent / a shell) and, when known, its rung. */
  getTopicRun: (key: SessionKey) => { family: BackendFamily | null; rung: FallbackChainEntry | null };
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
  /** Whether the API accepts a pasted key (`utils/anthropicApiKeyCheck.ts`); injectable so a test never reaches the network. */
  verifyAnthropicApiKey: (apiKey: string) => Promise<AnthropicApiKeyCheck>;
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
    bot, command, getState, replyToThread, editThreadMessage, deleteThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getDataDir, getInstanceTimezone, refreshClaudeUsage, readClaudeAuthStatus, startClaudeProfileLogin, applyClaudeProfile,
    applyClaudeProfileEverywhere, switchTopicByOperator, detectOpenCodeProviders, listOpenCodeModels, getTopicRun, disconnectOpenCodeProvider, startOpenCodeConnect, applyAutoSwitch, getHomeClaudeDir,
    verifyAnthropicApiKey,
  } = ports;
  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  /**
   * Topics whose next plain message is an answer to «➕»: the name of a new Claude profile (a subscription one, or one
   * billed to the API), or the id of the OpenCode provider to connect. One capture per topic; armed by the buttons /
   * `add`, disarmed by a slash command or `/esc`.
   */
  const awaitingProfileName = new Map<string, 'claudeName' | 'claudeApiName' | 'providerId'>();
  /** The OpenCode providers each screen MESSAGE listed — its disconnect buttons carry an index into this. */
  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat. */
  const providerSnapshots = new Map<string, string[]>();
  /** The provider whose model page a screen MESSAGE shows, with the models its buttons index (dropped when the screen is re-rendered). */
  const pageSnapshots = new Map<string, { providerId: string; models: string[] }>();

  function rememberProviders(key: SessionKey, messageId: number, providers: string[]): void {
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    pageSnapshots.delete(snapshotKey);
    rememberBoundedSnapshot(providerSnapshots, snapshotKey, providers, providerSnapshotLimit);
  }

  async function readOpenCodeProviders(): Promise<string[]> {
    try {
      return await detectOpenCodeProviders();
    } catch (e) {
      console.warn('[accounts] the OpenCode providers are unavailable:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** The Claude account a topic's next Claude session takes: its own pick, else the instance default. */
  function resolveClaudeAccountName(key: SessionKey, isGeneral: boolean): string {
    return isGeneral ? getState().getClaudeProfileGlobalDefault() : getState().resolveClaudeProfileName(key);
  }

  /**
   * The account the ✓ sits on. General: the instance default. A topic: the account its Claude session RUNS on (which is
   * not the pick while a switch is deferred), no account while it runs OpenCode, and — with no agent — the pick the next
   * start takes.
   */
  function resolveActiveName(key: SessionKey, isGeneral: boolean): string | null {
    if (isGeneral) return getState().getClaudeProfileGlobalDefault();
    const run = getTopicRun(key);
    if (run.family === 'opencode') return null;
    return run.rung?.backend === 'claude' ? run.rung.profile : resolveClaudeAccountName(key, false);
  }

  /** Where the topic runs, for the title: `Claude «perf»`, `OpenCode openai/gpt-5`, or `OpenCode` while its model is unknown. */
  function formatRunLabel(key: SessionKey): string {
    const run = getTopicRun(key);
    if (run.family === 'opencode') {
      return run.rung?.backend === 'opencode' ? `${t('fallback.backendOpenCode')} ${run.rung.providerId}/${run.rung.modelId}` : t('fallback.backendOpenCode');
    }
    return `${t('fallback.backendClaude')} «${resolveActiveName(key, false) ?? resolveClaudeAccountName(key, false)}»`;
  }

  /** The config directory of a profile; `null` for `default`. */
  function resolveDir(name: string): string | null {
    return resolveClaudeProfileDir(getDataDir(), name);
  }

  function checkIsKnownProfile(name: string): boolean {
    return name === defaultClaudeProfileName || getState().getClaudeProfileRecord(name) !== undefined;
  }

  /** How a known profile pays, as last recorded (`default` from its hidden record); `null` when never recorded. */
  function readBilling(name: string): ClaudeProfileBilling | null {
    return getState().getClaudeProfileInfo(name)?.billing ?? null;
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
      // The CLI's word on how the account pays wins over the kind it was added as, both ways.
      ...(status.billing !== null ? { billing: status.billing } : {}),
      loggedIn: status.loggedIn,
      email: status.email ?? undefined,
      subscriptionType: status.subscriptionType ?? undefined,
      orgName: status.orgName ?? undefined,
      statusCheckedAt: new Date().toISOString(),
    });
  }

  /**
   * The sign-in driver's report at the end of a profile sign-in: record it, then move live sessions onto it. A Console
   * sign-in that created its key replaces an older pasted key of the same account (the latest sign-in wins); the record
   * then takes the probe the sessions see — a failed Console sign-in over a working pasted key leaves the account
   * signed in.
   */
  async function onClaudeProfileAuthStatus(_key: SessionKey, profile: ClaudeLoginProfile, status: ClaudeAuthStatus | null): Promise<void> {
    let recorded = status;
    if (profile.billing === 'api' && profile.configDir !== null) {
      if (status?.loggedIn && status.apiKeySource === claudeConsoleLoginKeySource) removeClaudeProfileApiKey(profile.configDir);
      recorded = await readClaudeAuthStatus(profile.configDir) ?? status;
    }
    await recordProfileStatus(profile.name, recorded);
    // A sign-in is the operator acting on the account: a used-up-credits mark ends with it.
    if (recorded?.loggedIn) getState().setClaudeProfileCreditExhausted(profile.name, null);
    // A topic may already have picked the profile before its sign-in: its sleeping session resumes under it by
    // itself, and a live one is re-spawned now that the account exists.
    if (recorded?.loggedIn) await applyClaudeProfileEverywhere();
  }

  /**
   * @description An API key pasted into an API account's sign-in (the driver already deleted the message and stopped
   * the Console login): asked of the API first — a key it refuses is not stored — then kept in the profile's own
   * directory (`0600`, read by the `apiKeyHelper` of that profile's launches only), the account probed and recorded,
   * and live topics moved onto it. Returns the line to post; the key itself is never logged or echoed.
   */
  async function onClaudeProfileApiKey(_key: SessionKey, profile: ClaudeLoginProfile, apiKey: string): Promise<string> {
    if (profile.configDir === null || !checkIsKnownProfile(profile.name)) return t('account.apiKeyNoDirectory', { name: profile.name });
    const check = await verifyAnthropicApiKey(apiKey);
    if (check === 'invalid') return t('account.apiKeyRejected', { name: profile.name });
    try {
      createClaudeProfileLayout({ dataDir: getDataDir(), name: profile.name });
      writeClaudeProfileApiKey(profile.configDir, apiKey);
    } catch (e) {
      console.error(`[account] storing the API key of ${profile.name} failed:`, e instanceof Error ? e.message : e);
      return t('account.createFailed', { name: profile.name });
    }
    const status = await readClaudeAuthStatus(profile.configDir);
    await getState().upsertClaudeProfileRecord(profile.name, { billing: 'api' });
    await recordProfileStatus(profile.name, status);
    getState().setClaudeProfileCreditExhausted(profile.name, null);
    if (status?.loggedIn) await applyClaudeProfileEverywhere();
    console.log(`[account] ${profile.name}: an API key was stored (${check === 'valid' ? 'accepted by the API' : 'not verified'})`);
    return t(check === 'valid' ? 'account.apiKeySaved' : 'account.apiKeySavedUnverified', { name: profile.name });
  }

  function formatRow(row: AccountPickerRow): string {
    const marker = row.isActive ? '✓ ' : '• ';
    const account = row.loggedIn === false || (row.loggedIn === undefined && row.email === null && row.billing !== 'api')
      ? t('account.row.loggedOut')
      : formatAccountDetail(row);
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

  /**
   * What a signed-in account is: `ops@example.com, personal max`; billed to the API `ops@example.com, 💳 API · pay per
   * use`, or `💳 API key · pay per use` for a pasted key (no email to show).
   */
  function formatAccountDetail(row: AccountPickerRow): string {
    if (row.billing === 'api') return row.email === null ? t('account.kind.apiKey') : `${row.email}, ${t('account.kind.api')}`;
    return `${row.email ?? '?'}, ${t(`account.kind.${row.kind}`, { plan: row.subscriptionType ?? '?' })}`;
  }

  function formatRowButton(row: AccountPickerRow): string {
    const marker = row.isActive ? '✓ ' : '';
    const detail = row.loggedIn === false || (row.loggedIn === undefined && row.email === null && row.billing !== 'api')
      ? t('account.row.loggedOut')
      : row.email ?? row.name;
    return `${marker}${row.name} · ${detail}${row.billing === 'api' ? ' 💳' : ''}`;
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
        billing: defaultStatus?.billing ?? readBilling(defaultClaudeProfileName),
      },
      activeName: resolveActiveName(key, isGeneral),
      topicCounts,
    });
  }

  /** How a provider is signed in, for its row: «ChatGPT subscription» / «API key»; nothing for a kind we have no word for. */
  function formatProviderAuthKind(providerId: string): string {
    const kind = getState().getOpenCodeProviderUsage(providerId)?.authKind;
    if (kind === 'apiKey') return t('accounts.providerApiKey');
    return kind === 'subscription' && providerId === chatGptProviderId ? t('accounts.providerSubscription') : '';
  }

  /** The connected providers as text: `✓ openai — ChatGPT subscription`, its usage windows hanging under it like an account's. */
  function formatProviderList(providers: string[], rung: FallbackChainEntry | null): string {
    const nowMs = Date.now();
    return providers.map((provider) => {
      const kind = formatProviderAuthKind(provider);
      const usageLines = formatClaudeProfileUsageLines(getState().getOpenCodeProviderUsage(provider), getInstanceTimezone(), nowMs);
      return `${getRunningModelOfProvider(rung, provider) === null ? '•' : '✓'} ${provider}${kind === '' ? '' : ` — ${kind}`}${usageLines.map((line) => `\n${line}`).join('')}`;
    }).join('\n');
  }

  /** A provider's pick button in a topic: `✓ openai · gpt-5` where the topic runs, the bare provider elsewhere. */
  function formatProviderRowButton(provider: string, rung: FallbackChainEntry | null): string {
    const runningModel = getRunningModelOfProvider(rung, provider);
    return runningModel === null ? provider : `✓ ${provider} · ${runningModel}`;
  }

  /** The main screen: text + keyboard, for the topic (or General), and the provider list the keyboard indexes. */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard>; providers: string[] }> {
    const [rows, providers] = await Promise.all([buildPickerRows(key, isGeneral), readOpenCodeProviders()]);
    const list = rows.map(formatRow).join('\n');
    const run = getTopicRun(key);
    const title = isGeneral
      ? t('account.titleGeneral', { name: resolveClaudeAccountName(key, true), list })
      : t('account.title', { current: formatRunLabel(key), list });
    const openCodeSection = providers.length === 0
      ? t('accounts.openCodeNone')
      : t('accounts.openCodeSection', { list: formatProviderList(providers, isGeneral ? null : run.rung) });
    const isDefaultRemoved = getState().getClaudeProfileInfo(defaultClaudeProfileName)?.isRemoved === true;
    const removedNote = isDefaultRemoved ? `\n\n${t('accounts.defaultRemovedNote')}` : '';
    // The usage hint (which says the percentages are USED) follows the account list it explains.
    const buttonsHint = t(isGeneral ? 'accounts.buttonsHintGeneral' : 'accounts.buttonsHint');
    const text = `${title}${removedNote}\n\n${t('account.usageHint')}\n\n${openCodeSection}\n\n${buttonsHint}\n\n${t('account.autoSwitchHint')}`;
    // One row per Claude account: pick it (✓ = where the topic runs), sign it in again, remove it (`default` too: signs it out).
    const keyboardRows = rows.map((row) => [
      Markup.button.callback(formatRowButton(row), buildAccountUseCallback(row.name)),
      Markup.button.callback('🔑', buildAccountLoginCallback(row.name)),
      Markup.button.callback('🗑', buildAccountRemoveCallback(row.name)),
    ]);
    // A provider row mirrors it. In a topic its caption is the pick (the model page follows), 🔑 connects it again and
    // 🔌 disconnects it; in General a provider can only be connected or disconnected: «🔌 Disconnect X» and 🔑.
    providers.forEach((provider, index) => {
      keyboardRows.push(isGeneral
        ? [
          Markup.button.callback(t('accounts.disconnectButton', { provider }), buildAccountDisconnectCallback(index)),
          Markup.button.callback('🔑', buildAccountReconnectCallback(index)),
        ]
        : [
          Markup.button.callback(formatProviderRowButton(provider, run.rung), buildAccountOpenCodeUseCallback(index)),
          Markup.button.callback('🔑', buildAccountReconnectCallback(index)),
          Markup.button.callback('🔌', buildAccountDisconnectCallback(index)),
        ]);
    });
    keyboardRows.push([
      Markup.button.callback(t('accounts.addClaudeButton'), accountAddCallback),
      Markup.button.callback(t('accounts.addProviderButton'), accountAddProviderCallback),
    ]);
    keyboardRows.push([Markup.button.callback(t('accounts.addClaudeApiButton'), accountAddApiCallback)]);
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
   * a switch to Claude (`switchTopicByOperator`, which also makes the limit move while a usage-limit wait is armed): the answer
   * is then the question already posted (`null`: nothing to say) or the line that the topic switched.
   */
  async function applyPick(key: SessionKey, isGeneral: boolean, name: string): Promise<string | null> {
    if (!checkIsKnownProfile(name)) return t('account.unknown', { name });
    if (name !== defaultClaudeProfileName) {
      const status = await readClaudeAuthStatus(resolveDir(name));
      await recordProfileStatus(name, status);
      if (status !== null && !status.loggedIn) return t('account.notLoggedIn', { name });
    }
    // An account billed to the API says so whenever it is picked: from now on that topic (or every topic following General) costs money per request.
    const meteredNote = readBilling(name) === 'api' ? `\n${t(isGeneral ? 'account.pickedApiGeneral' : 'account.pickedApi')}` : '';
    if (isGeneral) {
      // The operator's pick is the act that ends a used-up-credits mark (in a topic the switch path clears it).
      getState().setClaudeProfileCreditExhausted(name, null);
      await getState().setClaudeProfileGlobalDefault(name);
      await applyClaudeProfileEverywhere();
      return `${t('account.setGlobal', { name })}${meteredNote}`;
    }
    const outcome = await switchTopicByOperator(key, { backend: 'claude', profile: name, model: null });
    if (outcome.kind === 'asked') return null;
    return outcome.kind === 'switched' ? `${outcome.text}${meteredNote}` : outcome.text;
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
   * then the relay posts the link. An API account (`billing: 'api'`) is recorded as such and signs in to the Claude
   * Console (`--console`), or takes a pasted API key. Returns the message to post BEFORE the link, or the refusal.
   */
  async function addProfile(key: SessionKey, rawName: string, billing: ClaudeProfileBilling = 'subscription'): Promise<string> {
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
    await getState().upsertClaudeProfileRecord(name, { createdAt: new Date().toISOString(), loggedIn: false, ...(billing === 'api' ? { billing } : {}) });
    await replyToThread(key, t(billing === 'api' ? 'account.createdApi' : 'account.created', { name }));
    await startClaudeProfileLogin(key, { name, configDir, ...(billing === 'api' ? { billing } : {}) });
    return '';
  }

  /** Sign a known profile in (again); `default` is the plain `~/.claude` login. */
  async function loginProfile(key: SessionKey, name: string): Promise<string> {
    if (!checkIsKnownProfile(name)) return t('account.unknown', { name });
    if (name !== defaultClaudeProfileName) {
      // The directory may be gone (a hand-cleaned DATA_DIR): recreate the layout so the login has a home.
      createClaudeProfileLayout({ dataDir: getDataDir(), name });
    }
    // An API account signs in to the Claude Console again (or takes a pasted key), never the subscription.
    const billing = readBilling(name);
    await startClaudeProfileLogin(key, { name, configDir: resolveDir(name), ...(billing === 'api' ? { billing } : {}) });
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

  /**
   * The captured answer of «➕»: a Claude profile name (a subscription or an API account), or an OpenCode provider id,
   * by what was asked. An API key pasted where the name was asked is a secret: deleted at once (`messageId`), never
   * echoed, and the name is asked again — the key belongs to the sign-in that follows.
   */
  async function submitProfileName(key: SessionKey, text: string, messageId?: number): Promise<void> {
    const asked = awaitingProfileName.get(keyToString(key));
    if (asked === 'providerId') {
      await submitProviderId(key, text);
      return;
    }
    if (checkIsAnthropicSecretLike(text)) {
      if (messageId !== undefined) await deleteThreadMessage(key, messageId);
      await replyToThread(key, `${t('account.apiKeyAsName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
      return;
    }
    const name = normaliseClaudeProfileName(text);
    if (!checkIsValidClaudeProfileName(name)) {
      await replyToThread(key, `${t('account.invalidName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
      return;
    }
    awaitingProfileName.delete(keyToString(key));
    const message = await addProfile(key, name, asked === 'claudeApiName' ? 'api' : 'subscription');
    if (message) await replyToThread(key, message);
  }

  // ── a provider as a pick: its model page ──

  /** The provider's model page in the screen's message (the shared page builder), and the snapshot its buttons index. */
  async function showProviderModelPage(key: SessionKey, messageId: number, providerId: string, models: string[], page: number): Promise<void> {
    const shown = buildOpenCodeProviderPage({
      providerId,
      models,
      page,
      rung: getTopicRun(key).rung,
      limits: getState().getOpenCodeModelLimits(),
      timezone: getInstanceTimezone(),
      nowMs: Date.now(),
      callbacks: {
        buildPage: buildAccountOpenCodePageCallback,
        buildPick: buildAccountOpenCodeModelCallback,
        noop: modelPickerNoopCallback,
        back: { label: t('fallback.backButton'), data: accountBackCallback },
      },
    });
    rememberBoundedSnapshot(pageSnapshots, buildMessageSnapshotKey(key, messageId), { providerId, models }, providerSnapshotLimit);
    await editThreadMessage(key, messageId, shown.text, shown.keyboard);
  }

  /** What the shared provider-pick handlers need from this screen: the switch path, the toast and the way back to the screen. */
  function buildPickDeps(ctx: Context, key: SessionKey, messageId: number, isGeneral: boolean) {
    return { ctx, key, switchTopicByOperator, answerWholeText: answerWithWholeText, rerender: () => rerenderPicker(key, messageId, isGeneral) };
  }

  /** `/accounts use <provider>/<model>`: the model a topic runs, through the same path as a tap; never in General. */
  async function applyTypedOpenCodePick(key: SessionKey, isGeneral: boolean, label: string): Promise<void> {
    const parsed = parseOpenCodeModelLabel(label);
    if (parsed === null) { await replyToThread(key, t('account.usage')); return; }
    if (isGeneral) { await replyToThread(key, t('limits.openCodeInTopicOnly')); return; }
    if (getState().getBinding(key) === null) { await replyToThread(key, t('thread.bind_required')); return; }
    const outcome = await switchTopicByOperator(key, { backend: 'opencode', providerId: parsed.providerId, modelId: parsed.modelId });
    if (outcome.kind !== 'asked') await replyToThread(key, outcome.text);
  }

  // ── the command ──

  function registerClaudeAccountCommands(): void {
    // `/accounts` (hidden alias `/account`) — bare: the screen. `add <name>` creates a profile and signs it in (`add <name> api`:
    // an account billed to a Claude Console organization's API balance); `use <name>` switches
    // this topic (General: the instance default); `login <name>` signs a profile in again; `remove <name>`
    // deletes one. Not gated on a session: the pick is read at the next spawn, so it must be settable first.
    command(['account', 'accounts'], async (_ctx, key, parsed: InboundCommand) => {
      const isGeneral = checkIsGeneral(key);
      const [verb = '', ...rest] = parsed.args;
      const name = normaliseClaudeProfileName(rest.join(' '));
      // `add <name> api`: the last word names the billing; the name is what precedes it.
      const isApiAdd = verb.toLowerCase() === 'add' && rest.length >= 2 && rest.at(-1)?.toLowerCase() === 'api';
      switch (verb.toLowerCase()) {
        case '': {
          await postPicker(key, isGeneral);
          return;
        }
        case 'add': {
          if (!name || name === 'api') {
            const asked = name === 'api' ? 'claudeApiName' : 'claudeName';
            awaitingProfileName.set(keyToString(key), asked);
            await replyToThread(key, `${t(asked === 'claudeApiName' ? 'account.askNameApi' : 'account.askName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
            return;
          }
          const message = isApiAdd
            ? await addProfile(key, normaliseClaudeProfileName(rest.slice(0, -1).join(' ')), 'api')
            : await addProfile(key, name);
          if (message) await replyToThread(key, message);
          return;
        }
        case 'use': {
          if (!name) { await replyToThread(key, t('account.usage')); return; }
          if (name.includes('/')) { await applyTypedOpenCodePick(key, isGeneral, rest.join(' ').trim()); return; }
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
      if (name === null) { await answerCallbackQuerySafely(ctx); return; }
      const confirmation = await applyPick(key, isGeneral, name);
      if (confirmation === null) await answerCallbackQuerySafely(ctx);
      else await answerWithWholeText(ctx, key, confirmation);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountFollowDefaultCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (isGeneral) { await answerCallbackQuerySafely(ctx); return; }
      await answerWithWholeText(ctx, key, await applyFollowDefault(key));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountAddCallback, (ctx) => handleTap(ctx, async (key) => {
      awaitingProfileName.set(keyToString(key), 'claudeName');
      await answerCallbackQuerySafely(ctx);
      await replyToThread(key, `${t('account.askName', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
    }));

    bot.action(accountAddApiCallback, (ctx) => handleTap(ctx, async (key) => {
      awaitingProfileName.set(keyToString(key), 'claudeApiName');
      await answerCallbackQuerySafely(ctx);
      await replyToThread(key, `${t('account.askNameApi', { max: claudeProfileNameMaxLength })}\n${t('login.esc_hint')}`);
    }));

    bot.action(accountAddProviderCallback, (ctx) => handleTap(ctx, async (key) => {
      awaitingProfileName.set(keyToString(key), 'providerId');
      await answerCallbackQuerySafely(ctx);
      await replyToThread(key, `${t('accounts.askProvider')}\n${t('login.esc_hint')}`);
    }));

    // A provider's «🔌» row → ask first (a disconnect drops stored credentials), against the snapshot of the
    // message the button sits on: an older screen can never map its index onto a newer list.
    bot.action(accountDisconnectCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await answerCallbackQuerySafely(ctx);
      await editThreadMessage(key, messageId, t('accounts.confirmDisconnect', { provider }), Markup.inlineKeyboard([
        [Markup.button.callback(t('accounts.confirmDisconnectButton', { provider }), buildAccountDisconnectConfirmCallback(Number(ctx.match[1])))],
        [Markup.button.callback(t('account.backButton'), accountBackCallback)],
      ]));
    }));

    bot.action(accountDisconnectConfirmCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await answerCallbackQuerySafely(ctx);
      await disconnectOpenCodeProvider(key, provider);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    // A provider's «🔑» → connect it again (the method picker); the screen is re-rendered first.
    bot.action(accountReconnectCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      if (messageId === null || provider === undefined) {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await answerCallbackQuerySafely(ctx);
      await startOpenCodeConnect(key, provider);
    }));

    // A provider row in a topic → its model page (a provider with one model is picked at once, unless the topic runs on it);
    // resolved against the snapshot of the message the button sits on, like the disconnect buttons.
    bot.action(accountOpenCodeUseCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const provider = messageId === null ? undefined : providerSnapshots.get(buildMessageSnapshotKey(key, messageId))?.[Number(ctx.match[1])];
      const answerStale = async (): Promise<void> => {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
      };
      if (messageId === null || provider === undefined) { await answerStale(); return; }
      if (isGeneral) { await answerCallbackQuerySafely(ctx, t('limits.openCodeInTopicOnly')); return; }
      if (getState().getBinding(key) === null) { await answerWithWholeText(ctx, key, t('thread.bind_required')); return; }
      const models = listOpenCodeModelsOfProvider(await listOpenCodeModels(), provider);
      await handleProviderTap({
        ...buildPickDeps(ctx, key, messageId, isGeneral),
        providerId: provider,
        models,
        rung: getTopicRun(key).rung,
        showPage: () => showProviderModelPage(key, messageId, provider, models, 0),
        answerStale,
      });
    }));

    bot.action(accountOpenCodePageCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const page = messageId === null ? undefined : pageSnapshots.get(buildMessageSnapshotKey(key, messageId));
      if (messageId === null || page === undefined) {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await answerCallbackQuerySafely(ctx);
      await showProviderModelPage(key, messageId, page.providerId, page.models, Number(ctx.match[1]));
    }));

    // A model on the open page: the switch. A refusal stays on the page; anything else returns to the screen, its ✓ moved.
    bot.action(accountOpenCodeModelCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const page = messageId === null ? undefined : pageSnapshots.get(buildMessageSnapshotKey(key, messageId));
      const modelId = page?.models[Number(ctx.match[1])];
      if (messageId === null || page === undefined || modelId === undefined) {
        await answerCallbackQuerySafely(ctx, t('accounts.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await handleModelPick(buildPickDeps(ctx, key, messageId, isGeneral), { backend: 'opencode', providerId: page.providerId, modelId });
    }));

    bot.action(accountLoginMenuCallback, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await answerCallbackQuerySafely(ctx);
      if (messageId !== null) await editThreadMessage(key, messageId, t('account.pickLogin'), buildProfileChoiceKeyboard(buildAccountLoginCallback, true));
    }));

    bot.action(accountRemoveMenuCallback, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await answerCallbackQuerySafely(ctx);
      if (Object.keys(getState().getClaudeProfileRecords()).length === 0) {
        await replyToThread(key, t('account.nothingToRemove'));
        return;
      }
      if (messageId !== null) await editThreadMessage(key, messageId, t('account.pickRemove'), buildProfileChoiceKeyboard(buildAccountRemoveCallback, false));
    }));

    bot.action(accountBackCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await answerCallbackQuerySafely(ctx);
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(accountLoginCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountLoginCallbackRe, { allowDefault: true });
      if (name === null) { await answerCallbackQuerySafely(ctx); return; }
      await answerCallbackQuerySafely(ctx);
      await rerenderPicker(key, messageId, isGeneral); // the sub-picker is consumed back into the main picker
      const message = await loginProfile(key, name);
      if (message) await replyToThread(key, message);
    }));

    bot.action(accountRemoveCallbackRe, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountRemoveCallbackRe, { allowDefault: true });
      if (name === null || !checkIsKnownProfile(name)) { await answerCallbackQuerySafely(ctx, t('account.unknown', { name: name ?? '?' })); return; }
      await answerCallbackQuerySafely(ctx);
      const confirmation = buildRemoveConfirmation(name);
      if (messageId !== null) await editThreadMessage(key, messageId, confirmation.text, confirmation.keyboard);
    }));

    bot.action(accountRemoveConfirmCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const name = parseAccountCallbackName(ctx.match[0], accountRemoveConfirmCallbackRe, { allowDefault: true });
      if (name === null) { await answerCallbackQuerySafely(ctx); return; }
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
    pickClaudeAccount: applyPick,
    onClaudeProfileAuthStatus,
    onClaudeProfileApiKey,
  };
}
