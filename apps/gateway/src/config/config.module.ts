import { Global, Module } from '@nestjs/common';

import { GATEWAY_CONFIG, loadConfig, type GatewayConfig } from './configuration';

/**
 * Configuration is resolved once at boot and injected as a plain frozen object.
 * Reading `process.env` from inside services makes them untestable and hides
 * misconfiguration until the first request touches the offending code path.
 */
@Global()
@Module({
  providers: [
    {
      provide: GATEWAY_CONFIG,
      useFactory: (): GatewayConfig => Object.freeze(loadConfig()),
    },
  ],
  exports: [GATEWAY_CONFIG],
})
export class GatewayConfigModule {}
