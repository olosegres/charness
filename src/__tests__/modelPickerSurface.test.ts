/**
 * Test case: N/A — TelegramCode has no Jira tracker
 *
 * @description The `bot.ts` half of the `/model` picker and `/disconnect`
 * wiring — the parts that are decisions, not Telegram I/O.
 *
 * Three confirmed regressions are pinned here:
 *   • a BUTTON model pick left `awaitingModelSelection` armed forever, so a
 *     later ordinary "3" prompt was swallowed as a model pick and never
 *     reached the agent — and the re-rendered text kept numbers nothing
 *     responds to;
 *   • `/disconnect` resolved its adapter from the THREAD while `/connect`
 *     hardcodes the OpenCode adapter, so a Claude topic could connect a
 *     provider but not disconnect it;
 *   • `/disconnect` was missing from Telegram's `/` autocomplete menu.
 *
 * `./modelPickerSurface.testSetup` is imported FIRST so `bot.ts`'s boot-time
 * `parseEnv()` finds a token + a valid `WORK_ROOT` before the module evaluates.
 */
import './modelPickerSurface.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS_MENU,
  applyModelPagePickArming,
  buildModelPageRender,
  buildModelProviderRender,
  checkIsNumberedModelPickArmed,
  getNumberedModelPick,
  getProviderAuthAdapter,
} from '../bot';
import {
  buildModelCatalog,
  checkIsCallbackDataWithinLimit,
  type ModelCatalog,
} from '../utils/modelPickerPlan';
import { TELEGRAM_HARD_LIMIT } from '../messageSplit';
import { getAdapter } from '../adapters/createAdapter';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const key: SessionKey = makeTelegramKey(-1001111111111, 111);
const openCodeAdapterLabel = 'OpenCode';

/** A two-provider catalog with enough models to paginate (page size is 10). */
function createPagedCatalog(): ModelCatalog {
  const models = [
    ...Array.from({ length: 14 }, (_, i) => `openrouter/vendor/model-${i}`),
    'anthropic/claude-opus-4-8',
  ];
  return buildModelCatalog(models, openCodeAdapterLabel, []);
}

function getPageModelLines(text: string): string[] {
  return text.split('\n').filter((line) => /^\d+\. /.test(line));
}

describe('/model page render — numbered list is opt-in', () => {
  it('with the numbered list: text carries numbers and the page is arm-eligible', () => {
    const catalog = createPagedCatalog();
    const render = buildModelPageRender(catalog, 0, 0, 'openrouter/vendor/model-3', {
      isWithNumberedList: true,
    });
    assert.ok(render);
    assert.equal(render.isNumberedPickArmed, true);
    assert.equal(getPageModelLines(render.text).length, 10, 'a full page of numbered entries');
    assert.equal(render.pageModels.length, 10);
  });

  it('without the numbered list: NO numbers survive in the text', () => {
    // Load-bearing: this is the render used after a BUTTON pick, where the
    // bare-digit affordance is disarmed. Printing numbers that silently do
    // nothing is worse than printing none.
    const catalog = createPagedCatalog();
    const render = buildModelPageRender(catalog, 0, 0, 'openrouter/vendor/model-3', {
      isWithNumberedList: false,
    });
    assert.ok(render);
    assert.equal(render.isNumberedPickArmed, false);
    assert.deepEqual(getPageModelLines(render.text), []);
    // The header and a hint still render — the message is not left empty.
    assert.ok(render.text.includes('openrouter'));
    assert.ok(render.text.trim().length > 0);
  });

  it('the ✓ marker follows the CURRENT model', () => {
    const catalog = createPagedCatalog();
    const before = buildModelPageRender(catalog, 0, 0, 'openrouter/vendor/model-1', {
      isWithNumberedList: false,
    });
    const after = buildModelPageRender(catalog, 0, 0, 'openrouter/vendor/model-4', {
      isWithNumberedList: false,
    });
    assert.ok(before && after);
    const getCheckedLabel = (render: NonNullable<typeof before>): string | undefined =>
      render.keyboard.reply_markup.inline_keyboard
        .flat()
        .map((button) => ('text' in button ? button.text : ''))
        .find((label) => label.endsWith(' ✓'));
    assert.equal(getCheckedLabel(before), 'vendor/model-1 ✓');
    assert.equal(getCheckedLabel(after), 'vendor/model-4 ✓', 'the tick moves with the pick');
  });

  it('a page beyond the end clamps instead of rendering an empty body', () => {
    const catalog = createPagedCatalog();
    const render = buildModelPageRender(catalog, 0, 99, 'x', { isWithNumberedList: true });
    assert.ok(render);
    assert.equal(render.pageModels.length, 4, 'the last page of 14 models');
  });

  it('an unknown provider index renders nothing', () => {
    const catalog = createPagedCatalog();
    assert.equal(
      buildModelPageRender(catalog, 99, 0, 'x', { isWithNumberedList: true }),
      null,
    );
  });
});

