/**
 * @description `utils/stripControlCharacters.ts`: text from outside the process (a runner's output, a forwarded message's sender name) with
 * everything a terminal could act on, or that could disguise what is shown, taken out.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripControlCharacters } from '../utils/stripControlCharacters';

describe('stripControlCharacters', () => {
  it('removes everything a terminal could act on or that could disguise a line — escapes, carriage returns, bells, NUL, DEL, C1 controls, bidirectional overrides, line separators — and keeps text, newlines and tabs', () => {
    const hostile = 'ok\u001b[2J\u001b]0;fake title\u0007 line\r\nnext\tcolumn\u0000\u007f\u009b31m \u202eevil\u2066\u2069\u200e\u200f\u2028\u2029 done — «ünï» 日本';
    assert.equal(stripControlCharacters(hostile), 'ok[2J]0;fake title line\nnext\tcolumn31m evil done — «ünï» 日本');
  });

  it('leaves plain text alone', () => {
    const plain = 'charness-runner: pairing with the hub\nInstalled two services: a (the link) and b.\n';
    assert.equal(stripControlCharacters(plain), plain);
  });
});
