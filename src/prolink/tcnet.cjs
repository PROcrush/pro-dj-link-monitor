const TCNET_HEADER = Buffer.from('TCN', 'ascii');

const TCNET_PORTS = Object.freeze({
  control: 60000,
  time: 60001,
  sync: 60002,
  bridgeUnicast: 65023,
  defaultUnicast: 65024
});

const TCNET_TYPES = Object.freeze({
  2: 'opt-in',
  3: 'opt-out',
  5: 'status',
  10: 'time-sync',
  13: 'notification',
  20: 'request',
  30: 'application-data',
  101: 'control',
  128: 'text',
  132: 'keyboard',
  200: 'data',
  204: 'file',
  213: 'application-specific-data',
  254: 'time'
});

const TCNET_DATA_TYPES = Object.freeze({
  2: 'metrics',
  4: 'metadata',
  8: 'beat-grid',
  12: 'cue-data',
  16: 'small-waveform',
  32: 'big-waveform',
  128: 'artwork',
  150: 'mixer-data'
});

const LAYER_NAMES = ['L1', 'L2', 'L3', 'L4', 'LA', 'LB', 'LM', 'LC'];

const LAYER_STATES = Object.freeze({
  0: 'Idle',
  3: 'Playing',
  4: 'Looping',
  5: 'Paused',
  6: 'Stopped',
  7: 'Cue Down',
  8: 'Platter Down',
  9: 'FFWD',
  10: 'FFRV',
  11: 'Hold'
});

function parseTcnetPacket(buffer, info = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  const base = {
    timestamp: new Date().toISOString(),
    source: info.address || '',
    sourcePort: info.sourcePort || null,
    localPort: info.localPort || info.port || null,
    length: buffer.length,
    valid: hasTcnetHeader(buffer),
    protocol: 'tcnet',
    type: null,
    typeName: 'unknown',
    summary: 'Unknown TCNet packet'
  };

  if (!base.valid) {
    return {...base, summary: `Non TCNet packet (${buffer.length} bytes)`};
  }

  const common = parseCommon(buffer);
  base.type = common.messageType;
  base.typeName = TCNET_TYPES[common.messageType] || 'unknown';
  base.summary = `TCNet ${base.typeName}`;

  if (common.messageType === 2) return {...base, common, tcnetNode: parseOptIn(buffer), summary: 'TCNet opt-in'};
  if (common.messageType === 3) return {...base, common, tcnetNodeOut: parseOptOut(buffer), summary: 'TCNet opt-out'};
  if (common.messageType === 5) return {...base, common, tcnetStatus: parseStatus(buffer), summary: 'TCNet status'};
  if (common.messageType === 13) return {...base, common, tcnetNotification: parseNotification(buffer), summary: 'TCNet notification'};
  if (common.messageType === 20) return {...base, common, tcnetRequest: parseRequest(buffer), summary: 'TCNet request'};
  if (common.messageType === 30) return {...base, common, tcnetApplicationData: parseApplicationData(buffer), summary: 'TCNet application data'};
  if (common.messageType === 200) return {...base, common, tcnetData: parseData(buffer), summary: 'TCNet data'};
  if (common.messageType === 204) return {...base, common, tcnetFile: parseClusterData(buffer), summary: 'TCNet file data'};
  if (common.messageType === 213) return {...base, common, tcnetApplicationSpecificData: parseApplicationData(buffer), summary: 'TCNet application-specific data'};
  if (common.messageType === 254) return {...base, common, tcnetTime: parseTime(buffer), summary: 'TCNet time'};
  if (common.messageType === 128) return {...base, common, tcnetText: parseTextLike(buffer), summary: 'TCNet text'};

  return {...base, common};
}

function hasTcnetHeader(buffer) {
  return buffer.length >= 8 && buffer.subarray(4, 7).equals(TCNET_HEADER);
}

