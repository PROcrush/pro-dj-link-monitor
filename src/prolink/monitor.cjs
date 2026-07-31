const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PORTS, parsePacket} = require('./parser.cjs');
const {BridgeService} = require('./bridge.cjs');
const {TCNET_PORTS, parseTcnetPacket, makeOptInPacket, makeRequestPacket} = require('./tcnet.cjs');
const {VirtualCdjProbe} = require('./virtualCdj.cjs');
const {requestTrackData, requestTrackCues} = require('./dbserver.cjs');
const {computeDeckTiming} = require('./timing.cjs');

const MAX_EVENTS = 120;
const MAX_WAVEFORM_FAILURES = 240;
const MAX_TCNET_CAPTURE = 800;
const STATE_EMIT_INTERVAL_MS = 250;
const TIMING_WATCHDOG_INTERVAL_MS = 250;
const WATCHDOG_STATE_EMIT_INTERVAL_MS = 1000;
const LIVE_WAVEFORM_POINT_LIMIT = 2200;
const HEAVY_STATE_RESEND_INTERVAL_MS = 2000;
const DB_REQUEST_TIMEOUT_MS = 6500;
const DB_TRACK_DEBOUNCE_MS = 350;
const DB_RETRY_MS = 10000;
const DB_PENDING_STALE_MS = 9000;
const PROLINK_CONNECTION_STALE_MS = 10000;
const TCNET_REQUEST_TYPES = [2, 4, 12, 16, 32];
const TCNET_REQUEST_LAYERS = [1, 2, 3, 4];
const TCNET_PASSIVE_UNICAST_PORTS = [TCNET_PORTS.bridgeUnicast, TCNET_PORTS.defaultUnicast];