describe('bare-digit arming follows the rendered text', () => {
  it('a numbered page arms it; the post-pick re-render DISARMS it', () => {
    // THE regression: after tapping a model button the thread stayed armed, so
    // a later ordinary "3" prompt was eaten as a model pick.
    const catalog = createPagedCatalog();
    const numbered = buildModelPageRender(catalog, 0, 0, 'x', { isWithNumberedList: true });
    const afterPick = buildModelPageRender(catalog, 0, 0, 'openrouter/vendor/model-2', {
      isWithNumberedList: false,
    });
    assert.ok(numbered && afterPick);

    applyModelPagePickArming(key, numbered);
    assert.equal(checkIsNumberedModelPickArmed(key), true);

    applyModelPagePickArming(key, afterPick);
    assert.equal(
      checkIsNumberedModelPickArmed(key),
      false,
      'a page rendered without numbers must never leave the thread armed',
    );
  });

  it('a numbered pick CONSUMES the affordance — both entry points, valid or not', () => {
    // `/model <n>` used to resolve against the page WITHOUT disarming, so the
    // thread stayed armed and a later ordinary "3" prompt was swallowed as
    // another model pick instead of reaching the agent — the same defect the
    // button-pick path already disarms for. One resolver now serves `/model <n>`
    // and the plain "3" reply, so the two can no longer drift.
    const catalog = createPagedCatalog();
    const page = buildModelPageRender(catalog, 0, 0, 'x', { isWithNumberedList: true });
    assert.ok(page);

    applyModelPagePickArming(key, page);
    assert.equal(getNumberedModelPick(key, 3), page.pageModels[2], 'resolves within the page');
    assert.equal(
      checkIsNumberedModelPickArmed(key),
      false,
      'a valid pick must leave the thread disarmed',
    );

    // An out-of-range number resolves to nothing AND still disarms, so a
    // mistyped "99" cannot leave the thread eating later digits.
    applyModelPagePickArming(key, page);
    assert.equal(getNumberedModelPick(key, 99), null);
    assert.equal(getNumberedModelPick(key, 0), null, '1-based: 0 addresses nothing');
    assert.equal(checkIsNumberedModelPickArmed(key), false);
  });

  it('a numbered pick resolves against the CURRENT page, not the whole catalog', () => {
    // The page list is what the user is looking at: "1" on page 2 must be the
    // 11th model, never the 1st.
    const catalog = createPagedCatalog();
    const secondPage = buildModelPageRender(catalog, 0, 1, 'x', { isWithNumberedList: true });
    assert.ok(secondPage);
    applyModelPagePickArming(key, secondPage);
    assert.equal(getNumberedModelPick(key, 1), 'openrouter/vendor/model-10');
  });

  it('a render with no models on the page never arms', () => {
    const empty = buildModelCatalog([], openCodeAdapterLabel, []);
    applyModelPagePickArming(key, {
      text: '',
      keyboard: { reply_markup: { inline_keyboard: [] } },
      pageModels: [],
      isNumberedPickArmed: true,
    });
    assert.equal(checkIsNumberedModelPickArmed(key), false);
    assert.deepEqual(empty.providers, []);
  });
});

