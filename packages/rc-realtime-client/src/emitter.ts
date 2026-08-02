export type Unsubscribe = () => void;

/**
 * A minimal typed event emitter. Node's `EventEmitter` would work, but keeping
 * this package free of Node built-ins means it also runs unchanged in a worker
 * or an edge runtime, which the twenty lines below are a small price for.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener as (payload: never) => void);

    return () => {
      bucket?.delete(listener as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;

    // Snapshot first: a listener that unsubscribes itself would otherwise
    // mutate the set mid-iteration and skip the listener after it.
    for (const listener of [...bucket]) {
      (listener as (payload: Events[K]) => void)(payload);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
