const LAYOUT_STORAGE_KEY = 'prodjlink.deckLayout';
const WAVEFORM_SETTINGS_STORAGE_KEY = 'prodjlink.waveformSettings';
const ARENA_PIONEER_MODE_STORAGE_KEY = 'prodjlink.arenaPioneerMode';
const LTC_SOURCE_MODE_STORAGE_KEY = 'prodjlink.ltcSourceMode';
const LTC_OFFSET_STORAGE_KEY = 'prodjlink.ltcOffsetMs';
const DECK_LAYOUTS = new Set(['auto', 'left-right', 'top-bottom']);
const WAVEFORM_MODES = new Set(['auto', 'three-band', 'rgb', 'blue']);
const WAVEFORM_VIEW_MODES = new Set(['overview', 'follow']);
const ARENA_PIONEER_MODES = new Set(['off']);
const LTC_SOURCE_MODES = new Set(['auto', 'deck-1', 'deck-2', 'deck-3', 'deck-4']);
const MAX_WAVEFORM_IMAGE_CACHE = 24;
const RENDER_INTERVAL_MS = 250;
const FOLLOW_WAVEFORM_WINDOW_MS = 60000;
const ARENA_DETECT_INTERVAL_MS = 5000;
const DEFAULT_WAVEFORM_SETTINGS = Object.freeze({
  mode: 'auto',
  viewMode: 'overview',
  heightScale: 1,
  brightness: 1
});

const state = {
  interfaces: [],
  selectedInterface: 'all',
  monitor: null,
  arena: {ok: false, connectedClips: [], error: ''},
  virtualAudio: {ok: false, preferred: null, candidates: [], error: ''},
  officialBridge: {available: false, running: false, path: null, lastError: ''},
  arenaPioneerMode: 'off',
  layout: normalizeDeckLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY)),
  waveformSettings: readWaveformSettings()
};
const waveformImageCache = new Map();
const waveformIssueLog = new Map();
let pendingRenderState = null;
let renderTimer = null;
let lastRenderAt = 0;
let waveformFrame = 0;
let renderedDeckMarkupKey = '';
let arenaDetectTimer = null;
let startMonitorPromise = null;
let reconfigureOutputsPromise = Promise.resolve();
let lastSuccessfulOutputOptions = null;

const els = {
  interfaceSelect: document.querySelector('#interfaceSelect'),
  layoutSelect: document.querySelector('#layoutSelect'),
  waveformModeSelect: document.querySelector('#waveformModeSelect'),
  waveformViewSelect: document.querySelector('#waveformViewSelect'),
  waveformHeightScale: document.querySelector('#waveformHeightScale'),
  waveformBrightness: document.querySelector('#waveformBrightness'),
  interfaceAddress: document.querySelector('#interfaceAddress'),
  interfaceMac: document.querySelector('#interfaceMac'),
  statusPill: document.querySelector('#statusPill'),
  masterWatch: document.querySelector('#masterWatch'),
  startButton: document.querySelector('#startButton'),
  forceRefreshButton: document.querySelector('#forceRefreshButton'),
  advancedNavButton: document.querySelector('#advancedNavButton'),
  monitorNavButton: document.querySelector('#monitorNavButton'),
  waveformLogButton: document.querySelector('#waveformLogButton'),
  stopButton: document.querySelector('#stopButton'),
  exportButton: document.querySelector('#exportButton'),
  clearLogButton: document.querySelector('#clearLogButton'),
  tcnetCaptureButton: document.querySelector('#tcnetCaptureButton'),
  tcnetCaptureStatus: document.querySelector('#tcnetCaptureStatus'),
  tcnetToggle: document.querySelector('#tcnetToggle'),
  tcnetNodeToggle: document.querySelector('#tcnetNodeToggle'),
  virtualCdjToggle: document.querySelector('#virtualCdjToggle'),
  virtualCdjId: document.querySelector('#virtualCdjId'),
  tcnetUnicastPort: document.querySelector('#tcnetUnicastPort'),
  websocketToggle: document.querySelector('#websocketToggle'),
  websocketPort: document.querySelector('#websocketPort'),
  webConsolePort: document.querySelector('#webConsolePort'),
  webConsoleLanToggle: document.querySelector('#webConsoleLanToggle'),
  webAddressText: document.querySelector('#webAddressText'),
  oscToggle: document.querySelector('#oscToggle'),
  oscHost: document.querySelector('#oscHost'),
  oscPort: document.querySelector('#oscPort'),
  arenaPioneerMode: document.querySelector('#arenaPioneerMode'),
  officialBridgeButton: document.querySelector('#officialBridgeButton'),
  officialBridgeStatus: document.querySelector('#officialBridgeStatus'),
  arenaConnectButton: document.querySelector('#arenaConnectButton'),
  arenaTimecodeToggle: document.querySelector('#arenaTimecodeToggle'),
  arenaLayer: document.querySelector('#arenaLayer'),
  arenaClip: document.querySelector('#arenaClip'),
  timecodeFps: document.querySelector('#timecodeFps'),
  virtualAudioStatus: document.querySelector('#virtualAudioStatus'),
  ltcPreflightStatus: document.querySelector('#ltcPreflightStatus'),
  ltcDemoToggle: document.querySelector('#ltcDemoToggle'),
  ltcManualRouteToggle: document.querySelector('#ltcManualRouteToggle'),
  ltcDemoConfigureArena: document.querySelector('#ltcDemoConfigureArena'),
  ltcSourceMode: document.querySelector('#ltcSourceMode'),
  ltcDemoSmpteInput: document.querySelector('#ltcDemoSmpteInput'),
  ltcDemoSeconds: document.querySelector('#ltcDemoSeconds'),
  ltcOffsetMs: document.querySelector('#ltcOffsetMs'),
  ltcDemoStatus: document.querySelector('#ltcDemoStatus'),
  deckGrid: document.querySelector('#deckGrid')
};

async function init() {
  state.interfaces = await window.prolink.listInterfaces();
  state.selectedInterface = pickDefaultInterface()?.id || 'all';
  els.layoutSelect.value = state.layout;
  if (els.arenaPioneerMode) els.arenaPioneerMode.value = state.arenaPioneerMode;
  if (els.ltcSourceMode) els.ltcSourceMode.value = readLtcSourceMode();
  if (els.ltcOffsetMs) els.ltcOffsetMs.value = String(readLtcOffsetMs());
  window.localStorage.setItem(ARENA_PIONEER_MODE_STORAGE_KEY, state.arenaPioneerMode);
  syncWaveformControls();
  renderInterfaceSelect();
  render(await window.prolink.getState());
  renderOfficialBridgeStatus();
  await detectVirtualAudio();

  window.prolink.onState((nextState) => {
    state.monitor = mergeMonitorState(state.monitor, nextState);
    queueRender(state.monitor);
  });

  els.interfaceSelect.addEventListener('change', () => {
    state.selectedInterface = els.interfaceSelect.value;
    renderInterfaceMeta();
    renderWebAddress();
  });

  els.layoutSelect.addEventListener('change', () => {
    state.layout = normalizeDeckLayout(els.layoutSelect.value);
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, state.layout);
    applyDeckLayout();
  });

  els.advancedNavButton.addEventListener('click', toggleAdvancedView);
  els.monitorNavButton.addEventListener('click', () => setActiveView('monitor'));
  els.deckGrid.addEventListener('click', handleDeckLtcSourceClick);

  for (const control of [els.waveformModeSelect, els.waveformViewSelect, els.waveformHeightScale, els.waveformBrightness]) {
    control.addEventListener('input', updateWaveformSettingsFromControls);
    control.addEventListener('change', updateWaveformSettingsFromControls);
  }

  els.startButton.addEventListener('click', () => startMonitor({manual: true}));
  els.webConsolePort.addEventListener('input', renderWebAddress);
  els.webConsolePort.addEventListener('change', async () => {
    renderWebAddress();
    if (!state.monitor?.running) return;
    await restartBridgeIfRunning();
  });
  els.webConsoleLanToggle.addEventListener('change', async () => {
    renderWebAddress();
    if (!state.monitor?.running) return;
    await restartBridgeIfRunning();
  });
  els.arenaTimecodeToggle.addEventListener('change', () => {
    if (!els.arenaTimecodeToggle.checked) return;
    if (els.oscPort.value === '9000') els.oscPort.value = '51337';
  });
  els.arenaConnectButton.addEventListener('click', async () => {
    await connectArena({restart: true, manual: true});
  });
  els.virtualAudioStatus?.addEventListener('click', handleVirtualAudioClick);
  els.officialBridgeButton?.addEventListener('click', () => renderOfficialBridgeStatus());
  els.arenaPioneerMode?.addEventListener('change', () => {
    state.arenaPioneerMode = 'off';
    els.arenaPioneerMode.value = 'off';
    window.localStorage.setItem(ARENA_PIONEER_MODE_STORAGE_KEY, state.arenaPioneerMode);
    renderOfficialBridgeStatus();
  });

  for (const control of [
    els.websocketToggle,
    els.websocketPort,
    els.oscToggle,
    els.oscHost,
    els.oscPort,
    els.arenaTimecodeToggle,
    els.arenaLayer,
    els.arenaClip,
    els.timecodeFps,
    els.ltcDemoToggle,
    els.ltcManualRouteToggle,
    els.ltcDemoConfigureArena,
    els.ltcSourceMode,
    els.ltcDemoSmpteInput,
    els.ltcDemoSeconds,
    els.ltcOffsetMs
  ]) {
    control.addEventListener('change', async () => {
      persistLtcControls();
      await restartBridgeIfRunning();
    });
  }

  els.forceRefreshButton.addEventListener('click', async () => {
    els.forceRefreshButton.disabled = true;
    try {
      const nextState = await window.prolink.forceRefresh();
      state.monitor = mergeMonitorState(state.monitor, nextState);
      render(state.monitor);
    } finally {
      els.forceRefreshButton.disabled = !state.monitor?.running;
    }
  });

  els.waveformLogButton.addEventListener('click', async () => {
    els.waveformLogButton.disabled = true;
    try {
      await window.prolink.exportWaveformLog();
    } finally {
      els.waveformLogButton.disabled = false;
    }
  });

  els.stopButton.addEventListener('click', async () => {
    const nextState = await window.prolink.stop();
    render(nextState);
    if (nextState.lastError) window.alert(nextState.lastError);
  });

  els.clearLogButton.addEventListener('click', async () => {
    render(await window.prolink.clearLog());
  });

  els.exportButton.addEventListener('click', async () => {
    await window.prolink.exportJson();
  });

  els.tcnetCaptureButton.addEventListener('click', async () => {
    els.tcnetCaptureButton.disabled = true;
    try {
      await window.prolink.exportTcnetCapture();
    } finally {
      els.tcnetCaptureButton.disabled = false;
    }
  });

  renderArenaStatus();
}

