import { app, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { CdpSession, partitionFor } from './CdpSession'
import type { ChatSession, HookPackageManifest, ImportedHookPackage, OrderSyncResult, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
import { builtinHooks, builtinPlatforms } from '../hooks'

type Persisted = { accounts: PlatformAccount[]; hooks: ImportedHookPackage[] }

export class PlatformManager {
  private readonly sessions = new Map<string, CdpSession>()
  private readonly listeners = new Set<(event: PlatformEvent) => void>()
  private state: Persisted = { accounts: [], hooks: [] }
  private readonly statePath: string
  private readonly stateBackupPath: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.statePath = join(app.getPath('userData'), 'platform-hub.json')
    this.stateBackupPath = join(app.getPath('userData'), 'platform-hub.json.bak')
  }

  async init(): Promise<void> {
    this.state = await this.readState(this.statePath)
      || await this.readState(this.stateBackupPath)
      || { accounts: [], hooks: [] }
  }

  listPlatforms(): PlatformDefinition[] {
    return [...builtinPlatforms, ...this.state.hooks.map(({ manifest }) => ({
      id: manifest.id,
      label: manifest.label,
      url: manifest.url,
      capabilities: manifest.capabilities,
      hookVersion: manifest.version,
      source: 'imported' as const,
    }))]
  }

  listAccounts(): PlatformAccount[] {
    return this.state.accounts.map((account) => {
      const cdp = this.sessions.get(account.id)
      const live = cdp?.getStatus()
      return {
        ...account,
        connected: live?.connected ?? account.connected,
        authenticated: live?.authenticated ?? account.authenticated,
        webContentsId: cdp?.getWebContentsId(),
      }
    })
  }

  async addAccount(input: { platform: string; label: string; url?: string }): Promise<PlatformAccount> {
    const platform = this.listPlatforms().find((item) => item.id === input.platform)
    if (!platform) throw new Error(`未找到平台适配器: ${input.platform}`)
    const id = randomUUID()
    const account: PlatformAccount = {
      id, platform: platform.id, label: input.label.trim() || platform.label,
      url: input.url || platform.url, partition: partitionFor(platform.id, id), connected: false,
      authenticated: false, createdAt: new Date().toISOString(),
    }
    this.state.accounts.push(account)
    await this.save()
    return account
  }

  async removeAccount(accountId: string): Promise<void> { this.sessions.get(accountId)?.close(); this.sessions.delete(accountId); this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId); await this.save() }

  async open(accountId: string): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    const platform = this.listPlatforms().find((item) => item.id === account.platform)!
    const hook = this.getHook(platform.id)
    let cdp = this.sessions.get(accountId)
    if (!cdp) {
      cdp = new CdpSession({ accountId, platform: platform.id, url: account.url, partition: account.partition, hook, emit: (event) => this.emit(event) })
      this.sessions.set(accountId, cdp)
    }
    await cdp.open(true)
    account.connected = true
    account.webContentsId = cdp.getWebContentsId()
    account.lastSeenAt = new Date().toISOString()
    await this.save()
    return { ...account, connected: true, webContentsId: cdp.getWebContentsId() }
  }

  async connect(accountId: string, webContentsId: number): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    const cdp = this.sessions.get(accountId)
    if (!cdp || cdp.getWebContentsId() !== webContentsId) throw new Error('CDP 页面与账号不匹配')
    account.connected = true; account.webContentsId = webContentsId; account.lastSeenAt = new Date().toISOString(); await this.save()
    return cdp.getStatus()
  }

  async disconnect(accountId: string): Promise<void> { this.sessions.get(accountId)?.close(); this.sessions.delete(accountId); const account = this.requireAccount(accountId); account.connected = false; account.webContentsId = undefined; await this.save() }
  async status(accountId: string): Promise<PlatformStatus> {
    let cdp = this.sessions.get(accountId)
    if (!cdp) {
      await this.open(accountId)
      cdp = this.sessions.get(accountId)
    }
    if (!cdp) throw new Error('页面尚未连接')
    await cdp.open(false)
    return cdp.refreshStatus()
  }

  async collectProducts(accountId: string): Promise<ProductRecord[]> { return this.withLogin<ProductRecord[]>(accountId, 'collectProducts') }
  async productDetail(accountId: string, goodsId: string): Promise<ProductRecord> { return this.withLogin<ProductRecord>(accountId, 'getProductDetail', goodsId) }
  async sessionsFor(accountId: string): Promise<ChatSession[]> { return this.withLogin<ChatSession[]>(accountId, 'listSessions') }
  async messagesFor(accountId: string, sessionId: string): Promise<PlatformMessage[]> { return this.withLogin<PlatformMessage[]>(accountId, 'listMessages', sessionId) }
  async ordersFor(accountId: string, userId?: string): Promise<unknown[]> { return this.withLogin<unknown[]>(accountId, 'getOrders', userId) }
  async syncOrdersFor(accountId: string, sessionId?: string, userId?: string): Promise<OrderSyncResult> { return this.withLogin<OrderSyncResult>(accountId, 'syncOrders', sessionId, userId) }
  async sendMessage(accountId: string, sessionId: string, content: string): Promise<{ success: boolean; error?: string }> { return this.withLogin(accountId, 'sendMessage', sessionId, content) }
  async sendFile(accountId: string, sessionId: string, dataUrl: string, fileName?: string): Promise<{ success: boolean; error?: string }> { return this.withLogin(accountId, 'sendFile', sessionId, dataUrl, fileName) }
  async transferSession(accountId: string, sessionId: string, target: string): Promise<unknown> { return this.withLogin(accountId, 'transferSession', sessionId, target) }

  onEvent(listener: (event: PlatformEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async importPackage(): Promise<PlatformDefinition | null> {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Hook package', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const manifestPath = result.filePaths[0]
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as HookPackageManifest
    if (!manifest.script && manifest.entry) {
      const packageRoot = dirname(manifestPath)
      const entryPath = resolve(packageRoot, manifest.entry)
      if (relative(packageRoot, entryPath).startsWith('..')) throw new Error('Hook 包 entry 不能指向包目录之外')
      manifest.script = await readFile(entryPath, 'utf8')
    }
    if (!manifest.id || !manifest.script || !manifest.url || !Array.isArray(manifest.capabilities)) throw new Error('Hook 包 manifest 缺少必要字段')
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: result.filePaths[0] }]
    await this.save()
    return { id: manifest.id, label: manifest.label, url: manifest.url, capabilities: manifest.capabilities, hookVersion: manifest.version, source: 'imported' }
  }

  private getHook(id: string): HookPackageManifest { return this.state.hooks.find((item) => item.manifest.id === id)?.manifest || builtinHooks[id] }
  private requireAccount(id: string): PlatformAccount { const account = this.state.accounts.find((item) => item.id === id); if (!account) throw new Error('平台账号不存在'); return account }
  private async invoke<T>(accountId: string, method: string, ...args: unknown[]): Promise<T> { const cdp = this.sessions.get(accountId); if (!cdp) throw new Error('请先打开平台页面'); return cdp.invoke<T>(method, ...args) }
  private async withLogin<T>(accountId: string, method: string, ...args: unknown[]): Promise<T> {
    const cdp = this.sessions.get(accountId)
    if (!cdp) throw new Error('请先打开平台页面')
    type RuntimeResult = T & { ok?: boolean; errorCode?: string; error?: string }
    let result = await cdp.invoke<RuntimeResult>(method, ...args)
    let errorCode = this.runtimeErrorCode(result)
    if (errorCode === 'LOGIN_REQUIRED' || (errorCode === 'RUNTIME_NOT_READY' && !cdp.getStatus().authenticated)) {
      await cdp.showRuntimePageFor(method)
      await cdp.waitForLogin(undefined, method)
      result = await cdp.invoke<RuntimeResult>(method, ...args)
      errorCode = this.runtimeErrorCode(result)
    }
    if (errorCode === 'RUNTIME_NOT_READY') {
      await cdp.showRuntimePageFor(method)
      result = await cdp.invoke<RuntimeResult>(method, ...args)
      errorCode = this.runtimeErrorCode(result)
    }
    if (errorCode === 'LOGIN_REQUIRED' || errorCode === 'RUNTIME_NOT_READY') {
      const detail = result && typeof result === 'object' ? result.error : undefined
      throw new Error(detail || (errorCode === 'LOGIN_REQUIRED' ? '请在平台页面完成登录后重试' : '平台运行时尚未就绪，请等待页面加载后重试'))
    }
    return result as T
  }
  private runtimeErrorCode(value: unknown): string | undefined {
    return value && typeof value === 'object' ? (value as { errorCode?: string }).errorCode : undefined
  }
  private emit(event: PlatformEvent): void {
    if (event.type === 'connection' && event.payload && typeof event.payload === 'object') {
      const account = this.state.accounts.find((item) => item.id === event.accountId)
      const status = event.payload as Partial<PlatformStatus>
      if (account) {
        account.connected = status.connected === true
        account.authenticated = status.authenticated === true
        account.lastSeenAt = new Date(event.timestamp).toISOString()
        void this.save()
      }
    }
    this.listeners.forEach((listener) => listener(event))
  }
  private async readState(path: string): Promise<Persisted | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Persisted>
      if (!Array.isArray(value.accounts) || !Array.isArray(value.hooks)) return null
      return { accounts: value.accounts, hooks: value.hooks }
    } catch {
      return null
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const operation = this.saveQueue.catch(() => undefined).then(async () => {
      const directory = app.getPath('userData')
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`
      await mkdir(directory, { recursive: true })
      const current = await readFile(this.statePath, 'utf8').catch(() => '')
      if (current) {
        try {
          const parsed = JSON.parse(current) as Partial<Persisted>
          if (Array.isArray(parsed.accounts) && Array.isArray(parsed.hooks)) {
            await writeFile(this.stateBackupPath, current, 'utf8')
          }
        } catch {
          // Keep the last valid backup when the primary file is incomplete.
        }
      }
      await writeFile(temporaryPath, snapshot, 'utf8')
      await rename(temporaryPath, this.statePath)
    })
    this.saveQueue = operation
    return operation
  }
}
