'use strict';

const {execFile} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveMacAudioHelperPath} = require('./macAudioHelperPath.cjs');
const {resolveWindowsAudioHelperPath} = require('./windowsAudioHelperPath.cjs');

const MAC_AUDIO_HELPER = resolveMacAudioHelperPath(__dirname);
const WINDOWS_AUDIO_HELPER = resolveWindowsAudioHelperPath(__dirname);
const SWIFT_CACHE = path.join(os.tmpdir(), 'prodjlink-swift-cache');

const VIRTUAL_AUDIO_NAME_PATTERNS = [
  /pro dj link/i,
  /prodjlink/i,
  /blackhole/i,
  /loopback/i,
  /soundflower/i,
  /vb-cable/i,
  /vb-audio/i,
  /voicemeeter/i,
  /virtual audio cable/i,
  /hifi cable/i,
  /virtual audio/i,
  /virtual/i
];

const ARENA_INCOMPATIBLE_NAME_PATTERNS = [
  // This camera companion device exposes a bidirectional virtual endpoint, but
  // Arena 7.16 repeatedly hung on startup when selected as the audio input.
  /emeet virtual audio/i
];

function listAudioDevices() {
  if (process.platform === 'win32') return listWindowsAudioDevices();
  if (process.platform !== 'darwin') {
    return Promise.resolve([]);
  }
  return listMacAudioDevices();
}

function listMacAudioDevices() {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        const devices = parseSystemProfilerAudio(JSON.parse(stdout || '{}'));
        if (devices.length > 0) {
          resolve(devices);
          return;
        }
        listMacAudioDevicesViaSwift().then(resolve, reject);
      } catch (parseError) {
        listMacAudioDevicesViaSwift().then(resolve, () => {
          reject(new Error(`Audio device parse failed: ${parseError.message}`));
        });
      }
    });
  });
}

function listMacAudioDevicesViaSwift() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/swift', [MAC_AUDIO_HELPER, 'list'], {
      env: {...process.env, CLANG_MODULE_CACHE_PATH: SWIFT_CACHE},
      timeout: 12_000,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(parseSwiftMacAudioDevices(JSON.parse(stdout || '[]')));
      } catch (parseError) {
        reject(new Error(`Swift audio device parse failed: ${parseError.message}`));
      }
    });
  });
}

function listWindowsAudioDevices() {
  return Promise.all([
    listWindowsPnpAudioDevices(),
    listWindowsWasapiRenderEndpoints().catch(() => [])
  ]).then(([devices, renderEndpoints]) => attachWindowsWasapiEndpoints(devices, renderEndpoints));
}

function listWindowsPnpAudioDevices() {
  const script = [
    '$devices = Get-CimInstance Win32_PnPEntity |',
    'Where-Object { $_.PNPClass -eq "AudioEndpoint" -or $_.PNPClass -eq "MEDIA" } |',
    'Select-Object Name, PNPClass, Manufacturer, Status, DeviceID, Service;',
    '$devices | ConvertTo-Json -Depth 3'
  ].join(' ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 7000,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(parseWindowsAudioDevices(JSON.parse(stdout || '[]')));
      } catch (parseError) {
        reject(new Error(`Windows audio device parse failed: ${parseError.message}`));
      }
    });
  });
}

function listWindowsWasapiRenderEndpoints() {
  if (!fs.existsSync(WINDOWS_AUDIO_HELPER)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(WINDOWS_AUDIO_HELPER, ['--list-devices'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(parseWindowsWasapiEndpoints(JSON.parse(stdout || '{}')));
      } catch (parseError) {
        reject(new Error(`WASAPI endpoint parse failed: ${parseError.message}`));
      }
    });
  });
}

function parseSystemProfilerAudio(payload = {}) {
  const roots = Array.isArray(payload.SPAudioDataType) ? payload.SPAudioDataType : [];
  const devices = [];
  for (const root of roots) collectAudioItems(root, devices);
  return devices.map((item) => normalizeAudioDevice(item));
}

