export type AdmissionBudget = 'batch' | 'read' | 'capture';
type SlotBudget = AdmissionBudget | 'native';
type Ownership = 'owned' | 'transferred' | 'released';

export interface AdmissionLease {
  release(): void;
  transferTo(settlement: Promise<unknown>): void;
}

export interface ByteLease extends AdmissionLease {
  readonly bytes: number;
}

export class AdmissionBusy extends Error {
  readonly code = 'busy';

  constructor(readonly budget: SlotBudget | 'bytes', readonly waitedMs: number) {
    super(`Outbound ${budget} admission is busy`);
    this.name = 'AdmissionBusy';
  }
}

class OwnedLease implements AdmissionLease {
  private state: Ownership = 'owned';

  constructor(private readonly relinquish: () => void) {}

  release(): void {
    if (this.state !== 'owned') return;
    this.finish();
  }

  transferTo(settlement: Promise<unknown>): void {
    if (this.state !== 'owned') {
      void settlement.catch(() => {});
      return;
    }
    this.state = 'transferred';
    // Handle both branches without creating an unobserved rejected finally promise.
    void settlement.then(() => this.finish(), () => this.finish());
  }

  private finish(): void {
    if (this.state === 'released') return;
    this.state = 'released';
    this.relinquish();
  }
}

interface Waiter {
  readonly budget: SlotBudget;
  readonly startedAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (lease: AdmissionLease) => void;
  readonly reject: (error: AdmissionBusy) => void;
}

const SLOT_LIMITS: Readonly<Record<SlotBudget, number>> = {
  batch: 8, read: 8, capture: 8, native: 4,
};
const SOURCE_BYTES = 80 * 1024 * 1024;
const WAITERS = 16;
const WAIT_MS = 2000;

/** One owner for the daemon's process-local budgets; tests may create isolated owners. */
export class OutboundAdmission {
  private readonly active: Record<SlotBudget, number> = { batch: 0, read: 0, capture: 0, native: 0 };
  private readonly waiters: Waiter[] = [];
  private reservedBytes = 0;

  get usage() {
    return { ...this.active, waiters: this.waiters.length, reservedBytes: this.reservedBytes };
  }

  acquire(budget: AdmissionBudget): Promise<AdmissionLease> {
    return this.acquireSlot(budget);
  }

  /** The callback's promise must include the operation's own final cleanup. */
  async run<T>(budget: AdmissionBudget, operation: () => Promise<T>): Promise<T> {
    const slot = await this.acquire(budget);
    try {
      return await operation();
    } finally {
      slot.release();
    }
  }

  reserveBytes(bytes: number): ByteLease {
    this.validateBytes(bytes);
    return this.reserve(bytes).lease;
  }

  /** Synthetic dispatch boundary, not a native reader. Settlement includes native cleanup. */
  async runNativeRead(
    maxBytes: number,
    operation: () => Promise<Uint8Array>,
  ): Promise<{ bytes: Uint8Array; lease: ByteLease }> {
    this.validateBytes(maxBytes);
    const read = await this.acquire('read');
    try {
      const reservation = this.reserve(maxBytes);
      try {
        const native = await this.acquireSlot('native');
        try {
          const bytes = await operation();
          // A short view still owns its entire backing allocation.
          reservation.shrink(bytes.buffer.byteLength);
          return { bytes, lease: reservation.lease };
        } finally {
          native.release();
        }
      } catch (error) {
        reservation.lease.release();
        throw error;
      }
    } finally {
      read.release();
    }
  }

  private validateBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('Source bytes must be a nonnegative safe integer');
    }
  }

  private reserve(bytes: number) {
    if (bytes > SOURCE_BYTES - this.reservedBytes) throw new AdmissionBusy('bytes', 0);
    this.reservedBytes += bytes;
    let retained = bytes;
    const owner = new OwnedLease(() => { this.reservedBytes -= retained; });
    const lease: ByteLease = {
      get bytes() { return retained; },
      release: () => owner.release(),
      transferTo: settlement => owner.transferTo(settlement),
    };
    return {
      lease,
      shrink: (backingBytes: number) => {
        if (backingBytes > retained) throw new RangeError('Backing allocation exceeds reserved maxBytes');
        this.reservedBytes -= retained - backingBytes;
        retained = backingBytes;
      },
    };
  }

  private acquireSlot(budget: SlotBudget): Promise<AdmissionLease> {
    this.drain();
    if (this.active[budget] < SLOT_LIMITS[budget]) return Promise.resolve(this.take(budget));
    if (this.waiters.length === WAITERS) return Promise.reject(new AdmissionBusy(budget, 0));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        budget, startedAt: Date.now(), resolve, reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(new AdmissionBusy(budget, Date.now() - waiter.startedAt));
        }, WAIT_MS),
      };
      this.waiters.push(waiter);
    });
  }

  private take(budget: SlotBudget): AdmissionLease {
    this.active[budget]++;
    return new OwnedLease(() => {
      this.active[budget]--;
      this.drain();
    });
  }

  private drain(): void {
    // FIFO among eligible requests; a saturated budget cannot block another budget.
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (!waiter) break;
      const waitedMs = Date.now() - waiter.startedAt;
      if (waitedMs >= WAIT_MS || this.active[waiter.budget] < SLOT_LIMITS[waiter.budget]) {
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waitedMs >= WAIT_MS) waiter.reject(new AdmissionBusy(waiter.budget, waitedMs));
        else waiter.resolve(this.take(waiter.budget));
      } else {
        index++;
      }
    }
  }
}

export const outboundAdmission = new OutboundAdmission();
