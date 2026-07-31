const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BridgeService,
  createRemoteMonitorHtml,
  encodeOscMessage,
  formatTimecode,
  isRawWebSocketOriginAllowed,
  sanitizePublicMonitorState,
  timecodeFrame
} = require('../src/prolink/bridge.cjs');
const {parseTcnetPacket} = require('../src/prolink/tcnet.cjs');
const {computeDeckTiming} = require('../src/prolink/timing.cjs');

test('encodes OSC integer messages with 4 byte padding', () => {
  const message = encodeOscMessage('/vj/deck/1/onair', 1);

  assert.equal(readOscString(message, 0), '/vj/deck/1/onair');
  assert.equal(message.includes(Buffer.from(',i\0\0')), true);
  assert.equal(message.readInt32BE(message.length - 4), 1);
  assert.equal(message.length % 4, 0);
});

test('encodes OSC float messages', () => {
  const message = encodeOscMessage('/vj/deck/2/bpm', 128.5);

  assert.equal(message.includes(Buffer.from(',f\0\0')), true);
  assert.equal(message.readFloatBE(message.length - 4), 128.5);
});

test('publishes VJ deck status values over stable OSC addresses', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.oscSocket = {};
  bridge.options = {oscEnabled: true, timecodeFps: 25, timecodeOffsetMs: 0};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishStatus({
    deviceId: 1,
    effectiveBpm: 132.4,
    trackBpm: 128,
    beat: 1,
    beatInMeasure: 3,
    isPlayingFlag: true,
    isSync: true,
    isMaster: false,
    isOnAir: true,
    positionMs: 2000,
    trackLengthMs: 5000,
    trackId: 77,
    title: 'Track',
    artist: 'Artist',
    key: 'Cm'
  });

  assert.deepEqual(sent[0], {address: '/vj/deck/1/bpm', value: 132.4});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/playing'), {address: '/vj/deck/1/playing', value: 1});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/remaining'), {address: '/vj/deck/1/remaining', value: 3000});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/timecode'), {address: '/vj/deck/1/timecode', value: '00:00:02:00'});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/title'), {address: '/vj/deck/1/title', value: 'Track'});
});

test('publishes supplied canonical timing instead of raw status position', () => {
  const bridge = new BridgeService();
  const sent = [];
  const nowMs = Date.parse('2026-07-10T12:00:00.000Z');
  const timing = computeDeckTiming({
    deviceId: 2,
    beat: 10,
    lastSeen: nowMs - 100,
    isPlayingFlag: true,
    trackLengthMs: 60_000
  }, {
    beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
  }, {nowMs, fps: 25});

  bridge.oscSocket = {};
  bridge.options = {oscEnabled: true, timecodeFps: 25, timecodeOffsetMs: 0};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishStatus({
    deviceId: 2,
    positionMs: 0,
    trackLengthMs: 60_000,
    isPlayingFlag: true
  }, timing);

  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/2/elapsed'), {address: '/vj/deck/2/elapsed', value: 4600});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/2/timecode'), {address: '/vj/deck/2/timecode', value: '00:00:04:15'});
});

test('does not publish fake timing addresses when canonical timing is unavailable', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.oscSocket = {};
  bridge.options = {oscEnabled: true, timecodeFps: 25, timecodeOffsetMs: 0};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishStatus({
    deviceId: 1,
    effectiveBpm: 128,
    isPlayingFlag: true,
    title: 'Track'
  }, {
    deck: 1,
    elapsedMs: null,
    totalMs: null,
    remainingMs: null,
    progress: null,
    source: 'none',
    frame: null,
    timecode: null
  });

  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/bpm'), {address: '/vj/deck/1/bpm', value: 128});
  assert.deepEqual(sent.find((item) => item.address === '/vj/deck/1/timingValid'), {address: '/vj/deck/1/timingValid', value: 0});
  for (const suffix of ['elapsed', 'remaining', 'progress', 'timecode', 'timecode/frame']) {
    assert.equal(sent.find((item) => item.address === `/vj/deck/1/${suffix}`), undefined);
  }
});

test('does not coerce missing relayed TCNet layer timing to zero', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.oscSocket = {};
  bridge.options = {oscEnabled: true, timecodeFps: 25, timecodeOffsetMs: 0};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishLayer({id: 3, timeMs: null, positionMs: null, beatMarker: 2});

  assert.deepEqual(sent.find((item) => item.address === '/vj/layer/3/timingValid'), {address: '/vj/layer/3/timingValid', value: 0});
  assert.equal(sent.find((item) => item.address === '/vj/layer/3/time'), undefined);
  assert.equal(sent.find((item) => item.address === '/vj/layer/3/timecode'), undefined);
  assert.deepEqual(sent.find((item) => item.address === '/vj/layer/3/beat'), {address: '/vj/layer/3/beat', value: 2});
});

test('keeps LTC delay compensation out of relayed layer timecode', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.oscSocket = {};
  bridge.options = {oscEnabled: true, timecodeFps: 25, timecodeOffsetMs: 1000};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishLayer({id: 3, timeMs: 2000});

  assert.deepEqual(sent.find((item) => item.address === '/vj/layer/3/timecode'), {
    address: '/vj/layer/3/timecode',
    value: '00:00:02:00'
  });
});