function parseWindowsAudioDevices(payload = []) {
  const rows = normalizeArray(payload)
    .map((item) => normalizeWindowsAudioRow(item))
    .filter((item) => item.name);
  const groups = new Map();
  const passthrough = [];

  for (const row of rows) {
    const family = inferWindowsVirtualFamily(row.name);
    if (!family) {
      passthrough.push(row);
      continue;
    }
    if (!groups.has(family)) {
      groups.set(family, {
        name: family,
        manufacturer: row.manufacturer,
        inputChannels: 0,
        outputChannels: 0,
        sampleRate: 0,
        transport: 'windows_virtual_audio',
        platform: 'win32',
        defaultInput: false,
        defaultOutput: false,
        defaultSystemOutput: false,
        status: row.status,
        endpoints: []
      });
    }
    const group = groups.get(family);
    group.endpoints.push(row);
    if (row.inputChannels > 0) {
      group.inputChannels = Math.max(group.inputChannels, row.inputChannels);
      group.recordingEndpoint = group.recordingEndpoint || row;
    }
    if (row.outputChannels > 0) {
      group.outputChannels = Math.max(group.outputChannels, row.outputChannels);
      group.playbackEndpoint = group.playbackEndpoint || row;
    }
    if (!group.manufacturer && row.manufacturer) group.manufacturer = row.manufacturer;
  }

  return [...groups.values(), ...passthrough];
}

function parseWindowsWasapiEndpoints(payload = {}) {
  const rows = normalizeArray(payload.devices || payload);
  return rows.map((item) => ({
    endpointId: String(item.endpointId || item.id || ''),
    name: String(item.name || item.friendlyName || ''),
    dataFlow: String(item.dataFlow || 'render').toLowerCase(),
    state: String(item.state || ''),
    default: Boolean(item.default)
  })).filter((item) => item.endpointId && item.name && item.dataFlow === 'render' && (!item.state || item.state.toLowerCase() === 'active'));
}

function attachWindowsWasapiEndpoints(devices = [], endpoints = []) {
  return devices.map((device) => {
    if (device.platform !== 'win32' || !device.playbackEndpoint) return device;
    const endpoint = findWindowsWasapiEndpoint(endpoints, device.playbackEndpoint.name);
    if (!endpoint) return device;
    return {
      ...device,
      playbackEndpoint: {
        ...device.playbackEndpoint,
        endpointId: endpoint.endpointId,
        dataFlow: endpoint.dataFlow,
        state: endpoint.state || device.playbackEndpoint.status,
        default: endpoint.default
      }
    };
  });
}

