import {
  SearchUsersQuerySchema,
  UpdateMyStatusRequestSchema,
  type GetUserResponse,
  type SearchUsersQuery,
  type SearchUsersResponse,
  type SetMyAvatarResponse,
  type UpdateMyStatusRequest,
  type UpdateMyStatusResponse,
} from '@t3foundry/open-rocket-chat-api-contract';
import { toMyProfile, toUserProfile, toUserSummary } from '@t3foundry/open-rocket-chat-rc-adapter';
import type { RocketChatUserClient } from '@t3foundry/open-rocket-chat-rc-rest-client';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { readAvatarUpload, withSettledAvatarTag } from '../common/avatar';
import { toApiException } from '../common/upstream-error';
import { zodPipe } from '../common/zod-validation.pipe';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';

/** Rocket.Chat ids are 17-character alphanumeric strings, unlike usernames. */
const looksLikeUserId = (value: string): boolean => /^[A-Za-z0-9]{17}$/.test(value);

@Controller('users')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly rocketChat: RocketChatService) {}

  /** Mention and DM autocomplete. Declared before `:userIdOrUsername`. */
  @Get('search')
  async search(
    @CurrentSession() session: ServerSession,
    @Query(zodPipe(SearchUsersQuerySchema)) query: SearchUsersQuery,
  ): Promise<SearchUsersResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const users = await client.users.search(query.q);
      return {
        items: users.slice(0, query.limit).map((user) => toUserSummary(user, context)),
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Sets the caller's own presence and status message.
   *
   * Scoped to the active server like every other route: an account signed in
   * to two Rocket.Chat servers has a separate presence on each, and there is
   * no upstream notion of a status that spans them.
   *
   * The updated profile is read back rather than assembled from the request,
   * because Rocket.Chat may refuse a status the server's settings disallow —
   * `Accounts_AllowInvisibleStatusOption` in particular — and the client
   * should show what is actually in force. What is in force for the caller is
   * the presence they chose, which is why the read-back goes through
   * `toMyProfile`: the computed `status` is `offline` for anybody without a
   * live session, and a status picker that answered `offline` to every set
   * would be unusable.
   */
  @Patch('me/status')
  async setMyStatus(
    @CurrentSession() session: ServerSession,
    @Body(zodPipe(UpdateMyStatusRequestSchema)) body: UpdateMyStatusRequest,
  ): Promise<UpdateMyStatusResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      await client.users.setStatus({
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.statusText === undefined ? {} : { message: body.statusText }),
      });

      return toMyProfile(await client.users.me(), this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Replaces the caller's own picture.
   *
   * Only ever the caller's: Rocket.Chat can grant `edit-other-user-avatar`, but
   * this client has no screen that administers somebody else's account, and a
   * route that would accept a target it never sends is a route worth not
   * having.
   */
  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  async setMyAvatar(
    @CurrentSession() session: ServerSession,
    @Req() request: FastifyRequest,
  ): Promise<SetMyAvatarResponse> {
    const image = await readAvatarUpload(request);
    const client = this.rocketChat.userClient(session);

    try {
      const before = await client.users.me();
      await client.users.setAvatar(image);
      return await this.profileWithSettledAvatar(session, client, before.avatarETag);
    } catch (error) {
      throw toApiException(error);
    }
  }

  /** Drops the picture; Rocket.Chat goes back to serving generated initials. */
  @Delete('me/avatar')
  @HttpCode(HttpStatus.OK)
  async resetMyAvatar(@CurrentSession() session: ServerSession): Promise<SetMyAvatarResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const before = await client.users.me();
      await client.users.resetAvatar(session.rocketChatUserId);
      return await this.profileWithSettledAvatar(session, client, before.avatarETag);
    } catch (error) {
      throw toApiException(error);
    }
  }

  private async profileWithSettledAvatar(
    session: ServerSession,
    client: RocketChatUserClient,
    previousTag: string | undefined,
  ): Promise<SetMyAvatarResponse> {
    const user = await withSettledAvatarTag(
      () => client.users.me(),
      (candidate) => candidate.avatarETag,
      previousTag,
    );

    return toMyProfile(user, this.rocketChat.adapterContext(session));
  }

  @Get(':userIdOrUsername')
  async get(
    @CurrentSession() session: ServerSession,
    @Param('userIdOrUsername') identifier: string,
  ): Promise<GetUserResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const user = await client.users.info(
        looksLikeUserId(identifier) ? { userId: identifier } : { username: identifier },
      );
      return toUserProfile(user, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }
}