function pickDefaultInterface() {
  return state.interfaces.find((item) => item.mac && !item.name.startsWith('utun')) || state.interfaces[0] || null;
}

async function startMonitor(options = {}) {
  const manual = Boolean(options.manual);
  if (!manual && !state.monitor?.running) {
    const nextState = await window.prolink.getState();
    render(nextState);
    return nextState;
  }
  if (startMonitorPromise) return startMonitorPromise;
  startMonitorPromise = startMonitorOnce({manual}).finally(() => {
    startMonitorPromise = null;
  });
  return startMonitorPromise;
}

async function startMonitorOnce({manual = false} = {}) {
  const selected = getSelectedInterface();
  if (els.ltcDemoToggle?.checked) {
    await detectVirtualAudio();
    const preflight = state.virtualAudio?.preflight || {};
    const manualRouteAllowed = isManualLtcRouteAllowed();
    const routeReady = Boolean(preflight.canAutoRoute || manualRouteAllowed);
    const detectedRoute = Boolean(state.virtualAudio?.ok && state.virtualAudio?.preferred);
    if (!routeReady || (!detectedRoute && !manualRouteAllowed)) {
      const action = preflight.action || `请先安装或选择 ${state.virtualAudio?.recommendation?.label || 'BlackHole 2ch'}。`;
      window.alert(`LTC Demo 需要兼容 Arena 的虚拟声卡。\n${preflight.headline || ''}\n${action}`.trim());
      els.ltcDemoToggle.checked = false;
    }
  }
  const outputOptions = readOutputOptions();
  const nextState = await window.prolink.start({
    interfaceId: selected?.id || 'all',
    manualStart: Boolean(manual),
    interfaceAddress: selected?.address || '0.0.0.0',
    interfaceMac: selected?.mac || '',
    tcnetEnabled: false,
    tcnetNodeEnabled: Boolean(els.tcnetNodeToggle?.checked),
    tcnetUnicastPort: parseIntInput(els.tcnetUnicastPort, 65024),
    virtualCdjEnabled: Boolean(selected?.mac && selected?.address && selected?.id !== 'all'),
    virtualCdjId: parseIntInput(els.virtualCdjId, 7),
    ...outputOptions
  });
  render(nextState);
  if (nextState.lastError) window.alert(nextState.lastError);
  else if (nextState.running) {
    lastSuccessfulOutputOptions = {...outputOptions};
    if (!sameOutputOptions(outputOptions, readOutputOptions())) await restartBridgeIfRunning();
  }
}

function readOutputOptions() {
  const arenaPioneerMode = getArenaPioneerMode();
  const manualRouteAllowed = isManualLtcRouteAllowed();
  const autoRouteReady = Boolean(state.virtualAudio?.preflight?.canAutoRoute);
  return {
    websocketEnabled: els.websocketToggle.checked,
    websocketPort: parseIntInput(els.websocketPort, 7071),
    webConsoleEnabled: true,
    webConsolePort: parseIntInput(els.webConsolePort, 7072),
    webConsoleLanEnabled: Boolean(els.webConsoleLanToggle.checked),
    oscEnabled: els.oscToggle.checked,
    oscHost: els.oscHost.value.trim() || '127.0.0.1',
    oscPort: parseIntInput(els.oscPort, 9000),
    arenaPioneerMode,
    arenaPioneerEnabled: arenaPioneerMode === 'tcnet',
    arenaPioneerHost: '255.255.255.255',
    arenaPioneerControlPort: 60000,
    arenaPioneerTimePort: 60001,
    arenaPioneerListenerPort: 65024,
    arenaTimecodeEnabled: els.arenaTimecodeToggle.checked,
    arenaApiEnabled: els.arenaTimecodeToggle.checked,
    arenaClipPositionEnabled: false,
    arenaApiHost: '127.0.0.1',
    arenaApiPort: 8080,
    arenaLayer: parseIntInput(els.arenaLayer, 1),
    arenaClip: parseIntInput(els.arenaClip, 1),
    timecodeFps: parseIntInput(els.timecodeFps, 25),
    timecodeOffsetMs: clampNumber(parseIntInput(els.ltcOffsetMs, 0), -1000, 1000, 0),
    timecodeDemoEnabled: Boolean(els.ltcDemoToggle?.checked && (state.virtualAudio?.ok || manualRouteAllowed) && (autoRouteReady || manualRouteAllowed)),
    timecodeDemoConfigureArena: els.ltcDemoConfigureArena?.checked !== false,
    timecodeDemoSegmentSeconds: parseIntInput(els.ltcDemoSeconds, 60),
    timecodeDemoSourceMode: readLtcSourceMode(),
    timecodeDemoSmpteInput: els.ltcDemoSmpteInput?.value || 'SMPTE 2',
    timecodeDemoRouteAudio: !manualRouteAllowed,
    timecodeDemoVirtualAudioName: state.virtualAudio?.preferred?.playbackEndpoint?.name || state.virtualAudio?.preflight?.playbackEndpointName || state.virtualAudio?.preferred?.name || 'BlackHole 2ch',
    timecodeDemoVirtualAudioId: state.virtualAudio?.preferred?.playbackEndpoint?.endpointId || state.virtualAudio?.preflight?.playbackEndpointId || ''
  };
}

function isManualLtcRouteAllowed() {
  if (!els.ltcManualRouteToggle?.checked) return false;
  const preflight = state.virtualAudio?.preflight || {};
  return Boolean(preflight.requiresManualRouting || preflight.status === 'driver-installed-enum-empty');
}

function setActiveView(view) {
  const showAdvanced = view === 'advanced';
  document.body.classList.toggle('view-advanced', showAdvanced);
  document.body.classList.toggle('view-monitor', !showAdvanced);
  els.advancedNavButton.classList.toggle('is-active', showAdvanced);
  if (!showAdvanced) render(state.monitor);
}

function toggleAdvancedView() {
  setActiveView(document.body.classList.contains('view-advanced') ? 'monitor' : 'advanced');
}

function renderInterfaceSelect() {
  const options = [
    {id: 'all', label: '全部 IPv4 网卡'},
    ...state.interfaces.map((item) => ({
      id: item.id,
      label: `${item.name} ${item.address}`
    }))
  ];

  els.interfaceSelect.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
    .join('');
  els.interfaceSelect.value = state.selectedInterface;
  renderInterfaceMeta();
}

function renderInterfaceMeta() {
  const selected = getSelectedInterface();
  els.interfaceAddress.textContent = selected?.address || '全部 IPv4';
  els.interfaceMac.textContent = selected?.mac || '-';
  renderWebAddress();
}

function render(nextState) {
  pendingRenderState = null;
  state.monitor = nextState || state.monitor || {};
  const monitor = state.monitor;

  els.statusPill.textContent = monitor.running ? '监听中' : '未监听';
  els.statusPill.classList.toggle('running', Boolean(monitor.running));
  els.statusPill.classList.toggle('idle', !monitor.running);
  els.startButton.disabled = Boolean(monitor.running);
  els.forceRefreshButton.disabled = !monitor.running;
  els.stopButton.disabled = !monitor.running;
  setSetupControlsDisabled(Boolean(monitor.running));
  applyDeckLayout();
  renderWebAddress();
  renderArenaStatus();
  renderOfficialBridgeStatus();
  renderTcnetCaptureStatus();
  renderVirtualAudioStatus();
  renderLtcDemoStatus();

  const deckCards = buildDeckCards(monitor);
  renderMasterWatch(deckCards);
  const markupKey = deckCards.map(deckMarkupKey).join('||');
  if (markupKey !== renderedDeckMarkupKey) {
    els.deckGrid.innerHTML = deckCards.map((deck, index) => renderDeckCard(deck, index)).join('');
    renderedDeckMarkupKey = markupKey;
  }
  updateDeckLiveFields(deckCards);
  if (waveformFrame) window.cancelAnimationFrame(waveformFrame);
  waveformFrame = window.requestAnimationFrame(() => {
    waveformFrame = 0;
    deckCards.forEach((deck, index) => drawWaveform(document.querySelector(`#waveformCanvas${index}`), deck, state.waveformSettings));
  });
}

