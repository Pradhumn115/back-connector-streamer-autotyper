/**
 * Platform backend that actually blocks/unblocks physical input at the agent.
 * `supported` is false where blocking isn't implemented for the current OS.
 */
export interface InputLockBackend {
  readonly supported: boolean;
  lock(): Promise<void>;
  unlock(): Promise<void>;
}

export interface InputLockManagerDeps {
  backend: InputLockBackend;
  /** Auto-release the lock after this long with no client activity. */
  autoReleaseMs: number;
  /** Called whenever the locked state changes (for notifying the client). */
  onChange: (locked: boolean) => void;
  /** Injectable timer for tests; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

/**
 * Owns the local-input lock lifecycle with two hard safety guarantees so the
 * person at the agent can never be permanently locked out:
 *   1. Auto-release after `autoReleaseMs` of no client activity.
 *   2. Explicit unlock() (called on client disconnect / client request).
 * The physical unlock hotkey is deliberately NOT relied upon, because a full
 * block (e.g. Windows BlockInput) also blocks that hotkey.
 */
export class InputLockManager {
  private locked = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: InputLockManagerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  get supported(): boolean {
    return this.deps.backend.supported;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Engage the lock. No-op if unsupported or already locked. */
  async lock(): Promise<void> {
    if (!this.deps.backend.supported || this.locked) return;
    await this.deps.backend.lock();
    this.locked = true;
    this.deps.onChange(true);
    this.armWatchdog();
  }

  /** Release the lock. No-op if not locked. */
  async unlock(): Promise<void> {
    if (!this.locked) return;
    this.disarmWatchdog();
    await this.deps.backend.unlock();
    this.locked = false;
    this.deps.onChange(false);
  }

  async toggle(): Promise<void> {
    if (this.locked) await this.unlock();
    else await this.lock();
  }

  /** Call on each incoming client input; keeps the lock alive (resets timer). */
  noteClientActivity(): void {
    if (this.locked) this.armWatchdog();
  }

  private armWatchdog(): void {
    this.disarmWatchdog();
    this.watchdog = this.setTimer(() => {
      // Failsafe: client went quiet -> hand control back to the agent user.
      void this.unlock();
    }, this.deps.autoReleaseMs);
  }

  private disarmWatchdog(): void {
    if (this.watchdog !== null) {
      this.clearTimer(this.watchdog);
      this.watchdog = null;
    }
  }
}
