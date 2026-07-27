/**
 * Decides when each arriving audio chunk should start playing.
 *
 * ## Why chunks cannot simply be played on arrival
 *
 * The agent captures on a steady clock, but the network does not deliver on
 * one. Chunks arrive early, late, and occasionally in a burst after a stall.
 * Playing each one the moment it lands reproduces that jitter as audible
 * clicks and gaps, because the audio hardware consumes samples at a constant
 * rate and any hole between two buffers is silence.
 *
 * So playback runs slightly behind arrival: each chunk is scheduled to start
 * exactly where the previous one ends, and the queue itself absorbs the
 * variation. `targetLatency` is how much delay is deliberately held to do that
 * — the entire trade in this file. Too little and every late packet is a gap;
 * too much and the sound lags the picture.
 *
 * ## The two ways the schedule goes wrong
 *
 * It drifts in both directions, and both need correcting or the delay ratchets
 * permanently in one direction:
 *
 *  - **Underrun.** Delivery stalled long enough that the scheduled end is now
 *    in the past. Continuing from it would schedule audio for a moment that
 *    has already gone, which the hardware plays immediately and out of order.
 *  - **Overrun.** Chunks arrived faster than real time — after a stall clears,
 *    typically — so the queue grew and with it the delay. Left alone this is
 *    the failure people actually notice: audio drifting further behind video
 *    the longer it runs, never recovering.
 *
 * Both resynchronise to the target, which costs one small discontinuity and
 * restores the intended latency.
 */
export interface ChunkSchedule {
  /** Context time at which this chunk should start. */
  startAt: number;
  /** Where the next chunk should start if delivery stays healthy. */
  nextTime: number;
  /** True when the schedule was reset; useful as a dropout signal. */
  resynced: boolean;
}

/**
 * @param nextTime  End of the last scheduled chunk, or 0 before any.
 * @param now       The audio context's current time.
 * @param duration  Length of this chunk in seconds.
 * @param targetLatency  Delay to hold when starting or resynchronising.
 * @param maxLatency     Queue depth past which the delay is considered runaway.
 */
export function scheduleChunk(
  nextTime: number,
  now: number,
  duration: number,
  targetLatency: number,
  maxLatency: number,
): ChunkSchedule {
  const fresh = nextTime <= 0;
  const underrun = nextTime < now;
  const overrun = nextTime > now + maxLatency;

  if (fresh || underrun || overrun) {
    const startAt = now + targetLatency;
    return { startAt, nextTime: startAt + duration, resynced: !fresh };
  }
  return { startAt: nextTime, nextTime: nextTime + duration, resynced: false };
}

/** Seconds of audio in a PCM chunk. */
export function chunkDuration(sampleCount: number, sampleRate: number, channels: number): number {
  if (sampleRate <= 0 || channels <= 0) return 0;
  return sampleCount / channels / sampleRate;
}