function findWindowsWasapiEndpoint(endpoints = [], name = '') {
  const normalized = normalizeWindowsEndpointName(name);
  if (!normalized) return null;
  const matches = endpoints.filter((endpoint) => normalizeWindowsEndpointName(endpoint.name) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

function parseSwiftMacAudioDevices(payload = []) {
  return normalizeArray(payload).map((item) => ({
    name: String(item.name || ''),
    uid: String(item.uid || ''),
    manufacturer: '',
    inputChannels: Number(item.inputChannels || 0),
    outputChannels: Number(item.outputChannels || 0),
    sampleRate: 0,
    transport: inferMacAudioTransport(item),
    defaultInput: Boolean(item.defaultInput),
    defaultOutput: Boolean(item.defaultOutput),
    defaultSystemOutput: Boolean(item.defaultSystemOutput)
  })).filter((device) => device.name);
}

function summarizeVirtualAudio(devices = [], options = {}) {
  const platform = inferVirtualAudioPlatform(devices);
  const installedDrivers = options.installedDrivers || detectInstalledVirtualAudioDrivers(platform);
  const candidates = devices.filter((device) => device.inputChannels > 0 && device.outputChannels > 0 && (
    device.transport === 'coreaudio_device_type_virtual' ||
    (device.transport === 'coreaudio_device_type_aggregate' && /pro dj link|prodjlink|blackhole|loopback|virtual/i.test(device.name)) ||
    device.transport === 'windows_virtual_audio' ||
    VIRTUAL_AUDIO_NAME_PATTERNS.some((pattern) => pattern.test(device.name))
  ));
  const incompatible = candidates.filter((device) => isArenaIncompatibleVirtualAudio(device));
  const compatibleCandidates = candidates.filter((device) => !isArenaIncompatibleVirtualAudio(device));
  const preferred = compatibleCandidates.find((device) => /blackhole/i.test(device.name)) ||
    compatibleCandidates.find((device) => /pro dj link|prodjlink/i.test(device.name)) ||
    compatibleCandidates.find((device) => /vb-cable|vb-audio/i.test(device.name)) ||
    compatibleCandidates.find((device) => /virtual audio cable/i.test(device.name)) ||
    compatibleCandidates.find((device) => /voicemeeter/i.test(device.name)) ||
    compatibleCandidates.find((device) => /loopback/i.test(device.name)) ||
    compatibleCandidates[0] ||
    null;
  const result = {
    ok: Boolean(preferred),
    preferred,
    candidates,
    compatibleCandidates,
    incompatible,
    all: devices,
    installedDrivers,
    recommendation: getVirtualAudioRecommendation(platform)
  };
  result.preflight = buildVirtualAudioPreflight(result, platform);
  return result;
}

function detectInstalledVirtualAudioDrivers(platform = process.platform) {
  if (platform !== 'darwin') return [];
  return [
    {
      name: 'BlackHole 2ch',
      path: '/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver',
      type: 'coreaudio_hal'
    }
  ].filter((driver) => {
    try {
      return fs.existsSync(driver.path);
    } catch (_error) {
      return false;
    }
  });
}

function inferVirtualAudioPlatform(devices = [], fallback = process.platform) {
  const platforms = devices.map((device) => device.platform).filter(Boolean);
  if (platforms.includes('win32')) return 'win32';
  if (platforms.includes('darwin')) return 'darwin';
  return fallback;
}

function buildVirtualAudioPreflight(summary = {}, platform = process.platform) {
  const recommendation = summary.recommendation || getVirtualAudioRecommendation(platform);
  const preferred = summary.preferred || null;
  if (preferred) {
    if (platform === 'win32') {
      const playback = preferred.playbackEndpoint?.name || preferred.name;
      const recording = preferred.recordingEndpoint?.name || preferred.name;
      const endpointId = preferred.playbackEndpoint?.endpointId || '';
      if (endpointId) {
        return {
          ok: true,
          status: 'ready-auto-route',
          platform,
          severity: 'ok',
          headline: `检测到 ${preferred.name} 与 WASAPI 端点`,
          action: `应用会直接输出到 ${playback}；Arena Audio Input Device 设为 ${recording}`,
          canAutoRoute: true,
          requiresManualRouting: false,
          blocksLtcDemo: false,
          playbackEndpointId: endpointId,
          playbackEndpointName: playback,
          recordingEndpointName: recording
        };
      }
      return {
        ok: true,
        status: 'ready-manual-route',
        platform,
        severity: 'warning',
        headline: `检测到 ${preferred.name}`,
        action: `Windows 默认播放设备设为 ${playback}，Arena Audio Input Device 设为 ${recording}`,
        canAutoRoute: false,
        requiresManualRouting: true,
        blocksLtcDemo: false,
        playbackEndpointName: playback,
        recordingEndpointName: recording
      };
    }
    if (platform === 'darwin') {
      return {
        ok: true,
        status: 'ready-auto-route',
        platform,
        severity: 'ok',
        headline: `检测到 ${preferred.name}`,
        action: `LTC Demo 会临时把系统输出切到 ${preferred.name}，停止后恢复原输出`,
        canAutoRoute: true,
        requiresManualRouting: false,
        blocksLtcDemo: false,
        playbackEndpointName: preferred.name,
        recordingEndpointName: preferred.name
      };
    }
    return {
      ok: true,
      status: 'ready-manual-route',
      platform,
      severity: 'warning',
      headline: `检测到 ${preferred.name}`,
      action: '请把 LTC 音频输出接到 Arena 的 SMPTE 音频输入',
      canAutoRoute: false,
      requiresManualRouting: true,
      blocksLtcDemo: false,
      playbackEndpointName: preferred.name,
      recordingEndpointName: preferred.name
    };
  }

  const incompatibleNames = (summary.incompatible || []).map((device) => device.name).filter(Boolean);
  if (incompatibleNames.length > 0) {
    return {
      ok: false,
      status: 'incompatible-only',
      platform,
      severity: 'error',
      headline: `检测到不兼容虚拟声卡：${incompatibleNames.join(', ')}`,
      action: `不要给 Arena 使用这些设备；请安装 ${recommendation.label}`,
      canAutoRoute: false,
      requiresManualRouting: false,
      blocksLtcDemo: true,
      recommendation
    };
  }

  const allDevices = Array.isArray(summary.all) ? summary.all : [];
  const installedDrivers = Array.isArray(summary.installedDrivers) ? summary.installedDrivers : [];
  const blackHoleInstalled = installedDrivers.some((driver) => /blackhole/i.test(driver.name));
  if (blackHoleInstalled) {
    return {
      ok: false,
      status: 'driver-installed-enum-empty',
      platform,
      severity: 'warning',
      headline: 'BlackHole 已安装，但当前进程枚举不到音频设备',
      action: '在系统输出和 Arena Audio Input 中选择 BlackHole 2ch 后，用手动路由测试',
      canAutoRoute: false,
      requiresManualRouting: true,
      blocksLtcDemo: true,
      playbackEndpointName: 'BlackHole 2ch',
      recordingEndpointName: 'BlackHole 2ch',
      recommendation
    };
  }
  return {
    ok: false,
    status: allDevices.length > 0 ? 'missing-compatible-route' : 'no-audio-devices-visible',
    platform,
    severity: 'error',
    headline: allDevices.length > 0 ? '未检测到 Arena 可用的双向虚拟声卡' : '系统音频设备枚举为空',
    action: `请安装或启用 ${recommendation.label} 后重新检测`,
    canAutoRoute: false,
    requiresManualRouting: false,
    blocksLtcDemo: true,
    recommendation
  };
}

function isArenaIncompatibleVirtualAudio(device = {}) {
  return ARENA_INCOMPATIBLE_NAME_PATTERNS.some((pattern) => pattern.test(String(device.name || '')));
}

function getVirtualAudioRecommendation(platform = process.platform) {
  if (platform === 'win32') {
    return {
      platform,
      label: 'VB-CABLE',
      downloadUrl: 'https://vb-audio.com/Cable/',
      summary: 'Windows 推荐先用 VB-CABLE；长期方案是基于 Microsoft SysVAD 做专用签名驱动。',
      installerType: 'driver'
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      label: 'BlackHole 2ch',
      downloadUrl: 'https://existential.audio/blackhole',
      summary: 'macOS 推荐 BlackHole 2ch 或已授权的 CoreAudio HAL 回环驱动。',
      installerType: 'driver'
    };
  }
  return {
    platform,
    label: 'Virtual Audio Cable',
    downloadUrl: '',
    summary: '当前平台需要提供系统可见的虚拟输入/输出音频设备。',
    installerType: 'driver'
  };
}

function collectAudioItems(item, devices) {
  if (!item || typeof item !== 'object') return;
  if (typeof item._name === 'string' && (
    Object.prototype.hasOwnProperty.call(item, 'coreaudio_device_input') ||
    Object.prototype.hasOwnProperty.call(item, 'coreaudio_device_output')
  )) {
    devices.push(item);
  }
  for (const child of Object.values(item)) {
    if (Array.isArray(child)) {
      for (const entry of child) collectAudioItems(entry, devices);
    } else if (child && typeof child === 'object') {
      collectAudioItems(child, devices);
    }
  }
}

function normalizeAudioDevice(item) {
  return {
    name: String(item._name || ''),
    manufacturer: String(item.coreaudio_device_manufacturer || ''),
    inputChannels: Number(item.coreaudio_device_input || 0),
    outputChannels: Number(item.coreaudio_device_output || 0),
    sampleRate: Number(item.coreaudio_device_srate || 0),
    transport: String(item.coreaudio_device_transport || ''),
    defaultInput: item.coreaudio_default_audio_input_device === 'spaudio_yes',
    defaultOutput: item.coreaudio_default_audio_output_device === 'spaudio_yes',
    defaultSystemOutput: item.coreaudio_default_audio_system_device === 'spaudio_yes'
  };
}

function inferMacAudioTransport(item = {}) {
  const name = String(item.name || '');
  const uid = String(item.uid || '');
  if (/aggregate/i.test(name) || /aggregate/i.test(uid)) return 'coreaudio_device_type_aggregate';
  if (VIRTUAL_AUDIO_NAME_PATTERNS.some((pattern) => pattern.test(name) || pattern.test(uid))) {
    return 'coreaudio_device_type_virtual';
  }
  return '';
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function normalizeWindowsAudioRow(item = {}) {
  const name = String(item.Name || item.name || '');
  const side = inferWindowsEndpointSide(name);
  return {
    name,
    manufacturer: String(item.Manufacturer || item.manufacturer || ''),
    endpointSide: side,
    inputChannels: side === 'input' ? 2 : 0,
    outputChannels: side === 'output' ? 2 : 0,
    sampleRate: 0,
    transport: 'windows_audio_endpoint',
    platform: 'win32',
    defaultInput: false,
    defaultOutput: false,
    defaultSystemOutput: false,
    status: String(item.Status || item.status || ''),
    pnpClass: String(item.PNPClass || item.pnpClass || ''),
    deviceId: String(item.DeviceID || item.deviceId || ''),
    service: String(item.Service || item.service || '')
  };
}

function inferWindowsEndpointSide(name = '') {
  if (/\b(output|recording|capture|microphone|mic)\b/i.test(name)) return 'input';
  if (/\b(input|playback|speaker|speakers|render)\b/i.test(name)) return 'output';
  return 'unknown';
}

function inferWindowsVirtualFamily(name = '') {
  if (/pro\s*dj\s*link|prodjlink/i.test(name)) return 'PRO DJ LINK LTC Cable';
  if (/voicemeeter.*aux|aux.*voicemeeter/i.test(name)) return 'Voicemeeter AUX';
  if (/voicemeeter.*vaio3|vaio3.*voicemeeter/i.test(name)) return 'Voicemeeter VAIO3';
  if (/voicemeeter/i.test(name)) return 'Voicemeeter';
  if (/vb-audio.*hifi|hifi.*vb-audio|hi-fi.*cable/i.test(name)) return 'VB-CABLE Hi-Fi';
  const vbCable = String(name).match(/\bcable(?:[- ]([a-d]))?\s+(?:input|output)\b/i);
  if (vbCable) return vbCable[1] ? `VB-CABLE ${vbCable[1].toUpperCase()}` : 'VB-CABLE';
  if (/vb-audio|vb-cable|cable (input|output)/i.test(name)) return 'VB-CABLE';
  if (/virtual audio cable|\bline \d+\b/i.test(name)) return 'Virtual Audio Cable';
  return null;
}

function normalizeWindowsEndpointName(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports = {
  attachWindowsWasapiEndpoints,
  buildVirtualAudioPreflight,
  detectInstalledVirtualAudioDrivers,
  getVirtualAudioRecommendation,
  isArenaIncompatibleVirtualAudio,
  listAudioDevices,
  parseSystemProfilerAudio,
  parseSwiftMacAudioDevices,
  parseWindowsAudioDevices,
  parseWindowsWasapiEndpoints,
  summarizeVirtualAudio
};
