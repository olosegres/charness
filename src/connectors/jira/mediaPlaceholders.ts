import { getStringAttribute, type AdfMediaResolver, type AdfNode } from './adf';
import type { JiraAttachment } from './client';
import { getSingleLineText } from './promptText';

/**
 * @description How a media node in an issue's text reaches the agent (plan C9):
 * as a placeholder where the file sat, naming the attachment to fetch —
 * `[image: login-error.png — attachment 10234]`. A pasted screenshot or video
 * is a `media` node whose id is a Media Services id, NOT the attachment id, so
 * the attachment is found from what Jira records (real ADF, S1 fixture):
 *
 *  1. an upload whose name was already taken is stored as `<stem> (<media id>).<ext>`:
 *     the attachment whose filename CONTAINS the media id — exact;
 *  2. otherwise every attachment named exactly like the node's `alt` (the original
 *     file name) — all their ids are listed, because a REST upload keeps duplicate names;
 *  3. an inline file (`mediaInline`) has no `alt` at all, but the rendered HTML
 *     links it to its attachment together with the media id
 *     (`<a href=".../attachment/content/<id>" data-media-services-id="<media id>">`):
 *     {@link getAttachmentIdsByMediaId} reads that — exact, so nothing is guessed;
 *  4. nothing found → `attachment unknown`.
 */

const attachmentContentPathRe = /\/attachment\/content\/(\d+)/;
const htmlAnchorTagRe = /<a\b[^>]*>/gi;
const htmlAttributeRe = /([A-Za-z_][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
const mediaServicesIdAttribute = 'data-media-services-id';
const unknownAttachmentText = 'attachment unknown';
const inlineFileLabel = 'inline file';
const externalMediaType = 'external';

/**
 * @description The media id → attachment id pairs a rendered body (a comment's
 * `renderedBody`, an issue's `renderedFields.description`) states: every `<a>`
 * that carries a `data-media-services-id` and a `/attachment/content/<id>` link.
 * Only those two attributes are read; the HTML itself never reaches the prompt.
 */
export function getAttachmentIdsByMediaId(renderedHtml: string | null | undefined): Map<string, string> {
  const attachmentIdByMediaId = new Map<string, string>();
  for (const [anchorTag] of (renderedHtml ?? '').matchAll(htmlAnchorTagRe)) {
    const attributes = new Map<string, string>();
    for (const [, name, value] of anchorTag.matchAll(htmlAttributeRe)) attributes.set(name.toLowerCase(), value);
    const mediaId = attributes.get(mediaServicesIdAttribute);
    const attachmentId = attachmentContentPathRe.exec(attributes.get('href') ?? '')?.[1];
    if (mediaId && attachmentId) attachmentIdByMediaId.set(mediaId, attachmentId);
  }
  return attachmentIdByMediaId;
}

export interface MediaResolverContext {
  /** The issue's `attachment` list. */
  attachments: readonly JiraAttachment[];
  /** Media id → attachment id, merged from the rendered description and comments. */
  attachmentIdByMediaId: ReadonlyMap<string, string>;
  /** Told, for each media node resolved, which attachments it stands for — the attachments block's "referenced in". */
  onResolved?: (attachmentIds: readonly string[]) => void;
}

/** What kind of file the placeholder names, from its type: only an image or a video is worth saying. */
function getMediaKind(mimeType: string | undefined): string {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  return 'file';
}

function getAttachmentTarget(attachmentIds: readonly string[]): string {
  if (attachmentIds.length === 0) return unknownAttachmentText;
  return attachmentIds.length === 1 ? `attachment ${attachmentIds[0]}` : `attachments ${attachmentIds.join(', ')}`;
}

/** The ids of the attachments a `file` media node stands for (rules 1–3 above); empty when none is found. */
function getAttachmentIds(node: AdfNode, context: MediaResolverContext): string[] {
  const mediaId = getStringAttribute(node, 'id') ?? '';
  const alt = getStringAttribute(node, 'alt') ?? '';
  const fromRenderedHtml = mediaId ? context.attachmentIdByMediaId.get(mediaId) : undefined;
  if (fromRenderedHtml) return [fromRenderedHtml];
  // An empty id would match every filename.
  const byMediaId = mediaId ? context.attachments.filter((attachment) => attachment.filename.includes(mediaId)) : [];
  if (byMediaId.length > 0) return byMediaId.map((attachment) => attachment.id);
  return alt ? context.attachments.filter((attachment) => attachment.filename === alt).map((attachment) => attachment.id) : [];
}

/** @description The resolver `getAdfText` takes for one issue's text. Pure apart from `onResolved`. */
export function createMediaResolver(context: MediaResolverContext): AdfMediaResolver {
  return (node) => {
    if (node.type === 'media' && getStringAttribute(node, 'type') === externalMediaType) {
      return `[image: ${getSingleLineText(getStringAttribute(node, 'url') ?? '')}]`;
    }
    const attachmentIds = getAttachmentIds(node, context);
    context.onResolved?.(attachmentIds);
    const firstAttachment = context.attachments.find((attachment) => attachment.id === attachmentIds[0]);
    const name = getSingleLineText(getStringAttribute(node, 'alt') ?? firstAttachment?.filename ?? '');
    const target = getAttachmentTarget(attachmentIds);
    if (!name) return `[${inlineFileLabel} — ${target}]`;
    return `[${getMediaKind(firstAttachment?.mimeType)}: ${name} — ${target}]`;
  };
}