/**
 * The live catalog that broke `/model`: `openrouter` alone ships 367 models,
 * with ids long enough that rendering them all produced a 12 990-char message
 * and `sendMessage` answered `400 … message is too long`.
 */
function createProductionSizedCatalog(hiddenProviders: string[] = []): ModelCatalog {
  const models = [
    ...Array.from(
      { length: 367 },
      (_, i) => `openrouter/some-vendor-name/a-fairly-long-model-identifier-${i}:free`,
    ),
    ...Array.from({ length: 16 }, (_, i) => `anthropic/claude-some-model-name-${i}`),
    ...Array.from({ length: 15 }, (_, i) => `openai/gpt-some-model-name-${i}`),
    ...Array.from({ length: 7 }, (_, i) => `opencode/hosted-model-${i}`),
  ];
  return buildModelCatalog(models, openCodeAdapterLabel, hiddenProviders);
}

function getCallbackData(render: { keyboard: { reply_markup: { inline_keyboard: unknown[][] } } }): string[] {
  return render.keyboard.reply_markup.inline_keyboard
    .flat()
    .map((button) => (button && typeof button === 'object' && 'callback_data' in button
      ? String((button as { callback_data: unknown }).callback_data)
      : ''));
}

describe('no render path can outgrow Telegram\'s message cap', () => {
  // THE bug this whole picker exists to fix. Every assertion here is against a
  // catalog the size of the operator's real one — if any path ever starts
  // scaling with the catalog again, `sendMessage` returns "message is too long"
  // and the topic goes silent, exactly as it did in production.
  const longCurrentModel = 'openrouter/some-vendor-name/a-fairly-long-model-identifier-42:free';

  it('the fixture really is big enough to reproduce the failure', () => {
    // Guard the guard: rendering this catalog the OLD way (every id in one
    // message) must blow the cap, otherwise the cases below prove nothing.
    const catalog = createProductionSizedCatalog();
    const everyModelInOneMessage = [...catalog.byProvider.values()].flat().join('\n');
    assert.ok(
      everyModelInOneMessage.length > TELEGRAM_HARD_LIMIT,
      `fixture renders to ${everyModelInOneMessage.length} chars — too small to reproduce the bug`,
    );
  });

  it('the provider level stays short no matter how many models exist', () => {
    const big = buildModelProviderRender(createProductionSizedCatalog(), longCurrentModel);
    const small = buildModelProviderRender(
      buildModelCatalog(['anthropic/a', 'openai/b', 'openrouter/c', 'opencode/d'], openCodeAdapterLabel, []),
      longCurrentModel,
    );
    assert.ok(big.text.length < TELEGRAM_HARD_LIMIT, `${big.text.length} chars`);
    assert.equal(
      big.text.length,
      small.text.length,
      'the provider-level TEXT must not grow with the model count at all',
    );
  });

  it('EVERY page of the 367-model provider fits, and each holds one page of models', () => {
    const catalog = createProductionSizedCatalog();
    const providerIndex = catalog.providers.indexOf('openrouter');
    const first = buildModelPageRender(catalog, providerIndex, 0, longCurrentModel, {
      isWithNumberedList: true,
    });
    assert.ok(first);
    const pageSize = first.pageModels.length;
    assert.ok(pageSize > 0 && pageSize < 367, 'a page is a SLICE, not the whole provider');

    const totalPages = Math.ceil(367 / pageSize);
    for (let page = 0; page < totalPages; page += 1) {
      const render = buildModelPageRender(catalog, providerIndex, page, longCurrentModel, {
        isWithNumberedList: true,
      });
      assert.ok(render, `page ${page} must render`);
      assert.ok(
        render.text.length < TELEGRAM_HARD_LIMIT,
        `page ${page} text is ${render.text.length} chars`,
      );
      assert.ok(render.pageModels.length <= pageSize, `page ${page} over-filled`);
      // Keyboard rows: one per model plus at most the nav row and the back row.
      assert.ok(
        render.keyboard.reply_markup.inline_keyboard.length <= pageSize + 2,
        `page ${page} keyboard has ${render.keyboard.reply_markup.inline_keyboard.length} rows`,
      );
    }
  });

  it('the post-pick re-render and the all-hidden / empty states fit too', () => {
    const catalog = createProductionSizedCatalog();
    const providerIndex = catalog.providers.indexOf('openrouter');
    const afterPick = buildModelPageRender(catalog, providerIndex, 5, longCurrentModel, {
      isWithNumberedList: false,
    });
    assert.ok(afterPick);
    assert.ok(afterPick.text.length < TELEGRAM_HARD_LIMIT);

    const allHidden = buildModelProviderRender(
      createProductionSizedCatalog(['openrouter', 'anthropic', 'openai', 'opencode']),
      longCurrentModel,
    );
    assert.ok(allHidden.text.length < TELEGRAM_HARD_LIMIT);
    assert.ok(allHidden.text.trim().length > 0, 'never an empty message');

    // An empty catalog must NOT claim "everything is hidden" — there would be
    // no 👁 button to tap, leaving the user on a dead end.
    const empty = buildModelProviderRender(
      buildModelCatalog([], openCodeAdapterLabel, []),
      longCurrentModel,
    );
    assert.equal(empty.keyboard.reply_markup.inline_keyboard.length, 0);
    assert.ok(empty.text.trim().length > 0);
    assert.notEqual(empty.text, allHidden.text, 'an empty catalog is not the all-hidden state');
  });

  it('every button on every level fits Telegram\'s 64-byte callback_data cap', () => {
    // The other half of the failure: raw model ids are far too long to ride a
    // callback, which is why the picker carries indexes.
    const catalog = createProductionSizedCatalog(['opencode']);
    const renders = [buildModelProviderRender(catalog, longCurrentModel)];
    const providerIndex = catalog.providers.indexOf('openrouter');
    for (const page of [0, 36]) {
      const render = buildModelPageRender(catalog, providerIndex, page, longCurrentModel, {
        isWithNumberedList: true,
      });
      assert.ok(render);
      renders.push(render);
    }
    for (const render of renders) {
      const callbackIds = getCallbackData(render);
      assert.ok(callbackIds.length > 0);
      for (const callbackData of callbackIds) {
        assert.ok(
          callbackData.length > 0 && checkIsCallbackDataWithinLimit(callbackData),
          `"${callbackData}" is ${Buffer.byteLength(callbackData)} bytes`,
        );
      }
    }
  });
});

