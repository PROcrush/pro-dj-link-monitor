const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {ProLinkMonitor} = require('../src/prolink/monitor.cjs');

test('merges beat packets into deck status state', async () => {
  const monitor = new ProLinkMonitor();
  const packet = Buffer.from(
    '5173707431576d4a4f4c2843444a2d33303030000000000000000000000000010001003c000001ee000003dc000005c9000007b700000d7f00000f6dffffffffffffffffffffffffffffffffffffffffffffffff000fb43900002f7e02000001',
    'hex'
  );

  monitor.handleMessage(50001, packet, {address: '192.0.2.16', port: 39591});

  const status = monitor.getState().statuses[0];
  assert.equal(status.deviceId, 1);
  assert.equal(status.trackBpm, 121.58);
  assert.equal(status.beatInMeasure, 2);
  assert.equal(status.playStateName, 'Beat');

  await monitor.stop();
});

test('merges CDJ-3000 precise position packets into deck timing state', async () => {
  const monitor = new ProLinkMonitor();
  const packet = Buffer.from(
    '5173707431576d4a4f4c0b43444a2d333030300000000000000000000000000200010018000017990007c4dc00000235000000000000000000000504',
    'hex'
  );

  monitor.handleMessage(50001, packet, {address: '192.0.2.16', port: 50001});

  const status = monitor.getState().statuses[0];
  assert.equal(status.deviceId, 1);
  assert.equal(status.positionMs, 509148);
  assert.match(status.positionLastSeen, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.trackLengthMs, 6041000);
  assert.equal(status.precisePitchPercent, 5.65);
  assert.equal(status.effectiveBpm, 128.4);
  assert.equal(status.lastPrecisePacket.packetTypeName, 'precise-position');

  await monitor.stop();
});

test('merges TCNet waveform packets into monitor state', async () => {
  const monitor = new ProLinkMonitor();
  const packet = Buffer.alloc(48);
  packet.writeUInt16LE(0x1111, 0);
  packet[2] = 3;
  packet[3] = 6;
  packet.write('TCN', 4, 'ascii');
  packet[7] = 200;
  packet.write('RESOLU', 8, 'ascii');
  packet[17] = 2;
  packet[24] = 16;
  packet[25] = 2;
  packet.writeUInt32LE(6, 26);
  packet.writeUInt32LE(1, 30);
  packet.writeUInt32LE(1, 34);
  Buffer.from([20, 80, 140, 160, 220, 230]).copy(packet, 42);

  monitor.handleMessage(65024, packet, {address: '192.168.10.33', port: 65023});

  const state = monitor.getState();
  assert.equal(state.waveforms.length, 1);
  assert.equal(state.waveforms[0].layerId, 2);
  assert.equal(state.waveforms[0].pointCount, 3);
  assert.equal(state.tcnetLayers[0].smallWaveformPoints, 3);

  await monitor.stop();
});

test('captures TCNet packets with raw export while keeping VJ state lean', async () => {
  const monitor = new ProLinkMonitor();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prodjlink-tcnet-capture-'));
  const exportPath = path.join(tmpDir, 'tcnet-capture.jsonl');
  const packet = Buffer.alloc(26);
  packet.writeUInt16LE(0x2222, 0);
  packet[2] = 3;
  packet[3] = 6;
  packet.write('TCN', 4, 'ascii');
  packet[7] = 20;
  packet.write('ARENA', 8, 'ascii');
  packet[16] = 9;
  packet[17] = 4;
  packet[24] = 4;
  packet[25] = 2;

  monitor.handleMessage(60000, packet, {address: '127.0.0.1', port: 65023});

  const state = monitor.getState();
  assert.equal(state.tcnetCapture.length, 1);
  assert.equal(state.tcnetCapture[0].typeName, 'request');
  assert.equal(state.tcnetCapture[0].requestDataTypeName, 'metadata');
  assert.equal(state.tcnetCapture[0].rawHex, undefined);

  const liveState = monitor.getVjState();
  assert.equal(liveState.health.tcnetCapture.total, 1);
  assert.equal(liveState.health.tcnetCapture.recent[0].rawHex, undefined);

  await monitor.exportTcnetCapture(exportPath);
  const lines = (await fs.readFile(exportPath, 'utf8')).trim().split('\n');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.rawHex, packet.toString('hex'));
  assert.equal(entry.sourcePort, 65023);
  assert.equal(entry.layerId, 2);

  await monitor.stop();
});

