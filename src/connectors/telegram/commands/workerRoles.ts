/**
 * `/workers` (hidden alias `/worker_models`) — the bot's default CLI, model and effort for each worker role an agent launches
 * (`utils/workerRoles.ts`, `settings.json` `workerRoles`), for the whole bot from any topic or General; `/bot_skills` opens it too.
 * A REPEATED-USE screen edited in place: every tap writes the file and re-renders, the moved ✓ is the feedback. Screens:
 * the overview (a row per role), a role (Claude models, the OpenCode row, efforts or the model's variants), the OpenCode providers
 * and the shared model page (`modelPage.ts`). The screens are `utils/workerRolesScreenPlan.ts`. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import { listOpenCodeModelsOfProvider, listOpenCodeProviders, parseOpenCodeModelLabel } from '../../../utils/fallbackChain';
import { modelPickerNoopCallback } from '../../../utils/modelPickerPlan';
import { builtInWorkerRoles, resolveWorkerRole, updateWorkerRolesSetting, type WorkerRoleId, type WorkerRoleValue, type WorkerRolesSetting } from '../../../utils/workerRoles';
import {
  buildWorkerRoleModelsTitle,
  buildWorkerRoleProvidersScreen,
  buildWorkerRoleScreen,
  buildWorkerRolesCallbackData,
  buildWorkerRolesOverview,
  getValueAfterClaudeModelPick,
  getValueAfterOpenCodeModelPick,
  parseWorkerRolesCallbackData,
  workerRolesCallbackRe,
  type WorkerRolesScreen,
  type WorkerRolesTap,
} from '../../../utils/workerRolesScreenPlan';
import type { BotCore } from './botCore';
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';
import { answerCallbackQuerySafely, answerCallbackWithFittedText } from './callbackToast';
import { buildModelPageButtons } from './modelPage';

/** Screens whose OpenCode list is kept (the newest); an older keyboard's OpenCode button is refused as out of date. */
const snapshotLimit = 50;

/**
 * What a message's OpenCode buttons index into: a role's screen (its model's variants), the provider list, or a provider's models.
 * The role is in the snapshot too, so a button can only act on the role the message showed.
 */
type WorkerRolesSnapshot =
  | { kind: 'role'; role: WorkerRoleId; model: string | null; variants: string[] }
  | { kind: 'providers'; role: WorkerRoleId; providers: string[] }
  | { kind: 'models'; role: WorkerRoleId; providerId: string; models: string[] };

/** What the module needs from the bot: the shared core and what only the composition root knows. */
export interface WorkerRolesPorts extends Pick<BotCore, 'bot' | 'command' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale'> {
  /** The roles `settings.json` holds now (`{}` for none, or for a broken file — the built-in values then apply). */
  readWorkerRoles: () => WorkerRolesSetting;
  /** Write the roles into `settings.json`: `null` on success, else the errno code of the failed write. */
  saveWorkerRoles: (setting: WorkerRolesSetting) => string | null;
  /** Where `settings.json` lives, for the «could not write» toast. */
  getSettingsPath: () => string;
  /** The OpenCode catalog (`provider/model`), `[]` when none is connected or it cannot be read. */
  listOpenCodeModels: () => Promise<readonly string[]>;
  /** The variants of an OpenCode `provider/model`, `[]` for none. */
  getOpenCodeModelVariants: (model: string) => Promise<readonly string[]>;
  /** The bot-wide «Bot skills» value: off → the overview warns that agents may not ask for these values. */
  readIsBotSkillsEnabled: () => boolean;
}

