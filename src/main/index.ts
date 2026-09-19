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

if (process.env.PLATFORM_HUB_ENABLE_GPU !== '1') {
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1120, minHeight: 720,
    backgroundColor: '#f4f7fb',
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, sandbox: false },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  mainWindow.on('closed', () => { mainWindow = null })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('platforms:list', (event) => { assertRenderer(event); return manager.listPlatforms() })
  ipcMain.handle('platforms:import', async (event) => { assertRenderer(event); return manager.importPackage() })
  ipcMain.handle('accounts:list', (event) => { assertRenderer(event); return manager.listAccounts() })
  ipcMain.handle('accounts:add', (event, input) => { assertRenderer(event); return manager.addAccount(input) })
  ipcMain.handle('accounts:remove', (event, id: string) => { assertRenderer(event); return manager.removeAccount(id) })
  ipcMain.handle('accounts:open', (event, id: string) => { assertRenderer(event); return manager.open(id) })
  ipcMain.handle('platform:connect', (event, id: string, webContentsId: number) => { assertRenderer(event); return manager.connect(id, webContentsId) })
  ipcMain.handle('platform:disconnect', (event, id: string) => { assertRenderer(event); return manager.disconnect(id) })
  ipcMain.handle('platform:status', (event, id: string) => { assertRenderer(event); return manager.status(id) })
  ipcMain.handle('products:collect', (event, id: string) => { assertRenderer(event); return manager.collectProducts(id) })
  ipcMain.handle('products:detail', (event, id: string, goodsId: string) => { assertRenderer(event); return manager.productDetail(id, goodsId) })
  ipcMain.handle('sessions:list', (event, id: string) => { assertRenderer(event); return manager.sessionsFor(id) })
  ipcMain.handle('messages:list', (event, id: string, sessionId: string) => { assertRenderer(event); return manager.messagesFor(id, sessionId) })
  ipcMain.handle('orders:list', (event, id: string, userId?: string) => { assertRenderer(event); return manager.ordersFor(id, userId) })
  ipcMain.handle('orders:sync', (event, id: string, sessionId?: string, userId?: string) => { assertRenderer(event); return manager.syncOrdersFor(id, sessionId, userId) })
  ipcMain.handle('message:send', (event, id: string, sessionId: string, content: string) => { assertRenderer(event); return manager.sendMessage(id, sessionId, content) })
  ipcMain.handle('message:file', (event, id: string, sessionId: string, dataUrl: string, fileName?: string) => { assertRenderer(event); return manager.sendFile(id, sessionId, dataUrl, fileName) })
  ipcMain.handle('session:transfer', (event, id: string, sessionId: string, target: string) => { assertRenderer(event); return manager.transferSession(id, sessionId, target) })
}

app.whenReady().then(async () => {
  await manager.init()
  if (!manager.listAccounts().length) {
    await manager.addAccount({ platform: 'douyin-shop', label: '抖店主账号' })
  }
  registerIpc()
  manager.onEvent((event: PlatformEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('platform:event', event)
  })
  createWindow()
  const doudian = manager.listAccounts().find((account) => account.platform === 'douyin-shop')
  if (doudian) void manager.open(doudian.id).catch((error) => console.error('[platform-hub] 打开抖店页面失败', error))
  app.on('activate', () => { if (!mainWindow) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
