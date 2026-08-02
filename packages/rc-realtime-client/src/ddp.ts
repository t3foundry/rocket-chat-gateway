import { Emitter, type Unsubscribe } from './emitter.js';
import {
  DDP_SUPPORTED_VERSIONS,
  DDP_VERSION,
  DdpConnectionError,
  DdpMethodError,
  type DdpIncomingFrame,
  type DdpOutgoingFrame,
} from './protocol.js';

export interface DdpLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: DdpLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DdpClientOptions {
  /** Full WebSocket URL including the `/websocket` path. */
  url: string;
  /** Defaults to the platform `WebSocket`. Node 22+ and every browser ship one. */
  webSocketImpl?: typeof WebSocket;
  logger?: DdpLogger;
  /**
   * Runs after the DDP handshake but before queued frames are flushed and
   * subscriptions are restored. This is where re-authentication belongs:
   * Rocket.Chat drops the socket's identity on reconnect and rejects
   * user-scoped subscriptions issued before the resume login lands.
   */
  onHandshake?: (client: DdpClient, reconnected: boolean) => Promise<void>;
  connectTimeoutMs?: number;
  methodTimeoutMs?: number;
  /** Interval between client-initiated pings. Set to 0 to rely on server pings alone. */
  heartbeatIntervalMs?: number;
  reconnect?: {
    enabled?: boolean;
    minDelayMs?: number;
    maxDelayMs?: number;
    /** `Infinity` by default: a gateway should keep trying until told to stop. */
    maxAttempts?: number;
  };
}

export type DdpConnectionState = 'idle' | 'connecting' | 'connected' | 'closed';

export interface StreamEvent {
  collection: string;
  eventName: string;
  args: unknown[];
}

interface DdpClientEvents extends Record<string, unknown> {
  connected: { session: string; reconnected: boolean };
  disconnected: { code: number; reason: string; willReconnect: boolean };
  error: { error: Error };
  /** Every `changed` frame belonging to a Rocket.Chat stream publication. */
  stream: StreamEvent;
  stateChanged: { state: DdpConnectionState };
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  /** Stable across reconnects; the DDP `id` is not. */
  token: string;
  name: string;
  params: unknown[];
  ddpId?: string;
  ready: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_METHOD_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const HEARTBEAT_GRACE_MS = 10_000;

/**
 * Low-level DDP client: framing, method calls, subscriptions, heartbeat and
 * reconnection. It knows nothing about Rocket.Chat's specific streams — that
 * lives in {@link RocketChatRealtimeClient}.
 */
export class DdpClient extends Emitter<DdpClientEvents> {
  private socket?: WebSocket;

  private state: DdpConnectionState = 'idle';

  private sessionId?: string;

  private nextId = 0;

  private readonly pendingCalls = new Map<string, PendingCall>();

  private readonly subscriptions = new Map<string, ActiveSubscription>();

  /** Frames produced before the handshake completes, replayed on `connected`. */
  private readonly outboundQueue: DdpOutgoingFrame[] = [];

  private connectPromise?: { resolve: () => void; reject: (error: Error) => void };

  private connectTimer?: ReturnType<typeof setTimeout>;

  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private heartbeatDeadline?: ReturnType<typeof setTimeout>;

  private reconnectAttempts = 0;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Set by `close()` so an in-flight reconnect does not resurrect the client. */
  private disposed = false;

  /** Set when the server rejected our identity; no amount of retrying fixes that. */
  private authRejected = false;

  /** Distinguishes the first handshake from every later one, for the reconnect path. */
  private hasConnectedBefore = false;

  private readonly logger: DdpLogger;

  private readonly webSocketImpl: typeof WebSocket;

  constructor(private readonly options: DdpClientOptions) {
    super();
    this.logger = options.logger ?? noopLogger;

    const impl = options.webSocketImpl ?? globalThis.WebSocket;
    if (!impl) {
      throw new DdpConnectionError(
        'No WebSocket implementation found. Pass `webSocketImpl` (for example the `ws` package) on Node < 22.',
      );
    }
    this.webSocketImpl = impl;
  }

