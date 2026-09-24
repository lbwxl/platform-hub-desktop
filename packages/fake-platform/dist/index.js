import { ok } from '@platform-hub/core-sdk';
export const fakePlatformDefinition = {
    id: 'fake-platform',
    label: 'Fake Platform',
    url: 'fake://platform',
    executionModel: 'service',
    capabilities: ['messages.listen'],
    version: '0.1.0',
};
export class FakePlatformAdapter {
    account;
    transport;
    calls = [];
    listeners = new Set();
    running = false;
    constructor(account) {
        this.account = account;
        this.transport = {
            start: async () => { this.calls.push('transport.start'); },
            invoke: async (operation, input) => ok({ operation, input }),
            subscribe: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
            stop: async () => { this.calls.push('transport.stop'); },
        };
    }
    get id() { return this.account.id; }
    async start() { this.calls.push('start'); this.running = true; await this.transport.start(); }
    async stop() { this.calls.push('stop'); this.running = false; await this.transport.stop(); }
    async getStatus() { this.calls.push('getStatus'); return { connected: this.running, authenticated: this.running, url: this.account.url, message: this.running ? 'ready' : 'stopped' }; }
    async attachPrimaryView() { this.calls.push('attachPrimaryView'); }
    detachPrimaryView() { this.calls.push('detachPrimaryView'); }
    updatePrimaryViewBounds(_bounds) { this.calls.push('updatePrimaryViewBounds'); }
    async dispose() { this.calls.push('dispose'); await this.stop(); }
}
export function createFakePlatformFactory() {
    return {
        definition: fakePlatformDefinition,
        create: (account, _context) => new FakePlatformAdapter(account),
    };
}
//# sourceMappingURL=index.js.map