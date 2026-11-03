import type { Attachment, AttachmentKind, FileRef } from '@t3foundry/open-rocket-chat-api-contract';
import type { RcAttachment, RcFileProp } from '@t3foundry/open-rocket-chat-rc-rest-client';

import { toIsoString, type AdapterContext } from './context.js';

/**
 * Rocket.Chat attachments are an untagged union: the kind has to be inferred
 * from which optional fields are populated. Checked most-specific first,
 * because an image attachment also carries a `title_link`.
 */
const inferKind = (attachment: RcAttachment): AttachmentKind => {
  if (attachment.image_url) return 'image';
  if (attachment.video_url) return 'video';
  if (attachment.audio_url) return 'audio';
  // A quote is the only attachment that links back to another message.
  if (attachment.message_link) return 'quote';
  if (attachment.title_link_download || attachment.type === 'file') return 'file';
  if (attachment.title_link || attachment.author_link) return 'link';
  return 'unknown';
};

const mimeTypeOf = (attachment: RcAttachment): string | null =>
  attachment.image_type ?? attachment.video_type ?? attachment.audio_type ?? null;

const sizeOf = (attachment: RcAttachment): number | null =>
  attachment.image_size ?? attachment.video_size ?? attachment.audio_size ?? null;

/** Only rewrite server-relative paths; absolute URLs come from link previews. */
const resolveUrl = (value: string | undefined, context: AdapterContext): string | null => {
  if (!value) return null;
  return value.startsWith('/') ? context.fileUrl(value) : value;
};

export const toAttachment = (attachment: RcAttachment, context: AdapterContext): Attachment => {
  const kind = inferKind(attachment);
  const media = attachment.image_url ?? attachment.video_url ?? attachment.audio_url;
  const dimensions = attachment.image_dimensions;

  return {
    kind,
    title: attachment.title ?? null,
    url: resolveUrl(media ?? attachment.title_link, context),
    description: attachment.description ?? null,
    text: attachment.text ?? null,
    mimeType: mimeTypeOf(attachment),
    size: sizeOf(attachment),
    dimensions: dimensions?.width && dimensions?.height ? { width: dimensions.width, height: dimensions.height } : null,
    // `image_preview` is a base64 blurhash-style placeholder, already inline.
    thumbnailUrl: attachment.image_preview ? `data:image/png;base64,${attachment.image_preview}` : null,
    color: attachment.color ?? null,
    author: attachment.author_name
      ? {
          name: attachment.author_name,
          iconUrl: resolveUrl(attachment.author_icon, context),
          link: attachment.author_link ?? null,
        }
      : null,
    quotedMessageUrl: attachment.message_link ?? null,
    createdAt: toIsoString(attachment.ts),
  };
};

export const toFileRef = (file: RcFileProp, context: AdapterContext, thumbnailPath?: string): FileRef => ({
  id: file._id,
  name: file.name ?? 'file',
  mimeType: file.type ?? null,
  size: file.size ?? null,
  // Rocket.Chat does not return the download path on the file record itself;
  // it is deterministic from the id and name.
  url: context.fileUrl(`/file-upload/${file._id}/${encodeURIComponent(file.name ?? 'file')}`),
  thumbnailUrl: thumbnailPath ? context.fileUrl(thumbnailPath) : null,
});

/** `/file-upload/<id>/<name>` — only the id identifies the upload. */
const uploadIdOf = (path: string): string | null => /^\/file-upload\/([^/]+)\//.exec(path)?.[1] ?? null;

/**
 * Rocket.Chat appends the thumbnail it generates for an image to the same
 * `files` array as the image itself, so one upload arrives as two records with
 * the same name — a client rendering `files` verbatim shows every image twice.
 *
 * The image attachment ties them back together: `fileId` is the original and
 * `image_url` is the thumbnail. The two only differ when a thumbnail was
 * actually generated; images already smaller than the thumbnail size reuse the
 * original, which is why the equality check has to come first.
 */
export const toFileRefs = (files: RcFileProp[], attachments: RcAttachment[], context: AdapterContext): FileRef[] => {
  const thumbnailPathByFileId = new Map<string, string>();
  const thumbnailIds = new Set<string>();

  for (const attachment of attachments) {
    const thumbnailPath = attachment.image_url;
    if (!thumbnailPath || thumbnailPath === attachment.title_link) continue;

    const id = uploadIdOf(thumbnailPath);
    if (id) thumbnailIds.add(id);
    if (attachment.fileId) thumbnailPathByFileId.set(attachment.fileId, thumbnailPath);
  }

  // `typeGroup` is the server's own marker; the id set is the fallback for
  // uploads stored before it existed, and for thumbnails whose attachment was
  // dropped along the way.
  const isThumbnail = (file: RcFileProp): boolean => file.typeGroup === 'thumb' || thumbnailIds.has(file._id);

  return files
    .filter((file) => !isThumbnail(file))
    .map((file) => toFileRef(file, context, thumbnailPathByFileId.get(file._id)));
};