class ProLinkMonitor extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.stopping = false;
    this.stopPromise = null;
    this.startPromise = null;
    this.stopRequested = false;
    this.sockets = new Map();
    this.options = {};
    this.startedAt = null;
    this.packetCounters = emptyCounters();
    this.devices = new Map();
    this.statuses = new Map();
    this.mediaSlots = new Map();
    this.tcnetNodes = new Map();
    this.tcnetLayers = new Map();
    this.tcnetCapture = [];
    this.metadata = new Map();
    this.cues = new Map();
    this.beatGrids = new Map();
    this.artwork = new Map();
    this.waveforms = new Map();
    this.waveformChunks = new Map();
    this.events = [];
    this.errors = [];
    this.waveformFailures = [];
    this.waveformFailureCount = 0;
    this.waveformFailureLogPath = null;
    this.waveformFailureLogWritePromise = Promise.resolve();
    this.flushTimer = null;
    this.timingWatchdogTimer = null;
    this.timingValidity = new Map();
    this.lastWatchdogStateEmittedAt = 0;
    this.bridge = new BridgeService();
    this.virtualCdj = null;
    this.tcnetOptInTimer = null;
    this.tcnetStartedAtMs = null;
    this.tcnetSeq = 0;
    this.requestedTcnetKeys = new Set();
      this.dbTrackKeys = new Set();
      this.dbPendingKeys = new Set();
      this.dbPendingStartedAt = new Map();
      this.dbFailedAt = new Map();
      this.dbRequests = new Map();
      this.dbCueKeys = new Set();
      this.dbCuePendingKeys = new Set();
      this.dbCuePendingStartedAt = new Map();
      this.dbCueFailedAt = new Map();
      this.dbRequestTimers = new Map();
      this.heavyRevision = 0;
      this.lastEmittedHeavyRevision = -1;
      this.lastHeavyStateEmittedAt = 0;
      this.outputReconfigurePromise = Promise.resolve();
  }

  async start(options = {}) {
    if (this.stopping) await this.stop();
    if (this.startPromise) return this.startPromise;
    if (this.running) await this.stop();
    this.stopRequested = false;
    const startPromise = this.performStart(options);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async performStart(options = {}) {
    this.options = {
      interfaceId: options.interfaceId || 'all',
      interfaceAddress: options.interfaceAddress || '0.0.0.0',
      interfaceMac: options.interfaceMac || '',
      tcnetEnabled: Boolean(options.tcnetEnabled),
      tcnetNodeEnabled: Boolean(options.tcnetNodeEnabled),
      tcnetUnicastPort: Number(options.tcnetUnicastPort || TCNET_PORTS.defaultUnicast),
      virtualCdjEnabled: Boolean(options.virtualCdjEnabled),
      virtualCdjId: clampNumber(options.virtualCdjId, 1, 15, 7),
      ...normalizeOutputOptions(options)
    };
    this.startedAt = new Date().toISOString();
    this.packetCounters = emptyCounters();
    this.devices.clear();
    this.statuses.clear();
    this.mediaSlots.clear();
    this.tcnetNodes.clear();
    this.tcnetLayers.clear();
    this.tcnetCapture = [];
    this.metadata.clear();
    this.cues.clear();
    this.beatGrids.clear();
    this.artwork.clear();
    this.waveforms.clear();
    this.waveformChunks.clear();
    this.events = [];
    this.errors = [];
    this.requestedTcnetKeys.clear();
      this.dbTrackKeys.clear();
      this.dbPendingKeys.clear();
      this.dbPendingStartedAt.clear();
      this.dbFailedAt.clear();
      this.dbRequests.clear();
      this.clearDbRequestTimers();
      this.heavyRevision = 0;
      this.lastEmittedHeavyRevision = -1;
      this.lastHeavyStateEmittedAt = 0;
      this.dbCueKeys.clear();
      this.dbCuePendingKeys.clear();
      this.dbCuePendingStartedAt.clear();
      this.dbCueFailedAt.clear();
    this.tcnetStartedAtMs = Date.now();
    this.tcnetSeq = 0;
    this.timingValidity.clear();
    this.lastWatchdogStateEmittedAt = 0;

    try {
      await Promise.all(this.getListenPorts().map((port) => this.bindPort(port)));
      if (this.stopRequested) throw monitorStartCancelled();
      await this.bridge.start(this.buildBridgeOptions(this.options));
      if (this.stopRequested) throw monitorStartCancelled();
      this.startVirtualCdjProbe();
      this.startTcnetNode();
      this.running = true;
      this.startTimingWatchdog();
      this.emitState();
    } catch (error) {
      await this.performStop();
      if (error.code === 'MONITOR_START_CANCELLED') return;
      throw error;
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.running = false;
    this.stopping = true;
    const stopPromise = this.finishRequestedStop();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
      this.stopping = false;
    }
  }

  async finishRequestedStop() {
    const startPromise = this.startPromise;
    if (startPromise) await startPromise.catch(() => {});
    await this.performStop();
  }

  async performStop() {
    this.stopTimingWatchdog();
    await this.outputReconfigurePromise.catch(() => {});
    this.stopTcnetNode();
    if (this.virtualCdj) this.virtualCdj.stop();
    this.virtualCdj = null;
    let bridgeStopError = null;
    try {
      await this.bridge.stop();
    } catch (error) {
      bridgeStopError = error;
      this.errors.push({timestamp: new Date().toISOString(), port: 'outputs', message: error.message});
    }
    this.clearDbRequestTimers();

    const sockets = Array.from(this.sockets.values());
    this.sockets.clear();

    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise((resolve) => {
            try {
              socket.close(resolve);
            } catch (_error) {
              resolve();
            }
          })
      )
    );

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.emitState();
    if (bridgeStopError) throw bridgeStopError;
  }

  buildBridgeOptions(options = this.options) {
    return {
      ...options,
      forceRefresh: () => this.forceRefresh(),
      getTcnetCaptureJsonl: () => this.getTcnetCaptureJsonl(),
      sendTcnetPacketFromPort: (packet, target, localPort) => this.sendTcnetPacketFromPort(packet, target, localPort),
      recordArenaPioneerPacket: (packet, target) => this.recordArenaPioneerOutbound(packet, target)
    };
  }

  reconfigureOutputs(options = {}) {
    if (!this.running || this.stopping) return this.getVjState();
    const patch = {...options};
    this.outputReconfigurePromise = this.outputReconfigurePromise
      .catch(() => {})
      .then(() => this.applyOutputConfiguration(patch));
    return this.outputReconfigurePromise;
  }

  async applyOutputConfiguration(options = {}) {
    if (!this.running || this.stopping) return this.getVjState();
    const previousOptions = this.options;
    const nextOptions = {
      ...previousOptions,
      ...normalizeOutputOptions({...previousOptions, ...options})
    };

    try {
      if (typeof this.bridge.reconfigure === 'function') {
        await this.bridge.reconfigure(this.buildBridgeOptions(nextOptions));
      } else {
        await this.bridge.start(this.buildBridgeOptions(nextOptions));
      }
      this.options = nextOptions;
      this.emitState();
      return this.getVjState();
    } catch (error) {
      this.errors.push({timestamp: new Date().toISOString(), port: 'outputs', message: error.message});
      this.emitState();
      throw error;
    }
  }

  clearLog() {
    this.events = [];
    this.tcnetCapture = [];
    this.emitState();
  }

  setWaveformFailureLogPath(filePath) {
    this.waveformFailureLogPath = filePath || null;
    if (!this.waveformFailureLogPath) return this.waveformFailureLogWritePromise;
    const targetPath = this.waveformFailureLogPath;
    return this.queueWaveformFailureLogWrite(() => sanitizePersistentWaveformFailureLog(targetPath));
  }

  async exportWaveformFailureLog(filePath) {
    // A user-triggered export may contain the detailed entries held in memory.
    // The automatic persistent log is separately privacy-minimized on every write.
    let logText = this.waveformFailures.map((entry) => JSON.stringify(entry)).join('\n');
    if (logText) logText += '\n';
    if (!logText && this.waveformFailureLogPath) {
      try {
        await this.waveformFailureLogWritePromise;
        logText = await fs.readFile(this.waveformFailureLogPath, 'utf8');
      } catch (_error) {
        logText = '';
      }
    }
    await fs.writeFile(filePath, logText, 'utf8');
  }

  async clearWaveformFailureLog() {
    this.waveformFailures = [];
    this.waveformFailureCount = 0;
    if (this.waveformFailureLogPath) {
      const targetPath = this.waveformFailureLogPath;
      await this.queueWaveformFailureLogWrite(async () => {
        await fs.mkdir(path.dirname(targetPath), {recursive: true});
        await fs.writeFile(targetPath, '', 'utf8');
      });
    }
    this.emitState();
  }

  recordRendererWaveformFailure(issue = {}) {
    this.recordWaveformFailure('renderer-draw-error', {
      deviceId: issue.deckId,
      trackId: issue.trackId,
      source: 'renderer'
    }, {
      trackKey: issue.trackKey,
      source: 'renderer',
      stage: 'draw',
      message: issue.message,
      title: issue.title,
      artist: issue.artist,
      dbKey: issue.dbKey,
      waveformKind: issue.waveformKind,
      waveformStyle: issue.waveformStyle,
      pointCount: issue.pointCount
    });
  }

  recordWaveformFailure(reason, status = {}, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      reason: String(reason || 'unknown'),
      deckId: firstNumber(status.deviceId, status.layerId, details.deckId),
      trackKey: trackReferenceKey(status) || details.trackKey || '',
      trackId: firstNumber(status.trackId, details.trackId),
      trackDeviceId: firstNumber(status.trackDeviceId, details.trackDeviceId),
      trackSlot: firstNumber(status.trackSlot, details.trackSlot),
      trackType: firstNumber(status.trackType, details.trackType),
      host: String(details.host || status.source || ''),
      source: String(details.source || status.source || ''),
      stage: String(details.stage || ''),
      title: String(details.title || status.title || ''),
      artist: String(details.artist || status.artist || ''),
      dbKey: String(details.dbKey || ''),
      dbPort: firstNumber(details.dbPort),
      waveformKind: String(details.waveformKind || details.kind || ''),
      waveformStyle: String(details.waveformStyle || details.style || ''),
      pointCount: firstNumber(details.pointCount),
      waveformCount: firstNumber(details.waveformCount),
      message: String(details.message || '').slice(0, 280)
    };

    this.waveformFailureCount += 1;
    this.waveformFailures.push(entry);
    if (this.waveformFailures.length > MAX_WAVEFORM_FAILURES) {
      this.waveformFailures.splice(0, this.waveformFailures.length - MAX_WAVEFORM_FAILURES);
    }
    this.appendWaveformFailure(entry);
    this.scheduleEmit();
    return entry;
  }

  appendWaveformFailure(entry) {
    if (!this.waveformFailureLogPath) return;
    const targetPath = this.waveformFailureLogPath;
    const persistentEntry = sanitizeWaveformFailureForDisk(entry);
    return this.queueWaveformFailureLogWrite(async () => {
      await fs.mkdir(path.dirname(targetPath), {recursive: true});
      await fs.appendFile(targetPath, `${JSON.stringify(persistentEntry)}\n`, 'utf8');
    });
  }

  queueWaveformFailureLogWrite(operation) {
    const queued = this.waveformFailureLogWritePromise
      .catch(() => {})
      .then(operation);
    this.waveformFailureLogWritePromise = queued.catch((error) => {
      this.errors.push({timestamp: new Date().toISOString(), port: 'waveform-log', message: error.message});
    });
    return queued;
  }

  forceRefresh() {
    let refreshed = 0;
    for (const status of this.statuses.values()) {
      const deviceId = Number(status?.deviceId || 0);
      if (!deviceId || deviceId > 4 || !trackReferenceKey(status)) continue;
      const sourceDevice = this.devices.get(status.trackDeviceId) || this.devices.get(status.deviceId);
      const host = sourceDevice?.ip || status.source;
      const key = dbTrackDataKey(status, host);

      const timerEntry = this.dbRequestTimers.get(deviceId);
      if (timerEntry?.timer) clearTimeout(timerEntry.timer);
      this.dbRequestTimers.delete(deviceId);

      this.clearDeckTrackData(deviceId);
      this.clearDbStateForDeck(deviceId, key);
      this.requestDbTrackData(status);
      refreshed += 1;
    }
    this.scheduleEmit();
    return {refreshed};
  }

  async exportJson(filePath) {
    const state = this.getVjState();
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async exportTcnetCapture(filePath) {
    await fs.writeFile(filePath, this.getTcnetCaptureJsonl(), 'utf8');
  }

  getTcnetCaptureJsonl() {
    const lines = this.tcnetCapture
      .slice()
      .reverse()
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    return lines ? `${lines}\n` : '';
  }

  getState(options = {}) {
    const eventLimit = normalizeLimit(options.eventLimit, MAX_EVENTS);
    const waveformPointLimit = normalizeLimit(options.waveformPointLimit, 0);
    return {
      running: this.running,
      startedAt: this.startedAt,
      options: this.options,
      packetCounters: this.packetCounters,
      devices: Array.from(this.devices.values()).sort((a, b) => a.id - b.id),
      statuses: Array.from(this.statuses.values()).sort((a, b) => a.deviceId - b.deviceId),
      mediaSlots: Array.from(this.mediaSlots.values()).sort((a, b) => {
        if (a.deviceId !== b.deviceId) return a.deviceId - b.deviceId;
        return a.slot - b.slot;
      }),
      tcnetNodes: Array.from(this.tcnetNodes.values()).sort((a, b) => a.nodeId - b.nodeId),
      tcnetLayers: Array.from(this.tcnetLayers.values()).sort((a, b) => a.id - b.id),
      tcnetCapture: this.getTcnetCaptureEntries(80),
      metadata: Array.from(this.metadata.values()).sort((a, b) => (a.layerId || 0) - (b.layerId || 0)),
      cues: Array.from(this.cues.values()).sort((a, b) => (a.layerId || 0) - (b.layerId || 0)),
      beatGrids: Array.from(this.beatGrids.values()).sort((a, b) => (a.layerId || 0) - (b.layerId || 0)),
      artwork: Array.from(this.artwork.values()).sort((a, b) => (a.layerId || 0) - (b.layerId || 0)),
      waveforms: this.getWaveformsForState(waveformPointLimit).sort((a, b) => {
        if (a.layerId !== b.layerId) return a.layerId - b.layerId;
        const kindCompare = String(a.kind || '').localeCompare(String(b.kind || ''));
        if (kindCompare !== 0) return kindCompare;
        return String(a.style || '').localeCompare(String(b.style || ''));
      }),
      dbRequests: Array.from(this.dbRequests.values()).sort((a, b) => {
        if ((a.deviceId || 0) !== (b.deviceId || 0)) return (a.deviceId || 0) - (b.deviceId || 0);
        return String(a.key || '').localeCompare(String(b.key || ''));
      }),
      bridge: this.bridge.getState(),
      virtualCdj: this.virtualCdj ? this.virtualCdj.getState() : {enabled: false},
      events: this.events.slice(0, eventLimit),
      errors: this.errors.slice(-12),
      waveformFailures: this.getWaveformFailureState(50)
    };
  }

  getWaveformsForState(pointLimit) {
    return Array.from(this.waveforms.values()).map((waveform) => cloneWaveformForState(waveform, pointLimit));
  }

  getVjState(options = {}) {
    const waveformPointLimit = normalizeLimit(options.waveformPointLimit, LIVE_WAVEFORM_POINT_LIMIT);
    const includeHeavy = options.includeHeavy !== false;
    return {
      profile: 'vj',
      running: this.running,
      startedAt: this.startedAt,
      heavyRevision: this.heavyRevision,
      interface: {
        id: this.options.interfaceId || 'all',
        address: this.options.interfaceAddress || '0.0.0.0'
      },
      outputs: this.bridge.getState(),
      decks: this.getVjDecks(waveformPointLimit, includeHeavy),
      health: {
        ok: this.errors.length === 0,
        errors: this.errors.slice(-3),
        waveformFailures: this.getWaveformFailureState(8),
        tcnetCapture: this.getTcnetCaptureState(8)
      }
    };
  }

  getTcnetCaptureState(limit = 8) {
    return {
      total: this.tcnetCapture.length,
      recent: this.getTcnetCaptureEntries(limit)
    };
  }

  getTcnetCaptureEntries(limit = 20) {
    return this.tcnetCapture.slice(0, limit).map((entry) => {
      const {rawHex, ...summary} = entry;
      return summary;
    });
  }

  getWaveformFailureState(limit = 20) {
    return {
      total: this.waveformFailureCount,
      path: this.waveformFailureLogPath || '',
      recent: this.waveformFailures.slice(-limit)
    };
  }

    getVjDecks(waveformPointLimit, includeHeavy = true) {
      const nowMs = Date.now();
      const devices = Array.from(this.devices.values()).filter((item) => isRecentProlinkRecord(item, nowMs));
      const statuses = Array.from(this.statuses.values()).filter((item) => isRecentProlinkRecord(item, nowMs));
      const layers = Array.from(this.tcnetLayers.values());
      const metadata = Array.from(this.metadata.values());
      const cues = includeHeavy ? Array.from(this.cues.values()) : [];
      const beatGrids = Array.from(this.beatGrids.values());
      const waveforms = includeHeavy ? this.getWaveformsForState(waveformPointLimit) : [];
      const dbRequests = Array.from(this.dbRequests.values());
      const waveformsByDeck = buildWaveformGroups(waveforms);
      const metadataByDeck = new Map(metadata.map((item) => [Number(item.layerId || item.deviceId), item]));
      const cuesByDeck = new Map(cues.map((item) => [Number(item.layerId || item.deviceId), item]));
      const beatGridByDeck = new Map(beatGrids.map((item) => [Number(item.layerId || item.deviceId), item]));
      const dbRequestByDeck = new Map(dbRequests.map((item) => [Number(item.deviceId), item]));
      const ids = new Set([1, 2, 3, 4]);

      for (const device of devices) if (device.id >= 1 && device.id <= 4) ids.add(Number(device.id));
      for (const status of statuses) if (status.deviceId >= 1 && status.deviceId <= 4) ids.add(Number(status.deviceId));

      return Array.from(ids)
        .filter((id) => Number.isFinite(id) && id >= 1 && id <= 4)
        .sort((a, b) => a - b)
        .map((id) => {
          const device = devices.find((item) => Number(item.id) === id) || null;
          const status = statuses.find((item) => Number(item.deviceId) === id) || {};
          const prolinkConnected = Boolean(device || status.deviceId);
          const layer = layers.find((item) => Number(item.id || item.layerId) === id) || {};
          const deckLayer = prolinkConnected ? layer : {};
          const rawMeta = metadataByDeck.get(id) || null;
          const rawWaveforms = waveformsByDeck.get(id) || [];
          const rawCues = cuesByDeck.get(id) || null;
          const rawBeatGrid = beatGridByDeck.get(id) || null;
          const meta = dataMatchesDeckTrack(rawMeta, status) ? rawMeta : {};
          const deckWaveforms = rawWaveforms.filter((item) => dataMatchesDeckTrack(item, status));
          const waveform = chooseWaveform(deckWaveforms);
          const cueList = dataMatchesDeckTrack(rawCues, status) ? slimCueList(rawCues) : null;
          const matchingBeatGrid = dataMatchesDeckTrack(rawBeatGrid, status) ? rawBeatGrid : null;
          const beatGrid = includeHeavy && matchingBeatGrid ? slimBeatGrid(matchingBeatGrid) : null;
          const dbRequest = slimDbRequest(dbRequestByDeck.get(id));
          const totalMs = firstNumber(
            status.trackLengthMs,
            status.totalTimeMs,
            status.durationMs,
            meta.trackLengthMs,
            waveform?.totalTimeMs,
            deckLayer.trackLengthMs,
            deckLayer.totalTimeMs
          );
          const timing = this.computeStatusTiming(status, {
            nowMs,
            beatGrid: matchingBeatGrid,
            totalMs
          });
          const rawState = prolinkConnected
            ? status.playStateName || deckLayer.stateName || (status.lastBeatPacket ? 'Beat' : device ? 'Linked' : 'No Link')
            : 'No Link';

          const trackKey = trackReferenceKey(status);
          const deck = {
            id,
            trackKey,
            connected: prolinkConnected,
            name: device?.name || `Deck ${id}`,
            title: meta.title || status.title || status.trackTitle || deckLayer.title || '',
            artist: meta.artist || status.artist || deckLayer.artist || '',
            key: meta.key || status.key || '',
            bpm: firstNumber(status.effectiveBpm, deckLayer.bpm, status.trackBpm, meta.tempo),
            pitchPercent: firstNumber(status.precisePitchPercent, status.effectivePitch, status.sliderPitch, deckLayer.speedPercent),
            state: rawState,
            stateLabel: statusNameZh(rawState),
            playing: Boolean(status.isPlayingFlag) || ['Playing', 'Looping', 'Beat'].includes(rawState),
            master: Boolean(status.isMaster || deckLayer.syncMaster),
            onAir: Boolean(status.isOnAir || deckLayer.onAir),
            sync: Boolean(status.isSync),
            beatInMeasure: firstNumber(deckLayer.beatMarker, status.beatInMeasure),
            beatNumber: firstNumber(status.beat, deckLayer.beatNumber),
            elapsedMs: timing.elapsedMs,
            remainingMs: timing.remainingMs,
            totalMs: timing.totalMs,
            progress: timing.progress,
            timecode: timing.timecode,
            timecodeFrame: timing.frame,
            timingSource: timing.source,
            timingSourceAgeMs: timing.sourceAgeMs,
            timingStale: timing.stale,
            timingValid: timing.elapsedMs !== null,
            db: dbRequest
          };
          if (includeHeavy) {
            deck.waveform = waveform ? {...waveform, playheadRatio: timing.progress} : null;
            deck.waveforms = deckWaveforms;
            deck.cues = cueList;
            deck.beatGrid = beatGrid;
          }
          return deck;
        });
    }

  getListenPorts() {
    const ports = [PORTS.announce, PORTS.beat, PORTS.status, PORTS.touchAudio];
    if (this.options.tcnetEnabled) {
      ports.push(TCNET_PORTS.control, TCNET_PORTS.time, TCNET_PORTS.sync, ...TCNET_PASSIVE_UNICAST_PORTS);
      if (this.options.tcnetNodeEnabled) ports.push(this.options.tcnetUnicastPort);
    }
    return Array.from(new Set(ports));
  }

  bindPort(port) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});

      socket.on('message', (message, remote) => {
        this.handleMessage(port, message, remote);
      });

      socket.once('error', (error) => {
        this.errors.push({
          timestamp: new Date().toISOString(),
          port,
          message: error.message
        });
        reject(error);
      });

      socket.bind({port, address: '0.0.0.0', exclusive: false}, () => {
        socket.removeAllListeners('error');
        socket.on('error', (error) => {
          this.errors.push({
            timestamp: new Date().toISOString(),
            port,
            message: error.message
          });
          this.scheduleEmit();
        });
        this.sockets.set(port, socket);
        resolve();
      });
    });
  }

  sendTcnetPacketFromPort(message, target = {}, localPort) {
    const socket = this.sockets.get(Number(localPort));
    const port = Number(target.port || 0);
    const host = target.host || target.address || '';
    if (!socket || !port || !host) return false;
    socket.send(message, port, host, (error) => {
      if (error) {
        this.errors.push({timestamp: new Date().toISOString(), port: localPort, message: error.message});
        this.scheduleEmit();
      }
    });
    return true;
  }

  handleMessage(localPort, message, remote) {
    if (this.stopping || this.stopRequested) return;
    const tcnetUnicastPort = this.options.tcnetUnicastPort || TCNET_PORTS.defaultUnicast;
    const isTcnet =
      localPort === TCNET_PORTS.control ||
      localPort === TCNET_PORTS.time ||
      localPort === TCNET_PORTS.sync ||
      localPort === tcnetUnicastPort ||
      TCNET_PASSIVE_UNICAST_PORTS.includes(localPort);
    const packet = isTcnet ? parseTcnetPacket(message, {
      localPort,
      address: remote.address,
      sourcePort: remote.port
    }) : parsePacket(message, {
      localPort,
      address: remote.address,
      sourcePort: remote.port
    });

    this.packetCounters.total += 1;
    this.packetCounters.byPort[String(localPort)] = (this.packetCounters.byPort[String(localPort)] || 0) + 1;
    if (packet.valid) this.packetCounters.valid += 1;
    else this.packetCounters.invalid += 1;

    if (isTcnet) {
      this.recordTcnetCapture(packet, message);
      this.updateTcnet(packet);
    }
    else {
      if (packet.device) this.upsertDevice(packet.device, packet);
      if (packet.status) this.upsertStatus(packet.status, packet);
      if (packet.beat) this.upsertBeat(packet.beat, packet);
      if (packet.media) this.upsertMedia(packet.media, packet);
    }

    this.events.unshift(toEvent(packet));
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.scheduleEmit();
  }

  upsertDevice(device, packet) {
    this.devices.set(device.id, {
      ...device,
      lastSeen: packet.timestamp,
      source: packet.source
    });
    for (const status of this.statuses.values()) {
      if (Number(status.trackDeviceId || status.deviceId) === Number(device.id)) this.scheduleDbTrackData(status);
    }
  }

  upsertStatus(status, packet) {
    const previous = this.statuses.get(status.deviceId) || {};
    const previousTrackKey = trackReferenceKey(previous);
    const nextTrackKey = trackReferenceKey(status);
    const trackChanged = previousTrackKey !== nextTrackKey;
    const base = trackChanged ? clearStatusTrackFields(previous) : previous;
    if (trackChanged) {
      this.timingValidity.delete(status.deviceId);
      this.clearDeckTrackData(status.deviceId);
    }
    this.statuses.set(status.deviceId, {
      ...base,
      ...status,
      beatLastSeen: chooseBeatLastSeen(base, status, packet.timestamp),
      lastSeen: packet.timestamp,
      source: packet.source
    });
    const next = this.statuses.get(status.deviceId);
    this.publishCanonicalStatus(next);
    this.scheduleDbTrackData(next);
  }

  upsertBeat(beat, packet) {
    if (!beat.deviceId) return;
    const previous = this.statuses.get(beat.deviceId) || {};
    const next = {
      ...previous,
      deviceId: beat.deviceId,
      trackBpm: beat.trackBpm ?? previous.trackBpm,
      beatInMeasure: beat.beatInMeasure ?? previous.beatInMeasure,
      positionMs: beat.positionMs ?? previous.positionMs,
      positionLastSeen: beat.positionMs !== undefined && beat.positionMs !== null ? packet.timestamp : previous.positionLastSeen,
      trackLengthMs: beat.trackLengthMs ?? previous.trackLengthMs,
      trackLengthSeconds: beat.trackLengthSeconds ?? previous.trackLengthSeconds,
      effectiveBpm: beat.effectiveBpm ?? previous.effectiveBpm,
      precisePitchPercent: beat.pitchPercent ?? previous.precisePitchPercent,
      playStateName: previous.playStateName || 'Beat',
      lastBeatPacket: beat,
      beatLastSeen: beat.packetType === 0x28 ? packet.timestamp : previous.beatLastSeen,
      lastPrecisePacket: beat.packetType === 0x0b ? beat : previous.lastPrecisePacket,
      lastSeen: packet.timestamp,
      source: packet.source
    };
    this.statuses.set(beat.deviceId, next);
    this.publishCanonicalStatus(next);
    this.scheduleDbTrackData(next);
  }

  publishCanonicalStatus(status, nowMs = Date.now()) {
    const timing = this.computeStatusTiming(status, {nowMs});
    const deviceId = Number(status?.deviceId || 0);
    if (deviceId) this.timingValidity.set(deviceId, timing.elapsedMs !== null);
    this.bridge.publishStatus(status, timing);
    return timing;
  }

  startTimingWatchdog() {
    this.stopTimingWatchdog();
    this.timingWatchdogTimer = setInterval(() => this.runTimingWatchdog(), TIMING_WATCHDOG_INTERVAL_MS);
  }

  stopTimingWatchdog() {
    if (this.timingWatchdogTimer) clearInterval(this.timingWatchdogTimer);
    this.timingWatchdogTimer = null;
  }

  runTimingWatchdog(nowMs = Date.now()) {
    if (!this.running || this.stopping) return;
    let timingChanged = false;
    for (const status of this.statuses.values()) {
      const deviceId = Number(status?.deviceId || 0);
      if (!deviceId || deviceId > 4) continue;
      const computed = this.computeStatusTiming(status, {nowMs});
      const timing = isRecentProlinkRecord(status, nowMs) ? computed : unavailableTiming(computed);
      const valid = timing.elapsedMs !== null;
      const previousValid = this.timingValidity.get(deviceId);
      if (previousValid === undefined) {
        this.timingValidity.set(deviceId, valid);
        continue;
      }
      if (previousValid === valid) continue;
      this.timingValidity.set(deviceId, valid);
      this.bridge.publishStatus(status, timing);
      timingChanged = true;
    }

    const hasLiveRecords = this.statuses.size > 0 || this.devices.size > 0;
    const periodicStateDue = hasLiveRecords && nowMs - this.lastWatchdogStateEmittedAt >= WATCHDOG_STATE_EMIT_INTERVAL_MS;
    if (timingChanged || periodicStateDue) {
      this.lastWatchdogStateEmittedAt = nowMs;
      this.emitState();
    }
  }

  computeStatusTiming(status, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const deviceId = Number(status?.deviceId || 0);
    const beatGrid = options.beatGrid !== undefined
      ? options.beatGrid
      : Array.from(this.beatGrids.values()).find((item) =>
        Number(item.layerId || item.deviceId) === deviceId && dataMatchesDeckTrack(item, status)
      ) || null;
    const metadata = Array.from(this.metadata.values()).find((item) =>
      Number(item.layerId || item.deviceId) === deviceId && dataMatchesDeckTrack(item, status)
    ) || null;
    const waveform = Array.from(this.waveforms.values()).find((item) =>
      Number(item.layerId || item.deviceId) === deviceId && dataMatchesDeckTrack(item, status) && firstNumber(item.totalTimeMs) !== null
    ) || null;
    const totalMs = firstNumber(
      options.totalMs,
      status?.trackLengthMs,
      status?.totalTimeMs,
      status?.durationMs,
      metadata?.trackLengthMs,
      waveform?.totalTimeMs
    );
    const timing = computeDeckTiming({
      ...status,
      trackKey: trackReferenceKey(status)
    }, beatGrid, {
      nowMs,
      fps: this.options.timecodeFps,
      // The UI offset compensates the physical LTC audio path only.
      offsetMs: 0,
      totalMs
    });

    if (timing.elapsedMs !== null && timing.source !== 'hold') {
      status.lastCanonicalElapsedMs = timing.elapsedMs;
      status.lastCanonicalSeen = nowMs;
    }
    return timing;
  }

  requestDbTrackData(status) {
    if (!status?.trackId || !status.trackDeviceId || !status.trackSlot || !status.trackType) return;
    const sourceDevice = this.devices.get(status.trackDeviceId) || this.devices.get(status.deviceId);
    const host = sourceDevice?.ip || status.source;
    if (!host) return;

      const key = dbTrackDataKey(status, host);
      if (!key) return;
      if (this.isDbRequestPending(key, this.dbPendingKeys, this.dbPendingStartedAt, 'dbserver')) return;
      if (this.dbTrackKeys.has(key)) {
        this.requestDbCueData(status, key, host);
        return;
      }

      const failedAt = this.dbFailedAt.get(key) || 0;
      if (Date.now() - failedAt < DB_RETRY_MS) return;

      this.dbPendingKeys.add(key);
      this.dbPendingStartedAt.set(key, Date.now());
      const posingPlayer = this.chooseDbPosingPlayer(status);
      this.markDbRequest(key, status, {
        stage: 'metadata-waveform',
        state: 'pending',
        host,
        posingPlayer
      });
      withTimeout(requestTrackData({
        host,
        targetPlayer: status.trackDeviceId,
        posingPlayer,
        slot: status.trackSlot,
        trackType: status.trackType,
        trackId: status.trackId,
        waveform: true,
        cues: false,
        artwork: false,
        timeoutMs: DB_REQUEST_TIMEOUT_MS
      }), DB_REQUEST_TIMEOUT_MS + 1000, `dbserver metadata/waveform timeout for ${host}`).then((data) => {
        this.dbPendingKeys.delete(key);
        this.dbPendingStartedAt.delete(key);
        if (!this.running) return;
        if (!data) {
          this.dbFailedAt.set(key, Date.now());
          this.markDbRequest(key, status, {
            stage: 'metadata-waveform',
            state: 'unavailable',
            host,
            message: 'CDJ returned no dbserver track data'
          });
          this.recordWaveformFailure('db-empty-response', status, {
            stage: 'metadata-waveform',
            host,
            dbKey: key,
            message: 'CDJ returned no dbserver track data'
          });
          this.scheduleEmit();
          return;
        }
        if (!this.isCurrentDbTrackData(status, key)) {
          this.markDbRequest(key, status, {stage: 'metadata-waveform', state: 'stale', host});
          this.recordWaveformFailure('db-stale-response', status, {
            stage: 'metadata-waveform',
            host,
            dbKey: key,
            message: 'Waveform response arrived after the deck switched tracks'
          });
          this.scheduleEmit();
          return;
        }
        this.dbTrackKeys.add(key);
        this.markDbRequest(key, status, {
          stage: 'metadata-waveform',
          state: 'ready',
          host,
          dbPort: data.dbPort,
          title: data.metadata?.title || '',
          waveformCount: data.waveforms?.length || (data.waveform ? 1 : 0),
          beatCount: data.beatGrid?.beatCount || 0,
          cueCount: data.cues?.cueCount || 0
        });
        this.applyDbTrackData(status, data, key);
        this.requestDbCueData(status, key, host);
      }).catch((error) => {
        this.dbPendingKeys.delete(key);
        this.dbPendingStartedAt.delete(key);
        this.dbFailedAt.set(key, Date.now());
        this.markDbRequest(key, status, {
          stage: 'metadata-waveform',
          state: 'failed',
          host,
          message: error.message
        });
        this.recordWaveformFailure('db-request-error', status, {
          stage: 'metadata-waveform',
          host,
          dbKey: key,
          message: error.message
        });
        this.errors.push({timestamp: new Date().toISOString(), port: 'dbserver', message: error.message});
        this.scheduleEmit();
      });
  }

  scheduleDbTrackData(status) {
    if (!status?.deviceId || !status?.trackId || !status.trackDeviceId || !status.trackSlot || !status.trackType) return;
    const sourceDevice = this.devices.get(status.trackDeviceId) || this.devices.get(status.deviceId);
    const host = sourceDevice?.ip || status.source;
    const key = dbTrackDataKey(status, host);
    if (!key) return;

    if (this.dbTrackKeys.has(key)) {
      this.requestDbCueData(status, key, host);
      return;
    }
    if (this.dbPendingKeys.has(key)) {
      return;
    }

    const deviceId = Number(status.deviceId);
    const trackKey = trackReferenceKey(status);
    const previous = this.dbRequestTimers.get(deviceId);
    if (previous?.trackKey === trackKey) return;
    if (previous?.timer) clearTimeout(previous.timer);

    const timer = setTimeout(() => {
      this.dbRequestTimers.delete(deviceId);
      const current = this.statuses.get(deviceId);
      if (trackReferenceKey(current) !== trackKey) return;
      this.requestDbTrackData(current);
    }, DB_TRACK_DEBOUNCE_MS);
    this.dbRequestTimers.set(deviceId, {timer, trackKey});
  }

  clearDbRequestTimers() {
    for (const entry of this.dbRequestTimers.values()) clearTimeout(entry.timer);
    this.dbRequestTimers.clear();
  }

  clearDbStateForDeck(deviceId, currentKey) {
    const keys = new Set(currentKey ? [currentKey] : []);
    for (const [key, request] of this.dbRequests.entries()) {
      if (Number(request.deviceId) === Number(deviceId)) keys.add(key);
    }
    for (const key of keys) {
      this.dbTrackKeys.delete(key);
      this.dbPendingKeys.delete(key);
      this.dbPendingStartedAt.delete(key);
      this.dbFailedAt.delete(key);
      this.dbCueKeys.delete(key);
      this.dbCuePendingKeys.delete(key);
      this.dbCuePendingStartedAt.delete(key);
      this.dbCueFailedAt.delete(key);
      this.dbRequests.delete(key);
    }
  }

  chooseDbPosingPlayer(status) {
    const virtualId = Number(this.options.virtualCdjId || 0);
    if (this.options.virtualCdjEnabled && virtualId >= 1 && virtualId <= 4) return virtualId;
    return status.trackDeviceId || status.deviceId || 1;
  }

  isCurrentDbTrackData(status, key) {
    const current = this.statuses.get(status.deviceId);
    if (!current) return false;
    if (trackReferenceKey(current) !== trackReferenceKey(status)) return false;
    const sourceDevice = this.devices.get(current.trackDeviceId) || this.devices.get(current.deviceId);
    const host = sourceDevice?.ip || current.source;
    return dbTrackDataKey(current, host) === key;
  }

    requestDbCueData(status, key, host) {
      if (!key || !host || !status?.trackId || !status.trackDeviceId || !status.trackSlot || !status.trackType) return;
      if (this.dbCueKeys.has(key) || this.isDbRequestPending(key, this.dbCuePendingKeys, this.dbCuePendingStartedAt, 'dbserver-cue')) return;

      const failedAt = this.dbCueFailedAt.get(key) || 0;
      if (Date.now() - failedAt < DB_RETRY_MS) return;

      this.dbCuePendingKeys.add(key);
      this.dbCuePendingStartedAt.set(key, Date.now());
      const posingPlayer = this.chooseDbPosingPlayer(status);
      this.markDbRequest(key, status, {
        stage: 'cue',
        state: 'pending',
        host,
        posingPlayer
      });
      withTimeout(requestTrackCues({
        host,
        targetPlayer: status.trackDeviceId,
        posingPlayer,
        slot: status.trackSlot,
        trackType: status.trackType,
        trackId: status.trackId,
        timeoutMs: 2500
      }), 3500, `dbserver cue timeout for ${host}`).then((data) => {
        this.dbCuePendingKeys.delete(key);
        this.dbCuePendingStartedAt.delete(key);
        if (!this.running || !data) return;
        if (!this.isCurrentDbTrackData(status, key)) {
          this.markDbRequest(key, status, {stage: 'cue', state: 'stale', host});
          this.scheduleEmit();
          return;
        }
        this.dbCueKeys.add(key);
        this.markDbRequest(key, status, {
          stage: 'cue',
          state: 'ready',
          host,
          dbPort: data.dbPort,
          cueCount: data.cues?.cueCount || 0
        });
        this.applyDbCueData(status, data, key);
      }).catch((error) => {
        this.dbCuePendingKeys.delete(key);
        this.dbCuePendingStartedAt.delete(key);
        this.dbCueFailedAt.set(key, Date.now());
        this.markDbRequest(key, status, {
          stage: 'cue',
          state: 'failed',
          host,
          message: error.message
        });
        this.errors.push({timestamp: new Date().toISOString(), port: 'dbserver-cue', message: error.message});
        this.scheduleEmit();
      });
    }

    applyDbCueData(status, data, key) {
      if (!data.cues?.cues) return;
      this.cues.set(String(status.deviceId), {
        ...data.cues,
        id: status.deviceId,
        layerId: status.deviceId,
        deviceId: status.deviceId,
        trackId: status.trackId,
        trackDeviceId: status.trackDeviceId,
        trackSlot: status.trackSlot,
        trackType: status.trackType,
        dbKey: key,
        dbPort: data.dbPort,
        source: status.source,
        lastSeen: new Date().toISOString()
      });
      this.markHeavyChanged();
      this.scheduleEmit(true);
    }

    isDbRequestPending(key, pendingKeys, pendingStartedAt, port) {
      if (!pendingKeys.has(key)) return false;
      const startedAt = pendingStartedAt.get(key);
      if (!startedAt || Date.now() - startedAt <= DB_PENDING_STALE_MS) return true;

      pendingKeys.delete(key);
      pendingStartedAt.delete(key);
      const message = `${port} request stale after ${DB_PENDING_STALE_MS}ms`;
      this.errors.push({timestamp: new Date().toISOString(), port, message});
      this.scheduleEmit();
      return false;
    }

    markDbRequest(key, status, update) {
      const previous = this.dbRequests.get(key) || {};
      this.dbRequests.set(key, {
        ...previous,
        ...update,
        key,
        deviceId: status.deviceId,
        trackId: status.trackId,
        trackDeviceId: status.trackDeviceId,
        trackSlot: status.trackSlot,
        trackType: status.trackType,
        updatedAt: new Date().toISOString()
      });
    }

  applyDbTrackData(status, data, key) {
    const metadata = data.metadata ? {
      ...data.metadata,
      id: status.deviceId,
      layerId: status.deviceId,
      deviceId: status.deviceId,
      trackId: status.trackId,
      trackDeviceId: status.trackDeviceId,
      trackSlot: status.trackSlot,
      trackType: status.trackType,
      source: status.source,
      dbKey: key,
      dbPort: data.dbPort,
      artworkId: data.artwork?.id || data.metadata?.artworkId || 0,
      hasArtwork: Boolean(data.artwork?.dataUrl),
      lastSeen: new Date().toISOString()
    } : null;

    if (metadata) {
      this.metadata.set(metadataKey(metadata), metadata);
      const previous = this.statuses.get(status.deviceId) || {};
      this.statuses.set(status.deviceId, {
        ...previous,
        title: metadata.title || previous.title,
        artist: metadata.artist ?? previous.artist,
        album: metadata.album ?? previous.album,
        key: metadata.key ?? previous.key,
        artworkId: metadata.artworkId || previous.artworkId,
        hasArtwork: metadata.hasArtwork || previous.hasArtwork,
        trackLengthMs: metadata.trackLengthMs || previous.trackLengthMs
      });
    }

    if (data.cues?.cues) this.applyDbCueData(status, data, key);

    if (data.beatGrid?.beats) {
      this.beatGrids.set(String(status.deviceId), {
        ...data.beatGrid,
        id: status.deviceId,
        layerId: status.deviceId,
        deviceId: status.deviceId,
        trackId: status.trackId,
        dbKey: key,
        dbPort: data.dbPort,
        source: status.source,
        lastSeen: new Date().toISOString()
      });
    }

    if (data.artwork?.dataUrl) {
      this.artwork.set(String(status.deviceId), {
        ...data.artwork,
        layerId: status.deviceId,
        deviceId: status.deviceId,
        trackId: status.trackId,
        dbKey: key,
        dbPort: data.dbPort,
        source: status.source,
        lastSeen: new Date().toISOString()
      });
    }

    const dbWaveforms = Array.isArray(data.waveforms) && data.waveforms.length ? data.waveforms : [data.waveform].filter(Boolean);
    const preciseTrackLengthMs = dbWaveforms.find((waveform) => waveform?.totalTimeMs)?.totalTimeMs || null;
    if (preciseTrackLengthMs) {
      const previous = this.statuses.get(status.deviceId) || {};
      this.statuses.set(status.deviceId, {
        ...previous,
        trackLengthMs: previous.trackLengthMs || preciseTrackLengthMs,
        waveformTrackLengthMs: preciseTrackLengthMs
      });
    }

    let storedWaveformCount = 0;
    for (const waveform of dbWaveforms) {
      if (!waveform?.points?.length) {
        this.recordWaveformFailure('db-empty-waveform-points', status, {
          stage: 'metadata-waveform',
          dbKey: key,
          dbPort: data.dbPort,
          waveformKind: waveform?.kind,
          waveformStyle: waveform?.style,
          pointCount: waveform?.pointCount || waveform?.points?.length || 0,
          waveformCount: dbWaveforms.length,
          message: 'Waveform entry contained no renderable points'
        });
        continue;
      }
      const waveformKey = `${status.deviceId}:${waveform.kind || 'wave'}:${waveform.style || 'dbserver'}`;
      this.waveforms.set(waveformKey, {
        ...waveform,
        layerId: status.deviceId,
        deviceId: status.deviceId,
        trackId: status.trackId,
        trackDeviceId: status.trackDeviceId,
        trackSlot: status.trackSlot,
        trackType: status.trackType,
        source: status.source,
        dbKey: key,
        dbPort: data.dbPort,
        lastSeen: new Date().toISOString()
      });
      storedWaveformCount += 1;
    }

    if (!storedWaveformCount) {
      this.recordWaveformFailure('db-no-usable-waveform', status, {
        stage: 'metadata-waveform',
        dbKey: key,
        dbPort: data.dbPort,
        waveformCount: dbWaveforms.length,
        message: dbWaveforms.length ? 'No returned waveform had renderable points' : 'CDJ returned metadata but no waveform payload'
      });
    }

    const currentStatus = this.statuses.get(status.deviceId);
    if (currentStatus) this.publishCanonicalStatus(currentStatus);
    this.markHeavyChanged();
    this.scheduleEmit(true);
  }

  clearDeckTrackData(deviceId) {
    const id = Number(deviceId);
    for (const [key, item] of this.metadata.entries()) {
      if (Number(item.layerId || item.deviceId) === id) this.metadata.delete(key);
    }
    for (const key of Array.from(this.cues.keys())) {
      if (Number(key) === id) this.cues.delete(key);
    }
    for (const key of Array.from(this.beatGrids.keys())) {
      if (Number(key) === id) this.beatGrids.delete(key);
    }
    for (const key of Array.from(this.artwork.keys())) {
      if (Number(key) === id) this.artwork.delete(key);
    }
    for (const key of Array.from(this.waveforms.keys())) {
      if (key.startsWith(`${id}:`)) this.waveforms.delete(key);
    }
    for (const key of Array.from(this.waveformChunks.keys())) {
      if (key.startsWith(`${id}:`)) this.waveformChunks.delete(key);
    }
    this.markHeavyChanged();
  }

  markHeavyChanged() {
    this.heavyRevision = (this.heavyRevision + 1) % Number.MAX_SAFE_INTEGER;
  }

  upsertMedia(media, packet) {
    this.mediaSlots.set(`${media.deviceId}:${media.slot}`, {
      ...media,
      lastSeen: packet.timestamp,
      source: packet.source
    });
  }

  updateTcnet(packet) {
    if (typeof this.bridge.observeTcnetPacket === 'function') this.bridge.observeTcnetPacket(packet);

    if (packet.tcnetNode) {
      this.upsertTcnetNode(packet.tcnetNode, packet);
      return;
    }

    if (packet.tcnetNodeOut) {
      this.tcnetNodes.delete(packet.tcnetNodeOut.nodeId);
      return;
    }

    if (packet.tcnetStatus?.layers) {
      for (const layer of packet.tcnetStatus.layers) {
        this.upsertTcnetLayer({
          ...layer,
          nodeId: packet.common?.nodeId,
          sourceName: packet.common?.nodeName,
          listenerPort: packet.tcnetStatus.listenerPort
        }, packet);
      }
      return;
    }

    if (packet.tcnetTime?.layers) {
      for (const layer of packet.tcnetTime.layers) this.upsertTcnetLayer(layer, packet);
      return;
    }

    const data = packet.tcnetData;
    if (!data) return;

    if (data.metrics) {
      this.upsertTcnetLayer(data.metrics, packet);
      return;
    }

    if (data.metadata) {
      const metadata = {
        ...data.metadata,
        dataTypeName: data.dataTypeName,
        lastSeen: packet.timestamp,
        source: packet.source
      };
      this.metadata.set(metadataKey(metadata), metadata);
      this.upsertTcnetLayer({
        id: metadata.layerId,
        layerId: metadata.layerId,
        trackId: metadata.trackId,
        artist: metadata.artist,
        title: metadata.title,
        key: metadata.key
      }, packet);
      return;
    }

    if (data.cues) {
      const cueData = {
        ...data.cues,
        dataTypeName: data.dataTypeName,
        lastSeen: packet.timestamp,
        source: packet.source
      };
      this.cues.set(String(cueData.layerId), cueData);
      this.upsertTcnetLayer({
        id: cueData.layerId,
        layerId: cueData.layerId,
        loopInMs: cueData.loopInMs,
        loopOutMs: cueData.loopOutMs,
        cueCount: cueData.cues.length,
        cues: cueData.cues
      }, packet);
      return;
    }

    if (data.waveform) {
      const waveform = this.mergeWaveform(data.waveform, packet, data.dataTypeName);
      this.upsertTcnetLayer({
        id: waveform.layerId,
        layerId: waveform.layerId,
        [`${waveform.kind}WaveformPoints`]: waveform.pointCount,
        waveformKind: waveform.kind
      }, packet);
    }
  }

  recordArenaPioneerOutbound(message, target = {}) {
    const packet = parseTcnetPacket(message, {
      address: this.options.interfaceAddress || '',
      sourcePort: null,
      localPort: target.localPort || target.port || null
    });
    this.recordTcnetCapture(packet, message, {
      direction: 'out',
      target: target.host || '',
      targetPort: target.port || null
    });
  }

  recordTcnetCapture(packet, message, extra = {}) {
    const dataPacket = packet.tcnetData || null;
    const appPacket = packet.tcnetApplicationData || packet.tcnetApplicationSpecificData || packet.tcnetFile || null;
    const notification = packet.tcnetNotification || null;
    const entry = {
      direction: 'in',
      timestamp: packet.timestamp,
      localPort: packet.localPort,
      source: packet.source,
      sourcePort: packet.sourcePort,
      length: packet.length,
      valid: packet.valid,
      type: packet.type,
      typeName: packet.typeName,
      summary: packet.summary,
      nodeId: packet.common?.nodeId ?? appPacket?.nodeId ?? null,
      nodeName: packet.common?.nodeName || appPacket?.nodeName || '',
      seq: packet.common?.seq ?? appPacket?.seq ?? null,
      nodeType: packet.common?.nodeType ?? appPacket?.nodeType ?? null,
      nodeTypeName: packet.common?.nodeTypeName || appPacket?.nodeTypeName || '',
      nodeOptions: packet.common?.nodeOptions ?? appPacket?.nodeOptions ?? null,
      protocolVersion: packet.common ? `${packet.common.versionMajor}.${packet.common.versionMinor}` : '',
      listenerPort: packet.tcnetNode?.listenerPort ?? packet.tcnetStatus?.listenerPort ?? packet.tcnetNodeOut?.listenerPort ?? null,
      requestDataType: packet.tcnetRequest?.dataType ?? null,
      requestDataTypeName: packet.tcnetRequest?.dataTypeName || '',
      layerId: packet.tcnetRequest?.layerId ?? dataPacket?.layerId ?? null,
      dataType: dataPacket?.dataType ?? null,
      dataTypeName: dataPacket?.dataTypeName || '',
      applicationIdentifier1: appPacket?.identifier1 ?? null,
      applicationIdentifier2: appPacket?.identifier2 ?? null,
      notificationCode: notification?.code ?? null,
      notificationRelatedType: notification?.relatedType ?? null,
      notificationRelatedTypeName: notification?.relatedTypeName || '',
      notificationRawBodyHex: notification?.rawBodyHex || '',
      packetSignature: appPacket?.packetSignature ?? null,
      totalPackets: appPacket?.totalPackets ?? dataPacket?.waveform?.totalPackets ?? null,
      packetNo: appPacket?.packetNo ?? dataPacket?.waveform?.packetNo ?? null,
      payloadSize: appPacket?.payloadSize ?? null,
      payloadPreviewHex: appPacket?.payloadPreviewHex || '',
      rawHex: Buffer.isBuffer(message) ? message.toString('hex') : Buffer.from(message || []).toString('hex'),
      ...extra
    };

    this.tcnetCapture.unshift(entry);
    if (this.tcnetCapture.length > MAX_TCNET_CAPTURE) this.tcnetCapture.length = MAX_TCNET_CAPTURE;
  }

  mergeWaveform(waveform, packet, dataTypeName) {
    const key = `${waveform.layerId}:${waveform.kind}:${waveform.style || dataTypeName || 'tcnet'}`;
    const totalPackets = Math.max(1, waveform.totalPackets || 1);
    let points = Array.isArray(waveform.points) ? waveform.points : [];

    if (totalPackets > 1) {
      const chunks = this.waveformChunks.get(key) || new Map();
      chunks.set(waveform.packetNo || chunks.size + 1, waveform.points);
      this.waveformChunks.set(key, chunks);
      points = Array.from(chunks.keys())
        .sort((a, b) => a - b)
        .flatMap((packetNo) => chunks.get(packetNo));
    }

    if (!points.length) {
      this.recordWaveformFailure('tcnet-empty-waveform-points', {
        deviceId: waveform.layerId,
        source: packet.source
      }, {
        stage: dataTypeName || 'tcnet-waveform',
        source: packet.source,
        waveformKind: waveform.kind,
        waveformStyle: waveform.style,
        pointCount: waveform.pointCount || 0,
        message: 'TCNet waveform packet contained no renderable points'
      });
    }

    const next = {
      layerId: waveform.layerId,
      kind: waveform.kind,
      dataTypeName,
      dataSize: waveform.dataSize,
      totalPackets,
      packetsReceived: totalPackets > 1 ? this.waveformChunks.get(key)?.size || 1 : 1,
      pointCount: points.length,
      points,
      lastSeen: packet.timestamp,
      source: packet.source
    };
    this.waveforms.set(key, next);
    return next;
  }

  upsertTcnetNode(node, packet) {
    const existing = this.tcnetNodes.get(node.nodeId) || {};
    const next = {
      ...existing,
      ...node,
      id: node.nodeId,
      lastSeen: packet.timestamp,
      source: packet.source,
      sourcePort: packet.sourcePort
    };
    this.tcnetNodes.set(node.nodeId, next);
    this.requestTcnetData(next);
  }

  upsertTcnetLayer(layer, packet) {
    const id = Number(layer.id || layer.layerId);
    if (!Number.isFinite(id) || id <= 0) return;
    const previous = this.tcnetLayers.get(id) || {};
    const next = {
      ...previous,
      ...layer,
      id,
      layerId: id,
      lastSeen: packet.timestamp,
      source: packet.source || previous.source
    };
    this.tcnetLayers.set(id, next);
    this.bridge.publishLayer(next);
  }

  startVirtualCdjProbe() {
    if (!this.options.virtualCdjEnabled) return;
    const socket = this.sockets.get(PORTS.announce);
    this.virtualCdj = new VirtualCdjProbe({
      socket,
      getDevices: () => Array.from(this.devices.values()),
      interfaceAddress: this.options.interfaceAddress,
      interfaceMac: this.options.interfaceMac,
      deviceId: this.options.virtualCdjId,
      deviceName: 'PDL-MONITOR'
    });

    const started = this.virtualCdj.start();
    if (!started) {
      this.errors.push({
        timestamp: new Date().toISOString(),
        port: PORTS.announce,
        message: 'Virtual CDJ needs a selected IPv4 interface with MAC address.'
      });
    }
  }

  startTcnetNode() {
    if (!this.options.tcnetEnabled || !this.options.tcnetNodeEnabled) return;
    const socket = this.sockets.get(TCNET_PORTS.control);
    if (!socket) return;
    this.sendTcnetOptIn();
    this.tcnetOptInTimer = setInterval(() => this.sendTcnetOptIn(), 1000);
  }

  stopTcnetNode() {
    if (this.tcnetOptInTimer) clearInterval(this.tcnetOptInTimer);
    this.tcnetOptInTimer = null;
  }

  sendTcnetOptIn() {
    const socket = this.sockets.get(TCNET_PORTS.control);
    if (!socket) return;

    const packet = makeOptInPacket({
      nodeId: 0x0f10,
      nodeName: 'PDLMON',
      seq: this.nextTcnetSeq(),
      nodeType: 4,
      listenerPort: this.options.tcnetUnicastPort,
      nodeCount: this.tcnetNodes.size,
      uptimeSeconds: Math.floor((Date.now() - (this.tcnetStartedAtMs || Date.now())) / 1000),
      vendor: 'Local',
      appName: 'PDL Monitor'
    });

    try {
      socket.setBroadcast(true);
      socket.send(packet, TCNET_PORTS.control, '255.255.255.255');
      for (const node of this.tcnetNodes.values()) {
        if (node.source && node.listenerPort) socket.send(packet, node.listenerPort, node.source);
      }
    } catch (error) {
      this.errors.push({timestamp: new Date().toISOString(), port: TCNET_PORTS.control, message: error.message});
    }
  }

  requestTcnetData(node) {
    if (!this.options.tcnetNodeEnabled || !node.source || !node.listenerPort) return;
    const socket = this.sockets.get(TCNET_PORTS.control);
    if (!socket) return;

    for (const dataType of TCNET_REQUEST_TYPES) {
      for (const layerId of TCNET_REQUEST_LAYERS) {
        const key = `${node.nodeId}:${dataType}:${layerId}`;
        if (this.requestedTcnetKeys.has(key)) continue;
        this.requestedTcnetKeys.add(key);
        const packet = makeRequestPacket({
          nodeId: 0x0f10,
          nodeName: 'PDLMON',
          seq: this.nextTcnetSeq(),
          nodeType: 4,
          dataType,
          layerId
        });
        socket.send(packet, node.listenerPort, node.source);
      }
    }
  }

  nextTcnetSeq() {
    this.tcnetSeq = (this.tcnetSeq + 1) & 0xff;
    return this.tcnetSeq;
  }

    scheduleEmit(force = false) {
      if (force && this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.emitState();
      }, STATE_EMIT_INTERVAL_MS);
    }

    emitState() {
      const now = Date.now();
      const includeHeavy =
        this.heavyRevision !== this.lastEmittedHeavyRevision ||
        now - this.lastHeavyStateEmittedAt >= HEAVY_STATE_RESEND_INTERVAL_MS;
      const state = this.getVjState({waveformPointLimit: LIVE_WAVEFORM_POINT_LIMIT, includeHeavy});
      if (includeHeavy) {
        this.lastEmittedHeavyRevision = this.heavyRevision;
        this.lastHeavyStateEmittedAt = now;
      }
      this.emit('state', state);
      this.bridge.broadcastState(state);
    }
}

