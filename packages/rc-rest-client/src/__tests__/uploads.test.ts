import { describe, expect, it, vi } from 'vitest';

import { RocketChatRestClient } from '../client.js';
import { RocketChatApiError } from '../errors.js';

const credentials = { userId: 'u1', authToken: 't1' };

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records calls and replays scripted responses by path. */
const stubFetch = (routes: Record<string, () => Response>) => {
  const calls: RecordedCall[] = [];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });

    const match = Object.keys(routes).find((path) => url.includes(path));
    if (!match) {
      return new Response(
        JSON.stringify({ success: false, error: 'unknown-endpoint', errorType: 'unknown-endpoint' }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return routes[match]!();
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const message = { _id: 'm1', rid: 'r1', msg: '', ts: '2026-01-01T00:00:00.000Z', u: { _id: 'u1', username: 'quy' } };

describe('uploads', () => {
  it('sends exactly the bytes it was given', async () => {
    // Regression guard. Small Node Buffers are windows onto a shared 8 KiB
    // pool, so building the Blob from `.buffer` used to upload the whole pool —
    // unrelated heap contents included — instead of the file.
    const { impl, calls } = stubFetch({
      'rooms.media/': () => json({ file: { _id: 'f1', url: '/file-upload/f1/note.txt' } }),
      'rooms.mediaConfirm/': () => json({ message }),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    const payload = Buffer.from('exactly these nineteen');
    await client.uploads.upload({
      roomId: 'r1',
      filename: 'note.txt',
      contentType: 'text/plain',
      content: payload,
    });

    const form = calls[0]!.init.body as FormData;
    const file = form.get('file') as File;

    expect(file.size).toBe(payload.byteLength);
    expect(await file.text()).toBe('exactly these nineteen');
  });

  it('falls back to the legacy upload route when the modern one is absent', async () => {
    const { impl, calls } = stubFetch({
      'rooms.upload/': () => json({ message }),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    await client.uploads.upload({
      roomId: 'r1',
      filename: 'note.txt',
      contentType: 'text/plain',
      content: Buffer.from('hi'),
      text: 'caption',
    });

    expect(calls[0]!.url).toContain('rooms.media/');
    expect(calls[1]!.url).toContain('rooms.upload/');
    expect(client.uploadStrategy).toBe('legacy-upload');
  });

  it('reuses the detected strategy instead of probing again', async () => {
    const { impl, calls } = stubFetch({ 'rooms.upload/': () => json({ message }) });
    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    const upload = () =>
      client.uploads.upload({
        roomId: 'r1',
        filename: 'a.txt',
        contentType: 'text/plain',
        content: Buffer.from('a'),
      });

    await upload();
    const afterProbe = calls.length;
    await upload();

    // Second upload is a single request: no repeated 404 against rooms.media.
    expect(calls.length - afterProbe).toBe(1);
  });

  it('propagates a genuine upload failure rather than falling back', async () => {
    const { impl } = stubFetch({
      'rooms.media/': () =>
        json({ success: false, error: 'File is too large', errorType: 'error-file-too-large' }, 413),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    await expect(
      client.uploads.upload({
        roomId: 'r1',
        filename: 'big.bin',
        contentType: 'application/octet-stream',
        content: Buffer.from('x'),
      }),
    ).rejects.toMatchObject({ status: 413, errorType: 'error-file-too-large' });
  });
});

describe('http', () => {
  it('treats a 200 carrying `success: false` as an error', async () => {
    const { impl } = stubFetch({
      'subscriptions.get': () => json({ success: false, error: 'nope', errorType: 'error-invalid-user' }),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    await expect(client.rooms.listSubscriptions()).rejects.toBeInstanceOf(RocketChatApiError);
  });

  it('reads the version from `/api/info`, which sits outside the versioned namespace', async () => {
    const { impl, calls } = stubFetch({ '/api/info': () => json({ version: '7.4' }) });
    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl });

    await expect(client.version()).resolves.toBe('7.4');
    // Under `/api/v1` this route does not exist: a self-hosted server answers
    // with the Meteor app shell as HTML and a 200, so the mistake shows up as
    // "unreachable" rather than as a 404.
    expect(calls[0]!.url).toBe('https://chat.test/api/info');
  });

  it('sends credentials as Rocket.Chat headers', async () => {
    const { impl, calls } = stubFetch({ 'rooms.get': () => json({ update: [], remove: [] }) });
    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    await client.rooms.list();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-user-id']).toBe('u1');
    expect(headers['x-auth-token']).toBe('t1');
  });

  it('retries a failed GET but never a send', async () => {
    let roomsAttempts = 0;
    let sendAttempts = 0;

    const { impl } = stubFetch({
      'rooms.get': () => {
        roomsAttempts += 1;
        return roomsAttempts < 3 ? json({ success: false }, 503) : json({ update: [], remove: [] });
      },
      'chat.sendMessage': () => {
        sendAttempts += 1;
        return json({ success: false }, 503);
      },
    });

    const client = new RocketChatRestClient({
      baseUrl: 'https://chat.test',
      fetch: impl,
      maxRetries: 2,
    }).as(credentials);

    await expect(client.rooms.list()).resolves.toEqual({ update: [], remove: [] });
    expect(roomsAttempts).toBe(3);

    // Replaying a send that may have succeeded would duplicate the message.
    await expect(client.chat.send({ roomId: 'r1', text: 'hi' })).rejects.toBeInstanceOf(RocketChatApiError);
    expect(sendAttempts).toBe(1);
  });

  it('normalises reaction shortcodes', async () => {
    const { impl, calls } = stubFetch({ 'chat.react': () => json({ success: true }) });
    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    await client.chat.react('m1', 'tada', true);

    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ emoji: ':tada:' });
  });
});
