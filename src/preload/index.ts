import { contextBridge, ipcRenderer } from 'electron'
import type { PlatformApi } from '../shared/platform'

const api: PlatformApi = {
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (input) => ipcRenderer.invoke('accounts:add', input),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    open: (id) => ipcRenderer.invoke('accounts:open', id),
  },
  platforms: {
    list: () => ipcRenderer.invoke('platforms:list'),
    importPackage: () => ipcRenderer.invoke('platforms:import'),
  },
  connect: (id, webContentsId) => ipcRenderer.invoke('platform:connect', id, webContentsId),
  disconnect: (id) => ipcRenderer.invoke('platform:disconnect', id),
  status: (id) => ipcRenderer.invoke('platform:status', id),
  collectProducts: (id) => ipcRenderer.invoke('products:collect', id),
  productDetail: (id, goodsId) => ipcRenderer.invoke('products:detail', id, goodsId),
  sessions: (id) => ipcRenderer.invoke('sessions:list', id),
  messages: (id, sessionId) => ipcRenderer.invoke('messages:list', id, sessionId),
  orders: (id, userId) => ipcRenderer.invoke('orders:list', id, userId),
  syncOrders: (id, sessionId, userId) => ipcRenderer.invoke('orders:sync', id, sessionId, userId),
  listenOrders: (id, sessionId, orderId) => ipcRenderer.invoke('orders:listen', id, sessionId, orderId),
  listenMessages: (id) => ipcRenderer.invoke('messages:listen', id),
  handoffTargets: (id) => ipcRenderer.invoke('handoff:targets', id),
  sendMessage: (id, sessionId, content) => ipcRenderer.invoke('message:send', id, sessionId, content),
  sendFile: (id, sessionId, dataUrl, fileName) => ipcRenderer.invoke('message:file', id, sessionId, dataUrl, fileName),
  transferSession: (id, sessionId, target) => ipcRenderer.invoke('session:transfer', id, sessionId, target),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value)
    ipcRenderer.on('platform:event', listener)
    return () => ipcRenderer.removeListener('platform:event', listener)
  },
}

contextBridge.exposeInMainWorld('platformApi', api)
