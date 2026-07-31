'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {computeDeckTiming, formatTimecode} = require('./timecode-core.cjs');

const baseTime = Date.parse('2026-07-04T12:30:00.000Z');

function grid(intervalMs, count) {
  return {
    beats: Array.from({length: count}, (_, index) => [index * intervalMs, (index % 4) + 1])
  };
}

test('beat-grid fallback creates a usable timecode when old bridge output would be zero', () => {
  const status = {
    deviceId: 2,
    beat: 10,
    lastSeen: baseTime - 100,
    isPlayingFlag: true,
    trackLengthMs: 60_000
  };
  const timing = computeDeckTiming(status, grid(500, 64), {nowMs: baseTime, fps: 25});
  const oldBridgeElapsedMs = status.positionMs || 0;

  assert.equal(timing.source, 'beat-grid');
  assert.equal(timing.elapsedMs, 4600);
  assert.equal(timing.timecode, '00:00:04:15');
  assert.equal(oldBridgeElapsedMs, 0);
  assert.ok(timing.elapsedMs - oldBridgeElapsedMs > 4000);
});

test('all external outputs must derive from the same canonical timing object', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 3723,
    positionLastSeen: baseTime,
    playStateName: 'Playing',
    isPlayingFlag: true,
    trackLengthMs: 217_000
  }, null, {nowMs: baseTime, fps: 30, offsetMs: 0});

  const uiElapsedMs = timing.elapsedMs;
  const webElapsedMs = timing.elapsedMs;
  const oscElapsedMs = timing.elapsedMs;
  const oscTimecode = timing.timecode;
  const arenaFallbackTimecode = formatTimecode(timing.elapsedMs, 30);

  assert.equal(uiElapsedMs, 3723);
  assert.equal(webElapsedMs, uiElapsedMs);
  assert.equal(oscElapsedMs, uiElapsedMs);
  assert.equal(oscTimecode, '00:00:03:21');
  assert.equal(arenaFallbackTimecode, oscTimecode);
});

test('fresher beat-grid anchor prevents stale absolute packets from freezing output', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 1700,
    beat: 20,
    lastSeen: baseTime - 50,
    isPlayingFlag: true,
    trackLengthMs: 60_000
  }, grid(500, 64), {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'beat-grid');
  assert.equal(timing.elapsedMs, 9550);
  assert.ok(timing.elapsedMs > 1000);
});