test('formats non-drop timecode frames', () => {
  assert.equal(formatTimecode(3_723_400, 25), '01:02:03:10');
  assert.equal(timecodeFrame(3_723_400, 25), 93_085);
  assert.equal(formatTimecode(-500, 25), '00:00:00:00');
});

test('keeps Arena clip transport untouched by default', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.oscSocket = {};
  bridge.options = {
    oscEnabled: false,
    arenaTimecodeEnabled: true,
    arenaLayer: 2,
    arenaClip: 8,
    timecodeFps: 25,
    timecodeOffsetMs: 0
  };
  bridge.state.timecode = {enabled: true, mode: 'arena-osc', fps: 25, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendOsc = (address, value) => sent.push({address, value});

  bridge.publishStatus({
    deviceId: 1,
    isPlayingFlag: true,
    positionMs: 3_723_400,
    trackLengthMs: 7_446_800
  });

  assert.deepEqual(sent.find((item) => item.address === '/vj/arena/sourceDeck'), {address: '/vj/arena/sourceDeck', value: 1});
  assert.deepEqual(sent.find((item) => item.address === '/vj/arena/timecode'), {address: '/vj/arena/timecode', value: '01:02:03:10'});
  assert.equal(sent.find((item) => item.address === '/composition/layers/2/clips/8/transport/position'), undefined);
});

test('publishes Arena API position only when clip-position follow is explicitly enabled', () => {
  const bridge = new BridgeService();
  const sentApi = [];
  bridge.options = {
    oscEnabled: false,
    arenaTimecodeEnabled: true,
    arenaApiEnabled: true,
    arenaClipPositionEnabled: true,
    arenaLayer: 1,
    arenaClip: 5,
    timecodeFps: 25,
    timecodeOffsetMs: 0
  };
  bridge.state.timecode = {enabled: true, mode: 'arena-api', fps: 25, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendArenaApiPosition = (layer, clip, progress) => sentApi.push({layer, clip, progress});

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isPlayingFlag: true,
    positionMs: 2500,
    trackLengthMs: 10000
  });

  assert.deepEqual(sentApi, [{layer: 1, clip: 5, progress: 0.25}]);
  assert.equal(bridge.state.timecode.sourceDeck, 2);
  assert.equal(bridge.state.timecode.timecode, '00:00:02:12');
});

test('publishes Arena API tempo without scrubbing clip position by default', () => {
  const bridge = new BridgeService();
  const sentApi = [];
  const patches = [];
  bridge.options = {
    oscEnabled: false,
    arenaTimecodeEnabled: true,
    arenaApiEnabled: true,
    arenaLayer: 1,
    arenaClip: 5,
    timecodeFps: 25,
    timecodeOffsetMs: 0
  };
  bridge.state.timecode = {enabled: true, mode: 'arena-api-bpm', fps: 25, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendArenaApiPosition = (layer, clip, progress) => sentApi.push({layer, clip, progress});
  bridge.putArenaCompositionPatch = (body) => {
    patches.push(body);
    return Promise.resolve(null);
  };

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isPlayingFlag: true,
    effectiveBpm: 124,
    beatInMeasure: 2,
    positionMs: 2500,
    trackLengthMs: 10000
  });

  assert.deepEqual(sentApi, []);
  assert.deepEqual(patches, [{tempocontroller: {tempo: {value: 124}}}]);
});

test('publishes Arena API tempo and downbeat resync from the active deck', () => {
  const bridge = new BridgeService();
  const patches = [];
  bridge.options = {
    oscEnabled: false,
    arenaTimecodeEnabled: true,
    arenaApiEnabled: true,
    arenaLayer: 1,
    arenaClip: 5,
    timecodeFps: 25,
    timecodeOffsetMs: 0
  };
  bridge.state.timecode = {enabled: true, mode: 'arena-api', fps: 25, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendArenaApiPosition = () => {};
  bridge.putArenaCompositionPatch = (body) => {
    patches.push(body);
    return Promise.resolve(null);
  };

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isPlayingFlag: true,
    effectiveBpm: 122.8,
    beatInMeasure: 1,
    positionMs: 0,
    trackLengthMs: 10000
  });

  assert.deepEqual(patches, [{tempocontroller: {tempo: {value: 122.8}, resync: {value: true}}}]);
  assert.equal(bridge.state.timecode.bpm, 122.8);
  assert.equal(bridge.state.timecode.beatInMeasure, 1);
});

test('ignores late Arena API completion from an older output generation', async () => {
  const bridge = new BridgeService();
  let resolveRequest;
  bridge.outputGeneration = 4;
  bridge.state.timecode = {enabled: true, lastError: 'new generation state'};
  bridge.putArenaCompositionPatch = () => new Promise((resolve) => {
    resolveRequest = resolve;
  });

  bridge.sendArenaApiTempoAndBeat({deck: 1, bpm: 128, beatInMeasure: 1});
  bridge.outputGeneration = 5;
  bridge.arenaApiTempoPending = false;
  resolveRequest();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.arenaApiLastTempo, null);
  assert.equal(bridge.state.timecode.lastError, 'new generation state');
  assert.equal(bridge.arenaApiTempoPending, false);
});

