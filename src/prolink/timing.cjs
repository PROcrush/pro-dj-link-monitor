'use strict';

const DEFAULT_FPS = 25;

function computeDeckTiming(status = {}, beatGrid = null, options = {}) {
  const nowMs = numberOr(options.nowMs, Date.now());
  const fps = normalizeFps(options.fps);
  const offsetMs = numberOr(options.offsetMs, 0);
  const totalMs = firstNumber(status.trackLengthMs, status.totalMs, status.durationMs, options.totalMs);
  const source = chooseAnchor(status, beatGrid, nowMs, options);

  if (!source) {
    return {
      deck: numberOr(status.deviceId, 0),
      trackKey: status.trackKey || null,
      elapsedMs: null,
      totalMs,
      remainingMs: null,
      progress: null,
      source: 'none',
      sourceAgeMs: null,
      stale: true,
      frame: null,
      timecode: null
    };
  }

  const projectedMs = projectAnchor(source.positionMs, source.seenAtMs, status, nowMs, totalMs);
  const elapsedMs = clampMs(projectedMs, totalMs);
  const frame = timecodeFrame(elapsedMs + offsetMs, fps);
  return {
    deck: numberOr(status.deviceId, 0),
    trackKey: status.trackKey || null,
    elapsedMs,
    totalMs,
    remainingMs: totalMs === null ? null : Math.max(0, totalMs - elapsedMs),
    progress: totalMs ? clampRatio(elapsedMs / totalMs) : null,
    source: source.type,
    sourceAgeMs: source.ageMs,
    stale: source.stale,
    frame,
    timecode: formatTimecodeFrame(frame, fps)
  };
}

function chooseAnchor(status, beatGrid, nowMs, options = {}) {
  const absolute = makeAnchor('absolute', firstNumber(status.positionMs, status.playheadMs), status.positionLastSeen, nowMs);
  const beatGridAnchor = makeBeatGridAnchor(status, beatGrid, nowMs);
  const raw = makeAnchor('raw', firstNumber(status.elapsedMs, status.playbackPositionMs, status.timeMs), status.lastSeen, nowMs);
  const hold = makeAnchor('hold', firstNumber(status.lastCanonicalElapsedMs), status.lastCanonicalSeen, nowMs);
  const moving = isMoving(status);

  const absoluteFreshMs = numberOr(options.absoluteFreshMs, 300);
  const absoluteMaxMs = numberOr(options.absoluteMaxMs, 1000);
  const beatFreshMs = numberOr(options.beatFreshMs, 1200);
  const beatMaxMs = numberOr(options.beatMaxMs, 2500);

  if (absolute && absolute.ageMs <= absoluteFreshMs) return markFresh(absolute);
  if (beatGridAnchor && (!absolute || absolute.ageMs > absoluteMaxMs || beatGridAnchor.seenAtMs > absolute.seenAtMs)) {
    const candidate = markStaleByAge(beatGridAnchor, beatFreshMs, beatMaxMs);
    if (candidate) return candidate;
  }
  if (absolute && absolute.ageMs <= absoluteMaxMs) return markStaleByAge(absolute, absoluteFreshMs, absoluteMaxMs);
  if (raw) {
    const candidate = markStaleByAge(raw, beatFreshMs, beatMaxMs);
    if (candidate) return candidate;
  }
  if (!moving && hold) return markFresh(hold);
  return null;
}

function makeBeatGridAnchor(status, beatGrid, nowMs) {
  const beatNumber = firstNumber(status.beat, status.beatNumber);
  const positionMs = beatNumber === null ? null : timeOfBeatGrid(beatGrid, beatNumber);
  return makeAnchor('beat-grid', positionMs, status.beatLastSeen || status.lastSeen, nowMs);
}

function makeAnchor(type, positionMs, seenAt, nowMs) {
  const numericPosition = firstNumber(positionMs);
  const seenAtMs = timestampMs(seenAt);
  if (numericPosition === null || seenAtMs === null) return null;
  return {
    type,
    positionMs: numericPosition,
    seenAtMs,
    ageMs: Math.max(0, nowMs - seenAtMs),
    stale: false
  };
}

function markFresh(anchor) {
  return {...anchor, stale: false};
}

function markStaleByAge(anchor, freshMs, maxMs) {
  if (anchor.ageMs > maxMs) return null;
  return {...anchor, stale: anchor.ageMs > freshMs};
}

function projectAnchor(positionMs, seenAtMs, status, nowMs, totalMs) {
  if (!isMoving(status)) return positionMs;
  const ageMs = Math.max(0, Math.min(2500, nowMs - seenAtMs));
  const projected = positionMs + ageMs * playbackSpeedFactor(status);
  return totalMs === null ? projected : Math.min(totalMs, projected);
}

function timeOfBeatGrid(beatGrid, beatNumber) {
  const beats = Array.isArray(beatGrid?.beats) ? beatGrid.beats : [];
  if (!beats.length || beatNumber < 0) return null;
  if (beatNumber === 0) return 0;
  const index = Math.min(beats.length - 1, Math.max(0, Math.round(beatNumber) - 1));
  const timeMs = firstNumber(Array.isArray(beats[index]) ? beats[index][0] : beats[index]?.timeMs);
  if (timeMs === null) return null;
  if (beatNumber <= beats.length || beats.length < 2) return timeMs;
  const previous = firstNumber(Array.isArray(beats[beats.length - 2]) ? beats[beats.length - 2][0] : beats[beats.length - 2]?.timeMs);
  if (previous === null) return timeMs;
  return timeMs + (timeMs - previous) * (beatNumber - beats.length);
}

function isMoving(status) {
  return Boolean(status.isPlayingFlag) || ['Playing', 'Looping', 'Beat'].includes(status.playStateName);
}

function playbackSpeedFactor(status) {
  const pitchPercent = firstNumber(status.precisePitchPercent, status.effectivePitch, status.sliderPitch, status.pitchPercent);
  if (pitchPercent === null) return 1;
  return Math.max(0.25, Math.min(4, 1 + pitchPercent / 100));
}

function formatTimecode(ms, fps = DEFAULT_FPS) {
  return formatTimecodeFrame(timecodeFrame(ms, fps), fps);
}

function timecodeFrame(ms, fps = DEFAULT_FPS) {
  const frameRate = normalizeFps(fps);
  return Math.max(0, Math.floor((Number(ms || 0) * frameRate) / 1000));
}

function formatTimecodeFrame(frame, fps = DEFAULT_FPS) {
  const frameRate = normalizeFps(fps);
  const totalFrames = Math.max(0, Math.floor(Number(frame || 0)));
  const frames = totalFrames % frameRate;
  const totalSeconds = Math.floor(totalFrames / frameRate);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return [hours, minutes, seconds, frames].map((part) => String(part).padStart(2, '0')).join(':');
}

function normalizeFps(value) {
  const fps = Math.round(Number(value || DEFAULT_FPS));
  return [24, 25, 30].includes(fps) ? fps : DEFAULT_FPS;
}

function clampMs(value, totalMs) {
  const ms = Math.max(0, Number(value || 0));
  return totalMs === null ? ms : Math.min(totalMs, ms);
}

function clampRatio(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

module.exports = {
  computeDeckTiming,
  formatTimecode,
  timecodeFrame,
  timeOfBeatGrid,
  playbackSpeedFactor
};
