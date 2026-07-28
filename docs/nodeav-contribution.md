# Upstream contribution to node-av

While building beamdesk's H.264 capture we found a real bug in node-av and
contributed the fix upstream.

- **Issue:** https://github.com/seydx/node-av/issues/314
- **Pull request:** https://github.com/seydx/node-av/pull/315

## The bug

node-av's high-level `Encoder` clears `frame.pictType` on every frame in
`prepareFrameForEncoding`, so a caller cannot force a keyframe on demand.
Setting `frame.pictType = AV_PICTURE_TYPE_I` (with `forced-idr`) — the standard
FFmpeg way to request an IDR — is erased before the frame reaches the codec, so
no forced keyframe is emitted. For a live stream that means a receiver can never
recover its first IDR on demand and stays black.

This is why `agent/src/capture/h264.ts` uses the low-level
`CodecContext.sendFrame()` rather than the ergonomic `Encoder.packets()`
wrapper — the low-level path does not clear `pictType`, so forced keyframes
work. See the note in that file.

## The fix (PR #315)

An opt-in `EncoderOptions.preserveFramePictType` flag: when set, the frame's
`pictType` is passed through untouched, so forced keyframes work through the
high-level API. Default behaviour is unchanged, so transcoding callers — for
which clearing the input's frame-type hints is correct — are unaffected.

Verified against libx264 at runtime: by default a forced keyframe request on a
mid-stream frame produces no keyframe; with the flag it produces the IDR. Both
cases are covered by tests, confirmed to fail without the change.

## If node-av merges it

Once released, beamdesk's capture could move back to the high-level
`Encoder.packets()` wrapper with `preserveFramePictType: true` and
`requestKeyframe()` implemented by tagging the next frame's `pictType`. Until
then, the low-level path stays — it works and is well understood.