test('holds LTC demo while the selected deck is not actively playing', () => {
  const bridge = new BridgeService();
  bridge.options = {
    timecodeDemoEnabled: true,
    timecodeFps: 25,
    timecodeOffsetMs: 0,
    timecodeDemoSourceMode: 'deck-2',
    timecodeDemoOutputLayer: 'M'
  };
  bridge.ltcDemo.start({
    enabled: true,
    configureArena: false,
    routeAudioToVirtual: false
  });
  bridge.state.timecode = {enabled: true, mode: 'audio-ltc-demo', fps: 25, sourceDeck: null, timecode: null, lastError: null};

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isPlayingFlag: false,
    playStateName: 'Cued',
    positionMs: 54,
    trackLengthMs: 217000,
    effectiveBpm: 123.8,
    beatInMeasure: 1
  });

  assert.equal(bridge.state.ltcDemo.enabled, true);
  assert.equal(bridge.state.ltcDemo.playing, false);
  assert.equal(bridge.state.ltcDemo.lastError, null);
  assert.equal(bridge.state.timecode.ltcDemoPlaying, false);
});

test('does not commit bridge startup before Windows LTC helper is ready', async () => {
  const bridge = new BridgeService();
  const calls = [];
  bridge.ltcDemo = {
    start() {
      calls.push('start');
    },
    async waitUntilReady() {
      calls.push('wait');
      throw new Error('WASAPI endpoint unavailable');
    },
    async stop() {
      calls.push('stop');
    },
    getState() {
      return {enabled: false, playing: false};
    }
  };

  await assert.rejects(bridge.start({
    websocketEnabled: false,
    webConsoleEnabled: false,
    timecodeDemoEnabled: true
  }), /WASAPI endpoint unavailable/);

  assert.deepEqual(calls, ['stop', 'start', 'wait', 'stop']);
});

test('does not publish new output while the bridge is closing', () => {
  const bridge = new BridgeService();
  let updates = 0;
  bridge.closing = true;
  bridge.options = {timecodeDemoEnabled: true};
  bridge.ltcDemo = {
    update() {
      updates += 1;
      return {enabled: true};
    },
    getState: () => ({enabled: true})
  };

  bridge.publishStatus({deviceId: 1, isPlayingFlag: true}, {
    deck: 1,
    elapsedMs: 1000,
    totalMs: 10_000,
    remainingMs: 9000,
    progress: 0.1,
    frame: 25,
    timecode: '00:00:01:00'
  });

  assert.equal(updates, 0);
});

test('ignores idle non-source decks while an LTC auto source is active', () => {
  const bridge = new BridgeService();
  const calls = [];
  bridge.options = {
    timecodeDemoEnabled: true,
    timecodeFps: 25,
    timecodeOffsetMs: 0,
    timecodeDemoSourceMode: 'auto',
    timecodeDemoOutputLayer: 'M'
  };
  bridge.ltcDemo = {
    update(timing) {
      calls.push({type: 'update', deck: timing.deck});
      return {enabled: true, playing: true, sourceDeck: timing.deck, timecode: timing.timecode, bpm: timing.bpm, beatInMeasure: timing.beatInMeasure};
    },
    hold(fields) {
      calls.push({type: 'hold', deck: fields.sourceDeck});
      return {enabled: true, playing: false, ...fields};
    },
    getState() {
      return {enabled: true, playing: true, sourceDeck: 2};
    }
  };
  bridge.state.timecode = {enabled: true, mode: 'audio-ltc-demo', fps: 25, sourceDeck: null, timecode: null, lastError: null};

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isPlayingFlag: true,
    positionMs: 1000,
    trackLengthMs: 200000
  });
  bridge.publishStatus({
    deviceId: 1,
    isMaster: false,
    isPlayingFlag: false,
    playStateName: 'Cued',
    positionMs: 0,
    trackLengthMs: 200000
  });

  assert.deepEqual(calls, [{type: 'update', deck: 2}]);
  assert.equal(bridge.state.timecode.sourceDeck, 2);
  assert.equal(bridge.state.timecode.ltcDemoPlaying, true);
});

test('uses explicit Output M deck source for LTC demo', () => {
  const bridge = new BridgeService();
  const calls = [];
  bridge.options = {
    timecodeDemoEnabled: true,
    timecodeFps: 25,
    timecodeOffsetMs: 0,
    timecodeDemoSourceMode: 'deck-2',
    timecodeDemoOutputLayer: 'M'
  };
  bridge.ltcDemo = {
    update(timing) {
      calls.push({type: 'update', deck: timing.deck});
      return {enabled: true, playing: true, sourceDeck: timing.deck, timecode: timing.timecode, bpm: timing.bpm, beatInMeasure: timing.beatInMeasure};
    },
    hold(fields) {
      calls.push({type: 'hold', deck: fields.sourceDeck});
      return {enabled: true, playing: false, ...fields};
    },
    getState() {
      return {enabled: true};
    }
  };
  bridge.state.timecode = {enabled: true, mode: 'audio-ltc-demo', fps: 25, sourceDeck: null, timecode: null, lastError: null};

  bridge.publishStatus({
    deviceId: 1,
    isMaster: true,
    isPlayingFlag: true,
    positionMs: 1000,
    trackLengthMs: 200000
  });
  bridge.publishStatus({
    deviceId: 2,
    isMaster: false,
    isPlayingFlag: true,
    positionMs: 2000,
    trackLengthMs: 200000
  });
  bridge.publishStatus({
    deviceId: 2,
    isMaster: false,
    isPlayingFlag: false,
    playStateName: 'Cued',
    positionMs: 2000,
    trackLengthMs: 200000
  });

  assert.deepEqual(calls, [
    {type: 'update', deck: 2},
    {type: 'hold', deck: 2}
  ]);
  assert.equal(bridge.state.timecode.sourceDeck, 2);
  assert.equal(bridge.state.timecode.ltcDemoPlaying, false);
});

