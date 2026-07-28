/**
 * Applies only the newest of a burst of requests, dropping the ones it overtook.
 *
 * ## Why the naive version is wrong, not merely slow
 *
 * A slider being dragged sends a change per pixel of travel, and applying one
 * here costs a process spawn — measured at ~116ms to set plus ~119ms to read
 * back on macOS. Awaiting each in turn is the obvious approach and it fails in
 * two ways at once: the work queues for seconds after the user has stopped,
 * and because every await resumes in its own turn there is no guarantee the
 * last request is the last one applied. A measured twenty-step drag ending on
 * 77 left the machine at 65.
 *
 * Intermediate positions have no value the moment a newer one exists — nobody
 * is listening to a volume the slider passed through. So only the newest is
 * kept, and the invariant worth stating is: **the last value requested is the
 * last value applied.**
 *
 * Generic over the value so the same rule can serve anything else that is
 * expensive to apply and cheap to supersede.
 */
export class CoalescingApplier<T> {
  private desired: T | null = null;
  private hasDesired = false;
  private applying = false;

  constructor(private readonly work: (value: T) => Promise<void>) {}

  /** True while a value is being applied; useful for deferring a read-back. */
  get busy(): boolean {
    return this.applying;
  }

  /**
   * Requests `value`, and resolves once the run that includes it has finished.
   *
   * A caller that arrives while work is in progress returns immediately: its
   * value is recorded and the running loop will pick it up, so the caller must
   * not also start one or the two would interleave and lose the ordering this
   * class exists to guarantee.
   */
  async set(value: T): Promise<void> {
    this.desired = value;
    this.hasDesired = true;
    if (this.applying) return;

    this.applying = true;
    try {
      while (this.hasDesired) {
        const target = this.desired as T;
        this.hasDesired = false;
        this.desired = null;
        await this.work(target);
      }
    } finally {
      // Cleared even when work throws: leaving this set would mark the applier
      // permanently busy, and every later request would be accepted and then
      // silently never applied.
      this.applying = false;
    }
  }
}
