const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachWindowsWasapiEndpoints,
  buildVirtualAudioPreflight,
  getVirtualAudioRecommendation,
  isArenaIncompatibleVirtualAudio,
  parseSystemProfilerAudio,
  parseSwiftMacAudioDevices,
  parseWindowsAudioDevices,
  parseWindowsWasapiEndpoints,
  summarizeVirtualAudio
} = require('../src/prolink/audioDevices.cjs');
const {findTargetDevice, requireCurrentOutputDevice} = require('../src/prolink/macAudioRoute.cjs');

test('detects bidirectional virtual audio devices from system_profiler data', () => {
  const devices = parseSystemProfilerAudio({
    SPAudioDataType: [{
      _items: [
        {_name: 'Mac mini扬声器', coreaudio_device_output: 2, coreaudio_device_transport: 'coreaudio_device_type_builtin'},
        {_name: 'BlackHole 2ch', coreaudio_device_input: 2, coreaudio_device_output: 2, coreaudio_device_transport: 'coreaudio_device_type_virtual'}
      ]
    }]
  });

  const summary = summarizeVirtualAudio(devices);
  assert.equal(summary.ok, true);
  assert.equal(summary.preferred.name, 'BlackHole 2ch');
  assert.equal(summary.preferred.inputChannels, 2);
  assert.equal(summary.preferred.outputChannels, 2);
});

test('does not treat output-only devices as virtual loopback candidates', () => {
  const summary = summarizeVirtualAudio([
    {name: 'Display Audio', inputChannels: 0, outputChannels: 2, transport: 'coreaudio_device_type_virtual'}
  ]);

  assert.equal(summary.ok, false);
  assert.equal(summary.preferred, null);
});

test('refuses automatic audio routing without a recoverable default output', () => {
  assert.throws(
    () => requireCurrentOutputDevice([{name: 'BlackHole 2ch', outputChannels: 2, defaultOutput: false}]),
    /已取消自动切换/
  );
  assert.equal(
    requireCurrentOutputDevice([{name: 'MacBook Pro Speakers', outputChannels: 2, defaultOutput: true}]).name,
    'MacBook Pro Speakers'
  );
});

test('detects Windows VB-CABLE playback and recording endpoints as one route', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'CABLE Input (VB-Audio Virtual Cable)', PNPClass: 'AudioEndpoint', Manufacturer: 'VB-Audio'},
    {Name: 'CABLE Output (VB-Audio Virtual Cable)', PNPClass: 'AudioEndpoint', Manufacturer: 'VB-Audio'}
  ]);

  const summary = summarizeVirtualAudio(devices);
  assert.equal(summary.ok, true);
  assert.equal(summary.preferred.name, 'VB-CABLE');
  assert.equal(summary.preferred.inputChannels, 2);
  assert.equal(summary.preferred.outputChannels, 2);
  assert.equal(summary.preferred.playbackEndpoint.name, 'CABLE Input (VB-Audio Virtual Cable)');
  assert.equal(summary.preferred.recordingEndpoint.name, 'CABLE Output (VB-Audio Virtual Cable)');
  assert.equal(summary.preflight.status, 'ready-manual-route');
  assert.equal(summary.preflight.playbackEndpointName, 'CABLE Input (VB-Audio Virtual Cable)');
  assert.equal(summary.preflight.recordingEndpointName, 'CABLE Output (VB-Audio Virtual Cable)');
});

test('does not treat a single Windows virtual endpoint as a complete loopback route', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'CABLE Input (VB-Audio Virtual Cable)', PNPClass: 'AudioEndpoint', Manufacturer: 'VB-Audio'}
  ]);

  const summary = summarizeVirtualAudio(devices);
  assert.equal(summary.ok, false);
  assert.equal(summary.preferred, null);
});

