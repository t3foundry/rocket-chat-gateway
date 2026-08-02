/**
 * Thrown for every non-2xx response and for well-formed responses carrying
 * `success: false`. Rocket.Chat is inconsistent about which of the two it uses
 * for the same logical failure, so callers should only ever branch on
 * `errorType` / `status`, never on the message text.
 */
export class RocketChatApiError extends Error {
  override readonly name = 'RocketChatApiError';

  constructor(
    readonly status: number,
    message: string,
    /** Stable-ish identifier such as `error-invalid-room` or `totp-required`. */
    readonly errorType?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** The user supplied valid credentials but must also present a 2FA code. */
  get isTotpRequired(): boolean {
    return this.errorType === 'totp-required' || this.errorType === 'error-totp-required';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * True when the server does not know this route at all — the signal used to
   * fall back to an older Rocket.Chat API shape.
   */
  get isUnknownEndpoint(): boolean {
    return this.status === 404 && this.errorType === 'unknown-endpoint';
  }
}

/** Network-level failure: DNS, TLS, connection refused, or the request timeout. */
export class RocketChatTransportError extends Error {
  override readonly name = 'RocketChatTransportError';

  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly timedOut = false,
  ) {
    super(message);
  }
}
