import { Global, Module } from '@nestjs/common';

import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
import { MemorySessionStore } from './memory-session.store';
import { RedisSessionStore } from './redis-session.store';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { SESSION_STORE, type SessionStore } from './session.types';

@Global()
@Module({
  providers: [
    {
      provide: SESSION_STORE,
      inject: [GATEWAY_CONFIG],
      useFactory: (config: GatewayConfig): SessionStore =>
        config.redisUrl ? RedisSessionStore.fromUrl(config.redisUrl) : new MemorySessionStore(),
    },
    SessionService,
    SessionGuard,
  ],
  exports: [SessionService, SessionGuard, SESSION_STORE],
})
export class SessionModule {}
