/**
 * @description A caption cut to fit an inline button — shared by every screen whose button names something the owner wrote (a person, a
 * topic): `maxChars` graphemes at most, the cut on a grapheme boundary (a family emoji is never split in half), ending in an ellipsis.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const labelEllipsis = '…';

/** @description `text` cut to `maxChars` graphemes, ending in an ellipsis when it was cut. */
export function cutButtonLabel(text: string, maxChars: number): string {
  const graphemes = [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
  if (graphemes.length <= maxChars) return text;
  return `${graphemes.slice(0, maxChars - 1).join('')}${labelEllipsis}`;
}
