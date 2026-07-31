const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TCNET_HEADER,
  parseTcnetPacket,
  makeOptInPacket,
  makeRequestPacket,
  makeStatusPacket,
  makeTimePacket,
  makeMetricsPacket,
  makeMetadataPacket,
  makeApplicationDataPacket,
  makeNotificationPacket
} = require('../src/prolink/tcnet.cjs');

test('builds and parses TCNet opt-in packets', () => {
  const packet = makeOptInPacket({
    nodeId: 0x1234,
    nodeName: 'PDLMON',
    seq: 7,
    nodeType: 4,
    listenerPort: 65024,
    nodeCount: 2,
    uptimeSeconds: 42,
    vendor: 'Local',
    appName: 'PDL Monitor'
  });

  const parsed = parseTcnetPacket(packet, {localPort: 60000, address: '192.168.10.20', sourcePort: 60000});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.common.versionMajor, 3);
  assert.equal(parsed.common.versionMinor, 5);
  assert.equal(parsed.typeName, 'opt-in');
  assert.equal(parsed.tcnetNode.nodeId, 0x1234);
  assert.equal(parsed.tcnetNode.nodeName, 'PDLMON');
  assert.equal(parsed.tcnetNode.listenerPort, 65024);
  assert.equal(parsed.tcnetNode.nodeTypeName, 'Slave');
  assert.equal(parsed.tcnetNode.appName, 'PDL Monitor');
});

test('builds and parses TCNet data request packets', () => {
  const packet = makeRequestPacket({
    nodeId: 0x1234,
    nodeName: 'PDLMON',
    seq: 8,
    nodeType: 4,
    dataType: 4,
    layerId: 2
  });

  const parsed = parseTcnetPacket(packet, {localPort: 60000, address: '192.168.10.21', sourcePort: 65023});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.typeName, 'request');
  assert.equal(parsed.tcnetRequest.dataTypeName, 'metadata');
  assert.equal(parsed.tcnetRequest.layerId, 2);
});

test('parses TCNet time packets', () => {
  const packet = tcnetBase(162, 254);
  packet.writeUInt32LE(65_432, 24);
  packet.writeUInt32LE(180_000, 56);
  packet[88] = 4;
  packet[96] = 3;
  packet[105] = 5;
  packet[106] = 1;
  packet[107] = 2;
  packet[108] = 1;
  packet[109] = 2;
  packet[110] = 3;
  packet[111] = 12;
  packet[154] = 1;

  const parsed = parseTcnetPacket(packet, {localPort: 60001, address: '192.168.10.30', sourcePort: 60001});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.typeName, 'time');
  assert.equal(parsed.tcnetTime.layers[0].timeMs, 65_432);
  assert.equal(parsed.tcnetTime.layers[0].totalTimeMs, 180_000);
  assert.equal(parsed.tcnetTime.layers[0].stateName, 'Playing');
  assert.equal(parsed.tcnetTime.layers[0].timecode, '01:02:03:12');
  assert.equal(parsed.tcnetTime.layers[0].onAir, 1);
});

test('parses TCNet metadata packets', () => {
  const packet = tcnetBase(560, 200);
  packet[24] = 4;
  packet[25] = 2;
  writeUtf8(packet, 29, 256, 'Artist Name');
  writeUtf8(packet, 285, 256, 'Track Title');
  packet.writeUInt16LE(11, 541);
  packet.writeUInt32LE(123456, 543);

  const parsed = parseTcnetPacket(packet, {localPort: 65024, address: '192.168.10.31', sourcePort: 65023});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.tcnetData.dataTypeName, 'metadata');
  assert.equal(parsed.tcnetData.metadata.layerId, 2);
  assert.equal(parsed.tcnetData.metadata.artist, 'Artist Name');
  assert.equal(parsed.tcnetData.metadata.title, 'Track Title');
  assert.equal(parsed.tcnetData.metadata.trackId, 123456);
});

test('parses TCNet metric and cue packets', () => {
  const metrics = tcnetBase(130, 200);
  metrics[24] = 2;
  metrics[25] = 1;
  metrics[27] = 3;
  metrics[31] = 7;
  metrics.writeUInt32LE(240_000, 32);
  metrics.writeUInt32LE(30_500, 36);
  metrics.writeUInt32LE(32768, 40);
  metrics.writeUInt32LE(16, 57);
  metrics.writeUInt32LE(12850, 112);
  metrics.writeUInt16LE(12, 116);
  metrics.writeUInt32LE(999, 118);

  const metricParsed = parseTcnetPacket(metrics, {localPort: 65024, address: '192.168.10.32'});
  assert.equal(metricParsed.tcnetData.metrics.stateName, 'Playing');
  assert.equal(metricParsed.tcnetData.metrics.positionMs, 30_500);
  assert.equal(metricParsed.tcnetData.metrics.bpm, 128.5);
  assert.equal(metricParsed.tcnetData.metrics.trackId, 999);

  const cues = tcnetBase(96, 200);
  cues[24] = 12;
  cues[25] = 1;
  cues.writeUInt32LE(1000, 42);
  cues[47] = 1;
  cues.writeUInt32LE(3000, 49);
  cues.writeUInt32LE(4000, 53);
  Buffer.from([0x20, 0xd0, 0x70]).copy(cues, 58);

  const cueParsed = parseTcnetPacket(cues, {localPort: 65024, address: '192.168.10.32'});
  assert.equal(cueParsed.tcnetData.dataTypeName, 'cue-data');
  assert.equal(cueParsed.tcnetData.cues.layerId, 1);
  assert.equal(cueParsed.tcnetData.cues.cues.length, 1);
  assert.equal(cueParsed.tcnetData.cues.cues[0].inMs, 3000);
  assert.equal(cueParsed.tcnetData.cues.cues[0].color, '#20d070');
});

