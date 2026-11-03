import 'reflect-metadata';

import { API_BASE_PATH } from '@t3foundry/open-rocket-chat-api-contract';
import fastifyCookie from '@fastify/cookie';
import { SERVER_ID_HEADER } from '@t3foundry/open-rocket-chat-api-contract';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { GATEWAY_CONFIG, type GatewayConfig } from './config/configuration';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Rocket.Chat ids appear in paths and are case sensitive.
      caseSensitive: true,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  const config = app.get<GatewayConfig>(GATEWAY_CONFIG);

  await app.register(fastifyCookie, { secret: config.session.secret });

  await app.register(fastifyCors, {
    origin: config.corsOrigins,
    // Required for the session cookie to be sent from a different origin.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // Listed explicitly rather than reflected: the server-scoping header has to
    // survive a cross-origin preflight for multi-server clients to work at all.
    allowedHeaders: ['content-type', 'accept', 'accept-language', SERVER_ID_HEADER],
  });

  await app.register(fastifyHelmet, {
    // The gateway serves JSON and proxied media, never HTML, so a restrictive
    // default CSP would only get in the way of the separately hosted frontend.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
  });

  app.setGlobalPrefix(API_BASE_PATH, {
    // The realtime endpoint is served by a raw WebSocket server outside the
    // Nest router, so it must not be prefixed or intercepted.
    exclude: ['/ws'],
  });

  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: config.host });

  app
    .get(Logger)
    .log(
      `Gateway listening on http://${config.host}:${config.port}${API_BASE_PATH} ` +
        `(servers: ${config.servers.map((server) => server.id).join(', ')})`,
    );
};

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this is the one
  // place a bare console write is the right call.
  console.error('Gateway failed to start:', error);
  process.exit(1);
});
