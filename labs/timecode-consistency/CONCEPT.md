# Timecode Consistency Lab

This document records the canonical-timing model developed in an isolated lab.
The production application now has a canonical timing implementation; keep
this note as design rationale and use the current source and regression tests
as the authority for implementation details.

## Goal

Create one canonical playhead for each deck, then derive every display/output value from it:

- desktop UI elapsed/remaining/progress
- LAN Web UI elapsed/remaining/progress
- OSC `/vj/deck/*/elapsed`, `/timecode`, `/timecode/frame`
- Arena fallback BPM/timecode status

No module should calculate its own independent playhead once this model is integrated.

## Research Notes

Resolume Arena SMPTE sync follows an external time source and moves a clip playhead to that time. Resolume's own docs emphasize that the incoming frame rate must match the source, and that SMPTE is specifically a playhead sync tool, not a general music-sync solution.

PRO DJ LINK gives several possible timing anchors:

- CDJ status packets on UDP `50002` identify play state, BPM, pitch, master, sync, on-air, current beat, and loaded track.
- Beat packets on UDP `50001` report beat timing and beat-in-bar. They are useful for beat-grid-derived position, but their upcoming beat values are normal-speed values and need pitch scaling.
- Absolute position packets on UDP `50001`, type `0x0b`, are the best source when present. CDJ-3000-class devices can report playhead milliseconds at roughly 30 ms intervals.
- Rekordbox beat-grid data maps beat number to milliseconds inside the track. It is the main fallback when absolute position is missing or stale.

## Canonical Model

For every deck, build a `timing` object:

```js
{
  deck,
  trackKey,
  elapsedMs,
  totalMs,
  remainingMs,
  progress,
  source,        // absolute | beat-grid | raw | hold | none
  sourceAgeMs,
  stale,
  frame,
  timecode
}
```

The source priority is:

1. Fresh absolute position anchor.
2. Fresh beat-grid anchor when absolute is missing or stale.
3. Raw position anchor from status, if nothing better exists.
4. Last held timing when paused/cued/stopped.
5. `null` when no valid track timing exists.

Freshness should be strict enough for outputs:

- absolute position: fresh under about `300 ms`; usable stale window up to about `1000 ms`
- beat-grid/status: fresh under about `1200 ms`; usable stale window up to about `2500 ms`
- if playing and every source is stale, mark `stale: true` and keep the last safe value instead of inventing a long projection

## Projection

An anchor is a playhead value observed at a wall-clock time. While the deck is moving:

```js
projectedMs = anchorMs + (nowMs - anchorSeenMs) * playbackSpeed
```

Where:

```js
playbackSpeed = clamp(1 + pitchPercent / 100, 0.25, 4)
```

If the deck is paused/cued/stopped, do not project. Hold the anchor.

Clamp the final result to `[0, totalMs]` when total length is known.

## Beat-Grid Fallback

If `status.beat` is present and a matching beat grid exists:

```js
anchorMs = beatGrid.beats[beatNumber - 1][0]
```

Beat `0` means the track is before the first beat and should map to `0 ms`.

If the beat number is beyond the beat-grid length, extrapolate using the final beat interval. This only keeps the fallback alive near the end of a track; absolute position remains preferred when available.

## Timecode Conversion

Timecode must be derived only from canonical `elapsedMs` plus offset:

```js
totalFrames = floor((elapsedMs + offsetMs) * fps / 1000)
HH:MM:SS:FF
```

For the current app, support `24`, `25`, and `30 fps`. Do not silently mix UI frame rate and output frame rate.

## Integration Contract

The lab established these requirements for production integration:

1. Compute `timing` in `monitor.cjs` before `getVjDecks()` and before `bridge.publishStatus()`.
2. Store the timing fields on the deck/status snapshot.
3. Make renderer, Web UI, OSC, and Arena fallback use those fields directly.
4. Keep experimental timing changes isolated until unit tests, capture replays,
   and live packet checks pass.
