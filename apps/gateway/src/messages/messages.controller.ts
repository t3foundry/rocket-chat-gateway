import {
  ListMessageCollectionQuerySchema,
  ListMessagesQuerySchema,
  ListThreadsQuerySchema,
  SearchMessagesQuerySchema,
  SendMessageRequestSchema,
  UpdateMessageRequestSchema,
  type DeleteMessageResponse,
  type ListMentionedMessagesResponse,
  type ListMessageCollectionQuery,
  type ListMessagesQuery,
  type ListMessagesResponse,
  type ListPinnedMessagesResponse,
  type ListStarredMessagesResponse,
  type ListThreadsQuery,
  type ListThreadsResponse,
  type Message,
  type MessageFlagResponse,
  type ReactResponse,
  type SearchMessagesQuery,
  type SearchMessagesResponse,
  type SendMessageRequest,
  type UpdateMessageRequest,
} from '@t3foundry/open-rocket-chat-api-contract';
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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { zodPipe } from '../common/zod-validation.pipe';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';
import { MessagesService } from './messages.service';

@Controller('rooms/:roomId')
@UseGuards(SessionGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('messages')
  async list(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListMessagesQuerySchema)) query: ListMessagesQuery,
  ): Promise<ListMessagesResponse> {
    return this.messages.list(session, roomId, query);
  }

  /** Declared before `messages/:messageId` so the literal path wins the match. */
  @Get('messages/search')
  async search(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(SearchMessagesQuerySchema)) query: SearchMessagesQuery,
  ): Promise<SearchMessagesResponse> {
    return this.messages.search(session, roomId, query.q, query.limit);
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Body(zodPipe(SendMessageRequestSchema)) body: SendMessageRequest,
  ): Promise<Message> {
    return this.messages.send(session, roomId, body);
  }

  @Patch('messages/:messageId')
  async update(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Param('messageId') messageId: string,
    @Body(zodPipe(UpdateMessageRequestSchema)) body: UpdateMessageRequest,
  ): Promise<Message> {
    return this.messages.update(session, roomId, messageId, body.text);
  }

  @Delete('messages/:messageId')
  async remove(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Param('messageId') messageId: string,
  ): Promise<DeleteMessageResponse> {
    await this.messages.delete(session, roomId, messageId);
    return { ok: true };
  }

  @Put('messages/:messageId/reactions/:emoji')
  async addReaction(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<ReactResponse> {
    await this.messages.react(session, messageId, decodeURIComponent(emoji), true);
    return { ok: true };
  }

  @Delete('messages/:messageId/reactions/:emoji')
  async removeReaction(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<ReactResponse> {
    await this.messages.react(session, messageId, decodeURIComponent(emoji), false);
    return { ok: true };
  }

  @Post('messages/:messageId/pin')
  @HttpCode(HttpStatus.OK)
  async pin(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
  ): Promise<MessageFlagResponse> {
    await this.messages.setPinned(session, messageId, true);
    return { ok: true };
  }

  @Delete('messages/:messageId/pin')
  async unpin(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
  ): Promise<MessageFlagResponse> {
    await this.messages.setPinned(session, messageId, false);
    return { ok: true };
  }

  @Post('messages/:messageId/star')
  @HttpCode(HttpStatus.OK)
  async star(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
  ): Promise<MessageFlagResponse> {
    await this.messages.setStarred(session, messageId, true);
    return { ok: true };
  }

  @Delete('messages/:messageId/star')
  async unstar(
    @CurrentSession() session: ServerSession,
    @Param('messageId') messageId: string,
  ): Promise<MessageFlagResponse> {
    await this.messages.setStarred(session, messageId, false);
    return { ok: true };
  }

  @Get('threads')
  async threads(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListThreadsQuerySchema)) query: ListThreadsQuery,
  ): Promise<ListThreadsResponse> {
    return this.messages.listThreads(session, roomId, query.offset, query.limit);
  }

  @Get('pinned')
  async pinned(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListMessageCollectionQuerySchema)) query: ListMessageCollectionQuery,
  ): Promise<ListPinnedMessagesResponse> {
    return this.messages.listCollection(session, roomId, 'pinned', query.offset, query.limit);
  }

  @Get('starred')
  async starred(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListMessageCollectionQuerySchema)) query: ListMessageCollectionQuery,
  ): Promise<ListStarredMessagesResponse> {
    return this.messages.listCollection(session, roomId, 'starred', query.offset, query.limit);
  }

  @Get('mentions')
  async mentions(
    @CurrentSession() session: ServerSession,
    @Param('roomId') roomId: string,
    @Query(zodPipe(ListMessageCollectionQuerySchema)) query: ListMessageCollectionQuery,
  ): Promise<ListMentionedMessagesResponse> {
    return this.messages.listCollection(session, roomId, 'mentions', query.offset, query.limit);
  }
}