test('does not mark decks connected from looped-back TCNet layers alone', async () => {
  const monitor = new ProLinkMonitor();
  const now = new Date().toISOString();
  monitor.tcnetLayers.set(1, {
    id: 1,
    layerId: 1,
    stateName: 'Idle',
    title: 'Looped TCNet Track',
    lastSeen: now,
    source: '192.0.2.11'
  });
  monitor.tcnetLayers.set(3, {
    id: 3,
    layerId: 3,
    stateName: 'Idle',
    lastSeen: now,
    source: '192.0.2.11'
  });

  const state = monitor.getVjState();
  const deck1 = state.decks.find((deck) => deck.id === 1);
  const deck3 = state.decks.find((deck) => deck.id === 3);

  assert.equal(deck1.connected, false);
  assert.equal(deck1.state, 'No Link');
  assert.equal(deck1.title, '');
  assert.equal(deck3.connected, false);
  assert.equal(deck3.state, 'No Link');

  await monitor.stop();
});

test('drops stale PRO DJ LINK connection state from deck cards', async () => {
  const monitor = new ProLinkMonitor();
  const stale = new Date(Date.now() - 30000).toISOString();
  monitor.devices.set(1, {
    id: 1,
    name: 'CDJ-3000',
    ip: '192.0.2.16',
    lastSeen: stale
  });
  monitor.statuses.set(1, {
    deviceId: 1,
    playStateName: 'Idle',
    lastSeen: stale
  });

  const state = monitor.getVjState();
  const deck = state.decks.find((item) => item.id === 1);

  assert.equal(deck.connected, false);
  assert.equal(deck.state, 'No Link');
  assert.equal(deck.stateLabel, '未连接');

  await monitor.stop();
});

test('listens to TCNet passive research ports including 60002', async () => {
  const monitor = new ProLinkMonitor();
  monitor.options = {tcnetEnabled: true, tcnetNodeEnabled: false};

  const ports = monitor.getListenPorts();

  assert.equal(ports.includes(60000), true);
  assert.equal(ports.includes(60001), true);
  assert.equal(ports.includes(60002), true);
  assert.equal(ports.includes(65023), true);
  assert.equal(ports.includes(65024), true);

  await monitor.stop();
});

test('stores dbserver beat grid cues artwork and waveform detail per deck', async () => {
  const monitor = new ProLinkMonitor();

  monitor.applyDbTrackData({
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: '192.0.2.16'
  }, {
    metadata: {title: 'Track', artist: 'Artist', artworkId: 9},
    cues: {cueCount: 1, hotCueCount: 1, loopCount: 0, cues: [{hotCueNumber: 1, label: 'A', positionMs: 1000, color: '#55d682'}]},
    beatGrid: {beatCount: 1, beats: [[1000, 1, 120]]},
    artwork: {id: 9, mime: 'image/jpeg', byteLength: 4, dataUrl: 'data:image/jpeg;base64,/9j/2Q=='},
    waveforms: [{kind: 'big', style: 'rgb', pointCount: 2, originalPointCount: 150, totalTimeMs: 1000, points: [[255, 255, 0, 0], [128, 0, 255, 0]]}],
    dbPort: 12524
  }, 'db-key');

  const state = monitor.getState();
  assert.equal(state.metadata[0].hasArtwork, true);
  assert.equal(state.cues[0].cueCount, 1);
  assert.equal(state.beatGrids[0].beatCount, 1);
  assert.equal(state.artwork[0].id, 9);
  assert.equal(state.waveforms[0].kind, 'big');

  const liveState = monitor.getState({waveformPointLimit: 1, eventLimit: 0});
  assert.equal(liveState.waveforms[0].pointCount, 1);
  assert.equal(liveState.waveforms[0].originalStatePointCount, 2);

  await monitor.stop();
});

test('includes db request status in monitor state', async () => {
  const monitor = new ProLinkMonitor();
  const status = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1
  };

  monitor.markDbRequest('192.0.2.16:1:3:1:123', status, {
    stage: 'metadata-waveform',
    state: 'ready',
    host: '192.0.2.16',
    waveformCount: 3
  });

  const state = monitor.getState();
  assert.equal(state.dbRequests.length, 1);
  assert.equal(state.dbRequests[0].state, 'ready');
  assert.equal(state.dbRequests[0].waveformCount, 3);

  await monitor.stop();
});

