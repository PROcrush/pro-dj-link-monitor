#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {spawn, spawnSync} = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const {
  listAudioDevices,
  summarizeVirtualAudio
} = require('../../src/prolink/audioDevices.cjs');

const ROOT = path.resolve(__dirname, '../..');
const AUDIO_TOOL = path.join(ROOT, 'labs/ltc-audio-timecode/audio-device.swift');
const RENDER_WAV = path.join(ROOT, 'labs/ltc-audio-timecode/render-ltc-wav.cjs');
const CLIP_PATH = '/api/v1/composition/layers/1/clips/1';
const FOG_FILE_URL = 'file:///Applications/Resolume%20Arena/media/Shop74/FogAndDust_3.mov';
const ARENA_CONFIG = path.join(process.env.HOME || '', 'Documents/Resolume Arena/Preferences/config.xml');

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const wavPath = await ensureDemoWav(options);

  const devices = await listAudioDevices();
  const virtualAudio = summarizeVirtualAudio(devices);
  const route = virtualAudio.preferred || manualRouteFromOptions(options);
  const report = {
    platform: process.platform,
    options,
    arenaConfig: readArenaAudioConfig(),
    virtualAudio: summarizeVirtualAudioForReport(virtualAudio),
    audioRoute: null,
    originalAudio: null,
    setup: {},
    samples: [],
    restored: null
  };

  if (!route) {
    report.audioRoute = {
      ok: false,
      reason: 'missing-compatible-virtual-audio',
      recommendation: virtualAudio.recommendation
    };
    console.log(JSON.stringify(analyze(report), null, 2));
    process.exitCode = 2;
    return;
  }

  const audioRoute = await activateAudioRoute(route, options);
  report.audioRoute = audioRoute;
  report.originalAudio = audioRoute.originalAudio || null;

  try {
    await putJson(CLIP_PATH, {transporttype: {value: options.smpteInput}});
    await post(`${CLIP_PATH}/connect`);
    await sleep(300);
    report.setup = summarizeClip(await getJson(CLIP_PATH));

    const playerCommand = buildAudioPlayerCommand(wavPath);
    report.player = {
      label: playerCommand.label,
      command: playerCommand.command,
      args: playerCommand.args
    };
    const player = spawn(playerCommand.command, playerCommand.args, {stdio: 'ignore', windowsHide: true});
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < 12_000) {
        const clip = await getJson(CLIP_PATH);
        report.samples.push({
          atMs: Date.now() - startedAt,
          ...summarizeClip(clip)
        });
        await sleep(500);
      }
    } finally {
      if (!player.killed) player.kill('SIGTERM');
    }
  } finally {
    report.restored = await cleanupAfterTest(audioRoute);
  }

  console.log(JSON.stringify(analyze(report), null, 2));
}

function readOptions(argv = []) {
  const help = argv.includes('--help') || argv.includes('-h');
  const manualRoute = argv.includes('--manual-route') || process.env.PRODJLINK_LTC_MANUAL_ROUTE === '1';
  return {
    help,
    manualRoute,
    manualRouteName: readOptionValue(argv, '--manual-route-name') || process.env.PRODJLINK_LTC_DEVICE_NAME || 'BlackHole 2ch',
    fps: normalizeNumber(readOptionValue(argv, '--fps') || process.env.PRODJLINK_LTC_FPS, 25),
    seconds: normalizeNumber(readOptionValue(argv, '--seconds') || process.env.PRODJLINK_LTC_SECONDS, 20),
    amplitude: normalizeNumber(readOptionValue(argv, '--amplitude') || process.env.PRODJLINK_LTC_AMPLITUDE, 0.55),
    channels: normalizeNumber(readOptionValue(argv, '--channels') || process.env.PRODJLINK_LTC_CHANNELS, 2),
    smpteInput: normalizeSmpteInput(readOptionValue(argv, '--smpte-input') || process.env.PRODJLINK_LTC_SMPTE_INPUT || 'SMPTE 1')
  };
}

