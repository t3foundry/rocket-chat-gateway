import { Module } from '@nestjs/common';

import { RoomsModule } from '../rooms/rooms.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRegistry } from './realtime.registry';

@Module({
  imports: [RoomsModule],
  providers: [RealtimeRegistry, RealtimeGateway],
  exports: [RealtimeRegistry],
})
export class RealtimeModule {}
