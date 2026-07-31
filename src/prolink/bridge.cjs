const dgram = require('node:dgram');
const http = require('node:http');
const {WebSocket, WebSocketServer} = require('ws');
const {
  TCNET_PORTS,
  makeOptInPacket,
  makeStatusPacket,
  makeTimePacket,
  makeMetricsPacket,
  makeMetadataPacket,
  makeApplicationDataPacket
} = require('./tcnet.cjs');
const {LtcDemoOutput} = require('./ltcDemo.cjs');

const OSC_FAST_INTERVAL_MS = 180;
const ARENA_INTERVAL_MS = 90;
const ARENA_API_CLIP_TTL_MS = 5000;
const ARENA_TEMPO_MIN_INTERVAL_MS = 450;
const ARENA_TEMPO_REFRESH_MS = 2000;
const ARENA_RESYNC_MIN_INTERVAL_MS = 1000;
const ARENA_PIONEER_NODE_ID = 0xff03;
const ARENA_PIONEER_NODE_NAME = 'BRIDGE22';
const ARENA_PIONEER_NODE_OPTIONS = 7;
const ARENA_PIONEER_VENDOR = 'PIONEER DJ CORP';
const ARENA_PIONEER_APP_NAME = 'PRODJLINK BRIDGE';
const ARENA_PIONEER_APP_VERSION = [1, 1, 67];
const ARENA_PIONEER_MIN_NODE_COUNT = 2;
const ARENA_PIONEER_SOURCE_PORT_OFFSET = 10_000;
const ARENA_PIONEER_STATUS_INTERVAL_MS = 500;
const ARENA_PIONEER_METRICS_INTERVAL_MS = 180;
const ARENA_PIONEER_METADATA_INTERVAL_MS = 2500;
const ARENA_PIONEER_OPT_IN_INTERVAL_MS = 1000;
const ARENA_PIONEER_APPDATA_RESPONSE_INTERVAL_MS = 2000;
const ARENA_PIONEER_STALE_MS = 5000;
const ARENA_PIONEER_PEER_TTL_MS = 5000;
const ARENA_PIONEER_BROADCAST_HOST = '255.255.255.255';
const DEFAULT_TIMECODE_FPS = 25;
const LOOPBACK_HOST = '127.0.0.1';
const TRUSTED_LAN_BIND_HOST = '0.0.0.0';

class BridgeService {
  constructor() {
    this.wsServer = null;
    this.httpServer = null;
    this.webConsoleWsServer = null;
      this.oscSocket = null;
      this.arenaPioneerSocket = null;
      this.oscCache = new Map();
      this.oscSentAt = new Map();
      this.arenaPioneerLayers = new Map();
      this.arenaPioneerMetadataSentAt = new Map();
      this.arenaPioneerPeers = new Map();
      this.arenaSource = null;
      this.ltcDemoSource = null;
      this.arenaApiClip = null;
      this.arenaApiPending = false;
      this.arenaApiLastSentAt = 0;
      this.arenaApiTempoPending = false;
      this.arenaApiLastTempoSentAt = 0;
      this.arenaApiLastTempo = null;
      this.arenaApiLastBeat = null;
      this.arenaApiLastResyncAt = 0;
      this.arenaPioneerSeq = 0;
      this.arenaPioneerStartedAtMs = 0;
      this.arenaPioneerLastOptInAt = 0;
      this.arenaPioneerLastStatusAt = 0;
      this.arenaPioneerLastMetricsAt = 0;
      this.arenaPioneerLastTimeAt = 0;
      this.arenaPioneerLastAppDataResponseAt = 0;
      this.options = {};
      this.ltcDemo = new LtcDemoOutput();
    this.closing = false;
    this.outputGeneration = 0;
    this.lastMonitorState = null;
    this.state = {
      websocket: {enabled: false, host: null, port: null, clients: 0, lastError: null},
      webConsole: {enabled: false, host: null, port: null, url: null, clients: 0, lastError: null},
      osc: {enabled: false, host: null, port: null, lastError: null},
      arenaPioneer: {enabled: false, host: null, controlPort: null, timePort: null, sourceDeck: null, peers: 0, lastError: null},
      ltcDemo: this.ltcDemo.getState(),
      timecode: {enabled: false, mode: null, fps: null, sourceDeck: null, timecode: null, lastError: null}
    };
  }

  async start(options = {}) {
    await this.stop({restoreAudio: true});
    try {
      await this.open(options);
    } catch (error) {
      await this.stop({restoreAudio: true});
      throw error;
    }
    return this.getState();
  }

  async reconfigure(options = {}) {
    const previousOptions = this.options;
    const restoreAudio = shouldRestoreAudioForReconfigure(previousOptions, options);
    try {
      await this.stop({restoreAudio});
    } catch (error) {
      try {
        await this.open(previousOptions);
      } catch (rollbackError) {
        await this.stop({restoreAudio: false}).catch(() => {});
        error.message = `${error.message}; output rollback failed: ${rollbackError.message}`;
      }
      throw error;
    }
    try {
      await this.open(options);
      return this.getState();
    } catch (error) {
      await this.stop({restoreAudio: shouldRestoreAudioAfterFailedOpen(previousOptions, options)});
      try {
        await this.open(previousOptions);
      } catch (rollbackError) {
        await this.stop({restoreAudio: true});
        error.message = `${error.message}; output rollback failed: ${rollbackError.message}`;
      }
      throw error;
    }
  }

  async open(options = {}) {
    this.closing = true;
    const arenaPioneerRequested = Boolean(options.arenaPioneerEnabled);
    this.options = {
      websocketEnabled: options.websocketEnabled !== false,
      websocketPort: Number(options.websocketPort || 7071),
      websocketHost: LOOPBACK_HOST,
      webConsoleEnabled: options.webConsoleEnabled !== false,
      webConsolePort: Number(options.webConsolePort || 7072),
      webConsoleLanEnabled: Boolean(options.webConsoleLanEnabled),
      webConsoleHost: options.webConsoleLanEnabled ? TRUSTED_LAN_BIND_HOST : LOOPBACK_HOST,
      forceRefresh: typeof options.forceRefresh === 'function' ? options.forceRefresh : null,
      getTcnetCaptureJsonl: typeof options.getTcnetCaptureJsonl === 'function' ? options.getTcnetCaptureJsonl : null,
      sendTcnetPacketFromPort: typeof options.sendTcnetPacketFromPort === 'function' ? options.sendTcnetPacketFromPort : null,
      recordArenaPioneerPacket: typeof options.recordArenaPioneerPacket === 'function' ? options.recordArenaPioneerPacket : null,
      oscEnabled: Boolean(options.oscEnabled),
      oscHost: options.oscHost || '127.0.0.1',
      oscPort: Number(options.oscPort || 9000),
      arenaPioneerRequested,
      arenaPioneerEnabled: arenaPioneerRequested,
      arenaPioneerHost: options.arenaPioneerHost || ARENA_PIONEER_BROADCAST_HOST,
      arenaPioneerControlPort: clampInteger(options.arenaPioneerControlPort, 1, 65535, TCNET_PORTS.control),
      arenaPioneerTimePort: clampInteger(options.arenaPioneerTimePort, 1, 65535, TCNET_PORTS.time),
      arenaPioneerListenerPort: clampInteger(options.arenaPioneerListenerPort, 1, 65535, TCNET_PORTS.defaultUnicast),
      arenaTimecodeEnabled: Boolean(options.arenaTimecodeEnabled),
      arenaApiEnabled: options.arenaApiEnabled !== false,
      arenaClipPositionEnabled: Boolean(options.arenaClipPositionEnabled),
      arenaApiHost: options.arenaApiHost || '127.0.0.1',
      arenaApiPort: clampInteger(options.arenaApiPort, 1, 65535, 8080),
      arenaLayer: clampInteger(options.arenaLayer, 1, 999, 1),
      arenaClip: clampInteger(options.arenaClip, 1, 999, 1),
      timecodeFps: normalizeTimecodeFps(options.timecodeFps),
      timecodeOffsetMs: clampInteger(options.timecodeOffsetMs, -3_600_000, 3_600_000, 0),
      timecodeDemoEnabled: Boolean(options.timecodeDemoEnabled),
      timecodeDemoConfigureArena: options.timecodeDemoConfigureArena !== false,
      timecodeDemoSegmentSeconds: clampInteger(options.timecodeDemoSegmentSeconds, 5, 600, 60),
      timecodeDemoSmpteInput: options.timecodeDemoSmpteInput || 'SMPTE 2',
      timecodeDemoRouteAudio: options.timecodeDemoRouteAudio !== false,
      timecodeDemoVirtualAudioName: String(options.timecodeDemoVirtualAudioName || ''),
      timecodeDemoVirtualAudioId: String(options.timecodeDemoVirtualAudioId || ''),
      timecodeDemoSourceMode: normalizeLtcSourceMode(options.timecodeDemoSourceMode),
      timecodeDemoOutputLayer: 'M'
    };

    const listeners = [];
    if (this.options.timecodeDemoEnabled) {
      this.ltcDemo.start({
        enabled: true,
        fps: this.options.timecodeFps,
        segmentSeconds: this.options.timecodeDemoSegmentSeconds,
        configureArena: this.options.timecodeDemoConfigureArena,
        arenaApiHost: this.options.arenaApiHost,
        arenaApiPort: this.options.arenaApiPort,
        arenaLayer: this.options.arenaLayer,
        arenaClip: this.options.arenaClip,
        arenaSmpteInput: this.options.timecodeDemoSmpteInput,
        routeAudioToVirtual: this.options.timecodeDemoRouteAudio,
        virtualAudioDeviceName: this.options.timecodeDemoVirtualAudioName,
        virtualAudioEndpointId: this.options.timecodeDemoVirtualAudioId,
        timecodeOffsetMs: this.options.timecodeOffsetMs,
        outputLayer: this.options.timecodeDemoOutputLayer,
        sourceMode: this.options.timecodeDemoSourceMode
      });
      if (typeof this.ltcDemo.waitUntilReady === 'function') await this.ltcDemo.waitUntilReady();
      this.state.ltcDemo = this.ltcDemo.getState();
    }
    if (this.options.oscEnabled || this.options.arenaTimecodeEnabled || this.options.arenaPioneerEnabled || this.options.timecodeDemoEnabled) {
      const modes = [];
      if (this.options.arenaPioneerEnabled) modes.push('arena-pioneer-tcnet');
      if (this.options.arenaTimecodeEnabled && this.options.arenaApiEnabled) modes.push('arena-api-bpm');
      else if (this.options.arenaTimecodeEnabled) modes.push('arena-osc');
      else if (this.options.oscEnabled) modes.push('osc');
      if (this.options.timecodeDemoEnabled) modes.push('audio-ltc-demo');
      this.state.timecode = {
        enabled: true,
        mode: modes.join('+'),
        fps: this.options.timecodeFps,
        sourceDeck: null,
        timecode: null,
        clipPositionEnabled: this.options.arenaClipPositionEnabled,
        ltcDemoSourceMode: this.options.timecodeDemoSourceMode,
        ltcDemoOutputLayer: this.options.timecodeDemoOutputLayer,
        lastError: null
      };
    }
    if (this.options.websocketEnabled) listeners.push(this.startWebSocket(this.options.websocketPort, this.options.websocketHost));
    if (this.options.webConsoleEnabled) listeners.push(this.startWebConsole(this.options.webConsolePort, this.options.webConsoleHost));
    if (this.options.oscEnabled) this.startOsc(this.options.oscHost, this.options.oscPort);
    if (this.options.arenaPioneerEnabled) listeners.push(this.startArenaPioneerTcnet());
    await Promise.all(listeners);
    this.closing = false;
  }

  async stop(options = {}) {
    this.closing = true;
    this.outputGeneration += 1;
    const restoreAudio = options.restoreAudio !== false;
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    const webConsoleWsServer = this.webConsoleWsServer;
    const oscSocket = this.oscSocket;
    const arenaPioneerSocket = this.arenaPioneerSocket;
    this.wsServer = null;
    this.httpServer = null;
    this.webConsoleWsServer = null;
    this.oscSocket = null;
    this.arenaPioneerSocket = null;

    terminateWebSocketClients(wsServer);
    terminateWebSocketClients(webConsoleWsServer);
    const closeTasks = [
      closeResource(wsServer),
      closeResource(httpServer),
      closeResource(webConsoleWsServer),
      closeResource(oscSocket),
      closeResource(arenaPioneerSocket),
      this.ltcDemo ? this.ltcDemo.stop({restoreAudio}) : Promise.resolve()
    ];

      this.oscCache.clear();
      this.oscSentAt.clear();
      this.arenaPioneerLayers.clear();
      this.arenaPioneerMetadataSentAt.clear();
      this.arenaPioneerPeers.clear();
      this.arenaSource = null;
      this.ltcDemoSource = null;
      this.arenaApiClip = null;
      this.arenaApiPending = false;
      this.arenaApiLastSentAt = 0;
      this.arenaApiTempoPending = false;
      this.arenaApiLastTempoSentAt = 0;
      this.arenaApiLastTempo = null;
      this.arenaApiLastBeat = null;
      this.arenaApiLastResyncAt = 0;
      this.arenaPioneerSeq = 0;
      this.arenaPioneerStartedAtMs = 0;
      this.arenaPioneerLastOptInAt = 0;
      this.arenaPioneerLastStatusAt = 0;
      this.arenaPioneerLastMetricsAt = 0;
      this.arenaPioneerLastTimeAt = 0;
      this.arenaPioneerLastAppDataResponseAt = 0;
    this.state = {
      websocket: {enabled: false, host: null, port: null, clients: 0, lastError: null},
      webConsole: {enabled: false, host: null, port: null, url: null, clients: 0, lastError: null},
      osc: {enabled: false, host: null, port: null, lastError: null},
      arenaPioneer: {enabled: false, host: null, controlPort: null, timePort: null, sourceDeck: null, peers: 0, lastError: null},
      ltcDemo: this.ltcDemo ? this.ltcDemo.getState() : {enabled: false},
      timecode: {enabled: false, mode: null, fps: null, sourceDeck: null, timecode: null, lastError: null}
    };
    const closeResults = await Promise.allSettled(closeTasks);
    if (this.ltcDemo) this.state.ltcDemo = this.ltcDemo.getState();
    const ltcStopResult = closeResults.at(-1);
    if (ltcStopResult?.status === 'rejected') {
      const error = ltcStopResult.reason instanceof Error
        ? ltcStopResult.reason
        : new Error(String(ltcStopResult.reason || 'LTC audio restore failed'));
      this.state.ltcDemo = {...this.state.ltcDemo, lastError: error.message};
      this.state.timecode.lastError = `LTC Demo: ${error.message}`;
      throw error;
    }
  }