function readArenaAudioConfig() {
  try {
    const text = fs.readFileSync(ARENA_CONFIG, 'utf8');
    const deviceSetup = text.match(/<DEVICESETUP\b[^>]*>/i)?.[0] || '';
    return {
      path: ARENA_CONFIG,
      exists: true,
      audioInputDeviceName: readXmlAttr(deviceSetup, 'audioInputDeviceName'),
      audioOutputDeviceName: readXmlAttr(deviceSetup, 'audioOutputDeviceName'),
      audioDeviceInChans: readXmlAttr(deviceSetup, 'audioDeviceInChans'),
      audioDeviceOutChans: readXmlAttr(deviceSetup, 'audioDeviceOutChans'),
      smpte1Input: readXmlParamValue(text, 'SMPTE1 Input'),
      smpte2Input: readXmlParamValue(text, 'SMPTE2 Input')
    };
  } catch (error) {
    return {
      path: ARENA_CONFIG,
      exists: false,
      error: error.message
    };
  }
}

function readXmlAttr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function readXmlParamValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`<Param\\b(?=[^>]*name="${escaped}")[^>]*value="([^"]*)"`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function printUsage() {
  console.log(`Usage:
  node labs/ltc-audio-timecode/try-arena-ltc.cjs
  node labs/ltc-audio-timecode/try-arena-ltc.cjs --fps 30 --amplitude 0.9
  node labs/ltc-audio-timecode/try-arena-ltc.cjs --smpte-input "SMPTE 2"
  node labs/ltc-audio-timecode/try-arena-ltc.cjs --manual-route --manual-route-name "BlackHole 2ch"

--manual-route assumes system audio output and Arena Audio Input Device have
already been set to the named virtual audio device. It is useful when macOS GUI
shows BlackHole but the current CLI environment cannot enumerate CoreAudio
devices.`);
}

function readOptionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `${name}=`;
  const entry = argv.find((item) => item.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSmpteInput(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalized === 'SMPTE 2' || normalized === 'SMPTE2' || normalized === '2') return 'SMPTE 2';
  return 'SMPTE 1';
}

function manualRouteFromOptions(options) {
  if (!options.manualRoute) return null;
  return {
    name: options.manualRouteName,
    platform: process.platform,
    inputChannels: 2,
    outputChannels: 2,
    transport: 'manual_virtual_audio_route',
    manualRoute: true
  };
}

