'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {renderLtcPcm, writeWav, formatTimecode, msToTimecodeParts} = require('./ltcAudio.cjs');
const {TemporaryMacOutputRoute} = require('./macAudioRoute.cjs');
const {WindowsWasapiLtcSink} = require('./windowsWasapiLtcSink.cjs');

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_SEGMENT_SECONDS = 60;
const SEGMENT_REFRESH_MARGIN_MS = 10_000;
const MIN_RESTART_INTERVAL_MS = 1200;

class LtcDemoOutput {
  constructor(dependencies = {}) {
    this.platform = dependencies.platform || process.platform;
    this.options = {};
    this.player = null;
    this.pendingSegment = false;
    this.pendingArenaConfig = false;
    this.lastRestartAt = 0;
    this.lastArenaConfigAt = 0;
    this.cleanupQueue = [];
    this.audioRoute = dependencies.audioRoute || new TemporaryMacOutputRoute();
    this.windowsSink = dependencies.windowsSink || new WindowsWasapiLtcSink({platform: this.platform});
    this.windowsSinkActive = false;
    this.windowsStartError = null;
    this.generation = 0;
    this.pendingSegmentTasks = new Set();
    this.stopping = false;
    this.stopPromise = null;
    this.state = emptyState();
  }

  start(options = {}) {
    if (this.stopPromise) throw new Error('LTC output is still stopping');
    this.stopping = false;
    const generation = this.nextGeneration();
    this.cancelPlayback();
    this.pendingSegment = false;
    this.pendingArenaConfig = false;
    this.cleanupQueue.splice(0);
    this.lastRestartAt = 0;
    this.options = {
      enabled: Boolean(options.enabled),
      fps: normalizeFps(options.fps),
      sampleRate: Number(options.sampleRate || DEFAULT_SAMPLE_RATE),
      segmentSeconds: clampInteger(options.segmentSeconds, 5, 600, DEFAULT_SEGMENT_SECONDS),
      amplitude: clampNumber(options.amplitude, 0.1, 1, 0.55),
      channels: clampInteger(options.channels, 1, 2, 2),
      tempDir: options.tempDir || path.join(os.tmpdir(), 'prodjlink-ltc-demo'),
      configureArena: options.configureArena !== false,
      arenaApiHost: options.arenaApiHost || '127.0.0.1',
      arenaApiPort: clampInteger(options.arenaApiPort, 1, 65535, 8080),
      arenaLayer: clampInteger(options.arenaLayer, 1, 999, 1),
      arenaClip: clampInteger(options.arenaClip, 1, 999, 1),
      arenaSmpteInput: normalizeSmpteInput(options.arenaSmpteInput),
      routeAudioToVirtual: options.routeAudioToVirtual !== false,
      virtualAudioDeviceName: String(options.virtualAudioDeviceName || ''),
      virtualAudioEndpointId: String(options.virtualAudioEndpointId || ''),
      timecodeOffsetMs: clampInteger(options.timecodeOffsetMs, -3_600_000, 3_600_000, 0),
      outputLayer: String(options.outputLayer || 'M').trim() || 'M',
      sourceMode: normalizeSourceMode(options.sourceMode)
    };
    this.state = {
      ...emptyState(),
      enabled: this.options.enabled,
      mode: this.options.enabled ? 'audio-ltc-demo' : null,
      fps: this.options.fps,
      arenaTarget: {
        layer: this.options.arenaLayer,
        clip: this.options.arenaClip,
        smpteInput: this.options.arenaSmpteInput
      },
      outputLayer: this.options.outputLayer,
      sourceMode: this.options.sourceMode,
      timecodeOffsetMs: this.options.timecodeOffsetMs
    };
    this.windowsSinkActive = false;
    this.windowsStartError = null;
    if (this.options.enabled && this.isWindowsAutoRoute()) {
      try {
        if (!this.options.virtualAudioEndpointId) throw new Error('未选择可用的 WASAPI 播放端点');
        this.windowsSink.start({
          endpointId: this.options.virtualAudioEndpointId,
          endpointName: this.options.virtualAudioDeviceName,
          fps: this.options.fps,
          sampleRate: this.options.sampleRate,
          channels: this.options.channels,
          amplitude: this.options.amplitude,
          generation
        });
        this.windowsSinkActive = true;
        this.state.mode = 'audio-ltc-wasapi';
        this.state.audioRoute = this.windowsAudioRouteState();
      } catch (error) {
        this.state.mode = 'audio-ltc-wasapi';
        this.windowsStartError = error;
        this.state.lastError = `Windows WASAPI: ${error.message}`;
      }
    }
  }

