export class OutboundCorrelationTracker {
    entries = new Map();
    ttlMs;
    maxEntries;
    now;
    sequence = 0;
    constructor(options = {}) {
        this.ttlMs = Math.max(1, options.ttlMs ?? 30_000);
        this.maxEntries = Math.max(1, options.maxEntries ?? 500);
        this.now = options.now ?? Date.now;
    }
    get size() {
        this.prune();
        return this.entries.size;
    }
    register(input) {
        this.prune();
        const operationId = input.operationId ?? `outbound-${this.now()}-${this.sequence++}`;
        const entry = {
            operationId,
            conversationId: input.conversationId,
            messageType: input.messageType,
            fingerprint: input.fingerprint,
            createdAt: input.createdAt ?? this.now(),
        };
        this.entries.set(operationId, entry);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (!oldest)
                break;
            this.entries.delete(oldest);
        }
        return entry;
    }
    remove(operationId) {
        return this.entries.delete(operationId);
    }
    match(input) {
        const receivedAt = input.receivedAt ?? this.now();
        this.prune(receivedAt);
        for (const [operationId, entry] of this.entries) {
            if (entry.conversationId === input.conversationId
                && entry.messageType === input.messageType
                && entry.fingerprint === input.fingerprint
                && receivedAt >= entry.createdAt) {
                this.entries.delete(operationId);
                return entry;
            }
        }
        return undefined;
    }
    clear() {
        this.entries.clear();
    }
    prune(at = this.now()) {
        for (const [operationId, entry] of this.entries) {
            if (at - entry.createdAt > this.ttlMs)
                this.entries.delete(operationId);
        }
    }
}
//# sourceMappingURL=index.js.map