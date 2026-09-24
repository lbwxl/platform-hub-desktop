import { ok, type HookOperation, type HookEvent, type HookResult } from '@platform-hub/hook-sdk'
import type { HookTransport } from '@platform-hub/hook-transport'
import type { PlatformAccountRecord, PlatformRuntimeAdapter, PlatformRuntimeFactory, PlatformRuntimeHostContext, PlatformRuntimeStatus, PlatformViewBounds } from '@platform-hub/platform-runtime'

export const fakePlatformDefinition = {
  id: 'fake-platform',
  label: 'Fake Platform',
  url: 'fake://platform',
  executionModel: 'service' as const,
  capabilities: ['messages.listen'] as const,
  version: '0.1.0',
}

export class FakePlatformAdapter implements PlatformRuntimeAdapter {
  readonly transport: HookTransport
  readonly calls: string[] = []
  private readonly listeners = new Set<(event: HookEvent) => void>()
  private running = false

  constructor(private readonly account: PlatformAccountRecord) {
    this.transport = {
      start: async () => { this.calls.push('transport.start') },
      invoke: async <T>(operation: HookOperation, input: unknown): Promise<HookResult<T>> => ok({ operation, input } as T),
      subscribe: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) },
      stop: async () => { this.calls.push('transport.stop') },
    }
  }

  get id(): string { return this.account.id }
  async start(): Promise<void> { this.calls.push('start'); this.running = true; await this.transport.start() }
  async stop(): Promise<void> { this.calls.push('stop'); this.running = false; await this.transport.stop() }
  async getStatus(): Promise<PlatformRuntimeStatus> { this.calls.push('getStatus'); return { connected: this.running, authenticated: this.running, url: this.account.url, message: this.running ? 'ready' : 'stopped' } }
  async attachPrimaryView(): Promise<void> { this.calls.push('attachPrimaryView') }
  detachPrimaryView(): void { this.calls.push('detachPrimaryView') }
  updatePrimaryViewBounds(_bounds: PlatformViewBounds): void { this.calls.push('updatePrimaryViewBounds') }
  async dispose(): Promise<void> { this.calls.push('dispose'); await this.stop() }
}

export function createFakePlatformFactory(): PlatformRuntimeFactory {
  return {
    definition: fakePlatformDefinition,
    create: (account: PlatformAccountRecord, _context: PlatformRuntimeHostContext) => new FakePlatformAdapter(account),
  }
}
