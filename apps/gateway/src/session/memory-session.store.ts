import type { SessionRecord, SessionStore } from './session.types';

/**
 * Default store. Sessions are lost on restart and are not shared between
 * instances, which is acceptable for development and single-node deployments;
 * configure `REDIS_URL` for anything else.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // Never hold the process open just to expire sessions.
    this.sweeper.unref?.();
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(id);
    if (!record) return null;

    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }

    return record;
  }

  async set(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, record);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
