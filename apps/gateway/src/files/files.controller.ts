import type { UploadFileResponse } from '@open-rocket-chat/api-contract';
import { toMessage } from '@open-rocket-chat/rc-adapter';
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import { ApiException } from '../common/api-exception';
import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';

/**
 * Response headers worth forwarding from Rocket.Chat to the browser.
 *
 * `content-length` is deliberately absent: see {@link FilesController.proxy}.
 */
const FORWARDED_HEADERS = ['content-type', 'content-disposition', 'last-modified', 'etag'];

@Controller()
@UseGuards(SessionGuard)
export class FilesController {
  constructor(private readonly rocketChat: RocketChatService) {}

  /**
   * `multipart/form-data` upload. Rocket.Chat couples upload and message
   * creation, so the response is the message the upload produced.
   */
  @Post('rooms/:roomId/files')
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Req() request: FastifyRequest,
  ): Promise<UploadFileResponse> {
    const part = await request.file();

    if (!part) {
      throw ApiException.localized('bad_request', 'multipartFileRequired');
    }

    // Buffered rather than streamed: Rocket.Chat's upload route needs a known
    // content length, and the size ceiling is already enforced by the
    // multipart limits configured at boot.
    const content = await part.toBuffer();

    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const description = readField(fields, 'description');
    const text = readField(fields, 'text');
    const threadId = readField(fields, 'threadId');

    const client = this.rocketChat.userClient(session);

    try {
      const message = await client.uploads.upload({
        roomId,
        filename: part.filename,
        contentType: part.mimetype,
        content,
        ...(description ? { description } : {}),
        ...(text ? { text } : {}),
        ...(threadId ? { threadId } : {}),
      });

      this.rocketChat.rememberUploadStrategy(session.serverId, client);

      return toMessage(message, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Streams an attachment from Rocket.Chat using the session's server-side
   * credentials. The browser holds no Rocket.Chat token, so this proxy is the
   * only way it can read protected uploads.
   */
  // Fastify's router (find-my-way) only accepts a bare `*` wildcard, and only
  // as the final segment — the `*name` form used by Express is rejected at
  // route-registration time.
  @Get('files/*')
  async download(
    @CurrentSession() session: ServerSession,
    @Param('*') path: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.proxy(session, `/${stripLeadingSlash(path)}`, reply);
  }

  /**
   * A room's picture. Declared before `avatars/:username` so `room` is not
   * read as somebody's name.
   */
  @Get('avatars/room/:roomId')
  async roomAvatar(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query('etag') etag: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.proxy(
      session,
      `/avatar/room/${encodeURIComponent(roomId)}${avatarQuery(session, etag)}`,
      reply,
      avatarCacheControl(etag),
    );
  }

  @Get('avatars/:username')
  async avatar(
    @CurrentSession() session: ServerSession,
    @Param('username') username: string,
    @Query('etag') etag: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.proxy(
      session,
      `/avatar/${encodeURIComponent(username)}${avatarQuery(session, etag)}`,
      reply,
      avatarCacheControl(etag),
    );
  }

  private async proxy(
    session: ServerSession,
    upstreamPath: string,
    reply: FastifyReply,
    cacheControl = 'private, max-age=300',
  ): Promise<void> {
    const client = this.rocketChat.userClient(session);

    let upstream: Response;
    try {
      upstream = await client.downloadFile(upstreamPath);
    } catch (error) {
      throw toApiException(error);
    }

    for (const header of FORWARDED_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) reply.header(header, value);
    }

    // `fetch` decodes `content-encoding` transparently but leaves the upstream
    // headers describing the encoded body, so a gzipped response arrives with a
    // `content-length` far shorter than the bytes we are about to write.
    // Forwarding it makes our own response under-declare its length: the extra
    // bytes land after the message the client considers finished, which any
    // strict HTTP parser in front of us — Vite's dev proxy included — rejects
    // outright. Rocket.Chat gzips the generated initials avatars, so this fires
    // for every user without a stored picture. Length is only forwarded when
    // the body reaching us was not decoded; otherwise Fastify chunks it.
    const encoding = upstream.headers.get('content-encoding');
    const length = upstream.headers.get('content-length');
    if (length && !encoding) reply.header('content-length', length);

    reply.header('cache-control', cacheControl);
    // The upstream URL is attacker-influenced via message content; a sniffed
    // content type could turn an "image" into an executed script on our origin.
    reply.header('x-content-type-options', 'nosniff');

    if (!upstream.body) {
      void reply.status(upstream.status).send();
      return;
    }

    void reply.status(upstream.status).send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
  }
}

const stripLeadingSlash = (value: string): string => value.replace(/^\/+/, '');

/**
 * The query string an avatar request needs: the cache-busting tag, and the
 * session's Rocket.Chat credentials.
 *
 * The credentials have to travel in the query rather than in the headers the
 * rest of the API takes. Rocket.Chat's avatar routes authenticate through
 * `isUserAuthenticated`, which reads `rc_uid` / `rc_token` from the query string
 * or from the browser's own cookies and looks nowhere else — the `x-user-id` /
 * `x-auth-token` pair that works for `/api/v1` and for `/file-upload` is simply
 * not consulted. With `Accounts_AvatarBlockUnauthenticatedAccess` on, which is
 * the default, a request it does not recognise is not refused either: it falls
 * through to the generated initials SVG, so a stored picture comes back looking
 * exactly like no picture at all.
 *
 * This is a server-to-server call inside the gateway and the token never
 * reaches the browser, but it does end up in a URL — so it stays confined to
 * the two avatar routes that have no other way in.
 */
const avatarQuery = (session: ServerSession, etag: string | undefined): string => {
  const query = new URLSearchParams({
    rc_uid: session.rocketChatUserId,
    rc_token: session.rocketChatAuthToken,
    ...(etag ? { etag } : {}),
  });

  return `?${query.toString()}`;
};

/**
 * With an etag the URL is content-addressed — Rocket.Chat mints a new one
 * whenever the picture changes — so it can be cached hard. That matters most
 * against a distant server, where every avatar in a busy room is otherwise a
 * fresh round-trip once an hour. Without an etag the URL says nothing about the
 * contents, so it only gets the short window.
 */
const avatarCacheControl = (etag: string | undefined): string =>
  etag ? 'public, max-age=604800, immutable' : 'public, max-age=3600';

const readField = (fields: Record<string, { value?: unknown } | undefined>, name: string): string | undefined => {
  const value = fields[name]?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
