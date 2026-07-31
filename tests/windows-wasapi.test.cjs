const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const {LtcDemoOutput} = require('../src/prolink/ltcDemo.cjs');
const {resolveWindowsAudioHelperPath} = require('../src/prolink/windowsAudioHelperPath.cjs');
const {WindowsWasapiLtcSink} = require('../src/prolink/windowsWasapiLtcSink.cjs');

test('resolves development and packaged Windows helper paths by architecture', () => {
  assert.equal(
    resolveWindowsAudioHelperPath('/workspace/src/prolink', 'x64', {}),
    '/workspace/src/windows-audio-helper/bin/x64/prodjlink-wasapi-ltc.exe'
  );
  assert.equal(
    resolveWindowsAudioHelperPath('/workspace/resources/app.asar/src/prolink', 'arm64', {}),
    '/workspace/resources/app.asar.unpacked/src/windows-audio-helper/bin/arm64/prodjlink-wasapi-ltc.exe'
  );
  assert.equal(
    resolveWindowsAudioHelperPath('/workspace/src/prolink', 'x64', {PRODJLINK_WASAPI_HELPER: 'C:\\Tools\\ltc.exe'}),
    'C:\\Tools\\ltc.exe'
  );
});

test('native helper source accepts the Node start and sync protocol contract', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'windows-audio-helper', 'src', 'main.cpp'),
    'utf8'
  );
  assert.match(source, /FindField\(object, "command"\)/);
  assert.match(source, /ReadString\(object, "endpointId"/);
  assert.match(source, /ReadInt\(object, "fps"/);
  assert.match(source, /command_name == "sync"/);
  assert.match(source, /\\"event\\":\\"started\\"/);
  assert.doesNotMatch(source, /--endpoint-id is required/);
});

test('Windows WASAPI sink sends NDJSON and ignores stale helper events', async () => {
  const child = createFakeChild();
  const commands = collectCommands(child.stdin);
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'C:\\App\\prodjlink-wasapi-ltc.exe',
    existsSync: () => true,
    spawn: () => child,
    stopTimeoutMs: 50
  });

  sink.start({endpointId: 'endpoint-1', endpointName: 'CABLE Input', fps: 25, generation: 2});
  const started = sink.waitUntilStarted(2);
  sink.sync({elapsedMs: 1234, rate: 1.08, sourceKey: 'deck-1', generation: 2});
  assert.deepEqual(commands.map((item) => item.command), ['start', 'sync']);
  assert.equal(commands[0].endpointId, 'endpoint-1');
  assert.equal(commands[1].rate, 1.08);
  assert.equal(commands[1].fps, 25);

  let startSettled = false;
  started.finally(() => {
    startSettled = true;
  });
  child.stdout.write('{"event":"ready"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startSettled, false);
  child.stdout.write('{"event":"started","generation":2,"endpointId":"endpoint-1"}\n{"event":"playing","generation":');
  child.stdout.write('2}\n');
  await started;
  assert.equal(sink.getState().playing, true);

  sink.hold(3);
  child.stdout.write('{"event":"playing","generation":2}\n');
  assert.equal(sink.getState().playing, false);
  assert.equal(commands.at(-1).command, 'hold');

  const stopping = sink.stop();
  child.exit(0);
  await stopping;
  assert.equal(commands.at(-1).command, 'shutdown');
  assert.equal(sink.getState().running, false);
});

test('Windows WASAPI sink does not let an old child overwrite a restarted child', () => {
  const first = createFakeChild();
  const second = createFakeChild();
  const children = [first, second];
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'helper.exe',
    existsSync: () => true,
    spawn: () => children.shift()
  });

  sink.start({endpointId: 'one', generation: 1});
  first.exit(1);
  sink.start({endpointId: 'two', generation: 2});
  first.emit('error', new Error('late old child error'));
  second.stdout.write('{"event":"ready"}\n');

  assert.equal(sink.getState().running, true);
  assert.equal(sink.getState().ready, true);
  assert.equal(sink.getState().endpointId, 'two');
  assert.equal(sink.getState().lastError, null);
});

test('Windows WASAPI sink refuses to start when the helper is missing', () => {
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'missing.exe',
    existsSync: () => false,
    spawn: () => assert.fail('must not spawn')
  });
  assert.throws(() => sink.start({endpointId: 'endpoint-1'}), /helper 不可用/);
});

test('Windows WASAPI sink rejects startup errors from the helper', async () => {
  const child = createFakeChild();
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'helper.exe',
    existsSync: () => true,
    spawn: () => child,
    startTimeoutMs: 50
  });
  sink.start({endpointId: 'missing-endpoint', fps: 30, generation: 4});
  const started = sink.waitUntilStarted(4);
  child.stdout.write('{"event":"error","generation":4,"message":"endpoint unavailable"}\n');
  await assert.rejects(started, /endpoint unavailable/);
  assert.equal(sink.getState().playing, false);
});