  getState() {
    if (this.wsServer) this.state.websocket.clients = this.wsServer.clients.size;
    if (this.webConsoleWsServer) this.state.webConsole.clients = this.webConsoleWsServer.clients.size;
    if (this.state.arenaPioneer) this.state.arenaPioneer.peers = this.getArenaPioneerPeers().length;
    if (this.ltcDemo) this.state.ltcDemo = this.ltcDemo.getState();
    return this.state;
  }

  observeTcnetPacket(packet) {
    if (this.closing || !packet?.source) return;
    const name = String(packet.tcnetNode?.nodeName || packet.common?.nodeName || '').trim();
    const appName = String(packet.tcnetNode?.appName || '').trim();
    const looksLikeArena = name.toLowerCase().includes('arena') || appName.toLowerCase().includes('arena');
    if (!looksLikeArena) return;

    if (packet.tcnetNode?.listenerPort) {
      const node = packet.tcnetNode;
      const peer = {
        nodeId: node.nodeId,
        nodeName: name || 'Arena',
        appName,
        source: packet.source,
        sourcePort: packet.sourcePort,
        listenerPort: node.listenerPort,
        nodeType: node.nodeType,
        nodeTypeName: node.nodeTypeName,
        protocolVersion: `${node.versionMajor}.${node.versionMinor}`,
        lastSeenAt: Date.now()
      };
      this.arenaPioneerPeers.set(`${peer.source}:${peer.nodeId}`, peer);
      if (this.state.arenaPioneer) this.state.arenaPioneer.peers = this.getArenaPioneerPeers().length;
    }

    this.respondToArenaPioneerApplicationData(packet);
    this.respondToArenaPioneerRequest(packet);
  }

  respondToArenaPioneerApplicationData(packet) {
    const appData = packet?.tcnetApplicationData;
    if (!this.options.arenaPioneerEnabled || !this.arenaPioneerSocket || !appData) return;
    if (appData.identifier1 !== 0xff || appData.identifier2 !== 0xff) return;
    const now = Date.now();
    if (now - this.arenaPioneerLastAppDataResponseAt < ARENA_PIONEER_APPDATA_RESPONSE_INTERVAL_MS) return;
    this.arenaPioneerLastAppDataResponseAt = now;
    const payload = Buffer.alloc(Math.max(20, appData.payloadSize || 20));
    payload.writeUInt16LE(0, 0);
    payload.writeUInt16LE(this.options.arenaPioneerListenerPort || TCNET_PORTS.defaultUnicast, 2);

    const packetOut = makeApplicationDataPacket({
        nodeId: ARENA_PIONEER_NODE_ID,
        nodeName: ARENA_PIONEER_NODE_NAME,
        seq: this.nextArenaPioneerSeq(),
        nodeType: 2,
        nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
        identifier1: appData.identifier1,
      identifier2: appData.identifier2,
      packetSignature: appData.packetSignature || 0x0abc0000,
      payload
    });

    if (packet.sourcePort) this.sendArenaPioneerResponsePacket(packetOut, packet.sourcePort, packet.source, packet.localPort);
  }

  respondToArenaPioneerRequest(packet) {
    const request = packet?.tcnetRequest;
    if (!this.options.arenaPioneerEnabled || !this.arenaPioneerSocket || !request) return;
    const layer = this.getArenaPioneerLayerForRequest(request.layerId);
    let packetOut = null;

    if (request.dataType === 2) {
      packetOut = makeMetricsPacket({
        nodeId: ARENA_PIONEER_NODE_ID,
        nodeName: ARENA_PIONEER_NODE_NAME,
        seq: this.nextArenaPioneerSeq(),
        nodeType: 2,
        nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
        layerId: layer.id,
        state: layer.state,
        syncMaster: layer.syncMaster,
        beatMarker: layer.beatMarker,
        trackLengthMs: layer.totalTimeMs,
        positionMs: layer.timeMs,
        speedPercent: layer.speedPercent,
        beatNumber: layer.beatNumber,
        bpm: layer.bpm,
        trackId: layer.trackId
      });
    } else if (request.dataType === 4) {
      packetOut = makeMetadataPacket({
        nodeId: ARENA_PIONEER_NODE_ID,
        nodeName: ARENA_PIONEER_NODE_NAME,
        seq: this.nextArenaPioneerSeq(),
        nodeType: 2,
        nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
        layerId: layer.id,
        artist: layer.artist,
        title: layer.title,
        trackId: layer.trackId
      });
    }

    if (!packetOut) return;
    const ports = new Set([packet.sourcePort]);
    for (const peer of this.getArenaPioneerPeers().filter((item) => item.source === packet.source)) {
      if (peer.listenerPort) ports.add(peer.listenerPort);
    }
    for (const port of ports) {
      if (!port) continue;
      if (port === packet.sourcePort) this.sendArenaPioneerResponsePacket(packetOut, port, packet.source, packet.localPort);
      else this.sendArenaPioneerPacket(packetOut, port, packet.source);
    }
  }

  getArenaPioneerLayerForRequest(layerId) {
    const id = clampInteger(layerId, 1, 8, 1);
    return this.arenaPioneerLayers.get(id) || {
      id,
      name: `D${id}`,
      source: id,
      state: 0,
      playing: false,
      syncMaster: false,
      onAir: false,
      beatMarker: 0,
      beatNumber: 0,
      bpm: 0,
      timeMs: 0,
      totalTimeMs: 0,
      speedPercent: 100,
      trackId: id,
      title: '',
      artist: ''
    };
  }

  getArenaPioneerPeers() {
    const now = Date.now();
    for (const [key, peer] of this.arenaPioneerPeers) {
      if (now - peer.lastSeenAt > ARENA_PIONEER_PEER_TTL_MS) this.arenaPioneerPeers.delete(key);
    }
    return Array.from(this.arenaPioneerPeers.values());
  }

  broadcastState(state) {
    const publicState = sanitizePublicMonitorState(state);
    this.lastMonitorState = publicState;
    const payload = JSON.stringify({type: 'state', payload: publicState});
    this.broadcastToWebSocketServer(this.wsServer, payload);
    this.broadcastToWebSocketServer(this.webConsoleWsServer, payload);
    if (this.wsServer) this.state.websocket.clients = this.wsServer.clients.size;
    if (this.webConsoleWsServer) this.state.webConsole.clients = this.webConsoleWsServer.clients.size;
  }

