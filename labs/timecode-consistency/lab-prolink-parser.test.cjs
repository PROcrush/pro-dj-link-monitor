'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {PROLINK_HEADER, PORTS, parsePacket} = require('./lab-prolink-parser.cjs');

test('parses CDJ-3000 absolute position packets', () => {
  const packet = Buffer.alloc(0x3c);
  PROLINK_HEADER.copy(packet, 0);
  packet.writeUInt8(0x0b, 0x0a);
  packet.writeUInt8(2, 0x21);
  packet.writeUInt32BE(217, 0x24);
  packet.writeUInt32BE(123456, 0x28);
  packet.writeInt32BE(326, 0x2c);
  packet.writeUInt32BE(1202, 0x38);

  const parsed = parsePacket(packet, {localPort: PORTS.beat, address: '192.0.2.16'});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.typeName, 'precise-position');
  assert.equal(parsed.beat.deviceId, 2);
  assert.equal(parsed.beat.positionMs, 123456);
  assert.equal(parsed.beat.trackLengthMs, 217000);
  assert.equal(parsed.beat.pitchPercent, 3.26);
  assert.equal(parsed.beat.effectiveBpm, 120.2);
});

test('parses status timing fields needed by beat-grid fallback', () => {
  const packet = Buffer.alloc(0xcc);
  PROLINK_HEADER.copy(packet, 0);
  packet.writeUInt8(0x0a, 0x0a);
  packet.writeUInt8(2, 0x21);
  packet.writeUInt8(2, 0x28);
  packet.writeUInt8(3, 0x29);
  packet.writeUInt8(1, 0x2a);
  packet.writeUInt32BE(777, 0x2c);
  packet.writeUInt8(0x03, 0x7b);
  packet.writeUInt8(0x68, 0x89);
  packet.writeUInt16BE(14010, 0x92);
  packet.writeUInt32BE(465, 0xa0);
  packet.writeUInt8(1, 0xa6);

  const parsed = parsePacket(packet, {localPort: PORTS.status, address: '192.0.2.16'});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.status.deviceId, 2);
  assert.equal(parsed.status.trackId, 777);
  assert.equal(parsed.status.playStateName, 'Playing');
  assert.equal(parsed.status.isPlayingFlag, true);
  assert.equal(parsed.status.isMaster, true);
  assert.equal(parsed.status.isOnAir, true);
  assert.equal(parsed.status.trackBpm, 140.1);
  assert.equal(parsed.status.beat, 465);
  assert.equal(parsed.status.beatInMeasure, 1);
});
