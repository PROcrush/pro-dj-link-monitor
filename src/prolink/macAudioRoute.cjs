'use strict';

const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {listAudioDevices, summarizeVirtualAudio} = require('./audioDevices.cjs');
const {resolveMacAudioHelperPath} = require('./macAudioHelperPath.cjs');

const SWIFT_HELPER = resolveMacAudioHelperPath(__dirname);
const SWIFT_CACHE = path.join(os.tmpdir(), 'prodjlink-swift-cache');

class TemporaryMacOutputRoute {
  constructor() {
    this.active = false;
    this.targetName = '';
    this.originalOutputName = '';
    this.lastError = null;
  }

  async activate(preferredName = '') {
    if (process.platform !== 'darwin') {
      return this.manualRouteState(preferredName);
    }
    if (this.active) {
      return this.getState();
    }

    const devices = await listAudioDevices();
    const summary = summarizeVirtualAudio(devices);
    const target = findTargetDevice(summary.candidates, preferredName) || summary.preferred;
    if (!target) {
      throw new Error('未检测到可用虚拟声卡输出');
    }

    const original = requireCurrentOutputDevice(devices);
    this.originalOutputName = original.name;
    this.targetName = target.name;

    if (this.originalOutputName !== target.name) {
      await setDefaultOutput(target.name);
    }
    this.active = true;
    this.lastError = null;
    return this.getState();
  }

  async manualRouteState(preferredName = '') {
    try {
      const devices = await listAudioDevices();
      const summary = summarizeVirtualAudio(devices);
      const target = findTargetDevice(summary.compatibleCandidates || summary.candidates, preferredName) || summary.preferred;
      if (process.platform === 'win32' && target) {
        return {
          active: false,
          supported: true,
          manual: true,
          reason: 'windows-default-playback-required',
          targetName: target.name,
          playbackEndpointName: target.playbackEndpoint?.name || target.name,
          recordingEndpointName: target.recordingEndpoint?.name || target.name,
          lastError: null
        };
      }
      return {
        active: false,
        supported: false,
        manual: true,
        reason: 'manual-routing-required',
        targetName: target?.name || '',
        lastError: null
      };
    } catch (error) {
      return {
        active: false,
        supported: false,
        manual: true,
        reason: 'audio-device-detect-failed',
        targetName: '',
        lastError: error.message
      };
    }
  }

  async restore() {
    if (process.platform !== 'darwin') return this.getState();
    if (!this.active) return this.getState();
    const original = this.originalOutputName;
    try {
      if (original) await setDefaultOutput(original);
      this.active = false;
      this.targetName = '';
      this.originalOutputName = '';
      this.lastError = null;
      return this.getState();
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  getState() {
    return {
      active: this.active,
      targetName: this.targetName,
      originalOutputName: this.originalOutputName,
      lastError: this.lastError
    };
  }
}

function findTargetDevice(candidates = [], preferredName = '') {
  const normalized = String(preferredName || '').trim().toLowerCase();
  if (!normalized) return null;
  return candidates.find((device) => String(device.name || '').toLowerCase() === normalized) ||
    candidates.find((device) => String(device.name || '').toLowerCase().includes(normalized)) ||
    null;
}

function requireCurrentOutputDevice(devices = []) {
  const current = devices.find((device) => device.defaultOutput && device.outputChannels > 0) || null;
  if (!current?.name) {
    throw new Error('未检测到当前默认系统输出，已取消自动切换；请改用手动音频路由');
  }
  return current;
}

function setDefaultOutput(deviceName) {
  return runSwiftAudioDevice(['set-default', 'output', deviceName]);
}

function runSwiftAudioDevice(args = []) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/swift', [SWIFT_HELPER, ...args], {
      env: {...process.env, CLANG_MODULE_CACHE_PATH: SWIFT_CACHE},
      timeout: 12_000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

module.exports = {
  TemporaryMacOutputRoute,
  findTargetDevice,
  requireCurrentOutputDevice,
  runSwiftAudioDevice,
  setDefaultOutput
};