function renderMasterWatch(deckCards) {
  if (!els.masterWatch) return;
  const masterDeck = deckCards.find((deck) => deck.isMaster);
  const liveDeck = deckCards.find((deck) => deck.stateClass === 'playing');
  const label = [
    masterDeck ? `MASTER D${masterDeck.id}` : '等待 MASTER',
    liveDeck ? `LIVE D${liveDeck.id}` : ''
  ].filter(Boolean).join(' / ');
  const text = els.masterWatch.querySelector('strong');
  if (text && text.textContent !== label) text.textContent = label;
  els.masterWatch.classList.toggle('has-master', Boolean(masterDeck));
  els.masterWatch.classList.toggle('has-live', Boolean(liveDeck));
}

function renderWebAddress() {
  if (!els.webAddressText) return;
  const address = getWebAddressHost();
  const port = parseIntInput(els.webConsolePort, 7072);
  const url = address ? `http://${address}:${port}/` : `http://--:${port}/`;
  els.webAddressText.textContent = url;
  els.webAddressText.title = url;
}

function startArenaAutoDetect() {
  if (arenaDetectTimer) window.clearInterval(arenaDetectTimer);
  arenaDetectTimer = window.setInterval(() => {
    connectArena({restart: true}).catch(() => {});
  }, ARENA_DETECT_INTERVAL_MS);
}

async function connectArena({restart = false, manual = false} = {}) {
  if (!window.prolink?.detectArena) return;
  const previousEnabled = Boolean(els.arenaTimecodeToggle.checked || els.ltcDemoToggle?.checked);
  const previousLayer = parseIntInput(els.arenaLayer, 1);
  const previousClip = parseIntInput(els.arenaClip, 1);
  setArenaDetecting(true);
  try {
    const result = await window.prolink.detectArena();
    state.arena = result || {ok: false, connectedClips: [], error: ''};
    const connectedClip = result?.connectedClips?.[0];
    if (!result?.ok) {
      renderArenaStatus();
      return;
    }

    const currentLayer = parseIntInput(els.arenaLayer, 1);
    const currentClip = parseIntInput(els.arenaClip, 1);
    const currentTargetConnected = result.connectedClips?.some((item) => item.layer === currentLayer && item.clip === currentClip);
    if (connectedClip && !currentTargetConnected) {
      els.arenaLayer.value = String(connectedClip.layer);
      els.arenaClip.value = String(connectedClip.clip);
    }
    renderArenaStatus();

    const nextLayer = parseIntInput(els.arenaLayer, 1);
    const nextClip = parseIntInput(els.arenaClip, 1);
    const targetChanged = nextLayer !== previousLayer || nextClip !== previousClip;
    const shouldRestart = restart && state.monitor?.running && (!previousEnabled || targetChanged || manual);
    if (shouldRestart) await restartBridgeIfRunning();
  } catch (error) {
    state.arena = {ok: false, connectedClips: [], error: error.message};
    renderArenaStatus();
  } finally {
    setArenaDetecting(false);
  }
}

function setArenaDetecting(detecting) {
  if (!els.arenaConnectButton) return;
  els.arenaConnectButton.classList.toggle('detecting', Boolean(detecting));
  if (detecting) els.arenaConnectButton.textContent = 'Arena 检测中';
}

function renderArenaStatus() {
  if (!els.arenaConnectButton) return;
  const timecode = state.monitor?.outputs?.timecode || {};
  const connectedClip = state.arena?.connectedClips?.find((item) =>
    item.layer === parseIntInput(els.arenaLayer, 1) && item.clip === parseIntInput(els.arenaClip, 1)
  ) || state.arena?.connectedClips?.[0];
  const hasError = Boolean(timecode.lastError);
  const syncing = Boolean(state.arena?.ok && timecode.enabled && !hasError);
  const connected = Boolean(state.arena?.ok);
  els.arenaConnectButton.classList.toggle('connected', connected && !syncing);
  els.arenaConnectButton.classList.toggle('syncing', syncing);
  els.arenaConnectButton.classList.toggle('disconnected', !connected || hasError);

  if (syncing) {
    els.arenaConnectButton.textContent = 'Arena 同步中';
  } else if (connected) {
    els.arenaConnectButton.textContent = 'Arena 已连接';
  } else {
    els.arenaConnectButton.textContent = 'Arena 未连接';
  }

  const details = [];
  if (connectedClip) details.push(`L${connectedClip.layer} / C${connectedClip.clip}${connectedClip.name ? ` ${connectedClip.name}` : ''}`);
  if (timecode.bpm) details.push(`BPM ${Number(timecode.bpm).toFixed(2)}`);
  if (timecode.beatInMeasure) details.push(`拍 ${timecode.beatInMeasure}`);
  if (state.monitor?.outputs?.ltcDemo?.playing) details.push('LTC Demo');
  if (hasError) details.push(timecode.lastError);
  if (!connected && state.arena?.error) details.push(state.arena.error);
  els.arenaConnectButton.title = details.length ? details.join(' | ') : '连接 Resolume Arena Webserver';
}

async function detectVirtualAudio() {
  if (!window.prolink?.detectVirtualAudio) return;
  try {
    state.virtualAudio = await window.prolink.detectVirtualAudio();
  } catch (error) {
    state.virtualAudio = {ok: false, preferred: null, candidates: [], error: error.message};
  }
  renderVirtualAudioStatus();
}

async function handleVirtualAudioClick() {
  await detectVirtualAudio();
  if (!state.virtualAudio?.ok && window.prolink?.openVirtualAudioGuide) {
    await window.prolink.openVirtualAudioGuide();
  }
}

function renderVirtualAudioStatus() {
  if (!els.virtualAudioStatus) return;
  const preferred = state.virtualAudio?.preferred;
  const ok = Boolean(state.virtualAudio?.ok && preferred);
  els.virtualAudioStatus.classList.toggle('ready', ok);
  els.virtualAudioStatus.classList.toggle('missing', !ok);
  if (ok) {
    els.virtualAudioStatus.textContent = preferred.name;
  } else {
    els.virtualAudioStatus.textContent = state.virtualAudio?.preflight?.status === 'no-audio-devices-visible'
      ? '音频不可见'
      : state.virtualAudio?.recommendation?.label || '未检测到';
  }
  const details = [];
  if (state.virtualAudio?.preflight?.headline) details.push(state.virtualAudio.preflight.headline);
  if (state.virtualAudio?.preflight?.action) details.push(state.virtualAudio.preflight.action);
  if (preferred) details.push(`${preferred.inputChannels} in / ${preferred.outputChannels} out`);
  if (preferred?.playbackEndpoint?.name) details.push(`软件输出：${preferred.playbackEndpoint.name}`);
  if (preferred?.recordingEndpoint?.name) details.push(`Arena 输入：${preferred.recordingEndpoint.name}`);
  if (state.virtualAudio?.candidates?.length) details.push(`${state.virtualAudio.candidates.length} 个候选`);
  if (state.virtualAudio?.incompatible?.length) {
    details.push(`不兼容：${state.virtualAudio.incompatible.map((device) => device.name).join(', ')}`);
  }
  if (!ok && state.virtualAudio?.recommendation?.summary) details.push(state.virtualAudio.recommendation.summary);
  if (state.virtualAudio?.error) details.push(state.virtualAudio.error);
  els.virtualAudioStatus.title = details.join(' | ') || '未检测到可用虚拟声卡；点击打开安装引导';
  renderLtcPreflightStatus();
}

function renderLtcPreflightStatus() {
  if (!els.ltcPreflightStatus) return;
  const preflight = state.virtualAudio?.preflight || {};
  const ok = Boolean(preflight.ok);
  const severity = preflight.severity || (ok ? 'ok' : 'error');
  els.ltcPreflightStatus.classList.toggle('ready', ok);
  els.ltcPreflightStatus.classList.toggle('warning', severity === 'warning');
  els.ltcPreflightStatus.classList.toggle('error', !ok && severity !== 'warning');
  if (ok && preflight.requiresManualRouting) {
    els.ltcPreflightStatus.textContent = '需要手动路由';
  } else if (ok && preflight.platform === 'win32' && preflight.status === 'ready-auto-route') {
    els.ltcPreflightStatus.textContent = 'WASAPI 直连';
  } else if (ok) {
    els.ltcPreflightStatus.textContent = '可自动路由';
  } else if (preflight.status === 'no-audio-devices-visible') {
    els.ltcPreflightStatus.textContent = '音频设备不可见';
  } else if (preflight.status === 'driver-installed-enum-empty') {
    els.ltcPreflightStatus.textContent = '需手动路由';
  } else if (preflight.status === 'incompatible-only') {
    els.ltcPreflightStatus.textContent = '设备不兼容';
  } else {
    els.ltcPreflightStatus.textContent = '需要虚拟声卡';
  }
  const details = [
    preflight.headline,
    preflight.action,
    preflight.playbackEndpointName ? `输出 ${preflight.playbackEndpointName}` : '',
    preflight.recordingEndpointName ? `输入 ${preflight.recordingEndpointName}` : ''
  ].filter(Boolean);
  els.ltcPreflightStatus.title = details.join(' | ') || '等待虚拟声卡检测';
}