    publishStatus(status, canonicalTiming = null) {
      if (this.closing || !status) return;
      const deck = status.deviceId || 0;
      if (!deck) return;
      const timing = resolvePublishedTiming(status, canonicalTiming, this.options);
      const bpm = normalizeArenaBpm(firstFiniteNumber(status.effectiveBpm, status.trackBpm, status.bpm));
      const beatInMeasure = normalizeBeatInMeasure(firstFiniteNumber(status.beatInMeasure, beatToMeasure(status.beat)));
      if (this.options.oscEnabled && this.oscSocket) {
        this.sendOscChanged(`/vj/deck/${deck}/bpm`, status.effectiveBpm || status.trackBpm || 0, OSC_FAST_INTERVAL_MS);
        this.sendOscChanged(`/vj/deck/${deck}/beat`, status.beat || 0, OSC_FAST_INTERVAL_MS);
        this.sendOscChanged(`/vj/deck/${deck}/bar`, status.beatInMeasure || 0, OSC_FAST_INTERVAL_MS);
        this.sendOscChanged(`/vj/deck/${deck}/playing`, status.isPlayingFlag ? 1 : 0, Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/master`, status.isMaster ? 1 : 0, Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/onair`, status.isOnAir ? 1 : 0, Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/sync`, status.isSync ? 1 : 0, Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/timingValid`, timing ? 1 : 0, Number.POSITIVE_INFINITY);
        if (timing) {
          this.sendOscChanged(`/vj/deck/${deck}/elapsed`, timing.elapsedMs, OSC_FAST_INTERVAL_MS);
          if (timing.remainingMs !== null) this.sendOscChanged(`/vj/deck/${deck}/remaining`, timing.remainingMs, OSC_FAST_INTERVAL_MS);
          if (timing.progress !== null) this.sendOscChanged(`/vj/deck/${deck}/progress`, timing.progress, OSC_FAST_INTERVAL_MS);
          this.sendOscChanged(`/vj/deck/${deck}/timecode`, timing.timecode, OSC_FAST_INTERVAL_MS);
          this.sendOscChanged(`/vj/deck/${deck}/timecode/frame`, timing.frame, OSC_FAST_INTERVAL_MS);
        }
        this.sendOscChanged(`/vj/deck/${deck}/title`, status.title || '', Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/artist`, status.artist || '', Number.POSITIVE_INFINITY);
        this.sendOscChanged(`/vj/deck/${deck}/key`, status.key || '', Number.POSITIVE_INFINITY);
      }
      const outputTiming = {
        deck,
        elapsedMs: timing?.elapsedMs ?? null,
        totalMs: timing?.totalMs ?? null,
        remainingMs: timing?.remainingMs ?? null,
        progress: timing?.progress ?? null,
        frame: timing?.frame ?? null,
        timecode: timing?.timecode ?? null,
        source: timing?.source || 'none',
        stale: timing?.stale ?? true,
        bpm,
        beatInMeasure
      };
      if (this.options.arenaTimecodeEnabled) this.publishArenaTimecode(status, outputTiming);
      if (this.options.arenaPioneerEnabled) {
        if (timing) this.publishArenaPioneerTcnet(status, outputTiming);
        else this.invalidateArenaPioneerDeck(deck);
      }
      if (this.options.timecodeDemoEnabled) this.publishLtcDemo(status, outputTiming);
    }

    publishLayer(layer) {
      if (this.closing || !this.oscSocket || !layer) return;
      const id = layer.id || layer.layerId || 0;
      if (!this.options.oscEnabled) return;
      const layerTimeMs = firstFiniteNumber(layer.timeMs, layer.positionMs);
      this.sendOscChanged(`/vj/layer/${id}/timingValid`, layerTimeMs !== null ? 1 : 0, Number.POSITIVE_INFINITY);
      if (layerTimeMs !== null) {
        this.sendOscChanged(`/vj/layer/${id}/time`, layerTimeMs, OSC_FAST_INTERVAL_MS);
        this.sendOscChanged(`/vj/layer/${id}/timecode`, layer.timecode || formatTimecode(layerTimeMs, this.options.timecodeFps), OSC_FAST_INTERVAL_MS);
      }
      this.sendOscChanged(`/vj/layer/${id}/beat`, layer.beatMarker || layer.beatNumber || 0, OSC_FAST_INTERVAL_MS);
      this.sendOscChanged(`/vj/layer/${id}/onair`, layer.onAir || 0, Number.POSITIVE_INFINITY);
  }

    publishArenaTimecode(status, timing) {
      if (!this.shouldPublishArenaSource(status, timing.deck)) return;
      const layer = this.options.arenaLayer;
      const clip = this.options.arenaClip;
      if (this.oscSocket) {
        this.sendOscChanged('/vj/arena/sourceDeck', timing.deck, Number.POSITIVE_INFINITY);
        this.sendOscChanged('/vj/arena/timingValid', timing.elapsedMs !== null ? 1 : 0, Number.POSITIVE_INFINITY);
        if (timing.timecode !== null) this.sendOscChanged('/vj/arena/timecode', timing.timecode, ARENA_INTERVAL_MS);
        if (timing.elapsedMs !== null) this.sendOscChanged('/vj/arena/elapsed', timing.elapsedMs, ARENA_INTERVAL_MS);
        if (timing.progress !== null) this.sendOscChanged('/vj/arena/progress', timing.progress, ARENA_INTERVAL_MS);
        if (this.options.arenaClipPositionEnabled && timing.progress !== null) {
          this.sendOscChanged(`/composition/layers/${layer}/clips/${clip}/transport/position`, timing.progress, ARENA_INTERVAL_MS);
        }
      }
      if (this.options.arenaApiEnabled) {
        if (this.options.arenaClipPositionEnabled && timing.progress !== null) this.sendArenaApiPosition(layer, clip, timing.progress);
        this.sendArenaApiTempoAndBeat(timing);
      }
      this.state.timecode.sourceDeck = timing.deck;
      this.state.timecode.timecode = timing.timecode ?? null;
      this.state.timecode.bpm = timing.bpm || null;
      this.state.timecode.beatInMeasure = timing.beatInMeasure || null;
      this.state.timecode.clipPositionEnabled = this.options.arenaClipPositionEnabled;
    }

    publishLtcDemo(status, timing) {
      if (!this.ltcDemo) return;
      const decision = this.resolveLtcDemoSource(status, timing);
      if (decision.action === 'ignore') return;
      if (decision.action === 'hold') {
        const ltcDemo = this.ltcDemo.hold({
          sourceDeck: decision.deck || timing.deck,
          timecode: timing.timecode,
          bpm: timing.bpm || null,
          beatInMeasure: timing.beatInMeasure || null,
          outputLayer: this.options.timecodeDemoOutputLayer,
          sourceMode: this.options.timecodeDemoSourceMode,
          lastSeenAt: new Date().toISOString()
        });
        this.state.ltcDemo = ltcDemo;
        if (this.state.timecode?.enabled) {
          this.state.timecode.sourceDeck = ltcDemo.sourceDeck;
          this.state.timecode.timecode = ltcDemo.timecode;
          this.state.timecode.bpm = ltcDemo.bpm || null;
          this.state.timecode.beatInMeasure = ltcDemo.beatInMeasure || null;
          this.state.timecode.ltcDemoPlaying = false;
          this.state.timecode.ltcDemoSourceMode = this.options.timecodeDemoSourceMode;
          this.state.timecode.ltcDemoOutputLayer = this.options.timecodeDemoOutputLayer;
          if (this.state.timecode.lastError?.startsWith('LTC Demo:')) this.state.timecode.lastError = null;
        }
        return;
      }
      const ltcDemo = this.ltcDemo.update(timing, {
        deck: timing.deck,
        trackKey: status.trackKey || '',
        trackId: status.trackId || '',
        title: status.title || '',
        artist: status.artist || '',
        playbackRate: playbackRateFromStatus(status)
      });
      this.state.ltcDemo = ltcDemo;
      if (this.state.timecode?.enabled) {
        this.state.timecode.sourceDeck = ltcDemo.sourceDeck;
        this.state.timecode.timecode = ltcDemo.timecode;
        this.state.timecode.bpm = ltcDemo.bpm || null;
          this.state.timecode.beatInMeasure = ltcDemo.beatInMeasure || null;
          this.state.timecode.ltcDemoPlaying = Boolean(ltcDemo.playing);
          this.state.timecode.ltcDemoSourceMode = this.options.timecodeDemoSourceMode;
          this.state.timecode.ltcDemoOutputLayer = this.options.timecodeDemoOutputLayer;
          if (ltcDemo.lastError) this.state.timecode.lastError = ltcDemo.lastError;
        else if (this.state.timecode.lastError?.startsWith('LTC Demo:') || this.state.timecode.lastError?.startsWith('Arena SMPTE:')) {
          this.state.timecode.lastError = null;
        }
      }
    }

    resolveLtcDemoSource(status = {}, timing = {}) {
      const deck = Number(timing.deck || status.deviceId || 0);
      if (!deck) return {action: 'ignore', deck: null};
      const sourceMode = normalizeLtcSourceMode(this.options.timecodeDemoSourceMode);
      const playing = isDeckActivelyPlaying(status);
      const now = Date.now();

      if (sourceMode.startsWith('deck-')) {
        const targetDeck = Number(sourceMode.slice(5));
        if (deck !== targetDeck) return {action: 'ignore', deck};
        this.ltcDemoSource = {deck, priority: 100, lastSeen: now, sourceMode};
        return {action: playing ? 'active' : 'hold', deck};
      }

      if (!playing) {
        if (this.ltcDemoSource?.deck === deck) {
          this.ltcDemoSource = null;
          return {action: 'hold', deck};
        }
        return {action: 'ignore', deck};
      }

      const priority = status.isMaster ? 30 : status.isOnAir ? 20 : 10;
      const current = this.ltcDemoSource;
      if (current && current.deck !== deck && priority < current.priority && now - current.lastSeen < 1500) {
        return {action: 'ignore', deck};
      }
      this.ltcDemoSource = {deck, priority, lastSeen: now, sourceMode};
      return {action: 'active', deck};
    }

    sendArenaApiTempoAndBeat(timing) {
      const generation = this.outputGeneration;
      const now = Date.now();
      const tempo = normalizeArenaBpm(timing.bpm);
      const beatInMeasure = normalizeBeatInMeasure(timing.beatInMeasure);
      const previousBeat = this.arenaApiLastBeat?.deck === timing.deck ? this.arenaApiLastBeat.beatInMeasure : null;
      const beatChanged = beatInMeasure !== null && beatInMeasure !== previousBeat;
      if (beatInMeasure !== null && beatChanged) {
        this.arenaApiLastBeat = {deck: timing.deck, beatInMeasure, seenAt: now};
      }

      const tempoDue = tempo !== null &&
        now - this.arenaApiLastTempoSentAt >= ARENA_TEMPO_MIN_INTERVAL_MS &&
        (this.arenaApiLastTempo === null || Math.abs(tempo - this.arenaApiLastTempo) >= 0.05 || now - this.arenaApiLastTempoSentAt >= ARENA_TEMPO_REFRESH_MS);
      const resyncDue = beatChanged && beatInMeasure === 1 && now - this.arenaApiLastResyncAt >= ARENA_RESYNC_MIN_INTERVAL_MS;
      if (this.arenaApiTempoPending || (!tempoDue && !resyncDue)) return;

      const tempocontroller = {};
      if (tempoDue) tempocontroller.tempo = {value: tempo};
      if (resyncDue) tempocontroller.resync = {value: true};
      this.arenaApiTempoPending = true;
      this.arenaApiLastTempoSentAt = now;
      if (resyncDue) this.arenaApiLastResyncAt = now;

      this.putArenaCompositionPatch({tempocontroller})
        .then(() => {
          if (generation !== this.outputGeneration) return;
          if (tempoDue) this.arenaApiLastTempo = tempo;
          if (this.state.timecode?.lastError?.startsWith('Arena API:')) this.state.timecode.lastError = null;
        })
        .catch((error) => {
          if (generation !== this.outputGeneration) return;
          if (this.state.timecode) this.state.timecode.lastError = `Arena API: ${error.message}`;
        })
        .finally(() => {
          if (generation === this.outputGeneration) this.arenaApiTempoPending = false;
        });
    }

    sendArenaApiPosition(layer, clip, progress) {
      const generation = this.outputGeneration;
      const normalized = Math.max(0, Math.min(1, Number(progress || 0)));
      const now = Date.now();
      if (this.arenaApiPending || now - this.arenaApiLastSentAt < ARENA_INTERVAL_MS) return;
      this.arenaApiPending = true;
      this.arenaApiLastSentAt = now;

      this.resolveArenaClipMax(layer, clip, generation)
        .then((maxMs) => {
          if (generation !== this.outputGeneration) return null;
          if (!Number.isFinite(maxMs) || maxMs <= 0) return null;
          const positionMs = Math.max(0, Math.min(maxMs, normalized * maxMs));
          return this.putArenaClipPosition(layer, clip, positionMs);
        })
        .then(() => {
          if (generation !== this.outputGeneration) return;
          if (this.state.timecode?.lastError?.startsWith('Arena API:')) this.state.timecode.lastError = null;
        })
        .catch((error) => {
          if (generation !== this.outputGeneration) return;
          if (this.state.timecode) this.state.timecode.lastError = `Arena API: ${error.message}`;
        })
        .finally(() => {
          if (generation === this.outputGeneration) this.arenaApiPending = false;
        });
    }

    resolveArenaClipMax(layer, clip, generation = this.outputGeneration) {
      const key = `${layer}:${clip}`;
      const now = Date.now();
      if (this.arenaApiClip?.key === key && now - this.arenaApiClip.fetchedAt < ARENA_API_CLIP_TTL_MS) {
        return Promise.resolve(this.arenaApiClip.maxMs);
      }

      return this.arenaApiRequest('GET', `/api/v1/composition/layers/${layer}/clips/${clip}`)
        .then((body) => {
          if (generation !== this.outputGeneration) return null;
          const maxMs = Number(body?.transport?.position?.max || 0);
          this.arenaApiClip = {key, maxMs, fetchedAt: Date.now()};
          return maxMs;
        });
    }

    putArenaClipPosition(layer, clip, positionMs) {
      return this.arenaApiRequest('PUT', `/api/v1/composition/layers/${layer}/clips/${clip}`, {
        transport: {
          position: {
            value: positionMs
          }
        }
      });
    }

    putArenaCompositionPatch(body) {
      return this.arenaApiRequest('PUT', '/api/v1/composition', body);
    }

    arenaApiRequest(method, requestPath, body = null) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const request = http.request({
          host: this.options.arenaApiHost,
          port: this.options.arenaApiPort,
          path: requestPath,
          method,
          timeout: 800,
          headers: payload ? {
            'Content-Type': 'application/json',
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

            if (!text) {
              resolve(null);
              return;
            }

            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(new Error(`Invalid JSON from Arena API: ${error.message}`));
            }
          });
        });

        request.on('timeout', () => request.destroy(new Error('request timeout')));
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
      });
    }

    shouldPublishArenaSource(status, deck) {
      const priority = status.isMaster ? 3 : status.isOnAir ? 2 : status.isPlayingFlag ? 1 : 0;
      if (priority <= 0) return false;
      const now = Date.now();
      const current = this.arenaSource;
      if (current && current.deck !== deck && priority < current.priority && now - current.lastSeen < 1500) return false;
      this.arenaSource = {deck, priority, lastSeen: now};
      return true;
    }

    publishArenaPioneerTcnet(status, timing) {
      if (!this.arenaPioneerSocket || !timing.deck) return;
      const now = Date.now();
      const layer = tcnetLayerFromStatus(status, timing);
      this.arenaPioneerLayers.set(layer.id, {...(this.arenaPioneerLayers.get(layer.id) || {}), ...layer, lastSeen: now});
      for (const [id, item] of this.arenaPioneerLayers) {
        if (now - item.lastSeen > ARENA_PIONEER_STALE_MS) this.arenaPioneerLayers.delete(id);
      }

      const layers = Array.from(this.arenaPioneerLayers.values());
      const peers = this.getArenaPioneerPeers();
      const nodeCount = Math.max(ARENA_PIONEER_MIN_NODE_COUNT, layers.length);
      const source = chooseArenaPioneerSource(layers);
      if (source) {
        this.state.arenaPioneer.sourceDeck = source.deck || source.source || source.id;
        if (this.state.timecode.enabled) {
          this.state.timecode.sourceDeck = source.deck || source.source || source.id;
          this.state.timecode.timecode = formatTimecode(source.timeMs, this.options.timecodeFps);
          this.state.timecode.bpm = source.bpm || null;
          this.state.timecode.beatInMeasure = source.beatMarker || null;
        }
      }

      if (now - this.arenaPioneerLastOptInAt >= ARENA_PIONEER_OPT_IN_INTERVAL_MS) {
        this.arenaPioneerLastOptInAt = now;
        const packet = makeOptInPacket({
          nodeId: ARENA_PIONEER_NODE_ID,
          nodeName: ARENA_PIONEER_NODE_NAME,
          seq: this.nextArenaPioneerSeq(),
          nodeType: 2,
          nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
          listenerPort: this.options.arenaPioneerListenerPort,
          nodeCount,
          uptimeSeconds: Math.floor((now - (this.arenaPioneerStartedAtMs || now)) / 1000),
          vendor: ARENA_PIONEER_VENDOR,
          appName: ARENA_PIONEER_APP_NAME,
          appVersion: ARENA_PIONEER_APP_VERSION
        });
        this.sendArenaPioneerPacket(packet, this.options.arenaPioneerControlPort, ARENA_PIONEER_BROADCAST_HOST);
        this.sendArenaPioneerToPeerPorts(packet, peers);
      }

      if (now - this.arenaPioneerLastStatusAt >= ARENA_PIONEER_STATUS_INTERVAL_MS) {
        this.arenaPioneerLastStatusAt = now;
        const packet = makeStatusPacket({
          nodeId: ARENA_PIONEER_NODE_ID,
          nodeName: ARENA_PIONEER_NODE_NAME,
          seq: this.nextArenaPioneerSeq(),
          nodeType: 2,
          nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
          listenerPort: this.options.arenaPioneerListenerPort,
          nodeCount,
          layers
        });
        this.sendArenaPioneerPacket(packet, this.options.arenaPioneerControlPort, ARENA_PIONEER_BROADCAST_HOST);
        this.sendArenaPioneerToPeerPorts(packet, peers);
      }

      if (now - this.arenaPioneerLastTimeAt >= ARENA_INTERVAL_MS) {
        this.arenaPioneerLastTimeAt = now;
        const packet = makeTimePacket({
          nodeId: ARENA_PIONEER_NODE_ID,
          nodeName: ARENA_PIONEER_NODE_NAME,
          seq: this.nextArenaPioneerSeq(),
          nodeType: 2,
          nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
          fps: this.options.timecodeFps,
          layers
        });
        this.sendArenaPioneerPacket(packet, this.options.arenaPioneerTimePort, ARENA_PIONEER_BROADCAST_HOST);
        this.sendArenaPioneerToPeerPorts(packet, peers);
      }

      if (now - this.arenaPioneerLastMetricsAt >= ARENA_PIONEER_METRICS_INTERVAL_MS) {
        this.arenaPioneerLastMetricsAt = now;
        for (const item of layers) {
          const packet = makeMetricsPacket({
            nodeId: ARENA_PIONEER_NODE_ID,
            nodeName: ARENA_PIONEER_NODE_NAME,
            seq: this.nextArenaPioneerSeq(),
            nodeType: 2,
            nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
            layerId: item.id,
            state: item.state,
            syncMaster: item.syncMaster,
            beatMarker: item.beatMarker,
            trackLengthMs: item.totalTimeMs,
            positionMs: item.timeMs,
            speedPercent: item.speedPercent,
            beatNumber: item.beatNumber,
            bpm: item.bpm,
            trackId: item.trackId
          });
          this.sendArenaPioneerToPeerPorts(packet, peers);
        }
      }

      for (const item of layers) {
        const metadataKey = `${item.id}:${item.trackId}:${item.artist}:${item.title}`;
        const sentAt = this.arenaPioneerMetadataSentAt.get(metadataKey) || 0;
        if (now - sentAt < ARENA_PIONEER_METADATA_INTERVAL_MS) continue;
        this.arenaPioneerMetadataSentAt.set(metadataKey, now);
        const packet = makeMetadataPacket({
          nodeId: ARENA_PIONEER_NODE_ID,
          nodeName: ARENA_PIONEER_NODE_NAME,
          seq: this.nextArenaPioneerSeq(),
          nodeType: 2,
          nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
          layerId: item.id,
          artist: item.artist,
          title: item.title,
          trackId: item.trackId
        });
        this.sendArenaPioneerToPeerPorts(packet, peers);
      }
    }

    invalidateArenaPioneerDeck(deck) {
      const deviceId = Number(deck || 0);
      if (!deviceId) return;
      const hadLayer = this.arenaPioneerLayers.delete(deviceId);
      const wasSource = this.state.arenaPioneer.sourceDeck === deviceId || this.state.timecode?.sourceDeck === deviceId;
      if (!hadLayer && !wasSource) return;
      const layers = Array.from(this.arenaPioneerLayers.values());
      const source = chooseArenaPioneerSource(layers);
      this.state.arenaPioneer.sourceDeck = source?.deck || source?.source || source?.id || null;
      if (this.state.timecode?.sourceDeck === deviceId || !source) {
        this.state.timecode.sourceDeck = source?.deck || source?.source || source?.id || null;
        this.state.timecode.timecode = source ? formatTimecode(source.timeMs, this.options.timecodeFps) : null;
      }
      if (!this.arenaPioneerSocket) return;

      const peers = this.getArenaPioneerPeers();
      const packet = makeStatusPacket({
        nodeId: ARENA_PIONEER_NODE_ID,
        nodeName: ARENA_PIONEER_NODE_NAME,
        seq: this.nextArenaPioneerSeq(),
        nodeType: 2,
        nodeOptions: ARENA_PIONEER_NODE_OPTIONS,
        listenerPort: this.options.arenaPioneerListenerPort,
        nodeCount: Math.max(ARENA_PIONEER_MIN_NODE_COUNT, layers.length),
        layers
      });
      this.arenaPioneerLastStatusAt = Date.now();
      this.sendArenaPioneerPacket(packet, this.options.arenaPioneerControlPort, ARENA_PIONEER_BROADCAST_HOST);
      this.sendArenaPioneerToPeerPorts(packet, peers);
    }

    async startArenaPioneerTcnet() {
      const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
      this.arenaPioneerSocket = socket;
      this.arenaPioneerStartedAtMs = Date.now();
      const sourcePort = arenaPioneerSourcePortFromListener(this.options.arenaPioneerListenerPort);
      this.state.arenaPioneer = {
        enabled: true,
        host: this.options.arenaPioneerHost,
        controlPort: this.options.arenaPioneerControlPort,
        timePort: this.options.arenaPioneerTimePort,
        sourcePort,
        sourceDeck: null,
        peers: this.getArenaPioneerPeers().length,
        lastError: null
      };
      await new Promise((resolve, reject) => {
        const onInitialError = (error) => {
          this.state.arenaPioneer.lastError = error.message;
          reject(error);
        };
        socket.once('error', onInitialError);
        socket.bind(sourcePort, () => {
          socket.off('error', onInitialError);
          socket.on('error', (error) => {
            this.state.arenaPioneer.lastError = error.message;
          });
          try {
            socket.setBroadcast(true);
            resolve();
          } catch (error) {
            this.state.arenaPioneer.lastError = error.message;
            reject(error);
          }
        });
      });
    }

    sendArenaPioneerPacket(packet, port, host = this.options.arenaPioneerHost) {
      if (!this.arenaPioneerSocket) return;
      if (this.options.recordArenaPioneerPacket) {
        this.options.recordArenaPioneerPacket(packet, {host, port});
      }
      if (host === ARENA_PIONEER_BROADCAST_HOST) {
        try {
          this.arenaPioneerSocket.setBroadcast(true);
        } catch (error) {
          this.state.arenaPioneer.lastError = error.message;
        }
      }
      this.arenaPioneerSocket.send(packet, port, host, (error) => {
        if (error) this.state.arenaPioneer.lastError = error.message;
      });
    }

    sendArenaPioneerResponsePacket(packet, port, host, localPort) {
      if (this.options.recordArenaPioneerPacket) {
        this.options.recordArenaPioneerPacket(packet, {host, port, localPort});
      }
      if (
        localPort &&
        this.options.sendTcnetPacketFromPort &&
        this.options.sendTcnetPacketFromPort(packet, {host, port}, localPort)
      ) {
        return;
      }
      this.sendArenaPioneerPacket(packet, port, host);
    }

    sendArenaPioneerToPeers(packet, peers = this.getArenaPioneerPeers()) {
      for (const peer of peers) {
        if (!peer.source || !peer.listenerPort) continue;
        this.sendArenaPioneerPacket(packet, peer.listenerPort, peer.source);
      }
    }

    sendArenaPioneerToPeerPorts(packet, peers = this.getArenaPioneerPeers()) {
      for (const peer of peers) {
        if (!peer.source) continue;
        const ports = new Set([peer.listenerPort, peer.sourcePort]);
        for (const port of ports) {
          if (port) this.sendArenaPioneerPacket(packet, port, peer.source);
        }
      }
    }

    nextArenaPioneerSeq() {
      this.arenaPioneerSeq = (this.arenaPioneerSeq + 1) & 0xff;
      return this.arenaPioneerSeq;
    }

  async startWebSocket(port, host = LOOPBACK_HOST) {
    const server = new WebSocketServer({
      host,
      port,
      verifyClient: ({req}) => isRawWebSocketOriginAllowed(req)
    });
    this.wsServer = server;
    server.on('connection', () => {
      this.state.websocket.clients = server.clients.size;
    });
    this.state.websocket = {enabled: true, host, port, clients: 0, lastError: null};
    await waitForListening(server, (error) => {
      this.state.websocket.lastError = error.message;
    });
    server.on('error', (error) => {
      this.state.websocket.lastError = error.message;
    });
  }

  async startWebConsole(port, host = LOOPBACK_HOST) {
    const html = createRemoteMonitorHtml();
    const webConsoleWsServer = new WebSocketServer({noServer: true});
    this.webConsoleWsServer = webConsoleWsServer;
    webConsoleWsServer.on('connection', (client) => {
      this.state.webConsole.clients = webConsoleWsServer.clients.size;
      if (this.lastMonitorState) {
        client.send(JSON.stringify({type: 'state', payload: sanitizePublicMonitorState(this.lastMonitorState)}));
      }
    });
    webConsoleWsServer.on('error', (error) => {
      this.state.webConsole.lastError = error.message;
    });

    this.httpServer = http.createServer((request, response) => this.handleWebConsoleRequest(request, response, html));
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.handleWebConsoleUpgrade(request, socket, head, webConsoleWsServer);
    });

    this.state.webConsole = {enabled: true, host, port, url: `http://${host}:${port}`, clients: 0, lastError: null};
    const server = this.httpServer;
    server.listen(port, host);
    await waitForListening(server, (error) => {
      this.state.webConsole.lastError = error.message;
    });
    server.on('error', (error) => {
      this.state.webConsole.lastError = error.message;
    });
  }

  handleWebConsoleUpgrade(request, socket, head, webConsoleWsServer = this.webConsoleWsServer) {
    if (!isWebConsoleOriginAllowed(request)) {
      rejectWebConsoleUpgrade(socket, 403, 'Forbidden');
      return false;
    }

    const url = parseWebConsoleRequestUrl(request);
    if (!url) {
      rejectWebConsoleUpgrade(socket, 400, 'Bad Request');
      return false;
    }
    if (url.pathname !== '/ws' || !webConsoleWsServer) {
      rejectWebConsoleUpgrade(socket, 404, 'Not Found');
      return false;
    }

    webConsoleWsServer.handleUpgrade(request, socket, head, (client) => {
      webConsoleWsServer.emit('connection', client, request);
    });
    return true;
  }

  handleWebConsoleRequest(request, response, html = createRemoteMonitorHtml()) {
    if (!isWebConsoleOriginAllowed(request)) {
      response.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end('Forbidden');
      return;
    }

    const url = parseWebConsoleRequestUrl(request);
    if (!url) {
      response.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end('Bad Request');
      return;
    }
    if (url.pathname === '/state.json') {
      const body = JSON.stringify(sanitizePublicMonitorState(this.lastMonitorState || {running: false}));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(body);
      return;
    }

    if (url.pathname === '/tcnet-capture.jsonl') {
      const body = this.options.getTcnetCaptureJsonl ? this.options.getTcnetCaptureJsonl() : '';
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(body);
      return;
    }

    if (url.pathname === '/refresh') {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Cache-Control': 'no-store',
          Allow: 'POST, OPTIONS'
        });
        response.end();
        return;
      }

      if (request.method !== 'POST') {
        response.writeHead(405, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          Allow: 'POST, OPTIONS'
        });
        response.end(JSON.stringify({ok: false, error: 'Use POST /refresh'}));
        return;
      }

