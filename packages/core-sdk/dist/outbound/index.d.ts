import type { HookMessageType } from '../contracts/index.js';
export interface OutboundCorrelation {
    operationId: string;
    conversationId: string;
    messageType: HookMessageType;
    fingerprint: string;
    createdAt: number;
}
export interface TrackOutboundInput extends Omit<OutboundCorrelation, 'operationId' | 'createdAt'> {
    operationId?: string;
    createdAt?: number;
}
export interface MatchOutboundInput {
    conversationId: string;
    messageType: HookMessageType;
    fingerprint: string;
    receivedAt?: number;
}
export interface OutboundCorrelationTrackerOptions {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
}
export declare class OutboundCorrelationTracker {
    private readonly entries;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    private sequence;
    constructor(options?: OutboundCorrelationTrackerOptions);
    get size(): number;
    register(input: TrackOutboundInput): OutboundCorrelation;
    remove(operationId: string): boolean;
    match(input: MatchOutboundInput): OutboundCorrelation | undefined;
    clear(): void;
    private prune;
}
//# sourceMappingURL=index.d.ts.map