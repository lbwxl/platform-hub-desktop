import { HOOK_PROTOCOL_VERSION, OutboundCorrelationTracker, fail, hookError, } from '@platform-hub/hook-sdk';
import { douyinHookRuntimeScript } from './runtime-source.js';
export function createDouyinPageRuntime(options) {
    let disposed = false;
    const outbound = new OutboundCorrelationTracker();
    return {
        get protocolVersion() { return options.description.protocolVersion; },
        describe: () => options.description,
        async invoke(operation, input) {
            if (disposed)
                return fail(hookError('RUNTIME_NOT_READY', 'Douyin Runtime 已销毁', undefined, true));
            const correlation = outboundInput(operation, input);
            const tracked = correlation ? outbound.register(correlation) : undefined;
            try {
                await ensurePageRuntime(options);
                options.logger?.debug('Invoking Douyin operation', { operation });
                const result = await options.evaluate(`globalThis.__PLATFORM_HOOK__.invoke(${JSON.stringify(operation)}, ${JSON.stringify(input ?? {})})`);
                if (!result.ok) {
                    if (tracked)
                        outbound.remove(tracked.operationId);
                    return result;
                }
                if (correlation && isHookMessage(result.data)) {
                    return { ok: true, data: { ...result.data, origin: 'automation' } };
                }
                return result;
            }
            catch (error) {
                if (tracked)
                    outbound.remove(tracked.operationId);
                options.logger?.warn('Douyin operation failed', { operation, error: error instanceof Error ? error.message : String(error) });
                return fail(hookError('PLATFORM_ERROR', error instanceof Error ? error.message : String(error), undefined, true));
            }
        },
        async drainEvents() {
            if (disposed)
                return [];
            try {
                await ensurePageRuntime(options);
                const events = await options.evaluate('globalThis.__PLATFORM_HOOK__.drainEvents()');
                return events.map((event) => attributeOutbound(event, outbound));
            }
            catch {
                return [];
            }
        },
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            outbound.clear();
            try {
                await options.evaluate('globalThis.__PLATFORM_HOOK__?.dispose?.()');
            }
            catch { /* page may already be gone */ }
        },
    };
}
export async function installDouyinPageRuntime(evaluate, page, manifest, logger) {
    const runtimeScript = `globalThis.__PLATFORM_HOOK_PAGE_ID__ = ${JSON.stringify(page.id)};\n${douyinHookRuntimeScript}`;
    await evaluate(runtimeScript);
    const description = await evaluate('globalThis.__PLATFORM_HOOK__.describe()');
    return createDouyinPageRuntime({ description, evaluate, runtimeScript, logger });
}
export { douyinHookRuntimeScript };
function outboundInput(operation, input) {
    const value = input && typeof input === 'object' ? input : {};
    const conversationId = String(value.conversationId || '');
    if (!conversationId)
        return undefined;
    if (operation === 'messages.send.text') {
        const content = String(value.text || '');
        return content ? { conversationId, messageType: 'text', fingerprint: fingerprint('text', content) } : undefined;
    }
    if (operation === 'messages.send.file') {
        const content = String(value.name || value.fileName || value.url || value.dataUrl || value.data || '');
        const messageType = String(value.mimeType || '').startsWith('image/') ? 'image' : 'file';
        return content ? { conversationId, messageType, fingerprint: fingerprint(messageType, messageType === 'image' ? '' : content) } : undefined;
    }
    return undefined;
}
function attributeOutbound(event, tracker) {
    if (event.type !== 'message.created')
        return event;
    const message = event.payload.message;
    if (message.direction !== 'outbound')
        return event;
    const matched = tracker.match({
        conversationId: message.conversationId,
        messageType: message.type,
        fingerprint: fingerprint(message.type, message.type === 'image' ? '' : message.content || message.attachments?.[0]?.name || ''),
    });
    if (!matched)
        return event;
    return { ...event, payload: { message: { ...message, origin: 'automation', deliveryStatus: 'sent' } } };
}
function fingerprint(type, content) {
    return `${type}:${content.trim()}`;
}
function isHookMessage(value) {
    return Boolean(value && typeof value === 'object' && 'conversationId' in value && 'direction' in value);
}
async function ensurePageRuntime(options) {
    if (!options.runtimeScript)
        return;
    const ready = await options.evaluate(`(() => {
    const runtime = globalThis.__PLATFORM_HOOK__
    if (!runtime || runtime.protocolVersion !== ${HOOK_PROTOCOL_VERSION}) return false
    try { return runtime.describe().pageId === ${JSON.stringify(options.description.pageId)} } catch { return false }
  })()`);
    if (!ready)
        await options.evaluate(options.runtimeScript);
}
//# sourceMappingURL=runtime.js.map