test('records waveform failure details when db data has no usable waveform', async () => {
  const monitor = new ProLinkMonitor();
  const status = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    title: 'Broken Track',
    source: '192.0.2.16'
  };

  monitor.applyDbTrackData(status, {
    metadata: {title: 'Broken Track', artist: 'Artist'},
    waveforms: [{kind: 'big', style: 'rgb', pointCount: 0, points: []}],
    dbPort: 12524
  }, '192.0.2.16:1:3:1:123');

  const state = monitor.getState();
  assert.equal(state.waveformFailures.total, 2);
  assert.equal(state.waveformFailures.recent[0].reason, 'db-empty-waveform-points');
  assert.equal(state.waveformFailures.recent[1].reason, 'db-no-usable-waveform');
  assert.equal(state.waveformFailures.recent[1].deckId, 1);
  assert.equal(state.waveformFailures.recent[1].trackKey, '1:3:1:123');
  assert.equal(state.waveformFailures.recent[1].host, '192.0.2.16');

  await monitor.stop();
});

test('exports waveform failure log as json lines', async () => {
  const monitor = new ProLinkMonitor();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prodjlink-waveform-log-'));
  const exportPath = path.join(tmpDir, 'waveform-failures.jsonl');

  monitor.recordWaveformFailure('db-request-error', {
    deviceId: 2,
    trackId: 456,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: '192.0.2.16'
  }, {
    stage: 'metadata-waveform',
    host: '192.0.2.16',
    message: 'timeout'
  });

  await monitor.exportWaveformFailureLog(exportPath);
  const lines = (await fs.readFile(exportPath, 'utf8')).trim().split('\n');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.reason, 'db-request-error');
  assert.equal(entry.deckId, 2);
  assert.equal(entry.trackKey, '1:3:1:456');
  assert.equal(entry.host, '192.0.2.16');
  assert.equal(entry.message, 'timeout');

  await monitor.stop();
});

