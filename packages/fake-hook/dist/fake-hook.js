import { HookHost, HookSession } from '@platform-hub/hook-host';
import { fail, hookError, ok, } from '@platform-hub/hook-sdk';
import { fakeHookManifest } from './manifest.js';
const defaultProducts = () => [
    { id: 'product-1', name: 'Fake 商品', price: 19.9, status: 'on_sale', stockQuantity: 8, images: ['fake://product-1.png'], skus: [{ id: 'sku-1', name: '默认', price: 19.9, stockQuantity: 8 }] },
];
export class FakeHookPageFactory {
    shops = new Map();
    pages = [];
    createCount = 0;
    closeCount = 0;
    installCount = 0;
    async create(context) {
        const page = new FakeHookPageAdapter(context, this.stateFor(context.shopId), this);
        this.pages.push(page);
        this.createCount += 1;
        return page;
    }
    setAuthenticated(shopId, authenticated) {
        const state = this.stateFor(shopId);
        if (state.authenticated === authenticated)
            return;
        state.authenticated = authenticated;
        this.pushEvent(state, 'primary', { type: 'auth.changed', timestamp: Date.now(), payload: { auth: { authenticated, shopId } } });
    }
    emitIncomingMessage(shopId, message) {
        const state = this.stateFor(shopId);
        const value = {
            id: message?.id || `message-${state.messages.length + 1}`,
            sessionId: message?.sessionId || 'session-1',
            senderId: message?.senderId || 'buyer-1',
            senderName: message?.senderName || 'Fake 买家',
            content: message?.content || '你好',
            type: message?.type || 'text',
            direction: 'inbound',
            isMine: false,
            timestamp: message?.timestamp || Date.now(),
        };
        state.messages.push(value);
        this.pushEvent(state, 'primary', { type: 'message.created', timestamp: value.timestamp, payload: { message: value } });
        return value;
    }
    emitOrder(shopId, order) {
        const state = this.stateFor(shopId);
        const fingerprint = JSON.stringify(order);
        if (state.orderFingerprints.get(order.id) === fingerprint)
            return false;
        const previous = state.orders.get(order.id);
        state.orders.set(order.id, order);
        state.orderFingerprints.set(order.id, fingerprint);
        if (state.ordersListening) {
            this.pushEvent(state, 'orders', previous
                ? { type: 'order.updated', timestamp: Date.now(), payload: { order, previous } }
                : { type: 'order.created', timestamp: Date.now(), payload: { order } });
        }
        return true;
    }
    requireChallenge(shopId, pageId, operation) {
        this.stateFor(shopId).challengeOperations.add(`${pageId}:${operation}`);
    }
    solveChallenge(shopId, pageId, operation) {
        const state = this.stateFor(shopId);
        state.challengeOperations.delete(`${pageId}:${operation}`);
        for (const wake of [...state.challengeWaiters])
            wake();
        state.challengeWaiters.clear();
    }
    failNext(shopId, pageId, operation) {
        this.stateFor(shopId).failNextOperations.add(`${pageId}:${operation}`);
    }
    stateFor(shopId) {
        let state = this.shops.get(shopId);
        if (!state) {
            state = {
                authenticated: true,
                messages: [],
                products: defaultProducts(),
                orders: new Map(),
                orderFingerprints: new Map(),
                pageEvents: new Map(),
                challengeOperations: new Set(),
                challengeWaiters: new Set(),
                failNextOperations: new Set(),
                ordersListening: false,
            };
            this.shops.set(shopId, state);
        }
        return state;
    }
    pushEvent(state, pageId, event) {
        const events = state.pageEvents.get(pageId) || [];
        events.push(event);
        state.pageEvents.set(pageId, events);
    }
}
export class FakeHook {
    shopId;
    factory;
    host;
    session;
    constructor(shopId = 'fake-shop-1', options) {
        this.shopId = shopId;
        this.factory = new FakeHookPageFactory();
        this.host = new HookHost({ pageFactory: this.factory, maxWorkerConcurrency: options?.maxWorkerConcurrency ?? 2 });
        this.session = this.host.createSession(fakeManifestForSession(), {
            sessionId: options?.sessionId || `fake-session-${shopId}`,
            shopId,
            maxWorkers: 2,
            workerIdleTtlMs: 40,
        });
    }
    async start() { await this.session.start(); }
    async stop() { await this.session.dispose(); this.host.stop(); }
    login() { this.factory.setAuthenticated(this.shopId, true); }
    logout() { this.factory.setAuthenticated(this.shopId, false); }
    receiveMessage(message) { return this.factory.emitIncomingMessage(this.shopId, message); }
    createOrder(order) { return this.factory.emitOrder(this.shopId, order); }
    updateOrder(order) { return this.factory.emitOrder(this.shopId, order); }
    requireChallenge(operation, pageId = operation.startsWith('products.') ? 'products' : 'orders') { this.factory.requireChallenge(this.shopId, pageId, operation); }
    completeChallenge(operation, pageId = operation.startsWith('products.') ? 'products' : 'orders') { this.factory.solveChallenge(this.shopId, pageId, operation); }
    failNext(operation, pageId = operation.startsWith('products.') ? 'products' : 'orders') { this.factory.failNext(this.shopId, pageId, operation); }
    workerPageCount() { return this.session.workerPages.size; }
    workerPageIds() { return this.session.workerPages.ids; }
}
function fakeManifestForSession() {
    return fakeHookManifest;
}
class FakeHookPageAdapter {
    context;
    state;
    owner;
    id;
    partition;
    definition;
    visible = false;
    alive = true;
    runtime;
    constructor(context, state, owner) {
        this.context = context;
        this.state = state;
        this.owner = owner;
        this.id = context.definition.id;
        this.partition = context.partition;
        this.definition = context.definition;
    }
    async installRuntime() {
        if (!this.alive)
            throw new Error('Fake page 已关闭');
        this.runtime = new FakePageRuntime(this.context, this.state);
        this.owner.installCount += 1;
        return this.runtime;
    }
    async show() { this.visible = true; }
    async waitForRuntimeReady(signal) {
        if (![...this.state.challengeOperations].some((key) => key.startsWith(`${this.id}:`)))
            return;
        await new Promise((resolve, reject) => {
            const done = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(new Error('Challenge Recovery 已取消')); };
            const cleanup = () => {
                this.state.challengeWaiters.delete(done);
                signal?.removeEventListener('abort', abort);
            };
            this.state.challengeWaiters.add(done);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async close() {
        if (!this.alive)
            return;
        this.alive = false;
        this.owner.closeCount += 1;
    }
    isAlive() { return this.alive; }
}
class FakePageRuntime {
    context;
    state;
    protocolVersion = 1;
    disposed = false;
    constructor(context, state) {
        this.context = context;
        this.state = state;
    }
    describe() {
        const operations = Object.entries(this.context.manifest.operations)
            .filter(([, route]) => route.page === this.context.definition.id)
            .map(([operation]) => operation);
        return {
            protocolVersion: this.protocolVersion,
            platform: this.context.manifest.platform,
            pageId: this.context.definition.id,
            capabilities: operations,
            operations,
        };
    }
    async invoke(operation, input) {
        if (this.disposed)
            return fail(hookError('RUNTIME_NOT_READY', 'Fake runtime 已销毁'));
        const key = `${this.context.definition.id}:${operation}`;
        if (this.state.failNextOperations.delete(key))
            throw new Error(`Fake runtime failure: ${operation}`);
        if (this.state.challengeOperations.has(key))
            return fail(hookError('CHALLENGE_REQUIRED', '需要用户完成官方验证', { pageId: this.context.definition.id }, true));
        if (!this.state.authenticated && operation !== 'auth.state')
            return fail(hookError('LOGIN_REQUIRED', '请先登录'));
        switch (operation) {
            case 'auth.state': return ok({ authenticated: this.state.authenticated, shopId: this.context.shopId });
            case 'sessions.list': return ok([{ id: 'session-1', title: 'Fake 会话', unreadCount: this.state.messages.filter((message) => !message.isMine).length }]);
            case 'messages.listen': return ok({ listening: true, watermark: this.state.messages.at(-1)?.timestamp || 0 });
            case 'messages.history': return ok(this.state.messages.filter((message) => message.sessionId === String(input?.sessionId || 'session-1')));
            case 'messages.send.text': return this.sendText(input);
            case 'messages.send.file': return this.sendFile(input);
            case 'products.list': return ok(this.state.products);
            case 'products.detail': return this.productDetail(input);
            case 'orders.list': return ok([...this.state.orders.values()]);
            case 'orders.listen': {
                this.state.pageEvents.set('orders', []);
                this.state.ordersListening = true;
                return ok({ listening: true, watermark: Math.max(0, ...[...this.state.orders.values()].map((order) => order.updatedAt || order.createdAt || 0)) });
            }
            default: return fail(hookError('NOT_SUPPORTED', `FakeHook 不支持 ${operation}`));
        }
    }
    drainEvents() {
        if (this.disposed)
            return [];
        const events = this.state.pageEvents.get(this.context.definition.id) || [];
        this.state.pageEvents.set(this.context.definition.id, []);
        return events;
    }
    async dispose() { this.disposed = true; }
    sendText(input) {
        const value = input;
        if (!value?.sessionId || !value.text)
            return fail(hookError('INVALID_INPUT', 'sessionId 和 text 必填'));
        const message = {
            id: `message-${this.state.messages.length + 1}`,
            sessionId: value.sessionId,
            senderId: 'seller',
            content: value.text,
            type: 'text',
            direction: 'outbound',
            isMine: true,
            timestamp: Date.now(),
        };
        this.state.messages.push(message);
        return ok(message);
    }
    sendFile(input) {
        const value = input;
        if (!value?.sessionId || !value.url)
            return fail(hookError('INVALID_INPUT', 'sessionId 和 url 必填'));
        const message = {
            id: `message-${this.state.messages.length + 1}`,
            sessionId: value.sessionId,
            senderId: 'seller',
            content: value.name || value.url,
            type: 'file',
            direction: 'outbound',
            isMine: true,
            timestamp: Date.now(),
            attachments: [{ url: value.url, name: value.name }],
        };
        this.state.messages.push(message);
        return ok(message);
    }
    productDetail(input) {
        const id = String(input?.id || '');
        const product = this.state.products.find((item) => item.id === id);
        return product ? ok(product) : fail(hookError('INVALID_INPUT', `商品不存在: ${id}`));
    }
}
//# sourceMappingURL=fake-hook.js.map