# Native-resolution encode width, with a fully dynamic quality ladder

## Problem

Encode width defaulted to a fixed 1920px regardless of the agent's actual
screen size — a deliberate choice (quality is bits-per-pixel; spreading a
fixed bitrate over more pixels looks softer), overridable via
`BCSA_MAX_WIDTH`, but not tied to what the display actually is.

Raising `BCSA_MAX_WIDTH` above 1920 exposed a real bug: the adaptive
quality ladder (`QUALITY_LADDER` in `connection/index.ts`) was a **fixed
absolute table** starting at `{1920, 60}`. The first time the adaptive
controller needed to step resolution down at all (bitrate already at the
floor and still congested), it called `setScale(1920, 30)` — the ladder's
second rung — regardless of what the session actually started at. A session
that began at 3840px would drop straight to 1920px in one jump on its first
ever congestion event, and could never climb back above 1920px for the rest
of that connection: "climb back up" only ever re-applied the table's own
absolute values, never the original higher starting width.

## Design

### 1. Default encode width = the agent's native screen width

`agent/src/index.ts`: `maxWidth` now defaults to `input.screenSize().width`
(falling back to 1920 if that call fails) instead of a fixed 1920.
`BCSA_MAX_WIDTH` still overrides either way — e.g. to deliberately cap a weak
link's starting resolution.

### 2. The quality ladder is relative to the session's actual starting width, not a fixed table

`buildQualityLadder(startWidth, startFps)` in `connection/index.ts` replaces
the old fixed `QUALITY_LADDER` array. Built once per connection (lazily, in
`ConnectionServer.getLadder()`) from `capture.encodeWidth` — whatever the
capture engine actually started at, whether that's the native width, a
`BCSA_MAX_WIDTH` override, or the 1920 fallback.

### 3. The ladder is continuous, not a handful of big jumps

Researched how real-time systems handle this (not guessed): Chrome's own
WebRTC video pipeline (the `QualityScaler` behind `degradationPreference`)
scales resolution in small, similarly-sized continuous steps driven by
encoder feedback, rather than jumping between a handful of fixed named
resolutions the way on-demand ABR ladders (HLS/DASH) do — a live picture has
no buffer to smooth over a big visible jump the way a buffered video player
does.

`buildQualityLadder` mirrors that: each resolution rung is `LADDER_WIDTH_STEP`
(0.8) times the previous rung's width, descending from the starting width down
to a 320px floor — roughly a dozen rungs from 1920 instead of the old table's
six. Frame rate drops from the starting fps to 30 once (at full resolution),
then to 15 once width has fallen to half the starting width — same
"resolution before frame rate" philosophy as before, just applied
continuously. Confirmed in a real test run: `1920px @ 30fps` stepped to
`1536px @ 30fps` (0.8 × 1920), not a jump to some fixed number.

### 4. The bitrate ceiling scales with resolution too

`BITRATE_MAX_KBPS_AT_1920` (20000, renamed from `BITRATE_MAX_KBPS`) is now a
*baseline*, not the actual ceiling. `ConnectionServer.bitrateCeilingKbps()`
scales it by `(encodeWidth / 1920)²` — pixel *area*, not width, is what
"bits per pixel" means, and area scales with width squared for a fixed aspect
ratio. Never scaled below the baseline (a smaller-than-1920 display keeps
exactly the ceiling it always had) and capped at `BITRATE_MAX_KBPS_CAP`
(60000) so an unusually large display doesn't imply a bitrate no real network
can sustain.

Without this, defaulting to native resolution on a high-DPI display would
have made the *default* experience worse, not better — the same fixed
20000kbps spread over more pixels than it was tuned for, directly
contradicting the point of streaming at native resolution in the first place.

## Testing

Full agent test suite (78 tests) passes unchanged, including the two tests
that exercise this exact code path (`lowers the encoder bitrate when the link
is congested`, `steps resolution and fps down when bitrate hits the floor`) —
their assertions check relative behavior (bitrate decreases, resolution/fps
step down), so they remain valid against the new dynamic implementation
without modification. Manually verified end-to-end: a real agent run on this
machine (1728px native display) now reports `max width 1728px` in its banner,
confirming native-resolution detection works, not just the unit-level logic.
