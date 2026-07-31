const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('prolink', {
  listInterfaces: () => ipcRenderer.invoke('network:listInterfaces'),
  detectVirtualAudio: () => ipcRenderer.invoke('audio:detectVirtual'),
  openVirtualAudioGuide: () => ipcRenderer.invoke('audio:openVirtualAudioGuide'),
  detectArena: () => ipcRenderer.invoke('arena:detect'),
  detectOfficialBridge: () => ipcRenderer.invoke('officialBridge:detect'),
  startOfficialBridge: (options) => ipcRenderer.invoke('officialBridge:start', options),
  start: (options) => ipcRenderer.invoke('monitor:start', options),
  stop: () => ipcRenderer.invoke('monitor:stop'),
  reconfigureOutputs: (options) => ipcRenderer.invoke('monitor:reconfigureOutputs', options),
  getState: () => ipcRenderer.invoke('monitor:getState'),
  forceRefresh: () => ipcRenderer.invoke('monitor:forceRefresh'),
  clearLog: () => ipcRenderer.invoke('monitor:clearLog'),
  exportJson: () => ipcRenderer.invoke('monitor:exportJson'),
  exportWaveformLog: () => ipcRenderer.invoke('monitor:exportWaveformLog'),
  exportTcnetCapture: () => ipcRenderer.invoke('monitor:exportTcnetCapture'),
  reportWaveformIssue: (issue) => ipcRenderer.invoke('monitor:reportWaveformIssue', issue),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('monitor:state', listener);
    return () => ipcRenderer.removeListener('monitor:state', listener);
  }
});
