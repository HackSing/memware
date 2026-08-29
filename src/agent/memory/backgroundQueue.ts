/**
 * In-process background queue for slow memory work.
 *
 * AgentCore uses this to push unified turn extraction, multimodal extraction,
 * and unified dream consolidation off the hot turn path while keeping deterministic drain
 * semantics for shutdown and tests.
 */

interface QueueJob {
  run: () => Promise<void>;
  resolve: () => void;
}

export class MemoryBackgroundQueue {
  private readonly pending: QueueJob[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private accepting = true;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error(`MemoryBackgroundQueue concurrency must be >= 1 (got ${concurrency})`);
    }
  }

  enqueue(run: () => Promise<void>): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pending.push({ run, resolve });
      this.scheduleDrain();
    });
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  discardPending(): number {
    if (this.pending.length === 0) return 0;
    const dropped = this.pending.splice(0, this.pending.length);
    for (const job of dropped) job.resolve();
    this.notifyIdleIfNeeded();
    return dropped.length;
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  queuedCount(): number {
    return this.pending.length;
  }

  pendingCount(): number {
    return this.inflight.size + this.pending.length;
  }

  async drain(timeoutMs: number = 30_000): Promise<boolean> {
    this.scheduleDrain();
    const idle = this.waitForIdle();
    if (timeoutMs <= 0) {
      await idle;
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const winner = await Promise.race([idle.then(() => 'idle' as const), timeout]);
      return winner === 'idle';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.startJobs();
    }, 0);
  }

  private startJobs(): void {
    while (this.inflight.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      let tracked: Promise<void>;
      tracked = Promise.resolve()
        .then(job.run)
        .catch(() => { /* caller handles/logs failures */ })
        .finally(() => {
          this.inflight.delete(tracked);
          job.resolve();
          if (this.pending.length > 0) this.scheduleDrain();
          this.notifyIdleIfNeeded();
        });
      this.inflight.add(tracked);
    }
    this.notifyIdleIfNeeded();
  }

  private waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.inflight.size === 0 && !this.drainTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private notifyIdleIfNeeded(): void {
    if (this.pending.length !== 0 || this.inflight.size !== 0 || this.drainTimer) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