      try {
        const result = this.options.forceRefresh ? this.options.forceRefresh() : {refreshed: 0};
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(JSON.stringify({ok: true, result}));
      } catch (error) {
        response.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(JSON.stringify({ok: false, error: error.message}));
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return;
    }

    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    response.end('Not found');
  }

  broadcastToWebSocketServer(server, payload) {
    if (!server) return;
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  startOsc(host, port) {
    this.oscSocket = dgram.createSocket('udp4');
    this.oscSocket.on('error', (error) => {
      this.state.osc.lastError = error.message;
    });
    this.state.osc = {enabled: true, host, port, lastError: null};
  }

    sendOsc(address, value) {
      const message = encodeOscMessage(address, value);
      this.oscSocket.send(message, this.state.osc.port, this.state.osc.host, (error) => {
        if (error) this.state.osc.lastError = error.message;
      });
    }

    sendOscChanged(address, value, minIntervalMs = 0) {
      const previous = this.oscCache.get(address);
      const now = Date.now();
      const lastSentAt = this.oscSentAt.get(address) || 0;
      if (previous === value && now - lastSentAt < minIntervalMs) return;
      if (previous === value && minIntervalMs === Number.POSITIVE_INFINITY) return;
      this.oscCache.set(address, value);
      this.oscSentAt.set(address, now);
      this.sendOsc(address, value);
    }
  }

function createRemoteMonitorHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PRO DJ LINK 局域网监控</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1013;
        --panel: rgba(16, 22, 26, 0.88);
        --line: rgba(255, 255, 255, 0.13);
        --muted: #9aa8a2;
        --dim: #65716d;
        --text: #eef5f1;
        --green: #20c94a;
        --cyan: #35d7ee;
        --amber: #fdb545;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-width: 980px;
        min-height: 100dvh;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.045), transparent 140px),
          linear-gradient(135deg, rgba(53,215,238,0.075), transparent 42%),
          linear-gradient(225deg, rgba(32,201,74,0.068), transparent 46%),
          linear-gradient(rgba(255,255,255,0.032) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.026) 1px, transparent 1px),
          var(--bg);
        background-size: auto, auto, auto, 32px 32px, 32px 32px, auto;
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: stretch;
        justify-content: space-between;
        gap: 16px;
        min-width: 0;
        min-height: 58px;
        padding: 0 12px;
        border-bottom: 1px solid var(--line);
        background: rgba(8, 12, 15, 0.9);
        backdrop-filter: blur(18px) saturate(1.55);
        -webkit-backdrop-filter: blur(18px) saturate(1.55);
        box-shadow: 0 18px 42px rgba(0,0,0,0.22);
      }
      .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .mark {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        border: 1px solid rgba(85, 214, 130, 0.7);
        border-radius: 6px;
        color: var(--green);
        background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(32,201,74,0.08)), rgba(32,201,74,0.08);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 0 22px rgba(32,201,74,0.16);
        font-weight: 800;
      }
      h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
      .sub { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
      .master-watch {
        flex: 0 0 220px;
        min-width: 0;
        display: grid;
        align-content: center;
        gap: 2px;
        padding: 0 14px;
        border-left: 1px solid rgba(255,255,255,0.1);
        border-right: 1px solid rgba(255,255,255,0.1);
        background: linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02)), rgba(9,13,16,0.42);
      }
      .master-watch span,
      .master-watch strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .master-watch span {
        color: var(--dim);
        font-size: 9px;
        font-weight: 900;
      }
      .master-watch strong {
        color: var(--muted);
        font-size: 14px;
        font-weight: 1000;
        font-variant-numeric: tabular-nums;
      }
      .master-watch.has-master {
        border-color: rgba(253,181,70,0.36);
        background: linear-gradient(90deg, rgba(253,181,70,0.22), rgba(32,201,74,0.1)), rgba(16,20,15,0.82);
      }
      .master-watch.has-master span,
      .master-watch.has-master strong {
        color: var(--amber);
        text-shadow: 0 0 18px rgba(253,181,70,0.38);
      }
      .master-watch.has-live strong {
        color: var(--green);
        text-shadow: 0 0 18px rgba(32,201,74,0.38), 0 0 28px rgba(32,201,74,0.18);
      }
      .pill {
        flex: 0 0 auto;
        padding: 7px 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .pill.online { color: var(--green); border-color: rgba(32, 201, 74, 0.45); }
      .actions {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
      }
      .actions::-webkit-scrollbar { display: none; }
      .layout-select,
      .waveform-select,
      .waveform-view-select,
      .refresh-button {
        height: 32px;
        width: 112px;
        padding: 0 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--text);
        background: linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.035)), var(--panel);
        font: inherit;
        font-size: 12px;
        font-weight: 800;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.16);
      }
      .waveform-select { width: 104px; }
      .waveform-view-select { width: 76px; }
      .refresh-button {
        width: auto;
        min-width: 64px;
        cursor: pointer;
        color: var(--green);
        border-color: rgba(32, 201, 74, 0.45);
      }
      .refresh-button:disabled {
        cursor: wait;
        color: var(--muted);
        border-color: var(--line);
      }
      .range-pill {
        height: 32px;
        width: 106px;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 0 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        background: linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.035)), var(--panel);
        font-size: 12px;
        font-weight: 800;
        white-space: nowrap;
      }
      .range-pill input {
        min-width: 0;
        width: 54px;
        accent-color: var(--green);
      }
      main {
        height: calc(100dvh - 74px);
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(2, minmax(420px, 1fr));
        grid-template-rows: repeat(2, minmax(0, 1fr));
        gap: 10px;
        padding: 10px;
        overflow: auto;
      }
      main.layout-auto,
      main.layout-left-right {
        grid-template-columns: repeat(2, minmax(420px, 1fr));
        grid-template-rows: repeat(2, minmax(0, 1fr));
      }
      main.layout-top-bottom {
        grid-template-columns: minmax(760px, 1fr);
        grid-template-rows: repeat(4, minmax(210px, 1fr));
      }
      article {
        position: relative;
        isolation: isolate;
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: 36px 52px 40px 44px minmax(0, 1fr) 28px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.105), rgba(255,255,255,0.024)),
          linear-gradient(180deg, rgba(37,46,52,0.78), rgba(11,15,18,0.92)),
          var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: 0 22px 58px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.17);
        overflow: hidden;
      }
      article.master {
        border-width: 2px;
        border-color: rgba(255, 220, 92, 1);
        box-shadow: 0 0 0 2px rgba(255, 210, 99, 0.34), 0 0 34px rgba(253, 181, 70, 0.42), 0 20px 70px rgba(253, 181, 70, 0.15);
      }
      article.state-playing {
        border-color: rgba(64, 232, 102, 0.98);
        box-shadow: 0 0 0 1px rgba(64,232,102,0.36), 0 0 0 3px rgba(32,201,74,0.08), 0 0 34px rgba(32,201,74,0.32), 0 18px 62px rgba(37,255,139,0.12), 0 22px 58px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.22);
      }
      article.master.state-playing {
        border-color: rgba(255, 229, 83, 1);
        box-shadow: 0 0 0 2px rgba(255,229,83,0.42), 0 0 38px rgba(253,181,70,0.5), 0 0 42px rgba(32,201,74,0.34);
      }
      article.state-standby { border-color: rgba(253, 181, 70, 0.75); }
      article.state-offline { opacity: 0.68; filter: saturate(0.72); }
      .deck-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 0;
        padding: 0 10px;
        border-bottom: 1px solid var(--line);
        color: var(--cyan);
        font-weight: 800;
        font-size: 12px;
      }
      .state {
        min-width: 58px;
        height: 18px;
        display: inline-grid;
        place-items: center;
        padding: 0 7px;
        border: 1px solid rgba(85,214,130,0.22);
        border-radius: 4px;
        color: var(--green);
        text-align: center;
        font-size: 10px;
      }
      article.master .deck-top {
        background: linear-gradient(180deg, rgba(255, 236, 160, 0.32), rgba(253, 181, 70, 0.14)), rgba(253, 181, 70, 0.13);
      }
      .deck-identity,
      .deck-alerts {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .deck-identity { flex: 1 1 auto; }
      .deck-alerts { flex: 0 0 auto; justify-content: flex-end; }
      .live-chip,
      .master-chip {
        height: 22px;
        display: inline-grid;
        place-items: center;
        padding: 0 9px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 1000;
        letter-spacing: 0;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62);
      }
      .live-chip {
        color: #102618;
        border: 1px solid rgba(173, 255, 191, 0.95);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(32, 201, 74, 0.96)), var(--green);
        animation: livePulse 1s ease-in-out infinite;
      }
      .master-chip {
        min-width: 76px;
        color: #2d2309;
        border: 1px solid rgba(255, 235, 164, 0.98);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(253, 181, 70, 0.98)), var(--amber);
        animation: masterPulse 1.2s ease-in-out infinite;
      }
      article.master .master-chip { transform: scale(1.08); }
      article.state-playing .deck-top { background: rgba(32, 201, 74, 0.13); }
      article.state-playing .state { color: #102618; background: var(--green); border-color: var(--green); }
      article.master.state-playing .deck-top {
        background: linear-gradient(90deg, rgba(253,181,70,0.28), rgba(32,201,74,0.18)), rgba(18, 23, 17, 0.78);
      }
      article.state-standby .deck-top { background: rgba(253, 181, 70, 0.1); }
      article.state-standby .state { color: #2d2309; background: var(--amber); border-color: var(--amber); }
      article.state-offline .state { color: var(--muted); background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
      .track {
        min-width: 0;
        overflow: hidden;
        display: grid;
        grid-template-columns: 36px minmax(0, 1fr);
        align-items: center;
        gap: 10px;
        padding: 5px 11px;
        min-height: 0;
        border-bottom: 1px solid rgba(255,255,255,0.075);
        background: linear-gradient(180deg, rgba(255,255,255,0.045), transparent), rgba(255,255,255,0.012);
      }
      .track-copy { min-width: 0; }
      .track h2 {
        margin: 0;
        font-size: 16px;
        line-height: 1.08;
        letter-spacing: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .track p {
        margin: 2px 0 0;
        color: var(--muted);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .art { width: 40px; height: 40px; border: 1px solid rgba(255,255,255,0.1); border-radius: 5px; object-fit: cover; background: rgba(0,0,0,0.22); }
      .art.empty { background: linear-gradient(135deg, rgba(32,201,74,0.12), rgba(53,215,238,0.08)), rgba(0,0,0,0.22); }
      .bpm {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 11px;
        overflow: hidden;
      }
      .bpm span { flex: 0 0 auto; color: var(--muted); font-size: 10px; font-weight: 900; }
      .bpm strong {
        min-width: 0;
        display: block;
        color: var(--green);
        font-size: 31px;
        line-height: 1;
        letter-spacing: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .times {
        display: grid;
        grid-template-columns: repeat(3, minmax(78px, 1fr));
        gap: 4px;
        min-width: 0;
        overflow: hidden;
        padding: 3px 11px 5px;
      }
      .timebox {
        min-width: 0;
        display: grid;
        align-content: center;
        padding: 3px 6px;
        background: rgba(0,0,0,0.24);
        border: 1px solid rgba(255,255,255,0.075);
        border-radius: 6px;
      }
      .timebox span { display: block; color: var(--muted); font-size: 9px; font-weight: 900; }
      .timebox strong {
        display: block;
        margin-top: 1px;
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      canvas {
        display: block;
        align-self: stretch;
        width: calc(100% - 22px);
        height: calc(100% - 8px);
        min-height: 48px;
        margin: 0 11px 8px;
        background: #0b1110;
        border: 1px solid rgba(255,255,255,0.11);
        border-radius: 6px;
      }
      .foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
        padding: 0 11px;
        border-top: 1px solid rgba(255,255,255,0.095);
        background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.016)), rgba(0,0,0,0.12);
        color: var(--muted);
        font-size: 10px;
        overflow: hidden;
      }
      .foot > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .flags { flex: 0 0 auto; display: flex; gap: 6px; }
      .flag { height: 18px; display: inline-flex; align-items: center; padding: 0 7px; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; }
      .flag.on { color: var(--green); border-color: rgba(32,201,74,0.45); }
      .flag.master { color: #2d2309; background: var(--amber); border-color: rgba(255,235,164,0.9); }
      @keyframes livePulse {
        0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.62), 0 0 0 0 rgba(32,201,74,0.42), 0 0 20px rgba(32,201,74,0.22); }
        50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.76), 0 0 0 4px rgba(32,201,74,0.14), 0 0 32px rgba(32,201,74,0.44); }
      }
      @keyframes masterPulse {
        0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.68), 0 0 0 0 rgba(253,181,70,0.46), 0 0 22px rgba(253,181,70,0.34); }
        50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 0 0 5px rgba(253,181,70,0.16), 0 0 38px rgba(253,181,70,0.58); }
      }
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
        }
      }
      @media (max-width: 520px) {
        header { position: sticky; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <div class="mark">PDL</div>
        <div>
          <h1>PRO DJ LINK 局域网监控</h1>
          <p class="sub" id="summary">等待数据</p>
        </div>
      </div>
      <div id="masterWatch" class="master-watch">
        <span>主控状态</span>
        <strong>等待 MASTER</strong>
      </div>
      <div class="actions">
        <select id="layoutSelect" class="layout-select">
          <option value="auto">自动布局</option>
          <option value="left-right">左右布局</option>
          <option value="top-bottom">上下布局</option>
        </select>
        <select id="waveformModeSelect" class="waveform-select">
          <option value="auto">自动波形</option>
          <option value="three-band">3Band</option>
          <option value="rgb">RGB</option>
          <option value="blue">Blue</option>
        </select>
        <select id="waveformViewSelect" class="waveform-view-select">
          <option value="overview">总览</option>
          <option value="follow">跟随</option>
        </select>
        <label class="range-pill">
          <span>高度</span>
          <input id="waveformHeightScale" type="range" min="70" max="150" value="100" />
        </label>
        <label class="range-pill">
          <span>亮度</span>
          <input id="waveformBrightness" type="range" min="70" max="150" value="100" />
        </label>
        <button id="refreshButton" class="refresh-button" type="button">刷新</button>
        <div id="status" class="pill">连接中</div>
      </div>
    </header>
    <main id="grid"></main>
    <script>
      const LAYOUT_STORAGE_KEY = 'prodjlink.webDeckLayout';
      const WAVEFORM_SETTINGS_STORAGE_KEY = 'prodjlink.webWaveformSettings';
      const layouts = new Set(['auto', 'left-right', 'top-bottom']);
      const waveformModes = new Set(['auto', 'three-band', 'rgb', 'blue']);
      const waveformViewModes = new Set(['overview', 'follow']);
      const maxWaveformImageCache = 24;
      const followWaveformWindowMs = 60000;
      const defaultWaveformSettings = {mode: 'auto', viewMode: 'overview', heightScale: 1, brightness: 1};
      const state = {
        monitor: null,
        online: false,
        layout: normalizeLayout(localStorage.getItem(LAYOUT_STORAGE_KEY)),
        waveformSettings: readWaveformSettings()
      };
      const els = {
        grid: document.querySelector('#grid'),
        layoutSelect: document.querySelector('#layoutSelect'),
        waveformModeSelect: document.querySelector('#waveformModeSelect'),
        waveformViewSelect: document.querySelector('#waveformViewSelect'),
        waveformHeightScale: document.querySelector('#waveformHeightScale'),
        waveformBrightness: document.querySelector('#waveformBrightness'),
        refreshButton: document.querySelector('#refreshButton'),
        status: document.querySelector('#status'),
        masterWatch: document.querySelector('#masterWatch'),
        summary: document.querySelector('#summary')
      };
      const waveformImageCache = new Map();

      init();

      async function init() {
        els.layoutSelect.value = state.layout;
        syncWaveformControls();
        applyLayout();
        els.layoutSelect.addEventListener('change', () => {
          state.layout = normalizeLayout(els.layoutSelect.value);
          localStorage.setItem(LAYOUT_STORAGE_KEY, state.layout);
          applyLayout();
        });
        [els.waveformModeSelect, els.waveformViewSelect, els.waveformHeightScale, els.waveformBrightness].forEach((control) => {
          control.addEventListener('input', updateWaveformSettingsFromControls);
          control.addEventListener('change', updateWaveformSettingsFromControls);
        });
        els.refreshButton.addEventListener('click', refreshCurrentTracks);
        try {
          const response = await fetch('/state.json', {cache: 'no-store'});
          if (response.ok) render(await response.json());
        } catch (_error) {}
        connect();
      }

      function connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host + '/ws');
        ws.addEventListener('open', () => setOnline(true));
        ws.addEventListener('close', () => {
          setOnline(false);
          setTimeout(connect, 1200);
        });
        ws.addEventListener('error', () => setOnline(false));
        ws.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'state') render(message.payload);
        });
      }

      function setOnline(value) {
        state.online = value;
        els.status.textContent = value ? '实时连接' : '重连中';
        els.status.classList.toggle('online', value);
      }

        async function refreshCurrentTracks() {
          els.refreshButton.disabled = true;
          try {
            const response = await fetch('/refresh', {method: 'POST', cache: 'no-store'});
            if (!response.ok) throw new Error('refresh failed');
            const payload = await response.json();
            if (!payload.ok) throw new Error(payload.error || 'refresh failed');
          } catch (error) {
            console.warn('Force refresh failed', error);
          } finally {
            els.refreshButton.disabled = false;
          }
        }

        function render(monitor) {
          state.monitor = mergeMonitorState(state.monitor, monitor || {});
          applyLayout();
          const decks = buildDecks(state.monitor);
          els.summary.textContent = '在线 ' + decks.filter((deck) => deck.stateClass !== 'offline').length + ' / ' + decks.length;
          updateMasterWatch(decks);
          els.grid.innerHTML = decks.map((deck, index) => renderDeck(deck, index)).join('');
          requestAnimationFrame(() => decks.forEach((deck, index) => drawWaveform(document.querySelector('#wf' + index), deck, state.waveformSettings)));
        }

        function updateMasterWatch(decks) {
          if (!els.masterWatch) return;
          const masterDeck = decks.find((deck) => deck.isMaster);
          const liveDeck = decks.find((deck) => deck.stateClass === 'playing');
          const label = [
            masterDeck ? 'MASTER D' + masterDeck.id : '等待 MASTER',
            liveDeck ? 'LIVE D' + liveDeck.id : ''
          ].filter(Boolean).join(' / ');
          const text = els.masterWatch.querySelector('strong');
          if (text && text.textContent !== label) text.textContent = label;
          els.masterWatch.classList.toggle('has-master', Boolean(masterDeck));
          els.masterWatch.classList.toggle('has-live', Boolean(liveDeck));
        }

        function buildDecks(monitor) {
          if (Array.isArray(monitor.decks)) return monitor.decks.map(normalizeVjDeck);

          const devices = monitor.devices || [];
        const statuses = monitor.statuses || [];
        const metadata = monitor.metadata || [];
        const cues = monitor.cues || [];
        const beatGrids = monitor.beatGrids || [];
        const artwork = monitor.artwork || [];
        const waveforms = monitor.waveforms || [];
        const nowMs = Date.now();
        const ids = new Set([1, 2, 3, 4]);
        devices.forEach((item) => ids.add(Number(item.id)));
        statuses.forEach((item) => ids.add(Number(item.deviceId)));
        const metaByDeck = new Map(metadata.map((item) => [Number(item.layerId || item.deviceId), item]));
        const cuesByDeck = new Map(cues.map((item) => [Number(item.layerId || item.deviceId), item]));
        const beatGridByDeck = new Map(beatGrids.map((item) => [Number(item.layerId || item.deviceId), item]));
        const artworkByDeck = new Map(artwork.map((item) => [Number(item.layerId || item.deviceId), item]));
        const wfByDeck = buildWaveformLookup(waveforms, state.waveformSettings.mode);

          return Array.from(ids).filter((id) => Number.isFinite(id) && id > 0).sort((a, b) => a - b).slice(0, 8).map((id) => {
          const device = devices.find((item) => Number(item.id) === id);
          const status = statuses.find((item) => Number(item.deviceId) === id) || {};
          const rawMeta = metaByDeck.get(id) || null;
          const rawWaveformData = wfByDeck.get(id) || null;
          const rawCueList = cuesByDeck.get(id) || null;
          const rawBeatGrid = beatGridByDeck.get(id) || null;
          const rawCover = artworkByDeck.get(id) || null;
          const meta = dataMatchesDeckTrack(rawMeta, status) ? rawMeta : {};
          const rawWaveform = dataMatchesDeckTrack(rawWaveformData, status) ? rawWaveformData : null;
          const cueList = dataMatchesDeckTrack(rawCueList, status) ? rawCueList : null;
          const beatGrid = dataMatchesDeckTrack(rawBeatGrid, status) ? rawBeatGrid : null;
          const cover = dataMatchesDeckTrack(rawCover, status) ? rawCover : null;
          const elapsedMs = projectPlaybackPositionMs(status, beatGrid, nowMs);
          const totalMs = firstNumber(status.trackLengthMs, meta.trackLengthMs, rawWaveform?.totalTimeMs);
          const remainingMs = totalMs !== null && elapsedMs !== null ? Math.max(0, totalMs - elapsedMs) : null;
          const waveform = rawWaveform ? Object.assign({}, rawWaveform, {
            playheadRatio: totalMs && elapsedMs !== null ? Math.max(0, Math.min(1, elapsedMs / totalMs)) : null
          }) : null;
          const rawState = status.playStateName || (status.lastBeatPacket ? 'Beat' : device ? 'Linked' : 'No Link');
          const stateClass = deckStateClass(device, rawState, status);
          return {
            id,
            trackKey: trackReferenceKeyFromStatus(status),
            connected: Boolean(device || status.lastSeen || status.lastBeatPacket),
            title: status.title || meta.title || (device ? (device.name || 'CDJ') + ' 已连接' : '等待曲名数据'),
            artist: status.artist || meta.artist || '',
            bpm: firstNumber(status.effectiveBpm, status.trackBpm, meta.tempo),
            state: statusNameZh(rawState),
            stateBadge: deckStateBadge(stateClass, rawState),
            stateClass,
            elapsedMs,
            totalMs,
            remainingMs,
            waveform,
            cueList,
            beatGrid,
            artwork: cover,
            dbRequest: null,
            ip: device?.ip || status.source || '-',
            beat: firstNumber(status.beatInMeasure),
            isMaster: Boolean(status.isMaster),
            isSync: Boolean(status.isSync),
            isOnAir: Boolean(status.isOnAir)
          };
          });
        }

        function normalizeVjDeck(deck) {
          const stateClass = deck.playing ? 'playing' : deck.connected ? 'standby' : 'offline';
          const waveforms = Array.isArray(deck.waveforms) ? deck.waveforms : [];
          const waveform = chooseWaveform(waveforms, state.waveformSettings.mode) || deck.waveform || null;
          return {
            id: deck.id,
            trackKey: deck.trackKey || null,
            connected: Boolean(deck.connected),
            title: deck.title || (deck.connected ? (deck.name || 'CDJ') + ' 已连接' : '等待曲名数据'),
            artist: deck.artist || '',
            bpm: firstNumber(deck.bpm),
            state: deck.stateLabel || statusNameZh(deck.state),
            stateBadge: deck.playing ? '正在播放' : deck.connected ? '待播' : '未连接',
            stateClass,
            elapsedMs: firstNumber(deck.elapsedMs),
            totalMs: firstNumber(deck.totalMs),
            remainingMs: firstNumber(deck.remainingMs),
            waveform: waveform ? Object.assign({}, waveform, {playheadRatio: deck.progress ?? waveform.playheadRatio ?? null}) : null,
            waveforms,
            cueList: deck.cues || null,
            beatGrid: deck.beatGrid || null,
            artwork: null,
            dbRequest: deck.db || null,
            ip: '',
            beat: firstNumber(deck.beatInMeasure),
            isMaster: Boolean(deck.master),
            isSync: Boolean(deck.sync),
            isOnAir: Boolean(deck.onAir)
          };
        }

      function mergeMonitorState(previousState, nextState) {
        if (!previousState || !Array.isArray(previousState.decks) || !Array.isArray(nextState?.decks)) return nextState || {};
        const previousById = new Map(previousState.decks.map((deck) => [Number(deck.id), deck]));
        const sameHeavyRevision = nextState.heavyRevision === previousState.heavyRevision;
        return Object.assign({}, nextState, {
          decks: nextState.decks.map((deck) => mergeDeckHeavyData(previousById.get(Number(deck.id)), deck, sameHeavyRevision))
        });
      }

      function mergeDeckHeavyData(previousDeck, nextDeck, sameHeavyRevision) {
        if (!previousDeck || !nextDeck) return nextDeck;
        const sameTrack = Boolean(nextDeck.trackKey) && nextDeck.trackKey === previousDeck.trackKey;
        if (!sameTrack || !sameHeavyRevision) return nextDeck;

        const merged = Object.assign({}, nextDeck);
        if (!Array.isArray(merged.waveforms) || !merged.waveforms.length) merged.waveforms = previousDeck.waveforms;
        if (!merged.waveform) merged.waveform = previousDeck.waveform;
        if (!merged.cues) merged.cues = previousDeck.cues;
        if (!merged.beatGrid) merged.beatGrid = previousDeck.beatGrid;
        return merged;
      }

      function dataMatchesDeckTrack(item, status) {
        if (!item) return false;
        const dataTrackId = firstNumber(item.trackId);
        if (dataTrackId === null) return true;
        const statusTrackId = firstNumber(status?.trackId);
        return statusTrackId !== null && dataTrackId === statusTrackId;
      }

      function buildWaveformLookup(waveforms, mode) {
        const grouped = new Map();
        (waveforms || []).forEach((waveform) => {
          const id = Number(waveform.layerId);
          if (!Number.isFinite(id)) return;
          const list = grouped.get(id) || [];
          list.push(waveform);
          grouped.set(id, list);
        });
        const byDeck = new Map();
        grouped.forEach((items, id) => byDeck.set(id, chooseWaveform(items, mode)));
        return byDeck;
      }

      function chooseWaveform(waveforms, mode) {
        const normalizedMode = waveformModes.has(mode) ? mode : 'auto';
        const exact = normalizedMode === 'auto' ? waveforms : waveforms.filter((waveform) => waveform.style === normalizedMode);
        const pool = exact.length ? exact : waveforms;
        return pool.slice().sort((a, b) => waveformScore(b, normalizedMode) - waveformScore(a, normalizedMode))[0] || null;
      }

      function waveformScore(waveform, mode) {
        const styleScore = {'three-band': 90, rgb: 80, blue: 70};
        const exactBonus = mode !== 'auto' && waveform.style === mode ? 100 : 0;
        const base = styleScore[waveform.style] || (waveform.kind === 'big' ? 60 : 50);
        const kindBonus = waveform.kind === 'big' ? 5 : 0;
        return exactBonus + base + kindBonus;
      }

      function renderDeck(deck, index) {
        const art = deck.artwork?.dataUrl ? '<img class="art" src="' + esc(deck.artwork.dataUrl) + '" alt="" />' : '<span class="art empty"></span>';
        const cueLabel = deck.cueList ? 'Cue ' + (deck.cueList.hotCueCount || 0) + ' Loop ' + (deck.cueList.loopCount || 0) : '等待Cue';
        const beatGridLabel = deck.beatGrid ? '网格 ' + (deck.beatGrid.beatCount || 0) + '拍' : '等待网格';
        const waveformLabel = deck.waveform ? waveformStyleLabel(deck.waveform) + ' ' + waveformPointLabel(deck.waveform) : dbRequestLabel(deck.dbRequest);
        const liveBadge = deck.stateClass === 'playing' ? '<b class="live-chip">LIVE</b>' : '';
        const masterBadge = deck.isMaster ? '<b class="master-chip">MASTER</b>' : '';
        return '<article class="state-' + esc(deck.stateClass) + (deck.isMaster ? ' master' : '') + '">' +
          '<div class="deck-top"><div class="deck-identity"><span>DECK ' + esc(deck.id) + '</span>' + liveBadge + '</div><div class="deck-alerts">' + masterBadge + '<strong class="state" title="' + esc(deck.state) + '">' + esc(deck.stateBadge) + '</strong></div></div>' +
          '<div class="track">' + art + '<div class="track-copy"><h2>' + esc(deck.title) + '</h2><p>' + esc(deck.artist || ' ') + '</p></div></div>' +
          '<div class="bpm"><span>实时BPM</span><strong>' + esc(deck.bpm !== null ? Number(deck.bpm).toFixed(2) : '--.--') + '</strong></div>' +
          '<div class="times">' +
            timeBox('正计时', deck.elapsedMs !== null ? formatDuration(deck.elapsedMs) : '--:--.---') +
            timeBox('倒计时', deck.remainingMs !== null ? '-' + formatDuration(deck.remainingMs) : '--:--.---') +
            timeBox('总时长', deck.totalMs !== null ? formatDuration(deck.totalMs) : '--:--.---') +
          '</div>' +
          '<canvas id="wf' + index + '" width="960" height="180"></canvas>' +
          '<div class="foot"><div class="flags">' +
            flag('播出', deck.isOnAir, '') + flag('同步', deck.isSync, '') + flag('主控', deck.isMaster, 'master') +
          '</div><span>拍位 ' + esc(deck.beat !== null ? deck.beat : '-') + ' / ' + esc(cueLabel) + ' / ' + esc(beatGridLabel) + ' / ' + esc(waveformLabel) + '</span></div>' +
        '</article>';
      }

      function timeBox(label, value) {
        return '<div class="timebox"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
      }

      function flag(label, on, extraClass) {
        const classes = ['flag'];
        if (on) classes.push('on');
        if (on && extraClass) classes.push(extraClass);
        return '<span class="' + classes.join(' ') + '">' + esc(label) + '</span>';
      }

      function drawWaveform(canvas, deck, settings) {
        if (!canvas) return;
        const waveform = deck?.waveform || null;
        const waveformSettings = normalizeWaveformSettings(settings);
        const prepared = prepareWaveformCanvas(canvas);
        const ctx = prepared.ctx;
        const width = prepared.width;
        const height = prepared.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#0b1110';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        if (!waveform || !Array.isArray(waveform.points) || !waveform.points.length) {
          ctx.fillStyle = 'rgba(170,184,180,0.72)';
          ctx.font = '18px system-ui, sans-serif';
          ctx.fillText('等待波形数据', 18, 34);
          return;
        }
        try {
          const waveformImage = getNaturalWaveformImage(waveform, waveformSettings);
          const viewport = getWaveformViewport(width, deck, waveform, waveformSettings);
          drawWaveformBackgroundAnnotations(ctx, width, height, deck, viewport);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(waveformImage, viewport.imageX, 0, viewport.imageWidth, height);
          drawWaveformForegroundAnnotations(ctx, width, height, deck, viewport);
          if (waveform.playheadRatio !== null && waveform.playheadRatio !== undefined) {
            drawPlayheadLine(ctx, viewport.playheadX, height);
          }
        } catch (error) {
          console.warn('Waveform draw failed', error);
          ctx.fillStyle = 'rgba(170,184,180,0.72)';
          ctx.font = '18px system-ui, sans-serif';
          ctx.fillText('波形绘制等待下一帧', 18, 34);
        }
      }

      function getWaveformViewport(width, deck, waveform, settings) {
        const progress = waveform?.playheadRatio !== null && waveform?.playheadRatio !== undefined ? clampRatio(waveform.playheadRatio) : null;
        if (settings.viewMode !== 'follow' || progress === null) {
          return {
            imageX: 0,
            imageWidth: width,
            playheadX: progress === null ? null : Math.round(width * progress)
          };
        }

        const totalMs = firstNumber(deck?.totalMs, waveform?.totalTimeMs);
        const visibleRatio = totalMs && totalMs > 0 ? clampNumber(followWaveformWindowMs / totalMs, 0.12, 1, 0.25) : 0.25;
        const imageWidth = Math.max(width, Math.round(width / visibleRatio));
        const playheadX = Math.round(width * 0.5);
        return {
          imageX: Math.round(playheadX - imageWidth * progress),
          imageWidth,
          playheadX
        };
      }

      function drawPlayheadLine(ctx, x, height) {
        if (x === null || x === undefined) return;
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(255,255,255,0.72)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, height - 8);
        ctx.stroke();
        ctx.restore();
      }

      function drawWaveformBackgroundAnnotations(ctx, width, height, deck, viewport) {
        const totalMs = firstNumber(deck?.totalMs, deck?.waveform?.totalTimeMs);
        if (!totalMs || totalMs <= 0) return;
        drawLoopRegions(ctx, width, height, deck?.cueList, totalMs, viewport);
      }

      function drawWaveformForegroundAnnotations(ctx, width, height, deck, viewport) {
        const totalMs = firstNumber(deck?.totalMs, deck?.waveform?.totalTimeMs);
        if (!totalMs || totalMs <= 0) return;
        drawBeatGridMarkers(ctx, width, height, deck?.beatGrid, totalMs, viewport);
        drawCueMarkers(ctx, width, height, deck?.cueList, totalMs, viewport);
      }

      function drawLoopRegions(ctx, width, height, cueList, totalMs, viewport) {
        (cueList?.cues || []).forEach((cue) => {
          if (!cue.isLoop || cue.loopMs === null || cue.loopMs === undefined) return;
          const x = timeToWaveformX(cue.positionMs, totalMs, width, viewport);
          const endX = timeToWaveformX(cue.loopMs, totalMs, width, viewport);
          const left = Math.max(0, Math.min(x, endX));
          const right = Math.min(width, Math.max(x, endX));
          if (right <= left) return;
          const color = normalizeHexColor(cue.color) || '#e5b552';
          ctx.fillStyle = hexToRgba(color, cue.hotCueNumber ? 0.22 : 0.16);
          ctx.fillRect(left, 0, Math.max(1, right - left), height);
          ctx.strokeStyle = hexToRgba(color, 0.68);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(left + 0.5, 0);
          ctx.lineTo(left + 0.5, height);
          ctx.moveTo(right - 0.5, 0);
          ctx.lineTo(right - 0.5, height);
          ctx.stroke();
        });
      }

      function drawBeatGridMarkers(ctx, width, height, beatGrid, totalMs, viewport) {
        const beats = beatGrid?.beats || [];
        if (!beats.length) return;
        const dense = beats.length > 360;
        ctx.save();
        ctx.lineWidth = 1;
        beats.forEach((beat) => {
          const timeMs = Number(beat?.[0]);
          const beatWithinBar = Number(beat?.[1] || 0);
          if (!Number.isFinite(timeMs)) return;
          if (dense && beatWithinBar !== 1) return;
          const x = timeToWaveformX(timeMs, totalMs, width, viewport);
          if (x < 0 || x > width) return;
          const downbeat = beatWithinBar === 1;
          ctx.globalAlpha = downbeat ? 0.95 : 0.52;
          ctx.strokeStyle = downbeat ? 'rgba(255,255,255,0.52)' : 'rgba(255,255,255,0.22)';
          ctx.beginPath();
          ctx.moveTo(x, downbeat ? height - 34 : height - 15);
          ctx.lineTo(x, height - 2);
          ctx.stroke();
        });
        ctx.restore();
      }

      function drawCueMarkers(ctx, width, height, cueList, totalMs, viewport) {
        ctx.save();
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        (cueList?.cues || []).forEach((cue) => {
          const timeMs = Number(cue.positionMs);
          if (!Number.isFinite(timeMs)) return;
          const x = timeToWaveformX(timeMs, totalMs, width, viewport);
          if (x < 0 || x > width) return;
          const color = normalizeHexColor(cue.color) || (cue.isLoop ? '#e5b552' : '#55d682');
          if (cue.hotCueNumber) drawHotCueMarker(ctx, x, width, height, color, cue.label, cue.isLoop);
          else drawMemoryCueMarker(ctx, x, width, height, color, cue.isLoop);
        });
        ctx.restore();
      }

      function timeToWaveformX(timeMs, totalMs, width, viewport) {
        const ratio = totalMs ? clampRatio(Number(timeMs || 0) / totalMs) : 0;
        if (!viewport) return Math.round(ratio * width);
        return Math.round(viewport.imageX + ratio * viewport.imageWidth);
      }

      function drawHotCueMarker(ctx, x, width, height, color, label, isLoop) {
        const safeLabel = String(label || '').slice(0, 2) || 'H';
        const badgeText = isLoop ? safeLabel + ' LOOP' : safeLabel;
        ctx.save();
        ctx.shadowColor = hexToRgba(color, 0.75);
        ctx.shadowBlur = 8;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.font = '700 11px system-ui, sans-serif';
        const badgeWidth = Math.max(isLoop ? 42 : 24, Math.ceil(ctx.measureText(badgeText).width) + 12);
        const badgeHeight = 18;
        const badgeX = Math.max(3, Math.min(width - badgeWidth - 3, x - Math.round(badgeWidth / 2)));
        ctx.fillStyle = color;
        ctx.fillRect(badgeX, 4, badgeWidth, badgeHeight);
        ctx.beginPath();
        ctx.moveTo(x, 4 + badgeHeight + 7);
        ctx.lineTo(x - 6, 4 + badgeHeight);
        ctx.lineTo(x + 6, 4 + badgeHeight);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = readableTextColor(color);
        ctx.textAlign = 'center';
        ctx.fillText(badgeText, badgeX + badgeWidth / 2, 7);
        ctx.restore();
      }

      function drawMemoryCueMarker(ctx, x, width, height, color, isLoop) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x - 6, 11);
        ctx.lineTo(x + 6, 11);
        ctx.closePath();
        ctx.fill();
        const label = isLoop ? 'Loop' : 'Cue';
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.fillText(label, Math.min(width - 30, Math.max(4, x + 7)), 8);
        ctx.restore();
      }

      function prepareWaveformCanvas(canvas) {
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width || canvas.width || 1));
        const height = Math.max(1, Math.round(rect.height || canvas.height || 1));
        const pixelWidth = Math.max(1, Math.round(width * ratio));
        const pixelHeight = Math.max(1, Math.round(height * ratio));
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return {ctx, width, height};
      }

      function getNaturalWaveformImage(waveform, settings) {
        const key = waveformImageCacheKey(waveform, settings);
        const cached = waveformImageCache.get(key);
        if (cached) {
          waveformImageCache.delete(key);
          waveformImageCache.set(key, cached);
          return cached;
        }
        const image = createNaturalWaveformImage(waveform, settings);
        waveformImageCache.set(key, image);
        while (waveformImageCache.size > maxWaveformImageCache) {
          waveformImageCache.delete(waveformImageCache.keys().next().value);
        }
        return image;
      }

      function waveformImageCacheKey(waveform, settings) {
        return [
          waveform.layerId || '',
          waveform.trackId || '',
          waveform.dbKey || '',
          waveform.kind || '',
          waveform.style || '',
          waveform.pointCount || waveform.points?.length || 0,
          waveform.originalPointCount || '',
          waveform.totalTimeMs || '',
          Math.round((settings.heightScale || 1) * 100),
          Math.round((settings.brightness || 1) * 100)
        ].join('|');
      }

      function createNaturalWaveformImage(waveform, settings) {
        const points = waveform.points || [];
        const naturalWidth = Math.max(1, points.length);
        const naturalHeight = maxNaturalWaveformHeight(points, waveform.style);
        const image = document.createElement('canvas');
        image.width = naturalWidth;
        image.height = naturalHeight;
        const ctx = image.getContext('2d');
        ctx.clearRect(0, 0, naturalWidth, naturalHeight);
        for (let segment = 0; segment < points.length; segment += 1) {
          const point = points[segment] || [];
          if (waveform.style === 'rgb' && point.length >= 8) {
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[0], rgbColor(point[1], point[2], point[3], settings.brightness), settings.heightScale);
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[4], rgbColor(point[5], point[6], point[7], settings.brightness), settings.heightScale);
          } else if (waveform.style === 'three-band' && point.length >= 3) {
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[2], rgbColor(255, 255, 255, settings.brightness), settings.heightScale);
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[1], rgbColor(242, 170, 60, settings.brightness), settings.heightScale);
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[0], rgbColor(32, 83, 217, settings.brightness), settings.heightScale);
          } else {
            drawNaturalWaveformBar(ctx, segment, naturalHeight, point[0], pointColor(point, waveform.style, settings.brightness), settings.heightScale);
          }
        }
        return image;
      }

      function maxNaturalWaveformHeight(points, style) {
        let max = 1;
        points.forEach((point) => {
          if (style === 'three-band') max = Math.max(max, Number(point?.[0] || 0), Number(point?.[1] || 0), Number(point?.[2] || 0));
          else max = Math.max(max, Number(point?.[0] || 0));
        });
        return Math.max(1, Math.ceil(max));
      }

      function drawNaturalWaveformBar(ctx, x, naturalHeight, level, color, heightScale) {
        const barHeight = Math.max(1, Math.min(naturalHeight, Math.round(Number(level || 0) * heightScale)));
        ctx.fillStyle = color;
        ctx.fillRect(x, naturalHeight - barHeight, 1, barHeight);
      }

      function clampRatio(ratio) {
        return Math.max(0, Math.min(1, Number(ratio || 0)));
      }

      function waveformStyleLabel(waveform) {
        if (waveform?.style === 'three-band') return '3Band';
        if (waveform?.style === 'rgb') return 'RGB';
        if (waveform?.style === 'blue') return 'Blue';
        return waveform?.kind || 'wave';
      }

      function waveformPointLabel(waveform) {
        const pointCount = Number(waveform?.pointCount || 0);
        const originalPointCount = Number(waveform?.originalPointCount || 0);
        if (originalPointCount && originalPointCount !== pointCount) return pointCount + '/' + originalPointCount + '点';
        return pointCount + '点';
      }

      function dbRequestLabel(request) {
        if (!request) return '等待波形';
        if (request.state === 'pending') return request.stage === 'cue' ? '请求Cue' : '请求曲库/波形';
        if (request.state === 'ready') {
          const count = Number(request.waveformCount || 0);
          return count ? '曲库已回填 ' + count + '组波形' : '曲库已回填';
        }
        if (request.state === 'stale') return '曲目变化，等待回填';
        if (request.state === 'unavailable') return '曲库暂无数据';
        if (request.state === 'failed') return request.message ? '曲库失败 ' + String(request.message).slice(0, 24) : '曲库请求失败';
        return '等待波形';
      }

      function trackReferenceKeyFromStatus(status) {
        const trackId = firstNumber(status?.trackId);
        const trackDeviceId = firstNumber(status?.trackDeviceId);
        const trackSlot = firstNumber(status?.trackSlot);
        const trackType = firstNumber(status?.trackType);
        if (!trackId || !trackDeviceId || !trackSlot || !trackType) return null;
        return trackDeviceId + ':' + trackSlot + ':' + trackType + ':' + trackId;
      }

      function pointColor(point, style, brightness) {
        if (style === 'rgb' && point.length >= 4) return rgbColor(point[1], point[2], point[3], brightness);
        return rgbColor(point[1], point[1], 255, brightness);
      }

      function rgbColor(red, green, blue, brightness) {
        return 'rgb(' + clampColor(red, brightness) + ',' + clampColor(green, brightness) + ',' + clampColor(blue, brightness) + ')';
      }

      function clampColor(value, brightness) {
        return Math.max(0, Math.min(255, Math.round(Number(value || 0) * brightness)));
      }

      function normalizeHexColor(color) {
        if (typeof color !== 'string') return null;
        const trimmed = color.trim();
        if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
        if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
          return '#' + trimmed.slice(1).split('').map((part) => part + part).join('');
        }
        return null;
      }

      function hexToRgba(color, alpha) {
        const normalized = normalizeHexColor(color);
        if (!normalized) return 'rgba(85, 214, 130, ' + alpha + ')';
        const red = Number.parseInt(normalized.slice(1, 3), 16);
        const green = Number.parseInt(normalized.slice(3, 5), 16);
        const blue = Number.parseInt(normalized.slice(5, 7), 16);
        return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + alpha + ')';
      }

      function readableTextColor(color) {
        const normalized = normalizeHexColor(color);
        if (!normalized) return '#08110e';
        const red = Number.parseInt(normalized.slice(1, 3), 16);
        const green = Number.parseInt(normalized.slice(3, 5), 16);
        const blue = Number.parseInt(normalized.slice(5, 7), 16);
        return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#08110e' : '#ffffff';
      }

      function formatDuration(ms) {
        const safe = Math.max(0, Number(ms || 0));
        const minutes = Math.floor(safe / 60000);
        const seconds = Math.floor((safe % 60000) / 1000);
        const millis = Math.floor(safe % 1000);
        return minutes + ':' + String(seconds).padStart(2, '0') + '.' + String(millis).padStart(3, '0');
      }

      function statusNameZh(value) {
        const map = {Playing: '播放中', Looping: '循环中', Paused: '暂停', Cued: '待播', Beat: '节拍中', Linked: '已连接', 'No Link': '未连接'};
        return map[value] || value || '未知';
      }

      function deckStateClass(device, rawState, status) {
        if (Boolean(status.isPlayingFlag) || ['Playing', 'Looping', 'Beat'].includes(rawState)) return 'playing';
        if (device) return 'standby';
        return 'offline';
      }

      function deckStateBadge(stateClass, rawState) {
        if (stateClass === 'playing') return '正在播放';
        if (stateClass === 'standby') return '待播';
        return statusNameZh(rawState);
      }

      function projectPlaybackPositionMs(status, beatGrid, nowMs) {
        const positionMs = firstNumber(status?.positionMs);
        if (positionMs !== null) return projectPositionAnchor(positionMs, status?.positionLastSeen, status, nowMs);
        const beatNumber = firstNumber(status?.beat);
        const beatPositionMs = beatNumber !== null ? timeOfBeatGrid(beatGrid, beatNumber) : null;
        if (beatPositionMs !== null) return projectPositionAnchor(beatPositionMs, status?.lastSeen, status, nowMs);
        return null;
      }

      function projectPositionAnchor(positionMs, timestamp, status, nowMs) {
        const timestampMs = Date.parse(timestamp || '');
        if (!Number.isFinite(timestampMs)) return positionMs;
        const isMoving = Boolean(status.isPlayingFlag) || ['Playing', 'Looping', 'Beat'].includes(status.playStateName);
        if (!isMoving) return positionMs;
        const ageMs = Math.max(0, Math.min(2000, nowMs - timestampMs));
        const projected = positionMs + ageMs * playbackSpeedFactor(status);
        const totalMs = firstNumber(status.trackLengthMs);
        return totalMs === null ? projected : Math.min(totalMs, projected);
      }

      function timeOfBeatGrid(beatGrid, beatNumber) {
        const beats = beatGrid?.beats || [];
        if (!beats.length || beatNumber < 0) return null;
        if (beatNumber === 0) return 0;
        const index = Math.min(beats.length - 1, Math.max(0, Math.round(beatNumber) - 1));
        const timeMs = Number(beats[index]?.[0]);
        if (!Number.isFinite(timeMs)) return null;
        if (beatNumber <= beats.length || beats.length < 2) return timeMs;
        const previous = Number(beats[beats.length - 2]?.[0]);
        if (!Number.isFinite(previous)) return timeMs;
        return timeMs + (timeMs - previous) * (beatNumber - beats.length);
      }

      function playbackSpeedFactor(status) {
        const pitchPercent = firstNumber(status?.precisePitchPercent, status?.effectivePitch, status?.sliderPitch);
        if (pitchPercent === null) return 1;
        return Math.max(0.25, Math.min(4, 1 + pitchPercent / 100));
      }

      function readWaveformSettings() {
        try {
          return normalizeWaveformSettings(JSON.parse(localStorage.getItem(WAVEFORM_SETTINGS_STORAGE_KEY) || '{}'));
        } catch (_error) {
          return Object.assign({}, defaultWaveformSettings);
        }
      }

      function syncWaveformControls() {
        const settings = normalizeWaveformSettings(state.waveformSettings);
        els.waveformModeSelect.value = settings.mode;
        els.waveformViewSelect.value = settings.viewMode;
        els.waveformHeightScale.value = String(Math.round(settings.heightScale * 100));
        els.waveformBrightness.value = String(Math.round(settings.brightness * 100));
      }

      function updateWaveformSettingsFromControls() {
        state.waveformSettings = normalizeWaveformSettings({
          mode: els.waveformModeSelect.value,
          viewMode: els.waveformViewSelect.value,
          heightScale: Number(els.waveformHeightScale.value) / 100,
          brightness: Number(els.waveformBrightness.value) / 100
        });
        localStorage.setItem(WAVEFORM_SETTINGS_STORAGE_KEY, JSON.stringify(state.waveformSettings));
        render(state.monitor);
      }

      function normalizeWaveformSettings(settings) {
        settings = settings || {};
        return {
          mode: waveformModes.has(settings.mode) ? settings.mode : defaultWaveformSettings.mode,
          viewMode: waveformViewModes.has(settings.viewMode) ? settings.viewMode : defaultWaveformSettings.viewMode,
          heightScale: clampNumber(settings.heightScale, 0.7, 1.5, defaultWaveformSettings.heightScale),
          brightness: clampNumber(settings.brightness, 0.7, 1.5, defaultWaveformSettings.brightness)
        };
      }

      function clampNumber(value, min, max, fallback) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.max(min, Math.min(max, numeric));
      }

      function applyLayout() {
        state.layout = normalizeLayout(state.layout);
        els.grid.className = 'layout-' + state.layout;
        els.layoutSelect.value = state.layout;
      }

      function normalizeLayout(layout) {
        return layouts.has(layout) ? layout : 'auto';
      }

      function firstNumber(...values) {
        for (const value of values) {
          if (value === null || value === undefined || value === '') continue;
          const numeric = Number(value);
          if (Number.isFinite(numeric)) return numeric;
        }
        return null;
      }

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[char]));
      }
    </script>
  </body>
