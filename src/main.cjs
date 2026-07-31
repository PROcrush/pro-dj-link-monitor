const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {app, BrowserWindow, ipcMain, dialog, shell} = require('electron');
const {listInterfaces} = require('./prolink/interfaces.cjs');
const {ProLinkMonitor} = require('./prolink/monitor.cjs');
const {
  getVirtualAudioRecommendation,
  listAudioDevices,
  summarizeVirtualAudio
} = require('./prolink/audioDevices.cjs');

const OFFICIAL_BRIDGE_DOWNLOAD_URL = 'https://www.pioneerdj.com/en/product/software-interfaces/pro-dj-link-bridge/';
const OFFICIAL_BRIDGE_APP_NAME = 'PRO DJ LINK Bridge.app';

let mainWindow;
let monitorShutdownPromise = null;
let quitAfterMonitorShutdown = false;
const monitor = new ProLinkMonitor();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function configureMonitorLogging() {
  const logPath = path.join(app.getPath('userData'), 'logs', 'waveform-failures.jsonl');
  monitor.setWaveformFailureLogPath(logPath);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#111313',
    title: 'PRO DJ LINK Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const handleMonitorState = (state) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('monitor:state', state);
  };
  monitor.on('state', handleMonitorState);

  mainWindow.on('closed', () => {
    monitor.off('state', handleMonitorState);
    mainWindow = null;
  });
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    configureMonitorLogging();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', (event) => {
  if (quitAfterMonitorShutdown) return;
  event.preventDefault();
  stopMonitorForShutdown()
    .catch((error) => console.error('Monitor shutdown failed:', error))
    .finally(() => {
      quitAfterMonitorShutdown = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    return;
  }
  stopMonitorForShutdown().catch(() => {});
});

function stopMonitorForShutdown() {
  if (!monitorShutdownPromise) {
    monitorShutdownPromise = stopMonitorWithRetry().finally(() => {
      monitorShutdownPromise = null;
    });
  }
  return monitorShutdownPromise;
}

async function stopMonitorWithRetry() {
  try {
    await monitor.stop();
  } catch (firstError) {
    await delay(200);
    try {
      await monitor.stop();
    } catch (retryError) {
      retryError.message = `${retryError.message}; first attempt: ${firstError.message}`;
      throw retryError;
    }
  }
}

ipcMain.handle('network:listInterfaces', () => listInterfaces());
ipcMain.handle('audio:detectVirtual', async () => {
  const devices = await listAudioDevices();
  return summarizeVirtualAudio(devices);
});
ipcMain.handle('audio:openVirtualAudioGuide', async () => {
  const recommendation = getVirtualAudioRecommendation();
  if (!recommendation.downloadUrl) return {ok: false, error: 'No installer URL for this platform'};
  await shell.openExternal(recommendation.downloadUrl);
  return {ok: true, recommendation};
});
ipcMain.handle('arena:detect', () => detectArena());
ipcMain.handle('officialBridge:detect', () => disabledOfficialBridgeState());
ipcMain.handle('officialBridge:start', () => disabledOfficialBridgeState());

ipcMain.handle('monitor:start', async (_event, options = {}) => {
    if (!monitor.running && options.manualStart !== true) {
      return monitor.getVjState();
    }
    try {
      await monitor.start(options);
    } catch (error) {
      return {...monitor.getVjState(), lastError: error.message};
    }
    return monitor.getVjState();
  });

  ipcMain.handle('monitor:stop', async () => {
    try {
      await monitor.stop();
      return monitor.getVjState();
    } catch (error) {
      return {...monitor.getVjState(), lastError: error.message};
    }
  });

  ipcMain.handle('monitor:reconfigureOutputs', async (_event, options = {}) => {
    try {
      return await monitor.reconfigureOutputs(options);
    } catch (error) {
      return {...monitor.getVjState(), lastError: error.message};
    }
  });

  ipcMain.handle('monitor:getState', () => monitor.getVjState());

  ipcMain.handle('monitor:forceRefresh', () => {
    monitor.forceRefresh();
    return monitor.getVjState();
  });

  ipcMain.handle('monitor:clearLog', () => {
    monitor.clearLog();
    return monitor.getVjState();
  });

ipcMain.handle('monitor:reportWaveformIssue', (_event, issue = {}) => {
  monitor.recordRendererWaveformFailure(issue);
  return monitor.getVjState();
});

ipcMain.handle('monitor:exportJson', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export PRO DJ LINK snapshot',
    defaultPath: `pro-dj-link-snapshot-${new Date().toISOString().replaceAll(':', '-')}.json`,
    filters: [{name: 'JSON', extensions: ['json']}]
  });

  if (result.canceled || !result.filePath) return {canceled: true};
  await monitor.exportJson(result.filePath);
  return {canceled: false, filePath: result.filePath};
});

