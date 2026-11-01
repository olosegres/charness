/**
 * @description `utils/sentKindsSummary.ts`: the per-kind wording both file tools answer with ("1 text, 2 photos") —
 * the kinds in one fixed order, singular and plural, nothing for a kind that did not go out.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSentKinds } from '../utils/sentKindsSummary';

describe('formatSentKinds', () => {
  it('counts each kind, singular for one and plural for more', () => {
    assert.equal(formatSentKinds(['photo']), '1 photo');
    assert.equal(formatSentKinds(['photo', 'photo', 'photo']), '3 photos');
    assert.equal(formatSentKinds(['text', 'text']), '2 texts');
  });

  it('names the kinds in one fixed order whatever the order they were sent in', () => {
    assert.equal(
      formatSentKinds(['document', 'animation', 'video', 'photo', 'text', 'document']),
      '1 text, 1 photo, 1 video, 1 animation, 2 documents',
    );
  });

  it('names nothing for a kind that did not go out, and nothing at all for nothing sent', () => {
    assert.equal(formatSentKinds(['document', 'document']), '2 documents');
    assert.equal(formatSentKinds([]), '');
  });
});
