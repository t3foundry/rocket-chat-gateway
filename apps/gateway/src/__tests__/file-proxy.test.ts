import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

import { FilesController } from '../files/files.controller';
import type { RocketChatService } from '../rocketchat/rocketchat.service';
import type { ServerSession } from '../session/session.types';

const session = {
  id: 'session-1',
  serverId: 'open',
  username: 'ada',
  rocketChatUserId: 'u1',
  rocketChatAuthToken: 'token-1',
} as ServerSession;

/** Collects what the controller decided to send, without a real Fastify reply. */
const fakeReply = () => {
  const headers: Record<string, string> = {};
  const reply = {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body?: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
};

const controllerFor = (upstream: Response) => {
  const rocketChat = {
    userClient: () => ({ downloadFile: vi.fn().mockResolvedValue(upstream) }),
  } as unknown as RocketChatService;

  return new FilesController(rocketChat);
};

const upstreamResponse = (headers: Record<string, string>) =>
  new Response(Readable.toWeb(Readable.from([Buffer.from('decoded-body')])) as ReadableStream, {
    status: 200,
    headers,
  });

describe('avatar and file proxying', () => {
  it('drops a content-length that describes the still-encoded upstream body', async () => {
    // `fetch` decodes gzip for us but leaves the headers describing the
    // compressed bytes. Passing that length on makes our own response claim to
    // be shorter than it is, and the trailing bytes then land after the message
    // the client considers complete — which is a fatal parse error for any
    // proxy in front of the gateway, not a recoverable one.
    const reply = fakeReply();

    await controllerFor(
      upstreamResponse({ 'content-type': 'image/svg+xml', 'content-encoding': 'gzip', 'content-length': '243' }),
    ).avatar(session, 'ada', undefined, reply as never);

    expect(reply.headers['content-length']).toBeUndefined();
    expect(reply.headers['content-type']).toBe('image/svg+xml');
  });

  it('keeps the content-length of a body that arrived undecoded', async () => {
    const reply = fakeReply();

    await controllerFor(upstreamResponse({ 'content-type': 'image/png', 'content-length': '936' })).avatar(
      session,
      'ada',
      undefined,
      reply as never,
    );

    expect(reply.headers['content-length']).toBe('936');
  });

  it('never forwards the upstream content-encoding, having sent decoded bytes', async () => {
    const reply = fakeReply();

    await controllerFor(upstreamResponse({ 'content-type': 'application/pdf', 'content-encoding': 'gzip' })).download(
      session,
      'files/report.pdf',
      reply as never,
    );

    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });
});
