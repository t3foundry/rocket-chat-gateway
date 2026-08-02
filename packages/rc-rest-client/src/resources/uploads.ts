import { RocketChatApiError } from '../errors.js';
import type { RcMessage } from '../types.js';
import { AuthenticatedResource, copyBytes } from './base.js';

export interface UploadInput {
  roomId: string;
  filename: string;
  contentType: string;
  content: Uint8Array | Blob;
  /** Caption rendered under the attachment. */
  description?: string;
  /** Message text posted alongside the file. */
  text?: string;
  threadId?: string;
  showInMainChannel?: boolean;
}

/**
 * Which upload API the connected server speaks.
 *
 * Rocket.Chat replaced the single-shot `rooms.upload/:rid` with a two-phase
 * `rooms.media` + `rooms.mediaConfirm` handshake. Both exist in the wild, and
 * the only reliable way to tell them apart is to try — the server version
 * string is not a dependable proxy because the change was backported.
 */
export type UploadStrategy = 'media-confirm' | 'legacy-upload';

export class UploadsResource extends AuthenticatedResource {
  /**
   * Detected once per client instance. Probing on every upload would double the
   * request count for the most latency-sensitive operation in the API.
   */
  private strategy: UploadStrategy | undefined;

  /** Pre-seeds the detected strategy, e.g. from a cached server capability record. */
  setStrategy(strategy: UploadStrategy | undefined): void {
    this.strategy = strategy;
  }

  getStrategy(): UploadStrategy | undefined {
    return this.strategy;
  }

  async upload(input: UploadInput): Promise<RcMessage> {
    if (this.strategy === 'legacy-upload') {
      return this.legacyUpload(input);
    }

    try {
      const message = await this.mediaConfirmUpload(input);
      this.strategy = 'media-confirm';
      return message;
    } catch (error) {
      if (this.strategy === 'media-confirm' || !isMissingRoute(error)) {
        throw error;
      }
      const message = await this.legacyUpload(input);
      this.strategy = 'legacy-upload';
      return message;
    }
  }

  /** Rocket.Chat 7.x and later: stage the bytes, then turn them into a message. */
  private async mediaConfirmUpload(input: UploadInput): Promise<RcMessage> {
    const staged = await this.http.request<{ file: { _id: string; url: string } }>(
      `rooms.media/${encodeURIComponent(input.roomId)}`,
      {
        method: 'POST',
        formData: buildFileForm(input),
        credentials: this.credentials,
      },
    );

    const confirmed = await this.post<{ message: RcMessage }>(
      `rooms.mediaConfirm/${encodeURIComponent(input.roomId)}/${encodeURIComponent(staged.file._id)}`,
      {
        ...(input.description ? { description: input.description } : {}),
        ...(input.text ? { msg: input.text } : {}),
        ...(input.threadId ? { tmid: input.threadId } : {}),
        ...(input.showInMainChannel ? { tshow: true } : {}),
      },
    );

    return confirmed.message;
  }

  /** Rocket.Chat 6.x: one multipart request carrying both bytes and message fields. */
  private async legacyUpload(input: UploadInput): Promise<RcMessage> {
    const form = buildFileForm(input);
    if (input.description) form.set('description', input.description);
    if (input.text) form.set('msg', input.text);
    if (input.threadId) form.set('tmid', input.threadId);
    if (input.showInMainChannel) form.set('tshow', 'true');

    const response = await this.http.request<{ message: RcMessage }>(
      `rooms.upload/${encodeURIComponent(input.roomId)}`,
      {
        method: 'POST',
        formData: form,
        credentials: this.credentials,
      },
    );

    return response.message;
  }
}

const buildFileForm = (input: UploadInput): FormData => {
  const form = new FormData();
  const blob =
    input.content instanceof Blob ? input.content : new Blob([copyBytes(input.content)], { type: input.contentType });

  form.set('file', blob, input.filename);
  return form;
};

/** Distinguishes "this server has no such route" from a genuine upload failure. */
const isMissingRoute = (error: unknown): boolean =>
  error instanceof RocketChatApiError && (error.isUnknownEndpoint || error.status === 404 || error.status === 405);
