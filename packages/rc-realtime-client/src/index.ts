export { DdpClient } from './ddp.js';
export type { DdpClientOptions, DdpConnectionState, DdpLogger, StreamEvent } from './ddp.js';

export { RocketChatRealtimeClient, toWebSocketUrl } from './realtime.js';
export type {
  RealtimeClientOptions,
  RealtimeLoginResult,
  DesktopNotificationEvent,
  PresenceEvent,
  PresenceStatus,
  SubscriptionChangeAction,
  TypingEvent,
} from './realtime.js';

export { DdpConnectionError, DdpMethodError, DDP_VERSION, DDP_SUPPORTED_VERSIONS } from './protocol.js';
export type * from './protocol.js';

export { Emitter } from './emitter.js';
export type { Unsubscribe } from './emitter.js';