function renderLtcDemoStatus() {
  if (!els.ltcDemoStatus) return;
  const demo = state.monitor?.outputs?.ltcDemo || {};
  els.ltcDemoStatus.classList.toggle('running', Boolean(demo.enabled && demo.playing && !demo.lastError));
  els.ltcDemoStatus.classList.toggle('error', Boolean(demo.lastError));
  if (!demo.enabled) {
    els.ltcDemoStatus.textContent = '待机';
  } else if (demo.lastError) {
    els.ltcDemoStatus.textContent = summarizeLtcDemoError(demo.lastError);
  } else if (demo.playing) {
    els.ltcDemoStatus.textContent = `D${demo.sourceDeck || '-'} ${demo.timecode || '--:--:--:--'}`;
  } else {
    els.ltcDemoStatus.textContent = '等待 Deck';
  }

  const details = [];
  if (demo.arenaTarget) details.push(`Arena L${demo.arenaTarget.layer}/C${demo.arenaTarget.clip} ${demo.arenaTarget.smpteInput}`);
  if (demo.arenaConfigured) details.push('已切 SMPTE');
  if (demo.audioRoute?.active) details.push(`输出到 ${demo.audioRoute.targetName}`);
  if (demo.audioRoute?.endpointId) details.push(`WASAPI ${demo.audioRoute.endpointId}`);
  if (demo.audioRoute?.manual && demo.audioRoute?.playbackEndpointName) {
    details.push(`默认播放设为 ${demo.audioRoute.playbackEndpointName}`);
  }
  if (demo.audioRoute?.manual && demo.audioRoute?.recordingEndpointName) {
    details.push(`Arena 输入设为 ${demo.audioRoute.recordingEndpointName}`);
  }
  if (demo.audioRoute?.reason) details.push(demo.audioRoute.reason);
  if (demo.audioRoute?.originalOutputName) details.push(`原输出 ${demo.audioRoute.originalOutputName}`);
  if (demo.audioRoute?.lastError) details.push(demo.audioRoute.lastError);
  if (demo.windowsAudioHelper?.ready) details.push('Windows helper 已就绪');
  if (demo.wavPath) details.push(demo.wavPath);
  if (demo.lastError) details.push(demo.lastError);
  els.ltcDemoStatus.title = details.join(' | ') || 'LTC Demo 待机';
}

function summarizeLtcDemoError(message = '') {
  const text = String(message || '');
  if (/等待有效 Deck 时间/.test(text)) return '等待 Deck';
  if (/虚拟声卡|audio route|macAudioDevice|WASAPI|app\.asar/.test(text)) return '路由异常';
  if (/Arena SMPTE|Arena API|ECONNREFUSED|ETIMEDOUT/.test(text)) return 'Arena异常';
  if (/afplay|playback|player/i.test(text)) return '播放异常';
  return '异常';
}

function renderTcnetCaptureStatus() {
  if (!els.tcnetCaptureStatus) return;
  const capture = state.monitor?.health?.tcnetCapture || {};
  const total = Number(capture.total || 0);
  const recent = Array.isArray(capture.recent) ? capture.recent : [];
  const last = recent[0];
  els.tcnetCaptureStatus.textContent = `${total} 包`;
  const detail = last ? `${last.typeName || 'unknown'} ${last.source || ''}:${last.sourcePort || ''} -> ${last.localPort || ''}` : '等待 Arena / Bridge / ShowKontrol TCNet 数据';
  els.tcnetCaptureStatus.title = detail.trim();
}

async function refreshOfficialBridgeStatus() {
  renderOfficialBridgeStatus();
}

async function startOfficialBridge({manual = false} = {}) {
  state.officialBridge = {
    available: false,
    running: false,
    disabled: true,
    path: null,
    lastError: '官方 Bridge 路线已禁用。'
  };
  renderOfficialBridgeStatus({pending: true});
  renderOfficialBridgeStatus();
  if (manual && state.officialBridge?.lastError) window.alert(state.officialBridge.lastError);
  return state.officialBridge;
}

function renderOfficialBridgeStatus(override = {}) {
  if (!els.officialBridgeStatus) return;
  const label = 'Virtual CDJ 根基';
  els.officialBridgeStatus.textContent = label;
  els.officialBridgeStatus.className = 'bridge-status ready';
  els.officialBridgeStatus.title = '官方 Bridge / TCNet 输出已禁用，只保留 Virtual CDJ + PRO DJ LINK 被动读取。';
  if (els.officialBridgeButton) {
    els.officialBridgeButton.textContent = 'Bridge 禁用';
    els.officialBridgeButton.disabled = true;
  }
}

function getWebAddressHost() {
  if (!els.webConsoleLanToggle?.checked) return '127.0.0.1';
  const selected = getSelectedInterface();
  const selectedAddress = selected?.address || '';
  if (selectedAddress && selectedAddress !== '0.0.0.0') return selectedAddress;
  const monitorAddress = state.monitor?.interface?.address || '';
  if (monitorAddress && monitorAddress !== '0.0.0.0') return monitorAddress;
  return state.interfaces.find((item) => item.mac && item.address && !item.name.startsWith('utun'))?.address || '';
}

function mergeMonitorState(previousState, nextState) {
  if (!previousState || !Array.isArray(previousState.decks) || !Array.isArray(nextState?.decks)) return nextState || {};
  const previousById = new Map(previousState.decks.map((deck) => [Number(deck.id), deck]));
  const sameHeavyRevision = nextState.heavyRevision === previousState.heavyRevision;
  return {
    ...nextState,
    decks: nextState.decks.map((deck) => mergeDeckHeavyData(previousById.get(Number(deck.id)), deck, sameHeavyRevision))
  };
}

function mergeDeckHeavyData(previousDeck, nextDeck, sameHeavyRevision) {
  if (!previousDeck || !nextDeck) return nextDeck;
  const sameTrack = Boolean(nextDeck.trackKey) && nextDeck.trackKey === previousDeck.trackKey;
  if (!sameTrack || !sameHeavyRevision) return nextDeck;

  const merged = {...nextDeck};
  if (!Array.isArray(merged.waveforms) || !merged.waveforms.length) merged.waveforms = previousDeck.waveforms;
  if (!merged.waveform) merged.waveform = previousDeck.waveform;
  if (!merged.cues) merged.cues = previousDeck.cues;
  if (!merged.beatGrid) merged.beatGrid = previousDeck.beatGrid;
  return merged;
}

function queueRender(nextState) {
  pendingRenderState = nextState;
  if (renderTimer) return;

  const elapsedMs = Date.now() - lastRenderAt;
  const delayMs = Math.max(0, RENDER_INTERVAL_MS - elapsedMs);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    const stateToRender = pendingRenderState;
    pendingRenderState = null;
    lastRenderAt = Date.now();
    render(stateToRender);
  }, delayMs);
}

function deckMarkupKey(deck) {
  return [
    deck.id,
    deck.trackKey || '',
    deck.title,
    deck.artist,
    deck.deviceName,
    deck.statusName,
    deck.stateBadge,
    deck.stateClass,
    deck.isMaster ? 1 : 0,
    deck.isOnAir ? 1 : 0,
    deck.isSync ? 1 : 0,
    deck.waveform?.trackId || '',
    deck.waveform?.dbKey || '',
    deck.waveform?.kind || '',
    deck.waveform?.style || '',
    deck.waveform?.pointCount || '',
    deck.cueList?.cueCount || '',
    deck.cueList?.hotCueCount || '',
    deck.cueList?.loopCount || '',
    deck.beatGrid?.beatCount || '',
    state.waveformSettings.mode,
    state.waveformSettings.viewMode,
    readLtcSourceMode()
  ].join('|');
}

