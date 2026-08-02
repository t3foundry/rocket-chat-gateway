import {
  AddRoomMembersRequestSchema,
  CreateDirectRoomRequestSchema,
  CreateRoomRequestSchema,
  ListRoomFilesQuerySchema,
  ListRoomMembersQuerySchema,
  PruneMessagesRequestSchema,
  UpdateRoomMemberRequestSchema,
  UpdateRoomNotificationsRequestSchema,
  UpdateRoomRequestSchema,
  ListRoomsQuerySchema,
  UpdateRoomStateRequestSchema,
  type AddRoomMembersRequest,
  type AddRoomMembersResponse,
  type CreateDirectRoomRequest,
  type CreateDirectRoomResponse,
  type ListRoomFilesQuery,
  type ListRoomFilesResponse,
  type ListRoomMembersQuery,
  type ListRoomMembersResponse,
  type ListRoomRolesResponse,
  type ListRoomsQuery,
  type ListRoomsResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type LeaveRoomResponse,
  type MarkRoomReadResponse,
  type MarkRoomUnreadResponse,
  type PruneMessagesRequest,
  type PruneMessagesResponse,
  type RemoveRoomMemberResponse,
  type RoomNotificationPreferences,
  type UpdateRoomMemberRequest,
  type UpdateRoomMemberResponse,
  type UpdateRoomNotificationsRequest,
  type UpdateRoomRequest,
  type RoomSummary,
  type SetRoomAvatarResponse,
  type UpdateRoomStateRequest,
} from '@open-rocket-chat/api-contract';
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

import { readAvatarUpload } from '../common/avatar';
import { zodPipe } from '../common/zod-validation.pipe';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';
import { RoomsService } from './rooms.service';

@Controller('rooms')
@UseGuards(SessionGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentSession() session: ServerSession,
    @Body(zodPipe(CreateRoomRequestSchema)) body: CreateRoomRequest,
  ): Promise<CreateRoomResponse> {
    return this.rooms.create(session, body);
  }

  @Get()
  async list(
    @CurrentSession() session: ServerSession,
    @Query(zodPipe(ListRoomsQuerySchema)) query: ListRoomsQuery,
  ): Promise<ListRoomsResponse> {
    return this.rooms.list(session, query);
  }

  /** Opens (creating if needed) a direct message. Declared before `:roomId` so
   * `direct` is not swallowed by the parameterised route. */
  @Post('direct')
  @HttpCode(HttpStatus.OK)
  async createDirect(
    @CurrentSession() session: ServerSession,
    @Body(zodPipe(CreateDirectRoomRequestSchema)) body: CreateDirectRoomRequest,
  ): Promise<CreateDirectRoomResponse> {
    return this.rooms.createDirect(session, body.username);
  }

  @Get(':roomId')
  async get(@CurrentSession() session: ServerSession, @Param('roomId') roomId: string): Promise<RoomSummary> {
    return this.rooms.get(session, roomId);
  }

  @Get(':roomId/members')
  async members(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListRoomMembersQuerySchema)) query: ListRoomMembersQuery,
  ): Promise<ListRoomMembersResponse> {
    return this.rooms.members(session, roomId, query);
  }

  @Post(':roomId/members')
  @HttpCode(HttpStatus.OK)
  async addMembers(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(AddRoomMembersRequestSchema)) body: AddRoomMembersRequest,
  ): Promise<AddRoomMembersResponse> {
    await this.rooms.addMembers(session, roomId, body.userIds);
    return { ok: true };
  }

  @Patch(':roomId/members/:userId')
  async updateMember(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Param('userId') userId: string,
    @Body(zodPipe(UpdateRoomMemberRequestSchema)) body: UpdateRoomMemberRequest,
  ): Promise<UpdateRoomMemberResponse> {
    await this.rooms.updateMember(session, roomId, userId, body);
    return { ok: true };
  }

  @Delete(':roomId/members/:userId')
  async removeMember(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Param('userId') userId: string,
  ): Promise<RemoveRoomMemberResponse> {
    await this.rooms.removeMember(session, roomId, userId);
    return { ok: true };
  }

  @Get(':roomId/roles')
  async roles(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
  ): Promise<ListRoomRolesResponse> {
    return this.rooms.roles(session, roomId);
  }

  @Get(':roomId/files')
  async files(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListRoomFilesQuerySchema)) query: ListRoomFilesQuery,
  ): Promise<ListRoomFilesResponse> {
    return this.rooms.files(session, roomId, query);
  }

  @Get(':roomId/notifications')
  async notifications(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
  ): Promise<RoomNotificationPreferences> {
    return this.rooms.notifications(session, roomId);
  }

  @Patch(':roomId/notifications')
  async updateNotifications(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(UpdateRoomNotificationsRequestSchema)) body: UpdateRoomNotificationsRequest,
  ): Promise<RoomNotificationPreferences> {
    return this.rooms.updateNotifications(session, roomId, body);
  }

  /** Bulk message deletion. Irreversible, which is why it is not a `DELETE` on a range. */
  @Post(':roomId/prune')
  @HttpCode(HttpStatus.OK)
  async prune(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(PruneMessagesRequestSchema)) body: PruneMessagesRequest,
  ): Promise<PruneMessagesResponse> {
    return this.rooms.prune(session, roomId, body);
  }

  @Post(':roomId/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
  ): Promise<MarkRoomReadResponse> {
    await this.rooms.markRead(session, roomId);
    return { ok: true };
  }

  @Patch(':roomId')
  async update(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(UpdateRoomRequestSchema)) body: UpdateRoomRequest,
  ): Promise<RoomSummary> {
    return this.rooms.update(session, roomId, body);
  }

  @Post(':roomId/leave')
  @HttpCode(HttpStatus.OK)
  async leave(@CurrentSession() session: ServerSession, @Param('roomId') roomId: string): Promise<LeaveRoomResponse> {
    await this.rooms.leave(session, roomId);
    return { ok: true };
  }

  @Post(':roomId/unread')
  @HttpCode(HttpStatus.OK)
  async markUnread(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
  ): Promise<MarkRoomUnreadResponse> {
    await this.rooms.markUnread(session, roomId);
    return { ok: true };
  }

  /**
   * Sets the room's picture. `multipart/form-data` with an `image` part, the
   * same shape the account avatar uses — Rocket.Chat carries a room avatar as a
   * data URI on a settings call, but that is an upstream detail no client
   * should have to encode for.
   */
  @Post(':roomId/avatar')
  @HttpCode(HttpStatus.OK)
  async setAvatar(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Req() request: FastifyRequest,
  ): Promise<SetRoomAvatarResponse> {
    return this.rooms.setAvatar(session, roomId, await readAvatarUpload(request));
  }

  @Delete(':roomId/avatar')
  @HttpCode(HttpStatus.OK)
  async resetAvatar(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
  ): Promise<SetRoomAvatarResponse> {
    return this.rooms.setAvatar(session, roomId, null);
  }

  @Patch(':roomId/state')
  async updateState(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(UpdateRoomStateRequestSchema)) body: UpdateRoomStateRequest,
  ): Promise<RoomSummary> {
    return this.rooms.updateState(session, roomId, body);
  }
}
