import { SERVER_ID_HEADER } from '@t3foundry/open-rocket-chat-api-contract';
import { Injectable, createParamDecorator, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ApiException } from '../common/api-exception';
import { SessionService } from './session.service';
import { connectionFor, toServerSession, type ServerSession, type SessionRecord } from './session.types';

export { SERVER_ID_HEADER };

/** Where the resolved session is parked for the duration of the request. */
export interface AuthenticatedRequest extends FastifyRequest {
  /** Every server this session is signed in to. */
  session?: SessionRecord;
  /** The one server this request is scoped to. */
  serverSession?: ServerSession;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const raw = request.cookies?.[this.sessions.cookieName];
    const sessionId = this.sessions.verify(raw);
    if (!sessionId) {
      throw ApiException.localized('unauthorized', 'noValidSessionCookie');
    }

    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw ApiException.localized('unauthorized', 'sessionExpired');
    }

    // The header picks which of the session's servers this request acts on.
    // Falling back to the default keeps single-server clients working without
    // ever setting it.
    const serverId = readServerId(request);

    const connection = connectionFor(session, serverId);
    if (!connection) {
      // Asking for a server this session never signed in to is an auth
      // failure, not a 404: the resource may well exist for somebody else.
      throw serverId
        ? ApiException.localized('unauthorized', 'notSignedInToServer', { variables: { serverId } })
        : ApiException.localized('unauthorized', 'noUsableServerConnection');
    }

    request.session = session;
    request.serverSession = toServerSession(session, connection);
    return true;
  }
}

/**
 * Reads the target server from the header, or from `?serverId=` as a fallback.
 *
 * The query form exists for `<img src>`: attachments and avatars are loaded by
 * the browser itself, which cannot attach a header. It selects among servers
 * the cookie is already signed in to, so it grants nothing on its own.
 */
const readServerId = (request: AuthenticatedRequest): string | undefined => {
  const header = request.headers[SERVER_ID_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader;

  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.serverId;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : undefined;
};

/**
 * The session scoped to one server — what nearly every handler wants.
 *
 * Its shape is the same as a single-server session's, so services never have
 * to know that a session can span several servers.
 */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext): ServerSession => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (!request.serverSession) {
    // Only reachable if a controller forgets `@UseGuards(SessionGuard)`.
    throw ApiException.unauthorized();
  }

  return request.serverSession;
});

/** The whole session, for the few handlers that work across servers. */
export const FullSession = createParamDecorator((_data: unknown, context: ExecutionContext): SessionRecord => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (!request.session) {
    throw ApiException.unauthorized();
  }

  return request.session;
});