async function ensureDemoWav(options = {}) {
  const wavPath = buildWavPath(options);
  if (fs.existsSync(wavPath)) return wavPath;
  const result = spawnSync(process.execPath, [
    RENDER_WAV,
    '--fps', String(options.fps || 25),
    '--seconds', String(options.seconds || 20),
    '--amplitude', String(options.amplitude || 0.55),
    '--channels', String(options.channels || 2),
    '--out', wavPath
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to render demo LTC WAV');
  }
  return wavPath;
}

function buildWavPath(options = {}) {
  const fps = String(options.fps || 25).replace(/[^0-9.]/g, '');
  const seconds = String(options.seconds || 20).replace(/[^0-9.]/g, '');
  const amplitude = String(options.amplitude || 0.55).replace(/[^0-9.]/g, '');
  const channels = String(options.channels || 2).replace(/[^0-9]/g, '');
  return path.join(ROOT, 'labs/ltc-audio-timecode/out', `ltc-${fps}fps-${seconds}s-a${amplitude}-ch${channels}.wav`);
}

async function activateAudioRoute(route, options = {}) {
  const routeInfo = summarizeDevice(route);
  if (route.manualRoute || options.manualRoute) {
    return {
      ok: true,
      routed: true,
      manual: true,
      platform: process.platform,
      route: routeInfo,
      reason: 'manual-route-assumed',
      instruction: `${route.name} 已由 GUI/系统设置路由；脚本只负责 Arena SMPTE 和 LTC 播放采样。`
    };
  }
  if (process.platform === 'darwin') {
    const originalAudio = await audioDefaults();
    const setAudio = [];
    setAudio.push(runAudioTool(['set-default', 'output', route.name]));
    return {
      ok: true,
      routed: true,
      platform: process.platform,
      route: routeInfo,
      originalAudio,
      setAudio
    };
  }

  if (process.platform === 'win32') {
    return {
      ok: true,
      routed: false,
      platform: process.platform,
      route: routeInfo,
      reason: 'windows-manual-routing-required',
      instruction: windowsRouteInstruction(route)
    };
  }

  return {
    ok: true,
    routed: false,
    platform: process.platform,
    route: routeInfo,
    reason: 'manual-routing-required'
  };
}

async function restoreAudioRoute(audioRoute) {
  if (!audioRoute || process.platform !== 'darwin') return;
  if (audioRoute.manual) return;
  restoreMacAudio(audioRoute.originalAudio);
}

function restoreMacAudio(original) {
  if (!original) return;
  if (original.defaultOutput) runAudioTool(['set-default', 'output', original.defaultOutput.name]);
  if (original.defaultSystemOutput) runAudioTool(['set-default', 'system-output', original.defaultSystemOutput.name]);
}

async function cleanupAfterTest(audioRoute) {
  const restored = {
    audio: null,
    audioRestoreError: null,
    arenaClip: null,
    arenaRestoreError: null
  };
  try {
    await restoreAudioRoute(audioRoute);
  } catch (error) {
    restored.audioRestoreError = error.message;
  }
  await sleep(150);
  restored.audio = await safeAudioDefaults();
  try {
    await restoreArenaClip();
    restored.arenaClip = summarizeClip(await getJson(CLIP_PATH));
  } catch (error) {
    restored.arenaRestoreError = error.message;
  }
  return restored;
}

async function safeAudioDefaults() {
  if (process.platform !== 'darwin') return null;
  try {
    return await audioDefaults();
  } catch (error) {
    return {error: error.message};
  }
}

async function audioDefaults() {
  const list = JSON.parse(runAudioTool(['list']));
  return {
    defaultInput: list.find((item) => item.defaultInput) || null,
    defaultOutput: list.find((item) => item.defaultOutput) || null,
    defaultSystemOutput: list.find((item) => item.defaultSystemOutput) || null
  };
}

function runAudioTool(args) {
  const result = spawnSync('/usr/bin/env', [
    'CLANG_MODULE_CACHE_PATH=/private/tmp/prodjlink-swift-cache',
    '/usr/bin/swift',
    AUDIO_TOOL,
    ...args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `audio tool failed: ${args.join(' ')}`);
  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf('[');
  if (args[0] === 'list' && jsonStart >= 0) return stdout.slice(jsonStart);
  return stdout.split('\n').pop().trim();
}

async function restoreArenaClip() {
  try {
    await post(`${CLIP_PATH}/clear`);
  } catch {}
  await postText(`${CLIP_PATH}/open`, FOG_FILE_URL);
  await putJson(CLIP_PATH, {
    name: {value: 'FogAndDust'},
    transporttype: {value: 'Timeline'},
    transport: {position: {value: 0}}
  });
}

function analyze(report) {
  const positions = report.samples.map((sample) => Number(sample.position || 0)).filter(Number.isFinite);
  const min = positions.length ? Math.min(...positions) : 0;
  const max = positions.length ? Math.max(...positions) : 0;
  const movementMs = max - min;
  const canEvaluate = Boolean(report.audioRoute?.routed || process.platform === 'win32');
  const routeName = report.audioRoute?.route?.name || report.options?.manualRouteName || '';
  const arenaInputMatches = !routeName || deviceNameMatches(report.arenaConfig?.audioInputDeviceName, routeName);
  return {
    ...report,
    verdict: {
      sampleCount: report.samples.length,
      movementMs,
      likelyLockedToLtc: movementMs > 1500,
      arenaInputMatches,
      note: verdictNote({movementMs, canEvaluate, audioRoute: report.audioRoute, arenaInputMatches, routeName, arenaConfig: report.arenaConfig})
    }
  };
}

function verdictNote({movementMs, canEvaluate, audioRoute, arenaInputMatches, routeName, arenaConfig}) {
  if (!audioRoute?.ok) return 'No compatible virtual audio route was available, so Arena LTC was not modified.';
  if (audioRoute.reason === 'manual-route-assumed' && !arenaInputMatches) {
    return `Manual audio route was assumed, but Arena config audio input is "${arenaConfig?.audioInputDeviceName || 'unknown'}", not "${routeName}".`;
  }
  if (movementMs > 1500) return 'Arena clip position moved while LTC WAV was playing.';
  if (audioRoute.reason === 'manual-route-assumed') {
    return 'Manual audio route was assumed. If movement is still zero, confirm system output and Arena audio input are both set to the virtual audio device.';
  }
  if (!canEvaluate) return 'LTC audio was generated, but this platform requires manual audio routing before the result can be evaluated.';
  if (audioRoute.reason === 'windows-manual-routing-required') {
    return 'Windows route was detected. Confirm Windows playback/default output is the virtual cable playback endpoint and Arena input is the paired recording endpoint.';
  }
  return 'Arena clip position did not show enough movement; audio routing or SMPTE input selection is probably not receiving the LTC signal.';
}

function deviceNameMatches(actual, expected) {
  const normalizedActual = normalizeDeviceName(actual);
  const normalizedExpected = normalizeDeviceName(expected);
  if (!normalizedExpected) return true;
  return normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual);
}

function normalizeDeviceName(value) {
  return String(value || '').trim().toLowerCase().replace(/[“”"]/g, '');
}

function summarizeVirtualAudioForReport(summary) {
  return {
    ok: summary.ok,
    preferred: summarizeDevice(summary.preferred),
    candidates: summary.candidates.map(summarizeDevice),
    compatibleCandidates: summary.compatibleCandidates.map(summarizeDevice),
    incompatible: summary.incompatible.map(summarizeDevice),
    installedDrivers: summary.installedDrivers || [],
    recommendation: summary.recommendation,
    preflight: summary.preflight || null
  };
}

function summarizeDevice(device) {
  if (!device) return null;
  return {
    name: device.name,
    platform: device.platform || process.platform,
    inputChannels: device.inputChannels,
    outputChannels: device.outputChannels,
    transport: device.transport,
    manualRoute: Boolean(device.manualRoute),
    playbackEndpoint: device.playbackEndpoint ? summarizeEndpoint(device.playbackEndpoint) : null,
    recordingEndpoint: device.recordingEndpoint ? summarizeEndpoint(device.recordingEndpoint) : null
  };
}

function summarizeEndpoint(endpoint) {
  return {
    name: endpoint.name,
    inputChannels: endpoint.inputChannels,
    outputChannels: endpoint.outputChannels,
    status: endpoint.status
  };
}

function windowsRouteInstruction(route) {
  const playback = route.playbackEndpoint?.name || route.name;
  const recording = route.recordingEndpoint?.name || route.name;
  return [
    `Windows 默认播放设备设为：${playback}`,
    `Resolume Arena Preferences > Audio > Audio Input Device 设为：${recording}`,
    'Clip transport 设为 SMPTE 1 后再运行此脚本。'
  ].join(' ');
}

function buildAudioPlayerCommand(filePath) {
  if (process.platform === 'darwin') {
    return {label: 'afplay', command: '/usr/bin/afplay', args: [filePath]};
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$player = New-Object System.Media.SoundPlayer;',
      `$player.SoundLocation = ${JSON.stringify(filePath)};`,
      '$player.Load();',
      '$player.PlaySync();'
    ].join(' ');
    return {
      label: 'PowerShell SoundPlayer',
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]
    };
  }
  return {label: 'aplay', command: 'aplay', args: [filePath]};
}

function summarizeClip(clip) {
  return {
    name: readParam(clip.name),
    connected: readParam(clip.connected),
    transporttype: readParam(clip.transporttype),
    position: readParam(clip.transport?.position),
    duration: clip.transport?.position?.max || null,
    playdirection: readParam(clip.transport?.controls?.playdirection),
    file: clip.video?.fileinfo?.path || null
  };
}

function getJson(requestPath) {
  return request('GET', requestPath).then((body) => JSON.parse(body || '{}'));
}

function putJson(requestPath, body) {
  return request('PUT', requestPath, JSON.stringify(body), 'application/json');
}

function post(requestPath) {
  return request('POST', requestPath);
}

function postText(requestPath, body) {
  return request('POST', requestPath, body, 'text/plain');
}

function request(method, requestPath, body = null, contentType = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : String(body);
    const req = http.request({
      host: '127.0.0.1',
      port: 8080,
      path: requestPath,
      method,
      timeout: 1500,
      headers: payload ? {
        'Content-Type': contentType || 'text/plain',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${requestPath} -> ${res.statusCode} ${text.slice(0, 180)}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readParam(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