function emptyCounters() {
  return {
    total: 0,
    valid: 0,
    invalid: 0,
    byPort: {
      50000: 0,
      50001: 0,
      50002: 0,
      50004: 0,
      60000: 0,
      60001: 0,
      60002: 0,
      65023: 0,
      65024: 0
    }
  };
}

function toEvent(packet) {
  const detail =
    packet.device?.name ||
    packet.status?.playStateName ||
    packet.media?.name ||
    packet.tcnetNode?.appName ||
    packet.tcnetData?.dataTypeName ||
    (packet.tcnetApplicationData ? 'application-data' : '') ||
    (packet.tcnetApplicationSpecificData ? 'application-specific-data' : '') ||
    (packet.tcnetFile ? 'file-data' : '') ||
    packet.tcnetTime?.layers?.find((layer) => layer.onAir)?.name ||
    packet.beat?.packetTypeName ||
    packet.typeName;

  return {
    timestamp: packet.timestamp,
    port: packet.localPort,
    source: packet.source,
    length: packet.length,
    type: packet.typeHex || packet.typeName || '',
    family: packet.family || '',
    summary: packet.summary,
    detail: detail || ''
  };
}

function metadataKey(metadata) {
  if (metadata.trackId) return `track:${metadata.trackId}`;
  return `layer:${metadata.layerId}`;
}

