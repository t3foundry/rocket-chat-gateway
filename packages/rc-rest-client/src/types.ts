/**
 * Minimal structural types for the Rocket.Chat records this client touches.
 *
 * These intentionally mirror the wire format, warts included (`_id`, `rid`,
 * single-letter fields). Translating them into something pleasant is the job of
 * `@t3foundry/open-rocket-chat-rc-adapter`; doing it here would hide the version drift
 * this package exists to absorb.
 *
 * Every field beyond the ones Rocket.Chat has always guaranteed is optional,
 * because the same route returns different subsets across 6.x/7.x.
 */

/**
 * Rocket.Chat serialises dates as ISO strings over REST and as `{ $date }` over
 * DDP — and returns raw epoch numbers from a few older routes.
 */
export type RcDate = string | number | { $date: number };

export interface RcUserSummary {
  _id: string;
  username?: string;
  name?: string;
}

export interface RcUser extends RcUserSummary {
  status?: 'online' | 'away' | 'busy' | 'offline';
  /**
   * The presence the account itself asked for, before Rocket.Chat narrows it by
   * whether any session is live. Only `/api/v1/me` returns it; `users.info`
   * reports another account's computed `status` and nothing about their intent.
   */
  statusDefault?: 'online' | 'away' | 'busy' | 'offline';
  statusText?: string;
  bio?: string;
  nickname?: string;
  emails?: { address: string; verified?: boolean }[];
  roles?: string[];
  utcOffset?: number;
  language?: string;
  avatarETag?: string;
  active?: boolean;
  createdAt?: RcDate;
  settings?: { preferences?: Record<string, unknown> };
}

export type RcRoomType = 'c' | 'p' | 'd' | 'l' | (string & {});

export interface RcRoom {
  _id: string;
  t: RcRoomType;
  name?: string;
  fname?: string;
  topic?: string;
  description?: string;
  announcement?: string;
  u?: RcUserSummary;
  /** Direct-message participants. Only populated on some routes. */
  usernames?: string[];
  uids?: string[];
  usersCount?: number;
  msgs?: number;
  ro?: boolean;
  broadcast?: boolean;
  encrypted?: boolean;
  reactWhenReadOnly?: boolean;
  archived?: boolean;
  default?: boolean;
  /** False for rooms (commonly default channels) the caller may not leave. */
  cl?: boolean;
  /** Usernames silenced in this room, and — in a read-only room — those exempted. */
  muted?: string[];
  unmuted?: string[];
  /** Parent room id — its presence is what makes a room a discussion. */
  prid?: string;
  teamId?: string;
  teamMain?: boolean;
  avatarETag?: string;
  lastMessage?: RcMessage;
  lm?: RcDate;
  ts?: RcDate;
  _updatedAt?: RcDate;
}

export interface RcSubscription {
  _id: string;
  rid: string;
  u: RcUserSummary;
  t: RcRoomType;
  name?: string;
  fname?: string;
  open?: boolean;
  alert?: boolean;
  unread?: number;
  userMentions?: number;
  groupMentions?: number;
  f?: boolean;
  ls?: RcDate;
  lr?: RcDate;
  ts?: RcDate;
  roles?: string[];
  archived?: boolean;
  /** Direct-message block state from the current user's point of view. */
  blocked?: boolean;
  blocker?: boolean;
  /** Rocket.Chat stores "muted" as a disabled-notifications flag on the subscription. */
  disableNotifications?: boolean;
  muteGroupMentions?: boolean;
  hideUnreadStatus?: boolean;
  hideMentionStatus?: boolean;
  desktopNotifications?: string;
  mobilePushNotifications?: string;
  emailNotifications?: string;
  audioNotificationValue?: string;
  /**
   * `subscription` when the user overrode the server default for this room,
   * `user` or absent when they did not. Rocket.Chat's own panel shows the
   * stored value only in the first case — otherwise the room is on "Default".
   */
  desktopPrefOrigin?: string;
  mobilePrefOrigin?: string;
  emailPrefOrigin?: string;
  prid?: string;
  teamId?: string;
  teamMain?: boolean;
  _updatedAt?: RcDate;
}

export interface RcFileProp {
  _id: string;
  name?: string;
  type?: string;
  size?: number;
  format?: string;
  /** `thumb` on the generated preview Rocket.Chat stores next to an image. */
  typeGroup?: string;
}

/**
 * An upload record as `channels.files` and friends return it — the stored file
 * itself, not the message it was posted in. `user` is joined in by the route.
 */
