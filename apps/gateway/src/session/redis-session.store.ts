import { Redis } from 'ioredis';

import type { SessionRecord, SessionStore } from './session.types';

const KEY_PREFIX = 'orc:session:';

/**
 * Shared session store for multi-instance deployments. Records expire through
 * Redis' own TTL rather than a sweeper, so an instance that dies mid-session
 * does not leave the entry behind.
 */
export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  static fromUrl(url: string): RedisSessionStore {
    return new RedisSessionStore(
      new Redis(url, {
        // Fail requests fast instead of queueing them while Redis is down; the
        // caller turns that into a 503 rather than hanging the browser.
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      }),
    );
  }

  async get(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      // A corrupt entry is indistinguishable from no session; drop it so the
      // user re-authenticates instead of hitting the same error forever.
      await this.delete(id);
      return null;
    }
  }

  async set(record: SessionRecord): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1_000));
    await this.redis.set(`${KEY_PREFIX}${record.id}`, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${id}`);
  }

  async dispose(): Promise<void> {
    await this.redis.quit();
  }
}