function dataMatchesDeckTrack(item, status) {
  if (!item) return false;
  const dataTrackId = firstNumber(item.trackId);
  if (dataTrackId === null) return true;
  const statusTrackId = firstNumber(status?.trackId);
  return statusTrackId !== null && dataTrackId === statusTrackId;
}

function isRecentProlinkRecord(record, nowMs = Date.now()) {
  if (!record) return false;
  const timestampMs = Date.parse(record.lastSeen || '');
  if (!Number.isFinite(timestampMs)) return true;
  return nowMs - timestampMs <= PROLINK_CONNECTION_STALE_MS;
}

function buildWaveformGroups(waveforms) {
  const grouped = new Map();
  for (const waveform of waveforms || []) {
    const id = Number(waveform.layerId || waveform.deviceId);
    if (!Number.isFinite(id)) continue;
    const list = grouped.get(id) || [];
    list.push(waveform);
    grouped.set(id, list);
  }
  return grouped;
}

function chooseWaveform(waveforms) {
  return (waveforms || []).slice().sort((a, b) => waveformScore(b) - waveformScore(a))[0] || null;
}

function waveformScore(waveform) {
  const styleScore = {
    'three-band': 90,
    rgb: 80,
    blue: 70
  };
  const base = styleScore[waveform.style] || (waveform.kind === 'big' ? 60 : 50);
  return base + (waveform.kind === 'big' ? 5 : 0);
}

