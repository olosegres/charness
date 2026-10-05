/**
 * @description Markdown ↔ ADF for the Jira connector (plan J4, D3): an answer
 * becomes a comment body, an issue's ADF becomes prompt text, and a long answer
 * is split into comment-sized chunks without breaking a code block.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adfNodeSchema,
  createCommentBodies,
  jiraCommentAdfMaxChars,
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

  it('an empty code block keeps no empty text node — ADF refuses one (text minLength 1) and Jira would reject the comment', () => {
    for (const markdown of ['```\n```', '```sh\n\n```', 'before\n\n```\n```\n\nafter']) {
      const doc = convertMarkdownToAdf(markdown);
      const emptyTexts = JSON.stringify(doc).match(/"type":"text","text":""/g);
      assert.equal(emptyTexts, null, markdown);
      assert.ok(doc.content.flatMap(getNodeTypes).includes('codeBlock'), markdown);
    }
  });
});

function cell(type: 'tableHeader' | 'tableCell', text: string): AdfNode {
  return { type, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function getTextNodes(node: AdfNode): AdfNode[] {
  return node.type === 'text' ? [node] : (node.content ?? []).flatMap(getTextNodes);
}

describe('convertMarkdownToAdf keeps HTML as literal text (R17)', () => {
  const convertToTexts = (markdown: string): string[] => convertMarkdownToAdf(markdown).content.flatMap(getTextNodes).map((node) => node.text ?? '');

  it('a generic type stays in the text, in prose and in code', () => {
    assert.deepEqual(convertToTexts('Returns Promise<string>, see `Map<K, V>`.'), ['Returns Promise<string>, see ', 'Map<K, V>', '.']);
    const codeBlock = convertMarkdownToAdf('```ts\nconst list: Array<number> = [];\n```').content[0];
    assert.deepEqual(getTextNodes(codeBlock).map((node) => node.text), ['const list: Array<number> = [];']);
  });

  it('an issue key in angle brackets stays as written', () => {
    assert.deepEqual(convertToTexts('Blocked by <PROJ-12>.'), ['Blocked by <PROJ-12>.']);
  });

  it('an <adf> block never becomes a node: a mention in it stays text that notifies nobody', () => {
    const markdown = '<adf>{"type":"mention","attrs":{"id":"placeholder-account","text":"@all"}}</adf>';
    const document = convertMarkdownToAdf(markdown);
    const types = document.content.flatMap(function collect(node: AdfNode): string[] {
      return [node.type, ...(node.content ?? []).flatMap(collect)];
    });
    assert.ok(!types.includes('mention'), types.join(','));
    assert.deepEqual(convertToTexts(markdown), [markdown]);
  });

  it('a real autolink stays a link with a clean address; a stray placeholder character cannot become <', () => {
    const [prefix, link] = convertMarkdownToAdf('See <https://example.com/x>').content.flatMap(getTextNodes);
    assert.equal(prefix.text, 'See ');
    assert.deepEqual(link.marks, [{ type: 'link', attrs: { href: 'https://example.com/x' } }]);
    assert.deepEqual(convertToTexts('a \uE000 b'), ['a \uFFFD b']);
  });

  it('an address-shaped <!\u2026 or <?\u2026 is HTML to the lexer, never an autolink: the rest of the answer survives', () => {
    // `<?` opens a processing instruction and `<!--` a comment that run to the end of the answer.
    for (const opener of ['<?@a.bc>', '<!--@x.yz>', '<!A@b.cd>', '<?x@host.example>']) {
      const texts = convertToTexts(`Intro.\n\n${opener} kept\n\nand the next paragraph`);
      assert.equal(texts.join(''), `Intro.${opener} keptand the next paragraph`, opener);
    }
  });

  it('an escaped \\< is a plain < in prose, and stays as written in code', () => {
    assert.deepEqual(convertToTexts('List\\<String\\>'), ['List<String', '>']);
    assert.deepEqual(convertToTexts('a \\\\<b>'), ['a ', '\\', '<b>']);
    assert.deepEqual(convertToTexts('`List\\<T>`'), ['List\\<T>']);
    // A bare address is linked as written: its text must not drift from its target.
    const [, link] = convertMarkdownToAdf('see https://a.example/x\\<y').content.flatMap(getTextNodes);
    assert.deepEqual([link.text, link.marks], ['https://a.example/x\\<y', [{ type: 'link', attrs: { href: 'https://a.example/x\\<y' } }]]);
    assert.deepEqual(getTextNodes(convertMarkdownToAdf('```\nList\\<T>\n```').content[0]).map((node) => node.text), ['List\\<T>']);
  });
});

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

  it('a link keeps its address beside its text; a bare link whose text is the address is not doubled', () => {
    const link = (text: string, href: string): AdfNode => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'See ' }, link('the spec', 'https://example.com/spec'), { type: 'text', text: ' and ' }, link('https://example.com/x', 'https://example.com/x'),
      ] }],
    };
    assert.equal(getAdfText(doc), 'See the spec (https://example.com/spec) and https://example.com/x');
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

  it('an oversized block with a fence right after a text line: the text stays text, every code piece fenced, nothing lost', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `# step ${index} *x*`);
    const chunks = splitMarkdownForComments(`Here is the script:\n\`\`\`sh\n${lines.join('\n')}\n\`\`\`\nThat is all.`, 60);
    assert.equal(chunks[0].split('\n\n')[0], 'Here is the script:');
    const codePieces = chunks.flatMap((chunk) => chunk.split('\n\n')).filter((piece) => piece.startsWith('```'));
    assert.ok(codePieces.length > 1);
    for (const piece of codePieces) assert.match(piece, /^```sh\n[\s\S]*\n```$/);
    assert.deepEqual(codePieces.flatMap((piece) => piece.split('\n').slice(1, -1)), lines);
    assert.equal(chunks.at(-1)?.split('\n\n').at(-1), 'That is all.');
    for (const chunk of chunks) assert.ok(chunk.length <= 60, `${chunk.length} chars`);
  });

  it('two fenced blocks with no blank line between them in an oversized block are each re-fenced on their own', () => {
    const first = Array.from({ length: 6 }, (_, index) => `a${index}`);
    const second = Array.from({ length: 6 }, (_, index) => `b${index}`);
    const chunks = splitMarkdownForComments(`\`\`\`\n${first.join('\n')}\n\`\`\`\n~~~\n${second.join('\n')}\n~~~`, 24);
    const pieces = chunks.flatMap((chunk) => chunk.split('\n\n'));
    for (const piece of pieces) assert.match(piece, /^(```\n[\s\S]*\n```|~~~\n[\s\S]*\n~~~)$/, piece);
    assert.deepEqual(pieces.flatMap((piece) => piece.split('\n').slice(1, -1)), [...first, ...second]);
  });

  it('a long line is cut after the last space that fits, never inside a word', () => {
    const chunks = splitMarkdownForComments('alpha beta gamma delta', 12);
    assert.deepEqual(chunks, ['alpha beta ', 'gamma delta']);
    assert.equal(chunks.join(''), 'alpha beta gamma delta');
  });

  it('a line longer than a comment is cut, nothing lost', () => {
    const chunks = splitMarkdownForComments('y'.repeat(25), 10);
    assert.deepEqual(chunks, ['y'.repeat(10), 'y'.repeat(10), 'y'.repeat(5)]);
  });

  it('a hard cut never splits a character outside the BMP: a lone surrogate is not valid text', () => {
    const line = `a${'😀'.repeat(10)}`;
    const chunks = splitMarkdownForComments(line, 6);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 6, chunk);
      assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, JSON.stringify(chunk));
    }
    assert.equal(chunks.join(''), line);
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

describe('createCommentBodies (R19)', () => {
  const getAdfLength = (body: object): number => JSON.stringify(body).length;

  it('a short answer is one body, identical to its conversion', () => {
    assert.deepEqual(createCommentBodies('Done.'), [convertMarkdownToAdf('Done.')]);
  });

  it('every body fits by BOTH counts, even when the Markdown cap alone would let the ADF overflow', () => {
    // Short marked-up words: about 9 Markdown characters become a ~60-character text node each.
    const markdown = Array.from({ length: 300 }, (_, index) => `**w${index}** _x_`).join(' ');
    const limits = { markdownMaxChars: 5_000, adfMaxChars: 4_000 };
    assert.ok(markdown.length < limits.markdownMaxChars, 'the Markdown alone fits one comment');
    assert.ok(getAdfLength(convertMarkdownToAdf(markdown)) > limits.adfMaxChars, 'its ADF does not');
    const bodies = createCommentBodies(markdown, limits);
    assert.ok(bodies.length > 1);
    for (const body of bodies) assert.ok(getAdfLength(body) <= limits.adfMaxChars, `${getAdfLength(body)} chars`);
    const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
    assert.deepEqual(bodies.flatMap((body) => words(getAdfText(body))), words(getAdfText(convertMarkdownToAdf(markdown))), 'nothing lost or reordered');
  });

  it('the real limits are under Jira\'s 32 767 characters', () => {
    assert.ok(jiraCommentAdfMaxChars < 32_767);
    for (const body of createCommentBodies(Array.from({ length: 3_000 }, (_, index) => `- **item ${index}** \`code\``).join('\n'))) {
      assert.ok(getAdfLength(body) <= jiraCommentAdfMaxChars);
    }
  });

  it('a limit too small to hold one character is an error, never an endless split', { timeout: 5_000 }, () => {
    assert.throws(() => createCommentBodies('text', { markdownMaxChars: 100, adfMaxChars: 10 }), /adfMaxChars 10 cannot hold a single character/);
  });
});

describe('no external media and no unsafe link targets in a comment (R25)', () => {
  const collectNodes = (node: AdfNode): AdfNode[] => [node, ...(node.content ?? []).flatMap(collectNodes)];
  const convertToNodes = (markdown: string): AdfNode[] => convertMarkdownToAdf(markdown).content.flatMap(collectNodes);
  const getLinkTargets = (markdown: string): string[] => convertToNodes(markdown)
    .flatMap((node) => node.marks ?? [])
    .flatMap((mark) => (mark.type === 'link' && typeof mark.attrs?.href === 'string' ? [mark.attrs.href] : []));

  it('an image becomes a plain link — never a media node any viewer\'s browser would fetch', () => {
    for (const markdown of ['![logo](https://example.com/pixel.png)', 'before ![](https://example.com/t.gif) after', '| a |\n|---|\n| ![i](https://example.com/i.png) |']) {
      const types = convertToNodes(markdown).map((node) => node.type);
      assert.ok(!types.includes('media') && !types.includes('mediaSingle'), `${markdown}: ${types.join(',')}`);
    }
    const [paragraph] = convertMarkdownToAdf('![logo](https://example.com/pixel.png)').content;
    assert.deepEqual(paragraph, { type: 'paragraph', content: [{ type: 'text', text: 'logo', marks: [{ type: 'link', attrs: { href: 'https://example.com/pixel.png' } }] }] });
  });

  it('a link keeps its target only for http, https and mailto', () => {
    assert.deepEqual(
      getLinkTargets('[a](https://example.com) [b](http://example.com) [c](mailto:someone@example.com) [d](javascript:alert(1)) [e](data:text/html,x) [f](/relative) [g](ftp://example.com)'),
      ['https://example.com', 'http://example.com', 'mailto:someone@example.com'],
    );
    const texts = convertToNodes('[click](javascript:alert(1))').filter((node) => node.type === 'text').map((node) => node.text);
    assert.deepEqual(texts, ['click'], 'the text stays, without a target');
  });

  it('an image with an unsafe address is text naming the address, never a link', () => {
    const nodes = convertToNodes('![x](javascript:alert(1))');
    assert.deepEqual(nodes.filter((node) => node.type === 'text').map((node) => node.text), ['x (javascript:alert(1))']);
    assert.deepEqual(getLinkTargets('![x](javascript:alert(1))'), []);
  });
});
