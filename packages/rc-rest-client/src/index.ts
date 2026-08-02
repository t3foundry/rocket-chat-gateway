export { RocketChatRestClient, RocketChatUserClient } from './client.js';
export type { LoginParams, LoginResult } from './client.js';

export { RocketChatHttp } from './http.js';
export type { RestClientOptions, RequestOptions, RocketChatCredentials } from './http.js';

export { RocketChatApiError, RocketChatTransportError } from './errors.js';

export { RoomsResource } from './resources/rooms.js';
export type {
  RoomsSyncResult,
  SubscriptionsSyncResult,
  RcNotificationPreferences,
  CleanHistoryOptions,
} from './resources/rooms.js';

export { ChatResource, normaliseEmoji } from './resources/chat.js';
export type { HistoryOptions, SendMessageOptions } from './resources/chat.js';

export { UsersResource } from './resources/users.js';

export { SettingsResource, toSettingsMap } from './resources/settings.js';
export type { RcSetting, RcPermission } from './resources/settings.js';

export { EmojiResource } from './resources/emoji.js';
export type { RcCustomEmoji } from './resources/emoji.js';

export { CommandsResource } from './resources/commands.js';
export type { RcSlashCommand } from './resources/commands.js';

export { UploadsResource } from './resources/uploads.js';
export type { UploadInput, UploadStrategy } from './resources/uploads.js';

export { roomNamespace } from './resources/base.js';

export type * from './types.js';
