/**
 * @description `requests/storedPromptRefresh.ts`: a connector's refresher brings a stored request prompt up to date at the
 * places that turn it into delivered text — the untaken prompt a wake-up or a usage-limit resume resends, and the copy
 * held through a usage-limit wait (which must not be delivered a second time next to the refreshed one).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { clearStoredPromptRefresher, refreshStoredPrompt, setStoredPromptRefresher } from '../requests/storedPromptRefresh';
import { getPromptNotTakenIn, getWakeUpMessage, joinPromptsNotTakenIn } from '../requests/requestHeader';
import { getHeldPromptsText, getTextWithHeldPrompts } from '../utils/limitHeldPrompts';
import type { OpenRequestState } from '../requests/types';

const storedText = '[Request req_1 · from: PROJ-1: you were mentioned] the note as it was';
const freshText = '[Request req_1 · from: PROJ-1: you were mentioned] the note as it is now';
const refresher = (text: string): string => (text === storedText ? freshText : text);

function createOpenRequest(id: string, prompt: string | undefined, isPromptTakenIn: boolean | undefined): OpenRequestState {
  return {
    id,
    origin: { kind: 'trackerMention', attributes: { issueKey: 'PROJ-1', triggerId: 'mention:1', requester: 'a' } },
    createdAt: 1,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    ...(prompt === undefined ? {} : { prompt }),
    ...(isPromptTakenIn === undefined ? {} : { isPromptTakenIn }),
  };
}

describe('refreshStoredPrompt', () => {
  afterEach(() => {
    clearStoredPromptRefresher(refresher);
  });

  it('is the text itself while no refresher is registered, and after it is cleared', () => {
    assert.equal(refreshStoredPrompt(storedText), storedText);
    setStoredPromptRefresher(refresher);
    assert.equal(refreshStoredPrompt(storedText), freshText);
    clearStoredPromptRefresher(refresher);
    assert.equal(refreshStoredPrompt(storedText), storedText);
  });

  it('clearing a refresher that is no longer the registered one leaves the registered one alone', () => {
    const newer = (text: string): string => `${text} (newer)`;
    setStoredPromptRefresher(refresher);
    setStoredPromptRefresher(newer);
    clearStoredPromptRefresher(refresher);
    assert.equal(refreshStoredPrompt('x'), 'x (newer)');
    clearStoredPromptRefresher(newer);
    assert.equal(refreshStoredPrompt('x'), 'x');
  });

  it('a refresher that throws leaves the stored text: a delivery never fails on it', () => {
    const warn = mock.method(console, 'warn', () => {});
    const failing = (): string => {
      throw new Error('boom');
    };
    try {
      setStoredPromptRefresher(failing);
      assert.equal(refreshStoredPrompt(storedText), storedText);
      assert.match(String(warn.mock.calls[0].arguments[0]), /kept the stored prompt: boom/);
    } finally {
      warn.mock.restore();
      clearStoredPromptRefresher(failing);
    }
  });

  it('a wake-up resend and the resume of a usage-limit wait carry the refreshed prompt; a prompt the session took in is not resent at all', () => {
    setStoredPromptRefresher(refresher);
    const untaken = createOpenRequest('req_1', storedText, false);
    assert.equal(getPromptNotTakenIn(untaken), freshText);
    assert.deepEqual(getWakeUpMessage(untaken, 'postRetry'), { reason: 'postRetry', text: freshText, isRequestPrompt: true });
    assert.equal(joinPromptsNotTakenIn([untaken, createOpenRequest('req_2', '[Request req_2] other', false)]), `${freshText}\n\n[Request req_2] other`);
    assert.equal(getPromptNotTakenIn(createOpenRequest('req_1', storedText, true)), undefined);
    assert.equal(getPromptNotTakenIn(createOpenRequest('req_1', undefined, undefined)), undefined);
  });

  it('a copy held through a usage-limit wait is delivered refreshed — and once, next to the refreshed resend of the same request', () => {
    setStoredPromptRefresher(refresher);
    assert.equal(getTextWithHeldPrompts(freshText, [{ text: storedText }]), freshText, 'the held copy of the request being resent is the same run');
    assert.equal(getTextWithHeldPrompts('the continue nudge', [{ text: storedText }]), `the continue nudge\n\n${freshText}`);
    assert.equal(getHeldPromptsText([{ text: storedText }, { text: 'a scheduled run' }]), `${freshText}\n\na scheduled run`);
  });
});
