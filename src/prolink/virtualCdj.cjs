// SPDX-License-Identifier: EPL-2.0
// Protocol startup templates and claim logic adapted from Deep Symmetry's
// beat-link VirtualCdj.java. See THIRD_PARTY_NOTICES.md and LICENSES/EPL-2.0.txt.

const {PROLINK_HEADER, PORTS} = require('./parser.cjs');

const ANNOUNCE_INTERVAL_MS = 1500;
const STARTUP_STEP_MS = 300;

const HELLO_TEMPLATE = Buffer.from([
  0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c, 0x0a, 0x00, 0x62, 0x65, 0x61, 0x74,
  0x2d, 0x6c, 0x69, 0x6e, 0x6b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x00, 0x26, 0x01, 0x40
]);

const CLAIM_STAGE_1_TEMPLATE = Buffer.from([
  0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c, 0x00, 0x00, 0x62, 0x65, 0x61, 0x74,
  0x2d, 0x6c, 0x69, 0x6e, 0x6b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x03, 0x00, 0x2c, 0x0d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);

const CLAIM_STAGE_2_TEMPLATE = Buffer.from([
  0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c, 0x02, 0x00, 0x62, 0x65, 0x61, 0x74,
  0x2d, 0x6c, 0x69, 0x6e, 0x6b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x03, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x00,
  0x01, 0x00
]);

const CLAIM_STAGE_3_TEMPLATE = Buffer.from([
  0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c, 0x04, 0x00, 0x62, 0x65, 0x61, 0x74,
  0x2d, 0x6c, 0x69, 0x6e, 0x6b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x03, 0x00, 0x26, 0x0d, 0x00
]);

class VirtualCdjProbe {
  constructor({socket, getDevices, interfaceAddress, interfaceMac, deviceId = 7, deviceName = 'PDL-MONITOR'}) {
    this.socket = socket;
    this.getDevices = getDevices;
    this.interfaceAddress = interfaceAddress;
    this.interfaceMac = interfaceMac;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.timer = null;
    this.startupTimers = [];
    this.enabled = false;
    this.sent = 0;
    this.startupSent = 0;
  }

  start() {
    if (!this.socket || !this.interfaceAddress || !this.interfaceMac) return false;
    this.stop();
    this.enabled = true;
    this.sendStartupHandshake();
    this.timer = setInterval(() => this.send(), ANNOUNCE_INTERVAL_MS);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers = [];
    this.timer = null;
    this.enabled = false;
  }

  getState() {
    return {
      enabled: this.enabled,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      sent: this.sent,
      startupSent: this.startupSent,
      interfaceAddress: this.interfaceAddress || null
    };
  }

  sendStartupHandshake() {
    const packets = makeStartupPackets({
      id: this.deviceId,
      name: this.deviceName,
      ip: this.interfaceAddress,
      mac: this.interfaceMac
    });

    packets.forEach((packet, index) => {
      const timer = setTimeout(() => {
        this.sendRaw(packet);
        this.startupSent += 1;
      }, index * STARTUP_STEP_MS);
      this.startupTimers.push(timer);
    });

    const announceTimer = setTimeout(() => this.send(), packets.length * STARTUP_STEP_MS);
    this.startupTimers.push(announceTimer);
  }

  send() {
    const packet = makeAnnouncePacket({
      id: this.deviceId,
      name: this.deviceName,
      type: 0x01,
      ip: this.interfaceAddress,
      mac: this.interfaceMac
    });

    this.sendRaw(packet);
    this.sent += 1;
  }

  sendRaw(packet) {
    this.socket.setBroadcast(true);
    this.socket.send(packet, PORTS.announce, '255.255.255.255');
    for (const device of this.getDevices()) {
      if (device.ip) this.socket.send(packet, PORTS.announce, device.ip);
    }
  }
}

function makeStartupPackets(device) {
  const packets = [];

  for (let counter = 1; counter <= 3; counter += 1) {
    packets.push(makeHelloPacket(device));
  }

  for (let counter = 1; counter <= 3; counter += 1) {
    packets.push(makeClaimStage1Packet(device, counter));
  }

  for (let counter = 1; counter <= 3; counter += 1) {
    packets.push(makeClaimStage2Packet(device, counter));
  }

  for (let counter = 1; counter <= 3; counter += 1) {
    packets.push(makeClaimStage3Packet(device, counter));
  }

  return packets;
}

function makeHelloPacket(device) {
  const packet = Buffer.from(HELLO_TEMPLATE);
  writeName(packet, 0x0c, 20, device.name);
  return packet;
}

function makeClaimStage1Packet(device, counter) {
  const packet = Buffer.from(CLAIM_STAGE_1_TEMPLATE);
  writeName(packet, 0x0c, 20, device.name);
  macToBuffer(device.mac).copy(packet, 0x26);
  packet[0x24] = counter;
  return packet;
}

function makeClaimStage2Packet(device, counter) {
  const packet = Buffer.from(CLAIM_STAGE_2_TEMPLATE);
  writeName(packet, 0x0c, 20, device.name);
  ipToBuffer(device.ip).copy(packet, 0x24);
  macToBuffer(device.mac).copy(packet, 0x28);
  packet[0x2e] = device.id;
  packet[0x2f] = counter;
  packet[0x31] = 0x02;
  return packet;
}

function makeClaimStage3Packet(device, counter) {
  const packet = Buffer.from(CLAIM_STAGE_3_TEMPLATE);
  writeName(packet, 0x0c, 20, device.name);
  packet[0x24] = device.id;
  packet[0x25] = counter;
  return packet;
}

function makeAnnouncePacket(device) {
  const packet = Buffer.alloc(0x36);
  PROLINK_HEADER.copy(packet, 0);
  packet[0x0a] = 0x06;
  packet[0x0b] = 0x00;
  writeName(packet, 0x0c, 20, device.name);
  packet[0x20] = 0x01;
  packet[0x21] = 0x02;
  packet.writeUInt16BE(0x0036, 0x22);
  packet[0x24] = device.id;
  packet[0x25] = device.type;
  macToBuffer(device.mac).copy(packet, 0x26);
  ipToBuffer(device.ip).copy(packet, 0x2c);
  Buffer.from([0x01, 0x00, 0x00, 0x00]).copy(packet, 0x30);
  packet[0x34] = device.type;
  packet[0x35] = 0x00;
  return packet;
}

function writeName(packet, offset, length, value) {
  Buffer.from(String(value || '').slice(0, length), 'ascii').copy(packet, offset);
}

function macToBuffer(mac) {
  return Buffer.from(
    String(mac || '00:00:00:00:00:00')
      .split(':')
      .map((item) => Number.parseInt(item, 16) || 0)
  );
}

function ipToBuffer(ip) {
  return Buffer.from(
    String(ip || '0.0.0.0')
      .split('.')
      .map((item) => Number.parseInt(item, 10) || 0)
  );
}

module.exports = {
  VirtualCdjProbe,
  makeAnnouncePacket,
  makeStartupPackets,
  makeHelloPacket,
  makeClaimStage1Packet,
  makeClaimStage2Packet,
  makeClaimStage3Packet
};
