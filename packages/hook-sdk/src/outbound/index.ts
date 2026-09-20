import type { HookMessageType } from '../contracts/index.js'

export interface OutboundCorrelation {
  operationId: string
  conversationId: string
  messageType: HookMessageType
  fingerprint: string
  createdAt: number
}

export interface TrackOutboundInput extends Omit<OutboundCorrelation, 'operationId' | 'createdAt'> {
  operationId?: string
  createdAt?: number
}

export interface MatchOutboundInput {
  conversationId: string
  messageType: HookMessageType
  fingerprint: string
  receivedAt?: number
}

export interface OutboundCorrelationTrackerOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export class OutboundCorrelationTracker {
  private readonly entries = new Map<string, OutboundCorrelation>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private sequence = 0

  constructor(options: OutboundCorrelationTrackerOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? 30_000)
    this.maxEntries = Math.max(1, options.maxEntries ?? 500)
    this.now = options.now ?? Date.now
  }

  get size(): number {
    this.prune()
    return this.entries.size
  }

  register(input: TrackOutboundInput): OutboundCorrelation {
    this.prune()
    const operationId = input.operationId ?? `outbound-${this.now()}-${this.sequence++}`
    const entry: OutboundCorrelation = {
      operationId,
      conversationId: input.conversationId,
      messageType: input.messageType,
      fingerprint: input.fingerprint,
      createdAt: input.createdAt ?? this.now(),
    }
    this.entries.set(operationId, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.entries.delete(oldest)
    }
    return entry
  }

  remove(operationId: string): boolean {
    return this.entries.delete(operationId)
  }

  match(input: MatchOutboundInput): OutboundCorrelation | undefined {
    const receivedAt = input.receivedAt ?? this.now()
    this.prune(receivedAt)
    for (const [operationId, entry] of this.entries) {
      if (
        entry.conversationId === input.conversationId
        && entry.messageType === input.messageType
        && entry.fingerprint === input.fingerprint
        && receivedAt >= entry.createdAt
      ) {
        this.entries.delete(operationId)
        return entry
      }
    }
    return undefined
  }

  clear(): void {
    this.entries.clear()
  }

  private prune(at = this.now()): void {
    for (const [operationId, entry] of this.entries) {
      if (at - entry.createdAt > this.ttlMs) this.entries.delete(operationId)
    }
  }
}
