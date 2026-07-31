'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {computeDeckTiming} = require('../src/prolink/timing.cjs');

const baseTime = Date.parse('2026-07-10T12:00:00.000Z');
const beatGrid = {
  beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
};

test('keeps missing timing anchors null instead of inventing zero', () => {
  const timing = computeDeckTiming({
    deviceId: 1,
    trackBpm: 128,
    isPlayingFlag: true,
    lastSeen: baseTime
  }, null, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'none');
  assert.equal(timing.elapsedMs, null);
  assert.equal(timing.remainingMs, null);
  assert.equal(timing.progress, null);
  assert.equal(timing.frame, null);
  assert.equal(timing.timecode, null);
});

test('keeps a real zero position as valid timing', () => {
  const timing = computeDeckTiming({
    deviceId: 1,
    positionMs: 0,
    positionLastSeen: baseTime,
    playStateName: 'Paused',
    trackLengthMs: 10_000
  }, null, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'absolute');
  assert.equal(timing.elapsedMs, 0);
  assert.equal(timing.remainingMs, 10_000);
  assert.equal(timing.progress, 0);
  assert.equal(timing.frame, 0);
  assert.equal(timing.timecode, '00:00:00:00');
});

test('uses beat-grid timing when an absolute position is unavailable', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    beat: 10,
    lastSeen: baseTime - 100,
    isPlayingFlag: true,
    trackLengthMs: 60_000
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'beat-grid');
  assert.equal(timing.elapsedMs, 4600);
  assert.equal(timing.timecode, '00:00:04:15');
});

test('falls through stale anchors to a paused canonical hold', () => {
  const timing = computeDeckTiming({
    deviceId: 2,
    positionMs: 1000,
    positionLastSeen: baseTime - 5000,
    beat: 10,
    lastSeen: baseTime - 5000,
    playStateName: 'Paused',
    isPlayingFlag: false,
    lastCanonicalElapsedMs: 4200,
    lastCanonicalSeen: baseTime
  }, beatGrid, {nowMs: baseTime, fps: 25});

  assert.equal(timing.source, 'hold');
  assert.equal(timing.elapsedMs, 4200);
  assert.equal(timing.timecode, '00:00:04:05');
});
