/**
 * One Rocket.Chat server a session is signed in to.
 *
 * The auth token lives here and nowhere else: that is the entire point of
 * running a gateway rather than talking to Rocket.Chat from the page.
 */
export interface SessionConnection {
  serverId: string;
  rocketChatUserId: string;
  rocketChatAuthToken: string;
  username: string;
  connectedAt: number;
}

/**
 * What the gateway keeps in exchange for the opaque cookie it hands the browser.
 *
 * A session holds several connections at once, so one client can work across
 * several Rocket.Chat servers and keep receiving events from all of them.
 */
export interface SessionRecord {
  id: string;
  /** Never empty: a session that loses its last connection is deleted. */
  connections: SessionConnection[];
  /** Used when a request carries no `X-Server-Id` header. */
  defaultServerId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A session resolved to one of its servers, which is what every request works
 * with.
 *
 * The field names deliberately match what a single-server session used to
 * carry, so services take this and never think about the multi-server shape.
 */
export interface ServerSession {
  /** The session id, shared by every server this session is connected to. */
  id: string;
  serverId: string;
  rocketChatUserId: string;
  rocketChatAuthToken: string;
  username: string;
}

export const toServerSession = (session: SessionRecord, connection: SessionConnection): ServerSession => ({
  id: session.id,
  serverId: connection.serverId,
  rocketChatUserId: connection.rocketChatUserId,
  rocketChatAuthToken: connection.rocketChatAuthToken,
  username: connection.username,
});

/** Finds the connection a request is scoped to, or `null` when there is none. */
export const connectionFor = (session: SessionRecord, serverId: string | undefined): SessionConnection | null => {
  const wanted = serverId ?? session.defaultServerId;
  return session.connections.find((connection) => connection.serverId === wanted) ?? null;
};

export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>;
  set(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** Called on shutdown; a Redis-backed store closes its connection here. */
  dispose(): Promise<void>;
}

export const SESSION_STORE = Symbol('SESSION_STORE');