test('publishes Arena Pioneer TCNet to discovered Arena listener', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.arenaPioneerSocket = {};
  bridge.options = {
    arenaPioneerEnabled: true,
    arenaPioneerHost: '255.255.255.255',
    arenaPioneerControlPort: 60000,
    arenaPioneerTimePort: 60001,
    arenaPioneerListenerPort: 65024,
    timecodeFps: 25,
    timecodeOffsetMs: 0
  };
  bridge.state.arenaPioneer = {enabled: true, host: '255.255.255.255', controlPort: 60000, timePort: 60001, sourceDeck: null, peers: 0, lastError: null};
  bridge.state.timecode = {enabled: true, mode: 'arena-pioneer-tcnet', fps: 25, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendArenaPioneerPacket = (packet, port, host = bridge.options.arenaPioneerHost) => sent.push({packet, port, host});
  bridge.observeTcnetPacket({
    source: '192.0.2.11',
    sourcePort: 63311,
    common: {nodeName: 'Arena'},
    tcnetNode: {
      nodeId: 5410,
      nodeName: 'Arena',
      appName: 'Resolume Arena',
      listenerPort: 65208,
      nodeType: 4,
      nodeTypeName: 'Slave',
      versionMajor: 3,
      versionMinor: 5
    }
  });

  bridge.publishStatus({
    deviceId: 2,
    isMaster: true,
    isOnAir: true,
    isPlayingFlag: true,
    effectiveBpm: 128.5,
    beatInMeasure: 1,
    beat: 33,
    positionMs: 42_000,
    trackLengthMs: 210_000,
    trackId: 777,
    title: 'Track',
    artist: 'Artist'
  });

  assert.equal(bridge.state.arenaPioneer.sourceDeck, 2);
  assert.equal(bridge.state.timecode.sourceDeck, 2);
  assert.equal(bridge.state.arenaPioneer.peers, 1);
  assert.equal(sent.some((item) => item.port === 60000 && item.host === '255.255.255.255'), true);
  assert.equal(sent.some((item) => item.port === 60001 && item.host === '255.255.255.255'), true);
  assert.equal(sent.some((item) => item.port === 65208 && item.host === '192.0.2.11'), true);
  assert.equal(sent.some((item) => item.port === 63311 && item.host === '192.0.2.11'), true);

  const controlPackets = sent
    .filter((item) => item.port === 60000)
    .map((item) => parseTcnetPacket(item.packet, {localPort: item.port, address: item.host}));
  const optIn = controlPackets.find((packet) => packet.typeName === 'opt-in');
  const status = controlPackets.find((packet) => packet.typeName === 'status');
  assert.equal(optIn.tcnetNode.nodeCount, 2);
  assert.equal(status.tcnetStatus.nodeCount, 2);
  assert.equal(status.tcnetStatus.appName, 'PRODJLINK BRIDGE');
  assert.equal(status.tcnetStatus.layers[0].source, 0);
  assert.equal(status.tcnetStatus.layers[1].source, 2);
});

test('invalidates the Arena Pioneer layer when canonical timing disappears', () => {
  const bridge = new BridgeService();
  const sent = [];
  const status = {deviceId: 2, isMaster: true, isPlayingFlag: true, trackId: 777};
  bridge.arenaPioneerSocket = {};
  bridge.options = {
    arenaPioneerEnabled: true,
    arenaPioneerHost: '255.255.255.255',
    arenaPioneerControlPort: 60000,
    arenaPioneerTimePort: 60001,
    arenaPioneerListenerPort: 65024,
    timecodeFps: 25
  };
  bridge.state.arenaPioneer = {enabled: true, sourceDeck: null, peers: 0, lastError: null};
  bridge.state.timecode = {enabled: true, sourceDeck: null, timecode: null, lastError: null};
  bridge.sendArenaPioneerPacket = (packet, port, host) => sent.push({packet, port, host});

  bridge.publishStatus(status, {
    deck: 2,
    elapsedMs: 42_000,
    totalMs: 210_000,
    remainingMs: 168_000,
    progress: 0.2,
    frame: 1050,
    timecode: '00:00:42:00'
  });
  sent.length = 0;
  bridge.publishStatus(status, {
    deck: 2,
    elapsedMs: null,
    totalMs: 210_000,
    remainingMs: null,
    progress: null,
    frame: null,
    timecode: null,
    source: 'none'
  });

  assert.equal(bridge.arenaPioneerLayers.has(2), false);
  assert.equal(bridge.state.arenaPioneer.sourceDeck, null);
  assert.equal(bridge.state.timecode.sourceDeck, null);
  assert.equal(bridge.state.timecode.timecode, null);
  const invalidation = sent
    .filter((item) => item.port === 60000)
    .map((item) => parseTcnetPacket(item.packet, {localPort: item.port, address: item.host}))
    .find((packet) => packet.typeName === 'status');
  assert.equal(invalidation.tcnetStatus.layers[1].state, 0);
  assert.equal(invalidation.tcnetStatus.layers[1].source, 0);
});

