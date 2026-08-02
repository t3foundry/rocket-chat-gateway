import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginServicesService } from './login-services.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginServicesService],
  exports: [AuthService],
})
export class AuthModule {}