function parseCommon(packet) {
  return {
    nodeId: readUInt16LE(packet, 0),
    versionMajor: readUInt8(packet, 2),
    versionMinor: readUInt8(packet, 3),
    messageType: readUInt8(packet, 7),
    nodeName: readAscii(packet, 8, 8),
    seq: readUInt8(packet, 16),
    nodeType: readUInt8(packet, 17),
    nodeTypeName: nodeTypeName(readUInt8(packet, 17)),
    nodeOptions: readUInt16LE(packet, 18),
    timestampMicros: readUInt32LE(packet, 20)
  };
}

function parseOptIn(packet) {
  const common = parseCommon(packet);
  return {
    ...common,
    nodeCount: readUInt16LE(packet, 24),
    listenerPort: readUInt16LE(packet, 26),
    uptimeSeconds: readUInt16LE(packet, 28),
    vendor: readAscii(packet, 32, 16),
    appName: readAscii(packet, 48, 16),
    appVersion: `${readUInt8(packet, 64)}.${readUInt8(packet, 65)}.${readUInt8(packet, 66)}`
  };
}

function parseOptOut(packet) {
  const common = parseCommon(packet);
  return {
    ...common,
    nodeCount: readUInt16LE(packet, 24),
    listenerPort: readUInt16LE(packet, 26)
  };
}

function parseStatus(packet) {
  const common = parseCommon(packet);
  const layers = LAYER_NAMES.map((name, index) => ({
    id: index + 1,
    name: readAscii(packet, 172 + index * 16, 16) || name,
    source: readUInt8(packet, 34 + index),
    state: readUInt8(packet, 42 + index),
    stateName: LAYER_STATES[readUInt8(packet, 42 + index)] || `State ${readUInt8(packet, 42 + index)}`,
    trackId: readUInt32LE(packet, 50 + index * 4)
  }));

  return {
    ...common,
    nodeCount: readUInt16LE(packet, 24),
    listenerPort: readUInt16LE(packet, 26),
    smpteMode: readUInt8(packet, 83),
    autoMasterMode: readUInt8(packet, 84),
    appName: readAscii(packet, 120, 16),
    layers
  };
}

function parseTime(packet) {
  const common = parseCommon(packet);
  const timeOffsets = [24, 28, 32, 36, 40, 44, 48, 52];
  const totalOffsets = [56, 60, 64, 68, 72, 76, 80, 84];
  const tcOffsets = [106, 112, 118, 124, 130, 136, 142, 148];
  const layers = LAYER_NAMES.map((name, index) => {
    const smpteMode = readUInt8(packet, tcOffsets[index]);
    return {
      id: index + 1,
      name,
      timeMs: readUInt32LE(packet, timeOffsets[index]),
      totalTimeMs: readUInt32LE(packet, totalOffsets[index]),
      beatMarker: readUInt8(packet, 88 + index),
      state: readUInt8(packet, 96 + index),
      stateName: LAYER_STATES[readUInt8(packet, 96 + index)] || `State ${readUInt8(packet, 96 + index)}`,
      smpteMode: smpteMode || readUInt8(packet, 105),
      timecodeState: readUInt8(packet, tcOffsets[index] + 1),
      timecode: formatTimecode(
        readUInt8(packet, tcOffsets[index] + 2),
        readUInt8(packet, tcOffsets[index] + 3),
        readUInt8(packet, tcOffsets[index] + 4),
        readUInt8(packet, tcOffsets[index] + 5)
      ),
      onAir: readUInt8(packet, 154 + index)
    };
  });

  return {
    ...common,
    timeEnabled: readUInt8(packet, 104),
    smpteMode: readUInt8(packet, 105),
    layers
  };
}

function parseRequest(packet) {
  return {
    ...parseCommon(packet),
    dataType: readUInt8(packet, 24),
    dataTypeName: TCNET_DATA_TYPES[readUInt8(packet, 24)] || 'unknown',
    layerId: readUInt8(packet, 25)
  };
}

function parseNotification(packet) {
  const relatedType = readUInt8(packet, 28);
  return {
    ...parseCommon(packet),
    identifier1: readUInt8(packet, 24),
    identifier2: readUInt8(packet, 25),
    code: readUInt16LE(packet, 26),
    relatedType,
    relatedTypeName: TCNET_TYPES[relatedType] || 'unknown',
    relatedDataType: readUInt8(packet, 29),
    rawBodyHex: packet.subarray(24).toString('hex')
  };
}