test('Windows WASAPI sink reports an unconfirmed helper termination', async () => {
  const child = createFakeChild();
  child.kill = () => false;
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'helper.exe',
    existsSync: () => true,
    spawn: () => child,
    stopTimeoutMs: 5,
    killGraceMs: 5
  });
  sink.start({endpointId: 'endpoint-1', generation: 1});
  child.stdout.write('{"event":"started","generation":1,"endpointId":"endpoint-1"}\n');
  await sink.waitUntilStarted(1);

  await assert.rejects(sink.stop(), /终止超时/);
  assert.equal(sink.getState().terminationUnconfirmed, true);
  assert.throws(() => sink.start({endpointId: 'endpoint-1', generation: 2}), /尚未确认退出/);
});

test('Windows WASAPI sink contains stdin EPIPE instead of crashing the host', () => {
  const child = createFakeChild();
  const sink = new WindowsWasapiLtcSink({
    platform: 'win32',
    helperPath: 'helper.exe',
    existsSync: () => true,
    spawn: () => child
  });
  sink.start({endpointId: 'endpoint-1', generation: 1});

  child.stdin.emit('error', new Error('write EPIPE'));

  assert.equal(sink.getState().inputClosed, true);
  assert.match(sink.getState().lastError, /EPIPE/);
  assert.equal(sink.sync({elapsedMs: 1000, sourceKey: 'deck-1', generation: 1}), false);
});

test('LTC output uses the Windows helper without writing segmented WAV files', async () => {
  const sink = createFakeSink();
  const output = new LtcDemoOutput({platform: 'win32', windowsSink: sink});
  let segmentWrites = 0;
  output.writeAndPlaySegment = async () => {
    segmentWrites += 1;
  };
  output.start({
    enabled: true,
    configureArena: false,
    routeAudioToVirtual: true,
    virtualAudioDeviceName: 'CABLE Input',
    virtualAudioEndpointId: 'endpoint-1'
  });
  await output.waitUntilReady();

  const state = output.update(
    {deck: 1, elapsedMs: 2500},
    {trackKey: 'track-1', playbackRate: 1.16}
  );

  assert.equal(segmentWrites, 0);
  assert.equal(sink.calls[0].command, 'start');
  assert.equal(sink.calls[1].command, 'sync');
  assert.equal(sink.calls[1].rate, 1.16);
  assert.equal(state.mode, 'audio-ltc-wasapi');
  assert.equal(state.playing, true);
  assert.equal(state.audioRoute.endpointId, 'endpoint-1');

  output.hold({sourceDeck: 1});
  assert.equal(output.getState().playing, false);
  assert.equal(sink.calls.at(-1).command, 'hold');
  await output.stop({restoreAudio: false});
  assert.equal(sink.calls.at(-1).command, 'shutdown');
});

test('LTC output fails closed when Windows direct routing cannot start', async () => {
  const sink = createFakeSink({startError: new Error('binary missing')});
  const output = new LtcDemoOutput({platform: 'win32', windowsSink: sink});
  let segmentWrites = 0;
  output.writeAndPlaySegment = async () => {
    segmentWrites += 1;
  };
  output.start({
    enabled: true,
    configureArena: false,
    routeAudioToVirtual: true,
    virtualAudioDeviceName: 'CABLE Input',
    virtualAudioEndpointId: 'endpoint-1'
  });
  await assert.rejects(output.waitUntilReady(), /binary missing/);

  let arenaConfigCalls = 0;
  output.configureArenaIfNeeded = () => {
    arenaConfigCalls += 1;
  };
  const state = output.update({deck: 1, elapsedMs: 1000}, {trackKey: 'track-1'});
  assert.equal(segmentWrites, 0);
  assert.equal(arenaConfigCalls, 0);
  assert.equal(state.playing, false);
  assert.match(state.lastError, /binary missing/);
});

test('explicit Windows manual routing keeps the legacy player fallback', () => {
  const output = new LtcDemoOutput({platform: 'win32', windowsSink: createFakeSink()});
  let segmentWrites = 0;
  output.writeAndPlaySegment = async () => {
    segmentWrites += 1;
  };
  output.start({enabled: true, configureArena: false, routeAudioToVirtual: false});
  output.update({deck: 1, elapsedMs: 1000}, {trackKey: 'manual'});
  assert.equal(segmentWrites, 1);
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.signalCode = signal;
    child.emit('exit', null, signal);
  };
  child.exit = (code = 0) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return child;
}

function collectCommands(stream) {
  const commands = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) commands.push(JSON.parse(line));
    }
  });
  return commands;
}

function createFakeSink(options = {}) {
  const calls = [];
  let state = {
    available: true,
    running: false,
    ready: false,
    playing: false,
    endpointId: '',
    endpointName: '',
    lastError: null
  };
  return {
    calls,
    start(config) {
      calls.push({command: 'start', ...config});
      if (options.startError) throw options.startError;
      state = {
        ...state,
        running: true,
        ready: true,
        endpointId: config.endpointId,
        endpointName: config.endpointName
      };
      return {...state};
    },
    sync(anchor) {
      calls.push({command: 'sync', ...anchor});
      state = {...state, playing: true};
      return true;
    },
    hold(generation) {
      calls.push({command: 'hold', generation});
      state = {...state, playing: false};
      return true;
    },
    async stop() {
      calls.push({command: 'shutdown'});
      state = {...state, running: false, ready: false, playing: false};
      return {...state};
    },
    getState() {
      return {...state};
    }
  };
}
