#!/usr/bin/env node
'use strict';

const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORTS = [50001, 50002];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seconds = Number(args.seconds || args.s || 30);
  const ports = String(args.ports || DEFAULT_PORTS.join(','))
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  const out = args.out || defaultCapturePath();
  fs.mkdirSync(path.dirname(out), {recursive: true});

  const stream = fs.createWriteStream(out, {flags: 'a'});
  const sockets = [];
  const counts = new Map();
  let closed = false;

  for (const port of ports) {
    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    socket.on('message', (message, remote) => {
      counts.set(port, (counts.get(port) || 0) + 1);
      stream.write(JSON.stringify({
        receivedAt: new Date().toISOString(),
        receivedAtMs: Date.now(),
        localPort: port,
        source: remote.address,
        sourcePort: remote.port,
        length: message.length,
        hex: message.toString('hex')
      }) + '\n');
    });
    socket.on('error', (error) => {
      console.error(`[record] UDP ${port} error: ${error.message}`);
    });
    socket.bind({port, address: '0.0.0.0', exclusive: false}, () => {
      console.log(`[record] listening UDP ${port}`);
    });
    sockets.push(socket);
  }

  const timer = Number.isFinite(seconds) && seconds > 0
    ? setTimeout(() => finish(0), seconds * 1000)
    : null;

  process.on('SIGINT', () => finish(130));
  process.on('SIGTERM', () => finish(143));

  function finish(code) {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    for (const socket of sockets) socket.close();
    stream.end(() => {
      const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
      const byPort = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]).map(([port, count]) => `${port}:${count}`).join(', ');
      console.log(`[record] wrote ${total} packets to ${out}${byPort ? ` (${byPort})` : ''}`);
      process.exit(code);
    });
  }
}

function defaultCapturePath() {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  return path.join(__dirname, 'captures', `prolink-${stamp}.jsonl`);
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

main();