function parseData(packet) {
  const common = parseCommon(packet);
  const dataType = readUInt8(packet, 24);
  const layerId = readUInt8(packet, 25);
  const base = {
    ...common,
    dataType,
    dataTypeName: TCNET_DATA_TYPES[dataType] || 'unknown',
    layerId
  };

  if (dataType === 2) return {...base, metrics: parseMetrics(packet)};
  if (dataType === 4) return {...base, metadata: parseMetadata(packet)};
  if (dataType === 12) return {...base, cues: parseCues(packet)};
  if (dataType === 16 || dataType === 32) return {...base, waveform: parseWaveform(packet, dataType)};

  return base;
}

function parseMetrics(packet) {
  return {
    layerId: readUInt8(packet, 25),
    state: readUInt8(packet, 27),
    stateName: LAYER_STATES[readUInt8(packet, 27)] || `State ${readUInt8(packet, 27)}`,
    syncMaster: readUInt8(packet, 29),
    beatMarker: readUInt8(packet, 31),
    trackLengthMs: readUInt32LE(packet, 32),
    positionMs: readUInt32LE(packet, 36),
    speedRaw: readUInt32LE(packet, 40),
    speedPercent: rawSpeedToPercent(readUInt32LE(packet, 40)),
    beatNumber: readUInt32LE(packet, 57),
    bpm: Number((readUInt32LE(packet, 112) / 100).toFixed(2)),
    pitchBendRaw: readUInt16LE(packet, 116),
    trackId: readUInt32LE(packet, 118)
  };
}

function parseMetadata(packet) {
  return {
    layerId: readUInt8(packet, 25),
    artist: readUtfText(packet, 29, 256),
    title: readUtfText(packet, 285, 256),
    key: readUInt16LE(packet, 541),
    trackId: readUInt32LE(packet, 543)
  };
}

function parseCues(packet) {
  const cues = [];
  for (let index = 0; index < 18; index += 1) {
    const offset = 47 + index * 22;
    if (packet.length < offset + 14) break;
    const type = readUInt8(packet, offset);
    const inMs = readUInt32LE(packet, offset + 2);
    const outMs = readUInt32LE(packet, offset + 6);
    const colorOffset = offset + 11;
    if (!type && !inMs && !outMs) continue;
    cues.push({
      index: index + 1,
      type,
      inMs,
      outMs,
      color: readRgb(packet, colorOffset)
    });
  }

  return {
    layerId: readUInt8(packet, 25),
    loopInMs: readUInt32LE(packet, 42),
    loopOutMs: readUInt32LE(packet, 46),
    cues
  };
}

function parseWaveform(packet, dataType) {
  const dataSize = readUInt32LE(packet, 26);
  const totalPackets = readUInt32LE(packet, 30);
  const packetNo = readUInt32LE(packet, 34);
  const clusterSize = readUInt32LE(packet, 38);
  const dataStart = 42;
  const available = Math.max(0, packet.length - dataStart);
  const payloadSize = dataSize && dataType === 16 ? Math.min(dataSize, available) : available;
  const payload = packet.subarray(dataStart, dataStart + payloadSize);
  const points = [];

  for (let index = 0; index + 1 < payload.length; index += 2) {
    points.push([payload[index], payload[index + 1]]);
  }

  return {
    layerId: readUInt8(packet, 25),
    kind: dataType === 16 ? 'small' : 'big',
    dataSize,
    totalPackets,
    packetNo,
    clusterSize,
    pointCount: points.length,
    points
  };
}

function parseTextLike(packet) {
  const size = readUInt32LE(packet, 26);
  return {
    ...parseCommon(packet),
    text: readAscii(packet, 42, size)
  };
}

function parseApplicationData(packet) {
  const data = parseClusterData(packet);
  return {
    ...data,
    identifier1: readUInt8(packet, 24),
    identifier2: readUInt8(packet, 25)
  };
}

