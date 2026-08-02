import { Controller, Get } from '@nestjs/common';

import { RocketChatService } from '../rocketchat/rocketchat.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  servers: { id: string; reachable: boolean; version: string | null }[];
}

@Controller('health')
export class HealthController {
  constructor(private readonly rocketChat: RocketChatService) {}

  /**
   * Liveness only: returns 200 as long as the process is serving. Kubernetes
   * must not restart the gateway because Rocket.Chat is down — that would take
   * out the one component able to report the outage.
   */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: reports whether each configured Rocket.Chat server answers. */
  @Get('upstream')
  async upstream(): Promise<HealthResponse> {
    const servers = await Promise.all(
      this.rocketChat.servers.map(async (server) => {
        try {
          const version = await this.rocketChat.restClient(server.id).version();
          return { id: server.id, reachable: true, version };
        } catch {
          return { id: server.id, reachable: false, version: null };
        }
      }),
    );

    return {
      status: servers.every((server) => server.reachable) ? 'ok' : 'degraded',
      servers,
    };
  }
}
