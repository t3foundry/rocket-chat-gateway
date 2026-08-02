import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_BASE_PATH } from '@open-rocket-chat/api-contract';

import { AppModule } from '../../src/app.module';

export const ROCKETCHAT_URL = process.env.E2E_ROCKETCHAT_URL ?? 'http://localhost:3000';
export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin-password-123';

/** Mirrors `main.ts` so the suite exercises the real plugin stack, not a subset. */
export const startGateway = async (): Promise<{ app: NestFastifyApplication; baseUrl: string }> => {
  process.env.ROCKETCHAT_SERVERS = ROCKETCHAT_URL;
  process.env.SESSION_SECRET = 'e2e-session-secret-that-is-long-enough-000000';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'warn';
  process.env.NODE_ENV = 'test';
  process.env.REALTIME_IDLE_TIMEOUT_SECONDS = '0';

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ caseSensitive: true }), {
    bufferLogs: true,
  });

  await app.register(fastifyCookie, { secret: process.env.SESSION_SECRET });
  await app.register(fastifyCors, { origin: ['http://localhost:5173'], credentials: true });
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.setGlobalPrefix(API_BASE_PATH, { exclude: ['/ws'] });
  app.enableShutdownHooks();

  // Port 0: let the OS pick, so a stray Rocket.Chat or a parallel run cannot
  // collide with the gateway under test.
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { app, baseUrl: `http://127.0.0.1:${port}` };
};

/** Polls until Rocket.Chat answers, so the suite fails with a clear message rather than a socket error. */
export const waitForRocketChat = async (timeoutMs = 180_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ROCKETCHAT_URL}/api/info`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Rocket.Chat at ${ROCKETCHAT_URL} did not become ready. Start it with \`pnpm rc:up\` from the repo root.`,
  );
};

/**
 * Creates a channel directly against Rocket.Chat for the suite to work in.
 *
 * The stock `general` channel is not usable as a fixture: Rocket.Chat creates
 * it but does not subscribe the seeded admin to it, so it never appears in the
 * room list. Creating a channel subscribes its owner, and an isolated room also
 * keeps repeated runs from interfering with each other.
 */
export const seedTestRoom = async (): Promise<{ roomId: string; name: string }> => {
  const login = await fetch(`${ROCKETCHAT_URL}/api/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });

  if (!login.ok) {
    throw new Error(`Could not authenticate against Rocket.Chat as \`${ADMIN_USERNAME}\` (HTTP ${login.status})`);
  }

  const { data } = (await login.json()) as { data: { authToken: string; userId: string } };
  const name = `e2e-${Date.now().toString(36)}`;

  const created = await fetch(`${ROCKETCHAT_URL}/api/v1/channels.create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': data.authToken,
      'x-user-id': data.userId,
    },
    body: JSON.stringify({ name }),
  });

  if (!created.ok) {
    throw new Error(`Could not create the fixture channel (HTTP ${created.status})`);
  }

  const payload = (await created.json()) as { channel: { _id: string } };
  return { roomId: payload.channel._id, name };
};

/**
 * A tiny cookie-aware HTTP client. `fetch` does not persist cookies, and the
 * whole point of the gateway is that authentication rides on one.
 */
export class GatewayClient {
  private cookie?: string;

  constructor(private readonly baseUrl: string) {}

  get sessionCookie(): string | undefined {
    return this.cookie;
  }

  async request(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);

    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }

    const response = await fetch(`${this.baseUrl}${API_BASE_PATH}${path}`, { ...init, headers, body });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    };
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, json?: unknown) {
    return this.request(path, { method: 'POST', json });
  }

  patch(path: string, json?: unknown) {
    return this.request(path, { method: 'PATCH', json });
  }

  delete(path: string) {
    return this.request(path, { method: 'DELETE' });
  }

  put(path: string) {
    return this.request(path, { method: 'PUT' });
  }
}