/** @description Build `/workers` over its ports: the command, its buttons, and the opener `/bot_skills` calls. */
export function createWorkerRoles(ports: WorkerRolesPorts) {
  const {
    bot, command, replyToThread, editThreadMessage, authoriseContext, withThreadLocale,
    readWorkerRoles, saveWorkerRoles, getSettingsPath, listOpenCodeModels, getOpenCodeModelVariants, readIsBotSkillsEnabled,
  } = ports;

  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`). */
  const snapshots = new Map<string, WorkerRolesSnapshot>();

  function buildKeyboard(screen: WorkerRolesScreen) {
    return Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.label, button.data))));
  }

  async function buildOverview(): Promise<WorkerRolesScreen> {
    return buildWorkerRolesOverview({ setting: readWorkerRoles(), openCodeModels: await listOpenCodeModels(), isBotSkillsEnabled: readIsBotSkillsEnabled() });
  }

  /** A role's screen and the snapshot its variant buttons index into. */
  async function buildRole(role: WorkerRoleId): Promise<{ screen: WorkerRolesScreen; snapshot: WorkerRolesSnapshot }> {
    const setting = readWorkerRoles();
    const { value } = resolveWorkerRole(setting, role);
    const [openCodeModels, variants] = await Promise.all([
      listOpenCodeModels(),
      value.cli === 'opencode' ? getOpenCodeModelVariants(value.model) : Promise.resolve([]),
    ]);
    return {
      screen: buildWorkerRoleScreen({ role, setting, openCodeModels, variants }),
      snapshot: { kind: 'role', role, model: value.cli === 'opencode' ? value.model : null, variants: [...variants] },
    };
  }

  /** The screen as a fresh message in `key`'s topic, worded in its language: `/workers`, and the `/bot_skills` row. */
  async function openScreen(key: SessionKey): Promise<void> {
    await withThreadLocale(key, async () => {
      const screen = await buildOverview();
      await replyToThread(key, screen.text, buildKeyboard(screen));
    });
  }

  /** Edit the tapped message into `screen`, remembering what its OpenCode buttons index (none for the overview). */
  async function showScreen(key: SessionKey, messageId: number, screen: WorkerRolesScreen, snapshot: WorkerRolesSnapshot | null): Promise<void> {
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    if (snapshot === null) snapshots.delete(snapshotKey);
    else rememberBoundedSnapshot(snapshots, snapshotKey, snapshot, snapshotLimit);
    if (!(await editThreadMessage(key, messageId, screen.text, buildKeyboard(screen)))) console.warn('[wkr_cb] screen edit failed');
  }

  async function showOverview(key: SessionKey, messageId: number): Promise<void> {
    await showScreen(key, messageId, await buildOverview(), null);
  }

  async function showRole(key: SessionKey, messageId: number, role: WorkerRoleId): Promise<void> {
    const { screen, snapshot } = await buildRole(role);
    await showScreen(key, messageId, screen, snapshot);
  }

  /** A provider's models on the shared model page: a pick goes back to the role, «Back» to the providers. */
  async function showModelPage(key: SessionKey, messageId: number, role: WorkerRoleId, providerId: string, models: string[], page: number): Promise<void> {
    const { value } = resolveWorkerRole(readWorkerRoles(), role);
    const current = value.cli === 'opencode' ? parseOpenCodeModelLabel(value.model) : null;
    const { rows } = buildModelPageButtons({
      provider: providerId,
      models,
      page,
      current: current?.providerId === providerId ? current.modelId : null,
      callbacks: {
        buildPage: (pageIndex) => buildWorkerRolesCallbackData({ kind: 'openCodeModelPage', role, page: pageIndex }),
        buildPick: (index) => buildWorkerRolesCallbackData({ kind: 'openCodeModel', role, index }),
        noop: modelPickerNoopCallback,
        back: { label: t('workerRoles.backButton'), data: buildWorkerRolesCallbackData({ kind: 'openCodeProviders', role }) },
      },
    });
    rememberBoundedSnapshot(snapshots, buildMessageSnapshotKey(key, messageId), { kind: 'models', role, providerId, models }, snapshotLimit);
    if (!(await editThreadMessage(key, messageId, buildWorkerRoleModelsTitle(role, providerId), Markup.inlineKeyboard(rows)))) console.warn('[wkr_cb] model page edit failed');
  }

  /** Write `role`'s new value (`null` = built-in); `false` after a failed write, which the toast already said. */
  async function writeRole(ctx: Context, role: WorkerRoleId, value: WorkerRoleValue | null): Promise<boolean> {
    return writeSetting(ctx, updateWorkerRolesSetting(readWorkerRoles(), role, value));
  }

  async function writeSetting(ctx: Context, setting: WorkerRolesSetting): Promise<boolean> {
    const code = saveWorkerRoles(setting);
    if (code === null) return true;
    await answerCallbackWithFittedText(ctx, t('update.cmd.writeFailed', { path: getSettingsPath(), code }));
    return false;
  }

  /** An OpenCode button whose list this message no longer has (a restart, a newer screen): say so, act on nothing. */
  async function answerStale(ctx: Context): Promise<void> {
    await answerCallbackQuerySafely(ctx, t('workerRoles.staleScreen'));
  }

  function getSnapshot(key: SessionKey, messageId: number): WorkerRolesSnapshot | undefined {
    return snapshots.get(buildMessageSnapshotKey(key, messageId));
  }

  /** What a tap does; a write failure leaves the screen as it is (the toast said why). */
  async function runTap(ctx: Context, key: SessionKey, messageId: number, tap: WorkerRolesTap): Promise<void> {
    switch (tap.kind) {
      case 'overview':
        await answerCallbackQuerySafely(ctx);
        await showOverview(key, messageId);
        return;
      case 'allBuiltIn':
        if (!(await writeSetting(ctx, {}))) return;
        await answerCallbackQuerySafely(ctx);
        await showOverview(key, messageId);
        return;
      case 'role':
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      case 'roleBuiltIn':
        if (!(await writeRole(ctx, tap.role, null))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      case 'claudeModel': {
        const { value } = resolveWorkerRole(readWorkerRoles(), tap.role);
        if (!(await writeRole(ctx, tap.role, getValueAfterClaudeModelPick(value, builtInWorkerRoles[tap.role], tap.model)))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      }
      case 'claudeEffort': {
        const { value } = resolveWorkerRole(readWorkerRoles(), tap.role);
        // An effort button of a Claude role: on a role that runs on OpenCode by now, the keyboard is from before the change.
        if (value.cli !== 'claude') { await answerStale(ctx); return; }
        if (!(await writeRole(ctx, tap.role, { ...value, effort: tap.effort }))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      }
      case 'openCodeProviders': {
        const providers = listOpenCodeProviders(await listOpenCodeModels());
        // Nothing to pick from: say where a provider is connected instead of an empty list.
        if (providers.length === 0) { await answerCallbackQuerySafely(ctx, t('workerRoles.noOpenCodeProviders')); return; }
        await answerCallbackQuerySafely(ctx);
        await showScreen(key, messageId, buildWorkerRoleProvidersScreen(tap.role, providers), { kind: 'providers', role: tap.role, providers });
        return;
      }
      case 'openCodeProvider': {
        const snapshot = getSnapshot(key, messageId);
        const providerId = snapshot?.kind === 'providers' && snapshot.role === tap.role ? snapshot.providers[tap.index] : undefined;
        const models = providerId === undefined ? [] : listOpenCodeModelsOfProvider(await listOpenCodeModels(), providerId);
        if (providerId === undefined || models.length === 0) { await answerStale(ctx); return; }
        await answerCallbackQuerySafely(ctx);
        await showModelPage(key, messageId, tap.role, providerId, models, 0);
        return;
      }
      case 'openCodeModelPage': {
        const snapshot = getSnapshot(key, messageId);
        if (snapshot?.kind !== 'models' || snapshot.role !== tap.role) { await answerStale(ctx); return; }
        await answerCallbackQuerySafely(ctx);
        await showModelPage(key, messageId, tap.role, snapshot.providerId, snapshot.models, tap.page);
        return;
      }
      case 'openCodeModel': {
        const snapshot = getSnapshot(key, messageId);
        const modelId = snapshot?.kind === 'models' && snapshot.role === tap.role ? snapshot.models[tap.index] : undefined;
        if (snapshot?.kind !== 'models' || modelId === undefined) { await answerStale(ctx); return; }
        const model = `${snapshot.providerId}/${modelId}`;
        const { value } = resolveWorkerRole(readWorkerRoles(), tap.role);
        if (!(await writeRole(ctx, tap.role, getValueAfterOpenCodeModelPick(value, model, await getOpenCodeModelVariants(model))))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      }
      case 'openCodeNoVariant': {
        const snapshot = getSnapshot(key, messageId);
        const { value } = resolveWorkerRole(readWorkerRoles(), tap.role);
        // «Model's default» belongs to the model the message showed, like the variants beside it.
        if (value.cli !== 'opencode' || snapshot?.kind !== 'role' || snapshot.role !== tap.role || snapshot.model !== value.model) { await answerStale(ctx); return; }
        if (!(await writeRole(ctx, tap.role, { ...value, effort: null }))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      }
      case 'openCodeVariant': {
        const snapshot = getSnapshot(key, messageId);
        const { value } = resolveWorkerRole(readWorkerRoles(), tap.role);
        const variant = snapshot?.kind === 'role' && snapshot.role === tap.role ? snapshot.variants[tap.index] : undefined;
        // The variants belong to the model the message showed: a role that moved to another model since makes the keyboard stale.
        if (variant === undefined || value.cli !== 'opencode' || snapshot?.kind !== 'role' || snapshot.model !== value.model) { await answerStale(ctx); return; }
        if (!(await writeRole(ctx, tap.role, { ...value, effort: variant }))) return;
        await answerCallbackQuerySafely(ctx);
        await showRole(key, messageId, tap.role);
        return;
      }
    }
  }

  async function handleTap(ctx: Context, data: string): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const tap = parseWorkerRolesCallbackData(data);
    const messageId = getCallbackMessageId(ctx);
    await withThreadLocale(key, async () => {
      if (tap === null || messageId === null) { await answerStale(ctx); return; }
      await runTap(ctx, key, messageId, tap);
    });
  }

  function registerWorkerRolesCommands(): void {
    // `/workers` — the same bot-wide screen from any topic or General; not gated on an adapter, a session or a binding: the value
    // is read at an agent's next `claude_profiles` call.
    command(['workers', 'worker_models'], async (_ctx, key) => {
      await openScreen(key);
    });
  }

  function registerWorkerRolesCallbacks(): void {
    bot.action(workerRolesCallbackRe, (ctx) => handleTap(ctx, ctx.match[0]));
  }

  return { registerWorkerRolesCommands, registerWorkerRolesCallbacks, openScreen };
}