test('privacy-minimizes automatic waveform logs while explicit export keeps current in-memory details', async () => {
  const monitor = new ProLinkMonitor();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prodjlink-waveform-privacy-'));
  const automaticPath = path.join(tmpDir, 'automatic-waveform-failures.jsonl');
  const explicitPath = path.join(tmpDir, 'explicit-waveform-export.jsonl');
  await fs.writeFile(automaticPath, `${JSON.stringify({
    timestamp: '2026-07-10T12:00:00.000Z',
    reason: 'legacy-error',
    title: 'Private Legacy Title',
    artist: 'Private Legacy Artist',
    host: '192.0.2.16',
    source: '192.0.2.16',
    trackKey: '1:3:1:999',
    dbKey: '192.0.2.16:1:3:1:999',
    message: '/Users/private-person/Music/secret.wav'
  })}\nmalformed /Users/private-person/secret\n`, 'utf8');

  await monitor.setWaveformFailureLogPath(automaticPath);
  monitor.recordWaveformFailure('db-request-error', {
    deviceId: 2,
    trackId: 456,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: '192.0.2.16',
    title: 'Private Current Title',
    artist: 'Private Current Artist'
  }, {
    stage: 'metadata-waveform',
    host: '192.0.2.16',
    dbKey: '192.0.2.16:1:3:1:456',
    message: '/Users/private-person/Music/current.wav',
    waveformKind: 'big',
    waveformStyle: 'rgb',
    pointCount: 0
  });
  await monitor.waveformFailureLogWritePromise;

  const automaticText = await fs.readFile(automaticPath, 'utf8');
  const automaticEntries = automaticText.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(automaticEntries.length, 2);
  for (const entry of automaticEntries) {
    for (const forbiddenKey of ['title', 'artist', 'host', 'source', 'trackKey', 'trackId', 'dbKey', 'message']) {
      assert.equal(Object.hasOwn(entry, forbiddenKey), false);
    }
  }
  assert.doesNotMatch(automaticText, /192\.0\.2\.16|Private|\/Users\//);

  const desktopState = monitor.getVjState();
  assert.equal(desktopState.health.waveformFailures.path, automaticPath);
  assert.equal(desktopState.health.waveformFailures.recent[0].title, 'Private Current Title');
  assert.equal(desktopState.health.waveformFailures.recent[0].artist, 'Private Current Artist');
  assert.equal(desktopState.health.waveformFailures.recent[0].host, '192.0.2.16');
  assert.equal(desktopState.health.waveformFailures.recent[0].trackKey, '1:3:1:456');
  assert.equal(desktopState.health.waveformFailures.recent[0].dbKey, '192.0.2.16:1:3:1:456');

  await monitor.exportWaveformFailureLog(explicitPath);
  const explicitEntry = JSON.parse((await fs.readFile(explicitPath, 'utf8')).trim());
  assert.equal(explicitEntry.title, 'Private Current Title');
  assert.equal(explicitEntry.artist, 'Private Current Artist');
  assert.equal(explicitEntry.host, '192.0.2.16');
  assert.equal(explicitEntry.trackKey, '1:3:1:456');
  assert.equal(explicitEntry.dbKey, '192.0.2.16:1:3:1:456');

  await monitor.stop();
});

test('builds a lean VJ state without raw packet tables', async () => {
  const monitor = new ProLinkMonitor();
  monitor.devices.set(1, {id: 1, name: 'CDJ-3000', ip: '192.0.2.16'});
  monitor.devices.set(7, {id: 7, name: 'PDL-MONITOR', ip: '192.0.2.11'});
  monitor.statuses.set(1, {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    title: 'Track',
    artist: 'Artist',
    key: 'Cm',
    effectiveBpm: 128.5,
    beatInMeasure: 2,
    isPlayingFlag: false,
    isMaster: true,
    playbackPositionMs: 1000,
    totalTimeMs: 4000,
    lastSeen: Date.now()
  });
  monitor.waveforms.set('1:big:three-band', {
    layerId: 1,
    deviceId: 1,
    trackId: 123,
    kind: 'big',
    style: 'three-band',
    pointCount: 2,
    points: [[1, 2, 3], [4, 5, 6]]
  });
  monitor.waveforms.set('1:big:rgb', {
    layerId: 1,
    deviceId: 1,
    trackId: 123,
    kind: 'big',
    style: 'rgb',
    pointCount: 2,
    points: [[1, 255, 0, 0], [2, 0, 255, 0]]
  });
  monitor.beatGrids.set('1', {
    layerId: 1,
    deviceId: 1,
    trackId: 123,
    beatCount: 2,
    beats: [[0, 1, 128], [500, 2, 128]]
  });
  monitor.events.push({summary: 'raw packet'});

  const state = monitor.getVjState({waveformPointLimit: 1});
  assert.equal(state.profile, 'vj');
  assert.equal(state.decks.length, 4);
  assert.equal(state.decks.some((deck) => deck.id === 7), false);
  assert.equal(state.decks[0].title, 'Track');
  assert.equal(state.decks[0].trackKey, '1:3:1:123');
  assert.equal(state.decks[0].progress, 0.25);
  assert.equal(state.decks[0].waveforms.length, 2);
  assert.equal(state.decks[0].waveforms.some((waveform) => waveform.style === 'rgb'), true);
  assert.equal(state.decks[0].beatGrid.beats.length, 2);
  assert.equal(state.packetCounters, undefined);
  assert.equal(state.events, undefined);
  assert.equal(state.devices, undefined);

  const lightState = monitor.getVjState({waveformPointLimit: 1, includeHeavy: false});
  assert.equal(lightState.heavyRevision, state.heavyRevision);
  assert.equal(lightState.decks[0].trackKey, '1:3:1:123');
  assert.equal(lightState.decks[0].progress, 0.25);
  assert.equal(lightState.decks[0].waveforms, undefined);
  assert.equal(lightState.decks[0].waveform, undefined);
  assert.equal(lightState.decks[0].beatGrid, undefined);

  await monitor.stop();
});

test('publishes the same canonical timing used by the VJ deck state', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  const seenAt = new Date(nowMs).toISOString();
  const status = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    beat: 10,
    beatLastSeen: seenAt,
    lastSeen: seenAt,
    isPlayingFlag: false,
    playStateName: 'Paused',
    trackLengthMs: 60_000
  };
  let bridgeTiming = null;
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 0};
  monitor.devices.set(1, {id: 1, name: 'CDJ-3000', lastSeen: seenAt});
  monitor.statuses.set(1, status);
  monitor.beatGrids.set('1', {
    layerId: 1,
    deviceId: 1,
    trackId: 123,
    beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
  });
  monitor.bridge.publishStatus = (_status, timing) => {
    bridgeTiming = timing;
  };

  monitor.publishCanonicalStatus(status, nowMs);
  const deck = monitor.getVjState().decks[0];

  assert.equal(bridgeTiming.elapsedMs, 4500);
  assert.equal(deck.elapsedMs, bridgeTiming.elapsedMs);
  assert.equal(deck.timecode, bridgeTiming.timecode);
  assert.equal(deck.timingSource, 'beat-grid');
});