test('answers Arena Pioneer application-data handshake on the Arena listener', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.arenaPioneerSocket = {};
  bridge.options = {
    arenaPioneerEnabled: true,
    arenaPioneerListenerPort: 65024,
    arenaPioneerHost: '255.255.255.255'
  };
  bridge.state.arenaPioneer = {enabled: true, peers: 0};
  bridge.sendArenaPioneerPacket = (packet, port, host) => sent.push({packet, port, host});
  bridge.observeTcnetPacket({
    source: '192.0.2.11',
    sourcePort: 63311,
    common: {nodeName: 'Arena'},
    tcnetApplicationData: {
      identifier1: 0xff,
      identifier2: 0xff,
      packetSignature: 0x0abc0000,
      payloadSize: 20,
      payloadPreviewHex: '0000b8fe00000000000000000000000000000000'
    }
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent.map((item) => `${item.host}:${item.port}`).sort(),
    ['192.0.2.11:63311']
  );

  const parsed = sent.map((item) => parseTcnetPacket(item.packet, {localPort: item.port, address: item.host}));
  assert.equal(parsed.filter((item) => item.typeName === 'application-data').length, 1);
  assert.equal(parsed.filter((item) => item.typeName === 'notification').length, 0);
  assert.equal(
    parsed
      .filter((item) => item.typeName === 'application-data')
      .every((item) => item.tcnetApplicationData.payloadPreviewHex.slice(0, 8) === '000000fe'),
    true
  );
});

test('answers Arena Pioneer metadata and metrics requests from the active layer', () => {
  const bridge = new BridgeService();
  const sent = [];
  bridge.arenaPioneerSocket = {};
  bridge.options = {
    arenaPioneerEnabled: true,
    arenaPioneerListenerPort: 65024,
    arenaPioneerHost: '255.255.255.255'
  };
  bridge.state.arenaPioneer = {enabled: true, peers: 0};
  bridge.arenaPioneerLayers.set(2, {
    id: 2,
    state: 3,
    syncMaster: true,
    beatMarker: 1,
    totalTimeMs: 210_000,
    timeMs: 42_000,
    speedPercent: 100,
    beatNumber: 33,
    bpm: 137,
    trackId: 777,
    title: 'Track',
    artist: 'Artist'
  });
  bridge.sendArenaPioneerPacket = (packet, port, host) => sent.push({packet, port, host});

  bridge.observeTcnetPacket({
    source: '192.0.2.11',
    sourcePort: 63311,
    common: {nodeName: 'Arena'},
    tcnetNode: {
      nodeId: 5410,
      nodeName: 'Arena',
      appName: 'Resolume Arena',
      listenerPort: 65208,
      nodeType: 4,
      nodeTypeName: 'Slave',
      versionMajor: 3,
      versionMinor: 5
    }
  });
  bridge.observeTcnetPacket({
    source: '192.0.2.11',
    sourcePort: 63311,
    common: {nodeName: 'Arena'},
    tcnetRequest: {dataType: 4, dataTypeName: 'metadata', layerId: 2}
  });
  bridge.observeTcnetPacket({
    source: '192.0.2.11',
    sourcePort: 63311,
    common: {nodeName: 'Arena'},
    tcnetRequest: {dataType: 2, dataTypeName: 'metrics', layerId: 2}
  });

  assert.equal(sent.length, 4);
  assert.equal(sent.some((item) => item.port === 63311 && item.host === '192.0.2.11'), true);
  assert.equal(sent.some((item) => item.port === 65208 && item.host === '192.0.2.11'), true);

  const metadata = sent
    .map((item) => parseTcnetPacket(item.packet, {localPort: item.port, address: item.host}))
    .find((item) => item.tcnetData?.dataTypeName === 'metadata');
  const metrics = sent
    .map((item) => parseTcnetPacket(item.packet, {localPort: item.port, address: item.host}))
    .find((item) => item.tcnetData?.dataTypeName === 'metrics');

  assert.equal(metadata.tcnetData.metadata.layerId, 2);
  assert.equal(metadata.tcnetData.metadata.title, 'Track');
  assert.equal(metadata.tcnetData.metadata.artist, 'Artist');
  assert.equal(metadata.tcnetData.metadata.trackId, 777);
  assert.equal(metrics.tcnetData.metrics.layerId, 2);
  assert.equal(metrics.tcnetData.metrics.bpm, 137);
  assert.equal(metrics.tcnetData.metrics.positionMs, 42_000);
  assert.equal(metrics.tcnetData.metrics.trackId, 777);
});

