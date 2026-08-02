import { Global, Module } from '@nestjs/common';

import { RocketChatService } from './rocketchat.service';

@Global()
@Module({
  providers: [RocketChatService],
  exports: [RocketChatService],
})
export class RocketChatModule {}
