'use strict';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_AMPLITUDE = 0.55;
const SUPPORTED_FPS = new Set([24, 25, 30]);
const SYNC_WORD_BITS = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

function makeLtcFrameBits(time, fps = 25) {
  fps = normalizeFps(fps);
  const frame = normalizeTime(time, fps);
  const bits = new Array(80).fill(0);
  writeBcd(bits, 0, frame.frames % 10, 4);
  writeBcd(bits, 8, Math.floor(frame.frames / 10), 2);
  writeBcd(bits, 16, frame.seconds % 10, 4);
  writeBcd(bits, 24, Math.floor(frame.seconds / 10), 3);
  writeBcd(bits, 32, frame.minutes % 10, 4);
  writeBcd(bits, 40, Math.floor(frame.minutes / 10), 3);
  writeBcd(bits, 48, frame.hours % 10, 4);
  writeBcd(bits, 56, Math.floor(frame.hours / 10), 2);
  for (let index = 0; index < SYNC_WORD_BITS.length; index += 1) bits[64 + index] = SYNC_WORD_BITS[index];
  const correctionBit = fps === 25 ? 59 : 27;
  bits[correctionBit] = parityCorrectionBit(bits, correctionBit);
  return bits;
}

function renderLtcPcm({startMs = 0, durationMs = 10_000, fps = 25, sampleRate = DEFAULT_SAMPLE_RATE, amplitude = DEFAULT_AMPLITUDE, channels = 2} = {}) {
  fps = normalizeFps(fps);
  if (![1, 2].includes(Number(channels))) throw new Error('channels must be 1 or 2');
  const framesToRender = Math.max(1, Math.ceil((Number(durationMs) / 1000) * fps));
  const samplesPerFrame = sampleRate / fps;
  const samplesPerBit = samplesPerFrame / 80;
  if (!Number.isInteger(samplesPerBit)) throw new Error(`sampleRate ${sampleRate} is not divisible by fps*80 for ${fps}fps`);
  const pcm = Buffer.alloc(framesToRender * 80 * samplesPerBit * channels * 2);
  let offset = 0;
  let polarity = -1;
  for (let frameIndex = 0; frameIndex < framesToRender; frameIndex += 1) {
    const frameTime = msToTimecodeParts(startMs + (frameIndex * 1000) / fps, fps);
    const bits = makeLtcFrameBits(frameTime, fps);
    for (const bit of bits) {
      polarity *= -1;
      const half = samplesPerBit / 2;
      for (let sample = 0; sample < samplesPerBit; sample += 1) {
        if (bit === 1 && sample === half) polarity *= -1;
        const value = Math.max(-1, Math.min(1, polarity * amplitude));
        const intValue = Math.round(value * 32767);
        for (let channel = 0; channel < channels; channel += 1) {
          pcm.writeInt16LE(intValue, offset);
          offset += 2;
        }
      }
    }
  }
  return pcm;
}

function writeWav({pcm, sampleRate = DEFAULT_SAMPLE_RATE, channels = 2}) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeGeneratedBitsFromPcm(pcm, {fps = 25, sampleRate = DEFAULT_SAMPLE_RATE, channels = 2, frameIndex = 0} = {}) {
  fps = normalizeFps(fps);
  const samplesPerBit = sampleRate / fps / 80;
  if (!Number.isInteger(samplesPerBit)) throw new Error('sampleRate/fps does not produce integer samples per bit');
  const bytesPerSampleFrame = channels * 2;
  const frameStartSamples = frameIndex * 80 * samplesPerBit;
  const bits = [];
  for (let bitIndex = 0; bitIndex < 80; bitIndex += 1) {
    const firstSample = frameStartSamples + bitIndex * samplesPerBit + Math.floor(samplesPerBit * 0.25);
    const secondSample = frameStartSamples + bitIndex * samplesPerBit + Math.floor(samplesPerBit * 0.75);
    const first = pcm.readInt16LE(firstSample * bytesPerSampleFrame);
    const second = pcm.readInt16LE(secondSample * bytesPerSampleFrame);
    bits.push(Math.sign(first) === Math.sign(second) ? 0 : 1);
  }
  return bits;
}

function bitsToTimecode(bits) {
  const frames = readBcd(bits, 0, 4) + 10 * readBcd(bits, 8, 2);
  const seconds = readBcd(bits, 16, 4) + 10 * readBcd(bits, 24, 3);
  const minutes = readBcd(bits, 32, 4) + 10 * readBcd(bits, 40, 3);
  const hours = readBcd(bits, 48, 4) + 10 * readBcd(bits, 56, 2);
  return {hours, minutes, seconds, frames};
}

function formatTimecode(parts) {
  return [parts.hours, parts.minutes, parts.seconds, parts.frames].map((part) => String(part).padStart(2, '0')).join(':');
}

function msToTimecodeParts(ms, fps = 25) {
  fps = normalizeFps(fps);
  const totalFrames = Math.max(0, Math.floor((Number(ms || 0) * fps) / 1000));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  return {hours, minutes, seconds, frames};
}

function normalizeFps(value) {
  const fps = Math.round(Number(value || 25));
  if (!SUPPORTED_FPS.has(fps)) throw new Error(`Unsupported fps ${value}; use 24, 25, or 30`);
  return fps;
}

function normalizeTime(time, fps) {
  return {
    hours: clampInt(time.hours, 0, 23),
    minutes: clampInt(time.minutes, 0, 59),
    seconds: clampInt(time.seconds, 0, 59),
    frames: clampInt(time.frames, 0, fps - 1)
  };
}

function writeBcd(bits, offset, value, width) {
  for (let bit = 0; bit < width; bit += 1) bits[offset + bit] = (value >> bit) & 1;
}

function readBcd(bits, offset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) value += Number(bits[offset + bit] || 0) << bit;
  return value;
}

function parityCorrectionBit(bits, correctionBit) {
  const onesWithoutCorrection = bits.reduce((sum, bit, index) => sum + (index === correctionBit ? 0 : Number(bit || 0)), 0);
  return onesWithoutCorrection % 2 === 0 ? 0 : 1;
}

function clampInt(value, min, max) {
  const numeric = Math.floor(Number(value || 0));
  return Math.max(min, Math.min(max, numeric));
}

module.exports = {
  makeLtcFrameBits,
  renderLtcPcm,
  writeWav,
  decodeGeneratedBitsFromPcm,
  bitsToTimecode,
  formatTimecode,
  msToTimecodeParts
};
