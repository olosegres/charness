/**
 * @description What the update flows do in General, shared: open the `/update` screen and keep it as the message the next taps use,
 * «Check now» and the wait for the screen to read what it should, wait for a message that comes after an install and a restart, and
 * follow the bot through a restart IN PLACE (one more boot, a new poll — and still the process the test started).
 */
import assert from 'node:assert/strict';
import type { FakeTelegram, FakeTelegramMessage } from '../telegramE2e/fakeTelegram';
import type { TopicDriver } from '../telegramE2e/topicDriver';
import type { IsolatedCharness } from './isolatedCharness';

/** The line the bot prints right before it starts polling: once per boot. */
export const launchLine = 'Launching Telegraf bot (long polling';

export class UpdateFlowDriver {
  /** The `/update` message the flow taps on. */
  screen: FakeTelegramMessage | null = null;

  constructor(
    private readonly fakeTelegram: FakeTelegram,
    private readonly getCharness: () => IsolatedCharness,
    private readonly general: TopicDriver,
  ) {}

  countBoots(): number {
    return this.getCharness().output.split(launchLine).length - 1;
  }

  getScreen(): FakeTelegramMessage {
    if (!this.screen) throw new Error('no /update screen is open yet');
    return this.screen;
  }

  /** @description The bot's process replaced itself: one more boot and a new poll — resolves when both happened. */
  async waitForRestartInPlace(description: string, timeoutMs: number): Promise<void> {
    const bootsBefore = this.countBoots();
    const pollsBefore = this.fakeTelegram.listCalls('getUpdates').length;
    await this.getCharness().waitFor(description, timeoutMs, () => this.countBoots() > bootsBefore && this.fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  }

  /** @description Open `/update` in General as a NEW message (it must contain `expectedText`) and keep it as the screen. */
  async openScreen(expectedText: string): Promise<FakeTelegramMessage> {
    this.screen = await this.general.sendAndAwaitReply('/update', expectedText);
    return this.screen;
  }

  /** @description «Check now» on the screen, then wait for the screen to read `expectedText`. */
  async checkNow(expectedText: string): Promise<void> {
    const screen = this.getScreen();
    const answer = await this.general.tapAndAwaitAnswer(screen, 'upd_check');
    assert.equal(answer, 'Checking…');
    await this.general.waitForMessageText(`the screen to read "${expectedText}"`, screen, (text) => text.includes(expectedText));
  }

  /** @description A tap on the screen's button `callbackData`; resolves its toast. */
  async tap(callbackData: string): Promise<string> {
    return this.general.tapAndAwaitAnswer(this.getScreen(), callbackData);
  }

  /** @description The callback data of the screen's buttons, flat. */
  getButtons(): string[] {
    return this.general.getKeyboardData(this.getScreen()).flat();
  }

  /** @description A General message that takes longer than a command's reply (it comes after an install and a restart). */
  async waitForGeneralMessage(description: string, timeoutMs: number, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
    let found: FakeTelegramMessage | undefined;
    await this.getCharness().waitFor(description, timeoutMs, () => {
      found = this.general.listMessages().find(check);
      return found !== undefined;
    });
    if (!found) throw new Error(`no message for ${description}`);
    return found;
  }

  /** @description The pid of the process the test started — the one a restart in place must keep. */
  getPid(): number {
    const pid = this.getCharness().pid;
    assert.ok(pid, 'charness has a pid');
    return pid;
  }
}