  async waitUntilReady() {
    if (!this.options.enabled || !this.isWindowsAutoRoute()) return this.getState();
    if (this.windowsStartError) throw this.windowsStartError;
    if (!this.windowsSinkActive) throw new Error('Windows WASAPI helper 未启动');
    if (typeof this.windowsSink.waitUntilStarted === 'function') {
      await this.windowsSink.waitUntilStarted(this.generation);
    }
    const sink = this.windowsSink.getState();
    if (!sink.ready) throw new Error(sink.lastError || 'Windows WASAPI helper 未就绪');
    this.state.audioRoute = this.windowsAudioRouteState(sink);
    if (this.state.lastError?.startsWith('Windows WASAPI:')) this.state.lastError = null;
    return this.getState();
  }

  async stop(options = {}) {
    if (this.stopPromise) return this.stopPromise;
    const generation = this.nextGeneration();
    const restoreAudio = options.restoreAudio !== false;
    this.stopping = true;
    this.options = {...this.options, enabled: false};
    this.state = {...this.state, enabled: false, mode: null, playing: false};
    this.cancelPlayback();
    this.pendingSegment = false;
    this.pendingArenaConfig = false;
    this.cleanupQueue.splice(0);
    const stopPromise = this.finishStop({generation, restoreAudio});
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
      this.stopping = false;
    }
  }

  async finishStop({generation, restoreAudio}) {
    await Promise.allSettled(Array.from(this.pendingSegmentTasks));
    if (this.isWindowsAutoRoute()) await this.windowsSink.stop();
    if (restoreAudio && !this.isWindowsAutoRoute()) await this.restoreAudioRoute(generation);
    this.windowsSinkActive = false;
    this.state = emptyState();
  }

  getState() {
    if (!this.isWindowsAutoRoute()) {
      return {...this.state, playing: Boolean(this.player && !this.player.killed)};
    }
    const sink = this.windowsSink.getState();
    return {
      ...this.state,
      playing: Boolean(sink.playing),
      audioRoute: this.windowsAudioRouteState(sink),
      windowsAudioHelper: sink,
      lastError: sink.lastError ? `Windows WASAPI: ${sink.lastError}` : this.state.lastError
    };
  }

  hold(fields = {}) {
    const generation = this.nextGeneration();
    this.cancelPlayback();
    if (this.isWindowsAutoRoute()) this.windowsSink.hold(generation);
    this.pendingSegment = false;
    this.state = {
      ...this.state,
      ...fields,
      enabled: Boolean(this.options.enabled),
      mode: this.options.enabled ? (this.isWindowsAutoRoute() ? 'audio-ltc-wasapi' : 'audio-ltc-demo') : null,
      outputLayer: this.options.outputLayer || this.state.outputLayer || 'M',
      sourceMode: this.options.sourceMode || this.state.sourceMode || 'auto',
      timecodeOffsetMs: this.options.timecodeOffsetMs || 0,
      wavPath: '',
      segmentStartMs: null,
      segmentStartedAtMs: null,
      segmentExpiresAtMs: null,
      segmentSeconds: null,
      lastError: null
    };
    return this.getState();
  }

  update(timing = {}, source = {}) {
    if (this.stopping || !this.options.enabled) return this.getState();
    if (timing.elapsedMs === null || timing.elapsedMs === undefined || timing.elapsedMs === '') {
      this.hold({
        sourceDeck: Number(timing.deck || source.deck || 0) || null,
        sourceKey: source.trackKey || timing.trackKey || '',
        timecode: null,
        bpm: timing.bpm || null,
        beatInMeasure: timing.beatInMeasure || null,
        lastSeenAt: new Date().toISOString()
      });
      this.state.lastError = 'LTC Demo: 等待有效 Deck 时间';
      return this.getState();
    }
    const elapsedMs = Number(timing.elapsedMs);
    if (!Number.isFinite(elapsedMs)) {
      this.state.lastError = 'LTC Demo: 等待有效 Deck 时间';
      return this.getState();
    }

    const now = Date.now();
    const sourceKey = [
      Number(timing.deck || source.deck || 0),
      source.trackKey || timing.trackKey || '',
      source.trackId || timing.trackId || ''
    ].join(':');
    if (this.state.sourceKey && this.state.sourceKey !== sourceKey) {
      this.nextGeneration();
      this.cancelPlayback();
      this.pendingSegment = false;
    }
    const startMs = Math.max(0, elapsedMs + this.options.timecodeOffsetMs);
    const timecode = formatTimecode(msToTimecodeParts(startMs, this.options.fps));
    this.state = {
      ...this.state,
      enabled: true,
      mode: this.isWindowsAutoRoute() ? 'audio-ltc-wasapi' : 'audio-ltc-demo',
      fps: this.options.fps,
      sourceDeck: Number(timing.deck || source.deck || 0) || null,
      sourceKey,
      timecode,
      bpm: timing.bpm || null,
      beatInMeasure: timing.beatInMeasure || null,
      outputLayer: this.options.outputLayer,
      sourceMode: this.options.sourceMode,
      timecodeOffsetMs: this.options.timecodeOffsetMs,
      lastSeenAt: new Date(now).toISOString()
    };

    const generation = this.generation;
    const windowsReady = !this.isWindowsAutoRoute() || Boolean(this.windowsSink.getState().ready);
    if (windowsReady) this.configureArenaIfNeeded(now, generation);
    if (this.isWindowsAutoRoute()) {
      if (this.windowsSinkActive) {
        this.windowsSink.sync({
          elapsedMs: startMs,
          rate: normalizePlaybackRate(source.playbackRate ?? source.rate),
          sourceKey,
          generation
        });
        this.state.audioRoute = this.windowsAudioRouteState();
        this.state.lastError = null;
      }
      return this.getState();
    }
    const needsSegment = this.needsSegment(sourceKey, startMs, now);
    if (needsSegment) {
      const task = Promise.resolve(this.writeAndPlaySegment({sourceKey, startMs, generation})).catch((error) => {
        if (this.isCurrentGeneration(generation)) this.state.lastError = `LTC Demo: ${error.message}`;
      });
      this.pendingSegmentTasks.add(task);
      task.finally(() => this.pendingSegmentTasks.delete(task));
    }
    return this.getState();
  }

  needsSegment(sourceKey, startMs, now) {
    if (this.pendingSegment) return false;
    if (now - this.lastRestartAt < MIN_RESTART_INTERVAL_MS) return false;
    if (!this.player || this.player.killed) return true;
    if (this.state.sourceKey && this.state.sourceKey !== sourceKey) return true;
    if (!this.state.segmentExpiresAtMs || now > this.state.segmentExpiresAtMs - SEGMENT_REFRESH_MARGIN_MS) return true;
    const expectedStart = Number(this.state.segmentStartMs || 0) + Math.max(0, now - Number(this.state.segmentStartedAtMs || now));
    return Math.abs(expectedStart - startMs) > 2500;
  }

  async writeAndPlaySegment({sourceKey, startMs, generation}) {
    if (!this.isCurrentGeneration(generation)) return;
    this.pendingSegment = true;
    let filePath = '';
    try {
      const durationMs = this.options.segmentSeconds * 1000;
      await fs.mkdir(this.options.tempDir, {recursive: true});
      if (!this.isCurrentGeneration(generation)) return;
      const filename = `ltc-${Date.now()}-${this.options.fps}fps.wav`;
      filePath = path.join(this.options.tempDir, filename);
      const pcm = renderLtcPcm({
        startMs,
        durationMs,
        fps: this.options.fps,
        sampleRate: this.options.sampleRate,
        amplitude: this.options.amplitude,
        channels: this.options.channels
      });
      if (!this.isCurrentGeneration(generation)) return;
      await fs.writeFile(filePath, writeWav({pcm, sampleRate: this.options.sampleRate, channels: this.options.channels}));
      if (!this.isCurrentGeneration(generation)) return;
      const audioRoute = await this.ensureAudioRoute(generation);
      if (!this.isCurrentGeneration(generation)) return;
      this.replacePlayer(filePath, generation);
      this.lastRestartAt = Date.now();
      this.state = {
        ...this.state,
        sourceKey,
        audioRoute,
        wavPath: filePath,
        segmentStartMs: startMs,
        segmentStartedAtMs: this.lastRestartAt,
        segmentExpiresAtMs: this.lastRestartAt + durationMs,
        segmentSeconds: this.options.segmentSeconds,
        lastError: null
      };
      this.queueCleanup(filePath);
    } finally {
      if (this.isCurrentGeneration(generation)) {
        this.pendingSegment = false;
      } else if (filePath) {
        fs.unlink(filePath).catch(() => {});
      }
    }
  }

  async ensureAudioRoute(generation = this.generation) {
    if (!this.options.routeAudioToVirtual) {
      return {
        ...this.audioRoute.getState(),
        manual: true,
        supported: true,
        reason: 'manual-route-assumed',
        targetName: this.options.virtualAudioDeviceName || 'manual audio route',
        playbackEndpointName: this.options.virtualAudioDeviceName || '',
        recordingEndpointName: this.options.virtualAudioDeviceName || ''
      };
    }
    try {
      const route = await this.audioRoute.activate(this.options.virtualAudioDeviceName);
      if (this.isCurrentGeneration(generation)) this.state.audioRoute = route;
      return route;
    } catch (error) {
      if (this.isCurrentGeneration(generation)) this.state.audioRoute = this.audioRoute.getState();
      throw new Error(`虚拟声卡路由失败：${error.message}`);
    }
  }

  async restoreAudioRoute(generation = this.generation) {
    if (!this.audioRoute) return null;
    try {
      const route = await this.audioRoute.restore();
      if (this.isCurrentGeneration(generation)) this.state.audioRoute = route;
      return route;
    } catch (error) {
      const route = {...this.audioRoute.getState(), lastError: error.message};
      if (this.isCurrentGeneration(generation)) {
        this.state.audioRoute = route;
        this.state.lastError = `LTC Demo: 恢复系统音频输出失败：${error.message}`;
      }
      throw new Error(`恢复系统音频输出失败：${error.message}`);
    }
  }

  replacePlayer(filePath, generation = this.generation) {
    if (!this.isCurrentGeneration(generation)) return;
    this.cancelPlayback();
    const launch = buildAudioPlayerCommand(filePath);
    const player = spawn(launch.command, launch.args, {stdio: 'ignore', windowsHide: true});
    this.player = player;
    player.on('error', (error) => {
      if (this.player === player && this.isCurrentGeneration(generation)) this.state.lastError = `${launch.label}: ${error.message}`;
    });
    player.on('exit', () => {
      if (this.player === player && this.isCurrentGeneration(generation)) this.player = null;
    });
  }

  configureArenaIfNeeded(now, generation = this.generation) {
    if (!this.options.configureArena || this.pendingArenaConfig) return;
    const targetKey = `${this.options.arenaLayer}:${this.options.arenaClip}:${this.options.arenaSmpteInput}`;
    if (this.state.arenaConfiguredTarget === targetKey && now - this.lastArenaConfigAt < 15_000) return;
    if (now - this.lastArenaConfigAt < 3000) return;
    this.pendingArenaConfig = true;
    this.lastArenaConfigAt = now;
    this.putArenaClip({
      transporttype: {value: this.options.arenaSmpteInput}
    })
      .then(() => this.postArenaClipCommand('connect'))
      .then(() => {
        if (!this.isCurrentGeneration(generation)) return;
        this.state.arenaConfigured = true;
        this.state.arenaConfiguredTarget = targetKey;
        if (this.state.lastError?.startsWith('Arena SMPTE:')) this.state.lastError = null;
      })
      .catch((error) => {
        if (!this.isCurrentGeneration(generation)) return;
        this.state.arenaConfigured = false;
        this.state.lastError = `Arena SMPTE: ${error.message}`;
      })
      .finally(() => {
        if (this.isCurrentGeneration(generation)) this.pendingArenaConfig = false;
      });
  }

  putArenaClip(body) {
    return this.arenaRequest('PUT', this.clipPath(), JSON.stringify(body), 'application/json');
  }

  postArenaClipCommand(command) {
    return this.arenaRequest('POST', `${this.clipPath()}/${command}`);
  }

  clipPath() {
    return `/api/v1/composition/layers/${this.options.arenaLayer}/clips/${this.options.arenaClip}`;
  }

  arenaRequest(method, requestPath, body = null, contentType = null) {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : String(body);
      const request = http.request({
        host: this.options.arenaApiHost,
        port: this.options.arenaApiPort,
        path: requestPath,
        method,
        timeout: 1000,
        headers: payload ? {
          'Content-Type': contentType || 'text/plain',
          'Content-Length': Buffer.byteLength(payload)
        } : {}
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 400) {
            reject(new Error(`${response.statusCode} ${text.slice(0, 120)}`.trim()));
            return;
          }
          resolve(text);
        });
      });
      request.on('timeout', () => request.destroy(new Error('request timeout')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  queueCleanup(currentFile) {
    this.cleanupQueue.push(currentFile);
    while (this.cleanupQueue.length > 4) {
      const old = this.cleanupQueue.shift();
      if (old && old !== currentFile) fs.unlink(old).catch(() => {});
    }
  }

  cancelPlayback() {
    if (this.player && !this.player.killed) {
      try {
        this.player.kill('SIGTERM');
      } catch (_error) {}
    }
    this.player = null;
  }

  isWindowsAutoRoute() {
    return this.platform === 'win32' && Boolean(this.options.routeAudioToVirtual);
  }

  windowsAudioRouteState(sink = this.windowsSink.getState()) {
    return {
      active: Boolean(sink.running),
      supported: Boolean(sink.available),
      manual: false,
      reason: 'windows-wasapi-endpoint',
      targetName: sink.endpointName || this.options.virtualAudioDeviceName || '',
      endpointId: sink.endpointId || this.options.virtualAudioEndpointId || '',
      playbackEndpointName: sink.endpointName || this.options.virtualAudioDeviceName || '',
      recordingEndpointName: '',
      lastError: sink.lastError || null
    };
  }

  nextGeneration() {
    this.generation = (this.generation + 1) % Number.MAX_SAFE_INTEGER;
    this.pendingArenaConfig = false;
    return this.generation;
  }

  isCurrentGeneration(generation) {
    return generation === this.generation;
  }
}

function emptyState() {
  return {
    enabled: false,
    mode: null,
    fps: null,
    sourceDeck: null,
    sourceKey: '',
    timecode: null,
    bpm: null,
    beatInMeasure: null,
    playing: false,
    wavPath: '',
    segmentStartMs: null,
    segmentStartedAtMs: null,
    segmentExpiresAtMs: null,
    segmentSeconds: null,
    audioRoute: null,
    arenaTarget: null,
    outputLayer: null,
    sourceMode: 'auto',
    timecodeOffsetMs: 0,
    arenaConfigured: false,
    arenaConfiguredTarget: '',
    lastSeenAt: null,
    windowsAudioHelper: null,
    lastError: null
  };
}

function buildAudioPlayerCommand(filePath, platform = process.platform) {
  if (platform === 'darwin') {
    return {
      label: 'afplay',
      command: '/usr/bin/afplay',
      args: [filePath]
    };
  }
  if (platform === 'win32') {
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
  return {
    label: 'aplay',
    command: 'aplay',
    args: [filePath]
  };
}

function normalizeFps(value) {
  const fps = Math.round(Number(value || 25));
  return [24, 25, 30].includes(fps) ? fps : 25;
}

function normalizeSmpteInput(value) {
  const text = String(value || 'SMPTE 2').trim().toUpperCase().replace(/\s+/, ' ');
  return text === 'SMPTE 1' || text === 'SMPTE 2' ? text : 'SMPTE 2';
}

function normalizeSourceMode(value) {
  const text = String(value || 'auto').trim().toLowerCase();
  return /^deck-[1-4]$/.test(text) ? text : 'auto';
}

function normalizePlaybackRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0.25, Math.min(4, numeric));
}

function clampInteger(value, min, max, fallback) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

module.exports = {
  buildAudioPlayerCommand,
  LtcDemoOutput
};
