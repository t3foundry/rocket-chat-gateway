import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
import { SESSION_STORE, type SessionConnection, type SessionRecord, type SessionStore } from './session.types';

@Injectable()
export class SessionService implements OnModuleDestroy {
  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(SESSION_STORE) private readonly store: SessionStore,
  ) {}

  get cookieName(): string {
    return this.config.session.cookieName;
  }

  /**
   * Adds a server connection, creating the session if there is not one yet.
   *
   * Signing in to a server that is already connected replaces its credentials
   * rather than duplicating it — that is what a re-login after an expired
   * upstream token looks like.
   */
  async connect(existing: SessionRecord | null, input: Omit<SessionConnection, 'connectedAt'>): Promise<SessionRecord> {
    const connection: SessionConnection = { ...input, connectedAt: Date.now() };

    const record: SessionRecord = existing
      ? {
          ...existing,
          connections: [...existing.connections.filter((entry) => entry.serverId !== connection.serverId), connection],
        }
      : {
          // 32 bytes of CSPRNG output: the session id is the only thing standing
          // between a guess and somebody else's Rocket.Chat tokens.
          id: randomBytes(32).toString('base64url'),
          connections: [connection],
          defaultServerId: connection.serverId,
          createdAt: Date.now(),
          expiresAt: Date.now() + this.config.session.ttlSeconds * 1_000,
        };

    await this.store.set(record);
    return record;
  }

  /**
   * Removes one server from a session, or ends it when that was the last one.
   *
   * Returns the surviving session, or `null` if it was deleted — the caller
   * needs to know whether to clear the cookie.
   */
  async disconnect(session: SessionRecord, serverId: string): Promise<SessionRecord | null> {
    const remaining = session.connections.filter((connection) => connection.serverId !== serverId);

    if (remaining.length === 0) {
      await this.store.delete(session.id);
      return null;
    }

    const record: SessionRecord = {
      ...session,
      connections: remaining,
      // The default must always point at a server still connected.
      defaultServerId:
        session.defaultServerId === serverId ? (remaining[0] as SessionConnection).serverId : session.defaultServerId,
    };

    await this.store.set(record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.store.get(id);
  }

  async destroy(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /**
   * The cookie value is `<id>.<hmac>`. Signing lets the gateway reject forged
   * ids without a store round-trip, and keeps a stolen cookie useless once the
   * signing secret is rotated.
   */
  sign(sessionId: string): string {
    return `${sessionId}.${this.hmac(sessionId)}`;
  }

  verify(cookieValue: string | undefined): string | null {
    if (!cookieValue) return null;

    const separator = cookieValue.lastIndexOf('.');
    if (separator <= 0) return null;

    const id = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    const expected = this.hmac(id);

    const provided = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    // `timingSafeEqual` throws on a length mismatch, which is itself a
    // non-constant-time signal, so the lengths are compared first.
    if (provided.length !== expectedBuffer.length) return null;

    return timingSafeEqual(provided, expectedBuffer) ? id : null;
  }

  attachCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(this.cookieName, this.sign(sessionId), this.cookieOptions());
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookieName, this.cookieOptions());
  }

  private cookieOptions() {
    return {
      // Unreadable from JavaScript: an XSS bug should not hand out the session.
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: this.config.session.sameSite,
      path: '/',
      maxAge: this.config.session.ttlSeconds,
      ...(this.config.session.domain ? { domain: this.config.session.domain } : {}),
    } as const;
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.config.session.secret).update(value).digest('base64url');
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.dispose();
  }
}
