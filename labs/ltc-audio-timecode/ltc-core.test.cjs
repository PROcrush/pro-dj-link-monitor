'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  makeLtcFrameBits,
  renderLtcPcm,
  writeWav,
  decodeGeneratedBitsFromPcm,
  bitsToTimecode,
  formatTimecode,
  msToTimecodeParts
} = require('./ltc-core.cjs');

test('builds an 80-bit LTC frame with sync word', () => {
  const bits = makeLtcFrameBits({hours: 1, minutes: 2, seconds: 3, frames: 4}, 25);
  assert.equal(bits.length, 80);
  assert.deepEqual(bits.slice(64, 80), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
  assert.equal(formatTimecode(bitsToTimecode(bits)), '01:02:03:04');
});

test('renders decodable 25fps LTC audio', () => {
  const pcm = renderLtcPcm({startMs: 1234, durationMs: 1000, fps: 25, sampleRate: 48000, channels: 2});
  const bits0 = decodeGeneratedBitsFromPcm(pcm, {fps: 25, sampleRate: 48000, channels: 2, frameIndex: 0});
  const bits10 = decodeGeneratedBitsFromPcm(pcm, {fps: 25, sampleRate: 48000, channels: 2, frameIndex: 10});
  assert.equal(formatTimecode(bitsToTimecode(bits0)), '00:00:01:05');
  assert.equal(formatTimecode(bitsToTimecode(bits10)), '00:00:01:15');
});

test('renders decodable 30fps LTC audio', () => {
  const pcm = renderLtcPcm({startMs: 0, durationMs: 1000, fps: 30, sampleRate: 48000, channels: 1});
  const bits29 = decodeGeneratedBitsFromPcm(pcm, {fps: 30, sampleRate: 48000, channels: 1, frameIndex: 29});
  assert.equal(formatTimecode(bitsToTimecode(bits29)), '00:00:00:29');
});

test('writes a valid PCM wav header', () => {
  const pcm = renderLtcPcm({durationMs: 40, fps: 25, sampleRate: 48000, channels: 2});
  const wav = writeWav({pcm, sampleRate: 48000, channels: 2});
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
});

test('converts milliseconds to timecode parts', () => {
  assert.equal(formatTimecode(msToTimecodeParts(3723, 25)), '00:00:03:18');
  assert.equal(formatTimecode(msToTimecodeParts(3723, 30)), '00:00:03:21');
});
