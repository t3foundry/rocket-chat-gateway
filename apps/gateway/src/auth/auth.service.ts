import type { LoginRequest, OAuthLoginRequest, Session, ServerConnection } from '@open-rocket-chat/api-contract';
import type { LoginResult } from '@open-rocket-chat/rc-rest-client';
import { toMyProfile } from '@open-rocket-chat/rc-adapter';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { SessionService } from '../session/session.service';
import { toServerSession, type SessionConnection, type SessionRecord } from '../session/session.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly rocketChat: RocketChatService,
    private readonly sessions: SessionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  /**
   * Exchanges Rocket.Chat credentials for a server connection.
   *
   * When `existing` is supplied the connection joins that session instead of
   * starting a new one, which is how a client ends up signed in to several
   * Rocket.Chat servers at the same time. The upstream tokens stay server-side
   * in every case.
   */
  async login(
    request: LoginRequest,
    existing: SessionRecord | null,
  ): Promise<{ session: SessionRecord; body: Session }> {
    const serverId = request.serverId ?? this.rocketChat.defaultServerId;
    const client = this.rocketChat.restClient(serverId);

    let result: LoginResult;
    try {
      result = await client.login({
        user: request.user,
        password: request.password,
        ...(request.totpCode ? { totpCode: request.totpCode } : {}),
      });
    } catch (error) {
      // Log the username, never the password or the upstream error body, which
      // can echo the submitted credentials back on some Rocket.Chat versions.
      this.logger.info({ serverId, user: request.user }, 'login rejected by Rocket.Chat');
      throw toApiException(error);
    }

    return this.connect(serverId, result, existing, request.user);
  }

  /**
   * Finishes an OAuth sign-in.
   *
   * The provider handshake happened between the browser and Rocket.Chat, which
   * is the only party holding the client secret; what arrives here is the
   * credential pair Rocket.Chat parked for that attempt. Redeeming it yields
   * the same auth token a password would have, so everything downstream —
   * including joining an existing multi-server session — is unchanged.
   */
  async loginWithOAuth(
    request: OAuthLoginRequest,
    existing: SessionRecord | null,
  ): Promise<{ session: SessionRecord; body: Session }> {
    const serverId = request.serverId ?? this.rocketChat.defaultServerId;

    let result: LoginResult;
    try {
      result = await this.rocketChat.restClient(serverId).loginWithOAuth({
        credentialToken: request.credentialToken,
        credentialSecret: request.credentialSecret,
      });
    } catch (error) {
      // The credential pair is single-use and short-lived upstream, so the
      // usual cause is a replayed or expired attempt rather than a bad user.
      this.logger.info({ serverId }, 'OAuth login rejected by Rocket.Chat');
      throw toApiException(error);
    }

    return this.connect(serverId, result, existing);
  }

  /** Turns a redeemed Rocket.Chat login into a session connection. */
  private async connect(
    serverId: string,
    result: LoginResult,
    existing: SessionRecord | null,
    fallbackUsername?: string,
  ): Promise<{ session: SessionRecord; body: Session }> {
    const session = await this.sessions.connect(existing, {
      serverId,
      rocketChatUserId: result.userId,
      rocketChatAuthToken: result.authToken,
      username: result.me.username ?? fallbackUsername ?? result.userId,
    });

    this.logger.info(
      { serverId, userId: result.userId, sessionId: session.id, servers: session.connections.length },
      'server connected',
    );

    return { session, body: await this.describe(session) };
  }

  /**
   * Re-reads every connection's profile, so a session survives a name or
   * avatar change upstream.
   *
   * A server that has become unreachable is dropped from the response rather
   * than failing the whole call: one unavailable Rocket.Chat must not stop
   * somebody using the others.
   */
  async describe(session: SessionRecord): Promise<Session> {
    const connections = await Promise.all(
      session.connections.map(async (connection) => this.describeConnection(session, connection)),
    );

    const usable = connections.filter((entry): entry is ServerConnection => entry !== null);

    if (usable.length === 0) {
      throw toApiException(new Error('no reachable server connections'));
    }

    return {
      connections: usable,
      defaultServerId: session.defaultServerId,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private async describeConnection(
    session: SessionRecord,
    connection: SessionConnection,
  ): Promise<ServerConnection | null> {
    const scoped = toServerSession(session, connection);

    try {
      const me = await this.rocketChat.userClient(scoped).users.me();
      const server = this.rocketChat.server(connection.serverId);

      return {
        user: toMyProfile(me, this.rocketChat.adapterContext(scoped)),
        server: {
          id: server.id,
          name: server.name,
          baseUrl: this.rocketChat.publicUrl(server.id),
          version: await this.rocketChat.version(server.id),
        },
      };
    } catch (error) {
      this.logger.warn(
        { err: error, serverId: connection.serverId, sessionId: session.id },
        'dropping unreachable server connection from the session description',
      );
      return null;
    }
  }

  /**
   * Signs out of one server, or all of them.
   *
   * Returns the surviving session, or `null` when the last connection went and
   * the session itself was destroyed.
   */
  async logout(session: SessionRecord, serverId?: string): Promise<SessionRecord | null> {
    const targets = serverId
      ? session.connections.filter((connection) => connection.serverId === serverId)
      : session.connections;

    for (const connection of targets) {
      try {
        // Best effort: invalidating the upstream token is desirable but must
        // not stop the local connection from being dropped.
        await this.rocketChat.userClient(toServerSession(session, connection)).users.logout();
      } catch (error) {
        this.logger.warn({ err: error, serverId: connection.serverId }, 'upstream logout failed');
      }
    }

    if (!serverId) {
      await this.sessions.destroy(session.id);
      return null;
    }

    return this.sessions.disconnect(session, serverId);
  }
}
