import type { HookManifest } from '@platform-hub/hook-sdk'
import { HookSession, partitionFor, type HookSessionOptions } from './session/hook-session.js'
import type { HookPageFactory } from './pages/types.js'
import { WorkerScheduler } from './scheduler/worker-scheduler.js'

export interface HookHostOptions {
  pageFactory: HookPageFactory
  maxWorkerConcurrency?: number
}

export class HookHost {
  readonly scheduler: WorkerScheduler
  constructor(private readonly options: HookHostOptions) {
    this.scheduler = new WorkerScheduler(options.maxWorkerConcurrency ?? 4)
  }

  createSession(manifest: HookManifest, session: Omit<HookSessionOptions, 'manifest' | 'factory' | 'scheduler' | 'partition'> & { partition?: string }): HookSession {
    return new HookSession({
      ...session,
      manifest,
      factory: this.options.pageFactory,
      scheduler: this.scheduler,
      partition: session.partition || partitionFor(manifest.platform, session.shopId),
    })
  }

  stop(): void { this.scheduler.stop() }
}

export * from './pages/types.js'
export * from './pages/worker-page-manager.js'
export * from './scheduler/worker-scheduler.js'
export * from './session/hook-session.js'
export * from './transport/electron-page-factory.js'
