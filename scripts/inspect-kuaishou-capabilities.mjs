const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手能力诊断超时')), 20_000)
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
    expression: `(() => {
      let sdk = window.__chat_sdk
      try {
        for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk
      } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }
      const describe = (value) => {
        if (!value || !['object', 'function'].includes(typeof value)) return null
        const result = []
        const seen = new Set()
        let owner = value
        for (let depth = 0; owner && depth < 4; depth += 1, owner = Object.getPrototypeOf(owner)) {
          try {
            for (const key of Object.getOwnPropertyNames(owner).slice(0, 300)) {
              if (key === 'constructor' || seen.has(key)) continue
              seen.add(key)
              let type = 'unknown'; let arity
              try { type = typeof value[key]; if (type === 'function') arity = value[key].length } catch (_) {}
              if (type === 'function' || /(send|upload|request|message|session|order|goods|product|file|image|event|emit|listen)/i.test(key)) result.push({ key, type, arity })
            }
          } catch (_) {}
        }
        return result
      }
      const eventInfo = (value) => ({
        eventNames: (() => { try { return Object.keys(value?._events || {}) } catch (_) { return [] } })(),
        on: typeof value?.on,
        off: typeof value?.off,
        addListener: typeof value?.addListener,
        removeListener: typeof value?.removeListener,
      })
      return {
        events: {
          sdk: eventInfo(sdk),
          esImSdk: eventInfo(sdk.esImSdk),
          sessionModel: eventInfo(sdk.sessionModel),
          currentStore: eventInfo(sdk.currentSessionMessageListStore),
        },
        messageSender: describe(sdk.messageSender),
        commonRequest: describe(sdk.commonRequest),
        https: describe(sdk.https),
        mainThreadHttps: describe(sdk.mainThreadHttps),
        esImSdk: describe(sdk.esImSdk),
        file: describe(sdk.esImSdk?.file),
        api: describe(sdk.esImSdk?.api),
        store: describe(sdk.store),
        requestSources: {
          commonRequest: String(sdk.commonRequest?.request || sdk.commonRequest?.post || sdk.commonRequest || '').slice(0, 6000),
          upload: String(sdk.esImSdk?.file?.upload || sdk.esImSdk?.file?.uploadFile || '').slice(0, 6000),
        },
      }
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
