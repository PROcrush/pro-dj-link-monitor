# Historical Canonical Timing Integration Plan

This document records the safeguards and acceptance criteria used when the
canonical timing model was prepared for production integration. It is not a
current implementation plan; use the application source and current tests for
the present state.

The original integration was gated on a complete live proof with either:

- fresh `0x0b` absolute position packets, or
- a running app state that includes a matching beat grid for the loaded track.

## Target Code Shape

The plan called for one backend timing function near the existing projection
helpers in `monitor.cjs`:

```js
const timing = computeCanonicalDeckTiming(status, rawBeatGrid, nowMs, {
  fps: this.options.timecodeFps,
  offsetMs: this.options.timecodeOffsetMs
});
```

The function must return:

```js
{
  elapsedMs,
  totalMs,
  remainingMs,
  progress,
  timecode,
  frame,
  timingSource,
  timingStale
}
```

Every consumer was expected to use those fields:

- `getVjDecks()` assigns `deck.elapsedMs`, `deck.remainingMs`, `deck.progress`, `deck.timecode`
- `bridge.publishStatus()` reads `status.elapsedMs/status.timecode/status.timecodeFrame`, not raw `status.positionMs`
- renderer and Web UI should prefer `deck.elapsedMs` from VJ state instead of recomputing when `monitor.decks` exists
- OSC and Arena fallback output use the same `timing` object

## Required Safeguards

1. Strict numeric helper:

```js
function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}
```

This prevents missing values from becoming fake `0ms` timecode.

2. Source priority:

```text
fresh absolute position > fresh beat-grid > usable absolute > raw > hold paused value > none
```

3. Output guard:

If `timing.source === 'none'`, do not send `00:00:00:00` as if it were valid. Show waiting/stale instead.

## Risk Points Identified During the Experiment

At the time this plan was written, the application had the pieces but not a
single source of truth:

- `monitor.cjs` computes projected elapsed time for VJ decks.
- `renderer.js` has a separate projection path for non-VJ state.
- `bridge.cjs` derived OSC/Arena timecode from raw `status.positionMs || 0`.

That design allowed UI and output to diverge. The integration was intentionally
scoped to closing this gap without coupling it to unrelated network-sync
experiments.

## Original Acceptance Criteria

- Lab tests pass.
- Replay of a capture with only beat packets produces no fake timecode.
- Replay of a capture with absolute position produces monotonic elapsed/timecode.
- Replay with beat-grid fixture produces elapsed/timecode when absolute position is absent.
- The timing helper/output wiring changes do not alter network broadcast
  behavior.
