import type { RcLoginServiceConfiguration } from '@t3foundry/open-rocket-chat-rc-rest-client';
import { describe, expect, it, vi } from 'vitest';

import { LoginServicesService } from '../auth/login-services.service';
import type { RocketChatService } from '../rocketchat/rocketchat.service';

const logger = {
  setContext: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as ConstructorParameters<typeof LoginServicesService>[1];

/**
 * Just enough of `RocketChatService` to answer the two anonymous routes a
 * login screen is built from.
 */
const stubRocketChat = (
  configurations: RcLoginServiceConfiguration[],
  settings: Record<string, unknown> = {},
  options: { publicUrl?: string } = {},
) => {
  const loginServices = vi.fn(async () => configurations);
  const publicSettings = vi.fn(async () => new Map(Object.entries(settings)));

  const service = {
    restClient: () => ({ loginServices, publicSettings }),
    publicUrl: () => options.publicUrl ?? 'https://chat.example.com',
  } as unknown as RocketChatService;

  return { service, loginServices, publicSettings };
};

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('login services', () => {
  it('builds a Google authorization URL a Rocket.Chat callback will accept', async () => {
    const { service } = stubRocketChat([{ service: 'google', clientId: 'google-client' }], {
      Site_Url: 'https://chat.example.com/',
    });

    const { loginServices } = await new LoginServicesService(service, logger).get('acme');

    expect(loginServices).toHaveLength(1);
    const [google] = loginServices;
    expect(google.id).toBe('google');
    expect(google.title).toBe('Google');
    expect(google.label).toBeNull();
    expect(google.icon).toBe('google');
    expect(new URL(google.authorizeUrl).origin + new URL(google.authorizeUrl).pathname).toBe(
      'https://accounts.google.com/o/oauth2/auth',
    );
    expect(params(google.authorizeUrl)).toMatchObject({
      client_id: 'google-client',
      // The trailing slash on `Site_Url` must not survive into the redirect:
      // Rocket.Chat rebuilds this without one when it redeems the code, and
      // the provider compares the two strings.
      redirect_uri: 'https://chat.example.com/_oauth/google',
      response_type: 'code',
      scope: 'profile email',
    });
    // `state` is the caller's single-use token, so it is deliberately absent.
    expect(params(google.authorizeUrl).state).toBeUndefined();
    expect(google.redirectUrl).toBe('https://chat.example.com/_oauth/google');
  });

  it('prefers the service record over the built-in defaults for self-hosted providers', async () => {
    const { service } = stubRocketChat([{ service: 'gitlab', clientId: 'gitlab-client' }], {
      Site_Url: 'https://chat.example.com',
      API_Gitlab_URL: 'https://gitlab.acme.dev/',
    });

    const { loginServices } = await new LoginServicesService(service, logger).get('acme');

    expect(loginServices[0].authorizeUrl).toContain('https://gitlab.acme.dev/oauth/authorize?');
    expect(params(loginServices[0].authorizeUrl).scope).toBe('read_user');
  });

  it('drives a custom service entirely from its own configuration', async () => {
    const { service } = stubRocketChat(
      [
        {
          service: 'acme-sso',
          clientId: 'sso-client',
          custom: true,
          serverURL: 'https://sso.acme.dev',
          authorizePath: '/authorize',
          scope: 'openid profile',
          buttonLabelText: 'Acme SSO',
          buttonColor: '#123456',
          buttonLabelColor: '#ffffff',
        },
      ],
      { Site_Url: 'https://chat.example.com' },
    );

    const { loginServices } = await new LoginServicesService(service, logger).get('acme');

    expect(loginServices[0]).toMatchObject({
      id: 'acme-sso',
      // The provider name and the administrator's button text are separate:
      // one fills in "Sign in with …", the other replaces the sentence.
      title: 'Acme-sso',
      label: 'Acme SSO',
      icon: null,
      buttonColor: '#123456',
      buttonTextColor: '#ffffff',
    });
    expect(loginServices[0].authorizeUrl).toContain('https://sso.acme.dev/authorize?');
    expect(params(loginServices[0].authorizeUrl)).toMatchObject({
      redirect_uri: 'https://chat.example.com/_oauth/acme-sso',
      scope: 'openid profile',
    });
  });

  it('leaves out hidden services, unusable handshakes and services with no client id', async () => {
    const { service } = stubRocketChat(
      [
        { service: 'google', clientId: 'google-client', showButton: false },
        // OAuth 1.0a, and the SSO protocols, need a handshake this flow has no
        // way to perform.
        { service: 'twitter', consumerKey: 'twitter-key' },
        { service: 'saml' },
        // Enabled but never finished being configured.
        { service: 'github' },
        // A provider nothing here knows, with nowhere to send the browser.
        { service: 'mystery', clientId: 'mystery-client' },
      ],
      { Site_Url: 'https://chat.example.com' },
    );

    const { loginServices } = await new LoginServicesService(service, logger).get('acme');

    expect(loginServices).toEqual([]);
  });

  it('sorts by service key and reports whether the password form is still offered', async () => {
    const { service } = stubRocketChat(
      [
        { service: 'gitlab', clientId: 'gitlab-client' },
        { service: 'github', clientId: 'github-client' },
      ],
      { Site_Url: 'https://chat.example.com', Accounts_ShowFormLogin: false },
    );

    const options = await new LoginServicesService(service, logger).get('acme');

    expect(options.loginServices.map((entry) => entry.id)).toEqual(['github', 'gitlab']);
    expect(options.passwordLoginEnabled).toBe(false);
  });

  it('asks Rocket.Chat once and answers the rest from memory', async () => {
    const { service, loginServices } = stubRocketChat([{ service: 'google', clientId: 'google-client' }]);
    const services = new LoginServicesService(service, logger);

    await services.get('acme');
    await services.get('acme');

    expect(loginServices).toHaveBeenCalledTimes(1);
  });

  it('falls back to the password form when the server will not say', async () => {
    const service = {
      restClient: () => ({
        loginServices: vi.fn(async () => {
          throw new Error('unreachable');
        }),
        publicSettings: vi.fn(async () => new Map()),
      }),
      publicUrl: () => 'https://chat.example.com',
    } as unknown as RocketChatService;

    await expect(new LoginServicesService(service, logger).get('acme')).resolves.toEqual({
      passwordLoginEnabled: true,
      loginServices: [],
    });
  });
});