export interface RcUpload {
  _id: string;
  name?: string;
  type?: string;
  size?: number;
  description?: string;
  rid?: string;
  userId?: string;
  user?: RcUserSummary;
  /** `image`, `video`, `audio`, `text`, `application`… — what the file filter groups on. */
  typeGroup?: string;
  /** Storage path; needs the same proxying as any other Rocket.Chat file URL. */
  path?: string;
  url?: string;
  uploadedAt?: RcDate;
  identify?: { format?: string; size?: { width: number; height: number } };
}

/** A user's roles *within one room* (`owner`, `moderator`, `leader`). */
export interface RcRoomRole {
  _id: string;
  rid: string;
  u: RcUserSummary;
  roles: string[];
}

export interface RcAttachment {
  title?: string;
  /** Upload this attachment was built from; absent on link previews and quotes. */
  fileId?: string;
  title_link?: string;
  title_link_download?: boolean;
  type?: string;
  description?: string;
  text?: string;
  image_url?: string;
  image_type?: string;
  image_size?: number;
  image_dimensions?: { width?: number; height?: number };
  image_preview?: string;
  video_url?: string;
  video_type?: string;
  video_size?: number;
  audio_url?: string;
  audio_type?: string;
  audio_size?: number;
  color?: string;
  ts?: RcDate;
  author_name?: string;
  author_icon?: string;
  author_link?: string;
  message_link?: string;
  /** Nested quotes; Rocket.Chat allows arbitrary depth. */
  attachments?: RcAttachment[];
}

export interface RcMessageUrl {
  url: string;
  meta?: Record<string, string>;
}

export interface RcMention {
  _id: string;
  username?: string;
  name?: string;
  fname?: string;
  type?: 'user' | 'team';
}

export interface RcMessage {
  _id: string;
  rid: string;
  msg: string;
  ts: RcDate;
  u: RcUserSummary;
  _updatedAt?: RcDate;
  /** Set only on human edits, which is why it cannot be derived from `_updatedAt`. */
  editedAt?: RcDate;
  editedBy?: RcUserSummary;
  /** System message discriminator: `uj` (joined), `room_changed_topic`, … */
  t?: string;
  alias?: string;
  tmid?: string;
  tshow?: boolean;
  tcount?: number;
  tlm?: RcDate;
  replies?: string[];
  mentions?: RcMention[];
  channels?: { _id: string; name?: string }[];
  reactions?: Record<string, { usernames: string[]; names?: string[] }>;
  attachments?: RcAttachment[];
  files?: RcFileProp[];
  file?: RcFileProp;
  urls?: RcMessageUrl[];
  pinned?: boolean;
  pinnedAt?: RcDate;
  pinnedBy?: RcUserSummary;
  starred?: { _id: string }[];
  drid?: string;
  groupable?: boolean;
  /** Present on end-to-end encrypted messages; `msg` then holds ciphertext. */
  e2e?: 'pending' | 'done';
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface RcSuccessEnvelope {
  success: true;
}

export interface RcErrorEnvelope {
  success: false;
  error?: string;
  errorType?: string;
  message?: string;
  details?: unknown;
  /** Some routes use `status: 'error'` with the text in `message`. */
  status?: string;
}

export interface RcLoginResult {
  status: 'success';
  data: {
    userId: string;
    authToken: string;
    me: RcUser;
  };
}

/**
 * One entry of `meteor_accounts_loginServiceConfiguration`, as returned by
 * `service.configurations` with the client secret projected away.
 *
 * Only custom OAuth services carry their own endpoints; for the built-in
 * providers Rocket.Chat writes nothing but the client id and expects every
 * client to already know where the provider lives.
 */
export interface RcLoginServiceConfiguration {
  _id?: string;
  /** Lowercased service key: `google`, `saml`, or a custom service's name. */
  service?: string;
  clientId?: string;
  /** Facebook and Twitter store the client id under their own names. */
  appId?: string;
  consumerKey?: string;
  custom?: boolean;
  serverURL?: string;
  authorizePath?: string;
  scope?: string;
  loginStyle?: string;
  buttonLabelText?: string;
  buttonLabelColor?: string;
  buttonColor?: string;
  /** Set to `false` by an administrator to keep a configured service hidden. */
  showButton?: boolean;
}

export interface RcServerInfo {
  /** Only present for authenticated callers on modern servers. */
  version?: string;
  info?: { version?: string };
  /** Rocket.Chat exposes a coarse version string to anonymous callers. */
  minimumClientVersions?: Record<string, string>;
}

export interface RcPageMeta {
  count?: number;
  offset?: number;
  total?: number;
}

/** e.g. `RcListEnvelope<'messages', RcMessage>` for `{ messages: [...], total: 12 }`. */
export type RcListEnvelope<K extends string, T> = { [P in K]: T[] } & RcPageMeta;