test('attaches a real MMDevice endpoint ID and enables Windows automatic routing', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'CABLE Input (VB-Audio Virtual Cable)', DeviceID: 'SWD\\MMDEVAPI\\PNP-ONLY-RENDER'},
    {Name: 'CABLE Output (VB-Audio Virtual Cable)', DeviceID: 'SWD\\MMDEVAPI\\PNP-ONLY-CAPTURE'}
  ]);
  const endpoints = parseWindowsWasapiEndpoints({
    devices: [{
      endpointId: '{0.0.0.00000000}.{REAL-MMDEVICE-ID}',
      name: 'CABLE Input (VB-Audio Virtual Cable)',
      dataFlow: 'render',
      state: 'active'
    }]
  });
  const summary = summarizeVirtualAudio(attachWindowsWasapiEndpoints(devices, endpoints));

  assert.equal(summary.preferred.playbackEndpoint.deviceId, 'SWD\\MMDEVAPI\\PNP-ONLY-RENDER');
  assert.equal(summary.preferred.playbackEndpoint.endpointId, '{0.0.0.00000000}.{REAL-MMDEVICE-ID}');
  assert.equal(summary.preflight.status, 'ready-auto-route');
  assert.equal(summary.preflight.canAutoRoute, true);
  assert.equal(summary.preflight.requiresManualRouting, false);
});

test('does not auto-route ambiguous or disabled Windows render endpoints', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'CABLE Input (VB-Audio Virtual Cable)'},
    {Name: 'CABLE Output (VB-Audio Virtual Cable)'}
  ]);
  const endpoints = parseWindowsWasapiEndpoints({devices: [
    {endpointId: 'disabled', name: 'CABLE Input (VB-Audio Virtual Cable)', dataFlow: 'render', state: 'disabled'},
    {endpointId: 'one', name: 'CABLE Input (VB-Audio Virtual Cable)', dataFlow: 'render', state: 'active'},
    {endpointId: 'two', name: 'CABLE Input (VB-Audio Virtual Cable)', dataFlow: 'render', state: 'active'}
  ]});
  const summary = summarizeVirtualAudio(attachWindowsWasapiEndpoints(devices, endpoints));

  assert.equal(endpoints.some((endpoint) => endpoint.endpointId === 'disabled'), false);
  assert.equal(summary.preferred.playbackEndpoint.endpointId, undefined);
  assert.equal(summary.preflight.status, 'ready-manual-route');
});

test('keeps VB-CABLE A and B endpoint pairs separate', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'CABLE-A Input (VB-Audio Cable A)'},
    {Name: 'CABLE-A Output (VB-Audio Cable A)'},
    {Name: 'CABLE-B Input (VB-Audio Cable B)'},
    {Name: 'CABLE-B Output (VB-Audio Cable B)'}
  ]);

  assert.deepEqual(devices.map((device) => device.name), ['VB-CABLE A', 'VB-CABLE B']);
  assert.match(devices[0].playbackEndpoint.name, /CABLE-A Input/);
  assert.match(devices[0].recordingEndpoint.name, /CABLE-A Output/);
  assert.match(devices[1].playbackEndpoint.name, /CABLE-B Input/);
  assert.match(devices[1].recordingEndpoint.name, /CABLE-B Output/);
});

test('keeps interleaved Voicemeeter buses separate from generic VB-Audio devices', () => {
  const devices = parseWindowsAudioDevices([
    {Name: 'VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)'},
    {Name: 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)'},
    {Name: 'VoiceMeeter Aux Input (VB-Audio VoiceMeeter AUX VAIO)'},
    {Name: 'VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)'},
    {Name: 'VoiceMeeter VAIO3 Output (VB-Audio VoiceMeeter VAIO3)'},
    {Name: 'VoiceMeeter VAIO3 Input (VB-Audio VoiceMeeter VAIO3)'}
  ]);

  assert.deepEqual(devices.map((device) => device.name), [
    'Voicemeeter AUX',
    'Voicemeeter',
    'Voicemeeter VAIO3'
  ]);
  for (const device of devices) {
    assert.equal(device.inputChannels, 2);
    assert.equal(device.outputChannels, 2);
  }
  assert.match(devices[0].playbackEndpoint.name, /Aux Input/i);
  assert.match(devices[0].recordingEndpoint.name, /Aux Output/i);
  assert.match(devices[1].playbackEndpoint.name, /VoiceMeeter Input/i);
  assert.match(devices[1].recordingEndpoint.name, /VoiceMeeter Output/i);
  assert.match(devices[2].playbackEndpoint.name, /VAIO3 Input/i);
  assert.match(devices[2].recordingEndpoint.name, /VAIO3 Output/i);
});