function slimCueList(cueList) {
  if (!cueList) return null;
  return {
    cueCount: cueList.cueCount || 0,
    hotCueCount: cueList.hotCueCount || 0,
    memoryCount: cueList.memoryCount || 0,
    loopCount: cueList.loopCount || 0,
    cues: (cueList.cues || []).map((cue) => ({
      hotCueNumber: cue.hotCueNumber || 0,
      label: cue.label || '',
      kind: cue.kind || '',
      isLoop: Boolean(cue.isLoop),
      positionMs: firstNumber(cue.positionMs),
      loopMs: firstNumber(cue.loopMs),
      color: cue.color || ''
    }))
  };
}

function slimBeatGrid(beatGrid) {
  if (!beatGrid) return null;
  const downbeats = (beatGrid.beats || [])
    .filter((beat) => Number(beat?.[1]) === 1)
    .slice(0, 64)
    .map((beat) => Number(beat?.[0] || 0));
  return {
    beatCount: beatGrid.beatCount || beatGrid.beats?.length || 0,
    beats: beatGrid.beats || [],
    downbeats
  };
}

function slimDbRequest(request) {
  if (!request) return null;
  return {
    state: request.state || '',
    stage: request.stage || '',
    message: request.message || '',
    waveformCount: request.waveformCount || 0,
    updatedAt: request.updatedAt || ''
  };
}

