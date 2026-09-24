import type { HookOperation } from '@platform-hub/hook-sdk'
import type { PlatformRuntimeAdapter, PlatformRuntimeHostContext, PlatformAccountRecord } from './contracts.js'
import { PlatformRegistry } from './platform-registry.js'

/** Generic per-account runtime owner shared by the Electron manager and tests. */
export class PlatformRuntimeManager {
  private readonly adapters = new Map<string, PlatformRuntimeAdapter>()

  constructor(
    private readonly registry: PlatformRegistry,
    private readonly contextFor: (account: PlatformAccountRecord) => PlatformRuntimeHostContext,
  ) {}

  async ensure(account: PlatformAccountRecord): Promise<PlatformRuntimeAdapter> {
    const existing = this.adapters.get(account.id)
    if (existing) return existing
    const factory = this.registry.require(account.platform)
    const adapter = await factory.create(account, this.contextFor(account))
    if (adapter.id !== account.id) {
      await adapter.dispose().catch(() => undefined)
      throw new Error(`Runtime Adapter id 与账号不匹配: ${account.id}`)
    }
    this.adapters.set(account.id, adapter)
    return adapter
  }

  get(accountId: string): PlatformRuntimeAdapter | undefined { return this.adapters.get(accountId) }

  async start(account: PlatformAccountRecord): Promise<PlatformRuntimeAdapter> {
    const adapter = await this.ensure(account)
    await adapter.start()
    return adapter
  }

  async invoke<T = unknown>(account: PlatformAccountRecord, operation: HookOperation | string, input: unknown = {}): Promise<T> {
    const adapter = await this.ensure(account)
    const result = await adapter.transport.invoke<T>(operation as HookOperation, input)
    if (!result.ok) {
      const error = new Error(result.error.message) as Error & { code?: string }
      error.code = result.error.code
      throw error
    }
    return result.data
  }

  async attachPrimaryView(account: PlatformAccountRecord): Promise<void> {
    const adapter = await this.ensure(account)
    await adapter.attachPrimaryView()
  }

  detachPrimaryView(accountId: string): void { this.adapters.get(accountId)?.detachPrimaryView() }

  async stop(accountId: string): Promise<void> { await this.adapters.get(accountId)?.stop() }

  async dispose(accountId: string): Promise<void> {
    const adapter = this.adapters.get(accountId)
    if (!adapter) return
    this.adapters.delete(accountId)
    await adapter.dispose()
  }

  async disposeAll(): Promise<void> {
    const adapters = [...this.adapters.values()]
    this.adapters.clear()
    await Promise.all(adapters.map((adapter) => adapter.dispose().catch(() => undefined)))
  }
}
