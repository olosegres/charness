/**
 * @description `requests/storedPromptRefresh.ts`: a connector's refresher brings a stored request prompt up to date where
 * the untaken prompt is read for delivery — what a wake-up or the resume of a usage-limit wait resends.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { clearStoredPromptRefresher, refreshStoredPrompt, setStoredPromptRefresher } from '../requests/storedPromptRefresh';
import { getPromptNotTakenIn, getWakeUpMessage, joinPromptsNotTakenIn } from '../requests/requestHeader';
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
});
