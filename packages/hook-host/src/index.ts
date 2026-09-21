import {
  noopHookLogger,
  validateHookManifest,
  withHookLoggerContext,
  type HookLogger,
  type HookManifest,
} from '@platform-hub/hook-sdk'
import { HookSession, partitionFor, type HookSessionOptions } from './session/hook-session.js'
import type { HookPageFactory } from './pages/types.js'
import { WorkerScheduler } from './scheduler/worker-scheduler.js'

export interface HookHostOptions {
  pageFactory: HookPageFactory
  maxWorkerConcurrency?: number
  logger?: HookLogger
}

export class HookHost {
  readonly scheduler: WorkerScheduler
  private readonly sessions = new Map<string, HookSession>()
  private readonly logger: HookLogger
  private disposed = false

  constructor(private readonly options: HookHostOptions) {
    this.logger = options.logger ?? noopHookLogger
    this.scheduler = new WorkerScheduler(options.maxWorkerConcurrency ?? 4, this.logger)
  }

  get sessionCount(): number { return this.sessions.size }

  createSession(
    manifest: HookManifest,
    session: Omit<HookSessionOptions, 'manifest' | 'factory' | 'scheduler' | 'partition' | 'logger'> & { partition?: string },
  ): HookSession {
    if (this.disposed) throw new Error('HookHost 已销毁')
    const errors = validateHookManifest(manifest)
    if (errors.length) throw new Error(`HookManifest 无效: ${errors.join('; ')}`)
    if (this.sessions.has(session.sessionId)) throw new Error(`HookSession 已存在: ${session.sessionId}`)
    const logger = withHookLoggerContext(this.logger, {
      platformId: manifest.platform,
      shopId: session.shopId,
      sessionId: session.sessionId,
    })
    const hookSession = new HookSession({
      ...session,
      manifest,
      factory: this.options.pageFactory,
      scheduler: this.scheduler,
      partition: session.partition || partitionFor(manifest.platform, session.shopId),
      logger,
    })
    this.sessions.set(session.sessionId, hookSession)
    return hookSession
  }

  getSession(sessionId: string): HookSession | undefined {
    return this.sessions.get(sessionId)
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.sessions.delete(sessionId)
    await session.dispose()
    return true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.dispose()))
    this.scheduler.stop()
    this.logger.info('Hook host disposed', { sessionCount: sessions.length })
  }

  async stop(): Promise<void> {
    await this.dispose()
  }
}

export * from './pages/types.js'
export * from './pages/persistent-page-manager.js'
export * from './pages/worker-page-manager.js'
export * from './scheduler/worker-scheduler.js'
export * from './session/hook-session.js'
export * from './transport/electron-page-factory.js'
