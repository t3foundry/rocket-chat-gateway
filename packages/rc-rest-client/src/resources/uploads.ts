import { RocketChatApiError } from '../errors.js';
import type { RcMessage } from '../types.js';
import { AuthenticatedResource } from './base.js';
import { encodeMultipart } from './multipart.js';

export interface UploadInput {
  roomId: string;
  filename: string;
  contentType: string;
  /**
   * The file. An async iterable is forwarded as it arrives rather than held,
   * which is what lets a caller relay somebody else's upload without buffering
   * it — and what makes the sender's own progress reflect the whole journey
   * instead of only the hop into the relay.
   */
  content: Uint8Array | AsyncIterable<Uint8Array>;
  /** Caption rendered under the attachment. */
  description?: string;
  /** Message text posted alongside the file. */
  text?: string;
  threadId?: string;
  showInMainChannel?: boolean;
  /**
   * Abandons the upload. A caller relaying a browser's request passes the
   * signal for that request, so a file taken back mid-flight stops here too
   * rather than landing in the room after the sender let go of it.
   */
  signal?: AbortSignal;
  /**
   * Read after the file has gone up, for message fields that only arrive once
   * the body has been drained — a multipart request whose trailing parts sit
   * behind the file. Merged over whatever was passed in directly.
   *
   * Only consulted by the two-phase route, which posts the message separately;
   * the single-request route has to write its fields alongside the bytes, so
   * anything not known before the upload starts cannot reach it.
   */
  lateFields?: () => { description?: string; text?: string; threadId?: string };
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
    // A streamed file cannot be sent twice: by the time the first attempt
    // fails, the bytes have been read and there is nothing left to replay. So
    // the route is settled before the file is touched rather than by trying
    // one and falling back — see `detectStrategy`.
    if (this.strategy === undefined) {
      this.strategy = await this.detectStrategy(input.roomId, input.signal);
    }

    return this.strategy === 'legacy-upload' ? this.legacyUpload(input) : this.mediaConfirmUpload(input);
  }

  /**
   * Asks whether `rooms.media` exists, without uploading anything.
   *
   * The route rejects a request with no `file` part before it looks at
   * anything else, so a deliberately empty body is answered with
   * `error-no-file` where the route exists and with `unknown-endpoint` or a
   * 404 where it does not. Nothing is stored either way, which is what makes
   * this safe to run against a real room.
   */
  private async detectStrategy(roomId: string, signal: AbortSignal | undefined): Promise<UploadStrategy> {
    const probe = encodeMultipart(undefined, { probe: '1' });

    try {
      await this.http.request(`rooms.media/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        stream: probe,
        credentials: this.credentials,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isMissingRoute(error)) return 'legacy-upload';
    }

    // Anything else — the expected `error-no-file`, a permission refusal, a
    // rate limit — came from the route itself, so the route is there.
    return 'media-confirm';
  }

  /** Rocket.Chat 7.x and later: stage the bytes, then turn them into a message. */
  private async mediaConfirmUpload(input: UploadInput): Promise<RcMessage> {
    const file = encodeMultipart({
      field: 'file',
      filename: input.filename,
      contentType: input.contentType,
      content: input.content,
    });

    const staged = await this.http.request<{ file: { _id: string; url: string } }>(
      `rooms.media/${encodeURIComponent(input.roomId)}`,
      {
        method: 'POST',
        stream: file,
        credentials: this.credentials,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    const late = input.lateFields?.() ?? {};
    const description = input.description ?? late.description;
    const text = input.text ?? late.text;
    const threadId = input.threadId ?? late.threadId;

    const confirmed = await this.post<{ message: RcMessage }>(
      `rooms.mediaConfirm/${encodeURIComponent(input.roomId)}/${encodeURIComponent(staged.file._id)}`,
      {
        ...(description ? { description } : {}),
        ...(text ? { msg: text } : {}),
        ...(threadId ? { tmid: threadId } : {}),
        ...(input.showInMainChannel ? { tshow: true } : {}),
      },
      // Carries no bytes, but this is where Rocket.Chat reads the staged file:
      // it generates thumbnails, runs the upload hooks and creates the message.
      // Abandoning it on the ordinary timeout would also strand the staged
      // file, which is only cleaned up 24 hours later.
      { timeoutMs: this.http.uploadTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) },
    );

    return confirmed.message;
  }

  /** Rocket.Chat 6.x: one multipart request carrying both bytes and message fields. */
  private async legacyUpload(input: UploadInput): Promise<RcMessage> {
    const fields: Record<string, string> = {};
    if (input.description) fields.description = input.description;
    if (input.text) fields.msg = input.text;
    if (input.threadId) fields.tmid = input.threadId;
    if (input.showInMainChannel) fields.tshow = 'true';

    const encoded = encodeMultipart(
      { field: 'file', filename: input.filename, contentType: input.contentType, content: input.content },
      fields,
    );

    const response = await this.http.request<{ message: RcMessage }>(
      `rooms.upload/${encodeURIComponent(input.roomId)}`,
      {
        method: 'POST',
        stream: encoded,
        credentials: this.credentials,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    return response.message;
  }
}

/** Distinguishes "this server has no such route" from a genuine upload failure. */
const isMissingRoute = (error: unknown): boolean =>
  error instanceof RocketChatApiError && (error.isUnknownEndpoint || error.status === 404 || error.status === 405);