test('parses TCNet small waveform packets', () => {
  const packet = tcnetBase(48, 200);
  packet[24] = 16;
  packet[25] = 3;
  packet.writeUInt32LE(6, 26);
  packet.writeUInt32LE(1, 30);
  packet.writeUInt32LE(1, 34);
  Buffer.from([10, 90, 120, 180, 255, 240]).copy(packet, 42);

  const parsed = parseTcnetPacket(packet, {localPort: 65024, address: '192.168.10.33'});

  assert.equal(parsed.tcnetData.dataTypeName, 'small-waveform');
  assert.equal(parsed.tcnetData.waveform.layerId, 3);
  assert.equal(parsed.tcnetData.waveform.kind, 'small');
  assert.equal(parsed.tcnetData.waveform.pointCount, 3);
  assert.deepEqual(parsed.tcnetData.waveform.points, [
    [10, 90],
    [120, 180],
    [255, 240]
  ]);
});

test('parses TCNet application, app-specific, and file packets for passive capture', () => {
  const app = tcnetBase(50, 30);
  app[24] = 0x12;
  app[25] = 0x34;
  app.writeUInt32LE(8, 26);
  app.writeUInt32LE(2, 30);
  app.writeUInt32LE(1, 34);
  app.writeUInt32LE(0x0aa0b0c0, 38);
  Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).copy(app, 42);

  const appParsed = parseTcnetPacket(app, {localPort: 60002, address: '127.0.0.1'});
  assert.equal(appParsed.typeName, 'application-data');
  assert.equal(appParsed.tcnetApplicationData.identifier1, 0x12);
  assert.equal(appParsed.tcnetApplicationData.identifier2, 0x34);
  assert.equal(appParsed.tcnetApplicationData.dataSize, 8);
  assert.equal(appParsed.tcnetApplicationData.totalPackets, 2);
  assert.equal(appParsed.tcnetApplicationData.packetNo, 1);
  assert.equal(appParsed.tcnetApplicationData.packetSignature, 0x0aa0b0c0);
  assert.equal(appParsed.tcnetApplicationData.payloadPreviewHex, '0102030405060708');

  const appSpecific = tcnetBase(46, 213);
  appSpecific.writeUInt32LE(4, 26);
  Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]).copy(appSpecific, 42);
  const appSpecificParsed = parseTcnetPacket(appSpecific, {localPort: 60000});
  assert.equal(appSpecificParsed.typeName, 'application-specific-data');
  assert.equal(appSpecificParsed.tcnetApplicationSpecificData.payloadPreviewHex, 'aabbccdd');

  const file = tcnetBase(45, 204);
  file.writeUInt32LE(3, 26);
  Buffer.from([0xff, 0xd8, 0xff]).copy(file, 42);
  const fileParsed = parseTcnetPacket(file, {localPort: 65024});
  assert.equal(fileParsed.typeName, 'file');
  assert.equal(fileParsed.tcnetFile.payloadSize, 3);
  assert.equal(fileParsed.tcnetFile.payloadPreviewHex, 'ffd8ff');
});

test('builds and parses TCNet application data packets', () => {
  const payload = Buffer.alloc(20);
  payload.writeUInt16LE(0, 0);
  payload.writeUInt16LE(65024, 2);
  const packet = makeApplicationDataPacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 11,
    nodeType: 2,
    identifier1: 0xff,
    identifier2: 0xff,
    packetSignature: 0x0abc0000,
    payload
  });

  const parsed = parseTcnetPacket(packet, {localPort: 65208});

  assert.equal(parsed.typeName, 'application-data');
  assert.equal(parsed.tcnetApplicationData.identifier1, 0xff);
  assert.equal(parsed.tcnetApplicationData.identifier2, 0xff);
  assert.equal(parsed.tcnetApplicationData.packetSignature, 0x0abc0000);
  assert.equal(parsed.tcnetApplicationData.payloadPreviewHex.slice(0, 8), '000000fe');
});