test('creates LAN web monitor HTML with same-origin websocket path', () => {
  const html = createRemoteMonitorHtml();

  assert.match(html, /PRO DJ LINK 局域网监控/);
  assert.match(html, /location\.host \+ '\/ws'/);
  assert.match(html, /实时BPM/);
  assert.match(html, /layoutSelect/);
  assert.match(html, /waveformModeSelect/);
  assert.match(html, /waveformViewSelect/);
  assert.match(html, /masterWatch/);
  assert.match(html, /等待 MASTER/);
  assert.match(html, /followWaveformWindowMs/);
  assert.match(html, /getWaveformViewport/);
  assert.match(html, /refreshButton/);
  assert.match(html, /fetch\('\/refresh'/);
  assert.match(html, /mergeMonitorState/);
  assert.match(html, /master-chip/);
  assert.match(html, /live-chip/);
  assert.match(html, /3Band/);
  assert.match(html, /正在播放/);
  assert.match(html, /待播/);
});

test('binds raw WebSocket and Web Console to loopback unless trusted LAN is explicitly enabled', async () => {
  const captureBindings = async (webConsoleLanEnabled) => {
    const bridge = new BridgeService();
    const bindings = [];
    bridge.startWebSocket = async (port, host) => bindings.push({service: 'websocket', port, host});
    bridge.startWebConsole = async (port, host) => bindings.push({service: 'web-console', port, host});

    await bridge.open({
      websocketEnabled: true,
      websocketPort: 7071,
      websocketHost: '0.0.0.0',
      webConsoleEnabled: true,
      webConsolePort: 7072,
      webConsoleLanEnabled
    });
    return {bridge, bindings};
  };

  const local = await captureBindings(false);
  assert.deepEqual(local.bindings, [
    {service: 'websocket', port: 7071, host: '127.0.0.1'},
    {service: 'web-console', port: 7072, host: '127.0.0.1'}
  ]);
  assert.equal(local.bridge.options.websocketHost, '127.0.0.1');
  assert.equal(local.bridge.options.webConsoleLanEnabled, false);

  const trustedLan = await captureBindings(true);
  assert.deepEqual(trustedLan.bindings, [
    {service: 'websocket', port: 7071, host: '127.0.0.1'},
    {service: 'web-console', port: 7072, host: '0.0.0.0'}
  ]);
  assert.equal(trustedLan.bridge.options.webConsoleLanEnabled, true);
});

test('raw WebSocket rejects browser origins outside loopback', () => {
  assert.equal(isRawWebSocketOriginAllowed({headers: {}}), true);
  assert.equal(isRawWebSocketOriginAllowed({headers: {origin: 'http://127.0.0.1:3000'}}), true);
  assert.equal(isRawWebSocketOriginAllowed({headers: {origin: 'https://localhost'}}), true);
  assert.equal(isRawWebSocketOriginAllowed({headers: {origin: 'http://[::1]:3000'}}), true);
  assert.equal(isRawWebSocketOriginAllowed({headers: {origin: 'https://attacker.example'}}), false);
  assert.equal(isRawWebSocketOriginAllowed({headers: {origin: 'null'}}), false);
});

test('Web Console rejects cross-origin HTTP requests without emitting wildcard CORS', () => {
  const bridge = new BridgeService();
  bridge.lastMonitorState = {running: true};

  const sameOrigin = createMockResponse();
  bridge.handleWebConsoleRequest({
    url: '/state.json',
    method: 'GET',
    headers: {host: '127.0.0.1:7072', origin: 'http://127.0.0.1:7072'}
  }, sameOrigin, '');
  assert.equal(sameOrigin.statusCode, 200);
  assert.equal(sameOrigin.headers['Access-Control-Allow-Origin'], undefined);

  const cli = createMockResponse();
  bridge.handleWebConsoleRequest({
    url: '/state.json',
    method: 'GET',
    headers: {host: '127.0.0.1:7072'}
  }, cli, '');
  assert.equal(cli.statusCode, 200);

  const crossOrigin = createMockResponse();
  bridge.handleWebConsoleRequest({
    url: '/state.json',
    method: 'GET',
    headers: {host: '127.0.0.1:7072', origin: 'https://attacker.example'}
  }, crossOrigin, '');
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.body, 'Forbidden');
});

