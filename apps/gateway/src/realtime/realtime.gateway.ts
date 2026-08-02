import { ClientCommandSchema, REALTIME_PATH, type ServerEvent } from '@open-rocket-chat/api-contract';
import { HttpAdapterHost } from '@nestjs/core';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { PinoLogger } from 'nestjs-pino';
import { WebSocket, WebSocketServer } from 'ws';

import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
import { SessionService } from '../session/session.service';
import { toServerSession, type SessionRecord } from '../session/session.types';
import { RealtimeRegistry } from './realtime.registry';
import type { UpstreamConnection } from './upstream-connection';

const HEARTBEAT_INTERVAL_MS = 30_000;
/** Guards against a client flooding the gateway with commands. */
const MAX_MESSAGE_BYTES = 16 * 1024;

/** One of the session's Rocket.Chat servers, as seen by a single browser socket. */
interface AttachedServer {
  serverId: string;
  connection: UpstreamConnection;
  /** Registry key, needed to release exactly this upstream on teardown. */
  key: string;
  /** Rooms this socket watches on this server. Room ids repeat across servers. */
  rooms: Set<string>;
}

interface ClientState {
  session: SessionRecord;
  /** Keyed by server id; a socket is attached to every server at once. */
  servers: Map<string, AttachedServer>;
  sink: (event: ServerEvent) => void;
  alive: boolean;
}

