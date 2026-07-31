'use strict';

const PROLINK_HEADER = Buffer.from([0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c]);

const PORTS = Object.freeze({
  announce: 50000,
  beat: 50001,
  status: 50002,
  touchAudio: 50004
});

const PACKET_TYPES = Object.freeze({
  0x02: 'beat',
  0x03: 'mixer-control',
  0x06: 'announce-or-media',
  0x0a: 'cdj-status',
  0x0b: 'precise-position',
  0x28: 'beat',
  0x29: 'mixer-status'
});

const PLAY_STATES = Object.freeze({
  0x00: 'Empty',
  0x02: 'Loading',
  0x03: 'Playing',
  0x04: 'Looping',
  0x05: 'Paused',
  0x06: 'Cued',
  0x07: 'Cuing',
  0x08: 'Platter Held',
  0x09: 'Searching',
  0x0e: 'Spun Down',
  0x11: 'Ended'
});

const STATUS_FLAGS = Object.freeze({
  onAir: 1 << 3,
  sync: 1 << 4,
  master: 1 << 5,
  playing: 1 << 6
});

function parsePacket(buffer, info = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const localPort = info.localPort || info.port || null;
  const base = {
    timestamp: info.timestamp || new Date().toISOString(),
    source: info.address || '',
    sourcePort: info.sourcePort || null,
    localPort,
    length: buffer.length,
    valid: hasProlinkHeader(buffer),
    type: null,
    typeName: 'unknown',
    family: familyFromPort(localPort)
  };

  if (!base.valid) return base;
  const type = readUInt8(buffer, 0x0a);
  const typed = {
    ...base,
    type,
    typeHex: toHex(type),
    typeName: PACKET_TYPES[type] || 'unknown'
  };

  if (localPort === PORTS.status && type === 0x0a) return {...typed, status: parseCdjStatus(buffer)};
  if (localPort === PORTS.beat) return {...typed, beat: parseBeatFamily(buffer)};
  return typed;
}

function parseCdjStatus(packet) {
  if (packet.length < 0xc8) return null;
  const rawBpm = readUInt16BE(packet, 0x92);
  const rawBeat = readUInt32BE(packet, 0xa0);
  const rawBeatsUntilCue = readUInt16BE(packet, 0xa4);
  const playState = readUInt8(packet, 0x7b);
  const flags = readUInt8(packet, 0x89);

  return {
    deviceId: readUInt8(packet, 0x21),
    trackId: readUInt32BE(packet, 0x2c),
    trackDeviceId: readUInt8(packet, 0x28),
    trackSlot: readUInt8(packet, 0x29),
    trackType: readUInt8(packet, 0x2a),
    playState,
    playStateName: PLAY_STATES[playState] || `State ${toHex(playState)}`,
    flags,
    isOnAir: Boolean(flags & STATUS_FLAGS.onAir),
    isSync: Boolean(flags & STATUS_FLAGS.sync),
    isMaster: Boolean(flags & STATUS_FLAGS.master),
    isPlayingFlag: Boolean(flags & STATUS_FLAGS.playing),
    trackBpm: rawBpm === 0xffff ? null : Number((rawBpm / 100).toFixed(2)),
    sliderPitch: calcPitch(packet.subarray(0x8d, 0x90)),
    effectivePitch: calcPitch(packet.subarray(0x99, 0x9c)),
    beat: rawBeat === 0xffffffff ? null : rawBeat,
    beatsUntilCue: rawBeatsUntilCue === 0x01ff ? null : rawBeatsUntilCue,
    beatInMeasure: readUInt8(packet, 0xa6),
    packetNum: packet.length >= 0xcc ? readUInt32BE(packet, 0xc8) : null
  };
}

function parseBeatFamily(packet) {
  const deviceId = packet.length > 0x21 ? readUInt8(packet, 0x21) : null;
  const packetType = readUInt8(packet, 0x0a);
  const beat = {
    deviceId,
    packetType,
    packetTypeName: PACKET_TYPES[packetType] || 'unknown'
  };

  if (packetType === 0x28 && packet.length >= 0x60) {
    const rawBpm = readUInt32BE(packet, 0x58);
    return {
      ...beat,
      trackBpm: rawBpm === 0xffffffff ? null : Number((rawBpm / 100).toFixed(2)),
      beatInMeasure: readUInt8(packet, 0x5c),
      beatDistanceMs: [0x24, 0x28, 0x2c, 0x30, 0x34, 0x38].map((offset) => readUInt32BE(packet, offset))
    };
  }

  if (packetType === 0x0b && packet.length >= 0x3c) return {...beat, ...parsePrecisePosition(packet)};
  return beat;
}

function parsePrecisePosition(packet) {
  const rawPitch = readInt32BE(packet, 0x2c);
  const rawEffectiveBpm = readUInt32BE(packet, 0x38);
  const trackLengthSeconds = readUInt32BE(packet, 0x24);
  const positionMs = readUInt32BE(packet, 0x28);

  return {
    trackLengthSeconds,
    trackLengthMs: trackLengthSeconds > 0 ? trackLengthSeconds * 1000 : null,
    positionMs,
    pitchPercent: Number((rawPitch / 100).toFixed(2)),
    effectiveBpm: rawEffectiveBpm > 0 ? Number((rawEffectiveBpm / 10).toFixed(1)) : null
  };
}

function hasProlinkHeader(buffer) {
  return Boolean(buffer && buffer.length >= PROLINK_HEADER.length + 1 && buffer.subarray(0, PROLINK_HEADER.length).equals(PROLINK_HEADER));
}

function familyFromPort(port) {
  if (port === PORTS.announce) return 'announce';
  if (port === PORTS.beat) return 'beat';
  if (port === PORTS.status) return 'status';
  if (port === PORTS.touchAudio) return 'touch-audio';
  return null;
}

function calcPitch(bytes) {
  if (!bytes || bytes.length < 3) return null;
  const value = Buffer.from([0x00, bytes[0], bytes[1], bytes[2]]).readUInt32BE();
  const zero = 0x100000;
  return Number((((value - zero) / zero) * 100).toFixed(2));
}

function readUInt8(packet, offset) {
  return packet.length > offset ? packet.readUInt8(offset) : 0;
}

function readUInt16BE(packet, offset) {
  return packet.length >= offset + 2 ? packet.readUInt16BE(offset) : 0;
}

function readUInt32BE(packet, offset) {
  return packet.length >= offset + 4 ? packet.readUInt32BE(offset) : 0;
}

function readInt32BE(packet, offset) {
  return packet.length >= offset + 4 ? packet.readInt32BE(offset) : 0;
}

function toHex(value, width = 2) {
  return `0x${Number(value || 0).toString(16).padStart(width, '0')}`;
}

module.exports = {
  PROLINK_HEADER,
  PORTS,
  parsePacket,
  parseCdjStatus,
  parseBeatFamily,
  parsePrecisePosition,
  hasProlinkHeader
};