test('refreshes a stale beat timestamp when a new status carries the beat number', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  const track = {deviceId: 1, trackId: 123, trackDeviceId: 1, trackSlot: 3, trackType: 1};
  let publishedTiming = null;
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 0};
  monitor.statuses.set(1, {
    ...track,
    beat: 9,
    beatLastSeen: new Date(nowMs - 5000).toISOString(),
    lastSeen: new Date(nowMs - 5000).toISOString()
  });
  monitor.beatGrids.set('1', {
    ...track,
    layerId: 1,
    beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
  });
  monitor.bridge.publishStatus = (_status, timing) => {
    publishedTiming = timing;
  };
  monitor.scheduleDbTrackData = () => {};

  monitor.upsertStatus({...track, beat: 10, isPlayingFlag: true}, {
    timestamp: new Date(nowMs).toISOString(),
    source: '192.0.2.16'
  });

  assert.equal(publishedTiming.source, 'beat-grid');
  assert.ok(publishedTiming.elapsedMs >= 4500 && publishedTiming.elapsedMs < 4550);
});

test('keeps the existing beat anchor while repeated status packets report the same beat', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  const track = {deviceId: 1, trackId: 123, trackDeviceId: 1, trackSlot: 3, trackType: 1};
  let publishedTiming = null;
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 0};
  monitor.statuses.set(1, {
    ...track,
    beat: 10,
    beatLastSeen: new Date(nowMs - 200).toISOString(),
    lastSeen: new Date(nowMs - 200).toISOString(),
    isPlayingFlag: true
  });
  monitor.beatGrids.set('1', {
    ...track,
    layerId: 1,
    beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
  });
  monitor.bridge.publishStatus = (_status, timing) => {
    publishedTiming = timing;
  };
  monitor.scheduleDbTrackData = () => {};

  monitor.upsertStatus({...track, beat: 10, isPlayingFlag: true}, {
    timestamp: new Date(nowMs).toISOString(),
    source: '192.0.2.16'
  });

  assert.equal(publishedTiming.source, 'beat-grid');
  assert.ok(publishedTiming.elapsedMs >= 4700 && publishedTiming.elapsedMs < 4750);
});

test('does not revive a stale beat anchor when status packets repeat the same beat', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  const track = {deviceId: 1, trackId: 123, trackDeviceId: 1, trackSlot: 3, trackType: 1};
  let publishedTiming = null;
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 0};
  monitor.statuses.set(1, {
    ...track,
    beat: 10,
    beatLastSeen: new Date(nowMs - 2600).toISOString(),
    lastSeen: new Date(nowMs - 2600).toISOString(),
    isPlayingFlag: true
  });
  monitor.beatGrids.set('1', {
    ...track,
    layerId: 1,
    beats: Array.from({length: 16}, (_, index) => [index * 500, (index % 4) + 1])
  });
  monitor.bridge.publishStatus = (_status, timing) => {
    publishedTiming = timing;
  };
  monitor.scheduleDbTrackData = () => {};

  monitor.upsertStatus({...track, beat: 10, isPlayingFlag: true}, {
    timestamp: new Date(nowMs).toISOString(),
    source: '192.0.2.16'
  });

  assert.equal(publishedTiming.source, 'none');
  assert.equal(publishedTiming.elapsedMs, null);
});

