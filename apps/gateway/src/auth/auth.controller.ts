import {
  LoginRequestSchema,
  LogoutRequestSchema,
  OAuthLoginRequestSchema,
  type LoginRequest,
  type LogoutRequest,
  type OAuthLoginRequest,
  type ServerListResponse,
  type Session,
} from '@open-rocket-chat/api-contract';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { zodPipe } from '../common/zod-validation.pipe';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { FullSession, SessionGuard, type AuthenticatedRequest } from '../session/session.guard';
import { SessionService } from '../session/session.service';
import type { SessionRecord } from '../session/session.types';
import { AuthService } from './auth.service';
import { LoginServicesService } from './login-services.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly rocketChat: RocketChatService,
    private readonly loginServices: LoginServicesService,
  ) {}

  /**
   * Public: lets a login screen render a server picker, and the right sign-in
   * methods for whichever server is picked, before any credentials exist. Only
   * ids and display names are exposed, never internal URLs.
   */
  @Get('servers')
  async listServers(): Promise<ServerListResponse> {
    const servers = await Promise.all(
      this.rocketChat.servers.map(async (server) => {
        const [version, options] = await Promise.all([
          this.rocketChat.version(server.id),
          this.loginServices.get(server.id),
        ]);

        return {
          id: server.id,
          name: server.name,
          baseUrl: this.rocketChat.publicUrl(server.id),
          version,
          passwordLoginEnabled: options.passwordLoginEnabled,
          loginServices: options.loginServices,
        };
      }),
    );

    return { servers, defaultServerId: this.rocketChat.defaultServerId };
  }

  /**
   * Signs in to a server.
   *
   * Deliberately not behind `SessionGuard`: it is the route that creates a
   * session. When a valid cookie is already present the new connection joins
   * that session, which is what makes several servers usable at once.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(zodPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() request: AuthenticatedRequest,
    // `passthrough` so Nest still serialises the returned body after the
    // cookie header is set on the raw reply.
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Session> {
    const existing = await this.resolveExistingSession(request);

    const { session, body: response } = await this.auth.login(body, existing);
    this.sessions.attachCookie(reply, session.id);

    return response;
  }

  /**
   * Completes an OAuth sign-in started in the browser.
   *
   * Unguarded for the same reason as `login`: it is one of the two routes that
   * can create a session, and an existing cookie means the server being signed
   * in to joins that session instead of replacing it.
   */
  @Post('login/oauth')
  @HttpCode(HttpStatus.OK)
  async loginWithOAuth(
    @Body(zodPipe(OAuthLoginRequestSchema)) body: OAuthLoginRequest,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Session> {
    const existing = await this.resolveExistingSession(request);

    const { session, body: response } = await this.auth.loginWithOAuth(body, existing);
    this.sessions.attachCookie(reply, session.id);

    return response;
  }

  @Get('session')
  @UseGuards(SessionGuard)
  async session(@FullSession() session: SessionRecord): Promise<Session> {
    return this.auth.describe(session);
  }

  /**
   * Signs out of one server, or of everything when no `serverId` is given.
   *
   * Returns the remaining session so a client that disconnected one of several
   * servers can carry on without a refetch; `204` means the session is gone.
   */
  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(
    @FullSession() session: SessionRecord,
    @Body(zodPipe(LogoutRequestSchema.optional())) body: LogoutRequest | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Session | undefined> {
    const remaining = await this.auth.logout(session, body?.serverId);

    if (!remaining) {
      this.sessions.clearCookie(reply);
      void reply.status(HttpStatus.NO_CONTENT);
      return undefined;
    }

    return this.auth.describe(remaining);
  }

  /**
   * Reads the session behind an unguarded route.
   *
   * A stale or forged cookie is treated as "no session" rather than an error:
   * the caller is signing in, so starting a fresh session is the right answer.
   */
  private async resolveExistingSession(request: AuthenticatedRequest): Promise<SessionRecord | null> {
    const sessionId = this.sessions.verify(request.cookies?.[this.sessions.cookieName]);
    return sessionId ? this.sessions.get(sessionId) : null;
  }
}
