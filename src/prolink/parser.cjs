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
  0x05: 'media-query',
  0x06: 'announce-or-media',
  0x0a: 'cdj-status',
  0x0b: 'precise-position',
  0x1e: 'touch-audio-timing',
  0x1f: 'touch-audio-data',
  0x20: 'touch-audio-handover',
  0x26: 'fader-start',
  0x27: 'on-air',
  0x28: 'beat',
  0x29: 'mixer-status',
  0x2a: 'sync-control',
  0x34: 'load-or-settings',
  0x40: 'nxs-gateway'
});

const DEVICE_TYPES = Object.freeze({
  0x01: 'CDJ/XDJ',
  0x03: 'Mixer',
  0x04: 'rekordbox'
});

const MEDIA_SLOTS = Object.freeze({
  0x00: 'Empty',
  0x01: 'CD',
  0x02: 'SD',
  0x03: 'USB',
  0x04: 'rekordbox',
  0x06: 'Streaming',
  0x09: 'Beatport LINK'
});

const TRACK_TYPES = Object.freeze({
  0x00: 'None',
  0x01: 'rekordbox',
  0x02: 'Unanalyzed',
  0x05: 'Audio CD'
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

  const base = {
    timestamp: new Date().toISOString(),
    source: info.address || '',
    sourcePort: info.sourcePort || info.port || null,
    localPort: info.localPort || info.port || null,
    length: buffer.length,
    valid: hasProlinkHeader(buffer),
    type: null,
    typeName: 'unknown',
    family: familyFromPort(info.localPort || info.port),
    summary: 'Unknown packet'
  };

  if (!base.valid) {
    return {...base, summary: `Non PRO DJ LINK packet (${buffer.length} bytes)`};
  }

  const type = buffer[0x0a];
  base.type = type;
  base.typeHex = toHex(type, 2);
  base.typeName = PACKET_TYPES[type] || 'unknown';
  base.summary = `${base.family || 'prolink'} ${base.typeName}`;

  const localPort = info.localPort || info.port;
  if (localPort === PORTS.announce && type === 0x06) {
    return {...base, device: parseAnnounce(buffer), summary: 'Device announcement'};
  }

  if (localPort === PORTS.status && type === 0x0a) {
    return {...base, status: parseCdjStatus(buffer), summary: 'CDJ status'};
  }

  if (localPort === PORTS.status && type === 0x29) {
    return {...base, mixerStatus: parseMixerStatus(buffer), summary: 'Mixer status'};
  }

  if (localPort === PORTS.status && type === 0x06) {
    return {...base, media: parseMediaSlot(buffer), summary: 'Media slot'};
  }

  if (localPort === PORTS.beat) {
    return {...base, beat: parseBeatFamily(buffer), summary: base.typeName};
  }

  return base;
}

function hasProlinkHeader(buffer) {
  if (!buffer || buffer.length < PROLINK_HEADER.length + 1) return false;
  return buffer.subarray(0, PROLINK_HEADER.length).equals(PROLINK_HEADER);
}

function parseAnnounce(packet) {
  if (packet.length < 0x35) return null;
  return {
    name: readAscii(packet, 0x0c, 20),
    id: readUInt8(packet, 0x24),
    type: readUInt8(packet, 0x34),
    typeName: DEVICE_TYPES[readUInt8(packet, 0x34)] || `Type ${toHex(readUInt8(packet, 0x34), 2)}`,
    mac: readMac(packet, 0x26),
    ip: readIPv4(packet, 0x2c)
  };
}

function parseCdjStatus(packet) {
  if (packet.length < 0xc8) return null;

  const rawBpm = readUInt16BE(packet, 0x92);
  const rawBeat = readUInt32BE(packet, 0xa0);
  const rawBeatsUntilCue = readUInt16BE(packet, 0xa4);
  const playState = readUInt8(packet, 0x7b);
  const flags = readUInt8(packet, 0x89);
  const trackSlot = readUInt8(packet, 0x29);
  const trackType = readUInt8(packet, 0x2a);

  return {
    deviceId: readUInt8(packet, 0x21),
    trackId: readUInt32BE(packet, 0x2c),
    trackDeviceId: readUInt8(packet, 0x28),
    trackSlot,
    trackSlotName: MEDIA_SLOTS[trackSlot] || `Slot ${toHex(trackSlot, 2)}`,
    trackType,
    trackTypeName: TRACK_TYPES[trackType] || `Type ${toHex(trackType, 2)}`,
    playState,
    playStateName: PLAY_STATES[playState] || `State ${toHex(playState, 2)}`,
    flags,
    isOnAir: Boolean(flags & STATUS_FLAGS.onAir),
    isSync: Boolean(flags & STATUS_FLAGS.sync),
    isMaster: Boolean(flags & STATUS_FLAGS.master),
    isPlayingFlag: Boolean(flags & STATUS_FLAGS.playing),
    isEmergencyMode: Boolean(readUInt8(packet, 0xba)),
    trackBpm: rawBpm === 0xffff ? null : Number((rawBpm / 100).toFixed(2)),
    sliderPitch: calcPitch(packet.subarray(0x8d, 0x90)),
    effectivePitch: calcPitch(packet.subarray(0x99, 0x9c)),
    beat: rawBeat === 0xffffffff ? null : rawBeat,
    beatsUntilCue: rawBeatsUntilCue === 0x01ff ? null : rawBeatsUntilCue,
    beatInMeasure: readUInt8(packet, 0xa6),
    packetNum: packet.length >= 0xcc ? readUInt32BE(packet, 0xc8) : null
  };
}

function parseMixerStatus(packet) {
  if (packet.length < 0x30) return null;
  return {
    deviceId: readUInt8(packet, 0x21),
    rawFlags: readUInt8(packet, 0x27),
    rawHex: packet.subarray(0, Math.min(packet.length, 64)).toString('hex')
  };
}

function parseMediaSlot(packet) {
  if (packet.length < 0xc0) return null;
  const slot = readUInt8(packet, 0x2b);
  const totalBytes = readBigUInt64BE(packet, 0xb0);
  const freeBytes = readBigUInt64BE(packet, 0xb8);

  return {
    deviceId: readUInt8(packet, 0x27),
    slot,
    slotName: MEDIA_SLOTS[slot] || `Slot ${toHex(slot, 2)}`,
    name: readAscii(packet, 0x2c, 40),
    createdDate: readAscii(packet, 0x6c, 24),
    color: readUInt8(packet, 0xa8),
    trackCount: readUInt16BE(packet, 0xa6),
    tracksType: readUInt8(packet, 0xaa),
    hasSettings: Boolean(readUInt8(packet, 0xab)),
    playlistCount: readUInt16BE(packet, 0xae),
    totalBytes: totalBytes.toString(),
    freeBytes: freeBytes.toString()
  };
}

function parseBeatFamily(packet) {
  const player = packet.length > 0x21 ? readUInt8(packet, 0x21) : null;
  const packetType = readUInt8(packet, 0x0a);
  const beat = {
    deviceId: player,
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

  if (packetType === 0x0b && packet.length >= 0x3c) {
    return {
      ...beat,
      ...parsePrecisePosition(packet)
    };
  }

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

function familyFromPort(port) {
  switch (port) {
    case PORTS.announce:
      return 'announce';
    case PORTS.beat:
      return 'beat';
    case PORTS.status:
      return 'status';
    case PORTS.touchAudio:
      return 'touch-audio';
    default:
      return null;
  }
}

function calcPitch(bytes) {
  if (!bytes || bytes.length < 3) return null;
  const value = Buffer.from([0x00, bytes[0], bytes[1], bytes[2]]).readUInt32BE();
  const zero = 0x100000;
  return Number((((value - zero) / zero) * 100).toFixed(2));
}

function readAscii(packet, offset, length) {
  if (packet.length <= offset) return '';
  return packet
    .subarray(offset, Math.min(packet.length, offset + length))
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
}

function readMac(packet, offset) {
  if (packet.length < offset + 6) return '';
  return Array.from(packet.subarray(offset, offset + 6), (byte) =>
    Number(byte).toString(16).padStart(2, '0')
  ).join(':');
}

function readIPv4(packet, offset) {
  if (packet.length < offset + 4) return '';
  return Array.from(packet.subarray(offset, offset + 4)).join('.');
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

function readBigUInt64BE(packet, offset) {
  return packet.length >= offset + 8 ? packet.readBigUInt64BE(offset) : 0n;
}

function toHex(value, width = 2) {
  return `0x${Number(value || 0).toString(16).padStart(width, '0')}`;
}

module.exports = {
  PROLINK_HEADER,
  PORTS,
  parsePacket,
  parseAnnounce,
  parseCdjStatus,
  parsePrecisePosition,
  parseMediaSlot,
  hasProlinkHeader,
  familyFromPort
};