test('watchdog invalidates timing when the last live packet goes stale', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  const status = {
    deviceId: 1,
    playbackPositionMs: 1000,
    lastSeen: new Date(nowMs).toISOString(),
    isPlayingFlag: true,
    playStateName: 'Playing',
    trackLengthMs: 60_000
  };
  const published = [];
  monitor.running = true;
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 0};
  monitor.statuses.set(1, status);
  monitor.bridge.publishStatus = (_status, timing) => published.push(timing);
  monitor.bridge.broadcastState = () => {};

  monitor.publishCanonicalStatus(status, nowMs);
  monitor.runTimingWatchdog(nowMs + 3000);

  assert.notEqual(published[0].elapsedMs, null);
  assert.equal(published[1].elapsedMs, null);
  assert.equal(published[1].source, 'none');
  assert.equal(monitor.timingValidity.get(1), false);
  monitor.running = false;
});

test('keeps LTC audio compensation out of canonical deck timecode', () => {
  const monitor = new ProLinkMonitor();
  const nowMs = Date.now();
  monitor.options = {timecodeFps: 25, timecodeOffsetMs: 1000};

  const timing = monitor.computeStatusTiming({
    deviceId: 1,
    playbackPositionMs: 2000,
    lastSeen: new Date(nowMs).toISOString(),
    isPlayingFlag: false,
    trackLengthMs: 60_000
  }, {nowMs});

  assert.equal(timing.elapsedMs, 2000);
  assert.equal(timing.timecode, '00:00:02:00');
});

test('periodically re-emits heavy VJ waveform state for late or missed clients', async () => {
  const monitor = new ProLinkMonitor();
  const states = [];
  monitor.on('state', (state) => states.push(state));
  monitor.devices.set(1, {id: 1, name: 'CDJ-3000', ip: '192.0.2.16'});
  monitor.statuses.set(1, {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    playbackPositionMs: 1000,
    totalTimeMs: 4000
  });
  monitor.waveforms.set('1:big:rgb', {
    layerId: 1,
    deviceId: 1,
    trackId: 123,
    kind: 'big',
    style: 'rgb',
    pointCount: 2,
    points: [[1, 255, 0, 0], [2, 0, 255, 0]]
  });
  monitor.markHeavyChanged();

  monitor.emitState();
  assert.equal(states.at(-1).decks[0].waveforms.length, 1);

  monitor.emitState();
  assert.equal(states.at(-1).decks[0].waveforms, undefined);

  monitor.lastHeavyStateEmittedAt = Date.now() - 2_100;
  monitor.emitState();
  assert.equal(states.at(-1).decks[0].waveforms.length, 1);

  await monitor.stop();
});

test('clears stale deck annotations when a deck switches tracks', async () => {
  const monitor = new ProLinkMonitor();
  const oldStatus = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: ''
  };

  monitor.statuses.set(1, {...oldStatus, title: 'Old Track', artist: 'Old Artist'});
  monitor.applyDbTrackData(oldStatus, {
    metadata: {title: 'Old Track', artist: 'Old Artist', artworkId: 9},
    cues: {cueCount: 1, hotCueCount: 1, loopCount: 0, cues: [{hotCueNumber: 1, label: 'A', positionMs: 1000, color: '#55d682'}]},
    beatGrid: {beatCount: 1, beats: [[1000, 1, 120]]},
    artwork: {id: 9, mime: 'image/jpeg', byteLength: 4, dataUrl: 'data:image/jpeg;base64,/9j/2Q=='},
    waveforms: [{kind: 'big', style: 'rgb', pointCount: 1, originalPointCount: 150, totalTimeMs: 1000, points: [[255, 255, 0, 0]]}],
    dbPort: 12524
  }, '192.0.2.16:1:3:1:123');

  monitor.upsertStatus({
    deviceId: 1,
    trackId: 456,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    playStateName: 'Loading'
  }, {
    timestamp: new Date().toISOString(),
    source: ''
  });

  const state = monitor.getState();
  assert.equal(state.statuses[0].trackId, 456);
  assert.equal(state.statuses[0].title, undefined);
  assert.equal(state.metadata.length, 0);
  assert.equal(state.cues.length, 0);
  assert.equal(state.beatGrids.length, 0);
  assert.equal(state.artwork.length, 0);
  assert.equal(state.waveforms.length, 0);

  await monitor.stop();
});

