import { RocketChatApiError, RocketChatTransportError } from './errors.js';
import type { RcErrorEnvelope } from './types.js';

export interface RocketChatCredentials {
  userId: string;
  authToken: string;
}

export interface RestClientOptions {
  /** Base URL of the Rocket.Chat server, e.g. `https://chat.example.com`. */
  baseUrl: string;
  /** Injected for tests and for runtimes that proxy outbound traffic. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Defaults to 15s. */
  timeoutMs?: number;
  /**
   * Timeout for requests that carry file bytes. Defaults to 5 minutes.
   *
   * Uploads are the one call whose duration is set by the payload rather than
   * by how quickly Rocket.Chat answers, so the ordinary timeout is the wrong
   * measure entirely: a 60 MB file to a server across the internet spends half
   * a minute on the wire before the server has anything to respond to.
   */
  uploadTimeoutMs?: number;
  /** Retries for transient failures (429, 5xx, network). Defaults to 2. */
  maxRetries?: number;
  userAgent?: string;
  /** Extra headers sent on every request, e.g. a tracing header. */
  defaultHeaders?: Record<string, string>;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; path: string }) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** An array value is sent as repeated `key[]` parameters. */
  query?: Record<string, string | number | boolean | readonly string[] | undefined | null>;
  body?: unknown;
  /** Sent as-is; the caller is responsible for the `Content-Type`. */
  formData?: FormData;
  /**
   * A body written by the caller and sent as it is produced, for payloads too
   * large to hold. Never retried: the bytes are gone once read.
   */
  stream?: { contentType: string; body: AsyncIterable<Uint8Array> };
  credentials?: RocketChatCredentials;
  /** Merged over the client defaults; used for two-factor headers. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Retry even for non-idempotent verbs. Off by default: replaying a
   * `chat.sendMessage` that actually succeeded would duplicate the message.
   */
  retryOnFailure?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const API_PREFIX = '/api/v1';

const isRetriableStatus = (status: number): boolean => status === 429 || status === 408 || status >= 500;

/**
 * Hand-rolled rather than `ReadableStream.from`, which arrived too late to
 * assume: this package is also consumed by a browser build.
 *
 * One chunk is pulled per request, so the source only produces as fast as the
 * socket drains it. That backpressure is the point — without it a gateway
 * forwarding an upload would read the whole file into memory regardless of how
 * slowly the far end accepts it.
 */
const toReadableStream = (source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
};