function dbTrackDataKey(status, host) {
  const trackKey = trackReferenceKey(status);
  if (!trackKey || !host) return null;
  return `${host}:${trackKey}`;
}

function trackReferenceKey(status) {
  const trackId = Number(status?.trackId || 0);
  const trackDeviceId = Number(status?.trackDeviceId || 0);
  const trackSlot = Number(status?.trackSlot || 0);
  const trackType = Number(status?.trackType || 0);
  if (!trackId || !trackDeviceId || !trackSlot || !trackType) return null;
  return `${trackDeviceId}:${trackSlot}:${trackType}:${trackId}`;
}

function clearStatusTrackFields(status) {
  const next = {...status};
  for (const key of [
    'title',
    'artist',
    'album',
    'key',
    'artworkId',
    'hasArtwork',
    'trackLengthMs',
    'trackLengthSeconds',
    'waveformTrackLengthMs',
    'positionMs',
    'positionLastSeen',
    'lastCanonicalElapsedMs',
    'lastCanonicalSeen',
    'lastBeatPacket',
    'beatLastSeen',
    'lastPrecisePacket'
  ]) {
    delete next[key];
  }
  return next;
}

function chooseBeatLastSeen(previous = {}, next = {}, packetTimestamp) {
  const nextBeat = firstNumber(next.beat, next.beatNumber);
  if (nextBeat === null) return previous.beatLastSeen;
  const previousSeenMs = Date.parse(previous.beatLastSeen || '');
  const packetMs = Date.parse(packetTimestamp || '');
  if (!Number.isFinite(previousSeenMs) || !Number.isFinite(packetMs)) return packetTimestamp;

  const previousBeat = firstNumber(previous.beat, previous.beatNumber);
  const ageMs = Math.max(0, packetMs - previousSeenMs);
  if (previousBeat === nextBeat) return previous.beatLastSeen;
  if (previousBeat !== nextBeat && previous.lastBeatPacket?.packetType === 0x28 && ageMs <= 300) {
    return previous.beatLastSeen;
  }
  return packetTimestamp;
}

