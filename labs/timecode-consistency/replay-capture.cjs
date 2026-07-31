#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const {parsePacket} = require('./lab-prolink-parser.cjs');
const {computeDeckTiming} = require('./timecode-core.cjs');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: node replay-capture.cjs --file captures/prolink.jsonl [--fps 25] [--beat-grid beat-grid.json]');
    process.exit(2);
  }

  const fps = Number(args.fps || 25);
  const beatGrids = loadBeatGrids(args['beat-grid']);
  const statuses = new Map();
  const summaries = new Map();
  let packets = 0;
  let valid = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(args.file),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    packets += 1;
    const record = JSON.parse(line);
    const receivedAtMs = Number(record.receivedAtMs || Date.parse(record.receivedAt));
    const packet = parsePacket(Buffer.from(record.hex, 'hex'), {
      localPort: record.localPort,
      address: record.source,
      sourcePort: record.sourcePort,
      timestamp: record.receivedAt
    });
    if (!packet.valid) continue;
    valid += 1;
    const updated = updateStatuses(statuses, packet, receivedAtMs);
    for (const status of updated) {
      const deck = Number(status.deviceId || 0);
      if (!deck) continue;
      const beatGrid = beatGrids.get(deck) || null;
      const timing = computeDeckTiming(status, beatGrid, {nowMs: receivedAtMs, fps});
      updateSummary(summaries, status, timing);
    }
  }

  printSummary({file: args.file, packets, valid, summaries});
}

function updateStatuses(statuses, packet, receivedAtMs) {
  const updated = [];
  if (packet.status?.deviceId) {
    const previous = statuses.get(packet.status.deviceId) || {};
    const status = {
      ...previous,
      ...packet.status,
      lastSeen: receivedAtMs,
      beatLastSeen: packet.status.beat !== null && packet.status.beat !== undefined ? receivedAtMs : previous.beatLastSeen,
      source: packet.source
    };
    statuses.set(status.deviceId, status);
    updated.push(status);
  }

  if (packet.beat?.deviceId) {
    const previous = statuses.get(packet.beat.deviceId) || {};
    const isPrecise = packet.beat.packetType === 0x0b;
    const status = {
      ...previous,
      deviceId: packet.beat.deviceId,
      trackBpm: packet.beat.trackBpm ?? previous.trackBpm,
      beatInMeasure: packet.beat.beatInMeasure ?? previous.beatInMeasure,
      positionMs: isPrecise ? packet.beat.positionMs : previous.positionMs,
      positionLastSeen: isPrecise ? receivedAtMs : previous.positionLastSeen,
      trackLengthMs: packet.beat.trackLengthMs ?? previous.trackLengthMs,
      trackLengthSeconds: packet.beat.trackLengthSeconds ?? previous.trackLengthSeconds,
      effectiveBpm: packet.beat.effectiveBpm ?? previous.effectiveBpm,
      precisePitchPercent: packet.beat.pitchPercent ?? previous.precisePitchPercent,
      beatLastSeen: !isPrecise ? receivedAtMs : previous.beatLastSeen,
      lastSeen: receivedAtMs,
      source: packet.source
    };
    statuses.set(status.deviceId, status);
    updated.push(status);
  }
  return updated;
}

function updateSummary(summaries, status, timing) {
  const deck = Number(status.deviceId || timing.deck || 0);
  const summary = summaries.get(deck) || {
    deck,
    packets: 0,
    sources: new Map(),
    stale: 0,
    firstElapsedMs: null,
    lastElapsedMs: null,
    maxBackwardMs: 0,
    maxOldBridgeLagMs: 0,
    timecode: null
  };

  summary.packets += 1;
  summary.sources.set(timing.source, (summary.sources.get(timing.source) || 0) + 1);
  if (timing.stale) summary.stale += 1;
  if (timing.elapsedMs !== null) {
    if (summary.firstElapsedMs === null) summary.firstElapsedMs = timing.elapsedMs;
    if (summary.lastElapsedMs !== null && timing.elapsedMs < summary.lastElapsedMs) {
      summary.maxBackwardMs = Math.max(summary.maxBackwardMs, summary.lastElapsedMs - timing.elapsedMs);
    }
    const oldBridgeElapsedMs = Number(status.positionMs || 0);
    summary.maxOldBridgeLagMs = Math.max(summary.maxOldBridgeLagMs, Math.abs(timing.elapsedMs - oldBridgeElapsedMs));
    summary.lastElapsedMs = timing.elapsedMs;
    summary.timecode = timing.timecode;
  }
  summaries.set(deck, summary);
}

function printSummary({file, packets, valid, summaries}) {
  console.log(`Capture: ${file}`);
  console.log(`Packets: ${packets}, valid PRO DJ LINK: ${valid}`);
  if (!summaries.size) {
    console.log('No deck timing could be computed.');
    return;
  }
  for (const summary of Array.from(summaries.values()).sort((a, b) => a.deck - b.deck)) {
    const sources = Array.from(summary.sources.entries()).map(([source, count]) => `${source}:${count}`).join(', ');
    console.log([
      `Deck ${summary.deck}`,
      `samples=${summary.packets}`,
      `sources=${sources}`,
      `stale=${summary.stale}`,
      `elapsed=${fmt(summary.firstElapsedMs)} -> ${fmt(summary.lastElapsedMs)}`,
      `timecode=${summary.timecode || '-'}`,
      `maxBackward=${Math.round(summary.maxBackwardMs)}ms`,
      `oldBridgeLag=${Math.round(summary.maxOldBridgeLagMs)}ms`
    ].join(' | '));
  }
}

function loadBeatGrids(file) {
  const map = new Map();
  if (!file) return map;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data.beats)) {
    map.set(Number(data.deck || data.deviceId || 1), data);
    return map;
  }
  for (const [deck, beatGrid] of Object.entries(data)) map.set(Number(deck), beatGrid);
  return map;
}

function fmt(ms) {
  return ms === null || ms === undefined ? '-' : `${Math.round(ms)}ms`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
