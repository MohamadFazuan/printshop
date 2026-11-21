'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

// The entire renderer↔main surface. No fs, no net, no key.
const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('printshop', {
  catalog: call('catalog:get'),
  getSettings: call('settings:get'),
  saveSettings: call('settings:save'),
  pickFolder: call('settings:pickFolder'),
  pickIcc: call('settings:pickIcc'),
  detectCodex: call('codex:detect'),
  codexStatus: call('codex:status'),
  codexLogin: call('codex:login'),
  codexLogout: call('codex:logout'),
  enhancePrompt: call('codex:enhance'),
  pickReference: call('image:pickReference'),
  describeReferences: call('image:describeReferences'),
  saveReferenceData: call('image:saveReferenceData'),
  // File.path is gone from Electron; this is the supported way to get a dropped
  // file's location. Returns '' for a File with nothing on disk (a screenshot).
  pathForFile: (file) => webUtils.getPathForFile(file),
  generate: call('image:generate'),
  saveExport: call('export:save'),
  // One-way main → renderer stream; the renderer cannot send on this channel.
  onProgress: (callback) => ipcRenderer.on('job:progress', (_event, payload) => callback(payload)),
  reveal: call('shell:reveal')
})
