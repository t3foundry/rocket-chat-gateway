import { describe, expect, it, vi } from 'vitest';

import { RocketChatRestClient } from '../client.js';
import { RocketChatApiError } from '../errors.js';

const credentials = { userId: 'u1', authToken: 't1' };

interface RecordedCall {
  url: string;
  init: RequestInit;
  /** The request body, read the way a server reads it. */
  body: string;
}

/** Reads a request body, streamed or not, into the bytes that were sent. */
const drain = async (body: BodyInit | null | undefined): Promise<string> => {
  if (!body) return '';
  if (typeof body === 'string') return body;

  const iterable = body as Partial<AsyncIterable<Uint8Array>>;
  if (typeof iterable[Symbol.asyncIterator] !== 'function') return String(body);

  const chunks: Buffer[] = [];
  for await (const chunk of iterable as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString('utf8');
};

/** A fetch stub that records calls and replays scripted responses by path. */
const stubFetch = (routes: Record<string, () => Response>) => {
  const calls: RecordedCall[] = [];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: RecordedCall = { url, init: init ?? {}, body: '' };
    calls.push(call);

    // Drained before answering, as a real server does. It matters for more
    // than fidelity: a multipart part sitting behind a streamed file only
    // becomes readable once the file has been read off the wire.
    call.body = await drain(init?.body);

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

/** The content of the multipart part named `name`, without its headers. */
const partOf = (body: string, name: string): string | undefined =>
  body
    .split(/--[^\r\n]+\r\n/)
    .find((section) => section.includes(`name="${name}"`))
    ?.split('\r\n\r\n')[1]
    ?.replace(/\r\n$/, '');

const mediaRoutes = {
  'rooms.media/': () => json({ file: { _id: 'f1', url: '/file-upload/f1/note.txt' } }),
  'rooms.mediaConfirm/': () => json({ message }),
};

describe('uploads', () => {
  it('sends exactly the bytes it was given', async () => {
    // Regression guard, from when the file travelled as a Blob: small Node
    // Buffers are windows onto a shared 8 KiB pool, so building one from
    // `.buffer` used to upload the whole pool — unrelated heap contents
    // included — in place of the file.
    const { impl, calls } = stubFetch(mediaRoutes);

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);
    client.uploadStrategy = 'media-confirm';

    await client.uploads.upload({
      roomId: 'r1',
      filename: 'note.txt',
      contentType: 'text/plain',
      content: Buffer.from('exactly these nineteen'),
    });

    expect(partOf(calls[0]!.body, 'file')).toBe('exactly these nineteen');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });

  it('forwards a streamed file without collecting it first', async () => {
    // The point of the streamed path: a gateway relaying somebody's upload
    // must not hold it, and the sender's own progress only tells the truth if
    // the bytes leave as they arrive.
    const { impl, calls } = stubFetch(mediaRoutes);

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);
    client.uploadStrategy = 'media-confirm';

    let pulled = 0;
    const content = (async function* () {
      for (const chunk of ['one ', 'two ', 'three']) {
        pulled += 1;
        yield Buffer.from(chunk);
      }
    })();

    await client.uploads.upload({ roomId: 'r1', filename: 'note.txt', contentType: 'text/plain', content });

    expect(partOf(calls[0]!.body, 'file')).toBe('one two three');
    expect(pulled).toBe(3);
  });

  it('reads message fields that only arrive after the file has gone up', async () => {
    // A browser's multipart request can put the caption behind the file, and
    // a part behind a streamed file stays unparsed until the file is drained.
    const { impl, calls } = stubFetch(mediaRoutes);

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);
    client.uploadStrategy = 'media-confirm';

    let drained = false;
    const content = (async function* () {
      yield Buffer.from('bytes');
      drained = true;
    })();

    await client.uploads.upload({
      roomId: 'r1',
      filename: 'note.txt',
      contentType: 'text/plain',
      content,
      lateFields: () => (drained ? { text: 'said afterwards' } : {}),
    });

    expect(JSON.parse(calls[1]!.body)).toMatchObject({ msg: 'said afterwards' });
  });

  it('detects the legacy upload route without spending the file on the attempt', async () => {
    // Probing by uploading is not open to a streamed body: by the time the
    // modern route answers 404 the bytes have been read and there is nothing
    // left to retry with. So the route is settled first, by a request that
    // carries no file at all.
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
    expect(calls[0]!.body).not.toContain('filename=');
    expect(calls[1]!.url).toContain('rooms.upload/');

    const legacy = calls[1]!.body;
    expect(partOf(legacy, 'file')).toBe('hi');
    expect(partOf(legacy, 'msg')).toBe('caption');
    expect(client.uploadStrategy).toBe('legacy-upload');
  });

  it('reads any answer from the modern route as proof it exists', async () => {
    // `error-no-file` is the expected reply to a probe carrying none, and a
    // refusal — a permission, a rate limit — is just as good: only a missing
    // route means the server speaks the older API.
    const { impl } = stubFetch({
      'rooms.media/': () => json({ success: false, error: 'No file uploaded', errorType: 'error-no-file' }, 400),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);

    // The stub answers the real upload the same way, so it fails — but on the
    // modern strategy rather than by falling back to the legacy route.
    await expect(
      client.uploads.upload({ roomId: 'r1', filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('a') }),
    ).rejects.toMatchObject({ errorType: 'error-no-file' });
    expect(client.uploadStrategy).toBe('media-confirm');
  });

  it('stops the upload when the caller abandons it', async () => {
    // A file taken back mid-flight must not land in the room a moment later.
    const controller = new AbortController();
    const { impl } = stubFetch({
      'rooms.media/': () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);
    client.uploadStrategy = 'media-confirm';

    await expect(
      client.uploads.upload({
        roomId: 'r1',
        filename: 'a.txt',
        contentType: 'text/plain',
        content: Buffer.from('a'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ timedOut: true });
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

  it('lets a slow upload run past the timeout that governs ordinary requests', async () => {
    // Regression guard. Uploads used to share the 15s request timeout, so a
    // file large enough to spend longer than that on the wire — routine
    // against a Rocket.Chat that is not on localhost — failed as
    // `upstream_unavailable`, blaming a server that was answering fine.
    const answerAfter =
      (ms: number, body: unknown) =>
      (init?: RequestInit): Promise<Response> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(json(body)), ms);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject((init.signal as AbortSignal).reason);
          });
        });

    const routes: Record<string, (init?: RequestInit) => Promise<Response>> = {
      'rooms.media/': answerAfter(200, { file: { _id: 'f1', url: '/file-upload/f1/slow.bin' } }),
      'rooms.mediaConfirm/': answerAfter(200, { message }),
      'rooms.get': answerAfter(200, { update: [], remove: [] }),
    };

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const match = Object.keys(routes).find((path) => url.includes(path));
      return routes[match!]!(init);
    }) as unknown as typeof globalThis.fetch;

    const client = new RocketChatRestClient({
      baseUrl: 'https://chat.test',
      fetch: impl,
      timeoutMs: 50,
      uploadTimeoutMs: 3_000,
    }).as(credentials);
    client.uploadStrategy = 'media-confirm';

    await expect(
      client.uploads.upload({
        roomId: 'r1',
        filename: 'slow.bin',
        contentType: 'application/octet-stream',
        content: Buffer.from('x'),
      }),
    ).resolves.toMatchObject({ _id: 'm1' });

    // The longer window is for file bytes only; everything else still fails
    // fast against a server that has stopped answering.
    await expect(client.rooms.list()).rejects.toMatchObject({ timedOut: true });
  });

  it('propagates a genuine upload failure rather than falling back', async () => {
    const { impl } = stubFetch({
      'rooms.media/': () =>
        json({ success: false, error: 'File is too large', errorType: 'error-file-too-large' }, 413),
    });

    const client = new RocketChatRestClient({ baseUrl: 'https://chat.test', fetch: impl }).as(credentials);
    client.uploadStrategy = 'media-confirm';

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
