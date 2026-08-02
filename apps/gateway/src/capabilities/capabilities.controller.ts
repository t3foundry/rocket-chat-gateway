import type { ServerCapabilities } from '@open-rocket-chat/api-contract';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';
import { CapabilitiesService } from './capabilities.service';

@Controller('server')
@UseGuards(SessionGuard)
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get('capabilities')
  async get(@CurrentSession() session: ServerSession): Promise<ServerCapabilities> {
    return this.capabilities.get(session);
  }
}
