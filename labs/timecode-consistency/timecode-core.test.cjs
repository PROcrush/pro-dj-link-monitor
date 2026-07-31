'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  computeDeckTiming,
  formatTimecode,
  timeOfBeatGrid,
  playbackSpeedFactor
} = require('./timecode-core.cjs');

const baseTime = Date.parse('2026-07-04T12:00:00.000Z');
const beatGrid = {
  beats: [
    [0, 1],
    [500, 2],
    [1000, 3],
    [1500, 4],
    [2000, 1]
  ]
};

test('absolute position is the preferred fresh anchor', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 30,
    beat: 5,
    lastSeen: baseTime - 10,
    isPlayingFlag: true,
    trackLengthMs: 10_000
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'absolute');
  assert.equal(timing.elapsedMs, 1030);
  assert.equal(timing.timecode, '00:00:01:00');
  assert.equal(timing.remainingMs, 8970);
  assert.equal(timing.progress, 0.103);
});

test('newer beat-grid anchor replaces stale absolute position', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 1600,
    beat: 5,
    lastSeen: baseTime - 100,
    isPlayingFlag: true,
    trackLengthMs: 10_000
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'beat-grid');
  assert.equal(timing.elapsedMs, 2100);
  assert.equal(timing.stale, false);
});

test('paused decks hold the anchor and do not project forward', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 4200,
    positionLastSeen: baseTime - 250,
    playStateName: 'Paused',
    isPlayingFlag: false,
    trackLengthMs: 10_000
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'absolute');
  assert.equal(timing.elapsedMs, 4200);
  assert.equal(timing.timecode, '00:00:04:05');
});

test('pitch changes projection speed', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 1000,
    precisePitchPercent: 10,
    isPlayingFlag: true,
    trackLengthMs: 10_000
  }, null, {nowMs: baseTime, fps: 25});

  assert.equal(timing.elapsedMs, 2100);
  assert.equal(playbackSpeedFactor({precisePitchPercent: 10}), 1.1);
});

test('beat-grid maps and extrapolates beat numbers', () => {
  assert.equal(timeOfBeatGrid(beatGrid, 0), 0);
  assert.equal(timeOfBeatGrid(beatGrid, 3), 1000);
  assert.equal(timeOfBeatGrid(beatGrid, 7), 3000);
});

test('timecode frame conversion is deterministic at app frame rates', () => {
  assert.equal(formatTimecode(3723, 25), '00:00:03:18');
  assert.equal(formatTimecode(3723, 30), '00:00:03:21');
  assert.equal(formatTimecode(-100, 25), '00:00:00:00');
});

test('stale sources become unavailable instead of drifting forever', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 5000,
    beat: 5,
    lastSeen: baseTime - 5000,
    isPlayingFlag: true,
    trackLengthMs: 10_000
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'none');
  assert.equal(timing.elapsedMs, null);
  assert.equal(timing.stale, true);
});

test('missing anchors are not coerced to zero timecode', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    trackBpm: 128,
    beatInMeasure: 1,
    lastSeen: baseTime,
    isPlayingFlag: true
  }, null, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'none');
  assert.equal(timing.elapsedMs, null);
  assert.equal(timing.timecode, null);
});
