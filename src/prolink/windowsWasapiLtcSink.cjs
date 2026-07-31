'use strict';

const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {resolveWindowsAudioHelperPath} = require('./windowsAudioHelperPath.cjs');

const DEFAULT_START_TIMEOUT_MS = 3000;
const DEFAULT_STOP_TIMEOUT_MS = 1200;
const DEFAULT_KILL_GRACE_MS = 800;

class WindowsWasapiLtcSink {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath || resolveWindowsAudioHelperPath(__dirname, options.arch);
    this.spawn = options.spawn || spawn;
    this.existsSync = options.existsSync || fs.existsSync;
    this.startTimeoutMs = Number(options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS);
    this.stopTimeoutMs = Number(options.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS);
    this.killGraceMs = Number(options.killGraceMs || DEFAULT_KILL_GRACE_MS);
    this.child = null;
    this.stdoutBuffer = '';
    this.currentGeneration = 0;
    this.fps = 25;
    this.startWaiter = null;
    this.stopPromise = null;
    this.state = emptyState(this.helperPath);
  }

  isAvailable() {
    return this.platform === 'win32' && this.existsSync(this.helperPath);
  }

  start(options = {}) {
    if (!this.isAvailable()) {
      throw new Error(`Windows WASAPI helper 不可用：${this.helperPath}`);
    }
    if (this.stopPromise) throw new Error('Windows WASAPI helper is still stopping');
    if (this.state.terminationUnconfirmed) throw new Error('上一个 Windows WASAPI helper 尚未确认退出');
    const generation = normalizeGeneration(options.generation);
    this.currentGeneration = generation;
    this.fps = normalizeFps(options.fps);
    if (!this.child) this.spawnHelper();
    this.createStartWaiter(generation);
    this.state = {
      ...this.state,
      available: true,
      running: true,
      endpointId: String(options.endpointId || ''),
      endpointName: String(options.endpointName || ''),
      generation,
      endpointOpened: false,
      startedGeneration: null,
      lastError: null
    };
    try {
      this.send({
        command: 'start',
        endpointId: this.state.endpointId,
        endpointName: this.state.endpointName,
        fps: this.fps,
        sampleRate: Number(options.sampleRate || 48000),
        channels: Number(options.channels || 2),
        amplitude: Number(options.amplitude || 0.55),
        generation
      });
    } catch (error) {
      this.rejectStartWaiter(error);
      this.failWrite(error);
      throw error;
    }
    return this.getState();
  }

  waitUntilStarted(generation = this.currentGeneration) {
    const normalized = normalizeGeneration(generation, this.currentGeneration);
    if (this.state.endpointOpened && this.state.startedGeneration === normalized) {
      return Promise.resolve(this.getState());
    }
    if (this.startWaiter?.generation === normalized) return this.startWaiter.promise;
    return Promise.reject(new Error(this.state.lastError || 'Windows WASAPI helper 未进入 started 状态'));
  }

  sync(anchor = {}) {
    if (!this.child) return false;
    const generation = normalizeGeneration(anchor.generation, this.currentGeneration);
    if (generation < this.currentGeneration) return false;
    this.currentGeneration = generation;
    this.state = {...this.state, generation};
    try {
      this.send({
        command: 'sync',
        elapsedMs: Math.max(0, Number(anchor.elapsedMs || 0)),
        rate: clamp(Number(anchor.rate || 1), 0.25, 4),
        fps: this.fps,
        sourceKey: String(anchor.sourceKey || ''),
        generation
      });
      return true;
    } catch (error) {
      this.failWrite(error);
      return false;
    }
  }

  hold(generation = this.currentGeneration) {
    const normalized = normalizeGeneration(generation, this.currentGeneration);
    if (normalized < this.currentGeneration) return false;
    this.currentGeneration = normalized;
    this.state = {...this.state, generation: normalized, playing: false};
    if (this.child) {
      try {
        this.send({command: 'hold', generation: normalized});
      } catch (error) {
        this.failWrite(error);
        return false;
      }
    }
    return true;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.state = emptyState(this.helperPath, this.isAvailable());
      return Promise.resolve(this.getState());
    }
    this.rejectStartWaiter(new Error('Windows WASAPI helper stopped before startup completed'));
    this.state = {...this.state, playing: false, stopping: true, terminationUnconfirmed: false};
    try {
      this.send({command: 'shutdown', generation: this.currentGeneration});
    } catch (error) {
      this.failWrite(error);
    }
    const stopPromise = waitForExit(child, this.stopTimeoutMs, this.killGraceMs).then(() => {
      if (this.child === child) this.child = null;
      this.stdoutBuffer = '';
      this.state = emptyState(this.helperPath, this.isAvailable());
      return this.getState();
    }).catch((error) => {
      if (this.child === child) {
        this.state = {
          ...this.state,
          playing: false,
          stopping: false,
          terminationUnconfirmed: true,
          lastError: error.message
        };
      }
      throw error;
    }).finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    });
    this.stopPromise = stopPromise;
    return stopPromise;
  }

  getState() {
    return {...this.state};
  }

  spawnHelper() {
    const child = this.spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.stdoutBuffer = '';
    this.state = {...emptyState(this.helperPath, true), running: true};
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdin?.on('error', (error) => {
      if (this.child !== child) return;
      this.rejectStartWaiter(error);
      this.state = {...this.state, inputClosed: true, playing: false, lastError: error.message};
    });
    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return;
      this.handleStdout(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (this.child !== child) return;
      const message = String(chunk || '').trim();
      if (message) this.state = {...this.state, lastError: message, playing: false};
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.rejectStartWaiter(error);
      this.state = {...this.state, running: false, playing: false, lastError: error.message};
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.rejectStartWaiter(new Error(`helper exited (${code ?? signal ?? 'unknown'})`));
      this.child = null;
      const expected = this.state.stopping;
      this.state = {
        ...this.state,
        running: false,
        ready: false,
        endpointOpened: false,
        playing: false,
        stopping: false,
        terminationUnconfirmed: false,
        lastError: this.state.lastError || (expected ? null : `helper exited (${code ?? signal ?? 'unknown'})`)
      };
    });
  }

  send(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || this.state.inputClosed) {
      throw new Error('Windows WASAPI helper stdin is unavailable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  failWrite(error) {
    this.state = {...this.state, running: false, playing: false, lastError: error.message};
    try {
      this.child?.kill('SIGTERM');
    } catch (_error) {}
  }

  createStartWaiter(generation) {
    this.rejectStartWaiter(new Error('Windows WASAPI helper start was superseded'));
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      const error = new Error('Windows WASAPI helper 启动超时');
      this.state = {...this.state, playing: false, lastError: error.message};
      this.rejectStartWaiter(error);
    }, Math.max(1, this.startTimeoutMs));
    timer.unref?.();
    this.startWaiter = {generation, promise, resolve: resolvePromise, reject: rejectPromise, timer};
  }

  resolveStartWaiter(generation) {
    const waiter = this.startWaiter;
    if (!waiter || waiter.generation !== generation) return;
    clearTimeout(waiter.timer);
    this.startWaiter = null;
    waiter.resolve(this.getState());
  }

  rejectStartWaiter(error) {
    const waiter = this.startWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.startWaiter = null;
    waiter.reject(error);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || '');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      try {
        this.applyEvent(JSON.parse(text));
      } catch (error) {
        this.state = {...this.state, playing: false, lastError: `helper protocol error: ${error.message}`};
        this.rejectStartWaiter(error);
      }
    }
  }

  applyEvent(event = {}) {
    const generation = event.generation === undefined
      ? this.currentGeneration
      : normalizeGeneration(event.generation);
    const type = String(event.event || '');
    const isPendingStartEvent = this.startWaiter?.generation === generation && (type === 'started' || type === 'error');
    if (generation < this.currentGeneration && !isPendingStartEvent) return;
    if (type === 'ready') {
      this.state = {...this.state, ready: true, running: true};
    } else if (type === 'started') {
      this.state = {
        ...this.state,
        ready: true,
        running: true,
        endpointId: String(event.endpointId || this.state.endpointId),
        endpointName: String(event.endpointName || this.state.endpointName),
        generation: Math.max(this.currentGeneration, generation),
        endpointOpened: true,
        startedGeneration: generation,
        lastError: null
      };
      this.resolveStartWaiter(generation);
    } else if (type === 'playing') {
      this.state = {...this.state, ready: true, playing: true, generation, lastError: null};
    } else if (type === 'held') {
      this.state = {...this.state, playing: false, generation};
    } else if (type === 'error') {
      this.state = {
        ...this.state,
        playing: false,
        generation: Math.max(this.currentGeneration, generation),
        endpointOpened: false,
        lastError: String(event.message || 'unknown helper error')
      };
      this.rejectStartWaiter(new Error(this.state.lastError));
    } else if (type === 'stopped') {
      this.state = {...this.state, playing: false, generation};
    }
  }
}

function waitForExit(child, timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let killTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (error) {
        fail(new Error(`Windows WASAPI helper 终止失败：${error.message}`));
        return;
      }
      killTimer = setTimeout(() => {
        fail(new Error('Windows WASAPI helper 终止超时，退出状态未确认'));
      }, Math.max(1, killGraceMs));
    }, Math.max(1, timeoutMs));
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', (error) => fail(new Error(`Windows WASAPI helper 终止失败：${error.message}`)));
  });
}

function emptyState(helperPath, available = false) {
  return {
    available,
    helperPath,
    running: false,
    ready: false,
    playing: false,
    stopping: false,
    terminationUnconfirmed: false,
    inputClosed: false,
    endpointId: '',
    endpointName: '',
    generation: 0,
    endpointOpened: false,
    startedGeneration: null,
    lastError: null
  };
}

function normalizeGeneration(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeFps(value) {
  const fps = Math.round(Number(value || 25));
  return [24, 25, 30].includes(fps) ? fps : 25;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  WindowsWasapiLtcSink,
  waitForExit
};
