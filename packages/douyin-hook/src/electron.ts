import { ElectronHookPageFactory, type ElectronPageFactoryOptions } from '@platform-hub/hook-host'
import type { WebContents } from 'electron'
import type { HookPageContext } from '@platform-hub/hook-host'
import type { HookLogger } from '@platform-hub/hook-sdk'
import { installDouyinPageRuntime, type DouyinEvaluate } from './runtime.js'

export interface DouyinElectronPageFactoryOptions extends Omit<ElectronPageFactoryOptions, 'installRuntime'> {
  evaluate?(context: HookPageContext, contents: WebContents, expression: string): Promise<unknown>
  logger?: HookLogger
}

export function createDouyinElectronPageFactory(options: DouyinElectronPageFactoryOptions): ElectronHookPageFactory {
  return new ElectronHookPageFactory({
    ...options,
    installRuntime: async (context, contents) => {
      const evaluate: DouyinEvaluate = options.evaluate
        ? <T>(expression: string) => options.evaluate!(context, contents, expression) as Promise<T>
        : createCdpEvaluator(contents)
      return installDouyinPageRuntime(evaluate, context.definition, context.manifest, options.logger)
    },
    isRuntimeReady: options.isRuntimeReady ?? (async (context, contents) => {
      try {
        return await createCdpEvaluator(contents)<boolean>(String.raw`(() => {
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
            return Boolean(window.localStorage?.getItem('GOODS_SWR_CACHE_V1'))
          }
          if (context.definition.id === 'orders') {
            if (!authenticated || !/^\/ffa\/(?:arrival-pages\/home|g\/list|morder\/order\/list)(?:\/|$)/i.test(String(location.pathname || ''))) return false
            const officialRuntime = window.__mona_pigeon_event?.globalStore || window.__REACH_RUNTIME__ || window.__NOTICE_RUNTIME__ || window.__NOTIFICATION_RUNTIME__ || window.__FRONTIER_NOTIFICATION_RUNTIME__
            const hasNotificationApi = Object.values(officialRuntime || {}).some((value) => value && ['subscribe', 'listen', 'on', 'addListener', 'addEventListener'].some((name) => typeof value?.[name] === 'function'))
            return Boolean(hasNotificationApi || window.__mona_pigeon_event?.globalStore)
          }
          return false
        })()`)
      } catch { return false }
    }),
  })
}

export function createCdpEvaluator(contents: WebContents): DouyinEvaluate {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  return async <T>(expression: string): Promise<T> => {
    const response = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as {
      result?: { value?: T; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Douyin Runtime.evaluate failed')
    }
    return response.result?.value as T
  }
}
