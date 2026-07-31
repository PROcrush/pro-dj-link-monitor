const test = require('node:test');
const assert = require('node:assert/strict');
const {parsePacket} = require('../src/prolink/parser.cjs');
const {
  makeAnnouncePacket,
  makeStartupPackets,
  makeHelloPacket,
  makeClaimStage1Packet,
  makeClaimStage2Packet,
  makeClaimStage3Packet
} = require('../src/prolink/virtualCdj.cjs');

test('builds a Virtual CDJ announcement that PRO DJ LINK parser can read', () => {
  const packet = makeAnnouncePacket({
    id: 7,
    name: 'PDL-MONITOR',
    type: 1,
    ip: '192.0.2.70',
    mac: '10:20:30:40:50:60'
  });

  const parsed = parsePacket(packet, {localPort: 50000, address: '192.0.2.70', sourcePort: 50000});

  assert.equal(parsed.valid, true);
  assert.equal(parsed.summary, 'Device announcement');
  assert.equal(parsed.device.id, 7);
  assert.equal(parsed.device.name, 'PDL-MONITOR');
  assert.equal(parsed.device.typeName, 'CDJ/XDJ');
  assert.equal(parsed.device.ip, '192.0.2.70');
  assert.equal(parsed.device.mac, '10:20:30:40:50:60');
});

test('builds Virtual CDJ startup hello and claim packets', () => {
  const device = {
    id: 7,
    name: 'PDL-MONITOR',
    ip: '192.0.2.11',
    mac: '10:20:30:40:50:60'
  };

  const hello = makeHelloPacket(device);
  assert.equal(hello[0x0a], 0x0a);
  assert.equal(hello.subarray(0x0c, 0x17).toString('ascii').replace(/\0/g, ''), 'PDL-MONITOR');

  const claim1 = makeClaimStage1Packet(device, 2);
  assert.equal(claim1[0x0a], 0x00);
  assert.equal(claim1[0x24], 2);
  assert.equal(claim1.subarray(0x26, 0x2c).toString('hex'), '102030405060');

  const claim2 = makeClaimStage2Packet(device, 3);
  assert.equal(claim2[0x0a], 0x02);
  assert.deepEqual(Array.from(claim2.subarray(0x24, 0x28)), [192, 0, 2, 11]);
  assert.equal(claim2.subarray(0x28, 0x2e).toString('hex'), '102030405060');
  assert.equal(claim2[0x2e], 7);
  assert.equal(claim2[0x2f], 3);
  assert.equal(claim2[0x31], 2);

  const claim3 = makeClaimStage3Packet(device, 1);
  assert.equal(claim3[0x0a], 0x04);
  assert.equal(claim3[0x24], 7);
  assert.equal(claim3[0x25], 1);

  const sequence = makeStartupPackets(device);
  assert.equal(sequence.length, 12);
});
