import { z } from 'zod';

/**
 * A Rocket.Chat deployment the gateway can front. Several may be configured so
 * one gateway can serve users across separate servers; the session records
 * which one it authenticated against.
 */
const ServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Internal URL the gateway dials, e.g. `http://rocketchat:3000` inside Docker. */
  url: z.string().url(),
  /**
   * Public URL of the same server, used only for building deep links shown to
   * users. Falls back to `url` when the deployment is not behind a proxy.
   */
  publicUrl: z.string().url().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const parseServers = (raw: string | undefined): ServerConfig[] => {
  if (!raw) return [];

  const trimmed = raw.trim();
  // Accept a bare URL for the single-server case so a first run needs no JSON.
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return [{ id: 'default', name: 'Rocket.Chat', url: trimmed }];
  }

  const parsed: unknown = JSON.parse(trimmed);
  return z.array(ServerConfigSchema).parse(Array.isArray(parsed) ? parsed : [parsed]);
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Either a single Rocket.Chat URL or a JSON array of {@link ServerConfig}. */
  ROCKETCHAT_SERVERS: z.string().min(1),

  /**
   * Signs the session cookie. Sessions survive a restart only if this stays
   * stable, so production deployments must set it explicitly.
   */
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().default('orc_session'),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(60 * 60 * 24 * 7),
  /** `lax` works for same-site deployments; cross-site frontends need `none` plus HTTPS. */
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION_COOKIE_SECURE: z.stringbool().optional(),
  SESSION_COOKIE_DOMAIN: z.string().optional(),

  /** Omit to keep sessions in memory — fine for a single instance, lost on restart. */
  REDIS_URL: z.string().url().optional(),

  /** Comma-separated browser origins allowed to call the API with credentials. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(100 * 1024 * 1024),

  /**
   * How long the gateway will spend pushing one file into Rocket.Chat.
   *
   * Sized against `MAX_UPLOAD_BYTES` and the slowest link worth serving rather
   * than against how responsive Rocket.Chat is: the default allows the largest
   * accepted upload roughly 350 KB/s. Too low and a large file over a real
   * network is reported to the user as a Rocket.Chat that stopped answering.
   */
  UPLOAD_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(300),

  /**
   * How long an idle upstream realtime connection is kept after the last
   * browser socket detaches, so a page reload does not pay a full DDP
   * handshake and re-login.
   */
  REALTIME_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).default(30),
});

export type GatewayConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;
  servers: ServerConfig[];
  defaultServerId: string;
  session: {
    secret: string;
    cookieName: string;
    ttlSeconds: number;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    domain?: string;
  };
  redisUrl?: string;
  corsOrigins: string[];
  maxUploadBytes: number;
  uploadTimeoutMs: number;
  realtimeIdleTimeoutMs: number;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): GatewayConfig => {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid gateway configuration:\n${issues}`);
  }

  const value = parsed.data;
  const servers = parseServers(value.ROCKETCHAT_SERVERS);

  if (servers.length === 0) {
    throw new Error('ROCKETCHAT_SERVERS must define at least one Rocket.Chat server');
  }

  const isProduction = value.NODE_ENV === 'production';

  return {
    nodeEnv: value.NODE_ENV,
    isProduction,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    servers,
    defaultServerId: servers[0].id,
    session: {
      secret: value.SESSION_SECRET,
      cookieName: value.SESSION_COOKIE_NAME,
      ttlSeconds: value.SESSION_TTL_SECONDS,
      sameSite: value.SESSION_COOKIE_SAMESITE,
      // `SameSite=None` is meaningless without `Secure`, and browsers drop the
      // cookie entirely rather than warning, so it is forced on here.
      secure: value.SESSION_COOKIE_SECURE ?? (isProduction || value.SESSION_COOKIE_SAMESITE === 'none'),
      ...(value.SESSION_COOKIE_DOMAIN ? { domain: value.SESSION_COOKIE_DOMAIN } : {}),
    },
    ...(value.REDIS_URL ? { redisUrl: value.REDIS_URL } : {}),
    corsOrigins: value.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    maxUploadBytes: value.MAX_UPLOAD_BYTES,
    uploadTimeoutMs: value.UPLOAD_TIMEOUT_SECONDS * 1_000,
    realtimeIdleTimeoutMs: value.REALTIME_IDLE_TIMEOUT_SECONDS * 1_000,
  };
};

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');
