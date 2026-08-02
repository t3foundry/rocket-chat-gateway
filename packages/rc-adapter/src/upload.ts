import type { FileTypeGroup, RoomFile } from '@open-rocket-chat/api-contract';
import type { RcUpload } from '@open-rocket-chat/rc-rest-client';

import { toIsoString, type AdapterContext } from './context.js';
import { toUserSummary } from './user.js';

const KNOWN_GROUPS: FileTypeGroup[] = ['image', 'video', 'audio', 'text', 'application'];

/**
 * Rocket.Chat stores `typeGroup` on newer uploads and leaves it off older ones,
 * so it is derived from the MIME type when absent. Anything unrecognised lands
 * in `application`, which is the bucket Rocket.Chat's own Files panel labels
 * "Files" — a file with no group at all would be invisible under every filter.
 */
const typeGroupOf = (upload: RcUpload): FileTypeGroup => {
  const stored = upload.typeGroup as FileTypeGroup | undefined;
  if (stored && KNOWN_GROUPS.includes(stored)) return stored;

  const family = upload.type?.split('/')[0] as FileTypeGroup | undefined;
  return family && KNOWN_GROUPS.includes(family) ? family : 'application';
};

/**
 * The download path.
 *
 * `path` is what the record carries, but it is a storage-backend detail that is
 * absent on some adapters; `/file-upload/<id>/<name>` is deterministic and is
 * what Rocket.Chat itself serves from, so it is the fallback rather than the
 * other way round.
 */
const pathOf = (upload: RcUpload, name: string): string =>
  upload.path && upload.path.startsWith('/') ? upload.path : `/file-upload/${upload._id}/${encodeURIComponent(name)}`;

export const toRoomFile = (upload: RcUpload, context: AdapterContext): RoomFile => {
  const name = upload.name ?? 'file';
  const dimensions = upload.identify?.size;
  const typeGroup = typeGroupOf(upload);

  return {
    id: upload._id,
    name,
    mimeType: upload.type ?? null,
    size: upload.size ?? null,
    description: upload.description ?? null,
    typeGroup,
    url: context.fileUrl(pathOf(upload, name)),
    // The file list renders a thumbnail strip; the upload record has no
    // separate preview, so an image stands in for itself and the client asks
    // for it at the size it draws.
    thumbnailUrl: typeGroup === 'image' ? context.fileUrl(pathOf(upload, name)) : null,
    dimensions: dimensions ? { width: dimensions.width, height: dimensions.height } : null,
    uploadedBy: upload.user ? toUserSummary(upload.user, context) : null,
    uploadedAt: toIsoString(upload.uploadedAt),
  };
};
