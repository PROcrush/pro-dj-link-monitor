const test = require('node:test');
const assert = require('node:assert/strict');
const {PROLINK_HEADER, parsePacket} = require('../src/prolink/parser.cjs');

test('parses announce packets', () => {
  const packet = Buffer.alloc(0x36);
  PROLINK_HEADER.copy(packet, 0);
  packet[0x0a] = 0x06;
  packet.write('CDJ-3000', 0x0c, 'ascii');
  packet[0x24] = 0x02;
  Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]).copy(packet, 0x26);
  Buffer.from([192, 168, 10, 42]).copy(packet, 0x2c);
  packet[0x34] = 0x01;

  const parsed = parsePacket(packet, {localPort: 50000, address: '192.168.10.42', sourcePort: 50000});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.device.name, 'CDJ-3000');
  assert.equal(parsed.device.id, 2);
  assert.equal(parsed.device.typeName, 'CDJ/XDJ');
  assert.equal(parsed.device.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(parsed.device.ip, '192.168.10.42');
});

test('parses CDJ status packets', () => {
  const packet = Buffer.alloc(0xcc);
  PROLINK_HEADER.copy(packet, 0);
  packet[0x0a] = 0x0a;
  packet[0x21] = 0x03;
  packet[0x28] = 0x01;
  packet[0x29] = 0x03;
  packet[0x2a] = 0x01;
  packet.writeUInt32BE(123456, 0x2c);
  packet[0x7b] = 0x03;
  packet[0x89] = (1 << 3) | (1 << 5) | (1 << 6);
  packet.writeUInt16BE(12850, 0x92);
  Buffer.from([0x10, 0x00, 0x00]).copy(packet, 0x99);
  packet.writeUInt32BE(64, 0xa0);
  packet.writeUInt16BE(16, 0xa4);
  packet[0xa6] = 0x01;
  packet.writeUInt32BE(77, 0xc8);

  const parsed = parsePacket(packet, {localPort: 50002, address: '192.168.10.43', sourcePort: 50002});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.status.deviceId, 3);
  assert.equal(parsed.status.trackId, 123456);
  assert.equal(parsed.status.trackSlotName, 'USB');
  assert.equal(parsed.status.playStateName, 'Playing');
  assert.equal(parsed.status.isOnAir, true);
  assert.equal(parsed.status.isMaster, true);
  assert.equal(parsed.status.trackBpm, 128.5);
  assert.equal(parsed.status.beat, 64);
  assert.equal(parsed.status.beatInMeasure, 1);
  assert.equal(parsed.status.packetNum, 77);
});

test('parses CDJ-3000 beat packets captured from the LAN', () => {
  const packet = Buffer.from(
    '5173707431576d4a4f4c2843444a2d33303030000000000000000000000000010001003c000001ee000003dc000005c9000007b700000d7f00000f6dffffffffffffffffffffffffffffffffffffffffffffffff000fb43900002f7e02000001',
    'hex'
  );

  const parsed = parsePacket(packet, {localPort: 50001, address: '192.0.2.16', sourcePort: 39591});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.summary, 'beat');
  assert.equal(parsed.beat.deviceId, 1);
  assert.equal(parsed.beat.packetTypeName, 'beat');
  assert.equal(parsed.beat.trackBpm, 121.58);
  assert.equal(parsed.beat.beatInMeasure, 2);
  assert.deepEqual(parsed.beat.beatDistanceMs, [494, 988, 1481, 1975, 3455, 3949]);
});

test('parses CDJ-3000 precise position packets captured from the LAN', () => {
  const packet = Buffer.from(
    '5173707431576d4a4f4c0b43444a2d333030300000000000000000000000000200010018000017990007c4dc00000235000000000000000000000504',
    'hex'
  );

  const parsed = parsePacket(packet, {localPort: 50001, address: '192.0.2.16', sourcePort: 50001});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.summary, 'precise-position');
  assert.equal(parsed.beat.deviceId, 1);
  assert.equal(parsed.beat.packetTypeName, 'precise-position');
  assert.equal(parsed.beat.trackLengthSeconds, 6041);
  assert.equal(parsed.beat.trackLengthMs, 6041000);
  assert.equal(parsed.beat.positionMs, 509148);
  assert.equal(parsed.beat.pitchPercent, 5.65);
  assert.equal(parsed.beat.effectiveBpm, 128.4);
});
