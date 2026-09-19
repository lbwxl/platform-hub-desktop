const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')
const requestedTargetId = process.argv[2] || ''

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手 SDK 诊断超时')), 30_000)
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
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      let sdk = window.__chat_sdk
      if (!sdk) {
        try {
          for (let index = 0; index < Math.min(window.frames.length, 12); index += 1) {
            if (window.frames[index].__chat_sdk) { sdk = window.frames[index].__chat_sdk; break }
          }
        } catch (_) {}
      }
      if (!sdk) return { error: 'chat-sdk-not-found' }

      const requestedTargetId = ${JSON.stringify(requestedTargetId)}
      if (requestedTargetId) {
        try { void sdk.chatWithTargetById(requestedTargetId) } catch (_) {}
        const started = Date.now()
        while (!sdk.currentSessionMessageListStore && Date.now() - started < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      const describe = (value) => {
        if (!value || !['object', 'function'].includes(typeof value)) return null
        const own = []
        const proto = []
        try {
          for (const key of Object.getOwnPropertyNames(value).slice(0, 400)) {
            let type = 'unknown'; let arity
            try { type = typeof value[key]; if (type === 'function') arity = value[key].length } catch (_) {}
            own.push({ key, type, arity })
          }
        } catch (_) {}
        try {
          const prototype = Object.getPrototypeOf(value)
          for (const key of Object.getOwnPropertyNames(prototype || {}).slice(0, 300)) {
            if (key === 'constructor') continue
            let type = 'unknown'; let arity
            try { type = typeof prototype[key]; if (type === 'function') arity = prototype[key].length } catch (_) {}
            proto.push({ key, type, arity })
          }
        } catch (_) {}
        return { own, proto }
      }
      const values = (collection) => {
        if (!collection) return []
        if (Array.isArray(collection)) return collection
        try { if (typeof collection.values === 'function') return Array.from(collection.values()) } catch (_) {}
        try { return Object.values(collection) } catch (_) { return [] }
      }
      const mapEntries = (collection) => {
        if (!collection) return []
        try { if (typeof collection.entries === 'function') return Array.from(collection.entries()).slice(0, 15) } catch (_) {}
        try { return Object.entries(collection).slice(0, 15) } catch (_) { return [] }
      }
      const safeRecord = (item) => {
        if (!item || typeof item !== 'object') return item
        const output = {}
        for (const key of Object.getOwnPropertyNames(item).slice(0, 100)) {
          let value
          try { value = item[key] } catch (_) { continue }
          if (typeof value === 'function') continue
          if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value
          else if (Array.isArray(value)) output[key] = { type: 'array', length: value.length }
          else if (typeof value === 'object') output[key] = { type: value.constructor?.name || 'object', keys: Object.getOwnPropertyNames(value).slice(0, 50) }
        }
        return output
      }
      const store = sdk.currentSessionMessageListStore
      const sessionAll = sdk.sessionModel?.sessionAllModel
      const messages = values(store?.messages || store?.messageList || store?.msgList || store?.list)
      const login = await sdk.getLoginUserInfo?.()
      return {
        login,
        sdk: describe(sdk),
        messageSender: describe(sdk.messageSender),
        currentStore: describe(store),
        currentStoreRecord: safeRecord(store),
        esImSdk: describe(sdk.esImSdk),
        sessionModel: describe(sdk.sessionModel),
        sessionAllModel: describe(sessionAll),
        sessionMaps: {
          allSessionMap: mapEntries(sessionAll?.allSessionMap).map(([key, value]) => ({ key, value: safeRecord(value) })),
          allSessionSourceMap: mapEntries(sessionAll?.allSessionSourceMap).map(([key, value]) => ({ key, value: safeRecord(value) })),
          imsdkSessions: values(sessionAll?.imsdkSessions).slice(0, 15).map(safeRecord),
          asyncSessions: values(sessionAll?.asyncSessions).slice(0, 15).map(safeRecord),
        },
        messageSamples: messages.slice(-5).map((item) => ({
          record: safeRecord(item),
          provider: safeRecord(item?.provider),
          kMsg: safeRecord(item?.kMsg),
          rawMsg: safeRecord(item?.kMsg?.rawMsg),
          eContent: safeRecord(item?.kMsg?.eContent),
        })),
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