function updateDeckLiveFields(deckCards) {
  const cards = els.deckGrid.querySelectorAll('.deck-card');
  deckCards.forEach((deck, index) => {
    const card = cards[index];
    if (!card) return;

    const bpm = deck.bpm !== null ? Number(deck.bpm).toFixed(2) : '--.--';
    const elapsed = deck.elapsedMs !== null ? formatDuration(deck.elapsedMs) : '--:--.---';
    const remaining = deck.remainingMs !== null ? `-${formatDuration(deck.remainingMs)}` : '--:--.---';
    const total = deck.totalMs !== null ? formatDuration(deck.totalMs) : '--:--.---';
    const beat = deck.beatInMeasure !== null ? deck.beatInMeasure : '-';

    const bpmValue = card.querySelector('.bpm-block strong');
    if (bpmValue && bpmValue.textContent !== bpm) bpmValue.textContent = bpm;

    const timeValues = card.querySelectorAll('.time-grid strong');
    if (timeValues[0] && timeValues[0].textContent !== elapsed) timeValues[0].textContent = elapsed;
    if (timeValues[1] && timeValues[1].textContent !== remaining) timeValues[1].textContent = remaining;
    if (timeValues[2] && timeValues[2].textContent !== total) timeValues[2].textContent = total;

    const miniStats = card.querySelectorAll('.mini-stats span');
    const cueLabel = deck.cueList ? `Cue ${deck.cueList.hotCueCount || 0} Loop ${deck.cueList.loopCount || 0}` : '等待Cue';
    const beatGridLabel = deck.beatGrid ? `网格 ${deck.beatGrid.beatCount || 0}拍` : '等待网格';
    const waveformLabel = deck.waveform ? `${waveformStyleLabel(deck.waveform)}${deck.waveform.kind === 'big' ? '大波形' : '小波形'} ${waveformPointLabel(deck.waveform)}` : dbRequestLabel(deck.dbRequest);
    const labels = [`拍位 ${beat}`, cueLabel, beatGridLabel, waveformLabel];
    labels.forEach((label, labelIndex) => {
      if (miniStats[labelIndex] && miniStats[labelIndex].textContent !== label) miniStats[labelIndex].textContent = label;
    });
  });
}

