/**
 * Job queue connecting the relay (enqueue `translate`) and the worker (consume `translate`, enqueue
 * `deliver`). In-process impl backs dev/CI (relay + worker in one process); pg-boss on Supabase
 * Postgres is the production target across containers (TECHNICAL-SPEC §4/§7) — see DECISIONS D1/D5.
 */
export type JobHandler = (data: unknown) => Promise<void>;

export interface Queue {
  publish(topic: string, data: unknown): Promise<void>;
  subscribe(topic: string, handler: JobHandler): void;
  /** Resolves once every job published so far has finished — test/shutdown aid. */
  drain(): Promise<void>;
}

export interface TranslateJob {
  renderId: string;
  kind: "html" | "url";
  html?: string;
  url?: string;
  viewport?: { width: number; height: number };
}

export interface DeliverJob {
  renderId: string;
}

/**
 * Fire-and-forget in-process queue. `publish` schedules handlers on the microtask queue (so a POST
 * returns "translating" immediately) and tracks in-flight work so `drain()` can await it.
 */
export class InMemoryQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler[]>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly onError: (topic: string, err: unknown) => void;

  constructor(onError?: (topic: string, err: unknown) => void) {
    this.onError = onError ?? (() => {});
  }

  subscribe(topic: string, handler: JobHandler): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
  }

  async publish(topic: string, data: unknown): Promise<void> {
    for (const handler of this.handlers.get(topic) ?? []) {
      const p = Promise.resolve()
        .then(() => handler(data))
        .catch((err) => this.onError(topic, err))
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }
}
