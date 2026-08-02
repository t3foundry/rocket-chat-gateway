/**
 * The subset of DDP (Meteor's Distributed Data Protocol) that Rocket.Chat
 * actually uses. Full DDP has collection semantics we deliberately ignore:
 * Rocket.Chat streams are published with `useCollection: false`, so every
 * event arrives as a `changed` frame whose `fields.args` is the payload.
 */

export const DDP_VERSION = '1';
export const DDP_SUPPORTED_VERSIONS = ['1', 'pre2', 'pre1'];

export interface DdpConnectFrame {
  msg: 'connect';
  version: string;
  support: string[];
  session?: string;
}

export interface DdpConnectedFrame {
  msg: 'connected';
  session: string;
}

/** Sent when the server refuses our DDP version and names one it accepts. */
export interface DdpFailedFrame {
  msg: 'failed';
  version: string;
}

export interface DdpPingFrame {
  msg: 'ping';
  id?: string;
}

export interface DdpPongFrame {
  msg: 'pong';
  id?: string;
}

export interface DdpMethodFrame {
  msg: 'method';
  method: string;
  params: unknown[];
  id: string;
}

export interface DdpResultFrame {
  msg: 'result';
  id: string;
  result?: unknown;
  error?: DdpError;
}

/** Emitted after a method's data changes have been written; we do not need it. */
export interface DdpUpdatedFrame {
  msg: 'updated';
  methods: string[];
}

export interface DdpSubFrame {
  msg: 'sub';
  id: string;
  name: string;
  params: unknown[];
}

export interface DdpUnsubFrame {
  msg: 'unsub';
  id: string;
}

export interface DdpReadyFrame {
  msg: 'ready';
  subs: string[];
}

export interface DdpNoSubFrame {
  msg: 'nosub';
  id: string;
  error?: DdpError;
}

export interface DdpChangedFrame {
  msg: 'changed';
  collection: string;
  id: string;
  fields?: {
    /** The stream key this event belongs to, e.g. a room id. */
    eventName?: string;
    args?: unknown[];
  };
}

export interface DdpAddedFrame {
  msg: 'added';
  collection: string;
  id: string;
  fields?: Record<string, unknown>;
}

export interface DdpRemovedFrame {
  msg: 'removed';
  collection: string;
  id: string;
}

export interface DdpError {
  error: string | number;
  reason?: string;
  message?: string;
  errorType?: string;
  details?: unknown;
}

export type DdpIncomingFrame =
  | DdpConnectedFrame
  | DdpFailedFrame
  | DdpPingFrame
  | DdpPongFrame
  | DdpResultFrame
  | DdpUpdatedFrame
  | DdpReadyFrame
  | DdpNoSubFrame
  | DdpChangedFrame
  | DdpAddedFrame
  | DdpRemovedFrame;

export type DdpOutgoingFrame =
  DdpConnectFrame | DdpPingFrame | DdpPongFrame | DdpMethodFrame | DdpSubFrame | DdpUnsubFrame;

/** Raised when the server rejects a method call or a subscription. */
export class DdpMethodError extends Error {
  override readonly name = 'DdpMethodError';

  constructor(
    readonly ddpError: DdpError,
    readonly method: string,
  ) {
    super(ddpError.reason ?? ddpError.message ?? String(ddpError.error));
  }

  /**
   * Rocket.Chat's markers for an expired, revoked or orphaned resume token.
   *
   * `User not found` is the one a token outlives its user by — a deleted or
   * renamed account — and it is not a 403, so matching on the status alone
   * leaves the caller retrying a login that can never succeed.
   */
  get isInvalidToken(): boolean {
    return (
      this.ddpError.error === 403 ||
      INVALID_TOKEN_ERRORS.has(String(this.ddpError.error)) ||
      INVALID_TOKEN_REASONS.has(this.ddpError.reason ?? '')
    );
  }

  /**
   * Rocket.Chat blocking this IP or user after too many login attempts. Unlike
   * a bad token this clears on its own, so it is worth waiting out.
   */
  get isLoginRateLimited(): boolean {
    return LOGIN_RATE_LIMIT_ERRORS.has(String(this.ddpError.error));
  }
}

const INVALID_TOKEN_ERRORS = new Set(['error-invalid-user', 'error-invalid-token', 'error-user-not-found']);

const INVALID_TOKEN_REASONS = new Set([
  'You must be logged in to do this.',
  "You've been logged out by the server. Please log in again.",
  'User not found',
]);

const LOGIN_RATE_LIMIT_ERRORS = new Set([
  'error-login-blocked-for-ip',
  'error-login-blocked-for-user',
  'error-too-many-requests',
]);

export class DdpConnectionError extends Error {
  override readonly name = 'DdpConnectionError';
}
