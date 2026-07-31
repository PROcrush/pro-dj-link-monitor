#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {renderLtcPcm, writeWav, msToTimecodeParts, formatTimecode} = require('./ltc-core.cjs');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fps = Number(args.fps || 25);
  const durationMs = Number(args.durationMs || Number(args.seconds || 10) * 1000);
  const startMs = Number(args.startMs || 0);
  const sampleRate = Number(args.sampleRate || 48000);
  const channels = Number(args.channels || 2);
  const amplitude = Number(args.amplitude || 0.55);
  const out = args.out || path.join(__dirname, 'out', `ltc-${fps}fps-${durationMs}ms.wav`);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const pcm = renderLtcPcm({startMs, durationMs, fps, sampleRate, channels, amplitude});
  fs.writeFileSync(out, writeWav({pcm, sampleRate, channels}));
  const start = formatTimecode(msToTimecodeParts(startMs, fps));
  const end = formatTimecode(msToTimecodeParts(startMs + durationMs, fps));
  console.log(JSON.stringify({out, fps, sampleRate, channels, durationMs, start, end, bytes: fs.statSync(out).size}, null, 2));
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
