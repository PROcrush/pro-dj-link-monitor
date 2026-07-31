const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {
  renderLtcPcm,
  decodeGeneratedBitsFromPcm,
  bitsToTimecode,
  formatTimecode,
  msToTimecodeParts
} = require('../src/prolink/ltcAudio.cjs');
const {LtcDemoOutput, buildAudioPlayerCommand} = require('../src/prolink/ltcDemo.cjs');
const {resolveMacAudioHelperPath} = require('../src/prolink/macAudioHelperPath.cjs');

test('renders decodable 25fps LTC audio from millisecond time', () => {
  const pcm = renderLtcPcm({
    startMs: 3723_400,
    durationMs: 1000,
    fps: 25,
    sampleRate: 48000,
    channels: 2
  });

  const bits = decodeGeneratedBitsFromPcm(pcm, {fps: 25, sampleRate: 48000, channels: 2});
  assert.equal(formatTimecode(bitsToTimecode(bits)), '01:02:03:10');
});

test('formats timecode parts for demo status', () => {
  assert.equal(formatTimecode(msToTimecodeParts(2500, 25)), '00:00:02:12');
  assert.equal(formatTimecode(msToTimecodeParts(2500, 30)), '00:00:02:15');
});

test('selects platform-specific LTC demo audio player commands', () => {
  assert.equal(buildAudioPlayerCommand('/tmp/a.wav', 'darwin').command, '/usr/bin/afplay');
  const windows = buildAudioPlayerCommand('C:\\Temp\\a.wav', 'win32');
  assert.equal(windows.command, 'powershell.exe');
  assert.equal(windows.args.includes('-Command'), true);
});

test('defaults LTC demo to Arena SMPTE 2 and rejects unsupported inputs', () => {
  const output = new LtcDemoOutput();
  output.start({enabled: true, arenaSmpteInput: 'SMPTE 4'});
  assert.equal(output.getState().arenaTarget.smpteInput, 'SMPTE 2');
});

test('cancels stale LTC segment work when output is held before playback starts', async () => {
  const output = new LtcDemoOutput();
  const playedFiles = [];
  output.ensureAudioRoute = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {manual: true, supported: true, reason: 'test'};
  };
  output.replacePlayer = (filePath) => {
    playedFiles.push(filePath);
  };
  output.start({
    enabled: true,
    configureArena: false,
    routeAudioToVirtual: false,
    segmentSeconds: 5,
    tempDir: path.join(os.tmpdir(), `prodjlink-ltc-test-${Date.now()}`)
  });

  output.update({deck: 2, elapsedMs: 1000, bpm: 120, beatInMeasure: 1}, {deck: 2, trackId: 'abc'});
  output.hold({sourceDeck: 2, timecode: '00:00:01:00'});
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(playedFiles, []);
  assert.equal(output.getState().playing, false);
  await output.stop({restoreAudio: false});
});

test('holds playback when canonical timing is unavailable instead of coercing null to zero', () => {
  const output = new LtcDemoOutput();
  let segmentWrites = 0;
  output.start({enabled: true, configureArena: false, routeAudioToVirtual: false});
  output.writeAndPlaySegment = async () => {
    segmentWrites += 1;
  };

  const state = output.update({deck: 1, elapsedMs: null}, {trackKey: '1:3:1:123'});

  assert.equal(segmentWrites, 0);
  assert.equal(state.playing, false);
  assert.equal(state.timecode, null);
  assert.match(state.lastError, /等待有效 Deck 时间/);
});

test('waits for pending audio activation before restoring on stop', async () => {
  const output = new LtcDemoOutput();
  const calls = [];
  let active = false;
  let releaseActivation;
  const activationBlocked = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  output.audioRoute = {
    async activate() {
      calls.push('activate:start');
      await activationBlocked;
      active = true;
      calls.push('activate:done');
      return this.getState();
    },
    async restore() {
      calls.push(`restore:${active}`);
      active = false;
      return this.getState();
    },
    getState() {
      return {active};
    }
  };
  output.writeAndPlaySegment = async ({generation}) => {
    await output.ensureAudioRoute(generation);
  };
  output.start({enabled: true, configureArena: false, routeAudioToVirtual: true});
  output.update({deck: 1, elapsedMs: 1000}, {trackId: 'race'});
  await new Promise((resolve) => setImmediate(resolve));

  const stopping = output.stop({restoreAudio: true});
  releaseActivation();
  await stopping;

  assert.deepEqual(calls, ['activate:start', 'activate:done', 'restore:true']);
  assert.equal(active, false);
  assert.equal(output.getState().enabled, false);
});

test('applies delay compensation only inside the LTC output', async () => {
  const output = new LtcDemoOutput();
  output.writeAndPlaySegment = async () => {};
  output.start({
    enabled: true,
    configureArena: false,
    routeAudioToVirtual: false,
    timecodeOffsetMs: 1000
  });

  const state = output.update({deck: 1, elapsedMs: 2000}, {trackId: 'offset'});

  assert.equal(state.timecode, '00:00:03:00');
  await output.stop({restoreAudio: false});
});

test('keeps audio route state retryable when restoration fails', async () => {
  const output = new LtcDemoOutput();
  let active = true;
  let restoreCalls = 0;
  output.audioRoute = {
    async restore() {
      restoreCalls += 1;
      if (restoreCalls === 1) throw new Error('temporary CoreAudio failure');
      active = false;
      return this.getState();
    },
    getState() {
      return {active, originalOutputName: 'MacBook Pro Speakers', targetName: 'BlackHole 2ch'};
    }
  };
  output.start({enabled: true, configureArena: false, routeAudioToVirtual: true});

  await assert.rejects(output.stop({restoreAudio: true}), /temporary CoreAudio failure/);
  assert.equal(output.getState().audioRoute.active, true);
  assert.match(output.getState().lastError, /恢复系统音频输出失败/);

  await output.stop({restoreAudio: true});
  assert.equal(active, false);
  assert.equal(output.getState().enabled, false);
});

test('resolves packaged Swift helper outside app.asar', () => {
  const dirname = '/Applications/PRO DJ LINK Monitor.app/Contents/Resources/app.asar/src/prolink';
  assert.equal(
    resolveMacAudioHelperPath(dirname),
    '/Applications/PRO DJ LINK Monitor.app/Contents/Resources/app.asar.unpacked/src/prolink/macAudioDevice.swift'
  );
});