test('remote state surfaces privacy-minimize waveform failure diagnostics without mutating desktop state', () => {
  const detailedFailure = {
    timestamp: '2026-07-10T12:00:00.000Z',
    reason: 'db-request-error',
    deckId: 2,
    stage: 'metadata-waveform',
    title: 'Private Track',
    artist: 'Private Artist',
    host: '192.0.2.16',
    source: '192.0.2.16',
    trackKey: '1:3:1:456',
    dbKey: '192.0.2.16:1:3:1:456',
    message: '/Users/private-person/Music/current.wav',
    waveformKind: 'big',
    waveformStyle: 'rgb',
    pointCount: 0,
    waveformCount: 1
  };
  const desktopState = {
    running: true,
    waveformFailures: {total: 1, path: '/Users/private-person/automatic.jsonl', recent: [detailedFailure]},
    health: {waveformFailures: {total: 1, path: '/Users/private-person/automatic.jsonl', recent: [detailedFailure]}}
  };
  const assertPublic = (publicState) => {
    for (const failures of [publicState.waveformFailures, publicState.health.waveformFailures]) {
      assert.deepEqual(Object.keys(failures).sort(), ['recent', 'total']);
      assert.equal(failures.total, 1);
      assert.equal(failures.recent[0].reason, 'db-request-error');
      assert.equal(failures.recent[0].deckId, 2);
      for (const key of ['path', 'title', 'artist', 'host', 'source', 'trackKey', 'trackId', 'dbKey', 'message']) {
        assert.equal(Object.hasOwn(failures, key), false);
        assert.equal(Object.hasOwn(failures.recent[0], key), false);
      }
    }
    const serialized = JSON.stringify(publicState);
    assert.doesNotMatch(serialized, /Private Track|Private Artist|192\.0\.2\.16|1:3:1:456|\/Users\//);
  };

  assertPublic(sanitizePublicMonitorState(desktopState));
  assert.equal(desktopState.health.waveformFailures.path, '/Users/private-person/automatic.jsonl');
  assert.equal(desktopState.health.waveformFailures.recent[0].title, 'Private Track');

  const bridge = new BridgeService();
  const rawMessages = [];
  const webMessages = [];
  bridge.wsServer = {clients: new Set([{readyState: 1, send: (message) => rawMessages.push(message)}])};
  bridge.webConsoleWsServer = {clients: new Set([{readyState: 1, send: (message) => webMessages.push(message)}])};
  bridge.broadcastState(desktopState);
  assertPublic(JSON.parse(rawMessages[0]).payload);
  assertPublic(JSON.parse(webMessages[0]).payload);
  assertPublic(bridge.lastMonitorState);

  bridge.lastMonitorState = desktopState;
  const response = createMockResponse();
  bridge.handleWebConsoleRequest({url: '/state.json', method: 'GET', headers: {host: 'localhost'}}, response, '');
  assert.equal(response.statusCode, 200);
  assertPublic(JSON.parse(response.body));
});

test('Web Console rejects cross-origin WebSocket upgrades while allowing same-origin and CLI clients', () => {
  const bridge = new BridgeService();
  let upgradeCount = 0;
  let connectionCount = 0;
  const webConsoleWsServer = {
    handleUpgrade(_request, _socket, _head, callback) {
      upgradeCount += 1;
      callback({});
    },
    emit(event) {
      if (event === 'connection') connectionCount += 1;
    }
  };
  const rejectedWrites = [];
  const rejectedSocket = {
    destroyed: false,
    write(value) {
      rejectedWrites.push(value);
    },
    destroy() {
      this.destroyed = true;
    }
  };

  const rejected = bridge.handleWebConsoleUpgrade({
    url: '/ws',
    headers: {host: '127.0.0.1:7072', origin: 'https://attacker.example'}
  }, rejectedSocket, Buffer.alloc(0), webConsoleWsServer);
  assert.equal(rejected, false);
  assert.equal(rejectedSocket.destroyed, true);
  assert.match(rejectedWrites.join(''), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(upgradeCount, 0);

  const allowedSocket = {write: () => assert.fail('must not reject same-origin upgrade'), destroy: () => assert.fail('must not destroy same-origin upgrade')};
  assert.equal(bridge.handleWebConsoleUpgrade({
    url: '/ws',
    headers: {host: '127.0.0.1:7072', origin: 'http://127.0.0.1:7072'}
  }, allowedSocket, Buffer.alloc(0), webConsoleWsServer), true);
  assert.equal(bridge.handleWebConsoleUpgrade({
    url: '/ws',
    headers: {host: '127.0.0.1:7072'}
  }, allowedSocket, Buffer.alloc(0), webConsoleWsServer), true);
  assert.equal(upgradeCount, 2);
  assert.equal(connectionCount, 2);
});

test('desktop UI keeps trusted-LAN Web Console access opt-in and updates the displayed URL', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const toggleMarkup = html.match(/<input id="webConsoleLanToggle"[^>]*>/)?.[0] || '';

  assert.match(toggleMarkup, /type="checkbox"/);
  assert.doesNotMatch(toggleMarkup, /checked/);
  assert.match(renderer, /webConsoleLanEnabled: Boolean\(els\.webConsoleLanToggle\.checked\)/);
  assert.match(renderer, /if \(!els\.webConsoleLanToggle\?\.checked\) return '127\.0\.0\.1'/);
  assert.match(renderer, /els\.webConsoleLanToggle\.addEventListener\('change'/);
});

test('desktop UI exposes one-click Arena connection status', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8');

  assert.match(html, /arenaConnectButton/);
  assert.match(html, /Arena 未连接/);
  assert.match(html, /Virtual CDJ/);
  assert.match(html, /Bridge \/ TCNet 禁用/);
  assert.match(html, /Arena BPM/);
  assert.match(html, /ltcSourceMode/);
  assert.match(renderer, /data-ltc-source/);
  assert.match(renderer, /handleDeckLtcSourceClick/);
  assert.match(renderer, /preflight\.canAutoRoute/);
  assert.match(renderer, /timecodeDemoVirtualAudioId/);
  assert.match(renderer, /toggleAdvancedView/);
  assert.match(renderer, /contains\('view-advanced'\) \? 'monitor' : 'advanced'/);
  assert.match(main, /monitor:reconfigureOutputs/);
  assert.match(main, /before-quit/);
  assert.match(main, /stopMonitorForShutdown/);
  assert.match(preload, /reconfigureOutputs/);
  const reconfigureSection = renderer.slice(
    renderer.indexOf('async function restartBridgeIfRunning'),
    renderer.indexOf('function normalizeWaveformSettings')
  );
  assert.match(reconfigureSection, /window\.prolink\.reconfigureOutputs/);
  assert.match(reconfigureSection, /nextState\.lastError/);
  assert.match(reconfigureSection, /已恢复上一组输出设置/);
  assert.doesNotMatch(reconfigureSection, /startMonitor\(/);
  assert.match(renderer, /els\.websocketToggle,\s*\n\s*els\.websocketPort/);
});

test('waits for bridge resources to close before stop resolves', async () => {
  const bridge = new BridgeService();
  const closed = [];
  const fakeResource = (name, clients = null) => ({
    clients,
    close(callback) {
      setImmediate(() => {
        closed.push(name);
        callback();
      });
    }
  });
  const client = {terminate: () => closed.push('client')};
  bridge.wsServer = fakeResource('websocket', new Set([client]));
  bridge.httpServer = fakeResource('http');
  bridge.webConsoleWsServer = fakeResource('web-console-ws', new Set());
  bridge.oscSocket = fakeResource('osc');
  bridge.arenaPioneerSocket = fakeResource('arena');
  bridge.ltcDemo = {
    async stop() {
      await new Promise((resolve) => setImmediate(resolve));
      closed.push('ltc');
    },
    getState: () => ({enabled: false})
  };

  await bridge.stop();

  assert.deepEqual(new Set(closed), new Set(['client', 'websocket', 'http', 'web-console-ws', 'osc', 'arena', 'ltc']));
});

test('surfaces LTC audio restoration failure from bridge stop', async () => {
  const bridge = new BridgeService();
  bridge.ltcDemo = {
    async stop() {
      throw new Error('CoreAudio restore failed');
    },
    getState: () => ({enabled: false, audioRoute: {active: true}})
  };

  await assert.rejects(bridge.stop(), /CoreAudio restore failed/);

  assert.equal(bridge.state.ltcDemo.audioRoute.active, true);
  assert.match(bridge.state.ltcDemo.lastError, /CoreAudio restore failed/);
});

test('rolls bridge outputs back after a failed reconfiguration', async () => {
  const bridge = new BridgeService();
  const calls = [];
  bridge.options = {marker: 'old', timecodeDemoEnabled: false};
  bridge.stop = async () => calls.push('stop');
  bridge.open = async (options) => {
    calls.push(`open:${options.marker}`);
    if (options.marker === 'new') throw new Error('new output failed');
  };

  await assert.rejects(bridge.reconfigure({marker: 'new'}), /new output failed/);

  assert.deepEqual(calls, ['stop', 'open:new', 'stop', 'open:old']);
});

test('retries audio restoration before a fresh bridge start', async () => {
  const bridge = new BridgeService();
  let restoreAudio = null;
  bridge.stop = async (options) => {
    restoreAudio = options.restoreAudio;
  };
  bridge.open = async () => {};

  await bridge.start({timecodeDemoEnabled: false});

  assert.equal(restoreAudio, true);
});

test('reopens previous outputs when LTC restoration fails during reconfiguration', async () => {
  const bridge = new BridgeService();
  const calls = [];
  bridge.options = {marker: 'old', timecodeDemoEnabled: true};
  bridge.stop = async () => {
    calls.push('stop');
    throw new Error('audio restore failed');
  };
  bridge.open = async (options) => {
    calls.push(`open:${options.marker}`);
  };

  await assert.rejects(bridge.reconfigure({marker: 'new', timecodeDemoEnabled: false}), /audio restore failed/);

  assert.deepEqual(calls, ['stop', 'open:old']);
});

test('restores the audio route when LTC output is disabled', async () => {
  const bridge = new BridgeService();
  let restoreAudio = null;
  bridge.options = {
    timecodeDemoEnabled: true,
    timecodeDemoRouteAudio: true,
    timecodeDemoVirtualAudioName: 'BlackHole 2ch'
  };
  bridge.stop = async (options) => {
    restoreAudio = options.restoreAudio;
  };
  bridge.open = async () => {};

  await bridge.reconfigure({timecodeDemoEnabled: false});

  assert.equal(restoreAudio, true);
});

test('restores a newly routed LTC output when reconfiguration fails', async () => {
  const bridge = new BridgeService();
  const restoreCalls = [];
  bridge.options = {marker: 'old', timecodeDemoEnabled: false};
  bridge.stop = async (options) => restoreCalls.push(options.restoreAudio);
  bridge.open = async (options) => {
    if (options.marker === 'new') throw new Error('port unavailable');
  };

  await assert.rejects(bridge.reconfigure({marker: 'new', timecodeDemoEnabled: true}), /port unavailable/);

  assert.deepEqual(restoreCalls, [false, true]);
});

test('LAN web monitor refresh endpoint calls the monitor refresh callback', () => {
  const bridge = new BridgeService();
  let refreshCalls = 0;
  bridge.options = {
    forceRefresh: () => {
      refreshCalls += 1;
      return {refreshed: 2};
    }
  };
  const response = createMockResponse();

  bridge.handleWebConsoleRequest({url: '/refresh', method: 'POST', headers: {host: 'localhost'}}, response, '');

  assert.equal(response.statusCode, 200);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(JSON.parse(response.body), {ok: true, result: {refreshed: 2}});
});

test('LAN web monitor exports TCNet capture jsonl for automation', () => {
  const bridge = new BridgeService();
  bridge.options = {
    getTcnetCaptureJsonl: () => '{"typeName":"opt-in"}\n'
  };
  const response = createMockResponse();

  bridge.handleWebConsoleRequest({url: '/tcnet-capture.jsonl', method: 'GET', headers: {host: 'localhost'}}, response, '');

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Content-Type'], /application\/x-ndjson/);
  assert.equal(response.body, '{"typeName":"opt-in"}\n');
});

function readOscString(message, offset) {
  const end = message.indexOf(0, offset);
  return message.subarray(offset, end).toString('utf8');
}

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
}
