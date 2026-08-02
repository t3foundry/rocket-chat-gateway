import { describe, expect, it, vi } from 'vitest';

import { RocketChatRestClient } from '../client.js';

const credentials = { userId: 'u1', authToken: 't1' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records request URLs and replays a scripted response per path. */
const stubFetch = (routes: Record<string, () => Response>) => {
  const urls: string[] = [];

  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);

    const match = Object.keys(routes).find((path) => url.includes(path));
    if (!match) {
      return json({ success: false, error: 'unknown-endpoint', errorType: 'unknown-endpoint' }, 404);
    }

    return routes[match]!();
  });

  return { impl: impl as unknown as typeof globalThis.fetch, urls };
};

const clientWith = (impl: typeof globalThis.fetch) =>
  new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

describe('user search', () => {
  it('asks spotlight for users only', async () => {
    const { impl, urls } = stubFetch({
      '/spotlight': () => json({ users: [{ _id: 'u2', username: 'huy', name: 'Huy' }], rooms: [] }),
    });

    const users = await clientWith(impl).users.search('hu');

    expect(users).toEqual([{ _id: 'u2', username: 'huy', name: 'Huy' }]);
    expect(urls).toHaveLength(1);

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/v1/spotlight');
    expect(url.searchParams.get('query')).toBe('hu');
    expect(JSON.parse(url.searchParams.get('type')!)).toEqual({ users: true, rooms: false });
  });

  it('falls back to users.autocomplete when spotlight is missing', async () => {
    // Regression guard: `users.autocomplete` is the route that times out on
    // large servers, so it must stay a fallback and never the first choice.
    const { impl, urls } = stubFetch({
      'users.autocomplete': () => json({ items: [{ _id: 'u2', username: 'huy' }] }),
    });

    const users = await clientWith(impl).users.search('hu');

    expect(users).toEqual([{ _id: 'u2', username: 'huy' }]);
    expect(urls.map((url) => new URL(url).pathname)).toEqual(['/api/v1/spotlight', '/api/v1/users.autocomplete']);
  });

  it('falls back when spotlight rejects the parameters', async () => {
    const { impl, urls } = stubFetch({
      '/spotlight': () => json({ success: false, error: 'must-be-boolean', errorType: 'invalid-params' }, 400),
      'users.autocomplete': () => json({ items: [] }),
    });

    await expect(clientWith(impl).users.search('hu')).resolves.toEqual([]);
    expect(urls.map((url) => new URL(url).pathname)).toEqual(['/api/v1/spotlight', '/api/v1/users.autocomplete']);
  });

  it('surfaces failures the fallback cannot fix', async () => {
    const { impl, urls } = stubFetch({
      '/spotlight': () => json({ success: false, error: 'unauthorized' }, 401),
    });

    await expect(clientWith(impl).users.search('hu')).rejects.toThrow();
    expect(urls).toHaveLength(1);
  });
});
