import type { LoginService } from '@open-rocket-chat/api-contract';
import type { RcLoginServiceConfiguration } from '@open-rocket-chat/rc-rest-client';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RocketChatService } from '../rocketchat/rocketchat.service';

/**
 * How long a server's login options are reused.
 *
 * They only change when an administrator edits them, and this route is public:
 * without a cache every unauthenticated page load would ask Rocket.Chat for
 * several hundred settings.
 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * What a provider needs beyond its client id for a browser to start the
 * handshake.
 *
 * Rocket.Chat stores none of this for its built-in providers — the service
 * record holds the client id and nothing else, and every Rocket.Chat client is
 * expected to already know where Google or GitLab lives. These mirror the
 * definitions in Rocket.Chat's own `client/views/root/hooks/customOAuth/*`, so
 * the URLs a browser opens are the ones the server will accept back.
 */
interface ProviderProfile {
  title: string;
  /** Icon key the client maps to a glyph. */
  icon: string;
  /** Where the provider is hosted, when it is hosted in exactly one place. */
  serverUrl?: string;
  /** Public setting naming the deployment, for self-hosted providers. */
  serverUrlSetting?: string;
  /** Absolute, or relative to the resolved server URL. */
  authorizePath: string;
  scope: string;
  /** Anything the provider expects on top of the standard OAuth parameters. */
  extraParams?: Record<string, string>;
}

const PROVIDERS: Record<string, ProviderProfile> = {
  google: {
    title: 'Google',
    icon: 'google',
    authorizePath: 'https://accounts.google.com/o/oauth2/auth',
    scope: 'profile email',
  },
  facebook: {
    title: 'Facebook',
    icon: 'facebook',
    // Pinned the way Meteor's `facebook-oauth` pins it; the dialog is
    // versioned and an unversioned URL stopped working years ago.
    authorizePath: 'https://www.facebook.com/v17.0/dialog/oauth',
    scope: 'email',
    extraParams: { display: 'popup' },
  },
  github: {
    title: 'GitHub',
    icon: 'github',
    serverUrl: 'https://github.com',
    authorizePath: 'https://github.com/login/oauth/authorize',
    scope: 'user:email',
  },
  github_enterprise: {
    title: 'GitHub Enterprise',
    icon: 'github',
    serverUrlSetting: 'API_GitHub_Enterprise_URL',
    authorizePath: '/login/oauth/authorize',
    scope: 'openid',
  },
  gitlab: {
    title: 'GitLab',
    icon: 'gitlab',
    serverUrl: 'https://gitlab.com',
    serverUrlSetting: 'API_Gitlab_URL',
    authorizePath: '/oauth/authorize',
    scope: 'read_user',
  },
  linkedin: {
    title: 'LinkedIn',
    icon: 'linkedin',
    serverUrl: 'https://www.linkedin.com',
    authorizePath: '/oauth/v2/authorization',
    scope: 'openid email profile',
  },
  drupal: {
    title: 'Drupal',
    icon: 'drupal',
    serverUrlSetting: 'API_Drupal_URL',
    authorizePath: '/oauth2/authorize',
    scope: 'openid email profile offline_access',
  },
  dolphin: {
    title: 'Dolphin',
    icon: 'dolphin',
    serverUrlSetting: 'Accounts_OAuth_Dolphin_URL',
    authorizePath: '/m/oauth2/auth/',
    scope: 'basic',
  },
  nextcloud: {
    title: 'Nextcloud',
    icon: 'nextcloud',
    serverUrlSetting: 'Accounts_OAuth_Nextcloud_URL',
    authorizePath: '/index.php/apps/oauth2/authorize',
    scope: 'openid',
  },
  'meteor-developer': {
    title: 'Meteor',
    icon: 'meteor',
    serverUrl: 'https://www.meteor.com',
    authorizePath: '/oauth2/authorize',
    scope: 'email',
  },
  wordpress: {
    title: 'WordPress',
    icon: 'wordpress',
    serverUrlSetting: 'API_Wordpress_URL',
    authorizePath: '/oauth/authorize',
    scope: 'openid',
  },
};

/**
 * Services that appear in the same Rocket.Chat collection but cannot be driven
 * by this flow: Twitter still speaks OAuth 1.0a (which needs a request-token
 * round trip the gateway would have to sign), and SAML, CAS, LDAP and Apple
 * each have a handshake of their own. Listing them keeps a puzzling silence
 * from looking like a bug.
 */
const UNSUPPORTED_SERVICES = new Set(['apple', 'cas', 'ldap', 'saml', 'twitter']);

/** Rocket.Chat's own fallback when a service has no configured label. */
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/** Rocket.Chat writes booleans as booleans, but older servers send strings. */
const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : typeof value === 'string' ? value === 'true' : fallback;

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const isAbsolute = (url: string): boolean => /^https?:\/\//i.test(url);

export interface ServerLoginOptions {
  passwordLoginEnabled: boolean;
  loginServices: LoginService[];
}