describe('/disconnect adapter resolution', () => {
  it('targets the OpenCode adapter, exactly like /connect does', () => {
    // `/connect` hardcodes `getAdapter('opencode')`; resolving `/disconnect`
    // from the THREAD instead made it answer "not supported" on a Claude topic
    // that had just connected a provider successfully.
    const adapter = getProviderAuthAdapter();
    assert.equal(adapter, getAdapter('opencode'), 'same instance /connect uses');
    assert.equal(adapter.name, 'opencode');
  });

  it('that adapter implements BOTH halves of the provider-auth pair', () => {
    const adapter = getProviderAuthAdapter();
    assert.equal(typeof adapter.connectProvider, 'function');
    assert.equal(typeof adapter.disconnectProvider, 'function');
  });

  it('the Claude backends do NOT implement disconnect (so the thread adapter is the wrong source)', () => {
    for (const backendName of ['claude', 'claude-json-stream']) {
      assert.equal(
        getAdapter(backendName).disconnectProvider,
        undefined,
        `${backendName} must not claim provider auth`,
      );
    }
  });
});

describe('Telegram command menu', () => {
  it('lists /disconnect right after /connect', () => {
    const commands = COMMANDS_MENU.map((entry) => entry.command);
    const connectIndex = commands.indexOf('connect');
    assert.ok(connectIndex >= 0, '/connect must be in the menu');
    assert.equal(commands[connectIndex + 1], 'disconnect');
  });

  it('every menu entry carries a non-empty description', () => {
    const disconnectEntry = COMMANDS_MENU.find((entry) => entry.command === 'disconnect');
    assert.ok(disconnectEntry);
    assert.ok(disconnectEntry.description.trim().length > 0);
  });
});
