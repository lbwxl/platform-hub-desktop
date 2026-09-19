import { doudianHookScript } from './hook.js';
function invocation(method, args) {
    return `(() => {
    const api = globalThis.__platformHub
    if (!api || typeof api[${JSON.stringify(method)}] !== 'function') {
      throw new Error(${JSON.stringify(`抖店 Hook 方法不可用: ${method}`)})
    }
    return api[${JSON.stringify(method)}](...${JSON.stringify(args)})
  })()`;
}
/** Creates a typed client over any CDP Runtime.evaluate implementation. */
export function createDoudianClient(evaluate) {
    const invoke = (method, ...args) => evaluate(invocation(method, args));
    const getAuthState = () => invoke('getAuthState');
    const listeners = new Set();
    let pollTimer;
    let pollInterval = 800;
    let draining = false;
    const drain = async () => {
        if (draining || !listeners.size)
            return;
        draining = true;
        try {
            const events = await invoke('drainEvents');
            for (const event of events)
                for (const listener of [...listeners])
                    listener(event);
        }
        catch (error) {
            const event = { type: 'error', payload: { error: String(error) }, timestamp: Date.now() };
            for (const listener of [...listeners])
                listener(event);
        }
        finally {
            draining = false;
        }
    };
    const restartPolling = (intervalMs) => {
        const nextInterval = Math.min(pollInterval, intervalMs);
        if (pollTimer && nextInterval === pollInterval)
            return;
        pollInterval = nextInterval;
        if (pollTimer)
            clearInterval(pollTimer);
        pollTimer = setInterval(() => void drain(), pollInterval);
        void drain();
    };
    const subscribe = (listener, options = {}) => {
        listeners.add(listener);
        restartPolling(options.intervalMs ?? 800);
        return () => {
            listeners.delete(listener);
            if (!listeners.size && pollTimer) {
                clearInterval(pollTimer);
                pollTimer = undefined;
                pollInterval = 800;
            }
        };
    };
    return {
        install: () => evaluate(doudianHookScript),
        getAuthState,
        async waitForLogin(options = {}) {
            const timeoutMs = options.timeoutMs ?? 15 * 60_000;
            const intervalMs = options.intervalMs ?? 1000;
            const started = Date.now();
            let state = await getAuthState();
            while (!state.authenticated && Date.now() - started < timeoutMs) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
                state = await getAuthState();
            }
            if (!state.authenticated)
                throw new Error('等待抖店登录超时，请完成登录后重试');
            return state;
        },
        collectProducts: () => invoke('collectProducts'),
        getProductDetail: (goodsId) => invoke('getProductDetail', goodsId),
        listSessions: () => invoke('listSessions'),
        listMessages: (sessionId) => invoke('listMessages', sessionId),
        sendMessage: (sessionId, content) => invoke('sendMessage', sessionId, content),
        sendFile: (sessionId, dataUrl, fileName) => invoke('sendFile', sessionId, dataUrl, fileName),
        getOrders: (userId) => invoke('getOrders', userId),
        syncOrders: (sessionId, userId) => invoke('syncOrders', sessionId, userId),
        transferSession: (sessionId, target) => invoke('transferSession', sessionId, target),
        drainEvents: () => invoke('drainEvents'),
        subscribe,
        subscribeOrders(listener, options = {}) {
            return subscribe((event) => {
                if (event.type === 'order')
                    listener(event.payload);
            }, options);
        },
        diagnose: () => invoke('diagnose'),
        async dispose() {
            listeners.clear();
            if (pollTimer)
                clearInterval(pollTimer);
            pollTimer = undefined;
            await invoke('dispose');
        },
    };
}
//# sourceMappingURL=client.js.map