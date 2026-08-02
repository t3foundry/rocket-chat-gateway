import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { GatewayConfigModule } from './config/config.module';
import { loadConfig } from './config/configuration';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommandsModule } from './commands/commands.module';
import { EmojiModule } from './emoji/emoji.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { MessagesModule } from './messages/messages.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RocketChatModule } from './rocketchat/rocketchat.module';
import { RoomsModule } from './rooms/rooms.module';
import { SessionModule } from './session/session.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    GatewayConfigModule,
    LoggerModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return {
          pinoHttp: {
            level: config.logLevel,
            transport: config.isProduction ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
            // Credentials and session cookies must never reach the log sink,
            // where they typically outlive the session itself.
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'req.headers["x-auth-token"]',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.totpCode',
              ],
              remove: true,
            },
            autoLogging: {
              ignore: (request) => request.url === '/api/v1/health',
            },
          },
        };
      },
    }),
    RocketChatModule,
    SessionModule,
    AuthModule,
    RoomsModule,
    MessagesModule,
    FilesModule,
    UsersModule,
    EmojiModule,
    CommandsModule,
    CapabilitiesModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
