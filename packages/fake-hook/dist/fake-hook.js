import { HookHost, HookSession } from '@platform-hub/core-page-host';
import { fail, HOOK_PROTOCOL_VERSION, hookError, ok, OutboundCorrelationTracker, } from '@platform-hub/core-sdk';
import { fakeHookManifest } from './manifest.js';
const defaultProducts = () => [{
        id: 'product-1',
        externalId: 'external-product-1',
        title: 'Fake 商品',
        description: 'FakeHook contract product',
        status: 'on_sale',
        price: { amount: 19.9, currency: 'CNY' },
        stockQuantity: 8,
        images: ['fake://product-1.png'],
        skus: [{ id: 'sku-1', externalId: 'external-sku-1', name: '默认', price: { amount: 19.9, currency: 'CNY' }, stockQuantity: 8 }],
        url: 'fake://products/product-1',
    }];
export class FakeHookPageFactory {
    shops = new Map();
    pages = [];
    pushEvents;
    drainDelayMs;
    runtimeRecords = [];
    createCount = 0;
    closeCount = 0;
    installCount = 0;
    drainCount = 0;
    subscriptionCount = 0;
    activeDrains = 0;
    maxActiveDrains = 0;
    constructor(options = {}) {
        this.pushEvents = options.pushEvents ?? true;
        this.drainDelayMs = Math.max(0, options.drainDelayMs ?? 0);
    }
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
    emitIncomingMessage(shopId, message = {}) {
        const state = this.stateFor(shopId);
        const value = {
            id: message.id || `message-${state.messages.length + 1}`,
            conversationId: message.conversationId || 'conversation-1',
            senderId: message.senderId || 'buyer-1',
            senderName: message.senderName || 'Fake 买家',
            content: message.content || '你好',
            type: message.type || 'text',
            direction: 'inbound',
            origin: 'customer',
            deliveryStatus: 'sent',
            timestamp: message.timestamp || Date.now(),
            attachments: message.attachments,
            raw: message.raw,
        };
        this.appendMessage(state, value);
        return value;
    }
    emitHumanOutgoingMessage(shopId, input = {}) {
        const state = this.stateFor(shopId);
        return this.emitPlatformOutgoing(state, {
            conversationId: input.conversationId || 'conversation-1',
            content: input.content || '人工回复',
            type: input.type || 'text',
        });
    }
    emitOrder(shopId, order) {
        const state = this.stateFor(shopId);
        const previous = state.orders.get(order.id);
        const changedFields = previous ? orderChangedFields(previous, order) : [];
        if (previous && changedFields.length === 0)
            return false;
        state.orders.set(order.id, order);
        if (state.ordersListening) {
            this.pushEvent(state, 'orders', previous
                ? { type: 'order.updated', timestamp: Date.now(), payload: { order, previous, changedFields } }
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
    setProducts(shopId, products) {
        this.stateFor(shopId).products = [...products];
    }
    setProductPageSize(shopId, pageSize) {
        this.stateFor(shopId).productPageSize = Math.max(1, Math.floor(pageSize));
    }
    failProductPage(shopId, page) {
        this.stateFor(shopId).productPageFailures.add(Math.max(0, Math.floor(page)));
    }
    challengeProductPage(shopId, page) {
        const state = this.stateFor(shopId);
        state.productPageChallenges.add(Math.max(0, Math.floor(page)));
        state.challengeOperations.add('products:products.list');
    }
    completeProductPageChallenge(shopId, page) {
        const state = this.stateFor(shopId);
        state.productPageChallenges.delete(Math.max(0, Math.floor(page)));
        if (!state.productPageChallenges.size)
            state.challengeOperations.delete('products:products.list');
        for (const wake of [...state.challengeWaiters])
            wake();
        state.challengeWaiters.clear();
    }
    duplicateProductPage(shopId, page) {
        this.stateFor(shopId).productPageDuplicates.add(Math.max(0, Math.floor(page)));
    }
    setOperationDelay(shopId, pageId, operation, delayMs) {
        this.stateFor(shopId).operationDelays.set(`${pageId}:${operation}`, Math.max(0, delayMs));
    }
    setRuntimeDescriptionOverride(shopId, pageId, override) {
        this.stateFor(shopId).runtimeOverrides.set(pageId, override);
    }
    failNextStart(shopId) { this.stateFor(shopId).failStart = true; }
    failNextStop(shopId) { this.stateFor(shopId).failStop = true; }
    stateFor(shopId) {
        let state = this.shops.get(shopId);
        if (!state) {
            state = {
                authenticated: true,
                messages: [],
                products: defaultProducts(),
                productPageSize: 100,
                productPageFailures: new Set(),
                productPageChallenges: new Set(),
                productPageDuplicates: new Set(),
                orders: new Map(),
                pageEvents: new Map(),
                pageListeners: new Map(),
                challengeOperations: new Set(),
                challengeWaiters: new Set(),
                failNextOperations: new Set(),
                operationDelays: new Map(),
                runtimeOverrides: new Map(),
                ordersListening: false,
                outbound: new OutboundCorrelationTracker(),
                handoffTargets: [{ id: 'agent-1', name: 'Fake 客服' }],
                handoffs: [],
                failStart: false,
                failStop: false,
            };
            this.shops.set(shopId, state);
        }
        return state;
    }
    subscribe(state, pageId, listener) {
        const listeners = state.pageListeners.get(pageId) || new Set();
        listeners.add(listener);
        state.pageListeners.set(pageId, listeners);
        this.subscriptionCount += 1;
        const queued = state.pageEvents.get(pageId) || [];
        state.pageEvents.set(pageId, []);
        for (const event of queued)
            listener(event);
        return () => {
            if (listeners.delete(listener))
                this.subscriptionCount -= 1;
            if (listeners.size === 0)
                state.pageListeners.delete(pageId);
        };
    }
    pushEvent(state, pageId, event) {
        const listeners = state.pageListeners.get(pageId);
        if (listeners?.size) {
            for (const listener of listeners)
                listener(event);
            return;
        }
        const events = state.pageEvents.get(pageId) || [];
        events.push(event);
        state.pageEvents.set(pageId, events);
    }
    appendMessage(state, message) {
        state.messages.push(message);
        this.pushEvent(state, 'primary', { type: 'message.created', timestamp: message.timestamp, payload: { message } });
    }
    emitPlatformOutgoing(state, input) {
        const matched = state.outbound.match({
            conversationId: input.conversationId,
            messageType: input.type,
            fingerprint: outboundFingerprint(input.type, input.content),
        });
        const message = {
            id: `message-${state.messages.length + 1}`,
            conversationId: input.conversationId,
            senderId: 'seller',
            content: input.content,
            type: input.type,
            direction: 'outbound',
            origin: matched ? 'automation' : 'human',
            deliveryStatus: 'sent',
            timestamp: Date.now(),
            attachments: input.attachments,
        };
        this.appendMessage(state, message);
        return message;
    }
    sendAutomation(state, input) {
        state.outbound.register({
            conversationId: input.conversationId,
            messageType: input.type,
            fingerprint: outboundFingerprint(input.type, input.content),
        });
        return this.emitPlatformOutgoing(state, input);
    }
    createRuntimeRecord(pageId) {
        const record = { id: `runtime-${this.runtimeRecords.length + 1}`, pageId, disposeCount: 0 };
        this.runtimeRecords.push(record);
        return record;
    }
}
export class FakeHook {
    shopId;
    factory;
    host;
    session;
    constructor(shopId = 'fake-shop-1', options = {}) {
        this.shopId = shopId;
        this.factory = new FakeHookPageFactory({ pushEvents: options.pushEvents });
        this.host = new HookHost({ pageFactory: this.factory, maxWorkerConcurrency: options.maxWorkerConcurrency ?? 2 });
        this.session = this.host.createSession(fakeHookManifest, {
            sessionId: options.sessionId || `fake-session-${shopId}`,
            shopId,
            maxWorkers: 2,
            workerIdleTtlMs: 40,
            challengeTimeoutMs: options.challengeTimeoutMs,
        });
    }
    async start() { await this.session.start(); }
    async stop() { await this.host.dispose(); }
    login() { this.factory.setAuthenticated(this.shopId, true); }
    logout() { this.factory.setAuthenticated(this.shopId, false); }
    receiveMessage(message) { return this.factory.emitIncomingMessage(this.shopId, message); }
    sendHumanMessage(input) { return this.factory.emitHumanOutgoingMessage(this.shopId, input); }
    createOrder(order) { return this.factory.emitOrder(this.shopId, order); }
    updateOrder(order) { return this.factory.emitOrder(this.shopId, order); }
    requireChallenge(operation, pageId = pageForOperation(operation)) { this.factory.requireChallenge(this.shopId, pageId, operation); }
    completeChallenge(operation, pageId = pageForOperation(operation)) { this.factory.solveChallenge(this.shopId, pageId, operation); }
    failNext(operation, pageId = pageForOperation(operation)) { this.factory.failNext(this.shopId, pageId, operation); }
    setProducts(products) { this.factory.setProducts(this.shopId, products); }
    setProductPageSize(pageSize) { this.factory.setProductPageSize(this.shopId, pageSize); }
    failProductPage(page) { this.factory.failProductPage(this.shopId, page); }
    challengeProductPage(page) { this.factory.challengeProductPage(this.shopId, page); }
    completeProductPageChallenge(page) { this.factory.completeProductPageChallenge(this.shopId, page); }
    duplicateProductPage(page) { this.factory.duplicateProductPage(this.shopId, page); }
    setOperationDelay(operation, delayMs, pageId = pageForOperation(operation)) { this.factory.setOperationDelay(this.shopId, pageId, operation, delayMs); }
    setRuntimeDescriptionOverride(pageId, override) { this.factory.setRuntimeDescriptionOverride(this.shopId, pageId, override); }
    failNextStart() { this.factory.failNextStart(this.shopId); }
    failNextStop() { this.factory.failNextStop(this.shopId); }
    workerPageCount() { return this.session.workerPages.size; }
    workerPageIds() { return this.session.workerPages.ids; }
}
export class FakeHookPageAdapter {
    context;
    state;
    owner;
    id;
    partition;
    definition;
    subscribeEvents;
    visible = false;
    alive = true;
    constructor(context, state, owner) {
        this.context = context;
        this.state = state;
        this.owner = owner;
        this.id = context.definition.id;
        this.partition = context.partition;
        this.definition = context.definition;
        if (owner.pushEvents)
            this.subscribeEvents = (listener) => owner.subscribe(state, this.id, listener);
    }
    async installRuntime() {
        if (!this.alive)
            throw new Error('Fake page 已关闭');
        if (this.definition.kind === 'primary' && this.state.failStart) {
            this.state.failStart = false;
            throw new Error('Fake start failure');
        }
        this.owner.installCount += 1;
        return new FakePageRuntime(this.context, this.state, this.owner, this.owner.createRuntimeRecord(this.definition.id), this.state.runtimeOverrides.get(this.definition.id));
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
    owner;
    record;
    override;
    protocolVersion;
    disposed = false;
    constructor(context, state, owner, record, override) {
        this.context = context;
        this.state = state;
        this.owner = owner;
        this.record = record;
        this.override = override;
        this.protocolVersion = override?.protocolVersion ?? HOOK_PROTOCOL_VERSION;
    }
    describe() {
        const operations = Object.entries(this.context.manifest.operations)
            .filter(([, route]) => route?.page === this.context.definition.id)
            .map(([operation]) => operation);
        return {
            protocolVersion: this.override?.protocolVersion ?? this.protocolVersion,
            platform: this.override?.platform ?? this.context.manifest.platform,
            pageId: this.override?.pageId ?? this.context.definition.id,
            capabilities: this.override?.capabilities ?? operations,
            operations: this.override?.operations ?? operations,
        };
    }
    async invoke(operation, input) {
        if (this.disposed)
            return fail(hookError('RUNTIME_NOT_READY', 'Fake runtime 已销毁'));
        const key = `${this.context.definition.id}:${operation}`;
        const delayMs = this.state.operationDelays.get(key) || 0;
        if (delayMs > 0)
            await delay(delayMs);
        if (this.state.failNextOperations.delete(key))
            throw new Error(`Fake runtime failure: ${operation}`);
        if (this.state.challengeOperations.has(key))
            return fail(hookError('CHALLENGE_REQUIRED', '需要用户完成官方验证', { pageId: this.context.definition.id }, true));
        if (!this.state.authenticated && operation !== 'auth.state')
            return fail(hookError('LOGIN_REQUIRED', '请先登录'));
        switch (operation) {
            case 'auth.state': return ok({ authenticated: this.state.authenticated, shopId: this.context.shopId });
            case 'sessions.list': return ok([{ id: 'conversation-1', title: 'Fake 会话', unreadCount: this.state.messages.filter((message) => message.origin === 'customer').length }]);
            case 'messages.listen': return ok({ listening: true, watermark: this.state.messages.at(-1)?.timestamp || 0 });
            case 'messages.history': return ok(this.state.messages.filter((message) => message.conversationId === String(input?.conversationId || 'conversation-1')));
            case 'messages.send.text': return this.sendText(input);
            case 'messages.send.file': return this.sendFile(input);
            case 'products.list': return this.listProducts();
            case 'products.detail': return this.productDetail(input);
            case 'orders.list': return ok([...this.state.orders.values()]);
            case 'orders.listen': {
                this.state.pageEvents.set('orders', []);
                this.state.ordersListening = true;
                return ok({ listening: true, watermark: Math.max(0, ...[...this.state.orders.values()].map((order) => order.updatedAt || order.createdAt || 0)) });
            }
            case 'handoff.targets.list': return ok(this.state.handoffTargets);
            case 'handoff.transfer': return this.transfer(input);
            case 'conversation.attention.set': return this.setConversationAttention(input);
            default: return fail(hookError('NOT_SUPPORTED', `FakeHook 不支持 ${operation}`));
        }
    }
    async drainEvents() {
        this.owner.drainCount += 1;
        this.owner.activeDrains += 1;
        this.owner.maxActiveDrains = Math.max(this.owner.maxActiveDrains, this.owner.activeDrains);
        try {
            if (this.owner.drainDelayMs > 0)
                await delay(this.owner.drainDelayMs);
            else
                await Promise.resolve();
            if (this.disposed)
                return [];
            const events = this.state.pageEvents.get(this.context.definition.id) || [];
            this.state.pageEvents.set(this.context.definition.id, []);
            return events;
        }
        finally {
            this.owner.activeDrains -= 1;
        }
    }
    async dispose() {
        this.record.disposeCount += 1;
        this.disposed = true;
        this.state.outbound.clear();
        if (this.state.failStop) {
            this.state.failStop = false;
            throw new Error('Fake stop failure');
        }
    }
    sendText(input) {
        const value = input;
        if (!value?.conversationId || !value.text)
            return fail(hookError('INVALID_INPUT', 'conversationId 和 text 必填'));
        if (value.simulateFailure) {
            const tracked = this.state.outbound.register({
                conversationId: value.conversationId,
                messageType: 'text',
                fingerprint: outboundFingerprint('text', value.text),
            });
            this.state.outbound.remove(tracked.operationId);
            return fail(hookError('PLATFORM_ERROR', 'Fake outbound failure', undefined, true));
        }
        return ok(this.owner.sendAutomation(this.state, {
            conversationId: value.conversationId,
            content: value.text,
            type: 'text',
        }));
    }
    sendFile(input) {
        const value = input;
        const source = value?.data || value?.dataUrl || value?.url;
        if (!value?.conversationId || !source)
            return fail(hookError('INVALID_INPUT', 'conversationId 和文件数据必填'));
        const content = value.name || 'attachment';
        if (value.simulateFailure) {
            const tracked = this.state.outbound.register({
                conversationId: value.conversationId,
                messageType: 'file',
                fingerprint: outboundFingerprint('file', content),
            });
            this.state.outbound.remove(tracked.operationId);
            return fail(hookError('PLATFORM_ERROR', 'Fake outbound failure', undefined, true));
        }
        return ok(this.owner.sendAutomation(this.state, {
            conversationId: value.conversationId,
            content,
            type: 'file',
            attachments: [{ ...(source.startsWith('http') ? { url: source } : {}), name: value.name, mimeType: value.mimeType }],
        }));
    }
    productDetail(input) {
        const id = String(input?.id || '');
        const product = this.state.products.find((item) => item.id === id);
        return product ? ok(product) : fail(hookError('INVALID_INPUT', `商品不存在: ${id}`));
    }
    listProducts() {
        const pageSize = Math.max(1, this.state.productPageSize);
        const onSale = this.state.products.filter((product) => product.status === 'on_sale');
        const pages = Math.max(1, Math.ceil(onSale.length / pageSize));
        const byExternalId = new Map();
        for (let page = 0; page < pages; page += 1) {
            if (this.state.productPageChallenges.has(page)) {
                return fail(hookError('CHALLENGE_REQUIRED', `商品分页 ${page} 需要验证`, { page }, true));
            }
            if (this.state.productPageFailures.has(page)) {
                this.state.productPageFailures.delete(page);
                return fail(hookError('PLATFORM_ERROR', `商品分页 ${page} 失败`, { page }, true));
            }
            const rows = onSale.slice(page * pageSize, (page + 1) * pageSize);
            const responseRows = this.state.productPageDuplicates.has(page) && rows[0] ? [...rows, rows[0]] : rows;
            for (const product of responseRows)
                byExternalId.set(product.externalId, product);
        }
        return ok([...byExternalId.values()]);
    }
    transfer(input) {
        const value = input;
        if (!value?.conversationId)
            return fail(hookError('INVALID_INPUT', 'conversationId 必填'));
        const target = value.targetId
            ? this.state.handoffTargets.find((item) => item.id === value.targetId)
            : value.targetName
                ? this.state.handoffTargets.find((item) => item.name === value.targetName)
                : this.state.handoffTargets[0];
        const result = { transferred: true, ...(target ? { target } : {}) };
        this.state.handoffs.push(result);
        return ok(result);
    }
    setConversationAttention(input) {
        const value = input;
        if (!value?.conversationId || !['pending', 'opened', 'resolved'].includes(String(value.state))) {
            return fail(hookError('INVALID_INPUT', 'conversationId 和有效 attention state 必填'));
        }
        return ok({ conversationId: value.conversationId, state: String(value.state), active: value.state !== 'resolved' });
    }
}
function outboundFingerprint(type, content) {
    return `${type}:${content.trim()}`;
}
function pageForOperation(operation) {
    if (operation.startsWith('products.'))
        return 'products';
    if (operation.startsWith('orders.'))
        return 'orders';
    return 'primary';
}
function orderChangedFields(previous, next) {
    const fields = [
        'externalId', 'shopId', 'conversationId', 'buyer', 'status', 'items', 'total', 'receiver', 'createdAt',
    ];
    return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=fake-hook.js.map