test('rejects stale dbserver data after a newer track becomes current', async () => {
  const monitor = new ProLinkMonitor();
  monitor.devices.set(1, {id: 1, ip: '192.0.2.16'});

  const oldStatus = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: '192.0.2.16'
  };
  const newStatus = {
    ...oldStatus,
    trackId: 456
  };

  monitor.statuses.set(1, newStatus);

  assert.equal(monitor.isCurrentDbTrackData(oldStatus, '192.0.2.16:1:3:1:123'), false);
  assert.equal(monitor.isCurrentDbTrackData(newStatus, '192.0.2.16:1:3:1:456'), true);

  await monitor.stop();
});

test('does not request cue data while core db track data is pending', async () => {
  const monitor = new ProLinkMonitor();
  const status = {
    deviceId: 1,
    trackId: 123,
    trackDeviceId: 1,
    trackSlot: 3,
    trackType: 1,
    source: '192.0.2.16'
  };
  const key = '192.0.2.16:1:3:1:123';
  let cueRequests = 0;
  monitor.requestDbCueData = () => {
    cueRequests += 1;
  };

  monitor.dbPendingKeys.add(key);
  monitor.requestDbTrackData(status);
  assert.equal(cueRequests, 0);

  monitor.dbPendingKeys.delete(key);
  monitor.dbTrackKeys.add(key);
  monitor.requestDbTrackData(status);
  assert.equal(cueRequests, 1);

  await monitor.stop();
});

test('reconfigures outputs without resetting live monitor state', async () => {
  const monitor = new ProLinkMonitor();
  const socket = {close: () => assert.fail('output reconfigure must not close PRO DJ LINK sockets')};
  const device = {id: 1, name: 'CDJ-3000', ip: '192.0.2.16'};
  const status = {deviceId: 1, trackId: 123, trackDeviceId: 1, trackSlot: 3, trackType: 1};
  const bridgeStarts = [];

  monitor.running = true;
  monitor.startedAt = '2026-07-10T12:00:00.000Z';
  monitor.options = {
    interfaceAddress: '192.0.2.11',
    tcnetEnabled: false,
    virtualCdjEnabled: true,
    websocketEnabled: true,
    websocketPort: 7071,
    webConsoleEnabled: true,
    webConsolePort: 7072,
    oscEnabled: false,
    oscHost: '127.0.0.1',
    oscPort: 9000
  };
  monitor.sockets.set(50000, socket);
  monitor.devices.set(1, device);
  monitor.statuses.set(1, status);
  monitor.metadata.set(1, {layerId: 1, trackId: 123, title: 'Track'});
  monitor.waveforms.set('1:big:rgb', {layerId: 1, trackId: 123, points: [[1, 2, 3]]});
  monitor.heavyRevision = 7;
  monitor.bridge.reconfigure = async (options) => bridgeStarts.push(options);

  await monitor.reconfigureOutputs({
    oscEnabled: true,
    oscPort: 9100,
    interfaceAddress: '10.0.0.99',
    tcnetEnabled: true,
    virtualCdjEnabled: false
  });

  assert.equal(bridgeStarts.length, 1);
  assert.equal(monitor.sockets.get(50000), socket);
  assert.equal(monitor.devices.get(1), device);
  assert.equal(monitor.statuses.get(1), status);
  assert.equal(monitor.metadata.size, 1);
  assert.equal(monitor.waveforms.size, 1);
  assert.equal(monitor.heavyRevision, 7);
  assert.equal(monitor.startedAt, '2026-07-10T12:00:00.000Z');
  assert.equal(monitor.options.oscEnabled, true);
  assert.equal(monitor.options.oscPort, 9100);
  assert.equal(monitor.options.interfaceAddress, '192.0.2.11');
  assert.equal(monitor.options.tcnetEnabled, false);
  assert.equal(monitor.options.virtualCdjEnabled, true);

  monitor.running = false;
  monitor.sockets.clear();
});

test('does not start bridge outputs while the monitor is stopped', async () => {
  const monitor = new ProLinkMonitor();
  let calls = 0;
  monitor.bridge.reconfigure = async () => {
    calls += 1;
  };

  const state = await monitor.reconfigureOutputs({oscEnabled: true});

  assert.equal(state.running, false);
  assert.equal(calls, 0);
});