/**
 * The browser-facing realtime endpoint.
 *
 * Deliberately hand-rolled on `ws` rather than `@nestjs/websockets`: the
 * upgrade has to be authenticated from a cookie before any adapter-level
 * machinery runs, and the protocol is a plain JSON event stream with no need
 * for room/namespace abstractions.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: WebSocketServer;

  private heartbeat?: NodeJS.Timeout;

  private readonly clients = new Map<WebSocket, ClientState>();

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
    private readonly registry: RealtimeRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RealtimeGateway.name);
  }

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;

    this.server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

    httpServer.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    this.heartbeat = setInterval(() => this.sweepDeadSockets(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();

    this.logger.info({ path: REALTIME_PATH }, 'realtime endpoint ready');
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const server = this.server;
    if (!server) return;

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== REALTIME_PATH) {
      // Another handler may own this path; closing it here would break them.
      return;
    }

    // Browsers cannot set headers on a WebSocket handshake, so the session
    // cookie is the only credential available at upgrade time.
    const session = await this.resolveSession(request);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this.isAllowedOrigin(request.headers.origin)) {
      // Without this check any site could open an authenticated socket using
      // the visitor's cookie; the same-origin policy does not cover WebSockets.
      this.logger.warn({ origin: request.headers.origin }, 'rejected websocket upgrade from disallowed origin');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    server.handleUpgrade(request, socket, head, (client) => {
      void this.registerClient(client, session);
    });
  }

  private async resolveSession(request: IncomingMessage): Promise<SessionRecord | null> {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return null;

    const raw = parseCookie(cookieHeader, this.sessions.cookieName);
    const sessionId = this.sessions.verify(raw);
    if (!sessionId) return null;

    return this.sessions.get(sessionId);
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    // Non-browser clients (mobile, CLI) send no Origin at all.
    if (!origin) return true;
    return this.config.corsOrigins.includes(origin);
  }

  /**
   * Attaches one browser socket to every server the session is signed in to.
   *
   * Multiplexing rather than a socket per server: the browser limits how many
   * it will hold open, and events are already tagged with the server they came
   * from, so one is enough.
   */
  private async registerClient(client: WebSocket, session: SessionRecord): Promise<void> {
    // The socket is already open by the time this runs, and establishing the
    // upstream connection below is asynchronous. A client that subscribes
    // immediately on `open` — the obvious thing to do — would otherwise have
    // its frames dropped on the floor and silently receive no events.
    const early: unknown[] = [];
    const bufferEarly = (data: unknown): void => {
      early.push(data);
    };
    client.on('message', bufferEarly);

    const sink = (event: ServerEvent): void => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    };

    // One server failing must not cost the client the others, so each is
    // attached independently and failures are reported rather than thrown.
    const attached = await Promise.all(
      session.connections.map(async (connection) => {
        const scoped = toServerSession(session, connection);
        const key = RealtimeRegistry.key(scoped);

        try {
          return {
            serverId: connection.serverId,
            connection: await this.registry.acquire(scoped),
            key,
            rooms: new Set<string>(),
          } satisfies AttachedServer;
        } catch (error) {
          this.logger.warn(
            { err: error, sessionId: session.id, serverId: connection.serverId },
            'could not establish upstream realtime connection',
          );
          return null;
        }
      }),
    );

    const servers = new Map(
      attached.filter((entry): entry is AttachedServer => entry !== null).map((entry) => [entry.serverId, entry]),
    );

    if (servers.size === 0) {
      client.off('message', bufferEarly);
      client.close(1011, 'upstream unavailable');
      return;
    }

    // The socket may have gone away while the handshakes were running.
    if (client.readyState !== WebSocket.OPEN) {
      client.off('message', bufferEarly);
      for (const entry of servers.values()) this.registry.release(entry.key);
      return;
    }

    const state: ClientState = { session, servers, sink, alive: true };
    this.clients.set(client, state);

    for (const entry of servers.values()) {
      entry.connection.attach(sink);
      // One ready event per server: the client learns which of them are live.
      sink(entry.connection.readyEvent());
    }

    client.off('message', bufferEarly);
    client.on('message', (data) => this.handleMessage(client, state, data));

    for (const buffered of early) {
      this.handleMessage(client, state, buffered);
    }
    client.on('pong', () => {
      state.alive = true;
    });
    client.on('close', () => this.teardownClient(client));
    client.on('error', (error) => {
      this.logger.debug({ err: error, sessionId: session.id }, 'client socket error');
      this.teardownClient(client);
    });
  }

  private handleMessage(client: WebSocket, state: ClientState, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }

    const command = ClientCommandSchema.safeParse(parsed);
    if (!command.success) {
      this.logger.debug({ sessionId: state.session.id }, 'discarding malformed realtime command');
      return;
    }

    if (command.data.type === 'ping') {
      client.pong();
      return;
    }

    // Room ids are only unique within one Rocket.Chat server, so a command
    // without a server this session is attached to is dropped rather than
    // guessed at.
    const target = state.servers.get(command.data.serverId);
    if (!target) {
      this.logger.debug(
        { sessionId: state.session.id, serverId: command.data.serverId },
        'realtime command for a server this socket is not attached to',
      );
      return;
    }

    switch (command.data.type) {
      case 'room.subscribe': {
        const { roomId } = command.data;
        // Idempotent per socket: a client that re-subscribes after a reconnect
        // must not inflate the upstream refcount and leak the subscription.
        if (target.rooms.has(roomId)) return;
        target.rooms.add(roomId);
        target.connection.subscribeRoom(roomId);
        return;
      }

      case 'room.unsubscribe': {
        const { roomId } = command.data;
        if (!target.rooms.delete(roomId)) return;
        target.connection.unsubscribeRoom(roomId);
        return;
      }

      case 'typing.set': {
        // Only for rooms this socket actually opened, so a client cannot
        // broadcast typing into arbitrary rooms.
        if (!target.rooms.has(command.data.roomId)) return;
        target.connection.setTyping(command.data.roomId, command.data.typing);
        return;
      }
    }
  }

  private teardownClient(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;

    this.clients.delete(client);

    for (const entry of state.servers.values()) {
      entry.connection.detach(state.sink);
      for (const roomId of entry.rooms) entry.connection.unsubscribeRoom(roomId);
      entry.rooms.clear();
      this.registry.release(entry.key);
    }
    state.servers.clear();
  }

  /** Drops sockets that stopped answering pings, e.g. after a laptop suspend. */
  private sweepDeadSockets(): void {
    for (const [client, state] of this.clients) {
      if (!state.alive) {
        client.terminate();
        this.teardownClient(client);
        continue;
      }

      state.alive = false;
      client.ping();
    }
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);

    for (const client of [...this.clients.keys()]) {
      client.close(1001, 'gateway shutting down');
      this.teardownClient(client);
    }

    this.server?.close();
  }
}

const parseCookie = (header: string, name: string): string | undefined => {
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
};