</html>`;
}

function encodeOscMessage(address, value) {
  const type = Number.isInteger(value) ? 'i' : typeof value === 'number' ? 'f' : 's';
  const parts = [oscString(address), oscString(`,${type}`)];

  if (type === 'i') {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(value);
    parts.push(buf);
  } else if (type === 'f') {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value);
    parts.push(buf);
  } else {
    parts.push(oscString(String(value)));
  }

  return Buffer.concat(parts);
}

function oscString(value) {
  const raw = Buffer.from(`${value}\0`, 'utf8');
  const padding = (4 - (raw.length % 4)) % 4;
  return Buffer.concat([raw, Buffer.alloc(padding)]);
}

function formatTimecode(ms, fps = DEFAULT_TIMECODE_FPS) {
  const frameRate = normalizeTimecodeFps(fps);
  const totalFrames = Math.max(0, Math.floor((Number(ms || 0) * frameRate) / 1000));
  const frames = totalFrames % frameRate;
  const totalSeconds = Math.floor(totalFrames / frameRate);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return [hours, minutes, seconds, frames].map((part) => String(part).padStart(2, '0')).join(':');
}

function timecodeFrame(ms, fps = DEFAULT_TIMECODE_FPS) {
  const frameRate = normalizeTimecodeFps(fps);
  return Math.max(0, Math.floor((Number(ms || 0) * frameRate) / 1000));
}

function normalizeTimecodeFps(value) {
  const numeric = Math.round(Number(value || DEFAULT_TIMECODE_FPS));
  if ([24, 25, 30].includes(numeric)) return numeric;
  return DEFAULT_TIMECODE_FPS;
}

function normalizeLtcSourceMode(value) {
  const text = String(value || 'auto').trim().toLowerCase();
  return /^deck-[1-4]$/.test(text) ? text : 'auto';
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function resolvePublishedTiming(status, canonicalTiming, options = {}) {
  const supplied = canonicalTiming !== null && canonicalTiming !== undefined;
  const elapsedMs = firstFiniteNumber(canonicalTiming?.elapsedMs);
  if (supplied && elapsedMs === null) return null;

  const resolvedElapsedMs = elapsedMs ?? firstFiniteNumber(
    status.positionMs,
    status.elapsedMs,
    status.playbackPositionMs,
    status.timeMs
  );
  if (resolvedElapsedMs === null) return null;

  const totalMs = firstFiniteNumber(canonicalTiming?.totalMs, status.trackLengthMs, status.totalMs, status.durationMs);
  const remainingMs = firstFiniteNumber(canonicalTiming?.remainingMs) ??
    (totalMs === null ? null : Math.max(0, totalMs - resolvedElapsedMs));
  const progress = firstFiniteNumber(canonicalTiming?.progress) ??
    (totalMs && totalMs > 0 ? Math.max(0, Math.min(1, resolvedElapsedMs / totalMs)) : null);
  const frame = firstFiniteNumber(canonicalTiming?.frame) ??
    timecodeFrame(resolvedElapsedMs + Number(options.timecodeOffsetMs || 0), options.timecodeFps);
  const timecode = canonicalTiming?.timecode ||
    formatTimecode(resolvedElapsedMs + Number(options.timecodeOffsetMs || 0), options.timecodeFps);

  return {
    elapsedMs: resolvedElapsedMs,
    totalMs,
    remainingMs,
    progress,
    frame,
    timecode,
    source: canonicalTiming?.source || 'explicit',
    stale: Boolean(canonicalTiming?.stale)
  };
}

function normalizeArenaBpm(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(20, Math.min(500, Number(numeric.toFixed(2))));
}

function normalizeBeatInMeasure(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1) return null;
  return ((numeric - 1) % 4) + 1;
}

function isDeckActivelyPlaying(status = {}) {
  return Boolean(status.isPlayingFlag) || ['Playing', 'Looping', 'Beat'].includes(status.playStateName);
}

function playbackRateFromStatus(status = {}) {
  const pitchPercent = firstFiniteNumber(status.precisePitchPercent, status.effectivePitch, status.sliderPitch);
  if (pitchPercent === null) return 1;
  return Math.max(0.25, Math.min(4, 1 + pitchPercent / 100));
}

function beatToMeasure(beat) {
  const numeric = Math.round(Number(beat));
  if (!Number.isFinite(numeric) || numeric < 1) return null;
  return ((numeric - 1) % 4) + 1;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function arenaPioneerSourcePortFromListener(listenerPort) {
  const port = Number(listenerPort) - ARENA_PIONEER_SOURCE_PORT_OFFSET;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function tcnetLayerFromStatus(status, timing) {
  const deck = clampInteger(timing.deck, 1, 8, 1);
  const playing = isDeckActivelyPlaying(status);
  const paused = ['Paused', 'Cue Down', 'Hold'].includes(status.playStateName);
  const trackId = firstFiniteNumber(status.trackId) || stableTrackId(status, deck);
  const pitchPercent = firstFiniteNumber(status.precisePitchPercent, status.effectivePitch, status.sliderPitch);
  return {
    id: deck,
    deck,
    name: `D${deck}`,
    source: deck,
    state: playing ? 3 : paused ? 5 : status.trackId ? 6 : 0,
    playing,
    syncMaster: Boolean(status.isMaster),
    onAir: Boolean(status.isOnAir || status.isMaster),
    beatMarker: normalizeBeatInMeasure(timing.beatInMeasure) || 0,
    beatNumber: firstFiniteNumber(status.beat) || 0,
    bpm: normalizeArenaBpm(timing.bpm) || 0,
    timeMs: Math.max(0, Math.round(Number(timing.elapsedMs || 0))),
    totalTimeMs: Math.max(0, Math.round(Number(timing.totalMs || 0))),
    speedPercent: Math.max(1, Math.min(400, Number((100 + (pitchPercent || 0)).toFixed(2)))),
    trackId,
    title: status.title || status.trackTitle || '',
    artist: status.artist || ''
  };
}

function chooseArenaPioneerSource(layers) {
  return layers
    .slice()
    .sort((a, b) => arenaPioneerPriority(b) - arenaPioneerPriority(a) || a.id - b.id)[0] || null;
}

function arenaPioneerPriority(layer) {
  if (layer.syncMaster && layer.playing) return 40;
  if (layer.syncMaster) return 30;
  if (layer.onAir && layer.playing) return 25;
  if (layer.onAir) return 20;
  if (layer.playing) return 10;
  return 0;
}

function stableTrackId(status, deck) {
  const text = `${deck}|${status.trackDeviceId || ''}|${status.trackSlot || ''}|${status.trackType || ''}|${status.title || status.trackTitle || ''}|${status.artist || ''}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || deck;
}

