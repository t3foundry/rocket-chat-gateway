import type { AdapterContext } from '@open-rocket-chat/rc-adapter';
import { RocketChatRestClient, type RocketChatUserClient, type UploadStrategy } from '@open-rocket-chat/rc-rest-client';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig, type ServerConfig } from '../config/configuration';
import type { ServerSession } from '../session/session.types';

const GATEWAY_USER_AGENT = 'open-rocket-chat-gateway';

/**
 * Owns the connection details for every configured Rocket.Chat server and
 * hands out clients bound to a session's credentials.
 */
@Injectable()
export class RocketChatService {
  private readonly clients = new Map<string, RocketChatRestClient>();

  /**
   * Which upload API each server speaks. Detected on the first upload and
   * reused, so only one request per server ever pays the probe.
   */
  private readonly uploadStrategies = new Map<string, UploadStrategy>();

  private readonly versions = new Map<string, string | null>();

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RocketChatService.name);
  }

  get servers(): ServerConfig[] {
    return this.config.servers;
  }

  get defaultServerId(): string {
    return this.config.defaultServerId;
  }

  server(serverId: string): ServerConfig {
    const server = this.config.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw ApiException.localized('bad_request', 'unknownServer', { variables: { serverId } });
    }
    return server;
  }

  /** Public-facing base URL, for deep links rendered in the client. */
  publicUrl(serverId: string): string {
    const server = this.server(serverId);
    return server.publicUrl ?? server.url;
  }

  restClient(serverId: string): RocketChatRestClient {
    const existing = this.clients.get(serverId);
    if (existing) return existing;

    const server = this.server(serverId);
    const client = new RocketChatRestClient({
      baseUrl: server.url,
      userAgent: GATEWAY_USER_AGENT,
      onRetry: ({ attempt, delayMs, reason, path }) => {
        this.logger.warn({ serverId, attempt, delayMs, reason, path }, 'retrying Rocket.Chat request');
      },
    });

    this.clients.set(serverId, client);
    return client;
  }

  /** A client carrying the session's Rocket.Chat credentials. */
  userClient(session: ServerSession): RocketChatUserClient {
    const client = this.restClient(session.serverId).as({
      userId: session.rocketChatUserId,
      authToken: session.rocketChatAuthToken,
    });

    client.uploadStrategy = this.uploadStrategies.get(session.serverId);
    return client;
  }

  /** Records the strategy the client discovered so later uploads skip the probe. */
  rememberUploadStrategy(serverId: string, client: RocketChatUserClient): void {
    const strategy = client.uploadStrategy;
    if (strategy && this.uploadStrategies.get(serverId) !== strategy) {
      this.logger.info({ serverId, strategy }, 'detected Rocket.Chat upload strategy');
      this.uploadStrategies.set(serverId, strategy);
    }
  }

  async version(serverId: string): Promise<string | null> {
    if (this.versions.has(serverId)) {
      return this.versions.get(serverId) ?? null;
    }

    try {
      const version = await this.restClient(serverId).version();
      this.versions.set(serverId, version);
      return version;
    } catch (error) {
      // Version is informational; a server that hides it must not break login.
      this.logger.debug({ serverId, err: error }, 'could not read Rocket.Chat version');
      this.versions.set(serverId, null);
      return null;
    }
  }

  /**
   * Media URLs point back at the gateway rather than at Rocket.Chat: the
   * browser has no Rocket.Chat token, so it could not fetch protected files
   * directly even if it knew where they lived.
   */
  adapterContext(session: ServerSession): AdapterContext {
    return {
      currentUserId: session.rocketChatUserId,
      currentUsername: session.username,
      avatarUrl: (username, etag) =>
        `/api/v1/avatars/${encodeURIComponent(username)}${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`,
      roomAvatarUrl: (roomId, etag) =>
        `/api/v1/avatars/room/${encodeURIComponent(roomId)}?etag=${encodeURIComponent(etag)}`,
      fileUrl: (path) => `/api/v1/files${path.startsWith('/') ? path : `/${path}`}`,
    };
  }
}
