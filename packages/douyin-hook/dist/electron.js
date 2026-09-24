import { ElectronHookPageFactory } from '@platform-hub/core-page-host';
import { installDouyinPageRuntime } from './runtime.js';
export function createDouyinElectronPageFactory(options) {
    return new ElectronHookPageFactory({
        ...options,
        installRuntime: async (context, contents) => {
            const evaluate = options.evaluate
                ? (expression) => options.evaluate(context, contents, expression)
                : createCdpEvaluator(contents);
            return installDouyinPageRuntime(evaluate, context.definition, context.manifest, options.logger);
        },
        isRuntimeReady: options.isRuntimeReady ?? (async (context, contents) => {
            try {
                return await createCdpEvaluator(contents)(String.raw `(() => {
          if (/captcha|verify|challenge|risk/i.test(String(location.pathname || '') + String(location.search || ''))) return false
          const validId = (value) => {
            const result = String(value ?? '').trim().toLowerCase()
            return Boolean(result && !['-1', '0', 'null', 'undefined'].includes(result))
          }
          const store = window.ss?._frontStore || window.ss?.instance
          const authenticated = validId(store?.shopInfo?.id) || validId(store?.selfInfo?.id) || validId(window.__mona_store__?.shopId)
          if (context.definition.id === 'primary') return authenticated
          if (!/fxg\.jinritemai\.com/i.test(String(location.hostname || ''))) return false
          if (context.definition.id === 'products') {
            return /^\/ffa\/g\/list(?:\/|$)/i.test(String(location.pathname || ''))
          }
          if (context.definition.id === 'orders') {
            if (!authenticated || !/^\/ffa\/(?:arrival-pages\/home|g\/list|morder\/order\/list)(?:\/|$)/i.test(String(location.pathname || ''))) return false
            const officialRuntime = window.__mona_pigeon_event?.globalStore || window.__REACH_RUNTIME__ || window.__NOTICE_RUNTIME__ || window.__NOTIFICATION_RUNTIME__ || window.__FRONTIER_NOTIFICATION_RUNTIME__
            const hasNotificationApi = Object.values(officialRuntime || {}).some((value) => value && ['subscribe', 'listen', 'on', 'addListener', 'addEventListener'].some((name) => typeof value?.[name] === 'function'))
            return Boolean(hasNotificationApi || window.__mona_pigeon_event?.globalStore)
          }
          return false
        })()`);
            }
            catch {
                return false;
            }
        }),
    });
}
export function createCdpEvaluator(contents) {
    if (!contents.debugger.isAttached())
        contents.debugger.attach('1.3');
    return async (expression) => {
        const response = await contents.debugger.sendCommand('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails) {
            throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Douyin Runtime.evaluate failed');
        }
        return response.result?.value;
    };
}
//# sourceMappingURL=electron.js.map