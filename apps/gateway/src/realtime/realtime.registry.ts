import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { RoomsService } from '../rooms/rooms.service';
import type { ServerSession } from '../session/session.types';
import { UpstreamConnection } from './upstream-connection';

interface RegistryEntry {
  connection: UpstreamConnection;
  /** Deferred teardown, armed once the last socket detaches. */
  idleTimer?: NodeJS.Timeout;
  /** Shared so concurrent sockets for one session await the same handshake. */
  starting: Promise<UpstreamConnection>;
}

/**
 * Owns the lifetime of upstream realtime connections, one per session.
 *
 * Connections outlive the sockets that use them for a short grace period: a
 * page reload would otherwise tear down the DDP connection and immediately pay
 * for a new handshake, login and resubscribe.
 */
@Injectable()
export class RealtimeRegistry implements OnModuleDestroy {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly rocketChat: RocketChatService,
    private readonly rooms: RoomsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RealtimeRegistry.name);
  }

  /**
   * One upstream per session *and* server.
   *
   * A session signed in to three Rocket.Chat servers holds three DDP
   * connections, all live at once — that is what keeps unread counts moving on
   * the servers the user is not currently looking at.
   */
  static key(session: ServerSession): string {
    return `${session.id}:${session.serverId}`;
  }

  async acquire(session: ServerSession): Promise<UpstreamConnection> {
    const key = RealtimeRegistry.key(session);
    const existing = this.entries.get(key);

    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      return existing.starting;
    }

    const connection = new UpstreamConnection(
      session,
      this.rocketChat.adapterContext(session),
      this.rocketChat.server(session.serverId).url,
      this.rooms,
      this.logger,
    );

    // A connection whose upstream identity was rejected can never recover, and
    // keeping it in the map would hand that dead link to every later socket for
    // this session.
    connection.onDead(() => {
      // Guarded on identity: by the time a dying connection reports in, the
      // key may already hold its replacement.
      if (this.entries.get(key)?.connection !== connection) return;

      this.logger.warn({ sessionId: session.id, serverId: session.serverId }, 'upstream realtime connection died');
      this.destroy(key);
    });

    const starting = connection
      .start()
      .then(() => {
        this.logger.info(
          { sessionId: session.id, serverId: session.serverId },
          'upstream realtime connection established',
        );
        return connection;
      })
      .catch((error: unknown) => {
        // A failed handshake must not leave a poisoned entry behind, or every
        // later socket for this session would await the same rejected promise.
        this.entries.delete(key);
        connection.dispose();
        throw error;
      });

    this.entries.set(key, { connection, starting });
    return starting;
  }

  /** Arms the idle timer; the connection is torn down only if nothing reattaches. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.connection.attachedCount > 0) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    if (this.config.realtimeIdleTimeoutMs === 0) {
      this.destroy(key);
      return;
    }

    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (current && current.connection.attachedCount === 0) {
        this.destroy(key);
      }
    }, this.config.realtimeIdleTimeoutMs);

    entry.idleTimer.unref?.();
  }

  /** Immediate teardown, used on logout and shutdown. */
  destroy(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.entries.delete(key);
    entry.connection.dispose();
    this.logger.info({ key }, 'upstream realtime connection closed');
  }

  onModuleDestroy(): void {
    for (const key of [...this.entries.keys()]) {
      this.destroy(key);
    }
  }
}