function buildDeckCards(monitor) {
  if (Array.isArray(monitor.decks)) {
    const decksById = new Map(monitor.decks.map((deck) => [Number(deck.id), deck]));
    return [1, 2, 3, 4].map((id) => normalizeVjDeck(decksById.get(id) || {id, connected: false, state: 'No Link'}));
  }

  const devices = monitor.devices || [];
  const statuses = monitor.statuses || [];
  const layers = monitor.tcnetLayers || [];
  const metadata = monitor.metadata || [];
  const cues = monitor.cues || [];
  const beatGrids = monitor.beatGrids || [];
  const artwork = monitor.artwork || [];
  const waveforms = monitor.waveforms || [];
  const dbRequests = monitor.dbRequests || [];
  const waveformByLayer = buildWaveformLookup(waveforms, state.waveformSettings.mode);
  const metadataByLayer = new Map(metadata.map((item) => [Number(item.layerId), item]));
  const cuesByLayer = new Map(cues.map((item) => [Number(item.layerId), item]));
  const beatGridByLayer = new Map(beatGrids.map((item) => [Number(item.layerId), item]));
  const artworkByLayer = new Map(artwork.map((item) => [Number(item.layerId), item]));
  const dbRequestByDeck = buildDbRequestLookup(dbRequests);
  const ids = new Set([1, 2, 3, 4]);
  const nowMs = Date.now();

  for (const device of devices) if (Number(device.id) >= 1 && Number(device.id) <= 4) ids.add(Number(device.id));
  for (const status of statuses) if (Number(status.deviceId) >= 1 && Number(status.deviceId) <= 4) ids.add(Number(status.deviceId));
  for (const layer of layers) {
    const id = Number(layer.id || layer.layerId);
    if (id >= 1 && id <= 4) ids.add(id);
  }

  return Array.from(ids)
    .filter((id) => Number.isFinite(id) && id >= 1 && id <= 4)
    .sort((a, b) => a - b)
    .map((id) => {
      const device = devices.find((item) => Number(item.id) === id);
      const status = statuses.find((item) => Number(item.deviceId) === id) || {};
      const layer = layers.find((item) => Number(item.id || item.layerId) === id) || {};
      const rawLayerMeta = metadataByLayer.get(id) || null;
      const rawWaveformData = waveformByLayer.get(id) || null;
      const rawCueList = cuesByLayer.get(id) || null;
      const rawBeatGrid = beatGridByLayer.get(id) || null;
      const rawCover = artworkByLayer.get(id) || null;
      const dbRequest = dbRequestByDeck.get(id) || null;
      const layerMeta = dataMatchesDeckTrack(rawLayerMeta, status) ? rawLayerMeta : {};
      const rawWaveform = dataMatchesDeckTrack(rawWaveformData, status) ? rawWaveformData : null;
      const cueList = dataMatchesDeckTrack(rawCueList, status) ? rawCueList : null;
      const beatGrid = dataMatchesDeckTrack(rawBeatGrid, status) ? rawBeatGrid : null;
      const cover = dataMatchesDeckTrack(rawCover, status) ? rawCover : null;
      const elapsedMs = firstNumber(projectPlaybackPositionMs(status, beatGrid, nowMs), layer.positionMs, layer.timeMs);
      const totalMs = firstNumber(status.trackLengthMs, layerMeta.trackLengthMs, rawWaveform?.totalTimeMs, layer.trackLengthMs, layer.totalTimeMs);
      const remainingMs = totalMs !== null && elapsedMs !== null ? Math.max(0, totalMs - elapsedMs) : null;
      const waveform = rawWaveform ? {
        ...rawWaveform,
        playheadRatio: totalMs && elapsedMs !== null ? Math.max(0, Math.min(1, elapsedMs / totalMs)) : null
      } : null;
      const title = layer.title || layerMeta.title || status.title || status.trackTitle || (device ? `${device.name || 'CDJ'} 已连接` : '等待曲名数据');
      const artist = layer.artist || layerMeta.artist || status.artist || '';
      const hasTiming = elapsedMs !== null || status.lastBeatPacket;
      const fallbackState = device ? (hasTiming ? 'Linked' : 'ConnectedNoBeat') : 'No Link';
      const rawState = layer.stateName || status.playStateName || (status.lastBeatPacket ? 'Beat' : fallbackState);
      const stateClass = deckStateClass({device, rawState, status, layer});
      const stateBadge = deckStateBadge(stateClass, rawState);

      return {
        id,
        trackKey: trackReferenceKeyFromStatus(status),
        deviceName: device?.name || `Deck ${id}`,
        ip: device?.ip || status.source || layer.source || '-',
        title,
        artist: artist || (device ? '已发现设备，等待节拍/曲名/波形数据' : '等待艺人数据'),
        bpm: firstNumber(status.effectiveBpm, layer.bpm, status.trackBpm),
        pitch: firstNumber(status.effectivePitch, status.sliderPitch, layer.speedPercent),
        statusName: statusNameZh(rawState),
        stateBadge,
        stateClass,
        beatInMeasure: firstNumber(layer.beatMarker, status.beatInMeasure),
        elapsedMs,
        remainingMs,
        totalMs,
        waveform,
        cueList,
        beatGrid,
        artwork: cover,
        dbRequest,
        isMaster: Boolean(status.isMaster || layer.syncMaster),
        isOnAir: Boolean(status.isOnAir || layer.onAir),
        isSync: Boolean(status.isSync),
        lastSeen: layer.lastSeen || status.lastSeen || device?.lastSeen
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
    deviceName: deck.name || `Deck ${deck.id}`,
    title: deck.title || (deck.connected ? `${deck.name || 'CDJ'} 已连接` : '等待曲名数据'),
    artist: deck.artist || (deck.connected ? '等待曲库数据' : '等待艺人数据'),
    bpm: firstNumber(deck.bpm),
    pitch: firstNumber(deck.pitchPercent),
    statusName: deck.stateLabel || statusNameZh(deck.state),
    stateBadge: deck.playing ? '正在播放' : deck.connected ? '待播' : '未连接',
    stateClass,
    beatInMeasure: firstNumber(deck.beatInMeasure),
    elapsedMs: firstNumber(deck.elapsedMs),
    remainingMs: firstNumber(deck.remainingMs),
    totalMs: firstNumber(deck.totalMs),
    waveform: waveform ? {...waveform, playheadRatio: deck.progress ?? waveform.playheadRatio ?? null} : null,
    cueList: deck.cues || null,
    beatGrid: deck.beatGrid || null,
    artwork: null,
    dbRequest: deck.db || null,
    isMaster: Boolean(deck.master),
    isOnAir: Boolean(deck.onAir),
    isSync: Boolean(deck.sync),
    lastSeen: null
  };
}

function dataMatchesDeckTrack(item, status) {
  if (!item) return false;
  const dataTrackId = firstNumber(item.trackId);
  if (dataTrackId === null) return true;
  const statusTrackId = firstNumber(status?.trackId);
  return statusTrackId !== null && dataTrackId === statusTrackId;
}

function trackReferenceKeyFromStatus(status) {
  const trackId = firstNumber(status?.trackId);
  const trackDeviceId = firstNumber(status?.trackDeviceId);
  const trackSlot = firstNumber(status?.trackSlot);
  const trackType = firstNumber(status?.trackType);
  if (!trackId || !trackDeviceId || !trackSlot || !trackType) return null;
  return `${trackDeviceId}:${trackSlot}:${trackType}:${trackId}`;
}

function buildDbRequestLookup(requests) {
  const byDeck = new Map();
  for (const request of requests || []) {
    const deviceId = Number(request.deviceId);
    if (!Number.isFinite(deviceId)) continue;
    const previous = byDeck.get(deviceId);
    if (!previous || Date.parse(request.updatedAt || '') >= Date.parse(previous.updatedAt || '')) {
      byDeck.set(deviceId, request);
    }
  }
  return byDeck;
}

function dbRequestLabel(request) {
  if (!request) return '等待波形数据';
  if (request.state === 'pending') return request.stage === 'cue' ? '请求Cue数据' : '请求曲库/波形';
  if (request.state === 'ready') {
    const count = Number(request.waveformCount || 0);
    return count ? `曲库已回填 ${count}组波形` : '曲库已回填';
  }
  if (request.state === 'stale') return '曲目变化，等待回填';
  if (request.state === 'unavailable') return '曲库暂无数据';
  if (request.state === 'failed') {
    const message = String(request.message || '').slice(0, 32);
    return message ? `曲库失败 ${message}` : '曲库请求失败';
  }
  return '等待波形数据';
}

function renderDeckCard(deck, index) {
  const bpm = deck.bpm !== null ? Number(deck.bpm).toFixed(2) : '--.--';
  const bpmLabel = deck.bpm !== null ? '实时BPM' : '等待BPM';
  const elapsed = deck.elapsedMs !== null ? formatDuration(deck.elapsedMs) : '--:--.---';
  const remaining = deck.remainingMs !== null ? `-${formatDuration(deck.remainingMs)}` : '--:--.---';
  const total = deck.totalMs !== null ? formatDuration(deck.totalMs) : '--:--.---';
  const beat = deck.beatInMeasure !== null ? deck.beatInMeasure : '-';
  const waveformLabel = deck.waveform ? `${waveformStyleLabel(deck.waveform)}${deck.waveform.kind === 'big' ? '大波形' : '小波形'} ${waveformPointLabel(deck.waveform)}` : dbRequestLabel(deck.dbRequest);
  const cueLabel = deck.cueList ? `Cue ${deck.cueList.hotCueCount || 0} Loop ${deck.cueList.loopCount || 0}` : '等待Cue';
  const beatGridLabel = deck.beatGrid ? `网格 ${deck.beatGrid.beatCount || 0}拍` : '等待网格';
  const artworkHtml = deck.artwork?.dataUrl ? `<img class="artwork-thumb" src="${escapeHtml(deck.artwork.dataUrl)}" alt="" />` : '<div class="artwork-thumb empty"></div>';
  const liveBadgeHtml = deck.stateClass === 'playing' ? '<b class="live-chip">LIVE</b>' : '';
  const masterBadgeHtml = deck.isMaster ? '<b class="master-chip">MASTER</b>' : '';
  const ltcSourceMode = readLtcSourceMode();
  const deckLtcSource = `deck-${deck.id}`;
  const ltcActive = ltcSourceMode === deckLtcSource;
  const ltcCandidate = ltcSourceMode === 'auto' && deck.stateClass === 'playing' && (deck.isMaster || deck.isOnAir);
  const ltcClass = [
    'deck-ltc-button',
    ltcActive ? 'active' : '',
    ltcCandidate ? 'candidate' : ''
  ].filter(Boolean).join(' ');
  const ltcDisabled = deck.stateClass === 'offline' && !ltcActive ? ' disabled' : '';
  const ltcTitle = ltcActive
    ? '当前 Output M / LTC 固定到这个 Deck，点击恢复自动'
    : `把 Output M / LTC 固定到 Deck ${deck.id}`;

  return `
    <article class="deck-card state-${escapeHtml(deck.stateClass)} ${deck.isMaster ? 'master' : ''}">
      <div class="deck-topline">
        <div class="deck-identity">
          <span>DECK ${escapeHtml(deck.id)}</span>
          ${liveBadgeHtml}
        </div>
        <div class="deck-alerts">
          ${masterBadgeHtml}
          <button class="${escapeHtml(ltcClass)}" type="button" data-ltc-source="${escapeHtml(deckLtcSource)}" title="${escapeHtml(ltcTitle)}"${ltcDisabled}>${ltcActive ? 'M LTC' : 'LTC'}</button>
          <strong title="${escapeHtml(deck.statusName)}">${escapeHtml(deck.stateBadge)}</strong>
        </div>
      </div>

      <div class="track-block">
        ${artworkHtml}
        <div class="track-copy">
          <h2>${escapeHtml(deck.title)}</h2>
          <p>${escapeHtml(deck.artist)}</p>
        </div>
        <div class="bpm-block">
          <span>${escapeHtml(bpmLabel)}</span>
          <strong>${escapeHtml(bpm)}</strong>
        </div>
        <div class="time-grid">
          <div>
            <span>正计时</span>
            <strong>${escapeHtml(elapsed)}</strong>
          </div>
          <div>
            <span>倒计时</span>
            <strong>${escapeHtml(remaining)}</strong>
          </div>
          <div>
            <span>总时长</span>
            <strong>${escapeHtml(total)}</strong>
          </div>
        </div>
      </div>

      <canvas id="waveformCanvas${index}" class="waveform-canvas" width="960" height="180"></canvas>

      <div class="deck-footer">
        <div class="flag-row">
          <span class="${deck.isOnAir ? 'flag active' : 'flag'}">播出</span>
          <span class="${deck.isSync ? 'flag active' : 'flag'}">同步</span>
          <span class="${deck.isMaster ? 'flag master' : 'flag'}">主控</span>
        </div>
        <div class="mini-stats">
          <span>拍位 ${escapeHtml(beat)}</span>
            <span>${escapeHtml(cueLabel)}</span>
            <span>${escapeHtml(beatGridLabel)}</span>
            <span>${escapeHtml(waveformLabel)}</span>
          </div>
        </div>
    </article>
  `;
}

function buildWaveformLookup(waveforms, mode = 'auto') {
  const grouped = new Map();
  for (const waveform of waveforms || []) {
    const layerId = Number(waveform.layerId);
    if (!Number.isFinite(layerId)) continue;
    const list = grouped.get(layerId) || [];
    list.push(waveform);
    grouped.set(layerId, list);
  }

  const byLayer = new Map();
  for (const [layerId, items] of grouped) {
    byLayer.set(layerId, chooseWaveform(items, mode));
  }
  return byLayer;
}

function chooseWaveform(waveforms, mode) {
  const normalizedMode = WAVEFORM_MODES.has(mode) ? mode : 'auto';
  const candidates = normalizedMode === 'auto' ? waveforms : waveforms.filter((waveform) => waveform.style === normalizedMode);
  const pool = candidates.length ? candidates : waveforms;
  return pool.slice().sort((a, b) => waveformScore(b, normalizedMode) - waveformScore(a, normalizedMode))[0] || null;
}

function waveformScore(waveform, mode) {
  const styleScore = {
    'three-band': 90,
    rgb: 80,
    blue: 70
  };
  const exactBonus = mode !== 'auto' && waveform.style === mode ? 100 : 0;
  const base = styleScore[waveform.style] || (waveform.kind === 'big' ? 60 : 50);
  const kindBonus = waveform.kind === 'big' ? 5 : 0;
  return exactBonus + base + kindBonus;
}

function drawWaveform(canvas, deck, settings = DEFAULT_WAVEFORM_SETTINGS) {
  if (!canvas) return;
  const waveform = deck?.waveform || null;
  const waveformSettings = normalizeWaveformSettings(settings);
  const {context, width, height} = prepareWaveformCanvas(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#101514';
  context.fillRect(0, 0, width, height);

  if (!waveform || !Array.isArray(waveform.points) || !waveform.points.length) {
    context.fillStyle = 'rgba(170,184,180,0.72)';
    context.font = '18px system-ui, sans-serif';
    context.fillText('等待波形数据', 18, 34);
    return;
  }

  try {
    const waveformImage = getNaturalWaveformImage(waveform, waveformSettings);
    const viewport = getWaveformViewport(width, deck, waveform, waveformSettings);
    drawWaveformBackgroundAnnotations(context, width, height, deck, viewport);
    context.imageSmoothingEnabled = false;
    context.drawImage(waveformImage, viewport.imageX, 0, viewport.imageWidth, height);
    drawWaveformForegroundAnnotations(context, width, height, deck, viewport);

    if (waveform.playheadRatio !== null && waveform.playheadRatio !== undefined) {
      drawPlayheadLine(context, viewport.playheadX, height);
    }
  } catch (error) {
    console.warn('Waveform draw failed', error);
    reportWaveformDrawFailure(deck, waveform, error);
    context.fillStyle = 'rgba(170,184,180,0.72)';
    context.font = '18px system-ui, sans-serif';
    context.fillText('波形绘制等待下一帧', 18, 34);
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
  const visibleRatio = totalMs && totalMs > 0 ? clampNumber(FOLLOW_WAVEFORM_WINDOW_MS / totalMs, 0.12, 1, 0.25) : 0.25;
  const imageWidth = Math.max(width, Math.round(width / visibleRatio));
  const playheadX = Math.round(width * 0.5);
  return {
    imageX: Math.round(playheadX - imageWidth * progress),
    imageWidth,
    playheadX
  };
}

function drawPlayheadLine(context, x, height) {
  if (x === null || x === undefined) return;
  context.save();
  context.strokeStyle = '#ffffff';
  context.lineWidth = 2;
  context.shadowColor = 'rgba(255,255,255,0.72)';
  context.shadowBlur = 6;
  context.beginPath();
  context.moveTo(x, 8);
  context.lineTo(x, height - 8);
  context.stroke();
  context.restore();
}

function reportWaveformDrawFailure(deck, waveform, error) {
  if (!window.prolink?.reportWaveformIssue) return;
  const key = [
    deck?.id || '',
    deck?.trackKey || '',
    waveform?.dbKey || '',
    waveform?.kind || '',
    waveform?.style || '',
    error?.message || ''
  ].join('|');
  const now = Date.now();
  const lastLoggedAt = waveformIssueLog.get(key) || 0;
  if (now - lastLoggedAt < 30000) return;
  waveformIssueLog.set(key, now);
  window.prolink.reportWaveformIssue({
    deckId: deck?.id || null,
    trackKey: deck?.trackKey || '',
    trackId: waveform?.trackId || null,
    title: deck?.title || '',
    artist: deck?.artist || '',
    dbKey: waveform?.dbKey || '',
    waveformKind: waveform?.kind || '',
    waveformStyle: waveform?.style || '',
    pointCount: waveform?.pointCount || waveform?.points?.length || 0,
    message: error?.message || String(error || 'Waveform draw failed')
  }).catch((reportError) => {
    console.warn('Waveform failure report failed', reportError);
  });
}

function drawWaveformBackgroundAnnotations(context, width, height, deck, viewport) {
  const totalMs = firstNumber(deck?.totalMs, deck?.waveform?.totalTimeMs);
  if (!totalMs || totalMs <= 0) return;
  drawLoopRegions(context, width, height, deck?.cueList, totalMs, viewport);
}

function drawWaveformForegroundAnnotations(context, width, height, deck, viewport) {
  const totalMs = firstNumber(deck?.totalMs, deck?.waveform?.totalTimeMs);
  if (!totalMs || totalMs <= 0) return;
  drawBeatGridMarkers(context, width, height, deck?.beatGrid, totalMs, viewport);
  drawCueMarkers(context, width, height, deck?.cueList, totalMs, viewport);
}

function drawLoopRegions(context, width, height, cueList, totalMs, viewport) {
  const cues = cueList?.cues || [];
  for (const cue of cues) {
    if (!cue.isLoop || cue.loopMs === null || cue.loopMs === undefined) continue;
    const x = timeToWaveformX(cue.positionMs, totalMs, width, viewport);
    const loopEndX = timeToWaveformX(cue.loopMs, totalMs, width, viewport);
    const left = Math.max(0, Math.min(x, loopEndX));
    const right = Math.min(width, Math.max(x, loopEndX));
    if (right <= left) continue;
    const color = normalizeHexColor(cue.color) || '#e5b552';
    context.fillStyle = hexToRgba(color, cue.hotCueNumber ? 0.22 : 0.16);
    context.fillRect(left, 0, Math.max(1, right - left), height);
    context.strokeStyle = hexToRgba(color, 0.68);
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(left + 0.5, 0);
    context.lineTo(left + 0.5, height);
    context.moveTo(right - 0.5, 0);
    context.lineTo(right - 0.5, height);
    context.stroke();
  }
}

function drawBeatGridMarkers(context, width, height, beatGrid, totalMs, viewport) {
  const beats = beatGrid?.beats || [];
  if (!beats.length) return;
  const dense = beats.length > 360;
  context.save();
  context.lineWidth = 1;
  for (const beat of beats) {
    const timeMs = Number(beat?.[0]);
    const beatWithinBar = Number(beat?.[1] || 0);
    if (!Number.isFinite(timeMs)) continue;
    if (dense && beatWithinBar !== 1) continue;
    const x = timeToWaveformX(timeMs, totalMs, width, viewport);
    if (x < 0 || x > width) continue;
    const downbeat = beatWithinBar === 1;
    context.globalAlpha = downbeat ? 0.95 : 0.52;
    context.strokeStyle = downbeat ? 'rgba(255,255,255,0.52)' : 'rgba(255,255,255,0.22)';
    context.beginPath();
    context.moveTo(x, downbeat ? height - 34 : height - 15);
    context.lineTo(x, height - 2);
    context.stroke();
  }
  context.restore();
}

function drawCueMarkers(context, width, height, cueList, totalMs, viewport) {
  const cues = cueList?.cues || [];
  context.save();
  context.font = '11px system-ui, sans-serif';
  context.textBaseline = 'top';
  for (const cue of cues) {
    const timeMs = Number(cue.positionMs);
    if (!Number.isFinite(timeMs)) continue;
    const x = timeToWaveformX(timeMs, totalMs, width, viewport);
    if (x < 0 || x > width) continue;
    const color = normalizeHexColor(cue.color) || (cue.isLoop ? '#e5b552' : '#55d682');
    if (cue.hotCueNumber) drawHotCueMarker(context, x, width, height, color, cue.label, cue.isLoop);
    else drawMemoryCueMarker(context, x, width, height, color, cue.isLoop);
  }
  context.restore();
}

function timeToWaveformX(timeMs, totalMs, width, viewport) {
  const ratio = totalMs ? clampRatio(Number(timeMs || 0) / totalMs) : 0;
  if (!viewport) return Math.round(ratio * width);
  return Math.round(viewport.imageX + ratio * viewport.imageWidth);
}

function drawHotCueMarker(context, x, width, height, color, label, isLoop) {
  const safeLabel = String(label || '').slice(0, 2) || 'H';
  const badgeText = isLoop ? `${safeLabel} LOOP` : safeLabel;
  context.save();
  context.shadowColor = hexToRgba(color, 0.75);
  context.shadowBlur = 8;
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(x + 0.5, 0);
  context.lineTo(x + 0.5, height);
  context.stroke();
  context.shadowBlur = 0;
  context.font = '700 11px system-ui, sans-serif';
  const badgeWidth = Math.max(isLoop ? 42 : 24, Math.ceil(context.measureText(badgeText).width) + 12);
  const badgeHeight = 18;
  const badgeX = Math.max(3, Math.min(width - badgeWidth - 3, x - Math.round(badgeWidth / 2)));
  context.fillStyle = color;
  context.fillRect(badgeX, 4, badgeWidth, badgeHeight);
  context.beginPath();
  context.moveTo(x, 4 + badgeHeight + 7);
  context.lineTo(x - 6, 4 + badgeHeight);
  context.lineTo(x + 6, 4 + badgeHeight);
  context.closePath();
  context.fill();
  context.fillStyle = readableTextColor(color);
  context.textAlign = 'center';
  context.fillText(badgeText, badgeX + badgeWidth / 2, 7);
  context.restore();
}

function drawMemoryCueMarker(context, x, width, height, color, isLoop) {
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x + 0.5, 0);
  context.lineTo(x + 0.5, height);
  context.stroke();
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x - 6, 11);
  context.lineTo(x + 6, 11);
  context.closePath();
  context.fill();
  const label = isLoop ? 'Loop' : 'Cue';
  context.font = '700 10px system-ui, sans-serif';
  context.fillText(label, Math.min(width - 30, Math.max(4, x + 7)), 8);
  context.restore();
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
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return {context, width, height};
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
  while (waveformImageCache.size > MAX_WAVEFORM_IMAGE_CACHE) {
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
  const context = image.getContext('2d');
  context.clearRect(0, 0, naturalWidth, naturalHeight);

  for (let segment = 0; segment < points.length; segment += 1) {
    const point = points[segment] || [];
    if (waveform.style === 'rgb' && point.length >= 8) {
      drawNaturalWaveformBar(context, segment, naturalHeight, point[0], rgbColor(point[1], point[2], point[3], settings.brightness), settings.heightScale);
      drawNaturalWaveformBar(context, segment, naturalHeight, point[4], rgbColor(point[5], point[6], point[7], settings.brightness), settings.heightScale);
    } else if (waveform.style === 'three-band' && point.length >= 3) {
      drawNaturalWaveformBar(context, segment, naturalHeight, point[2], rgbColor(255, 255, 255, settings.brightness), settings.heightScale);
      drawNaturalWaveformBar(context, segment, naturalHeight, point[1], rgbColor(242, 170, 60, settings.brightness), settings.heightScale);
      drawNaturalWaveformBar(context, segment, naturalHeight, point[0], rgbColor(32, 83, 217, settings.brightness), settings.heightScale);
    } else {
      drawNaturalWaveformBar(context, segment, naturalHeight, point[0], pointColor(point, waveform.style, settings.brightness), settings.heightScale);
    }
  }

  return image;
}

function maxNaturalWaveformHeight(points, style) {
  let max = 1;
  for (const point of points) {
    if (style === 'three-band') max = Math.max(max, Number(point?.[0] || 0), Number(point?.[1] || 0), Number(point?.[2] || 0));
    else max = Math.max(max, Number(point?.[0] || 0));
  }
  return Math.max(1, Math.ceil(max));
}

function drawNaturalWaveformBar(context, x, naturalHeight, level, color, heightScale = 1) {
  const barHeight = Math.max(1, Math.min(naturalHeight, Math.round(Number(level || 0) * heightScale)));
  context.fillStyle = color;
  context.fillRect(x, naturalHeight - barHeight, 1, barHeight);
}

function clampRatio(ratio) {
  return Math.max(0, Math.min(1, Number(ratio || 0)));
}

function waveformStyleLabel(waveform) {
  if (waveform?.style === 'three-band') return '3Band';
  if (waveform?.style === 'rgb') return 'RGB';
  if (waveform?.style === 'blue') return 'Blue';
  return '';
}

function waveformPointLabel(waveform) {
  const pointCount = Number(waveform?.pointCount || 0);
  const originalPointCount = Number(waveform?.originalPointCount || 0);
  if (originalPointCount && originalPointCount !== pointCount) return `${pointCount}/${originalPointCount}点`;
  return `${pointCount}点`;
}

function pointColor(point, style, brightness = 1) {
  if (style === 'rgb' && point.length >= 4) {
    const [, red, green, blue] = point;
    return rgbColor(red, green, blue, brightness);
  }
  const [, color] = point;
  return rgbColor(color, color, 255, brightness);
}

function rgbColor(red, green, blue, brightness = 1) {
  return `rgb(${clampColor(red, brightness)}, ${clampColor(green, brightness)}, ${clampColor(blue, brightness)})`;
}

function clampColor(value, brightness = 1) {
  return Math.max(0, Math.min(255, Math.round(Number(value || 0) * brightness)));
}

function normalizeHexColor(color) {
  if (typeof color !== 'string') return null;
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((part) => part + part).join('')}`;
  }
  return null;
}

function hexToRgba(color, alpha = 1) {
  const normalized = normalizeHexColor(color);
  if (!normalized) return `rgba(85, 214, 130, ${alpha})`;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function readableTextColor(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) return '#08110e';
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#08110e' : '#ffffff';
}

function deckStateClass({device, rawState, status, layer}) {
  const isPlaying = Boolean(status.isPlayingFlag) ||
    ['Playing', 'Looping', 'Beat'].includes(rawState) ||
    ['Playing', 'Looping'].includes(layer.stateName);
  if (isPlaying) return 'playing';
  if (device) return 'standby';
  return 'offline';
}

function deckStateBadge(stateClass, rawState) {
  if (stateClass === 'playing') return '正在播放';
  if (stateClass === 'standby') return '待播';
  return statusNameZh(rawState);
}

function applyDeckLayout() {
  const layout = normalizeDeckLayout(state.layout);
  els.deckGrid.classList.remove('layout-auto', 'layout-left-right', 'layout-top-bottom');
  els.deckGrid.classList.add(`layout-${layout}`);
  els.layoutSelect.value = layout;
}

function normalizeDeckLayout(layout) {
  return DECK_LAYOUTS.has(layout) ? layout : 'auto';
}

function projectPlaybackPositionMs(status, beatGrid, nowMs = Date.now()) {
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
  const speed = playbackSpeedFactor(status);
  const projected = positionMs + ageMs * speed;
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
    return normalizeWaveformSettings(JSON.parse(window.localStorage.getItem(WAVEFORM_SETTINGS_STORAGE_KEY) || '{}'));
  } catch (_error) {
    return {...DEFAULT_WAVEFORM_SETTINGS};
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
  window.localStorage.setItem(WAVEFORM_SETTINGS_STORAGE_KEY, JSON.stringify(state.waveformSettings));
  render(state.monitor);
}

function getArenaPioneerMode() {
  const mode = normalizeArenaPioneerMode(els.arenaPioneerMode?.value || state.arenaPioneerMode);
  state.arenaPioneerMode = mode;
  return mode;
}

function normalizeArenaPioneerMode(value) {
  return ARENA_PIONEER_MODES.has(value) ? value : 'off';
}

function readLtcSourceMode() {
  return normalizeLtcSourceMode(els.ltcSourceMode?.value || window.localStorage.getItem(LTC_SOURCE_MODE_STORAGE_KEY));
}

function readLtcOffsetMs() {
  return Math.round(clampNumber(Number(window.localStorage.getItem(LTC_OFFSET_STORAGE_KEY)), -1000, 1000, 0));
}

function persistLtcControls() {
  const sourceMode = normalizeLtcSourceMode(els.ltcSourceMode?.value);
  const offsetMs = Math.round(clampNumber(parseIntInput(els.ltcOffsetMs, 0), -1000, 1000, 0));
  if (els.ltcSourceMode) {
    els.ltcSourceMode.value = sourceMode;
    window.localStorage.setItem(LTC_SOURCE_MODE_STORAGE_KEY, sourceMode);
  }
  if (els.ltcOffsetMs) {
    els.ltcOffsetMs.value = String(offsetMs);
    window.localStorage.setItem(LTC_OFFSET_STORAGE_KEY, String(offsetMs));
  }
}

async function handleDeckLtcSourceClick(event) {
  const button = event.target.closest('[data-ltc-source]');
  if (!button || !els.deckGrid.contains(button)) return;
  const deckSourceMode = normalizeLtcSourceMode(button.dataset.ltcSource);
  if (deckSourceMode === 'auto') return;
  const nextSourceMode = readLtcSourceMode() === deckSourceMode ? 'auto' : deckSourceMode;
  if (els.ltcSourceMode) els.ltcSourceMode.value = nextSourceMode;
  persistLtcControls();
  render(state.monitor);
  await restartBridgeIfRunning();
}

function normalizeLtcSourceMode(value) {
  return LTC_SOURCE_MODES.has(value) ? value : 'auto';
}

async function restartBridgeIfRunning() {
  if (!state.monitor?.running) return;
  const outputOptions = readOutputOptions();
  reconfigureOutputsPromise = reconfigureOutputsPromise
    .catch(() => {})
    .then(async () => {
      if (!state.monitor?.running) return state.monitor;
      const nextState = await window.prolink.reconfigureOutputs(outputOptions);
      state.monitor = mergeMonitorState(state.monitor, nextState);
      if (nextState.lastError) {
        if (lastSuccessfulOutputOptions) applyOutputOptionsToControls(lastSuccessfulOutputOptions);
        renderWebAddress();
        render(state.monitor);
        window.alert(`${nextState.lastError}\n已恢复上一组输出设置。`);
        return state.monitor;
      }
      lastSuccessfulOutputOptions = {...outputOptions};
      render(state.monitor);
      return state.monitor;
    });
  return reconfigureOutputsPromise;
}

function applyOutputOptionsToControls(options = {}) {
  els.websocketToggle.checked = options.websocketEnabled !== false;
  els.websocketPort.value = String(options.websocketPort || 7071);
  els.webConsolePort.value = String(options.webConsolePort || 7072);
  els.webConsoleLanToggle.checked = Boolean(options.webConsoleLanEnabled);
  els.oscToggle.checked = Boolean(options.oscEnabled);
  els.oscHost.value = options.oscHost || '127.0.0.1';
  els.oscPort.value = String(options.oscPort || 9000);
  els.arenaTimecodeToggle.checked = Boolean(options.arenaTimecodeEnabled);
  els.arenaLayer.value = String(options.arenaLayer || 1);
  els.arenaClip.value = String(options.arenaClip || 1);
  els.timecodeFps.value = String(options.timecodeFps || 25);
  if (els.ltcDemoToggle) els.ltcDemoToggle.checked = Boolean(options.timecodeDemoEnabled);
  if (els.ltcManualRouteToggle) els.ltcManualRouteToggle.checked = options.timecodeDemoRouteAudio === false;
  if (els.ltcDemoConfigureArena) els.ltcDemoConfigureArena.checked = options.timecodeDemoConfigureArena !== false;
  if (els.ltcSourceMode) els.ltcSourceMode.value = normalizeLtcSourceMode(options.timecodeDemoSourceMode);
  if (els.ltcDemoSmpteInput) els.ltcDemoSmpteInput.value = options.timecodeDemoSmpteInput || 'SMPTE 2';
  if (els.ltcDemoSeconds) els.ltcDemoSeconds.value = String(options.timecodeDemoSegmentSeconds || 60);
  if (els.ltcOffsetMs) els.ltcOffsetMs.value = String(options.timecodeOffsetMs || 0);
  persistLtcControls();
}

function sameOutputOptions(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeWaveformSettings(settings = {}) {
  const mode = WAVEFORM_MODES.has(settings.mode) ? settings.mode : DEFAULT_WAVEFORM_SETTINGS.mode;
  const viewMode = WAVEFORM_VIEW_MODES.has(settings.viewMode) ? settings.viewMode : DEFAULT_WAVEFORM_SETTINGS.viewMode;
  return {
    mode,
    viewMode,
    heightScale: clampNumber(settings.heightScale, 0.7, 1.5, DEFAULT_WAVEFORM_SETTINGS.heightScale),
    brightness: clampNumber(settings.brightness, 0.7, 1.5, DEFAULT_WAVEFORM_SETTINGS.brightness)
  };
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function setSetupControlsDisabled(disabled) {
  const controls = [
    els.interfaceSelect,
    els.tcnetToggle,
    els.tcnetNodeToggle,
    els.virtualCdjToggle,
    els.virtualCdjId,
    els.tcnetUnicastPort
  ];
  for (const control of controls) control.disabled = disabled;
}

function getSelectedInterface() {
  return state.interfaces.find((item) => item.id === state.selectedInterface) || null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function parseIntInput(input, fallback) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

function formatDuration(ms) {
  const numeric = Number(ms || 0);
  const totalMs = Math.max(0, Math.round(numeric));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

init().catch((error) => {
  console.error(error);
});