  get connectionState(): DdpConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get session(): string | undefined {
    return this.sessionId;
  }

  /** Resolves once the DDP handshake completes, not merely when the socket opens. */
  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    if (this.disposed) throw new DdpConnectionError('This DDP client has been closed');

    if (this.connectPromise) {
      // A concurrent caller is already connecting; ride along with it.
      return new Promise<void>((resolve, reject) => {
        const offConnected = this.once('connected', () => {
          offError();
          resolve();
        });
        const offError = this.once('error', ({ error }) => {
          offConnected();
          reject(error);
        });
      });
    }

    return this.openSocket(false);
  }

  private openSocket(isReconnect: boolean): Promise<void> {
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };

      let socket: WebSocket;
      try {
        socket = new this.webSocketImpl(this.options.url);
      } catch (error) {
        this.failConnect(new DdpConnectionError(`Unable to open WebSocket: ${(error as Error).message}`));
        return;
      }

      this.socket = socket;

      this.connectTimer = setTimeout(() => {
        this.failConnect(new DdpConnectionError('Timed out waiting for the DDP handshake'));
        // Force the socket shut so the close handler drives reconnection.
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        this.logger.debug('ddp socket open', { url: this.options.url, isReconnect });
        this.sendFrame({ msg: 'connect', version: DDP_VERSION, support: DDP_SUPPORTED_VERSIONS }, true);
      });

      socket.addEventListener('message', (event: MessageEvent) => {
        this.handleRawMessage(event.data);
      });

      socket.addEventListener('error', () => {
        // The browser/undici error event carries no useful detail; the close
        // event that follows has the code we actually report.
        this.logger.warn('ddp socket error', { url: this.options.url });
      });

