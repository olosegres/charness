/**
 * @description Markdown ↔ ADF for the Jira connector (plan J4, D3): an answer
 * becomes a comment body, an issue's ADF becomes prompt text, and a long answer
 * is split into comment-sized chunks without breaking a code block.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adfNodeSchema,
  convertMarkdownToAdf,
  getAdfText,
  jiraCommentMarkdownMaxChars,
  splitMarkdownForComments,
  type AdfNode,
} from '../connectors/jira/adf';

function getNodeTypes(node: AdfNode): string[] {
  return [node.type, ...(node.content ?? []).flatMap(getNodeTypes)];
}

describe('convertMarkdownToAdf', () => {
  it('turns headings, lists, code, marks and links into ADF', () => {
    const doc = convertMarkdownToAdf('# Result\n\nSome **bold** and `code`, see [the docs](https://example.com).\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n');

    assert.equal(doc.type, 'doc');
    assert.equal(doc.version, 1);
    const types = doc.content.flatMap(getNodeTypes);
    for (const expected of ['heading', 'paragraph', 'bulletList', 'listItem', 'codeBlock']) assert.ok(types.includes(expected), expected);
    const markTypes = JSON.stringify(doc);
    for (const mark of ['"strong"', '"code"', '"link"', 'https://example.com']) assert.ok(markTypes.includes(mark), mark);
  });
});

function cell(type: 'tableHeader' | 'tableCell', text: string): AdfNode {
  return { type, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

describe('getAdfText', () => {
  const description: AdfNode = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ask ' },
          { type: 'mention', attrs: { id: 'placeholder-id', text: '@Requester' } },
          { type: 'text', text: ' about it', marks: [{ type: 'strong' }] },
          { type: 'hardBreak' },
          { type: 'inlineCard', attrs: { url: 'https://example.com/spec' } },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
        ],
      },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Step'), cell('tableHeader', 'Owner')] },
          { type: 'tableRow', content: [cell('tableCell', 'build'), cell('tableCell', 'AI')] },
        ],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
    ],
  };

  it('one line per block, list items as "- …", a table row per line, mentions and cards by their text', () => {
    assert.equal(
      getAdfText(description),
      'Goal\nAsk @Requester about it\nhttps://example.com/spec\n- first\n- second\nStep | Owner\nbuild | AI\nnpm test',
    );
  });

  it('an absent description is empty text', () => {
    assert.equal(getAdfText(null), '');
    assert.equal(getAdfText({ type: 'doc', content: [] }), '');
  });

  it('round-trips an answer: the text of the converted Markdown keeps its words', () => {
    const text = getAdfText(convertMarkdownToAdf('Done.\n\n- built\n- tested'));
    assert.equal(text, 'Done.\n- built\n- tested');
  });

  it('the response schema accepts real ADF shapes and drops unknown keys', () => {
    const parsed = adfNodeSchema.parse({ ...description, localId: 'x', content: [{ type: 'rule' }] });
    assert.deepEqual(parsed, { type: 'doc', content: [{ type: 'rule' }] });
    assert.equal(adfNodeSchema.safeParse({ content: [] }).success, false, 'a node needs a type');
  });
});

describe('splitMarkdownForComments', () => {
  it('a short answer is one chunk; blank input none', () => {
    assert.deepEqual(splitMarkdownForComments('Short answer.'), ['Short answer.']);
    assert.deepEqual(splitMarkdownForComments('  \n\n '), []);
  });

  it('packs whole paragraphs in order and never exceeds the cap', () => {
    const paragraphs = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const chunks = splitMarkdownForComments(paragraphs.join('\n\n'), 90);
    assert.deepEqual(chunks, [`${paragraphs[0]}\n\n${paragraphs[1]}`, paragraphs[2]]);
  });

  it('keeps a fenced code block with blank lines whole when it fits', () => {
    // Split at its blank line, the fence's first half would still fit after the paragraph and be packed there.
    const code = '```\nline 1\n\nline 3\n```';
    const chunks = splitMarkdownForComments(`${'p'.repeat(20)}\n\n${code}`, 40);
    assert.deepEqual(chunks, ['p'.repeat(20), code]);
  });

  it('an oversized code block is split by lines, every piece fenced', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`);
    const chunks = splitMarkdownForComments(`\`\`\`ts\n${lines.join('\n')}\n\`\`\``, 120);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 120, `${chunk.length} chars`);
      assert.match(chunk, /^```ts\n[\s\S]*\n```$/);
    }
    assert.deepEqual(chunks.flatMap((chunk) => chunk.split('\n').slice(1, -1)), lines);
  });

  it('an oversized code block keeps its blank lines, also where a piece starts', () => {
    const lines = ['first = 1', '', 'second = 2', '', '', 'third = 3', ''];
    const chunks = splitMarkdownForComments(`\`\`\`\n${lines.join('\n')}\n\`\`\``, 18);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flatMap((chunk) => chunk.split('\n').slice(1, -1)), lines);
  });

  it('a line longer than a comment is cut, nothing lost', () => {
    const chunks = splitMarkdownForComments('y'.repeat(25), 10);
    assert.deepEqual(chunks, ['y'.repeat(10), 'y'.repeat(10), 'y'.repeat(5)]);
  });

  it('a longer fence is closed only by a fence at least as long without an info string', () => {
    // The inner ``` lines are content of the ```` block, so its blank line must not split it.
    const code = '````md\n```ts\nx\n\n```\n````';
    assert.deepEqual(splitMarkdownForComments(`${'p'.repeat(20)}\n\n${code}`, 40), ['p'.repeat(20), code]);
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const chunks = splitMarkdownForComments(`~~~~\n${lines.join('\n')}\n~~~~`, 40);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.match(chunk, /^~~~~\n[\s\S]*\n~~~~$/, 'every piece re-closed with the full fence');
    assert.deepEqual(chunks.flatMap((chunk) => chunk.split('\n').slice(1, -1)), lines);
  });

  it('a fence opener too long to re-fence beside any line falls back to line pieces, never loops', { timeout: 5_000 }, () => {
    const chunks = splitMarkdownForComments(`\`\`\`${'i'.repeat(30)}\nbody\n\`\`\``, 20);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 20);
    assert.throws(() => splitMarkdownForComments('x', 0), RangeError);
  });

  it('an answer at the real cap splits into chunks that each stay under it', () => {
    const paragraph = 'x'.repeat(10_000);
    const chunks = splitMarkdownForComments(Array.from({ length: 7 }, () => paragraph).join('\n\n'));
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) assert.ok(chunk.length <= jiraCommentMarkdownMaxChars);
  });
});