const jitteredBackoff = (attempt: number): number => {
  const base = Math.min(2 ** attempt * 250, 4_000);
  return base + Math.random() * base * 0.25;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Rocket.Chat signals rate limiting with `Retry-After` in seconds, but omits it
 * on some deployments; fall back to the normal backoff curve when absent.
 */
const retryAfterMs = (response: Response, attempt: number): number => {
  const header = response.headers.get('retry-after');
  if (!header) return jitteredBackoff(attempt);
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1_000 : jitteredBackoff(attempt);
};

export class RocketChatHttp {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RestClientOptions) {
    // A trailing slash would produce `//api/v1/...`, which some reverse proxies
    // in front of Rocket.Chat reject outright.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new Error('No fetch implementation available; pass `fetch` in RestClientOptions');
    }
  }

  get serverUrl(): string {
    return this.baseUrl;
  }

  /**
   * The window a file-carrying request is given. Exposed so the two-phase
   * upload can put its second leg — which carries no bytes of its own, but
   * makes Rocket.Chat process the ones already staged — under the same clock.
   */
  get uploadTimeoutMs(): number {
    return this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  /** Builds an absolute URL for a Rocket.Chat path outside the v1 API (avatars, file downloads). */
  absoluteUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', retryOnFailure = method === 'GET' } = options;
    const maxRetries = retryOnFailure ? (this.options.maxRetries ?? DEFAULT_MAX_RETRIES) : 0;

    let attempt = 0;
    // Retries are bounded by maxRetries; the loop always exits via return or throw.
    for (;;) {
      try {
        const response = await this.performRequest(path, options);

        if (response.ok) {
          const parsed = await this.parseBody<T>(response);
          // Several Rocket.Chat routes answer 200 with `success: false` instead
          // of an error status, so a 2xx alone is not proof the call worked.
          this.assertEnvelopeSuccess(parsed, response.status);
          return parsed;
        }

        if (attempt < maxRetries && isRetriableStatus(response.status)) {
          const delayMs = retryAfterMs(response, attempt);
          this.options.onRetry?.({ attempt, delayMs, reason: `status ${response.status}`, path });
          await sleep(delayMs);
          attempt += 1;
          continue;
        }

        throw await this.toApiError(response);
      } catch (error) {
        if (error instanceof RocketChatApiError) throw error;

        const transportError = this.toTransportError(error);
        if (attempt < maxRetries && !transportError.timedOut) {
          const delayMs = jitteredBackoff(attempt);
          this.options.onRetry?.({ attempt, delayMs, reason: transportError.message, path });
          await sleep(delayMs);
          attempt += 1;
          continue;
        }

        throw transportError;
      }
    }
  }

  /**
   * Performs a request and hands back the untouched `Response`, so binary
   * payloads can be streamed rather than buffered. No retry: replaying a
   * partially consumed download stream is not something the caller can recover.
   */
  async requestRaw(path: string, options: RequestOptions = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.performRequest(path, options);
    } catch (error) {
      throw this.toTransportError(error);
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    return response;
  }

  private async performRequest(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `${API_PREFIX}/${path}`}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;

      // Rocket.Chat parses repeated parameters with `qs`, which needs the
      // bracket suffix to produce an array — `status=online&status=away`
      // arrives as the string `online,away` on some deployments.
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(`${key}[]`, String(entry));
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.defaultHeaders,
      ...options.headers,
    };

    if (this.options.userAgent) {
      headers['user-agent'] = this.options.userAgent;
    }

    if (options.credentials) {
      headers['x-user-id'] = options.credentials.userId;
      headers['x-auth-token'] = options.credentials.authToken;
    }

    let body: BodyInit | undefined;
    if (options.formData) {
      // Deliberately no Content-Type: fetch has to set the multipart boundary.
      body = options.formData;
    } else if (options.stream) {
      // The caller owns this one, boundary included — nothing else knows it.
      headers['content-type'] = options.stream.contentType;
      body = toReadableStream(options.stream.body);
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    // A file body is a file on its way up, and how long that takes is a
    // property of its size and of the link, not of the server's health. Timing
    // it like an ordinary call reports a slow upload as an unreachable
    // Rocket.Chat, which is both wrong and unactionable.
    const carriesFile = Boolean(options.formData ?? options.stream);
    const timeoutMs =
      options.timeoutMs ?? (carriesFile ? this.uploadTimeoutMs : (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    return this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal,
      redirect: 'follow',
      // Required for a streamed request body: it tells fetch the response may
      // begin before the request has finished being sent. Not in the DOM
      // typings, which still describe a body that is fully known up front.
      ...(options.stream ? ({ duplex: 'half' } as object) : {}),
    });
  }

  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RocketChatApiError(
        response.status,
        'Rocket.Chat returned a non-JSON body; the URL may point at a reverse proxy rather than the API',
        'invalid-json',
        text.slice(0, 512),
      );
    }
  }

  private assertEnvelopeSuccess(payload: unknown, status: number): void {
    if (typeof payload !== 'object' || payload === null) return;

    const envelope = payload as RcErrorEnvelope;
    if (envelope.success !== false && envelope.status !== 'error') return;

    throw new RocketChatApiError(
      status,
      envelope.error ?? envelope.message ?? 'Rocket.Chat reported an unsuccessful operation',
      envelope.errorType,
      envelope.details,
    );
  }

  private async toApiError(response: Response): Promise<RocketChatApiError> {
    let payload: RcErrorEnvelope | undefined;
    try {
      payload = (await response.clone().json()) as RcErrorEnvelope;
    } catch {
      payload = undefined;
    }

    const message = payload?.error ?? payload?.message ?? `Rocket.Chat request failed with HTTP ${response.status}`;

    return new RocketChatApiError(response.status, message, payload?.errorType, payload?.details);
  }

  private toTransportError(error: unknown): RocketChatTransportError {
    if (error instanceof RocketChatTransportError) return error;

    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

    return new RocketChatTransportError(
      timedOut ? 'Rocket.Chat request timed out' : `Rocket.Chat request failed: ${(error as Error)?.message ?? error}`,
      error,
      timedOut,
    );
  }
}