test('builds and parses TCNet notification packets', () => {
  const packet = makeNotificationPacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 12,
    nodeType: 2,
    identifier1: 0xff,
    identifier2: 0xff,
    code: 13,
    relatedType: 30,
    relatedDataType: 0
  });

  const parsed = parseTcnetPacket(packet, {localPort: 65208});

  assert.equal(parsed.typeName, 'notification');
  assert.equal(parsed.tcnetNotification.identifier1, 0xff);
  assert.equal(parsed.tcnetNotification.identifier2, 0xff);
  assert.equal(parsed.tcnetNotification.code, 13);
  assert.equal(parsed.tcnetNotification.relatedTypeName, 'application-data');
  assert.equal(parsed.tcnetNotification.rawBodyHex, 'ffff0d001e00');
});

test('builds Arena-style TCNet status and time packets from deck layers', () => {
  const layers = [{
    id: 2,
    name: 'D2',
    source: 2,
    stateName: 'Playing',
    playing: true,
    trackId: 9001,
    timeMs: 65_432,
    totalTimeMs: 180_000,
    beatMarker: 4,
    onAir: true
  }];

  const status = makeStatusPacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 9,
    nodeType: 2,
    listenerPort: 65024,
    nodeCount: 1,
    layers
  });
  const statusParsed = parseTcnetPacket(status, {localPort: 60000});

  assert.equal(statusParsed.typeName, 'status');
  assert.equal(status.length, 300);
  assert.equal(statusParsed.tcnetStatus.appName, 'PRODJLINK BRIDGE');
  assert.equal(statusParsed.tcnetStatus.layers[0].source, 0);
  assert.equal(statusParsed.tcnetStatus.layers[0].name, 'L1');
  assert.equal(statusParsed.tcnetStatus.layers[1].name, 'D2');
  assert.equal(statusParsed.tcnetStatus.layers[1].source, 2);
  assert.equal(statusParsed.tcnetStatus.layers[1].stateName, 'Playing');
  assert.equal(statusParsed.tcnetStatus.layers[1].trackId, 9001);

  const time = makeTimePacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 10,
    nodeType: 2,
    fps: 25,
    layers
  });
  const timeParsed = parseTcnetPacket(time, {localPort: 60001});

  assert.equal(timeParsed.typeName, 'time');
  assert.equal(time.length, 154);
  assert.equal(timeParsed.tcnetTime.timeEnabled, 1);
  assert.equal(timeParsed.tcnetTime.smpteMode, 30);
  assert.equal(timeParsed.tcnetTime.layers[1].timeMs, 65_432);
  assert.equal(timeParsed.tcnetTime.layers[1].totalTimeMs, 180_000);
  assert.equal(timeParsed.tcnetTime.layers[1].beatMarker, 4);
  assert.equal(timeParsed.tcnetTime.layers[1].stateName, 'Playing');
  assert.equal(timeParsed.tcnetTime.layers[1].onAir, 0);
});

test('builds Arena-style TCNet metrics and metadata packets', () => {
  const metrics = makeMetricsPacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 11,
    nodeType: 2,
    layerId: 2,
    state: 3,
    syncMaster: true,
    beatMarker: 1,
    trackLengthMs: 210_000,
    positionMs: 42_000,
    speedPercent: 100,
    beatNumber: 64,
    bpm: 128.5,
    trackId: 777
  });
  const metricsParsed = parseTcnetPacket(metrics, {localPort: 60000});

  assert.equal(metricsParsed.typeName, 'data');
  assert.equal(metricsParsed.tcnetData.dataTypeName, 'metrics');
  assert.equal(metricsParsed.tcnetData.metrics.layerId, 2);
  assert.equal(metricsParsed.tcnetData.metrics.syncMaster, 1);
  assert.equal(metricsParsed.tcnetData.metrics.bpm, 128.5);
  assert.equal(metricsParsed.tcnetData.metrics.trackId, 777);

  const metadata = makeMetadataPacket({
    nodeId: 0x0f10,
    nodeName: 'PDLMON',
    seq: 12,
    nodeType: 2,
    layerId: 2,
    artist: 'Artist',
    title: 'Title',
    key: 11,
    trackId: 777
  });
  const metadataParsed = parseTcnetPacket(metadata, {localPort: 60000});

  assert.equal(metadataParsed.tcnetData.dataTypeName, 'metadata');
  assert.equal(metadataParsed.tcnetData.metadata.layerId, 2);
  assert.equal(metadataParsed.tcnetData.metadata.artist, 'Artist');
  assert.equal(metadataParsed.tcnetData.metadata.title, 'Title');
  assert.equal(metadataParsed.tcnetData.metadata.key, 11);
  assert.equal(metadataParsed.tcnetData.metadata.trackId, 777);
});

function tcnetBase(length, type) {
  const packet = Buffer.alloc(length);
  packet.writeUInt16LE(0x1111, 0);
  packet[2] = 3;
  packet[3] = 6;
  TCNET_HEADER.copy(packet, 4);
  packet[7] = type;
  packet.write('RESOLU', 8, 'ascii');
  packet[16] = 1;
  packet[17] = 2;
  return packet;
}

function writeUtf8(packet, offset, length, value) {
  Buffer.from(value, 'utf8').copy(packet, offset, 0, length);
}
