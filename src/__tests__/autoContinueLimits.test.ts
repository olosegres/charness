/**
 * @description The auto-resume switch (`connectors/telegram/commands/autoContinueLimits.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends) and recording stand-ins for the armed usage-limit wait. Pinned:
 *
 *   • WIRING — the command and the two buttons it registers, in order;
 *   • the picker: Enable / Disable, a «skip once» row only while a resume is armed;
 *   • the switch for a regular topic (its own override) and for General (the instance-wide default);
 *   • turning it off drops the topic's armed resume — and stops waking its request only when one WAS armed;
 *   • a tap consumes the picker: it becomes a keyboard-less confirmation.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoContinueLimits } from '../connectors/telegram/commands/autoContinueLimits';
import type { SessionKey } from '../sessionKey';
import { buildSkipArmedRetryCallbackData } from '../utils/autoContinueOnLimit';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const armedFireAt = 1_800_000_000_000;
const waitStepMs = 25;
const waitTimeoutMs = 10_000;

let harness: CommandHarness;
let autoContinueLimits: ReturnType<typeof createAutoContinueLimits>;
let isGeneralTopic = false;
let armedFireAtForTopic: number | null = null;
const cancelledRetryKeys: SessionKey[] = [];
const stoppedLimitWaitKeys: SessionKey[] = [];

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

describe('autoContinueLimits: the auto-resume switch over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    autoContinueLimits = createAutoContinueLimits({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      getArmedLimitRetryFireAt: () => armedFireAtForTopic,
      cancelApiRetry: (key) => {
        cancelledRetryKeys.push(key);
        armedFireAtForTopic = null;
      },
      getRequestWakeUpEngine: () => ({
        stopWakingForLimitWait: async (key) => {
          stoppedLimitWaitKeys.push(key);
        },
      }),
    });
    autoContinueLimits.registerAutoContinueLimitsCommands();
    autoContinueLimits.registerAutoContinueLimitsCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /auto_continue_limits and its two buttons, in the order the bot has always had', () => {
    assert.deepEqual(harness.registeredCommandNames, ['auto_continue_limits']);
    assert.deepEqual(harness.registeredActionPatterns, ['acl_on', 'acl_off']);
  });

  it('the bare command offers Enable / Disable with ✓ on the current value, and no «skip once» without an armed resume', async () => {
    await harness.runCommand('auto_continue_limits');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /: ON/);
    assert.deepEqual(harness.getKeyboardData(picker), [['acl_on', 'acl_off']]);
  });

  it('while a resume is armed the picker adds its «skip once» row', async () => {
    armedFireAtForTopic = armedFireAt;
    await harness.runCommand('auto_continue_limits');
    assert.deepEqual(harness.getKeyboardData(harness.replies.at(-1)), [['acl_on', 'acl_off'], [buildSkipArmedRetryCallbackData(armedFireAt)]]);
  });

  it('«off» in a regular topic sets that topic\'s override, drops its armed resume and stops waking its request', async () => {
    await harness.runCommand('auto_continue_limits', 'off');
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), false);
    assert.deepEqual(cancelledRetryKeys, [harness.key]);
    assert.deepEqual(stoppedLimitWaitKeys, [harness.key], 'the wait was armed: its request must not be woken into the same limit');
    assert.match(harness.replies.at(-1)?.text ?? '', /OFF/);
  });

  it('«off» with no resume armed cancels nothing the request side needs to hear about', async () => {
    await harness.runCommand('auto_continue_limits', 'on');
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), true);
    stoppedLimitWaitKeys.length = 0;
    await harness.runCommand('auto_continue_limits', 'off');
    assert.deepEqual(stoppedLimitWaitKeys, [], 'nothing was armed, nothing to stop');
  });

  it('in General the switch is the instance-wide default and leaves the topics\' own overrides alone', async () => {
    isGeneralTopic = true;
    await harness.runCommand('auto_continue_limits', 'on');
    assert.equal(harness.state.getAutoContinueOnLimitGlobalDefault(), true);
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), false, 'the topic override wins over the default');
    await harness.runCommand('auto_continue_limits', 'off');
    assert.equal(harness.state.getAutoContinueOnLimitGlobalDefault(), false);
    assert.match(harness.replies.at(-1)?.text ?? '', /all topics|instance/i);
  });

  it('a tap applies the setting, answers and consumes the picker into a keyboard-less confirmation', async () => {
    isGeneralTopic = false;
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker');
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(picker, 'acl_on');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1, 'the tap was answered');
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), true);
    await waitUntil('the picker to become its confirmation', () => (harness.fakeTelegram.getMessage(picker)?.text ?? '').includes('ON'));
    assert.match(harness.fakeTelegram.getMessage(picker)?.text ?? '', /Auto-resume after a usage limit: ON for this topic/);
  });

  it('consuming a picker with no message to rewrite is a no-op', async () => {
    const editsBefore = harness.fakeTelegram.listCalls('editMessageText').length;
    await autoContinueLimits.consumeAutoContinueLimitsPicker(harness.key, undefined, 'text');
    assert.equal(harness.fakeTelegram.listCalls('editMessageText').length, editsBefore);
  });
});