      socket.addEventListener('close', (event: CloseEvent) => {
        this.handleClose(event.code, event.reason);
      });
    });
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string') return;

    let frame: DdpIncomingFrame;
    try {
      frame = JSON.parse(data) as DdpIncomingFrame;
    } catch {
      this.logger.warn('discarding non-JSON DDP frame');
      return;
    }

    switch (frame.msg) {
      case 'connected':
        this.handleConnected(frame.session);
        break;

      case 'failed':
        this.failConnect(new DdpConnectionError(`Server requires DDP version ${frame.version}`));
        break;

      case 'ping':
        this.sendFrame({ msg: 'pong', ...(frame.id ? { id: frame.id } : {}) }, true);
        break;

      case 'pong':
        this.clearHeartbeatDeadline();
        break;

      case 'result':
        this.handleResult(frame.id, frame.result, frame.error);
        break;

      case 'ready':
        for (const id of frame.subs) {
          const subscription = this.findSubscriptionByDdpId(id);
          if (subscription) subscription.ready = true;
        }
        break;

      case 'nosub':
        this.handleNoSub(frame.id, frame.error);
        break;

      case 'changed':
        if (frame.fields?.eventName) {
          this.emit('stream', {
            collection: frame.collection,
            eventName: frame.fields.eventName,
            args: frame.fields.args ?? [],
          });
        }
        break;

      default:
        // `added`, `removed` and `updated` are collection bookkeeping we do not
        // use, because Rocket.Chat streams are published without collections.
        break;
    }
  }

  private handleConnected(session: string): void {
    this.sessionId = session;
    this.clearConnectTimer();

    const reconnected = this.hasConnectedBefore;
    this.hasConnectedBefore = true;

    // Marked connected before the handshake hook runs so that the hook's own
    // frames (the resume login) go out immediately instead of being queued.
    this.setState('connected');
    this.startHeartbeat();

    const finish = (): void => {
      // Reset only once the connection is genuinely usable. Clearing it on the
      // `connected` frame alone would restart the backoff on every attempt
      // whose handshake hook then fails, turning a rejected resume login into
      // a sub-second reconnect loop that Rocket.Chat answers by blocking the
      // gateway's IP.
      this.reconnectAttempts = 0;

      if (reconnected) this.resubscribeAll();
      this.flushQueue();

      this.connectPromise?.resolve();
      this.connectPromise = undefined;

      this.emit('connected', { session, reconnected });
    };

    const hook = this.options.onHandshake?.(this, reconnected);
    if (!hook) {
      finish();
      return;
    }

    hook.then(finish).catch((error: Error) => {
      // Credentials the server has rejected will be rejected again on the next
      // socket, so retrying only burns login attempts. Giving up surfaces the
      // failure to the caller, which can re-authenticate and build a new client.
      if (error instanceof DdpMethodError && error.isInvalidToken) {
        this.authRejected = true;
        this.logger.error('ddp authentication rejected; not reconnecting', { error: error.message });
      } else {
        this.logger.error('ddp handshake hook failed', { error: error.message });
      }

      this.failConnect(error);
      // Without a valid identity the socket is useless; closing it lets the
      // normal reconnect path retry with fresh credentials.
      try {
        this.socket?.close();
      } catch {
        /* already closing */
      }
    });
  }

  private handleResult(id: string, result: unknown, error?: DdpMethodError['ddpError']): void {
    const pending = this.pendingCalls.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingCalls.delete(id);

    if (error) {
      pending.reject(new DdpMethodError(error, pending.method));
    } else {
      pending.resolve(result);
    }
  }

  private handleNoSub(id: string, error?: DdpMethodError['ddpError']): void {
    const subscription = this.findSubscriptionByDdpId(id);
    if (!subscription) return;

    if (error) {
      this.logger.warn('subscription rejected', { name: subscription.name, reason: error.reason });
      this.emit('error', { error: new DdpMethodError(error, `sub:${subscription.name}`) });
    }

    // The server dropped it; keep the record so a reconnect retries it, but
    // clear the id so we do not match future frames against a dead id.
    subscription.ddpId = undefined;
    subscription.ready = false;
  }

  private findSubscriptionByDdpId(ddpId: string): ActiveSubscription | undefined {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.ddpId === ddpId) return subscription;
    }
    return undefined;
  }

  /**
   * Calls a Meteor method. Rocket.Chat exposes login, typing notifications and
   * a handful of operations that have no REST equivalent this way.
   */
  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (this.disposed) throw new DdpConnectionError('This DDP client has been closed');

    const id = this.allocateId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new DdpConnectionError(`DDP method \`${method}\` timed out`));
      }, this.options.methodTimeoutMs ?? DEFAULT_METHOD_TIMEOUT_MS);

      this.pendingCalls.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.sendFrame({ msg: 'method', method, params, id });
    });
  }

  /**
   * Subscribes to a Rocket.Chat stream. The returned token survives
   * reconnects: the client re-issues the subscription automatically, so
   * callers never have to re-subscribe from their own reconnect handler.
   */
  subscribe(name: string, params: unknown[]): string {
    const token = `sub:${name}:${this.allocateId()}`;
    const subscription: ActiveSubscription = { token, name, params, ready: false };
    this.subscriptions.set(token, subscription);
    this.sendSubscribe(subscription);
    return token;
  }

  unsubscribe(token: string): void {
    const subscription = this.subscriptions.get(token);
    if (!subscription) return;

    this.subscriptions.delete(token);
    if (subscription.ddpId) {
      this.sendFrame({ msg: 'unsub', id: subscription.ddpId });
    }
  }

  private sendSubscribe(subscription: ActiveSubscription): void {
    const ddpId = this.allocateId();
    subscription.ddpId = ddpId;
    subscription.ready = false;
    this.sendFrame({ msg: 'sub', id: ddpId, name: subscription.name, params: subscription.params });
  }

  /** Re-issues every live subscription after a reconnect. */
  private resubscribeAll(): void {
    for (const subscription of this.subscriptions.values()) {
      this.sendSubscribe(subscription);
    }
  }

  private sendFrame(frame: DdpOutgoingFrame, immediate = false): void {
    const socket = this.socket;
    const canSendNow = socket?.readyState === 1 && (immediate || this.state === 'connected');

    if (!canSendNow) {
      // Queue rather than throw: callers routinely subscribe while the
      // handshake is still in flight, and dropping those would lose events.
      this.outboundQueue.push(frame);
      return;
    }

    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.error('failed to send DDP frame', { error: String(error) });
      this.outboundQueue.push(frame);
    }
  }

  private flushQueue(): void {
    const queued = this.outboundQueue.splice(0, this.outboundQueue.length);
    for (const frame of queued) {
      this.sendFrame(frame, true);
    }
  }

  private allocateId(): string {
    this.nextId += 1;
    return String(this.nextId);
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();

    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    if (interval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'connected') return;

      this.sendFrame({ msg: 'ping' });
      // A silently half-open TCP connection looks identical to an idle one;
      // the missing pong is the only signal that we need to reconnect.
      this.heartbeatDeadline = setTimeout(() => {
        this.logger.warn('ddp heartbeat timed out, forcing reconnect');
        try {
          this.socket?.close();
        } catch {
          /* already closing */
        }
      }, HEARTBEAT_GRACE_MS);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearHeartbeatDeadline();
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = undefined;
  }

  // -------------------------------------------------------------------------
  // Teardown and reconnection
  // -------------------------------------------------------------------------

  private handleClose(code: number, reason: string): void {
    this.stopHeartbeat();
    this.clearConnectTimer();
    this.socket = undefined;

    const wasConnected = this.state === 'connected';
    const willReconnect = !this.disposed && (this.options.reconnect?.enabled ?? true) && this.canRetry();

    // In-flight calls can never complete on a dead socket, and leaving them
    // pending would hang the caller until the method timeout fires.
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new DdpConnectionError(`Connection closed before \`${pending.method}\` returned`));
      this.pendingCalls.delete(id);
    }

    for (const subscription of this.subscriptions.values()) {
      subscription.ddpId = undefined;
      subscription.ready = false;
    }

    this.setState(this.disposed ? 'closed' : 'idle');

    if (this.connectPromise) {
      this.failConnect(new DdpConnectionError(`WebSocket closed during handshake (${code} ${reason})`));
    }

    if (wasConnected || !this.disposed) {
      this.emit('disconnected', { code, reason, willReconnect });
    }

    if (willReconnect) {
      this.scheduleReconnect();
    }
  }

  private canRetry(): boolean {
    if (this.authRejected) return false;

    const maxAttempts = this.options.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY;
    return this.reconnectAttempts < maxAttempts;
  }

  private scheduleReconnect(): void {
    const minDelay = this.options.reconnect?.minDelayMs ?? 1_000;
    const maxDelay = this.options.reconnect?.maxDelayMs ?? 30_000;
    const exponential = Math.min(minDelay * 2 ** this.reconnectAttempts, maxDelay);
    // Jitter keeps a fleet of gateway instances from reconnecting in lockstep
    // and knocking the Rocket.Chat server over right after it recovers.
    const delay = exponential / 2 + Math.random() * (exponential / 2);

    this.reconnectAttempts += 1;
    this.logger.debug('scheduling ddp reconnect', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      if (this.disposed) return;

      // Subscriptions are restored inside `handleConnected`, after the
      // handshake hook has re-authenticated the socket.
      void this.openSocket(true).catch((error: Error) => {
        this.logger.warn('ddp reconnect failed', { error: error.message });
        this.emit('error', { error });
      });
    }, delay);
  }

  private failConnect(error: Error): void {
    this.clearConnectTimer();
    this.connectPromise?.reject(error);
    this.connectPromise = undefined;
    this.emit('error', { error });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private setState(state: DdpConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('stateChanged', { state });
  }

  /** Closes the connection permanently. The instance cannot be reconnected. */
  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.clearConnectTimer();
    this.subscriptions.clear();
    this.outboundQueue.length = 0;

    try {
      this.socket?.close();
    } catch {
      /* already closing */
    }
    this.socket = undefined;
    this.setState('closed');
    this.removeAllListeners();
  }

  /** Convenience for callers that only care about one stream key. */
  onStream(collection: string, eventName: string, handler: (args: unknown[]) => void): Unsubscribe {
    return this.on('stream', (event) => {
      if (event.collection === collection && event.eventName === eventName) {
        handler(event.args);
      }
    });
  }
}