function parseClusterData(packet) {
  const dataSize = readUInt32LE(packet, 26);
  const totalPackets = readUInt32LE(packet, 30);
  const packetNo = readUInt32LE(packet, 34);
  const packetSignature = readUInt32LE(packet, 38);
  const payload = packet.subarray(42);
  return {
    ...parseCommon(packet),
    dataSize,
    totalPackets,
    packetNo,
    packetSignature,
    payloadSize: payload.length,
    payloadPreviewHex: payload.subarray(0, 32).toString('hex')
  };
}

function makeBasePacket(length, {nodeId, nodeName, seq, nodeType, nodeOptions = 0, messageType}) {
  const packet = Buffer.alloc(length);
  packet.writeUInt16LE(nodeId, 0);
  packet[2] = 3;
  packet[3] = 5;
  TCNET_HEADER.copy(packet, 4);
  packet[7] = messageType;
  writeAscii(packet, 8, 8, nodeName);
  packet[16] = seq & 0xff;
  packet[17] = nodeType;
  packet.writeUInt16LE(clampUInt16(nodeOptions), 18);
  packet.writeUInt32LE(currentMicros(), 20);
  return packet;
}

function makeOptInPacket({nodeId, nodeName, seq, nodeType, nodeOptions, listenerPort, nodeCount, uptimeSeconds, vendor, appName, appVersion}) {
  const packet = makeBasePacket(68, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 2});
  packet.writeUInt16LE(nodeCount || 0, 24);
  packet.writeUInt16LE(listenerPort, 26);
  packet.writeUInt16LE(uptimeSeconds % 43200, 28);
  writeAscii(packet, 32, 16, vendor || 'Local');
  writeAscii(packet, 48, 16, appName || 'PDL Monitor');
  const version = Array.isArray(appVersion) ? appVersion : [0, 1, 0];
  packet[64] = clampByte(version[0]);
  packet[65] = clampByte(version[1]);
  packet[66] = clampByte(version[2]);
  return packet;
}

function makeRequestPacket({nodeId, nodeName, seq, nodeType, nodeOptions, dataType, layerId}) {
  const packet = makeBasePacket(26, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 20});
  packet[24] = dataType;
  packet[25] = layerId;
  return packet;
}

function makeStatusPacket({
  nodeId,
  nodeName,
  seq,
  nodeType,
  nodeOptions,
  listenerPort,
  nodeCount,
  layers,
  smpteMode = 30,
  autoMasterMode = 0,
  appName = 'PRODJLINK BRIDGE'
}) {
  const packet = makeBasePacket(300, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 5});
  packet.writeUInt16LE(nodeCount || 0, 24);
  packet.writeUInt16LE(listenerPort || TCNET_PORTS.defaultUnicast, 26);
  packet[83] = smpteMode;
  packet[84] = autoMasterMode;
  writeAscii(packet, 120, 16, appName);

  normalizeLayers(layers).forEach((layer, index) => {
    packet[34 + index] = layer.source === undefined ? 0 : clampByte(layer.source);
    packet[42 + index] = normalizeLayerState(layer);
    packet.writeUInt32LE(clampUInt32(layer.trackId), 50 + index * 4);
    writeAscii(packet, 172 + index * 16, 16, layer.name || '');
  });

  return packet;
}

function makeTimePacket({nodeId, nodeName, seq, nodeType, nodeOptions, layers, smpteMode = 30, fps = 25}) {
  const packet = makeBasePacket(154, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 254});
  packet[104] = 1;
  packet[105] = smpteMode;

  normalizeLayers(layers).forEach((layer, index) => {
    const timeMs = clampUInt32(layer.timeMs ?? layer.positionMs);
    const totalMs = clampUInt32(layer.totalTimeMs ?? layer.trackLengthMs);
    packet.writeUInt32LE(timeMs, 24 + index * 4);
    packet.writeUInt32LE(totalMs, 56 + index * 4);
    packet[88 + index] = clampByte(layer.beatMarker || layer.beatInMeasure || 0);
    packet[96 + index] = normalizeLayerState(layer);
  });

  return packet;
}

