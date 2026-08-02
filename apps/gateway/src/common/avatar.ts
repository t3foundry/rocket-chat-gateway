import { isAvatarMediaType } from '@open-rocket-chat/api-contract';
import type { FastifyRequest } from 'fastify';

import { ApiException } from './api-exception';

/** One avatar image, read off a multipart request and checked. */
export interface AvatarUpload {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Reads the `image` part of an avatar upload.
 *
 * Buffered rather than streamed: both upstream routes want the bytes in hand —
 * one as a multipart field with a known length, the other as a base64 data URI
 * — and the size ceiling is already enforced by the multipart limits set at
 * boot, so nothing unbounded is being held.
 *
 * The media type is checked here rather than left to Rocket.Chat because the
 * server stores whatever it is given: a TIFF would upload cleanly and then
 * render as a broken picture in every client on it.
 */
export const readAvatarUpload = async (request: FastifyRequest): Promise<AvatarUpload> => {
  const part = await request.file();

  if (!part) {
    throw ApiException.localized('bad_request', 'multipartImageRequired');
  }

  if (!isAvatarMediaType(part.mimetype)) {
    throw ApiException.localized('bad_request', 'avatarMustBeImage');
  }

  return {
    filename: part.filename,
    contentType: part.mimetype,
    content: await part.toBuffer(),
  };
};

/** The `data:` URI form Rocket.Chat's room-avatar setting is carried in. */
export const toDataUri = (upload: AvatarUpload): string =>
  `data:${upload.contentType};base64,${upload.content.toString('base64')}`;

/**
 * How long to wait for Rocket.Chat to publish the new avatar tag, and how
 * often to look. Both halves of Rocket.Chat's avatar handling — `setUserAvatar`
 * and `setRoomAvatar` — store the picture immediately but write the tag from a
 * 500ms `setTimeout`, so a record read the moment the upload returns still
 * carries the old one.
 */
const SETTLE_ATTEMPTS = 4;
const SETTLE_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Re-reads a record until its avatar tag stops being the one from before the
 * upload.
 *
 * Without this the caller would be answered with a URL addressing the picture
 * it just replaced — which every cache between here and the browser would then
 * serve for as long as the tag says it is immutable. Bounded: after the last
 * attempt whatever was read is returned regardless, because a stale tag is a
 * far better answer than a failed upload.
 */
export const withSettledAvatarTag = async <T>(
  read: () => Promise<T>,
  tagOf: (value: T) => string | undefined,
  previousTag: string | undefined,
): Promise<T> => {
  let latest = await read();

  for (let attempt = 1; attempt < SETTLE_ATTEMPTS && tagOf(latest) === previousTag; attempt += 1) {
    await sleep(SETTLE_INTERVAL_MS);
    latest = await read();
  }

  return latest;
};