function sanitizePublicMonitorState(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {running: false};
  const sanitized = {...state};
  if (Object.hasOwn(sanitized, 'waveformFailures')) {
    sanitized.waveformFailures = sanitizePublicWaveformFailureState(sanitized.waveformFailures);
  }
  if (sanitized.health && typeof sanitized.health === 'object' && !Array.isArray(sanitized.health)) {
    sanitized.health = {...sanitized.health};
    if (Object.hasOwn(sanitized.health, 'waveformFailures')) {
      sanitized.health.waveformFailures = sanitizePublicWaveformFailureState(sanitized.health.waveformFailures);
    }
  }
  return sanitized;
}

function sanitizePublicWaveformFailureState(state = {}) {
  const total = Number(state?.total);
  return {
    total: Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0,
    recent: Array.isArray(state?.recent) ? state.recent.map(sanitizePublicWaveformFailureEntry) : []
  };
}

function sanitizePublicWaveformFailureEntry(entry = {}) {
  const sanitized = {reason: sanitizePublicDiagnosticLabel(entry.reason, 'unknown')};
  const timestampMs = Date.parse(entry.timestamp || '');
  if (Number.isFinite(timestampMs)) sanitized.timestamp = new Date(timestampMs).toISOString();
  addPublicDiagnosticNumber(sanitized, 'deckId', entry.deckId);
  addPublicDiagnosticLabel(sanitized, 'stage', entry.stage);
  addPublicDiagnosticLabel(sanitized, 'waveformKind', entry.waveformKind);
  addPublicDiagnosticLabel(sanitized, 'waveformStyle', entry.waveformStyle);
  addPublicDiagnosticNumber(sanitized, 'pointCount', entry.pointCount);
  addPublicDiagnosticNumber(sanitized, 'waveformCount', entry.waveformCount);
  return sanitized;
}

