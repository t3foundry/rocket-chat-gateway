import type { RocketChatCredentials, RocketChatHttp, RequestOptions } from '../http.js';

/** Shared plumbing for the authenticated resource groups. */
export abstract class AuthenticatedResource {
  constructor(
    protected readonly http: RocketChatHttp,
    protected readonly credentials: RocketChatCredentials,
  ) {}

  protected get<T>(path: string, query?: RequestOptions['query'], options?: RequestOptions): Promise<T> {
    return this.http.request<T>(path, { ...options, method: 'GET', query, credentials: this.credentials });
  }

  protected post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>(path, { ...options, method: 'POST', body, credentials: this.credentials });
  }
}

/**
 * Copies a view into a standalone buffer.
 *
 * Small Node `Buffer`s are slices of a shared 8 KiB pool, so reaching for
 * `.buffer` yields the whole pool — including unrelated heap contents that
 * would then be uploaded in place of the file. `Buffer.prototype.slice` does
 * not help: unlike `Uint8Array.prototype.slice` it is an alias for `subarray`
 * and shares the same memory. Constructing a `Uint8Array` from the view is
 * what actually copies, and only the bytes the view covers.
 */
export const copyBytes = (content: Uint8Array): Uint8Array<ArrayBuffer> => {
  // Allocated against a plain ArrayBuffer: the input's buffer type widens to
  // `ArrayBufferLike`, which `BlobPart` rejects because it admits SharedArrayBuffer.
  const copy = new Uint8Array(new ArrayBuffer(content.byteLength));
  copy.set(content);
  return copy;
};

/**
 * Rocket.Chat's room-scoped routes are namespaced by room type rather than
 * being generic — `channels.history` for public channels, `groups.history` for
 * private ones, `im.history` for direct messages. Callers should not have to
 * care, so every room method dispatches through here.
 */
export const roomNamespace = (roomType: string): 'channels' | 'groups' | 'im' => {
  switch (roomType) {
    case 'c':
      return 'channels';
    case 'd':
      return 'im';
    // Private groups, discussions, teams and omnichannel rooms are all stored
    // as private rooms and served by the `groups.*` family.
    default:
      return 'groups';
  }
};