/**
 * What a login screen may offer for one Rocket.Chat server.
 *
 * Rocket.Chat spreads this across a service collection and a pile of settings
 * and leaves each client to reassemble it; doing that here means a client only
 * has to render what it is handed, and that a provider it has never heard of
 * still works.
 */
@Injectable()
export class LoginServicesService {
  private readonly cache = new Map<string, { options: ServerLoginOptions; expiresAt: number }>();

  constructor(
    private readonly rocketChat: RocketChatService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LoginServicesService.name);
  }

  async get(serverId: string): Promise<ServerLoginOptions> {
    const cached = this.cache.get(serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.options;

    const client = this.rocketChat.restClient(serverId);

    try {
      // Both routes are anonymous upstream, which is the whole reason a login
      // screen can be built before anybody has signed in.
      const [configurations, settings] = await Promise.all([client.loginServices(), client.publicSettings()]);

      const options: ServerLoginOptions = {
        passwordLoginEnabled: asBoolean(settings.get('Accounts_ShowFormLogin'), true),
        loginServices: this.toLoginServices(serverId, configurations, settings),
      };

      this.cache.set(serverId, { options, expiresAt: Date.now() + CACHE_TTL_MS });
      return options;
    } catch (error) {
      // A server that will not answer must still be signable in to: fall back
      // to the password form rather than a login screen with nothing on it.
      this.logger.warn({ err: error, serverId }, 'could not read login services');
      return { passwordLoginEnabled: true, loginServices: [] };
    }
  }

  private toLoginServices(
    serverId: string,
    configurations: RcLoginServiceConfiguration[],
    settings: Map<string, unknown>,
  ): LoginService[] {
    // `Site_Url` rather than the gateway's own notion of the public URL: it is
    // what Rocket.Chat builds its callback from, and the provider will only
    // accept the redirect it was given at the start of the handshake.
    const rootUrl = withoutTrailingSlash(asString(settings.get('Site_Url')) ?? this.rocketChat.publicUrl(serverId));

    return (
      configurations
        // Sorted by service key the way Rocket.Chat's own login screen sorts
        // them, so the buttons do not shuffle between the two clients.
        .filter((configuration) => configuration.service && configuration.showButton !== false)
        .sort((left, right) => (left.service ?? '').localeCompare(right.service ?? ''))
        .map((configuration) => this.toLoginService(configuration, rootUrl, settings))
        .filter((service): service is LoginService => service !== null)
    );
  }

  private toLoginService(
    configuration: RcLoginServiceConfiguration,
    rootUrl: string,
    settings: Map<string, unknown>,
  ): LoginService | null {
    const service = configuration.service as string;
    if (UNSUPPORTED_SERVICES.has(service)) {
      this.logger.debug({ service }, 'skipping login service this flow cannot drive');
      return null;
    }

    // Facebook and Twitter store the client id under their own names.
    const clientId = configuration.clientId ?? configuration.appId ?? configuration.consumerKey;
    if (!clientId) return null;

    const profile = PROVIDERS[service];
    const authorizeUrl = this.authorizeUrl(configuration, profile, clientId, rootUrl, settings);
    if (!authorizeUrl) {
      this.logger.debug({ service }, 'skipping login service with no resolvable authorization endpoint');
      return null;
    }

    return {
      id: service,
      title: profile?.title ?? capitalize(service),
      label: asString(configuration.buttonLabelText) ?? null,
      icon: profile?.icon ?? null,
      buttonColor: asString(configuration.buttonColor) ?? null,
      buttonTextColor: asString(configuration.buttonLabelColor) ?? null,
      authorizeUrl: authorizeUrl.toString(),
      redirectUrl: `${rootUrl}/_oauth/${service}`,
    };
  }

  /**
   * The URL the browser opens, minus the `state` the caller adds.
   *
   * Built the way Rocket.Chat's own client builds it — same parameters, same
   * defaults for a missing path or scope — because the code that comes back is
   * redeemed by Rocket.Chat against exactly these values.
   */
  private authorizeUrl(
    configuration: RcLoginServiceConfiguration,
    profile: ProviderProfile | undefined,
    clientId: string,
    rootUrl: string,
    settings: Map<string, unknown>,
  ): URL | null {
    // Custom services — and WordPress, which Rocket.Chat stores like one —
    // carry their own endpoints, so they work without being known here.
    const serverUrl =
      asString(configuration.serverURL) ??
      (profile?.serverUrlSetting ? asString(settings.get(profile.serverUrlSetting)) : undefined) ??
      profile?.serverUrl;

    const authorizePath = asString(configuration.authorizePath) ?? profile?.authorizePath ?? '/oauth/authorize';
    const absolute = isAbsolute(authorizePath)
      ? authorizePath
      : serverUrl && `${withoutTrailingSlash(serverUrl)}${authorizePath}`;

    if (!absolute) return null;

    let url: URL;
    try {
      url = new URL(absolute);
    } catch {
      return null;
    }

    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', `${rootUrl}/_oauth/${configuration.service}`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', asString(configuration.scope) ?? profile?.scope ?? 'openid');

    for (const [key, value] of Object.entries(profile?.extraParams ?? {})) {
      url.searchParams.set(key, value);
    }

    return url;
  }
}