function unavailableTiming(timing = {}) {
  return {
    ...timing,
    elapsedMs: null,
    remainingMs: null,
    progress: null,
    source: 'none',
    sourceAgeMs: null,
    stale: true,
    frame: null,
    timecode: null
  };
}

function monitorStartCancelled() {
  const error = new Error('Monitor start cancelled by stop request');
  error.code = 'MONITOR_START_CANCELLED';
  return error;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function statusNameZh(value) {
  const map = {
    Beat: '节拍中',
    Linked: '已连接',
    'No Link': '未连接',
    ConnectedNoBeat: '已连接 / 无节拍',
    Playing: '播放中',
    Looping: '循环中',
    Paused: '暂停',
    Idle: '空闲',
    'Cue Down': '按下Cue',
    'Platter Down': '按下盘面',
    FFWD: '快进',
    FFRV: '快退',
    Hold: '保持',
    Cued: 'Cue就绪',
    Loading: '载入中',
    Empty: '空',
    Stopped: '停止'
  };
  return map[value] || value || '-';
}

function cloneWaveformForState(waveform, pointLimit) {
  if (!pointLimit || !Array.isArray(waveform?.points) || waveform.points.length <= pointLimit) return {...waveform};
  const points = downsamplePoints(waveform.points, pointLimit);
  return {
    ...waveform,
    points,
    pointCount: points.length,
    statePointCount: points.length,
    originalStatePointCount: waveform.pointCount || waveform.points.length
  };
}

function downsamplePoints(points, limit) {
  if (!Array.isArray(points) || points.length <= limit) return points;
  const step = points.length / limit;
  const output = [];
  for (let index = 0; index < limit; index += 1) {
    const start = Math.floor(index * step);
    const end = Math.max(start + 1, Math.floor((index + 1) * step));
    output.push(aggregatePoint(points, start, Math.min(points.length, end)));
  }
  return output;
}

function aggregatePoint(points, start, end) {
  const sample = points[start] || [0];
  const output = new Array(sample.length).fill(0);
  for (let index = start; index < end; index += 1) {
    const point = points[index] || sample;
    for (let part = 0; part < output.length; part += 1) {
      output[part] = Math.max(output[part], Number(point[part] || 0));
    }
  }
  return output;
}

async function sanitizePersistentWaveformFailureLog(filePath) {
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const sanitizedLines = [];
  for (const line of existing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        sanitizedLines.push(JSON.stringify(sanitizeWaveformFailureForDisk(entry)));
      }
    } catch (_error) {
      // Drop malformed legacy lines rather than retaining potentially private text.
    }
  }

  const sanitized = sanitizedLines.length ? `${sanitizedLines.join('\n')}\n` : '';
  if (sanitized === existing) return;
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, sanitized, 'utf8');
}

