const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('抖店订单能力诊断超时')), 20_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})

socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    returnByValue: true,
    expression: `(() => {
      const store = window.ss?._frontStore
      const blocked = /(token|cookie|header|phone|mobile|address|security|password|credential|secret|avatar|image|url)/i
      const relevant = /(order|trade|status|state|buyer|user|conversation|session|sku|product|goods|item|amount|price|count|quantity|time|version|refresh|pay|create|update)/i
      const safeKeys = (value) => {
        try { return Object.getOwnPropertyNames(value).filter((key) => !blocked.test(key)).slice(0, 220) } catch (_) { return [] }
      }
      const methods = (value, path) => {
        if (!value || !['object', 'function'].includes(typeof value)) return []
        const result = []
        const seen = new Set()
        for (let owner = value, depth = 0; owner && depth < 4; owner = Object.getPrototypeOf(owner), depth += 1) {
          for (const key of safeKeys(owner)) {
            if (key === 'constructor' || seen.has(key)) continue
            seen.add(key)
            let fn
            try { fn = value[key] } catch (_) { continue }
            if (typeof fn !== 'function' || !relevant.test(key)) continue
            let source = ''
            try { source = String(fn).slice(0, 5000) } catch (_) {}
            result.push({ path: path + '.' + key, arity: fn.length, source })
          }
        }
        return result
      }
      const metadata = (value, depth = 0, seen = new Set()) => {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
        if (!['object', 'function'].includes(typeof value) || seen.has(value) || depth > 3) return undefined
        seen.add(value)
        if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.slice(0, 5).map((item) => metadata(item, depth + 1, seen)).filter(Boolean) }
        const output = {}
        for (const key of safeKeys(value)) {
          if (!relevant.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (typeof child === 'function') continue
          const nested = metadata(child, depth + 1, seen)
          if (nested !== undefined) output[key] = nested
        }
        return output
      }
      const eventNames = (value) => {
        if (!value) return []
        if (value instanceof Map) return Array.from(value.keys()).map(String)
        try { return Object.keys(value) } catch (_) { return [] }
      }
      const roomOrders = []
      const rooms = store?.uiState?.chatRooms?.value
      const roomValues = rooms instanceof Map ? Array.from(rooms.entries()) : Object.entries(rooms || {})
      for (const [id, room] of roomValues.slice(0, 30)) {
        const keys = safeKeys(room).filter((key) => relevant.test(key))
        const data = metadata(room)
        if (keys.length || Object.keys(data || {}).length) roomOrders.push({ id: String(id), keys, data })
      }
      const kora = []
      const instances = window.Kora?.instances
      const instanceEntries = instances instanceof Map ? Array.from(instances.entries()) : Object.entries(instances || {})
      for (const [id, instance] of instanceEntries.slice(0, 50)) {
        kora.push({ id: String(id), keys: safeKeys(instance).filter((key) => relevant.test(key)), methods: methods(instance, 'Kora.instances[' + String(id) + ']') })
      }
      const windowRoots = []
      for (const key of safeKeys(window)) {
        if (!/(order|trade)/i.test(key)) continue
        let value
        try { value = window[key] } catch (_) { continue }
        windowRoots.push({ key, type: typeof value, keys: safeKeys(value).filter((name) => relevant.test(name)), methods: methods(value, 'window.' + key) })
      }
      const workbench = window.__WORKBENCH_EVENT_SDK_IN_WINDOW__
      const mona = window.__mona_pigeon_event
      const context = mona?.globalStore?.data?.initContextData
      const sourceOf = (owner, key) => {
        try { return typeof owner?.[key] === 'function' ? String(owner[key]).slice(0, 12_000) : '' } catch (_) { return '' }
      }
      const services = []
      for (const key of safeKeys(context).filter((name) => /Symbol$/.test(name))) {
        const symbol = context?.[key]
        for (const [getterName, getter] of [['get', context?.get], ['zContainer.get', context?.zContainer?.get]]) {
          if (typeof getter !== 'function') continue
          try {
            const owner = getterName === 'get' ? context : context.zContainer
            const value = getter.call(owner, symbol)
            if (value) services.push({ key, getter: getterName, keys: safeKeys(value), methods: methods(value, key) })
          } catch (_) {}
        }
      }
      const allServices = []
      const allServiceKeys = []
      const instanceMap = context?.zContainer?.instanceMap
      let containerEntries = []
      try { containerEntries = instanceMap instanceof Map ? Array.from(instanceMap.entries()) : Object.entries(instanceMap || {}) } catch (_) {}
      for (const [key, value] of containerEntries.slice(0, 300)) {
        const serviceMethods = methods(value, 'service[' + String(key) + ']')
        const serviceKeys = safeKeys(value)
        allServiceKeys.push({ key: String(key), keys: serviceKeys })
        const text = [String(key), ...serviceKeys, ...serviceMethods.map((item) => item.path + ' ' + item.source)].join(' ')
        if (/(order|trade|pay|purchase)/i.test(text)) {
          allServices.push({ key: String(key), keys: serviceKeys, methods: serviceMethods })
        }
      }
      const discovery = []
      const roots = [
        { path: 'mona.initContextData', value: mona?.globalStore?.data?.initContextData, depth: 0 },
        { path: 'pigeonRemote', value: window.mona_remote_pigeon, depth: 0 },
        { path: 'pluginLoader', value: window.__pigeonPluginLoader, depth: 0 },
        { path: 'ss.instance', value: window.ss?.instance, depth: 0 },
      ]
      const seen = new Set()
      while (roots.length && seen.size < 1000) {
        const current = roots.shift()
        const value = current.value
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        const keys = safeKeys(value)
        const matchedMethods = []
        for (const key of keys) {
          let child
          try { child = value[key] } catch (_) { continue }
          if (typeof child === 'function') {
            let source = ''
            try { source = String(child).slice(0, 8000) } catch (_) {}
            if (/(order|trade|pay|request|fetch)/i.test(key) || /(order|trade|pay)/i.test(source)) matchedMethods.push({ key, arity: child.length, source })
          }
          if (current.depth < 4 && child && ['object', 'function'].includes(typeof child)
            && /(order|trade|request|api|service|plugin|store|data|action|event|workstation|default|remote)/i.test(key)) {
            roots.push({ path: current.path + '.' + key, value: child, depth: current.depth + 1 })
          }
        }
        if (matchedMethods.length || /(order|trade|workstation)/i.test(current.path)) {
          discovery.push({ path: current.path, keys: keys.filter((key) => relevant.test(key) || /(request|fetch|api)/i.test(key)), methods: matchedMethods })
        }
      }
      return {
        workstation: {
          keys: safeKeys(store?.uiState?.workstation),
          data: metadata(store?.uiState?.workstation),
          methods: methods(store?.uiState?.workstation, 'store.uiState.workstation'),
        },
        materialCenter: {
          keys: safeKeys(store?.uiState?.materialCenter),
          data: metadata(store?.uiState?.materialCenter),
          methods: methods(store?.uiState?.materialCenter, 'store.uiState.materialCenter'),
        },
        history: {
          data: metadata(store?.historyConversationData),
          methods: methods(store?.historyConversationData, 'store.historyConversationData'),
        },
        taskOrder: { data: metadata(store?.taskOrder), methods: methods(store?.taskOrder, 'store.taskOrder') },
        orderInvitation: { data: metadata(store?.orderInvitation), methods: methods(store?.orderInvitation, 'store.orderInvitation') },
        currentBuyer: metadata(store?.buyerMap?.currentTalkingBuyer),
        roomOrders,
        workbenchEvents: eventNames(workbench?._eventListenerInfoMap).filter((name) => /(order|trade|pay|refresh)/i.test(name)),
        workbenchAllEvents: eventNames(workbench?._eventListenerInfoMap).slice(0, 250),
        monaAppEvents: eventNames(mona?._eventMapByApp).filter((name) => /(order|trade|pay|refresh)/i.test(name)),
        monaPluginEvents: eventNames(mona?._eventMapByPlugin).filter((name) => /(order|trade|pay|refresh)/i.test(name)),
        parsedPlugins: (window.__pigeonPluginLoader?.parsedPlugins || []).slice(0, 80).map((item) => metadata(item)),
        kora,
        windowRoots,
        discovery: discovery.slice(0, 160),
        contextRuntime: {
          sources: ['get', 'post', 'instance', 'inject', 'getStoreData', 'doAction'].map((key) => ({ key, source: sourceOf(context, key) })),
          storeKeys: safeKeys(context?.Store),
          containerKeys: safeKeys(context?.zContainer),
          containerMethods: methods(context?.zContainer, 'context.zContainer'),
          services,
          allServices,
          allServiceKeys,
        },
        orderResources: (() => {
          try {
            return performance.getEntriesByType('resource').map((item) => String(item.name || '')).filter((name) => /(order|trade|workstation|plugin|remote|pigeon)/i.test(name)).slice(-300)
          } catch (_) { return [] }
        })(),
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
