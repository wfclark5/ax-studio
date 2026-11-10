import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SessionData, StudioAPI, StreamExit, StreamLine } from '../shared/api'

function listen<T>(channel: string, cb: (v: T) => void) {
  const handler = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: StudioAPI = {
  platform: () => ipcRenderer.invoke('platform'),
  run: (req) => ipcRenderer.invoke('run', req),
  pipe: (req) => ipcRenderer.invoke('pipe', req),
  stream: (req) => ipcRenderer.invoke('stream', req),
  cancelStream: (id) => ipcRenderer.invoke('cancelStream', id),
  onStreamLine: (cb) => listen<StreamLine>('stream:line', cb),
  onStreamExit: (cb) => listen<StreamExit>('stream:exit', cb),
  startSession: (req) => ipcRenderer.invoke('session:start', req),
  writeSession: (id, data) => ipcRenderer.invoke('session:write', id, data),
  interruptSession: (id) => ipcRenderer.invoke('session:interrupt', id),
  endSessionInput: (id) => ipcRenderer.invoke('session:eof', id),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  onSessionData: (cb) => listen<SessionData>('session:data', cb),
  onSessionExit: (cb) => listen<StreamExit>('session:exit', cb),
  which: (program) => ipcRenderer.invoke('which', program),
  updateTray: (summary) => ipcRenderer.send('tray:update', summary),
  kubeconfigFor: (context) => ipcRenderer.invoke('kubeconfigFor', context),
  setKubeconfig: (value) => ipcRenderer.invoke('kubeconfig:set', value),
  kubeconfigInfo: () => ipcRenderer.invoke('kubeconfig:info'),
  pickKubeconfig: (current) => ipcRenderer.invoke('kubeconfig:pick', current),
  fileExists: (path) => ipcRenderer.invoke('fileExists', path),
  containerRuntime: () => ipcRenderer.invoke('containerRuntime'),
  openYAML: (dir) => ipcRenderer.invoke('openYAML', dir),
  saveYAML: (name, text) => ipcRenderer.invoke('saveYAML', name, text),
  onMenu: (cb) => listen<string>('menu', cb),
}

contextBridge.exposeInMainWorld('studio', api)
