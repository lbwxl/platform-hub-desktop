import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { PlatformManager } from './cdp/PlatformManager'
import type { PlatformEvent } from '../shared/platform'

// Development/verification runners can provide an isolated writable profile.
// Electron otherwise inherits a locked-down global profile on some managed
// Windows hosts, which prevents the CDP window from starting at all.
if (process.env.PLATFORM_HUB_USER_DATA) {
  app.setPath('userData', process.env.PLATFORM_HUB_USER_DATA)
}

// WebContentsView relies on Chromium's compositor for stable native view
// embedding. Keep GPU/compositing enabled by default; opt out only for a
// machine with a confirmed driver/runtime problem.
if (process.env.PLATFORM_HUB_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')
}
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PLATFORM_HUB_CDP_PORT || '9333')
}

let mainWindow: BrowserWindow | null = null
const manager = new PlatformManager()

function assertRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('未经授权的 IPC 调用')
}

function createWindow(load = true): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1120, minHeight: 720,
    backgroundColor: '#f4f7fb',
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, sandbox: false },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  mainWindow.on('closed', () => { mainWindow = null })
  if (load) loadRenderer(mainWindow)
  return mainWindow
}

function loadRenderer(window: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('platforms:list', (event) => { assertRenderer(event); return manager.listPlatforms() })
  ipcMain.handle('platforms:import', async (event) => { assertRenderer(event); return manager.importPackage() })
  ipcMain.handle('accounts:list', (event) => { assertRenderer(event); return manager.listAccounts() })
  ipcMain.handle('accounts:add', (event, input) => { assertRenderer(event); return manager.addAccount(input) })
  ipcMain.handle('accounts:remove', (event, id: string) => { assertRenderer(event); return manager.removeAccount(id) })
  ipcMain.handle('accounts:open', (event, id: string) => { assertRenderer(event); return manager.open(id) })
  ipcMain.handle('accounts:setOnline', (event, id: string, online: boolean) => { assertRenderer(event); return manager.setAccountOnline(id, online) })
  ipcMain.handle('runtime:states', (event) => { assertRenderer(event); return manager.runtimeStates() })
  ipcMain.handle('conversation:attention:set', (event, id: string, conversationId: string, state: 'pending' | 'opened' | 'resolved') => { assertRenderer(event); return manager.setConversationAttention(id, conversationId, state) })
  ipcMain.handle('viewport:bounds', (event, bounds: { x: number; y: number; width: number; height: number }) => { assertRenderer(event); return manager.setPrimaryViewportBounds(bounds) })
  ipcMain.handle('platform:connect', (event, id: string, webContentsId: number) => { assertRenderer(event); return manager.connect(id, webContentsId) })
  ipcMain.handle('platform:disconnect', (event, id: string) => { assertRenderer(event); return manager.disconnect(id) })
  ipcMain.handle('platform:status', (event, id: string) => { assertRenderer(event); return manager.status(id) })
  ipcMain.handle('products:collect', (event, id: string) => { assertRenderer(event); return manager.collectProducts(id) })
  ipcMain.handle('products:detail', (event, id: string, goodsId: string) => { assertRenderer(event); return manager.productDetail(id, goodsId) })
  ipcMain.handle('sessions:list', (event, id: string) => { assertRenderer(event); return manager.sessionsFor(id) })
  ipcMain.handle('messages:list', (event, id: string, sessionId: string) => { assertRenderer(event); return manager.messagesFor(id, sessionId) })
  ipcMain.handle('orders:list', (event, id: string, userId?: string) => { assertRenderer(event); return manager.ordersFor(id, userId) })
  ipcMain.handle('orders:sync', (event, id: string, sessionId?: string, userId?: string) => { assertRenderer(event); return manager.syncOrdersFor(id, sessionId, userId) })
  ipcMain.handle('orders:listen', (event, id: string, sessionId?: string, orderId?: string) => { assertRenderer(event); return manager.listenOrdersFor(id, sessionId, orderId) })
  ipcMain.handle('messages:listen', (event, id: string) => { assertRenderer(event); return manager.listenMessagesFor(id) })
  ipcMain.handle('handoff:targets', (event, id: string) => { assertRenderer(event); return manager.handoffTargetsFor(id) })
  ipcMain.handle('message:send', (event, id: string, sessionId: string, content: string) => { assertRenderer(event); return manager.sendMessage(id, sessionId, content) })
  ipcMain.handle('message:file', (event, id: string, sessionId: string, dataUrl: string, fileName?: string) => { assertRenderer(event); return manager.sendFile(id, sessionId, dataUrl, fileName) })
  ipcMain.handle('session:transfer', (event, id: string, sessionId: string, target: string) => { assertRenderer(event); return manager.transferSession(id, sessionId, target) })
}

app.whenReady().then(async () => {
  await manager.init()
  createWindow(false)
  if (mainWindow) await manager.attachMainWindow(mainWindow)
  if (!manager.listAccounts().length) {
    await manager.addAccount({ platform: 'douyin-shop', label: '抖店主账号' })
  }
  registerIpc()
  manager.onEvent((event: PlatformEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('platform:event', event)
  })
  if (mainWindow) loadRenderer(mainWindow)
  const douyin = manager.listAccounts().find((account) => account.platform === 'douyin-shop')
  if (douyin) void manager.open(douyin.id).catch((error) => console.error('[platform-hub] 打开抖店页面失败', error))
  app.on('activate', () => {
    if (!mainWindow) {
      const window = createWindow(false)
      void manager.attachMainWindow(window).then(() => loadRenderer(window))
    }
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