function makeMetricsPacket({nodeId, nodeName, seq, nodeType, nodeOptions, layerId, state, syncMaster, beatMarker, trackLengthMs, positionMs, speedPercent, beatNumber, bpm, trackId}) {
  const packet = makeBasePacket(130, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 200});
  packet[24] = 2;
  packet[25] = clampByte(layerId);
  packet[27] = normalizeLayerState({state});
  packet[29] = syncMaster ? 1 : 0;
  packet[31] = clampByte(beatMarker || 0);
  packet.writeUInt32LE(clampUInt32(trackLengthMs), 32);
  packet.writeUInt32LE(clampUInt32(positionMs), 36);
  packet.writeUInt32LE(speedPercentToRaw(speedPercent), 40);
  packet.writeUInt32LE(clampUInt32(beatNumber), 57);
  packet.writeUInt32LE(clampUInt32(Math.round(Number(bpm || 0) * 100)), 112);
  packet.writeUInt16LE(0, 116);
  packet.writeUInt32LE(clampUInt32(trackId), 118);
  return packet;
}

function makeMetadataPacket({nodeId, nodeName, seq, nodeType, nodeOptions, layerId, artist, title, key, trackId}) {
  const packet = makeBasePacket(560, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 200});
  packet[24] = 4;
  packet[25] = clampByte(layerId);
  writeUtf8(packet, 29, 256, artist || '');
  writeUtf8(packet, 285, 256, title || '');
  packet.writeUInt16LE(clampUInt16(key), 541);
  packet.writeUInt32LE(clampUInt32(trackId), 543);
  return packet;
}

function makeApplicationDataPacket({
  nodeId,
  nodeName,
  seq,
  nodeType,
  nodeOptions,
  identifier1 = 0xff,
  identifier2 = 0xff,
  packetSignature = 0x0abc0000,
  payload = Buffer.alloc(0)
}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const packet = makeBasePacket(42 + body.length, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 30});
  packet[24] = clampByte(identifier1);
  packet[25] = clampByte(identifier2);
  packet.writeUInt32LE(clampUInt32(body.length), 26);
  packet.writeUInt32LE(1, 30);
  packet.writeUInt32LE(1, 34);
  packet.writeUInt32LE(clampUInt32(packetSignature), 38);
  body.copy(packet, 42);
  return packet;
}

function makeNotificationPacket({
  nodeId,
  nodeName,
  seq,
  nodeType,
  nodeOptions,
  identifier1 = 0xff,
  identifier2 = 0xff,
  code = 13,
  relatedType = 30,
  relatedDataType = 0
}) {
  const packet = makeBasePacket(30, {nodeId, nodeName, seq, nodeType, nodeOptions, messageType: 13});
  packet[24] = clampByte(identifier1);
  packet[25] = clampByte(identifier2);
  packet.writeUInt16LE(clampUInt16(code), 26);
  packet[28] = clampByte(relatedType);
  packet[29] = clampByte(relatedDataType);
  return packet;
}

function normalizeLayers(layers) {
  const byId = new Map((layers || []).map((layer) => [Number(layer.id || layer.layerId), layer]));
  return LAYER_NAMES.map((name, index) => {
    const id = index + 1;
    return {id, ...(byId.get(id) || {})};
  });
}

function normalizeLayerState(layer = {}) {
  const value = Number(layer.state);
  if (Number.isFinite(value) && value >= 0 && value <= 255) return value;
  const name = layer.stateName || layer.playStateName || '';
  if (name === 'Looping') return 4;
  if (name === 'Paused') return 5;
  if (name === 'Stopped') return 6;
  if (name === 'Cue Down') return 7;
  if (name === 'Platter Down') return 8;
  if (name === 'FFWD') return 9;
  if (name === 'FFRV') return 10;
  if (name === 'Hold') return 11;
  if (layer.playing || name === 'Playing' || name === 'Beat') return 3;
  return 0;
}