test('recommends platform-specific virtual audio installers', () => {
  assert.equal(getVirtualAudioRecommendation('darwin').label, 'BlackHole 2ch');
  assert.equal(getVirtualAudioRecommendation('win32').label, 'VB-CABLE');
});

test('finds preferred macOS virtual output target by exact or partial name', () => {
  const candidates = [
    {name: 'BlackHole 2ch'},
    {name: 'EMEET Virtual Audio'}
  ];
  assert.equal(findTargetDevice(candidates, 'EMEET Virtual Audio').name, 'EMEET Virtual Audio');
  assert.equal(findTargetDevice(candidates, 'emeet').name, 'EMEET Virtual Audio');
  assert.equal(findTargetDevice(candidates, 'missing'), null);
});

test('does not mark known Arena-incompatible virtual endpoints as ready', () => {
  const summary = summarizeVirtualAudio([
    {
      name: 'EMEET Virtual Audio',
      inputChannels: 2,
      outputChannels: 2,
      transport: 'coreaudio_device_type_virtual'
    }
  ]);

  assert.equal(isArenaIncompatibleVirtualAudio(summary.candidates[0]), true);
  assert.equal(summary.ok, false);
  assert.equal(summary.preferred, null);
  assert.equal(summary.incompatible[0].name, 'EMEET Virtual Audio');
  assert.equal(summary.preflight.status, 'incompatible-only');
  assert.equal(summary.preflight.blocksLtcDemo, true);
});

test('detects Swift CoreAudio aggregate fallback devices as compatible routes', () => {
  const devices = parseSwiftMacAudioDevices([
    {
      name: 'PRO DJ LINK LTC Aggregate',
      uid: 'local.prodjlink.ltc.aggregate',
      inputChannels: 2,
      outputChannels: 2
    },
    {
      name: 'EMEET Virtual Audio',
      uid: 'EMEET_VirtualAudio_UID',
      inputChannels: 2,
      outputChannels: 2
    }
  ]);

  const summary = summarizeVirtualAudio(devices);
  assert.equal(summary.ok, true);
  assert.equal(summary.preferred.name, 'PRO DJ LINK LTC Aggregate');
  assert.equal(summary.incompatible[0].name, 'EMEET Virtual Audio');
});

test('preflight reports empty macOS audio enumeration as a blocker', () => {
  const preflight = buildVirtualAudioPreflight({
    ok: false,
    preferred: null,
    incompatible: [],
    all: [],
    recommendation: getVirtualAudioRecommendation('darwin')
  }, 'darwin');

  assert.equal(preflight.status, 'no-audio-devices-visible');
  assert.equal(preflight.blocksLtcDemo, true);
  assert.match(preflight.action, /BlackHole 2ch/);
});

test('preflight distinguishes installed BlackHole from missing virtual audio', () => {
  const preflight = buildVirtualAudioPreflight({
    ok: false,
    preferred: null,
    incompatible: [],
    all: [],
    installedDrivers: [{name: 'BlackHole 2ch', path: '/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver'}],
    recommendation: getVirtualAudioRecommendation('darwin')
  }, 'darwin');

  assert.equal(preflight.status, 'driver-installed-enum-empty');
  assert.equal(preflight.requiresManualRouting, true);
  assert.equal(preflight.playbackEndpointName, 'BlackHole 2ch');
});
