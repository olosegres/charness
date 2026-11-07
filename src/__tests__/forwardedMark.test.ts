/**
 * @description Unit coverage for the forwarded-message mark (`[Forwarded message · from: … ·
 * originally sent: …]`) the bot folds ahead of a prompt when the operator forwards a message
 * into a topic.
 *
 * Cases:
 *   - each of the four origins reads as its own kind (user with `@username`, hidden user,
 *     chat, channel), with the signature when there is one;
 *   - the original date is the instance-local ISO instant, left out when Telegram gave none;
 *   - a nameless origin reads `unknown`; a name with a newline stays on the header's one line;
 *   - not forwarded → no mark.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildForwardedMark } from '../utils/forwardedMark';
import { formatIsoLocalOffset } from '../utils/isoTimestamp';

/** An arbitrary original send time, unix seconds. */
const originalSentAtSeconds = 1_793_000_000;
const originalSentAtIso = formatIsoLocalOffset(originalSentAtSeconds * 1000);

test('buildForwardedMark: a known user reads with their name and @username', () => {
  assert.equal(
    buildForwardedMark({ kind: 'user', name: 'Alice Smith', username: 'alice', originalSentAtSeconds }),
    `[Forwarded message · from: user Alice Smith (@alice) · originally sent: ${originalSentAtIso}]`,
  );
});

test('buildForwardedMark: a user with no @username has none shown', () => {
  assert.equal(
    buildForwardedMark({ kind: 'user', name: 'Alice Smith', originalSentAtSeconds }),
    `[Forwarded message · from: user Alice Smith · originally sent: ${originalSentAtIso}]`,
  );
});

test('buildForwardedMark: a hidden user is said to be hidden', () => {
  assert.equal(
    buildForwardedMark({ kind: 'hiddenUser', name: 'Jane Doe', originalSentAtSeconds }),
    `[Forwarded message · from: hidden user Jane Doe · originally sent: ${originalSentAtIso}]`,
  );
});

test('buildForwardedMark: a chat and a channel read as such, a post signature is kept', () => {
  assert.equal(
    buildForwardedMark({ kind: 'chat', name: 'Team room', signature: 'Chief', originalSentAtSeconds }),
    `[Forwarded message · from: chat Team room · signed: Chief · originally sent: ${originalSentAtIso}]`,
  );
  assert.equal(
    buildForwardedMark({ kind: 'channel', name: 'Ops Alerts', originalSentAtSeconds }),
    `[Forwarded message · from: channel Ops Alerts · originally sent: ${originalSentAtIso}]`,
  );
});

test('buildForwardedMark: the original date is local ISO with the offset, never UTC "Z"', () => {
  const mark = buildForwardedMark({ kind: 'channel', name: 'Ops Alerts', originalSentAtSeconds });
  assert.match(mark ?? '', /originally sent: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/);
});

test('buildForwardedMark: no usable date → the date part is left out, not printed as 1970', () => {
  assert.equal(buildForwardedMark({ kind: 'channel', name: 'Ops Alerts' }), '[Forwarded message · from: channel Ops Alerts]');
  assert.equal(buildForwardedMark({ kind: 'channel', name: 'Ops Alerts', originalSentAtSeconds: 0 }), '[Forwarded message · from: channel Ops Alerts]');
});

test('buildForwardedMark: an origin with no name reads "unknown", and a name cannot break the header line', () => {
  assert.equal(buildForwardedMark({ kind: 'chat', name: '' }), '[Forwarded message · from: chat unknown]');
  assert.equal(buildForwardedMark({ kind: 'hiddenUser', name: 'Jane\nDoe\t]' }), '[Forwarded message · from: hidden user Jane Doe ]]');
});

test('buildForwardedMark: a message that was not forwarded has no mark', () => {
  assert.equal(buildForwardedMark(undefined), null);
});