function sanitizeWaveformFailureForDisk(entry = {}) {
  const timestampMs = Date.parse(entry.timestamp || '');
  const sanitized = {
    timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : new Date().toISOString(),
    reason: sanitizeDiagnosticLabel(entry.reason, 'unknown')
  };
  addFiniteDiagnosticNumber(sanitized, 'deckId', entry.deckId);
  addDiagnosticLabel(sanitized, 'stage', entry.stage);
  addDiagnosticLabel(sanitized, 'waveformKind', entry.waveformKind);
  addDiagnosticLabel(sanitized, 'waveformStyle', entry.waveformStyle);
  addFiniteDiagnosticNumber(sanitized, 'pointCount', entry.pointCount);
  addFiniteDiagnosticNumber(sanitized, 'waveformCount', entry.waveformCount);
  return sanitized;
}

function addDiagnosticLabel(target, key, value) {
  const sanitized = sanitizeDiagnosticLabel(value);
  if (sanitized) target[key] = sanitized;
}

function addFiniteDiagnosticNumber(target, key, value) {
  const numeric = firstNumber(value);
  if (numeric !== null) target[key] = numeric;
}

function sanitizeDiagnosticLabel(value, fallback = '') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function normalizeLimit(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeOutputOptions(options = {}) {
  const fps = Math.round(Number(options.timecodeFps || 25));
  return {
    websocketEnabled: options.websocketEnabled !== false,
    websocketPort: clampNumber(options.websocketPort, 1024, 65535, 7071),
    webConsoleEnabled: options.webConsoleEnabled !== false,
    webConsolePort: clampNumber(options.webConsolePort, 1024, 65535, 7072),
    webConsoleLanEnabled: Boolean(options.webConsoleLanEnabled),
    oscEnabled: Boolean(options.oscEnabled),
    oscHost: options.oscHost || '127.0.0.1',
    oscPort: clampNumber(options.oscPort, 1, 65535, 9000),
    arenaPioneerEnabled: Boolean(options.arenaPioneerEnabled),
    arenaPioneerHost: options.arenaPioneerHost || '255.255.255.255',
    arenaPioneerControlPort: clampNumber(options.arenaPioneerControlPort, 1, 65535, TCNET_PORTS.control),
    arenaPioneerTimePort: clampNumber(options.arenaPioneerTimePort, 1, 65535, TCNET_PORTS.time),
    arenaPioneerListenerPort: clampNumber(options.arenaPioneerListenerPort, 1, 65535, TCNET_PORTS.defaultUnicast),
    arenaTimecodeEnabled: Boolean(options.arenaTimecodeEnabled),
    arenaApiEnabled: options.arenaApiEnabled !== false,
    arenaClipPositionEnabled: Boolean(options.arenaClipPositionEnabled),
    arenaApiHost: options.arenaApiHost || '127.0.0.1',
    arenaApiPort: clampNumber(options.arenaApiPort, 1, 65535, 8080),
    arenaLayer: clampNumber(options.arenaLayer, 1, 999, 1),
    arenaClip: clampNumber(options.arenaClip, 1, 999, 1),
    timecodeFps: [24, 25, 30].includes(fps) ? fps : 25,
    timecodeOffsetMs: clampNumber(options.timecodeOffsetMs, -3_600_000, 3_600_000, 0),
    timecodeDemoEnabled: Boolean(options.timecodeDemoEnabled),
    timecodeDemoConfigureArena: options.timecodeDemoConfigureArena !== false,
    timecodeDemoSegmentSeconds: clampNumber(options.timecodeDemoSegmentSeconds, 5, 600, 60),
    timecodeDemoSmpteInput: options.timecodeDemoSmpteInput || 'SMPTE 2',
    timecodeDemoRouteAudio: options.timecodeDemoRouteAudio !== false,
    timecodeDemoVirtualAudioName: String(options.timecodeDemoVirtualAudioName || ''),
    timecodeDemoVirtualAudioId: String(options.timecodeDemoVirtualAudioId || ''),
    timecodeDemoSourceMode: normalizeLtcSourceMode(options.timecodeDemoSourceMode)
  };
}

function normalizeLtcSourceMode(value) {
  const text = String(value || 'auto').trim().toLowerCase();
  return /^deck-[1-4]$/.test(text) ? text : 'auto';
}

module.exports = {ProLinkMonitor};