ipcMain.handle('monitor:exportWaveformLog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export waveform failure log',
    defaultPath: `pro-dj-link-waveform-failures-${new Date().toISOString().replaceAll(':', '-')}.jsonl`,
    filters: [{name: 'JSON Lines', extensions: ['jsonl']}, {name: 'JSON', extensions: ['json']}]
  });

  if (result.canceled || !result.filePath) return {canceled: true};
  await monitor.exportWaveformFailureLog(result.filePath);
  return {canceled: false, filePath: result.filePath};
});

ipcMain.handle('monitor:exportTcnetCapture', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export TCNet capture',
    defaultPath: `arena-tcnet-capture-${new Date().toISOString().replaceAll(':', '-')}.jsonl`,
    filters: [{name: 'JSON Lines', extensions: ['jsonl']}, {name: 'JSON', extensions: ['json']}]
  });

  if (result.canceled || !result.filePath) return {canceled: true};
  await monitor.exportTcnetCapture(result.filePath);
  return {canceled: false, filePath: result.filePath};
});

function detectArena() {
  return requestArenaJson('/api/v1/composition')
    .then((composition) => ({
      ok: true,
      host: '127.0.0.1',
      port: 8080,
      connectedClips: extractConnectedArenaClips(composition)
    }))
    .catch((error) => ({
      ok: false,
      host: '127.0.0.1',
      port: 8080,
      error: error.message,
      connectedClips: []
    }));
}

function requestArenaJson(requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: 8080,
      path: requestPath,
      method: 'GET',
      timeout: 600
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`${response.statusCode} ${body.slice(0, 120)}`.trim()));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid Arena JSON: ${error.message}`));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    request.end();
  });
}

function extractConnectedArenaClips(composition) {
  const connected = [];
  for (const [layerIndex, layer] of (composition.layers || []).entries()) {
    for (const [clipIndex, clip] of (layer.clips || []).entries()) {
      if (String(readParamValue(clip.connected)).toLowerCase() !== 'connected') continue;
      connected.push({
        layer: layerIndex + 1,
        clip: clipIndex + 1,
        name: readParamValue(clip.name) || '',
        positionMs: Number(readParamValue(clip.transport?.position) || 0),
        durationMs: Number(clip.transport?.position?.max || 0)
      });
    }
  }
  return connected;
}

function readParamValue(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
}

function disabledOfficialBridgeState() {
  return {
    available: false,
    running: false,
    disabled: true,
    path: null,
    downloadUrl: OFFICIAL_BRIDGE_DOWNLOAD_URL,
    lastError: '官方 Bridge 路线已禁用，当前版本只使用 Virtual CDJ / PRO DJ LINK 被动读取。'
  };
}

async function detectOfficialBridge() {
  const running = await isOfficialBridgeRunning();
  for (const candidate of officialBridgeCandidates()) {
    if (!candidate) continue;
    if (await appBundleExists(candidate)) {
      return {
        available: true,
        running,
        path: candidate,
        downloadUrl: OFFICIAL_BRIDGE_DOWNLOAD_URL,
        lastError: null
      };
    }
  }

  return {
    available: false,
    running,
    path: null,
    downloadUrl: OFFICIAL_BRIDGE_DOWNLOAD_URL,
    lastError: '未找到官方 PRO DJ LINK Bridge'
  };
}

async function startOfficialBridge(options = {}) {
  const detected = await detectOfficialBridge();
  if (!detected.available) {
    if (options.openDownload) await shell.openExternal(OFFICIAL_BRIDGE_DOWNLOAD_URL);
    return {
      ...detected,
      started: false,
      openedDownload: Boolean(options.openDownload)
    };
  }

  const openError = await shell.openPath(detected.path);
  if (openError) {
    return {
      ...detected,
      started: false,
      lastError: openError
    };
  }

  await delay(700);
  const next = await detectOfficialBridge();
  return {
    ...next,
    started: true,
    requestedAt: new Date().toISOString()
  };
}

function officialBridgeCandidates() {
  const candidates = [
    process.env.PRO_DJ_LINK_BRIDGE_APP,
    path.join('/Applications', OFFICIAL_BRIDGE_APP_NAME),
    path.join('/Applications', 'Pioneer DJ', OFFICIAL_BRIDGE_APP_NAME),
    path.join('/Applications', 'AlphaTheta', OFFICIAL_BRIDGE_APP_NAME)
  ];

  try {
    candidates.push(path.join(app.getPath('userData'), 'official-bridge', OFFICIAL_BRIDGE_APP_NAME));
  } catch (_error) {
    // app.getPath can only be used after Electron is ready.
  }

  candidates.push(path.join('/private/tmp', 'prodjlink_bridge.nEMIWW', 'pkg', 'PRO-DJ-LINK-Bridge.pkg', 'Payload', OFFICIAL_BRIDGE_APP_NAME));
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function appBundleExists(appPath) {
  try {
    await fs.access(path.join(appPath, 'Contents', 'Info.plist'));
    return true;
  } catch (_error) {
    return false;
  }
}

function isOfficialBridgeRunning() {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-f', OFFICIAL_BRIDGE_APP_NAME.replace('.app', '')], {timeout: 800}, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(Boolean(String(stdout || '').trim()));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