function addPublicDiagnosticLabel(target, key, value) {
  const sanitized = sanitizePublicDiagnosticLabel(value);
  if (sanitized) target[key] = sanitized;
}

function addPublicDiagnosticNumber(target, key, value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) target[key] = numeric;
}

function sanitizePublicDiagnosticLabel(value, fallback = '') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function parseWebConsoleRequestUrl(request) {
  try {
    return new URL(String(request?.url || '/'), 'http://localhost');
  } catch (_error) {
    return null;
  }
}

function isWebConsoleOriginAllowed(request) {
  const originHeader = getRequestHeader(request, 'origin');
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string' || !originHeader.trim()) return false;

  const hostHeader = getRequestHeader(request, 'host');
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;

  try {
    const origin = new URL(originHeader.trim());
    if (!['http:', 'https:'].includes(origin.protocol)) return false;
    if (origin.username || origin.password || origin.search || origin.hash) return false;
    return origin.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch (_error) {
    return false;
  }
}

function isRawWebSocketOriginAllowed(request) {
  const originHeader = getRequestHeader(request, 'origin');
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string' || !originHeader.trim()) return false;

  try {
    const origin = new URL(originHeader.trim());
    if (!['http:', 'https:'].includes(origin.protocol)) return false;
    if (origin.username || origin.password || origin.search || origin.hash) return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(origin.hostname.toLowerCase());
  } catch (_error) {
    return false;
  }
}

function getRequestHeader(request, name) {
  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function rejectWebConsoleUpgrade(socket, statusCode, statusText) {
  const body = `${statusText}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
    );
  } catch (_error) {
    // The connection may already be closing; destruction below is authoritative.
  }
  socket.destroy();
}

function waitForListening(resource, onError = () => {}) {
  if (resource?.listening || resource?._server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const handleListening = () => {
      resource.off('error', handleError);
      resolve();
    };
    const handleError = (error) => {
      resource.off('listening', handleListening);
      onError(error);
      reject(error);
    };
    resource.once('listening', handleListening);
    resource.once('error', handleError);
  });
}

function terminateWebSocketClients(server) {
  if (!server?.clients) return;
  for (const client of server.clients) {
    try {
      if (typeof client.terminate === 'function') client.terminate();
      else client.close();
    } catch (_error) {
      // Closing is best effort; the server close below remains authoritative.
    }
  }
}

function closeResource(resource) {
  if (!resource || typeof resource.close !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      resource.close(finish);
      if (typeof resource.closeAllConnections === 'function') resource.closeAllConnections();
    } catch (_error) {
      finish();
    }
  });
}

function shouldRestoreAudioForReconfigure(previous = {}, next = {}) {
  if (!previous.timecodeDemoEnabled) return false;
  if (!next.timecodeDemoEnabled) return true;
  if (previous.timecodeDemoRouteAudio !== next.timecodeDemoRouteAudio) return true;
  if (String(previous.timecodeDemoVirtualAudioName || '') !== String(next.timecodeDemoVirtualAudioName || '')) return true;
  return String(previous.timecodeDemoVirtualAudioId || '') !== String(next.timecodeDemoVirtualAudioId || '');
}

function shouldRestoreAudioAfterFailedOpen(previous = {}, next = {}) {
  if (!next.timecodeDemoEnabled) return false;
  if (!previous.timecodeDemoEnabled) return true;
  if (previous.timecodeDemoRouteAudio !== next.timecodeDemoRouteAudio) return true;
  if (String(previous.timecodeDemoVirtualAudioName || '') !== String(next.timecodeDemoVirtualAudioName || '')) return true;
  return String(previous.timecodeDemoVirtualAudioId || '') !== String(next.timecodeDemoVirtualAudioId || '');
}

module.exports = {
  BridgeService,
  createRemoteMonitorHtml,
  encodeOscMessage,
  formatTimecode,
  isRawWebSocketOriginAllowed,
  sanitizePublicMonitorState,
  timecodeFrame
};
