const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /fxg\.jinritemai\.com\/ffa\/g\/list/i.test(item.url))
if (!target) throw new Error('未找到抖店商品管理 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 20_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression: `(async () => {
  const event = window.__mona_light_event || window.__lightEvent
  const runtime = await window.__get_light_runtime?.()
  const workbench = window.__WORKBENCH_EVENT_SDK_IN_WINDOW__
  const app = window.Garfish?.activeApps?.[0]
  const entries = (value) => {
    if (!value) return []
    try { return value instanceof Map ? [...value.entries()].map(([key, item]) => [String(key), typeof item]) : Object.entries(value).map(([key, item]) => [key, typeof item]) } catch (_) { return [] }
  }
  const shape = (value) => {
    if (!value) return null
    const output = []
    let current = value
    for (let depth = 0; current && depth < 4; depth += 1) {
      output.push({ depth, members: Object.getOwnPropertyNames(current).map((name) => {
        let type = 'unknown'; let source
        try { type = typeof value[name]; if (type === 'function') source = String(value[name]).slice(0, 1200) } catch (_) {}
        return { name, type, source }
      }) })
      current = Object.getPrototypeOf(current)
    }
    return output
  }
  let jsApis
  try { jsApis = await workbench?.getJSApiList?.() } catch (error) { jsApis = { error: String(error?.message || error) } }
  return {
    eventMapByApp: entries(event?._eventMapByApp),
    eventMapByPlugin: entries(event?._eventMapByPlugin),
    scopeMap: entries(event?._scopeMap),
    listenerMap: entries(event?._pluginListenerMap),
    eventGlobalData: event?.globalStore?.data ? Object.keys(event.globalStore.data) : [],
    runtime: shape(runtime),
    runtimeDefault: shape(runtime?.default),
    workbench: shape(workbench),
    jsApis,
    activeApps: (window.Garfish?.activeApps || []).map((item) => ({ name: item?.name, appInfo: item?.appInfo ? { name: item.appInfo.name, basename: item.appInfo.basename, entry: item.appInfo.entry } : null, exportKeys: Object.keys(item?.customExports || {}), cjsKeys: Object.keys(item?.__cjsModulesExports || {}) })),
    cacheAppKeys: Object.keys(window.Garfish?.cacheApps || {}),
    appInfoKeys: Object.keys(window.Garfish?.appInfos || {}),
    goodsModule: (() => { const value = window['@ecom-mcenter/ffa-goods:1.0.1.8292']; return { array: Array.isArray(value), type: typeof value, length: value?.length, sample: Array.isArray(value) ? value.slice(0, 5).map((item) => ({ type: typeof item, keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 80) : [], value: typeof item === 'string' ? item.slice(0, 200) : undefined })) : null } })(),
    appProvider: shape(app?.provider),
    appExports: shape(app?.customExports),
    appCjsExports: shape(app?.__cjsModulesExports),
    appContext: shape(app?.context),
  }
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
