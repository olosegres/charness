/**
 * @description The per-request header that rides inside a request's prompt
 * (`requests/requestHeader.ts`): names the id and how to answer, and says the
 * plain text is not shown only when that is so.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestHeader } from '../requests/requestHeader';

describe('buildRequestHeader', () => {
  it('names the request, its origin and the answer_request call, then a blank line', () => {
    const header = buildRequestHeader({
      requestId: 'req_AbCd1234',
      originDescription: 'a message in this topic',
      isPlainTextHidden: false,
    });
    assert.ok(header.startsWith('[Request req_AbCd1234 · from: a message in this topic]\n'));
    assert.match(header, /answer_request tool \(requestId "req_AbCd1234"\)/);
    assert.doesNotMatch(header, /does not see your plain text/);
    assert.ok(header.endsWith('\n\n'));
  });

  it('warns that plain text is not shown when the requester cannot see it', () => {
    const header = buildRequestHeader({
      requestId: 'req_AbCd1234',
      originDescription: 'PROJ-123 assigned to you',
      isPlainTextHidden: true,
    });
    assert.match(header, /does not see your plain text output/);
  });
});