test('serializes rapid output changes and keeps the latest configuration', async () => {
  const monitor = new ProLinkMonitor();
  const ports = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  monitor.running = true;
  monitor.options = {
    interfaceAddress: '192.0.2.11',
    websocketEnabled: false,
    webConsoleEnabled: false,
    oscEnabled: true,
    oscPort: 9000
  };
  monitor.bridge.reconfigure = async (options) => {
    ports.push(options.oscPort);
    if (ports.length === 1) await firstBlocked;
  };

  const first = monitor.reconfigureOutputs({oscPort: 9101});
  await new Promise((resolve) => setImmediate(resolve));
  const second = monitor.reconfigureOutputs({oscPort: 9102});
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(ports, [9101, 9102]);
  assert.equal(monitor.options.oscPort, 9102);
  monitor.running = false;
});

test('rejects late output reconfiguration once monitor stop begins', async () => {
  const monitor = new ProLinkMonitor();
  const calls = [];
  let releaseReconfigure;
  const blocked = new Promise((resolve) => {
    releaseReconfigure = resolve;
  });
  monitor.running = true;
  monitor.options = {
    websocketEnabled: false,
    webConsoleEnabled: false,
    oscEnabled: false
  };
  monitor.bridge.reconfigure = async () => {
    calls.push('reconfigure');
    await blocked;
  };
  monitor.bridge.stop = async () => {
    calls.push('stop');
  };

  const activeReconfigure = monitor.reconfigureOutputs({oscEnabled: true});
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = monitor.stop();
  const lateState = await monitor.reconfigureOutputs({oscPort: 9200});
  releaseReconfigure();
  await Promise.all([activeReconfigure, stopping]);

  assert.equal(lateState.running, false);
  assert.deepEqual(calls, ['reconfigure', 'stop']);
  assert.equal(monitor.stopping, false);
});

test('cancels an in-flight monitor start before late sockets can leak', async () => {
  const monitor = new ProLinkMonitor();
  const calls = [];
  let releaseBind;
  const bindBlocked = new Promise((resolve) => {
    releaseBind = resolve;
  });
  const socket = {
    close(callback) {
      calls.push('socket:close');
      callback();
    }
  };
  monitor.getListenPorts = () => [50000];
  monitor.bindPort = async () => {
    calls.push('bind:start');
    await bindBlocked;
    monitor.sockets.set(50000, socket);
    calls.push('bind:end');
  };
  monitor.bridge.start = async () => {
    calls.push('bridge:start');
  };
  monitor.bridge.stop = async () => {
    calls.push('bridge:stop');
  };
  monitor.emitState = () => {};

  const starting = monitor.start({websocketEnabled: false, webConsoleEnabled: false});
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = monitor.stop();
  releaseBind();
  await Promise.all([starting, stopping]);

  assert.equal(monitor.running, false);
  assert.equal(monitor.sockets.size, 0);
  assert.equal(calls.includes('bridge:start'), false);
  assert.equal(calls.includes('socket:close'), true);
});

test('drops late network ingress after stop is requested', () => {
  const monitor = new ProLinkMonitor();
  monitor.stopRequested = true;
  const packet = Buffer.from(
    '5173707431576d4a4f4c2843444a2d33303030000000000000000000000000010001003c000001ee000003dc000005c9000007b700000d7f00000f6dffffffffffffffffffffffffffffffffffffffffffffffff000fb43900002f7e02000001',
    'hex'
  );

  monitor.handleMessage(50001, packet, {address: '192.0.2.16', port: 39591});

  assert.equal(monitor.packetCounters.total, 0);
  assert.equal(monitor.statuses.size, 0);
});

test('closes monitor sockets even when output shutdown reports an audio error', async () => {
  const monitor = new ProLinkMonitor();
  let socketClosed = 0;
  monitor.running = true;
  monitor.sockets.set(50000, {
    close(callback) {
      socketClosed += 1;
      callback();
    }
  });
  monitor.bridge.stop = async () => {
    throw new Error('audio restore failed');
  };
  monitor.emitState = () => {};

  await assert.rejects(monitor.stop(), /audio restore failed/);

  assert.equal(socketClosed, 1);
  assert.equal(monitor.sockets.size, 0);
  assert.equal(monitor.running, false);
});
