import { RocketChatHttp, type RestClientOptions, type RocketChatCredentials } from './http.js';
import { ChatResource } from './resources/chat.js';
import { CommandsResource } from './resources/commands.js';
import { EmojiResource } from './resources/emoji.js';
import { RoomsResource } from './resources/rooms.js';
import { SettingsResource, toSettingsMap, type RcSetting } from './resources/settings.js';
import { UploadsResource, type UploadStrategy } from './resources/uploads.js';
import { UsersResource } from './resources/users.js';
import type { RcLoginResult, RcLoginServiceConfiguration, RcServerInfo, RcUser } from './types.js';

export interface LoginParams {
  /** Username or email — Rocket.Chat accepts either on this field. */
  user: string;
  password: string;
  /** Supplied on the retry after a `totp-required` failure. */
  totpCode?: string;
}

export interface LoginResult {
  userId: string;
  authToken: string;
  me: RcUser;
}

/**
 * Everything a client can do without knowing who it is: server discovery and
 * login. Authenticated work happens on the object returned by {@link as}.
 */
export class RocketChatRestClient {
  private readonly http: RocketChatHttp;

  constructor(options: RestClientOptions) {
    this.http = new RocketChatHttp(options);
  }

  get serverUrl(): string {
    return this.http.serverUrl;
  }

  /**
   * Version string of the connected server, or `null` when the deployment
   * hides it from anonymous callers (the default since Rocket.Chat 6.0).
   */
  async version(): Promise<string | null> {
    // `/api/info`, not `/api/v1/info`: this one route sits outside the
    // versioned namespace. Asking under `/api/v1` gets the Meteor app shell
    // (HTML, status 200) on a self-hosted server and a 404 behind a CDN, so
    // the leading slash is what keeps the prefix from being added.
    const info = await this.http.request<RcServerInfo>('/api/info');
    return info.version ?? info.info?.version ?? null;
  }

  async login(params: LoginParams): Promise<LoginResult> {
    const result = await this.http.request<RcLoginResult>('login', {
      method: 'POST',
      body: {
        user: params.user,
        password: params.password,
        ...(params.totpCode ? { code: params.totpCode } : {}),
      },
      // Both forms exist: older servers read the body `code`, newer ones the
      // header. Sending both costs nothing and covers the whole supported range.
      headers: params.totpCode ? { 'x-2fa-code': params.totpCode, 'x-2fa-method': 'totp' } : undefined,
    });

    return {
      userId: result.data.userId,
      authToken: result.data.authToken,
      me: result.data.me,
    };
  }

  /**
   * Finishes an OAuth sign-in with the credential pair the browser collected
   * from Rocket.Chat's own `/_oauth/<service>` callback.
   *
   * Rocket.Chat's REST `login` forwards any body without a `password` straight
   * to the Meteor `login` method, which is where `accounts-oauth` picks the
   * pair up and resolves it to the user it parked under that token.
   */
  async loginWithOAuth(credential: { credentialToken: string; credentialSecret: string }): Promise<LoginResult> {
    const result = await this.http.request<RcLoginResult>('login', {
      method: 'POST',
      body: {
        oauth: {
          credentialToken: credential.credentialToken,
          credentialSecret: credential.credentialSecret,
        },
      },
    });

    return {
      userId: result.data.userId,
      authToken: result.data.authToken,
      me: result.data.me,
    };
  }

  /**
   * Login services the server has configured, secrets excluded.
   *
   * Anonymous by design: a login screen has to know which buttons to draw
   * before anybody has signed in. Rocket.Chat serves this route without
   * authentication for exactly that reason.
   */
  async loginServices(): Promise<RcLoginServiceConfiguration[]> {
    const response = await this.http.request<{ configurations?: RcLoginServiceConfiguration[] }>(
      'service.configurations',
    );
    return response.configurations ?? [];
  }

  /**
   * Public settings, as a lookup keyed by id — the anonymous twin of
   * {@link SettingsResource.publicSettings}, for the handful of settings a
   * login screen needs before there are any credentials to send.
   */
  async publicSettings(): Promise<Map<string, unknown>> {
    const response = await this.http.request<{ settings?: RcSetting[] }>('settings.public', {
      query: { count: 0 },
    });
    return toSettingsMap(response.settings);
  }

  /** Binds a set of credentials, producing the authenticated surface of the API. */
  as(credentials: RocketChatCredentials): RocketChatUserClient {
    return new RocketChatUserClient(this.http, credentials);
  }
}

export class RocketChatUserClient {
  readonly rooms: RoomsResource;

  readonly chat: ChatResource;

  readonly users: UsersResource;

  readonly uploads: UploadsResource;

  readonly emoji: EmojiResource;

  readonly commands: CommandsResource;

  readonly settings: SettingsResource;

  constructor(
    private readonly http: RocketChatHttp,
    readonly credentials: RocketChatCredentials,
  ) {
    this.rooms = new RoomsResource(http, credentials);
    this.chat = new ChatResource(http, credentials);
    this.users = new UsersResource(http, credentials);
    this.uploads = new UploadsResource(http, credentials);
    this.emoji = new EmojiResource(http, credentials);
    this.commands = new CommandsResource(http, credentials);
    this.settings = new SettingsResource(http, credentials);
  }

  get serverUrl(): string {
    return this.http.serverUrl;
  }

  /** Carries the detected upload strategy across client instances for a server. */
  get uploadStrategy(): UploadStrategy | undefined {
    return this.uploads.getStrategy();
  }

  set uploadStrategy(strategy: UploadStrategy | undefined) {
    this.uploads.setStrategy(strategy);
  }

  /**
   * Rocket.Chat serves avatars from an unauthenticated path keyed by username.
   * `etag` busts the cache when the user changes their picture.
   */
  avatarUrl(username: string, etag?: string | null): string {
    const suffix = etag ? `?etag=${encodeURIComponent(etag)}` : '';
    return this.http.absoluteUrl(`/avatar/${encodeURIComponent(username)}${suffix}`);
  }

  /**
   * Turns a stored file path into an absolute URL. The result still requires
   * authentication, so the gateway proxies it rather than handing it to browsers.
   */
  fileUrl(path: string): string {
    return this.http.absoluteUrl(path);
  }

  /**
   * Streams a file straight from Rocket.Chat. Returns the raw `Response` so the
   * caller can pipe it without buffering an entire video into memory.
   */
  async downloadFile(path: string, signal?: AbortSignal): Promise<Response> {
    return this.http.requestRaw(path, { credentials: this.credentials, signal });
  }
}