function msToTimecodeFields(ms, fps) {
  const frameRate = [24, 25, 30].includes(Number(fps)) ? Number(fps) : 25;
  const totalFrames = Math.max(0, Math.floor((Number(ms || 0) * frameRate) / 1000));
  const frames = totalFrames % frameRate;
  const totalSeconds = Math.floor(totalFrames / frameRate);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return {hours, minutes, seconds, frames};
}

function speedPercentToRaw(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 32768;
  return clampUInt32(Math.round((numeric / 100) * 32768));
}

function clampByte(value) {
  const numeric = Math.round(Number(value || 0));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(255, numeric));
}

function clampUInt16(value) {
  const numeric = Math.round(Number(value || 0));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(65535, numeric));
}

function clampUInt32(value) {
  const numeric = Math.round(Number(value || 0));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(0xffffffff, numeric));
}

function nodeTypeName(value) {
  const names = [];
  if (value & 1) names.push('Auto');
  if (value & 2) names.push('Master');
  if (value & 4) names.push('Slave');
  if (value & 8) names.push('Repeater');
  return names.join('+') || `Type ${value}`;
}

function formatTimecode(hours, minutes, seconds, frames) {
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

function rawSpeedToPercent(value) {
  if (!value) return 0;
  return Number(((value / 32768) * 100).toFixed(2));
}

function currentMicros() {
  const now = Date.now();
  return (now % 1000) * 1000;
}

function readUtfText(packet, offset, length) {
  if (packet.length <= offset) return '';
  const slice = packet.subarray(offset, Math.min(packet.length, offset + length));
  if (looksLikeUtf16Le(slice)) {
    const end = findUtf16Terminator(slice);
    return slice.subarray(0, end).toString('utf16le').replace(/\0/g, '').trim();
  }

  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function looksLikeUtf16Le(slice) {
  const sampleLength = Math.min(slice.length, 32);
  let pairs = 0;
  let nonZeroEven = 0;
  let zeroOdd = 0;

  for (let offset = 0; offset + 1 < sampleLength; offset += 2) {
    const even = slice[offset];
    const odd = slice[offset + 1];
    if (even === 0 && odd === 0) break;
    pairs += 1;
    if (even !== 0) nonZeroEven += 1;
    if (odd === 0) zeroOdd += 1;
  }

  return pairs >= 2 && nonZeroEven >= 2 && zeroOdd / pairs >= 0.6;
}

function findUtf16Terminator(slice) {
  for (let offset = 0; offset + 1 < slice.length; offset += 2) {
    if (slice[offset] === 0 && slice[offset + 1] === 0) return offset;
  }
  return slice.length;
}

function readAscii(packet, offset, length) {
  if (packet.length <= offset) return '';
  return packet
    .subarray(offset, Math.min(packet.length, offset + length))
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
}

function writeAscii(packet, offset, length, value) {
  Buffer.from(String(value || '').slice(0, length), 'ascii').copy(packet, offset);
}

function writeUtf8(packet, offset, length, value) {
  Buffer.from(String(value || ''), 'utf8').copy(packet, offset, 0, length - 1);
}

function readRgb(packet, offset) {
  if (packet.length < offset + 3) return '#000000';
  return `#${[packet[offset], packet[offset + 1], packet[offset + 2]]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function readUInt8(packet, offset) {
  return packet.length > offset ? packet.readUInt8(offset) : 0;
}

function readUInt16LE(packet, offset) {
  return packet.length >= offset + 2 ? packet.readUInt16LE(offset) : 0;
}

function readUInt32LE(packet, offset) {
  return packet.length >= offset + 4 ? packet.readUInt32LE(offset) : 0;
}

function pad2(value) {
  return String(value || 0).padStart(2, '0');
}

module.exports = {
  TCNET_HEADER,
  TCNET_PORTS,
  TCNET_TYPES,
  TCNET_DATA_TYPES,
  LAYER_NAMES,
  parseTcnetPacket,
  makeOptInPacket,
  makeRequestPacket,
  makeStatusPacket,
  makeTimePacket,
  makeMetricsPacket,
  makeMetadataPacket,
  makeApplicationDataPacket,
  makeNotificationPacket,
  hasTcnetHeader
};
